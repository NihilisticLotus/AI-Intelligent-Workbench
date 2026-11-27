// 能力中心 MCP 工具管家与结果限流网关（第 2.3-R 步升级）：
// - 统一托管 MCP 服务配置，敏感环境变量/请求头走 Windows DPAPI secrets 表加密存储；
// - 常驻 Stdio 单实例进程池 + 空闲自动回收 + 崩溃自愈，以及 HTTP Streamable 会话复用；
// - 全局渐进式工具发现（跨服务总工具 > 25、总 Schema > 24 KB 或单服务 > 40 时自动收敛为全局 3 元工具）；
// - 头尾摘要截断 + 任务级受控内存溢出分页回查（aic_mcp__read_output，零本机路径暴露）+ 2.1 防注入围栏。
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
  formatMcpToolResult, HttpMcpSessionStore, invokeMcpTool, MCP_DEFAULT_TIMEOUT_MS, MCP_MAX_RESULT_CHARS, probeMcpServer,
  type McpRuntimeConfig,
} from './client';
import { MCP_OVERFLOW_MAX_READ_CHARS, McpOverflowStore } from './overflow';
import {
  validateMcpCommandAndArgs, validateMcpEnvKey, validateMcpHeaderKey, validateMcpUrl,
} from './parser';
import { MCP_MAX_STDOUT_LINE_BYTES, MCP_STDIO_IDLE_TTL_MS, StdioMcpPool } from './pool';

/** 单服务工具数超过该阈值时，在卡片上展示「已自动折叠」并触发渐进式发现。 */
export const MCP_FOLD_THRESHOLD = 40;
/** 跨全部已启用服务总工具数超过该阈值时，自动切换全局渐进式工具搜索，防止多服务叠爆上下文。 */
export const MCP_GLOBAL_FOLD_TOOL_THRESHOLD = 25;
/** 跨全部已启用服务工具 Schema 总字节数超过该阈值时，同样触发全局渐进式工具搜索。 */
export const MCP_GLOBAL_FOLD_SCHEMA_BYTES = 24_000;

export const MCP_TOOL_SEARCH = 'aic_mcp__search_tools';
export const MCP_TOOL_DESCRIBE = 'aic_mcp__describe_tool';
export const MCP_TOOL_CALL = 'aic_mcp__call_tool';
export const MCP_TOOL_READ_OUTPUT = 'aic_mcp__read_output';

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
  idleTtlMs?: number;
  maxStdoutLineBytes?: number;
}

export type ExposedMcpDispatchEntry =
  | { serverId: string; mode: 'direct'; toolName: string }
  | { mode: 'global_search' | 'global_describe' | 'global_call' | 'read_output' };

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

function endpointSignature(row: Pick<McpRow, 'transport' | 'command' | 'args_json' | 'url'>): string {
  return JSON.stringify([row.transport, row.command, row.args_json, row.url]);
}

export class McpHub {
  /** 独占模式（exclusive）服务器的串行队列锁，防止多个会话同时碰撞桌面软件 MCP */
  private exclusiveLocks = new Map<string, Promise<void>>();
  /** ACP 会话临时 MCP Hub 令牌表（内存中只保存 SHA-256 摘要，会话结束或任务删除立即吊销） */
  private bridgeGrants = new Map<string, McpBridgeGrant>();
  /** 常驻 Stdio 单实例进程池（支持空闲自动回收与崩溃自愈） */
  private stdioPool: StdioMcpPool;
  /** HTTP Streamable MCP 会话复用缓存 */
  private httpSessions = new HttpMcpSessionStore();
  /** 任务级受控内存溢出分页回查存储（零磁盘路径） */
  private overflow = new McpOverflowStore();

  constructor(
    private db: Db,
    private secrets: SecretService,
    private events: EventStore,
    private processes: ProcessRegistry,
    private opts: McpHubOptions,
  ) {
    this.stdioPool = new StdioMcpPool({
      processes,
      idleTtlMs: opts.idleTtlMs ?? MCP_STDIO_IDLE_TTL_MS,
      maxStdoutLineBytes: opts.maxStdoutLineBytes ?? MCP_MAX_STDOUT_LINE_BYTES,
    });
    events.bus.on((ev) => {
      if (ev.type === 'session.ended' && ev.sessionId) this.revokeBridge(ev.sessionId);
      if (ev.type === 'task.deleted') {
        for (const [k, g] of this.bridgeGrants) {
          if (g.taskId === ev.data.id) this.bridgeGrants.delete(k);
        }
        this.overflow.clearTask(ev.data.id);
      }
    });
  }

  /** 工作台关闭或测试收尾时回收全部常驻 Stdio 进程并清空缓存。 */
  async close(): Promise<void> {
    this.bridgeGrants.clear();
    this.overflow.clearAll();
    this.httpSessions.clearAll();
    await this.stdioPool.closeAll();
  }

  activePoolCount(): number {
    return this.stdioPool.activeCount();
  }

  hasPooledProcess(serverId: string): boolean {
    return this.stdioPool.has(serverId);
  }

  private async evictRuntime(serverId: string): Promise<void> {
    this.httpSessions.evict(serverId);
    await this.stdioPool.evict(serverId);
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
    let shouldEvict = false;
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
        || (nextTransport === 'stdio' ? nextCommand : null) !== fresh.command
        || (nextTransport === 'http' ? nextUrl : null) !== fresh.url
        || JSON.stringify(nextTransport === 'stdio' ? nextArgs : []) !== fresh.args_json;
      const credentialsChanged = envPrepared.length > 0
        || headerPrepared.length > 0
        || (body.removeEnvKeys?.length ?? 0) > 0
        || (body.removeHeaderKeys?.length ?? 0) > 0;
      shouldEvict = !enabled || endpointChanged || credentialsChanged;

      const nextStatus = !enabled ? 'disabled' : endpointChanged ? 'idle' : (fresh.status === 'disabled' ? 'idle' : fresh.status);
      // 修改了启动命令/参数/地址后必须同步清空旧的工具清单缓存，避免模型拿旧工具去调新服务
      const nextToolsJson = endpointChanged ? '[]' : fresh.tools_json;

      this.db.run(
        `UPDATE mcp_servers
         SET name = ?, description = ?, transport = ?, command = ?, args_json = ?, url = ?,
             env_refs_json = ?, header_refs_json = ?, concurrency = ?, agents_json = ?,
             enabled = ?, status = ?, last_error = ?, tools_json = ?, updated_at = ?
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
        nextToolsJson,
        ts,
        id,
      );

      for (const secId of obsoleteSecrets) this.secrets.delete(secId);
    });

    if (shouldEvict) await this.evictRuntime(id);
    return this.get(id);
  }

  async delete(id: string): Promise<void> {
    this.db.tx(() => {
      const row = this.getRow(id);
      const envRefs = safeJson<Record<string, string>>(row.env_refs_json, {});
      const headerRefs = safeJson<Record<string, string>>(row.header_refs_json, {});
      this.db.run('DELETE FROM mcp_servers WHERE id = ?', id);
      for (const secId of [...Object.values(envRefs), ...Object.values(headerRefs)]) {
        this.secrets.delete(secId);
      }
    });
    await this.evictRuntime(id);
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

  private async withConcurrency<T>(row: Pick<McpRow, 'id' | 'concurrency'>, fn: () => Promise<T>): Promise<T> {
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
    const startSig = endpointSignature(row);
    const started = Date.now();
    this.db.run(
      "UPDATE mcp_servers SET status = CASE WHEN enabled = 1 THEN 'starting' ELSE 'disabled' END, updated_at = ? WHERE id = ?",
      started,
      id,
    );
    try {
      const { cfg } = await this.resolveRuntimeConfig(row);
      const { steps, tools } = await this.withConcurrency(row, () => probeMcpServer(cfg, {
        processes: this.processes,
        stdioPool: this.stdioPool,
        httpSessions: this.httpSessions,
        keepWarm: !!row.enabled,
        timeoutMs: this.opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
        signal,
        egress: {
          blockedLocalPorts: this.opts.blockedLocalPorts,
          allowFakeIpProxy: this.opts.allowFakeIpProxy?.() ?? false,
        },
      }));

      // 探测耗时较长，写回前重新读取最新行，避免覆盖测试期间并发发生的停用、改配置或删除操作
      const latest = this.db.get<McpRow>('SELECT * FROM mcp_servers WHERE id = ?', id);
      if (!latest) {
        await this.evictRuntime(id);
        throw Errors.notFound('该 MCP 服务在测试过程中已被删除');
      }
      if (endpointSignature(latest) !== startSig) {
        await this.evictRuntime(id);
        const server = this.toSummary(latest);
        return McpTestResult.parse({
          server,
          ok: true,
          durationMs: Math.max(0, Date.now() - started),
          steps: [...steps, { step: '状态核对', ok: true, detail: '测试期间配置已变更，未覆盖新配置状态，请重新测试' }],
          tools: server.tools,
          folded: server.toolsFolded,
          error: null,
        });
      }

      if (!latest.enabled) await this.evictRuntime(id);
      const finished = now();
      this.db.run(
        `UPDATE mcp_servers
         SET status = CASE WHEN enabled = 1 THEN 'ready' ELSE 'disabled' END,
             last_error = NULL, last_checked_at = ?, tools_json = ?, updated_at = ?
         WHERE id = ?`,
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
      const latest = this.db.get<McpRow>('SELECT * FROM mcp_servers WHERE id = ?', id);
      if (!latest) {
        await this.evictRuntime(id);
        throw Errors.notFound('该 MCP 服务在测试过程中已被删除');
      }
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      if (endpointSignature(latest) === startSig) {
        const finished = now();
        this.db.run(
          `UPDATE mcp_servers
           SET status = CASE WHEN enabled = 1 THEN 'error' ELSE 'disabled' END,
               last_error = ?, last_checked_at = ?, updated_at = ?
           WHERE id = ?`,
          message,
          finished,
          finished,
          id,
        );
      }
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

  private activeRowsWithTools(taskId: string, agent: AgentKind): Array<{ row: McpRow; tools: McpToolInfo[] }> {
    const disabledSet = new Set(
      this.db
        .all<{ server_id: string }>('SELECT server_id FROM task_mcp_overrides WHERE task_id = ? AND disabled = 1', taskId)
        .map((r) => r.server_id),
    );
    const out: Array<{ row: McpRow; tools: McpToolInfo[] }> = [];
    for (const row of this.db.all<McpRow>('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY created_at ASC')) {
      if (disabledSet.has(row.id)) continue;
      const agents = safeJson<AgentKind[]>(row.agents_json, []);
      if (agents.length > 0 && !agents.includes(agent)) continue;
      const tools = safeJson<McpToolInfo[]>(row.tools_json, []);
      if (tools.length > 0) out.push({ row, tools });
    }
    return out;
  }

  /**
   * 为独立 Agent 或 ACP Hub 生成当前任务可见的工具声明（第 2.3-R 步全局渐进式发现）：
   * - 当所有已启用 MCP 总工具数 ≤ 25 且 Schema 总量 ≤ 24 KB（且单服务 ≤ 40）时直出工具，零额外往返；
   * - 超过任一阈值时自动收敛为全局统一的 3 个元工具（aic_mcp__search_tools / describe_tool / call_tool）；
   * - 只要存在可用 MCP，同时提供只读分页回查工具 aic_mcp__read_output（用于读取被限流截断的中间内容）。
   */
  exposedToolsFor(taskId: string, agent: AgentKind): {
    definitions: IndependentModelToolDefinition[];
    dispatch: Map<string, ExposedMcpDispatchEntry>;
    globalFolded: boolean;
  } {
    const active = this.activeRowsWithTools(taskId, agent);
    const definitions: IndependentModelToolDefinition[] = [];
    const dispatch = new Map<string, ExposedMcpDispatchEntry>();

    if (!active.length) {
      return { definitions, dispatch, globalFolded: false };
    }

    const totalTools = active.reduce((sum, item) => sum + item.tools.length, 0);
    const totalSchemaBytes = active.reduce((sum, item) => sum + item.row.tools_json.length, 0);
    const anySingleFolded = active.some((item) => item.tools.length > MCP_FOLD_THRESHOLD);
    const globalFolded = anySingleFolded
      || totalTools > MCP_GLOBAL_FOLD_TOOL_THRESHOLD
      || totalSchemaBytes > MCP_GLOBAL_FOLD_SCHEMA_BYTES;

    if (globalFolded) {
      const serverListDesc = active.map((a) => `${a.row.name}(${a.tools.length})`).join('、');
      definitions.push(
        {
          name: MCP_TOOL_SEARCH,
          description: `在当前任务已启用的全部 MCP 服务（共 ${active.length} 个服务、${totalTools} 个工具：${serverListDesc}）中按关键词或服务名渐进式搜索工具。`,
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '搜索关键词（匹配工具名、说明或服务名；留空返回前 20 个工具）' },
              server: { type: 'string', description: '可选，只搜索指定名称的 MCP 服务' },
            },
            required: [],
            additionalProperties: false,
          },
        },
        {
          name: MCP_TOOL_DESCRIBE,
          description: '查看指定 MCP 工具的完整说明与 JSON 参数结构；请先通过 aic_mcp__search_tools 确认工具名。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '目标工具名称' },
              server: { type: 'string', description: '可选，当多个 MCP 存在同名工具时用于指定服务名' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        {
          name: MCP_TOOL_CALL,
          description: '调用指定 MCP 服务中的工具；请先用 aic_mcp__search_tools / aic_mcp__describe_tool 核对工具名与参数。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '目标工具名称' },
              server: { type: 'string', description: '可选，目标 MCP 服务名称（多服务存在同名工具时必填）' },
              arguments: { type: 'object', description: '工具参数对象' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      );
      dispatch.set(MCP_TOOL_SEARCH, { mode: 'global_search' });
      dispatch.set(MCP_TOOL_DESCRIBE, { mode: 'global_describe' });
      dispatch.set(MCP_TOOL_CALL, { mode: 'global_call' });
    } else {
      for (const { row, tools } of active) {
        const prefix = `mcp_${serverSlug(row.name, row.id)}__`;
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

    // 统一附带只读溢出分页回查工具（单次上限 8,000 字符、严格按 taskId 隔离、零磁盘路径）
    definitions.push({
      name: MCP_TOOL_READ_OUTPUT,
      description: '分页读取因超过 8,000 字符而被截断的 MCP 输出内容（需提供截断提示中的 outputId，单次最多读取 8,000 字符）。',
      parameters: {
        type: 'object',
        properties: {
          outputId: { type: 'string', description: '截断提示中给出的输出编号（如 out_a1b2c3d4e5f6）' },
          offset: { type: 'integer', description: '起始字符偏移（从 0 开始，默认 0）' },
          limit: { type: 'integer', description: `本次最多读取字符数（默认 ${MCP_OVERFLOW_MAX_READ_CHARS}，上限 ${MCP_OVERFLOW_MAX_READ_CHARS}）` },
        },
        required: ['outputId'],
        additionalProperties: false,
      },
    });
    dispatch.set(MCP_TOOL_READ_OUTPUT, { mode: 'read_output' });

    return { definitions, dispatch, globalFolded };
  }

  private resolveGlobalTool(
    active: Array<{ row: McpRow; tools: McpToolInfo[] }>,
    targetName: string,
    serverFilter: string,
  ):
    | { ok: true; row: McpRow; tool: McpToolInfo }
    | { ok: false; message: string } {
    if (!targetName) return { ok: false, message: '缺少目标工具名称，请先调用 aic_mcp__search_tools 查询。' };
    const filterLower = serverFilter.trim().toLowerCase();
    const matches: Array<{ row: McpRow; tool: McpToolInfo }> = [];
    for (const item of active) {
      if (filterLower && item.row.name.toLowerCase() !== filterLower) continue;
      const found = item.tools.find((t) => t.name === targetName);
      if (found) matches.push({ row: item.row, tool: found });
    }
    if (matches.length === 0) {
      return {
        ok: false,
        message: filterLower
          ? `在服务「${serverFilter}」中未找到名为「${targetName}」的工具。`
          : `在当前任务已启用的 MCP 服务中未找到名为「${targetName}」的工具，请先调用 aic_mcp__search_tools 查询。`,
      };
    }
    if (matches.length > 1) {
      const names = matches.map((m) => m.row.name).join('、');
      return {
        ok: false,
        message: `多个 MCP 服务都包含名为「${targetName}」的工具（${names}），请在 server 参数中指明要调用哪一个服务。`,
      };
    }
    return { ok: true, row: matches[0]!.row, tool: matches[0]!.tool };
  }

  /** 执行某个暴露给模型的 MCP 工具（自动处理全局渐进式搜索、分页回查、常驻池复用、独占锁、头尾截断与防注入围栏）。 */
  async executeExposedTool(
    taskId: string,
    agent: AgentKind,
    exposedName: string,
    rawArgs: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ text: string; isError: boolean; serverName: string; toolName: string; overflowId?: string | null }> {
    const { dispatch } = this.exposedToolsFor(taskId, agent);
    const entry = dispatch.get(exposedName);
    if (!entry) throw Errors.notFound(`当前任务未启用这个 MCP 工具：${exposedName}`);

    if (entry.mode === 'read_output') {
      const outputId = typeof rawArgs.outputId === 'string' ? rawArgs.outputId.trim() : '';
      const offset = typeof rawArgs.offset === 'number' ? rawArgs.offset : 0;
      const limit = typeof rawArgs.limit === 'number' ? rawArgs.limit : MCP_OVERFLOW_MAX_READ_CHARS;
      if (!outputId) {
        return {
          text: wrapProvenance('external_data', 'MCP 溢出内容回查', '请提供截断提示中的 outputId（例如 out_xxxxxxxxxxxx）。'),
          isError: true,
          serverName: 'aic-mcp-hub',
          toolName: 'read_output',
        };
      }
      const chunk = this.overflow.read(taskId, outputId, offset, limit);
      if (!chunk) {
        return {
          text: wrapProvenance('external_data', 'MCP 溢出内容回查', `未找到编号为「${outputId}」的溢出记录（可能已过期、被清理或不属于当前任务）。`),
          isError: true,
          serverName: 'aic-mcp-hub',
          toolName: 'read_output',
        };
      }
      const tailHint = chunk.nextOffset !== null
        ? `后续还有内容，可继续传 offset=${chunk.nextOffset} 读取。`
        : '已读到暂存内容末尾。';
      const clipHint = chunk.clipped ? `（原始 ${chunk.originalChars} 字符，缓存上限保留前 ${chunk.storedChars} 字符）` : '';
      const body = `【分页回查 ${chunk.id} · ${chunk.serverName} / ${chunk.toolName}：字符区间 ${chunk.offset}..${chunk.endOffset} / ${chunk.storedChars}${clipHint}。${tailHint}】\n${chunk.slice}`;
      return {
        text: wrapProvenance('external_data', `MCP 溢出分页 ${chunk.serverName} / ${chunk.toolName}`, body),
        isError: false,
        serverName: chunk.serverName,
        toolName: 'read_output',
      };
    }

    const active = this.activeRowsWithTools(taskId, agent);

    if (entry.mode === 'global_search') {
      const q = typeof rawArgs.query === 'string' ? rawArgs.query.trim().toLowerCase() : '';
      const srvFilter = typeof rawArgs.server === 'string' ? rawArgs.server.trim().toLowerCase() : '';
      const matched: string[] = [];
      let totalMatched = 0;
      let totalAll = 0;
      for (const { row, tools } of active) {
        if (srvFilter && !row.name.toLowerCase().includes(srvFilter)) continue;
        totalAll += tools.length;
        for (const t of tools) {
          const hit = !q
            || t.name.toLowerCase().includes(q)
            || t.description.toLowerCase().includes(q)
            || row.name.toLowerCase().includes(q);
          if (!hit) continue;
          totalMatched++;
          if (matched.length < 20) {
            matched.push(`- [${row.name}] ${t.name}：${t.description || '无说明'}`);
          }
        }
      }
      const body = matched.length
        ? `共匹配 ${totalMatched} 个工具（显示前 ${matched.length} 个，检索范围共 ${totalAll} 个）：\n${matched.join('\n')}`
        : `未找到匹配「${q || srvFilter}」的工具（当前范围共 ${totalAll} 个工具）。`;
      return {
        text: wrapProvenance('external_data', 'MCP 全局工具目录', body),
        isError: false,
        serverName: 'aic-mcp-hub',
        toolName: 'search_tools',
      };
    }

    if (entry.mode === 'global_describe') {
      const targetName = typeof rawArgs.name === 'string' ? rawArgs.name.trim() : '';
      const srvFilter = typeof rawArgs.server === 'string' ? rawArgs.server : '';
      const resolved = this.resolveGlobalTool(active, targetName, srvFilter);
      if (!resolved.ok) {
        return {
          text: wrapProvenance('external_data', 'MCP 工具说明', resolved.message),
          isError: true,
          serverName: 'aic-mcp-hub',
          toolName: 'describe_tool',
        };
      }
      const body = `所属服务：${resolved.row.name}\n工具名称：${resolved.tool.name}\n说明：${resolved.tool.description || '无'}\n参数结构：\n${JSON.stringify(resolved.tool.inputSchema, null, 2)}`;
      return {
        text: wrapProvenance('external_data', `MCP 工具说明 ${resolved.row.name} / ${resolved.tool.name}`, body),
        isError: false,
        serverName: resolved.row.name,
        toolName: 'describe_tool',
      };
    }

    let row: McpRow;
    let targetTool: string;
    let callArgs: Record<string, unknown>;
    if (entry.mode === 'global_call') {
      const targetName = typeof rawArgs.name === 'string' ? rawArgs.name.trim() : '';
      const srvFilter = typeof rawArgs.server === 'string' ? rawArgs.server : '';
      const resolved = this.resolveGlobalTool(active, targetName, srvFilter);
      if (!resolved.ok) {
        return {
          text: wrapProvenance('external_data', 'MCP 工具调用', resolved.message),
          isError: true,
          serverName: 'aic-mcp-hub',
          toolName: targetName || 'call_tool',
        };
      }
      row = resolved.row;
      targetTool = resolved.tool.name;
      callArgs = rawArgs.arguments && typeof rawArgs.arguments === 'object' && !Array.isArray(rawArgs.arguments)
        ? (rawArgs.arguments as Record<string, unknown>)
        : {};
    } else if (entry.mode === 'direct') {
      row = this.getRow(entry.serverId);
      targetTool = entry.toolName;
      callArgs = rawArgs;
    } else {
      throw Errors.notFound(`当前任务未启用这个 MCP 工具：${exposedName}`);
    }

    const { cfg, secretValues } = await this.resolveRuntimeConfig(row);
    let rawResult: unknown;
    try {
      rawResult = await this.withConcurrency(row, () => invokeMcpTool(cfg, targetTool, callArgs, {
        processes: this.processes,
        stdioPool: this.stdioPool,
        httpSessions: this.httpSessions,
        timeoutMs: this.opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS,
        signal,
        egress: {
          blockedLocalPorts: this.opts.blockedLocalPorts,
          allowFakeIpProxy: this.opts.allowFakeIpProxy?.() ?? false,
        },
      }));
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      this.db.run(
        `UPDATE mcp_servers
         SET status = CASE WHEN enabled = 1 THEN 'error' ELSE 'disabled' END,
             last_error = ?, updated_at = ?
         WHERE id = ?`,
        message,
        now(),
        row.id,
      );
      throw err;
    }

    const ts = now();
    this.db.run(
      `UPDATE mcp_servers
       SET last_called_at = ?, last_called_tool = ?,
           status = CASE WHEN enabled = 1 THEN 'ready' ELSE 'disabled' END,
           last_error = NULL, updated_at = ?
       WHERE id = ?`,
      ts,
      targetTool,
      ts,
      row.id,
    );
    const formatted = formatMcpToolResult(
      row.name,
      targetTool,
      rawResult,
      secretValues,
      this.opts.maxResultChars ?? MCP_MAX_RESULT_CHARS,
      (redactedText) => this.overflow.put({ taskId, serverName: row.name, toolName: targetTool, content: redactedText }).id,
    );
    return {
      text: formatted.text,
      isError: formatted.isError,
      serverName: row.name,
      toolName: targetTool,
      overflowId: formatted.overflowId,
    };
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
    const taskExists = this.db.get('SELECT 1 FROM tasks WHERE id = ?', grant.taskId);
    if (!taskExists) throw Errors.unauthorized('MCP 桥接所属任务已不存在');
    // 会话启动瞬间（spawn 阶段）sessions 行尚未插入；若已落库则必须处于 active 状态
    const sessionRow = this.db.get<{ status: string }>('SELECT status FROM sessions WHERE id = ? AND task_id = ?', grant.sessionId, grant.taskId);
    if (sessionRow && sessionRow.status !== 'active') {
      this.revokeBridge(grant.sessionId);
      throw Errors.unauthorized('MCP 桥接会话已结束');
    }
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
      const activeSession = this.db.get<{ status: string }>('SELECT status FROM sessions WHERE id = ? AND task_id = ?', grant.sessionId, grant.taskId);
      if (!activeSession || activeSession.status !== 'active') {
        throw Errors.unauthorized('MCP 桥接会话尚未就绪或已结束');
      }
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
