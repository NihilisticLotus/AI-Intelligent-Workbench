// Agent 服务：检测结果缓存、能力缓存（agent_caps）、登录流程、测试连接、并发上限（phase-1.md 6.2.4、6.3、6.5.1、6.6.2）。
// GET /agents 只读缓存；探测只在 Gateway 启动、[重新检测]、登录完成、测试连接时执行。
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  WORKBUDDY_APP_METHOD, type AgentAdapter, type AgentCaps as AdapterCaps, type DetectResult, type LoginHandle, type SessionConfigState,
} from '@aic/adapters';
import {
  ErrorActionKey, ErrorCode, type AgentCaps, type AgentInfo, type AgentKind, type AgentLoginBody, type AgentTestResult, type ModelInfo, type PatchAgentBody,
} from '@aic/protocol';
import type { Db } from '../db';
import type { EventStore } from '../events';
import type { ProfileRow, ProfileService } from '../profiles';
import { AbortError, Errors, newId, now } from '../util';
import type { AgentRegistry } from './registry';

const DEFAULT_LIMIT = 2;
const STALE_MS = 24 * 3600_000;

interface AgentSettingsRow { concurrencyLimit?: number; engine?: 'bundled' | 'local'; defaultModel?: string | null; defaultEffort?: string | null }
interface Catalog { models: ModelInfo[]; efforts: string[] | null; modes: { id: string; name: string }[] }
type CapsRow = { agent: string; profile_id: string; adapter_version: string | null; engine_version: string | null; caps_json: string | null; catalog_json: string | null; probed_at: number };

interface LoginRec { id: string; kind: AgentKind; profileId: string; handle: LoginHandle; done: boolean }

export interface AgentServiceOptions {
  dataDir: string;
  log: (msg: string) => void;
  audit(deviceId: string | null, action: string, detail: string): void;
}

export class AgentService {
  private detected = new Map<AgentKind, DetectResult & { error?: string }>();
  private detecting = new Map<AgentKind, Promise<DetectResult>>();
  private staticCatalog = new Map<AgentKind, Catalog>();
  private profileLogin = new Map<string, boolean | null>();
  private running = new Map<AgentKind, number>();
  private queues = new Map<AgentKind, (() => void)[]>();
  private logins = new Map<string, LoginRec>();
  private probing = new Map<AgentKind, Promise<void>>();
  profiles!: ProfileService;

  constructor(private db: Db, private events: EventStore, private registry: AgentRegistry, private o: AgentServiceOptions) {}

  attach(profiles: ProfileService) {
    this.profiles = profiles;
    for (const a of this.registry.all()) {
      const s = this.settings(a.id);
      if (s.engine) a.configure?.({ engine: s.engine });
    }
  }

  adapter(kind: AgentKind): AgentAdapter | undefined { return this.registry.get(kind); }

  // ---------- 设置 ----------

  private allSettings(): Partial<Record<AgentKind, AgentSettingsRow>> {
    const v = this.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'agent_settings'")?.value;
    try { return v ? JSON.parse(v) : {}; } catch { return {}; }
  }
  settings(kind: AgentKind): AgentSettingsRow { return this.allSettings()[kind] ?? {}; }
  private saveSettings(kind: AgentKind, s: AgentSettingsRow) {
    const all = { ...this.allSettings(), [kind]: s };
    this.db.run("INSERT INTO meta (key, value) VALUES ('agent_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(all));
  }
  concurrencyLimit(kind: AgentKind) { return this.settings(kind).concurrencyLimit ?? DEFAULT_LIMIT; }

  // ---------- 检测 ----------

  /** 检测一个 Agent（用默认账号的环境变量）。force：跳过适配器内部缓存 */
  detect(kind: AgentKind, force = false): Promise<DetectResult> {
    const inflight = this.detecting.get(kind);
    if (inflight && !force) return inflight;
    const p = this.doDetect(kind, force).finally(() => { if (this.detecting.get(kind) === p) this.detecting.delete(kind); });
    this.detecting.set(kind, p);
    return p;
  }

  private async doDetect(kind: AgentKind, force: boolean): Promise<DetectResult> {
    const a = this.registry.get(kind);
    if (!a) throw Errors.agentUnavailable('这个 Agent 暂不可用');
    let d: DetectResult & { error?: string };
    try {
      if (a.real) {
        const def = this.profiles.defaultRow(kind);
        let env: Record<string, string> = {};
        let redact: string[] = [];
        try { ({ env, redact } = await this.profiles.envFor(a, def)); } catch (e) {
          this.o.log(`[agents] ${a.displayName} 默认账号的密钥读不出来：${(e as Error).message}`);
        }
        d = await a.detect({ force, env, redact, profile: this.profiles.account(def) });
        this.profileLogin.set(def.id, d.loginCheck === 'unknown' ? null : d.loggedIn);
        this.invalidateIfVersionChanged(kind, d);
      } else {
        d = await a.detect({ force });
        this.staticCatalog.set(kind, { models: await a.listModels(), efforts: await a.listEfforts(), modes: [] });
      }
    } catch (e) {
      d = { installed: false, version: null, enginePath: null, loggedIn: false, message: `检测出错：${(e as Error).message}`, error: String((e as Error).message), checkedAt: now() };
    }
    this.detected.set(kind, d);
    return d;
  }

  /** 已有检测结果就直接用（不重复探测） */
  async ensureDetected(kind: AgentKind): Promise<DetectResult> {
    return this.detected.get(kind) ?? this.detect(kind);
  }

  /** Gateway 启动时：检测全部 Agent，并为支持自动探测的 Agent（Claude）补齐能力缓存 */
  async startup() {
    await Promise.all(this.registry.all().map(async (a) => {
      await this.detect(a.id).catch(() => {});
      this.pushStatus(a.id);
      void this.autoProbe(a.id);
    }));
  }

  async redetect(): Promise<AgentInfo[]> {
    await Promise.all(this.registry.all().map(async (a) => {
      if (a.real) this.db.run('DELETE FROM agent_caps WHERE agent = ?', a.id);
      await this.detect(a.id, true).catch(() => {});
      this.pushStatus(a.id);
      // [重新检测] 对已登录的 Agent 都做一次探测会话（phase-1.md 6.3：Codex、CodeBuddy 只在这里、测试连接和首次会话时探测）
      void this.autoProbe(a.id, true);
    }));
    return this.list();
  }

  private invalidateIfVersionChanged(kind: AgentKind, d: DetectResult) {
    const r = this.db.get<CapsRow>('SELECT * FROM agent_caps WHERE agent = ? LIMIT 1', kind);
    if (r && (r.adapter_version !== (d.adapterVersion ?? null) || r.engine_version !== (d.engineVersion ?? null))) {
      this.o.log(`[agents] ${kind} 版本变化，能力缓存失效`);
      this.db.run('DELETE FROM agent_caps WHERE agent = ?', kind);
    }
  }

  /**
   * 缓存为空或超过 24 小时：自动做一次探测会话（只对 autoProbe 的 Agent：session/new 不花钱、不需要登录）。
   * userInitiated：用户点了 [重新检测]，不看 autoProbe，但只探测已登录的 Agent（session/new 也不花钱）。
   */
  autoProbe(kind: AgentKind, userInitiated = false): Promise<void> {
    const a = this.registry.get(kind);
    const d = this.detected.get(kind);
    if (!a?.real || !a.probe || !d?.installed) return Promise.resolve();
    if (!a.autoProbe && !(userInitiated && d.loggedIn)) return Promise.resolve();
    const def = this.profiles.defaultRow(kind);
    const row = this.capsRow(kind, def.id);
    if (row && now() - row.probed_at < STALE_MS) return Promise.resolve();
    const inflight = this.probing.get(kind);
    if (inflight) return inflight;
    const p = (async () => {
      const dir = this.probeDir();
      try {
        const { env, redact, account } = await this.profiles.envFor(a, def);
        const r = await a.probe!({ cwd: dir, env, redact, profile: account });
        if (r.caps && r.config) { this.saveCaps(kind, def.id, r.caps, r.config); this.pushStatus(kind); }
      } catch (e) {
        this.o.log(`[agents] ${kind} 自动探测失败：${(e as Error).message}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })().finally(() => this.probing.delete(kind));
    this.probing.set(kind, p);
    return p;
  }

  private probeDir() {
    const base = path.join(this.o.dataDir, 'probe');
    mkdirSync(base, { recursive: true });
    return mkdtempSync(path.join(base, 'p-'));
  }

  // ---------- 能力缓存 ----------

  private capsRow(kind: AgentKind, profileId: string): CapsRow | undefined {
    return this.db.get<CapsRow>('SELECT * FROM agent_caps WHERE agent = ? AND profile_id = ?', kind, profileId);
  }

  saveCaps(kind: AgentKind, profileId: string, caps: AdapterCaps, config: SessionConfigState | null) {
    const d = this.detected.get(kind);
    const prev = this.capsRow(kind, profileId);
    const catalog = config && (config.models.length || config.efforts)
      ? JSON.stringify({ models: config.models, efforts: config.efforts, modes: config.modes } satisfies Catalog)
      : prev?.catalog_json ?? null;
    this.db.run(
      `INSERT INTO agent_caps (agent, profile_id, adapter_version, engine_version, caps_json, catalog_json, commands_json, probed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent, profile_id) DO UPDATE SET adapter_version = excluded.adapter_version, engine_version = excluded.engine_version,
         caps_json = excluded.caps_json, catalog_json = excluded.catalog_json, commands_json = excluded.commands_json, probed_at = excluded.probed_at`,
      kind, profileId, d?.adapterVersion ?? null, d?.engineVersion ?? null, JSON.stringify(caps), catalog, JSON.stringify(caps.commands ?? []), now(),
    );
  }

  /** 会话里收到新的配置推送时，顺带更新模型列表缓存 */
  saveCatalog(kind: AgentKind, profileId: string, config: SessionConfigState) {
    if (!config.models.length && !config.efforts) return;
    const prev = this.capsRow(kind, profileId);
    if (!prev) return;
    this.db.run('UPDATE agent_caps SET catalog_json = ? WHERE agent = ? AND profile_id = ?',
      JSON.stringify({ models: config.models, efforts: config.efforts, modes: config.modes } satisfies Catalog), kind, profileId);
  }

  /** 收到思考内容后把 caps.thoughts 写回缓存 */
  saveThoughts(kind: AgentKind, profileId: string) {
    const r = this.capsRow(kind, profileId);
    if (!r?.caps_json) return;
    try {
      const c = JSON.parse(r.caps_json) as AdapterCaps;
      if (c.thoughts) return;
      c.thoughts = true;
      this.db.run('UPDATE agent_caps SET caps_json = ? WHERE agent = ? AND profile_id = ?', JSON.stringify(c), kind, profileId);
    } catch { /* 忽略 */ }
  }

  /** 模型列表：账号的缓存 → 默认账号的缓存 → 自定义地址手填的列表 → 适配器静态列表（演示 Agent） */
  catalog(kind: AgentKind, profileId: string | null): Catalog & { source: 'cache' | 'manual' | 'none' | 'session' } {
    const a = this.registry.get(kind);
    if (!a?.real) {
      const s = this.staticCatalog.get(kind) ?? { models: [], efforts: null, modes: [] };
      return { ...s, source: 'cache' };
    }
    const def = this.profiles.defaultRow(kind);
    const pid = profileId ?? def.id;
    const row = this.capsRow(kind, pid) ?? this.capsRow(kind, def.id);
    if (row?.catalog_json) {
      try { return { ...(JSON.parse(row.catalog_json) as Catalog), source: 'cache' }; } catch { /* 下面 */ }
    }
    const p = this.profiles.toApi(this.profiles.resolve(kind, pid));
    if (p.models.length) return { models: p.models, efforts: null, modes: [], source: 'manual' };
    return { models: [], efforts: null, modes: [], source: 'none' };
  }

  // ---------- 登录状态 ----------

  profileLoggedIn(profileId: string): boolean | null { return this.profileLogin.get(profileId) ?? null; }

  /** 运行中发现登录状态变化（登录失效、会话建立成功） */
  markAuth(kind: AgentKind, profileId: string, loggedIn: boolean) {
    const before = this.profileLogin.get(profileId);
    this.profileLogin.set(profileId, loggedIn);
    const a = this.registry.get(kind);
    if (a?.real && this.profiles.defaultRow(kind).id === profileId) {
      const d = this.detected.get(kind);
      if (d) this.detected.set(kind, { ...d, loggedIn, message: loggedIn ? null : '登录已失效，请重新登录' });
    }
    if (before !== loggedIn) this.pushStatus(kind);
  }

  // ---------- AgentInfo ----------

  info(a: AgentAdapter): AgentInfo {
    const d = this.detected.get(a.id);
    const caps = a.real ? this.cachedCaps(a.id) : null;
    const cat = this.catalog(a.id, null);
    const status: AgentInfo['status'] = !d ? 'error' : d.error || d.unsupported ? 'error' : !d.installed ? 'not_installed' : !d.loggedIn ? 'needs_login' : 'ready';
    const info: AgentInfo = {
      kind: a.id, displayName: a.displayName, status,
      version: d?.engineVersion ?? d?.version ?? null,
      verified: d?.verified ?? true,
      models: cat.models, efforts: cat.efforts,
      message: d ? d.message : '还没有检测',
      adapterVersion: d?.adapterVersion ?? null,
      engineVersion: d?.engineVersion ?? null,
      ...(d?.engineSource ? { engineSource: d.engineSource } : {}),
      engineLocation: d?.engineLocation ?? null,
      authMethods: d?.authMethods ?? [],
      modelsSource: a.real ? cat.source : 'cache',
      runningSessions: this.running.get(a.id) ?? 0,
      concurrencyLimit: this.concurrencyLimit(a.id),
      ...(d?.checkedAt ? { checkedAt: d.checkedAt } : {}),
      ...(caps ? { caps } : {}),
      // 可选的权限级别、默认模型、工作区设置文件是否生效：客户端按这些字段显示，不自己写死
      permissionLevels: a.permissionLevels ?? ['readonly', 'ask', 'workspace', 'full'],
      defaultModel: this.settings(a.id).defaultModel ?? null,
      defaultEffort: this.settings(a.id).defaultEffort ?? null,
      ...(a.workspaceConfig ? { workspaceConfig: a.workspaceConfig } : {}),
      ...(a.real ? { profiles: this.profiles.summary(a.id) } : {}),
    };
    return info;
  }

  private cachedCaps(kind: AgentKind): AgentCaps | null {
    const def = this.profiles.defaultRow(kind);
    const row = this.capsRow(kind, def.id) ?? this.db.get<CapsRow>('SELECT * FROM agent_caps WHERE agent = ? ORDER BY probed_at DESC LIMIT 1', kind);
    if (!row?.caps_json) return null;
    try {
      const c = JSON.parse(row.caps_json) as AdapterCaps;
      return { loadSession: c.loadSession, resume: c.resume, close: c.close, modelSwitch: c.modelSwitch, thoughts: c.thoughts, modes: c.modes, prompt: c.prompt };
    } catch { return null; }
  }

  /** 能力缓存里记录的换模型方式（账号的缓存优先，其次默认账号） */
  cachedModelSwitch(kind: AgentKind, profileId: string | null): string | null {
    const def = this.profiles.defaultRow(kind);
    const row = this.capsRow(kind, profileId ?? def.id) ?? this.capsRow(kind, def.id);
    if (!row?.caps_json) return null;
    try { return (JSON.parse(row.caps_json) as AdapterCaps).modelSwitch ?? null; } catch { return null; }
  }

  async list(): Promise<AgentInfo[]> {
    const all = this.registry.all();
    await Promise.all(all.map((a) => this.ensureDetected(a.id).catch(() => {})));
    for (const a of all) if (a.real) this.profiles.ensureLocal(a.id);
    return all.map((a) => this.info(a));
  }

  async one(kind: AgentKind): Promise<AgentInfo> {
    const a = this.registry.get(kind);
    if (!a) throw Errors.notFound('没有这个 Agent');
    await this.ensureDetected(kind).catch(() => {});
    if (a.real) this.profiles.ensureLocal(kind);
    return this.info(a);
  }

  pushStatus(kind: AgentKind) {
    const a = this.registry.get(kind);
    if (!a) return;
    try {
      if (a.real) this.profiles.ensureLocal(kind);
      this.events.append({ type: 'agent.status', taskId: null, sessionId: null, data: { agent: this.info(a) } });
    } catch (e) { this.o.log(`[agents] 推送状态失败：${(e as Error).message}`); }
  }

  async patch(kind: AgentKind, body: PatchAgentBody): Promise<AgentInfo> {
    const a = this.registry.get(kind);
    if (!a) throw Errors.notFound('没有这个 Agent');
    if (body.engine !== undefined && kind !== 'claude') throw Errors.badRequest('只有 Claude Code 可以选择引擎');
    const s = { ...this.settings(kind) };
    if (body.concurrencyLimit !== undefined) s.concurrencyLimit = body.concurrencyLimit;
    if (body.defaultModel !== undefined) {
      if (body.defaultModel !== null) {
        const cat = this.catalog(kind, null);
        if (cat.models.length && !cat.models.some((m) => m.id === body.defaultModel)) throw Errors.badRequest(`${a.displayName} 没有这个模型：${body.defaultModel}`);
      }
      s.defaultModel = body.defaultModel;
    }
    if (body.defaultEffort !== undefined) {
      if (body.defaultEffort !== null) {
        const cat = this.catalog(kind, null);
        if (!cat.efforts || !cat.efforts.includes(body.defaultEffort)) throw Errors.badRequest(`不支持这个思考强度：${body.defaultEffort}`);
      }
      s.defaultEffort = body.defaultEffort;
    }
    const engineChanged = body.engine !== undefined && body.engine !== (s.engine ?? 'bundled');
    if (body.engine !== undefined) s.engine = body.engine;
    this.saveSettings(kind, s);
    if (engineChanged) {
      a.configure?.({ engine: body.engine! });
      this.db.run('DELETE FROM agent_caps WHERE agent = ?', kind);
      await this.detect(kind, true);
      void this.autoProbe(kind);
    }
    // 并发上限调大了：放行排队中的会话
    this.drain(kind);
    this.pushStatus(kind);
    return this.info(a);
  }

  // ---------- 并发上限 ----------

  /** 占一个会话名额；满了就排队（onQueued 在开始排队时调用）。返回释放函数；wait 为 false 且已满时返回 null */
  async acquire(kind: AgentKind, onQueued?: () => void, signal?: AbortSignal, opts: { wait?: boolean } = {}): Promise<(() => void) | null> {
    const a = this.registry.get(kind);
    if (!a?.real) return () => {};
    if (signal?.aborted) throw new AbortError();
    const n = this.running.get(kind) ?? 0;
    if (n < this.concurrencyLimit(kind)) {
      this.running.set(kind, n + 1);
      this.pushStatus(kind);
      return this.releaser(kind);
    }
    if (opts.wait === false) return null;
    onQueued?.();
    await new Promise<void>((resolve, reject) => {
      // 已经取消的信号不会再触发 abort 事件：直接放弃排队，否则会一直挂在队列里
      if (signal?.aborted) { reject(new AbortError()); return; }
      const q = this.queues.get(kind) ?? [];
      this.queues.set(kind, q);
      // 名额在 drain() 里同步占好（running + 1），这里只负责唤醒
      const go = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      const onAbort = () => { const i = q.indexOf(go); if (i >= 0) q.splice(i, 1); reject(new AbortError()); };
      q.push(go);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    this.pushStatus(kind);
    return this.releaser(kind);
  }

  private releaser(kind: AgentKind) {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.running.set(kind, Math.max(0, (this.running.get(kind) ?? 1) - 1));
      this.drain(kind);
      this.pushStatus(kind);
    };
  }

  /** 放行排队的会话：每放行一个就同步占一个名额，不会超过上限 */
  private drain(kind: AgentKind) {
    const q = this.queues.get(kind) ?? [];
    while (q.length && (this.running.get(kind) ?? 0) < this.concurrencyLimit(kind)) {
      this.running.set(kind, (this.running.get(kind) ?? 0) + 1);
      q.shift()!();
    }
  }

  /** 排队中的会话数（测试用） */
  queued(kind: AgentKind) { return this.queues.get(kind)?.length ?? 0; }
  runningCount(kind: AgentKind) { return this.running.get(kind) ?? 0; }

  // ---------- 登录 ----------

  async login(kind: AgentKind, body: AgentLoginBody, deviceId: string | null): Promise<{ loginId: string }> {
    const a = this.registry.get(kind);
    if (!a) throw Errors.notFound('没有这个 Agent');
    if (!a.real || !a.startLogin) throw Errors.badRequest(`${a.displayName} 不需要登录`);
    const d = await this.ensureDetected(kind);
    const method = (d.authMethods ?? []).find((m) => m.id === body.methodId);
    if (!method) throw Errors.badRequest(`${a.displayName} 没有这种登录方式：${body.methodId}`);
    if (method.flow === 'apiKey') throw Errors.badRequest('API Key 请在“添加账号”里填写，不需要登录');
    const profile = this.profiles.resolve(kind, body.profileId);
    if (profile.kind !== 'subscription') throw Errors.badRequest('这个账号用的是 API Key，不需要登录');
    const existing = [...this.logins.values()].find((l) => l.kind === kind && !l.done);
    if (existing) return { loginId: existing.id };
    // CodeBuddy：对已登录的用户调用 authenticate 会先登出（还会退出 WorkBuddy 里的账号），必须二次确认
    if (kind === 'codebuddy' && body.methodId !== WORKBUDDY_APP_METHOD && this.profileLoggedIn(profile.id) === true && !body.force) {
      throw Errors.conflict('CodeBuddy 已经登录了', '换账号会同时退出 WorkBuddy 里的账号；确认后再试', [{ label: '确认换账号', action: ErrorActionKey.LoginForce, args: { kind, methodId: body.methodId, profileId: profile.id } }]);
    }
    const { env, account } = await this.profiles.envFor(a, profile);
    const loginId = newId('lg');
    const emit = (state: 'started' | 'waiting_browser' | 'need_code' | 'succeeded' | 'failed' | 'cancelled', extra: { authUrl?: string | undefined; message?: string | undefined } = {}) => {
      this.events.append({
        type: 'agent.login', taskId: null, sessionId: null,
        data: { loginId, kind, profileId: profile.id, state, ...(extra.authUrl ? { authUrl: extra.authUrl } : {}), ...(extra.message ? { message: extra.message } : {}) },
      });
    };
    // 先建记录再启动登录：适配器会在 startLogin 里同步回调一次 onProgress（'started'），
    // 之前 rec 在回调之后才声明，回调里访问 rec 抛 ReferenceError，登录接口直接 500（2026-11-07 用户报告）
    const rec: LoginRec = { id: loginId, kind, profileId: profile.id, handle: null as unknown as LoginHandle, done: false };
    rec.handle = a.startLogin({
      methodId: body.methodId, profile: account, env,
      onProgress: (p) => { if (!rec.done) emit(p.state, p); },
    });
    const handle = rec.handle;
    this.logins.set(loginId, rec);
    this.o.audit(deviceId, 'agent.login', `${kind} ${profile.id} ${profile.name} ${body.methodId}`);
    void handle.done.then(async (r) => {
      rec.done = true;
      emit(r.state, r);
      if (r.state === 'succeeded' && body.methodId !== WORKBUDDY_APP_METHOD) {
        this.profileLogin.set(profile.id, true);
        this.db.run('DELETE FROM agent_caps WHERE agent = ? AND profile_id = ?', kind, profile.id);
        await this.detect(kind, true).catch(() => {});
        void this.autoProbe(kind);
      }
      this.pushStatus(kind);
      setTimeout(() => this.logins.delete(loginId), 60_000).unref?.();
    });
    return { loginId };
  }

  private loginRec(kind: AgentKind, loginId: string): LoginRec {
    const r = this.logins.get(loginId);
    if (!r || r.kind !== kind) throw Errors.notFound('找不到这个登录流程');
    return r;
  }

  cancelLogin(kind: AgentKind, loginId: string) {
    const r = this.loginRec(kind, loginId);
    if (!r.done) r.handle.cancel();
  }

  submitCode(kind: AgentKind, loginId: string, code: string) {
    const r = this.loginRec(kind, loginId);
    if (r.done) throw Errors.invalidState('登录流程已经结束了');
    if (!r.handle.submitCode) throw Errors.badRequest('这个登录流程不需要授权码');
    r.handle.submitCode(code);
  }

  // ---------- 测试连接 ----------

  async test(kind: AgentKind, body: { profileId?: string | undefined; sendMessage?: boolean | undefined }): Promise<AgentTestResult> {
    const a = this.registry.get(kind);
    if (!a) throw Errors.notFound('没有这个 Agent');
    if (!a.real || !a.probe) {
      return { ok: true, steps: [{ ts: now(), label: '演示 Agent 不需要测试连接', ok: true, ms: 0 }] };
    }
    const profile = this.profiles.resolve(kind, body.profileId);
    let env: Record<string, string>;
    let redact: string[];
    let account;
    try { ({ env, redact, account } = await this.profiles.envFor(a, profile)); } catch (e) {
      return { ok: false, steps: [{ ts: now(), label: '读取账号密钥', ok: false, ms: 0, detail: (e as Error).message }] };
    }
    const dir = this.probeDir();
    try {
      const r = await a.probe({ cwd: dir, env, redact, profile: account, ...(body.sendMessage ? { sendMessage: true } : {}) });
      if (r.caps && r.config) this.saveCaps(kind, profile.id, r.caps, r.config);
      this.profiles.setTest(profile.id, r.ok);
      if (r.error?.code === ErrorCode.AgentAuthRequired) this.markAuth(kind, profile.id, false);
      else if (r.ok && r.config) this.markAuth(kind, profile.id, true);
      this.pushStatus(kind);
      return { ok: r.ok, steps: r.steps };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** 关闭：取消进行中的登录 */
  shutdown() {
    for (const l of this.logins.values()) if (!l.done) l.handle.cancel();
  }

  isLocalProfile(r: ProfileRow) { return r.id === `pf_local_${r.agent}`; }
}
