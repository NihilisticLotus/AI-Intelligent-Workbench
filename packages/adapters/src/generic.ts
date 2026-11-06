// 按 AcpAgentSpec 组装一个通用适配器：契约测试和 Gateway 集成测试用它接假 ACP Agent（phase-1.md 6.8），
// 也可以用来临时接入其他原生支持 ACP 的 Agent。
import type { AgentKind, PermissionLevel } from '@aic/protocol';
import { agentErrors } from './acp/errors';
import { acpProbe, acpSpawn, type AcpAgentSpec, type AcpRuntime } from './acp/session';
import type { AgentAdapter, AuthMethodInfo, DetectResult } from './types';

export interface SpecAdapterOptions {
  kind: AgentKind;
  displayName: string;
  entry: string;
  args?: string[];
  /** 额外固定注入的环境变量（例如假 Agent 的剧本路径） */
  env?: Record<string, string>;
  modes?: Partial<Record<PermissionLevel, string>>;
  modeRank?: Record<string, number>;
  permissionLevels?: PermissionLevel[];
  detect?: Partial<DetectResult>;
  authMethods?: AuthMethodInfo[];
  autoProbe?: boolean;
  /** 建会话时带的 _meta（测试 Claude 的设置隔离用） */
  sessionMeta?: Record<string, unknown>;
  /** 启动时指定模型用的环境变量名（测试 H1 用） */
  launchModelEnv?: string;
}

export function specFromOptions(o: SpecAdapterOptions): AcpAgentSpec {
  const modes = o.modes ?? { readonly: 'plan', ask: 'default', workspace: 'acceptEdits', full: 'bypassPermissions' };
  const rank = o.modeRank ?? { plan: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };
  return {
    kind: o.kind, displayName: o.displayName,
    launch: () => ({ entry: o.entry, args: o.args ?? [] }),
    modeFor: (l) => modes[l] ?? null,
    modeRank: (m) => rank[m] ?? 99,
    extensions: [],
    onNotification: (ctx, method, params) => {
      if (method === '_auth/status_update' && params && typeof params === 'object' && (params as { kind?: unknown }).kind === 'none') ctx.emit({ kind: 'auth', loggedIn: false });
    },
    authMethodsFromInit: () => o.authMethods ?? [],
    ...(o.sessionMeta ? { sessionMeta: () => structuredClone(o.sessionMeta!) } : {}),
    ...(o.launchModelEnv ? { launchModel: (model: string) => ({ env: { [o.launchModelEnv!]: model } }) } : {}),
  };
}

export function createSpecAdapter(o: SpecAdapterOptions, rt: AcpRuntime): AgentAdapter {
  const spec = specFromOptions(o);
  const withEnv = (env?: Record<string, string>) => ({ ...(o.env ?? {}), ...(env ?? {}) });
  return {
    id: o.kind, displayName: o.displayName, real: true,
    authMethods: ['oauth', 'apiKey'],
    permissionLevels: o.permissionLevels ?? ['readonly', 'ask'],
    autoProbe: o.autoProbe ?? false,
    ...(o.launchModelEnv ? { launchModel: true } : {}),
    async detect() {
      return {
        installed: true, version: '9.9.9', enginePath: o.entry, loggedIn: true, message: null,
        adapterVersion: '9.9.9', engineVersion: '9.9.9', engineSource: 'bundled', engineLocation: '测试用假 Agent',
        verified: false, authMethods: o.authMethods ?? [], loginCheck: 'none', checkedAt: Date.now(), ...o.detect,
      };
    },
    async login() { throw agentErrors.unsupported(o.displayName, '登录'); },
    buildEnv(profile, secret): Record<string, string> { return profile.kind === 'apiKey' && secret ? { AIC_FAKE_SECRET: secret } : {}; },
    async listModels() { return []; },
    async listEfforts() { return null; },
    spawn(opts) { return acpSpawn(spec, rt, { ...opts, env: withEnv(opts.env) }); },
    async probeCapabilities(conn) {
      if (!conn.caps) throw agentErrors.protocol(o.kind, o.displayName, '会话没有能力信息');
      return conn.caps;
    },
    probe(opts) { return acpProbe(spec, rt, { ...opts, env: withEnv(opts.env) }); },
    mapPermissionLevel(level) { return { modeId: spec.modeFor(level) ?? undefined }; },
  };
}
