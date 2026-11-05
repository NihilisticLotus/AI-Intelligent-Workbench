// 通用小工具：ID、时间、统一错误
import { randomBytes } from 'node:crypto';
import { ErrorCode, type ApiError } from '@aic/protocol';

/** 不透明 ID：前缀 + 随机串，客户端不要解析 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export const now = () => Date.now();

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AbortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export class AbortError extends Error {
  constructor() { super('已取消'); this.name = 'AbortError'; }
}

/** 业务错误：带 HTTP 状态码和协议里的 ApiError，路由和 WebSocket 都用它 */
export class AppError extends Error {
  constructor(public status: number, public body: ApiError) {
    super(body.message);
  }
}

const mk = (status: number, code: string) =>
  (message: string, hint?: string, actions: ApiError['actions'] = []) =>
    new AppError(status, { code, message, ...(hint ? { hint } : {}), actions });

export const Errors = {
  badRequest: mk(400, ErrorCode.BadRequest),
  unauthorized: mk(401, ErrorCode.Unauthorized),
  forbidden: mk(403, ErrorCode.Forbidden),
  forbiddenOrigin: mk(403, ErrorCode.ForbiddenOrigin),
  forbiddenHost: mk(403, ErrorCode.ForbiddenHost),
  notFound: mk(404, ErrorCode.NotFound),
  conflict: mk(409, ErrorCode.Conflict),
  invalidState: mk(409, ErrorCode.InvalidState),
  pairingInvalid: mk(400, ErrorCode.PairingInvalid),
  tooLarge: mk(413, ErrorCode.PayloadTooLarge),
  rateLimited: mk(429, ErrorCode.RateLimited),
  agentUnavailable: mk(503, ErrorCode.AgentUnavailable),
  internal: mk(500, ErrorCode.Internal),
};

/** 把任意异常转成 ApiError（未知异常不泄露内部细节） */
export function toApiError(e: unknown): { status: number; body: ApiError } {
  if (e instanceof AppError) return { status: e.status, body: e.body };
  return { status: 500, body: { code: ErrorCode.Internal, message: '服务内部错误', hint: '请查看终端窗口里的日志，或重启 AI Console', actions: [] } };
}

/** zod 校验失败时给用户看的简短说明 */
export function zodMessage(issues: { path: PropertyKey[]; message: string }[]): string {
  const first = issues[0];
  if (!first) return '请求格式不正确';
  const p = first.path.map(String).join('.');
  return p ? `字段 ${p} 不正确：${first.message}` : `请求格式不正确：${first.message}`;
}
