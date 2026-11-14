import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskUsage } from '@aic/protocol';
import { UsageDetails } from './usage';

const usage: TaskUsage = { turns: 1, reportedTurns: 0, segments: [], total: { source: 'agent', totalTokens: null,
  inputTokens: null, outputTokens: null, thoughtTokens: null, cacheReadTokens: null, cacheWriteTokens: null } };
const render = (amount: number, currency: string) => renderToStaticMarkup(createElement(UsageDetails, {
  usage, independent: null, error: null, config: { model: null, effort: null, usage: { used: 0, size: 0, cost: { amount, currency } } },
}));

it.each(['', ' \t '])('供应商费用单位为空 %j 时不把无单位数值显示成费用', (currency) => {
  const html = render(2.15, currency);
  expect(html).toContain('费用未知');
  expect(html).toContain('Agent 未报告费用单位');
  expect(html).not.toContain('费用 2.15');
  expect(html).toContain('其中 1 轮 Agent 未报告用量');
});

it.each([{ amount: 0, currency: 'USD' }, { amount: 2.15, currency: 'credits' }])('保留报告单位与真实零费用：$currency', ({ amount, currency }) => {
  const html = render(amount, currency);
  expect(html).toContain(`费用 ${amount} ${currency}`);
  expect(html).not.toContain('费用未知');
});

it('两轮都有部分字段时仍标明大字合计只覆盖一轮，真实零也计入覆盖', () => {
  const partial: TaskUsage = { ...usage, turns: 2, reportedTurns: 2, total: { ...usage.total, totalTokens: 12, inputTokens: 30, outputTokens: 0 },
    reportedCounts: { totalTokens: 1, inputTokens: 2, outputTokens: 1, thoughtTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  const html = renderToStaticMarkup(createElement(UsageDetails, { usage: partial, independent: null, error: null, config: { model: null, effort: null } }));
  expect(html).toContain('合计为部分合计：仅 1 / 2 轮报告');
  expect(html).toContain('输出为部分合计：仅 1 / 2 轮报告');
  expect(html).not.toContain('输入为部分合计');
  expect(html).not.toContain('其中 1 轮 Agent 未报告用量');
});
it('旧服务无逐项计数时明确说明覆盖未知', () => {
  expect(render(0, 'USD')).toContain('无法确认合计是否完整');
});
