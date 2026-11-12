import type { ViewItem } from '../state/core';

interface NavigationItem { key: string; kind: 'user' | 'turn' | 'attn'; agent: string | null; ts: number; text: string }

export function navigationItems(view: readonly ViewItem[]) {
  const clip = (text: string) => { const plain = text.replace(/\s+/g, ' ').trim(); return plain.length > 60 ? plain.slice(0, 60) + '…' : plain; };
  return view.flatMap<NavigationItem>((item) => {
    if (item.kind === 'user') return [{ key: item.key, kind: 'user' as const, agent: null, ts: item.ts, text: clip(item.text) || '附件消息' }];
    if (item.kind !== 'turn') return [];
    const process = item.steps.filter((s) => s.kind === 'agent').map((s) => s.text).join(' ');
    return [{ key: item.key, kind: item.pendingApproval ? 'attn' as const : 'turn' as const, agent: item.agent, ts: item.ts,
      text: clip(item.answer?.text || process) || (item.pendingApproval ? '有审批等你处理' : item.done ? '本轮处理已结束' : '正在回复…') }];
  });
}

/** tops 使用消息在滚动内容中的位置，当前刻度取视口上方三分之一。 */
export function currentNavigationIndex(tops: readonly number[], scrollTop: number, height: number, scrollHeight: number) {
  if (!tops.length) return -1;
  if (scrollTop + height >= scrollHeight - 4) return tops.length - 1;
  const target = scrollTop + height / 3;
  let index = 0;
  for (let i = 0; i < tops.length; i++) if (tops[i]! <= target) index = i;
  return index;
}
export function navigationKey(key: string, index: number, length: number) {
  if (!length) return null;
  const next = key === 'ArrowDown' ? index + 1 : key === 'ArrowUp' ? index - 1 : key === 'Home' ? 0 : key === 'End' ? length - 1 : null;
  return next === null ? null : Math.max(0, Math.min(length - 1, next));
}
export function navigationMotion(reduced: boolean) {
  return { behavior: reduced ? 'instant' as const : 'smooth' as const, flash: !reduced };
}
