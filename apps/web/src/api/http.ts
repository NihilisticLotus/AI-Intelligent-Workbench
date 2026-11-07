// REST 客户端：所有请求都走 /api/v1，统一处理错误格式 ApiError。
// 只认一个基础地址 baseUrl（默认同源 ''）；以后局域网或外网访问时只是换这个地址。
// 凭据由 getAuthHeaders 提供（见 credentials.ts）：浏览器是 HttpOnly Cookie（credentials: 'include'）+ X-AIC-Key，
// 桌面和手机应用是 Authorization: Bearer。
import {
  AttachmentInfo, AgentInfo, AgentLoginResult, AgentProfile, AgentTestResult, API_BASE, ApiError, Approval, DeleteProfileResult, Device, ErrorCode, EventEnvelope,
  FsBrowseResult, Group, Hello, OkResult, Page, PairingCompleteResult, PairingStartResult, Project, RedetectResult, Task, TaskDraft,
  type AgentKind, type AgentLoginBody, type CreateProfileBody, type DeviceKind, type PatchAgentBody, type PatchProfileBody, type PutTaskDraftBody,
} from '@aic/protocol';
import { z } from 'zod';

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

/**
 * 历史事件分页：逐条解析，不认识的事件（新版 Gateway 加的类型）跳过，和 WebSocket 一样处理（phase-1.md 第 2 节）。
 * 只有分页外壳不对时才报错。rawCount、lastSeq 按原始条数算，分页不会因为跳过的事件卡住
 */
export function parseEventPage(raw: unknown): { items: EventEnvelope[]; nextCursor: string | null; rawCount: number; lastSeq: number | null; skipped: number } {
  const shell = Page(z.unknown()).parse(raw);
  const items: EventEnvelope[] = [];
  let lastSeq: number | null = null;
  for (const it of shell.items) {
    const seq = (it as { seq?: unknown } | null)?.seq;
    if (typeof seq === 'number') lastSeq = seq;
    const p = EventEnvelope.safeParse(it);
    if (p.success) items.push(p.data);
  }
  return { items, nextCursor: shell.nextCursor, rawCount: shell.items.length, lastSeq, skipped: shell.items.length - items.length };
}

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

  attachmentInfo(taskId: string, id: string) { return this.request('GET', `/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(id)}/info`, { parse: AttachmentInfo }); }
  async attachmentBlob(taskId: string, id: string): Promise<Blob> {
    const res = await this.fetchImpl(this.baseUrl + API_BASE + `/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(id)}`, { credentials: 'include', headers: this.opts.getAuthHeaders?.() });
    if (!res.ok) { const body = ApiError.parse(await res.json()); if (res.status === 401) this.opts.onUnauthorized?.(body); throw new ApiRequestError(body, res.status); }
    return res.blob();
  }
  uploadAttachment(taskId: string, file: File, progress: (n: number) => void, signal?: AbortSignal): Promise<AttachmentInfo> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.baseUrl + API_BASE + `/tasks/${encodeURIComponent(taskId)}/attachments`); xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream'); xhr.setRequestHeader('X-AIC-Filename', encodeURIComponent(file.name));
      for (const [key,value] of Object.entries(this.opts.getAuthHeaders?.() ?? {})) xhr.setRequestHeader(key,value);
      xhr.upload.onprogress = (ev) => { if(ev.lengthComputable) progress(Math.round(ev.loaded / ev.total * 100)); };
      const abort = () => xhr.abort(); const cleanup = () => signal?.removeEventListener('abort', abort);
      xhr.onload = () => { cleanup(); try { const data: unknown = JSON.parse(xhr.responseText); if(xhr.status >= 200 && xhr.status < 300) resolve(AttachmentInfo.parse(data)); else { const error = ApiError.parse(data); if(xhr.status === 401)this.opts.onUnauthorized?.(error); reject(new ApiRequestError(error,xhr.status)); } } catch { reject(new Error('上传响应无法识别')); } };
      xhr.onerror = () => { cleanup(); reject(new Error('附件上传失败，请检查连接后重试')); }; xhr.onabort = () => { cleanup(); reject(new Error('附件上传已取消')); };
      if(signal?.aborted) { reject(new Error('附件上传已取消'));return; }signal?.addEventListener('abort',abort,{once:true});xhr.send(file);
    });
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
    /** 1.2：不传或 null 表示用该 Agent 的默认账号 */
    profileId?: string | null; deferPrompt?: boolean; attachments?: string[];
  }) { return this.request('POST', '/tasks', { body, parse: oneOf(Task) }); }
  patchTask(id: string, body: { title?: string; groupId?: string | null; permission?: string; profileId?: string | null }) {
    return this.request('PATCH', `/tasks/${encodeURIComponent(id)}`, { body, parse: oneOf(Task) });
  }
  /** 任务历史事件：after 之后最多 limit 条（不认识的事件类型跳过） */
  taskEvents(id: string, after: number, limit = 500) {
    return this.request('GET', `/tasks/${encodeURIComponent(id)}/events`, { query: { after, limit }, parse: { parse: parseEventPage } });
  }
  agents() { return this.request('GET', '/agents', { parse: listOf(AgentInfo) }).then((r) => r.items); }

  // ---------- 1.2：真实 Agent、登录、账号（phase-1.md 6.6.2） ----------
  /** 任务草稿（输入框里没发出去的文字和注释） */
  getDraft(taskId: string) { return this.request('GET', `/tasks/${encodeURIComponent(taskId)}/draft`, { parse: TaskDraft }); }
  putDraft(taskId: string, body: PutTaskDraftBody) { return this.request('PUT', `/tasks/${encodeURIComponent(taskId)}/draft`, { body, parse: TaskDraft }); }
  /** 重新检测全部 Agent（版本、登录、能力缓存失效） */
  redetectAgents() { return this.request('POST', '/agents/redetect', { body: {}, parse: RedetectResult }).then((r) => r.items); }
  /** 返回值以服务端为准：给了 AgentInfo 就用，否则返回 null，由调用方重新拉 /agents */
  patchAgent(kind: AgentKind, body: PatchAgentBody) {
    return this.request('PATCH', `/agents/${encodeURIComponent(kind)}`, { body }).then((raw) => {
      const p = AgentInfo.safeParse(raw);
      return p.success ? p.data : null;
    });
  }
  startLogin(kind: AgentKind, body: AgentLoginBody) {
    return this.request('POST', `/agents/${encodeURIComponent(kind)}/login`, { body, parse: AgentLoginResult });
  }
  cancelLogin(kind: AgentKind, loginId: string) {
    return this.request('POST', `/agents/${encodeURIComponent(kind)}/login/${encodeURIComponent(loginId)}/cancel`, { body: {}, parse: OkResult });
  }
  sendLoginCode(kind: AgentKind, loginId: string, code: string) {
    return this.request('POST', `/agents/${encodeURIComponent(kind)}/login/${encodeURIComponent(loginId)}/code`, { body: { code }, parse: OkResult });
  }
  testAgent(kind: AgentKind, body: { profileId?: string; sendMessage?: boolean }) {
    return this.request('POST', `/agents/${encodeURIComponent(kind)}/test`, { body, parse: AgentTestResult });
  }
  /** 账号列表：按游标翻完所有页 */
  async profiles(agent?: AgentKind): Promise<AgentProfile[]> {
    const all: AgentProfile[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: { items: AgentProfile[]; nextCursor: string | null } = await this.request('GET', '/profiles', { query: { agent, cursor }, parse: listOf(AgentProfile) });
      all.push(...page.items);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return all;
  }
  /** apiKey 只在这个请求体里出现一次；响应里只有 hasSecret 和末 4 位 */
  createProfile(body: CreateProfileBody) { return this.request('POST', '/profiles', { body, parse: oneOf(AgentProfile) }); }
  patchProfile(id: string, body: PatchProfileBody) { return this.request('PATCH', `/profiles/${encodeURIComponent(id)}`, { body, parse: oneOf(AgentProfile) }); }
  /** keptDir：账号的独立配置目录（登录信息）保留在磁盘上，界面据此提示 */
  deleteProfile(id: string) { return this.request('DELETE', `/profiles/${encodeURIComponent(id)}`, { parse: DeleteProfileResult }); }
  refreshProfileModels(id: string) { return this.request('POST', `/profiles/${encodeURIComponent(id)}/models/refresh`, { body: {}, parse: oneOf(AgentProfile) }); }
  pendingApprovals() { return this.request('GET', '/approvals', { query: { status: 'pending' }, parse: listOf(Approval) }).then((r) => r.items); }
}
