// 事件归并：把 Gateway 推来的事件（以及 REST 取回的历史事件）合并成客户端状态。
// 规则：
//  1. 同一个 seq 只应用一次（重连补发、历史与实时重叠都不会重复）。
//  2. 乱序到达按 seq 处理：任务日志始终按 seq 升序；实体（任务、审批、Agent）只接受比上次更新更新的事件。
//  3. 这里全是纯函数，不碰网络和界面，方便测试。
import type { AgentInfo, ApiError, Approval, EventEnvelope, EventOf, ModelInfo, Task, AttachmentInfo } from '@aic/protocol';

/** 1.2：登录流程的最新状态（agent.login 事件），键为 loginId */
export type LoginInfo = EventOf<'agent.login'>['data'] & { ts: number };

export interface CoreState {
  tasks: Record<string, Task>;
  approvals: Record<string, Approval>;
  agents: AgentInfo[];
  /** 登录流程（全局事件），只增不删；界面按 Agent 取最近的一个 */
  logins: Record<string, LoginInfo>;
  /** 实体最后一次被更新时的 seq，键为 't:任务' 'a:审批' 'g:Agent' 'l:登录' */
  entitySeq: Record<string, number>;
  /** 每个任务的事件：按 seq 升序、无重复 */
  logs: Record<string, EventEnvelope[]>;
  /** 不属于任何任务的事件（Agent 状态、全局错误），同样按 seq 去重，只保留最近 200 条 */
  globalLog: EventEnvelope[];
  /** 从 WebSocket 实时流里收到的最大 seq，重连时作为 lastSeq 发给服务端 */
  wsSeq: number;
}

export const emptyCore = (): CoreState => ({
  tasks: {}, approvals: {}, agents: [], logins: {}, entitySeq: {}, logs: {}, globalLog: [], wsSeq: 0,
});

/** 按 seq 插入有序数组；seq 已存在时原样返回同一个数组（调用方据此判断是否重复） */
export function insertBySeq(list: readonly EventEnvelope[] | undefined, ev: EventEnvelope): EventEnvelope[] {
  const arr = (list ?? []) as EventEnvelope[];
  const n = arr.length;
  // 快速路径：绝大多数事件是按顺序追加的
  if (n === 0 || arr[n - 1]!.seq < ev.seq) return [...arr, ev];
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.seq < ev.seq) lo = mid + 1;
    else hi = mid;
  }
  if (arr[lo]?.seq === ev.seq) return arr; // 重复
  return [...arr.slice(0, lo), ev, ...arr.slice(lo)];
}

export type EventSource = 'ws' | 'history';

const newer = (s: CoreState, key: string, seq: number) => seq > (s.entitySeq[key] ?? 0);

/** 应用一个事件；重复事件返回原状态对象 */
export function applyEvent(s: CoreState, ev: EventEnvelope, source: EventSource = 'ws'): CoreState {
  const wsSeq = source === 'ws' ? Math.max(s.wsSeq, ev.seq) : s.wsSeq;
  let next: CoreState;
  if (ev.taskId) {
    const old = s.logs[ev.taskId];
    const log = insertBySeq(old, ev);
    if (log === old) return wsSeq === s.wsSeq ? s : { ...s, wsSeq };
    next = { ...s, wsSeq, logs: { ...s.logs, [ev.taskId]: log } };
  } else {
    const log = insertBySeq(s.globalLog, ev);
    if (log === s.globalLog) return wsSeq === s.wsSeq ? s : { ...s, wsSeq };
    next = { ...s, wsSeq, globalLog: log.length > 200 ? log.slice(-200) : log };
  }
  return applyEntity(next, ev);
}

export function applyEvents(s: CoreState, events: readonly EventEnvelope[], source: EventSource = 'ws'): CoreState {
  let cur = s;
  for (const ev of events) cur = applyEvent(cur, ev, source);
  return cur;
}

function applyEntity(s: CoreState, ev: EventEnvelope): CoreState {
  switch (ev.type) {
    case 'task.created':
    case 'task.updated': {
      const t = ev.data.task;
      const key = 't:' + t.id;
      if (!newer(s, key, ev.seq)) return s;
      return { ...s, tasks: { ...s.tasks, [t.id]: t }, entitySeq: { ...s.entitySeq, [key]: ev.seq } };
    }
    case 'approval.requested': {
      const a = ev.data.approval;
      const key = 'a:' + a.id;
      if (!newer(s, key, ev.seq)) return s;
      return { ...s, approvals: { ...s.approvals, [a.id]: a }, entitySeq: { ...s.entitySeq, [key]: ev.seq } };
    }
    case 'approval.resolved': {
      const { approvalId, status, decidedBy } = ev.data;
      const decidedByName = ev.data.decidedByName ?? null;
      const key = 'a:' + approvalId;
      if (!newer(s, key, ev.seq)) return s;
      const cur = s.approvals[approvalId];
      const approvals = cur ? { ...s.approvals, [approvalId]: { ...cur, status, decidedBy, decidedByName } } : s.approvals;
      return { ...s, approvals, entitySeq: { ...s.entitySeq, [key]: ev.seq } };
    }
    case 'agent.status': {
      const ag = ev.data.agent;
      const key = 'g:' + ag.kind;
      if (!newer(s, key, ev.seq)) return s;
      const idx = s.agents.findIndex((x) => x.kind === ag.kind);
      const agents = idx >= 0 ? s.agents.map((x, i) => (i === idx ? ag : x)) : [...s.agents, ag];
      return { ...s, agents, entitySeq: { ...s.entitySeq, [key]: ev.seq } };
    }
    case 'agent.login': {
      const d = ev.data;
      const key = 'l:' + d.loginId;
      if (!newer(s, key, ev.seq)) return s;
      return { ...s, logins: { ...s.logins, [d.loginId]: { ...d, ts: ev.ts } }, entitySeq: { ...s.entitySeq, [key]: ev.seq } };
    }
    default:
      return s;
  }
}

/** 用 REST 快照覆盖实体：只覆盖 seq 不晚于快照时刻的条目，已被更新的实时事件不会被旧快照冲掉 */
export function applyTaskSnapshot(s: CoreState, tasks: readonly Task[], atSeq: number): CoreState {
  const next = { ...s.tasks };
  const seqs = { ...s.entitySeq };
  for (const t of tasks) {
    const key = 't:' + t.id;
    if ((seqs[key] ?? 0) <= atSeq) { next[t.id] = t; seqs[key] = atSeq; }
  }
  return { ...s, tasks: next, entitySeq: seqs };
}

/** 单个 REST 响应里的任务（不带 seq）：本地已有这条任务就以事件为准，不覆盖；只在本地还没有时写入 */
export function mergeRestTask<S extends CoreState>(s: S, t: Task): S {
  if (s.entitySeq['t:' + t.id] !== undefined || s.tasks[t.id]) return s;
  return { ...s, tasks: { ...s.tasks, [t.id]: t } };
}

export function applyApprovalSnapshot(s: CoreState, list: readonly Approval[], atSeq: number): CoreState {
  const next = { ...s.approvals };
  const seqs = { ...s.entitySeq };
  for (const a of list) {
    const key = 'a:' + a.id;
    if ((seqs[key] ?? 0) <= atSeq) { next[a.id] = a; seqs[key] = atSeq; }
  }
  return { ...s, approvals: next, entitySeq: seqs };
}

export function applyAgentSnapshot(s: CoreState, list: readonly AgentInfo[], atSeq: number): CoreState {
  const seqs = { ...s.entitySeq };
  const agents = list.map((ag) => {
    const key = 'g:' + ag.kind;
    if ((seqs[key] ?? 0) <= atSeq) { seqs[key] = atSeq; return ag; }
    return s.agents.find((x) => x.kind === ag.kind) ?? ag;
  });
  return { ...s, agents, entitySeq: seqs };
}

// ---------------------------------------------------------------------
// 对话时间线：由任务日志（已按 seq 排好）推导，渲染层只读
// ---------------------------------------------------------------------
export interface ToolItem {
  id: string; kind: string; title: string; target: string | null;
  /** rejected：用户在审批里拒绝，没有执行（不是故障） */
  output: string; state: 'running' | 'ok' | 'failed' | 'rejected'; summary: string | null;
  startTs: number; endTs: number | null;
}
export interface PlanEntry { text: string; status: 'pending' | 'in_progress' | 'completed' }
export type TimelineItem =
  | { kind: 'user'; key: string; id: string; text: string; ts: number; attachments?: AttachmentInfo[] }
  | {
      kind: 'agent'; key: string; id: string; text: string; thought: string;
      thoughtStart: number | null; thoughtEnd: number | null; done: boolean; ts: number;
      agent: string | null; model: string | null;
      /** 同一轮回复的后续片段（Agent 在工具调用之间分段输出）：界面不再重复头像和名称，看起来是一条回复 */
      cont: boolean;
    }
  | { kind: 'tools'; key: string; tools: ToolItem[] }
  | { kind: 'plan'; key: string; items: PlanEntry[]; ts: number }
  | { kind: 'approval'; key: string; approval: Approval; resolved: ResolvedInfo | null }
  | { kind: 'note'; key: string; text: string; ts: number; level?: 'info' | 'warn' }
  /** 会话配置变化（换模型、思考强度）；显示名由界面按 /agents 换算 */
  | { kind: 'config'; key: string; model: string | null; effort: string | null; agent: string | null; ts: number }
  | { kind: 'error'; key: string; error: ApiError; ts: number };

export interface ResolvedInfo { status: Approval['status']; decidedBy: string | null; decidedByName: string | null }
type AgentItem = Extract<TimelineItem, { kind: 'agent' }>;

export function buildTimeline(events: readonly EventEnvelope[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const agentMsgs = new Map<string, AgentItem>();
  const tools = new Map<string, ToolItem>();
  const notices = new Map<string, Extract<TimelineItem,{kind:'note'}>>();
  const approvals = new Map<string, Extract<TimelineItem, { kind: 'approval' }>>();
  let lastGroup: Extract<TimelineItem, { kind: 'tools' }> | null = null;
  let agent: string | null = null;
  let model: string | null = null;
  /** undefined 表示还没见过思考强度（第一次报告不算“切换”） */
  let effort: string | null | undefined = undefined;
  /** 这一轮（上一条用户消息之后）是否已经有 Agent 的回复片段 */
  let turnHasAgent = false;
  /** 新片段或新工具开始时，之前的片段都已结束：收起“正在思考 / 正在回复”，避免一直转圈 */
  const closeOpen = (ts: number) => {
    for (const m of agentMsgs.values()) if (!m.done) { m.done = true; if (m.thought && m.thoughtEnd === null) m.thoughtEnd = ts; }
  };

  const push = (it: TimelineItem) => { items.push(it); if (it.kind !== 'tools') lastGroup = null; };
  const agentItem = (id: string, ts: number, forText = false): AgentItem => {
    let it = agentMsgs.get(id);
    // 有的 Agent 把思考和正文放在不同的 messageId 里：紧跟在“只有思考”的消息后面的正文并入同一条
    if (!it && forText) {
      const last = items[items.length - 1];
      if (last?.kind === 'agent' && last.thought && !last.text && !last.done) { it = last; agentMsgs.set(id, it); }
    }
    if (!it) {
      closeOpen(ts);
      it = { kind: 'agent', key: 'm:' + id, id, text: '', thought: '', thoughtStart: null, thoughtEnd: null, done: false, ts, agent, model, cont: turnHasAgent };
      turnHasAgent = true;
      agentMsgs.set(id, it);
      push(it);
    }
    return it;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'task.updated':
        // 回合失败或停止时可能没有 message.done；结束进度显示，不把片段当作正式会话记录。
        if (['review', 'paused', 'interrupted', 'failed', 'merged', 'discarded'].includes(ev.data.task.status)) closeOpen(ev.ts);
        break;
      case 'session.started':
        agent = ev.data.agent; model = ev.data.model;
        // 1.2：恢复原来的会话（H1）时留一行提示；恢复失败、新建会话由 Gateway 发 session.notice 说明
        if (ev.data.resumed) push({ kind: 'note', key: 'r:' + ev.seq, text: '已恢复原来的会话，Agent 记得之前的对话', ts: ev.ts });
        break;
      case 'session.notice': {
        const old=ev.data.id?notices.get(ev.data.id):undefined;
        if(old){old.text=ev.data.text;old.ts=ev.ts;old.level=ev.data.level;}
        else {const note={kind:'note' as const,key:'n:'+(ev.data.id??ev.seq),text:ev.data.text,ts:ev.ts,level:ev.data.level};push(note);if(ev.data.id)notices.set(ev.data.id,note);}break;
      }
      case 'session.config': {
        // 只在真的变了时留一行提示（有的实现每次开会话都会报一次完整配置）
        const d = ev.data;
        const modelChanged = d.model !== undefined && d.model !== model;
        const effortChanged = d.effort !== undefined && d.effort !== effort && effort !== undefined;
        if (d.model !== undefined) model = d.model;
        if (d.effort !== undefined) effort = d.effort;
        if (modelChanged || effortChanged) {
          // 连续切换（中间没有新消息）只保留一行，显示最终结果；否则来回切几次就堆出一串提示（用户报告）
          const last = items[items.length - 1];
          if (last?.kind === 'config') {
            if (modelChanged) last.model = model;
            if (effortChanged) last.effort = effort ?? null;
            last.ts = ev.ts;
          } else {
            push({ kind: 'config', key: 'c:' + ev.seq, model: modelChanged ? model : null, effort: effortChanged ? effort ?? null : null, agent, ts: ev.ts });
          }
        }
        break;
      }
      case 'session.ended': {
        const r = ev.data.reason;
        const text = /cancel/i.test(r) ? '已按你的要求停止' : /error|fail|crash/i.test(r) ? `会话异常结束：${r}` : null;
        if (text) push({ kind: 'note', key: 'n:' + ev.seq, text, ts: ev.ts });
        break;
      }
      case 'message.user':
        closeOpen(ev.ts);
        turnHasAgent = false;
        push({ kind: 'user', key: 'u:' + ev.data.messageId, id: ev.data.messageId, text: ev.data.text, ts: ev.ts, ...(ev.data.attachments?{attachments:ev.data.attachments}:{}) });
        break;
      case 'thought.delta': {
        const it = agentItem(ev.data.messageId, ev.ts);
        it.thought += ev.data.text;
        it.thoughtStart ??= ev.ts;
        it.thoughtEnd = ev.ts;
        break;
      }
      case 'message.delta': {
        const it = agentItem(ev.data.messageId, ev.ts, true);
        it.text += ev.data.text;
        break;
      }
      case 'message.done': {
        const item = agentItem(ev.data.messageId, ev.ts, true);
        if (ev.data.text !== undefined) item.text = ev.data.text;
        item.done = true;
        break;
      }
      case 'tool.start': {
        closeOpen(ev.ts);
        const t: ToolItem = { id: ev.data.toolId, kind: ev.data.kind, title: ev.data.title, target: ev.data.target, output: '', state: 'running', summary: null, startTs: ev.ts, endTs: null };
        tools.set(t.id, t);
        if (!lastGroup) { lastGroup = { kind: 'tools', key: 'tg:' + ev.seq, tools: [] }; items.push(lastGroup); }
        lastGroup.tools.push(t);
        break;
      }
      case 'tool.update': {
        const t=tools.get(ev.data.toolId);if(t){if(ev.data.title!==undefined)t.title=ev.data.title;if(ev.data.target!==undefined)t.target=ev.data.target;if(ev.data.kind!==undefined)t.kind=ev.data.kind;}break;
      }
      case 'tool.output': {
        const t = tools.get(ev.data.toolId);
        if (t) t.output += ev.data.text;
        break;
      }
      case 'tool.end': {
        const t = tools.get(ev.data.toolId);
        if (t) { t.state = ev.data.ok ? 'ok' : ev.data.rejected ? 'rejected' : 'failed'; t.summary = ev.data.summary; t.endTs = ev.ts; }
        break;
      }
      case 'plan.update': {
        // 只保留最新的一份计划，放在最近一次更新的位置
        const idx = items.findIndex((x) => x.kind === 'plan');
        if (idx >= 0) items.splice(idx, 1);
        push({ kind: 'plan', key: 'p:' + ev.seq, items: ev.data.items, ts: ev.ts });
        break;
      }
      case 'approval.requested': {
        const it = { kind: 'approval' as const, key: 'a:' + ev.data.approval.id, approval: ev.data.approval, resolved: null };
        approvals.set(ev.data.approval.id, it);
        push(it);
        break;
      }
      case 'approval.resolved': {
        const it = approvals.get(ev.data.approvalId);
        if (it) it.resolved = { status: ev.data.status, decidedBy: ev.data.decidedBy, decidedByName: ev.data.decidedByName ?? null };
        break;
      }
      case 'error':
        push({ kind: 'error', key: 'e:' + ev.seq, error: ev.data.error, ts: ev.ts });
        break;
      default:
        break;
    }
  }
  return items;
}

/** 最新计划（右侧“计划”标签用） */
export function latestPlan(events: readonly EventEnvelope[]): EventOf<'plan.update'> | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'plan.update') return ev;
  }
  return null;
}

/** 任务当前会话的配置（切换器、右侧面板用） */
export interface SessionCfg {
  model: string | null;
  effort: string | null;
  /** 1.2：当前会话给出的可选模型 / 思考强度；undefined 表示会话没给，界面用 /agents 的缓存 */
  models?: ModelInfo[];
  efforts?: string[] | null;
  agentMode?: string | null;
  /** 1.2：当前会话使用的账号；undefined 表示不知道（用任务上的 profileId） */
  profileId?: string | null;
  /** 1.2：上下文用量（usage_update） */
  usage?: EventOf<'session.usage'>['data'];
}

/** 任务的当前会话配置（切换器显示用）：从日志里最近的 session.started / session.config 推导，缺省回落到任务本身 */
export function sessionConfig(task: Task, events: readonly EventEnvelope[]): SessionCfg {
  const cfg: SessionCfg = { model: task.model, effort: task.effort };
  if (task.profileId !== undefined) cfg.profileId = task.profileId;
  for (const ev of events) {
    if (ev.type === 'session.started') {
      cfg.model = ev.data.model ?? cfg.model;
      if (ev.data.profileId !== undefined) cfg.profileId = ev.data.profileId;
      // 新会话：上一个会话的用量不再适用
      delete cfg.usage;
    }
    if (ev.type === 'session.config') {
      const d = ev.data;
      if (d.model !== undefined) cfg.model = d.model;
      if (d.effort !== undefined) cfg.effort = d.effort;
      if (d.models !== undefined) cfg.models = d.models;
      if (d.efforts !== undefined) cfg.efforts = d.efforts;
      if (d.agentMode !== undefined) cfg.agentMode = d.agentMode;
    }
    if (ev.type === 'session.usage') cfg.usage = ev.data;
  }
  return cfg;
}

/** 让任务停下来的错误（进程退出、登录失效、额度用完等）：最后一条用户消息之后的最后一个 error，任务处于暂停 / 中断 / 失败时才算 */
export function blockingError(task: Task, events: readonly EventEnvelope[]): EventOf<'error'> | null {
  if (task.status !== 'paused' && task.status !== 'interrupted' && task.status !== 'failed') return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'message.user') return null;
    if (ev.type === 'error') return ev;
  }
  return null;
}

/** 最后一条用户消息（“再试一次”用） */
export function lastUserText(events: readonly EventEnvelope[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.type === 'message.user') return ev.data.text;
  }
  return null;
}

// ---------------------------------------------------------------------
// 按“轮”展示（2026-11-07 用户对照 Codex 提出）：一轮回复 = 两条用户消息之间 Agent 的全部输出。
// 过程（思考、中途的说明、工具调用、审批）收进一个可折叠的“用时 N 秒”，最终回答单独显示在下面。
// ---------------------------------------------------------------------
export type TurnStep =
  | Extract<TimelineItem, { kind: 'agent' }>
  | Extract<TimelineItem, { kind: 'tools' }>
  | Extract<TimelineItem, { kind: 'approval' }>;
export interface TurnItem {
  kind: 'turn'; key: string; agent: string | null; model: string | null;
  /** 第一段输出的时间、最后一次活动的时间 */
  ts: number; endTs: number;
  /** 过程：除最终回答之外的全部步骤（最终回答的思考也算过程） */
  steps: TurnStep[];
  /** 最终回答：最后一段、并且之后没有工具调用和审批的 Agent 输出 */
  answer: Extract<TimelineItem, { kind: 'agent' }> | null;
  done: boolean;
  /** 有还没处理的审批：过程必须展开，审批卡片不能藏起来 */
  pendingApproval: boolean;
}
export type ViewItem = Exclude<TimelineItem, { kind: 'agent' | 'tools' }> | TurnItem;

export function groupTurns(items: readonly TimelineItem[]): ViewItem[] {
  const out: ViewItem[] = [];
  let buf: TurnStep[] = [];
  let deferred: ViewItem[] = [];
  const flush = () => {
    if (!buf.length) { out.push(...deferred); deferred = []; return; }
    const last = buf[buf.length - 1]!;
    const answer = last.kind === 'agent' && last.text ? last : null;
    const steps = answer ? buf.slice(0, -1) : buf.slice();
    const agents = buf.filter((s): s is Extract<TurnStep, { kind: 'agent' }> => s.kind === 'agent');
    const first = agents[0] ?? null;
    let ts = Infinity;
    let endTs = 0;
    let running = false;
    let pending = false;
    for (const s of buf) {
      if (s.kind === 'agent') {
        ts = Math.min(ts, s.thoughtStart ?? s.ts);
        endTs = Math.max(endTs, s.ts, s.thoughtEnd ?? 0);
        if (!s.done) running = true;
      } else if (s.kind === 'tools') {
        for (const t of s.tools) {
          ts = Math.min(ts, t.startTs);
          endTs = Math.max(endTs, t.endTs ?? t.startTs);
          if (t.state === 'running') running = true;
        }
      } else {
        ts = Math.min(ts, s.approval.createdAt);
        endTs = Math.max(endTs, s.approval.createdAt);
        if (!s.resolved && s.approval.status === 'pending') pending = true;
      }
    }
    out.push({
      kind: 'turn', key: 'turn:' + buf[0]!.key, agent: first?.agent ?? null, model: first?.model ?? null,
      ts: Number.isFinite(ts) ? ts : 0, endTs, steps, answer, done: !running && !pending, pendingApproval: pending,
    });
    out.push(...deferred);
    buf = []; deferred = [];
  };
  for (const it of items) {
    if (it.kind === 'agent' || it.kind === 'tools' || it.kind === 'approval') buf.push(it);
    else if (it.kind === 'plan' && buf.length) deferred.push(it); // 计划放到这一轮的后面，不打断这一轮
    else { flush(); out.push(it); }
  }
  flush();
  return out;
}
