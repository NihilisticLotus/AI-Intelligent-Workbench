// ACP 错误 → 协议 ApiError（phase-1.md 6.5.3）。message 写给用户看，全部经过脱敏。
import { ErrorActionKey, ErrorCode, type AgentKind, type ApiError } from '@aic/protocol';
import { clip, redact } from '../redact';
import { AgentError, type AgentErrorReason } from '../types';
import { isRecord } from '../util';

const QUOTA_RE = /rate.?limit|quota|usage limit|\b429\b|insufficient|credit|余额|额度/i;
const AUTH_RE = /auth(?:entication)?[ _-]?required|authrequired|not logged in|login required|unauthori[sz]ed|\b401\b|未登录|请先登录/i;
const NOT_FOUND_RE = /resource not found|session not found|no such session|会话不存在/i;

const mk = (body: ApiError, reason: AgentErrorReason) => new AgentError(body, reason);

/** 常用的错误构造 */
export const agentErrors = {
  authRequired: (kind: AgentKind, name: string) => mk({
    code: ErrorCode.AgentAuthRequired, message: `${name} 需要登录`,
    hint: '登录完成后回到任务里点 [继续]',
    actions: [{ label: '去登录', action: ErrorActionKey.Login, args: { kind } }],
  }, 'auth'),
  quota: (kind: AgentKind, name: string, detail: string | null) => mk({
    code: ErrorCode.AgentQuotaExceeded, message: `${name} 的额度或调用频率达到上限`,
    ...(detail ? { hint: detail } : { hint: '可以稍后再试，或者换个模型、换个账号' }),
    actions: [
      { label: '换模型', action: ErrorActionKey.SwitchModel, args: { kind } },
      { label: '换账号', action: ErrorActionKey.SwitchProfile, args: { kind } },
    ],
  }, 'quota'),
  crashed: (kind: AgentKind, name: string) => mk({
    code: ErrorCode.AgentCrashed, message: `${name} 意外退出`,
    hint: '点 [继续] 会自动恢复会话',
    actions: [{ label: '继续', action: ErrorActionKey.Continue, args: { kind } }],
  }, 'crashed'),
  startTimeout: (kind: AgentKind, name: string, method: string) => mk({
    code: ErrorCode.AgentStartTimeout, message: `${name} 启动超时（${method} 没有在规定时间内返回）`,
    hint: '可以再试一次；多次失败的话请在 Agent 页点 [测试连接]',
    actions: [
      { label: '再试一次', action: ErrorActionKey.RetryTask, args: { kind } },
      { label: '测试连接', action: ErrorActionKey.TestAgent, args: { kind } },
    ],
  }, 'start_timeout'),
  timeout: (kind: AgentKind, name: string, method: string) => mk({
    code: ErrorCode.AgentFailed, message: `${name} 没有及时响应（${method}）`, hint: '请稍后再试', actions: [],
  }, 'timeout'),
  protocol: (kind: AgentKind, name: string, detail: string) => mk({
    code: ErrorCode.AgentProtocolError, message: `${name} 返回了无法识别的数据`, hint: detail,
    actions: [{ label: '测试连接', action: ErrorActionKey.TestAgent, args: { kind } }],
  }, 'protocol'),
  /** 权限模式设置不上（或设置后仍比预期宽松）：为了安全不启动会话 */
  modeUnavailable: (kind: AgentKind, name: string, mode: string) => mk({
    code: ErrorCode.PermissionLevelUnavailable, message: `没能把 ${name} 切换到对应的权限模式${mode ? `（${mode}）` : ''}`,
    hint: '为了安全，会话没有启动（Agent 处在更宽松的模式时不会请求审批）。可以再试一次；多次失败的话请在 Agent 页点 [测试连接]',
    actions: [
      { label: '再试一次', action: ErrorActionKey.RetryTask, args: { kind } },
      { label: '测试连接', action: ErrorActionKey.TestAgent, args: { kind } },
    ],
  }, 'failed'),
  unsupported: (name: string, what: string) => mk({
    code: ErrorCode.AgentUnavailable, message: `${name} 不支持${what}`, actions: [],
  }, 'unsupported'),
  notInstalled: (kind: AgentKind, name: string, detail?: string) => mk({
    code: ErrorCode.AgentUnavailable, message: `${name} 没有安装或找不到引擎`,
    ...(detail ? { hint: detail } : {}),
    actions: [{ label: '打开 Agent 页', action: ErrorActionKey.OpenAgents, args: { kind } }],
  }, 'failed'),
};

/** RequestError 一类对象的字段 */
export function errorParts(e: unknown): { code: number | null; message: string; data: unknown } {
  if (isRecord(e) || e instanceof Error) {
    const r = e as unknown as Record<string, unknown>;
    return { code: typeof r.code === 'number' ? r.code : null, message: typeof r.message === 'string' ? r.message : String(e), data: r.data };
  }
  return { code: null, message: String(e), data: undefined };
}

/** 错误信息里的说明文字（data.details / data.message），用于 hint */
export function errorDetail(e: unknown, secrets: readonly string[] = []): string | null {
  const { message, data } = errorParts(e);
  let d: string | null = null;
  if (isRecord(data)) {
    if (typeof data.details === 'string') d = data.details;
    else if (typeof data.message === 'string') d = data.message;
  } else if (typeof data === 'string') d = data;
  const out = d ?? (message && !/^(Internal error|Invalid params)$/i.test(message) ? message : null);
  return out ? clip(redact(out, secrets), 500) : null;
}

/** 是不是“会话不存在”（session/resume、session/load 返回 -32002 或 Resource not found） */
export function isNotFound(e: unknown): boolean {
  if (e instanceof AgentError) return e.reason === 'not_found';
  const { code, message } = errorParts(e);
  return code === -32002 || NOT_FOUND_RE.test(message);
}

export function isAuthError(e: unknown): boolean {
  if (e instanceof AgentError) return e.reason === 'auth';
  const { code, message, data } = errorParts(e);
  const text = `${message} ${safeJson(data)}`;
  if (isRecord(data) && data.category === 'auth') return true;
  if (code === -32000 && /auth/i.test(text)) return true;
  return AUTH_RE.test(text);
}

const safeJson = (v: unknown) => { try { return v === undefined ? '' : JSON.stringify(v); } catch { return ''; } };

/** 从额度错误里尽量找出重置时间 */
export function quotaHint(text: string): string {
  const m = /(?:resets?|try again|retry)\s+(?:at\s+)?((?:\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d\d:\d\d)?)|(?:\d{1,2}:\d{2}(?:\s*(?:UTC|GMT)[+-]?\d*)?)|(?:in\s+\d+\s+(?:seconds?|minutes?|hours?|days?))|(?:\d+\s*[smh]\b)|(?:after\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{4}-\d{2}-\d{2})))/i.exec(text);
  return m ? `额度预计在 ${m[1]!.trim()} 后恢复` : '额度或调用频率达到上限，可以稍后再试，或换个模型 / 账号';
}

/** 只接受整段以已知错误开头的短回复，避免把讨论错误的正常正文误判。 */
export const TEXT_ERROR_PATTERNS = [
  /^(?:The ['"][^'"\n]+['"] model is not supported|model is not supported)\b/i,
  /^upstream_status:\s*HTTP 4\d\d\b/i,
  /^API Error: Request rejected\b/i,
] as const;
export function textResponseError(text: string, kind: AgentKind, name: string, secrets: readonly string[] = []): AgentError | null {
  if (text.length >= 600 || !TEXT_ERROR_PATTERNS.some((p) => p.test(text.trim()))) return null;
  const error = classifyError(new Error(text.trim()), kind, name, secrets);
  return error.reason === 'quota' ? error : new AgentError({ ...error.body,
    actions: [{ label: '换模型', action: ErrorActionKey.SwitchModel, args: { kind } }],
  }, 'invalid_value');
}

/** 任意错误 → AgentError（已经是 AgentError 的原样返回） */
export function classifyError(e: unknown, kind: AgentKind, name: string, secrets: readonly string[] = []): AgentError {
  if (e instanceof AgentError) return e;
  const { code, message, data } = errorParts(e);
  const text = `${message} ${safeJson(data)}`;
  if (isNotFound(e) && code !== -32601) {
    return mk({ code: ErrorCode.SessionNotRecoverable, message: '原来的会话找不到了', actions: [] }, 'not_found');
  }
  if (isAuthError(e)) return agentErrors.authRequired(kind, name);
  if (QUOTA_RE.test(text)) return agentErrors.quota(kind, name, quotaHint(text));
  if (code === -32601) return agentErrors.unsupported(name, `这个操作（${clip(redact(message, secrets), 100)}）`);
  if (/connection closed|进程已退出|ECONNRESET|EPIPE/i.test(message)) return agentErrors.crashed(kind, name);
  const detail = errorDetail(e, secrets);
  return mk({
    code: ErrorCode.AgentFailed,
    message: `${name} 执行出错：${clip(redact(message, secrets), 300)}`,
    ...(detail && detail !== message ? { hint: detail } : { hint: '可以重新发送消息再试一次' }),
    actions: [],
  }, 'failed');
}

/** 设置项被拒绝（-32602 / -32603）：保留原值，把 Agent 的说明放进 hint */
export function invalidValue(e: unknown, name: string, what: string, secrets: readonly string[] = []): AgentError {
  const detail = errorDetail(e, secrets);
  return mk({
    code: ErrorCode.BadRequest, message: `${name} 不接受这个${what}`,
    ...(detail ? { hint: detail } : {}), actions: [],
  }, 'invalid_value');
}
