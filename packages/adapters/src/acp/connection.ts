// AcpConnection：Agent 进程 + ACP 客户端 + 超时 + stderr（phase-1.md 6.2.1）。三家共用。
//
// 为什么自己做 NDJSON 编解码，而不用 SDK 的 ndJsonStream：
// - SDK 收到非 JSON 行会回给 Agent 一个 -32700 错误；规格要求只记警告、跳过该行。
// - SDK 的客户端会用严格的 schema 校验每条 session/update，不认识的类型直接丢弃并打印错误；
//   规格要求“未知类型只计数”。所以通知（session/update、私有通知）在进入 SDK 之前就分流给我们自己处理，
//   请求（session/request_permission 等）仍交给 SDK，用 '*' 宽松接收，回应走 SDK。
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import * as acp from '@agentclientprotocol/sdk/unstable';
import type { AgentKind } from '@aic/protocol';
import { clip, redact } from '../redact';
import type { LogFn, ProcessTracker } from '../types';
import { AgentError } from '../types';
import { isRecord, withTimeout } from '../util';
import { descendants, isAlive, killTree, spawnAgent, type LaunchSpec } from './launch';
import { agentErrors } from './errors';

export interface AcpTimeouts {
  /** 进程启动到 initialize 返回 */
  initialize: number;
  /** session/new、session/resume、session/load */
  session: number;
  /** set_config_option / set_mode */
  config: number;
  /** 用户点 [停止] 后等 session/prompt 返回的时间，超时结束进程树 */
  cancel: number;
  /** 关闭 stdin 后等进程自己退出 */
  closeGrace: number;
  /** 结束进程后再等多久 */
  killGrace: number;
}
export const DEFAULT_TIMEOUTS: AcpTimeouts = { initialize: 30_000, session: 60_000, config: 15_000, cancel: 10_000, closeGrace: 3_000, killGrace: 2_000 };

/** 单行 NDJSON 的上限（超过就丢弃这一行并记警告） */
const MAX_LINE = 64 * 1024 * 1024;
const STDERR_LINE_MAX = 2000;
const STDERR_TAIL = 200;

export interface AcpConnectionOptions {
  kind: AgentKind;
  displayName: string;
  launch: LaunchSpec;
  cwd: string;
  /** 已经清理并叠加过的完整环境变量 */
  env: Record<string, string>;
  /** 需要脱敏的原文（本次注入的密钥） */
  redact?: string[];
  log: LogFn;
  /** 日志前缀里的会话标识 */
  label?: string;
  tracker?: ProcessTracker;
  sessionLabel?: string | null;
  timeouts?: Partial<AcpTimeouts>;
  clientCapabilities?: Record<string, unknown>;
  /** session/update 的原始 params（宽松，不做 schema 校验） */
  onSessionUpdate?: (params: Record<string, unknown>) => void;
  /** 其他通知（私有扩展等） */
  onNotification?: (method: string, params: unknown) => void;
  /** Agent 发来的请求；只处理 session/request_permission，其余回 -32601 */
  onPermission?: (params: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  /** 启动（initialize）期间取消：立即结束进程树 */
  signal?: AbortSignal;
}

export type ExitInfo = { code: number | null; signal: string | null; stderrTail: string[]; killed?: boolean };

export class AcpConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pid: number | null;
  readonly timeouts: AcpTimeouts;
  initResult: Record<string, unknown> = {};
  private conn: acp.ClientConnection;
  private tail: string[] = [];
  private closing = false;
  /** 由 kill() 结束（而不是 close() 主动关闭） */
  private killed = false;
  private exited = false;
  private exitInfo: ExitInfo | null = null;
  private exitCbs: ((i: ExitInfo) => void)[] = [];
  private exitPromise: Promise<void>;
  private updateHandler: ((p: Record<string, unknown>) => void) | null = null;
  private buffered: Record<string, unknown>[] = [];
  private secrets: string[];
  private prefix: string;

  private constructor(private opts: AcpConnectionOptions) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    this.secrets = opts.redact ?? [];
    this.prefix = `[agent:${opts.kind}${opts.label ? `:${opts.label}` : ''}]`;
    if (opts.onSessionUpdate) this.updateHandler = opts.onSessionUpdate;
    // 日志里只写入口、参数和环境变量的名字，不写值
    opts.log('info', `${this.prefix} 启动 ${opts.launch.entry ?? opts.launch.command ?? ''} ${opts.launch.args.join(' ')}（注入变量：${Object.keys(opts.env).filter((k) => !(k in process.env) || process.env[k] !== opts.env[k]).join(', ') || '无'}）`);
    this.child = spawnAgent(opts.launch, { cwd: opts.cwd, env: opts.env });
    this.pid = this.child.pid ?? null;
    if (this.pid) opts.tracker?.started({ pid: this.pid, agent: opts.kind, sessionId: opts.sessionLabel ?? null, startedAt: Date.now() });

    this.exitPromise = new Promise<void>((resolve) => {
      const done = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exited) return;
        this.exited = true;
        if (this.pid) opts.tracker?.exited(this.pid);
        this.exitInfo = { code, signal, stderrTail: [...this.tail], ...(this.killed ? { killed: true } : {}) };
        if (!this.closing) opts.log('warn', `${this.prefix} 进程意外退出 code=${code} signal=${signal}；stderr 最后 ${this.tail.length} 行：\n${this.tail.join('\n')}`);
        // 意外退出、或被 kill() 结束（取消无响应、模式改不回来）：都通知上层释放名额、记会话结束；close() 主动关闭不通知
        if (!this.closing || this.killed) {
          for (const cb of this.exitCbs) { try { cb(this.exitInfo); } catch { /* 忽略 */ } }
        }
        try { this.conn?.close(new Error('Agent 进程已退出')); } catch { /* 忽略 */ }
        resolve();
      };
      this.child.on('exit', done);
      this.child.on('error', (e) => {
        opts.log('error', `${this.prefix} 进程出错：${redact(e.message, this.secrets)}`);
        done(null, null);
      });
    });
    // 三条管道的 error 由 spawnAgent 统一兜底（ISSUE-0052）；这里再记一条日志便于排查，不影响收尾
    this.child.stdin.on('error', () => { /* 进程退出后写入会 EPIPE，忽略 */ });
    this.child.stdout.on('error', (e) => opts.log('warn', `${this.prefix} stdout 管道出错：${redact(e.message, this.secrets)}`));
    this.child.stderr.on('error', (e) => opts.log('warn', `${this.prefix} stderr 管道出错：${redact(e.message, this.secrets)}`));
    this.readStderr();
    this.conn = this.connect();
  }

  /** 启动进程并完成 initialize */
  static async start(opts: AcpConnectionOptions): Promise<AcpConnection> {
    const c = new AcpConnection(opts);
    // 握手期间用户点了 [停止]：立即结束进程树，不用等 initialize 超时（30 秒）
    const onAbort = () => { void c.kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (opts.signal?.aborted) throw new Error('已取消');
      const init = await c.request<Record<string, unknown>>('initialize', {
        protocolVersion: 1,
        clientCapabilities: opts.clientCapabilities ?? { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'ai-console', title: 'AI Console', version: '0.1.0' },
      }, c.timeouts.initialize, 'start');
      c.initResult = isRecord(init) ? init : {};
      return c;
    } catch (e) {
      await c.kill();
      throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  get displayName() { return this.opts.displayName; }
  get kind() { return this.opts.kind; }
  get isClosed() { return this.closing || this.exited; }
  get stderrTail() { return [...this.tail]; }
  get redactList() { return this.secrets; }

  /** 设置 session/update 的处理函数；之前收到的会按顺序补发 */
  setUpdateHandler(fn: (p: Record<string, unknown>) => void) {
    this.updateHandler = fn;
    const b = this.buffered;
    this.buffered = [];
    for (const p of b) fn(p);
  }

  onExit(cb: (i: ExitInfo) => void) { this.exitCbs.push(cb); }

  /**
   * 发请求。timeoutMs 为 0 表示不设超时。phase 决定超时后的处理：
   * start（启动或会话建立）超时 → 结束进程树并报 agent.start_timeout；其他阶段只报超时错误。
   */
  async request<T = unknown>(method: string, params: unknown, timeoutMs: number, phase: 'start' | 'session' | 'other' = 'other', signal?: AbortSignal): Promise<T> {
    if (this.exited) throw agentErrors.crashed(this.opts.kind, this.opts.displayName);
    const p = this.conn.agent.request<T>(method, params, signal ? { cancellationSignal: signal } : undefined);
    try {
      return await withTimeout(p, timeoutMs, () => (phase === 'other'
        ? agentErrors.timeout(this.opts.kind, this.opts.displayName, method)
        : agentErrors.startTimeout(this.opts.kind, this.opts.displayName, method)),
      phase === 'other' ? undefined : () => { void this.kill(); });
    } catch (e) {
      if (e instanceof AgentError) throw e;
      // 进程已经退出：请求是因为连接关闭而失败的
      if (this.exited && !this.closing) throw agentErrors.crashed(this.opts.kind, this.opts.displayName);
      throw e;
    }
  }

  notify(method: string, params: unknown): void {
    if (this.exited) return;
    void this.conn.agent.notify(method, params).catch(() => {});
  }

  /**
   * 正常关闭：关闭 stdin → 等 closeGrace → 结束进程树 → 再等 killGrace → 结束关闭前快照里还活着的子孙进程。
   * 调用方需要的话，先自行发 session/close。
   */
  async close(): Promise<void> {
    if (this.closing) { await this.exitPromise; return; }
    this.closing = true;
    const pid = this.pid;
    const snapshot = pid && !this.exited ? await descendants(pid).catch(() => []) : [];
    try { this.conn.close(); } catch { /* 忽略 */ }
    try { this.child.stdin.end(); } catch { /* 忽略 */ }
    if (!this.exited) await Promise.race([this.exitPromise, delay(this.timeouts.closeGrace)]);
    if (!this.exited && pid) {
      await killTree(pid);
      await Promise.race([this.exitPromise, delay(this.timeouts.killGrace)]);
    }
    for (const d of snapshot) if (isAlive(d)) await killTree(d);
    this.opts.log('info', `${this.prefix} 已关闭`);
  }

  /** 立即结束进程树（超时、取消无响应时用） */
  async kill(): Promise<void> {
    if (!this.closing) this.killed = true;
    this.closing = true;
    const pid = this.pid;
    const snapshot = pid && !this.exited ? await descendants(pid).catch(() => []) : [];
    try { this.conn.close(); } catch { /* 忽略 */ }
    if (pid && !this.exited) {
      await killTree(pid);
      await Promise.race([this.exitPromise, delay(this.timeouts.killGrace)]);
    }
    for (const d of snapshot) if (isAlive(d)) await killTree(d);
  }

  /** 等进程退出 */
  waitExit() { return this.exitPromise; }

  // ---------- 内部 ----------

  private readStderr() {
    const dec = new StringDecoder('utf8');
    let buf = '';
    const line = (raw: string) => {
      const l = clip(redact(raw.replace(/\r$/, ''), this.secrets), STDERR_LINE_MAX);
      if (!l.trim()) return;
      this.tail.push(l);
      if (this.tail.length > STDERR_TAIL) this.tail.shift();
      this.opts.log('debug', `${this.prefix} ${l}`);
    };
    this.child.stderr.on('data', (d: Buffer) => {
      buf += dec.write(d);
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      if (buf.length > STDERR_LINE_MAX * 4) { line(buf); buf = ''; }
    });
    this.child.stderr.on('end', () => { if (buf) line(buf); });
  }

  private connect(): acp.ClientConnection {
    const self = this;
    const dec = new StringDecoder('utf8');
    let buf = '';
    const readable = new ReadableStream<acp.AnyMessage>({
      start(controller) {
        const handle = (raw: string) => {
          const text = raw.trim();
          if (!text) return;
          let msg: unknown;
          try { msg = JSON.parse(text); } catch {
            self.opts.log('warn', `${self.prefix} stdout 出现非 JSON 行，已跳过：${clip(redact(text, self.secrets), 200)}`);
            return;
          }
          if (!isRecord(msg)) {
            self.opts.log('warn', `${self.prefix} stdout 出现非对象的 JSON，已跳过`);
            return;
          }
          // 通知（有 method、没有 id）：我们自己处理；协议层的 $/ 通知交给 SDK
          if (typeof msg.method === 'string' && !('id' in msg) && !msg.method.startsWith('$/')) {
            self.dispatchNotification(msg.method, msg.params);
            return;
          }
          controller.enqueue(msg as acp.AnyMessage);
        };
        self.child.stdout.on('data', (d: Buffer) => {
          buf += dec.write(d);
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
          if (buf.length > MAX_LINE) {
            self.opts.log('warn', `${self.prefix} stdout 单行超过上限，已丢弃`);
            buf = '';
          }
        });
        self.child.stdout.on('end', () => {
          if (buf) handle(buf);
          buf = '';
          try { controller.close(); } catch { /* 已关闭 */ }
        });
        self.child.stdout.on('error', (e) => { try { controller.error(e); } catch { /* 已关闭 */ } });
      },
    });
    const writable = new WritableStream<acp.AnyMessage>({
      write(msg) {
        return new Promise<void>((resolve) => {
          if (self.exited || self.child.stdin.destroyed || self.child.stdin.writableEnded) return resolve();
          self.child.stdin.write(`${JSON.stringify(msg)}\n`, () => resolve());
        });
      },
    });

    const app = acp.client({ name: 'ai-console' })
      .onRequest('*', async (ctx) => {
        if (ctx.method === 'session/request_permission' && this.opts.onPermission && isRecord(ctx.params)) {
          return this.opts.onPermission(ctx.params, ctx.signal);
        }
        // fs/*、terminal/* 没有声明；elicitation/* 本步不支持
        throw acp.RequestError.methodNotFound(ctx.method);
      })
      .onNotification('*', (ctx) => { this.dispatchNotification(ctx.method, ctx.params); });
    return app.connect({ readable, writable });
  }

  private dispatchNotification(method: string, params: unknown) {
    try {
      if (method === 'session/update') {
        if (!isRecord(params)) return;
        if (this.updateHandler) this.updateHandler(params);
        else this.buffered.push(params);
        return;
      }
      this.opts.onNotification?.(method, params);
    } catch (e) {
      this.opts.log('error', `${this.prefix} 处理通知 ${method} 出错：${redact(e instanceof Error ? e.message : String(e), this.secrets)}`);
    }
  }
}

const delay = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.(); });
