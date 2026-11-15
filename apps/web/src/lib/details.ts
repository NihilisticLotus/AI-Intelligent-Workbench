import type { EventEnvelope, IndependentContextReport } from '@aic/protocol';
import type { SessionCfg } from '../state/core';
import { formatTokens } from './tokens';

export const detailSections = ['environment', 'plan', 'context', 'usage', 'connection', 'output'] as const;
export type DetailSection = typeof detailSections[number];
export const defaultDetailSections: DetailSection[] = ['plan', 'context'];
export function validDetailSections(value: unknown): DetailSection[] {
  return Array.isArray(value) ? detailSections.filter((key) => value.includes(key)) : [...defaultDetailSections];
}
export function contextValue(usage: SessionCfg['usage'], estimate?: IndependentContextReport | null) {
  const used = usage?.used ?? estimate?.estimatedInputTokens ?? null;
  const size = usage?.size && usage.size > 0 ? usage.size : !usage ? estimate?.contextWindow ?? null : null;
  return { used, size, estimated: !usage && used !== null, percent: used !== null && size ? Math.round(100 * used / size) : null };
}
export function contextSummary(value: ReturnType<typeof contextValue>, agent: string, model: string | null) {
  const amount = value.percent !== null ? `${value.percent}%` : value.used !== null ? formatTokens(value.used) : '未报告';
  return `${amount}${value.estimated ? '（估算）' : ''} · ${agent}${model ? ' · ' + model : ''}`;
}

/** 某类事件最近一条的序号；从末尾往前找，不复制整段日志。 */
export function lastSeq(log: readonly EventEnvelope[] | undefined, type: EventEnvelope['type']): number | undefined {
  if (!log) return undefined;
  for (let i = log.length - 1; i >= 0; i--) if (log[i]!.type === type) return log[i]!.seq;
  return undefined;
}
