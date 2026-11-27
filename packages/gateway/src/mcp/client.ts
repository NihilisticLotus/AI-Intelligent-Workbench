// MCP Stdio 与 Streamable HTTP JSON-RPC 2.0 客户端（第 2.3-R 步升级）：
// - stdio：复用 StdioMcpPool 常驻单实例进程池（含 Windows npx/npm 安全解析、空闲回收、2 MB 单行上限与 45 秒看门狗）；
// - http：接入 2.1 统一出站门禁、完整兼容 Streamable HTTP SSE（event: message + data:）、notifications/initialized 与 Mcp-Session-Id 复用；
// - tools/list：自动处理 nextCursor 游标分页（带最大页数与工具数上限防死循环）；
// - 工具返回：密钥脱敏 + UTF-16 安全头尾摘要截断（配套沙盒溢出分页回查提示）+ 2.1 external_data 防注入围栏。
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { redactExact } from '@aic/adapters';
import { McpToolInfo, type McpTestStep } from '@aic/protocol';
import type { ProcessRegistry } from '../processes';
import { assertEgressUrl, createPinnedLookup, type EgressPolicyOptions } from '../security/egress';
import { wrapProvenance } from '../security/provenance';
import { Errors } from '../util';
import { safeSliceHead, safeSliceTail } from './overflow';
import { MCP_PROTOCOL_VERSION, StdioMcpPool } from './pool';

export const MCP_DEFAULT_TIMEOUT_MS = 45_000;
export const MCP_MAX_RESULT_CHARS = 8_000;
export const MCP_MAX_HTTP_BYTES = 1024 * 1024;
export const MCP_MAX_TOOLS_PER_SERVER = 500;
export const MCP_MAX_LIST_PAGES = 10;
const HTTP_SESSION_TTL_MS = 10 * 60_000;

export interface McpRuntimeConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
}

export interface McpClientOptions {
  processes?: ProcessRegistry;
  stdioPool?: StdioMcpPool;
  httpSessions?: HttpMcpSessionStore;
  /** 本次探测结束后是否保留常驻进程（例如已停用服务测试完立即回收） */
  keepWarm?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  egress?: EgressPolicyOptions;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

interface HttpSessionEntry {
  fingerprint: string;
  sessionId: string | null;
  lastUsedAt: number;
}

/** HTTP Streamable MCP 会话缓存：复用 Mcp-Session-Id 避免每次 tools/call 重复握手。 */
export class HttpMcpSessionStore {
  private sessions = new Map<string, HttpSessionEntry>();

  private fingerprint(cfg: McpRuntimeConfig): string {
    const sortedHeaders = Object.entries(cfg.headers).sort(([a], [b]) => a.localeCompare(b));
    return createHash('sha256').update(JSON.stringify({ url: cfg.url, headers: sortedHeaders })).digest('hex');
  }

  get(cfg: McpRuntimeConfig): { sessionId: string | null } | null {
    const entry = this.sessions.get(cfg.id);
    if (!entry) return null;
    if (Date.now() - entry.lastUsedAt > HTTP_SESSION_TTL_MS || entry.fingerprint !== this.fingerprint(cfg)) {
      this.sessions.delete(cfg.id);
      return null;
    }
    entry.lastUsedAt = Date.now();
    return { sessionId: entry.sessionId };
  }

  set(cfg: McpRuntimeConfig, sessionId: string | null): void {
    this.sessions.set(cfg.id, {
      fingerprint: this.fingerprint(cfg),
      sessionId,
      lastUsedAt: Date.now(),
    });
  }

  evict(serverId: string): void {
    this.sessions.delete(serverId);
  }

  clearAll(): void {
    this.sessions.clear();
  }
}

function normalizeToolsBatch(raw: unknown): { tools: McpToolInfo[]; nextCursor: string | null } {
  const rec = raw && typeof raw === 'object' ? (raw as { tools?: unknown; nextCursor?: unknown }) : {};
  const list = Array.isArray(rec.tools) ? rec.tools : [];
  const out: McpToolInfo[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== 'string' || !obj.name.trim()) continue;
    const description = typeof obj.description === 'string' ? obj.description.slice(0, 1000) : '';
    const rawSchema = obj.inputSchema && typeof obj.inputSchema === 'object' && !Array.isArray(obj.inputSchema)
      ? (obj.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
    out.push(McpToolInfo.parse({
      name: obj.name.trim().slice(0, 128),
      description,
      inputSchema: rawSchema,
    }));
  }
  const nextCursor = typeof rec.nextCursor === 'string' && rec.nextCursor.trim() ? rec.nextCursor.trim() : null;
  return { tools: out, nextCursor };
}

/** 自动翻页拉取 tools/list（兼容 nextCursor，带最大页数与总数上限防死循环）。 */
async function listAllTools(
  fetchPage: (cursor?: string) => Promise<unknown>,
): Promise<{ tools: McpToolInfo[]; pages: number; capped: boolean }> {
  const seenNames = new Set<string>();
  const seenCursors = new Set<string>();
  const all: McpToolInfo[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let capped = false;

  while (pages < MCP_MAX_LIST_PAGES) {
    pages++;
    const raw = await fetchPage(cursor);
    const batch = normalizeToolsBatch(raw);
    for (const tool of batch.tools) {
      if (seenNames.has(tool.name)) continue;
      seenNames.add(tool.name);
      all.push(tool);
      if (all.length >= MCP_MAX_TOOLS_PER_SERVER) {
        capped = true;
        return { tools: all, pages, capped };
      }
    }
    if (!batch.nextCursor || seenCursors.has(batch.nextCursor)) break;
    seenCursors.add(batch.nextCursor);
    cursor = batch.nextCursor;
  }

  if (cursor && pages >= MCP_MAX_LIST_PAGES) capped = true;
  return { tools: all, pages, capped };
}

function extractCallText(rawResult: unknown): { text: string; isError: boolean } {
  if (!rawResult || typeof rawResult !== 'object') {
    return { text: String(rawResult ?? ''), isError: false };
  }
  const rec = rawResult as { content?: unknown; isError?: unknown };
  const isError = rec.isError === true;
  if (Array.isArray(rec.content)) {
    const parts: string[] = [];
    for (const block of rec.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      } else if (b.type === 'resource' && b.resource && typeof b.resource === 'object') {
        const res = b.resource as Record<string, unknown>;
        if (typeof res.text === 'string') parts.push(res.text);
      } else {
        try { parts.push(JSON.stringify(b)); } catch { /* 忽略不可序列化块 */ }
      }
    }
    return { text: parts.join('\n'), isError };
  }
  try {
    return { text: JSON.stringify(rawResult), isError };
  } catch {
    return { text: String(rawResult), isError };
  }
}

/**
 * 统一封装 MCP 工具返回（第 2.3-R 步升级）：
 * 1) 先剥除本次注入的明文密钥，再决定是否存入溢出缓存；
 * 2) 超出 8,000 字符采用 UTF-16 安全「头尾摘要」截断（默认保留前 70% + 后 30%），避免丢掉关键末尾报错；
 * 3) 若提供了 overflowId，附上分页回查工具提示（aic_mcp__read_output，零本机路径）；
 * 4) 包裹 2.1 的 external_data 防伪信封（information only），防范间接提示词注入。
 */
export function formatMcpToolResult(
  serverName: string,
  toolName: string,
  rawResult: unknown,
  secrets: readonly string[],
  maxChars = MCP_MAX_RESULT_CHARS,
  onOverflow?: (redactedText: string) => string | null,
): { text: string; isError: boolean; truncated: boolean; originalChars: number; overflowId: string | null } {
  const { text: extracted, isError } = extractCallText(rawResult);
  const redacted = secrets.length ? redactExact(extracted, secrets) : extracted;
  const originalChars = redacted.length;
  const truncated = originalChars > maxChars;
  let overflowId: string | null = null;
  let body: string;

  if (truncated) {
    overflowId = onOverflow ? onOverflow(redacted) : null;
    const readHint = overflowId
      ? `如需查看中间省略内容，请调用 aic_mcp__read_output（outputId="${overflowId}"，指定 offset 与 limit，单次最多读取 8,000 字符）。`
      : '如需其余内容请缩小查询范围。';

    if (maxChars >= 200) {
      const headBudget = Math.floor(maxChars * 0.7);
      const tailBudget = maxChars - headBudget;
      const head = safeSliceHead(redacted, headBudget);
      const tail = safeSliceTail(redacted, tailBudget);
      const omitted = Math.max(0, originalChars - head.length - tail.length);
      body = `【MCP 返回已自动限流截断：原始长度 ${originalChars} 字符，已保留头部 ${head.length} 字符与尾部 ${tail.length} 字符（中间省略 ${omitted} 字符）；${readHint}】\n${head}\n\n……（中间省略 ${omitted} 字符，起始偏移 offset=${head.length}）……\n\n${tail}`;
    } else {
      const head = safeSliceHead(redacted, maxChars);
      body = `【MCP 返回已自动限流截断：原始长度 ${originalChars} 字符，已保留前 ${head.length} 字符；${readHint}】\n${head}\n……（以下省略 ${originalChars - head.length} 字符）`;
    }
  } else {
    body = redacted || '（工具返回为空）';
  }

  const fenced = wrapProvenance('external_data', `MCP 工具 ${serverName} / ${toolName}`, body);
  return { text: fenced, isError, truncated, originalChars, overflowId };
}

/**
 * 解析 MCP Streamable HTTP 返回体：
 * 同时兼容 application/json 与 text/event-stream（含 event: message / 注释行 / 多事件流）。
 */
export function parseHttpMcpBody(
  rawText: string,
  contentType: string,
  expectedId?: number,
): JsonRpcResponse {
  const trimmed = rawText.trim();
  if (!trimmed) return { result: {} };

  const looksLikeSse = /\btext\/event-stream\b/i.test(contentType)
    || /^(?:event:|data:|:)/m.test(trimmed);

  if (!looksLikeSse) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch {
      throw new Error('MCP HTTP 服务返回的内容不是有效的 JSON-RPC 响应');
    }
  }

  const events = trimmed.split(/\r?\n\r?\n/);
  const parsedList: JsonRpcResponse[] = [];
  for (const block of events) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (!dataLines.length) continue;
    const payload = dataLines.join('\n').trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as JsonRpcResponse;
      if (obj && typeof obj === 'object') parsedList.push(obj);
    } catch {
      // 忽略 SSE 心跳或非 JSON 注释块
    }
  }

  if (!parsedList.length) {
    throw new Error('MCP HTTP SSE 响应中未找到有效的 JSON-RPC 消息');
  }
  if (expectedId !== undefined) {
    const matched = parsedList.find((m) => m.id === expectedId);
    if (matched) return matched;
  }
  return parsedList.at(-1)!;
}

class HttpStatusError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

/** 经 2.1 统一出站门禁发送一次 HTTP MCP JSON-RPC 2.0 POST 请求。 */
async function postHttpMcp(
  cfg: McpRuntimeConfig,
  opts: McpClientOptions,
  payload: Record<string, unknown>,
  sessionHeader?: string | null,
  isNotification = false,
): Promise<{ json: JsonRpcResponse; sessionId: string | null; statusCode: number }> {
  if (!cfg.url) throw Errors.badRequest('MCP 服务缺少远程地址');
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const parsed = new URL(cfg.url);
  const hostNoBrackets = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopbackExplicit = hostNoBrackets === '127.0.0.1' || hostNoBrackets === '::1';
  const policy: EgressPolicyOptions = {
    allowLocalhost: hostNoBrackets === 'localhost',
    allowExplicitPrivateIp: isLoopbackExplicit,
    ...opts.egress,
  };
  assertEgressUrl(parsed, policy);
  const pinnedLookup = createPinnedLookup(parsed, policy);
  const body = JSON.stringify(payload);
  const reqFn = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'content-length': String(Buffer.byteLength(body)),
    ...cfg.headers,
  };
  if (sessionHeader) headers['mcp-session-id'] = sessionHeader;

  return new Promise((resolve, reject) => {
    const req = reqFn(parsed, {
      method: 'POST',
      headers,
      lookup: pinnedLookup,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        return reject(new Error('MCP 远程服务返回了重定向，安全策略已拒绝跟随'));
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MCP_MAX_HTTP_BYTES) {
          res.destroy(new Error(`MCP HTTP 响应超过大小上限（${MCP_MAX_HTTP_BYTES} 字节）`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0;
        const rawText = Buffer.concat(chunks).toString('utf8');
        const nextSession = typeof res.headers['mcp-session-id'] === 'string'
          ? res.headers['mcp-session-id']
          : sessionHeader ?? null;
        if (isNotification) {
          // notifications/initialized 返回 200 / 202 / 204 均视为成功；部分简化服务未实现通知端点返回 400/404/405 也不阻断
          return resolve({ json: { result: {} }, sessionId: nextSession, statusCode });
        }
        if (!statusCode || statusCode >= 400) {
          return reject(new HttpStatusError(statusCode, `MCP HTTP 服务返回错误状态（HTTP ${statusCode}）`));
        }
        const ct = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : '';
        try {
          const expectedId = typeof payload.id === 'number' ? payload.id : undefined;
          const json = parseHttpMcpBody(rawText, ct, expectedId);
          resolve({ json, sessionId: nextSession, statusCode });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });

    const onAbort = () => req.destroy(new Error('MCP 调用已取消'));
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(new Error(`MCP HTTP 响应超过 ${Math.round(timeoutMs / 1000)} 秒超时`)));
    req.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    req.on('close', () => opts.signal?.removeEventListener('abort', onAbort));
    req.end(body);
  });
}

async function initializeHttpMcp(cfg: McpRuntimeConfig, opts: McpClientOptions): Promise<string | null> {
  const initRes = await postHttpMcp(cfg, opts, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ai-console', version: '0.1.0' } },
  });
  if (initRes.json.error) throw new Error(initRes.json.error.message || 'MCP HTTP 握手失败');
  // 遵循 MCP Streamable HTTP 规范发送 notifications/initialized
  await postHttpMcp(cfg, opts, { jsonrpc: '2.0', method: 'notifications/initialized' }, initRes.sessionId, true).catch(() => {});
  opts.httpSessions?.set(cfg, initRes.sessionId);
  return initRes.sessionId;
}

/** 测试 MCP 连接：执行 initialize + notifications/initialized + 分页 tools/list，返回分步中文日志与工具清单。 */
export async function probeMcpServer(
  cfg: McpRuntimeConfig,
  opts: McpClientOptions = {},
): Promise<{ steps: McpTestStep[]; tools: McpToolInfo[] }> {
  const steps: McpTestStep[] = [];
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;

  if (cfg.transport === 'stdio') {
    if (!cfg.command) throw Errors.badRequest('MCP 服务缺少启动命令');
    const ownPool = !opts.stdioPool;
    const pool = opts.stdioPool ?? new StdioMcpPool({ processes: opts.processes });
    const spec = { id: cfg.id, name: cfg.name, command: cfg.command, args: cfg.args, env: cfg.env };
    try {
      // 测试连接时若已有旧常驻实例，先温和回收再重新握手以验证最新配置
      await pool.evict(cfg.id);
      steps.push({ step: '启动服务', ok: true, detail: `已按白名单隔离环境无黑框启动：${cfg.command}` });
      const { tools, pages, capped } = await listAllTools((cursor) =>
        pool.rpc(spec, 'tools/list', cursor ? { cursor } : {}, { timeoutMs, signal: opts.signal }),
      );
      steps.push({ step: '协议握手', ok: true, detail: 'MCP initialize 与 initialized 握手成功（已加入常驻共享池）' });
      const extra = [
        pages > 1 ? `分页 ${pages} 页` : '',
        capped ? `达到单服务上限 ${MCP_MAX_TOOLS_PER_SERVER}` : '',
        tools.length > 40 ? '超过 40 个，调用时将自动折叠为渐进式搜索' : '',
      ].filter(Boolean).join('，');
      steps.push({ step: '读取工具清单', ok: true, detail: `发现 ${tools.length} 个工具${extra ? `（${extra}）` : ''}` });
      return { steps, tools };
    } finally {
      if (ownPool || opts.keepWarm === false) {
        await pool.evict(cfg.id);
      }
    }
  }

  // HTTP 传输
  steps.push({ step: '地址检查', ok: true, detail: `通过安全出站检查：${cfg.url}` });
  const sessionId = await initializeHttpMcp(cfg, opts);
  steps.push({ step: '协议握手', ok: true, detail: sessionId ? 'MCP HTTP 握手成功并建立会话复用' : 'MCP HTTP initialize 握手成功' });

  let reqSeq = 2;
  const { tools, pages, capped } = await listAllTools(async (cursor) => {
    const listRes = await postHttpMcp(cfg, opts, {
      jsonrpc: '2.0',
      id: reqSeq++,
      method: 'tools/list',
      params: cursor ? { cursor } : {},
    }, sessionId);
    if (listRes.json.error) throw new Error(listRes.json.error.message || '读取工具列表失败');
    return listRes.json.result;
  });
  const extra = [
    pages > 1 ? `分页 ${pages} 页` : '',
    capped ? `达到单服务上限 ${MCP_MAX_TOOLS_PER_SERVER}` : '',
    tools.length > 40 ? '超过 40 个，调用时将自动折叠为渐进式搜索' : '',
  ].filter(Boolean).join('，');
  steps.push({ step: '读取工具清单', ok: true, detail: `发现 ${tools.length} 个工具${extra ? `（${extra}）` : ''}` });
  if (opts.keepWarm === false) opts.httpSessions?.evict(cfg.id);
  return { steps, tools };
}

/** 调用一次 MCP 工具（优先复用常驻 Stdio 进程池或 HTTP 会话），返回原始 JSON-RPC result。 */
export async function invokeMcpTool(
  cfg: McpRuntimeConfig,
  toolName: string,
  args: Record<string, unknown>,
  opts: McpClientOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;

  if (cfg.transport === 'stdio') {
    if (!cfg.command) throw Errors.badRequest('MCP 服务缺少启动命令');
    const ownPool = !opts.stdioPool;
    const pool = opts.stdioPool ?? new StdioMcpPool({ processes: opts.processes });
    const spec = { id: cfg.id, name: cfg.name, command: cfg.command, args: cfg.args, env: cfg.env };
    try {
      return await pool.rpc(spec, 'tools/call', { name: toolName, arguments: args }, { timeoutMs, signal: opts.signal });
    } finally {
      if (ownPool) await pool.evict(cfg.id);
    }
  }

  // HTTP：优先复用已握手的 Mcp-Session-Id，若服务端返回 404 或会话失效则自动重握手一次
  const cached = opts.httpSessions?.get(cfg);
  let sessionId = cached ? cached.sessionId : await initializeHttpMcp(cfg, opts);

  const callOnce = async (sid: string | null) => {
    const callRes = await postHttpMcp(cfg, opts, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }, sid);
    if (callRes.sessionId && callRes.sessionId !== sid) {
      opts.httpSessions?.set(cfg, callRes.sessionId);
    }
    if (callRes.json.error) throw new Error(callRes.json.error.message || 'MCP 工具调用失败');
    return callRes.json.result;
  };

  try {
    return await callOnce(sessionId);
  } catch (err) {
    // 只有使用了缓存会话且服务端提示 404/会话失效时，自动重握手重试一次
    const isSessionExpired = err instanceof HttpStatusError && (err.statusCode === 404 || err.statusCode === 400);
    if (cached && isSessionExpired && !opts.signal?.aborted) {
      opts.httpSessions?.evict(cfg.id);
      sessionId = await initializeHttpMcp(cfg, opts);
      return await callOnce(sessionId);
    }
    throw err;
  }
}
