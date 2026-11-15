import { describe, expect, it } from 'vitest';
import { contextSummary, contextValue, defaultDetailSections, validDetailSections, lastSeq } from './details';
import { formatTokens } from './tokens';
describe('详细面板摘要与默认折叠',()=>{
  it('只默认展开计划和上下文，坏偏好不引入其他节',()=>{
    expect(defaultDetailSections).toEqual(['plan','context']); expect(validDetailSections(null)).toEqual(defaultDetailSections);
    expect(validDetailSections(['output','unknown','output'])).toEqual(['output']); expect(validDetailSections([])).toEqual([]);
  });
  it('未知窗口没有百分比，真实零与完全未知分别保留',()=>{
    expect(contextSummary(contextValue(undefined),'演示',null)).toBe('未报告 · 演示');
    expect(contextSummary(contextValue({used:0,size:0}),'演示',null)).toBe('0 · 演示');
    expect(contextSummary(contextValue({used:76200,size:200000}),'演示','快')).toBe('38% · 演示 · 快');
  });
  it('用量格式区分未知与零，千位保留最多一位小数',()=>{
    expect([null,0,999,1000,1234,1000000].map(formatTokens)).toEqual(['未报告','0','999','1k','1.2k','1000k']);
  });
});

describe('lastSeq（ISSUE-0076）', () => {
  it('返回最近一条同类事件的序号，没有时为 undefined', () => {
    const ev = (seq: number, type: string) => ({ seq, type }) as never;
    expect(lastSeq([ev(1, 'turn.usage'), ev(2, 'tool.end'), ev(3, 'turn.usage'), ev(4, 'message.delta')], 'turn.usage')).toBe(3);
    expect(lastSeq([ev(1, 'tool.end')], 'turn.usage')).toBeUndefined();
    expect(lastSeq(undefined, 'turn.usage')).toBeUndefined();
  });
});
