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
