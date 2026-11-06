// Codex：经 @agentclientprotocol/codex-acp 2.5.0 接入（phase-1.md 6.3）。
// 只用适配器自带的 codex（0.165），不设 CODEX_PATH：本机全局 0.120 读不了当前的 ~/.codex/config.toml（ISSUE-0009）。
// 两者共用 CODEX_HOME（默认 ~/.codex），登录态相同。我们不读这个目录里的任何文件。
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PermissionLevel } from '@aic/protocol';
import { agentErrors } from '../acp/errors';
import { buildChildEnv, runCli } from '../acp/launch';
import { acpProbe, acpSpawn, type AcpAgentSpec, type AcpRuntime } from '../acp/session';
import { acpAuthenticateLogin, initAuthMethods, pkgDirOf, readVersion, resolveFrom } from '../common';
import type { AccountProfile, AgentAdapter, AuthMethodInfo, DetectResult, LoginRequest } from '../types';
import { isVerified } from '../verified';

const NAME = 'Codex';
const MODE_RANK: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, agent: 2, 'agent-full-access': 3 };
/** 官方地址（API Key 账号用） */
const OPENAI_BASE = 'https://api.openai.com/v1';
/** API Key 账号：provider 从这个环境变量读密钥，密钥不落盘 */
export const CODEX_KEY_ENV = 'AIC_PROVIDER_KEY';

export const CODEX_AUTH_METHODS: AuthMethodInfo[] = [
  { id: 'chat-gpt', name: 'ChatGPT 登录', description: '用 ChatGPT 账号登录（会在这台电脑上打开浏览器）', flow: 'browser' },
  { id: 'api-key', name: '官方 API Key', description: '在账号里填写 OpenAI API Key', flow: 'apiKey' },
];

export function codexPaths() {
  const pkg = resolveFrom('@agentclientprotocol/codex-acp/package.json');
  const dir = pkgDirOf(pkg);
  const entry = dir ? path.join(dir, 'dist', 'index.js') : null;
  const codexJs = pkg ? resolveFrom('@openai/codex/bin/codex.js', pkg) : null;
  const codexPkg = pkg ? resolveFrom('@openai/codex/package.json', pkg) : null;
  return { pkg, entry, codexJs, adapterVersion: readVersion(pkg), engineVersion: readVersion(codexPkg) };
}

export function createCodexAdapter(rt: AcpRuntime): AgentAdapter {
  const paths = codexPaths();
  const spec: AcpAgentSpec = {
    kind: 'codex', displayName: NAME,
    launch: () => {
      if (!paths.entry || !existsSync(paths.entry)) throw agentErrors.notInstalled('codex', NAME, '找不到 codex-acp，请重新安装 AI Console 的依赖');
      if (!paths.codexJs || !existsSync(paths.codexJs)) throw agentErrors.notInstalled('codex', NAME, '找不到适配器自带的 codex');
      return { entry: paths.entry, args: [] };
    },
    // “需审批”映射到 read-only：on-request，写文件和越出沙箱的命令都要申请（workspace-write 下工作区内的修改不会询问）
    modeFor: (level: PermissionLevel) => (level === 'readonly' || level === 'ask' ? 'read-only' : level === 'workspace' ? 'workspace-write' : 'agent-full-access'),
    modeRank: (m) => MODE_RANK[m] ?? 99,
    extensions: [],
    dirEnvKeys: ['CODEX_HOME'],
    // H1：模型并进 CODEX_CONFIG（codex-acp 启动时读取的会话配置）
    launchModel: (model, env) => {
      let cfg: Record<string, unknown> = {};
      try { cfg = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) as Record<string, unknown> : {}; } catch { cfg = {}; }
      return { env: { CODEX_CONFIG: JSON.stringify({ ...cfg, model }) } };
    },
    authMethodsFromInit: (init) => initAuthMethods(init)
      .filter((m) => m.id === 'chat-gpt' || m.id === 'api-key')
      .map((m) => CODEX_AUTH_METHODS.find((x) => x.id === m.id)!),
  };

  return {
    id: 'codex', displayName: NAME, real: true,
    authMethods: ['oauth', 'apiKey', 'customEndpoint'],
    permissionLevels: ['readonly', 'ask'],
    // 不自动探测：会拉起用户全部全局 MCP（phase-1.md 6.3.2）
    autoProbe: false,
    launchModel: true,
    // Codex 只在用户自己标记为信任的项目里读取项目的 .codex 配置
    workspaceConfig: 'trusted_only',
    experimentalProfile: () => false,
    // API Key / 自定义地址的账号总是用自己的 CODEX_HOME（见 buildEnv），会话也存在那里
    sessionStore: (p) => (p.kind === 'subscription' && p.configDir === 'shared' ? 'shared' : `profile:${p.id}`),

    async detect(opts = {}): Promise<DetectResult> {
      const base: DetectResult = {
        installed: false, version: paths.adapterVersion, enginePath: paths.codexJs, loggedIn: false, message: null,
        adapterVersion: paths.adapterVersion, engineVersion: paths.engineVersion, engineSource: 'bundled', engineLocation: '适配器自带',
        verified: isVerified('codex', paths.adapterVersion, paths.engineVersion), authMethods: CODEX_AUTH_METHODS, loginCheck: 'unknown', checkedAt: Date.now(),
      };
      if (!paths.entry || !existsSync(paths.entry)) return { ...base, message: '找不到 codex-acp，请重新安装 AI Console 的依赖' };
      if (!paths.codexJs || !existsSync(paths.codexJs)) return { ...base, message: '找不到适配器自带的 codex' };
      const env = opts.env ?? {};
      if (env[CODEX_KEY_ENV]) return { ...base, installed: true, loggedIn: true, loginCheck: 'secret' };
      // node codex.js login status：只用正则判断是否已登录，输出不写日志
      const r = await runCli({ entry: paths.codexJs, args: ['login', 'status'] }, { env: buildChildEnv(env), timeoutMs: 30_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      const loggedIn = /^\s*Logged in using (ChatGPT|an API key)/im.test(out);
      const known = loggedIn || /not logged in/i.test(out);
      return {
        ...base, installed: true, loggedIn, loginCheck: known ? 'cli' : 'unknown',
        message: loggedIn ? null : known ? '还没有登录' : r.timedOut ? '检查登录状态超时' : '没能判断登录状态',
      };
    },

    async login() { throw agentErrors.unsupported(NAME, '直接登录，请使用 startLogin'); },

    buildEnv(profile: AccountProfile, secret?: string | null) {
      const env: Record<string, string> = {};
      const kind = profile.kind ?? 'subscription';
      const home = profile.profileDir ? path.join(profile.profileDir, 'codex') : null;
      if (kind === 'subscription') {
        if (profile.configDir === 'isolated' && home) env.CODEX_HOME = home;
        return env;
      }
      // API Key / 自定义地址：独立的 CODEX_HOME + 会话级 provider，密钥经环境变量传入（6.4.2，待实测）
      if (home) env.CODEX_HOME = home;
      const provider: Record<string, unknown> = {
        name: 'AI Console', base_url: kind === 'apiKey' ? OPENAI_BASE : profile.baseUrl ?? OPENAI_BASE,
        env_key: CODEX_KEY_ENV, wire_api: profile.wireApi ?? 'responses',
      };
      const cfg: Record<string, unknown> = { model_provider: 'aic', model_providers: { aic: provider } };
      const first = profile.models?.[0]?.id;
      if (kind === 'customEndpoint' && first) cfg.model = first;
      env.CODEX_CONFIG = JSON.stringify(cfg);
      if (secret) env[CODEX_KEY_ENV] = secret;
      return env;
    },

    async listModels() { return []; },
    async listEfforts() { return null; },

    spawn(opts) { return acpSpawn(spec, rt, opts); },
    async probeCapabilities(conn) {
      if (!conn.caps) throw agentErrors.protocol('codex', NAME, '会话没有能力信息');
      return conn.caps;
    },
    probe(opts) { return acpProbe(spec, rt, opts); },
    mapPermissionLevel(level) { return { modeId: spec.modeFor(level) ?? undefined }; },

    /** chat-gpt：ACP authenticate。适配器先检查现有登录，有效就直接返回；否则在这台电脑的浏览器里打开授权页 */
    startLogin(req: LoginRequest) {
      if (req.methodId !== 'chat-gpt') throw agentErrors.unsupported(NAME, `这种登录方式（${req.methodId}），API Key 请在账号里添加`);
      return acpAuthenticateLogin(spec, rt, req, {});
    },
  };
}
