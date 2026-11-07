// AI Console 共享协议：Gateway 与所有客户端（浏览器、以后的桌面软件和手机应用）共用的类型与校验。
// 规则见 docs/plan-phase1.md 第 2 节：只通过 /api/v1 的 REST + WebSocket 对接；类型只在这里定义一次。
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const API_BASE = '/api/v1';

// ---------- 基础类型 ----------
/** 不透明 ID：客户端不解析、不拼接 */
export const Id = z.string().min(1).max(64);
/** 毫秒时间戳 */
export const Ts = z.number().int().nonnegative();

export const AgentKind = z.enum(['fake', 'claude', 'codex', 'codebuddy', 'zcode', 'workbuddy']);
export type AgentKind = z.infer<typeof AgentKind>;

export const PermissionLevel = z.enum(['readonly', 'ask', 'workspace', 'full']);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const TaskStatus = z.enum(['draft', 'queued', 'running', 'waiting', 'paused', 'review', 'merged', 'discarded', 'failed', 'interrupted']);
export type TaskStatus = z.infer<typeof TaskStatus>;

// ---------- 错误 ----------
/** 统一错误格式：message 给用户看，actions 是界面可直接渲染的按钮 */
export const ErrorAction = z.object({ label: z.string(), action: z.string(), args: z.record(z.string(), z.unknown()).optional() });
export const ApiError = z.object({
  code: z.string(),            // 机器可读，如 'auth.invalid_token'
  message: z.string(),         // 发生了什么
  hint: z.string().optional(), // 怎么处理
  actions: z.array(ErrorAction).default([]),
});
export type ApiError = z.infer<typeof ApiError>;
export const ErrorCode = {
  Unauthorized: 'auth.unauthorized',
  ForbiddenOrigin: 'auth.forbidden_origin',
  BadRequest: 'request.invalid',
  NotFound: 'resource.not_found',
  Conflict: 'resource.conflict',
  Internal: 'server.internal',
  AgentUnavailable: 'agent.unavailable',
  // 1.1 新增（只加不改）
  ForbiddenHost: 'auth.forbidden_host',       // Host 头不是 127.0.0.1:<端口> / localhost:<端口>
  Forbidden: 'auth.forbidden',                // 已登录但无权做这件事（例如非本机请求配对码）
  PairingInvalid: 'pairing.invalid_code',     // 配对码错误、过期或已用过
  RateLimited: 'request.rate_limited',
  PayloadTooLarge: 'request.too_large',
  InvalidState: 'task.invalid_state',         // 任务当前状态不允许该操作（如正在执行时再次发送）
  // 1.2 新增（phase-1.md 6.6.3）
  AgentAuthRequired: 'agent.auth_required',   // 登录失效：任务暂停，按钮“去登录”
  AgentQuotaExceeded: 'agent.quota_exceeded', // 额度或限流：任务暂停，按钮“换模型”“换账号”
  AgentCrashed: 'agent.crashed',              // Agent 进程意外退出：按钮“继续”
  AgentStartTimeout: 'agent.start_timeout',   // 启动或握手超时：按钮“再试一次”“测试连接”
  AgentProtocolError: 'agent.protocol_error',
  AgentFailed: 'agent.failed',                // 1.1 已在用，这里补上常量
  PermissionLevelUnavailable: 'permission.level_unavailable', // 真实 Agent 本步只开放“只读”“需审批”
  ProfileInUse: 'profile.in_use',
  SecretUnavailable: 'secret.unavailable',
  SessionNotRecoverable: 'session.not_recoverable',
  AgentNoResponse: 'agent.no_response',
  AttachmentUnsupported: 'attachment.unsupported',
  AttachmentTooLarge: 'attachment.too_large',
  AttachmentTooMany: 'attachment.too_many',
  AttachmentNotFound: 'attachment.not_found',
  AttachmentBadType: 'attachment.bad_type',
  AgentNativeConfiguration: 'agent.native_configuration',
} as const;

/**
 * 1.2 新增：ApiError.actions[].action 的已知取值，界面据此渲染成可以直接点的按钮。
 * 命名沿用 1.1 已经在用的 'agents.login'、'task.cancel'、'pairing.start'。
 * args 里常见的键：kind（AgentKind）、profileId、taskId。客户端遇到不认识的 action 提示刷新界面。
 */
export const ErrorActionKey = {
  Retry: 'retry',
  Reload: 'reload',
  OpenAgents: 'open_agents',
  OpenSettings: 'open_settings',
  PairingStart: 'pairing.start',
  /** 去登录 / 重新登录：打开 Agent 页对应的 Agent（args.kind）和账号（args.profileId） */
  Login: 'agents.login',
  /** 测试连接（args.kind） */
  TestAgent: 'agents.test',
  /**
   * 确认后强制登录（CodeBuddy 已登录时换账号会同时退出 WorkBuddy 里的账号）。
   * args：kind、methodId、profileId（可选）。客户端先二次确认，再带 force: true 调 POST /agents/:kind/login
   */
  LoginForce: 'agents.login_force',
  /** 停止（args.taskId） */
  Cancel: 'task.cancel',
  /** 继续：发一条“继续”，Gateway 收到消息时自动恢复会话（args.taskId） */
  Continue: 'task.continue',
  /** 恢复会话：同 Continue，文案不同 */
  Resume: 'task.resume',
  /** 再试一次：把最后一条消息重新发一遍（启动超时等，args.taskId） */
  RetryTask: 'task.retry',
  /** 换模型：打开输入框的切换器（args.taskId） */
  SwitchModel: 'task.switch_model',
  /** 换账号：打开切换器的账号一栏；没有别的账号时去 Agent 页添加（args.taskId） */
  SwitchProfile: 'task.switch_profile',
} as const;

// ---------- 握手 ----------
export const Hello = z.object({
  server: z.literal('ai-console-gateway'),
  version: z.string(),
  protocol: z.number().int(),
  /** 功能开关：客户端据此决定显示哪些功能，后续阶段新增功能只加开关 */
  features: z.record(z.string(), z.boolean()),
  machine: z.object({ id: Id, name: z.string(), os: z.string() }),
  device: z.object({ id: Id, name: z.string(), kind: z.enum(['browser', 'desktop', 'mobile']) }),
  lastSeq: z.number().int().nonnegative(),
  /** 1.1 新增：每次 Gateway 启动都会变的标识；客户端据此判断服务是否重启过 */
  bootId: z.string().optional(),
  lastExit: z.object({ clean: z.boolean(), at: Ts, reason: z.string().nullable() }).nullable().optional(),
});
export type Hello = z.infer<typeof Hello>;

// ---------- 实体 ----------
export const Project = z.object({
  id: Id, name: z.string(), path: z.string(), isGit: z.boolean(),
  defaultAgent: AgentKind.nullable(), createdAt: Ts,
});
export type Project = z.infer<typeof Project>;

export const Group = z.object({ id: Id, name: z.string(), ord: z.number().int(), createdAt: Ts });
export type Group = z.infer<typeof Group>;

export const Task = z.object({
  id: Id, projectId: Id, groupId: Id.nullable(), title: z.string(), prompt: z.string(),
  status: TaskStatus, permission: PermissionLevel,
  agent: AgentKind, model: z.string().nullable(), effort: z.string().nullable(),
  autoAllowLowRisk: z.boolean(), autoMergeOnPass: z.boolean(),
  lastActivityAt: Ts, createdAt: Ts, updatedAt: Ts,
  /** 1.2 新增：任务使用的账号；空 = 该 Agent 的默认账号 */
  profileId: Id.nullable().optional(),
});
export type Task = z.infer<typeof Task>;

export const ModelInfo = z.object({ id: z.string(), name: z.string(), contextWindow: z.number().int().nullable(), vision: z.boolean().nullable().optional() });
export type ModelInfo = z.infer<typeof ModelInfo>;

// ---------- 1.2 新增：Agent 的登录方式、能力、账号概要（phase-1.md 6.6.1） ----------
/** 归一化后的登录方式：browser 在浏览器里授权；apiKey 用账号配置里的密钥；external_app 去别的应用里登录（WorkBuddy） */
export const AuthMethod = z.object({
  id: z.string(), name: z.string(), description: z.string().nullable(),
  flow: z.enum(['browser', 'apiKey', 'external_app']),
});
export type AuthMethod = z.infer<typeof AuthMethod>;
/** 换模型的方式：configOption / unstableSetModel 为会话内切换（H0）；none 要结束进程再恢复会话（H1） */
export const ModelSwitch = z.enum(['configOption', 'unstableSetModel', 'none']);
export type ModelSwitch = z.infer<typeof ModelSwitch>;
export const AgentCaps = z.object({
  loadSession: z.boolean(), resume: z.boolean(), close: z.boolean(),
  modelSwitch: ModelSwitch, thoughts: z.boolean(),
  modes: z.array(z.object({ id: z.string(), name: z.string() })),
  prompt: z.object({ image: z.boolean(), audio: z.boolean(), embeddedContext: z.boolean() }),
});
export type AgentCaps = z.infer<typeof AgentCaps>;
export const ProfileKind = z.enum(['subscription', 'apiKey', 'customEndpoint']);
export type ProfileKind = z.infer<typeof ProfileKind>;
/** AgentInfo 里的账号概要（卡片上显示用；完整信息走 /profiles） */
export const ProfileSummary = z.object({
  id: Id, name: z.string(), kind: ProfileKind, isDefault: z.boolean(),
  loggedIn: z.boolean().nullable(),
  /**
   * 1.2 审查后新增：会话存在哪（不透明的键，客户端只比较是否相等）。
   * 和任务当前账号的值相同 → 换账号后能恢复原来的会话；不同 → 需要交接（之后的版本），Gateway 会拒绝
   */
  sessionStore: z.string().optional(),
  /** 当前账号的模型与能力缓存；旧服务端没有这些字段时，客户端继续兼容 Agent 级列表。 */
  models: z.array(ModelInfo).optional(),
  efforts: z.array(z.string()).nullable().optional(),
  caps: AgentCaps.optional(),
  modelsSource: z.enum(['session', 'cache', 'manual', 'none']).optional(),
});
export type ProfileSummary = z.infer<typeof ProfileSummary>;

export const AgentInfo = z.object({
  kind: AgentKind, displayName: z.string(),
  status: z.enum(['ready', 'needs_login', 'not_installed', 'error', 'disabled']),
  version: z.string().nullable(), verified: z.boolean(),
  models: z.array(ModelInfo), efforts: z.array(z.string()).nullable(),
  message: z.string().nullable(),
  // 1.2 新增（全部可选，老客户端可以忽略）
  adapterVersion: z.string().nullable().optional(),
  engineVersion: z.string().nullable().optional(),
  engineSource: z.enum(['bundled', 'local', 'app']).optional(),
  /** 只用于展示的文本，客户端不解析、不拼接 */
  engineLocation: z.string().nullable().optional(),
  authMethods: z.array(AuthMethod).optional(),
  caps: AgentCaps.optional(),
  /** 模型列表从哪来：session 当前会话、cache 能力缓存、manual 手填、none 还没有（首次使用后显示） */
  modelsSource: z.enum(['session', 'cache', 'manual', 'none']).optional(),
  runningSessions: z.number().int().nonnegative().optional(),
  concurrencyLimit: z.number().int().positive().optional(),
  checkedAt: Ts.optional(),
  profiles: z.array(ProfileSummary).optional(),
  /** 1.2 审查后新增：这个 Agent 现在能选的权限级别（Gateway 按它校验）；没有这个字段时客户端退回自己的默认规则 */
  permissionLevels: z.array(PermissionLevel).optional(),
  /** 新任务默认用的模型、思考强度（Agent 设置）；null 表示用 Agent 自己的默认值 */
  defaultModel: z.string().nullable().optional(),
  defaultEffort: z.string().nullable().optional(),
  /**
   * 工作区里的 Agent 设置文件（hooks、自动允许规则，例如 .claude/settings.json）是否生效：
   * ignored 不加载；trusted_only 只在用户在 Agent 里信任过的项目加载；loaded 会加载
   */
  workspaceConfig: z.enum(['ignored', 'trusted_only', 'loaded']).optional(),
  /**
   * 2026-11-07 新增：用户是否启用了这个 Agent（Agent 页的开关，design.md 6.7）。
   * false 时 Gateway 不检测、不探测、不接新任务，status 为 disabled；没有这个字段的老 Gateway 当作 true
   */
  enabled: z.boolean().optional(),
  /** 2026-11-07 新增：装了但这个版本还不能在工作台里用（WorkBuddy 精简引擎、ZCode 等桥接）；status 仍为 error，message 写明原因 */
  unsupported: z.boolean().optional(),
  modelFailures: z.array(z.object({ profileId: Id.nullable(), model: z.string(), reason: z.string(), at: Ts })).optional(),
  /** 第三方 Agent 沿用自身配置，工作台不管理其 API 或登录。 */
  usesNativeConfig: z.boolean().optional(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

/** 模型报告优先，其次使用 Agent 报告；没有报告就保持未知。 */
export function visionOf(info: Pick<AgentInfo, 'models' | 'caps'> | undefined, modelId: string | null): boolean | null {
  return info?.models.find((m) => m.id === modelId)?.vision ?? info?.caps?.prompt.image ?? null;
}

export const AttachmentInfo = z.object({
  id: Id, name: z.string().max(255), mime: z.string(), size: z.number().int().nonnegative(),
  kind: z.enum(['image', 'file']), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable(), createdAt: Ts,
});
export type AttachmentInfo = z.infer<typeof AttachmentInfo>;
/** 仅服务端和适配器之间传递，路径不返回客户端。 */
export type PromptAttachment = Pick<AttachmentInfo, 'kind' | 'mime' | 'name' | 'width' | 'height'> & { path: string; uri: string };
export type PromptInput = { text: string; attachments?: PromptAttachment[] };

export const Approval = z.object({
  id: Id, taskId: Id, sessionId: Id,
  title: z.string(),          // “Claude Code 请求执行命令”
  reason: z.string(),         // Agent 给出的理由
  detail: z.string(),         // 命令或文件路径，完整显示
  cwd: z.string().nullable(),
  options: z.array(z.object({ id: z.string(), label: z.string(), kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']) })),
  status: z.enum(['pending', 'allowed', 'rejected', 'expired']),
  decidedBy: Id.nullable(), createdAt: Ts, expiresAt: Ts.nullable(),
  /** 1.1 新增：处理这条审批的设备名（显示“由 xxx 处理”用） */
  decidedByName: z.string().nullable().optional(),
});
export type Approval = z.infer<typeof Approval>;

// ---------- 事件（服务端 → 客户端） ----------
const Base = { seq: z.number().int().positive(), ts: Ts, taskId: Id.nullable(), sessionId: Id.nullable() };
const ev = <T extends string, D extends z.ZodTypeAny>(type: T, data: D) => z.object({ ...Base, type: z.literal(type), data });

export const ToolKind = z.enum(['read', 'search', 'edit', 'create', 'delete', 'execute', 'fetch', 'think', 'other']);
export const EventEnvelope = z.discriminatedUnion('type', [
  ev('task.created', z.object({ task: Task })),
  ev('task.updated', z.object({ task: Task })),
  ev('session.started', z.object({
    agent: AgentKind, model: z.string().nullable(),
    /** 1.2 新增：会话使用的账号；resumed 表示这次是恢复原来的会话（H1） */
    profileId: Id.nullable().optional(), resumed: z.boolean().optional(),
  })),
  ev('session.ended', z.object({ reason: z.string() })),
  ev('message.user', z.object({ messageId: Id, text: z.string(), attachments: z.array(AttachmentInfo).max(10).optional() })),
  ev('message.delta', z.object({ messageId: Id, text: z.string() })),
  ev('message.done', z.object({ messageId: Id })),
  ev('thought.delta', z.object({ messageId: Id, text: z.string() })),
  ev('tool.start', z.object({ toolId: Id, kind: ToolKind, title: z.string(), target: z.string().nullable() })),
  ev('tool.update', z.object({ toolId: Id, title: z.string().optional(), target: z.string().nullable().optional(), kind: ToolKind.optional() })),
  ev('tool.output', z.object({ toolId: Id, text: z.string() })),
  /** rejected（1.1 新增）：用户在审批里拒绝，工具没有执行；界面按“未执行”显示，不当成故障 */
  ev('tool.end', z.object({ toolId: Id, ok: z.boolean(), summary: z.string().nullable(), rejected: z.boolean().optional() })),
  ev('plan.update', z.object({ items: z.array(z.object({ text: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })) })),
  ev('approval.requested', z.object({ approval: Approval })),
  ev('approval.resolved', z.object({
    approvalId: Id, status: Approval.shape.status, decidedBy: Id.nullable(), optionId: z.string().nullable(),
    /** 1.1 新增：处理设备的名称 */
    decidedByName: z.string().nullable().optional(),
  })),
  ev('session.config', z.object({
    model: z.string().nullable(), effort: z.string().nullable(), permission: PermissionLevel.optional(),
    /** 1.2 新增：Agent 自己的模式 id；当前会话可选的模型和思考强度（efforts 为 null 表示不能调节） */
    agentMode: z.string().nullable().optional(),
    models: z.array(ModelInfo).optional(),
    efforts: z.array(z.string()).nullable().optional(),
  })),
  ev('agent.status', z.object({ agent: AgentInfo })),
  ev('error', z.object({ error: ApiError })),
  // 1.2 新增
  /** 登录进度（全局事件，taskId 为空）。authUrl 只放过了白名单的授权链接 */
  ev('agent.login', z.object({
    loginId: Id, kind: AgentKind, profileId: Id.nullable().optional(),
    state: z.enum(['started', 'waiting_browser', 'need_code', 'succeeded', 'failed', 'cancelled']),
    authUrl: z.string().optional(), message: z.string().optional(),
  })),
  ev('session.usage', z.object({
    used: z.number().nonnegative(), size: z.number().nonnegative(),
    cost: z.object({ amount: z.number(), currency: z.string() }).optional(),
  })),
  /** 降级、恢复失败、强度被重置等需要告诉用户的情况：对话里的灰色提示行 */
  ev('session.notice', z.object({ level: z.enum(['info', 'warn']), text: z.string(), id: Id.optional() })),
]);
export type EventEnvelope = z.infer<typeof EventEnvelope>;
export type EventType = EventEnvelope['type'];
export type EventOf<T extends EventType> = Extract<EventEnvelope, { type: T }>;
/** 写入事件库前的形态（seq 由服务端分配） */
export type NewEvent = { [K in EventType]: Omit<EventOf<K>, 'seq' | 'ts'> & { ts?: number } }[EventType];

// ---------- 指令（客户端 → 服务端，经 WebSocket） ----------
const op = <T extends string, D extends z.ZodTypeAny>(name: T, data: D) => z.object({ id: Id, op: z.literal(name), data });
export const ClientOp = z.discriminatedUnion('op', [
  /**
   * 订阅：从 lastSeq 之后补发，再推实时事件。
   * taskIds 不传：收全部事件（网页默认用法）；
   * taskIds 传数组：只收全局事件（taskId 为空）、列表里任务的事件，以及所有任务的 task.created / task.updated / approval.*（侧栏和审批提醒要用）。
   * 每条连接只有一个订阅，重复 subscribe 以最后一次为准。
   */
  op('subscribe', z.object({ lastSeq: z.number().int().nonnegative(), taskIds: z.array(Id).optional() })),
  op('prompt', z.object({ taskId: Id, text: z.string().max(100_000), attachments: z.array(Id).max(10).optional() })
    .refine((v) => !!v.text.trim() || !!v.attachments?.length, '文字和附件至少提供一个')),
  op('cancel', z.object({ taskId: Id })),
  op('approve', z.object({ approvalId: Id, optionId: z.string(), note: z.string().max(2000).optional() })),
  op('switch', z.object({
    taskId: Id, agent: AgentKind.optional(), model: z.string().optional(), effort: z.string().optional(),
    /** 1.2 新增：同一 Agent 换账号 */
    profileId: Id.optional(),
  })),
  op('ping', z.object({})),
]);
export type ClientOp = z.infer<typeof ClientOp>;

/** 服务端对每条指令的回应；重复的 id 返回同样的结果、不重复执行 */
export const ServerFrame = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ack'), id: Id, ok: z.boolean(), error: ApiError.optional(), result: z.unknown().optional() }),
  z.object({ kind: z.literal('event'), event: EventEnvelope }),
  z.object({
    kind: z.literal('replayed'), upToSeq: z.number().int().nonnegative(),
    /** 1.1 新增：本次启动的标识（同 Hello.bootId）。变了说明服务重启过，断线前未确认的指令不要按原 id 重发 */
    bootId: z.string().optional(),
    /** 1.1 新增：客户端给的 lastSeq 比服务端最大 seq 还大（数据库被重置或换了）：客户端应清空本地事件状态，重新拉快照 */
    reset: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('pong'), ts: Ts }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// ---------- REST 请求体 ----------
export const CreateProjectBody = z.object({ name: z.string().min(1).max(200), path: z.string().min(1).max(1000) });
export const CreateTaskBody = z.object({
  projectId: Id, groupId: Id.nullable().optional(), prompt: z.string().max(100_000),
  title: z.string().max(200).optional(), agent: AgentKind, model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(), permission: PermissionLevel.default('ask'),
  /** 1.2 新增 */
  profileId: Id.nullable().optional(),
  attachments: z.array(Id).max(10).optional(),
  deferPrompt: z.boolean().optional(),
}).refine((v) => !!v.prompt.trim() || !!v.attachments?.length || v.deferPrompt === true, '文字和附件至少提供一个');
export const PatchTaskBody = z.object({
  title: z.string().max(200).optional(), groupId: Id.nullable().optional(), permission: PermissionLevel.optional(),
  autoAllowLowRisk: z.boolean().optional(), autoMergeOnPass: z.boolean().optional(),
  /** 1.2 新增 */
  profileId: Id.nullable().optional(),
});
export const CreateGroupBody = z.object({ name: z.string().min(1).max(100) });
export const PatchGroupBody = z.object({ name: z.string().min(1).max(100).optional(), ord: z.number().int().optional() });
export const EventsQuery = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(2000).default(500) });
/** 分页：游标而不是页码 */
export const Page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/** 本机会话令牌在浏览器里的存放：HttpOnly Cookie 名前缀；以后桌面和手机用 Authorization: Bearer */
export const SESSION_COOKIE = 'aic_session';
/**
 * 1.1 新增：实际使用的 Cookie 名带实例标识（由 Gateway 的数据目录决定），
 * 同一台电脑上不同端口、不同数据目录的 Gateway 不会互相覆盖 Cookie。
 */
export const sessionCookieName = (instanceId: string) => `${SESSION_COOKIE}_${instanceId}`;
/**
 * 1.1 新增：浏览器设备密钥。配对时随响应返回一次，网页存在按“源”（含端口）隔离的本地存储里，
 * 每个请求放在这个头里；只有 Cookie + 密钥同时正确才算通过。Cookie 被同机其他端口的服务拿到也没用。
 */
export const KEY_HEADER = 'x-aic-key';
/** WebSocket 子协议：浏览器不能给 WebSocket 加请求头，凭据经子协议传递；服务端只回选 WS_SUBPROTOCOL */
export const WS_SUBPROTOCOL = 'aic.v1';
export const WS_KEY_PROTOCOL_PREFIX = 'aic-key.';
export const WS_BEARER_PROTOCOL_PREFIX = 'aic-bearer.';
export const AUTH_HEADER = 'authorization';

// ======================================================================
// 1.1 新增（Gateway 第一版）。只加不改，保持向后兼容。
// ======================================================================

/** /hello 里 features 的已知键；客户端遇到不认识的键直接忽略 */
export const FeatureKey = {
  FakeAgent: 'agents.fake',          // 演示 Agent
  RealAgents: 'agents.real',         // 1.2 起
  Approvals: 'approvals',
  Groups: 'groups',
  FsBrowse: 'fs.browse',
  Worktrees: 'workspace.worktree',   // 1.3 起
  Handoff: 'context.handoff',        // 1.4 起
  Lan: 'access.lan',                 // 1.5 起
  SideChat: 'chat.side',             // 侧边聊天（design.md 第 26 节，后续阶段）；网页据此决定是否显示“在侧边聊天中提问”
  // 后续阶段的页面入口（侧栏按这些开关显示）；1.1 全部未开启
  PageAssets: 'pages.assets',
  PageGenerate: 'pages.generate',
  PageAutomations: 'pages.automations',
  PageMonitor: 'pages.monitor',
  PageCapabilities: 'pages.capabilities',
  // 1.2 新增
  Profiles: 'agents.profiles',       // 账号配置（订阅登录 / API Key / 自定义地址）
  // 2026-11-07 新增
  AgentToggle: 'agents.toggle',      // Agent 启用开关（PATCH /agents/:kind { enabled }）
  Drafts: 'tasks.draft',             // 任务草稿按任务保存（GET / PUT /tasks/:id/draft）
} as const;

// ---------- 设备与配对 ----------
export const DeviceKind = z.enum(['browser', 'desktop', 'mobile']);
export type DeviceKind = z.infer<typeof DeviceKind>;
export const Device = z.object({
  id: Id, name: z.string(), kind: DeviceKind,
  lastIp: z.string().nullable(), lastSeen: Ts.nullable(), pairedAt: Ts,
  /** 是否就是发起这次请求的设备 */
  current: z.boolean(),
});
export type Device = z.infer<typeof Device>;

/** POST /pairing/start 的返回：配对码本身只打印在电脑的终端窗口里，不经网络返回 */
export const PairingStartResult = z.object({ expiresAt: Ts });
export type PairingStartResult = z.infer<typeof PairingStartResult>;

export const PairingCompleteBody = z.object({
  code: z.string().trim().min(4).max(16),
  deviceName: z.string().trim().min(1).max(100),
  kind: DeviceKind.default('browser'),
  /** cookie：浏览器（令牌写进 HttpOnly Cookie，响应里不带令牌）；bearer：桌面 / 手机应用（令牌在响应里返回一次） */
  tokenDelivery: z.enum(['cookie', 'bearer']).default('cookie'),
});
export type PairingCompleteBody = z.infer<typeof PairingCompleteBody>;
export const PairingCompleteResult = z.object({
  device: Device,
  /** tokenDelivery=bearer 时返回的设备令牌 */
  token: z.string().optional(),
  /** 1.1 新增：tokenDelivery=cookie 时返回的设备密钥，之后放在 KEY_HEADER 里 */
  key: z.string().optional(),
});
export type PairingCompleteResult = z.infer<typeof PairingCompleteResult>;

// ---------- 项目 ----------
export const PatchProjectBody = z.object({
  name: z.string().min(1).max(200).optional(),
  defaultAgent: AgentKind.nullable().optional(),
});
export type PatchProjectBody = z.infer<typeof PatchProjectBody>;

// ---------- 文件夹浏览（只列目录） ----------
export const FsBrowseQuery = z.object({
  path: z.string().min(1).max(1000).optional(),
  /** 1.1 新增：分页游标（上一页的 nextCursor），不透明 */
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(500),
});
export const FsEntry = z.object({
  name: z.string(),
  /** 不透明路径：原样传回 /fs/browse 或 POST /projects，客户端不要自己拼接 */
  path: z.string(),
  kind: z.enum(['drive', 'home', 'dir']),
  isGit: z.boolean(),
});
export type FsEntry = z.infer<typeof FsEntry>;
export const FsBrowseResult = z.object({
  /** 当前目录；null 表示“根”（盘符和常用位置） */
  path: z.string().nullable(),
  /** 上一级；null 表示已经在根，返回根列表请不带 path 调用 */
  parent: z.string().nullable(),
  entries: z.array(FsEntry),
  /** 1.1 新增：还有更多子文件夹时给出游标；null 或缺省表示已经列完 */
  nextCursor: z.string().nullable().optional(),
});
export type FsBrowseResult = z.infer<typeof FsBrowseResult>;

// ---------- 任务列表 ----------
export const TasksQuery = z.object({
  projectId: Id.optional(),
  groupId: Id.optional(),
  /** '1' 表示只要未分类的任务（groupId 为空） */
  ungrouped: z.enum(['0', '1']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const ApprovalsQuery = z.object({ status: Approval.shape.status.optional() });

// ---------- WebSocket ack 的 result ----------
export const SubscribeResult = z.object({ upToSeq: z.number().int().nonnegative() });
export const PromptResult = z.object({ taskId: Id, messageId: Id });
export const ApproveResult = z.object({ approval: Approval });
export const SwitchResult = z.object({ task: Task });
export const CancelResult = z.object({ taskId: Id });
export const PingResult = z.object({});

/** WebSocket 关闭码：4401 令牌失效或设备被吊销（客户端应回到配对页，不要重连） */
export const WS_CLOSE_UNAUTHORIZED = 4401;

// ======================================================================
// 1.2 新增（接入真实 Agent，phase-1.md 6.6）。只加不改，保持向后兼容。
// ======================================================================

// ---------- 账号（不含密钥明文） ----------
export const AuthHeader = z.enum(['x-api-key', 'bearer']);
export const AgentProfile = z.object({
  id: Id, agent: AgentKind, name: z.string(), kind: ProfileKind,
  /** shared：用 Agent 默认的配置目录（本机已有的登录）；isolated：AI Console 单独的目录 */
  configDir: z.enum(['shared', 'isolated']),
  baseUrl: z.string().nullable(), authHeader: AuthHeader.nullable(),
  models: z.array(ModelInfo),
  /** 接口永远不返回密钥明文：只有是否已保存和末 4 位 */
  hasSecret: z.boolean(), secretHint: z.string().nullable(),
  isDefault: z.boolean(), loggedIn: z.boolean().nullable(),
  /** 只有源码依据、没有实测的组合（CodeBuddy 的 API Key 和自定义地址），界面标“实验” */
  experimental: z.boolean(),
  lastTestAt: Ts.nullable(), lastTestOk: z.boolean().nullable(),
  createdAt: Ts, updatedAt: Ts,
  /** 旧的第三方认证配置仅保留待清理，不能用于任务、测试或刷新模型。 */
  retired: z.boolean().optional(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

/** baseUrl：https://，或者 http:// 加 127.0.0.1 / localhost */
export const isAllowedBaseUrl = (s: string): boolean => {
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch { return false; }
};
const BaseUrl = z.string().max(500).refine(isAllowedBaseUrl, { message: '地址必须是 https://，或者 http://127.0.0.1 / http://localhost' });

export const CreateProfileBody = z.object({
  agent: AgentKind, name: z.string().trim().min(1).max(100), kind: ProfileKind,
  configDir: z.enum(['shared', 'isolated']).optional(),
  baseUrl: BaseUrl.optional(), authHeader: AuthHeader.optional(),
  /** 只在请求体里出现一次，Gateway 收到后立即加密，不进日志 */
  apiKey: z.string().min(1).max(4000).optional(),
  models: z.array(ModelInfo).max(200).optional(),
});
export type CreateProfileBody = z.infer<typeof CreateProfileBody>;
export const PatchProfileBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  configDir: z.enum(['shared', 'isolated']).optional(),
  baseUrl: BaseUrl.optional(), authHeader: AuthHeader.optional(),
  /** 传入就整个替换 */
  apiKey: z.string().min(1).max(4000).optional(),
  models: z.array(ModelInfo).max(200).optional(),
  isDefault: z.literal(true).optional(),
});
export type PatchProfileBody = z.infer<typeof PatchProfileBody>;
export const ProfilesQuery = z.object({ agent: AgentKind.optional() });

// ---------- 登录、测试、Agent 设置 ----------
export const AgentLoginBody = z.object({
  profileId: Id.optional(),
  /** AgentInfo.authMethods 里的 id；CodeBuddy 另有 workbuddy-app（启动 WorkBuddy） */
  methodId: z.string().min(1).max(100),
  /** CodeBuddy 已登录时必须带上（会同时退出 WorkBuddy 里的账号） */
  force: z.boolean().optional(),
});
export type AgentLoginBody = z.infer<typeof AgentLoginBody>;
export const AgentLoginResult = z.object({ loginId: Id });
export const AgentLoginCodeBody = z.object({ code: z.string().trim().min(1).max(2000) });
export const WORKBUDDY_APP_METHOD = 'workbuddy-app';

export const AgentTestBody = z.object({
  profileId: Id.optional(),
  /** 多发一条“只回复 OK”，会产生少量费用 */
  sendMessage: z.boolean().optional(),
});
export const AgentTestStep = z.object({ ts: Ts, label: z.string(), ok: z.boolean(), ms: z.number().nonnegative(), detail: z.string().optional() });
export const AgentTestResult = z.object({ ok: z.boolean(), steps: z.array(AgentTestStep) });
export type AgentTestResult = z.infer<typeof AgentTestResult>;

export const PatchAgentBody = z.object({
  concurrencyLimit: z.number().int().min(1).max(4).optional(),
  /** 只对 Claude 有效：bundled 适配器自带的引擎；local 本机安装的 Claude Code */
  engine: z.enum(['bundled', 'local']).optional(),
  /** 新任务默认用的模型、思考强度；null 恢复为 Agent 自己的默认值 */
  defaultModel: z.string().min(1).max(200).nullable().optional(),
  defaultEffort: z.string().min(1).max(50).nullable().optional(),
  /** 2026-11-07 新增：启用 / 关闭这个 Agent */
  enabled: z.boolean().optional(),
});
export type PatchAgentBody = z.infer<typeof PatchAgentBody>;

// ---------- 任务草稿（输入框里没发出去的文字和注释，按任务保存，换设备也在；design.md 15.2） ----------
export const DraftAnnotation = z.object({
  id: z.string().min(1).max(40),
  /** 选中的原文（显示用，可能截断） */
  text: z.string().max(4001),
  /** 原文在对话文字里的完整内容和大致位置，恢复时按它重新定位；找不到就只保留注释 */
  raw: z.string().max(4001).optional(),
  pos: z.number().int().min(-1).optional(),
  comment: z.string().max(2000),
});
export type DraftAnnotation = z.infer<typeof DraftAnnotation>;
export const TaskDraft = z.object({
  text: z.string().max(100_000),
  annotations: z.array(DraftAnnotation).max(50),
  attachments: z.array(Id).max(10).optional(),
  expiredAttachments: z.boolean().optional(),
  updatedAt: Ts.nullable(),
});
export type TaskDraft = z.infer<typeof TaskDraft>;
/** PUT /tasks/:id/draft：文字为空且没有注释时等于删除草稿 */
export const PutTaskDraftBody = TaskDraft.omit({ updatedAt: true, expiredAttachments: true });
export type PutTaskDraftBody = z.infer<typeof PutTaskDraftBody>;
export const RedetectResult = z.object({ items: z.array(AgentInfo) });

/** 只表示“成功”的响应（取消登录、提交授权码等） */
export const OkResult = z.object({ ok: z.literal(true) });
export type OkResult = z.infer<typeof OkResult>;
/** DELETE /profiles/:id：keptDir 为 true 表示账号专属的配置目录保留在磁盘上（没有删除） */
export const DeleteProfileResult = z.object({ ok: z.literal(true), keptDir: z.boolean() });
export type DeleteProfileResult = z.infer<typeof DeleteProfileResult>;

/** 真实 Agent 第 1.2 步开放的权限级别（工作区内自动、全自动等 1.3 有了工作副本再开放） */
export const REAL_AGENT_PERMISSIONS: readonly PermissionLevel[] = ['readonly', 'ask'];

// ---------- 独立 Agent：命令与工具持久意图（只追加，不改变旧任务和事件） ----------
const CommandArgument = z.string().max(32_768).refine((s) => !s.includes('\0'), { message: '命令参数不能包含空字符' });
/** 规范化后交给审批与执行的命令；环境和工作目录只由 Gateway 提供。 */
export const IndependentCommandSpec = z.object({
  program: CommandArgument.refine((s) => s.length > 0, { message: '需要可执行文件' }),
  args: z.array(CommandArgument).max(256),
  timeoutMs: z.number().int().min(1).max(600_000),
  maxOutputBytes: z.number().int().min(1024).max(1024 * 1024),
}).strict();
export type IndependentCommandSpec = z.infer<typeof IndependentCommandSpec>;

export const IndependentCommandOutcome = z.object({
  reason: z.enum(['completed', 'cancelled', 'timed_out', 'output_limit', 'start_failed', 'interrupted']),
  exitCode: z.number().int().nullable(),
  outputBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  durationMs: z.number().nonnegative(),
});
export type IndependentCommandOutcome = z.infer<typeof IndependentCommandOutcome>;
/** 输出仅给工具调用方；不自动写入事件、审计或进程登记。 */
export const IndependentCommandResult = IndependentCommandOutcome.extend({ stdout: z.string(), stderr: z.string() });
export type IndependentCommandResult = z.infer<typeof IndependentCommandResult>;

export const IndependentToolState = z.enum(['pending', 'approved', 'rejected', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
export type IndependentToolState = z.infer<typeof IndependentToolState>;
/** hash 覆盖规范化参数、工作区和审批基准；记录不保存密钥、附件正文或工具原始参数。 */
export const IndependentToolIntent = z.object({
  taskId: Id, sessionId: Id, turnId: Id,
  callId: z.string().min(1).max(200), toolName: z.string().min(1).max(100),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type IndependentToolIntent = z.infer<typeof IndependentToolIntent>;
export const IndependentToolRecord = IndependentToolIntent.extend({
  id: Id, state: IndependentToolState, createdAt: Ts, updatedAt: Ts,
  pid: z.number().int().positive().nullable(), processStartedAt: Ts.nullable(),
  outcome: IndependentCommandOutcome.nullable(),
});
export type IndependentToolRecord = z.infer<typeof IndependentToolRecord>;
