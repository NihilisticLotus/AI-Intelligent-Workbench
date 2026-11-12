// 界面层的小状态：路由（地址栏 hash）、提示条、读屏播报。
import { AgentKind, type ApiError } from '@aic/protocol';
import { createStore } from './store';

// ---------- 路由 ----------
// #/            首页（没有选中任务）
// #/t/<任务id>  对话
// #/agents      Agent
// #/agents/<kind>[/<账号id>]  Agent 页并选中某个 Agent（错误按钮“去登录”等用）
// #/settings    设置
// #/p/<页面>    以后按功能开关出现的页面
export interface NewTaskPreset { projectId?: string; groupId?: string | null; agent?: AgentKind; model?: string; prompt?: string }
export type Route =
  | { page: 'home' }
  | { page: 'new'; preset?: NewTaskPreset }
  | { page: 'task'; taskId: string }
  | { page: 'agents'; agent?: string; profileId?: string }
  | { page: 'settings' }
  | { page: 'feature'; key: string };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  if (h === '/new' || h.startsWith('/new?')) {
    const params = new URLSearchParams(h.split('?').slice(1).join('?')), preset: NewTaskPreset = {};
    for (const key of ['projectId', 'model', 'prompt'] as const) if (params.has(key)) preset[key] = params.get(key)!;
    if (params.has('groupId')) preset.groupId = params.get('groupId') || null;
    const agent = AgentKind.safeParse(params.get('agent'));
    if (agent.success) preset.agent = agent.data;
    return Object.keys(preset).length ? { page: 'new', preset } : { page: 'new' };
  }
  if (h.startsWith('/t/')) return { page: 'task', taskId: decodeURIComponent(h.slice(3)) };
  if (h === '/agents') return { page: 'agents' };
  if (h.startsWith('/agents/')) {
    const [agent, profileId] = h.slice(8).split('/').map((x) => decodeURIComponent(x));
    return profileId ? { page: 'agents', agent, profileId } : agent ? { page: 'agents', agent } : { page: 'agents' };
  }
  if (h === '/settings') return { page: 'settings' };
  if (h.startsWith('/p/')) return { page: 'feature', key: decodeURIComponent(h.slice(3)) };
  return { page: 'home' };
}

export function routeHash(r: Route): string {
  switch (r.page) {
    case 'new': {
      const params = new URLSearchParams();
      for (const key of ['projectId', 'groupId', 'agent', 'model', 'prompt'] as const) {
        const value = r.preset?.[key];
        if (value !== undefined) params.set(key, value ?? '');
      }
      return '#/new' + (params.size ? '?' + params.toString() : '');
    }
    case 'task': return '#/t/' + encodeURIComponent(r.taskId);
    case 'agents': return '#/agents' + (r.agent ? '/' + encodeURIComponent(r.agent) + (r.profileId ? '/' + encodeURIComponent(r.profileId) : '') : '');
    case 'settings': return '#/settings';
    case 'feature': return '#/p/' + encodeURIComponent(r.key);
    default: return '#/';
  }
}

export const routeStore = createStore<Route>(typeof location === 'undefined' ? { page: 'home' } : parseHash(location.hash));
export const newTaskReturnStore = createStore<Exclude<Route, { page: 'new' }>>({ page: 'home' });
function applyRoute(route: Route) {
  const previous = routeStore.get();
  if (route.page === 'new' && previous.page !== 'new') newTaskReturnStore.set(() => previous);
  routeStore.set(() => route);
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => applyRoute(parseHash(location.hash)));
}
export function navigate(r: Route) {
  const h = routeHash(r);
  if (location.hash !== h) location.hash = h;
  else applyRoute(r);
}
export function returnFromNewTask() { navigate(newTaskReturnStore.get()); }

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

// ---------- 带按钮的错误（审查第 19 条） ----------
// 提示条只放操作结果的短提示；Gateway 给了 actions 的错误要“发生了什么 + 怎么处理 + 按钮”，
// 放进页面里的 alert 块（不自动消失，用户点关闭或点按钮后消失）。
export interface ErrorAlert { id: number; error: ApiError; taskId: string | null; kind: string | null }
export const errorAlertStore = createStore<ErrorAlert[]>([]);
let alertSeq = 0;
export function alertError(error: ApiError, ctx: { taskId?: string | null; kind?: string | null } = {}) {
  const id = ++alertSeq;
  // 同样的错误不重复堆叠：只留最新的一条，最多 3 条
  errorAlertStore.set((l) => [...l.filter((a) => a.error.code !== error.code || a.error.message !== error.message), { id, error, taskId: ctx.taskId ?? null, kind: ctx.kind ?? null }].slice(-3));
  return id;
}
export function dismissAlert(id: number) { errorAlertStore.set((l) => l.filter((a) => a.id !== id)); }
/** 有按钮的错误进页面里的 alert 块，没有按钮的用提示条 */
export function showError(error: ApiError, ctx: { taskId?: string | null; kind?: string | null } = {}) {
  if (error.actions.length) alertError(error, ctx); else toastError(error);
}

// ---------- 读屏播报（只播报“消息完成”“新审批”，不逐字播报） ----------
export const announceStore = createStore<{ text: string; n: number }>({ text: '', n: 0 });
export function announce(text: string) {
  announceStore.set((s) => ({ text, n: s.n + 1 }));
}
