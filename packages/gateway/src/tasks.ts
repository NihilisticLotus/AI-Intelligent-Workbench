// 任务、会话与审批（1.1 版本的 TaskScheduler + SessionManager + PermissionBroker 合在这里，后续再拆）。
// 所有状态变化都先经过 EventStore.append（先写库，再推送）。
// 1.2：真实 Agent 的会话运行时（账号环境变量、恢复 H1、并发上限、空闲回收、进程崩溃）、切换模型（H0）、异常映射（phase-1.md 6.5）。
import type { AgentKind, ApiError, Approval, PermissionLevel, Task, TaskStatus, AttachmentInfo, PromptAttachment } from '@aic/protocol';
import { ErrorCode, visionOf } from '@aic/protocol';
import type { z } from 'zod';
import type { CreateTaskBody, PatchTaskBody, TasksQuery } from '@aic/protocol';
import { AgentError, redact as redactText, redactExact, StreamRedactor, type SessionConfigState } from '@aic/adapters';
import type { AgentAdapter, AgentConnection, AgentRegistry, AgentUpdate, PermissionOutcome, PermissionRequest, SessionHost } from './agents/registry';
import type { AgentService } from './agents/service';
import type { Db } from './db';
import type { EventStore } from './events';
import { AppError, AbortError, Errors, newId, now } from './util';

type TaskRow = {
  id: string; project_id: string; group_id: string | null; title: string; prompt: string;
  status: TaskStatus; permission_level: PermissionLevel; agent: AgentKind; model: string | null; effort: string | null;
  auto_allow_low_risk: number; auto_merge_on_pass: number;
  last_activity_at: number; created_at: number; updated_at: number;
  profile_id: string | null;
};

const toTask = (r: TaskRow): Task => ({
  id: r.id, projectId: r.project_id, groupId: r.group_id, title: r.title, prompt: r.prompt,
  status: r.status, permission: r.permission_level, agent: r.agent, model: r.model, effort: r.effort,
  autoAllowLowRisk: !!r.auto_allow_low_risk, autoMergeOnPass: !!r.auto_merge_on_pass,
  lastActivityAt: r.last_activity_at, createdAt: r.created_at, updatedAt: r.updated_at,
  profileId: r.profile_id ?? null,
});

/** 已建立会话的任务的内存状态 */
interface Runtime {
  sessionId: string;
  conn: AgentConnection;
  /** 会话使用的账号（演示 Agent 为空） */
  profileId: string | null;
  /** 释放并发名额 */
  release: () => void;
  lastActive: number;
  /** 我们主动关闭的（空闲回收、换账号、H1） */
  closing: boolean;
  /** 本次注入的密钥原文：写事件、审批记录前按原文脱敏 */
  secrets: string[];
  redactor: StreamRedactor;
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
  /** 会话空闲多久后关闭 Agent 进程（下次发消息时自动恢复），默认 30 分钟 */
  idleTimeoutMs?: number;
  noResponseNoticeMs?: number;
  noResponseCancelMs?: number;
  log?: (msg: string) => void;
}

const FINAL: TaskStatus[] = ['merged', 'discarded'];

/** 不排队的启动（换账号）遇到并发已满 */
class SlotBusyError extends Error {
  constructor() { super('并发已满'); this.name = 'SlotBusyError'; }
}

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
  /** 这一轮里有审批超时：回合结束后任务暂停（不进入待验收） */
  private approvalTimedOut = new Set<string>();
  /** 每个任务最近一次启动时注入的密钥（启动失败时的兜底错误也要脱敏） */
  private secretsOf = new Map<string, string[]>();
  private lastActivity = 0;
  private activity = new Map<string, number>();
  private noResponseNoticeMs: number;
  private noResponseCancelMs: number;
  attachments: import('./attachments').AttachmentService | null = null;
  private readonly approvalTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | null = null;
  private log: (msg: string) => void;
  /** 由 Gateway 组装时注入（1.2）；为空时退回 1.1 的行为 */
  agentSvc: AgentService | null = null;

  constructor(private db: Db, private events: EventStore, private agents: AgentRegistry, opts: TaskServiceOptions = {}) {
    this.noResponseNoticeMs = opts.noResponseNoticeMs ?? 60_000;
    this.noResponseCancelMs = opts.noResponseCancelMs ?? 600_000;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 30 * 60_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
    this.log = opts.log ?? ((m) => console.log(m));
    this.idleTimer = setInterval(() => this.reapIdle(), Math.min(60_000, Math.max(1000, Math.floor(this.idleTimeoutMs / 4))));
    this.idleTimer.unref?.();
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

  /** 这个账号有没有正在运行的会话（删除账号时检查） */
  profileInUse(profileId: string): boolean {
    for (const rt of this.runtimes.values()) if (rt.profileId === profileId) return true;
    return false;
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
    const rt = this.runtimes.get(taskId);
    if (rt) rt.lastActive = now();
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

  private async adapterFor(kind: AgentKind, profileId?: string | null): Promise<AgentAdapter> {
    const a = this.agents.get(kind);
    if (!a) throw Errors.agentUnavailable('这个 Agent 暂不可用', '这个 Agent 还没有接入');
    // Agent 页关掉的 Agent 不接新任务（运行中的会话照常做完，design.md 6.7）
    if (this.agentSvc && !this.agentSvc.enabled(kind)) {
      throw Errors.agentUnavailable(`${a.displayName} 已关闭`, '在 Agent 页打开它后才能使用', [{ label: '打开 Agent 页', action: 'open_agents', args: { kind } }]);
    }
    // 1.2：用缓存的检测结果（CodeBuddy 的检测要启动一次引擎，不能每次都做）
    const d = this.agentSvc ? await this.agentSvc.ensureDetected(kind) : await a.detect();
    if (!d.installed) throw Errors.agentUnavailable(`${a.displayName} 没有安装`, d.message ?? undefined, [{ label: '打开 Agent 页', action: 'open_agents', args: { kind } }]);
    // 用 API Key 的账号不看“本机登录”的状态
    const profile = a.real && this.agentSvc ? this.agentSvc.profiles.resolve(kind, profileId) : null;
    const needLogin = profile ? profile.kind === 'subscription' && this.agentSvc!.profileLoggedIn(profile.id) === false : !d.loggedIn;
    if (needLogin) throw Errors.agentUnavailable(`${a.displayName} 还没有登录`, '请先在 Agent 页登录', [{ label: '去登录', action: 'agents.login', args: { kind, ...(profile ? { profileId: profile.id } : {}) } }]);
    return a;
  }

  /** 校验模型和思考强度。真实 Agent 用能力缓存里的列表；列表为空（还没用过）时不校验，交给 Agent 判断 */
  private async checkModel(a: AgentAdapter, model: string | null | undefined, effort: string | null | undefined, profileId?: string | null) {
    let models;
    let efforts;
    if (a.real && this.agentSvc) {
      const cat = this.agentSvc.catalog(a.id, profileId ?? null);
      models = cat.models;
      efforts = cat.efforts;
      if (models.length === 0) return { model: model ?? null, effort: effort ?? null };
    } else {
      models = await a.listModels();
      efforts = await a.listEfforts();
    }
    // 真实 Agent 不指定模型时用 Agent 自己的默认值（null，不下发）
    const m = model ?? (a.real ? null : models[0]?.id ?? null);
    if (m !== null && !models.some((x) => x.id === m)) throw Errors.badRequest(`${a.displayName} 没有这个模型：${m}`);
    let e = effort ?? null;
    if (efforts) {
      if (!a.real) e = e ?? efforts[Math.floor(efforts.length / 2)] ?? null;
      if (e !== null && !efforts.includes(e)) throw Errors.badRequest(`不支持这个思考强度：${e}`);
    } else if (e !== null && !a.real) {
      throw Errors.badRequest(`${a.displayName} 不支持调节思考强度`);
    }
    return { model: m, effort: e };
  }

  /** 真实 Agent 第 1.2 步只开放“只读”和“需审批”（phase-1.md 6.3.4） */
  private checkPermission(a: AgentAdapter, level: PermissionLevel) {
    if (a.permissionLevels && !a.permissionLevels.includes(level)) {
      throw Errors.levelUnavailable(`${a.displayName} 暂时不能使用这个权限级别`, '“工作区内自动”和“全自动”会在第 1.3 步有了工作副本后开放；现在可以选“只读”或“需审批”');
    }
  }

  async create(body: z.infer<typeof CreateTaskBody>): Promise<Task> {
    if (!this.db.get('SELECT id FROM projects WHERE id = ?', body.projectId)) throw Errors.badRequest('找不到这个项目');
    if (body.groupId && !this.db.get('SELECT id FROM task_groups WHERE id = ?', body.groupId)) throw Errors.badRequest('找不到这个分组');
    const a = await this.adapterFor(body.agent, body.profileId);
    this.checkPermission(a, body.permission);
    const profileId = body.profileId ?? null;
    if (profileId) {
      if (!a.real || !this.agentSvc) throw Errors.badRequest(`${a.displayName} 不需要账号`);
      this.agentSvc.profiles.resolve(body.agent, profileId);
    }
    const { model, effort } = await this.checkModel(a, body.model, body.effort, profileId);
    const id = newId('t');
    if (body.attachments?.length) this.attachments?.resolve(id, body.attachments);
    const t = now();
    const title = (body.title?.trim() || body.prompt.trim().split(/\r?\n/)[0]!.slice(0, 40)) || '新任务';
    this.db.run(
      `INSERT INTO tasks (id, project_id, group_id, title, prompt, status, permission_level, agent, model, effort, profile_id, last_activity_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, body.projectId, body.groupId ?? null, title, body.prompt, body.permission, body.agent, model, effort, profileId, this.activityTs(), t, t,
    );
    const task = this.get(id);
    this.events.append({ type: 'task.created', taskId: id, sessionId: null, data: { task } });
    if (body.deferPrompt) this.setStatus(id, 'draft');
    else this.startTurn(id, body.prompt);
    return this.get(id);
  }

  async patch(id: string, body: z.infer<typeof PatchTaskBody>): Promise<Task> {
    const row = this.getRow(id);
    if (body.groupId && !this.db.get('SELECT id FROM task_groups WHERE id = ?', body.groupId)) throw Errors.badRequest('找不到这个分组');
    const a = this.agents.get(row.agent);
    if (body.permission !== undefined && a) this.checkPermission(a, body.permission);
    if (body.profileId !== undefined && body.profileId !== row.profile_id) {
      await this.switchProfile(id, body.profileId);
    }
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (body.title !== undefined) { sets.push('title = ?'); params.push(body.title.trim() || row.title); }
    if (body.groupId !== undefined) { sets.push('group_id = ?'); params.push(body.groupId); }
    if (body.permission !== undefined) { sets.push('permission_level = ?'); params.push(body.permission); }
    if (body.autoAllowLowRisk !== undefined) { sets.push('auto_allow_low_risk = ?'); params.push(body.autoAllowLowRisk ? 1 : 0); }
    if (body.autoMergeOnPass !== undefined) { sets.push('auto_merge_on_pass = ?'); params.push(body.autoMergeOnPass ? 1 : 0); }
    if (sets.length === 0) return this.get(id);
    sets.push('updated_at = ?'); params.push(now());
    this.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (body.permission !== undefined && body.permission !== row.permission_level) {
      const rt = this.runtimes.get(id);
      if (rt) await rt.conn.setPermission(body.permission);
      this.emitConfig(id, rt?.sessionId ?? null, rt?.conn.config?.() ?? null);
    }
    this.emitUpdated(id);
    return this.get(id);
  }

  // ---------- 会话 ----------

  private host(taskId: string, sessionId: string, secrets: string[] = [], redactor = new StreamRedactor(secrets)): SessionHost {
    return {
      update: (u) => this.onUpdate(taskId, sessionId, u, secrets, redactor),
      requestPermission: (req, signal) => this.onPermission(taskId, sessionId, secrets.length ? {
        ...req, title: redactExact(req.title, secrets), reason: redactExact(req.reason, secrets), detail: redactExact(req.detail, secrets),
      } : req, signal),
    };
  }

  /** 流式脱敏扣留的尾巴：按原来的事件类型补发 */
  private flushRedactor(taskId: string, sessionId: string, red: StreamRedactor, except?: string) {
    for (const key of red.keys()) {
      if (key === except) continue;
      const text = red.flush(key);
      if (!text) continue;
      const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      const base = { taskId, sessionId } as const;
      if (kind === 'm') this.events.append({ ...base, type: 'message.delta', data: { messageId: id, text } });
      else if (kind === 't') this.events.append({ ...base, type: 'thought.delta', data: { messageId: id, text } });
      else if (kind === 'o') this.events.append({ ...base, type: 'tool.output', data: { toolId: id, text } });
    }
  }

  /** session.config：当前模型、强度、权限，以及当前会话可选的模型和强度（切换器用） */
  private emitConfig(taskId: string, sessionId: string | null, st: SessionConfigState | null) {
    const row = this.getRow(taskId);
    const extra = st
      ? { agentMode: st.mode, models: st.models, efforts: st.efforts }
      : (() => {
        const a = this.agents.get(row.agent);
        if (!a?.real || !this.agentSvc) return {};
        const cat = this.agentSvc.catalog(row.agent, row.profile_id);
        return { models: cat.models, efforts: cat.efforts };
      })();
    this.events.append({ type: 'session.config', taskId, sessionId, data: { model: row.model, effort: row.effort, permission: row.permission_level, ...extra } });
  }

  private onUpdate(taskId: string, sessionId: string, u: AgentUpdate, secrets: string[] = [], red?: StreamRedactor) {
    this.activity.set(taskId, now());
    if (u.kind === 'activity') return;
    const base = { taskId, sessionId } as const;
    // 写进事件库前按密钥原文脱敏（工具输出里可能有 env / printenv 打出来的 API Key）；流式分片扣留可能是密钥开头的尾巴
    const streamKey = u.kind === 'message' ? `m:${u.messageId}` : u.kind === 'thought' ? `t:${u.messageId}` : u.kind === 'tool_output' ? `o:${u.toolId}` : null;
    if (red?.active) this.flushRedactor(taskId, sessionId, red, streamKey ?? undefined);
    const clean = (s: string) => (secrets.length ? redactExact(s, secrets) : s);
    const piece = (key: string, text: string) => (red?.active ? red.push(key, text) : text);
    switch (u.kind) {
      case 'thought': {
        const text = piece(`t:${u.messageId}`, u.text);
        if (text) this.events.append({ ...base, type: 'thought.delta', data: { messageId: u.messageId, text } });
        const rt = this.runtimes.get(taskId);
        if (rt?.profileId && this.agentSvc && !rt.conn.caps?.thoughts) this.agentSvc.saveThoughts(this.getRow(taskId).agent, rt.profileId);
        break;
      }
      case 'message': {
        const text = piece(`m:${u.messageId}`, u.text);
        if (text) this.events.append({ ...base, type: 'message.delta', data: { messageId: u.messageId, text } });
        break;
      }
      case 'message_done': this.touch(taskId); this.events.append({ ...base, type: 'message.done', data: { messageId: u.messageId } }); break;
      case 'tool_start': this.touch(taskId); this.events.append({ ...base, type: 'tool.start', data: { toolId: u.toolId, kind: u.toolKind, title: clean(u.title), target: u.target === null ? null : clean(u.target) } }); break;
      case 'tool_update': this.events.append({ ...base, type: 'tool.update', data: {
        toolId: u.toolId, ...(u.title !== undefined ? { title: clean(u.title) } : {}),
        ...(u.target !== undefined ? { target: u.target === null ? null : clean(u.target) } : {}),
        ...(u.toolKind !== undefined ? { kind: u.toolKind } : {}),
      } }); break;
      case 'tool_output': {
        const text = piece(`o:${u.toolId}`, u.text);
        if (text) this.events.append({ ...base, type: 'tool.output', data: { toolId: u.toolId, text } });
        break;
      }
      case 'tool_end': this.events.append({ ...base, type: 'tool.end', data: { toolId: u.toolId, ok: u.ok, summary: u.summary === null ? null : clean(u.summary), ...(u.rejected ? { rejected: true } : {}) } }); break;
      case 'plan': this.events.append({ ...base, type: 'plan.update', data: { items: secrets.length ? u.items.map((i) => ({ ...i, text: clean(i.text) })) : u.items } }); break;
      case 'config': {
        const row = this.getRow(taskId);
        this.events.append({ ...base, type: 'session.config', data: { model: u.model, effort: u.effort, permission: row.permission_level } });
        break;
      }
      case 'config_options': {
        // 以 Agent 返回的全量配置为准：任务记录跟着更新
        const st = u.state;
        const row = this.getRow(taskId);
        if ((st.model !== null && st.model !== row.model) || (st.effort !== row.effort && (st.effort !== null || st.efforts === null))) {
          this.db.run('UPDATE tasks SET model = ?, effort = ?, updated_at = ? WHERE id = ?', st.model ?? row.model, st.effort, now(), taskId);
        }
        this.emitConfig(taskId, sessionId, st);
        const rt = this.runtimes.get(taskId);
        if (rt?.profileId && this.agentSvc) this.agentSvc.saveCatalog(row.agent, rt.profileId, st);
        break;
      }
      case 'mode': {
        const row = this.getRow(taskId);
        this.events.append({ ...base, type: 'session.config', data: { model: row.model, effort: row.effort, permission: row.permission_level, agentMode: u.modeId } });
        break;
      }
      case 'usage': this.events.append({ ...base, type: 'session.usage', data: { used: u.used, size: u.size, ...(u.cost ? { cost: u.cost } : {}) } }); break;
      case 'notice': this.events.append({ ...base, type: 'session.notice', data: { level: u.level, text: clean(u.text) } }); break;
      case 'auth': {
        const rt = this.runtimes.get(taskId);
        if (rt?.profileId && this.agentSvc) this.agentSvc.markAuth(this.getRow(taskId).agent, rt.profileId, u.loggedIn);
        break;
      }
    }
  }

  /** 关闭一个运行时（主动）：释放名额，会话记为结束，agent_session_id 保留用于恢复 */
  private async dropRuntime(taskId: string, reason: string) {
    const rt = this.runtimes.get(taskId);
    if (!rt) return;
    rt.closing = true;
    this.runtimes.delete(taskId);
    try { await rt.conn.close(); } catch { /* 忽略 */ }
    rt.release();
    this.endSession(taskId, rt.sessionId, reason);
  }

  private endSession(taskId: string, sessionId: string, reason: string) {
    const r = this.db.run("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'", now(), sessionId);
    if (r.changes > 0) this.events.append({ type: 'session.ended', taskId, sessionId, data: { reason } });
  }

  /**
   * 进程退出（phase-1.md 6.5.3）：意外退出，或适配器自己结束了进程（取消无响应、模式改不回来，killed）。
   * 回合进行中 → 由 runTurn 决定状态；空闲 → 状态不变。立即释放并发名额，未决审批一律作废
   */
  private onExit(taskId: string, rt: Runtime, killed = false) {
    if (rt.closing || this.runtimes.get(taskId) !== rt) return;
    this.runtimes.delete(taskId);
    rt.release();
    for (const p of [...this.pending.values()]) {
      if (p.approval.sessionId !== rt.sessionId) continue;
      p.cleanup();
      this.finishApproval(p.approval.id, 'expired', null, null);
      p.reject(new AbortError());
    }
    this.endSession(taskId, rt.sessionId, killed ? 'closed' : 'crashed');
  }

  private async ensureRuntime(taskId: string, signal?: AbortSignal): Promise<Runtime> {
    const existing = this.runtimes.get(taskId);
    if (existing && !existing.conn.isClosed?.()) return existing;
    if (existing) {
      // 取消无响应时进程被结束了：下一条消息时恢复会话
      this.runtimes.delete(taskId);
      existing.release();
      this.endSession(taskId, existing.sessionId, 'closed');
    }
    const inflight = this.starting.get(taskId);
    if (inflight) return inflight;
    const p = this.startRuntime(taskId, signal);
    this.starting.set(taskId, p);
    try { return await p; } finally { this.starting.delete(taskId); }
  }

  private async startRuntime(taskId: string, signal?: AbortSignal, opts: { strictResume?: boolean; noQueue?: boolean } = {}): Promise<Runtime> {
    const row = this.getRow(taskId);
    const a = await this.adapterFor(row.agent, row.profile_id);
    const project = this.db.get<{ path: string }>('SELECT path FROM projects WHERE id = ?', row.project_id);
    const svc = a.real ? this.agentSvc : null;
    const profile = svc ? svc.profiles.resolve(row.agent, row.profile_id) : null;
    const spawnEnv = svc && profile ? await svc.profiles.envFor(a, profile) : null;
    const secrets = spawnEnv?.redact ?? [];
    this.secretsOf.set(taskId, secrets);
    // 前面的 await 期间用户可能已经点了 [停止]：不要再去排队
    if (signal?.aborted) throw new AbortError();
    // 并发上限：超出时任务进入“排队中”，有进程空出来就按顺序启动。不是回合的启动（换账号）不排队
    let release: () => void = () => {};
    if (svc) {
      const r = await svc.acquire(row.agent, () => this.setStatus(taskId, 'queued'), signal, { wait: !opts.noQueue });
      if (!r) throw new SlotBusyError();
      release = r;
    }
    try {
      if (signal?.aborted) throw new AbortError();
      if (this.getRow(taskId).status === 'queued' && this.turnAborts.has(taskId)) this.setStatus(taskId, 'running');
      // 上一个会话：同一个任务、同一个 Agent，有 agent_session_id → 恢复（H1）。不限定账号：换账号后也先试着恢复，
      // 恢复不了时适配器会新建会话并提示“Agent 不记得之前的对话”，不会悄悄丢掉上下文
      const prev = this.db.get<{ id: string; agent_session_id: string; caps_json: string | null }>(
        `SELECT id, agent_session_id, caps_json FROM sessions WHERE task_id = ? AND agent_id = ? AND agent_session_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
        taskId, row.agent,
      );
      const resume = a.real && prev ? { agentSessionId: prev.agent_session_id } : undefined;
      // H1：上次的会话不能在会话里换模型时，启动时就指定模型
      const launchModel = !!(a.real && a.launchModel && row.model && this.modelSwitchOf(prev?.caps_json ?? null, row.agent, profile?.id ?? null) === 'none');
      const sessionId = newId('s');
      const redactor = new StreamRedactor(secrets);
      const conn = await a.spawn({
        cwd: project?.path ?? process.cwd(), model: row.model, effort: row.effort, permission: row.permission_level,
        host: this.host(taskId, sessionId, secrets, redactor), sessionLabel: sessionId,
        ...(spawnEnv ? { env: spawnEnv.env, redact: spawnEnv.redact, profile: spawnEnv.account } : {}),
        ...(resume ? { resume } : {}), ...(signal ? { signal } : {}), ...(launchModel ? { launchModel: true } : {}),
      });
      if (opts.strictResume && resume && !conn.resumed) {
        await conn.close().catch(() => {});
        throw Errors.notRecoverable('换账号后原来的会话找不到了', '同一个 Agent 换账号需要交接，会在第 1.4 步提供；现在可以换回原来的账号');
      }
      if (signal?.aborted) { await conn.close().catch(() => {}); throw new AbortError(); }
      const caps = await a.probeCapabilities(conn);
      // Agent 实际用的模型和任务记录不一致（例如没能下发保存的模型）：以 Agent 为准写回，界面不再显示一个没生效的模型
      const actual = a.real ? conn.config?.() ?? null : null;
      if (actual && row.model !== null && actual.model !== row.model) {
        this.db.run('UPDATE tasks SET model = ?, updated_at = ? WHERE id = ?', actual.model, now(), taskId);
      }
      this.db.run(
        "INSERT INTO sessions (id, task_id, agent_id, profile_id, model, agent_session_id, parent_session_id, caps_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        sessionId, taskId, row.agent, profile?.id ?? null, actual?.model ?? row.model, conn.agentSessionId, prev?.id ?? null, JSON.stringify(caps), now(),
      );
      this.events.append({
        type: 'session.started', taskId, sessionId,
        data: { agent: row.agent, model: conn.config?.().model ?? row.model, ...(profile ? { profileId: profile.id } : {}), ...(a.real ? { resumed: !!conn.resumed } : {}) },
      });
      const rt: Runtime = { sessionId, conn, profileId: profile?.id ?? null, release, lastActive: now(), closing: false, secrets, redactor };
      this.runtimes.set(taskId, rt);
      conn.onExit?.((info) => this.onExit(taskId, rt, !!info.killed));
      // 建会话期间产生的更新（恢复失败的提示、配置）在 session.started 之后补发
      conn.ready?.();
      if (svc && profile) {
        svc.saveCaps(row.agent, profile.id, caps, conn.config?.() ?? null);
        svc.markAuth(row.agent, profile.id, true);
      }
      return rt;
    } catch (e) {
      release();
      throw e;
    }
  }

  private isBusy(taskId: string) {
    return this.turnAborts.has(taskId);
  }

  /** 上一个会话（或能力缓存）记录的换模型方式；不知道时返回 null */
  private modelSwitchOf(capsJson: string | null, agent: AgentKind, profileId: string | null): string | null {
    if (capsJson) {
      try { const c = JSON.parse(capsJson) as { modelSwitch?: unknown }; if (typeof c.modelSwitch === 'string') return c.modelSwitch; } catch { /* 下面 */ }
    }
    return this.agentSvc?.cachedModelSwitch(agent, profileId) ?? null;
  }

  /** 发一条用户消息并在后台跑一轮 */
  private startTurn(taskId: string, text: string, attachments: AttachmentInfo[] = [], inputs: PromptAttachment[] = []): string {
    const messageId = newId('m');
    this.touch(taskId, true);
    this.events.append({ type: 'message.user', taskId, sessionId: this.runtimes.get(taskId)?.sessionId ?? null, data: { messageId, text, ...(attachments.length ? { attachments } : {}) } });
    // 同步占住“忙碌”状态：避免两条 prompt 同时进来，也让会话启动期间的 cancel 能找到这个回合
    this.attachments?.markUsed(taskId, attachments.map((a) => a.id));
    const abort = new AbortController();
    this.turnAborts.set(taskId, abort);
    this.setStatus(taskId, 'running');
    const turn = this.runTurn(taskId, text, abort, inputs);
    this.turns.add(turn);
    void turn.finally(() => this.turns.delete(turn));
    return messageId;
  }

  /** 错误事件：动作按钮带上 taskId，界面可以直接执行 */
  private emitError(taskId: string, sessionId: string | null, body: ApiError) {
    const error: ApiError = { ...body, actions: body.actions.map((x) => ({ ...x, args: { taskId, ...(x.args ?? {}) } })) };
    this.events.append({ type: 'error', taskId, sessionId, data: { error } });
  }

  private async runTurn(taskId: string, text: string, abort: AbortController, attachments: PromptAttachment[]) {
    let rt: Runtime | undefined;
    let watchdog: NodeJS.Timeout | undefined;
    let noResponse = false;
    this.approvalTimedOut.delete(taskId);
    try {
      rt = await this.ensureRuntime(taskId, abort.signal);
      if (abort.signal.aborted) throw new AbortError();
      rt.lastActive = now();
      this.activity.set(taskId, now());
      let lastNotice = -Infinity;
      const noticeId = newId('idle');
      const timeout = new Promise<never>((_, reject) => {
        watchdog = setInterval(() => {
          if ([...this.pending.values()].some((p) => p.approval.taskId === taskId)) { this.activity.set(taskId, now()); return; }
          const idle = now() - (this.activity.get(taskId) ?? now());
          if (idle >= this.noResponseCancelMs) {
            noResponse = true;
            reject(new AppError(504, { code: ErrorCode.AgentNoResponse, message: 'Agent 10 分钟没有回应，这一轮已停止', hint: '可以重新发送，或换个模型 / 账号', actions: [{ label: '重试', action: 'task.retry' }, { label: '换模型', action: 'task.switch_model' }] }));
            abort.abort();
          } else if (idle >= this.noResponseNoticeMs && now() - lastNotice >= 120_000) {
            lastNotice = now();
            this.events.append({ type: 'session.notice', taskId, sessionId: rt!.sessionId, data: { id: noticeId, level: 'warn', text: 'Agent 已经 ' + Math.max(1, Math.floor(idle / 60_000)) + ' 分钟没有回应，可能在重试或网络不稳定。可以继续等，也可以停止这一轮。' } });
          }
        }, Math.min(1000, this.noResponseNoticeMs, this.noResponseCancelMs));
        watchdog.unref?.();
      });
      const r = await Promise.race([rt.conn.prompt({ text, attachments }, abort.signal), timeout]);
      rt.lastActive = now();
      if (rt.redactor.active) this.flushRedactor(taskId, rt.sessionId, rt.redactor);
      // 审批超时：不放行，本轮结束后任务暂停（不进入待验收）
      const timedOut = this.approvalTimedOut.has(taskId);
      if (timedOut && r.stopReason !== 'error') {
        this.events.append({ type: 'session.notice', taskId, sessionId: rt.sessionId, data: { level: 'warn', text: '有审批超时没有处理，没有放行；任务已暂停，可以继续发消息' } });
      }
      this.setStatus(taskId, r.stopReason === 'cancelled' || timedOut ? 'paused' : r.stopReason === 'error' ? 'failed' : 'review');
    } catch (e) {
      if (rt?.redactor.active) this.flushRedactor(taskId, rt.sessionId, rt.redactor);
      // 用户点了 [停止]：不管启动阶段抛的是什么（取消、或进程被结束导致的错误），都按暂停处理
      if (noResponse) {
        this.emitError(taskId, rt?.sessionId ?? null, (e as AppError).body);
        this.setStatus(taskId, 'paused');
      } else if (e instanceof AbortError || abort.signal.aborted) {
        this.setStatus(taskId, 'paused');
      } else if (e instanceof SlotBusyError) {
        this.setStatus(taskId, 'paused');
      } else if (e instanceof AgentError) {
        this.onAgentError(taskId, rt, e);
      } else if (e instanceof Error && 'body' in e && 'status' in e) {
        // AppError（例如没有登录、密钥读不出来）
        const body = (e as unknown as { body: ApiError }).body;
        this.emitError(taskId, rt?.sessionId ?? null, body);
        this.setStatus(taskId, 'failed');
      } else {
        console.error('[tasks] 任务执行出错', e);
        const msg = e instanceof Error ? e.message : String(e);
        this.emitError(taskId, rt?.sessionId ?? null, { code: ErrorCode.AgentFailed, message: `Agent 执行出错：${redactText(msg, rt?.secrets ?? this.secretsOf.get(taskId) ?? [])}`, hint: '可以重新发送消息再试一次', actions: [] });
        this.setStatus(taskId, 'failed');
      }
    } finally {
      if (watchdog) clearInterval(watchdog);
      this.activity.delete(taskId);
      if (this.turnAborts.get(taskId) === abort) this.turnAborts.delete(taskId);
      this.approvalTimedOut.delete(taskId);
      if (rt) rt.lastActive = now();
      // 进程在这一轮里被结束了（取消无响应等）：立即释放名额、记会话结束，不等下一条消息或空闲回收
      if (rt && rt.conn.isClosed?.() && this.runtimes.get(taskId) === rt) this.onExit(taskId, rt, true);
    }
  }

  /** 适配器错误 → 任务状态（phase-1.md 6.5.3）。不自动重试，不自动换账号或模型 */
  private onAgentError(taskId: string, rt: Runtime | undefined, e: AgentError) {
    const row = this.getRow(taskId);
    const sessionId = rt?.sessionId ?? null;
    this.emitError(taskId, sessionId, e.body);
    switch (e.reason) {
      case 'auth': {
        const pid = rt?.profileId ?? (this.agentSvc && this.agents.get(row.agent)?.real ? this.agentSvc.profiles.resolve(row.agent, row.profile_id).id : null);
        if (pid && this.agentSvc) this.agentSvc.markAuth(row.agent, pid, false);
        this.setStatus(taskId, 'paused');
        break;
      }
      case 'invalid_value':
        this.db.run('INSERT INTO model_failures (agent,profile_id,model,reason,at) VALUES (?,?,?,?,?) ON CONFLICT(agent,profile_id,model) DO UPDATE SET reason=excluded.reason,at=excluded.at', row.agent, rt?.profileId ?? row.profile_id ?? '', row.model ?? '', e.body.message, now());
        this.agentSvc?.pushStatus(row.agent);
        this.setStatus(taskId, 'paused'); break;
      case 'quota': this.setStatus(taskId, 'paused'); break;
      case 'crashed': this.setStatus(taskId, 'interrupted'); break;
      default: this.setStatus(taskId, 'failed');
    }
  }

  async prompt(taskId: string, text: string, attachmentIds: string[] = []): Promise<{ taskId: string; messageId: string }> {
    const row = this.getRow(taskId);
    if (FINAL.includes(row.status)) throw Errors.invalidState('任务已经结束，不能继续发送消息');
    if (this.isBusy(taskId)) throw Errors.invalidState('任务正在执行', '请等这一轮结束，或先点 [停止]', [{ label: '停止', action: 'task.cancel', args: { taskId } }]);
    const a = this.attachments?.resolve(taskId, attachmentIds) ?? { infos: [], inputs: [] };
    const agent = this.agents.get(row.agent);
    const info = agent ? this.agentSvc?.info(agent) : undefined;
    const configModels = this.runtimes.get(taskId)?.conn.config?.().models;
    if (a.infos.some((x) => x.kind === 'image') && visionOf(info ? { ...info, models: configModels ?? info.models } : undefined, row.model) === false) {
      throw new AppError(415, { code: ErrorCode.AttachmentUnsupported, message: (info?.displayName ?? row.agent) + ' · ' + (row.model ?? '当前模型') + ' 看不了图片', actions: [{ label: '换模型', action: 'task.switch_model', args: { taskId } }] });
    }
    return { taskId, messageId: this.startTurn(taskId, text, a.infos, a.inputs) };
  }

  async cancel(taskId: string): Promise<void> {
    this.getRow(taskId);
    const abort = this.turnAborts.get(taskId);
    if (!abort) return; // 没在执行，取消视为成功（幂等）
    abort.abort();
  }

  /**
   * 切换（design.md 7.4）：同 Agent 换模型、思考强度（H0：会话内切换；不支持时 H1：结束进程 → 带新参数重启 → 恢复）；
   * 同 Agent 换账号（结束进程 → 用新账号重启 → 恢复）；跨 Agent 在 1.4 提供。
   */
  async switch(taskId: string, opts: { agent?: AgentKind | undefined; model?: string | undefined; effort?: string | undefined; profileId?: string | undefined }): Promise<Task> {
    const row = this.getRow(taskId);
    if (opts.agent && opts.agent !== row.agent) {
      throw Errors.agentUnavailable('暂时不能切换到其他 Agent', '跨 Agent 交接会在第 1.4 步提供；现在可以换模型或思考强度');
    }
    if (opts.profileId !== undefined && opts.profileId !== row.profile_id) await this.switchProfile(taskId, opts.profileId);
    if (opts.model === undefined && opts.effort === undefined) return this.get(taskId);
    const cur = this.getRow(taskId);
    const a = await this.adapterFor(cur.agent, cur.profile_id);
    const rt = this.runtimes.get(taskId);
    const live = rt && !rt.conn.isClosed?.() ? rt : undefined;

    if (!a.real) {
      // 演示 Agent：1.1 的行为
      const { model, effort } = await this.checkModel(a, opts.model ?? cur.model, opts.effort ?? cur.effort);
      this.db.run('UPDATE tasks SET model = ?, effort = ?, updated_at = ? WHERE id = ?', model, effort, now(), taskId);
      if (live) await live.conn.setConfig({ ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      else this.events.append({ type: 'session.config', taskId, sessionId: null, data: { model, effort, permission: cur.permission_level } });
      this.emitUpdated(taskId);
      return this.get(taskId);
    }

    if (live) {
      const st = live.conn.config?.();
      const caps = live.conn.caps;
      if (opts.model !== undefined && st && st.models.length && !st.models.some((m) => m.id === opts.model)) {
        throw Errors.badRequest(`${a.displayName} 没有这个模型：${opts.model}`);
      }
      if (opts.model !== undefined && opts.model !== st?.model && caps?.modelSwitch === 'none') {
        // H1：结束进程 → 用新模型参数重启 → 恢复
        if (!caps.resume && !caps.loadSession) throw Errors.agentUnavailable(`${a.displayName} 不支持在会话里换模型，也不能恢复会话`, '换模型需要交接，会在第 1.4 步提供');
        if (!a.launchModel) throw Errors.agentUnavailable(`${a.displayName} 不支持在会话里换模型，也不能在启动时指定模型`, '换模型需要交接，会在第 1.4 步提供');
        if (this.isBusy(taskId)) throw Errors.invalidState('任务正在执行', '请等这一轮结束，或先点 [停止] 再换模型', [{ label: '停止', action: 'task.cancel', args: { taskId } }]);
        this.db.run('UPDATE tasks SET model = ?, effort = COALESCE(?, effort), updated_at = ? WHERE id = ?', opts.model, opts.effort ?? null, now(), taskId);
        await this.dropRuntime(taskId, 'switch_model');
        this.events.append({ type: 'session.notice', taskId, sessionId: null, data: { level: 'info', text: `${a.displayName} 不支持在会话里换模型，下一条消息时会以新模型恢复会话` } });
        this.emitConfig(taskId, null, null);
        this.emitUpdated(taskId);
        return this.get(taskId);
      }
      // H0：会话内切换；失败时保留原值（Agent 的说明在 error.hint 里）。中途失败（模型换了、强度没换）也按 Agent 的真实状态写回
      const writeBack = () => {
        const after = live.conn.config?.();
        if (after) this.db.run('UPDATE tasks SET model = ?, effort = ?, updated_at = ? WHERE id = ?', after.model ?? cur.model, after.effort, now(), taskId);
      };
      try {
        await live.conn.setConfig({ ...(opts.model !== undefined ? { model: opts.model } : {}), ...(opts.effort !== undefined ? { effort: opts.effort } : {}) });
      } catch (e) {
        writeBack();
        this.emitUpdated(taskId);
        throw e;
      }
      writeBack();
      this.emitUpdated(taskId);
      return this.get(taskId);
    }

    // 没有会话：只改任务记录，下次建会话时下发
    const { model, effort } = await this.checkModel(a, opts.model ?? cur.model, opts.effort ?? cur.effort, cur.profile_id);
    this.db.run('UPDATE tasks SET model = ?, effort = ?, updated_at = ? WHERE id = ?', model, effort, now(), taskId);
    this.emitConfig(taskId, null, null);
    this.emitUpdated(taskId);
    return this.get(taskId);
  }

  /** 同 Agent 换账号（phase-1.md 6.5.4）：有会话时结束进程 → 用新账号重启 → 恢复；会话找不到时报 session.not_recoverable */
  private async switchProfile(taskId: string, profileId: string | null) {
    const row = this.getRow(taskId);
    const a = this.agents.get(row.agent);
    if (!a?.real || !this.agentSvc) throw Errors.badRequest(`${a?.displayName ?? '这个 Agent'} 不需要账号`);
    const target = this.agentSvc.profiles.resolve(row.agent, profileId);
    if (this.isBusy(taskId)) throw Errors.invalidState('任务正在执行', '请等这一轮结束，或先点 [停止] 再换账号', [{ label: '停止', action: 'task.cancel', args: { taskId } }]);
    // 会话存放位置不同（例如本机登录 ↔ 独立配置目录的账号）：原来的会话在新账号下一定恢复不了，换过去会悄悄丢掉上下文
    const from = this.agentSvc.profiles.resolve(row.agent, row.profile_id);
    const hadSession = !!this.db.get('SELECT id FROM sessions WHERE task_id = ? AND agent_id = ? AND agent_session_id IS NOT NULL LIMIT 1', taskId, row.agent);
    if (hadSession && this.agentSvc.profiles.sessionStore(from) !== this.agentSvc.profiles.sessionStore(target)) {
      throw Errors.notRecoverable(
        `“${target.name}”和“${from.name}”的会话不在同一个地方，换过去 Agent 会不记得之前的对话`,
        '换到这个账号需要交接，会在第 1.4 步提供；现在可以新建一个任务并选这个账号',
      );
    }
    const rt = this.runtimes.get(taskId);
    const old = row.profile_id;
    this.db.run('UPDATE tasks SET profile_id = ?, updated_at = ? WHERE id = ?', profileId, now(), taskId);
    if (!rt) {
      // 没有进程（空闲回收、Gateway 重启过、还没建过会话）：下一条消息时用新账号恢复最近的会话；
      // 恢复不了时适配器会新建会话并发 session.notice（Agent 不记得之前的对话），不会悄悄丢掉上下文
      this.emitUpdated(taskId);
      return;
    }
    const agentSessionId = rt.conn.agentSessionId;
    await this.dropRuntime(taskId, 'switch_profile');
    // 新账号下恢复原来的会话（agent_session_id 相同，账号不同）
    this.db.run('UPDATE sessions SET profile_id = ? WHERE task_id = ? AND agent_session_id = ?', target.id, taskId, agentSessionId);
    try {
      // 不排队：名额被别的排队任务拿走时，不让这个请求一直挂着，改为下一条消息时再启动
      const p = this.startRuntime(taskId, undefined, { strictResume: true, noQueue: true });
      this.starting.set(taskId, p);
      await p;
    } catch (e) {
      if (e instanceof SlotBusyError) {
        this.events.append({ type: 'session.notice', taskId, sessionId: null, data: { level: 'info', text: `${a.displayName} 的并发名额已满，已换成新账号；发下一条消息时会用新账号恢复会话` } });
        this.emitUpdated(taskId);
        return;
      }
      this.db.run('UPDATE tasks SET profile_id = ? WHERE id = ?', old, taskId);
      this.db.run('UPDATE sessions SET profile_id = ? WHERE task_id = ? AND agent_session_id = ?', rt.profileId, taskId, agentSessionId);
      throw e;
    } finally {
      this.starting.delete(taskId);
    }
    this.emitUpdated(taskId);
  }

  /** 空闲回收：会话 30 分钟没有活动（没有回合、没有未决审批）就关闭进程，下次发消息时自动恢复 */
  private reapIdle() {
    const t = now();
    for (const [taskId, rt] of this.runtimes) {
      if (this.isBusy(taskId) || t - rt.lastActive < this.idleTimeoutMs) continue;
      if ([...this.pending.values()].some((p) => p.approval.taskId === taskId)) continue;
      if (!this.agents.get(this.getRow(taskId).agent)?.real) continue;
      this.log(`[tasks] 任务 ${taskId} 的会话空闲超过 ${Math.round(this.idleTimeoutMs / 60_000)} 分钟，关闭 Agent 进程`);
      void this.dropRuntime(taskId, 'idle');
    }
  }

  // ---------- 审批 ----------

  private onPermission(taskId: string, sessionId: string, req: PermissionRequest, signal: AbortSignal): Promise<PermissionOutcome> {
    this.activity.set(taskId, now());
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
        // Agent 自己撤回了请求（回合还在跑）：重新计算状态；回合被停止时由 runTurn 决定
        if (!this.turnAborts.get(taskId)?.signal.aborted) this.recomputeStatus(taskId);
        reject(new AbortError());
      };
      const timer = setTimeout(() => {
        const p = this.pending.get(approval.id);
        if (!p) return;
        p.cleanup();
        this.finishApproval(approval.id, 'expired', null, null);
        // 超时不放行；记下来，本轮结束后任务暂停（不进入待验收）
        this.approvalTimedOut.add(taskId);
        this.recomputeStatus(taskId);
        resolve({ outcome: 'cancelled' });
      }, this.approvalTimeoutMs);
      timer.unref?.();
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.pending.delete(approval.id);
        this.activity.set(taskId, now());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(approval.id, { approval, resolve, reject, timer, cleanup });
    });
  }

  /** 审批结束（处理、超时、撤回）后重新计算状态：还有未决审批 → 等待审批；回合还在跑 → 运行中 */
  private recomputeStatus(taskId: string) {
    const row = this.db.get<{ status: TaskStatus }>('SELECT status FROM tasks WHERE id = ?', taskId);
    if (!row) return;
    const waiting = [...this.pending.values()].some((p) => p.approval.taskId === taskId);
    const next: TaskStatus | null = waiting ? 'waiting' : this.isBusy(taskId) ? 'running' : null;
    if (next && next !== row.status) this.setStatus(taskId, next);
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
    // 拒绝理由（note）ACP 不支持回传，只存在审批记录里
    const a = this.finishApproval(approvalId, status, deviceId, optionId)!;
    if (note) {
      const withNote = { ...a, note };
      this.db.run('UPDATE approvals SET request_json = ? WHERE id = ?', JSON.stringify(withNote), approvalId);
    }
    // 还有别的审批没处理（并行的工具调用）→ 仍是“等待审批”，否则回到运行中；再把结果交还 Agent
    this.recomputeStatus(p.approval.taskId);
    // “总是允许”在 1.3 写入项目规则；1.1 先按允许一次处理
    p.resolve({ outcome: 'selected', optionId, ...(note ? { note } : {}) });
    return a;
  }

  /** 关闭：中断所有执行中的任务，关闭全部 Agent 会话 */
  async shutdown() {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    for (const abort of this.turnAborts.values()) abort.abort();
    await Promise.allSettled([...this.turns]);
    for (const t of this.emitTimers.values()) clearTimeout(t);
    this.emitTimers.clear();
    for (const p of [...this.pending.values()]) p.cleanup();
    const all = [...this.runtimes.entries()];
    this.runtimes.clear();
    await Promise.allSettled(all.map(async ([, rt]) => {
      rt.closing = true;
      await rt.conn.close().catch(() => {});
      rt.release();
    }));
  }

  /** 等所有正在执行的轮次结束（测试用） */
  async idle() { await Promise.allSettled([...this.turns]); }
}
