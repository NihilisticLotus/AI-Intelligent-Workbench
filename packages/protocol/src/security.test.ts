// 安全协议校验测试：覆盖 ProvenanceTier、SecurityCheckItem 与 SecurityStatus 合法及非法输入。
import { describe, expect, it } from 'vitest';
import { ProvenanceTier, SecurityCheckItem, SecurityStatus } from './index';

describe('安全协议（2.1）', () => {
  it('ProvenanceTier 仅接受三档权威来源', () => {
    expect(ProvenanceTier.parse('producer')).toBe('producer');
    expect(ProvenanceTier.parse('delegated')).toBe('delegated');
    expect(ProvenanceTier.parse('external_data')).toBe('external_data');
    expect(ProvenanceTier.safeParse('system').success).toBe(false);
    expect(ProvenanceTier.safeParse('').success).toBe(false);
  });

  it('SecurityCheckItem 严格校验字段且拒绝未知扩展字段', () => {
    const valid = SecurityCheckItem.parse({
      key: 'provenance',
      enabled: true,
      label: '防外部指令冒充',
      detail: '外部资料统一打上只读参考封条。',
    });
    expect(valid.enabled).toBe(true);
    expect(SecurityCheckItem.safeParse({ ...valid, path: 'C:\\secret' }).success).toBe(false);
  });

  it('SecurityStatus 仅接受枚举、布尔与非负整数计数，拒绝额外字段或非法类型', () => {
    const sample = {
      provenanceFence: { active: true, tiers: ['producer', 'delegated', 'external_data'] },
      subprocessEnvIsolation: { active: true },
      egressGuard: { active: true, allowFakeIpProxy: false, blockedLocalPortsCount: 1 },
      secretStorage: { mode: 'dpapi', encryptedCount: 2 },
      lanBoundary: { lanEnabled: false, currentConnection: 'local', localOnlyWriteGuard: true },
      markdownSafety: { blockRemoteImages: true, blockNonHttpLinks: true },
    };
    expect(SecurityStatus.parse(sample)).toEqual(sample);

    expect(SecurityStatus.safeParse({ ...sample, dataDir: 'D:\\.aic-data' }).success).toBe(false);
    expect(SecurityStatus.safeParse({
      ...sample,
      secretStorage: { mode: 'plaintext', encryptedCount: 0 },
    }).success).toBe(false);
    expect(SecurityStatus.safeParse({
      ...sample,
      secretStorage: { mode: 'dpapi', encryptedCount: -1 },
    }).success).toBe(false);
    expect(SecurityStatus.safeParse({
      ...sample,
      egressGuard: { active: true, allowFakeIpProxy: false, blockedLocalPortsCount: 1.5 },
    }).success).toBe(false);
    expect(SecurityStatus.safeParse({
      ...sample,
      lanBoundary: { lanEnabled: true, currentConnection: 'internet', localOnlyWriteGuard: true },
    }).success).toBe(false);
  });
});
