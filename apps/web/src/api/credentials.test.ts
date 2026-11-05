// 设备凭据测试：按 Platform.tokenDelivery 保存密钥或令牌，生成对应的请求头和 WebSocket 子协议。
import { describe, expect, it } from 'vitest';
import type { SecureStorage } from '../platform/types';
import { Credentials } from './credentials';

function memStorage(): SecureStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data, secure: true,
    async get(k) { return data.get(k) ?? null; },
    async set(k, v) { data.set(k, v); },
    async remove(k) { data.delete(k); },
  };
}

const device = { id: 'd1', name: '本机', kind: 'browser' as const, lastIp: null, lastSeen: null, pairedAt: 1, current: true };

describe('Credentials', () => {
  it('浏览器（cookie）：保存设备密钥，放在 X-AIC-Key 头和 aic-key 子协议里', async () => {
    const st = memStorage();
    const c = new Credentials(st, 'cookie');
    await c.load();
    expect(c.headers()).toEqual({});
    expect(c.wsProtocols()).toEqual(['aic.v1']);
    await c.save({ device, key: 'k123' });
    expect(c.headers()).toEqual({ 'x-aic-key': 'k123' });
    expect(c.wsProtocols()).toEqual(['aic.v1', 'aic-key.k123']);
    // 重新启动后从存储里读回
    const c2 = new Credentials(st, 'cookie');
    await c2.load();
    expect(c2.has).toBe(true);
    await c2.clear();
    expect(c2.headers()).toEqual({});
    expect(st.data.size).toBe(0);
  });

  it('桌面 / 手机（bearer）：保存令牌，放在 Authorization 头和 aic-bearer 子协议里', async () => {
    const c = new Credentials(memStorage(), 'bearer');
    await c.load();
    await c.save({ device: { ...device, kind: 'desktop' }, token: 't456' });
    expect(c.headers()).toEqual({ authorization: 'Bearer t456' });
    expect(c.wsProtocols()).toEqual(['aic.v1', 'aic-bearer.t456']);
  });
});
