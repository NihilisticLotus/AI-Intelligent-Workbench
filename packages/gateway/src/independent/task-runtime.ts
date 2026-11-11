// 正式任务宿主：配置、记账、上下文、工具与审批均由 Gateway 持有，不借用第三方 Agent 认证。
import {
  IndependentTaskOptions, IndependentTaskState, IndependentApprovalDetail, IndependentHistoryPage,
  IndependentCommandSpec,
  type AgentInfo, type IndependentTaskReference, type PermissionLevel, type IndependentToolCall, type IndependentCapabilityField,
} from '@aic/protocol';
import { redact } from '@aic/adapters';
import type { Db } from '../db';
import type { EventStore } from '../events';
import type { AttachmentService } from '../attachments';
import type { ProcessRegistry } from '../processes';
import type { AgentConnection, SessionHost } from '../agents/registry';
import { Errors, newId, now } from '../util';
import { IndependentCatalog } from './catalog';
import { IndependentConversationStore } from './conversation';
import { IndependentRequestLedger } from './request-ledger';
import { IndependentToolJournal } from './tool-journal';
import { IndependentCommandExecutor } from './commands';
import { IndependentCommandTool } from './command-tool';
import { IndependentFileHost } from './file-host';
import { IndependentFiles } from './files';
import { IndependentFileReceipts } from './file-receipts';
import { IndependentFileTool } from './file-tool';
import { IndependentFileDriver } from './file-driver';
import { IndependentAttachments } from './attachments';
import { IndependentApiDriver } from './model-driver';
import { IndependentTurnEngine, type IndependentApprovalClock } from './turn-engine';
import { independentModelTools } from './tool-definitions';
import { usableCapability } from './capabilities';
const STOP_TEXT = {
  completed: '本回合已完成，等待你验收。', cancelled: '本回合已停止，实际工具与连接已收尾。',
  interrupted: '本回合已中断，请核对记录后继续。', timed_out: '已达到回合时间上限。',
  model_limit: '已达到模型调用上限。', tool_limit: '已达到工具调用上限。', output_limit: '已达到输出上限。',
  context_limit: '输入预检未通过，请查看上下文状态，调整配置或创建人工总结。',
  usage_unknown: '上游未返回完整用量，停止后续调用。', configuration_changed: '配置已变化，请重新核对并应用配置。',
  model_error: '模型请求未能可靠完成；不会自动重试，请查看请求记录。',
  tool_error: '工具结果不确定，请核对文件或进程的实际副作用；不会自动重放。',
  request_budget: '请求次数或人工金额预留额度已用尽。',
};

export class IndependentTaskRuntime {
  readonly store: IndependentConversationStore;
  readonly ledger: IndependentRequestLedger;
  readonly journal: IndependentToolJournal;
  private details = new Map<string, IndependentApprovalDetail>();
  constructor(private db: Db, private catalog: IndependentCatalog, private events: EventStore,
    private attachments: AttachmentService, private dataDir: string, private processes: ProcessRegistry,
    private orphanCleanup: Promise<unknown>) {
    this.store = new IndependentConversationStore(db); this.ledger = new IndependentRequestLedger(db);
    this.journal = new IndependentToolJournal(db);
  }
  private row(taskId: string) {
    const row = this.db.get('SELECT * FROM independent_task_settings WHERE task_id=?', taskId);
    if (!row) throw Errors.invalidState('任务尚未保存独立 Agent 配置');
    return row;
  }
  private changed(taskId: string) {
    this.events.append({ type: 'independent.task_changed', taskId, sessionId: null, data: { revision: Number(this.row(taskId).revision) } });
  }
  reference(taskId: string): IndependentTaskReference {
    const row = this.row(taskId), options = IndependentTaskOptions.parse(JSON.parse(String(row.options_json)));
    return { ...options.selection, revision: Number(row.revision) };
  }
  info(): AgentInfo {
    const models = this.catalog.listServices().filter((s) => s.enabled).flatMap((s) => this.catalog.listModels(s.id)
      .filter((m) => m.enabled).map((m) => {
        const capability = (field: IndependentCapabilityField) => usableCapability(m, field);
        const context = capability('contextWindow'), vision = capability('imageInput');
        return { id: m.id, name: `${s.name} / ${m.name}`, contextWindow: typeof context === 'number' ? context : null,
          vision: typeof vision === 'boolean' ? vision : null };
      }));
    return { kind: 'independent', displayName: 'AI Console 独立 Agent', status: models.length ? 'ready' : 'disabled',
      version: '0.1.0', verified: false, models, efforts: null, message: models.length ? '使用工作台自有 API 与模型配置' : '请先在 Agent 管理中添加 API 和模型',
      usesNativeConfig: false, permissionLevels: ['readonly', 'ask'], workspaceConfig: 'ignored' };
  }
  configure(taskId: string, input: IndependentTaskOptions, expectedRevision?: number) {
    const options = IndependentTaskOptions.parse(input);
    return this.db.tx(() => {
      const old = this.db.get('SELECT * FROM independent_task_settings WHERE task_id=?', taskId);
      if (old && Number(old.revision) !== expectedRevision) throw Errors.conflict('任务配置已变化，请重新载入');
      if (!old && expectedRevision !== undefined) throw Errors.conflict('任务配置尚未创建');
      if (old?.recovery_required) throw Errors.invalidState('请先核对中断记录');
      if (!old) options.fileToolVersion ??= 'separate_v2';
      else {
        const previous = IndependentTaskOptions.parse(JSON.parse(String(old.options_json)));
        if (options.fileToolVersion === undefined && previous.fileToolVersion !== undefined) options.fileToolVersion = previous.fileToolVersion;
        if ((previous.fileToolVersion ?? 'combined_v1') !== (options.fileToolVersion ?? 'combined_v1')
          && (this.db.get('SELECT id FROM independent_turns WHERE task_id=? LIMIT 1', taskId)
            || this.ledger.snapshot(taskId).attemptedRequests > 0)) throw Errors.conflict('任务已使用原文件工具，请新建任务使用另一版本；现有上下文与预算保持不变');
      }
      const model = this.catalog.getModel(options.selection.serviceId, options.selection.modelId);
      const service = this.catalog.getService(options.selection.serviceId);
      const cap = (field: IndependentCapabilityField) => usableCapability(model, field);
      if (options.limits.maxToolCalls > 0 && cap('tools') !== true) throw Errors.badRequest('模型工具能力未知或不支持，请核对能力，或将工具次数设为 0');
      if (options.generation.effort && (cap('thinking') !== true || !Array.isArray(cap('effortLevels'))
        || !(cap('effortLevels') as string[]).includes(options.generation.effort))) throw Errors.badRequest('思考强度缺少适用能力证据');
      if (options.context.mode === 'endpoint' && service.protocol === 'chat_completions') throw Errors.badRequest('Chat 协议没有已接入的计数接口，请选本地预检');
      if (options.generation.stream === true && cap('streaming') === false) throw Errors.badRequest('所选模型不支持流式响应');
      if (options.generation.chatTokenLimitField && service.protocol !== 'chat_completions') throw Errors.badRequest('这个协议不能设置 Chat 输出参数');
      const thinking = options.generation.thinking;
      if (thinking) {
        if (service.protocol !== 'anthropic_messages') throw Errors.badRequest('当前只有 Messages 协议接入了独立思考开关');
        if (thinking.mode === 'disabled' ? cap('thinkingCanDisable') !== true : cap('thinking') !== true) throw Errors.badRequest('缺少适用的思考开关能力证据');
        const min = cap('thinkingBudgetMin'), max = cap('thinkingBudgetMax'), output = cap('outputLimit');
        if (thinking.mode === 'enabled' && (thinking.budgetTokens === undefined || thinking.budgetTokens >= Math.min(options.limits.maxOutputTokens, typeof output === 'number' ? output : Infinity))
          || thinking.mode !== 'enabled' && thinking.budgetTokens !== undefined
          || thinking.budgetTokens !== undefined && (typeof min === 'number' && thinking.budgetTokens < min || typeof max === 'number' && thinking.budgetTokens > max)) throw Errors.badRequest('思考预算须在已知范围内，开启时必须小于输出预留');
      }
      if (old) {
        const previous = this.ledger.snapshot(taskId);
        const binding = this.catalog.rebind(taskId, options.selection, previous.binding);
        this.ledger.adjust(binding, options.requestBudget, previous.revision!);
        this.db.run('UPDATE independent_task_settings SET options_json=?,revision=revision+1,context_json=NULL,updated_at=? WHERE task_id=?', JSON.stringify(options), now(), taskId);
      } else {
        this.ledger.create(this.catalog.bind(taskId, options.selection), options.requestBudget);
        this.db.run('INSERT INTO independent_task_settings(task_id,revision,options_json,updated_at) VALUES (?,1,?,?)', taskId, JSON.stringify(options), now());
      }
      this.db.run('UPDATE tasks SET model=?,effort=?,updated_at=? WHERE id=?', options.selection.modelId, options.generation.effort ?? null, now(), taskId);
      this.changed(taskId); return this.state(taskId);
    });
  }
  state(taskId: string): IndependentTaskState {
    const row = this.row(taskId), budget = this.ledger.snapshot(taskId);
    const last = this.db.get('SELECT id FROM independent_turns WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', taskId);
    const checkpoint = this.db.get(`SELECT c.* FROM independent_checkpoints c JOIN sessions s ON c.session_id=s.id
      WHERE s.task_id=? ORDER BY c.created_at DESC,c.rowid DESC LIMIT 1`, taskId);
    return IndependentTaskState.parse({ revision: row.revision, options: JSON.parse(String(row.options_json)), binding: budget.binding, budget,
      recoveryRequired: !!row.recovery_required, lastTurn: last ? this.store.get(String(last.id)) : null,
      context: row.context_json === null ? null : JSON.parse(String(row.context_json)), requests: this.ledger.entries(taskId),
      checkpoint: checkpoint ? { id: checkpoint.id, sessionId: checkpoint.session_id, throughSeq: checkpoint.through_seq, sourceHash: checkpoint.source_hash, summary: checkpoint.summary, createdAt: checkpoint.created_at } : null,
      tools: this.db.all('SELECT id FROM independent_tool_calls WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200', taskId).map((r) => this.journal.get(String(r.id))) });
  }
  assertReady(taskId: string) {
    if (this.row(taskId).recovery_required) throw Errors.invalidState('上次执行已中断，请先核对请求、工具与实际文件后确认继续');
    this.catalog.bound(taskId);
    if (this.ledger.snapshot(taskId).remainingRequests < 1) throw Errors.invalidState('请求预算已用尽，请先应用新的预算上限');
  }
  requireReview(taskId: string) {
    this.db.run('UPDATE independent_task_settings SET recovery_required=1 WHERE task_id=?', taskId); this.changed(taskId);
  }
  recoverOnStartup() {
    this.db.run(`UPDATE independent_task_settings SET recovery_required=1 WHERE task_id IN (
      SELECT task_id FROM independent_turns WHERE status='running'
      UNION SELECT task_id FROM independent_tool_calls WHERE state IN ('pending','approved','running')
      UNION SELECT task_id FROM independent_request_attempts WHERE state='reserved')`);
  }
  async acknowledge(taskId: string, revision: number) {
    await this.orphanCleanup;
    return this.db.tx(() => {
      const row = this.row(taskId);
      if (Number(row.revision) !== revision) throw Errors.conflict('任务配置已变化，请重新核对');
      for (const session of this.db.all('SELECT id FROM sessions WHERE task_id=?', taskId)) {
        this.journal.recover(String(session.id)); this.store.recover(String(session.id));
      }
      this.ledger.recover(taskId);
      this.db.run('UPDATE independent_task_settings SET recovery_required=0,revision=revision+1,updated_at=? WHERE task_id=?', now(), taskId);
      this.changed(taskId); return this.state(taskId);
    });
  }
  history(taskId: string, after: number, limit: number): IndependentHistoryPage {
    this.row(taskId);
    const session = this.db.get('SELECT id FROM sessions WHERE task_id=? AND agent_id=? ORDER BY started_at DESC LIMIT 1', taskId, 'independent');
    const entries = session ? this.store.entries(String(session.id)) : [];
    const items = entries.filter((e) => e.seq > after).slice(0, limit).map((e) => {
      if (e.message.role !== 'assistant') return e;
      const { continuation: _opaque, ...message } = e.message; return { ...e, message };
    });
    return { items, nextCursor: items.length && items.at(-1)!.seq < entries.length ? items.at(-1)!.seq : null };
  }
  checkpoint(taskId: string, input: { throughSeq: number; summary: string; expectedTailHash: string }) {
    const session = this.db.get('SELECT id FROM sessions WHERE task_id=? AND agent_id=? ORDER BY started_at DESC LIMIT 1', taskId, 'independent');
    if (!session) throw Errors.invalidState('任务还没有会话记录');
    const result = this.store.checkpoint(String(session.id), input.throughSeq, input.summary, input.expectedTailHash);
    this.changed(taskId); return result;
  }
  approval(taskId: string, toolId: string) {
    const detail = this.details.get(toolId);
    const record = detail?.kind === 'file' ? detail.proposal.record : detail?.record;
    if (!detail || record?.taskId !== taskId) throw Errors.notFound('这项审批已结束或不属于该任务');
    return detail;
  }
  async open(taskId: string, sessionId: string, workspace: string, initialPermission: PermissionLevel, host: SessionHost): Promise<AgentConnection> {
    await this.orphanCleanup; this.assertReady(taskId);
    const state = this.state(taskId), options = state.options;
    const { key } = await this.catalog.credentials(taskId); const secrets = key ? [key] : [];
    let permission = initialPermission, closed = false, messageId = newId('m'), streamedText = false;
    const executor = new IndependentCommandExecutor(this.dataDir, {
      started: (p) => {
        // 这里要求登记实际成功，不能吞掉落库故障后仍派发命令。
        this.processes.started({ ...p, agent: 'independent', sessionId });
        if (!this.db.get('SELECT pid FROM agent_processes WHERE pid=? AND session_id=?', p.pid, sessionId)) throw Errors.internal('命令宿主登记失败');
      }, exited: (pid) => this.processes.exited(pid),
    });
    const files = new IndependentFiles(new IndependentFileHost(workspace, this.dataDir, executor));
    const fileTool = new IndependentFileTool(files, this.journal, new IndependentFileReceipts(this.db));
    const basis = JSON.stringify({ taskId, sessionId, revision: state.revision, workspace });
    let clock: IndependentApprovalClock | undefined;
    const approve = async (id: string, title: string, detail: IndependentApprovalDetail, signal: AbortSignal) => {
      if (permission !== 'ask' || signal.aborted) return { approved: false, reason: signal.aborted ? '操作已停止' : '只读权限不允许修改或命令' };
      this.details.set(id, detail);
      clock?.pause();
      try {
        const result = await host.requestPermission({ toolId: id, title, reason: '独立 Agent 请求本次操作，请展开详情核对后决定。',
          detail: '原始内容仅通过任务的独立审批详情接口读取，不写入事件。', cwd: null,
          options: [{ id: 'allow', label: '允许一次', kind: 'allow_once' }, { id: 'reject', label: '拒绝', kind: 'reject_once' }] }, signal);
        return { approved: permission === 'ask' && !signal.aborted && result.outcome === 'selected' && result.optionId === 'allow',
          reason: result.outcome === 'selected' ? redact(result.note || '用户未批准本次操作', secrets) : '审批已取消或超时' };
      } finally { clock?.resume(); this.details.delete(id); }
    };
    const fileDriver = new IndependentFileDriver(files, fileTool, this.journal, basis,
      (proposal, signal) => approve(proposal.record.id, proposal.kind === 'create' ? '创建项目文件' : '替换项目文本',
        { kind: 'file', proposal }, signal));
    const command = new IndependentCommandTool(this.journal, executor);
    const tools = options.limits.maxToolCalls > 0 ? independentModelTools(options.fileToolVersion) : [];
    const allowedTools = new Set(tools.map((tool) => tool.name));
    const driver = new IndependentApiDriver(this.catalog, {
      generation: options.generation, context: options.context, accounting: this.ledger.accounting(taskId),
      tools, loadAttachment: (id, attachmentId, signal) => new IndependentAttachments(this.attachments).load(id, attachmentId, signal),
      onContext: (_binding, report) => { this.db.run('UPDATE independent_task_settings SET context_json=?,updated_at=? WHERE task_id=?', JSON.stringify(report), now(), taskId); this.changed(taskId); },
      onDelta: (_binding, delta) => {
        if (delta.type === 'text_delta' && delta.text) streamedText = true;
        host.update({ kind: delta.type === 'text_delta' ? 'message' : 'thought', messageId, text: delta.text });
      },
    });
    const engine = new IndependentTurnEngine(this.store, {
      checkBinding: (binding) => driver.checkBinding(binding), waitForIdle: (binding) => driver.waitForIdle(binding),
      complete: (input, signal) => { messageId = newId('m'); streamedText = false; return driver.complete(input, signal); },
    }, {
      execute: async (call: IndependentToolCall, identity: { taskId: string; sessionId: string; turnId: string }, signal: AbortSignal, turnClock?: IndependentApprovalClock) => {
        clock = turnClock;
        const toolId = newId('tool'); host.update({ kind: 'tool_start', toolId, toolKind: call.name === 'command' ? 'execute' : ['write_file', 'create_file', 'replace_text'].includes(call.name) ? 'edit' : 'read', title: call.name, target: null });
        let ok = false;
        try {
          if (!allowedTools.has(call.name)) return { role: 'tool', callId: call.id, name: call.name, outcome: 'error', text: '本次任务未声明这个工具，未执行' };
          if (call.name !== 'command') {
            const result = await fileDriver.execute(call, identity, signal); ok = result.outcome === 'ok'; return result;
          }
          const spec = IndependentCommandSpec.safeParse(call.arguments);
          const result = (outcome: 'ok' | 'error' | 'rejected' | 'cancelled', text: string) => ({ role: 'tool' as const, callId: call.id, name: call.name, outcome, text });
          if (!spec.success) return result('error', '命令参数无效，未执行');
          const record = command.prepare({ ...identity, callId: call.id }, spec.data, workspace, basis);
          try {
            const decision = await approve(record.id, '执行项目命令', { kind: 'command', record, spec: spec.data,
              warning: '命令使用本机权限运行，可能读写工作区外文件、访问网络或调用已安装软件。这不是系统沙箱；请逐项核对参数。' }, signal);
            if (!decision.approved) {
              if (signal.aborted) this.journal.cancel(record.id); else this.journal.reject(record.id);
              return result(signal.aborted ? 'cancelled' : 'rejected', decision.reason);
            }
            this.journal.approve(record.id);
            const output = await command.execute(record.id, spec.data, { cwd: workspace, approvalBasis: basis, signal, redact: secrets });
            ok = output.reason === 'completed' && output.exitCode === 0;
            return result(ok ? 'ok' : output.reason === 'cancelled' ? 'cancelled' : 'error', redact(JSON.stringify(output), secrets));
          } catch (error) {
            const latest = this.journal.get(record.id);
            if (latest.state === 'pending' || latest.state === 'approved') this.journal.cancel(record.id);
            throw error;
          }
        } finally { host.update({ kind: 'tool_end', toolId, ok, summary: ok ? '工具结果已保存到独立会话' : '工具未成功完成，请查看独立记录' }); this.changed(taskId); }
      },
    }, { assistant: (_turn, reply) => {
      // 完整响应仍发布既有正文片段，旧客户端不认识可选 done.text 时也能显示回复。
      if (!streamedText && reply.text) host.update({ kind: 'message', messageId, text: redact(reply.text, secrets) });
      // 流片段仅代表暂时可见的进度；落盘后用完整正文确认，避免非流回复缺字或重复拼接。
      this.events.append({ type: 'message.done', taskId, sessionId, data: { messageId, text: redact(reply.text, secrets) } });
      host.update({ kind: 'activity' }); this.changed(taskId);
    } });
    return {
      agentSessionId: sessionId, resumed: this.store.entries(sessionId).length > 0, isClosed: () => closed,
      setConfig: async () => { throw Errors.badRequest('请在独立任务配置中明确应用服务、模型与预算'); },
      setPermission: async (level) => { if (level !== 'readonly' && level !== 'ask') throw Errors.levelUnavailable('独立 Agent 当前仅支持只读或需审批'); permission = level; },
      prompt: async (input, signal) => {
        this.assertReady(taskId);
        const rules = await files.rules(null, signal);
        if (!rules.complete) throw Errors.invalidState('项目规则未能完整读取，未请求模型');
        const text = typeof input === 'string' ? input : input.text;
        const attachments = typeof input === 'string' ? [] : input.attachments ?? [];
        if (attachments.some((a) => !a.attachmentId)) throw Errors.badRequest('附件缺少任务内身份');
        const previous = this.db.get('SELECT id FROM independent_turns WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', sessionId);
        const tail = this.store.entries(sessionId).at(-1);
        const turn = this.store.create(this.catalog.bound(taskId), sessionId, { role: 'user', text,
          attachments: attachments.map((a) => ({ attachmentId: a.attachmentId! })) }, options.limits,
        `你是 AI Console 独立编码 Agent。用中文与用户沟通。遵守项目规则，先读后改；修改与命令必须经用户审批。不要读取第三方 Agent 的凭据，不要输出密钥。工具返回范围、用量和错误必须如实说明。可用 Node 可执行文件：${process.execPath}\n项目规则：\n${rules.files.map((f) => f.path + '\n' + f.text).join('\n')}`,
        previous && tail ? { previousBinding: this.store.get(String(previous.id)).binding, tailHash: tail.hash } : undefined);
        try {
          const result = await engine.run(turn.id, signal);
          if (result.stop === 'tool_error' || result.stop === 'interrupted') this.db.run('UPDATE independent_task_settings SET recovery_required=1 WHERE task_id=?', taskId);
          host.update({ kind: 'notice', level: result.stop === 'completed' ? 'info' : 'warn', text: STOP_TEXT[result.stop!] });
          return { stopReason: result.stop === 'completed' ? 'end_turn' : result.stop === 'cancelled' || result.stop === 'interrupted' ? 'cancelled' : 'error' };
        } finally {
          if (this.db.get("SELECT id FROM independent_turns WHERE task_id=? AND status='running'", taskId)
            || this.db.get("SELECT id FROM independent_tool_calls WHERE task_id=? AND state IN ('pending','approved','running')", taskId)
            || this.ledger.snapshot(taskId).pendingRequests) this.db.run('UPDATE independent_task_settings SET recovery_required=1 WHERE task_id=?', taskId);
          this.changed(taskId);
        }
      },
      close: async () => { closed = true; try { await engine.close(); } finally { await executor.close(); } },
    };
  }
}
