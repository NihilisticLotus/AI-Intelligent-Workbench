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

export const AgentKind = z.enum(['fake', 'claude', 'codex', 'codebuddy', 'zcode']);
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
});
export type Task = z.infer<typeof Task>;

export const ModelInfo = z.object({ id: z.string(), name: z.string(), contextWindow: z.number().int().nullable() });
export const AgentInfo = z.object({
  kind: AgentKind, displayName: z.string(),
  status: z.enum(['ready', 'needs_login', 'not_installed', 'error', 'disabled']),
  version: z.string().nullable(), verified: z.boolean(),
  models: z.array(ModelInfo), efforts: z.array(z.string()).nullable(),
  message: z.string().nullable(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

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
  ev('session.started', z.object({ agent: AgentKind, model: z.string().nullable() })),
  ev('session.ended', z.object({ reason: z.string() })),
  ev('message.user', z.object({ messageId: Id, text: z.string() })),
  ev('message.delta', z.object({ messageId: Id, text: z.string() })),
  ev('message.done', z.object({ messageId: Id })),
  ev('thought.delta', z.object({ messageId: Id, text: z.string() })),
  ev('tool.start', z.object({ toolId: Id, kind: ToolKind, title: z.string(), target: z.string().nullable() })),
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
  ev('session.config', z.object({ model: z.string().nullable(), effort: z.string().nullable(), permission: PermissionLevel.optional() })),
  ev('agent.status', z.object({ agent: AgentInfo })),
  ev('error', z.object({ error: ApiError })),
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
  op('prompt', z.object({ taskId: Id, text: z.string().min(1).max(100_000) })),
  op('cancel', z.object({ taskId: Id })),
  op('approve', z.object({ approvalId: Id, optionId: z.string(), note: z.string().max(2000).optional() })),
  op('switch', z.object({ taskId: Id, agent: AgentKind.optional(), model: z.string().optional(), effort: z.string().optional() })),
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
  projectId: Id, groupId: Id.nullable().optional(), prompt: z.string().min(1).max(100_000),
  title: z.string().max(200).optional(), agent: AgentKind, model: z.string().nullable().optional(),
  effort: z.string().nullable().optional(), permission: PermissionLevel.default('ask'),
});
export const PatchTaskBody = z.object({
  title: z.string().max(200).optional(), groupId: Id.nullable().optional(), permission: PermissionLevel.optional(),
  autoAllowLowRisk: z.boolean().optional(), autoMergeOnPass: z.boolean().optional(),
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
  // 后续阶段的页面入口（侧栏按这些开关显示）；1.1 全部未开启
  PageAssets: 'pages.assets',
  PageGenerate: 'pages.generate',
  PageAutomations: 'pages.automations',
  PageMonitor: 'pages.monitor',
  PageCapabilities: 'pages.capabilities',
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
