// 通用小工具：ID、时间、统一错误
import { randomBytes } from 'node:crypto';
import { ErrorCode, type ApiError } from '@aic/protocol';
import { AgentError } from '@aic/adapters';

/** 不透明 ID：前缀 + 随机串，客户端不要解析 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export const now = () => Date.now();

/** 1.2 起 AbortError、sleep 与适配器共用同一份（演示 Agent 移到了 @aic/adapters，instanceof 判断要一致） */
export { AbortError, sleep } from '@aic/adapters';

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
  // 1.2 新增
  levelUnavailable: mk(400, ErrorCode.PermissionLevelUnavailable),
  profileInUse: mk(409, ErrorCode.ProfileInUse),
  secretUnavailable: mk(503, ErrorCode.SecretUnavailable),
  notRecoverable: mk(409, ErrorCode.SessionNotRecoverable),
};

/** 适配器错误的 HTTP 状态码 */
function agentStatus(e: AgentError): number {
  switch (e.reason) {
    case 'invalid_value': return 400;
    case 'auth': return 409; // 不用 401：客户端会把 401 当成设备令牌失效
    case 'quota': return 409;
    case 'unsupported': return 409;
    case 'not_found': return 409;
    default: return 502;
  }
}

/** 把任意异常转成 ApiError（未知异常不泄露内部细节） */
export function toApiError(e: unknown): { status: number; body: ApiError } {
  if (e instanceof AppError) return { status: e.status, body: e.body };
  if (e instanceof AgentError) return { status: agentStatus(e), body: e.body };
  return { status: 500, body: { code: ErrorCode.Internal, message: '服务内部错误', hint: '请查看终端窗口里的日志，或重启 AI Console', actions: [] } };
}

/** zod 校验失败时给用户看的简短说明 */
export function zodMessage(issues: { path: PropertyKey[]; message: string }[]): string {
  const first = issues[0];
  if (!first) return '请求格式不正确';
  const p = first.path.map(String).join('.');
  return p ? `字段 ${p} 不正确：${first.message}` : `请求格式不正确：${first.message}`;
}
