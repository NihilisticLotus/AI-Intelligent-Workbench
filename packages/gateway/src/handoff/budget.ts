import type { HandoffLevel } from '@aic/protocol';

export function estimateTokens(text: string): number {
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! < 128 ? 1 : 4;
  return Math.ceil(units * 1.15 / 4);
}

export function targetWindow(...values: unknown[]): number {
  for (const n of values) if (typeof n === 'number' && Number.isSafeInteger(n) && n > 0) return n;
  return 128_000;
}

export function handoffLevel(tokens: number, window: number, hasSummary: boolean): HandoffLevel {
  if (tokens <= window * 0.35) return 'H2';
  return hasSummary ? 'H3' : 'H4';
}

/** 按完整 UTF-8 字符保留首尾，截断标志也计入字节上限。 */
export function clipBytes(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maxBytes) return value;
  const marker = '\n…（已截断）\n';
  const keep = Math.floor((maxBytes - Buffer.byteLength(marker)) / 2);
  let first = keep, last = bytes.length - keep;
  while ((bytes[first]! & 0xc0) === 0x80) first--;
  while ((bytes[last]! & 0xc0) === 0x80) last++;
  return bytes.toString('utf8',0,first) + marker + bytes.toString('utf8',last);
}

export function outputText(text: string, failed: boolean): string {
  if (failed) return clipBytes(text,8192);
  const lines = text.split(/\r?\n/);
  return lines.length <= 40 ? text : [...lines.slice(0,20),'…（中间输出已省略）',...lines.slice(-20)].join('\n');
}

export function recentWithin<T>(items: readonly T[], budget: number, render: (item:T)=>string): T[] {
  const kept: T[] = [];
  for (let i = items.length-1; i >= 0; i--) {
    const cost = estimateTokens(render(items[i]!));
    if (cost > budget) break;
    kept.push(items[i]!);
    budget -= cost;
  }
  return kept.reverse();
}

/** 份额按优先级从前向后结转，硬性事实超过份额时仍保留，后续可选内容使用余量。 */
export function sectionBudgets(window: number) {
  const total=Math.min(16_000,Math.floor(window*0.1));
  let used=0, allocated=0;
  return {
    next(share:number) {
      allocated+=Math.floor(total*share);
      return Math.max(0,allocated-used);
    },
    account(content:unknown) { used+=estimateTokens(JSON.stringify(content)); },
  };
}
