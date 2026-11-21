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
      const headersOnly = await gw.api('HEAD', `/pairing/requests/${request.id}`, { loopback: LAN_ALIAS, token });
      expect(headersOnly.status).toBe(405);
      expect(headersOnly.headers['set-cookie']).toBeUndefined();
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

  it('吊销设备会取消它的在途换配，批量吊销也会清掉尚未领取的新配对', async () => {
    const { gw, token, issue, submit, poll, decide, page } = await setup();
    const local = await page();
    try {
      const services = gw.gw.services;
      const ip = '127.0.0.1';
      const old = services.auth.issueDevice(ip, { deviceName: '待换配手机', kind: 'browser', tokenDelivery: 'cookie' }, null, 'lan');
      const rotation = services.lanPairing.submit(ip, '', { code: (await issue()).code, deviceName: '换配手机', kind: 'browser', tokenDelivery: 'cookie' }, old.device.id);
      services.lanPairing.decide(rotation.id, true);
      services.auth.revoke(old.device.id, old.device.id);
      expect(services.lanPairing.status(rotation.id, ip).body.status).toBe('unavailable');
      const fresh = LanPairingPending.parse((await submit((await issue()).code)).json);
      await decide(fresh.id, true);
      const pending = LanPairingPending.parse((await submit((await issue()).code)).json);
      const unused = await issue();
      expect((await gw.api('DELETE', '/devices/lan', { token })).status).toBe(200);
      expect((await poll(fresh.id)).json.status).toBe('unavailable');
      expect((await poll(pending.id)).json.status).toBe('unavailable');
      expect((await submit(unused.code)).status).toBe(400);
      expect(services.auth.listDevices(null)).toHaveLength(1);
    } finally { await local.close(); }
  });

  it('换配写库失败保留原设备，重试只生成一条有效配对', async () => {
    const { gw, issue, page } = await setup();
    const local = await page();
    try {
      const { auth, lanPairing } = gw.gw.services;
      const body = { deviceName: '换配设备', kind: 'browser', tokenDelivery: 'cookie' } as const;
      const ip = '127.0.0.1';
      const old = auth.issueDevice(ip, body, null, 'lan');
      const count = auth.listDevices(null).length;
      const pending = lanPairing.submit(ip, '', { ...body, code: (await issue()).code }, old.device.id);
      lanPairing.decide(pending.id, true);
      const failing = vi.spyOn(auth, 'revoke').mockImplementationOnce(() => { throw new Error('模拟换配写入失败'); });
      try { expect(() => lanPairing.status(pending.id, ip)).toThrow('模拟换配写入失败'); }
      finally { failing.mockRestore(); }
      expect(auth.listDevices(null)).toHaveLength(count);
      expect(auth.deviceRow(old.device.id)?.revoked).toBe(0);
      expect(lanPairing.status(pending.id, ip).body.status).toBe('paired');
      expect(auth.deviceRow(old.device.id)?.revoked).toBe(1);
      expect(auth.listDevices(null)).toHaveLength(count);
      expect(lanPairing.status(pending.id, ip).body.status).toBe('claimed');
    } finally { await local.close(); }
  });

  it('在另一个本机页面接手时补齐仍待处理的两类确认，远程页面只收到普通同步结果', async () => {
    const { gw, token, issue, submit, page, decide } = await setup();
    const local = await page();
    const next = await WsClient.connect(gw.port, token);
    const phone = await WsClient.connect(gw.port, token, {}, undefined, LAN_ALIAS);
    try {
      const pairing = LanPairingPending.parse((await submit((await issue()).code)).json);
      const id = gw.gw.services.auth.listDevices(null)[0]!.id;
      const confirmation = gw.gw.services.accessConfirmation.require({ id, name: '离线手机', ip: LAN_ALIAS, remote: true }, 'task.permission');
      const event = await local.waitEvent(e => e.type === 'access.confirm_requested');
      if (event.type !== 'access.confirm_requested') throw new Error('没有收到操作确认');
      const data = { lastSeq: gw.gw.services.events.lastSeq() };
      try {
        await next.call({ op: 'subscribe', data });
        await phone.call({ op: 'subscribe', data });
        expect(phone.frames.find(f => f.kind === 'replayed')).not.toHaveProperty('pendingAccess');
        expect(next.frames.find(f => f.kind === 'replayed')).toMatchObject({ pendingAccess: [
          { kind: 'pairing', request: { id: pairing.id } }, { kind: 'operation', request: { id: event.data.id } },
        ] });
        await local.close();
        await decide(pairing.id, false);
      } finally { gw.gw.services.accessConfirmation.decide(event.data.id, true); await confirmation; }
      await next.call({ op: 'subscribe', data });
      expect(next.frames.filter(f => f.kind === 'replayed').at(-1)).toMatchObject({ pendingAccess: [] });
    } finally { await Promise.all([local.close(), next.close(), phone.close()]); }
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
    expect(fast.json.serverTime).toBe(at());
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

  it('本机发起和失败的配对均留下审计结果，只记录操作和来源', async () => {
    const { gw, token } = await setup();
    await gw.api('POST', '/pairing/start');
    const wrongCode = gw.code() === '000000' ? '111111' : '000000';
    const rejected = await gw.api('POST', '/pairing/complete', { body: { code: wrongCode, deviceName: '不应进入审计的设备输入' } });
    expect(rejected.status).toBe(400);
    const entries = (await gw.api('GET', '/access/audit', { token })).json.items;
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'pairing.start', result: 'ok', ip: '127.0.0.1' }),
      expect.objectContaining({ action: 'pairing.local', result: 'failed', ip: '127.0.0.1' }),
    ]));
    expect(JSON.stringify(entries)).not.toContain('不应进入审计的设备输入');
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
