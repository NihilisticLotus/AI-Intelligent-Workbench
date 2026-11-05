// WebSocket 客户端测试：重连带 lastSeq、ack 去重、断线期间的指令处理、退避、4401 不重连。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@aic/protocol';
import { WsClient, type ConnState, type WebSocketLike } from './ws';
import { ApiRequestError, ClientErrorCode } from './http';

class FakeWs implements WebSocketLike {
  static all: FakeWs[] = [];
  readyState = 0;
  sent: Array<{ id: string; op: string; data: Record<string, unknown> }> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) { FakeWs.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.drop(code); }
  // ---- 测试控制 ----
  open() { this.readyState = 1; this.onopen?.({}); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  frame(f: unknown) { this.onmessage?.({ data: JSON.stringify(f) }); }
  ack(id: string, ok = true, result?: unknown) { this.frame({ kind: 'ack', id, ok, result }); }
  last(op: string) { return [...this.sent].reverse().find((m) => m.op === op)!; }
}

const ev = (seq: number): EventEnvelope => ({
  seq, ts: 1000 + seq, taskId: 't1', sessionId: 's1', type: 'message.delta', data: { messageId: 'm1', text: String(seq) },
});

let ids = 0;
function setup(extra: Partial<ConstructorParameters<typeof WsClient>[0]> = {}) {
  let lastSeq = 0;
  const events: EventEnvelope[] = [];
  const states: ConnState[] = [];
  const client = new WsClient({
    url: 'ws://127.0.0.1:17890/api/v1/ws',
    WebSocketImpl: FakeWs,
    getLastSeq: () => lastSeq,
    onEvent: (e) => { events.push(e); lastSeq = Math.max(lastSeq, e.seq); },
    onState: (s) => states.push(s),
    heartbeatMs: 0,
    ackTimeoutMs: 5000,
    newId: () => `c_${++ids}`,
    ...extra,
  });
  return { client, events, states, setLastSeq: (n: number) => { lastSeq = n; } };
}

/** 打开连接并完成订阅与补发 */
function goOnline(w: FakeWs, upTo = 0) {
  w.open();
  const sub = w.last('subscribe');
  w.ack(sub.id, true, { upToSeq: upTo });
  w.frame({ kind: 'replayed', upToSeq: upTo });
}

beforeEach(() => { FakeWs.all = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('WsClient 连接与重连', () => {
  it('连接后先发 subscribe{lastSeq}，收到 replayed 后进入 online', () => {
    const { client, states, setLastSeq } = setup();
    setLastSeq(42);
    client.start();
    const w = FakeWs.all[0]!;
    w.open();
    expect(w.sent[0]).toMatchObject({ op: 'subscribe', data: { lastSeq: 42 } });
    expect(client.state).toBe('replaying');
    w.frame({ kind: 'replayed', upToSeq: 42 });
    expect(client.state).toBe('online');
    expect(states).toEqual(['connecting', 'replaying', 'online']);
  });

  it('断线后自动重连，并带上已收到的最大 seq', () => {
    const { client, events } = setup();
    client.start();
    const w1 = FakeWs.all[0]!;
    goOnline(w1);
    w1.frame({ kind: 'event', event: ev(1) });
    w1.frame({ kind: 'event', event: ev(2) });
    w1.frame({ kind: 'event', event: ev(3) });
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);

    w1.drop();
    expect(client.state).toBe('reconnecting');
    expect(FakeWs.all).toHaveLength(1);
    vi.advanceTimersByTime(500); // 第一次退避 0.5 秒
    const w2 = FakeWs.all[1]!;
    w2.open();
    expect(w2.last('subscribe').data).toEqual({ lastSeq: 3 });
  });

  it('退避时间翻倍，最多 10 秒；恢复后归零', () => {
    const { client } = setup();
    client.start();
    FakeWs.all[0]!.drop();
    const delays = [500, 1000, 2000, 4000, 8000, 10000, 10000];
    for (const [i, d] of delays.entries()) {
      vi.advanceTimersByTime(d - 1);
      expect(FakeWs.all).toHaveLength(i + 1);
      vi.advanceTimersByTime(1);
      expect(FakeWs.all).toHaveLength(i + 2);
      if (i < delays.length - 1) FakeWs.all[i + 1]!.drop();
    }
    goOnline(FakeWs.all.at(-1)!);
    FakeWs.all.at(-1)!.drop();
    vi.advanceTimersByTime(500);
    expect(FakeWs.all).toHaveLength(delays.length + 2);
  });

  it('服务端用 4401 关闭时不再重连', () => {
    const { client } = setup();
    client.start();
    goOnline(FakeWs.all[0]!);
    FakeWs.all[0]!.drop(4401);
    expect(client.state).toBe('unauthorized');
    vi.advanceTimersByTime(60_000);
    expect(FakeWs.all).toHaveLength(1);
  });
});

describe('WsClient 指令与 ack', () => {
  it('每条指令带 id，ack 成功后返回 result', async () => {
    const { client } = setup();
    client.start();
    const w = FakeWs.all[0]!;
    goOnline(w);
    const p = client.request('prompt', { taskId: 't1', text: '你好' });
    const sent = w.last('prompt');
    expect(sent.id).toMatch(/^c_/);
    w.ack(sent.id, true, { taskId: 't1', messageId: 'm9' });
    await expect(p).resolves.toEqual({ taskId: 't1', messageId: 'm9' });
  });

  it('同一个 id 的重复 ack 只生效一次', async () => {
    const { client } = setup();
    client.start();
    const w = FakeWs.all[0]!;
    goOnline(w);
    const resolved = vi.fn();
    const p = client.request('cancel', { taskId: 't1' }).then(resolved);
    const id = w.last('cancel').id;
    w.ack(id, true, 'first');
    w.ack(id, false); // 重复的 ack：应被忽略
    w.ack(id, true, 'second');
    await p;
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(resolved).toHaveBeenCalledWith('first');
    expect(client.hasCompleted(id)).toBe(true);
    expect(client.pendingCount).toBe(0);
  });

  it('ack.ok=false 时抛出带 ApiError 的异常', async () => {
    const { client } = setup();
    client.start();
    const w = FakeWs.all[0]!;
    goOnline(w);
    const p = client.request('prompt', { taskId: 't1', text: 'x' });
    w.frame({ kind: 'ack', id: w.last('prompt').id, ok: false, error: { code: 'task.invalid_state', message: '任务正在执行', actions: [] } });
    await expect(p).rejects.toMatchObject({ error: { code: 'task.invalid_state' } });
  });

  it('ack 超时后报错', async () => {
    const { client } = setup();
    client.start();
    goOnline(FakeWs.all[0]!);
    const p = client.request('prompt', { taskId: 't1', text: 'x' });
    const assertion = expect(p).rejects.toMatchObject({ error: { code: ClientErrorCode.AckTimeout } });
    vi.advanceTimersByTime(5000);
    await assertion;
  });

  it('断线期间新发的指令直接拒绝，不排队', async () => {
    const { client } = setup();
    client.start();
    const w = FakeWs.all[0]!;
    goOnline(w);
    w.drop();
    expect(client.canSend).toBe(false);
    const p = client.request('prompt', { taskId: 't1', text: '断线时发的' });
    await expect(p).rejects.toBeInstanceOf(ApiRequestError);
    await expect(p).rejects.toMatchObject({ error: { code: ClientErrorCode.Offline } });
    vi.advanceTimersByTime(500);
    const w2 = FakeWs.all[1]!;
    goOnline(w2);
    expect(w2.sent.some((m) => m.op === 'prompt')).toBe(false);
  });

  it('已发出未确认的指令在重连后（同一次服务启动）用同一个 id 重发，由服务端去重', async () => {
    const { client } = setup();
    client.start();
    const w1 = FakeWs.all[0]!;
    w1.open();
    w1.frame({ kind: 'replayed', upToSeq: 0, bootId: 'boot-1' });
    const p = client.request('approve', { approvalId: 'a1', optionId: 'allow' });
    const id = w1.last('approve').id;
    w1.drop(); // ack 还没回来就断了
    vi.advanceTimersByTime(500);
    const w2 = FakeWs.all[1]!;
    w2.open();
    // 等 replayed 确认服务没有重启过才重发
    expect(w2.sent.filter((m) => m.op === 'approve')).toHaveLength(0);
    w2.frame({ kind: 'replayed', upToSeq: 0, bootId: 'boot-1' });
    const resent = w2.sent.filter((m) => m.op === 'approve');
    expect(resent).toHaveLength(1);
    expect(resent[0]!.id).toBe(id);
    w2.ack(id, true, { ok: 1 });
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it('断线期间服务重启过（bootId 变了）：不重发未确认的指令，以“服务已重启”拒绝', async () => {
    const replays: Array<{ reset: boolean; restarted: boolean }> = [];
    const { client } = setup({ onReplayed: (_u, info) => replays.push(info) });
    client.start();
    const w1 = FakeWs.all[0]!;
    w1.open();
    w1.frame({ kind: 'replayed', upToSeq: 0, bootId: 'boot-1' });
    const p = client.request('prompt', { taskId: 't1', text: '跑一下测试' });
    w1.drop();
    vi.advanceTimersByTime(500);
    const w2 = FakeWs.all[1]!;
    w2.open();
    w2.frame({ kind: 'replayed', upToSeq: 0, bootId: 'boot-2' });
    await expect(p).rejects.toMatchObject({ error: { code: ClientErrorCode.ServerRestarted } });
    expect(w2.sent.some((m) => m.op === 'prompt')).toBe(false);
    expect(replays.at(-1)).toMatchObject({ restarted: true, reset: false });
    // 新连接上新发的指令照常
    const q = client.request('prompt', { taskId: 't1', text: '再来' });
    w2.ack(w2.last('prompt').id, true, { taskId: 't1', messageId: 'm' });
    await expect(q).resolves.toMatchObject({ taskId: 't1' });
  });

  it('replayed.reset 传给上层', () => {
    const replays: Array<{ reset: boolean }> = [];
    const { client } = setup({ onReplayed: (_u, info) => replays.push(info) });
    client.start();
    const w = FakeWs.all[0]!;
    w.open();
    w.frame({ kind: 'replayed', upToSeq: 3, bootId: 'b', reset: true });
    expect(replays).toEqual([{ reset: true, bootId: 'b', restarted: false }]);
  });

  it('握手带上凭据子协议；补发期间每来一帧事件，订阅的等待重新计时', () => {
    let proto: string[] | undefined;
    class ProtoWs extends FakeWs { constructor(url: string, protocols?: string[]) { super(url); proto = protocols; } }
    const { client } = setup({ WebSocketImpl: ProtoWs, protocols: () => ['aic.v1', 'aic-key.k1'] });
    client.start();
    expect(proto).toEqual(['aic.v1', 'aic-key.k1']);
    const w = FakeWs.all[0]!;
    w.open();
    // 补发很久：只要事件在来，就不会因为订阅 ack 超时而断开
    for (let i = 1; i <= 10; i++) { vi.advanceTimersByTime(20_000); w.frame({ kind: 'event', event: ev(i) }); }
    expect(w.readyState).toBe(1);
    w.frame({ kind: 'replayed', upToSeq: 10 });
    expect(client.state).toBe('online');
  });

  it('不合法的指令在发送前就被拒绝', async () => {
    const { client } = setup();
    client.start();
    const w = FakeWs.all[0]!;
    goOnline(w);
    const before = w.sent.length;
    await expect(client.request('prompt', { taskId: 't1', text: '' })).rejects.toMatchObject({ error: { code: 'request.invalid' } });
    expect(w.sent.length).toBe(before);
  });

  it('忽略无法识别的消息', () => {
    const { client, events } = setup();
    client.start();
    const w = FakeWs.all[0]!;
    goOnline(w);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    w.onmessage?.({ data: 'not json' });
    w.frame({ kind: 'event', event: { seq: 'x' } });
    expect(events).toHaveLength(0);
    warn.mockRestore();
  });
});
