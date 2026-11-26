// ZCode（智谱）适配器：通过精确锁定版本的开源桥接器 `zcode-acp-server`（Apache-2.0）驱动本机 ZCode 内置引擎（phase-1.md 第 14 节，ISSUE-0020）。
// 安全边界：
// 1. 不读取 ~/.zcode 下的任何凭据或配置文件；登录状态仅通过 ACP session/new 返回的可用服务状态判断。
// 2. 强制用当前 Node 进程启动桥接器（ZCODE_ACP_RUNTIME=node），关闭远程 hub（ZCODE_ACP_REMOTE=0）与自动挂机续跑（ZCODE_ACP_QUOTA_AUTO_RESUME=0）。
// 3. 强制覆盖桥接器默认的 yolo 全自动模式：只读映射为 plan，需审批映射为 build（文件修改与命令执行均须请求工作台审批；注意 ZCode 的 guarded 具有 yolo 自动写文件语义，仅拦截高危 shell，故归入更宽松档位）。
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PermissionLevel } from '@aic/protocol';
import { AcpConnection } from '../acp/connection';
import { agentErrors, isAuthError } from '../acp/errors';
import { buildNativeEnv, guardStdio, killTree, runCli } from '../acp/launch';
import { acpProbe, acpSpawn, agentEnv, type AcpAgentSpec, type AcpRuntime } from '../acp/session';
import { initAuthMethods, nativeAccountEnv, pkgDirOf, readVersion, resolveFrom } from '../common';
import { redact } from '../redact';
import type { AgentAdapter, AuthMethodInfo, DetectResult } from '../types';
import { isRecord, str } from '../util';
import { isVerified } from '../verified';

const NAME = 'ZCode';
const LOGIN_CACHE_MS = 10 * 60_000;
/** 保留旧常量导出以兼容既有引用 */
export const ZCODE_BRIDGE_PENDING = '已找到 ZCode，但它用自家的通信协议，工作台还不能和它对话。协议桥接会在后续步骤提供（design.md 6.5）';
const NOT_FOUND = '没有找到 ZCode。安装 ZCode 桌面端后点 [重新检测]';
const BRIDGE_NOT_FOUND = '找不到 zcode-acp-server，请重新安装 AI Console 的依赖';
const NOT_LOGGED_IN = '还没有登录或未启用模型服务：请在 ZCode 桌面端完成登录，然后点 [重新检测]';

const MODE_RANK: Record<string, number> = {
  plan: 0,
  build: 1,
  edit: 2,
  guarded: 3,
  auto: 4,
  yolo: 5,
};

export const ZCODE_AUTH_METHODS: AuthMethodInfo[] = [
  { id: 'zcode-credentials', name: '在 ZCode 桌面端登录', description: '沿用 ZCode 桌面端已登录的智谱 / Coding Plan 账号', flow: 'external_app' },
];

/** 引擎位置：%LOCALAPPDATA%\Programs\ZCode\resources\glm\zcode.cjs（或 macOS 应用包）；override 用于测试 */
export function findZcode(override?: string | null): string | null {
  if (override) return existsSync(override) ? override : null;
  if (process.platform === 'win32') {
    const cands: string[] = [];
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    return cands.find((c) => existsSync(c)) ?? null;
  }
  if (process.platform === 'darwin') {
    const mac = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
    return existsSync(mac) ? mac : null;
  }
  return null;
}

export function zcodeBridgePaths() {
  const pkg = resolveFrom('zcode-acp-server/package.json');
  const dir = pkgDirOf(pkg);
  const entry = dir ? path.join(dir, 'dist', 'index.js') : null;
  return { pkg, entry, adapterVersion: readVersion(pkg) };
}

/** 受控桥接环境变量：固定 Node 运行时、隔离桥接外部用户配置、禁远程端口、禁默认 yolo */
export function zcodeBridgeEnv(zcodeJs: string, mode: string): Record<string, string> {
  // zcode-acp-server 的 ~/.config/zcode-acp/config.json 优先级高于环境变量；
  // 将 XDG_CONFIG_HOME 指向工作台受控空目录（不影响底层 zcode.cjs 读取 ~/.zcode 原生凭据），防止外部配置文件重新开启 remote 或 yolo。
  const emptyXdg = path.join(tmpdir(), 'aic-zcode-xdg-empty');
  try { mkdirSync(emptyXdg, { recursive: true }); } catch { /* 忽略 */ }
  return {
    XDG_CONFIG_HOME: emptyXdg,
    ZCODE_BIN: zcodeJs,
    ZCODE_NODE: process.execPath,
    ZCODE_ACP_RUNTIME: 'node',
    ZCODE_ACP_REMOTE: '0',
    ZCODE_ACP_QUOTA_AUTO_RESUME: '0',
    ZCODE_ACP_SHOW_COMPLETION_STATUS: '0',
    ZCODE_ACP_LANG: 'zh',
    ZCODE_ACP_MODE: mode,
  };
}

export interface ZcodeOptions extends Partial<AcpRuntime> {
  enginePath?: string | null;
  /** 测试时覆盖桥接入口（例如指向 fake-acp-agent.mjs） */
  bridgeEntry?: string | null;
}

/** 启动底层 app-server 等首条 JSON 消息（保留供诊断与单测调用） */
export function pingAppServer(js: string, timeoutMs = 15_000): Promise<{ ok: boolean; firstMethod: string | null; detail: string | null }> {
  return new Promise((resolve) => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'aic-zcode-'));
    const done = (r: { ok: boolean; firstMethod: string | null; detail: string | null }) => {
      clearTimeout(timer);
      void killTree(child.pid ?? 0).finally(() => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* 忽略 */ } });
      resolve(r);
    };
    const child = spawn(process.execPath, [js, 'app-server'], { cwd, env: buildNativeEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    guardStdio(child);
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

/** 从 session/new 的返回判断 ZCode 桌面端是否已有可用登录凭据（不读 ~/.zcode 文件） */
function hasSelectableProvider(resp: unknown): boolean | null {
  if (!isRecord(resp) || !Array.isArray(resp.configOptions)) return null;
  const modelOpt = resp.configOptions.find((c) => isRecord(c) && c.category === 'model') as Record<string, unknown> | undefined;
  if (!modelOpt) return null;
  const meta = isRecord(modelOpt._meta) && isRecord(modelOpt._meta.zcode) ? modelOpt._meta.zcode : null;
  if (meta && Array.isArray(meta.providers)) {
    return meta.providers.some((p) => isRecord(p) && p.selectable === true);
  }
  return Array.isArray(modelOpt.options) ? modelOpt.options.length > 0 : null;
}

export function createZcodeAdapter(o: ZcodeOptions = {}): AgentAdapter {
  const rt: AcpRuntime = { log: o.log ?? (() => {}), ...(o.tracker ? { tracker: o.tracker } : {}), ...(o.timeouts ? { timeouts: o.timeouts } : {}) };
  const bridge = zcodeBridgePaths();
  const versionCache = new Map<string, string | null>();
  const loginCache = new Map<string, { at: number; loggedIn: boolean | null }>();

  const bridgeEntry = () => o.bridgeEntry ?? bridge.entry;

  const spec: AcpAgentSpec = {
    kind: 'zcode',
    displayName: NAME,
    usesNativeConfig: true,
    launch: () => {
      const js = findZcode(o.enginePath);
      if (!js) throw agentErrors.notInstalled('zcode', NAME, NOT_FOUND);
      const entry = bridgeEntry();
      if (!entry || !existsSync(entry)) throw agentErrors.notInstalled('zcode', NAME, BRIDGE_NOT_FOUND);
      return { entry, args: [] };
    },
    modeFor: (level: PermissionLevel) => (level === 'readonly' ? 'plan' : level === 'ask' ? 'build' : level === 'workspace' ? 'edit' : 'yolo'),
    modeRank: (m) => MODE_RANK[m] ?? 99,
    extensions: ['_zcode/turnState'],
    dirEnvKeys: ['ZCODE_HOME'],
    onNotification: (ctx, method) => {
      if (method.startsWith('_zcode/')) ctx.log('debug', `[agent:zcode] 私有通知 ${method}`);
    },
    authMethodsFromInit: (init) => initAuthMethods(init).map((m) => ZCODE_AUTH_METHODS.find((x) => x.id === m.id) ?? {
      id: m.id, name: m.name, description: m.description, flow: 'external_app' as const,
    }),
  };

  async function readEngineVersion(js: string): Promise<string | null> {
    let key = js;
    try { key = `${js}|${statSync(js).mtimeMs}`; } catch { /* 用路径 */ }
    if (versionCache.has(key)) return versionCache.get(key) ?? null;
    const r = await runCli({ entry: js, args: ['--version'] }, { env: buildNativeEnv(), timeoutMs: 20_000 });
    const v = /\d+\.\d+\.\d+/.exec(r.stdout)?.[0] ?? null;
    if (v) versionCache.set(key, v);
    return v;
  }

  async function checkLogin(js: string, env: Record<string, string>, secrets: string[]): Promise<boolean | null> {
    const full = agentEnv(spec, { ...env, ...zcodeBridgeEnv(js, 'plan') });
    let conn: AcpConnection | null = null;
    try {
      conn = await AcpConnection.start({
        kind: 'zcode', displayName: NAME, launch: spec.launch(full), cwd: tmpdir(), env: full, redact: secrets, log: rt.log, label: 'detect',
        ...(rt.tracker ? { tracker: rt.tracker } : {}),
        timeouts: { ...rt.timeouts, initialize: Math.min(rt.timeouts?.initialize ?? 30_000, 30_000) },
      });
      const resp = await conn.request<Record<string, unknown>>('session/new', { cwd: tmpdir(), mcpServers: [] }, conn.timeouts.session, 'session');
      return hasSelectableProvider(resp);
    } catch (e) {
      if (isAuthError(e)) return false;
      rt.log('warn', `[agent:zcode] 检查登录状态失败：${redact(e instanceof Error ? e.message : String(e), secrets)}`);
      return null;
    } finally {
      await conn?.close().catch(() => {});
    }
  }

  return {
    id: 'zcode',
    displayName: NAME,
    real: true,
    usesNativeConfig: true,
    authMethods: [],
    permissionLevels: ['readonly', 'ask'] satisfies PermissionLevel[],
    autoProbe: false,
    launchModel: false,
    workspaceConfig: 'trusted_only',
    experimentalProfile: () => false,
    sessionStore: () => 'shared',

    async detect(opts = {}): Promise<DetectResult> {
      const js = findZcode(o.enginePath);
      const entry = bridgeEntry();
      const adapterVer = o.bridgeEntry ? '0.94.0' : bridge.adapterVersion;
      const base: DetectResult = {
        installed: false, version: adapterVer, enginePath: js, loggedIn: false, message: null,
        adapterVersion: adapterVer, engineVersion: null, engineSource: 'app', engineLocation: 'ZCode 内置引擎（经 zcode-acp 桥接）',
        verified: false, authMethods: ZCODE_AUTH_METHODS, loginCheck: 'unknown', checkedAt: Date.now(),
      };
      if (!js) return { ...base, message: NOT_FOUND };
      if (!entry || !existsSync(entry)) return { ...base, message: BRIDGE_NOT_FOUND };
      const engineVer = await readEngineVersion(js).catch(() => null);
      const verified = isVerified('zcode', adapterVer, engineVer);
      const env = opts.env ?? {};
      const cacheKey = `${js}|${adapterVer ?? ''}|${engineVer ?? ''}`;
      const cached = loginCache.get(cacheKey);
      let loggedIn: boolean | null;
      if (!opts.force && cached && Date.now() - cached.at < LOGIN_CACHE_MS) loggedIn = cached.loggedIn;
      else {
        loggedIn = await checkLogin(js, env, opts.redact ?? []);
        loginCache.set(cacheKey, { at: Date.now(), loggedIn });
      }
      return {
        ...base,
        installed: true,
        version: engineVer ?? adapterVer,
        engineVersion: engineVer,
        verified,
        loggedIn: loggedIn === true,
        loginCheck: loggedIn === null ? 'unknown' : 'acp',
        message: loggedIn === null ? '没能判断登录状态' : loggedIn ? null : NOT_LOGGED_IN,
      };
    },

    async login() { throw agentErrors.unsupported(NAME, '在工作台里登录（请在 ZCode 桌面端登录）'); },
    buildEnv: nativeAccountEnv,
    async listModels() { return []; },
    async listEfforts() { return null; },

    spawn(opts) {
      const js = findZcode(o.enginePath);
      const mode = spec.modeFor(opts.permission) ?? 'build';
      const extra = js ? zcodeBridgeEnv(js, mode) : {};
      return acpSpawn(spec, rt, { ...opts, env: { ...(opts.env ?? {}), ...extra } });
    },
    async probeCapabilities(conn) {
      if (!conn.caps) throw agentErrors.protocol('zcode', NAME, '会话没有能力信息');
      return conn.caps;
    },
    probe(opts) {
      const js = findZcode(o.enginePath);
      const extra = js ? zcodeBridgeEnv(js, 'plan') : {};
      return acpProbe(spec, rt, { ...opts, env: { ...opts.env, ...extra } });
    },
    mapPermissionLevel(level) { return { modeId: spec.modeFor(level) ?? undefined }; },
  };
}
