// Agent 适配器接口（design.md 6.2）与注册表。
// 1.1 只有演示用的 fake；1.2 起 claude / codex / codebuddy 按同一接口接入（经 ACP）。
// 适配器只负责“说 Agent 的话”，产生的更新统一交给 SessionHost，由 Gateway 转成协议事件。
import type { AgentInfo, AgentKind, PermissionLevel } from '@aic/protocol';
import type { z } from 'zod';
import type { ModelInfo as ModelInfoSchema, ToolKind } from '@aic/protocol';

export type ModelInfo = z.infer<typeof ModelInfoSchema>;
export type ToolKindT = z.infer<typeof ToolKind>;

export interface DetectResult {
  installed: boolean;
  version: string | null;
  enginePath: string | null;
  loggedIn: boolean;
  message: string | null;
}

export type AuthMethod = 'none' | 'oauth' | 'apiKey' | 'customEndpoint';
export interface AccountProfile { id: string; agentId: AgentKind; name: string; authMethod: AuthMethod; baseUrl?: string }
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
}

/** Agent 发出的会话更新（对应 ACP session/update），Gateway 负责落库成事件 */
export type AgentUpdate =
  | { kind: 'thought'; messageId: string; text: string }
  | { kind: 'message'; messageId: string; text: string }
  | { kind: 'message_done'; messageId: string }
  | { kind: 'tool_start'; toolId: string; toolKind: ToolKindT; title: string; target: string | null }
  | { kind: 'tool_output'; toolId: string; text: string }
  /** rejected：用户在审批里拒绝，工具没有执行（不是执行出错） */
  | { kind: 'tool_end'; toolId: string; ok: boolean; summary: string | null; rejected?: boolean }
  | { kind: 'plan'; items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { kind: 'config'; model: string | null; effort: string | null };

/** 权限请求（对应 ACP session/request_permission）；选项由 Agent 自己提供 */
export interface PermissionRequest {
  toolId: string;
  title: string;
  reason: string;
  detail: string;
  cwd: string | null;
  options: { id: string; label: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
}
export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string; note?: string }
  | { outcome: 'cancelled' };

/** Gateway 提供给适配器的回调 */
export interface SessionHost {
  update(u: AgentUpdate): void;
  requestPermission(req: PermissionRequest, signal: AbortSignal): Promise<PermissionOutcome>;
}

export interface SpawnOptions {
  cwd: string;
  model: string | null;
  effort: string | null;
  permission: PermissionLevel;
  host: SessionHost;
  profile?: AccountProfile;
}

export type StopReason = 'end_turn' | 'cancelled' | 'refusal' | 'error';

/** 一条已建立的 Agent 会话（1.2 起是 ACP 连接的包装） */
export interface AgentConnection {
  /** Agent 自己的会话 ID，用于恢复 */
  readonly agentSessionId: string;
  prompt(text: string, signal: AbortSignal): Promise<{ stopReason: StopReason }>;
  setConfig(cfg: { model?: string; effort?: string }): Promise<void>;
  /** 权限级别映射到 Agent 自己的模式（session/set_mode） */
  setPermission(level: PermissionLevel): Promise<void>;
  close(): Promise<void>;
}

export interface AgentAdapter {
  id: AgentKind;
  displayName: string;

  // 环境
  detect(): Promise<DetectResult>;
  install?(progress: ProgressFn): Promise<void>;
  update?(progress: ProgressFn): Promise<void>;

  // 账号
  authMethods: AuthMethod[];
  login(profile: AccountProfile): Promise<void>;
  buildEnv(profile: AccountProfile): Record<string, string>;

  // 模型
  listModels(profile?: AccountProfile): Promise<ModelInfo[]>;
  /** 思考强度选项；null 表示不支持调节 */
  listEfforts(): Promise<string[] | null>;

  // 会话
  spawn(opts: SpawnOptions): Promise<AgentConnection>;
  probeCapabilities(conn: AgentConnection): Promise<AgentCaps>;

  mapPermissionLevel?(level: PermissionLevel): { modeId?: string };
  contextWindowOf?(modelId: string): number | undefined;
}

export class AgentRegistry {
  private adapters = new Map<AgentKind, AgentAdapter>();

  register(a: AgentAdapter) { this.adapters.set(a.id, a); }
  get(kind: AgentKind): AgentAdapter | undefined { return this.adapters.get(kind); }

  async info(a: AgentAdapter): Promise<AgentInfo> {
    const d = await a.detect();
    return {
      kind: a.id,
      displayName: a.displayName,
      status: !d.installed ? 'not_installed' : !d.loggedIn ? 'needs_login' : 'ready',
      version: d.version,
      verified: true,
      models: await a.listModels(),
      efforts: await a.listEfforts(),
      message: d.message,
    };
  }

  async list(): Promise<AgentInfo[]> {
    return Promise.all([...this.adapters.values()].map((a) => this.info(a)));
  }
}
