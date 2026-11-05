// REST 客户端：所有请求都走 /api/v1，统一处理错误格式 ApiError。
// 只认一个基础地址 baseUrl（默认同源 ''）；以后局域网或外网访问时只是换这个地址。
// 凭据由 getAuthHeaders 提供（见 credentials.ts）：浏览器是 HttpOnly Cookie（credentials: 'include'）+ X-AIC-Key，
// 桌面和手机应用是 Authorization: Bearer。
import {
  AgentInfo, API_BASE, ApiError, Approval, Device, ErrorCode, EventEnvelope, FsBrowseResult, Group, Hello,
  Page, PairingCompleteResult, PairingStartResult, Project, Task, type DeviceKind,
} from '@aic/protocol';
import type { z } from 'zod';

/** 客户端自己产生的错误码（网络断开、超时等），不在服务端协议里 */
export const ClientErrorCode = {
  Network: 'client.network',
  BadResponse: 'client.bad_response',
  Offline: 'client.offline',
  AckTimeout: 'client.ack_timeout',
  /** 断线期间服务重启了：断线前没收到回应的指令不再重发，交给用户确认 */
  ServerRestarted: 'client.server_restarted',
} as const;

/** 带 ApiError 的异常：界面直接展示 message / hint，并把 actions 渲染成按钮 */
export class ApiRequestError extends Error {
  readonly error: ApiError;
  readonly status: number;
  constructor(error: ApiError, status = 0) {
    super(error.message);
    this.error = error;
    this.status = status;
  }
  get code() { return this.error.code; }
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiRequestError) return e.error;
  return { code: ClientErrorCode.Network, message: '出了点问题', hint: e instanceof Error ? e.message : String(e), actions: [] };
}

export interface HttpClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 每个请求附带的鉴权头（设备密钥或 Bearer 令牌） */
  getAuthHeaders?: () => Record<string, string>;
  /** 收到 401 时回调（令牌失效或设备被吊销），界面据此回到配对页 */
  onUnauthorized?: (err: ApiError) => void;
}

type Query = Record<string, string | number | undefined | null>;

/** 列表接口统一是协议里的分页格式 { items, nextCursor } */
const listOf = <T extends z.ZodTypeAny>(item: T) => ({
  parse(raw: unknown): { items: z.infer<T>[]; nextCursor: string | null } {
    return Page(item).parse(raw) as { items: z.infer<T>[]; nextCursor: string | null };
  },
});

/** 单个实体直接返回（不包一层） */
const oneOf = <T extends z.ZodTypeAny>(schema: T) => ({
  parse(raw: unknown): z.infer<T> { return schema.parse(raw); },
});

export class HttpClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly opts: HttpClientOptions;

  constructor(opts: HttpClientOptions = {}) {
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? '').replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? ((...a) => globalThis.fetch(...a));
  }

  /** WebSocket 地址：同源时由当前页面地址推导 */
  wsUrl(): string {
    const base = this.baseUrl || (typeof location !== 'undefined' ? location.origin : 'http://127.0.0.1:17890');
    return base.replace(/^http/, 'ws') + API_BASE + '/ws';
  }

  async request<T = unknown>(method: string, path: string, opts: { query?: Query; body?: unknown; parse?: { parse(raw: unknown): T } } = {}): Promise<T> {
    let url = this.baseUrl + API_BASE + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += '?' + s;
    }
    const headers: Record<string, string> = { accept: 'application/json', ...this.opts.getAuthHeaders?.() };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method, headers, credentials: 'include',
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch {
      throw new ApiRequestError({
        code: ClientErrorCode.Network, message: '连不上 AI Console 服务',
        hint: '确认启动脚本的窗口还开着；关掉了就重新双击“启动 AI Console”。', actions: [{ label: '重试', action: 'retry' }],
      });
    }

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try { data = JSON.parse(text); } catch { data = undefined; }
    }
    if (!res.ok) {
      const parsed = ApiError.safeParse(data);
      const err: ApiError = parsed.success ? parsed.data : {
        code: res.status === 401 ? ErrorCode.Unauthorized : ClientErrorCode.BadResponse,
        message: res.status === 401 ? '这台设备还没有配对' : `服务返回了错误（${res.status}）`,
        actions: [],
      };
      if (res.status === 401) this.opts.onUnauthorized?.(err);
      throw new ApiRequestError(err, res.status);
    }
    if (!opts.parse) return data as T;
    try {
      return opts.parse.parse(data);
    } catch (e) {
      throw new ApiRequestError({
        code: ClientErrorCode.BadResponse, message: '服务返回的数据和界面版本不匹配',
        hint: '刷新页面；还不行就重新启动 AI Console。' + (e instanceof Error ? `（${e.message.slice(0, 200)}）` : ''),
        actions: [{ label: '刷新页面', action: 'reload' }],
      }, res.status);
    }
  }

  // ---------- 具体接口 ----------
  hello() { return this.request('GET', '/hello', { parse: Hello }); }
  pairingStart() { return this.request('POST', '/pairing/start', { body: {}, parse: PairingStartResult }); }
  /** kind / tokenDelivery 由 Platform 决定：浏览器要 Cookie + 设备密钥，桌面和手机要 Bearer 令牌 */
  pairingComplete(code: string, deviceName: string, kind: DeviceKind, tokenDelivery: 'cookie' | 'bearer') {
    return this.request('POST', '/pairing/complete', { body: { code, deviceName, kind, tokenDelivery }, parse: PairingCompleteResult });
  }
  devices() { return this.request('GET', '/devices', { parse: listOf(Device) }).then((r) => r.items); }
  revokeDevice(id: string) { return this.request('DELETE', `/devices/${encodeURIComponent(id)}`); }

  projects() { return this.request('GET', '/projects', { parse: listOf(Project) }).then((r) => r.items); }
  createProject(name: string, path: string) { return this.request('POST', '/projects', { body: { name, path }, parse: oneOf(Project) }); }
  patchProject(id: string, body: { name?: string }) { return this.request('PATCH', `/projects/${encodeURIComponent(id)}`, { body, parse: oneOf(Project) }); }
  deleteProject(id: string) { return this.request('DELETE', `/projects/${encodeURIComponent(id)}`); }
  /** 只列文件夹；子文件夹很多时分页，cursor 传上一页的 nextCursor */
  browse(path?: string | null, cursor?: string | null) {
    return this.request('GET', '/fs/browse', { query: { path: path ?? undefined, cursor: cursor ?? undefined }, parse: FsBrowseResult });
  }

  groups() { return this.request('GET', '/groups', { parse: listOf(Group) }).then((r) => r.items); }
  createGroup(name: string) { return this.request('POST', '/groups', { body: { name }, parse: oneOf(Group) }); }
  patchGroup(id: string, body: { name?: string; ord?: number }) { return this.request('PATCH', `/groups/${encodeURIComponent(id)}`, { body, parse: oneOf(Group) }); }
  deleteGroup(id: string) { return this.request('DELETE', `/groups/${encodeURIComponent(id)}`); }

  /** 任务列表：按游标翻完所有页 */
  async tasks(query: { projectId?: string; groupId?: string } = {}): Promise<Task[]> {
    const all: Task[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const page: { items: Task[]; nextCursor: string | null } = await this.request('GET', '/tasks', { query: { ...query, cursor }, parse: listOf(Task) });
      all.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return all;
  }
  task(id: string) { return this.request('GET', `/tasks/${encodeURIComponent(id)}`, { parse: oneOf(Task) }); }
  createTask(body: {
    projectId: string; groupId: string | null; prompt: string; title?: string;
    agent: string; model: string | null; effort: string | null; permission: string;
  }) { return this.request('POST', '/tasks', { body, parse: oneOf(Task) }); }
  patchTask(id: string, body: { title?: string; groupId?: string | null; permission?: string }) {
    return this.request('PATCH', `/tasks/${encodeURIComponent(id)}`, { body, parse: oneOf(Task) });
  }
  /** 任务历史事件：after 之后最多 limit 条 */
  taskEvents(id: string, after: number, limit = 500) {
    return this.request('GET', `/tasks/${encodeURIComponent(id)}/events`, { query: { after, limit }, parse: listOf(EventEnvelope) });
  }
  agents() { return this.request('GET', '/agents', { parse: listOf(AgentInfo) }).then((r) => r.items); }
  pendingApprovals() { return this.request('GET', '/approvals', { query: { status: 'pending' }, parse: listOf(Approval) }).then((r) => r.items); }
}
