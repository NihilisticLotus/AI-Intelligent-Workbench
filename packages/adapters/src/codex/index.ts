// Codex：经 @agentclientprotocol/codex-acp 2.5.0 接入（phase-1.md 6.3）。
// 只用适配器自带的 codex（0.165），不设 CODEX_PATH：本机全局 0.120 读不了当前的 ~/.codex/config.toml（ISSUE-0009）。
// 两者共用 CODEX_HOME（默认 ~/.codex），登录态相同。我们不读这个目录里的任何文件。
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PermissionLevel } from '@aic/protocol';
import { agentErrors } from '../acp/errors';
import { buildNativeEnv, runCli } from '../acp/launch';
import { acpProbe, acpSpawn, type AcpAgentSpec, type AcpRuntime } from '../acp/session';
import { initAuthMethods, nativeAccountEnv, pkgDirOf, readVersion, resolveFrom } from '../common';
import type { AgentAdapter, AuthMethodInfo, DetectResult } from '../types';
import { isVerified } from '../verified';

const NAME = 'Codex';
const MODE_RANK: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, agent: 2, 'agent-full-access': 3 };

export const CODEX_AUTH_METHODS: AuthMethodInfo[] = [
  { id: 'chat-gpt', name: 'ChatGPT 登录', description: '用 ChatGPT 账号登录（会在这台电脑上打开浏览器）', flow: 'browser' },
  { id: 'api-key', name: '官方 API Key', description: '在账号里填写 OpenAI API Key', flow: 'apiKey' },
];

/** 只改变会话模型，保留软件已配置的 provider；配置损坏时停止，不换用默认服务。 */
export function codexModelEnv(model: string, env: Record<string, string>): Record<string, string> {
  let cfg: unknown = {};
  try { cfg = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) : {}; } catch { throw agentErrors.protocol('codex', NAME, '软件的会话配置无法解析，请在 Codex 中检查配置'); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw agentErrors.protocol('codex', NAME, '软件的会话配置必须是对象，请在 Codex 中检查配置');
  return { CODEX_CONFIG: JSON.stringify({ ...cfg, model }) };
}

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
    kind: 'codex', displayName: NAME, usesNativeConfig: true,
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
    launchModel: (model, env) => ({ env: codexModelEnv(model, env) }),
    authMethodsFromInit: (init) => initAuthMethods(init)
      .filter((m) => m.id === 'chat-gpt' || m.id === 'api-key')
      .map((m) => CODEX_AUTH_METHODS.find((x) => x.id === m.id)!),
  };

  return {
    id: 'codex', displayName: NAME, real: true, usesNativeConfig: true,
    authMethods: [],
    permissionLevels: ['readonly', 'ask'],
    // 不自动探测：会拉起用户全部全局 MCP（phase-1.md 6.3.2）
    autoProbe: false,
    launchModel: true,
    // Codex 只在用户自己标记为信任的项目里读取项目的 .codex 配置
    workspaceConfig: 'trusted_only',
    experimentalProfile: () => false,
    sessionStore: () => 'shared',

    async detect(opts = {}): Promise<DetectResult> {
      const base: DetectResult = {
        installed: false, version: paths.adapterVersion, enginePath: paths.codexJs, loggedIn: false, message: null,
        adapterVersion: paths.adapterVersion, engineVersion: paths.engineVersion, engineSource: 'bundled', engineLocation: '适配器自带',
        verified: isVerified('codex', paths.adapterVersion, paths.engineVersion), authMethods: CODEX_AUTH_METHODS, loginCheck: 'unknown', checkedAt: Date.now(),
      };
      if (!paths.entry || !existsSync(paths.entry)) return { ...base, message: '找不到 codex-acp，请重新安装 AI Console 的依赖' };
      if (!paths.codexJs || !existsSync(paths.codexJs)) return { ...base, message: '找不到适配器自带的 codex' };
      const env = opts.env ?? {};
      // node codex.js login status：只用正则判断是否已登录，输出不写日志
      const r = await runCli({ entry: paths.codexJs, args: ['login', 'status'] }, { env: buildNativeEnv(env), timeoutMs: 30_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      const loggedIn = /^\s*Logged in using (ChatGPT|an API key)/im.test(out);
      const known = loggedIn || /not logged in/i.test(out);
      return {
        ...base, installed: true, loggedIn, loginCheck: known ? 'cli' : 'unknown',
        message: loggedIn ? null : known ? '还没有登录' : r.timedOut ? '检查登录状态超时' : '没能判断登录状态',
      };
    },

    async login() { throw agentErrors.unsupported(NAME, '在工作台里登录，请在 Codex 中完成登录'); },

    buildEnv: nativeAccountEnv,

    async listModels() { return []; },
    async listEfforts() { return null; },

    spawn(opts) { return acpSpawn(spec, rt, opts); },
    async probeCapabilities(conn) {
      if (!conn.caps) throw agentErrors.protocol('codex', NAME, '会话没有能力信息');
      return conn.caps;
    },
    probe(opts) { return acpProbe(spec, rt, opts); },
    mapPermissionLevel(level) { return { modeId: spec.modeFor(level) ?? undefined }; },
  };
}
