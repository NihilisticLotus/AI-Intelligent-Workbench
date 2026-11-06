// Agent 注册表。适配器接口（design.md 6.2）1.2 起定义在 @aic/adapters（phase-1.md 6.1），
// 这里重新导出这些类型，Gateway 里现有的引用路径不变。
import type { AgentInfo, AgentKind } from '@aic/protocol';
import type { AgentAdapter } from '@aic/adapters';

export type {
  AccountProfile, AgentAdapter, AgentCaps, AgentConnection, AgentUpdate, AuthMethod, DetectResult, ModelInfo,
  PermissionOutcome, PermissionRequest, ProgressFn, SessionHost, SpawnOptions, StopReason, ToolKindT,
  SessionConfigState, AuthMethodInfo, LoginHandle, ProbeResult,
} from '@aic/adapters';

export class AgentRegistry {
  private adapters = new Map<AgentKind, AgentAdapter>();

  register(a: AgentAdapter) { this.adapters.set(a.id, a); }
  get(kind: AgentKind): AgentAdapter | undefined { return this.adapters.get(kind); }
  all(): AgentAdapter[] { return [...this.adapters.values()]; }

  /** 1.1 的简单版本：直接检测。1.2 起 GET /agents 走 AgentService（带缓存、账号、能力） */
  async info(a: AgentAdapter): Promise<AgentInfo> {
    const d = await a.detect();
    return {
      kind: a.id,
      displayName: a.displayName,
      status: !d.installed ? 'not_installed' : !d.loggedIn ? 'needs_login' : 'ready',
      version: d.version,
      verified: d.verified ?? true,
      models: await a.listModels(),
      efforts: await a.listEfforts(),
      message: d.message,
    };
  }

  async list(): Promise<AgentInfo[]> {
    return Promise.all([...this.adapters.values()].map((a) => this.info(a)));
  }
}
