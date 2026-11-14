import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UserMsg } from './Chat';

it('无回复轮次用量在用户消息下可见且可聚焦，不伪造 Agent 回复', () => {
  const props = { anchor: 'u1', text: '输出前取消', ts: 1, taskId: 't1' };
  const html = renderToStaticMarkup(createElement(UserMsg, { ...props, usage: { source: 'agent', totalTokens: null, inputTokens: null,
    outputTokens: null, thoughtTokens: null, cacheReadTokens: null, cacheWriteTokens: null } }));
  expect(html).toContain('用量：未报告'); expect(html).toContain('tabindex="0"');
  expect(html).not.toContain('正在回复');
  expect(renderToStaticMarkup(createElement(UserMsg, props))).not.toContain('turn-usage');
});
