// 真实 Agent 相关的纯函数：状态文案、权限开放规则、换模型方式、账号描述、测试日志、错误的默认按钮。
// 不碰网络和界面，方便测试（agents.test.ts）。
import {
  ErrorActionKey, ErrorCode, isAllowedBaseUrl,
  type AgentCaps, type AgentInfo, type AgentKind, type AgentProfile, type AgentTestResult, type ApiError,
  type AuthMethod, type ModelInfo, type PermissionLevel, type ProfileKind, type ProfileSummary,
} from '@aic/protocol';
import type { StatusShape } from './format';

/** 演示 Agent 以外都是真实 Agent：第 1.2 步直接在项目目录里运行 */
export const isRealAgent = (kind: AgentKind | string): boolean => kind !== 'fake';

// ---------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------
export function agentStatusText(s: string): string {
  return ({ ready: '就绪', needs_login: '需要登录', not_installed: '未安装', error: '出错', disabled: '已关闭' } as Record<string, string>)[s] ?? s;
}

/** 卡片上的状态：就绪但版本没验证过时显示“未验证版本”（琥珀菱形，照常可用） */
export function agentStatusView(a: AgentInfo): { text: string; shape: StatusShape } {
  if (a.status === 'ready' && !a.verified && (a.version || a.adapterVersion || a.engineVersion)) return { text: '未验证版本', shape: 'wait' };
  // 装了但还不能用（WorkBuddy 精简引擎、ZCode 等桥接）：不是故障，显示“暂不支持”
  if (a.unsupported) return { text: '暂不支持', shape: 'err' };
  const shape: Record<AgentInfo['status'], StatusShape> = { ready: 'ok', needs_login: 'wait', not_installed: 'idle', error: 'err', disabled: 'idle' };
  return { text: agentStatusText(a.status), shape: shape[a.status] };
}

/** 用户是否启用了这个 Agent（Agent 页的开关）；老 Gateway 没有这个字段时都算启用 */
export const isEnabled = (a: Pick<AgentInfo, 'enabled'>): boolean => a.enabled !== false;

/** 能不能派发任务；不能时给出原因（新建任务对话框、切换器显示） */
export function agentReadiness(a: AgentInfo | undefined): { ready: boolean; reason: string | null } {
  if (!a) return { ready: false, reason: '没有检测到这个 Agent' };
  if (a.status === 'ready') return { ready: true, reason: null };
  const base = {
    needs_login: `${a.displayName} 还没有登录`,
    not_installed: `这台电脑上没有找到 ${a.displayName}`,
    error: a.unsupported ? `${a.displayName} 暂时不能在工作台里使用` : `${a.displayName} 检测出错`,
    disabled: `${a.displayName} 已关闭`,
    ready: '',
  }[a.status];
  return { ready: false, reason: joinReason(base, a.message) };
}
/** 拼上 Agent 给的说明；说明开头和我们的文案重复时（“还没有登录：请在……”）去掉重复的那一截 */
function joinReason(base: string, message: string | null): string {
  let m = (message ?? '').trim();
  if (!m || m === base) return base;
  const head = /^([^：:，,。]{1,20})[：:，,。]\s*/.exec(m);
  if (head && base.includes(head[1]!.trim())) m = m.slice(head[0].length);
  return m ? `${base}：${m}` : base;
}

// ---------------------------------------------------------------------
// 权限：真实 Agent 第 1.2 步只开放“只读”和“需审批”（phase-1.md 6.3.4）
// ---------------------------------------------------------------------
export const PERM_LOCKED_REASON = '有了独立工作副本后开放';
/**
 * 这个权限级别现在能不能选。以 Gateway 给的 AgentInfo.permissionLevels 为准（Gateway 按它校验）；
 * 老 Gateway 没有这个字段时退回默认规则：真实 Agent 只开放“只读”和“需审批”
 */
export function permAvailable(kind: AgentKind | string, p: PermissionLevel, info?: Pick<AgentInfo, 'permissionLevels'> | null): boolean {
  if (info?.permissionLevels) return info.permissionLevels.includes(p);
  return !isRealAgent(kind) || p === 'readonly' || p === 'ask';
}
export const DIRECT_EDIT_WARNING = '会直接修改项目文件：这个任务直接在项目目录里运行；有了独立工作副本后会在副本里修改，建议权限保持“需审批”。';

/**
 * 工作区里的 Agent 设置文件（hooks、自动允许规则）会不会生效（审查第 1 条）。
 * warn 为 true 时新建任务对话框也要提示：这些设置可能让操作不经工作台审批就执行
 */
export function workspaceConfigNote(a: Pick<AgentInfo, 'kind' | 'displayName' | 'workspaceConfig'> | undefined): { text: string; warn: boolean } | null {
  if (!a || !isRealAgent(a.kind)) return null;
  switch (a.workspaceConfig) {
    case 'ignored': return { text: '不加载项目里的 Agent 设置文件（hooks、自动允许规则），工作台审批照常生效；项目说明文件（例如 CLAUDE.md、AGENTS.md）仍会读取', warn: false };
    case 'trusted_only': return { text: `项目里的 ${a.displayName} 设置只在你在 ${a.displayName} 里信任过这个项目时生效；其中的自动允许规则可能让部分操作不经工作台审批`, warn: true };
    default: return { text: '工作区里的 Agent 设置会生效：仓库自带的 hooks、自动允许规则可能让操作不经工作台审批就执行。只在信任的项目里使用', warn: true };
  }
}

/** 新任务默认的模型和思考强度：演示 Agent 用第一个；真实 Agent 用 Agent 设置里的默认值，没设时用 Agent 自己的默认值（''，不下发） */
export function taskDefaults(a: AgentInfo | undefined): { model: string; effort: string } {
  if (!a) return { model: '', effort: '' };
  if (!isRealAgent(a.kind)) {
    return { model: a.models[0]?.id ?? '', effort: a.efforts?.length ? a.efforts[Math.floor((a.efforts.length - 1) / 2)] ?? '' : '' };
  }
  const model = a.defaultModel && (!a.models.length || a.models.some((m) => m.id === a.defaultModel)) ? a.defaultModel : '';
  const effort = a.defaultEffort && a.efforts?.includes(a.defaultEffort) ? a.defaultEffort : '';
  return { model, effort };
}

// ---------------------------------------------------------------------
// 换模型的方式（design.md 7.4）：H0 会话内切换；H1 结束进程再恢复会话
// ---------------------------------------------------------------------
export type SwitchKind = 'in_session' | 'resume' | 'new_session';
export function modelSwitchKind(caps: AgentCaps | undefined): SwitchKind {
  if (!caps || caps.modelSwitch !== 'none') return 'in_session';
  return caps.resume || caps.loadSession ? 'resume' : 'new_session';
}
export const switchKindText: Record<SwitchKind, string> = {
  in_session: '会话内切换（无损）',
  resume: '恢复会话（无损）',
  new_session: '新建会话（Agent 不记得之前的对话）',
};

/**
 * 换账号的方式：会话存放位置相同（Gateway 给的 sessionStore 相等）→ 恢复会话；不同 → 需要交接（之后的版本），不能直接换。
 * 老 Gateway 没给 sessionStore 时按“可以恢复”处理（Gateway 恢复不了时会提示）
 */
export type ProfileSwitchKind = 'resume' | 'handoff';
export function profileSwitchKind(from: Pick<ProfileSummary, 'sessionStore'> | null | undefined, to: Pick<ProfileSummary, 'sessionStore'>): ProfileSwitchKind {
  if (!from?.sessionStore || !to.sessionStore) return 'resume';
  return from.sessionStore === to.sessionStore ? 'resume' : 'handoff';
}
export const profileSwitchText: Record<ProfileSwitchKind, string> = {
  resume: '恢复会话',
  handoff: '需要交接，之后的版本提供',
};

/**
 * Agent 正在执行时，这次切换要不要先问“等当前步骤完成 / 立即中断”（ui-design.md 6.5）：
 * 换账号、需要重启进程的换模型（H1）都要等这一轮结束；会话内切换（H0）的模型和思考强度直接生效
 */
export function switchNeedsTurnEnd(status: string, what: 'profile' | 'model' | 'effort', how: SwitchKind): boolean {
  if (status !== 'running' && status !== 'waiting' && status !== 'queued') return false;
  if (what === 'profile') return true;
  return what === 'model' && how !== 'in_session';
}

/** 模型列表：当前会话给的优先，其次 Agent 的缓存（phase-1.md 6.3.2） */
export function pickModels(info: AgentInfo | undefined, session?: { models?: ModelInfo[] | undefined }): ModelInfo[] {
  if (session?.models?.length) return session.models;
  return info?.models ?? [];
}
/** 思考强度：null 表示不能调节（界面隐藏）；会话给了就以会话为准（随模型变化） */
export function pickEfforts(info: AgentInfo | undefined, session?: { efforts?: string[] | null | undefined }): string[] | null {
  if (session && session.efforts !== undefined) return session.efforts?.length ? session.efforts : null;
  return info?.efforts?.length ? info.efforts : null;
}
/** 模型列表为空时的说明 */
export function emptyModelsText(info: AgentInfo | undefined): string {
  if (info?.modelsSource === 'none' && isRealAgent(info.kind)) return '首次使用后显示模型列表';
  return '由 Agent 决定';
}

export function capsSummary(caps: AgentCaps | undefined): string[] {
  if (!caps) return [];
  const out: string[] = [];
  out.push(caps.modelSwitch === 'none' ? '换模型时恢复会话' : '会话内换模型');
  if (caps.resume) out.push('可恢复会话');
  else if (caps.loadSession) out.push('可重新载入会话');
  if (caps.thoughts) out.push('显示思考过程');
  if (caps.prompt.image) out.push('可以看图片');
  return out;
}

export function engineSourceText(a: Pick<AgentInfo, 'kind' | 'engineSource'>): string | null {
  switch (a.engineSource) {
    case 'bundled': return a.kind === 'codebuddy' ? '工作台自带的官方独立版引擎' : '适配器自带的引擎';
    case 'local': return '本机安装的引擎';
    case 'app': return a.kind === 'workbuddy' ? 'WorkBuddy 内置引擎' : '应用内置引擎';
    default: return null;
  }
}

// ---------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------
/** 能在界面里直接发起的登录方式（apiKey 走“添加账号 → 官方 API Key”，不调用 authenticate） */
export function loginMethods(a: AgentInfo): AuthMethod[] {
  return (a.authMethods ?? []).filter((m) => m.flow !== 'apiKey');
}
export const LOGIN_TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
/** 登录进度的三步：启动、在浏览器里授权、确认登录状态 */
export function loginStep(state: string): number {
  switch (state) {
    case 'started': return 0;
    case 'waiting_browser': case 'need_code': return 1;
    case 'succeeded': return 3;
    default: return -1;
  }
}
/** 登录状态变化时给读屏播报的一行字（登录框本身不是 live 区域，见 ui-design.md 8.3） */
export function loginAnnounceText(state: string, inApp = false): string {
  switch (state) {
    case 'started': return '正在启动登录';
    case 'waiting_browser': return inApp ? '请在 WorkBuddy 里登录' : '正在等待浏览器授权';
    case 'need_code': return '需要输入浏览器里显示的授权码';
    case 'succeeded': return '登录成功';
    case 'failed': return '登录没有完成';
    case 'cancelled': return '已取消登录';
    default: return '';
  }
}
/** 授权链接只接受 https，其余一律不显示（Gateway 已按白名单过滤，这里再挡一层） */
export function safeAuthUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try { return new URL(url).protocol === 'https:' ? url : null; } catch { return null; }
}

// ---------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------
export const profileKindText: Record<ProfileKind, string> = { subscription: '订阅登录', apiKey: '官方 API Key', customEndpoint: '自定义地址' };
export const SECRET_STORE_TEXT = '已加密保存在本机（Windows 数据保护）';

/** 本机已有的登录（自动建的默认账号）：不能删除 */
export const isLocalLogin = (p: Pick<AgentProfile, 'kind' | 'configDir'>) => p.kind === 'subscription' && p.configDir === 'shared';

export function profileDesc(p: AgentProfile): string {
  const parts: string[] = [];
  if (p.kind === 'subscription') {
    parts.push(p.configDir === 'shared' ? (p.agent === 'workbuddy' ? '沿用 WorkBuddy 登录' : '这台电脑上已有的登录') : '单独的订阅登录');
    if (p.loggedIn === true) parts.push('已登录');
    if (p.loggedIn === false) parts.push('未登录');
  } else {
    if (p.kind === 'customEndpoint' && p.baseUrl) parts.push(hostOf(p.baseUrl));
    parts.push(p.hasSecret && p.secretHint ? `结尾 …${p.secretHint}，${SECRET_STORE_TEXT}` : '还没有保存密钥');
  }
  if (p.lastTestAt !== null && p.lastTestOk === false) parts.push('上次测试没通过');
  return parts.join('，');
}
function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** 手填的模型列表：逗号、顿号或换行分隔 */
export function parseModelList(text: string): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const raw of text.split(/[\n,，、]+/)) {
    const id = raw.trim();
    if (!id || seen.has(id) || id.length > 200) continue;
    seen.add(id);
    out.push({ id, name: id, contextWindow: null });
  }
  return out;
}

export interface ProfileDraft {
  kind: ProfileKind; name: string; baseUrl: string; authHeader: 'x-api-key' | 'bearer'; apiKey: string; models: string;
}
/** 表单校验：返回第一条错误（中文），通过时返回 null。editing 为真时密钥可以留空（表示不修改） */
export function validateProfileDraft(d: ProfileDraft, editing: boolean): string | null {
  if (!d.name.trim()) return '给账号起个名字，例如“工作室 API Key”';
  if (d.kind === 'customEndpoint') {
    if (!d.baseUrl.trim()) return '填写地址，例如 https://relay.example.com';
    if (!isAllowedBaseUrl(d.baseUrl.trim())) return '地址必须以 https:// 开头；本机服务可以用 http://127.0.0.1 或 http://localhost';
  }
  if (d.kind !== 'subscription' && !editing && !d.apiKey.trim()) return '填写密钥';
  if (/\s/.test(d.apiKey.trim())) return '密钥里不应有空格或换行，检查一下是否多复制了内容';
  return null;
}

// ---------------------------------------------------------------------
// 测试连接日志
// ---------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
export function formatTestLog(r: AgentTestResult): string {
  const lines = r.steps.map((s) => {
    const d = new Date(s.ts);
    const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const ms = s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)} 秒` : `${Math.round(s.ms)} 毫秒`;
    return `${t}  ${s.ok ? '✓' : '✗'} ${s.label}（${ms}）${s.detail ? `：${s.detail}` : ''}`;
  });
  const failed = r.steps.find((s) => !s.ok);
  lines.push(r.ok ? '结果：一切正常' : `结果：没有通过${failed ? `，卡在“${failed.label}”` : ''}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------
// 错误：Gateway 没给按钮时补上默认按钮（phase-1.md 6.5.3）
// ---------------------------------------------------------------------
export function withDefaultActions(err: ApiError, ctx: { taskId?: string | null; kind?: AgentKind | string | null }): ApiError {
  if (err.actions.length) return err;
  const t = ctx.taskId ? { taskId: ctx.taskId } : undefined;
  const k = ctx.kind ? { kind: ctx.kind } : undefined;
  const A = ErrorActionKey;
  switch (err.code) {
    case ErrorCode.AgentAuthRequired:
      return { ...err, actions: [{ label: '去登录', action: A.Login, args: k }] };
    case ErrorCode.AgentQuotaExceeded:
      return { ...err, actions: t ? [{ label: '换模型', action: A.SwitchModel, args: t }, { label: '换账号', action: A.SwitchProfile, args: t }] : [] };
    case ErrorCode.AgentCrashed:
      return { ...err, actions: t ? [{ label: '继续', action: A.Continue, args: t }] : [] };
    case ErrorCode.AgentStartTimeout:
      return { ...err, actions: [...(t ? [{ label: '再试一次', action: A.RetryTask, args: t }] : []), { label: '测试连接', action: A.TestAgent, args: k }] };
    // 切换器里的错误（审查第 19 条）：会话恢复不了 → 去 Agent 页看账号（“正在执行”时 Gateway 自带 [停止]）
    case ErrorCode.SessionNotRecoverable:
      return { ...err, actions: [{ label: '去 Agent 页', action: A.OpenAgents, args: k }] };
    default:
      return err;
  }
}

/** 需要任务处于空闲状态才能执行的按钮（会发消息） */
export const TASK_SEND_ACTIONS = new Set<string>([ErrorActionKey.Continue, ErrorActionKey.Resume, ErrorActionKey.RetryTask, 'continue', 'resume']);
