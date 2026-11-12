// AcpSession：实现 AgentConnection，三家共用（phase-1.md 6.2.1–6.2.3、6.3.2、6.5.4）。
// 一个进程只跑一个会话（6.3.1 总表“每个进程的会话数”）。
import { ErrorCode, type PromptInput, type AgentKind, type PermissionLevel, type TurnTokenUsage } from '@aic/protocol';
import { promptUsage } from './usage';
import { redact } from '../redact';
import {
  AgentError, type AgentCaps, type AgentConnection, type AgentUpdate, type AuthMethodInfo, type LogFn, type McpServerSpec, type ProbeOptions,
  type ProbeResult, type ProbeStep, type ProcessTracker, type SessionConfigState, type SessionHost, type SpawnOptions, type StopReason,
} from '../types';
import { AbortError, isRecord, newId, str } from '../util';
import { configSignature, EMPTY_CONFIG, legacyIsCombo, modelSwitchOf, parseConfigState } from './config';
import { AcpConnection, type AcpTimeouts, type ExitInfo } from './connection';
import { textResponseError, isCodexProxyModelError, agentErrors, classifyError, invalidValue, isNotFound } from './errors';
import { buildChildEnv, buildNativeEnv, type LaunchSpec } from './launch';
import { normalizePermission } from './permissions';
import { UpdateMapper } from './updates';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';

/** 每家 Agent 的差异描述（adapter 提供） */
export interface AcpAgentSpec {
  kind: AgentKind;
  displayName: string;
  usesNativeConfig?: boolean;
  /** 解析启动方式；找不到时抛 AgentError（notInstalled） */
  launch(env: Record<string, string>): LaunchSpec;
  clientCapabilities?: Record<string, unknown>;
  /** 权限级别 → Agent 模式 */
  modeFor(level: PermissionLevel): string | null;
  /** 模式的宽松程度，数值越大越宽松；不认识的模式按最宽松处理 */
  modeRank(modeId: string): number;
  extensions: string[];
  /** 私有通知（Claude 的 _auth/status_update、CodeBuddy 的 _codebuddy.ai/* 等） */
  onNotification?(ctx: { emit(u: AgentUpdate): void; log: LogFn }, method: string, params: unknown): void;
  /** initialize 返回的 authMethods → 归一化 */
  authMethodsFromInit?(init: Record<string, unknown>): AuthMethodInfo[];
  /** 启动前确保存在的目录（环境变量名，例如 CLAUDE_CONFIG_DIR） */
  dirEnvKeys?: string[];
  /**
   * session/new、session/resume、session/load 带上的 _meta（Claude：只读用户设置、关掉 bypass，
   * 不加载工作区里的 .claude/settings*.json，避免仓库自带的 hooks 和 allow 规则绕过工作台审批）
   */
  sessionMeta?(): Record<string, unknown>;
  /** 启动时指定模型（H1：Agent 不能在会话里换模型时用）。返回要叠加的环境变量和启动参数 */
  launchModel?(model: string, env: Record<string, string>): { env?: Record<string, string>; args?: string[] };
}

export interface AcpRuntime {
  log: LogFn;
  tracker?: ProcessTracker;
  timeouts?: Partial<AcpTimeouts>;
}

const MAX_TOKENS_NOTICE = '回复达到长度上限，可以让它继续';

/** 合并后的环境变量：删掉会串号的变量，再叠加账号变量；需要的配置目录先建好 */
export function agentEnv(spec: AcpAgentSpec, overlay: Record<string, string> = {}): Record<string, string> {
  const env = spec.usesNativeConfig ? buildNativeEnv(overlay) : buildChildEnv(overlay);
  for (const k of spec.usesNativeConfig ? [] : spec.dirEnvKeys ?? []) {
    const d = env[k];
    if (d) { try { mkdirSync(d, { recursive: true }); } catch { /* 启动时会报错 */ } }
  }
  return env;
}

export class AcpSession implements AgentConnection {
  agentSessionId = '';
  caps: AgentCaps;
  resumed = false;
  resumeFailure: string | null = null;
  private state: SessionConfigState = EMPTY_CONFIG;
  private mapper: UpdateMapper;
  private expectedMode: string | null = null;
  private exitCbs: ((i: ExitInfo) => void)[] = [];
  private turnAbort: AbortController | null = null;
  private lastSig = '';
  private configTimer: NodeJS.Timeout | null = null;
  private holding = true;
  private turnMessages = new Map<string, string>();
  private turnTools = false;
  private turnCompactions = new Set<string>();
  private held: AgentUpdate[] = [];
  private replayOpen = false;
  private replayTimer: NodeJS.Timeout | null = null;
  private permission: PermissionLevel;
  private log: LogFn;
  private secrets: string[];

  constructor(private spec: AcpAgentSpec, private conn: AcpConnection, private opts: SpawnOptions, rt: AcpRuntime) {
    this.log = rt.log;
    this.secrets = opts.redact ?? [];
    this.permission = opts.permission;
    const init = conn.initResult;
    const ac = isRecord(init.agentCapabilities) ? init.agentCapabilities : {};
    const sc = isRecord(ac.sessionCapabilities) ? ac.sessionCapabilities : {};
    const pc = isRecord(ac.promptCapabilities) ? ac.promptCapabilities : {};
    const mc = isRecord(ac.mcpCapabilities) ? ac.mcpCapabilities : {};
    const info = isRecord(init.agentInfo) ? init.agentInfo : null;
    this.caps = {
      loadSession: ac.loadSession === true,
      resume: isRecord(sc.resume), list: isRecord(sc.list), close: isRecord(sc.close), fork: isRecord(sc.fork),
      modelSwitch: 'none', thoughts: false, modes: [],
      prompt: { image: pc.image === true, audio: pc.audio === true, embeddedContext: pc.embeddedContext === true },
      mcp: { http: mc.http === true, sse: mc.sse === true },
      extensions: [...spec.extensions],
      unknownUpdates: {}, commands: [],
      agentInfo: info ? { name: str(info.name), version: str(info.version) } : null,
    };
    const tag = (opts.sessionLabel ?? newId('s')).replace(/[^A-Za-z0-9]/g, '').slice(-10);
    this.mapper = new UpdateMapper(tag, (u) => this.emit(u), {
      unknown: (type) => {
        const u = this.caps.unknownUpdates ?? (this.caps.unknownUpdates = {});
        u[type] = (u[type] ?? 0) + 1;
        this.log('debug', `[agent:${spec.kind}] 未知的 session/update 类型：${type}`);
      },
      thought: () => { this.caps.thoughts = true; },
      commands: (names) => { this.caps.commands = names; },
      mode: (m) => this.onMode(m),
      configOptions: (u) => {
        this.state = parseConfigState(u, this.state);
        this.caps.modelSwitch = this.state.ids.model ? 'configOption' : this.caps.modelSwitch;
        this.scheduleConfig();
        if (this.state.mode) this.checkDrift(this.state.mode);
      },
      sessionInfo: (u) => this.onSessionInfo(u),
    });
    conn.setUpdateHandler((p) => {
      const u = isRecord(p.update) ? p.update : null;
      if (u) this.mapper.handle(u);
    });
    conn.onExit((i) => {
      if (this.turnAbort) this.mapper.endTurn(i.killed ? 'cancelled' : 'error');
      for (const cb of this.exitCbs) cb(i);
    });
  }

  get pid() { return this.conn.pid; }
  config(): SessionConfigState { return this.state; }
  onExit(cb: (i: ExitInfo) => void) { this.exitCbs.push(cb); }
  isClosed() { return this.conn.isClosed; }

  /** Gateway 记录好会话（发出 session.started）后调用：先补发建会话期间的更新，再发一次当前配置 */
  ready() {
    if (!this.holding) return;
    this.holding = false;
    const h = this.held;
    this.held = [];
    for (const u of h) this.opts.host.update(u);
    this.emitConfig(true);
  }

  /** 发给 Gateway；建会话期间先攒着（配置在 ready() 时统一发一次） */
  emit(u: AgentUpdate) {
    if (this.turnAbort && u.kind === 'message') this.turnMessages.set(u.messageId, (this.turnMessages.get(u.messageId) ?? '') + u.text);
    if (this.turnAbort && u.kind === 'tool_start') {
      if (this.spec.kind === 'codex' && u.toolKind === 'think' && u.title === 'Compact conversation' && u.target === null) this.turnCompactions.add(u.toolId);
      else this.turnTools = true;
    }
    if (this.turnAbort && u.kind === 'tool_update' && this.turnCompactions.has(u.toolId)
      && ((u.toolKind !== undefined && u.toolKind !== 'think') || (u.title !== undefined && u.title !== 'Compact conversation') || (u.target !== undefined && u.target !== null))) this.turnTools = true;
    if (this.holding) { if (u.kind !== 'config_options') this.held.push(u); return; }
    this.opts.host.update(u);
  }

  notice(level: 'info' | 'warn', text: string) { this.emit({ kind: 'notice', level, text }); }

  // ---------- 建立会话 ----------

  /** 恢复（resume 优先，其次 load）。成功返回 true；Agent 不支持恢复返回 false；其他失败抛错 */
  async tryResume(agentSessionId: string): Promise<boolean> {
    const base = { sessionId: agentSessionId, cwd: this.opts.cwd, mcpServers: this.mcpServers(), ...this.meta() };
    const t = this.conn.timeouts.session;
    let resp: Record<string, unknown>;
    if (this.caps.resume) {
      resp = asRecord(await this.conn.request('session/resume', base, t, 'session'));
    } else if (this.caps.loadSession) {
      // 回放期间收到的 update 全部丢弃（Gateway 的事件库里本来就有完整对话）
      this.mapper.replaying = true;
      try {
        resp = asRecord(await this.conn.request('session/load', base, t, 'session'));
      } finally {
        this.endReplaySoon();
      }
    } else {
      return false;
    }
    this.agentSessionId = agentSessionId;
    this.resumed = true;
    this.afterSession(resp);
    return true;
  }

  private meta(): { _meta?: Record<string, unknown> } {
    const m = this.spec.sessionMeta?.();
    return m ? { _meta: m } : {};
  }

  /** 注入的 MCP 服务：只放 aic- 前缀的（其余记警告后丢弃） */
  private mcpServers(): McpServerSpec[] {
    const list = this.opts.mcpServers ?? [];
    const ok = list.filter((m) => m.name.startsWith('aic-'));
    if (ok.length !== list.length) this.log('warn', `[agent:${this.spec.kind}] 注入的 MCP 服务名必须以 aic- 开头，已跳过 ${list.length - ok.length} 个`);
    return ok;
  }

  async newSession() {
    const resp = asRecord(await this.conn.request('session/new', { cwd: this.opts.cwd, mcpServers: this.mcpServers(), ...this.meta() },this.conn.timeouts.session, 'session'));
    const id = str(resp.sessionId);
    if (!id) throw agentErrors.protocol(this.spec.kind, this.spec.displayName, 'session/new 没有返回 sessionId');
    this.agentSessionId = id;
    this.afterSession(resp);
  }

  private afterSession(resp: Record<string, unknown>) {
    this.state = parseConfigState(resp, EMPTY_CONFIG);
    this.legacyCombo = legacyIsCombo(resp);
    this.caps.modelSwitch = modelSwitchOf(this.state, resp);
    this.caps.modes = this.state.modes;
    if (this.state.efforts) this.caps.effortOptions = this.state.efforts;
  }
  private legacyCombo = false;
  /** 启动时已经指定的模型（H1） */
  launchedModel: string | null = null;
  /** 正在把漂移的模式改回来：期间收到的审批请求一律拒绝 */
  private driftFix: Promise<void> | null = null;
  /** 这一轮因为模式漂移被暂停了 */
  private driftCancelled = false;

  /** 下发权限模式、模型、思考强度（新建或恢复之后都要做一次；恢复后 Agent 可能回到默认值） */
  async applyInitial() {
    // 权限模式是硬性前置条件：Agent 处在更宽松的模式（bypass / acceptEdits / auto）时根本不会来请求审批，
    // 工作台审批也就拦不住。设置失败或设置后仍比预期宽松，就关掉会话、报错，不交给用户使用。
    const exp = this.spec.modeFor(this.permission);
    try {
      await this.setPermission(this.permission);
    } catch (e) {
      this.log('warn', `[agent:${this.spec.kind}] 设置模式失败：${redact(String((e as Error).message), this.secrets)}`);
      throw agentErrors.modeUnavailable(this.spec.kind, this.spec.displayName, exp ?? '');
    }
    if (exp && this.state.mode !== null && this.spec.modeRank(this.state.mode) > this.spec.modeRank(exp)) {
      this.log('warn', `[agent:${this.spec.kind}] 设置模式后仍是更宽松的“${this.state.mode}”（应为“${exp}”）`);
      throw agentErrors.modeUnavailable(this.spec.kind, this.spec.displayName, exp);
    }
    const want = { model: this.opts.model, effort: this.opts.effort };
    // H1：模型已经在启动时指定（Agent 不能在会话里换模型），不再走 setConfig
    if (want.model && this.caps.modelSwitch === 'none' && this.launchedModel === want.model) {
      if (this.state.model === null) this.state = { ...this.state, model: want.model };
      want.model = null;
    }
    if (want.model && this.state.models.length && !this.state.models.some((m) => m.id === want.model)) {
      this.notice('warn', `原来选的模型 ${want.model} 现在不可用，已改用 ${this.state.model ?? 'Agent 默认模型'}`);
      want.model = null;
    }
    try {
      await this.setConfig({
        ...(want.model && want.model !== this.state.model ? { model: want.model } : {}),
        ...(want.effort && want.effort !== this.state.effort ? { effort: want.effort } : {}),
      }, { quiet: true });
    } catch (e) {
      const msg = e instanceof AgentError ? `${e.body.message}${e.body.hint ? `：${e.body.hint}` : ''}` : String(e);
      this.notice('warn', `没能恢复原来的模型或思考强度（${msg}），已使用 ${this.state.model ?? 'Agent 默认模型'}`);
    }
  }

  // ---------- 回合 ----------

  async prompt(input: PromptInput, signal: AbortSignal): Promise<{ stopReason: StopReason; usage?: TurnTokenUsage }> {
    if (this.conn.isClosed) throw agentErrors.crashed(this.spec.kind, this.spec.displayName);
    this.turnMessages.clear(); this.turnTools = false; this.turnCompactions.clear();
    const prompt: Record<string, unknown>[] = [];
    if (input.text) prompt.push({ type: 'text', text: input.text });
    for (const a of input.attachments ?? []) {
      if (a.kind === 'image') {
        if (!this.caps.prompt.image) throw new AgentError({ code: ErrorCode.AttachmentUnsupported, message: '这个 Agent 看不了图片', actions: [] }, 'unsupported');
        if ((await stat(a.path)).size > 5 * 1024 * 1024) throw new AgentError({ code: ErrorCode.AttachmentTooLarge, message: '图片太大，最大 5 MB', actions: [] }, 'failed');
        prompt.push({ type: 'image', mimeType: a.mime, data: (await readFile(a.path)).toString('base64') });
      } else if (this.caps.prompt.embeddedContext && a.mime.startsWith('text/') && (await stat(a.path)).size < 256 * 1024) {
        prompt.push({ type: 'resource', resource: { uri: a.uri, text: await readFile(a.path, 'utf8'), mimeType: a.mime } });
      } else prompt.push({ type: 'resource_link', uri: a.uri, name: a.name, mimeType: a.mime });
    }
    const turn = new AbortController();
    this.turnAbort = turn;
    this.driftCancelled = false;
    let cancelTimer: NodeJS.Timeout | null = null;
    let killed = false;
    const onAbort = () => {
      turn.abort();
      this.conn.notify('session/cancel', { sessionId: this.agentSessionId });
      // 10 秒内没有返回就结束进程树（下一条消息时自动恢复会话）
      cancelTimer = setTimeout(() => { killed = true; void this.conn.kill(); }, this.conn.timeouts.cancel);
      cancelTimer.unref?.();
    };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = asRecord(await this.conn.request('session/prompt', {
        sessionId: this.agentSessionId, prompt,
      }, 0));
      const stop = this.driftCancelled ? 'cancelled' : str(resp.stopReason) ?? 'end_turn';
      const usage = promptUsage(resp.usage);
      if (stop === 'cancelled') { this.mapper.endTurn('cancelled'); return { stopReason: 'cancelled' }; }
      this.mapper.endTurn('end_turn');
      if (!this.turnTools && this.turnMessages.size === 1) {
        const text = [...this.turnMessages.values()][0]!;
        // 自动压缩只豁免当前模型的固定代理封套；原有错误模式仍要求完全没有工具。
        const proxyEnvelope = text.trim().startsWith('CC Switch local proxy failed');
        const failure = (this.turnCompactions.size || proxyEnvelope) && !isCodexProxyModelError(text, this.state.model) ? null
          : textResponseError(text, this.spec.kind, this.spec.displayName, this.secrets);
        if (failure) throw failure;
      }
      if (stop === 'refusal') return { stopReason: 'refusal', ...(usage ? { usage } : {}) };
      if (stop === 'max_tokens' || stop === 'max_turn_requests') this.notice('info', MAX_TOKENS_NOTICE);
      return { stopReason: 'end_turn', ...(usage ? { usage } : {}) };
    } catch (e) {
      if ((signal.aborted || this.driftCancelled) && (killed || this.conn.isClosed)) { this.mapper.endTurn('cancelled'); return { stopReason: 'cancelled' }; }
      if (signal.aborted && errCode(e) === -32800) { this.mapper.endTurn('cancelled'); return { stopReason: 'cancelled' }; }
      this.mapper.endTurn('error');
      throw classifyError(e, this.spec.kind, this.spec.displayName, this.secrets);
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      signal.removeEventListener('abort', onAbort);
      if (this.turnAbort === turn) this.turnAbort = null;
    }
  }

  /** session/request_permission → 工作台审批 */
  async onPermission(params: Record<string, unknown>, reqSignal: AbortSignal): Promise<unknown> {
    this.emit({ kind: 'activity' });
    const n = normalizePermission(params, { agentName: this.spec.displayName, cwd: this.opts.cwd });
    for (const w of n.warnings) this.log('warn', `[agent:${this.spec.kind}] ${w}`);
    if (n.toolCall) this.mapper.ensureTool(n.toolCall);
    if (this.driftFix) {
      // 模式还没改回来：不交给用户审批，直接拒绝
      if (n.toolCallId) this.mapper.markRejected(n.toolCallId);
      const r = n.options.find((o) => o.kind.startsWith('reject'));
      return { outcome: r ? { outcome: 'selected', optionId: r.id } : { outcome: 'cancelled' } };
    }
    if (n.auto) {
      if (n.toolCallId) this.mapper.markRejected(n.toolCallId);
      this.notice('warn', `${this.spec.displayName} 发来的审批请求没有可以显示的选项，已自动拒绝`);
      return { outcome: n.auto === 'cancelled' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: n.auto.optionId } };
    }
    const signals = [reqSignal, ...(this.turnAbort ? [this.turnAbort.signal] : [])];
    const signal = AbortSignal.any(signals);
    let out;
    try {
      out = await this.opts.host.requestPermission(n.request, signal);
    } catch {
      return { outcome: { outcome: 'cancelled' } };
    }
    const opt = out.outcome === 'selected' ? n.options.find((o) => o.id === out.optionId) : undefined;
    if (!opt) {
      // 作废或超时：工具没有执行，界面按“未执行”显示
      if (n.toolCallId) this.mapper.markRejected(n.toolCallId);
      return { outcome: { outcome: 'cancelled' } };
    }
    if (opt.kind.startsWith('reject') && n.toolCallId) this.mapper.markRejected(n.toolCallId);
    // 用户填写的拒绝理由（note）ACP 不支持回传，只存在审批记录里
    return { outcome: { outcome: 'selected', optionId: opt.id } };
  }

  // ---------- 配置 ----------

  async setConfig(cfg: { model?: string; effort?: string }, opts: { quiet?: boolean } = {}): Promise<void> {
    // 不管成功还是中途失败（例如模型换成功、强度失败），都把 Agent 的真实状态推给 Gateway，
    // 否则任务记录还是旧模型，下次恢复会话时又被改回去
    try {
      await this.doSetConfig(cfg, opts);
    } finally {
      this.emitConfig();
    }
  }

  private async doSetConfig(cfg: { model?: string; effort?: string }, opts: { quiet?: boolean }): Promise<void> {
    const name = this.spec.displayName;
    const prevEffort = this.state.effort;
    if (cfg.model !== undefined && cfg.model !== this.state.model) {
      if (this.caps.modelSwitch === 'configOption' && this.state.ids.model) {
        await this.setOption(this.state.ids.model, cfg.model, '模型');
      } else if (this.caps.modelSwitch === 'unstableSetModel') {
        const modelId = this.legacyCombo && this.state.effort ? `${cfg.model}[${cfg.effort ?? this.state.effort}]` : cfg.model;
        try {
          await this.conn.request('session/set_model', { sessionId: this.agentSessionId, modelId }, this.conn.timeouts.config);
        } catch (e) { throw this.configError(e, '模型'); }
        this.state = { ...this.state, model: cfg.model, ...(this.legacyCombo && cfg.effort ? { effort: cfg.effort } : {}) };
        if (this.legacyCombo && cfg.effort) cfg = { ...cfg, effort: undefined };
      } else {
        throw agentErrors.unsupported(name, '在会话里换模型');
      }
      // 思考强度的可选项随模型变化：原来的强度不在新列表里时，改用新的 currentValue 并提示
      const wanted = cfg.effort ?? prevEffort;
      if (wanted && this.state.efforts && !this.state.efforts.includes(wanted)) {
        if (!opts.quiet || cfg.effort) this.notice('info', `新模型不支持思考强度“${wanted}”，已改为“${this.state.effort ?? '默认'}”`);
        if (cfg.effort) cfg = { ...cfg, effort: undefined };
      }
    }
    if (cfg.effort !== undefined && cfg.effort !== this.state.effort) {
      if (!this.state.ids.effort) {
        if (!(this.legacyCombo && this.caps.modelSwitch === 'unstableSetModel')) throw agentErrors.unsupported(name, '调节思考强度');
        const modelId = `${this.state.model}[${cfg.effort}]`;
        try {
          await this.conn.request('session/set_model', { sessionId: this.agentSessionId, modelId }, this.conn.timeouts.config);
        } catch (e) { throw this.configError(e, '思考强度'); }
        this.state = { ...this.state, effort: cfg.effort };
      } else {
        await this.setOption(this.state.ids.effort, cfg.effort, '思考强度');
      }
    }
  }

  private configError(e: unknown, what: string) {
    const c = errCode(e);
    if (c === -32602 || c === -32603) return invalidValue(e, this.spec.displayName, what, this.secrets);
    return classifyError(e, this.spec.kind, this.spec.displayName, this.secrets);
  }

  /** session/set_config_option：返回全量 configOptions，直接覆盖会话状态 */
  private async setOption(configId: string, value: string, what: string) {
    let resp: Record<string, unknown>;
    try {
      resp = asRecord(await this.conn.request('session/set_config_option', { sessionId: this.agentSessionId, configId, value }, this.conn.timeouts.config));
    } catch (e) {
      throw this.configError(e, what);
    }
    if (Array.isArray(resp.configOptions)) this.state = parseConfigState(resp, this.state);
    else if (configId === this.state.ids.model) this.state = { ...this.state, model: value };
    else if (configId === this.state.ids.effort) this.state = { ...this.state, effort: value };
    else if (configId === this.state.ids.mode) this.state = { ...this.state, mode: value };
  }

  async setPermission(level: PermissionLevel): Promise<void> {
    this.permission = level;
    const modeId = this.spec.modeFor(level);
    if (!modeId) return;
    this.expectedMode = modeId;
    if (this.state.mode === modeId) return;
    await this.setMode(modeId);
    this.emitConfig();
  }

  private async setMode(modeId: string) {
    if (this.state.ids.mode) {
      try { await this.setOption(this.state.ids.mode, modeId, '模式'); return; } catch (e) {
        this.log('warn', `[agent:${this.spec.kind}] set_config_option mode 失败，改用 set_mode：${redact(String((e as Error).message), this.secrets)}`);
      }
    }
    try {
      await this.conn.request('session/set_mode', { sessionId: this.agentSessionId, modeId }, this.conn.timeouts.config);
    } catch (e) { throw this.configError(e, '模式'); }
    this.state = { ...this.state, mode: modeId };
  }

  private onMode(modeId: string) {
    this.state = { ...this.state, mode: modeId };
    if (!this.checkDrift(modeId)) this.scheduleConfig();
  }

  /** 模式漂移：Agent 的模式比权限级别映射到的更宽松时，立即改回（例如退出计划模式时选了 bypass） */
  private checkDrift(modeId: string): boolean {
    const exp = this.expectedMode;
    if (!exp || modeId === exp) return false;
    if (this.spec.modeRank(modeId) <= this.spec.modeRank(exp)) return false;
    if (this.driftFix) return true;
    // 更宽松的模式下 Agent 不会再请求审批：先暂停这一轮（session/cancel），改回之前收到的审批一律拒绝；
    // 改回失败就结束进程，不让它停在宽松模式里继续跑
    const inTurn = !!this.turnAbort;
    if (inTurn) {
      this.driftCancelled = true;
      this.conn.notify('session/cancel', { sessionId: this.agentSessionId });
    }
    this.notice('warn', `${this.spec.displayName} 切换到了更宽松的模式“${modeId}”，已按任务的权限级别改回“${exp}”${inTurn ? '，这一轮已暂停' : ''}`);
    this.driftFix = this.setMode(exp).then(() => {
      if (this.state.mode !== null && this.spec.modeRank(this.state.mode) > this.spec.modeRank(exp)) throw new Error(`改回后仍是“${this.state.mode}”`);
      this.emitConfig();
    }).catch((e) => {
      this.log('error', `[agent:${this.spec.kind}] 模式改回失败，结束 Agent 进程：${redact(String((e as Error).message), this.secrets)}`);
      this.notice('warn', `没能把 ${this.spec.displayName} 改回“${exp}”模式，已结束 Agent 进程；发下一条消息时会重新启动`);
      this.conn.notify('session/cancel', { sessionId: this.agentSessionId });
      void this.conn.kill();
    }).finally(() => { this.driftFix = null; });
    return true;
  }

  /** 推送合并：100ms 内的多条只发一次；没有变化不发 */
  private scheduleConfig() {
    if (this.configTimer) return;
    this.configTimer = setTimeout(() => { this.configTimer = null; this.emitConfig(); }, 100);
    this.configTimer.unref?.();
  }

  private emitConfig(force = false) {
    if (this.configTimer) { clearTimeout(this.configTimer); this.configTimer = null; }
    const sig = configSignature(this.state);
    if (!force && sig === this.lastSig) return;
    this.lastSig = sig;
    this.caps.modes = this.state.modes;
    if (this.state.efforts) this.caps.effortOptions = this.state.efforts;
    this.emit({ kind: 'config_options', state: this.state });
  }

  // ---------- 回放边界（CodeBuddy） ----------

  private onSessionInfo(u: Record<string, unknown>) {
    const meta = isRecord(u._meta) ? u._meta : {};
    const mark = meta['codebuddy.ai/historyReplay'];
    if (mark === 'start') { this.replayOpen = true; this.mapper.replaying = true; }
    if (mark === 'end') {
      this.replayOpen = false;
      if (this.replayTimer) { clearTimeout(this.replayTimer); this.replayTimer = null; this.mapper.replaying = false; }
    }
  }

  /** load 返回后：有 start 没 end 的继续丢弃，直到 end（最多再等 5 秒） */
  private endReplaySoon() {
    if (!this.replayOpen) { this.mapper.replaying = false; return; }
    this.replayTimer = setTimeout(() => { this.replayTimer = null; this.replayOpen = false; this.mapper.replaying = false; }, 5000);
    this.replayTimer.unref?.();
  }

  // ---------- 关闭 ----------

  async close(): Promise<void> {
    if (this.configTimer) { clearTimeout(this.configTimer); this.configTimer = null; }
    if (!this.conn.isClosed && this.caps.close && this.agentSessionId) {
      await this.conn.request('session/close', { sessionId: this.agentSessionId }, 2000).catch(() => {});
    }
    await this.conn.close();
  }
}

const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {});
const errCode = (e: unknown): number | null => (isRecord(e) || e instanceof Error ? (typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : null) : null);

// ---------- 启动（含恢复失败时新建） ----------

export async function startConnection(spec: AcpAgentSpec, rt: AcpRuntime, opts: { cwd: string; env: Record<string, string>; redact?: string[]; label?: string; holder: { session: AcpSession | null }; signal?: AbortSignal }): Promise<AcpConnection> {
  const launch = spec.launch(opts.env);
  const pending: AgentUpdate[] = [];
  const emitter = {
    emit: (u: AgentUpdate) => { if (opts.holder.session) opts.holder.session.emit(u); else pending.push(u); },
    log: rt.log,
  };
  try {
    return await AcpConnection.start({
      kind: spec.kind, displayName: spec.displayName, launch, cwd: opts.cwd, env: opts.env, redact: opts.redact ?? [],
      log: rt.log, ...(opts.label ? { label: opts.label } : {}), ...(rt.tracker ? { tracker: rt.tracker } : {}), sessionLabel: opts.label ?? null,
      ...(rt.timeouts ? { timeouts: rt.timeouts } : {}),
      ...(spec.clientCapabilities ? { clientCapabilities: spec.clientCapabilities } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      onNotification: (method, params) => spec.onNotification?.(emitter, method, params),
      onPermission: async (params, signal) => {
        const s = opts.holder.session;
        if (!s) return { outcome: { outcome: 'cancelled' } };
        return s.onPermission(params, signal);
      },
    });
  } catch (e) {
    throw classifyError(e, spec.kind, spec.displayName, opts.redact ?? []);
  }
}

/** 启动 Agent 进程、建立（或恢复）会话、下发配置 */
export async function acpSpawn(spec: AcpAgentSpec, rt: AcpRuntime, opts: SpawnOptions): Promise<AcpSession> {
  const signal = opts.signal;
  if (signal?.aborted) throw new AbortError();
  // H1：Agent 不能在会话里换模型时，由 Gateway 要求在启动时指定模型
  const inherited = agentEnv(spec, opts.env ?? {});
  const lm = opts.launchModel && opts.model && spec.launchModel ? spec.launchModel(opts.model, inherited) : null;
  const env = { ...inherited, ...(lm?.env ?? {}) };
  const runSpec: AcpAgentSpec = lm?.args?.length ? { ...spec, launch: (e) => { const l = spec.launch(e); return { ...l, args: [...l.args, ...lm.args!] }; } } : spec;
  const holder: { session: AcpSession | null } = { session: null };
  let conn: AcpConnection | null = null;
  // 用户在启动期间点了 [停止]：立即结束进程，不用等启动超时
  const onAbort = () => { void conn?.kill(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const start = async () => {
    const c = await startConnection(runSpec, rt, { cwd: opts.cwd, env, redact: opts.redact ?? [], ...(opts.sessionLabel ? { label: opts.sessionLabel } : {}), holder, ...(signal ? { signal } : {}) });
    conn = c;
    if (signal?.aborted) { await c.kill(); throw new AbortError(); }
    return c;
  };
  try {
    return await spawnInner(spec, rt, opts, start, holder, lm ? opts.model : null);
  } catch (e) {
    if (signal?.aborted) {
      await (conn as AcpConnection | null)?.kill().catch(() => {});
      throw new AbortError();
    }
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

async function spawnInner(spec: AcpAgentSpec, rt: AcpRuntime, opts: SpawnOptions, start: () => Promise<AcpConnection>, holder: { session: AcpSession | null }, launchedModel: string | null): Promise<AcpSession> {
  let conn = await start();
  let session = new AcpSession(spec, conn, opts, rt);
  session.launchedModel = launchedModel;
  holder.session = session;
  const fail = async (e: unknown): Promise<never> => {
    await conn.kill().catch(() => {});
    throw classifyError(e, spec.kind, spec.displayName, opts.redact ?? []);
  };

  let failure: string | null = null;
  if (opts.resume) {
    try {
      const ok = await session.tryResume(opts.resume.agentSessionId);
      if (!ok) failure = `${spec.displayName} 不支持恢复会话`;
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const err = classifyError(e, spec.kind, spec.displayName, opts.redact ?? []);
      if (err.reason === 'auth' || err.reason === 'quota') return fail(err);
      // 会话不存在（例如从没 prompt 过的会话）、恢复超时或其他错误：新建会话
      failure = isNotFound(e) || err.reason === 'not_found' ? '原来的会话已经不存在' : `恢复失败（${err.body.message}）`;
      rt.log('warn', `[agent:${spec.kind}] 恢复会话失败，改为新建：${failure}`);
      if (conn.isClosed) {
        conn = await start();
        session = new AcpSession(spec, conn, opts, rt);
        session.launchedModel = launchedModel;
        holder.session = session;
      }
    }
  }
  if (!session.resumed) {
    try { await session.newSession(); } catch (e) { return fail(e); }
    if (opts.resume) {
      session.resumeFailure = failure;
      session.notice('warn', `原来的会话无法恢复（${failure ?? '原因未知'}），已新建会话；Agent 不记得之前的对话。`);
    }
  }
  if (opts.signal?.aborted) { await conn.kill().catch(() => {}); throw new AbortError(); }
  try {
    await session.applyInitial();
  } catch (e) {
    // 权限模式设置不上：会话不能交给用户使用
    await session.close().catch(() => {});
    throw e;
  }
  return session;
}

/** 测试连接 / 探测会话（phase-1.md 6.6.2） */
export async function acpProbe(spec: AcpAgentSpec, rt: AcpRuntime, opts: ProbeOptions): Promise<ProbeResult> {
  const steps: ProbeStep[] = [];
  const t0 = () => Date.now();
  const step = (label: string, start: number, ok: boolean, detail?: string) => {
    steps.push({ ts: Date.now(), label, ok, ms: Date.now() - start, ...(detail ? { detail: redact(detail, opts.redact ?? []) } : {}) });
  };
  let s = t0();
  const env = agentEnv(spec, opts.env);
  try {
    const l = spec.launch(env);
    step('找到引擎', s, true, l.entry ?? l.command ?? '');
  } catch (e) {
    const err = classifyError(e, spec.kind, spec.displayName);
    step('找到引擎', s, false, err.body.hint ?? err.body.message);
    return { ok: false, steps, caps: null, config: null, authMethods: null, error: err.body };
  }
  let text = '';
  const host: SessionHost = {
    update: (u) => { if (u.kind === 'message') text += u.text; },
    // 测试时不执行任何需要审批的操作
    requestPermission: async (req) => {
      const r = req.options.find((o) => o.kind.startsWith('reject'));
      return r ? { outcome: 'selected', optionId: r.id } : { outcome: 'cancelled' };
    },
  };
  const holder: { session: AcpSession | null } = { session: null };
  s = t0();
  let conn: AcpConnection;
  try {
    conn = await startConnection(spec, rt, { cwd: opts.cwd, env, redact: opts.redact ?? [], label: 'probe', holder });
    step('启动并握手（initialize）', s, true);
  } catch (e) {
    const err = classifyError(e, spec.kind, spec.displayName, opts.redact ?? []);
    step('启动并握手（initialize）', s, false, err.body.message);
    return { ok: false, steps, caps: null, config: null, authMethods: null, error: err.body };
  }
  const authMethods = spec.authMethodsFromInit?.(conn.initResult) ?? null;
  const session = new AcpSession(spec, conn, {
    cwd: opts.cwd, model: null, effort: null, permission: 'readonly', host, ...(opts.profile ? { profile: opts.profile } : {}),
    env: opts.env, redact: opts.redact ?? [], sessionLabel: 'probe',
  }, rt);
  holder.session = session;
  let error: ProbeResult['error'];
  let ok = true;
  try {
    s = t0();
    try {
      await session.newSession();
      step('新建会话（session/new）', s, true);
    } catch (e) {
      const err = classifyError(e, spec.kind, spec.displayName, opts.redact ?? []);
      step('新建会话（session/new）', s, false, err.body.message);
      error = err.body;
      ok = false;
    }
    if (ok) {
      s = t0();
      const st = session.config();
      step('读取模型列表', s, true, `${st.models.length} 个模型${st.efforts ? `，思考强度 ${st.efforts.join(' / ')}` : '，不能调节思考强度'}`);
      if (opts.sendMessage) {
        s = t0();
        session.ready();
        try {
          await session.setPermission('readonly').catch(() => {});
          const r = await session.prompt({ text: '这是连接测试，请只回复 OK，不要做任何其他事情。' }, new AbortController().signal);
          step('发送测试消息', s, r.stopReason === 'end_turn', `回复：${text.trim().slice(0, 200) || '（空）'}`);
          if (r.stopReason !== 'end_turn') ok = false;
        } catch (e) {
          const err = classifyError(e, spec.kind, spec.displayName, opts.redact ?? []);
          step('发送测试消息', s, false, err.body.message);
          error = err.body;
          ok = false;
        }
      }
    }
  } finally {
    s = t0();
    await session.close().catch(() => {});
    step('关闭会话', s, true);
  }
  return { ok, steps, caps: ok || session.agentSessionId ? session.caps : null, config: session.agentSessionId ? session.config() : null, authMethods, ...(error ? { error } : {}) };
}
