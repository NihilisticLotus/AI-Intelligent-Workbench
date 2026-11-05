// 测试工具：临时数据目录 + 随机端口启动 Gateway；用 node:http 发请求（可以自定义 Host / Origin）
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { Approval, ClientOp, EventEnvelope, ServerFrame } from '@aic/protocol';
import { createGateway, type Gateway, type GatewayOptions } from '../src/server';

export interface TestGw {
  gw: Gateway;
  port: number;
  dataDir: string;
  /** 最近一次生成的配对码 */
  code(): string;
  /** 完成一次配对，返回令牌 */
  pair(name?: string): Promise<string>;
  /** 按浏览器方式配对：返回 Cookie（name=value）和设备密钥 */
  pairBrowser(name?: string, extra?: ReqOpts): Promise<{ cookie: string; key: string; deviceId: string }>;
  api(method: string, p: string, o?: ReqOpts): Promise<Res>;
  stop(): Promise<void>;
}

export interface ReqOpts { token?: string; cookie?: string; key?: string; body?: unknown; headers?: Record<string, string> }
export interface Res { status: number; headers: Record<string, string | string[] | undefined>; json: any; text: string }

export function rawRequest(port: number, method: string, p: string, o: ReqOpts = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...o.headers };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.cookie = o.cookie;
    if (o.key) headers['x-aic-key'] = o.key;
    let data: string | undefined;
    if (o.body !== undefined) {
      data = JSON.stringify(o.body);
      headers['content-type'] ??= 'application/json';
      headers['content-length'] = String(Buffer.byteLength(data));
    }
    const req = request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export async function startGw(extra: Partial<GatewayOptions> = {}, dataDir?: string): Promise<TestGw> {
  const dir = dataDir ?? mkdtempSync(path.join(tmpdir(), 'aic-test-'));
  let last = '';
  const gw = await createGateway({
    dataDir: dir, port: 0, openBrowser: false, fakeSpeed: 0, log: () => {},
    webDist: path.join(dir, 'no-web'),
    ...extra,
    pairing: {
      ...extra.pairing,
      limits: { startIntervalMs: 0, ...extra.pairing?.limits },
      onPairingCode: (c) => { last = c; },
    },
  });
  // createGateway 在 onPairingCode 设置之前不会生成码，这里确保拿到启动时的码
  const t: TestGw = {
    gw, port: gw.port, dataDir: dir,
    code: () => last,
    api: (m, p, o) => rawRequest(gw.port, m, `/api/v1${p}`, o),
    async pair(name = '测试设备') {
      if (!last) gw.services.auth.newPairingCode();
      const r = await t.api('POST', '/pairing/complete', { body: { code: last, deviceName: name, tokenDelivery: 'bearer' } });
      last = '';
      if (r.status !== 200) throw new Error(`配对失败 ${r.status} ${r.text}`);
      return r.json.token as string;
    },
    async pairBrowser(name = '测试浏览器', extra = {}) {
      if (!last) gw.services.auth.newPairingCode();
      const r = await t.api('POST', '/pairing/complete', { ...extra, body: { code: last, deviceName: name } });
      last = '';
      if (r.status !== 200) throw new Error(`配对失败 ${r.status} ${r.text}`);
      return { cookie: String(r.headers['set-cookie']).split(';')[0]!, key: r.json.key as string, deviceId: r.json.device.id as string };
    },
    async stop() {
      await gw.close();
      if (!dataDir) rmSync(dir, { recursive: true, force: true });
    },
  };
  return t;
}

/** WebSocket 测试客户端：收集所有帧，可按条件等待 */
export class WsClient {
  frames: ServerFrame[] = [];
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];
  private seq = 0;
  constructor(public ws: WebSocket) {
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as ServerFrame;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => { if (w.pred(f)) { w.resolve(f); return false; } return true; });
    });
  }

  static connect(port: number, token: string | null, headers: Record<string, string> = {}, protocols?: string[]): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`, protocols ?? [], { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
      const c = new WsClient(ws);
      ws.once('open', () => resolve(c));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`握手失败 ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  send(op: Omit<ClientOp, 'id'> & { id?: string }): string {
    const id = op.id ?? `c_${++this.seq}`;
    this.ws.send(JSON.stringify({ ...op, id }));
    return id;
  }

  waitFor(pred: (f: ServerFrame) => boolean, timeoutMs = 5000): Promise<ServerFrame> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (f: ServerFrame) => { clearTimeout(t); resolve(f); } };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(new Error('等待帧超时'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** 发送并等 ack */
  async call(op: Omit<ClientOp, 'id'> & { id?: string }) {
    const id = this.send(op);
    const f = await this.waitFor((x) => x.kind === 'ack' && x.id === id);
    return f as Extract<ServerFrame, { kind: 'ack' }>;
  }

  events(): EventEnvelope[] {
    return this.frames.flatMap((f) => (f.kind === 'event' ? [f.event] : []));
  }

  waitEvent(pred: (e: EventEnvelope) => boolean, timeoutMs = 5000) {
    return this.waitFor((f) => f.kind === 'event' && pred(f.event), timeoutMs).then((f) => (f as Extract<ServerFrame, { kind: 'event' }>).event);
  }

  close() {
    return new Promise<void>((r) => {
      if (this.ws.readyState === WebSocket.CLOSED) return r();
      this.ws.once('close', () => r());
      this.ws.close();
    });
  }
}

/** 建一个项目（用临时目录） */
export async function makeProject(t: TestGw, token: string, name = '示例项目') {
  const dir = mkdtempSync(path.join(t.dataDir, 'proj-'));
  const r = await t.api('POST', '/projects', { token, body: { name, path: dir } });
  if (r.status !== 201) throw new Error(`建项目失败 ${r.status} ${r.text}`);
  return r.json as { id: string; path: string };
}

/** 需审批级别下，演示 Agent 先请求修改文件、再请求执行命令。测试里先放行修改文件那一次，再等命令审批 */
export const isCommandApproval = (taskId: string) => (e: EventEnvelope) =>
  e.type === 'approval.requested' && e.taskId === taskId && (e.data as { approval: Approval }).approval.detail.includes('Unity');
export async function allowEditApproval(ws: WsClient, taskId: string): Promise<void> {
  const req = await ws.waitEvent((e) => e.type === 'approval.requested' && e.taskId === taskId && !(e.data as { approval: Approval }).approval.detail.includes('Unity'));
  const ack = await ws.call({ op: 'approve', data: { approvalId: (req.data as { approval: Approval }).approval.id, optionId: 'allow' } });
  if (!ack.ok) throw new Error('放行修改文件的审批失败');
}
