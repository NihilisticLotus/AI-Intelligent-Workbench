// 事件归并：把 Gateway 推来的事件（以及 REST 取回的历史事件）合并成客户端状态。
// 规则：
//  1. 同一个 seq 只应用一次（重连补发、历史与实时重叠都不会重复）。
//  2. 乱序到达按 seq 处理：任务日志始终按 seq 升序；实体（任务、审批、Agent）只接受比上次更新更新的事件。
//  3. 这里全是纯函数，不碰网络和界面，方便测试。
import type { AgentInfo, ApiError, Approval, EventEnvelope, EventOf, Task } from '@aic/protocol';

export interface CoreState {
  tasks: Record<string, Task>;
  approvals: Record<string, Approval>;
  agents: AgentInfo[];
  /** 实体最后一次被更新时的 seq，键为 't:任务' 'a:审批' 'g:Agent' */
  entitySeq: Record<string, number>;
  /** 每个任务的事件：按 seq 升序、无重复 */
  logs: Record<string, EventEnvelope[]>;
  /** 不属于任何任务的事件（Agent 状态、全局错误），同样按 seq 去重，只保留最近 200 条 */
  globalLog: EventEnvelope[];
  /** 从 WebSocket 实时流里收到的最大 seq，重连时作为 lastSeq 发给服务端 */
  wsSeq: number;
}

export const emptyCore = (): CoreState => ({
  tasks: {}, approvals: {}, agents: [], entitySeq: {}, logs: {}, globalLog: [], wsSeq: 0,
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
  | { kind: 'user'; key: string; id: string; text: string; ts: number }
  | {
      kind: 'agent'; key: string; id: string; text: string; thought: string;
      thoughtStart: number | null; thoughtEnd: number | null; done: boolean; ts: number;
      agent: string | null; model: string | null;
    }
  | { kind: 'tools'; key: string; tools: ToolItem[] }
  | { kind: 'plan'; key: string; items: PlanEntry[]; ts: number }
  | { kind: 'approval'; key: string; approval: Approval; resolved: ResolvedInfo | null }
  | { kind: 'note'; key: string; text: string; ts: number }
  /** 会话配置变化（换模型、思考强度）；显示名由界面按 /agents 换算 */
  | { kind: 'config'; key: string; model: string | null; effort: string | null; agent: string | null; ts: number }
  | { kind: 'error'; key: string; error: ApiError; ts: number };

export interface ResolvedInfo { status: Approval['status']; decidedBy: string | null; decidedByName: string | null }
type AgentItem = Extract<TimelineItem, { kind: 'agent' }>;

export function buildTimeline(events: readonly EventEnvelope[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const agentMsgs = new Map<string, AgentItem>();
  const tools = new Map<string, ToolItem>();
  const approvals = new Map<string, Extract<TimelineItem, { kind: 'approval' }>>();
  let lastGroup: Extract<TimelineItem, { kind: 'tools' }> | null = null;
  let agent: string | null = null;
  let model: string | null = null;
  /** undefined 表示还没见过思考强度（第一次报告不算“切换”） */
  let effort: string | null | undefined = undefined;

  const push = (it: TimelineItem) => { items.push(it); if (it.kind !== 'tools') lastGroup = null; };
  const agentItem = (id: string, ts: number, forText = false): AgentItem => {
    let it = agentMsgs.get(id);
    // 有的 Agent 把思考和正文放在不同的 messageId 里：紧跟在“只有思考”的消息后面的正文并入同一条
    if (!it && forText) {
      const last = items[items.length - 1];
      if (last?.kind === 'agent' && last.thought && !last.text && !last.done) { it = last; agentMsgs.set(id, it); }
    }
    if (!it) {
      it = { kind: 'agent', key: 'm:' + id, id, text: '', thought: '', thoughtStart: null, thoughtEnd: null, done: false, ts, agent, model };
      agentMsgs.set(id, it);
      push(it);
    }
    return it;
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'session.started':
        agent = ev.data.agent; model = ev.data.model; break;
      case 'session.config': {
        // 只在真的变了时留一行提示（有的实现每次开会话都会报一次完整配置）
        const d = ev.data;
        const modelChanged = d.model !== undefined && d.model !== model;
        const effortChanged = d.effort !== undefined && d.effort !== effort && effort !== undefined;
        if (d.model !== undefined) model = d.model;
        if (d.effort !== undefined) effort = d.effort;
        if (modelChanged || effortChanged) {
          push({ kind: 'config', key: 'c:' + ev.seq, model: modelChanged ? model : null, effort: effortChanged ? effort ?? null : null, agent, ts: ev.ts });
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
        push({ kind: 'user', key: 'u:' + ev.data.messageId, id: ev.data.messageId, text: ev.data.text, ts: ev.ts });
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
      case 'message.done':
        agentItem(ev.data.messageId, ev.ts, true).done = true;
        break;
      case 'tool.start': {
        const t: ToolItem = { id: ev.data.toolId, kind: ev.data.kind, title: ev.data.title, target: ev.data.target, output: '', state: 'running', summary: null, startTs: ev.ts, endTs: null };
        tools.set(t.id, t);
        if (!lastGroup) { lastGroup = { kind: 'tools', key: 'tg:' + ev.seq, tools: [] }; items.push(lastGroup); }
        lastGroup.tools.push(t);
        break;
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

/** 任务的当前会话配置（切换器显示用）：从日志里最近的 session.started / session.config 推导，缺省回落到任务本身 */
export function sessionConfig(task: Task, events: readonly EventEnvelope[]): { model: string | null; effort: string | null } {
  let model = task.model;
  let effort = task.effort;
  for (const ev of events) {
    if (ev.type === 'session.started') model = ev.data.model ?? model;
    if (ev.type === 'session.config') { if (ev.data.model !== undefined) model = ev.data.model; if (ev.data.effort !== undefined) effort = ev.data.effort; }
  }
  return { model, effort };
}
