// 工具持久意图与状态转换。恢复仅标记中断，不执行、补做或重试工具。
import { IndependentCommandOutcome, IndependentToolIntent, IndependentToolRecord, type IndependentToolState } from '@aic/protocol';
import type { Db, Row } from '../db';
import { Errors, newId, now } from '../util';

export class IndependentToolJournal {
  constructor(private db: Db) {}

  private record(row: Row): IndependentToolRecord {
    return IndependentToolRecord.parse({ id: row.id, taskId: row.task_id, sessionId: row.session_id,
      turnId: row.turn_id, callId: row.call_id, toolName: row.tool_name, inputHash: row.input_hash,
      state: row.state, createdAt: row.created_at, updatedAt: row.updated_at,
      pid: row.pid, processStartedAt: row.process_started_at,
      outcome: row.outcome_json === null ? null : JSON.parse(String(row.outcome_json)) });
  }

  get(id: string): IndependentToolRecord {
    const row = this.db.get('SELECT * FROM independent_tool_calls WHERE id = ?', id);
    if (!row) throw Errors.notFound('找不到独立工具记录');
    return this.record(row);
  }

  create(input: IndependentToolIntent): IndependentToolRecord {
    const intent = IndependentToolIntent.parse(input);
    return this.db.tx(() => {
      const session = this.db.get<{ task_id: string }>('SELECT task_id FROM sessions WHERE id = ?', intent.sessionId);
      if (!session || session.task_id !== intent.taskId) throw Errors.badRequest('工具会话与任务不一致');
      const old = this.db.get('SELECT * FROM independent_tool_calls WHERE session_id = ? AND turn_id = ? AND call_id = ?', intent.sessionId, intent.turnId, intent.callId);
      if (old) {
        const record = this.record(old);
        if (record.toolName !== intent.toolName || record.inputHash !== intent.inputHash || record.taskId !== intent.taskId) throw Errors.conflict('同一工具调用的内容发生变化，请重新审批');
        return record;
      }
      const id = newId('itc'); const at = now();
      this.db.run(`INSERT INTO independent_tool_calls
        (id,task_id,session_id,turn_id,call_id,tool_name,input_hash,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,'pending',?,?)`, id, intent.taskId, intent.sessionId, intent.turnId, intent.callId, intent.toolName, intent.inputHash, at, at);
      return this.get(id);
    });
  }

  private transition(id: string, from: readonly IndependentToolState[], to: IndependentToolState): IndependentToolRecord {
    return this.db.tx(() => {
      const record = this.get(id);
      // 审批重发可以幂等；running 只能由 start 的 CAS 进入一次。
      if (record.state === to && to !== 'running') return record;
      if (!from.includes(record.state)) throw Errors.invalidState('工具状态已变化，不能执行本次操作');
      const result = this.db.run(`UPDATE independent_tool_calls SET state = ?, updated_at = ? WHERE id = ? AND state = ?`, to, now(), id, record.state);
      if (result.changes !== 1) throw Errors.conflict('工具状态已被其他操作改变');
      return this.get(id);
    });
  }

  approve(id: string) { return this.transition(id, ['pending'], 'approved'); }
  reject(id: string) { return this.transition(id, ['pending'], 'rejected'); }
  /** 活动命令必须先由执行器停止；运行中不能靠这条转换假装已取消。 */
  cancel(id: string) { return this.transition(id, ['pending', 'approved'], 'cancelled'); }
  start(id: string) { return this.transition(id, ['approved'], 'running'); }

  /** 宿主登记成功后执行器才可派发命令。重复登记不能把 PID 换成另一进程。 */
  setProcess(id: string, pid: number, startedAt: number): IndependentToolRecord {
    const identity = IndependentToolRecord.pick({ pid: true, processStartedAt: true }).parse({ pid, processStartedAt: startedAt });
    if (identity.pid === null || identity.processStartedAt === null) throw Errors.badRequest('缺少工具进程身份');
    return this.db.tx(() => {
      const record = this.get(id);
      if (record.state !== 'running') throw Errors.invalidState('工具不在执行状态，不能登记进程');
      if (record.pid !== null) {
        if (record.pid !== pid || record.processStartedAt !== startedAt) throw Errors.conflict('工具已登记其他进程');
        return record;
      }
      this.db.run('UPDATE independent_tool_calls SET pid = ?, process_started_at = ?, updated_at = ? WHERE id = ? AND state = ? AND pid IS NULL', identity.pid, identity.processStartedAt, now(), id, 'running');
      return this.get(id);
    });
  }

  finish(id: string, input: IndependentCommandOutcome): IndependentToolRecord {
    // schema 丢弃 stdout / stderr 等额外字段，持久记录只含概要。
    const outcome = IndependentCommandOutcome.parse(input);
    const state: IndependentToolState = outcome.reason === 'completed' && outcome.exitCode === 0 ? 'succeeded'
      : outcome.reason === 'cancelled' ? 'cancelled' : outcome.reason === 'interrupted' ? 'interrupted' : 'failed';
    return this.db.tx(() => {
      const record = this.get(id);
      if (record.state !== 'running') throw Errors.invalidState('工具已结束或尚未执行，不能覆写结果');
      this.db.run('UPDATE independent_tool_calls SET state = ?, outcome_json = ?, updated_at = ? WHERE id = ? AND state = ?', state, JSON.stringify(outcome), now(), id, 'running');
      return this.get(id);
    });
  }

  /** 仅在执行器接管前调用；调用方仍须核对文件副作用和补齐模型工具结果。 */
  recover(sessionId?: string): IndependentToolRecord[] {
    if (sessionId !== undefined) IndependentToolIntent.shape.sessionId.parse(sessionId);
    return this.db.tx(() => {
      const rows = this.db.all(`SELECT * FROM independent_tool_calls WHERE state IN ('pending','approved','running')${sessionId ? ' AND session_id = ?' : ''}`, ...(sessionId ? [sessionId] : []));
      for (const row of rows) this.db.run('UPDATE independent_tool_calls SET state = ?, updated_at = ? WHERE id = ?', 'interrupted', now(), String(row.id));
      return rows.map((row) => this.get(String(row.id)));
    });
  }
}
