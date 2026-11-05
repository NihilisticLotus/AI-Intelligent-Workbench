// 应用状态与操作：启动、配对、REST 快照、WebSocket 实时事件、各种用户操作。
// 网页界面也只是 /api/v1 的普通客户端，这里不做任何“只有本机才能用”的捷径。
import {
  ErrorCode, type ApiError, type Device, type EventEnvelope, type Group, type Hello, type PermissionLevel,
  type Project, type Task,
} from '@aic/protocol';
import { ApiRequestError, HttpClient, toApiError } from '../api/http';
import { Credentials } from '../api/credentials';
import { WsClient, type ConnState } from '../api/ws';
import { guessDeviceName } from '../lib/format';
import { platform } from '../platform';
import {
  applyAgentSnapshot, applyApprovalSnapshot, applyEvents, applyTaskSnapshot, emptyCore, mergeRestTask, type CoreState,
} from './core';
import { createStore, useStore } from './store';
import { announce, navigate, routeStore } from './ui';

export type BootState = 'loading' | 'unpaired' | 'ready' | 'error';

export interface AppState extends CoreState {
  boot: BootState;
  /** 启动或配对失败时显示的错误 */
  bootError: ApiError | null;
  /** 配对页：已请求过新配对码（显示“看终端窗口里的配对码”和输入框） */
  pairRequested: boolean;
  hello: Hello | null;
  conn: ConnState;
  projects: Project[];
  groups: Group[];
  /** 任务历史是否已经从 REST 取回 */
  history: Record<string, 'loading' | 'done' | 'error'>;
  devices: Device[] | null;
}

export const appStore = createStore<AppState>({
  ...emptyCore(), boot: 'loading', bootError: null, pairRequested: false, hello: null, conn: 'idle',
  projects: [], groups: [], history: {}, devices: null,
});
export const useApp = <S>(sel: (s: AppState) => S) => useStore(appStore, sel);
const set = (fn: (s: AppState) => AppState) => appStore.set(fn);

/** 设备凭据：存哪里、要哪种都由 Platform 决定，界面代码不碰 */
export const creds = new Credentials(platform.secureStorage, platform.tokenDelivery);

export const api = new HttpClient({
  baseUrl: platform.baseUrl,
  getAuthHeaders: () => creds.headers(),
  onUnauthorized: () => toUnpaired(),
});

let ws: WsClient | null = null;

// ---------- 实时事件：每帧合并一次，流式输出时不会每个字都触发一次渲染 ----------
let queue: EventEnvelope[] = [];
let flushScheduled = false;
function enqueueEvent(ev: EventEnvelope) {
  queue.push(ev);
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => { flushScheduled = false; flushEvents(); };
  if (typeof requestAnimationFrame !== 'undefined' && document.visibilityState === 'visible') requestAnimationFrame(run);
  else setTimeout(run, 16);
}
function flushEvents() {
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  const before = appStore.get();
  set((s) => ({ ...s, ...applyEvents(s, batch, 'ws') }));
  sideEffects(before, batch);
}

/** 事件带来的界面副作用：播报、系统通知 */
function sideEffects(before: AppState, batch: EventEnvelope[]) {
  for (const ev of batch) {
    if (ev.type === 'approval.requested' && !before.approvals[ev.data.approval.id] && ev.data.approval.status === 'pending') {
      const a = ev.data.approval;
      announce(`新审批：${a.title}`);
      void platform.notify({
        title: '有审批等你处理', body: `${a.title}：${a.detail.slice(0, 120)}`, tag: a.id,
        onClick: () => navigate({ page: 'task', taskId: a.taskId }),
      });
    }
    if (ev.type === 'message.done') announce('消息完成');
  }
}

// ---------- 启动 ----------
let booting: Promise<void> | null = null;
/** 同一时间只跑一次启动流程（React 开发模式会把 effect 执行两次，配对码只能用一次） */
export function boot(): Promise<void> {
  booting ??= doBoot().finally(() => { booting = null; });
  return booting;
}
async function doBoot() {
  set((s) => ({ ...s, boot: 'loading', bootError: null }));
  if (!creds.isLoaded) await creds.load();
  // 1) 地址栏带 #pair=<配对码>：先清掉地址栏里的配对码；已有有效凭据就直接进入，不重复配对
  //    （每次启动脚本都会带新码打开浏览器，重复配对会不断产生新设备、留下无人持有的旧令牌）
  const m = /(?:^#|&)pair=([^&]+)/.exec(location.hash);
  if (m) {
    const code = decodeURIComponent(m[1]!);
    history.replaceState(null, '', location.pathname + location.search);
    routeStore.set(() => ({ page: 'home' }));
    let hello: Hello | null = null;
    if (creds.has) {
      try { hello = await api.hello(); } catch (e) {
        if (!(e instanceof ApiRequestError && e.status === 401)) { set((s) => ({ ...s, boot: 'error', bootError: toApiError(e) })); return; }
      }
    }
    if (hello) { await startOrFail(hello); return; }
    try {
      await pairWith(code);
    } catch (e) {
      set((s) => ({ ...s, boot: 'unpaired', bootError: toApiError(e) }));
      return;
    }
  }
  await startOrFail();
}

async function startOrFail(hello?: Hello) {
  try {
    await start(hello);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) { toUnpaired(); return; }
    set((s) => ({ ...s, boot: 'error', bootError: toApiError(e) }));
  }
}

/** 用配对码配对，并按 Platform 保存凭据 */
async function pairWith(code: string) {
  const r = await api.pairingComplete(code.trim(), guessDeviceName(), platform.kind, platform.tokenDelivery);
  await creds.save(r);
}

/** 取 /hello 和各种快照，然后连 WebSocket */
async function start(prefetched?: Hello) {
  const hello = prefetched ?? await api.hello();
  const atSeq = hello.lastSeq;
  const [projects, groups, tasks, agents, approvals] = await Promise.all([
    api.projects(), api.groups(), api.tasks(), api.agents(), api.pendingApprovals(),
  ]);
  set((s) => {
    let core: CoreState = { ...s, wsSeq: Math.max(s.wsSeq, atSeq) };
    core = applyTaskSnapshot(core, tasks, atSeq);
    core = applyApprovalSnapshot(core, approvals, atSeq);
    core = applyAgentSnapshot(core, agents, atSeq);
    return { ...s, ...core, hello, projects, groups, boot: 'ready', bootError: null, pairRequested: false };
  });
  connectWs();
}

function connectWs() {
  ws?.stop();
  ws = new WsClient({
    url: () => api.wsUrl(),
    protocols: () => creds.wsProtocols(),
    getLastSeq: () => appStore.get().wsSeq,
    onEvent: enqueueEvent,
    onReplayed: (upToSeq, info) => {
      flushEvents();
      // 服务端的数据库被重置或换了（seq 比我们记得的小）：清空本地事件状态，重新拉快照
      if (info.reset || upToSeq < appStore.get().wsSeq) void resetAndRestart();
    },
    onState: (conn) => {
      set((s) => ({ ...s, conn }));
      if (conn === 'unauthorized') toUnpaired();
      if (conn === 'online') void resyncAfterReconnect();
    },
    onConnectFailure: (attempt) => {
      // 浏览器看不到握手失败的 HTTP 状态码：连续失败时用 /hello 判断是不是令牌失效
      if (attempt === 2 || attempt % 5 === 0) api.hello().catch(() => { /* 401 会走 onUnauthorized */ });
    },
  });
  ws.start();
}

/** 重连后：事件已由 lastSeq 补齐；项目、分组不走事件，顺手刷新一次 */
let firstOnline = true;
async function resyncAfterReconnect() {
  if (firstOnline) { firstOnline = false; return; }
  try {
    const [projects, groups] = await Promise.all([api.projects(), api.groups()]);
    set((s) => ({ ...s, projects, groups }));
  } catch { /* 下次再说 */ }
}

async function resetAndRestart() {
  ws?.stop();
  ws = null;
  queue = [];
  firstOnline = true;
  set((s) => ({ ...s, ...emptyCore(), history: {}, devices: null }));
  await startOrFail();
}

function toUnpaired() {
  ws?.stop();
  ws = null;
  // 凭据已失效（或设备被吊销）：清掉本地保存的密钥 / 令牌
  void creds.clear();
  set((s) => (s.boot === 'unpaired' ? s : { ...s, boot: 'unpaired', conn: 'idle' }));
}

// ---------- 配对 ----------
export async function requestPairingCode(): Promise<ApiError | null> {
  try {
    await api.pairingStart();
    set((s) => ({ ...s, pairRequested: true, bootError: null }));
    return null;
  } catch (e) {
    return toApiError(e);
  }
}
export async function completePairing(code: string): Promise<ApiError | null> {
  try {
    ws?.stop();
    ws = null;
    await pairWith(code);
    await start();
    return null;
  } catch (e) {
    return toApiError(e);
  }
}

// ---------- 任务历史 ----------
export async function loadHistory(taskId: string) {
  const st = appStore.get().history[taskId];
  if (st === 'loading' || st === 'done') return;
  set((s) => ({ ...s, history: { ...s.history, [taskId]: 'loading' } }));
  try {
    let after = 0;
    for (let i = 0; i < 200; i++) {
      const page = await api.taskEvents(taskId, after, 500);
      if (page.items.length) set((s) => ({ ...s, ...applyEvents(s, page.items, 'history') }));
      const last = page.items[page.items.length - 1];
      if (!last || page.items.length < 500) break;
      after = last.seq;
    }
    set((s) => ({ ...s, history: { ...s.history, [taskId]: 'done' } }));
  } catch (e) {
    set((s) => ({ ...s, history: { ...s.history, [taskId]: 'error' } }));
    throw e;
  }
}

// ---------- 指令（WebSocket） ----------
const notConnected = () => Promise.reject(new ApiRequestError({ code: 'client.offline', message: '还没有连上服务', actions: [] }));
export const sendPrompt = (taskId: string, text: string) => (ws ? ws.request('prompt', { taskId, text }) : notConnected());
export const cancelTask = (taskId: string) => (ws ? ws.request('cancel', { taskId }) : notConnected());
export const approve = (approvalId: string, optionId: string, note?: string) =>
  ws ? ws.request('approve', note ? { approvalId, optionId, note } : { approvalId, optionId }) : notConnected();
export const switchConfig = (taskId: string, patch: { model?: string; effort?: string }) =>
  ws ? ws.request('switch', { taskId, ...patch }) : notConnected();

// ---------- REST 操作 ----------
const upsert = <T extends { id: string }>(list: T[], item: T) =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];

/**
 * 用接口返回的任务更新本地。REST 响应不带 seq，可能比已经到达的 WebSocket 事件旧
 * （例如 PATCH 期间任务刚变成“等待审批”）：本地已经有这条任务的事件时以事件为准，
 * 服务端每次修改都会推 task.updated；只有本地还没有这条任务时才写入。
 */
export function putTask(t: Task) {
  set((s) => ({ ...s, ...mergeRestTask(s, t) }));
}

export async function createTask(body: Parameters<HttpClient['createTask']>[0]) {
  const t = await api.createTask(body);
  putTask(t);
  return t;
}
export async function patchTask(id: string, body: { title?: string; groupId?: string | null; permission?: PermissionLevel }) {
  const t = await api.patchTask(id, body);
  putTask(t);
  return t;
}
export async function createProject(name: string, path: string) {
  const p = await api.createProject(name, path);
  set((s) => ({ ...s, projects: upsert(s.projects, p) }));
  return p;
}
export async function renameProject(id: string, name: string) {
  const p = await api.patchProject(id, { name });
  set((s) => ({ ...s, projects: upsert(s.projects, p) }));
}
export async function removeProject(id: string) {
  await api.deleteProject(id);
  set((s) => {
    const tasks = Object.fromEntries(Object.entries(s.tasks).filter(([, t]) => t.projectId !== id));
    return { ...s, projects: s.projects.filter((p) => p.id !== id), tasks };
  });
}
export async function createGroup(name: string) {
  const g = await api.createGroup(name);
  set((s) => ({ ...s, groups: upsert(s.groups, g) }));
  return g;
}
export async function renameGroup(id: string, name: string) {
  const g = await api.patchGroup(id, { name });
  set((s) => ({ ...s, groups: upsert(s.groups, g) }));
}
export async function deleteGroup(id: string) {
  await api.deleteGroup(id);
  // 服务端把这些任务的 groupId 置空；本地同步做一次，随后的 task.updated 事件会再确认
  set((s) => {
    const tasks = { ...s.tasks };
    for (const [k, t] of Object.entries(tasks)) if (t.groupId === id) tasks[k] = { ...t, groupId: null };
    return { ...s, groups: s.groups.filter((g) => g.id !== id), tasks };
  });
}
export async function refreshAgents() {
  const agents = await api.agents();
  set((s) => ({ ...s, ...applyAgentSnapshot(s, agents, s.wsSeq) }));
}
export async function loadDevices() {
  const devices = await api.devices();
  set((s) => ({ ...s, devices }));
}
export async function revokeDevice(id: string) {
  await api.revokeDevice(id);
  set((s) => ({ ...s, devices: s.devices?.filter((d) => d.id !== id) ?? null }));
}

export function isUnauthorized(err: ApiError) { return err.code === ErrorCode.Unauthorized; }
