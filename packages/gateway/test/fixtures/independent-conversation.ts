// 仅用于默认测试的跨进程崩溃夹具，无真实模型与网络。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDb } from '../../src/db';
import { IndependentConversationStore } from '../../src/independent/conversation';
import { seed } from './independent-journal';

export const binding = { taskId: 'task', serviceId: 'service', modelId: 'model', configRevision: 1, modelRevision: 1, createdAt: 1 };
export const limits = { maxModelCalls: 5, maxToolCalls: 5, maxOutputTokens: 100, timeoutMs: 10_000, maxContextBytes: 100_000 };
export const user = { role: 'user' as const, text: '验证独立回合', attachments: [] };
export const usage = { inputTokens: 10, outputTokens: 2, cacheReadTokens: null, cacheWriteTokens: null };
export const call = { id: 'call-1', name: 'write', arguments: { text: '只执行一次' } };
export const toolReply = { role: 'assistant' as const, text: '', toolCalls: [call], stopReason: 'tool_calls' as const, usage };
export const finalReply = { role: 'assistant' as const, text: '完成', toolCalls: [], stopReason: 'complete' as const, usage };

if (process.argv[1]?.endsWith('independent-conversation.ts')) {
  const [directory, stage] = process.argv.slice(2);
  if (!directory || !stage) throw new Error('缺少夹具目录或阶段');
  const db = openDb(path.join(directory, 'conversation.db')); seed(db);
  const store = new IndependentConversationStore(db); const turn = store.create(binding, 'session', user, limits);
  const owner = store.acquire(turn.id); store.claimModel(turn.id, owner);
  if (stage !== 'requested') store.assistant(turn.id, owner, toolReply);
  if (['effect', 'result'].includes(stage)) {
    store.claimTool(turn.id, owner); writeFileSync(path.join(directory, 'effect.txt'), '只执行一次');
    if (stage === 'result') store.tool(turn.id, owner, { role: 'tool', callId: call.id, name: call.name, text: '完成', outcome: 'ok' });
  }
  writeFileSync(path.join(directory, 'ready'), JSON.stringify({ turnId: turn.id, pid: process.pid }));
  setInterval(() => {}, 1000);
}
