import { EventEnvelope, type LanInterface, type LanState } from '@aic/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanControls } from '../pages/device-access-section';
import { choiceDialog, confirmDialog, DialogHost, dismissSessionOverlays, MenuHost, openMenu } from '../components/ui';
import { canUseSystemNotifications, createBrowserPlatform } from '../platform/browser';
import {
  canToggleLan, isLanHostname, localDeadline, networkChoice, pairCodeFromHash, pairingResultMessage, pollingOutcome, secondsUntil, updateAccessPrompts,
} from './lan-access';

const network: LanInterface = { name: '离线网卡', address: '192.168.8.5', category: 'private' };
const lan: LanState = { enabled: false, requested: false, selected: null, port: 17890, firewall: 'missing', interfaces: [network], unavailableReason: null };

describe('网页设备访问', () => {
  it('配对失效时收起工作台菜单和对话框，并取消仍待选择的操作', async () => {
    const selected = vi.fn();
    openMenu({} as HTMLElement, [{ label: '打开任务', onSelect: selected }]);
    const confirmed = confirmDialog({ title: '删除任务', body: '测试', ok: '删除' });
    const choice = choiceDialog({ title: '选择操作', body: '测试', choices: [{ value: 'continue', label: '继续' }] });
    expect(renderToStaticMarkup(createElement(DialogHost))).toContain('删除任务');
    expect(renderToStaticMarkup(createElement(MenuHost))).toContain('打开任务');
    dismissSessionOverlays();
    expect(renderToStaticMarkup(createElement(DialogHost))).toBe('');
    expect(renderToStaticMarkup(createElement(MenuHost))).toBe('');
    expect(await confirmed).toBe(false);
    expect(await choice).toBeNull();
    expect(selected).not.toHaveBeenCalled();
  });

  it('专用网可开启，公用网显示具体原因，局域网页面只呈现状态', () => {
    const props = { busy: false, onSelect: vi.fn(), onToggle: vi.fn(), onUpdate: vi.fn() };
    const publicNet = { ...network, category: 'public' as const };
    const publicState = { ...lan, interfaces: [publicNet] };
    const local = renderToStaticMarkup(createElement(LanControls, { ...props, state: lan, choice: network, remote: false }));
    expect(local).toContain('aria-checked="false"');
    expect(local).toContain('只有这台电脑能访问');
    const publicPage = renderToStaticMarkup(createElement(LanControls, { ...props, state: publicState, choice: publicNet, remote: false }));
    expect(publicPage).toMatch(/role="switch"[^>]*disabled/);
    expect(publicPage).toContain('Windows 设置里改为专用网络');
    const remoteState: LanState = { ...lan, enabled: true, requested: true, selected: network, firewall: 'mismatch' };
    const remote = renderToStaticMarkup(createElement(LanControls, { ...props, state: remoteState, choice: network, remote: true }));
    expect(remote).toContain('防火墙规则需要更新');
    expect(remote).not.toContain('role="switch"');
    expect(remote).not.toContain('>更新规则<');
    expect(canToggleLan(remoteState, network, false)).toBe(true);
    expect(networkChoice(lan, null)).toEqual(network);
    expect(networkChoice({ ...lan, interfaces: [publicNet, network] }, null)).toBeNull();
    const other = { ...network, name: '另一张网卡', address: '192.168.8.6' };
    expect(networkChoice({ ...remoteState, interfaces: [network, other], selected: other }, network)).toEqual(other);
  });

  it('启动时没能恢复的局域网仍显示为开启，开关用于关闭', () => {
    const props = { busy: false, onSelect: vi.fn(), onToggle: vi.fn(), onUpdate: vi.fn() };
    const pendingState: LanState = { ...lan, requested: true, selected: network, firewall: 'mismatch', unavailableReason: '防火墙规则需要更新，请在设备与访问中检查' };
    const page = renderToStaticMarkup(createElement(LanControls, { ...props, state: pendingState, choice: network, remote: false }));
    expect(page).toContain('aria-checked="true"');
    expect(page).toContain('已开启，暂未生效');
    expect(page).not.toContain('只有这台电脑能访问');
    expect(page).toContain('防火墙规则需要更新');
    expect(page).toMatch(/<select[^>]*disabled/);
    expect(canToggleLan(pendingState, null, false)).toBe(true);
    const leftover = renderToStaticMarkup(createElement(LanControls, { ...props, state: { ...lan, firewall: 'mismatch' }, choice: network, remote: false }));
    expect(leftover).toContain('有残留规则');
  });

  it('配对片段可预填，待确认状态按拒绝、超时和逐 IP 锁定时间显示', () => {
    expect(isLanHostname('127.0.0.2')).toBe(true);
    expect(isLanHostname('localhost')).toBe(false);
    expect(pairCodeFromHash('#pair=%30%30%31%32%33%34')).toBe('001234');
    expect(pairCodeFromHash('#/settings')).toBeNull();
    expect(() => pairCodeFromHash('#pair=%FF')).not.toThrow();
    expect(pollingOutcome(null, 1000, 500)).toBe('pending');
    expect(pollingOutcome(null, 1000, 1000)).toBe('expired');
    expect(pollingOutcome({ status: 'rejected' }, 1000, 1001)).toBe('rejected');
    // 手机时钟比电脑快：服务端仍在等待就继续等，不按本地时钟提前判超时
    expect(pollingOutcome({ status: 'pending', id: `lp_${'a'.repeat(32)}`, expiresAt: 1000 }, 1000, 5000)).toBe('pending');
    expect(pairingResultMessage.unavailable).toContain('已断开');
    expect(secondsUntil(2500, 1000)).toBe(2);
  });

  it('手机快慢都按实际剩余时长等待确认或解除限流，兼容旧版时间戳', () => {
    for (const received of [200, 9_000_000]) {
      expect(localDeadline(1_120_000, 1_000_000, received)).toBe(received + 120_000);
      expect(localDeadline(1_060_000, 1_000_000, received)).toBe(received + 60_000);
      expect(localDeadline(900_000, 1_000_000, received)).toBe(received);
    }
    expect(localDeadline(1_000_000, undefined, 200)).toBe(1_000_000);
  });

  it('按接收顺序处理配对与操作请求，忽略重复及超时请求', () => {
    const base = { seq: 1, ts: 100, taskId: null, sessionId: null };
    const first = EventEnvelope.parse({ ...base, type: 'pairing.requested', data: {
      id: `lp_${'a'.repeat(32)}`, name: '离线手机', browser: 'Safari', ip: '127.0.0.1', expiresAt: 1000,
    } });
    const second = EventEnvelope.parse({ ...base, seq: 2, type: 'access.confirm_requested', data: {
      id: `access_${'a'.repeat(12)}`, operation: 'project.delete', deviceId: 'device', deviceName: '离线手机', ip: '127.0.0.1',
      objectId: 'id', objectName: '项目', expiresAt: 1000,
    } });
    if (first.type !== 'pairing.requested') throw new Error('缺少配对事件');
    const queue = updateAccessPrompts(updateAccessPrompts([], first, 500), second, 500);
    expect(queue.map((entry) => entry.kind)).toEqual(['pairing', 'operation']);
    expect(updateAccessPrompts(queue, first, 500)).toBe(queue);
    expect(updateAccessPrompts([], second, 1000)).toEqual([]);
    const allowed = EventEnvelope.parse({ ...base, seq: 3, type: 'pairing.resolved', data: { id: first.data.id, status: 'allowed' } });
    expect(updateAccessPrompts(queue, allowed).map((entry) => entry.kind)).toEqual(['operation']);
  });
});

describe('浏览器能力降级', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('非安全来源使用页面通知，剪贴板不可用时允许上层显示手动复制', async () => {
    expect(canUseSystemNotifications(false, true)).toBe(false);
    expect(canUseSystemNotifications(true, false)).toBe(false);
    expect(canUseSystemNotifications(true, true)).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(await createBrowserPlatform().copyText('临时文本')).toBe(false);
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await createBrowserPlatform().copyText('临时文本')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('临时文本');
  });
});
