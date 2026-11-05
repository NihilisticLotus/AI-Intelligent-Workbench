// 界面层的小状态：路由（地址栏 hash）、提示条、读屏播报。
import type { ApiError } from '@aic/protocol';
import { createStore } from './store';

// ---------- 路由 ----------
// #/            首页（没有选中任务）
// #/t/<任务id>  对话
// #/agents      Agent
// #/settings    设置
// #/p/<页面>    以后按功能开关出现的页面
export type Route =
  | { page: 'home' }
  | { page: 'task'; taskId: string }
  | { page: 'agents' }
  | { page: 'settings' }
  | { page: 'feature'; key: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  if (h.startsWith('/t/')) return { page: 'task', taskId: decodeURIComponent(h.slice(3)) };
  if (h === '/agents') return { page: 'agents' };
  if (h === '/settings') return { page: 'settings' };
  if (h.startsWith('/p/')) return { page: 'feature', key: decodeURIComponent(h.slice(3)) };
  return { page: 'home' };
}

export function routeHash(r: Route): string {
  switch (r.page) {
    case 'task': return '#/t/' + encodeURIComponent(r.taskId);
    case 'agents': return '#/agents';
    case 'settings': return '#/settings';
    case 'feature': return '#/p/' + encodeURIComponent(r.key);
    default: return '#/';
  }
}

export const routeStore = createStore<Route>(typeof location === 'undefined' ? { page: 'home' } : parseHash(location.hash));
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => routeStore.set(() => parseHash(location.hash)));
}
export function navigate(r: Route) {
  const h = routeHash(r);
  if (location.hash !== h) location.hash = h;
  else routeStore.set(() => r);
}

// ---------- 提示条 ----------
export interface Toast { id: number; text: string; kind: 'ok' | 'attn' | 'err' }
export const toastStore = createStore<Toast[]>([]);
let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'ok', ms = 3600) {
  const id = ++toastSeq;
  toastStore.set((l) => [...l, { id, text, kind }]);
  setTimeout(() => toastStore.set((l) => l.filter((t) => t.id !== id)), ms);
}
export function toastError(err: ApiError) {
  toast(err.hint ? `${err.message}。${err.hint}` : err.message, 'err', 6000);
}

// ---------- 读屏播报（只播报“消息完成”“新审批”，不逐字播报） ----------
export const announceStore = createStore<{ text: string; n: number }>({ text: '', n: 0 });
export function announce(text: string) {
  announceStore.set((s) => ({ text, n: s.n + 1 }));
}
