// MCP Stdio 与 HTTP JSON-RPC 2.0 客户端：
// - stdio：强制 shell:false、windowsHide:true、2.1 环境变量白名单隔离、ProcessRegistry 登记、45 秒看门狗强杀整棵进程树；
// - http：接入 2.1 统一出站门禁（禁止内网探测与回打本机 Gateway 端口）、禁止重定向、有界响应；
// - 工具返回：密钥脱敏 + 8,000 字符截断摘要 + 2.1 external_data 防注入围栏。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { killTree, redactExact } from '@aic/adapters';
import { McpToolInfo, type McpTestStep } from '@aic/protocol';
import type { ProcessRegistry } from '../processes';
import { buildIsolatedSubprocessEnv } from '../security/env-policy';
import { assertEgressUrl, createPinnedLookup, type EgressPolicyOptions } from '../security/egress';
import { wrapProvenance } from '../security/provenance';
import { Errors } from '../util';

export const MCP_DEFAULT_TIMEOUT_MS = 45_000;
export const MCP_MAX_RESULT_CHARS = 8_000;
export const MCP_MAX_HTTP_BYTES = 512 * 1024;
const MCP_PROTOCOL_VERSION = '2025-06-18';

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
  timeoutMs?: number;
  signal?: AbortSignal;
  egress?: EgressPolicyOptions;
}

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function normalizeTools(raw: unknown): McpToolInfo[] {
  const list = Array.isArray((raw as { tools?: unknown })?.tools) ? (raw as { tools: unknown[] }).tools : [];
  const out: McpToolInfo[] = [];
  for (const item of list.slice(0, 200)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== 'string' || !rec.name.trim()) continue;
    const description = typeof rec.description === 'string' ? rec.description.slice(0, 1000) : '';
    const rawSchema = rec.inputSchema && typeof rec.inputSchema === 'object' && !Array.isArray(rec.inputSchema)
      ? (rec.inputSchema as Record<string, unknown>)
      : { type: 'object', properties: {} };
    out.push(McpToolInfo.parse({
      name: rec.name.trim().slice(0, 128),
      description,
      inputSchema: rawSchema,
    }));
  }
  return out;
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
 * 统一封装 MCP 工具返回：
 * 1) 剥除本次注入的明文密钥；
 * 2) 超出 8,000 字符自动截断并附带结构化摘要说明；
 * 3) 包裹 2.1 的 external_data 防伪信封（information only），防范间接提示词注入。
 */
export function formatMcpToolResult(
  serverName: string,
  toolName: string,
  rawResult: unknown,
  secrets: readonly string[],
  maxChars = MCP_MAX_RESULT_CHARS,
): { text: string; isError: boolean; truncated: boolean; originalChars: number } {
  const { text: extracted, isError } = extractCallText(rawResult);
  const redacted = secrets.length ? redactExact(extracted, secrets) : extracted;
  const originalChars = redacted.length;
  const truncated = originalChars > maxChars;
  const body = truncated
    ? `【MCP 返回已自动限流截断：原始长度 ${originalChars} 字符，已保留前 ${maxChars} 字符；如需其余内容请缩小查询范围。】\n${redacted.slice(0, maxChars)}\n……（以下省略 ${originalChars - maxChars} 字符）`
    : redacted || '（工具返回为空）';
  const fenced = wrapProvenance('external_data', `MCP 工具 ${serverName} / ${toolName}`, body);
  return { text: fenced, isError, truncated, originalChars };
}

/** 在受控子进程（无黑框、环境变量白名单、看门狗强杀）中执行一次 stdio MCP 会话并立即清理进程树。 */
async function withStdioMcp<T>(
  cfg: McpRuntimeConfig,
  opts: McpClientOptions,
  run: (rpc: (method: string, params?: Record<string, unknown>) => Promise<unknown>, notify: (method: string, params?: Record<string, unknown>) => void) => Promise<T>,
): Promise<T> {
  if (!cfg.command) throw Errors.badRequest('MCP 服务缺少启动命令');
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const home = mkdtempSync(path.join(tmpdir(), 'aic-mcp-'));
  const env = buildIsolatedSubprocessEnv({ home, extraVars: cfg.env });

  const child = spawn(cfg.command, cfg.args, {
    cwd: home,
    env,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  const startedAt = Date.now();
  if (pid) {
    opts.processes?.started({ pid, agent: 'independent', sessionId: `mcp:${cfg.id}`, startedAt });
  }

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  let settledExit = false;
  let stderrTail = '';
  const secrets = Object.values(cfg.env).filter(Boolean);

  const rejectAll = (err: Error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    pending.clear();
  };

  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-800);
  });
  child.stdin?.on('error', () => { /* 子进程提前退出时的 EPIPE 由 exit/close 处理 */ });

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcResponse;
    try { msg = JSON.parse(line) as JsonRpcResponse; } catch { return; }
    if (typeof msg.id !== 'number') return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) {
      const m = msg.error.message ? redactExact(msg.error.message, secrets) : `MCP 错误 (${msg.error.code ?? -1})`;
      entry.reject(new Error(m));
    } else {
      entry.resolve(msg.result);
    }
  });

  const onExit = (code: number | null, sig: string | null) => {
    if (settledExit) return;
    settledExit = true;
    const hint = stderrTail.trim() ? `：${redactExact(stderrTail.trim(), secrets).slice(0, 200)}` : '';
    rejectAll(new Error(`MCP 进程提前退出（code=${code ?? 'null'}, signal=${sig ?? 'null'}）${hint}`));
  };
  child.once('error', (err) => {
    if (settledExit) return;
    settledExit = true;
    rejectAll(new Error(`无法启动 MCP 命令（${cfg.command}）：${err.message}`));
  });
  child.once('exit', onExit);

  const onAbort = () => {
    rejectAll(new Error('MCP 调用已取消'));
    if (pid) void killTree(pid);
  };
  if (opts.signal?.aborted) {
    onAbort();
  } else {
    opts.signal?.addEventListener('abort', onAbort, { once: true });
  }

  const notify = (method: string, params?: Record<string, unknown>) => {
    if (!child.stdin || child.stdin.destroyed) return;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }) + '\n');
  };

  const rpc = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (settledExit) return Promise.reject(new Error('MCP 进程已退出'));
    if (opts.signal?.aborted) return Promise.reject(new Error('MCP 调用已取消'));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 响应超过 ${Math.round(timeoutMs / 1000)} 秒未返回，已自动中止并回收进程`));
        if (pid) void killTree(pid);
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n');
    });
  };

  try {
    return await run(rpc, notify);
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    rl.close();
    rejectAll(new Error('MCP 会话已结束'));
    if (pid) {
      await killTree(pid);
      opts.processes?.exited(pid);
    }
    try { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* 忽略临时目录占用 */ }
  }
}

/** 经 2.1 统一出站门禁发送一次 HTTP MCP JSON-RPC 2.0 POST 请求。 */
async function postHttpMcp(
  cfg: McpRuntimeConfig,
  opts: McpClientOptions,
  payload: Record<string, unknown>,
  sessionHeader?: string | null,
): Promise<{ json: JsonRpcResponse; sessionId: string | null }> {
  if (!cfg.url) throw Errors.badRequest('MCP 服务缺少远程地址');
  const timeoutMs = opts.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const parsed = new URL(cfg.url);
  const hostNoBrackets = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isLoopbackExplicit = hostNoBrackets === '127.0.0.1' || hostNoBrackets === '::1';
  // 允许用户显式配置本机 HTTP MCP（但通过 blockedLocalPorts 严格禁止回打 Gateway 自身端口，且禁止云元数据与内网探测）
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
        const rawText = Buffer.concat(chunks).toString('utf8').trim();
        if (!res.statusCode || res.statusCode >= 400) {
          return reject(new Error(`MCP HTTP 服务返回错误状态（HTTP ${res.statusCode ?? 0}）`));
        }
        const nextSession = typeof res.headers['mcp-session-id'] === 'string' ? res.headers['mcp-session-id'] : sessionHeader ?? null;
        // 兼容 Streamable HTTP 返回 JSON 或 SSE data: 行
        const jsonText = rawText.startsWith('data:')
          ? rawText.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).at(-1) ?? ''
          : rawText;
        if (!jsonText) return resolve({ json: { result: {} }, sessionId: nextSession });
        try {
          resolve({ json: JSON.parse(jsonText) as JsonRpcResponse, sessionId: nextSession });
        } catch {
          reject(new Error('MCP HTTP 服务返回的内容不是有效的 JSON-RPC 响应'));
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

/** 测试 MCP 连接：执行 initialize + tools/list，返回分步中文日志与工具清单。 */
export async function probeMcpServer(
  cfg: McpRuntimeConfig,
  opts: McpClientOptions = {},
): Promise<{ steps: McpTestStep[]; tools: McpToolInfo[] }> {
  const steps: McpTestStep[] = [];
  if (cfg.transport === 'stdio') {
    const tools = await withStdioMcp(cfg, opts, async (rpc, notify) => {
      steps.push({ step: '启动服务', ok: true, detail: `已按白名单隔离环境无黑框启动：${cfg.command}` });
      await rpc('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-console', version: '0.1.0' },
      });
      notify('notifications/initialized');
      steps.push({ step: '协议握手', ok: true, detail: 'MCP initialize 握手成功' });
      const listed = await rpc('tools/list', {});
      const parsed = normalizeTools(listed);
      steps.push({ step: '读取工具清单', ok: true, detail: `发现 ${parsed.length} 个工具${parsed.length > 40 ? '（超过 40 个，调用时将自动折叠为 3 步搜索/查看/执行）' : ''}` });
      return parsed;
    });
    return { steps, tools };
  }

  // HTTP 传输
  steps.push({ step: '地址检查', ok: true, detail: `通过安全出站检查：${cfg.url}` });
  const initRes = await postHttpMcp(cfg, opts, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ai-console', version: '0.1.0' } },
  });
  if (initRes.json.error) throw new Error(initRes.json.error.message || 'MCP HTTP 握手失败');
  steps.push({ step: '协议握手', ok: true, detail: 'MCP HTTP initialize 握手成功' });

  const listRes = await postHttpMcp(cfg, opts, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  }, initRes.sessionId);
  if (listRes.json.error) throw new Error(listRes.json.error.message || '读取工具列表失败');
  const tools = normalizeTools(listRes.json.result);
  steps.push({ step: '读取工具清单', ok: true, detail: `发现 ${tools.length} 个工具${tools.length > 40 ? '（超过 40 个，调用时将自动折叠为 3 步搜索/查看/执行）' : ''}` });
  return { steps, tools };
}

/** 调用一次 MCP 工具，返回原始 JSON-RPC result。 */
export async function invokeMcpTool(
  cfg: McpRuntimeConfig,
  toolName: string,
  args: Record<string, unknown>,
  opts: McpClientOptions = {},
): Promise<unknown> {
  if (cfg.transport === 'stdio') {
    return withStdioMcp(cfg, opts, async (rpc, notify) => {
      await rpc('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ai-console', version: '0.1.0' },
      });
      notify('notifications/initialized');
      return rpc('tools/call', { name: toolName, arguments: args });
    });
  }

  const initRes = await postHttpMcp(cfg, opts, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'ai-console', version: '0.1.0' } },
  });
  if (initRes.json.error) throw new Error(initRes.json.error.message || 'MCP HTTP 握手失败');
  const callRes = await postHttpMcp(cfg, opts, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  }, initRes.sessionId);
  if (callRes.json.error) throw new Error(callRes.json.error.message || 'MCP 工具调用失败');
  return callRes.json.result;
}
