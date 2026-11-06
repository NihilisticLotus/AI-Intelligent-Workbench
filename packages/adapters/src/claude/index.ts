// Claude Code：经 @agentclientprotocol/claude-agent-acp 0.100.0 接入（phase-1.md 6.3）。
// 引擎默认用适配器自带的 claude.exe；Agent 设置里可以改成本机 npm 全局安装的 Claude Code（注入 CLAUDE_CODE_EXECUTABLE）。
// 两者读同一个配置目录（CLAUDE_CONFIG_DIR，默认 ~/.claude），登录态共享。我们不读这个目录里的任何文件。
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { PermissionLevel } from '@aic/protocol';
import { agentErrors } from '../acp/errors';
import { buildChildEnv, killTree, runCli, spawnAgent } from '../acp/launch';
import { acpProbe, acpSpawn, type AcpAgentSpec, type AcpRuntime } from '../acp/session';
import { allowedAuthUrl, initAuthMethods, LOGIN_TIMEOUT_MS, loginLifecycle, pkgDirOf, readVersion, resolveFrom } from '../common';
import type {
  AccountProfile, AgentAdapter, AgentSettings, AuthMethodInfo, DetectResult, LoginHandle, LoginRequest,
} from '../types';
import { isVerified } from '../verified';
import { isRecord } from '../util';

const NAME = 'Claude Code';
const MODE_RANK: Record<string, number> = { plan: 0, default: 1, acceptEdits: 2, auto: 3, bypassPermissions: 4 };

/**
 * 建会话时传给 claude-agent-acp 的 _meta（session/new、resume、load 都带）。
 * - settingSources 只留 user：不加载工作区里的 .claude/settings.json、settings.local.json。通过 SDK 启动时没有 CLI 的
 *   “是否信任此文件夹”确认，仓库自带的 hooks 会以用户身份直接执行，permissions.allow 会让工具不经审批就运行。
 * - allowDangerouslySkipPermissions: false：从源头关掉 bypassPermissions 模式（适配器据此也不提供这个模式）。
 */
export const CLAUDE_SESSION_META = { claudeCode: { options: { settingSources: ['user'], allowDangerouslySkipPermissions: false } } } as const;
/** 工具子进程（Bash 等）不继承 Anthropic 凭据：Claude Code 启动子进程前清理这些环境变量 */
export const CLAUDE_SCRUB_ENV = { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } as const;
/** 订阅登录时 CLI 输出里可能出现的授权链接（只推这些主机） */
const AUTH_HOSTS = ['claude.ai', 'console.anthropic.com', 'platform.claude.com', 'anthropic.com', 'claude.com'];

export const CLAUDE_AUTH_METHODS: AuthMethodInfo[] = [
  { id: 'claude-ai-login', name: 'Claude 订阅登录', description: '用 Claude Pro / Max 订阅账号登录（会打开浏览器）', flow: 'browser' },
  { id: 'console-login', name: 'Anthropic Console 登录', description: '按 API 用量计费（会打开浏览器）', flow: 'browser' },
  { id: 'api-key', name: '官方 API Key', description: '在账号里填写 Anthropic API Key', flow: 'apiKey' },
];

/** 适配器包与引擎的位置 */
export function claudePaths() {
  const pkg = resolveFrom('@agentclientprotocol/claude-agent-acp/package.json');
  const dir = pkgDirOf(pkg);
  const entry = dir ? path.join(dir, 'dist', 'index.js') : null;
  const sdkMain = pkg ? resolveFrom('@anthropic-ai/claude-agent-sdk', pkg) : null;
  const plat = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  const platPkg = sdkMain ? resolveFrom(`${plat}/package.json`, sdkMain) : null;
  const bundledExe = platPkg ? path.join(path.dirname(platPkg), process.platform === 'win32' ? 'claude.exe' : 'claude') : null;
  const appData = process.env.APPDATA ?? '';
  const localExe = appData ? path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude') : null;
  return { pkg, entry, bundledExe, localExe, adapterVersion: readVersion(pkg) };
}

export function createClaudeAdapter(rt: AcpRuntime): AgentAdapter {
  const paths = claudePaths();
  let settings: AgentSettings = { engine: 'bundled' };
  const versionCache = new Map<string, string | null>();

  const engineExe = () => (settings.engine === 'local' ? paths.localExe : paths.bundledExe);
  const engineEnv = (): Record<string, string> => (settings.engine === 'local' && paths.localExe ? { CLAUDE_CODE_EXECUTABLE: paths.localExe } : {});

  const spec: AcpAgentSpec = {
    kind: 'claude', displayName: NAME,
    launch: () => {
      if (!paths.entry || !existsSync(paths.entry)) throw agentErrors.notInstalled('claude', NAME, '找不到 claude-agent-acp，请重新安装 AI Console 的依赖');
      const exe = engineExe();
      if (!exe || !existsSync(exe)) throw agentErrors.notInstalled('claude', NAME, settings.engine === 'local' ? '找不到本机安装的 Claude Code，请改用“适配器自带”' : '找不到适配器自带的 claude.exe（安装依赖时不能使用 --omit=optional）');
      return { entry: paths.entry, args: [] };
    },
    // 声明 auth.terminal，否则 initialize 不返回 authMethods
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } },
    modeFor: (level: PermissionLevel) => (level === 'readonly' ? 'plan' : level === 'ask' ? 'default' : level === 'workspace' ? 'acceptEdits' : 'bypassPermissions'),
    modeRank: (m) => MODE_RANK[m] ?? 99,
    extensions: ['_auth/status_update'],
    dirEnvKeys: ['CLAUDE_CONFIG_DIR'],
    sessionMeta: () => structuredClone(CLAUDE_SESSION_META) as unknown as Record<string, unknown>,
    launchModel: (model) => ({ env: { ANTHROPIC_MODEL: model } }),
    onNotification: (ctx, method, params) => {
      if (method !== '_auth/status_update' || !isRecord(params)) return;
      const st = isRecord(params.authStatus) ? params.authStatus : params;
      // kind 为 none 表示未登录；只取这个字段，label 等可能含个人信息，不记录
      if (st.kind === 'none') ctx.emit({ kind: 'auth', loggedIn: false });
      else if (typeof st.kind === 'string') ctx.emit({ kind: 'auth', loggedIn: true });
    },
    authMethodsFromInit: (init) => initAuthMethods(init).map((m) => CLAUDE_AUTH_METHODS.find((x) => x.id === m.id) ?? { id: m.id, name: m.name, description: m.description, flow: 'browser' as const }),
  };

  async function engineVersion(exe: string): Promise<string | null> {
    let key = exe;
    try { key = `${exe}|${statSync(exe).mtimeMs}`; } catch { /* 用路径 */ }
    if (versionCache.has(key)) return versionCache.get(key) ?? null;
    const r = await runCli({ command: exe, args: ['--version'] }, { env: buildChildEnv({}), timeoutMs: 20_000 });
    const v = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null;
    if (v) versionCache.set(key, v);
    return v;
  }

  /** claude.exe auth status --json：只解析 loggedIn / authMethod / apiProvider，其余字段丢弃，输出不写日志 */
  async function authStatus(exe: string, env: Record<string, string>): Promise<boolean | null> {
    const r = await runCli({ command: exe, args: ['auth', 'status', '--json'] }, { env: buildChildEnv(env), timeoutMs: 20_000 });
    const m = /\{[\s\S]*\}/.exec(r.stdout);
    if (!m) return null;
    try {
      const j = JSON.parse(m[0]) as Record<string, unknown>;
      return typeof j.loggedIn === 'boolean' ? j.loggedIn : null;
    } catch { return null; }
  }

  return {
    id: 'claude', displayName: NAME, real: true,
    authMethods: ['oauth', 'apiKey', 'customEndpoint'],
    permissionLevels: ['readonly', 'ask'],
    autoProbe: true,
    launchModel: true,
    workspaceConfig: 'ignored',
    configure(s) { settings = { ...settings, ...s }; },
    experimentalProfile: () => false,

    async detect(opts = {}): Promise<DetectResult> {
      const exe = engineExe();
      const base: DetectResult = {
        installed: false, version: paths.adapterVersion, enginePath: exe, loggedIn: false, message: null,
        adapterVersion: paths.adapterVersion, engineVersion: null, engineSource: settings.engine === 'local' ? 'local' : 'bundled',
        engineLocation: settings.engine === 'local' ? '本机安装的 Claude Code' : '适配器自带', verified: false,
        authMethods: CLAUDE_AUTH_METHODS, loginCheck: 'unknown', checkedAt: Date.now(),
      };
      if (!paths.entry || !existsSync(paths.entry)) return { ...base, message: '找不到 claude-agent-acp，请重新安装 AI Console 的依赖' };
      if (!exe || !existsSync(exe)) {
        return { ...base, message: settings.engine === 'local' ? '找不到本机安装的 Claude Code（npm 全局），可以在 Agent 设置里改用“适配器自带”' : '找不到适配器自带的 claude.exe' };
      }
      const engineVer = await engineVersion(exe);
      const env = { ...(opts.env ?? {}), ...engineEnv() };
      let loggedIn: boolean | null;
      let loginCheck: DetectResult['loginCheck'] = 'cli';
      if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) { loggedIn = true; loginCheck = 'secret'; }
      else loggedIn = await authStatus(exe, env);
      if (loggedIn === null) loginCheck = 'unknown';
      return {
        ...base, installed: true, engineVersion: engineVer, loggedIn: loggedIn === true, loginCheck,
        verified: isVerified('claude', paths.adapterVersion, engineVer),
        message: loggedIn === null ? '没能判断登录状态（auth status 没有返回结果）' : loggedIn ? null : '还没有登录',
      };
    },

    async login() { throw agentErrors.unsupported(NAME, '直接登录，请使用 startLogin'); },

    buildEnv(profile: AccountProfile, secret?: string | null) {
      const env: Record<string, string> = {};
      const kind = profile.kind ?? 'subscription';
      if (kind === 'subscription') {
        if (profile.configDir === 'isolated' && profile.profileDir) env.CLAUDE_CONFIG_DIR = path.join(profile.profileDir, 'claude');
      } else if (kind === 'apiKey') {
        if (secret) env.ANTHROPIC_API_KEY = secret;
      } else {
        if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl;
        if (secret) {
          if (profile.authHeader === 'bearer') env.ANTHROPIC_AUTH_TOKEN = secret;
          else env.ANTHROPIC_API_KEY = secret;
        }
        const first = profile.models?.[0]?.id;
        if (first) env.ANTHROPIC_CUSTOM_MODEL_OPTION = first;
      }
      return env;
    },

    async listModels() { return []; },
    async listEfforts() { return null; },

    spawn(opts) { return acpSpawn(spec, rt, { ...opts, env: { ...(opts.env ?? {}), ...engineEnv(), ...CLAUDE_SCRUB_ENV } }); },
    async probeCapabilities(conn) {
      if (!conn.caps) throw agentErrors.protocol('claude', NAME, '会话没有能力信息');
      return conn.caps;
    },
    probe(opts) { return acpProbe(spec, rt, { ...opts, env: { ...opts.env, ...engineEnv(), ...CLAUDE_SCRUB_ENV } }); },
    mapPermissionLevel(level) { return { modeId: spec.modeFor(level) ?? undefined }; },

    /**
     * 订阅登录：ACP authenticate 不支持（terminal 类型），由 Gateway 以隐藏子进程运行
     * `node <adapter>/dist/index.js --cli auth login --claudeai|--console`。CLI 会打开浏览器走 OAuth。
     * 输出里只提取白名单内的授权链接推给界面，其余输出不记录（ISSUE-0007）。
     */
    startLogin(req: LoginRequest): LoginHandle {
      const flag = req.methodId === 'claude-ai-login' ? '--claudeai' : req.methodId === 'console-login' ? '--console' : null;
      if (!flag) throw agentErrors.unsupported(NAME, `这种登录方式（${req.methodId}）`);
      const launch = spec.launch({});
      const env = buildChildEnv({ ...req.env, ...engineEnv() });
      const child = spawnAgent({ entry: launch.entry!, args: ['--cli', 'auth', 'login', flag] }, { cwd: tmpdir(), env });
      if (child.pid) rt.tracker?.started({ pid: child.pid, agent: 'claude', sessionId: null, startedAt: Date.now() });
      const life = loginLifecycle(LOGIN_TIMEOUT_MS, () => { void killTree(child.pid ?? 0); });
      let urlSent = false;
      let codeAsked = false;
      let buf = '';
      req.onProgress({ state: 'started' });
      const scan = (d: Buffer) => {
        buf = (buf + d.toString('utf8')).slice(-8192);
        if (!urlSent) {
          for (const m of buf.matchAll(/https:\/\/[^\s"'<>`]+/g)) {
            const url = m[0].replace(/[).,;]+$/, '');
            if (allowedAuthUrl(url, AUTH_HOSTS)) { urlSent = true; req.onProgress({ state: 'waiting_browser', authUrl: url }); break; }
          }
        }
        if (!codeAsked && /(paste|enter)[^\n]{0,40}code|授权码/i.test(buf)) {
          codeAsked = true;
          req.onProgress({ state: 'need_code', message: '请把浏览器里显示的授权码粘贴到这里' });
        }
      };
      child.stdout.on('data', scan);
      child.stderr.on('data', scan);
      child.stdin.on('error', () => {});
      child.on('exit', async (code) => {
        if (child.pid) rt.tracker?.exited(child.pid);
        if (life.finished) return;
        if (code !== 0) { life.finish({ state: 'failed', message: `登录没有完成（退出码 ${code}）` }); return; }
        const exe = engineExe();
        const ok = exe ? await authStatus(exe, { ...req.env, ...engineEnv() }) : null;
        life.finish(ok ? { state: 'succeeded' } : { state: 'failed', message: '登录流程结束了，但仍然显示未登录' });
      });
      child.on('error', (e) => life.finish({ state: 'failed', message: e.message }));
      return {
        done: life.promise,
        cancel() { void killTree(child.pid ?? 0); life.finish({ state: 'cancelled' }); },
        submitCode(code: string) { if (!child.stdin.destroyed) child.stdin.write(`${code.trim()}\n`); },
      };
    },
  };
}
