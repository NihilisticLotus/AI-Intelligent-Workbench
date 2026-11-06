// CodeBuddy：WorkBuddy 内置的 CodeBuddy 引擎，原生 --acp（phase-1.md 6.3）。
// 登录沿用 WorkBuddy（共用 ~/.codebuddy），我们不读这个目录里的任何文件；登录态脆弱，检查结果缓存 10 分钟（ISSUE-0008）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionLevel } from '@aic/protocol';
import { AcpConnection } from '../acp/connection';
import { agentErrors } from '../acp/errors';
import { acpProbe, acpSpawn, agentEnv, type AcpAgentSpec, type AcpRuntime } from '../acp/session';
import { acpAuthenticateLogin, readVersion } from '../common';
import type { AccountProfile, AgentAdapter, AuthMethodInfo, DetectResult, LoginHandle, LoginRequest } from '../types';
import { isRecord } from '../util';
import { isVerified } from '../verified';

const NAME = 'CodeBuddy';
const MODE_RANK: Record<string, number> = { plan: 0, dontAsk: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4, fullAccess: 5 };
const REL = ['resources', 'app.asar.unpacked', 'cli', 'dist', 'codebuddy.js'];
const LOGIN_CACHE_MS = 10 * 60_000;
const AUTH_HOSTS = ['codebuddy.ai', 'codebuddy.cn', 'copilot.tencent.com', 'tencent.com', 'qq.com', 'github.com', 'google.com'];
export const WORKBUDDY_APP_METHOD = 'workbuddy-app';

export const CODEBUDDY_AUTH_METHODS: AuthMethodInfo[] = [
  { id: WORKBUDDY_APP_METHOD, name: '在 WorkBuddy 中登录', description: '打开 WorkBuddy，在那里登录后回来点 [重新检测]', flow: 'external_app' },
  { id: 'internal', name: '微信登录（国内版）', description: '会打开浏览器；也会同时登录 WorkBuddy', flow: 'browser' },
  { id: 'external', name: 'Google / GitHub 登录（国际版）', description: '会打开浏览器；也会同时登录 WorkBuddy', flow: 'browser' },
  { id: 'iOA', name: 'iOA 登录（腾讯内网）', description: '会打开浏览器', flow: 'browser' },
  { id: 'api-key', name: 'API Key（实验）', description: '只有源码依据，没有实测', flow: 'apiKey' },
];

/** 找引擎：先看已知位置，找不到时扫描 %LOCALAPPDATA%\Programs 下的同名目录（design 6.3） */
export function findCodebuddy(override?: string | null): { js: string | null; root: string | null } {
  const cands: string[] = [];
  if (override) cands.push(override);
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const programs = path.join(local, 'Programs');
    cands.push(path.join(programs, 'WorkBuddy', ...REL));
    try {
      for (const d of readdirSync(programs, { withFileTypes: true })) if (d.isDirectory()) cands.push(path.join(programs, d.name, ...REL));
    } catch { /* 目录不存在 */ }
  }
  for (const c of cands) {
    if (existsSync(c)) return { js: c, root: path.resolve(path.dirname(c), '..', '..', '..', '..') };
  }
  return { js: null, root: null };
}

/**
 * 引擎版本：cli/package.json 里写的是 0.0.0（打包时没有回填），真实版本嵌在 codebuddy.js 的
 * "@tencent-ai/codebuddy-code" 包信息里。文件约 20 MB，按路径 + 修改时间 + 大小缓存，只读一次。
 */
const versionCache = new Map<string, string | null>();
export function readCodebuddyVersion(js: string): string | null {
  const fromPkg = readVersion(path.resolve(path.dirname(js), '..', 'package.json'));
  if (fromPkg && fromPkg !== '0.0.0') return fromPkg;
  let key: string;
  try { const st = statSync(js); key = `${js}|${st.mtimeMs}|${st.size}`; } catch { return fromPkg; }
  if (!versionCache.has(key)) {
    let v: string | null = null;
    try {
      v = /"name":"@tencent-ai\/codebuddy-code","version":"(\d[^"]{0,40})"/.exec(readFileSync(js, 'utf8'))?.[1] ?? null;
    } catch { /* 读不到就用 package.json 的值 */ }
    versionCache.set(key, v);
  }
  return versionCache.get(key) ?? fromPkg;
}

export interface CodebuddyOptions extends AcpRuntime {
  /** 引擎 js 的位置（测试或用户点选安装目录时用） */
  enginePath?: string | null;
}

export function createCodebuddyAdapter(rt: CodebuddyOptions): AgentAdapter {
  let loc = findCodebuddy(rt.enginePath);
  const loginCache = new Map<string, { at: number; loggedIn: boolean | null }>();

  const spec: AcpAgentSpec = {
    kind: 'codebuddy', displayName: NAME,
    launch: () => {
      if (!loc.js || !existsSync(loc.js)) loc = findCodebuddy(rt.enginePath);
      if (!loc.js) throw agentErrors.notInstalled('codebuddy', NAME, '没有找到 WorkBuddy。请先安装 WorkBuddy');
      // --setting-sources user：不加载工作区里的 .codebuddy/settings*.json（仓库自带的 hooks、自动允许规则会绕过工作台审批）
      return { entry: loc.js, args: ['--acp', '--setting-sources', 'user'] };
    },
    modeFor: (level: PermissionLevel) => (level === 'readonly' ? 'plan' : level === 'ask' ? 'default' : level === 'workspace' ? 'acceptEdits' : 'bypassPermissions'),
    modeRank: (m) => MODE_RANK[m] ?? 99,
    extensions: ['_codebuddy.ai/*'],
    dirEnvKeys: ['CODEBUDDY_CONFIG_DIR'],
    launchModel: (model) => ({ args: ['--model', model] }),
    onNotification: (ctx, method) => {
      // 私有通知（artifact、question、checkpoint、command 等）只记类型名，不报错
      if (method.startsWith('_codebuddy.ai/')) ctx.log('debug', `[agent:codebuddy] 私有通知 ${method}`);
    },
    authMethodsFromInit: () => CODEBUDDY_AUTH_METHODS,
  };

  /** initialize → _codebuddy.ai/getUserInfo：只看有没有 userInfo.userId，其余丢弃，不存用户信息 */
  async function checkLogin(env: Record<string, string>): Promise<boolean | null> {
    const full = agentEnv(spec, env);
    let conn: AcpConnection | null = null;
    try {
      conn = await AcpConnection.start({
        kind: 'codebuddy', displayName: NAME, launch: spec.launch(full), cwd: tmpdir(), env: full, log: rt.log, label: 'detect',
        ...(rt.tracker ? { tracker: rt.tracker } : {}), timeouts: { ...rt.timeouts, initialize: Math.min(rt.timeouts?.initialize ?? 30_000, 30_000) },
      });
      const r = await conn.request('_codebuddy.ai/getUserInfo', {}, 15_000);
      const ui = isRecord(r) && isRecord(r.userInfo) ? r.userInfo : null;
      return !!(ui && (typeof ui.userId === 'string' || typeof ui.userId === 'number') && String(ui.userId));
    } catch (e) {
      rt.log('warn', `[agent:codebuddy] 检查登录状态失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      await conn?.close().catch(() => {});
    }
  }

  return {
    id: 'codebuddy', displayName: NAME, real: true,
    authMethods: ['oauth', 'apiKey', 'customEndpoint'],
    permissionLevels: ['readonly', 'ask'],
    // 不自动探测：需要登录，且登录态脆弱（ISSUE-0008）
    autoProbe: false,
    launchModel: true,
    workspaceConfig: 'ignored',
    experimentalProfile: (kind) => kind !== 'subscription',

    async detect(opts = {}): Promise<DetectResult> {
      loc = findCodebuddy(rt.enginePath);
      const version = loc.js ? readCodebuddyVersion(loc.js) : null;
      const base: DetectResult = {
        installed: !!loc.js, version, enginePath: loc.js, loggedIn: false, message: null,
        adapterVersion: null, engineVersion: version, engineSource: 'app', engineLocation: 'WorkBuddy 内置',
        verified: isVerified('codebuddy', null, version), authMethods: CODEBUDDY_AUTH_METHODS, loginCheck: 'unknown', checkedAt: Date.now(),
      };
      if (!loc.js) return { ...base, message: '没有找到 WorkBuddy。请先安装 WorkBuddy，安装后点 [重新检测]' };
      const env = opts.env ?? {};
      if (env.CODEBUDDY_API_KEY || env.CODEBUDDY_AUTH_TOKEN) return { ...base, loggedIn: true, loginCheck: 'secret' };
      const key = JSON.stringify(Object.keys(env).sort().map((k) => [k, k.startsWith('CODEBUDDY_CONFIG') ? env[k] : '']));
      const cached = loginCache.get(key);
      let loggedIn: boolean | null;
      if (!opts.force && cached && Date.now() - cached.at < LOGIN_CACHE_MS) loggedIn = cached.loggedIn;
      else {
        loggedIn = await checkLogin(env);
        loginCache.set(key, { at: Date.now(), loggedIn });
      }
      return {
        ...base, loggedIn: loggedIn === true, loginCheck: loggedIn === null ? 'unknown' : 'acp',
        message: loggedIn === null ? '没能判断登录状态' : loggedIn ? null : '还没有登录：请在 WorkBuddy 里登录，或在这里登录',
      };
    },

    async login() { throw agentErrors.unsupported(NAME, '直接登录，请使用 startLogin'); },

    buildEnv(profile: AccountProfile, secret?: string | null) {
      const env: Record<string, string> = {};
      const kind = profile.kind ?? 'subscription';
      if (kind === 'subscription') {
        if (profile.configDir === 'isolated' && profile.profileDir) env.CODEBUDDY_CONFIG_DIR = path.join(profile.profileDir, 'codebuddy');
      } else if (kind === 'apiKey') {
        if (secret) env.CODEBUDDY_API_KEY = secret;
      } else {
        if (profile.baseUrl) env.CODEBUDDY_BASE_URL = profile.baseUrl;
        if (secret) {
          if (profile.authHeader === 'bearer') env.CODEBUDDY_AUTH_TOKEN = secret;
          else env.CODEBUDDY_API_KEY = secret;
        }
      }
      return env;
    },

    async listModels() { return []; },
    async listEfforts() { return null; },

    spawn(opts) { return acpSpawn(spec, rt, opts); },
    async probeCapabilities(conn) {
      if (!conn.caps) throw agentErrors.protocol('codebuddy', NAME, '会话没有能力信息');
      return conn.caps;
    },
    probe(opts) { return acpProbe(spec, rt, opts); },
    mapPermissionLevel(level) { return { modeId: spec.modeFor(level) ?? undefined }; },

    startLogin(req: LoginRequest): LoginHandle {
      loginCache.clear();
      if (req.methodId === WORKBUDDY_APP_METHOD) {
        // 启动 WorkBuddy，用户在那里登录后回来点 [重新检测]
        const exe = loc.root ? path.join(loc.root, 'WorkBuddy.exe') : null;
        req.onProgress({ state: 'started' });
        if (!exe || !existsSync(exe)) {
          return { done: Promise.resolve({ state: 'failed', message: '没有找到 WorkBuddy.exe' }), cancel() {} };
        }
        try {
          spawn(exe, [], { detached: true, stdio: 'ignore', shell: false }).unref();
        } catch (e) {
          return { done: Promise.resolve({ state: 'failed', message: `打开 WorkBuddy 失败：${(e as Error).message}` }), cancel() {} };
        }
        return { done: Promise.resolve({ state: 'succeeded', message: '已打开 WorkBuddy。请在 WorkBuddy 里登录，完成后回到这里点 [重新检测]' }), cancel() {} };
      }
      if (!['external', 'internal', 'iOA'].includes(req.methodId)) throw agentErrors.unsupported(NAME, `这种登录方式（${req.methodId}）`);
      // 对已登录的用户调用 authenticate 会先登出（Gateway 已要求 force 二次确认）
      return acpAuthenticateLogin(spec, rt, req, {
        authUrlMethod: '_codebuddy.ai/authUrl', authUrlHosts: AUTH_HOSTS,
        verify: (resp) => {
          const meta = isRecord(resp) && isRecord(resp._meta) ? resp._meta : {};
          const ui = isRecord(meta['codebuddy.ai/userinfo']) ? meta['codebuddy.ai/userinfo'] : null;
          return !!(ui && ui.userId);
        },
      });
    },
  };
}
