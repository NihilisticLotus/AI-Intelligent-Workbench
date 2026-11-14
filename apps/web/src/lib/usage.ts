import type { EventEnvelope, TurnUsage, TaskUsage } from '@aic/protocol';
import type { SessionCfg } from '../state/core';
import { contextValue } from './details';
import { formatTokens } from './tokens';

export function ringState(usage: SessionCfg['usage']) {
  const value = contextValue(usage);
  const ratio = value.used !== null && value.size ? value.used / value.size : null;
  const tone = ratio === null ? 'unknown' : ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'attn' : 'normal';
  const text = value.used === null ? '上下文用量未报告' : value.size
    ? `上下文 ${formatTokens(value.used)} / ${formatTokens(value.size)}（${value.percent}%）`
    : `上下文 ${formatTokens(value.used)}（窗口大小未报告）`;
  return { tone, progress: Math.max(0, Math.min(100, (ratio ?? 0) * 100)), text: text + (tone === 'danger' ? '；Agent 会自动压缩较早的对话' : '') };
}

const fields = ['totalTokens', 'inputTokens', 'outputTokens', 'thoughtTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
const labels = ['合计', '输入', '输出', '思考', '读缓存', '写缓存'];
export function turnUsageText(usage: TurnUsage) {
  return {
    summary: fields.every((key) => usage[key] === null) ? '用量：未报告'
      : `${formatTokens(usage.totalTokens)} token · 输入 ${formatTokens(usage.inputTokens)} · 输出 ${formatTokens(usage.outputTokens)}`,
    detail: fields.map((key, i) => `${labels[i]} ${usage[key] ?? '未报告'}`).join(' · '),
  };
}
export function turnUsages(events: readonly EventEnvelope[]) {
  const result = new Map<string, TurnUsage>();
  for (const ev of events) if (ev.type === 'turn.usage') result.set(ev.data.messageId, ev.data.usage);
  return result;
}

/** 不用“任一字段已报告”的轮数冒充各字段覆盖范围。 */
export function usageCoverageText(usage: TaskUsage): string[] {
  if (!usage.turns) return [];
  if (!usage.reportedCounts) return ['各项仅合计已报告的值；当前服务未提供逐项覆盖轮数，无法确认合计是否完整。'];
  return fields.flatMap((key, index) => {
    const count = usage.reportedCounts![key];
    return count > 0 && count < usage.turns
      ? [`${labels[index]}为部分合计：仅 ${count} / ${usage.turns} 轮报告，未报告的轮次不计入。`] : [];
  });
}
