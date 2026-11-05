// WebSocket 客户端：/api/v1/ws
// - 连上后先发 subscribe{lastSeq}，服务端补发缺失事件并发一帧 replayed，之后推实时事件。
// - 每条指令带 id，等服务端 ack；超时报错。同一个 ack 只认第一次。
// - 断线自动重连，退避 0.5s → 1s → 2s … 最多 10s；重连时带上已收到的最大 seq。
// - 断线期间：已经发出、还没收到 ack 的指令，在重连并收到 replayed 后用同一个 id 重发（服务端按 id 去重，不会重复执行）；
//   但服务端的去重记录只在内存里：replayed.bootId 和上次不同（服务重启过）时不重发，而是以“服务已重启”拒绝，
//   由用户看了最新状态再决定。断线期间新发的指令直接拒绝（界面同时禁用发送）。
// - replayed.reset：服务端的数据库被重置了，交给上层清空本地事件状态、重新拉快照。
// - 凭据经子协议传递（浏览器的 WebSocket 不能加请求头），见 credentials.ts。
// - 服务端用 4401 关闭表示令牌失效或设备被吊销：不再重连，交给界面回到配对页。
import { ClientOp, ServerFrame, WS_CLOSE_UNAUTHORIZED, type ApiError, type EventEnvelope } from '@aic/protocol';
import { ApiRequestError, ClientErrorCode } from './http';
import { newOpId } from '../lib/ids';

/** 只用到浏览器 WebSocket 的这几样，测试里用假实现替换 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string, protocols?: string[]) => WebSocketLike;

export type ConnState =
  | 'idle'          // 还没开始
  | 'connecting'    // 第一次连接中
  | 'replaying'     // 已连上，正在补发事件
  | 'online'        // 实时
  | 'reconnecting'  // 断线，等待重连
  | 'unauthorized'  // 令牌失效，停止重连
  | 'stopped';      // 主动停止

type OpName = ClientOp['op'];
type OpData<N extends OpName> = Extract<ClientOp, { op: N }>['data'];

export interface WsClientOptions {
  url: string | (() => string);
  /** 握手时带的子协议（含凭据），每次连接时取最新值 */
  protocols?: () => string[];
  WebSocketImpl?: WebSocketCtor;
  /** 当前已收到的最大 seq（由 store 提供） */
  getLastSeq: () => number;
  onEvent: (ev: EventEnvelope) => void;
  onReplayed?: (upToSeq: number, info: { reset: boolean; bootId: string | null; restarted: boolean }) => void;
  onState?: (s: ConnState) => void;
  /** 每次连接失败（含握手失败）后回调，attempt 从 1 开始；界面可以借机用 /hello 检查是不是令牌失效了 */
  onConnectFailure?: (attempt: number) => void;
  ackTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** 心跳间隔；0 表示不发心跳 */
  heartbeatMs?: number;
  newId?: () => string;
}

interface Pending {
  frame: string;
  op: OpName;
  resolve: (v: unknown) => void;
  reject: (e: ApiRequestError) => void;
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

/** 订阅的 ack 要等补发全部发完才回来：积压大时可能很久，每收到一帧补发事件就重新计时 */
const SUBSCRIBE_IDLE_TIMEOUT_MS = 30_000;

const OPEN = 1;

export class WsClient {
  private readonly o: Required<Omit<WsClientOptions, 'onReplayed' | 'onState' | 'onConnectFailure' | 'WebSocketImpl' | 'protocols'>> & WsClientOptions;
  private ws: WebSocketLike | null = null;
  private _state: ConnState = 'idle';
  private pending = new Map<string, Pending>();
  /** 最近完成的 id（防止服务端重复 ack 时误触发）；保留最近 1000 个，与服务端一致 */
  private done = new Set<string>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private subscribeId: string | null = null;
  private everOnline = false;
  /** 上次 replayed 带来的服务启动标识 */
  private bootId: string | null = null;
  /** 本次连接打开时就在等 ack 的指令（断线前发出的），收到 replayed 后决定重发还是拒绝 */
  private carryOver: string[] = [];

  constructor(opts: WsClientOptions) {
    this.o = {
      ackTimeoutMs: 15_000, backoffMinMs: 500, backoffMaxMs: 10_000, heartbeatMs: 25_000, newId: () => newOpId(),
      ...opts,
    };
  }

  get state(): ConnState { return this._state; }
  /** 是否可以发指令（断线期间界面据此禁用发送） */
  get canSend(): boolean { return this._state === 'online' || this._state === 'replaying'; }

  start(): void {
    if (this._state !== 'idle' && this._state !== 'stopped' && this._state !== 'unauthorized') return;
    this.setState('connecting');
    this.open();
  }

  stop(): void {
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onopen = null; ws.onerror = null; try { ws.close(1000, 'client stop'); } catch { /* 忽略 */ } }
    this.failAll(offlineError('连接已关闭'));
    this.setState('stopped');
  }

  /** 发一条指令，等 ack。ack.ok=false 或超时时抛 ApiRequestError */
  request<N extends Exclude<OpName, 'subscribe'>>(op: N, data: OpData<N>): Promise<unknown> {
    if (!this.canSend) return Promise.reject(new ApiRequestError(offlineError()));
    return this.enqueue(op, data);
  }

  // ---------- 内部 ----------
  private enqueue(op: OpName, data: unknown, id = this.o.newId(), timeoutMs = this.o.ackTimeoutMs): Promise<unknown> {
    const msg = { id, op, data };
    // 发出去之前先按协议校验，避免把坏数据发给服务端
    const ok = ClientOp.safeParse(msg);
    if (!ok.success) {
      return Promise.reject(new ApiRequestError({ code: 'request.invalid', message: '指令内容不合法', hint: ok.error.issues[0]?.message, actions: [] }));
    }
    return new Promise((resolve, reject) => {
      const p: Pending = { frame: JSON.stringify(msg), op, resolve, reject, timer: setTimeout(() => {}, 0), timeoutMs };
      this.pending.set(id, p);
      this.arm(id);
      if (this.ws && this.ws.readyState === OPEN) this.ws.send(p.frame);
    });
  }

  /** （重新）开始等 ack 的计时 */
  private arm(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      if (this.pending.get(id) !== p) return;
      this.pending.delete(id);
      this.remember(id);
      p.reject(new ApiRequestError({
        code: ClientErrorCode.AckTimeout, message: '服务没有及时回应这条指令',
        hint: '它可能已经执行了。看一下对话里的最新状态再决定要不要重试。', actions: [],
      }));
    }, p.timeoutMs);
  }

  private open(): void {
    const Impl = this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketCtor | undefined);
    if (!Impl) throw new Error('当前环境没有 WebSocket');
    const url = typeof this.o.url === 'function' ? this.o.url() : this.o.url;
    let ws: WebSocketLike;
    try {
      ws = new Impl(url, this.o.protocols?.());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.setState('replaying');
      // 先订阅；断线前已发出、未确认的指令要等 replayed 确认服务没有重启过再按原 id 重发
      this.carryOver = [...this.pending.keys()];
      this.subscribeId = this.o.newId();
      const sub = this.enqueue('subscribe', { lastSeq: this.o.getLastSeq() }, this.subscribeId, SUBSCRIBE_IDLE_TIMEOUT_MS);
      sub.catch(() => { /* 订阅失败：关闭后走重连 */ if (this.ws === ws) ws.close(4000, 'subscribe failed'); });
      this.startHeartbeat();
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => { /* 浏览器随后会触发 onclose，在那里处理 */ };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      // 订阅本身不跨连接保留：新连接会重新订阅
      if (this.subscribeId) { const p = this.pending.get(this.subscribeId); if (p) { clearTimeout(p.timer); this.pending.delete(this.subscribeId); } this.subscribeId = null; }
      if (ev.code === WS_CLOSE_UNAUTHORIZED) {
        this.failAll({ code: 'auth.unauthorized', message: '这台设备的令牌已失效', hint: '重新配对后再试。', actions: [] });
        this.setState('unauthorized');
        return;
      }
      if (!opened || this._state !== 'online') this.o.onConnectFailure?.(this.attempt + 1);
      this.scheduleReconnect();
    };
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let json: unknown;
    try { json = JSON.parse(raw); } catch { return; }
    const parsed = ServerFrame.safeParse(json);
    if (!parsed.success) {
      console.warn('[ws] 忽略无法识别的消息', parsed.error.issues[0]);
      return;
    }
    const f = parsed.data;
    switch (f.kind) {
      case 'event':
        // 补发期间每来一帧都说明服务在工作，订阅的等待重新计时
        if (this._state === 'replaying' && this.subscribeId) this.arm(this.subscribeId);
        this.o.onEvent(f.event);
        break;
      case 'replayed': {
        this.attempt = 0;
        this.everOnline = true;
        const bootId = f.bootId ?? null;
        const restarted = !!(this.bootId && bootId && bootId !== this.bootId);
        if (bootId) this.bootId = bootId;
        const carry = this.carryOver;
        this.carryOver = [];
        for (const id of carry) {
          const p = this.pending.get(id);
          if (!p) continue;
          if (restarted) {
            // 服务重启过：去重记录已经没了，按原 id 重发可能重复执行
            clearTimeout(p.timer);
            this.pending.delete(id);
            this.remember(id);
            p.reject(new ApiRequestError({
              code: ClientErrorCode.ServerRestarted, message: '服务已重启，这条指令可能没有执行',
              hint: '请看对话里的最新状态，确认是否需要再操作一次。', actions: [],
            }));
          } else if (this.ws && this.ws.readyState === OPEN) {
            this.ws.send(p.frame);
          }
        }
        this.setState('online');
        this.o.onReplayed?.(f.upToSeq, { reset: !!f.reset, bootId, restarted });
        break;
      }
      case 'ack': {
        const p = this.pending.get(f.id);
        if (!p) return; // 已处理过（重复 ack）或不是我们发的
        clearTimeout(p.timer);
        this.pending.delete(f.id);
        this.remember(f.id);
        if (f.ok) p.resolve(f.result);
        else p.reject(new ApiRequestError(f.error ?? { code: 'server.internal', message: '指令没有执行成功', actions: [] }));
        break;
      }
      case 'pong':
        break;
    }
  }

  private remember(id: string) {
    this.done.add(id);
    if (this.done.size > 1000) {
      const first = this.done.values().next().value;
      if (first !== undefined) this.done.delete(first);
    }
  }

  /** 已完成的 id（测试用） */
  hasCompleted(id: string): boolean { return this.done.has(id); }
  /** 等待 ack 的指令数（测试用） */
  get pendingCount(): number { return this.pending.size; }

  private scheduleReconnect() {
    if (this._state === 'stopped' || this._state === 'unauthorized') return;
    // 第一次连接就失败时保持“连接中”，之后都算“正在重新连接”
    this.setState(this.everOnline || this.attempt > 0 ? 'reconnecting' : 'connecting');
    const delay = Math.min(this.o.backoffMaxMs, this.o.backoffMinMs * 2 ** this.attempt);
    this.attempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.open(); }, delay);
  }

  /** 心跳：长时间没有回应说明连接已半死，主动断开触发重连 */
  private startHeartbeat() {
    this.stopHeartbeat();
    if (!this.o.heartbeatMs) return;
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || this._state !== 'online') return;
      this.enqueue('ping', {}).catch((e: ApiRequestError) => {
        if (e.code === ClientErrorCode.AckTimeout && this.ws === ws) ws.close(4000, 'heartbeat timeout');
      });
    }, this.o.heartbeatMs);
  }
  private stopHeartbeat() { if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; } }
  private clearTimers() {
    this.stopHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private failAll(err: ApiError) {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new ApiRequestError(err)); this.remember(id); }
    this.pending.clear();
  }

  private setState(s: ConnState) {
    if (this._state === s) return;
    this._state = s;
    this.o.onState?.(s);
  }
}

function offlineError(message = '和 AI Console 服务的连接断开了'): ApiError {
  return { code: ClientErrorCode.Offline, message, hint: '正在自动重新连接，恢复后再发送。', actions: [] };
}
