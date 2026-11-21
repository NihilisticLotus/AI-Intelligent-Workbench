import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NetworkInterfaceInfoIPv4 } from 'node:os';
import { FeatureKey, LanState } from '@aic/protocol';
import WebSocket from 'ws';
import { createApp } from '../src/http/app';
import { firewallChangeArgs, firewallRuleMatches, firewallRuleName } from '../src/lan/firewall';
import { isPrivateIpv4, listPrivateInterfaces } from '../src/lan/interfaces';
import { parseNetworkProfiles } from '../src/lan/network-profile';
import type { LanCommand, LanCommandResult } from '../src/lan/windows-executor';
import { startGw, WsClient, type TestGw } from './helpers';

const address = '192.168.7.4';
const alias = '127.0.0.2';
const name = '家庭 Wi-Fi';
const program = 'C:\\Program Files\\nodejs\\node.exe';
const interactiveUac = { enabled: 1, interactive: true, elevated: false, adminGroup: true, adminPolicy: 5, userPolicy: 3 };
const rule = {
  address, port: '17890', program, remoteAddress: 'LocalSubnet', profiles: 2, protocol: 6, direction: 1, action: 1, edge: false, enabled: true,
};
const ipv4 = (address: string, internal = false): NetworkInterfaceInfoIPv4 => ({
  address, netmask: '255.255.255.0', family: 'IPv4', mac: '', internal, cidr: `${address}/24`,
});

async function occupyAdjacentPorts() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const occupied = createServer();
    const next = createServer();
    const probe = createServer();
    const close = () => Promise.all([occupied, next, probe].filter(server => server.listening)
      .map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    try {
      // 独立抽取候选，避免系统连续分配的临时端口与同一轮 HTTP 客户端争用。
      const port = randomInt(20_000, 40_000);
      occupied.listen(port, '127.0.0.1');
      await once(occupied, 'listening');
      next.listen(port + 1, '127.0.0.1');
      await once(next, 'listening');
      // 保留两个相邻端口，后续端口探测只用于排除 Windows 保留范围。
      probe.listen(port + 2, '127.0.0.1');
      await once(probe, 'listening');
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      return { close, port };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') {
        await close();
        throw error;
      }
    }
    await close();
  }
  throw new Error('未找到可验证端口顺延的相邻回环端口');
}

describe('局域网探测与防火墙', () => {
  it('只列出私有网段的外部 IPv4，保留网卡名', () => {
    for (const valid of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.1.1']) expect(isPrivateIpv4(valid), valid).toBe(true);
    for (const invalid of ['172.15.255.255', '172.32.0.1', '198.18.1.1', '169.254.1.1', '127.0.0.1', '100.64.1.1', '192.169.1.1', '10.0.0.256', '::ffff:10.0.0.1']) {
      expect(isPrivateIpv4(invalid), invalid).toBe(false);
    }
    expect(listPrivateInterfaces(() => ({ [name]: [ipv4(address), ipv4('169.254.1.1'), ipv4('10.0.0.1', true)] })))
      .toEqual([{ name, address }]);
  });

  it('解析专用、公用、域与未知类别，类别冲突时拒绝推断', () => {
    const json = JSON.stringify([
      { name, category: 'Private' }, { name: '公用', category: 'Public' }, { name: '域', category: 'DomainAuthenticated' },
      { name: '其他', category: 0 }, { name: '重复', category: 'Private' }, { name: '重复', category: 'Public' }, null,
    ]);
    expect([...parseNetworkProfiles(json)]).toEqual([[name.toLowerCase(), 'private'], ['公用', 'public'], ['域', 'domain'], ['其他', 'unknown'], ['重复', 'unknown']]);
    expect(parseNetworkProfiles('无效输出').size).toBe(0);
  });

  it('生成仅允许选中地址、专用网络、本地子网与实际端口的入站程序规则', () => {
    const ruleName = firewallRuleName('离线预览');
    expect(ruleName).toMatch(/^AI Console LAN [0-9a-f]{16}$/);
    expect(firewallRuleName('正式使用')).not.toBe(ruleName);
    const target = { address, port: 17891, program };
    expect(firewallChangeArgs(ruleName, 'add', target)).toEqual([
      'advfirewall', 'firewall', 'add', 'rule', `name=${ruleName}`, 'dir=in', 'action=allow', 'enable=yes', 'profile=private',
      'protocol=TCP', 'edge=no', 'remoteip=localsubnet', `localip=${address}`, 'localport=17891', `program=${program}`,
    ]);
    expect(firewallChangeArgs(ruleName, 'set', target).slice(0, 6)).toEqual(['advfirewall', 'firewall', 'set', 'rule', `name=${ruleName}`, 'new']);
    expect(firewallChangeArgs(ruleName, 'delete', null)).toEqual(['advfirewall', 'firewall', 'delete', 'rule', `name=${ruleName}`]);
  });

  it('验证实例规则的地址、实际端口、程序路径和网络类别', () => {
    const target = { address, port: 17890, program };
    expect(firewallRuleMatches({ ...rule, address: `${address}/255.255.255.255`, program: program.toUpperCase() }, target)).toBe(true);
    for (const replacement of [{ port: '17891' }, { profiles: 7 }, { program: 'C:\\Other\\node.exe' },
      { remoteAddress: '*' }, { address: '*' }, { enabled: false }, { edge: true }, { protocol: 17 }]) {
      expect(firewallRuleMatches({ ...rule, ...replacement }, target), JSON.stringify(replacement)).toBe(false);
    }
  });
});

describe('局域网设置接口', () => {
  let t: TestGw | undefined;
  afterEach(async () => { await t?.stop(); t = undefined; });

  async function setup(initialCategory = 'Private', port?: number, profileCheckMs?: number) {
    const calls: LanCommand[] = [];
    let installed: unknown[] = [];
    let changeResult: LanCommandResult = { status: 'ok', stdout: '' };
    let uacResult: LanCommandResult = { status: 'ok', stdout: JSON.stringify(interactiveUac) };
    let category = initialCategory;
    let present = true;
    let hold: (() => Promise<void>) | undefined;
    const lan = {
      ...(profileCheckMs === undefined ? {} : { profileCheckMs }),
      supported: true, program, listInterfaces: () => present ? [{ name, address: alias }] : [],
      execute: async (cmd: LanCommand): Promise<LanCommandResult> => {
        calls.push(cmd);
        if (cmd.kind === 'uac-check') return uacResult;
        if (cmd.kind === 'network-profile') {
          const stdout = JSON.stringify([{ name, category }]);
          const pause = hold;
          hold = undefined;
          if (pause) await pause();
          return { status: 'ok', stdout };
        }
        if (cmd.kind === 'firewall-query') return { status: 'ok', stdout: JSON.stringify(installed) };
        if (changeResult.status === 'ok') {
          const args = cmd.env?.AIC_LAN_RULE_ARGS ?? '';
          installed = args.includes('"delete"') ? [] : [{ ...rule, address: alias, port: /"localport=(\d+)"/.exec(args)?.[1] }];
        }
        return changeResult;
      },
    };
    const gw = await startGw({ lan, ...(port === undefined ? {} : { port }) });
    t = gw;
    const token = await gw.pair();
    const body = { enabled: true, name, address: alias };
    return { gw, token, calls, body, lan,
      holdNextProfile: () => {
        let started!: () => void;
        let release!: () => void;
        const arrived = new Promise<void>(resolve => { started = resolve; });
        const paused = new Promise<void>(resolve => { release = resolve; });
        hold = () => { started(); return paused; };
        return { arrived, release };
      },
      setChangeResult: (value: LanCommandResult) => { changeResult = value; },
      setUac: (patch: Partial<typeof interactiveUac>) => {
        uacResult = { status: 'ok', stdout: JSON.stringify({ ...interactiveUac, ...patch }) };
      },
      setUacResult: (result: LanCommandResult) => { uacResult = result; },
      setCategory: (value: string) => { category = value; },
      setPresent: (value: boolean) => { present = value; },
      setRules: (value: unknown[]) => { installed = value; },
    };
  }

  it('默认关闭，已认证本机确认规则后开启，关闭时确认规则已删除', async () => {
    const { gw, token, calls, body } = await setup();
    expect((await gw.api('GET', '/access/lan')).status).toBe(401);
    expect(calls).toHaveLength(0);
    const before = LanState.parse((await gw.api('GET', '/access/lan', { token })).json);
    expect(before).toMatchObject({ enabled: false, requested: false, port: gw.port, interfaces: [{ name, address: alias, category: 'private' }], firewall: 'missing' });
    expect(calls.find((cmd) => cmd.kind === 'network-profile')?.timeoutMs).toBe(10_000);
    expect((await gw.api('PUT', '/access/lan', { token, body: { ...body, address: '10.0.0.3' } })).status).toBe(403);
    const config = await gw.api('PUT', '/access/lan', { token, body });
    expect(config.json).toMatchObject({ enabled: true, requested: true, selected: { address: alias, name }, firewall: 'matched' });
    expect(calls.filter((cmd) => cmd.kind === 'firewall-change')).toHaveLength(1);
    const updated = await gw.api('POST', '/access/lan/firewall', { token });
    expect(updated.json.firewall).toBe('matched');
    expect(calls.find((cmd) => cmd.kind === 'firewall-change')?.env?.AIC_LAN_RULE_ARGS).toContain(`"localport=${gw.port}"`);
    expect((await gw.api('PUT', '/access/lan', { token, body: { enabled: false } })).json).toMatchObject({ enabled: false, requested: false, firewall: 'missing' });
  });

  it('拒绝公用、域、未知类别且不保存开启设置', async () => {
    for (const category of ['Public', 'DomainAuthenticated', 'Unexpected']) {
      const { gw, token, calls, body } = await setup(category);
      try {
        const result = await gw.api('PUT', '/access/lan', { token, body });
        expect(result.status, category).toBe(403);
        expect((await gw.api('GET', '/access/lan', { token })).json.requested).toBe(false);
        expect(calls.every((cmd) => cmd.kind !== 'firewall-change')).toBe(true);
      } finally {
        await gw.stop();
        t = undefined;
      }
    }
  });

  it('UAC 被拒、命令失败或超时都给出原因并保持关闭', async () => {
    const { gw, token, body, setChangeResult } = await setup();
    for (const [status, expected] of [['cancelled', '没有添加防火墙规则'], ['failed', '规则写入失败'], ['timeout', '超时']] as const) {
      setChangeResult({ status });
      const result = await gw.api('PUT', '/access/lan', { token, body });
      expect(result.status).toBe(status === 'cancelled' ? 403 : 409);
      expect(result.json.message).toContain(expected);
      expect((await gw.api('GET', '/access/lan', { token })).json).toMatchObject({ enabled: false, requested: false, firewall: 'missing' });
    }
  });

  it('点击开启才核对 UAC，无法交互时解释原因且不写规则', async () => {
    const { gw, token, body, calls, setUac, setUacResult } = await setup();
    await gw.api('GET', '/access/lan', { token });
    expect(calls.some(call => call.kind === 'uac-check')).toBe(false);
    for (const [patch, reason] of [
      [{ enabled: 0 }, '已关闭 UAC'], [{ elevated: true }, '普通权限'],
      [{ interactive: false }, '交互式桌面'], [{ adminPolicy: 0 }, '不提示'],
      [{ adminGroup: false, userPolicy: 0 }, '拒绝提升'], [{ adminGroup: false, userPolicy: 9 }, '无法确认'],
    ] as const) {
      setUac(patch);
      const reply = await gw.api('PUT', '/access/lan', { token, body });
      expect(reply.status).toBe(409);
      expect(reply.json.message).toContain(reason);
      expect((await gw.api('GET', '/access/lan', { token })).json).toMatchObject({
        enabled: false, requested: false, firewall: 'missing',
      });
    }
    for (const result of [{ status: 'failed' }, { status: 'ok', stdout: '{' }, { status: 'ok', stdout: '{}' }] as const) {
      setUacResult(result);
      expect((await gw.api('PUT', '/access/lan', { token, body })).json.message).toContain('无法确认');
    }
    expect(calls.some(call => call.kind === 'firewall-change')).toBe(false);
  });

  it('普通用户按自己的提示策略开启，关闭时 UAC 不可用先断开且保留清理入口', async () => {
    const { gw, token, body, calls, setUac } = await setup();
    setUac({ adminGroup: false, adminPolicy: 0, userPolicy: 3 });
    expect((await gw.api('PUT', '/access/lan', { token, body })).json.enabled).toBe(true);
    setUac({ enabled: 0 });
    const reply = await gw.api('PUT', '/access/lan', { token, body: { enabled: false } });
    expect(reply.status).toBe(409);
    expect(reply.json.message).toContain('规则待清理');
    expect((await gw.api('GET', '/access/lan', { token })).json).toMatchObject({
      enabled: false, requested: false, firewall: 'mismatch',
    });
    expect(gw.gw.services.lan.activeAddress()).toBeNull();
    expect(calls.filter(call => call.kind === 'firewall-change')).toHaveLength(1);
    setUac({});
    expect((await gw.api('POST', '/access/lan/firewall', { token })).json).toMatchObject({ enabled: false, firewall: 'missing' });
  });

  it('非回环来源可读状态，不能保存设置或操作防火墙', async () => {
    const { gw, token, calls, body } = await setup();
    const app = createApp(gw.gw.services, { webDist: gw.dataDir });
    const env = { incoming: { socket: { remoteAddress: '192.168.7.5' } } } as Parameters<typeof app.fetch>[1];
    const request = (method: string, path: string) => app.request(`/api/v1/access/lan${path}`, {
      method, headers: { host: `127.0.0.1:${gw.port}`, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(method === 'PUT' ? { body: JSON.stringify(body) } : {}),
    }, env);
    expect((await request('GET', '')).status).toBe(200);
    expect((await request('PUT', '')).status).toBe(403);
    expect((await request('POST', '/firewall')).status).toBe(403);
    expect(calls.every((cmd) => cmd.kind !== 'firewall-change')).toBe(true);
  });

  it('第二监听使用顺延后的同一端口，HTTP 和 WebSocket 校验地址与来源，关闭时只断开第二监听', async () => {
    const { close, port } = await occupyAdjacentPorts();
    try {
      const { gw, token, body, setChangeResult } = await setup('Private', port);
      // 探测和启动之间系统仍可能分配端口。以产品承诺的十次尝试及实际监听端口为准。
      expect(gw.port).toBeGreaterThanOrEqual(port + 2);
      expect(gw.port).toBeLessThan(port + 10);
      const host = `${alias}:${gw.port}`;
      const origin = `http://${host}`;
      const app = createApp(gw.gw.services, { webDist: gw.dataDir });
      const env = { incoming: { socket: { localAddress: alias, remoteAddress: '127.0.0.1' } } } as Parameters<typeof app.fetch>[1];
      const simulated = () => app.request('/api/v1/hello', { headers: { host, origin, authorization: `Bearer ${token}` } }, env);
      expect((await simulated()).status).toBe(403);
      expect(gw.gw.services.auth.checkOrigin(origin, true)).toBe(false);
      expect((await gw.api('PUT', '/access/lan', { token, body })).status).toBe(200);
      expect((await gw.api('GET', '/hello', { token })).json.lanConnection).toBe(false);
      const fromLan = await gw.api('GET', '/hello', { loopback: alias, token, headers: { origin } });
      expect(fromLan.status).toBe(200);
      expect(fromLan.json).toMatchObject({ lanConnection: true, features: { [FeatureKey.Lan]: true } });
      expect((await gw.api('GET', '/hello', { loopback: alias })).status).toBe(401);
      expect((await gw.api('GET', '/hello', { loopback: alias, token, headers: { host: `localhost:${gw.port}` } })).status).toBe(403);
      expect((await gw.api('GET', '/hello', { loopback: alias, token, headers: { host: `dns.example:${gw.port}` } })).status).toBe(403);
      expect((await gw.api('GET', '/hello', { loopback: alias, token, headers: { origin: `http://localhost:${gw.port}` } })).status).toBe(403);
      expect((await gw.api('GET', '/hello', { token, headers: { host } })).status).toBe(403);
      expect((await gw.api('PUT', '/access/lan', { loopback: alias, token, body: { enabled: false } })).status).toBe(403);
      expect((await gw.api('POST', '/access/lan/firewall', { loopback: alias, token })).status).toBe(403);
      const code = gw.gw.services.auth.newPairingCode().code;
      const localCodeFromLan = await gw.api('POST', '/pairing/complete', { loopback: alias, body: { code, deviceName: '离线模拟' } });
      expect(localCodeFromLan.status).toBe(400);
      expect(localCodeFromLan.headers['set-cookie']).toBeUndefined();

      const connect = (headers: Record<string, string> = {}) => new Promise<WebSocket | number>((resolve, reject) => {
        const socket = new WebSocket(`ws://${host}/api/v1/ws`, { headers: { origin, authorization: `Bearer ${token}`, ...headers } });
        socket.once('open', () => resolve(socket));
        socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode ?? 0); });
        socket.once('error', reject);
      });
      expect(await connect({ origin: `http://localhost:${gw.port}` })).toBe(403);
      expect(await connect({ host: `dns.example:${gw.port}` })).toBe(403);
      const lanSocket = await connect();
      if (!(lanSocket instanceof WebSocket)) throw new Error('回环别名 WebSocket 未连接');
      const lanClosed = once(lanSocket, 'close');
      const localSocket = await WsClient.connect(gw.port, token);
      try {
        setChangeResult({ status: 'cancelled' });
        expect((await gw.api('PUT', '/access/lan', { token, body: { enabled: false } })).status).toBe(403);
        await lanClosed;
        expect((await localSocket.call({ op: 'ping', data: {} })).ok).toBe(true);
        await expect(gw.api('GET', '/hello', { loopback: alias, token })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
        expect((await simulated()).status).toBe(403);
        expect(gw.gw.services.auth.checkOrigin(origin, true)).toBe(false);
        setChangeResult({ status: 'ok', stdout: '' });
        expect((await gw.api('POST', '/access/lan/firewall', { token })).json.firewall).toBe('missing');
      } finally { await localSocket.close(); }
    } finally { await close(); }
  });

  it('第二监听失败时回滚开关，本机继续服务，留下可重试清理的规则状态', async () => {
    const { gw, token, body } = await setup();
    const taken = createServer();
    taken.listen(gw.port, alias);
    await once(taken, 'listening');
    try {
      const rejected = await gw.api('PUT', '/access/lan', { token, body });
      expect(rejected.status).toBe(409);
      expect(rejected.json.message).toContain('无法监听');
      const current = await gw.api('GET', '/access/lan', { token });
      expect(current.json).toMatchObject({ enabled: false, requested: false, firewall: 'mismatch' });
      expect(current.json.unavailableReason).toContain('无法监听');
      expect((await gw.api('GET', '/hello', { token })).status).toBe(200);
      expect((await gw.api('POST', '/access/lan/firewall', { token })).json.firewall).toBe('missing');
    } finally { await new Promise<void>((resolve) => taken.close(() => resolve())); }
  });

  it('运行中网卡转成公用时停止第二监听，保留本机，恢复网络后由本机重新启用', async () => {
    const { gw, token, calls, body, setCategory } = await setup('Private', undefined, 40);
    expect((await gw.api('PUT', '/access/lan', { token, body })).status).toBe(200);
    const phone = await WsClient.connect(gw.port, token, {}, undefined, alias);
    try {
      calls.length = 0;
      setCategory('Public');
      await vi.waitFor(() => expect(gw.gw.services.lan.activeAddress()).toBeNull());
      await vi.waitFor(() => expect(phone.ws.readyState).toBe(WebSocket.CLOSED));
      const state = (await gw.api('GET', '/access/lan', { token })).json;
      expect(state).toMatchObject({ requested: true, enabled: false, selected: { category: 'public' } });
      expect(state.unavailableReason).toContain('公用');
      expect(calls.some(call => call.kind === 'firewall-change')).toBe(false);
      setCategory('Private');
      expect((await gw.api('GET', '/access/lan', { token })).json.enabled).toBe(false);
      expect((await gw.api('POST', '/access/lan/firewall', { token })).json.enabled).toBe(true);
      expect((await gw.api('GET', '/hello', { token, loopback: alias })).status).toBe(200);
    } finally { await phone.close(); }
  });

  it('上一次监听的公用网络查询晚到时，保留随后重新开启的专用监听', async () => {
    const { gw, token, body, setCategory, holdNextProfile } = await setup();
    await gw.api('PUT', '/access/lan', { token, body });
    setCategory('Public');
    const gate = holdNextProfile();
    const stale = gw.api('GET', '/access/lan', { token });
    try {
      await gate.arrived;
      await gw.api('PUT', '/access/lan', { token, body: { enabled: false } });
      setCategory('Private');
      expect((await gw.api('PUT', '/access/lan', { token, body })).json.enabled).toBe(true);
    } finally { gate.release(); }
    expect((await stale).json).toMatchObject({ enabled: true, requested: true, selected: { category: 'private' } });
    expect((await gw.api('GET', '/hello', { token, loopback: alias })).status).toBe(200);
  });

  it('启动只恢复仍存在的专用网卡和匹配当前程序端口的规则，失败时不提权', async () => {
    const { gw, token, body, calls, lan, setPresent, setCategory, setRules } = await setup();
    expect((await gw.api('PUT', '/access/lan', { token, body })).status).toBe(200);
    await gw.gw.close();
    const logs: string[] = [];
    const resume = () => startGw({ port: gw.port, lan, log: (message) => logs.push(message) }, gw.dataDir);
    calls.length = 0;
    const valid = await resume();
    try { expect((await valid.api('GET', '/hello', { token, loopback: alias })).json.lanConnection).toBe(true); }
    finally { await valid.stop(); }
    for (const [configure, reason] of [
      [() => setPresent(false), '网卡或私有 IPv4 地址'],
      [() => { setPresent(true); setCategory('Public'); }, '公用网络'],
      [() => { setCategory('Private'); setRules([{ ...rule, address: alias, port: String(gw.port), program: 'C:\\Other\\node.exe' }]); }, '防火墙规则需要更新'],
    ] as const) {
      configure();
      const stopped = await resume();
      try {
        const state = (await stopped.api('GET', '/access/lan', { token })).json;
        expect(state).toMatchObject({ enabled: false, requested: true });
        expect(state.unavailableReason).toContain(reason);
        expect(logs.some((message) => message.includes('局域网保持关闭') && message.includes(reason))).toBe(true);
      } finally { await stopped.stop(); }
    }
    expect(calls.every((cmd) => cmd.kind !== 'firewall-change')).toBe(true);
  });
});
