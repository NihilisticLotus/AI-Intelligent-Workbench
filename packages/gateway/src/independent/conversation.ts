// 完整会话与控制记录单独持久化；这里不发布事件、不保存凭据、不自动重放工具。
import { createHash } from 'node:crypto';
import {
  IndependentAssistantMessage, IndependentContextCheckpoint, IndependentConversationMessage,
  IndependentModelBinding, IndependentRunLimits, IndependentToolMessage, IndependentTurnRecord, IndependentUserMessage,
  IndependentRebindConfirmation,
  type IndependentConversationEntry, type IndependentToolCall, type IndependentTurnStop,
} from '@aic/protocol';
import type { Db, Row } from '../db';
import { Errors, newId, now } from '../util';

const ZERO_HASH = '0'.repeat(64);
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const ENTRY_BYTES = 2 * 1024 * 1024;
const RESULT_RESERVE = 2000;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const digest = (previousHash: string, sessionId: string, turnId: string, seq: number, json: string) =>
  createHash('sha256').update(JSON.stringify([previousHash, sessionId, turnId, seq, json])).digest('hex');

export class IndependentConversationStore {
  constructor(private db: Db) {}

  private row(id: string): Row {
    const row = this.db.get('SELECT * FROM independent_turns WHERE id=?', id);
    if (!row) throw Errors.notFound('找不到独立回合');
    return row;
  }
  get(id: string): IndependentTurnRecord {
    const r = this.row(id);
    return IndependentTurnRecord.parse({ id: r.id, taskId: r.task_id, sessionId: r.session_id,
      binding: JSON.parse(String(r.binding_json)), limits: JSON.parse(String(r.limits_json)), status: r.status,
      phase: r.phase, revision: r.revision, modelCalls: r.model_calls, toolCalls: r.tool_calls,
      outputTokens: r.output_tokens, stop: r.stop, createdAt: r.created_at, updatedAt: r.updated_at });
  }
  private owned(id: string, owner: string) {
    const row = this.row(id);
    if (row.status !== 'running' || row.owner !== owner) throw Errors.conflict('回合已结束或由其他运行器持有');
    return this.get(id);
  }
  private touch(id: string) { this.db.run('UPDATE independent_turns SET revision=revision+1,updated_at=? WHERE id=?', now(), id); }

  entries(sessionId: string): IndependentConversationEntry[] {
    const rows = this.db.all('SELECT * FROM independent_messages WHERE session_id=? ORDER BY seq', sessionId);
    let previousHash = ZERO_HASH;
    return rows.map((r, index) => {
      const json = String(r.message_json); const seq = index + 1;
      const hash = digest(previousHash, sessionId, String(r.turn_id), seq, json);
      if (r.seq !== seq || r.previous_hash !== previousHash || r.hash !== hash) throw Errors.invalidState('会话记录摘要不一致，停止继续并保留原记录');
      const entry = { sessionId, turnId: String(r.turn_id), seq, message: IndependentConversationMessage.parse(JSON.parse(json)),
        previousHash, hash, createdAt: Number(r.created_at) };
      previousHash = hash; return entry;
    });
  }
  private append(turn: IndependentTurnRecord, message: IndependentConversationMessage, reserve = 0) {
    const entries = this.entries(turn.sessionId); const json = JSON.stringify(message);
    const total = this.db.get<{ size: number }>('SELECT coalesce(sum(length(CAST(message_json AS BLOB))),0) AS size FROM independent_messages WHERE session_id=?', turn.sessionId)!.size;
    if (Buffer.byteLength(json) > ENTRY_BYTES || entries.length + 1 + reserve > MAX_ENTRIES || total + Buffer.byteLength(json) + reserve * RESULT_RESERVE > MAX_BYTES) {
      throw Errors.tooLarge('会话原始记录已达容量限制，请处理后再继续');
    }
    const seq = entries.length + 1; const previousHash = entries.at(-1)?.hash ?? ZERO_HASH;
    this.db.run('INSERT INTO independent_messages(session_id,seq,turn_id,message_json,previous_hash,hash,created_at) VALUES (?,?,?,?,?,?,?)',
      turn.sessionId, seq, turn.id, json, previousHash, digest(previousHash, turn.sessionId, turn.id, seq, json), now());
  }

  create(bindingInput: IndependentModelBinding, sessionId: string, userInput: IndependentUserMessage, limitsInput: IndependentRunLimits, systemPrompt = '', rebindInput?: IndependentRebindConfirmation): IndependentTurnRecord {
    const binding = IndependentModelBinding.parse(bindingInput); const user = IndependentUserMessage.parse(userInput);
    const limits = IndependentRunLimits.parse(limitsInput);
    if (Buffer.byteLength(systemPrompt) > 1024 * 1024) throw Errors.tooLarge('项目规则与系统提示过大');
    return this.db.tx(() => {
      const session = this.db.get('SELECT task_id FROM sessions WHERE id=?', sessionId);
      if (!session || session.task_id !== binding.taskId) throw Errors.badRequest('回合会话与任务不一致');
      if (this.db.get("SELECT id FROM independent_turns WHERE session_id=? AND status='running'", sessionId)) throw Errors.conflict('会话已有运行回合');
      const previous = this.db.get('SELECT binding_json FROM independent_turns WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', sessionId);
      if (previous) {
        const old = IndependentModelBinding.parse(JSON.parse(String(previous.binding_json)));
        if (old.serviceId !== binding.serviceId || old.modelId !== binding.modelId || old.configRevision !== binding.configRevision || old.modelRevision !== binding.modelRevision) {
          const confirmation = IndependentRebindConfirmation.safeParse(rebindInput);
          if (!confirmation.success || JSON.stringify(confirmation.data.previousBinding) !== JSON.stringify(old)
            || confirmation.data.tailHash !== this.entries(sessionId).at(-1)?.hash) throw Errors.conflict('会话配置已变化，须明确核对后建立新绑定');
        }
      }
      this.entries(sessionId);
      const id = newId('itr'); const at = now();
      this.db.run(`INSERT INTO independent_turns(id,task_id,session_id,binding_json,limits_json,system_prompt,status,phase,revision,output_tokens,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'running','ready',1,0,?,?)`, id, binding.taskId, sessionId, JSON.stringify(binding), JSON.stringify(limits), systemPrompt, at, at);
      const turn = this.get(id); this.append(turn, user); return turn;
    });
  }
  acquire(id: string): string {
    return this.db.tx(() => {
      const r = this.row(id);
      if (r.status !== 'running' || r.owner !== null) throw Errors.conflict('回合已结束或已有运行器');
      const owner = newId('runner');
      if (this.db.run('UPDATE independent_turns SET owner=? WHERE id=? AND owner IS NULL AND status=?', owner, id, 'running').changes !== 1) throw Errors.conflict('回合已由其他运行器持有');
      return owner;
    });
  }
  context(id: string) {
    const turn = this.get(id); const entries = this.entries(turn.sessionId);
    const r = this.db.get('SELECT * FROM independent_checkpoints WHERE session_id=? ORDER BY through_seq DESC LIMIT 1', turn.sessionId);
    const checkpoint = r ? IndependentContextCheckpoint.parse({ id: r.id, sessionId: r.session_id, throughSeq: r.through_seq, sourceHash: r.source_hash, summary: r.summary, createdAt: r.created_at }) : null;
    if (checkpoint && entries[checkpoint.throughSeq - 1]?.hash !== checkpoint.sourceHash) throw Errors.invalidState('压缩来源摘要不一致');
    const systemPrompt = String(this.row(id).system_prompt);
    // 私有续传在生成时绑定了绑定、系统提示（含项目规则正文）、人工总结和工具声明（modelWire 的 scope / prefix）。
    // 其中任何一项与当前回合不同，就只移除本次输入里的专用资料、保留可移植原文；原始记录不改写，也不放宽 modelWire 的校验（ISSUE-0056）。
    const basis = new Map<string, { binding: IndependentModelBinding; systemPrompt: string; tools: boolean }>();
    const basisOf = (turnId: string) => {
      let value = basis.get(turnId);
      if (!value) { const record = this.get(turnId); value = { binding: record.binding, systemPrompt: String(this.row(turnId).system_prompt), tools: record.limits.maxToolCalls > 0 }; basis.set(turnId, value); }
      return value;
    };
    return { systemPrompt, checkpoint,
      messages: entries.filter((e) => e.seq > (checkpoint?.throughSeq ?? 0)).map((e) => {
        const message = e.message;
        if (message.role !== 'assistant' || !message.continuation) return message;
        const old = basisOf(e.turnId);
        if (old.binding.serviceId === turn.binding.serviceId && old.binding.modelId === turn.binding.modelId && old.binding.configRevision === turn.binding.configRevision
            && old.binding.modelRevision === turn.binding.modelRevision && old.binding.createdAt === turn.binding.createdAt
            && old.systemPrompt === systemPrompt && old.tools === turn.limits.maxToolCalls > 0
            // 在当前总结保存之前产生的消息，生成时用的是更早的总结或没有总结
            && !(checkpoint && e.createdAt <= checkpoint.createdAt)) return message;
        const { continuation: _private, ...portable } = message; return portable;
      }) };
  }
  pending(id: string): IndependentToolCall[] {
    const turn = this.get(id); const entries = this.entries(turn.sessionId).filter((e) => e.turnId === id);
    const pending: IndependentToolCall[] = [];
    for (const { message } of entries) {
      if (message.role === 'assistant') pending.push(...message.toolCalls);
      else if (message.role === 'tool') {
        const call = pending.shift();
        if (!call || call.id !== message.callId || call.name !== message.name) throw Errors.invalidState('工具结果与原调用不成对');
      }
    }
    return pending;
  }
  claimModel(id: string, owner: string) {
    return this.db.tx(() => {
      const turn = this.owned(id, owner);
      if (turn.phase !== 'ready' || this.pending(id).length) throw Errors.invalidState('工具尚未结束或已有模型请求');
      if (turn.modelCalls >= turn.limits.maxModelCalls || turn.outputTokens === null || turn.outputTokens >= turn.limits.maxOutputTokens) throw Errors.invalidState('本回合的模型调用预算已耗尽或用量未知');
      if (!this.canRequest(id)) throw Errors.tooLarge('会话没有容纳回复与工具结果的空间');
      this.db.run("UPDATE independent_turns SET model_calls=model_calls+1,phase='model' WHERE id=?", id);
      this.touch(id); return this.get(id);
    });
  }
  canRequest(id: string) {
    const turn = this.get(id);
    const size = this.db.get<{ count: number; size: number }>('SELECT count(*) AS count,coalesce(sum(length(CAST(message_json AS BLOB))),0) AS size FROM independent_messages WHERE session_id=?', turn.sessionId)!;
    // 先为一条最大回复及其最多 64 项中断结果保留空间，再允许产生上游请求。
    return size.count + 65 <= MAX_ENTRIES && size.size + ENTRY_BYTES + 64 * RESULT_RESERVE <= MAX_BYTES;
  }
  assistant(id: string, owner: string, input: IndependentAssistantMessage) {
    const message = IndependentAssistantMessage.parse(input);
    return this.db.tx(() => {
      const turn = this.owned(id, owner);
      if (turn.phase !== 'model') throw Errors.invalidState('本回合没有待完成模型请求');
      const ids = new Set(this.entries(turn.sessionId).filter((e) => e.turnId === id).flatMap((e) => e.message.role === 'assistant' ? e.message.toolCalls.map((c) => c.id) : []));
      if (message.toolCalls.some((c) => ids.has(c.id))) throw Errors.conflict('模型重复使用了本回合的工具调用身份');
      this.append(turn, message, message.toolCalls.length);
      const output = turn.outputTokens === null || message.usage.outputTokens === null ? null : turn.outputTokens + message.usage.outputTokens;
      this.db.run('UPDATE independent_turns SET phase=?,output_tokens=? WHERE id=?', message.toolCalls.length ? 'tools' : 'ready', output, id);
      this.touch(id); return this.get(id);
    });
  }
  claimTool(id: string, owner: string) {
    return this.db.tx(() => {
      const turn = this.owned(id, owner); const call = this.pending(id)[0];
      if (turn.phase !== 'tools' || !call || this.row(id).active_call_id !== null) throw Errors.invalidState('没有待派发工具或工具已在执行');
      if (turn.toolCalls >= turn.limits.maxToolCalls) throw Errors.invalidState('已达工具调用上限');
      this.db.run('UPDATE independent_turns SET active_call_id=?,tool_calls=tool_calls+1 WHERE id=?', call.id, id);
      this.touch(id); return call;
    });
  }
  private toolAppend(turn: IndependentTurnRecord, input: IndependentToolMessage) {
    let message = IndependentToolMessage.parse(input); const pending = this.pending(turn.id); const call = pending[0];
    if (!call || call.id !== message.callId || call.name !== message.name) throw Errors.conflict('工具结果身份或顺序与声明不符');
    const total = this.db.get<{ size: number }>('SELECT coalesce(sum(length(CAST(message_json AS BLOB))),0) AS size FROM independent_messages WHERE session_id=?', turn.sessionId)!.size;
    const available = Math.min(ENTRY_BYTES, MAX_BYTES - total - (pending.length - 1) * RESULT_RESERVE);
    if (bytes(message) > available) {
      const suffix = '\n[工具结果因会话容量限制截断]'; let low = 0; let high = message.text.length;
      while (low < high) { const middle = Math.ceil((low + high) / 2); if (bytes({ ...message, text: message.text.slice(0, middle) + suffix }) <= available) low = middle; else high = middle - 1; }
      message = { ...message, text: message.text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '') + suffix };
    }
    this.append(turn, message, pending.length - 1);
    this.db.run('UPDATE independent_turns SET active_call_id=NULL,phase=? WHERE id=?', pending.length > 1 ? 'tools' : 'ready', turn.id);
    return message;
  }
  tool(id: string, owner: string, input: IndependentToolMessage) {
    return this.db.tx(() => {
      const turn = this.owned(id, owner);
      if (this.row(id).active_call_id !== input.callId) throw Errors.conflict('工具未派发或身份已变化');
      const stored = this.toolAppend(turn, input); this.touch(id); return stored;
    });
  }
  finish(id: string, owner: string, stop: IndependentTurnStop) {
    return this.db.tx(() => { this.owned(id, owner); return this.finishInside(id, stop); });
  }
  private finishInside(id: string, stop: IndependentTurnStop) {
    const turn = this.get(id); const pending = this.pending(id);
    if (stop === 'completed' && (turn.phase !== 'ready' || pending.length)) throw Errors.invalidState('模型与工具尚未完成');
    for (const call of pending) this.toolAppend(this.get(id), { role: 'tool', callId: call.id, name: call.name,
      text: '本回合已停止；本次工具没有可靠完成记录，不可自动重放，请核对实际副作用。',
      outcome: stop === 'cancelled' ? 'cancelled' : ['tool_limit', 'model_limit', 'output_limit', 'usage_unknown', 'context_limit', 'request_budget'].includes(stop) ? 'budget_exceeded' : 'interrupted' });
    const status = stop === 'completed' ? 'completed' : stop === 'cancelled' ? 'cancelled' : stop === 'interrupted' ? 'interrupted' : 'failed';
    this.db.run('UPDATE independent_turns SET status=?,stop=?,owner=NULL,active_call_id=NULL,output_tokens=?,phase=? WHERE id=?',
      status, stop, turn.phase === 'model' ? null : turn.outputTokens, 'ready', id);
    this.touch(id); return this.get(id);
  }
  /** 只能在旧运行器 / 命令收尾后由宿主调用，不在读取记录时自动触发。 */
  recover(sessionId?: string) {
    return this.db.tx(() => this.db.all("SELECT id FROM independent_turns WHERE status='running'" + (sessionId ? ' AND session_id=?' : ''), ...(sessionId ? [sessionId] : []))
      .map((r) => this.finishInside(String(r.id), 'interrupted')));
  }
  checkpoint(sessionId: string, throughSeq: number, summary: string, expectedTailHash: string): IndependentContextCheckpoint {
    if (!summary.trim()) throw Errors.badRequest('总结不能为空');
    return this.db.tx(() => {
      const entries = this.entries(sessionId); const tail = entries.at(-1); const boundary = entries[throughSeq - 1];
      if (!tail || tail.hash !== expectedTailHash) throw Errors.conflict('总结期间会话已变化，请重新核对来源');
      if (this.db.get("SELECT id FROM independent_turns WHERE session_id=? AND status='running'", sessionId)) throw Errors.invalidState('运行中不能替换上下文');
      if (!Number.isInteger(throughSeq) || !boundary || entries[throughSeq]?.turnId === boundary.turnId || this.get(boundary.turnId).status === 'running') throw Errors.badRequest('压缩必须位于完整终态回合边界');
      const previous = this.db.get<{ through_seq: number }>('SELECT max(through_seq) AS through_seq FROM independent_checkpoints WHERE session_id=?', sessionId);
      if (previous?.through_seq && throughSeq <= previous.through_seq) throw Errors.conflict('不能回退已有压缩来源范围');
      const checkpoint = IndependentContextCheckpoint.parse({ id: newId('icp'), sessionId, throughSeq, sourceHash: boundary.hash, summary, createdAt: now() });
      if (Buffer.byteLength(summary) > 1024 * 1024) throw Errors.tooLarge('总结内容过大');
      this.db.run('INSERT INTO independent_checkpoints(id,session_id,through_seq,source_hash,summary,created_at) VALUES (?,?,?,?,?,?)',
        checkpoint.id, sessionId, throughSeq, checkpoint.sourceHash, summary, checkpoint.createdAt);
      return checkpoint;
    });
  }
}
