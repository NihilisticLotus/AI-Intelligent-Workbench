import { afterEach, describe, expect, it } from 'vitest';
import type { NetworkInterfaceInfoIPv4 } from 'node:os';
import { LanState } from '@aic/protocol';
import { createApp } from '../src/http/app';
import { firewallChangeArgs, firewallRuleMatches, firewallRuleName } from '../src/lan/firewall';
import { isPrivateIpv4, listPrivateInterfaces } from '../src/lan/interfaces';
import { parseNetworkProfiles } from '../src/lan/network-profile';
import type { LanCommand, LanCommandResult } from '../src/lan/windows-executor';
import { startGw, type TestGw } from './helpers';

const address = '192.168.7.4';
const name = '家庭 Wi-Fi';
const program = 'C:\\Program Files\\nodejs\\node.exe';
const rule = {
  address, port: '17890', program, remoteAddress: 'LocalSubnet', profiles: 2, protocol: 6, direction: 1, action: 1, edge: false, enabled: true,
};
const ipv4 = (address: string, internal = false): NetworkInterfaceInfoIPv4 => ({
  address, netmask: '255.255.255.0', family: 'IPv4', mac: '', internal, cidr: `${address}/24`,
});

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

  async function setup(category = 'Private') {
    const calls: LanCommand[] = [];
    let installed: unknown[] = [];
    let changeResult: LanCommandResult = { status: 'ok', stdout: '' };
    let actualPort = 0;
    const gw = await startGw({ lan: {
      supported: true, program, readInterfaces: () => ({ [name]: [ipv4(address)] }),
      execute: async (cmd) => {
        calls.push(cmd);
        if (cmd.kind === 'network-profile') return { status: 'ok', stdout: JSON.stringify([{ name, category }]) };
        if (cmd.kind === 'firewall-query') return { status: 'ok', stdout: JSON.stringify(installed) };
        if (changeResult.status === 'ok') {
          installed = cmd.env?.AIC_LAN_RULE_ARGS?.includes('"delete"') ? [] : [{ ...rule, port: String(actualPort) }];
        }
        return changeResult;
      },
    } });
    t = gw;
    actualPort = gw.port;
    const token = await gw.pair();
    const body = { enabled: true, name, address };
    return { gw, token, calls, body, setChangeResult: (value: LanCommandResult) => { changeResult = value; } };
  }

  it('默认关闭，已认证本机可保存选择，规则显式更新且复核，禁用后可删除规则', async () => {
    const { gw, token, calls, body } = await setup();
    expect((await gw.api('GET', '/access/lan')).status).toBe(401);
    expect(calls).toHaveLength(0);
    const before = LanState.parse((await gw.api('GET', '/access/lan', { token })).json);
    expect(before).toMatchObject({ enabled: false, requested: false, port: gw.port, interfaces: [{ name, address, category: 'private' }], firewall: 'missing' });
    expect(calls.find((cmd) => cmd.kind === 'network-profile')?.timeoutMs).toBe(10_000);
    expect((await gw.api('PUT', '/access/lan', { token, body: { ...body, address: '10.0.0.3' } })).status).toBe(403);
    const config = await gw.api('PUT', '/access/lan', { token, body });
    expect(config.json).toMatchObject({ enabled: false, requested: true, selected: { address, name }, firewall: 'missing' });
    expect(calls.filter((cmd) => cmd.kind === 'firewall-change')).toHaveLength(0);
    const updated = await gw.api('POST', '/access/lan/firewall', { token });
    expect(updated.json.firewall).toBe('matched');
    expect(calls.find((cmd) => cmd.kind === 'firewall-change')?.env?.AIC_LAN_RULE_ARGS).toContain(`"localport=${gw.port}"`);
    await gw.api('PUT', '/access/lan', { token, body: { enabled: false } });
    expect((await gw.api('POST', '/access/lan/firewall', { token })).json).toMatchObject({ enabled: false, requested: false, firewall: 'missing' });
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
    await gw.api('PUT', '/access/lan', { token, body });
    for (const [status, expected] of [['cancelled', '没有添加防火墙规则'], ['failed', '规则写入失败'], ['timeout', '超时']] as const) {
      setChangeResult({ status });
      const result = await gw.api('POST', '/access/lan/firewall', { token });
      expect(result.status).toBe(status === 'cancelled' ? 403 : 409);
      expect(result.json.message).toContain(expected);
      expect((await gw.api('GET', '/access/lan', { token })).json).toMatchObject({ enabled: false, firewall: 'missing' });
    }
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
});
