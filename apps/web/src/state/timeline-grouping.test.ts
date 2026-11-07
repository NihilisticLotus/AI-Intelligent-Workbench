// 对话时间线（2026-11-07 用户人工验证发现的两个问题）：
// 1) 来回切换思考强度会堆出一串“已切换”提示；2) Agent 在工具调用之间分段输出，每段都显示头像和“正在思考”。
import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@aic/protocol';
import { buildTimeline } from './core';

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, ts = ++seq * 1000) =>
  ({ seq: ++seq, ts, type, taskId: 't1', sessionId: 's1', data }) as unknown as EventEnvelope;

describe('时间线', () => {
  it('连续切换思考强度（中间没有新消息）只留一行，显示最终结果', () => {
    const items = buildTimeline([
      ev('session.started', { agent: 'codex', model: 'm' }),
      ev('session.config', { model: 'm', effort: 'medium' }),
      ev('message.user', { messageId: 'u1', text: '你好' }),
      ev('message.delta', { messageId: 'a1', text: '好' }),
      ev('message.done', { messageId: 'a1' }),
      ev('session.config', { effort: 'xhigh' }),
      ev('session.config', { effort: 'high' }),
      ev('session.config', { effort: 'low' }),
    ]);
    const cfg = items.filter((x) => x.kind === 'config');
    expect(cfg).toHaveLength(1);
    expect(cfg[0]).toMatchObject({ effort: 'low' });
  });

  it('有新消息隔开时，各自保留一行', () => {
    const items = buildTimeline([
      ev('session.started', { agent: 'codex', model: 'm' }),
      ev('session.config', { effort: 'medium' }),
      ev('session.config', { effort: 'high' }),
      ev('message.user', { messageId: 'u1', text: '继续' }),
      ev('session.config', { effort: 'low' }),
    ]);
    expect(items.filter((x) => x.kind === 'config')).toHaveLength(2);
  });

  it('同一轮里分段输出：只有第一段带头像和名称，之前的片段不再显示“正在思考”', () => {
    const items = buildTimeline([
      ev('session.started', { agent: 'codex', model: 'm' }),
      ev('message.user', { messageId: 'u1', text: '查一下 UE 5.9' }),
      ev('thought.delta', { messageId: 'a1', text: '先搜官方' }),
      ev('message.delta', { messageId: 'a1', text: '我先查一下。' }),
      ev('tool.start', { toolId: 'k1', kind: 'search', title: 'Web search', target: null }),
      ev('tool.end', { toolId: 'k1', ok: true, summary: null }),
      ev('thought.delta', { messageId: 'a2', text: '**Searching official news pages**' }),
      ev('tool.start', { toolId: 'k2', kind: 'search', title: 'Web search', target: null }),
      ev('tool.end', { toolId: 'k2', ok: true, summary: null }),
      ev('thought.delta', { messageId: 'a3', text: '整理结论' }),
      ev('message.delta', { messageId: 'a3', text: 'UE 5.9 预计……' }),
      ev('message.done', { messageId: 'a3' }),
      ev('message.user', { messageId: 'u2', text: '谢谢' }),
      ev('message.delta', { messageId: 'a4', text: '不客气' }),
    ]);
    const agents = items.filter((x) => x.kind === 'agent');
    expect(agents.map((a) => a.cont)).toEqual([false, true, true, false]);
    // 前面的片段都已结束：思考有结束时间，不会一直显示“正在思考”
    for (const a of agents.slice(0, 3)) expect(a.done).toBe(true);
    expect(agents[1]!.thoughtEnd).not.toBeNull();
  });
});
