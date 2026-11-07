// ZCode（智谱）适配器：本步只做检测和连接测试，对话要等协议桥接（design.md 6.5，计划 M6）。
// ZCode 没有 ACP 模式，只有自家的 ZCode Protocol（`zcode app-server`，stdio 上的 JSON 行）。
// 2026-11-07 实测本机 0.17.1：`--version` 可用；app-server 启动后会推送 startup/storageState，
// 但不认 ACP 的 initialize（回 invalid-message），所以现在无法直接对话。
// 我们不读 ZCode 的登录文件（~/.zcode），登录状态一律记为“没能判断”。
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionLevel } from '@aic/protocol';
import { buildChildEnv, killTree, runCli } from '../acp/launch';
import { agentErrors } from '../acp/errors';
import type { AgentAdapter, DetectResult, LogFn, ProbeResult, ProbeStep } from '../types';
import { isVerified } from '../verified';

const NAME = 'ZCode';
export const ZCODE_BRIDGE_PENDING = '已找到 ZCode，但它用自家的通信协议，工作台还不能和它对话。协议桥接会在后续步骤提供（design.md 6.5）';
const NOT_FOUND = '没有找到 ZCode。安装 ZCode 后点 [重新检测]';

/** 引擎位置：%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs；override 用于测试 */
export function findZcode(override?: string | null): string | null {
  if (override) return existsSync(override) ? override : null;
  const base = process.env.LOCALAPPDATA;
  if (!base) return null;
  const js = path.join(base, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs');
  return existsSync(js) ? js : null;
}

export interface ZcodeOptions {
  enginePath?: string | null;
  log?: LogFn;
}

/** 启动 app-server，等它推送第一条 JSON 消息（证明引擎能跑起来、协议通道是通的），然后关掉 */
export function pingAppServer(js: string, timeoutMs = 15_000): Promise<{ ok: boolean; firstMethod: string | null; detail: string | null }> {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'aic-zcode-'));
    const done = (r: { ok: boolean; firstMethod: string | null; detail: string | null }) => {
      clearTimeout(timer);
      void killTree(child.pid ?? 0).finally(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* 忽略 */ } });
      resolve(r);
    };
    const child = spawn(process.execPath, [js, 'app-server'], { cwd, env: buildChildEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const j = JSON.parse(line) as { method?: unknown };
          done({ ok: true, firstMethod: typeof j.method === 'string' ? j.method : null, detail: null });
          return;
        } catch { /* 不是 JSON，继续等 */ }
      }
    });
    child.on('error', (e) => done({ ok: false, firstMethod: null, detail: e.message }));
    child.on('close', (code) => done({ ok: false, firstMethod: null, detail: `app-server 退出了（代码 ${code ?? '无'}）` }));
    const timer = setTimeout(() => done({ ok: false, firstMethod: null, detail: `${Math.round(timeoutMs / 1000)} 秒内没有响应` }), timeoutMs);
  });
}

export function createZcodeAdapter(o: ZcodeOptions = {}): AgentAdapter {
  const version = async (js: string) => {
    const r = await runCli({ entry: js, args: ['--version'] }, { env: buildChildEnv(), timeoutMs: 20_000 });
    const m = /\d+\.\d+\.\d+/.exec(r.stdout);
    return m ? m[0] : null;
  };
  return {
    id: 'zcode', displayName: NAME, real: true,
    authMethods: ['oauth'],
    permissionLevels: ['readonly', 'ask'] satisfies PermissionLevel[],
    autoProbe: false,
    workspaceConfig: 'ignored',

    async detect(): Promise<DetectResult> {
      const js = findZcode(o.enginePath);
      const base: DetectResult = {
        installed: !!js, version: null, enginePath: js, loggedIn: false, message: js ? ZCODE_BRIDGE_PENDING : NOT_FOUND,
        adapterVersion: null, engineVersion: null, engineSource: 'app', engineLocation: 'ZCode 内置引擎',
        verified: false, authMethods: [], loginCheck: 'unknown', checkedAt: Date.now(),
      };
      if (!js) return base;
      const v = await version(js).catch(() => null);
      return { ...base, version: v, engineVersion: v, verified: isVerified('zcode', null, v), unsupported: true };
    },

    async login() { throw agentErrors.unsupported(NAME, '在工作台里登录（请在 ZCode 里登录）'); },
    buildEnv() { return {}; },
    async listModels() { return []; },
    async listEfforts() { return null; },
    async spawn() { throw agentErrors.unsupported(NAME, `对话：${ZCODE_BRIDGE_PENDING}`); },
    async probeCapabilities() { throw agentErrors.unsupported(NAME, '能力探测'); },

    /** 测试连接：找到引擎 → 读版本 → 启动 app-server 等第一条消息 → 说明对话还要等桥接 */
    async probe(): Promise<ProbeResult> {
      const steps: ProbeStep[] = [];
      const step = (label: string, ok: boolean, t0: number, detail?: string) => steps.push({ ts: Date.now(), label, ok, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
      let t = Date.now();
      const js = findZcode(o.enginePath);
      step('找到引擎', !!js, t, js ? 'ZCode 内置引擎' : NOT_FOUND);
      if (!js) return { ok: false, steps, caps: null, config: null, authMethods: null };
      t = Date.now();
      const v = await version(js).catch(() => null);
      step('读取版本', !!v, t, v ?? '没有读到版本号');
      t = Date.now();
      const ping = await pingAppServer(js);
      step('启动 app-server（ZCode 自家协议）', ping.ok, t, ping.ok ? `收到 ${ping.firstMethod ?? '消息'}` : ping.detail ?? undefined);
      steps.push({ ts: Date.now(), label: '开始对话', ok: false, ms: 0, detail: ZCODE_BRIDGE_PENDING });
      o.log?.('info', `[agent:zcode] 连接测试：版本 ${v ?? '未知'}，app-server ${ping.ok ? '有响应' : '无响应'}`);
      return { ok: false, steps, caps: null, config: null, authMethods: null };
    },
  };
}
