import { describe, expect, it } from 'vitest';
import { IndependentCapabilityField, IndependentDiscoveryParseFailure, type IndependentModel, type IndependentService } from '@aic/protocol';
import { capabilityLabels, capabilityText, discoveryParseFailureText, evidenceApplies, latestRequest, overridePatch } from './independent';

describe('独立模型能力编辑', () => {
  it('固定解析分类有中文说明，旧诊断明确未记录，不推断上游结构', () => {
    expect(discoveryParseFailureText()).toContain('未记录');
    expect(discoveryParseFailureText('data_not_array')).toBe('响应不符合已接入的模型列表结构');
    const descriptions=IndependentDiscoveryParseFailure.options.map(discoveryParseFailureText);
    expect(new Set(descriptions).size).toBe(5);
    expect(descriptions.every(text=>/[\u4e00-\u9fff]/.test(text)&&!text.includes('fixture'))).toBe(true);
  });
  it('16 个协议字段均有中文名称，未知、false、零和空列表各自保留', () => {
    expect(Object.keys(capabilityLabels).sort()).toEqual([...IndependentCapabilityField.options].sort());
    expect(capabilityText(null)).toBe('未知'); expect(capabilityText(false)).toBe('不支持');
    expect(capabilityText(0)).toBe('0'); expect(capabilityText([])).toBe('无可选项');
  });
  it('只提交编辑字段，false 和零不丢失，空白仅恢复当前字段', () => {
    expect(overridePatch({ imageInput: 'false', thinkingBudgetMin: '0', tools: '' })).toEqual({ imageInput: false, thinkingBudgetMin: 0, tools: null });
    expect(overridePatch({ effortLevels: 'low， high', inputModalities: 'text,image', outputModalities: '[]' })).toEqual({ effortLevels: ['low', 'high'], inputModalities: ['text', 'image'], outputModalities: [] });
  });
  it.each(['1e6', '0x100', '2.5', '-1', '1000000001', ''])('窗口非法格式与范围 %s 不被悄悄改写', (input) => {
    if (input === '') expect(overridePatch({ contextWindow: input })).toEqual({ contextWindow: null });
    else expect(() => overridePatch({ contextWindow: input })).toThrow();
  });
  it('拒绝重复强度、未知布尔文本和超长值', () => {
    expect(() => overridePatch({ effortLevels: 'high,high' })).toThrow();
    expect(() => overridePatch({ thinking: 'yes' })).toThrow();
    expect(() => overridePatch({ defaultEffort: 'x'.repeat(101) })).toThrow();
  });
  it('范围匹配必须包含服务、配置修订、协议、API 版本、套餐和模型 ID', () => {
    const service = { id: 's', configRevision: 2, protocol: 'responses', apiVersion: null, providerId: 'p', plan: 'pro' } as IndependentService;
    const model = { remoteModelId: 'm' } as IndependentModel;
    const evidence = { scope: { serviceId: 's', configRevision: 2, protocol: 'responses', apiVersion: null, providerId: 'p', plan: 'pro', remoteModelId: 'm' } } as IndependentModel['evidence'][number];
    expect(evidenceApplies(service, model, evidence)).toBe(true);
    for (const [key, value] of Object.entries(evidence.scope)) expect(evidenceApplies(service, model, { ...evidence, scope: { ...evidence.scope, [key]: value === null ? 'changed' : 'different' } })).toBe(false);
  });
  it('目录刷新后旧响应和离开页面后的响应不能覆盖新快照', async () => {
    const requests = latestRequest(); let show = '';
    let finish!: (value: string) => void; const slow = new Promise<string>((resolve) => { finish = resolve; });
    const old = requests.begin(); const pending = slow.then((v) => { if (requests.current(old)) show = v; });
    const newer = requests.begin(); if (requests.current(newer)) show = '新服务目录'; finish('旧服务目录'); await pending;
    expect(show).toBe('新服务目录'); requests.invalidate(); expect(requests.current(newer)).toBe(false);
  });
});
