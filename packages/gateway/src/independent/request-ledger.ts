// 每次网络尝试先占用持久预算；失败与崩溃不退回，避免把未知账单当成免费。
import {
  IndependentModelBinding, IndependentRequestAttempt, IndependentRequestBudget, IndependentRequestBudgetSnapshot,
  IndependentRequestRecord, IndependentRequestSettlement, type IndependentRequestAccounting,
} from '@aic/protocol';
import type { Db } from '../db';
import { Errors, newId, now } from '../util';
import { ModelTransportError } from './model-http';

export class IndependentRequestLedger {
  constructor(private db: Db) {}

  private budget(taskId: string) {
    const row = this.db.get('SELECT * FROM independent_request_budgets WHERE task_id=?', taskId);
    if (!row) throw Errors.invalidState('任务尚未设置独立请求预算');
    return { binding: IndependentModelBinding.parse(JSON.parse(String(row.binding_json))),
      policy: IndependentRequestBudget.parse(JSON.parse(String(row.policy_json))) };
  }
  /** 首次设置后不可隐式重置；重复装配同一配置是幂等的。 */
  create(bindingInput: IndependentModelBinding, policyInput: IndependentRequestBudget) {
    const binding = IndependentModelBinding.parse(bindingInput), policy = IndependentRequestBudget.parse(policyInput);
    return this.db.tx(() => {
      if (this.db.get('SELECT task_id FROM independent_request_budgets WHERE task_id=?', binding.taskId)) {
        const existing = this.budget(binding.taskId);
        if (JSON.stringify(existing) !== JSON.stringify({ binding, policy })) throw Errors.conflict('任务已有固定请求预算，不能通过重新装配清空记录');
      } else {
        this.db.run('INSERT INTO independent_request_budgets(task_id,binding_json,policy_json,created_at) VALUES (?,?,?,?)',
          binding.taskId, JSON.stringify(binding), JSON.stringify(policy), now());
      }
      return this.snapshot(binding.taskId);
    });
  }
  snapshot(taskId: string): IndependentRequestBudgetSnapshot {
    const { binding, policy } = this.budget(taskId);
    const totals = this.db.get<{ count: number; pending: number; reserved: number }>(
      "SELECT count(*) AS count,coalesce(sum(CASE WHEN state='reserved' THEN 1 ELSE 0 END),0) AS pending,coalesce(sum(reserved_micros),0) AS reserved FROM independent_request_attempts WHERE task_id=?", taskId)!;
    return IndependentRequestBudgetSnapshot.parse({ binding, policy, attemptedRequests: totals.count, pendingRequests: totals.pending,
      remainingRequests: Math.max(0, policy.maxRequests - totals.count), reservedMicros: policy.money ? totals.reserved : null,
      remainingMicros: policy.money ? Math.max(0, policy.money.maxReservedMicros - totals.reserved) : null, actualCostMicros: null });
  }
  get(id: string): IndependentRequestRecord {
    const row = this.db.get('SELECT * FROM independent_request_attempts WHERE id=?', id);
    if (!row) throw Errors.notFound('找不到独立请求记录');
    const { binding, policy } = this.budget(String(row.task_id));
    return IndependentRequestRecord.parse({ id: row.id, taskId: row.task_id, ordinal: row.ordinal, binding,
      attempt: JSON.parse(String(row.attempt_json)), status: row.state,
      settlement: row.settlement_json === null ? null : JSON.parse(String(row.settlement_json)), reservedMicros: row.reserved_micros,
      currency: policy.money?.currency ?? null, createdAt: row.created_at, updatedAt: row.updated_at });
  }
  entries(taskId: string) {
    this.budget(taskId);
    return this.db.all('SELECT id FROM independent_request_attempts WHERE task_id=? ORDER BY ordinal', taskId).map((r) => this.get(String(r.id)));
  }
  reserve(bindingInput: IndependentModelBinding, attemptInput: IndependentRequestAttempt): string {
    const binding = IndependentModelBinding.parse(bindingInput), attempt = IndependentRequestAttempt.parse(attemptInput);
    return this.db.tx(() => {
      const snapshot = this.snapshot(binding.taskId);
      if (JSON.stringify(binding) !== JSON.stringify(snapshot.binding)) throw Errors.conflict('请求与任务预算绑定不一致');
      const money = snapshot.policy.money, ceiling = money ? (attempt.kind === 'model' ? money.modelCeilingMicros : money.counterCeilingMicros) : null;
      if (snapshot.remainingRequests < 1 || money && (ceiling === null || ceiling > snapshot.remainingMicros!)) throw new ModelTransportError('budget');
      const id = newId('ireq'), at = now();
      this.db.run("INSERT INTO independent_request_attempts(id,task_id,ordinal,attempt_json,state,reserved_micros,created_at,updated_at) VALUES (?,?,?,?,'reserved',?,?,?)",
        id, binding.taskId, snapshot.attemptedRequests + 1, JSON.stringify(attempt), ceiling, at, at);
      return id;
    });
  }
  settle(id: string, input: IndependentRequestSettlement) {
    const settlement = IndependentRequestSettlement.parse(input);
    return this.db.tx(() => {
      const current = this.get(id);
      if (settlement.outcome === 'succeeded' && (current.attempt.kind === 'model'
        ? settlement.usage === null || settlement.countedInputTokens !== null
        : settlement.usage !== null || settlement.countedInputTokens === null)) throw Errors.badRequest('计数和生成的用量记录不能互换');
      if (current.status !== 'reserved') {
        if (JSON.stringify(current.settlement) !== JSON.stringify(settlement)) throw Errors.conflict('请求已有终态，不能由迟到结果覆盖');
        return current;
      }
      this.db.run('UPDATE independent_request_attempts SET state=?,settlement_json=?,updated_at=? WHERE id=? AND state=?',
        settlement.outcome, JSON.stringify(settlement), now(), id, 'reserved');
      return this.get(id);
    });
  }
  /** 只能在旧网络连接收尾后调用；保留所有次数和金额预留，不重发请求。 */
  recover(taskId?: string) {
    return this.db.tx(() => this.db.all("SELECT id FROM independent_request_attempts WHERE state='reserved'" + (taskId ? ' AND task_id=?' : ''), ...(taskId ? [taskId] : []))
      .map((r) => this.settle(String(r.id), { outcome: 'interrupted', failure: 'interrupted', usage: null, countedInputTokens: null })));
  }
  accounting(taskId: string): IndependentRequestAccounting {
    this.budget(taskId);
    const committed = () => {
      let done = false; this.db.afterCommit(() => { done = true; });
      if (!done) throw Errors.invalidState('请求记账仍在外层事务中，提交前不能继续网络或报告结算成功');
    };
    return {
      reserve: (binding, attempt) => { if (binding.taskId !== taskId) throw Errors.conflict('请求不属于本任务'); const id = this.reserve(binding, attempt); committed(); return id; },
      settle: (id, result) => { if (this.get(id).taskId !== taskId) throw Errors.conflict('请求不属于本任务'); this.settle(id, result); committed(); },
    };
  }
}
