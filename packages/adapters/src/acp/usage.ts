import type { TurnTokenUsage } from '@aic/protocol';

/** ACP 草案的缓存字段名与工作台不同；异常字段不转换成数字。 */
export function promptUsage(value: unknown): TurnTokenUsage | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  return { inputTokens: count(raw.inputTokens), outputTokens: count(raw.outputTokens),
    thoughtTokens: count(raw.thoughtTokens), cacheReadTokens: count(raw.cachedReadTokens),
    cacheWriteTokens: count(raw.cachedWriteTokens), totalTokens: count(raw.totalTokens) };
}
