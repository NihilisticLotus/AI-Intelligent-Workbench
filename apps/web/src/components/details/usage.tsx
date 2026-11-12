import type { TaskUsage, IndependentTaskState } from '@aic/protocol';
import type { SessionCfg } from '../../state/core';
import { formatTokens } from '../../lib/tokens';
import { clock } from '../../lib/format';
export function UsageDetails({ usage, independent, config, error }: { usage: TaskUsage | null; independent: IndependentTaskState | null; config: SessionCfg; error: string | null }) {
  if (!usage) return <p className="d-note" role="status">{error ?? '正在读取用量…'}</p>;
  const start = usage.segments.length ? Math.min(...usage.segments.map((s) => s.startedAt)) : null;
  const totals = usage.total, missing = usage.turns - usage.reportedTurns;
  const cost = config.usage?.cost;
  const reserved = independent?.budget.reservedMicros;
  return <>{error ? <p className="d-note" role="alert">刷新失败，以下为上次读取的用量：{error}</p> : null}<div className="token-total"><b>{formatTokens(totals.totalTokens)}</b><span>token · {usage.turns} 轮 · {usage.segments.length} 段会话{start !== null ? ` · 从 ${clock(start)}开始` : ''}</span></div>
    <dl className="d-dl"><dt>输入</dt><dd>{formatTokens(totals.inputTokens)}</dd><dt className="ind">读缓存</dt><dd>{formatTokens(totals.cacheReadTokens)}</dd><dt className="ind">写缓存</dt><dd>{formatTokens(totals.cacheWriteTokens)}</dd><dt>输出</dt><dd>{formatTokens(totals.outputTokens)}</dd><dt className="ind">思考</dt><dd>{formatTokens(totals.thoughtTokens)}</dd></dl>
    {missing ? <p className="d-note">其中 {missing} 轮 Agent 未报告用量，合计不含这些轮。</p> : null}
    {usage.segments.length > 1 ? <ul className="d-segments">{usage.segments.map((s, i) => <li key={s.sessionId ?? 'missing'}><span>会话 {i + 1} · {s.model ?? s.agent} · {s.turns} 轮</span><span>{formatTokens(s.totals.totalTokens)}</span></li>)}</ul> : null}
    <p className="d-note">{cost ? `费用 ${cost.amount} ${cost.currency}` : reserved != null ? `人工预留 ${(reserved / 1_000_000).toFixed(2)} ${independent?.budget.policy.money?.currency ?? ''}（预留，不是实际账单）` : '费用未知'}<br />额度未知</p></>;
}
