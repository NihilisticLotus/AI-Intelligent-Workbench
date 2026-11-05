import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ErrorCode, WS_SUBPROTOCOL } from '@aic/protocol';
import { DEV_CODE_FILE } from '../src/server';
import { startGw, WsClient, type TestGw } from './helpers';

let t: TestGw;
beforeEach(async () => { t = await startGw(); });
afterEach(async () => { await t.stop(); });

describe('鉴权', () => {
  it('没有令牌返回 401 和协议里的 ApiError', async () => {
    const r = await t.api('GET', '/hello');
    expect(r.status).toBe(401);
    expect(r.json.code).toBe(ErrorCode.Unauthorized);
    expect(r.json.actions[0].action).toBe('pairing.start');
  });

  it('错误令牌返回 401', async () => {
    expect((await t.api('GET', '/projects', { token: 'not-a-real-token' })).status).toBe(401);
  });

  it('错误 Origin 返回 403（即使令牌正确）', async () => {
    const token = await t.pair();
    const r = await t.api('GET', '/hello', { token, headers: { origin: 'http://evil.example' } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe(ErrorCode.ForbiddenOrigin);
    // 同源 Origin 可以
    const ok = await t.api('GET', '/hello', { token, headers: { origin: `http://127.0.0.1:${t.port}` } });
    expect(ok.status).toBe(200);
    // 未配对时的配对接口也校验 Origin
    const p = await t.api('POST', '/pairing/start', { body: {}, headers: { origin: 'http://evil.example' } });
    expect(p.status).toBe(403);
  });

  it('错误 Host 返回 403（防 DNS 重绑定），静态页面也一样', async () => {
    const token = await t.pair();
    const r = await t.api('GET', '/hello', { token, headers: { host: `evil.example:${t.port}` } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe(ErrorCode.ForbiddenHost);
    const page = await t.api('GET', '/../', { headers: { host: 'attacker.test' } });
    expect(page.status).toBe(403);
    expect((await t.api('GET', '/hello', { token, headers: { host: `localhost:${t.port}` } })).status).toBe(200);
  });

  it('开发用的 AIC_DEV_ORIGIN 被允许', async () => {
    const t2 = await startGw({ devOrigin: 'http://127.0.0.1:5173' });
    try {
      const token = await t2.pair();
      expect((await t2.api('GET', '/hello', { token, headers: { origin: 'http://127.0.0.1:5173' } })).status).toBe(200);
      expect((await t2.api('GET', '/hello', { token, headers: { origin: 'http://127.0.0.1:5174' } })).status).toBe(403);
    } finally { await t2.stop(); }
  });

  it('配对码一次性有效；浏览器配对写 HttpOnly + SameSite=Strict Cookie、返回设备密钥，不在响应里返回令牌', async () => {
    const code = t.code();
    expect(code).toMatch(/^\d{6}$/);
    const r = await t.api('POST', '/pairing/complete', { body: { code, deviceName: '这台电脑的浏览器' } });
    expect(r.status).toBe(200);
    expect(r.json.token).toBeUndefined();
    expect(r.json.key).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const cookie = String(r.headers['set-cookie']);
    // Cookie 名带实例标识：同机不同数据目录的 Gateway 不会互相覆盖
    expect(cookie).toMatch(/^aic_session_[0-9a-f]{8}=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toContain(r.json.key);
    // 同一个码第二次用：失败
    const again = await t.api('POST', '/pairing/complete', { body: { code, deviceName: '别的设备' } });
    expect(again.status).toBe(400);
    expect(again.json.code).toBe(ErrorCode.PairingInvalid);
    // Cookie + 密钥访问
    const cookieVal = cookie.split(';')[0]!;
    const hello = await t.api('GET', '/hello', { cookie: cookieVal, key: r.json.key });
    expect(hello.status).toBe(200);
    expect(hello.json.server).toBe('ai-console-gateway');
    expect(hello.json.device.name).toBe('这台电脑的浏览器');
    expect(typeof hello.json.bootId).toBe('string');
  });

  it('只有 Cookie 不够：缺密钥、密钥不对、把 Cookie 值当 Bearer 用都是 401', async () => {
    const { cookie, key } = await t.pairBrowser();
    const raw = cookie.split('=')[1]!;
    expect((await t.api('GET', '/hello', { cookie })).status).toBe(401);
    expect((await t.api('GET', '/hello', { cookie, key: key.slice(0, -2) + 'xx' })).status).toBe(401);
    expect((await t.api('GET', '/hello', { token: raw })).status).toBe(401);
    expect((await t.api('GET', '/hello', { token: raw, key })).status).toBe(401);
    // 旧名字 aic_session 不再被接受
    expect((await t.api('GET', '/hello', { cookie: `aic_session=${raw}`, key })).status).toBe(401);
    expect((await t.api('GET', '/hello', { cookie, key })).status).toBe(200);
  });

  it('带着有效凭据重新配对：旧设备被吊销，设备列表不会越积越多', async () => {
    const a = await t.pairBrowser('浏览器');
    const b = await t.pairBrowser('浏览器', { cookie: a.cookie, key: a.key });
    expect(b.deviceId).not.toBe(a.deviceId);
    expect((await t.api('GET', '/hello', { cookie: a.cookie, key: a.key })).status).toBe(401);
    const list = await t.api('GET', '/devices', { cookie: b.cookie, key: b.key });
    expect(list.json.items.map((d: { id: string }) => d.id)).toEqual([b.deviceId]);
  });

  it('库里只存令牌哈希', async () => {
    const token = await t.pair();
    const rows = t.gw.services.db.all<{ token_hash: string }>('SELECT token_hash FROM devices');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).not.toContain(token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('现有配对码没过期时，[重新生成] 只在终端重新打印同一个码，不会作废用户正在看的码；码不经网络返回', async () => {
    const old = t.code();
    for (let i = 0; i < 5; i++) {
      const r = await t.api('POST', '/pairing/start', { body: {} });
      expect(r.status).toBe(200);
      expect(r.json.expiresAt).toBeGreaterThan(Date.now());
      expect(JSON.stringify(r.json)).not.toContain(old);
      expect(t.code()).toBe(old);
    }
    expect((await t.api('POST', '/pairing/complete', { body: { code: old, deviceName: 'x' } })).status).toBe(200);
    // 用掉之后再请求：生成新码
    expect((await t.api('POST', '/pairing/start', { body: {} })).status).toBe(200);
    expect(t.code()).toMatch(/^\d{6}$/);
  });

  it('[重新生成] 有最短间隔', async () => {
    const t2 = await startGw({ pairing: { limits: { startIntervalMs: 60_000 } } });
    try {
      await t2.pairBrowser();
      const r = await t2.api('POST', '/pairing/start', { body: {} });
      expect(r.status).toBe(429);
      expect(r.json.code).toBe(ErrorCode.RateLimited);
    } finally { await t2.stop(); }
  });

  it('配对码过期后无效', async () => {
    const t2 = await startGw({ pairing: { pairingTtlMs: 1 } });
    try {
      await new Promise((r) => setTimeout(r, 10));
      const r = await t2.api('POST', '/pairing/complete', { body: { code: t2.code(), deviceName: 'x' } });
      expect(r.status).toBe(400);
    } finally { await t2.stop(); }
  });

  it('失败按配对码计数：输错太多次这个码作废，重新生成后照样能配对（不会把本机整个锁住）', async () => {
    const t2 = await startGw({ pairing: { limits: { maxFailuresPerCode: 3, startIntervalMs: 0 } } });
    try {
      const code = t2.code();
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 3; i++) {
        const r = await t2.api('POST', '/pairing/complete', { body: { code: wrong, deviceName: 'x' } });
        expect(r.json.code).toBe(ErrorCode.PairingInvalid);
      }
      // 正确的码也已经作废
      expect((await t2.api('POST', '/pairing/complete', { body: { code, deviceName: 'x' } })).status).toBe(400);
      expect((await t2.api('POST', '/pairing/start', { body: {} })).status).toBe(200);
      expect((await t2.api('POST', '/pairing/complete', { body: { code: t2.code(), deviceName: 'x' } })).status).toBe(200);
    } finally { await t2.stop(); }
  });

  it('配对码因输错作废后，重新生成的最短间隔翻倍', async () => {
    const t2 = await startGw({ pairing: { limits: { maxFailuresPerCode: 1, startIntervalMs: 2000 } } });
    try {
      // 把“上次生成”拨到 3 秒前：正常间隔 2 秒已经过了，翻倍后的 4 秒还没到
      (t2.gw.services.auth as unknown as { lastIssuedAt: number }).lastIssuedAt = Date.now() - 3000;
      const wrong = t2.code() === '000000' ? '111111' : '000000';
      await t2.api('POST', '/pairing/complete', { body: { code: wrong, deviceName: 'x' } });
      expect((await t2.api('POST', '/pairing/start', { body: {} })).status).toBe(429);
    } finally { await t2.stop(); }
  });

  it('吊销设备后令牌失效，WebSocket 被关闭', async () => {
    const a = await t.pair('A');
    const b = await t.pair('B');
    const list = await t.api('GET', '/devices', { token: a });
    expect(list.json.items).toHaveLength(2);
    const bId = list.json.items.find((d: { name: string }) => d.name === 'B').id;
    const ws = await WsClient.connect(t.port, b);
    const closed = new Promise<number>((r) => ws.ws.once('close', (code) => r(code)));
    expect((await t.api('DELETE', `/devices/${bId}`, { token: a })).status).toBe(200);
    expect(await closed).toBe(4401);
    expect((await t.api('GET', '/hello', { token: b })).status).toBe(401);
  });

  it('WebSocket 握手：无令牌 401、错误 Origin 403', async () => {
    const token = await t.pair();
    const status = (headers: Record<string, string>) => new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${t.port}/api/v1/ws`, { headers });
      ws.once('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0));
      ws.once('open', () => { ws.close(); resolve(101); });
      ws.once('error', () => {});
    });
    expect(await status({})).toBe(401);
    expect(await status({ authorization: `Bearer ${token}`, origin: 'http://evil.example' })).toBe(403);
    expect(await status({ authorization: `Bearer ${token}` })).toBe(101);
    const { cookie, key } = await t.pairBrowser();
    expect(await status({ cookie, 'x-aic-key': key, origin: `http://localhost:${t.port}` })).toBe(101);
    // 只有 Cookie：401
    expect(await status({ cookie, origin: `http://localhost:${t.port}` })).toBe(401);
  });

  it('WebSocket 握手：浏览器经子协议传设备密钥 / Bearer 令牌，服务端只回选 aic.v1', async () => {
    const { cookie, key } = await t.pairBrowser();
    const c = await WsClient.connect(t.port, null, { cookie, origin: `http://127.0.0.1:${t.port}` }, [WS_SUBPROTOCOL, `aic-key.${key}`]);
    expect(c.ws.protocol).toBe(WS_SUBPROTOCOL);
    await c.close();
    const token = await t.pair();
    const c2 = await WsClient.connect(t.port, null, {}, [WS_SUBPROTOCOL, `aic-bearer.${token}`]);
    expect(c2.ws.protocol).toBe(WS_SUBPROTOCOL);
    await c2.close();
    await expect(WsClient.connect(t.port, null, {}, [WS_SUBPROTOCOL, `aic-key.${key}`])).rejects.toThrow(/401/);
  });

  it('请求体必须是 JSON', async () => {
    const token = await t.pair();
    const r = await t.api('POST', '/groups', { token, body: { name: 'x' }, headers: { 'content-type': 'text/plain' } });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe(ErrorCode.BadRequest);
  });

  it('未知接口返回 404 ApiError', async () => {
    const token = await t.pair();
    const r = await t.api('GET', '/nope', { token });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe(ErrorCode.NotFound);
  });
});

describe('开发模式（AIC_DEV=1）', () => {
  it('启动时的随机配对码写进数据目录供预览工具读取，用过即作废；之后重新生成的码不写文件', async () => {
    const logs: string[] = [];
    const t2 = await startGw({ dev: true, log: (m) => logs.push(m) });
    const file = path.join(t2.dataDir, DEV_CODE_FILE);
    try {
      expect(logs.some((m) => m.includes('开发模式'))).toBe(true);
      const [code, port] = readFileSync(file, 'utf8').trim().split('\n');
      expect(code).toBe(t2.code());
      expect(code).toMatch(/^\d{6}$/);
      expect(Number(port)).toBe(t2.port);
      expect((await t2.api('POST', '/pairing/complete', { body: { code, deviceName: '预览', tokenDelivery: 'bearer' } })).status).toBe(200);
      const again = await t2.api('POST', '/pairing/complete', { body: { code, deviceName: '预览', tokenDelivery: 'bearer' } });
      expect(again.json.code).toBe(ErrorCode.PairingInvalid);
      expect((await t2.api('POST', '/pairing/start', { body: {} })).status).toBe(200);
      expect(t2.code()).not.toBe('');
      expect(readFileSync(file, 'utf8').trim().split('\n')[0]).toBe(code);
    } finally { await t2.stop(); }
    expect(existsSync(file)).toBe(false);
  });

  it('不是开发模式时不写文件；AIC_DEV_PAIR_CODE 不再有任何作用', async () => {
    process.env.AIC_DEV_PAIR_CODE = 'devpair2026';
    const t2 = await startGw({ dev: false });
    try {
      expect(existsSync(path.join(t2.dataDir, DEV_CODE_FILE))).toBe(false);
      expect(t2.code()).toMatch(/^\d{6}$/);
      expect((await t2.api('POST', '/pairing/complete', { body: { code: 'devpair2026', deviceName: 'x', tokenDelivery: 'bearer' } })).status).toBe(400);
    } finally { delete process.env.AIC_DEV_PAIR_CODE; await t2.stop(); }
  });
});
