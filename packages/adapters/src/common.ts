// 适配器共用：包路径解析、版本读取、基于 ACP authenticate 的登录流程。
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ErrorCode, type AgentKind } from '@aic/protocol';
import { AcpConnection } from './acp/connection';
import { classifyError } from './acp/errors';
import { agentEnv, type AcpAgentSpec, type AcpRuntime } from './acp/session';
import { AgentError, type AccountProfile, type LoginHandle, type LoginRequest } from './types';
import { isRecord } from './util';

const req = createRequire(import.meta.url);

/** 原生 Agent 的认证归软件自己管理，兼容保留 buildEnv 接口但不注入工作台账号。 */
export function nativeAccountEnv(profile: AccountProfile, secret?: string | null): Record<string, string> {
  if ((profile.kind ?? 'subscription') !== 'subscription' || profile.configDir === 'isolated' || secret) {
    throw new AgentError({ code: ErrorCode.AgentNativeConfiguration, message: '这个 Agent 使用软件自身的配置与登录', hint: '自定义 API 请配置给 AI Console 独立 Agent；旧测试账号已停止使用', actions: [] }, 'unsupported');
  }
  return {};
}

/** 解析某个包里的文件；from：从哪个包的位置开始解析（处理嵌套依赖） */
export function resolveFrom(spec: string, from?: string): string | null {
  try {
    const r = from ? createRequire(from) : req;
    return r.resolve(spec);
  } catch { return null; }
}

export function readVersion(pkgJson: string | null): string | null {
  if (!pkgJson || !existsSync(pkgJson)) return null;
  try {
    const v = (JSON.parse(readFileSync(pkgJson, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch { return null; }
}

/** 授权链接白名单：只推 https、并且主机在列表里的链接 */
export function allowedAuthUrl(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return hosts.some((x) => h === x || h.endsWith(`.${x}`));
  } catch { return false; }
}

/** 登录流程的公共部分：超时、取消、只结束一次 */
export function loginLifecycle(timeoutMs: number, onCancel: () => void) {
  let settle!: (r: { state: 'succeeded' | 'failed' | 'cancelled'; message?: string }) => void;
  let done = false;
  const promise = new Promise<{ state: 'succeeded' | 'failed' | 'cancelled'; message?: string }>((r) => { settle = r; });
  const finish = (r: { state: 'succeeded' | 'failed' | 'cancelled'; message?: string }) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    settle(r);
  };
  const timer = setTimeout(() => { onCancel(); finish({ state: 'failed', message: '登录超时（10 分钟内没有完成）' }); }, timeoutMs);
  timer.unref?.();
  return { promise, finish, get finished() { return done; } };
}

export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/**
 * 基于 ACP authenticate 的登录（Codex 的 chat-gpt、CodeBuddy 的 external / internal / iOA）。
 * Agent 自己打开系统浏览器；有授权链接通知时（CodeBuddy 的 _codebuddy.ai/authUrl）转给界面。
 */
export function acpAuthenticateLogin(spec: AcpAgentSpec, rt: AcpRuntime, req: LoginRequest, opts: {
  authUrlMethod?: string; authUrlHosts?: string[];
  /** authenticate 返回后判断是否成功 */
  verify?: (resp: unknown) => boolean;
}): LoginHandle {
  let conn: AcpConnection | null = null;
  let cancelled = false;
  const life = loginLifecycle(LOGIN_TIMEOUT_MS, () => { void conn?.kill(); });
  req.onProgress({ state: 'started' });
  void (async () => {
    try {
      const env = agentEnv(spec, req.env);
      conn = await AcpConnection.start({
        kind: spec.kind, displayName: spec.displayName, launch: spec.launch(env), cwd: tmpdir(), env, log: rt.log, label: 'login',
        ...(rt.tracker ? { tracker: rt.tracker } : {}), ...(rt.timeouts ? { timeouts: rt.timeouts } : {}),
        ...(spec.clientCapabilities ? { clientCapabilities: spec.clientCapabilities } : {}),
        onNotification: (method, params) => {
          if (opts.authUrlMethod && method === opts.authUrlMethod && isRecord(params) && typeof params.authUrl === 'string') {
            if (allowedAuthUrl(params.authUrl, opts.authUrlHosts ?? [])) req.onProgress({ state: 'waiting_browser', authUrl: params.authUrl });
            else rt.log('warn', `[agent:${spec.kind}] 授权链接不在白名单里，没有推给界面`);
          }
        },
      });
      if (cancelled) { await conn.kill(); return; }
      if (!opts.authUrlMethod) req.onProgress({ state: 'waiting_browser', message: '已在这台电脑的浏览器里打开授权页面' });
      const resp = await conn.request('authenticate', { methodId: req.methodId }, LOGIN_TIMEOUT_MS);
      const ok = opts.verify ? opts.verify(resp) : true;
      life.finish(ok ? { state: 'succeeded' } : { state: 'failed', message: '登录没有完成' });
    } catch (e) {
      if (cancelled) life.finish({ state: 'cancelled' });
      else life.finish({ state: 'failed', message: classifyError(e, spec.kind, spec.displayName).body.message });
    } finally {
      await conn?.close().catch(() => {});
    }
  })();
  return {
    done: life.promise,
    cancel() { cancelled = true; void conn?.kill(); life.finish({ state: 'cancelled' }); },
  };
}

/** initialize 的 authMethods → 归一化（id 原样保留，名称由各适配器翻译） */
export function initAuthMethods(init: Record<string, unknown>): { id: string; name: string; description: string | null; type: string | null }[] {
  const list = Array.isArray(init.authMethods) ? init.authMethods.filter(isRecord) : [];
  return list.map((m) => ({
    id: String(m.id ?? ''), name: String(m.name ?? m.id ?? ''),
    description: typeof m.description === 'string' ? m.description : null,
    type: typeof m.type === 'string' ? m.type : null,
  })).filter((m) => m.id);
}

export const pkgDirOf = (file: string | null) => (file ? path.dirname(file) : null);
export type { AgentKind };
