// WebSocket：/api/v1/ws。客户端发 ClientOp，服务端回 ServerFrame。
// 连接后先 subscribe{lastSeq}：补发 seq > lastSeq 的事件 → 一帧 replayed → 实时事件。
// 每条 op 都回 ack；同一设备重复的 id 返回第一次的结果、不重复执行（保留最近 1000 个）。
// 去重缓存只在内存里：服务重启后由客户端根据 replayed.bootId 判断，不按原 id 重发断线前未确认的指令。
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { z } from 'zod';
import {
  API_BASE, ClientOp, ErrorCode, WS_CLOSE_UNAUTHORIZED, WS_SUBPROTOCOL,
  type ApproveResult, type CancelResult, type EventEnvelope, type PingResult, type PromptResult,
  type ServerFrame, type SubscribeResult, type SwitchResult,
} from '@aic/protocol';
import { KEY_HEADER_LC } from './auth';
import type { Services } from './services';
import { toApiError, zodMessage } from './util';

const WS_PATH = `${API_BASE}/ws`;
const DEDUPE_LIMIT = 1000;
const REPLAY_BATCH = 500;
/** 补发时发送缓冲超过这个值就等它写出去再读下一批（背压），补发阶段不会因为积压大而被断开 */
const REPLAY_HIGH_WATER = 1024 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024; // 实时推送阶段客户端太慢时断开，让它重连补发
const HEARTBEAT_MS = 30_000;
/** 任务过滤时仍然推送的事件（侧栏、审批提醒） */
const ALWAYS = new Set(['task.created', 'task.updated', 'approval.requested', 'approval.resolved']);

type AckFrame = Extract<ServerFrame, { kind: 'ack' }>;
type OpResult = z.infer<typeof SubscribeResult> | z.infer<typeof PingResult> | z.infer<typeof PromptResult>
  | z.infer<typeof CancelResult> | z.infer<typeof ApproveResult> | z.infer<typeof SwitchResult>;

/** 最近 N 个 op 的结果（按插入顺序淘汰） */
class OpCache {
  private map = new Map<string, Promise<AckFrame>>();
  get(k: string) { return this.map.get(k); }
  set(k: string, v: Promise<AckFrame>) {
    this.map.set(k, v);
    while (this.map.size > DEDUPE_LIMIT) this.map.delete(this.map.keys().next().value!);
  }
}

function reject(socket: Duplex, status: number, text: string) {
  const body = JSON.stringify({ code: status === 401 ? ErrorCode.Unauthorized : ErrorCode.ForbiddenOrigin, message: text, actions: [] });
  socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Forbidden'}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
  socket.destroy();
}

/** 等发送缓冲降下来；连接关闭时返回 false */
async function drained(ws: WebSocket, limit: number): Promise<boolean> {
  while (ws.readyState === ws.OPEN && ws.bufferedAmount > limit) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return ws.readyState === ws.OPEN;
}

export function attachWs(server: Server, s: Services) {
  const wss = new WebSocketServer({
    noServer: true, maxPayload: 2 * 1024 * 1024,
    // 浏览器经子协议传凭据；只回选固定的协议名，不把凭据回显在响应头里
    handleProtocols: (protocols) => (protocols.has(WS_SUBPROTOCOL) ? WS_SUBPROTOCOL : false),
  });
  const cache = new OpCache();
  const byDevice = new Map<string, Set<WebSocket>>();
  let connSeq = 0;

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== WS_PATH) return reject(socket, 403, '没有这个地址');
    // 握手同样校验 Host / Origin / 凭据
    if (!s.auth.checkHost(req.headers.host)) return reject(socket, 403, '访问地址不正确');
    if (!s.auth.checkOrigin(req.headers.origin)) return reject(socket, 403, '拒绝了来自其他网页的连接');
    const ip = req.socket.remoteAddress ?? '';
    const key = req.headers[KEY_HEADER_LC];
    const device = s.auth.authenticate({
      cookie: req.headers.cookie, authorization: req.headers.authorization,
      key: typeof key === 'string' ? key : null, protocols: req.headers['sec-websocket-protocol'],
    }, ip);
    if (!device) return reject(socket, 401, '还没有连接到 AI Console');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, device.id));
  });

  s.auth.onRevoke((deviceId) => {
    for (const ws of byDevice.get(deviceId) ?? []) ws.close(WS_CLOSE_UNAUTHORIZED, 'revoked');
  });

  function onConnection(ws: WebSocket, deviceId: string) {
    const connId = ++connSeq;
    let set = byDevice.get(deviceId);
    if (!set) { set = new Set(); byDevice.set(deviceId, set); }
    set.add(ws);

    // 订阅状态：live 之前不推实时事件；lastSent 防止补发和实时之间重复
    let live = false;
    let filter: Set<string> | null = null;
    let lastSent = 0;
    let alive = true;
    /** 每次 subscribe 加一；旧的补发循环看到代数变了就停 */
    let generation = 0;

    const sendNow = (f: ServerFrame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)); };
    const send = (f: ServerFrame) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
      ws.send(JSON.stringify(f));
    };
    const wants = (e: EventEnvelope) => !filter || e.taskId === null || filter.has(e.taskId) || ALWAYS.has(e.type);

    const off = s.events.bus.on((e) => {
      if (!live || e.seq <= lastSent) return;
      lastSent = e.seq;
      if (wants(e)) send({ kind: 'event', event: e });
    });

    /**
     * 补发：分批读库发送，每批之后按背压等待缓冲写出。
     * 最后一批（不足一批）的读取、取 upToSeq、切到实时是在同一个同步段里完成的，期间不会有新事件插进来。
     */
    const subscribe = async (lastSeq: number, taskIds?: string[]) => {
      const gen = ++generation;
      live = false;
      filter = taskIds ? new Set(taskIds) : null;
      let after = lastSeq;
      for (;;) {
        const batch = s.events.read({ after, limit: REPLAY_BATCH });
        for (const e of batch) if (wants(e)) sendNow({ kind: 'event', event: e });
        if (batch.length < REPLAY_BATCH) break;
        after = batch[batch.length - 1]!.seq;
        if (!(await drained(ws, REPLAY_HIGH_WATER)) || gen !== generation) return { upToSeq: after };
      }
      const upToSeq = s.events.lastSeq();
      // 补发只读了 > lastSeq 的数据；实时阈值就是库里当前最大 seq，不能用客户端的 lastSeq 抬高
      lastSent = upToSeq;
      live = true;
      // 客户端的 lastSeq 比库里还大：数据库被重置或换了，让客户端清空本地状态重新拉快照
      const reset = lastSeq > upToSeq;
      sendNow({ kind: 'replayed', upToSeq, bootId: s.bootId, ...(reset ? { reset } : {}) });
      return { upToSeq };
    };

    const exec = async (op: ClientOp): Promise<OpResult> => {
      switch (op.op) {
        case 'subscribe': return subscribe(op.data.lastSeq, op.data.taskIds);
        case 'ping': { send({ kind: 'pong', ts: Date.now() }); const r: z.infer<typeof PingResult> = {}; return r; }
        case 'prompt': return s.tasks.prompt(op.data.taskId, op.data.text);
        case 'cancel': { await s.tasks.cancel(op.data.taskId); const r: z.infer<typeof CancelResult> = { taskId: op.data.taskId }; return r; }
        case 'approve': return { approval: await s.tasks.approve(op.data.approvalId, op.data.optionId, op.data.note, deviceId) };
        case 'switch': return { task: await s.tasks.switch(op.data.taskId, op.data) };
      }
    };

    ws.on('message', async (raw, isBinary) => {
      if (isBinary) return;
      let json: unknown;
      try { json = JSON.parse(raw.toString()); } catch { json = undefined; }
      const parsed = ClientOp.safeParse(json);
      if (!parsed.success) {
        const id = typeof (json as { id?: unknown })?.id === 'string' ? (json as { id: string }).id : '?';
        send({ kind: 'ack', id, ok: false, error: { code: ErrorCode.BadRequest, message: zodMessage(parsed.error.issues), actions: [] } });
        return;
      }
      const op = parsed.data;
      // 订阅和心跳只对当前连接有意义，去重范围限于本连接；其他指令按设备去重（重连后重发也不会重复执行）
      const key = op.op === 'subscribe' || op.op === 'ping' ? `c${connId}:${op.id}` : `d${deviceId}:${op.id}`;
      let p = cache.get(key);
      if (!p) {
        p = exec(op).then(
          (result): AckFrame => ({ kind: 'ack', id: op.id, ok: true, result }),
          (e): AckFrame => {
            const { status, body } = toApiError(e);
            if (status >= 500) console.error('[ws] 处理指令出错', op.op, e);
            return { kind: 'ack', id: op.id, ok: false, error: body };
          },
        );
        cache.set(key, p);
      }
      send(await p);
    });

    ws.on('pong', () => { alive = true; });
    const hb = setInterval(() => {
      if (!alive) { ws.terminate(); return; }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    hb.unref();

    ws.on('close', () => {
      clearInterval(hb);
      off();
      generation++;
      set!.delete(ws);
      if (set!.size === 0) byDevice.delete(deviceId);
    });
    ws.on('error', () => { /* close 会随后触发 */ });
  }

  return {
    close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
  };
}
