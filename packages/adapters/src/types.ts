// Agent 适配器接口（design.md 6.2）。1.1 时定义在 gateway/src/agents/registry.ts，1.2 起移到这里（phase-1.md 6.2）。
// 规则：在 1.1 的接口上只增不改——已有成员不改名、不改类型；新增成员都是可选的，或者是新类型。
// 适配器只负责“说 Agent 的话”，产生的更新统一交给 SessionHost，由 Gateway 转成协议事件。
import type { AgentKind, ApiError, PermissionLevel, PromptInput } from '@aic/protocol';
import type { z } from 'zod';
import type { ModelInfo as ModelInfoSchema, ToolKind } from '@aic/protocol';

export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export type ToolKindT = z.infer<typeof ToolKind>;

/** 归一化后的登录方式（对应协议 AgentInfo.authMethods） */
export interface AuthMethodInfo {
  id: string;
  name: string;
  description: string | null;
  flow: 'browser' | 'apiKey' | 'external_app';
}

export interface DetectResult {
  installed: boolean;
  version: string | null;
  enginePath: string | null;
  loggedIn: boolean;
  message: string | null;
  // ---- 1.2 新增 ----
  adapterVersion?: string | null;
  engineVersion?: string | null;
  engineSource?: 'bundled' | 'local' | 'app';
  /** 只用于展示的文本（例如“适配器自带”“WorkBuddy 内置”），客户端不解析 */
  engineLocation?: string | null;
  /** 版本组合在已验证版本表里（verified.ts） */
  verified?: boolean;
  authMethods?: AuthMethodInfo[];
  /** 登录状态是怎么判断的；unknown 表示没能判断（例如检查命令超时） */
  loginCheck?: 'cli' | 'acp' | 'secret' | 'none' | 'unknown';
  /** 检测时间 */
  checkedAt?: number;
  /** 装了但这个版本不能在工作台里使用（例如 WorkBuddy 只带精简引擎）；message 写明原因 */
  unsupported?: boolean;
}

export type AuthMethod = 'none' | 'oauth' | 'apiKey' | 'customEndpoint';
export interface AccountProfile {
  id: string;
  agentId: AgentKind;
  name: string;
  authMethod: AuthMethod;
  baseUrl?: string;
  // ---- 1.2 新增（phase-1.md 6.4） ----
  kind?: 'subscription' | 'apiKey' | 'customEndpoint';
  configDir?: 'shared' | 'isolated';
  /** isolated 账号的专属目录（Gateway 算好的绝对路径，例如 .aic-data/profiles/<id>）；shared 时为空 */
  profileDir?: string | null;
  authHeader?: 'x-api-key' | 'bearer' | null;
  models?: ModelInfo[];
  /** Codex 自定义地址的 wire_api（默认 responses） */
  wireApi?: 'responses' | 'chat' | null;
}
export type ProgressFn = (p: { step: string; percent?: number }) => void;

export interface AgentCaps {
  loadSession: boolean;
  resume: boolean;
  list: boolean;
  close: boolean;
  fork: boolean;
  modelSwitch: 'configOption' | 'unstableSetModel' | 'none';
  effortOptions?: string[];
  thoughts: boolean;
  modes: { id: string; name: string }[];
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
  mcp: { http: boolean; sse: boolean };
  extensions: string[];
  // ---- 1.2 新增 ----
  /** 收到过但不认识的 session/update 类型及次数（Agent 测试页显示） */
  unknownUpdates?: Record<string, number>;
  /** available_commands_update 里的命令名 */
  commands?: string[];
  /** initialize 返回的 agentInfo / 版本 */
  agentInfo?: { name: string | null; version: string | null } | null;
}

/** 会话当前的模型、思考强度、模式及各自的可选项（phase-1.md 6.3.2） */
export interface SessionConfigState {
  model: string | null;
  effort: string | null;
  mode: string | null;
  models: ModelInfo[];
  /** null：不能调节思考强度 */
  efforts: string[] | null;
  modes: { id: string; name: string }[];
  /** 列表从哪来：configOptions（会话最新）/ legacy（旧字段 models）/ none */
  source: 'configOptions' | 'legacy' | 'none';
  /** 各配置项在 Agent 里的 id（按 category 找到的） */
  ids: { model: string | null; effort: string | null; mode: string | null };
}

/** Agent 发出的会话更新（对应 ACP session/update），Gateway 负责落库成事件 */
export type AgentUpdate =
  | { kind: 'thought'; messageId: string; text: string }
  | { kind: 'message'; messageId: string; text: string }
  | { kind: 'message_done'; messageId: string }
  | { kind: 'tool_start'; toolId: string; toolKind: ToolKindT; title: string; target: string | null }
  | { kind: 'activity' }
  | { kind: 'tool_update'; toolId: string; title?: string; target?: string | null; toolKind?: ToolKindT }
  | { kind: 'tool_output'; toolId: string; text: string }
  /** rejected：用户在审批里拒绝，工具没有执行（不是执行出错） */
  | { kind: 'tool_end'; toolId: string; ok: boolean; summary: string | null; rejected?: boolean }
  | { kind: 'plan'; items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { kind: 'config'; model: string | null; effort: string | null }
  // ---- 1.2 新增 ----
  | { kind: 'usage'; used: number; size: number; cost?: { amount: number; currency: string } }
  | { kind: 'mode'; modeId: string }
  | { kind: 'config_options'; state: SessionConfigState }
  | { kind: 'notice'; level: 'info' | 'warn'; text: string }
  /** 运行中发现登录状态变化（Claude 的 _auth/status_update 等） */
  | { kind: 'auth'; loggedIn: boolean };

/** 审批选项的 kind（卡片上的） */
export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

/** 权限请求（对应 ACP session/request_permission）；选项由 Agent 自己提供 */
export interface PermissionRequest {
  toolId: string;
  title: string;
  reason: string;
  detail: string;
  cwd: string | null;
  options: { id: string; label: string; kind: PermissionOptionKind }[];
}
export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string; note?: string }
  | { outcome: 'cancelled' };

/** Gateway 提供给适配器的回调 */
export interface SessionHost {
  update(u: AgentUpdate): void;
  requestPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionOutcome>;
}

/** 日志：只写给 Gateway 的日志，不进事件库、不发给客户端 */
export type LogFn = (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;

/** 进程登记：Gateway 记下启动过的 Agent 进程，退出时兜底结束（phase-1.md 6.2.1） */
export interface ProcessTracker {
  started(p: { pid: number; agent: AgentKind; sessionId: string | null; startedAt: number }): void;
  exited(pid: number): void;
}

export interface SpawnOptions {
  cwd: string;
  model: string | null;
  effort: string | null;
  permission: PermissionLevel;
  host: SessionHost;
  profile?: AccountProfile;
  // ---- 1.2 新增 ----
  /** Gateway 算好的账号环境变量（buildEnv 的结果） */
  env?: Record<string, string>;
  /** 需要在日志和错误里脱敏的原文（本次注入的密钥） */
  redact?: string[];
  /** 恢复原来的会话（H1） */
  resume?: { agentSessionId: string };
  signal?: AbortSignal;
  /** Gateway 的会话 ID，用于日志前缀和进程登记 */
  sessionLabel?: string;
  /**
   * 注入的 MCP 服务（stdio）。本步 Gateway 一律不传（等于 []）；冒烟测试注入 aic-echo，1.4 注入 aic_history。
   * 服务名必须带 aic- 前缀：Codex 会静默跳过与用户配置同名的服务（ISSUE-0001）。
   */
  mcpServers?: McpServerSpec[];
  /** 在启动时指定模型（H1：Agent 不能在会话里换模型）；适配器 launchModel 为 true 时才有效 */
  launchModel?: boolean;
}

/** ACP 的 stdio MCP 服务描述 */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}

export type StopReason = 'end_turn' | 'cancelled' | 'refusal' | 'error';

/** 一条已建立的 Agent 会话（1.2 起是 ACP 连接的包装） */
export interface AgentConnection {
  /** Agent 自己的会话 ID，用于恢复 */
  readonly agentSessionId: string;
  prompt(input: PromptInput, signal: AbortSignal): Promise<{ stopReason: StopReason }>;
  setConfig(cfg: { model?: string; effort?: string }): Promise<void>;
  /** 权限级别映射到 Agent 自己的模式（session/set_mode） */
  setPermission(level: PermissionLevel): Promise<void>;
  close(): Promise<void>;
  // ---- 1.2 新增 ----
  /** 本次会话的能力（initialize + session/new 推导） */
  readonly caps?: AgentCaps;
  /** 当前的模型、思考强度、模式及可选项 */
  config?(): SessionConfigState;
  /** 进程意外退出（不是我们主动关闭的）时回调 */
  /** killed：取消无响应、模式改不回来等由适配器自己结束的进程（不是崩溃，也不是 Gateway 主动关闭） */
  onExit?(cb: (info: { code: number | null; signal: string | null; stderrTail: string[]; killed?: boolean }) => void): void;
  /** 这次是恢复原来的会话（true），还是新建的（false） */
  readonly resumed?: boolean;
  /** 恢复失败、新建了会话时的原因（界面提示用） */
  readonly resumeFailure?: string | null;
  /** Agent 进程 pid（演示 Agent 没有） */
  readonly pid?: number | null;
  /** Gateway 记录好会话（发出 session.started）后调用；建会话期间产生的更新在这之后按顺序补发 */
  ready?(): void;
  /** 进程已经退出或正在关闭（例如取消无响应被结束），下一条消息时需要恢复会话 */
  isClosed?(): boolean;
}

/** 登录流程的进度（对应协议 agent.login 事件的 state） */
export type LoginState = 'started' | 'waiting_browser' | 'need_code' | 'succeeded' | 'failed' | 'cancelled';
export interface LoginHandle {
  /** 结束：succeeded / failed / cancelled */
  done: Promise<{ state: 'succeeded' | 'failed' | 'cancelled'; message?: string }>;
  cancel(): void;
  /** 需要粘贴授权码时（ISSUE-0007 的备选） */
  submitCode?(code: string): void;
}
export interface LoginRequest {
  methodId: string;
  profile: AccountProfile;
  env: Record<string, string>;
  onProgress(p: { state: LoginState; authUrl?: string; message?: string }): void;
}

/** 测试连接 / 探测会话的结果（phase-1.md 6.6.2 POST /agents/:kind/test） */
export interface ProbeStep { ts: number; label: string; ok: boolean; ms: number; detail?: string }
export interface ProbeResult {
  ok: boolean;
  steps: ProbeStep[];
  caps: AgentCaps | null;
  config: SessionConfigState | null;
  authMethods: AuthMethodInfo[] | null;
  /** 失败原因（已脱敏） */
  error?: ApiError;
}
export interface ProbeOptions {
  cwd: string;
  env: Record<string, string>;
  redact?: string[];
  profile?: AccountProfile;
  /** 多发一条“只回复 OK”（会产生少量费用） */
  sendMessage?: boolean;
}

export interface AgentAdapter {
  id: AgentKind;
  displayName: string;

  // 环境
  detect(opts?: DetectOptions): Promise<DetectResult>;
  install?(progress: ProgressFn): Promise<void>;
  update?(progress: ProgressFn): Promise<void>;

  // 账号
  authMethods: AuthMethod[];
  login(profile: AccountProfile): Promise<void>;
  /** secret：Gateway 解密后传入（1.2 新增参数），适配器不接触密钥存储 */
  buildEnv(profile: AccountProfile, secret?: string | null): Record<string, string>;

  // 模型
  listModels(profile?: AccountProfile): Promise<ModelInfo[]>;
  /** 思考强度选项；null 表示不支持调节 */
  listEfforts(): Promise<string[] | null>;

  // 会话
  spawn(opts: SpawnOptions): Promise<AgentConnection>;
  probeCapabilities(conn: AgentConnection): Promise<AgentCaps>;

  mapPermissionLevel?(level: PermissionLevel): { modeId?: string };
  contextWindowOf?(modelId: string): number | undefined;

  // ---- 1.2 新增 ----
  /** 真实 Agent（经 ACP 接入、会修改真实文件） */
  real?: boolean;
  /** 本步开放的权限级别；不写表示全部开放 */
  permissionLevels?: PermissionLevel[];
  /** 启动图形化登录流程 */
  startLogin?(req: LoginRequest): LoginHandle;
  /** 测试连接 / 探测：initialize → session/new（临时目录）→ 读模型 →（可选发一条消息）→ 关闭 */
  probe?(opts: ProbeOptions): Promise<ProbeResult>;
  /** 是否支持自动探测（Claude：session/new 不花钱、不需要登录） */
  autoProbe?: boolean;
  /** Agent 设置（引擎选择等），由 Gateway 下发 */
  configure?(settings: AgentSettings): void;
  /** 能在启动时指定模型（H1 换模型靠它） */
  launchModel?: boolean;
  /** 工作区里的 Agent 设置文件（hooks、自动允许规则）是否生效：ignored 不加载；trusted_only 只在用户信任过的项目里加载 */
  workspaceConfig?: 'ignored' | 'trusted_only' | 'loaded';
  /** 某类账号是否只是“实验”支持（只有源码依据） */
  experimentalProfile?(kind: 'subscription' | 'apiKey' | 'customEndpoint'): boolean;
  /**
   * 账号的会话存在哪（不透明的键）：键相同的账号之间可以恢复彼此的会话；不同时换账号需要交接（第 1.4 步）。
   * 不提供时：配置目录 isolated → 账号自己的目录，shared → Agent 的默认目录
   */
  sessionStore?(p: { id: string; kind: 'subscription' | 'apiKey' | 'customEndpoint'; configDir: 'shared' | 'isolated' }): string;
}

export interface DetectOptions {
  /** 跳过适配器内部的缓存（例如 CodeBuddy 的 10 分钟登录缓存） */
  force?: boolean;
  profile?: AccountProfile;
  env?: Record<string, string>;
  redact?: string[];
}

export interface AgentSettings {
  /** 只对 Claude 有效：bundled 适配器自带的引擎；local 本机安装的 Claude Code */
  engine?: 'bundled' | 'local';
}

/** 适配器抛出的业务错误：body 直接是协议里的 ApiError（message 已脱敏） */
export class AgentError extends Error {
  constructor(public body: ApiError, public reason: AgentErrorReason = 'failed') {
    super(body.message);
    this.name = 'AgentError';
  }
}
export type AgentErrorReason =
  | 'auth' | 'quota' | 'crashed' | 'start_timeout' | 'timeout' | 'protocol' | 'not_found' | 'invalid_value' | 'unsupported' | 'failed';
