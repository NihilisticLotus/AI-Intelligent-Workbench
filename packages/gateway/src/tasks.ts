// 任务、会话与审批（1.1 版本的 TaskScheduler + SessionManager + PermissionBroker 合在这里，后续再拆）。
// 所有状态变化都先经过 EventStore.append（先写库，再推送）。
// 1.2：真实 Agent 的会话运行时（账号环境变量、恢复 H1、并发上限、空闲回收、进程崩溃）、切换模型（H0）、异常映射（phase-1.md 6.5）。
import type { AgentKind, ApiError, Approval, PermissionLevel, Task, TaskStatus, AttachmentInfo, PromptAttachment } from '@aic/protocol';
import { ErrorCode, visionOf } from '@aic/protocol';
import type { z } from 'zod';
import type { CreateTaskBody, PatchTaskBody, TasksQuery, TaskActivity } from '@aic/protocol';
import { TaskQueue } from './task-queue';
import { AgentError, redact as redactText, redactExact, StreamRedactor, type SessionConfigState } from '@aic/adapters';
import { errorLogText } from './error-log';
import type { AgentAdapter, AgentConnection, AgentRegistry, AgentUpdate, PermissionOutcome, PermissionRequest, SessionHost } from './agents/registry';
import type { AgentService } from './agents/service';
import type { Db } from './db';
import type { EventStore } from './events';
import { AppError, AbortError, Errors, newId, now } from './util';
import type { IndependentTaskRuntime } from './independent/task-runtime';
import type { IndependentTaskOptions } from '@aic/protocol';
import { emptyUsage, recordTurnUsage } from './usage';
import { WorkspaceManager, WorkspaceError } from './workspaces';
import { GitError } from './git';
import { PermissionBroker } from './permission-rules';
import { TaskMemory } from './task-memory';
import type { HandoffTarget } from '@aic/protocol';
import type { HistoryAccess } from './handoff/history-access';
import { taskSummaryBody, limitTaskSummary } from './task-summary';
import type { PermissionOperation, PermissionContext, AlwaysAllowConfirmation, PermissionRulePreview } from '@aic/protocol';
import { validateProjectDir } from './fsbrowse';
import type { TaskWorkspace, MergeWorkspaceBody, WorkspaceOperationResult } from '@aic/protocol';

type TaskRow = {
  id: string; project_id: string; group_id: string | null; title: string; prompt: string;
  status: TaskStatus; permission_level: PermissionLevel; agent: AgentKind; model: string | null; effort: string | null;
  auto_allow_low_risk: number; auto_merge_on_pass: number;
  last_activity_at: number; created_at: number; updated_at: number;
  profile_id: string | null;
  workspace_kind: TaskWorkspace['kind'] | null; workspace_path: string | null; branch: string | null; base_ref: string | null;
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
  operation?: PermissionOperation;
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
  /** 有工具正在执行时的无回应上限（默认 60 分钟，不小于普通上限）；Agent 卡死在工具里也要能自动停下（ISSUE-0074）。 */
  noResponseToolCancelMs?: number;
  log?: (msg: string) => void;
}

const FINAL: TaskStatus[] = ['merged', 'discarded'];

/** 不排队的启动（换账号）遇到并发已满 */
class SlotBusyError extends Error {
  constructor() { super('并发已满'); this.name = 'SlotBusyError'; }
}

export class TaskService {
  readonly memory: TaskMemory;
  history?: HistoryAccess;
  private summaryJobs = new Map<string, Promise<void>>();
  private dirtySummaries = new Set<string>();
  savedSecrets: (content: string) => Promise<string[]> = async () => [];
  readonly permissions: PermissionBroker;
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
  private changeJobs = new Set<Promise<void>>();
  /** 这一轮里有审批超时：回合结束后任务暂停（不进入待验收） */
  private approvalTimedOut = new Set<string>();
  /** 每个任务最近一次启动时注入的密钥（启动失败时的兜底错误也要脱敏） */
  private secretsOf = new Map<string, string[]>();
  private lastActivity = 0;
  private activity = new Map<string, number>();
  /** 仅记录当前回合、当前会话已开始未结束的工具；回放和旧会话事件不延长等待。 */
  private activeTools = new Map<string, { sessionId: string; ids: Set<string> }>();
  private noResponseNoticeMs: number;
  private noResponseCancelMs: number;
  private noResponseToolCancelMs: number;
  attachments: import('./attachments').AttachmentService | null = null;
  private readonly approvalTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private idleTimer: NodeJS.Timeout | null = null;
  private log: (msg: string) => void;
  /** 由 Gateway 组装时注入（1.2）；为空时退回 1.1 的行为 */
  agentSvc: AgentService | null = null;
  independentRuntime: IndependentTaskRuntime | null = null;
  workspaces: WorkspaceManager | null = null;
  private projectQueue = new TaskQueue(() => 1, (_key, ids) => this.queueChanged(ids));
  private turnActivity = new Map<string, TaskActivity>();
  private configuring = new Set<string>();

  constructor(private db: Db, private events: EventStore, private agents: AgentRegistry, opts: TaskServiceOptions = {}) {
    this.memory = new TaskMemory(db,id=>this.secretsOf.get(id) ?? []);
    events.bus.on(event => {
      if (!event.taskId || !['task.created','plan.update','tool.end','approval.resolved'].includes(event.type)) return;
      this.memory.sync(event.taskId);
      if (event.type !== 'task.created') this.scheduleSummary(event.taskId);
    });
    this.permissions=new PermissionBroker(db);
    this.noResponseNoticeMs = opts.noResponseNoticeMs ?? 60_000;
    this.noResponseCancelMs = opts.noResponseCancelMs ?? 600_000;
    this.noResponseToolCancelMs = Math.max(this.noResponseCancelMs, opts.noResponseToolCancelMs ?? 3_600_000);
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 30 * 60_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
    this.log = opts.log ?? ((m) => console.log(m));
    this.idleTimer = setInterval(() => this.reapIdle(), Math.min(60_000, Math.max(1000, Math.floor(this.idleTimeoutMs / 4))));
    this.idleTimer.unref?.();
  }

  private async taskSummaryText(id: string) {
    const body = taskSummaryBody(this.memory.list(id));
    const secrets = [...await this.savedSecrets(body),...(this.secretsOf.get(id) ?? [])];
    return limitTaskSummary(body,secrets);
  }
  sessionSecrets(id: string): readonly string[] { return this.secretsOf.get(id) ?? []; }

  /** 同一副本的变化合并写入；新变化到达时，当前发布结束后重新从账本渲染。 */
  private scheduleSummary(id: string) {
    if (!this.workspaces?.get(id) || !['worktree','copy'].includes(this.getRow(id).workspace_kind ?? '')) return;
    this.dirtySummaries.add(id);
    if (this.summaryJobs.has(id)) return;
    const job = Promise.resolve().then(async () => {
      while (this.dirtySummaries.delete(id)) {
          const text = await this.taskSummaryText(id);
        await this.workspaces!.writeTaskArtifacts(id,new Map([['.aic/TASK.md',text]]));
      }
    }).catch(() => {
      // 文件并非唯一载体，账本仍可读取。不把第三方的路径、输出或密钥放入通知。
      if (this.db.get('SELECT id FROM tasks WHERE id=?',id)) this.events.append({type:'session.notice',taskId:id,sessionId:null,data:{level:'warn',text:'工作副本的任务说明未更新，完整记录可在任务账本中查看。'}});
    }).finally(() => { this.summaryJobs.delete(id); });
    this.summaryJobs.set(id,job);
  }

  async updateMemory(id: string, change: () => void) {
    this.getRow(id);
    change();
    this.events.append({taskId:id,sessionId:null,type:'task.memory_updated',data:{}});
    this.scheduleSummary(id);
    await this.summaryJobs.get(id);
    return {items:this.memory.list(id)};
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
  get(id: string): Task {
    const row = this.getRow(id);
    const task = toTask(row);
    const projectQueue = this.projectQueue.position(id), agentQueue = this.agentSvc?.queuePosition(id);
    if (projectQueue) task.queue = { scope: 'project', ...projectQueue };
    else if (agentQueue) task.queue = { scope: 'agent', ...agentQueue };
    if (['running', 'waiting'].includes(task.status)) task.activity = this.turnActivity.get(id);
    const record = this.workspaces?.get(id);
    task.permissionLevels=(task.agent==='fake'||task.agent==='independent')&&!!record&&['worktree','copy'].includes(row.workspace_kind??'')?['readonly','ask','workspace','full']:['readonly','ask'];
    const operation=this.workspaces?.operation(id);
    if(operation && ['merged','applied','rolled_back','discarded'].includes(operation.state))task.status=operation.state==='discarded'?'discarded':'merged';
    const prep = this.db.get<{state: 'preparing' | 'confirmation_required' | 'failed'; bytes: number | null; error: string | null}>('SELECT * FROM workspace_preparations WHERE task_id=?', id);
    task.workspace = { kind: row.workspace_kind ?? 'inplace', path: record?.path ?? row.workspace_path,
      branch: record?.branch ?? row.branch, baseRef: record?.baseRef ?? row.base_ref, baseBranch: record?.baseBranch ?? null,
      ...(prep ? { state: prep.state, ...(prep.bytes !== null ? { copyBytes: prep.bytes } : {}), ...(prep.error ? { error: prep.error } : {}) } : record ? { state: record.state === 'ready' ? 'ready' : 'failed' } : {}),
      ...(record ? { largeFiles: record.largeFiles.map(f => f.path) } : {}),
      ...(operation ? {operation:(({appliedFiles: _files,...visible})=>visible)(operation)} : {}),
      ...(operation?.state==='pending'?{state:'failed' as const,error:'上次项目操作尚未确认完成，请重启工作台核对记录；不要重复合并。'}:{}),
    };
    return task.agent === 'independent' && this.independentRuntime ? { ...task, independent: this.independentRuntime.reference(id) } : task;
  }

  async workspaceOperation<T>(id: string, operation: (manager: WorkspaceManager) => Promise<T>, write = false): Promise<T> {
    const task = this.get(id);
    if (!this.workspaces || !['worktree', 'copy'].includes(task.workspace?.kind ?? '')) throw Errors.invalidState('旧任务没有独立工作副本，请查看工具记录。');
    if (task.workspace?.state !== 'ready') throw Errors.invalidState('工作副本尚未准备好。');
    if (write && (this.isBusy(id) || FINAL.includes(task.status))) throw Errors.invalidState('请等任务空闲且未结束时再还原文件。');
    if (write) this.configuring.add(id);
    try { return await operation(this.workspaces); }
    catch (e) {
      if (e instanceof WorkspaceError) throw new AppError(e.code === 'workspace.path' ? 400 : 409, { code: e.code, message: e.message, actions: [] });
      if (e instanceof GitError) throw Errors.invalidState(e.message);
      throw e;
    } finally { if (write) this.configuring.delete(id); }
  }

  /** 工具结束时的刷新合并到 1.5 秒一次；进行中的刷新完成后再补一次，不在每个工具后都全量计算（ISSUE-0100）。 */
  private changeTimers = new Map<string, { timer: NodeJS.Timeout; done: Promise<void>; resolve: () => void }>();
  scheduleChanges(taskId: string, delayMs = 1500): Promise<void> {
    const pending = this.changeTimers.get(taskId);
    if (pending) return pending.done;
    let resolve!: () => void; const done = new Promise<void>((r) => { resolve = r; });
    const timer = setTimeout(() => { this.changeTimers.delete(taskId); void this.refreshChanges(taskId).finally(resolve); }, delayMs);
    timer.unref?.(); this.changeTimers.set(taskId, { timer, done, resolve });
    return done;
  }
  refreshChanges(taskId: string): Promise<void> {
    const scheduled = this.changeTimers.get(taskId);
    if (scheduled) { clearTimeout(scheduled.timer); this.changeTimers.delete(taskId); }
    const job0 = this.refreshNow(taskId);
    if (scheduled) void job0.finally(scheduled.resolve);
    return job0;
  }
  private refreshNow(taskId: string): Promise<void> {
    if (!this.db.get('SELECT id FROM tasks WHERE id=?', taskId)) return Promise.resolve();
    if (!['worktree', 'copy'].includes(this.getRow(taskId).workspace_kind ?? '') || !this.workspaces?.get(taskId)) return Promise.resolve();
    this.workspaces.invalidate(taskId);
    const job = this.workspaces.diff(taskId).then(changes => {
      this.events.append({ type: 'task.changes_updated', taskId, sessionId: null, data: { added: changes.added, removed: changes.removed, fileCount: changes.files.length } });
    }).catch(() => { /* 读取时仍在写文件时不发布旧统计；面板的读取错误与下次工具事件负责刷新。 */ });
    this.changeJobs.add(job); void job.finally(() => this.changeJobs.delete(job)); return job;
  }

  async restoreWorkspaceFile(id: string, relative: string) {
    const result = await this.workspaceOperation(id, manager => manager.restoreFile(id, relative), true);
    this.events.append({type:'task.file_restored',taskId:id,sessionId:null,data:{path:relative}});
    this.syncWorkspace(id); await this.refreshChanges(id); return result;
  }

  async finishWorkspace(id: string, action: 'merge'|'discard'|'rollback'|'open', body?: MergeWorkspaceBody): Promise<WorkspaceOperationResult|{ok:true}> {
    const task=this.get(id);
    if(this.isBusy(id)||['running','waiting','queued'].includes(task.status))throw Errors.invalidState('请等任务空闲后再操作工作副本。');
    if(FINAL.includes(task.status)&&action!=='rollback'&&action!=='open')throw Errors.invalidState('任务已经结束。');
    this.configuring.add(id);
    try {
      return await this.workspaceOperation(id,async manager=>{
        await this.dropRuntime(id,'workspace_operation');
        if(action==='open'){await manager.open(id);return {ok:true} as const;}
        let result:WorkspaceOperationResult;
        if(action==='discard')result=await manager.discard(id);
        else if(action==='rollback')result=task.workspace?.kind==='copy'?await manager.rollbackCopy(id):await manager.rollbackGit(id);
        else result=task.workspace?.kind==='copy'?await manager.applyCopy(id):await manager.mergeGit(id,body!);
        const final=manager.operation(id);
        if(final && ['merged','applied','rolled_back','discarded'].includes(final.state))this.db.run('UPDATE tasks SET status=?,finished_at=?,updated_at=? WHERE id=?',final.state==='discarded'?'discarded':'merged',final.finishedAt,now(),id);
        this.syncWorkspace(id);await this.refreshChanges(id);return result;
      });
    } finally {this.configuring.delete(id);}
  }

  async cleanupWorkspaces() {
    if(!this.workspaces)return {removed:[],failed:[]};
    return this.workspaces.cleanup(async id=>{
      if(this.isBusy(id))return false;
      await this.dropRuntime(id,'workspace_cleanup');return true;
    });
  }

  async deleteTask(id:string) {
    const task=this.get(id);if(this.isBusy(id)||['running','waiting','queued'].includes(task.status))throw Errors.invalidState('请等任务空闲后再删除。');
    if(task.workspace?.operation?.state==='pending')throw Errors.invalidState('上次工作区操作尚未核对，暂不能删除恢复记录。');
    this.configuring.add(id);
    try {
      await this.dropRuntime(id,'task_deleted');
      if(this.workspaces?.get(id))await this.workspaces.remove(id);
      this.attachments?.deleteTask(id);
      this.db.tx(()=>{
        this.db.run('DELETE FROM tasks WHERE id=?',id);
        this.db.run('DELETE FROM sessions WHERE task_id=?',id);
        this.db.run('DELETE FROM approvals WHERE task_id=?',id);
        this.db.run('DELETE FROM workspace_preparations WHERE task_id=?',id);
        this.db.run('DELETE FROM workspace_operations WHERE task_id=?',id);
        this.events.append({type:'task.deleted',taskId:null,sessionId:null,data:{id}});
      });
      const timer=this.emitTimers.get(id);if(timer)clearTimeout(timer);this.emitTimers.delete(id);this.lastEmit.delete(id);
      return {ok:true};
    }catch(e){if(e instanceof WorkspaceError)throw new AppError(409,{code:e.code,message:e.message,actions:[]});if(e instanceof GitError)throw Errors.invalidState(e.message);throw e;}
    finally{this.configuring.delete(id);}
  }

  private syncWorkspace(id: string) {
    const record = this.workspaces?.get(id);
    if (record) this.db.run('UPDATE tasks SET workspace_path=?,branch=?,base_ref=?,snapshot_before=?,snapshot_after=?,workspace_large_files=? WHERE id=?', record.path, record.branch, record.baseRef, record.snapshotBefore, record.snapshotAfter, JSON.stringify(record.largeFiles), id);
    this.emitUpdated(id);
  }

  /** 准备失败保留任务与原因，不降级到项目原目录；大复制只在明确确认后继续。 */
  private async prepareNewWorkspace(id: string, deferPrompt: boolean, confirmed = false): Promise<boolean> {
    if (!this.workspaces) return true;
    this.configuring.add(id);
    try {
      const row = this.getRow(id);
      const project = this.db.get<{path: string; is_git: number; ignore_globs: string | null; carry_globs: string | null}>('SELECT * FROM projects WHERE id=?', row.project_id)!;
      // 先标记新任务，检查目录失败时也不能被误认为旧 inplace。
      const kind = row.workspace_kind ?? (project.is_git ? 'worktree' : 'copy');
      this.db.run('UPDATE tasks SET workspace_kind=? WHERE id=?', kind, id);
      this.db.run("INSERT INTO workspace_preparations(task_id,state,defer_prompt) VALUES (?,'preparing',?) ON CONFLICT(task_id) DO UPDATE SET state='preparing',error=NULL", id, deferPrompt ? 1 : 0);
      const actual = validateProjectDir(project.path);
      const selected = actual.isGit ? 'worktree' : 'copy';
      // 已有 git 项目丢失 .git 时必须报错，不能悄悄当非 git 处理。
      if (project.is_git && !actual.isGit) throw new WorkspaceError('workspace.git', '项目目录不是有效的 git 仓库。');
      this.db.run('UPDATE tasks SET workspace_kind=? WHERE id=?', selected, id);
      const request = { taskId: id, projectId: row.project_id, title: row.title, projectPath: project.path,
        ignoreGlobs: JSON.parse(project.ignore_globs ?? '[]') as string[], carryGlobs: JSON.parse(project.carry_globs ?? '[]') as string[], confirmLargeCopy: confirmed };
      if (selected === 'worktree') await this.workspaces.createWorktree(request);
      else await this.workspaces.createCopy(request);
      this.scheduleSummary(id);
      this.db.run('DELETE FROM workspace_preparations WHERE task_id=?', id);
      this.syncWorkspace(id);
      return true;
    } catch (error) {
      const confirmation = error instanceof WorkspaceError && error.code === 'workspace.copy_confirmation';
      const message = error instanceof WorkspaceError || error instanceof GitError ? error.message : error instanceof AppError ? error.body.message : '工作副本准备失败，请检查项目文件夹和磁盘空间。';
      this.db.run('UPDATE workspace_preparations SET state=?,bytes=?,error=? WHERE task_id=?', confirmation ? 'confirmation_required' : 'failed', confirmation ? error.bytes ?? null : null, message, id);
      this.setStatus(id, confirmation ? 'draft' : 'failed');
      if (!confirmation) this.emitError(id, null, { code: ErrorCode.AgentFailed, message, actions: [] });
      return false;
    } finally { this.configuring.delete(id); }
  }

  async confirmWorkspace(id: string): Promise<Task> {
    const prep = this.db.get<{state: string; defer_prompt: number}>('SELECT * FROM workspace_preparations WHERE task_id=?', id);
    if (!prep || prep.state !== 'confirmation_required' || this.isBusy(id)) throw Errors.invalidState('这个任务没有等待复制确认');
    if (await this.prepareNewWorkspace(id, !!prep.defer_prompt, true)) {
      if (prep.defer_prompt) this.setStatus(id, 'draft');
      else this.startTurn(id, this.getRow(id).prompt);
    }
    return this.get(id);
  }

  private async runtimePath(id: string): Promise<string> {
    const row = this.getRow(id);
    if (row.workspace_kind === 'worktree' || row.workspace_kind === 'copy') {
      if (!this.workspaces) throw Errors.invalidState('工作副本管理器不可用');
      return this.workspaces.runtimePath(id);
    }
    const project = this.db.get<{path: string}>('SELECT path FROM projects WHERE id=?', row.project_id);
    if (!project) throw Errors.notFound('找不到任务的项目');
    return project.path;
  }

  queueChanged(ids: string[]) {
    for (const id of ids) if (this.db.get('SELECT id FROM tasks WHERE id=?', id)) this.emitUpdated(id);
  }
  moveQueuedTask(id: string, position: number): Task {
    const task = this.get(id);
    if (task.status !== 'queued' || !task.queue) throw Errors.invalidState('任务已不在等待队列，请刷新后查看');
    if (task.queue.scope === 'project') this.projectQueue.move(id, position);
    else this.agentSvc!.moveQueuedTask(id, position);
    return this.get(id);
  }
  private async acquireProject(id: string, signal: AbortSignal): Promise<() => void> {
    const row = this.getRow(id);
    if (row.workspace_kind !== 'copy' && row.workspace_kind !== 'shadow') return () => {};
    const release = await this.projectQueue.acquire(row.project_id, id, () => {
      this.setStatus(id, 'queued');
      this.events.append({ type: 'session.notice', taskId: id, sessionId: null, data: { level: 'info', text: '等待同项目的任务结束' } });
    }, signal);
    if (signal.aborted) { release!(); throw new AbortError(); }
    this.setStatus(id, 'running'); return release!;
  }

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
    const items = rows.slice(0, q.limit).map((r) => this.get(r.id));
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
    if (needLogin) {
      if (a.usesNativeConfig) throw Errors.agentUnavailable(`${a.displayName} 还没有登录`, '请在该软件中完成配置或登录，再回到工作台重新检测', [{ label: '查看 Agent', action: 'open_agents', args: { kind } }]);
      throw Errors.agentUnavailable(`${a.displayName} 还没有登录`, '请先在 Agent 页登录', [{ label: '去登录', action: 'agents.login', args: { kind, ...(profile ? { profileId: profile.id } : {}) } }]);
    }
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

  /** 用户选择 A：自动档只开放给由工作台逐项审批的隔离任务。 */
  private checkTaskPermission(kind:AgentKind,level:PermissionLevel,isolated:boolean) {
    if(level==='readonly'||level==='ask')return;
    if(kind!=='fake'&&kind!=='independent')throw Errors.levelUnavailable('第三方 Agent 本步仅支持只读或需审批','原生自动模式可能绕过工作台规则，暂未开放');
    if(!isolated)throw Errors.levelUnavailable('直接在项目目录运行的旧任务不能使用自动权限档','请新建隔离工作副本任务');
  }
  private checkPermission(a: AgentAdapter, level: PermissionLevel,isolated:boolean) {
    this.checkTaskPermission(a.id,level,isolated);
    if (a.permissionLevels && !a.permissionLevels.includes(level)) {
      throw Errors.levelUnavailable(`${a.displayName} 暂时不能使用这个权限级别`, '请选择当前任务提供的权限级别');
    }
  }

  async create(body: z.infer<typeof CreateTaskBody>): Promise<Task> {
    if (!this.db.get('SELECT id FROM projects WHERE id = ?', body.projectId)) throw Errors.badRequest('找不到这个项目');
    if (body.groupId && !this.db.get('SELECT id FROM task_groups WHERE id = ?', body.groupId)) throw Errors.badRequest('找不到这个分组');
    if (body.agent === 'independent') {
      if (!this.independentRuntime || !body.independent) throw Errors.badRequest('请先填写独立 Agent 的模型、上下文与预算配置');
      if (body.profileId || body.model || body.effort) throw Errors.badRequest('独立 Agent 使用自己的任务配置，不接受第三方账号或模型字段');
      this.checkTaskPermission('independent',body.permission,!!this.workspaces);
      if (body.attachments?.length) throw Errors.badRequest('请先创建任务，再上传附件');
      const id = newId('t'), t = now();
      this.db.tx(() => {
        this.db.run(`INSERT INTO tasks (id,project_id,group_id,title,prompt,status,permission_level,agent,last_activity_at,created_at,updated_at)
          VALUES (?,?,?,?,?,'draft',?,'independent',?,?,?)`, id, body.projectId, body.groupId ?? null,
          body.title?.trim() || body.prompt.trim().split(/\r?\n/)[0]?.slice(0,40) || '新任务', body.prompt, body.permission, this.activityTs(), t, t);
        this.independentRuntime!.configure(id, body.independent!);
        this.events.append({ type: 'task.created', taskId: id, sessionId: null, data: { task: this.get(id) } });
      });
      if (!await this.prepareNewWorkspace(id, !!body.deferPrompt)) return this.get(id);
      if (!body.deferPrompt) { this.independentRuntime.assertReady(id); this.startTurn(id, body.prompt); }
      return this.get(id);
    }
    if (body.independent) throw Errors.badRequest('独立配置只能用于独立 Agent');
    const a = await this.adapterFor(body.agent, body.profileId);
    this.checkPermission(a, body.permission,!!this.workspaces);
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
    if (!await this.prepareNewWorkspace(id, !!body.deferPrompt)) return this.get(id);
    if (body.deferPrompt) this.setStatus(id, 'draft');
    else this.startTurn(id, body.prompt);
    return this.get(id);
  }

  async patch(id: string, body: z.infer<typeof PatchTaskBody>): Promise<Task> {
    const row = this.getRow(id);
    const isolated=!!this.workspaces?.get(id)&&['worktree','copy'].includes(row.workspace_kind??'');
    if(body.permission)this.checkTaskPermission(row.agent,body.permission,isolated);
    if (this.configuring.has(id)) throw Errors.invalidState('任务配置正在更新');
    if (body.groupId && !this.db.get('SELECT id FROM task_groups WHERE id = ?', body.groupId)) throw Errors.badRequest('找不到这个分组');
    const a = this.agents.get(row.agent);
    if (body.permission !== undefined && a) this.checkPermission(a, body.permission,isolated);
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
        ...(req.operation?{operation:{...req.operation,command:req.operation.command===null?null:redactExact(req.operation.command,secrets),paths:req.operation.paths.map(p=>redactExact(p,secrets)),complete:req.operation.complete&&!secrets.some(secret=>JSON.stringify(req.operation).includes(secret))}}:{}),
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
    const tools = this.activeTools.get(taskId);
    if (tools?.sessionId === sessionId) {
      if (u.kind === 'tool_start') tools.ids.add(u.toolId);
      else if (u.kind === 'tool_end') tools.ids.delete(u.toolId);
    }
    if (u.kind === 'activity') return;
    const base = { taskId, sessionId } as const;
    // 写进事件库前按密钥原文脱敏（工具输出里可能有 env / printenv 打出来的 API Key）；流式分片扣留可能是密钥开头的尾巴
    const streamKey = u.kind === 'message' ? `m:${u.messageId}` : u.kind === 'thought' ? `t:${u.messageId}` : u.kind === 'tool_output' ? `o:${u.toolId}` : null;
    if (red?.active) this.flushRedactor(taskId, sessionId, red, streamKey ?? undefined);
    const clean = (s: string) => (secrets.length ? redactExact(s, secrets) : s);
    const activity = this.turnActivity.get(taskId);
    if (activity && (u.kind === 'tool_start' || u.kind === 'tool_end' || u.kind === 'message' || u.kind === 'thought')) {
      const action = u.kind === 'tool_start' ? clean(u.title).slice(0, 500) : u.kind === 'tool_end' ? '正在继续处理' : u.kind === 'thought' ? '正在思考' : '正在回复';
      if (activity.action !== action) { activity.action = action; this.emitUpdated(taskId); }
    }
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
        ...(u.files ? { files: u.files.map((f) => ({ ...f, path: clean(f.path) })) } : {}),
      } }); break;
      case 'tool_output': {
        const text = piece(`o:${u.toolId}`, u.text);
        if (text) this.events.append({ ...base, type: 'tool.output', data: { toolId: u.toolId, text } });
        break;
      }
      case 'tool_end': {
        const end = this.events.append({ ...base, type: 'tool.end', data: { toolId: u.toolId, ok: u.ok, summary: u.summary === null ? null : clean(u.summary), ...(u.rejected ? { rejected: true } : {}) } });
        if (u.memoryCommand) this.memory.command(taskId,sessionId,end.seq,end.ts,u.memoryCommand);
        void this.scheduleChanges(taskId);
        break;
      }
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
    try { await rt.conn.close(); } catch {
      if (this.getRow(taskId).agent === 'independent') {
        rt.closing = false; this.independentRuntime?.requireReview(taskId);
        throw Errors.invalidState('独立会话未可靠收尾，请先核对中断记录');
      }
    }
    this.runtimes.delete(taskId);
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
    const permissionTask=this.get(taskId);
    this.checkTaskPermission(permissionTask.agent,permissionTask.permission,!!this.workspaces?.get(taskId)&&['worktree','copy'].includes(permissionTask.workspace?.kind??''));
    await this.runtimePath(taskId);
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

  async startHandoffRuntime(taskId: string, handoffId: string, target: HandoffTarget, signal?: AbortSignal) {
    const handoff = this.db.get<{from_session_id: string | null}>(
      'SELECT from_session_id FROM handoffs WHERE id=? AND task_id=? AND to_session_id IS NULL', handoffId, taskId);
    if (!handoff || !this.history) throw Errors.invalidState('交接记录不可用');
    const task = this.get(taskId);
    this.checkTaskPermission(target.agent, task.permission, !!this.workspaces?.get(taskId) && ['worktree','copy'].includes(task.workspace?.kind ?? ''));
    return this.startRuntime(taskId, signal, { noQueue: true, handoff: { id: handoffId, parent: handoff.from_session_id, target } });
  }

  private async startRuntime(taskId: string, signal?: AbortSignal, opts: {
    strictResume?: boolean; noQueue?: boolean; handoff?: {id: string; parent: string | null; target: HandoffTarget};
  } = {}): Promise<Runtime> {
    const task = this.getRow(taskId);
    const next = opts.handoff?.target;
    const row = next ? { ...task, agent: next.agent, profile_id: null, model: next.model ?? null, effort: next.effort ?? null } : task;
    if (row.agent === 'independent') {
      if (!this.independentRuntime) throw Errors.invalidState('独立 Agent 尚未装配');
      const project = this.db.get<{ path: string }>('SELECT path FROM projects WHERE id=?', row.project_id);
      if (!project) throw Errors.notFound('找不到任务的项目');
      const previous = this.db.get<{ id: string }>('SELECT id FROM sessions WHERE task_id=? AND agent_id=? ORDER BY started_at DESC LIMIT 1', taskId, row.agent);
      const sessionId = previous?.id ?? newId('s');
      if (!previous) this.db.run("INSERT INTO sessions(id,task_id,agent_id,model,agent_session_id,status,started_at) VALUES (?,?,'independent',?,?,'active',?)", sessionId, taskId, row.model, sessionId, now());
      const conn = await this.independentRuntime.open(taskId, sessionId, await this.runtimePath(taskId), row.permission_level, this.host(taskId, sessionId), row.workspace_kind === 'worktree' || row.workspace_kind === 'copy');
      if (signal?.aborted) { await conn.close(); throw new AbortError(); }
      this.db.run("UPDATE sessions SET status='active',ended_at=NULL,model=? WHERE id=?", row.model, sessionId);
      this.events.append({ type: 'session.started', taskId, sessionId, data: { agent: row.agent, model: row.model, resumed: !!previous } });
      const rt: Runtime = { sessionId, conn, profileId: null, release: () => {}, lastActive: now(), closing: false, secrets: [], redactor: new StreamRedactor([]) };
      this.runtimes.set(taskId, rt); return rt;
    }
    const a = await this.adapterFor(row.agent, row.profile_id);
    const project = this.db.get<{ path: string }>('SELECT path FROM projects WHERE id = ?', row.project_id);
    const svc = a.real ? this.agentSvc : null;
    const profile = svc ? svc.profiles.resolve(row.agent, row.profile_id) : null;
    const spawnEnv = svc && profile ? await svc.profiles.envFor(a, profile) : null;
    const secrets = [...(spawnEnv?.redact ?? [])];
    this.secretsOf.set(taskId, secrets);
    // 前面的 await 期间用户可能已经点了 [停止]：不要再去排队
    if (signal?.aborted) throw new AbortError();
    // 并发上限：超出时任务进入“排队中”，有进程空出来就按顺序启动。不是回合的启动（换账号）不排队
    let release: () => void = () => {};
    if (svc) {
      const r = await svc.acquire(row.agent, () => this.setStatus(taskId, 'queued'), signal, { wait: !opts.noQueue, taskId });
      if (!r) throw new SlotBusyError();
      release = r;
    }
    const sessionId = newId('s');
    let opening: AgentConnection | undefined;
    try {
      if (signal?.aborted) throw new AbortError();
      if (this.getRow(taskId).status === 'queued' && this.turnAborts.has(taskId)) this.setStatus(taskId, 'running');
      // 上一个会话：同一个任务、同一个 Agent，有 agent_session_id → 恢复（H1）。不限定账号：换账号后也先试着恢复，
      // 恢复不了时适配器会新建会话并提示“Agent 不记得之前的对话”，不会悄悄丢掉上下文
      const prev = opts.handoff ? undefined : this.db.get<{ id: string; agent_session_id: string; profile_id: string | null; caps_json: string | null }>(
        `SELECT id, agent_session_id, profile_id, caps_json FROM sessions WHERE task_id = ? AND agent_id = ? AND agent_session_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`,
        taskId, row.agent,
      );
      if (a.usesNativeConfig && prev?.profile_id && prev.profile_id !== profile?.id) {
        throw Errors.nativeConfiguration('这个旧任务曾使用工作台替换的认证，已停止继续调用', '请保留历史并用该软件自身配置新建任务；不会自动改用其他账号计费');
      }
      const resume = a.real && prev ? { agentSessionId: prev.agent_session_id } : undefined;
      // H1：上次的会话不能在会话里换模型时，启动时就指定模型
      const launchModel = !!(a.real && a.launchModel && row.model && this.modelSwitchOf(prev?.caps_json ?? null, row.agent, profile?.id ?? null) === 'none');
      const history = opts.handoff && this.history?.serverFor({ taskId, sessionId, handoffId: opts.handoff.id });
      if (history) secrets.push(...history.env.filter(entry => entry.name === 'AIC_HISTORY_TOKEN').map(entry => entry.value));
      const redactor = new StreamRedactor(secrets);
      const conn = await a.spawn({
        cwd: await this.runtimePath(taskId), model: row.model, effort: row.effort, permission: row.permission_level,
        host: this.host(taskId, sessionId, secrets, redactor), sessionLabel: sessionId,
        ...(spawnEnv ? { env: spawnEnv.env, profile: spawnEnv.account } : {}),
        ...(secrets.length ? { redact: secrets } : {}), ...(history ? { mcpServers: [history] } : {}),
        ...(resume ? { resume } : {}), ...(signal ? { signal } : {}), ...(launchModel ? { launchModel: true } : {}),
      });
      opening = conn;
      if (opts.strictResume && resume && !conn.resumed) {
        throw Errors.notRecoverable('换账号后原来的会话找不到了', '同一个 Agent 换账号需要交接，会在之后的版本提供；现在可以换回原来的账号');
      }
      if (signal?.aborted) throw new AbortError();
      const caps = await a.probeCapabilities(conn);
      // Agent 实际用的模型和任务记录不一致（例如没能下发保存的模型）：以 Agent 为准写回，界面不再显示一个没生效的模型
      const actual = a.real ? conn.config?.() ?? null : null;
      if (!opts.handoff && actual && row.model !== null && actual.model !== row.model) {
        this.db.run('UPDATE tasks SET model = ?, updated_at = ? WHERE id = ?', actual.model, now(), taskId);
      }
      this.db.run(
        "INSERT INTO sessions (id, task_id, agent_id, profile_id, model, agent_session_id, parent_session_id, handoff_id, caps_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
        sessionId, taskId, row.agent, profile?.id ?? null, actual?.model ?? row.model, conn.agentSessionId, opts.handoff?.parent ?? prev?.id ?? null, opts.handoff?.id ?? null, JSON.stringify(caps), now(),
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
      if (opts.handoff) this.history?.revoke(sessionId);
      await opening?.close().catch(() => {});
      release();
      throw e;
    }
  }

  private isBusy(taskId: string) {
    return this.turnAborts.has(taskId) || this.configuring.has(taskId);
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
    this.turnActivity.set(taskId, { startedAt: now(), action: '正在准备运行' });
    this.setStatus(taskId, 'running');
    const turn = this.runTurn(taskId, messageId, text, abort, inputs);
    this.turns.add(turn);
    void turn.finally(() => this.turns.delete(turn));
    return messageId;
  }

  /** 错误事件：动作按钮带上 taskId，界面可以直接执行 */
  private emitError(taskId: string, sessionId: string | null, body: ApiError) {
    const agent = this.getRow(taskId).agent;
    const nativeAuth = this.agents.get(agent)?.usesNativeConfig && body.code === ErrorCode.AgentAuthRequired;
    const error: ApiError = nativeAuth
      ? { ...body, hint: '请在该 Agent 软件中完成配置或登录，然后回到工作台重新检测', actions: [{ label: '查看 Agent', action: 'open_agents', args: { kind: agent, taskId } }] }
      : { ...body, actions: body.actions.map((x) => ({ ...x, args: { taskId, ...(x.args ?? {}) } })) };
    this.events.append({ type: 'error', taskId, sessionId, data: { error } });
  }

  private async runTurn(taskId: string, messageId: string, text: string, abort: AbortController, attachments: PromptAttachment[]) {
    let rt: Runtime | undefined;
    const source = this.getRow(taskId).agent === 'independent' ? 'independent' : 'agent';
    let usage = emptyUsage(source);
    let watchdog: NodeJS.Timeout | undefined;
    let noResponse = false;
    let releaseProject: (() => void) | undefined;
    let releaseDemo: (() => void) | undefined;
    let snapshotStarted = false;
    let snapshotFailed = false;
    const finishSnapshot = async () => {
      if (watchdog) clearInterval(watchdog);
      if (!snapshotStarted || !this.workspaces) return;
      snapshotStarted = false;
      try { await this.workspaces.snapshot(taskId, '回合结束后'); this.syncWorkspace(taskId); }
      catch { snapshotFailed = true; throw Errors.internal('回合结束后的快照失败，请检查工作副本；本轮改动尚未完整记录。'); }
    };
    this.approvalTimedOut.delete(taskId);
    try {
      releaseProject = await this.acquireProject(taskId, abort.signal);
      if (this.getRow(taskId).agent === 'fake' && this.agentSvc) {
        releaseDemo = (await this.agentSvc.acquire('fake', () => this.setStatus(taskId, 'queued'), abort.signal, { taskId }))!;
        if (abort.signal.aborted) throw new AbortError();
        this.setStatus(taskId, 'running');
      }
      this.turnActivity.set(taskId, { startedAt: now(), action: '正在准备运行' });
      if (this.getRow(taskId).workspace_kind === 'copy' && this.workspaces) {
        await this.workspaces.snapshot(taskId, '回合开始前'); this.syncWorkspace(taskId); snapshotStarted = true; void this.refreshChanges(taskId);
      }
      rt = await this.ensureRuntime(taskId, abort.signal);
      const inline = await this.workspaces?.artifactConflicts(taskId,'.aic/TASK.md');
      const promptText = inline ? (await this.taskSummaryText(taskId))+'\n## 本轮用户消息\n\n'+text : text;
      if (abort.signal.aborted) throw new AbortError();
      this.turnActivity.set(taskId, { startedAt: now(), action: '正在处理任务' }); this.emitUpdated(taskId);
      rt.lastActive = now();
      this.activity.set(taskId, now());
      let lastNotice = -Infinity;
      this.activeTools.set(taskId, { sessionId: rt.sessionId, ids: new Set() });
      const noticeId = newId('idle');
      const timeout = new Promise<never>((_, reject) => {
        watchdog = setInterval(() => {
          // 等待审批不计时。工具执行中不提醒、改用更长的上限：静默构建不算断联，
          // 但工具结束事件永远不来（Agent 卡死）时仍要能停下，不能无限等（ISSUE-0074）。
          if ([...this.pending.values()].some((p) => p.approval.taskId === taskId)) { this.activity.set(taskId, now()); return; }
          const toolsOpen = !!this.activeTools.get(taskId)?.ids.size;
          const limit = toolsOpen ? this.noResponseToolCancelMs : this.noResponseCancelMs;
          const idle = now() - (this.activity.get(taskId) ?? now());
          if (idle >= limit) {
            noResponse = true;
            const minutes = Math.max(1, Math.round(limit / 60_000));
            reject(new AppError(504, { code: ErrorCode.AgentNoResponse, message: toolsOpen ? `工具执行 ${minutes} 分钟没有任何回应，这一轮已停止` : `Agent ${minutes} 分钟没有回应，这一轮已停止`, hint: '可以重新发送，或换个模型 / 账号', actions: [{ label: '重试', action: 'task.retry' }, { label: '换模型', action: 'task.switch_model' }] }));
            abort.abort();
          } else if (!toolsOpen && idle >= this.noResponseNoticeMs && now() - lastNotice >= 120_000) {
            lastNotice = now();
            this.events.append({ type: 'session.notice', taskId, sessionId: rt!.sessionId, data: { id: noticeId, level: 'warn', text: 'Agent 已经 ' + Math.max(1, Math.floor(idle / 60_000)) + ' 分钟没有回应，可能在重试或网络不稳定。可以继续等，也可以停止这一轮。' } });
          }
        }, Math.min(1000, this.noResponseNoticeMs, this.noResponseCancelMs));
        watchdog.unref?.();
      });
      const prompt = rt.conn.prompt({ text: promptText, attachments }, abort.signal);
      let r: Awaited<typeof prompt>;
      try { r = await Promise.race([prompt, timeout]); }
      catch (error) {
        if (this.getRow(taskId).agent === 'independent') await prompt.catch(() => {});
        throw error;
      }
      rt.lastActive = now();
      if (rt.redactor.active) this.flushRedactor(taskId, rt.sessionId, rt.redactor);
      if (r.usage && !abort.signal.aborted && r.stopReason !== 'cancelled' && r.stopReason !== 'error') usage = { ...r.usage, source };
      // 审批超时：不放行，本轮结束后任务暂停（不进入待验收）
      const timedOut = this.approvalTimedOut.has(taskId);
      if (timedOut && r.stopReason !== 'error') {
        this.events.append({ type: 'session.notice', taskId, sessionId: rt.sessionId, data: { level: 'warn', text: '有审批超时没有处理，没有放行；任务已暂停，可以继续发消息' } });
      }
      await finishSnapshot();
      await this.refreshChanges(taskId);
      this.setStatus(taskId, r.stopReason === 'cancelled' || timedOut ? 'paused' : r.stopReason === 'error' ? 'failed' : 'review');
    } catch (e) {
      try { await finishSnapshot(); } catch (error) { e = error; }
      // 尚在项目队列时取消，没有 Agent 进入副本，也没有本轮改动需要等待。
      if (releaseProject || !abort.signal.aborted) await this.refreshChanges(taskId);
      if (rt?.redactor.active) this.flushRedactor(taskId, rt.sessionId, rt.redactor);
      // 用户点了 [停止]：不管启动阶段抛的是什么（取消、或进程被结束导致的错误），都按暂停处理
      if (snapshotFailed) {
        this.emitError(taskId, rt?.sessionId ?? null, (e as AppError).body);
        this.setStatus(taskId, 'failed');
      } else if (noResponse) {
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
        console.error('[tasks] 任务执行出错', errorLogText(e, rt?.secrets ?? this.secretsOf.get(taskId) ?? []));
        const msg = e instanceof Error ? e.message : String(e);
        this.emitError(taskId, rt?.sessionId ?? null, { code: ErrorCode.AgentFailed, message: `Agent 执行出错：${redactText(msg, rt?.secrets ?? this.secretsOf.get(taskId) ?? [])}`, hint: '可以重新发送消息再试一次', actions: [] });
        this.setStatus(taskId, 'failed');
      }
    } finally {
      this.scheduleSummary(taskId);
      if (watchdog) clearInterval(watchdog);
      releaseDemo?.(); releaseProject?.();
      this.turnActivity.delete(taskId);
      recordTurnUsage(this.db, this.events, taskId, rt?.sessionId ?? null, messageId, usage);
      this.activity.delete(taskId);
      this.activeTools.delete(taskId);
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
    if (FINAL.includes(this.get(taskId).status)) throw Errors.invalidState('任务已经结束，不能继续发送消息');
    if(this.workspaces?.operation(taskId)?.state==='pending')throw Errors.invalidState('上次项目操作尚未确认完成，暂不能继续任务。');
    if (this.db.get('SELECT task_id FROM workspace_preparations WHERE task_id=?', taskId)) throw Errors.invalidState('工作副本尚未准备好，请先处理准备提示');
    if (this.isBusy(taskId)) throw Errors.invalidState('任务正在执行', '请等这一轮结束，或先点 [停止]', [{ label: '停止', action: 'task.cancel', args: { taskId } }]);
    if (row.agent === 'independent') this.independentRuntime?.assertReady(taskId);
    const a = this.attachments?.resolve(taskId, attachmentIds) ?? { infos: [], inputs: [] };
    const agent = this.agents.get(row.agent);
    const info = row.agent === 'independent' ? this.independentRuntime?.info() : agent ? this.agentSvc?.info(agent) : undefined;
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

  /** 独立任务的配置 / 恢复操作在整个异步收尾期间占住任务，防止并发发送。 */
  async updateIndependent(taskId: string, action: 'configure' | 'recover' | 'checkpoint', input: IndependentTaskOptions | { expectedRevision: number } | { throughSeq: number; summary: string; expectedTailHash: string }, expectedRevision?: number) {
    const row = this.getRow(taskId);
    if (row.agent !== 'independent' || !this.independentRuntime) throw Errors.badRequest('这个任务不是独立 Agent 任务');
    if (FINAL.includes(row.status) || this.isBusy(taskId)) throw Errors.invalidState('请在任务空闲且未结束时操作');
    this.configuring.add(taskId);
    try {
      await this.dropRuntime(taskId, 'independent_config');
      if (action === 'configure') this.independentRuntime.configure(taskId, input as IndependentTaskOptions, expectedRevision);
      else if (action === 'recover') await this.independentRuntime.acknowledge(taskId, (input as { expectedRevision: number }).expectedRevision);
      else this.independentRuntime.checkpoint(taskId, input as { throughSeq: number; summary: string; expectedTailHash: string });
      this.emitUpdated(taskId);
      // 输入框从会话事件推导当前模型；明确应用后立即覆盖旧 session.started。
      if (action === 'configure') this.emitConfig(taskId, null, null);
      return this.independentRuntime.state(taskId);
    } finally { this.configuring.delete(taskId); }
  }

  /**
   * 切换（design.md 7.4）：同 Agent 换模型、思考强度（H0：会话内切换；不支持时 H1：结束进程 → 带新参数重启 → 恢复）；
   * 同 Agent 换账号（结束进程 → 用新账号重启 → 恢复）；跨 Agent 在 1.4 提供。
   */
  async switch(taskId: string, opts: { agent?: AgentKind | undefined; model?: string | undefined; effort?: string | undefined; profileId?: string | undefined }): Promise<Task> {
    const row = this.getRow(taskId);
    if (row.agent === 'independent') throw Errors.badRequest('请在独立任务配置中明确应用服务、模型与预算');
    if (opts.agent && opts.agent !== row.agent) {
      throw Errors.agentUnavailable('暂时不能切换到其他 Agent', '跨 Agent 交接会在之后的版本提供；现在可以换模型或思考强度');
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
        if (!caps.resume && !caps.loadSession) throw Errors.agentUnavailable(`${a.displayName} 不支持在会话里换模型，也不能恢复会话`, '换模型需要交接，会在之后的版本提供');
        if (!a.launchModel) throw Errors.agentUnavailable(`${a.displayName} 不支持在会话里换模型，也不能在启动时指定模型`, '换模型需要交接，会在之后的版本提供');
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
        // 模型仍是旧值且上游明确拒绝时才记失败；模型已生效后的强度错误不污染模型列表。
        const after = live.conn.config?.();
        if (e instanceof AgentError && e.reason === 'invalid_value' && opts.model !== undefined
          && opts.model !== st?.model && after && after.model !== opts.model) {
          this.db.run('INSERT INTO model_failures (agent,profile_id,model,reason,at) VALUES (?,?,?,?,?) ON CONFLICT(agent,profile_id,model) DO UPDATE SET reason=excluded.reason,at=excluded.at', cur.agent, live.profileId ?? cur.profile_id ?? '', opts.model, e.body.message, now());
          this.agentSvc?.pushStatus(cur.agent);
        }
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
        '换到这个账号需要交接，会在之后的版本提供；现在可以新建一个任务并选这个账号',
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

  private async permissionContext(taskId:string):Promise<PermissionContext> {
    const row=this.getRow(taskId),project=this.db.get<{path:string}>('SELECT path FROM projects WHERE id=?',row.project_id)!;
    return {projectId:row.project_id,root:await this.runtimePath(taskId),original:project.path,level:row.permission_level,isolated:row.workspace_kind==='worktree'||row.workspace_kind==='copy'};
  }
  private async onPermission(taskId: string, sessionId: string, req: PermissionRequest, signal: AbortSignal): Promise<PermissionOutcome> {
    this.activity.set(taskId, now());
    const row = this.getRow(taskId);
    const pick = (kinds: string[]) => req.options.find((o) => kinds.includes(o.kind));
    const operation=req.operation??{tool:'any' as const,command:null,paths:[],complete:false,deletion:false};
    const context=await this.permissionContext(taskId);
    this.checkTaskPermission(row.agent,row.permission_level,context.isolated);
    const decision=await this.permissions.decide(operation,context);
    if(signal.aborted)throw new AbortError();
    if(decision.action==='deny') {
      this.events.append({type:'session.notice',taskId,sessionId,data:{level:'warn',text:'已拒绝操作：'+decision.reason}});
      const o = pick(['reject_once', 'reject_always']);
      return o ? { outcome: 'selected', optionId: o.id, note: decision.reason } : { outcome: 'cancelled' };
    }
    if(decision.action==='allow') {
      const o=pick(['allow_once']);
      if(o){
        // 普通读取不在对话里逐条提示，避免刷屏；按项目规则或自动档放行的修改和命令仍留一行记录（ISSUE-0103）。
        if(decision.ruleId||operation.tool!=='read')this.events.append({type:'session.notice',taskId,sessionId,data:{level:'info',text:(decision.ruleId?'已按规则自动允许：':'已自动允许：')+decision.reason}});
        return {outcome:'selected',optionId:o.id};}
    }
    const preview=pick(['allow_once'])?await this.permissions.preview(operation,context):null;
    if(signal.aborted)throw new AbortError();
    const options=req.options.filter(o=>o.kind!=='allow_always');
    if(preview)options.push({id:newId('opt'),kind:'allow_always',label:'总是允许…'});

    const t = now();
    const approval: Approval = {
      id: newId('a'), taskId, sessionId, title: req.title, reason: req.reason, detail: req.detail, cwd: req.cwd,
      options, canAlwaysAllow:!!preview, status: 'pending', decidedBy: null, createdAt: t, expiresAt: t + this.approvalTimeoutMs,
      ...(row.agent === 'independent'&&operation.tool!=='read' ? { independentToolId: req.toolId } : {}),
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
      this.pending.set(approval.id, { approval, operation, resolve, reject, timer, cleanup });
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
  async permissionRulePreview(approvalId:string) {
    const p=this.pending.get(approvalId);if(!p?.operation)throw Errors.invalidState('这条审批无法生成规则');
    const preview=await this.permissions.preview(p.operation,await this.permissionContext(p.approval.taskId));
    if(!preview||this.pending.get(approvalId)!==p)throw Errors.invalidState('审批已变化或不能安全生成规则');return preview;
  }
  async approve(approvalId: string, optionId: string, note: string | undefined, deviceId: string, alwaysAllow?:AlwaysAllowConfirmation): Promise<Approval> {
    const p = this.pending.get(approvalId);
    if (!p) {
      const exists = this.db.get('SELECT id FROM approvals WHERE id = ?', approvalId);
      if (!exists) throw Errors.notFound('找不到这条审批');
      throw Errors.invalidState('这条审批已经处理过了');
    }
    const opt = p.approval.options.find((o) => o.id === optionId);
    if (!opt) throw Errors.badRequest('没有这个选项');
    let responseId=optionId;
    let confirmedRule:PermissionRulePreview|undefined;
    if(opt.kind.startsWith('allow')) {
      if(!p.operation)throw Errors.invalidState('审批操作已失效');
      const context=await this.permissionContext(p.approval.taskId),decision=await this.permissions.decide(p.operation,context);
      if(decision.action==='deny')throw Errors.invalidState('当前规则已禁止此操作：'+decision.reason);
      if(opt.kind==='allow_always') {
        if(!alwaysAllow)throw Errors.badRequest('请先预览并确认规则');
        const preview=await this.permissionRulePreview(approvalId);
        if(preview.revision!==alwaysAllow.revision)throw Errors.conflict('权限规则已变化，请重新预览');
        const once=p.approval.options.find(o=>o.kind==='allow_once');if(!once)throw Errors.invalidState('Agent 不支持允许一次，不能写入它的原生规则');
        if(this.pending.get(approvalId)!==p)throw Errors.invalidState('这条审批已经处理过了');
        confirmedRule=preview;responseId=once.id;
      } else if(alwaysAllow)throw Errors.badRequest('此选项不接受规则确认');
    }
    if(this.pending.get(approvalId)!==p)throw Errors.invalidState('这条审批已经处理过了');
    const status = opt.kind.startsWith('allow') ? 'allowed' : 'rejected';
    // 拒绝理由（note）ACP 不支持回传，只存在审批记录里
    const a=this.db.tx(()=>{
      if(confirmedRule)this.permissions.addAlways(this.getRow(p.approval.taskId).project_id,confirmedRule);
      const result=this.finishApproval(approvalId,status,deviceId,optionId)!;
      if(note)this.db.run('UPDATE approvals SET request_json = ? WHERE id = ?',JSON.stringify({...result,note}),approvalId);
      return result;
    });
    p.cleanup();
    // 还有别的审批没处理（并行的工具调用）→ 仍是“等待审批”，否则回到运行中；再把结果交还 Agent
    this.recomputeStatus(p.approval.taskId);
    // 工作台规则独立保存，永不转发 Agent 的 allow_always。
    p.resolve({ outcome: 'selected', optionId:responseId, ...(note ? { note } : {}) });
    return a;
  }

  /** 关闭：中断所有执行中的任务，关闭全部 Agent 会话 */
  async shutdown() {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
    for (const abort of this.turnAborts.values()) abort.abort();
    await Promise.allSettled([...this.turns]);
    for (const pending of this.changeTimers.values()) { clearTimeout(pending.timer); pending.resolve(); }
    this.changeTimers.clear();
    await Promise.allSettled([...this.changeJobs]);
    await Promise.allSettled([...this.summaryJobs.values()]);
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
  async idle() { await Promise.allSettled([...this.turns]); await Promise.allSettled([...this.summaryJobs.values()]); }
}
