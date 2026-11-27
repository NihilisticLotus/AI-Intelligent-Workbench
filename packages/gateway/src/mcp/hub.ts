// 能力中心 MCP 工具管家与结果限流网关（第 2.3 步）：
// - 统一托管 MCP 服务配置，敏感环境变量/请求头走 Windows DPAPI secrets 表加密存储；
// - 一键测试连接与工具清单缓存，超过 40 个工具自动折叠为 search_tools / describe_tool / call_tool 三步；
// - 为独立 Agent 与第三方 ACP 会话提供统一工具挂载、独占锁并发控制、8,000 字限流截断与防注入信封。
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { McpServerSpec } from '@aic/adapters';
import {
  CreateMcpServerBody, McpServerSummary, McpTestResult, McpToolInfo, PatchMcpServerBody, TaskMcpConnections,
  type AgentKind, type IndependentModelToolDefinition, type McpSecretEntry,
} from '@aic/protocol';
import type { Db } from '../db';
import type { EventStore } from '../events';
import type { ProcessRegistry } from '../processes';
import type { SecretService } from '../secrets';
import type { PortListInput } from '../security/egress';
import { wrapProvenance } from '../security/provenance';
import { Errors, newId, now } from '../util';
import {
  formatMcpToolResult, invokeMcpTool, MCP_DEFAULT_TIMEOUT_MS, MCP_MAX_RESULT_CHARS, probeMcpServer,
  type McpRuntimeConfig,
} from './client';
import {
  validateMcpCommandAndArgs, validateMcpEnvKey, validateMcpHeaderKey, validateMcpUrl,
} from './parser';

export const MCP_FOLD_THRESHOLD = 40;

type McpRow = {
  id: string;
  name: string;
  description: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args_json: string;
  url: string | null;
  env_refs_json: string;
  header_refs_json: string;
  concurrency: 'shared' | 'exclusive';
  agents_json: string;
  enabled: number;
  status: 'idle' | 'starting' | 'ready' | 'error' | 'disabled';
  last_error: string | null;
  last_checked_at: number | null;
  last_called_at: number | null;
  last_called_tool: string | null;
  tools_json: string;
  created_at: number;
  updated_at: number;
};

export interface McpBridgeGrant {
  taskId: string;
  sessionId: string;
  agent: AgentKind;
}

export interface McpHubOptions {
  port: () => number;
  blockedLocalPorts?: PortListInput;
  allowFakeIpProxy?: () => boolean;
  timeoutMs?: number;
  maxResultChars?: number;
}

const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');

function serverSlug(name: string, id: string): string {
  const ascii = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
  const suffix = id.replace(/[^a-zA-Z0-9]/g, '').slice(-4).toLowerCase();
  return ascii ? `${ascii}_${suffix}` : `srv_${suffix}`;
}

function safeJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
}

export class McpHub {
  /** 独占模式（exclusive）服务器的串行队列锁，防止多个会话同时碰撞桌面软件 MCP */
  private exclusiveLocks = new Map<string, Promise<void>>();
  /** ACP 会话临时 MCP Hub 令牌表（内存中只保存 SHA-256 摘要，会话结束或任务删除立即吊销） */
  private bridgeGrants = new Map<string, McpBridgeGrant>();

  constructor(
    private db: Db,
    private secrets: SecretService,
    private events: EventStore,
    private processes: ProcessRegistry,
    private opts: McpHubOptions,
  ) {
    events.bus.on((ev) => {
      if (ev.type === 'session.ended' && ev.sessionId) this.revokeBridge(ev.sessionId);
      if (ev.type === 'task.deleted') {
        for (const [k, g] of this.bridgeGrants) {
          if (g.taskId === ev.data.id) this.bridgeGrants.delete(k);
        }
      }
    });
  }

  private getRow(id: string): McpRow {
    const row = this.db.get<McpRow>('SELECT * FROM mcp_servers WHERE id = ?', id);
    if (!row) throw Errors.notFound('找不到这个 MCP 服务');
    return row;
  }

  private toSecretEntries(refs: Record<string, string>): McpSecretEntry[] {
    return Object.entries(refs)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, secretId]) => {
        const hint = this.secrets.hint(secretId);
        return { key, hint: hint ?? '', hasValue: hint !== null };
      });
  }

  private toSummary(row: McpRow): McpServerSummary {
    const args = safeJson<string[]>(row.args_json, []);
    const envRefs = safeJson<Record<string, string>>(row.env_refs_json, {});
    const headerRefs = safeJson<Record<string, string>>(row.header_refs_json, {});
    const agents = safeJson<AgentKind[]>(row.agents_json, []);
    const tools = safeJson<McpToolInfo[]>(row.tools_json, []);
    const enabled = !!row.enabled;
    return McpServerSummary.parse({
      id: row.id,
      name: row.name,
      description: row.description,
      transport: row.transport,
      command: row.command,
      args,
      url: row.url,
      envSecrets: this.toSecretEntries(envRefs),
      headerSecrets: this.toSecretEntries(headerRefs),
      concurrency: row.concurrency,
      agents,
      enabled,
      status: enabled ? row.status : 'disabled',
      lastError: row.last_error,
      lastCheckedAt: row.last_checked_at,
      lastCalledAt: row.last_called_at,
      lastCalledTool: row.last_called_tool,
      toolCount: tools.length,
      toolsFolded: tools.length > MCP_FOLD_THRESHOLD,
      tools,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  list(): McpServerSummary[] {
    return this.db
      .all<McpRow>('SELECT * FROM mcp_servers ORDER BY enabled DESC, created_at ASC')
      .map((r) => this.toSummary(r));
  }

  get(id: string): McpServerSummary {
    return this.toSummary(this.getRow(id));
  }

  private async prepareSecrets(
    map: Record<string, string> | undefined,
    validator: (key: string) => void,
  ): Promise<Array<{ key: string; persist: () => { id: string; hint: string } }>> {
    if (!map) return [];
    const prepared: Array<{ key: string; persist: () => { id: string; hint: string } }> = [];
    for (const [key, value] of Object.entries(map)) {
      validator(key);
      const persist = await this.secrets.prepare(value);
      prepared.push({ key, persist });
    }
    return prepared;
  }

  async create(input: CreateMcpServerBody): Promise<McpServerSummary> {
    const body = CreateMcpServerBody.parse(input);
    if (body.transport === 'stdio') {
      validateMcpCommandAndArgs(body.command!, body.args);
    } else {
      validateMcpUrl(body.url!);
    }
    if (this.db.get('SELECT id FROM mcp_servers WHERE LOWER(name) = LOWER(?)', body.name)) {
      throw Errors.conflict(`已存在名为「${body.name}」的 MCP 服务`);
    }

    const envPrepared = await this.prepareSecrets(body.envValues, validateMcpEnvKey);
    const headerPrepared = await this.prepareSecrets(body.headerValues, validateMcpHeaderKey);

    const id = newId('mcp');
    const ts = now();
    this.db.tx(() => {
      if (this.db.get('SELECT id FROM mcp_servers WHERE LOWER(name) = LOWER(?)', body.name)) {
        throw Errors.conflict(`已存在名为「${body.name}」的 MCP 服务`);
      }
      const envRefs: Record<string, string> = {};
      for (const item of envPrepared) envRefs[item.key] = item.persist().id;
      const headerRefs: Record<string, string> = {};
      for (const item of headerPrepared) headerRefs[item.key] = item.persist().id;

      this.db.run(
        `INSERT INTO mcp_servers (
          id, name, description, transport, command, args_json, url,
          env_refs_json, header_refs_json, concurrency, agents_json,
          enabled, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        body.name,
        body.description,
        body.transport,
        body.transport === 'stdio' ? body.command : null,
        JSON.stringify(body.transport === 'stdio' ? body.args : []),
        body.transport === 'http' ? body.url : null,
        JSON.stringify(envRefs),
        JSON.stringify(headerRefs),
        body.concurrency,
        JSON.stringify([...new Set(body.agents)]),
        body.enabled ? 1 : 0,
        body.enabled ? 'idle' : 'disabled',
        ts,
        ts,
      );
    });
    return this.get(id);
  }

  async patch(id: string, input: PatchMcpServerBody): Promise<McpServerSummary> {
    const body = PatchMcpServerBody.parse(input);
    const current = this.getRow(id);
    const nextName = body.name ?? current.name;
    const nextTransport = body.transport ?? current.transport;
    const nextCommand = body.command !== undefined ? body.command : (nextTransport === 'stdio' ? current.command : null);
    const nextArgs = body.args !== undefined ? body.args : (nextTransport === 'stdio' ? safeJson<string[]>(current.args_json, []) : []);
    const nextUrl = body.url !== undefined ? body.url : (nextTransport === 'http' ? current.url : null);

    if (nextTransport === 'stdio') {
      if (!nextCommand || !nextCommand.trim()) throw Errors.badRequest('本机命令（stdio）模式必须填写启动命令');
      validateMcpCommandAndArgs(nextCommand, nextArgs);
    } else {
      if (!nextUrl || !nextUrl.trim()) throw Errors.badRequest('远程接口（HTTP）模式必须填写服务地址');
      validateMcpUrl(nextUrl);
    }

    const envPrepared = await this.prepareSecrets(body.envValues, validateMcpEnvKey);
    const headerPrepared = await this.prepareSecrets(body.headerValues, validateMcpHeaderKey);

    const ts = now();
    this.db.tx(() => {
      const fresh = this.getRow(id);
      if (nextName.toLowerCase() !== fresh.name.toLowerCase()) {
        const dup = this.db.get('SELECT id FROM mcp_servers WHERE LOWER(name) = LOWER(?) AND id <> ?', nextName, id);
        if (dup) throw Errors.conflict(`已存在名为「${nextName}」的 MCP 服务`);
      }

      const envRefs = safeJson<Record<string, string>>(fresh.env_refs_json, {});
      const headerRefs = safeJson<Record<string, string>>(fresh.header_refs_json, {});
      const obsoleteSecrets: string[] = [];

      for (const k of body.removeEnvKeys ?? []) {
        if (envRefs[k]) { obsoleteSecrets.push(envRefs[k]!); delete envRefs[k]; }
      }
      for (const item of envPrepared) {
        if (envRefs[item.key]) obsoleteSecrets.push(envRefs[item.key]!);
        envRefs[item.key] = item.persist().id;
      }
      for (const k of body.removeHeaderKeys ?? []) {
        if (headerRefs[k]) { obsoleteSecrets.push(headerRefs[k]!); delete headerRefs[k]; }
      }
      for (const item of headerPrepared) {
        if (headerRefs[item.key]) obsoleteSecrets.push(headerRefs[item.key]!);
        headerRefs[item.key] = item.persist().id;
      }

      const enabled = body.enabled !== undefined ? body.enabled : !!fresh.enabled;
      const endpointChanged = nextTransport !== fresh.transport
        || nextCommand !== fresh.command
        || nextUrl !== fresh.url
        || JSON.stringify(nextArgs) !== fresh.args_json;
      const nextStatus = !enabled ? 'disabled' : endpointChanged ? 'idle' : (fresh.status === 'disabled' ? 'idle' : fresh.status);

      this.db.run(
        `UPDATE mcp_servers
         SET name = ?, description = ?, transport = ?, command = ?, args_json = ?, url = ?,
             env_refs_json = ?, header_refs_json = ?, concurrency = ?, agents_json = ?,
             enabled = ?, status = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        nextName,
        body.description ?? fresh.description,
        nextTransport,
        nextTransport === 'stdio' ? nextCommand : null,
        JSON.stringify(nextTransport === 'stdio' ? nextArgs : []),
        nextTransport === 'http' ? nextUrl : null,
        JSON.stringify(envRefs),
        JSON.stringify(headerRefs),
        body.concurrency ?? fresh.concurrency,
        JSON.stringify(body.agents !== undefined ? [...new Set(body.agents)] : safeJson<AgentKind[]>(fresh.agents_json, [])),
        enabled ? 1 : 0,
        nextStatus,
        endpointChanged ? null : fresh.last_error,
        ts,
        id,
      );

      for (const secId of obsoleteSecrets) this.secrets.delete(secId);
    });

    return this.get(id);
  }

  delete(id: string): void {
    this.db.tx(() => {
      const row = this.getRow(id);
      const envRefs = safeJson<Record<string, string>>(row.env_refs_json, {});
      const headerRefs = safeJson<Record<string, string>>(row.header_refs_json, {});
      this.db.run('DELETE FROM mcp_servers WHERE id = ?', id);
      for (const secId of [...Object.values(envRefs), ...Object.values(headerRefs)]) {
        this.secrets.delete(secId);
      }
    });
  }

  private async resolveRuntimeConfig(row: McpRow): Promise<{ cfg: McpRuntimeConfig; secretValues: string[] }> {
    const envRefs = safeJson<Record<string, string>>(row.env_refs_json, {});
    const headerRefs = safeJson<Record<string, string>>(row.header_refs_json, {});
    const env: Record<string, string> = {};
    const headers: Record<string, string> = {};
    const secretValues: string[] = [];

    for (const [key, secId] of Object.entries(envRefs)) {
      validateMcpEnvKey(key);
      const val = await this.secrets.read(secId);
      if (val !== null) {
        env[key] = val;
        secretValues.push(val);
      }
    }
    for (const [key, secId] of Object.entries(headerRefs)) {
      validateMcpHeaderKey(key);
      const val = await this.secrets.read(secId);
      if (val !== null) {
        headers[key] = val;
        secretValues.push(val);
      }
    }

    return {
      cfg: {
        id: row.id,
        name: row.name,
        transport: row.transport,
        command: row.command,
        args: safeJson<string[]>(row.args_json, []),
        url: row.url,
        env,
        headers,
      },
      secretValues,
    };
  }

  private async withConcurrency<T>(row: McpRow, fn: () => Promise<T>): Promise<T> {
    if (row.concurrency !== 'exclusive') return fn();
    const prev = this.exclusiveLocks.get(row.id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => { release = r; });
    const tail = prev.catch(() => {}).then(() => current);
    this.exclusiveLocks.set(row.id, tail);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.exclusiveLocks.get(row.id) === tail) this.exclusiveLocks.delete(row.id);
    }
  }

  async test(id: string, signal?: AbortSignal): Promise<McpTestResult> {
    const row = this.getRow(id);
    const started = Date.now();
    this.db.run("UPDATE mcp_servers SET status = 'starting', updated_at = ? WHERE id = ?", started, id);
    try {
      const { cfg } = await this.resolveRuntimeConfig(row);
      const { steps, tools } = await this.withConcurrency(row, () => probeMcpServer(cfg, {
        processes: this.processes,
        timeoutMs: this.opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
        signal,
        egress: {
          blockedLocalPorts: this.opts.blockedLocalPorts,
          allowFakeIpProxy: this.opts.allowFakeIpProxy?.() ?? false,
        },
      }));
      const finished = now();
      this.db.run(
        `UPDATE mcp_servers
         SET status = ?, last_error = NULL, last_checked_at = ?, tools_json = ?, updated_at = ?
         WHERE id = ?`,
        row.enabled ? 'ready' : 'disabled',
        finished,
        JSON.stringify(tools),
        finished,
        id,
      );
      const server = this.get(id);
      return McpTestResult.parse({
        server,
        ok: true,
        durationMs: Math.max(0, Date.now() - started),
        steps,
        tools,
        folded: tools.length > MCP_FOLD_THRESHOLD,
        error: null,
      });
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      const finished = now();
      this.db.run(
        `UPDATE mcp_servers
         SET status = ?, last_error = ?, last_checked_at = ?, updated_at = ?
         WHERE id = ?`,
        row.enabled ? 'error' : 'disabled',
        message,
        finished,
        finished,
        id,
      );
      const server = this.get(id);
      return McpTestResult.parse({
        server,
        ok: false,
        durationMs: Math.max(0, Date.now() - started),
        steps: [{ step: '连接测试', ok: false, detail: message }],
        tools: server.tools,
        folded: server.toolsFolded,
        error: message,
      });
    }
  }

  /** 查询指定任务的 MCP 连接情况（右侧“详细 → 连接”面板使用）。 */
  taskConnections(taskId: string, agent: AgentKind): TaskMcpConnections {
    const rows = this.db.all<McpRow>('SELECT * FROM mcp_servers ORDER BY enabled DESC, created_at ASC');
    const disabledSet = new Set(
      this.db
        .all<{ server_id: string }>('SELECT server_id FROM task_mcp_overrides WHERE task_id = ? AND disabled = 1', taskId)
        .map((r) => r.server_id),
    );
    const servers = rows.map((row) => {
      const agents = safeJson<AgentKind[]>(row.agents_json, []);
      const tools = safeJson<McpToolInfo[]>(row.tools_json, []);
      const enabled = !!row.enabled;
      const assigned = agents.length === 0 || agents.includes(agent);
      const disabledForTask = disabledSet.has(row.id);
      return {
        id: row.id,
        name: row.name,
        transport: row.transport,
        enabled,
        assigned,
        disabledForTask,
        activeForTask: enabled && assigned && !disabledForTask,
        status: enabled ? row.status : 'disabled',
        concurrency: row.concurrency,
        toolCount: tools.length,
        toolsFolded: tools.length > MCP_FOLD_THRESHOLD,
        lastCalledAt: row.last_called_at,
        lastCalledTool: row.last_called_tool,
      };
    });
    return TaskMcpConnections.parse({ taskId, agent, servers });
  }

  /** 更新指定任务的临时停用 MCP 列表（仅影响该任务）。 */
  setTaskOverrides(taskId: string, agent: AgentKind, disabledServerIds: readonly string[]): TaskMcpConnections {
    const validIds = new Set(this.db.all<{ id: string }>('SELECT id FROM mcp_servers').map((r) => r.id));
    const cleaned = [...new Set(disabledServerIds.filter((id) => validIds.has(id)))];
    this.db.tx(() => {
      this.db.run('DELETE FROM task_mcp_overrides WHERE task_id = ?', taskId);
      for (const serverId of cleaned) {
        this.db.run('INSERT INTO task_mcp_overrides (task_id, server_id, disabled) VALUES (?, ?, 1)', taskId, serverId);
      }
    });
    return this.taskConnections(taskId, agent);
  }

  private activeRowsFor(taskId: string, agent: AgentKind): McpRow[] {
    const disabledSet = new Set(
      this.db
        .all<{ server_id: string }>('SELECT server_id FROM task_mcp_overrides WHERE task_id = ? AND disabled = 1', taskId)
        .map((r) => r.server_id),
    );
    return this.db
      .all<McpRow>('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY created_at ASC')
      .filter((row) => {
        if (disabledSet.has(row.id)) return false;
        const agents = safeJson<AgentKind[]>(row.agents_json, []);
        return agents.length === 0 || agents.includes(agent);
      });
  }

  /**
   * 为独立 Agent 或 ACP Hub 生成当前任务可见的工具声明。
   * 单服务工具数 > 40 时自动折叠为 search_tools / describe_tool / call_tool 三步，防止撑爆模型上下文。
   */
  exposedToolsFor(taskId: string, agent: AgentKind): {
    definitions: IndependentModelToolDefinition[];
    dispatch: Map<string, { serverId: string; mode: 'direct'; toolName: string } | { serverId: string; mode: 'search' | 'describe' | 'call' }>;
  } {
    const rows = this.activeRowsFor(taskId, agent);
    const definitions: IndependentModelToolDefinition[] = [];
    const dispatch = new Map<string, { serverId: string; mode: 'direct'; toolName: string } | { serverId: string; mode: 'search' | 'describe' | 'call' }>();

    for (const row of rows) {
      const tools = safeJson<McpToolInfo[]>(row.tools_json, []);
      if (!tools.length) continue;
      const prefix = `mcp_${serverSlug(row.name, row.id)}__`;

      if (tools.length > MCP_FOLD_THRESHOLD) {
        const searchName = `${prefix}search_tools`;
        const describeName = `${prefix}describe_tool`;
        const callName = `${prefix}call_tool`;
        definitions.push(
          {
            name: searchName,
            description: `在 MCP 服务「${row.name}」（共 ${tools.length} 个工具，已折叠）中按关键词搜索工具名称与说明。`,
            parameters: {
              type: 'object',
              properties: { query: { type: 'string', description: '搜索关键词（留空返回前 20 个工具）' } },
              required: [],
              additionalProperties: false,
            },
          },
          {
            name: describeName,
            description: `查看 MCP 服务「${row.name}」中指定工具的详细说明与参数结构。`,
            parameters: {
              type: 'object',
              properties: { name: { type: 'string', description: '目标工具名称' } },
              required: ['name'],
              additionalProperties: false,
            },
          },
          {
            name: callName,
            description: `调用 MCP 服务「${row.name}」中的指定工具；请先用 search_tools / describe_tool 确认工具名与参数。`,
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: '目标工具名称' },
                arguments: { type: 'object', description: '工具参数对象' },
              },
              required: ['name'],
              additionalProperties: false,
            },
          },
        );
        dispatch.set(searchName, { serverId: row.id, mode: 'search' });
        dispatch.set(describeName, { serverId: row.id, mode: 'describe' });
        dispatch.set(callName, { serverId: row.id, mode: 'call' });
      } else {
        for (const t of tools) {
          const safeTool = t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
          const exposedName = `${prefix}${safeTool}`;
          const params = t.inputSchema && typeof t.inputSchema === 'object'
            ? { ...t.inputSchema, type: 'object' }
            : { type: 'object', properties: {} };
          definitions.push({
            name: exposedName,
            description: `[MCP: ${row.name}] ${t.description || t.name}`,
            parameters: params,
          });
          dispatch.set(exposedName, { serverId: row.id, mode: 'direct', toolName: t.name });
        }
      }
    }

    return { definitions, dispatch };
  }

  /** 执行某个暴露给模型的 MCP 工具（自动处理折叠三步、独占锁、8,000 字截断与防注入围栏）。 */
  async executeExposedTool(
    taskId: string,
    agent: AgentKind,
    exposedName: string,
    rawArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean; serverName: string; toolName: string }> {
    const { dispatch } = this.exposedToolsFor(taskId, agent);
    const entry = dispatch.get(exposedName);
    if (!entry) throw Errors.notFound(`当前任务未启用这个 MCP 工具：${exposedName}`);
    const row = this.getRow(entry.serverId);
    const tools = safeJson<McpToolInfo[]>(row.tools_json, []);

    if (entry.mode === 'search') {
      const q = typeof rawArgs.query === 'string' ? rawArgs.query.trim().toLowerCase() : '';
      const matched = tools
        .filter((t) => !q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
        .slice(0, 20)
        .map((t) => `- ${t.name}：${t.description || '无说明'}`);
      const body = matched.length
        ? `共匹配 ${matched.length} 个工具（服务共 ${tools.length} 个）：\n${matched.join('\n')}`
        : `未找到包含「${q}」的工具（服务共 ${tools.length} 个工具）。`;
      return {
        text: wrapProvenance('external_data', `MCP 工具目录 ${row.name}`, body),
        isError: false,
        serverName: row.name,
        toolName: 'search_tools',
      };
    }

    if (entry.mode === 'describe') {
      const targetName = typeof rawArgs.name === 'string' ? rawArgs.name.trim() : '';
      const found = tools.find((t) => t.name === targetName);
      if (!found) {
        return {
          text: wrapProvenance('external_data', `MCP 工具目录 ${row.name}`, `找不到名为「${targetName}」的工具。`),
          isError: true,
          serverName: row.name,
          toolName: 'describe_tool',
        };
      }
      const body = `工具名称：${found.name}\n说明：${found.description || '无'}\n参数结构：\n${JSON.stringify(found.inputSchema, null, 2)}`;
      return {
        text: wrapProvenance('external_data', `MCP 工具说明 ${row.name} / ${found.name}`, body),
        isError: false,
        serverName: row.name,
        toolName: 'describe_tool',
      };
    }

    let targetTool: string;
    let callArgs: Record<string, unknown>;
    if (entry.mode === 'call') {
      targetTool = typeof rawArgs.name === 'string' ? rawArgs.name.trim() : '';
      if (!targetTool || !tools.some((t) => t.name === targetTool)) {
        return {
          text: wrapProvenance('external_data', `MCP 工具 ${row.name}`, `未找到名为「${targetTool}」的已登记工具，请先用 search_tools 查询。`),
          isError: true,
          serverName: row.name,
          toolName: targetTool || 'call_tool',
        };
      }
      callArgs = rawArgs.arguments && typeof rawArgs.arguments === 'object' && !Array.isArray(rawArgs.arguments)
        ? (rawArgs.arguments as Record<string, unknown>)
        : {};
    } else if (entry.mode === 'direct') {
      targetTool = entry.toolName;
      callArgs = rawArgs;
    } else {
      throw Errors.notFound(`当前任务未启用这个 MCP 工具：${exposedName}`);
    }

    const { cfg, secretValues } = await this.resolveRuntimeConfig(row);
    const rawResult = await this.withConcurrency(row, () => invokeMcpTool(cfg, targetTool, callArgs, {
      processes: this.processes,
      timeoutMs: this.opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
      signal,
      egress: {
        blockedLocalPorts: this.opts.blockedLocalPorts,
        allowFakeIpProxy: this.opts.allowFakeIpProxy?.() ?? false,
      },
    }));
    const ts = now();
    this.db.run(
      'UPDATE mcp_servers SET last_called_at = ?, last_called_tool = ?, status = ?, last_error = NULL, updated_at = ? WHERE id = ?',
      ts,
      targetTool,
      row.enabled ? 'ready' : 'disabled',
      ts,
      row.id,
    );
    const formatted = formatMcpToolResult(row.name, targetTool, rawResult, secretValues, this.opts.maxResultChars ?? MCP_MAX_RESULT_CHARS);
    return { text: formatted.text, isError: formatted.isError, serverName: row.name, toolName: targetTool };
  }

  // ---------- 第三方 ACP 会话统一 MCP Hub 桥接 ----------

  /** 若该任务有可用的已启用 MCP 服务（且已测试出工具），返回受控 aic-mcp-hub 桥接规格。 */
  bridgeFor(grant: McpBridgeGrant): McpServerSpec | null {
    const { definitions } = this.exposedToolsFor(grant.taskId, grant.agent);
    if (!definitions.length) return null;
    this.revokeBridge(grant.sessionId);
    const token = randomBytes(32).toString('base64url');
    this.bridgeGrants.set(tokenDigest(token), { ...grant });
    return {
      name: 'aic-mcp-hub',
      command: process.execPath,
      args: [fileURLToPath(new URL('./acp-bridge.mjs', import.meta.url))],
      env: [
        { name: 'AIC_MCP_PORT', value: String(this.opts.port()) },
        { name: 'AIC_MCP_TOKEN', value: token },
      ],
    };
  }

  revokeBridge(sessionId: string): void {
    for (const [k, g] of this.bridgeGrants) {
      if (g.sessionId === sessionId) this.bridgeGrants.delete(k);
    }
  }

  authenticateBridge(header: string | undefined): McpBridgeGrant {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '');
    const grant = match && this.bridgeGrants.get(tokenDigest(match[1]!));
    if (!grant) throw Errors.unauthorized('MCP 桥接会话无效或已结束');
    return grant;
  }

  async handleBridgeRpc(
    grant: McpBridgeGrant,
    body: { method?: unknown; name?: unknown; arguments?: unknown },
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (body.method === 'tools/list') {
      const { definitions } = this.exposedToolsFor(grant.taskId, grant.agent);
      return {
        tools: definitions.map((d) => ({
          name: d.name,
          description: d.description,
          inputSchema: d.parameters,
        })),
      };
    }
    if (body.method === 'tools/call') {
      if (typeof body.name !== 'string' || !body.name) throw Errors.badRequest('缺少工具名称');
      const args = body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? (body.arguments as Record<string, unknown>)
        : {};
      const res = await this.executeExposedTool(grant.taskId, grant.agent, body.name, args, signal);
      return { isError: res.isError, content: [{ type: 'text', text: res.text }] };
    }
    throw Errors.badRequest('不支持的 MCP Hub 内部请求');
  }
}
