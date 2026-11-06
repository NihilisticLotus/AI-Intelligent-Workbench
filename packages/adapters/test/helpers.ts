// 契约测试工具：剧本文件、假 ACP Agent 的适配器、记录更新的 SessionHost
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpecAdapter, type AgentAdapter, type AgentUpdate, type LogFn, type PermissionOutcome, type PermissionRequest, type SessionHost, type AcpTimeouts } from '../src/index';

export const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-agent.mjs');

export interface Scenario { dir: string; env: Record<string, string>; log(): Record<string, any>[]; cleanup(): void }

/** 写剧本文件，返回给假 Agent 的环境变量 */
export function scenario(sc: Record<string, unknown>): Scenario {
  const dir = mkdtempSync(path.join(tmpdir(), 'aic-acp-'));
  const file = path.join(dir, 'scenario.json');
  const logFile = path.join(dir, 'agent.log');
  writeFileSync(file, JSON.stringify(sc));
  return {
    dir,
    env: { AIC_FAKE_SCENARIO: file, AIC_FAKE_LOG: logFile },
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上偶尔被占用 */ } },
  };
}

export const MODES = [{ value: 'plan', name: 'Plan' }, { value: 'default', name: 'Default' }, { value: 'acceptEdits', name: 'Accept edits' }, { value: 'bypassPermissions', name: 'Bypass' }];
export const MODELS = [{ value: 'alpha', name: 'Alpha' }, { value: 'beta', name: 'Beta' }];

export class LogSink {
  lines: { level: string; msg: string }[] = [];
  fn: LogFn = (level, msg) => { this.lines.push({ level, msg }); };
  text() { return this.lines.map((l) => l.msg).join('\n'); }
}

export function fakeAdapter(sc: Scenario, opts: { timeouts?: Partial<AcpTimeouts>; log?: LogSink } = {}): AgentAdapter {
  return createSpecAdapter({ kind: 'claude', displayName: '假 Agent', entry: FIXTURE, env: sc.env }, {
    log: (opts.log ?? new LogSink()).fn,
    ...(opts.timeouts ? { timeouts: opts.timeouts } : {}),
  });
}

/** 记录所有更新；审批按 decide 决定 */
export class RecordingHost implements SessionHost {
  updates: AgentUpdate[] = [];
  requests: PermissionRequest[] = [];
  decide: (req: PermissionRequest, signal: AbortSignal) => Promise<PermissionOutcome> = async (req) => {
    const o = req.options.find((x) => x.kind === 'allow_once');
    return o ? { outcome: 'selected', optionId: o.id } : { outcome: 'cancelled' };
  };
  update(u: AgentUpdate) { this.updates.push(u); }
  requestPermission(req: PermissionRequest, signal: AbortSignal) { this.requests.push(req); return this.decide(req, signal); }
  kinds() { return this.updates.map((u) => u.kind); }
  of<K extends AgentUpdate['kind']>(k: K) { return this.updates.filter((u): u is Extract<AgentUpdate, { kind: K }> => u.kind === k); }
}

export const waitFor = async (pred: () => boolean, ms = 5000) => {
  const t = Date.now();
  while (!pred()) {
    if (Date.now() - t > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
};
