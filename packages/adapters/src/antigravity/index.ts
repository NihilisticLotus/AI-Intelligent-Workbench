// Google Antigravity：通过官方命令行 `agy acp`（ACP v1 over stdio）原生接入（phase-1.md 第 14 节）。
// `agy` 与 Antigravity 桌面版共用系统安全凭据中的登录态；工作台不读取 ~/.gemini 下的任何凭据或配置文件。
// 权限只开放“只读（plan）”和“需审批（default）”，严禁传 --dangerously-skip-permissions。
import { existsSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { PermissionLevel } from '@aic/protocol';
import { AcpConnection } from '../acp/connection';
import { agentErrors, isAuthError } from '../acp/errors';
import { buildNativeEnv, runCli } from '../acp/launch';
import { acpProbe, acpSpawn, agentEnv, type AcpAgentSpec, type AcpRuntime } from '../acp/session';
import { initAuthMethods, nativeAccountEnv } from '../common';
import { redact } from '../redact';
import type { AgentAdapter, AuthMethodInfo, DetectResult } from '../types';
import { isRecord, str } from '../util';
import { isVerified } from '../verified';

const NAME = 'Antigravity';
const LOGIN_CACHE_MS = 10 * 60_000;
const MODE_RANK: Record<string, number> = {
  plan: 0,
  default: 1,
  'accept-edits': 2,
  acceptEdits: 2,
  auto: 3,
  bypass: 4,
  bypassPermissions: 4,
};

export const ANTIGRAVITY_CLI_MISSING_WITH_APP = '已检测到 Antigravity 桌面版，但尚未安装官方命令行组件 agy。安装官方 Antigravity CLI 后点 [重新检测]';
export const ANTIGRAVITY_NOT_FOUND = '没有找到 Google Antigravity（agy）。安装 Antigravity CLI 后点 [重新检测]';
const NOT_LOGGED_IN = '还没有登录：请在 Antigravity 应用中登录（或在终端运行 agy acp --login），完成后点 [重新检测]';

export const ANTIGRAVITY_AUTH_METHODS: AuthMethodInfo[] = [
  { id: 'oauth-personal', name: 'Google 账号登录', description: '使用个人 Google 账号在浏览器完成授权', flow: 'browser' },
  { id: 'oauth-business', name: 'Gemini Enterprise 登录', description: '使用企业账号在浏览器完成授权', flow: 'browser' },
  { id: 'gemini-api-key', name: 'Gemini API Key', description: '在自身环境中配置 GEMINI_API_KEY', flow: 'apiKey' },
  { id: 'agent-platform', name: 'Google Cloud 项目（ADC）', description: '使用 Google Cloud 默认应用凭据', flow: 'browser' },
];

/** 是否安装了 Antigravity 桌面版（仅用于给出更准确的未安装 CLI 提示文案） */
export function hasAntigravityApp(): boolean {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    return !!(local && existsSync(path.join(local, 'Programs', 'antigravity', 'Antigravity.exe')));
  }
  if (process.platform === 'darwin') return existsSync('/Applications/Antigravity.app');
  return false;
}

/** 查找官方 agy 可执行文件：override → 默认安装目录（%LOCALAPPDATA%\agy\bin\agy.exe / ~/.local/bin/agy）→ PATH */
export function findAntigravity(override?: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (override) return existsSync(override) ? override : null;
  const exeName = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const cands: string[] = [];
  if (process.platform === 'win32') {
    const local = env.LOCALAPPDATA ?? process.env.LOCALAPPDATA;
    if (local) cands.push(path.join(local, 'agy', 'bin', 'agy.exe'));
  } else {
    cands.push(path.join(homedir(), '.local', 'bin', 'agy'));
  }
  const pathRaw = env.PATH ?? env.Path ?? process.env.PATH ?? '';
  for (const dir of pathRaw.split(path.delimiter)) {
    const trimmed = dir.trim();
    if (trimmed) cands.push(path.join(trimmed, exeName));
  }
  for (const c of cands) {
    if (existsSync(c)) return c;
  }
  return null;
}

export interface AntigravityOptions extends AcpRuntime {
  /** 测试或自定义路径覆盖 */
  enginePath?: string | null;
}

export function createAntigravityAdapter(rt: AntigravityOptions): AgentAdapter {
  const versionCache = new Map<string, string | null>();
  const loginCache = new Map<string, { at: number; loggedIn: boolean | null }>();

  const notFoundMessage = () => (hasAntigravityApp() ? ANTIGRAVITY_CLI_MISSING_WITH_APP : ANTIGRAVITY_NOT_FOUND);

  const spec: AcpAgentSpec = {
    kind: 'antigravity',
    displayName: NAME,
    usesNativeConfig: true,
    launch: (env) => {
      const exe = findAntigravity(rt.enginePath, env);
      if (!exe) throw agentErrors.notInstalled('antigravity', NAME, notFoundMessage());
      // 若 override 传入的是测试脚本（.js / .mjs / .cjs），交给当前 Node 启动；否则直接启动原生 agy 可执行文件
      if (/\.(m|c)?js$/i.test(exe)) return { entry: exe, args: ['acp', '--disable-telemetry'] };
      return { command: exe, args: ['acp', '--disable-telemetry'] };
    },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } },
    modeFor: (level: PermissionLevel) => (level === 'readonly' ? 'plan' : level === 'ask' ? 'default' : level === 'workspace' ? 'accept-edits' : 'auto'),
    modeRank: (m) => MODE_RANK[m] ?? 99,
    extensions: [],
    launchModel: (model) => ({ args: ['--model', model] }),
    authMethodsFromInit: (init) => initAuthMethods(init).map((m) => ANTIGRAVITY_AUTH_METHODS.find((x) => x.id === m.id) ?? {
      id: m.id, name: m.name, description: m.description, flow: 'browser' as const,
    }),
  };

  async function readAgyVersion(exe: string, env: Record<string, string>): Promise<string | null> {
    let key = exe;
    try { key = `${exe}|${statSync(exe).mtimeMs}`; } catch { /* 用路径 */ }
    if (versionCache.has(key)) return versionCache.get(key) ?? null;
    const launch = /\.(m|c)?js$/i.test(exe) ? { entry: exe, args: ['--version'] } : { command: exe, args: ['--version'] };
    const r = await runCli(launch, { env: buildNativeEnv(env), timeoutMs: 20_000 });
    const v = /(\d+\.\d+\.\d+)/.exec(`${r.stdout}\n${r.stderr}`)?.[1] ?? null;
    if (v) versionCache.set(key, v);
    return v;
  }

  /** 通过零费用 ACP 握手（initialize → session/new → session/close）判断本机是否已登录，不读取任何凭据文件 */
  async function checkLogin(env: Record<string, string>, secrets: string[]): Promise<boolean | null> {
    const full = agentEnv(spec, env);
    let conn: AcpConnection | null = null;
    try {
      conn = await AcpConnection.start({
        kind: 'antigravity', displayName: NAME, launch: spec.launch(full), cwd: tmpdir(), env: full, redact: secrets, log: rt.log, label: 'detect',
        ...(rt.tracker ? { tracker: rt.tracker } : {}),
        ...(spec.clientCapabilities ? { clientCapabilities: spec.clientCapabilities } : {}),
        timeouts: { ...rt.timeouts, initialize: Math.min(rt.timeouts?.initialize ?? 30_000, 30_000) },
      });
      const resp = await conn.request<Record<string, unknown>>('session/new', { cwd: tmpdir(), mcpServers: [] }, conn.timeouts.session, 'session');
      const sid = isRecord(resp) ? str(resp.sessionId) : null;
      if (sid) await conn.request('session/close', { sessionId: sid }, 2_000).catch(() => {});
      return true;
    } catch (e) {
      if (isAuthError(e)) return false;
      rt.log('warn', `[agent:antigravity] 检查登录状态失败：${redact(e instanceof Error ? e.message : String(e), secrets)}`);
      return null;
    } finally {
      await conn?.close().catch(() => {});
    }
  }

  return {
    id: 'antigravity',
    displayName: NAME,
    real: true,
    usesNativeConfig: true,
    authMethods: [],
    permissionLevels: ['readonly', 'ask'],
    autoProbe: false,
    launchModel: true,
    workspaceConfig: 'trusted_only',
    experimentalProfile: () => false,
    sessionStore: () => 'shared',

    async detect(opts = {}): Promise<DetectResult> {
      const env = opts.env ?? {};
      const exe = findAntigravity(rt.enginePath, { ...process.env, ...env });
      const base: DetectResult = {
        installed: !!exe, version: null, enginePath: exe, loggedIn: false, message: null,
        adapterVersion: null, engineVersion: null, engineSource: 'local', engineLocation: '本机安装的 Antigravity CLI（agy）',
        verified: false, authMethods: ANTIGRAVITY_AUTH_METHODS, loginCheck: 'unknown', checkedAt: Date.now(),
      };
      if (!exe) return { ...base, message: notFoundMessage() };
      const engineVer = await readAgyVersion(exe, env);
      const verified = isVerified('antigravity', null, engineVer);
      if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) {
        return { ...base, version: engineVer, engineVersion: engineVer, verified, loggedIn: true, loginCheck: 'secret' };
      }
      const cacheKey = `${exe}|${engineVer ?? ''}`;
      const cached = loginCache.get(cacheKey);
      let loggedIn: boolean | null;
      if (!opts.force && cached && Date.now() - cached.at < LOGIN_CACHE_MS) loggedIn = cached.loggedIn;
      else {
        loggedIn = await checkLogin(env, opts.redact ?? []);
        loginCache.set(cacheKey, { at: Date.now(), loggedIn });
      }
      return {
        ...base,
        version: engineVer,
        engineVersion: engineVer,
        verified,
        loggedIn: loggedIn === true,
        loginCheck: loggedIn === null ? 'unknown' : 'acp',
        message: loggedIn === null ? '没能判断登录状态' : loggedIn ? null : NOT_LOGGED_IN,
      };
    },

    async login() { throw agentErrors.unsupported(NAME, '在工作台里登录，请在 Antigravity 应用中完成登录'); },

    buildEnv: nativeAccountEnv,

    async listModels() { return []; },
    async listEfforts() { return null; },

    spawn(opts) { return acpSpawn(spec, rt, opts); },
    async probeCapabilities(conn) {
      if (!conn.caps) throw agentErrors.protocol('antigravity', NAME, '会话没有能力信息');
      return conn.caps;
    },
    probe(opts) { return acpProbe(spec, rt, opts); },
    mapPermissionLevel(level) { return { modeId: spec.modeFor(level) ?? undefined }; },
  };
}
