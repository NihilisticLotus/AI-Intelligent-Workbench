// 任务、会话与审批（1.1 版本的 TaskScheduler + SessionManager + PermissionBroker 合在这里，后续再拆）。
// 所有状态变化都先经过 EventStore.append（先写库，再推送）。
import type { AgentKind, Approval, PermissionLevel, Task, TaskStatus } from '@aic/protocol';
import type { z } from 'zod';
import type { CreateTaskBody, PatchTaskBody, TasksQuery } from '@aic/protocol';
import type { AgentAdapter, AgentConnection, AgentRegistry, AgentUpdate, PermissionOutcome, PermissionRequest, SessionHost } from './agents/registry';
import type { Db } from './db';
import type { EventStore } from './events';
import { AbortError, Errors, newId, now } from './util';

type TaskRow = {
  id: string; project_id: string; group_id: string | null; title: string; prompt: string;
  status: TaskStatus; permission_level: PermissionLevel; agent: AgentKind; model: string | null; effort: string | null;
  auto_allow_low_risk: number; auto_merge_on_pass: number;
  last_activity_at: number; created_at: number; updated_at: number;
};

const toTask = (r: TaskRow): Task => ({
  id: r.id, projectId: r.project_id, groupId: r.group_id, title: r.title, prompt: r.prompt,
  status: r.status, permission: r.permission_level, agent: r.agent, model: r.model, effort: r.effort,
  autoAllowLowRisk: !!r.auto_allow_low_risk, autoMergeOnPass: !!r.auto_merge_on_pass,
  lastActivityAt: r.last_activity_at, createdAt: r.created_at, updatedAt: r.updated_at,
});

/** 已建立会话的任务的内存状态 */
interface Runtime {
  sessionId: string;
  conn: AgentConnection;
}

/** touch（最近活动时间变化）推送 task.updated 的节流间隔 */
const ACTIVITY_EMIT_MS = 1000;

interface PendingApproval {
  approval: Approval;
  resolve: (o: PermissionOutcome) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export interface TaskServiceOptions {
  /** 审批超时，默认 30 分钟；超时后任务暂停，不会自动放行 */
  approvalTimeoutMs?: number;
}

const FINAL: TaskStatus[] = ['merged', 'discarded'];

export class TaskService {
  private runtimes = new Map<string, Runtime>();
  private starting = new Map<string, Promise<Runtime>>();
  /**
   * 每个任务当前回合的 AbortController：startTurn 时同步写入、回合结束时删除。
   * 会话还在启动（ensureRuntime 未完成）时也在这里，cancel / shutdown 都从这里取，不会漏掉启动中的回合。
   */
  private turnAborts = new Map<string, AbortController>();
  /** 最近一次推送 task.updated 的时间，以及等待中的节流推送 */
  private lastEmit = new Map<string, number>();
  private emitTimers = new Map<string, NodeJS.Timeout>();
  private pending = new Map<string, PendingApproval>();
  private turns = new Set<Promise<void>>();
  private lastActivity = 0;
  private readonly approvalTimeoutMs: number;

  constructor(private db: Db, private events: EventStore, private agents: AgentRegistry, opts: TaskServiceOptions = {}) {
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 30 * 60_000;
  }

  /** 单调递增的“最近活动”时间，保证同一毫秒内的先后也能排出来 */
  private activityTs(): number {
    const t = Math.max(now(), this.lastActivity + 1);
    this.lastActivity = t;
    return t;
  }

  /** Gateway 启动时：上次没跑完的任务标记为“已中断”，未决审批作废（design.md 10.6） */
  recoverOnStartup() {
    const maxAct = this.db.get<{ m: number | null }>('SELECT MAX(last_activity_at) AS m FROM tasks')?.m ?? 0;
    this.lastActivity = maxAct;
    const stale = this.db.all<{ id: string }>("SELECT id FROM tasks WHERE status IN ('running', 'waiting', 'queued')");
    const approvals = this.db.all<{ id: string }>("SELECT id FROM approvals WHERE status = 'pending'");
    for (const a of approvals) this.finishApproval(a.id, 'expired', null, null);
    for (const t of stale) this.setStatus(t.id, 'interrupted');
    this.db.run("UPDATE sessions SET status = 'ended', ended_at = ? WHERE status = 'active'", now());
  }

  // ---------- 查询 ----------

  getRow(id: string): TaskRow {
    const r = this.db.get<TaskRow>('SELECT * FROM tasks WHERE id = ?', id);
    if (!r) throw Errors.notFound('找不到这个任务');
    return r;
  }
  get(id: string): Task { return toTask(this.getRow(id)); }

  /** 按最近活动倒序；游标分页 */
  list(q: z.infer<typeof TasksQuery>): { items: Task[]; nextCursor: string | null } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
    if (q.groupId) { where.push('group_id = ?'); params.push(q.groupId); }
    else if (q.ungrouped === '1') where.push('group_id IS NULL');
    if (q.cursor) {
      let c: unknown;
      try { c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')); } catch { /* 下面统一报错 */ }
      if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'string') throw Errors.badRequest('分页游标不正确');
      where.push('(last_activity_at < ? OR (last_activity_at = ? AND id < ?))');
      params.push(c[0], c[0], c[1]);
    }
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_activity_at DESC, id DESC LIMIT ?`;
    const rows = this.db.all<TaskRow>(sql, ...params, q.limit + 1);
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit).map(toTask);
    const last = items[items.length - 1];
    return { items, nextCursor: more && last ? Buffer.from(JSON.stringify([last.lastActivityAt, last.id])).toString('base64url') : null };
  }

  listApprovals(status?: Approval['status']): Approval[] {
    const rows = status
      ? this.db.all<{ request_json: string }>('SELECT request_json FROM approvals WHERE status = ? ORDER BY created_at', status)
      : this.db.all<{ request_json: string }>('SELECT request_json FROM approvals ORDER BY created_at DESC LIMIT 500');
    return rows.map((r) => JSON.parse(r.request_json) as Approval);
  }

  // ---------- 修改 ----------

  emitUpdated(taskId: string) {
    const timer = this.emitTimers.get(taskId);
    if (timer) { clearTimeout(timer); this.emitTimers.delete(taskId); }
    const task = this.get(taskId);
    this.lastEmit.set(taskId, now());
    this.events.append({ type: 'task.updated', taskId, sessionId: null, data: { task } });
  }

  /**
   * 更新最近活动时间。客户端按 lastActivityAt 排序，所以也要推 task.updated，否则网页顺序和 GET /tasks 不一致；
   * 流式过程中 touch 很频繁，同一任务 1 秒内最多推一次，最后一次变化保证会推出去。
   * silent：调用方紧接着会 setStatus（自带推送），这里不用再推。
   */
  private touch(taskId: string, silent = false) {
    this.db.run('UPDATE tasks SET last_activity_at = ? WHERE id = ?', this.activityTs(), taskId);
    if (silent || this.emitTimers.has(taskId)) return;
    const wait = (this.lastEmit.get(taskId) ?? 0) + ACTIVITY_EMIT_MS - now();
    if (wait <= 0) { this.emitUpdated(taskId); return; }
    const timer = setTimeout(() => {
      this.emitTimers.delete(taskId);
      try { this.emitUpdated(taskId); } catch { /* 任务已被删除 */ }
    }, wait);
    timer.unref?.();
    this.emitTimers.set(taskId, timer);
  }

  private setStatus(taskId: string, status: TaskStatus) {
    const t = now();
    this.db.run('UPDATE tasks SET status = ?, updated_at = ?, last_activity_at = ? WHERE id = ?', status, t, this.activityTs(), taskId);
    this.emitUpdated(taskId);
  }

  private async adapterFor(kind: AgentKind): Promise<AgentAdapter> {
    const a = this.agents.get(kind);
    if (!a) throw Errors.agentUnavailable('这个 Agent 暂不可用', '第一阶段只提供演示 Agent，真实 Agent 会在下一步接入');
    const d = await a.detect();
    if (!d.installed) throw Errors.agentUnavailable(`${a.displayName} 没有安装`);
    if (!d.loggedIn) throw Errors.agentUnavailable(`${a.displayName} 还没有登录`, '请先在 Agent 页面登录', [{ label: '去登录', action: 'agents.login', args: { kind } }]);
    return a;
  }

  private async checkModel(a: AgentAdapter, model: string | null | undefined, effort: string | null | undefined) {
    const models = await a.listModels();
    const efforts = await a.listEfforts();
    const m = model ?? models[0]?.id ?? null;
    if (m !== null && !models.some((x) => x.id === m)) throw Errors.badRequest(`${a.displayName} 没有这个模型：${m}`);
    let e = effort ?? null;
    if (efforts) {
      e = e ?? efforts[Math.floor(efforts.length / 2)] ?? null;
      if (e !== null && !efforts.includes(e)) throw Errors.badRequest(`不支持这个思考强度：${e}`);
    } else if (e !== null) {
      throw Errors.badRequest(`${a.displayName} 不支持调节思考强度`);
    }
    return { model: m, effort: e };
  }

  async create(body: z.infer<typeof CreateTaskBody>): Promise<Task> {
    if (!this.db.get('SELECT id FROM projects WHERE id = ?', body.projectId)) throw Errors.badRequest('找不到这个项目');
    if (body.groupId && !this.db.get('SELECT id FROM task_groups WHERE id = ?', body.groupId)) throw Errors.badRequest('找不到这个分组');
    const a = await this.adapterFor(body.agent);
    const { model, effort } = await this.checkModel(a, body.model, body.effort);
    const id = newId('t');
    const t = now();
    const title = (body.title?.trim() || body.prompt.trim().split(/\r?\n/)[0]!.slice(0, 40)) || '新任务';
    this.db.run(
      `INSERT INTO tasks (id, project_id, group_id, title, prompt, status, permission_level, agent, model, effort, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
      id, body.projectId, body.groupId ?? null, title, body.prompt, body.permission, body.agent, model, effort, this.activityTs(), t, t,
    );
    const task = this.get(id);
    this.events.append({ type: 'task.created', taskId: id, sessionId: null, data: { task } });
    this.startTurn(id, body.prompt);
    return this.get(id);
  }

  async patch(id: string, body: z.infer<typeof PatchTaskBody>): Promise<Task> {
    const row = this.getRow(id);
    if (body.groupId && !this.db.get('SELECT id FROM task_groups WHERE id = ?', body.groupId)) throw Errors.badRequest('找不到这个分组');
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (body.title !== undefined) { sets.push('title = ?'); params.push(body.title.trim() || row.title); }
    if (body.groupId !== undefined) { sets.push('group_id = ?'); params.push(body.groupId); }
    if (body.permission !== undefined) { sets.push('permission_level = ?'); params.push(body.permission); }
    if (body.autoAllowLowRisk !== undefined) { sets.push('auto_allow_low_risk = ?'); params.push(body.autoAllowLowRisk ? 1 : 0); }
    if (body.autoMergeOnPass !== undefined) { sets.push('auto_merge_on_pass = ?'); params.push(body.autoMergeOnPass ? 1 : 0); }
    if (sets.length === 0) return toTask(row);
    sets.push('updated_at = ?'); params.push(now());
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (body.permission !== undefined && body.permission !== row.permission_level) {
      const rt = this.runtimes.get(id);
      if (rt) await rt.conn.setPermission(body.permission);
      const cur = this.getRow(id);
      this.events.append({ type: 'session.config', taskId: id, sessionId: rt?.sessionId ?? null, data: { model: cur.model, effort: cur.effort, permission: body.permission } });
    }
    this.emitUpdated(id);
    return this.get(id);
  }

  // ---------- 会话 ----------

  private host(taskId: string, sessionId: string): SessionHost {
    return {
      update: (u) => this.onUpdate(taskId, sessionId, u),
      requestPermission: (req, signal) => this.onPermission(taskId, sessionId, req, signal),
    };
  }

  private onUpdate(taskId: string, sessionId: string, u: AgentUpdate) {
    const base = { taskId, sessionId } as const;
    switch (u.kind) {
      case 'thought': this.events.append({ ...base, type: 'thought.delta', data: { messageId: u.messageId, text: u.text } }); break;
      case 'message': this.events.append({ ...base, type: 'message.delta', data: { messageId: u.messageId, text: u.text } }); break;
      case 'message_done': this.touch(taskId); this.events.append({ ...base, type: 'message.done', data: { messageId: u.messageId } }); break;
      case 'tool_start': this.touch(taskId); this.events.append({ ...base, type: 'tool.start', data: { toolId: u.toolId, kind: u.toolKind, title: u.title, target: u.target } }); break;
      case 'tool_output': this.events.append({ ...base, type: 'tool.output', data: { toolId: u.toolId, text: u.text } }); break;
      case 'tool_end': this.events.append({ ...base, type: 'tool.end', data: { toolId: u.toolId, ok: u.ok, summary: u.summary, ...(u.rejected ? { rejected: true } : {}) } }); break;
      case 'plan': this.events.append({ ...base, type: 'plan.update', data: { items: u.items } }); break;
      case 'config': {
        const row = this.getRow(taskId);
        this.events.append({ ...base, type: 'session.config', data: { model: u.model, effort: u.effort, permission: row.permission_level } });
        break;
      }
    }
  }

  private async ensureRuntime(taskId: string): Promise<Runtime> {
    const existing = this.runtimes.get(taskId);
    if (existing) return existing;
    const inflight = this.starting.get(taskId);
    if (inflight) return inflight;
    const p = (async () => {
      const row = this.getRow(taskId);
      const a = await this.adapterFor(row.agent);
      const project = this.db.get<{ path: string }>('SELECT path FROM projects WHERE id = ?', row.project_id);
      const sessionId = newId('s');
      const conn = await a.spawn({ cwd: project?.path ?? process.cwd(), model: row.model, effort: row.effort, permission: row.permission_level, host: this.host(taskId, sessionId) });
      const caps = await a.probeCapabilities(conn);
      this.db.run(
        "INSERT INTO sessions (id, task_id, agent_id, model, agent_session_id, caps_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)",
        sessionId, taskId, row.agent, row.model, conn.agentSessionId, JSON.stringify(caps), now(),
      );
      this.events.append({ type: 'session.started', taskId, sessionId, data: { agent: row.agent, model: row.model } });
      const rt: Runtime = { sessionId, conn };
      this.runtimes.set(taskId, rt);
      return rt;
    })();
    this.starting.set(taskId, p);
    try { return await p; } finally { this.starting.delete(taskId); }
  }

  private isBusy(taskId: string) {
    return this.turnAborts.has(taskId);
  }

  /** 发一条用户消息并在后台跑一轮 */
  private startTurn(taskId: string, text: string): string {
    const messageId = newId('m');
    this.touch(taskId, true);
    this.events.append({ type: 'message.user', taskId, sessionId: this.runtimes.get(taskId)?.sessionId ?? null, data: { messageId, text } });
    // 同步占住“忙碌”状态：避免两条 prompt 同时进来，也让会话启动期间的 cancel 能找到这个回合
    const abort = new AbortController();
    this.turnAborts.set(taskId, abort);
    this.setStatus(taskId, 'running');
    const turn = this.runTurn(taskId, text, abort);
    this.turns.add(turn);
    void turn.finally(() => this.turns.delete(turn));
    return messageId;
  }

  private async runTurn(taskId: string, text: string, abort: AbortController) {
    let rt: Runtime | undefined;
    try {
      rt = await this.ensureRuntime(taskId);
      if (abort.signal.aborted) throw new AbortError();
      const r = await rt.conn.prompt(text, abort.signal);
      this.setStatus(taskId, r.stopReason === 'cancelled' ? 'paused' : r.stopReason === 'error' ? 'failed' : 'review');
    } catch (e) {
      if (e instanceof AbortError || abort.signal.aborted) {
        this.setStatus(taskId, 'paused');
      } else {
        console.error('[tasks] 任务执行出错', e);
        const msg = e instanceof Error ? e.message : String(e);
        this.events.append({ type: 'error', taskId, sessionId: rt?.sessionId ?? null, data: { error: { code: 'agent.failed', message: `Agent 执行出错：${msg}`, hint: '可以重新发送消息再试一次', actions: [] } } });
        this.setStatus(taskId, 'failed');
      }
    } finally {
      if (this.turnAborts.get(taskId) === abort) this.turnAborts.delete(taskId);
    }
  }

  async prompt(taskId: string, text: string): Promise<{ taskId: string; messageId: string }> {
    const row = this.getRow(taskId);
    if (FINAL.includes(row.status)) throw Errors.invalidState('任务已经结束，不能继续发送消息');
    if (this.isBusy(taskId)) throw Errors.invalidState('任务正在执行', '请等这一轮结束，或先点 [停止]', [{ label: '停止', action: 'task.cancel', args: { taskId } }]);
    return { taskId, messageId: this.startTurn(taskId, text) };
  }

  async cancel(taskId: string): Promise<void> {
    this.getRow(taskId);
    const abort = this.turnAborts.get(taskId);
    if (!abort) return; // 没在执行，取消视为成功（幂等）
    abort.abort();
  }

  async switch(taskId: string, opts: { agent?: AgentKind | undefined; model?: string | undefined; effort?: string | undefined }): Promise<Task> {
    const row = this.getRow(taskId);
    if (opts.agent && opts.agent !== row.agent) {
      throw Errors.agentUnavailable('暂时不能切换到其他 Agent', '跨 Agent 交接会在后续版本提供；现在可以换模型或思考强度');
    }
    const a = await this.adapterFor(row.agent);
    const { model, effort } = await this.checkModel(a, opts.model ?? row.model, opts.effort ?? row.effort);
    this.db.run('UPDATE tasks SET model = ?, effort = ?, updated_at = ? WHERE id = ?', model, effort, now(), taskId);
    const rt = this.runtimes.get(taskId);
    if (rt) {
      // Agent 自己会回报 config 更新（对应 ACP config_option_update），由 onUpdate 落成 session.config
      await rt.conn.setConfig({ ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    } else {
      this.events.append({ type: 'session.config', taskId, sessionId: null, data: { model, effort, permission: row.permission_level } });
    }
    this.emitUpdated(taskId);
    return this.get(taskId);
  }

  // ---------- 审批 ----------

  private onPermission(taskId: string, sessionId: string, req: PermissionRequest, signal: AbortSignal): Promise<PermissionOutcome> {
    const row = this.getRow(taskId);
    const pick = (kinds: string[]) => req.options.find((o) => kinds.includes(o.kind));
    // 权限级别（9.1）：只读一律拒绝；工作区内自动 / 全自动直接放行；需审批时出卡片
    if (row.permission_level === 'readonly') {
      const o = pick(['reject_once', 'reject_always']);
      return Promise.resolve(o ? { outcome: 'selected', optionId: o.id, note: '只读权限下不允许执行' } : { outcome: 'cancelled' });
    }
    if (row.permission_level === 'full' || row.permission_level === 'workspace') {
      const o = pick(['allow_once', 'allow_always']);
      if (o) return Promise.resolve({ outcome: 'selected', optionId: o.id });
    }
    if (signal.aborted) return Promise.reject(new AbortError());

    const t = now();
    const approval: Approval = {
      id: newId('a'), taskId, sessionId, title: req.title, reason: req.reason, detail: req.detail, cwd: req.cwd,
      options: req.options, status: 'pending', decidedBy: null, createdAt: t, expiresAt: t + this.approvalTimeoutMs,
    };
    this.db.run(
      'INSERT INTO approvals (id, task_id, session_id, request_json, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      approval.id, taskId, sessionId, JSON.stringify(approval), 'pending', t,
    );
    this.touch(taskId, true);
    this.events.append({ type: 'approval.requested', taskId, sessionId, data: { approval } });
    this.setStatus(taskId, 'waiting');

    return new Promise<PermissionOutcome>((resolve, reject) => {
      const onAbort = () => {
        const p = this.pending.get(approval.id);
        if (!p) return;
        p.cleanup();
        this.finishApproval(approval.id, 'expired', null, null);
        reject(new AbortError());
      };
      const timer = setTimeout(() => {
        const p = this.pending.get(approval.id);
        if (!p) return;
        p.cleanup();
        this.finishApproval(approval.id, 'expired', null, null);
        resolve({ outcome: 'cancelled' }); // 超时不放行，本轮结束后任务暂停
      }, this.approvalTimeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(approval.id);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(approval.id, { approval, resolve, reject, timer, cleanup });
    });
  }

  private finishApproval(id: string, status: Approval['status'], decidedBy: string | null, optionId: string | null): Approval | null {
    const r = this.db.get<{ request_json: string; task_id: string; session_id: string }>('SELECT request_json, task_id, session_id FROM approvals WHERE id = ?', id);
    if (!r) return null;
    // 带上处理设备的名称：界面显示“由 xxx 处理”，不用另外去查设备列表
    const decidedByName = decidedBy ? this.db.get<{ name: string }>('SELECT name FROM devices WHERE id = ?', decidedBy)?.name ?? null : null;
    const a: Approval = { ...(JSON.parse(r.request_json) as Approval), status, decidedBy, decidedByName };
    this.db.run('UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, request_json = ? WHERE id = ?', status, decidedBy, now(), JSON.stringify(a), id);
    this.events.append({ type: 'approval.resolved', taskId: r.task_id, sessionId: r.session_id, data: { approvalId: id, status, decidedBy, optionId, decidedByName } });
    return a;
  }

  /** 任一设备先处理即生效（先到先得） */
  async approve(approvalId: string, optionId: string, note: string | undefined, deviceId: string): Promise<Approval> {
    const p = this.pending.get(approvalId);
    if (!p) {
      const exists = this.db.get('SELECT id FROM approvals WHERE id = ?', approvalId);
      if (!exists) throw Errors.notFound('找不到这条审批');
      throw Errors.invalidState('这条审批已经处理过了');
    }
    const opt = p.approval.options.find((o) => o.id === optionId);
    if (!opt) throw Errors.badRequest('没有这个选项');
    p.cleanup();
    const status = opt.kind.startsWith('allow') ? 'allowed' : 'rejected';
    const a = this.finishApproval(approvalId, status, deviceId, optionId)!;
    // 回到运行中，再把结果交还 Agent
    this.setStatus(p.approval.taskId, 'running');
    // “总是允许”在 1.3 写入项目规则；1.1 先按允许一次处理
    p.resolve({ outcome: 'selected', optionId, ...(note ? { note } : {}) });
    return a;
  }

  /** 关闭：中断所有执行中的任务 */
  async shutdown() {
    for (const abort of this.turnAborts.values()) abort.abort();
    await Promise.allSettled([...this.turns]);
    for (const t of this.emitTimers.values()) clearTimeout(t);
    this.emitTimers.clear();
    for (const p of [...this.pending.values()]) p.cleanup();
    for (const rt of this.runtimes.values()) await rt.conn.close().catch(() => {});
    this.runtimes.clear();
  }

  /** 等所有正在执行的轮次结束（测试用） */
  async idle() { await Promise.allSettled([...this.turns]); }
}
