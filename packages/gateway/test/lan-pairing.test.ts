import { once } from 'node:events';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ErrorCode, LanPairingCode, LanPairingPending, LanPairingStatus, WS_SUBPROTOCOL } from '@aic/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/http/app';
import { LAN_ALIAS, LAN_SELECTION, startLanGateway } from './fixtures/lan-gateway';
import { startGw, WsClient, type TestGw } from './helpers';

const TTL = 120_000;

describe('局域网配对', () => {
  let t: TestGw | undefined;
  afterEach(async () => { await t?.stop(); t = undefined; });

  async function setup() {
    let time = Date.now();
    const gw = await startLanGateway({ lanPairing: { clock: () => time } });
    t = gw;
    const token = await gw.pair();
    expect((await gw.api('PUT', '/access/lan', { token, body: LAN_SELECTION })).status).toBe(200);
    const issue = async () => LanPairingCode.parse((await gw.api('POST', '/pairing/local-code', { token })).json);
    const submit = (code: string) => gw.api('POST', '/pairing/complete', {
      loopback: LAN_ALIAS, body: { code, deviceName: '离线手机' }, headers: { 'user-agent': 'Mozilla/5.0 Version/26.0 Safari/605.1.15' },
    });
    const poll = (id: string) => gw.api('GET', `/pairing/requests/${id}`, { loopback: LAN_ALIAS });
    const decide = (id: string, allow: boolean) => gw.api('POST', `/pairing/requests/${id}/decision`, { token, body: { allow } });
    const page = async (loopback?: typeof LAN_ALIAS) => {
      const ws = await WsClient.connect(gw.port, token, {}, undefined, loopback);
      await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
      return ws;
    };
    return { gw, token, issue, submit, poll, decide, page, at: () => time, advance: (ms: number) => { time += ms; } };
  }

  it('只推给本机页面，电脑允许后同一设备只领取一次浏览器凭据', async () => {
    const { gw, token, issue, submit, poll, decide, page } = await setup();
    const local = await page();
    const lanObserver = await page(LAN_ALIAS);
    try {
      const code = await issue();
      expect(code.address).toBe(`http://${LAN_ALIAS}:${gw.port}/`);
      expect((await gw.api('POST', '/pairing/local-code')).status).toBe(401);
      expect((await gw.api('POST', '/pairing/local-code', { token, loopback: LAN_ALIAS })).status).toBe(403);
      const response = await submit(code.code);
      expect(response.status).toBe(202);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(response.json).not.toHaveProperty('key');
      const request = LanPairingPending.parse(response.json);
      const event = await local.waitEvent((e) => e.type === 'pairing.requested');
      expect(event.data).toMatchObject({ id: request.id, name: '离线手机', browser: 'Safari', expiresAt: request.expiresAt });
      const waiting = await poll(request.id);
      expect(waiting.json.status).toBe('pending');
      expect(waiting.headers['set-cookie']).toBeUndefined();
      expect((await gw.api('GET', '/devices', { token })).json.items).toHaveLength(1);
      expect((await gw.api('POST', `/pairing/requests/${request.id}/decision`, { loopback: LAN_ALIAS, token, body: { allow: true } })).status).toBe(403);

      const app = createApp(gw.gw.services, { webDist: gw.dataDir });
      const wrongIp = { incoming: { socket: { localAddress: LAN_ALIAS, remoteAddress: '192.168.5.3' } } } as Parameters<typeof app.fetch>[1];
      const pollWrongIp = () => app.request(`/api/v1/pairing/requests/${request.id}`, { headers: { host: `${LAN_ALIAS}:${gw.port}` } }, wrongIp);
      expect((await pollWrongIp()).status).toBe(404);
      expect((await decide(request.id, true)).status).toBe(200);
      expect((await pollWrongIp()).status).toBe(404);
      expect((await decide(request.id, true)).status).toBe(409);
      const granted = await poll(request.id);
      const paired = LanPairingStatus.parse(granted.json);
      if (paired.status !== 'paired') throw new Error('局域网设备未收到配对凭据');
      expect(paired.device).toMatchObject({ source: 'lan', current: true });
      const cookie = String(granted.headers['set-cookie']);
      expect(cookie).toMatch(/HttpOnly.*SameSite=Strict/);
      expect(cookie).not.toMatch(/; Secure\b/);
      expect(cookie).not.toContain(paired.key);
      expect(granted.json).not.toHaveProperty('token');
      const repeated = await poll(request.id);
      expect(repeated.json).toEqual({ status: 'claimed' });
      expect(repeated.headers['set-cookie']).toBeUndefined();
      expect((await gw.api('GET', '/hello', { loopback: LAN_ALIAS })).status).toBe(401);
      const creds = { cookie: cookie.split(';')[0]!, key: paired.key };
      expect((await gw.api('GET', '/hello', { loopback: LAN_ALIAS, ...creds })).json.device.source).toBe('lan');
      expect((await gw.api('POST', '/pairing/local-code', creds)).status).toBe(403);
      expect((await lanObserver.call({ op: 'subscribe', data: { lastSeq: 0 } })).ok).toBe(true);
      expect(lanObserver.events().filter((ev) => ev.type.startsWith('pairing.'))).toHaveLength(0);

      expect((await gw.api('PUT', '/access/lan', { token, body: { enabled: false } })).status).toBe(200);
      expect((await gw.api('PUT', '/access/lan', { token, body: LAN_SELECTION })).status).toBe(200);
      expect((await gw.api('GET', '/hello', { loopback: LAN_ALIAS, ...creds })).status).toBe(200);
      const remote = await WsClient.connect(gw.port, null, { cookie: creds.cookie }, [WS_SUBPROTOCOL, `aic-key.${creds.key}`], LAN_ALIAS);
      const closed = once(remote.ws, 'close');
      expect((await gw.api('DELETE', '/devices/lan', { token })).json.revoked).toBe(1);
      expect((await closed)[0]).toBe(4401);
      expect((await gw.api('GET', '/hello', { loopback: LAN_ALIAS, ...creds })).status).toBe(401);
      expect((await gw.api('GET', '/devices', { token })).json.items.map((item: { source: string }) => item.source)).toEqual(['local']);
    } finally { await Promise.all([local.close(), lanObserver.close()]); }
  });

  it('拒绝、超时、本机页面掉线或没有打开时均不会发放令牌', async () => {
    const { gw, token, issue, submit, poll, decide, page, advance } = await setup();
    expect((await submit((await issue()).code)).status).toBe(409);
    const local = await page();
    try {
      const rejected = LanPairingPending.parse((await submit((await issue()).code)).json);
      expect((await decide(rejected.id, false)).status).toBe(200);
      const refused = await poll(rejected.id);
      expect(refused.json).toEqual({ status: 'rejected' });
      expect(refused.headers['set-cookie']).toBeUndefined();

      const expired = LanPairingPending.parse((await submit((await issue()).code)).json);
      advance(TTL + 1);
      expect((await decide(expired.id, true)).status).toBe(409);
      const tooLate = await poll(expired.id);
      expect(tooLate.json).toEqual({ status: 'expired' });
      expect(tooLate.headers['set-cookie']).toBeUndefined();

      const disconnected = LanPairingPending.parse((await submit((await issue()).code)).json);
      await local.close();
      await vi.waitFor(() => expect(gw.gw.services.lanPairing.hasLocalPage()).toBe(false));
      expect((await decide(disconnected.id, true)).status).toBe(409);
      const unavailable = await poll(disconnected.id);
      expect(unavailable.json).toEqual({ status: 'unavailable' });
      expect(unavailable.headers['set-cookie']).toBeUndefined();
      expect((await gw.api('GET', '/devices', { token })).json.items).toHaveLength(1);
    } finally { await local.close(); }
  });

  it('同一来源 IP 每分钟只接受五次尝试，连续十次失败后锁定十五分钟', async () => {
    const { gw, token, issue, submit, page, at, advance } = await setup();
    const code = await issue();
    const wrong = code.code === '000000' ? '111111' : '000000';
    const app = createApp(gw.gw.services, { webDist: gw.dataDir });
    const otherIp = { incoming: { socket: { localAddress: LAN_ALIAS, remoteAddress: '192.168.5.8' } } } as Parameters<typeof app.fetch>[1];
    for (let i = 0; i < 5; i++) expect((await submit(wrong)).status).toBe(400);
    const fast = await submit(wrong);
    expect(fast.status).toBe(429);
    expect(fast.json).toMatchObject({ code: ErrorCode.RateLimited, retryAt: at() + 60_000 });
    const other = await app.request('/api/v1/pairing/complete', {
      method: 'POST', headers: { host: `${LAN_ALIAS}:${gw.port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code: wrong, deviceName: '另一个离线来源' }),
    }, otherIp);
    expect(other.status).toBe(400);
    expect((await gw.api('GET', '/hello', { token })).status).toBe(200);
    expect(await gw.pair('回环计数独立')).toBeTruthy();

    advance(60_000);
    for (let i = 0; i < 4; i++) expect((await submit(wrong)).status).toBe(400);
    const locked = await submit(wrong);
    expect(locked.status).toBe(429);
    expect(locked.json).toMatchObject({ code: ErrorCode.PairingLocked, retryAt: at() + 15 * 60_000 });
    expect((await submit((await issue()).code)).json.code).toBe(ErrorCode.PairingLocked);

    advance(15 * 60_000);
    const local = await page();
    try { expect((await submit((await issue()).code)).status).toBe(202); }
    finally { await local.close(); }
  });

  it('旧设备迁移为本机来源，原配对仍然有效', async () => {
    const gw = await startGw();
    t = gw;
    const token = await gw.pair('已有配对');
    await gw.gw.close();
    const old = new DatabaseSync(path.join(gw.dataDir, 'data.db'));
    try { old.exec('ALTER TABLE devices DROP COLUMN pairing_source; PRAGMA user_version=25;'); }
    finally { old.close(); }
    const migrated = await startGw({}, gw.dataDir);
    try {
      const devices = await migrated.api('GET', '/devices', { token });
      expect(devices.status).toBe(200);
      expect(devices.json.items).toHaveLength(1);
      expect(devices.json.items[0]).toMatchObject({ name: '已有配对', source: 'local' });
    } finally { await migrated.stop(); }
  });
});
