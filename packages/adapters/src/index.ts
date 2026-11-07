// @aic/adapters：各 Agent 适配器（phase-1.md 6.2）。
import type { AgentAdapter } from './types';
import type { AcpRuntime } from './acp/session';
import { createClaudeAdapter } from './claude';
import { createCodexAdapter } from './codex';
import { createCodebuddyAdapter, createWorkbuddyAdapter } from './codebuddy';
import { createFakeAdapter } from './fake';
import { createZcodeAdapter } from './zcode';

export * from './types';
export { createFakeAdapter, FAKE_MODELS, FAKE_EFFORTS, type FakeAgentOptions } from './fake';
export { createClaudeAdapter, claudePaths, CLAUDE_AUTH_METHODS, CLAUDE_SESSION_META, CLAUDE_SCRUB_ENV } from './claude';
export { createCodexAdapter, codexPaths, CODEX_AUTH_METHODS, CODEX_KEY_ENV } from './codex';
export { createCodebuddyAdapter, createWorkbuddyAdapter, findCodebuddy, findCodebuddyStandalone, isLiteOnlyEngine, CODEBUDDY_AUTH_METHODS, WORKBUDDY_AUTH_METHODS, WORKBUDDY_APP_METHOD } from './codebuddy';
export { createZcodeAdapter, findZcode, pingAppServer, ZCODE_BRIDGE_PENDING } from './zcode';
export { AcpConnection, DEFAULT_TIMEOUTS, type AcpTimeouts, type AcpConnectionOptions } from './acp/connection';
export { AcpSession, acpSpawn, acpProbe, agentEnv, type AcpAgentSpec, type AcpRuntime } from './acp/session';
export { buildChildEnv, shouldStrip, killTree, killTreeSync, isAlive, processStartTimes, descendants, runCli, type LaunchSpec } from './acp/launch';
export { classifyError, agentErrors, isAuthError, isNotFound } from './acp/errors';
export { parseConfigState, EMPTY_CONFIG } from './acp/config';
export { normalizePermission, normalizeKind } from './acp/permissions';
export { UpdateMapper } from './acp/updates';
export { redact, redactExact, clip, StreamRedactor } from './redact';
export { isVerified, VERIFIED } from './verified';
export { AbortError, newId, sleep, now } from './util';

export interface CreateAdaptersOptions extends AcpRuntime {
  /** 演示 Agent 的节奏倍率（测试里设为 0） */
  fakeSpeed?: number;
  /** CodeBuddy 引擎位置（不传则用工作台自带的独立版） */
  codebuddyPath?: string | null;
  /** WorkBuddy 内置引擎位置（不传则自动查找） */
  workbuddyPath?: string | null;
  /** ZCode 内置引擎位置（不传则自动查找） */
  zcodePath?: string | null;
}

/** 演示 Agent + 三个真实 Agent */
export function createAdapters(opts: CreateAdaptersOptions): AgentAdapter[] {
  return [
    createFakeAdapter({ speed: opts.fakeSpeed ?? 1 }),
    createClaudeAdapter(opts),
    createCodexAdapter(opts),
    createCodebuddyAdapter({ ...opts, enginePath: opts.codebuddyPath ?? null }),
    createWorkbuddyAdapter({ ...opts, enginePath: opts.workbuddyPath ?? null }),
    createZcodeAdapter({ enginePath: opts.zcodePath ?? null, log: opts.log }),
  ];
}
export { createSpecAdapter, specFromOptions, type SpecAdapterOptions } from './generic';
