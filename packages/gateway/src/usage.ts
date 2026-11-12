import { TaskUsage, TurnUsage, TurnTokenUsage, type IndependentRequestRecord } from '@aic/protocol';
import type { Db } from './db';
import type { EventStore } from './events';
import { Errors } from './util';

export const tokenFields = ['inputTokens', 'outputTokens', 'thoughtTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'] as const;
export const emptyUsage = (source: TurnUsage['source']): TurnUsage => ({ source,
  inputTokens: null, outputTokens: null, thoughtTokens: null, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null });

/** 任务合计只加已报告的值；独立回合中的任一生成请求缺项则该项未知。 */
export function sumUsage(values: TurnTokenUsage[], source: TurnUsage['source'], requireAll = false): TurnUsage {
  const result = emptyUsage(source);
  for (const key of tokenFields) {
    const numbers = values.map((v) => v[key]).filter((n): n is number => n !== null);
    const sum = numbers.reduce((a, b) => a + b, 0);
    if (numbers.length && (!requireAll || numbers.length === values.length) && Number.isSafeInteger(sum)) result[key] = sum;
  }
  return result;
}

export function independentTurnUsage(records: IndependentRequestRecord[]): TurnTokenUsage {
  const { source: _source, ...usage } = sumUsage(records.filter((r) => r.attempt.kind === 'model').map((r) => ({
    inputTokens: r.settlement?.usage?.inputTokens ?? null, outputTokens: r.settlement?.usage?.outputTokens ?? null,
    cacheReadTokens: r.settlement?.usage?.cacheReadTokens ?? null, cacheWriteTokens: r.settlement?.usage?.cacheWriteTokens ?? null,
    // 历史账本没有这两项，不能用输入加输出来冒充上游报告的总量。
    thoughtTokens: r.settlement?.usage?.thoughtTokens ?? null, totalTokens: r.settlement?.usage?.totalTokens ?? null,
  })), 'independent', true);
  return TurnTokenUsage.parse(usage);
}

export function recordTurnUsage(db: Db, events: EventStore, taskId: string, sessionId: string | null, messageId: string, usage: TurnUsage) {
  const checked = TurnUsage.parse(usage);
  db.tx(() => {
    const inserted = db.run('INSERT OR IGNORE INTO turn_usage(task_id,session_id,message_id,usage_json,at) VALUES (?,?,?,?,?)',
      taskId, sessionId, messageId, JSON.stringify(checked), Date.now());
    if (inserted.changes) events.append({ type: 'turn.usage', taskId, sessionId, data: { messageId, usage: checked } });
  });
}

export function taskUsage(db: Db, taskId: string): TaskUsage {
  const task = db.get<{ agent: TaskUsage['segments'][number]['agent']; model: string | null }>('SELECT agent,model FROM tasks WHERE id=?', taskId);
  if (!task) throw Errors.notFound('找不到任务');
  const source = task.agent === 'independent' ? 'independent' : 'agent';
  const rows = db.all<{ session_id: string | null; usage_json: string; at: number; agent_id: typeof task.agent | null; model: string | null; started_at: number | null }>(
    `SELECT u.*,s.agent_id,s.model,s.started_at FROM turn_usage u LEFT JOIN sessions s ON u.session_id=s.id WHERE u.task_id=? ORDER BY u.at,u.rowid`, taskId);
  const groups = new Map<string | null, typeof rows>();
  for (const row of rows) { const group = groups.get(row.session_id) ?? []; group.push(row); groups.set(row.session_id, group); }
  const reported = (usage: TurnUsage) => tokenFields.some((key) => usage[key] !== null);
  const segments = [...groups].map(([sessionId, group]) => {
    const first = group[0]!, values = group.map((r) => TurnUsage.parse(JSON.parse(r.usage_json)));
    return { sessionId, agent: first.agent_id ?? task.agent, model: first.model, startedAt: first.started_at ?? first.at,
      turns: group.length, reportedTurns: values.filter(reported).length, totals: sumUsage(values, values[0]!.source) };
  });
  return TaskUsage.parse({ segments, turns: rows.length, reportedTurns: segments.reduce((n, s) => n + s.reportedTurns, 0),
    total: sumUsage(segments.map((s) => s.totals), source) });
}
