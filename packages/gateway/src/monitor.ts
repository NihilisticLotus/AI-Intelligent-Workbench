// 监控统计、调用账本汇总与花费/Token 双口径上限阀门（第 2.2 步）。
// 坚持诚实口径：只汇总真实报告的 Token 与实际报告/预留的费用，绝不对订阅制无单价模型猜测价格或以 0 冒充。
import {
  ErrorActionKey, ErrorCode, MonitorOverview, TaskSource, TurnUsage, UpsertUsageCapBody,
  UsageCapEvaluation, UsageCapRule,
  type AgentInfo, type AgentKind, type CapAlertLevel, type MonitorAgentHealth,
  type MonitorBreakdownItem, type MonitorDailyPoint, type MonitorRecentEvent, type MonitorUsageTotals,
} from '@aic/protocol';
import type { Db } from './db';
import type { EventStore } from './events';
import { tokenFields } from './usage';
import { AppError, Errors, newId, now as clockNow } from './util';

const AGENT_LABELS: Record<AgentKind, string> = {
  fake: '演示 Agent',
  claude: 'Claude Code',
  codex: 'Codex',
  codebuddy: 'CodeBuddy',
  zcode: 'ZCode',
  workbuddy: 'WorkBuddy',
  antigravity: 'Antigravity',
  independent: 'AI Console 独立 Agent',
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/** 按指定时区偏移（同 Date.getTimezoneOffset，东八区为 -480）格式化 YYYY-MM-DD。 */
export function localDateKey(utcMs: number, tzOffsetMinutes: number): string {
  const local = new Date(utcMs - tzOffsetMinutes * 60_000);
  return `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
}

/** 计算给定时刻所在的本地自然日起止（半开区间 [start, end)）。 */
export function localDayBounds(utcMs: number, tzOffsetMinutes = new Date(utcMs).getTimezoneOffset()) {
  const local = new Date(utcMs - tzOffsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const start = Date.UTC(y, m, d) + tzOffsetMinutes * 60_000;
  const end = Date.UTC(y, m, d + 1) + tzOffsetMinutes * 60_000;
  return { start, end, dateKey: `${y}-${pad2(m + 1)}-${pad2(d)}` };
}

/** 计算给定时刻所在的本地自然月起止（半开区间 [start, end)）。 */
export function localMonthBounds(utcMs: number, tzOffsetMinutes = new Date(utcMs).getTimezoneOffset()) {
  const local = new Date(utcMs - tzOffsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const start = Date.UTC(y, m, 1) + tzOffsetMinutes * 60_000;
  const end = Date.UTC(y, m + 1, 1) + tzOffsetMinutes * 60_000;
  return { start, end };
}

/** 返回含今天在内最近 days 天的本地日期键（从早到晚）。 */
export function recentLocalDayKeys(utcMs: number, days: number, tzOffsetMinutes = new Date(utcMs).getTimezoneOffset()): string[] {
  const local = new Date(utcMs - tzOffsetMinutes * 60_000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m, d - i));
    keys.push(`${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`);
  }
  return keys;
}

/** 单轮用于趋势图与 Token 上限校验的有效 Token 数（若上游未报告 totalTokens，仅加总已报告的输入/输出/思考）。 */
export function effectiveTurnTokens(usage: TurnUsage): number {
  if (usage.totalTokens !== null) return usage.totalTokens;
  const parts = [usage.inputTokens, usage.outputTokens, usage.thoughtTokens].filter((n): n is number => n !== null);
  return parts.length ? parts.reduce((sum, n) => sum + n, 0) : 0;
}

type CapRow = {
  id: string;
  scope: 'global' | 'agent';
  agent: AgentKind | null;
  period: 'daily' | 'monthly';
  max_tokens: number | null;
  max_cost_micros: number | null;
  currency: string;
  enforcement: 'block_unattended' | 'block_all';
  enabled: number;
  created_at: number;
  updated_at: number;
};

type UsageRow = {
  task_id: string;
  session_id: string | null;
  usage_json: string;
  at: number;
  agent: AgentKind;
  project_id: string | null;
  project_name: string | null;
};

interface MutableBucket {
  turns: number;
  reportedTurns: number;
  sums: Record<(typeof tokenFields)[number], number>;
  counts: Record<(typeof tokenFields)[number], number>;
  effectiveTokens: number;
  costs: Map<string, number>;
  taskIds: Set<string>;
}

function createBucket(): MutableBucket {
  return {
    turns: 0,
    reportedTurns: 0,
    sums: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    counts: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 },
    effectiveTokens: 0,
    costs: new Map(),
    taskIds: new Set(),
  };
}

function addTurnToBucket(bucket: MutableBucket, usage: TurnUsage, taskId: string) {
  bucket.turns++;
  bucket.taskIds.add(taskId);
  let anyReported = false;
  for (const field of tokenFields) {
    const val = usage[field];
    if (val !== null) {
      anyReported = true;
      bucket.sums[field] += val;
      bucket.counts[field]++;
    }
  }
  if (anyReported) bucket.reportedTurns++;
  bucket.effectiveTokens += effectiveTurnTokens(usage);
}

function addCostToBucket(bucket: MutableBucket, currency: string, micros: number, taskId?: string | null) {
  if (!Number.isSafeInteger(micros) || micros < 0) return;
  if (!/^[A-Z]{3}$/.test(currency)) return;
  bucket.costs.set(currency, (bucket.costs.get(currency) ?? 0) + micros);
  if (taskId) bucket.taskIds.add(taskId);
}

function toTotals(bucket: MutableBucket): MonitorUsageTotals {
  return {
    turns: bucket.turns,
    reportedTurns: bucket.reportedTurns,
    inputTokens: bucket.counts.inputTokens ? bucket.sums.inputTokens : null,
    outputTokens: bucket.counts.outputTokens ? bucket.sums.outputTokens : null,
    thoughtTokens: bucket.counts.thoughtTokens ? bucket.sums.thoughtTokens : null,
    cacheReadTokens: bucket.counts.cacheReadTokens ? bucket.sums.cacheReadTokens : null,
    cacheWriteTokens: bucket.counts.cacheWriteTokens ? bucket.sums.cacheWriteTokens : null,
    totalTokens: bucket.counts.totalTokens ? bucket.sums.totalTokens : null,
    reportedCosts: [...bucket.costs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, micros]) => ({ currency, micros })),
  };
}

function capFromRow(row: CapRow): UsageCapRule {
  return UsageCapRule.parse({
    id: row.id,
    scope: row.scope,
    agent: row.agent,
    period: row.period,
    maxTokens: row.max_tokens,
    maxCostMicros: row.max_cost_micros,
    currency: row.currency,
    enforcement: row.enforcement,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function maxLevel(levels: CapAlertLevel[]): CapAlertLevel {
  if (levels.includes('exceeded')) return 'exceeded';
  if (levels.includes('warn')) return 'warn';
  return 'ok';
}

interface WindowAggregation {
  global: MutableBucket;
  byAgent: Map<AgentKind, MutableBucket>;
  byProject: Map<string, { name: string; bucket: MutableBucket }>;
}

export interface MonitorServiceDeps {
  listAgents: () => Promise<AgentInfo[]>;
  events?: EventStore;
  now?: () => number;
  tzOffsetMinutes?: () => number;
}

export class MonitorService {
  constructor(private db: Db, private deps: MonitorServiceDeps) {}

  private currentNow(override?: number) {
    return override ?? this.deps.now?.() ?? clockNow();
  }

  private currentTz(nowMs: number) {
    return this.deps.tzOffsetMinutes?.() ?? new Date(nowMs).getTimezoneOffset();
  }

  private aggregateWindow(from: number, to: number): WindowAggregation {
    const global = createBucket();
    const byAgent = new Map<AgentKind, MutableBucket>();
    const byProject = new Map<string, { name: string; bucket: MutableBucket }>();

    const agentBucket = (agent: AgentKind) => {
      let b = byAgent.get(agent);
      if (!b) { b = createBucket(); byAgent.set(agent, b); }
      return b;
    };
    const projectBucket = (projectId: string | null, projectName: string | null) => {
      if (!projectId) return null;
      let entry = byProject.get(projectId);
      if (!entry) { entry = { name: projectName ?? '已移除项目', bucket: createBucket() }; byProject.set(projectId, entry); }
      return entry.bucket;
    };

    // 1. 汇总每轮真实报告的 Token（turn_usage）
    const usageRows = this.db.all<UsageRow>(
      `SELECT u.task_id, u.session_id, u.usage_json, u.at,
              COALESCE(s.agent_id, t.agent) AS agent,
              t.project_id, p.name AS project_name
       FROM turn_usage u
       LEFT JOIN sessions s ON s.id = u.session_id
       LEFT JOIN tasks t ON t.id = u.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE u.at >= ? AND u.at < ?`,
      from,
      to,
    );
    for (const row of usageRows) {
      let parsed: TurnUsage;
      try { parsed = TurnUsage.parse(JSON.parse(row.usage_json)); } catch { continue; }
      addTurnToBucket(global, parsed, row.task_id);
      if (row.agent) addTurnToBucket(agentBucket(row.agent), parsed, row.task_id);
      const pb = projectBucket(row.project_id, row.project_name);
      if (pb) addTurnToBucket(pb, parsed, row.task_id);
    }

    // 2. 汇总独立模型与交接摘要的实际预留金额（仅当设置了金额预留与币种）
    for (const table of ['independent_request_attempts', 'handoff_summary_requests'] as const) {
      const costRows = this.db.all<{ task_id: string; reserved_micros: number; currency: string; project_id: string | null; project_name: string | null }>(
        `SELECT r.task_id, r.reserved_micros, r.currency, t.project_id, p.name AS project_name
         FROM ${table} r
         LEFT JOIN tasks t ON t.id = r.task_id
         LEFT JOIN projects p ON p.id = t.project_id
         WHERE r.reserved_micros IS NOT NULL AND r.currency IS NOT NULL AND r.created_at >= ? AND r.created_at < ?`,
        from,
        to,
      );
      for (const row of costRows) {
        const micros = Number(row.reserved_micros);
        addCostToBucket(global, row.currency, micros, row.task_id);
        addCostToBucket(agentBucket('independent'), row.currency, micros, row.task_id);
        const pb = projectBucket(row.project_id, row.project_name);
        if (pb) addCostToBucket(pb, row.currency, micros, row.task_id);
      }
    }

    // 3. 汇总第三方 ACP session.usage 中明确上报的费用（按会话计算窗口内相对窗口前的净增量，避免跨日/跨月重复叠加）
    const sessionCostRows = this.db.all<{ task_id: string | null; session_id: string | null; payload: string; agent: AgentKind | null; project_id: string | null; project_name: string | null }>(
      `SELECT e.task_id, e.session_id, e.payload, COALESCE(s.agent_id, t.agent) AS agent, t.project_id, p.name AS project_name
       FROM events e
       LEFT JOIN sessions s ON s.id = e.session_id
       LEFT JOIN tasks t ON t.id = e.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE e.type = 'session.usage' AND e.ts >= ? AND e.ts < ?`,
      from,
      to,
    );
    const sessionMaxCost = new Map<string, { micros: number; currency: string; sessionId: string | null; agent: AgentKind | null; projectId: string | null; projectName: string | null; taskId: string | null }>();
    const activeSessionIds = new Set<string>();
    for (const row of sessionCostRows) {
      if (row.agent === 'independent') continue;
      let data: { cost?: { amount?: unknown; currency?: unknown } };
      try { data = JSON.parse(row.payload); } catch { continue; }
      const amount = data?.cost?.amount;
      const currency = typeof data?.cost?.currency === 'string' ? data.cost.currency.toUpperCase() : '';
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) continue;
      const micros = Math.round(amount * 1_000_000);
      if (row.session_id) activeSessionIds.add(row.session_id);
      const dedupeKey = `${row.session_id ?? row.task_id ?? 'anon'}:${currency}`;
      const existing = sessionMaxCost.get(dedupeKey);
      if (!existing || micros > existing.micros) {
        sessionMaxCost.set(dedupeKey, {
          micros,
          currency,
          sessionId: row.session_id,
          agent: row.agent,
          projectId: row.project_id,
          projectName: row.project_name,
          taskId: row.task_id,
        });
      }
    }
    const baselineBefore = new Map<string, number>();
    if (activeSessionIds.size > 0) {
      const ids = [...activeSessionIds];
      const placeholders = ids.map(() => '?').join(',');
      const priorRows = this.db.all<{ session_id: string | null; payload: string }>(
        `SELECT session_id, payload FROM events WHERE type = 'session.usage' AND ts < ? AND session_id IN (${placeholders})`,
        from,
        ...ids,
      );
      for (const row of priorRows) {
        if (!row.session_id) continue;
        let data: { cost?: { amount?: unknown; currency?: unknown } };
        try { data = JSON.parse(row.payload); } catch { continue; }
        const amount = data?.cost?.amount;
        const currency = typeof data?.cost?.currency === 'string' ? data.cost.currency.toUpperCase() : '';
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) continue;
        const micros = Math.round(amount * 1_000_000);
        const key = `${row.session_id}:${currency}`;
        const prev = baselineBefore.get(key) ?? 0;
        if (micros > prev) baselineBefore.set(key, micros);
      }
    }
    for (const [key, item] of sessionMaxCost.entries()) {
      const prior = item.sessionId ? (baselineBefore.get(key) ?? 0) : 0;
      const delta = Math.max(0, item.micros - prior);
      if (delta === 0 && prior > 0) continue;
      addCostToBucket(global, item.currency, delta, item.taskId);
      if (item.agent) addCostToBucket(agentBucket(item.agent), item.currency, delta, item.taskId);
      const pb = projectBucket(item.projectId, item.projectName);
      if (pb) addCostToBucket(pb, item.currency, delta, item.taskId);
    }

    return { global, byAgent, byProject };
  }

  listRules(): UsageCapRule[] {
    return this.db
      .all<CapRow>('SELECT * FROM usage_cap_rules ORDER BY scope ASC, period ASC, created_at ASC')
      .map(capFromRow);
  }

  upsertRule(input: UpsertUsageCapBody, nowMs?: number): UsageCapEvaluation {
    const body = UpsertUsageCapBody.parse(input);
    const ts = this.currentNow(nowMs);
    const id = this.db.tx(() => {
      if (body.id) {
        const existing = this.db.get<CapRow>('SELECT * FROM usage_cap_rules WHERE id = ?', body.id);
        if (!existing) throw Errors.notFound('找不到这条上限规则');
        const duplicate = this.db.get<{ id: string }>(
          'SELECT id FROM usage_cap_rules WHERE scope = ? AND COALESCE(agent, \'\') = COALESCE(?, \'\') AND period = ? AND id <> ?',
          body.scope,
          body.agent,
          body.period,
          body.id,
        );
        if (duplicate) throw Errors.conflict('同范围和周期的上限规则已存在，请直接编辑该规则');
        this.db.run(
          `UPDATE usage_cap_rules
           SET scope = ?, agent = ?, period = ?, max_tokens = ?, max_cost_micros = ?, currency = ?, enforcement = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
          body.scope,
          body.agent,
          body.period,
          body.maxTokens,
          body.maxCostMicros,
          body.currency,
          body.enforcement,
          body.enabled ? 1 : 0,
          ts,
          body.id,
        );
        return body.id;
      }

      const sameSlot = this.db.get<{ id: string }>(
        'SELECT id FROM usage_cap_rules WHERE scope = ? AND COALESCE(agent, \'\') = COALESCE(?, \'\') AND period = ?',
        body.scope,
        body.agent,
        body.period,
      );
      if (sameSlot) {
        this.db.run(
          `UPDATE usage_cap_rules
           SET max_tokens = ?, max_cost_micros = ?, currency = ?, enforcement = ?, enabled = ?, updated_at = ?
           WHERE id = ?`,
          body.maxTokens,
          body.maxCostMicros,
          body.currency,
          body.enforcement,
          body.enabled ? 1 : 0,
          ts,
          sameSlot.id,
        );
        return sameSlot.id;
      }

      const nextId = newId('cap');
      this.db.run(
        `INSERT INTO usage_cap_rules(id, scope, agent, period, max_tokens, max_cost_micros, currency, enforcement, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nextId,
        body.scope,
        body.agent,
        body.period,
        body.maxTokens,
        body.maxCostMicros,
        body.currency,
        body.enforcement,
        body.enabled ? 1 : 0,
        ts,
        ts,
      );
      return nextId;
    });

    const evals = this.evaluateCaps(ts);
    const found = evals.find((e) => e.rule.id === id);
    if (!found) throw Errors.notFound('找不到刚保存的上限规则');
    return found;
  }

  deleteRule(id: string): void {
    const res = this.db.run('DELETE FROM usage_cap_rules WHERE id = ?', id);
    if (!res.changes) throw Errors.notFound('找不到这条上限规则');
  }

  evaluateCaps(nowMs?: number): UsageCapEvaluation[] {
    const ts = this.currentNow(nowMs);
    const tz = this.currentTz(ts);
    const day = localDayBounds(ts, tz);
    const month = localMonthBounds(ts, tz);
    const rules = this.listRules();
    if (!rules.length) return [];

    let dayAgg: WindowAggregation | null = null;
    let monthAgg: WindowAggregation | null = null;
    const getAgg = (period: 'daily' | 'monthly') => {
      if (period === 'daily') return (dayAgg ??= this.aggregateWindow(day.start, day.end));
      return (monthAgg ??= this.aggregateWindow(month.start, month.end));
    };

    return rules.map((rule) => {
      const bounds = rule.period === 'daily' ? day : month;
      const agg = getAgg(rule.period);
      const bucket = rule.scope === 'global' ? agg.global : (agg.byAgent.get(rule.agent!) ?? createBucket());
      const usedTokens = bucket.effectiveTokens;
      const hasCurrencyCost = bucket.costs.has(rule.currency);
      const usedCostMicros = hasCurrencyCost ? bucket.costs.get(rule.currency)! : null;

      const tokenRatio = rule.maxTokens !== null ? usedTokens / rule.maxTokens : null;
      const costRatio = rule.maxCostMicros !== null && usedCostMicros !== null ? usedCostMicros / rule.maxCostMicros : null;
      const ratio = Math.max(tokenRatio ?? 0, costRatio ?? 0);

      let level: CapAlertLevel = 'ok';
      let blockingUnattended = false;
      let blockingManual = false;
      if (rule.enabled) {
        if (ratio >= 1) {
          level = 'exceeded';
          blockingUnattended = true;
          blockingManual = rule.enforcement === 'block_all';
        } else if (ratio >= 0.8) {
          level = 'warn';
        }
      }

      return UsageCapEvaluation.parse({
        rule,
        windowStart: bounds.start,
        windowEnd: bounds.end,
        usedTokens,
        usedCostMicros,
        tokenRatio,
        costRatio,
        level,
        blockingUnattended,
        blockingManual,
      });
    });
  }

  /**
   * 仅在新任务或新回合启动前执行阀门检查；绝不中断已在运行中的当前回合。
   * 默认策略（block_unattended）只拦截自动化/Webhook/委派来源，始终放行制作人手动消息。
   */
  assertCanStartTurn(agent: AgentKind, sourceInput: TaskSource = 'manual', nowMs?: number, taskId: string | null = null): void {
    const source = TaskSource.parse(sourceInput);
    const evals = this.evaluateCaps(nowMs);
    for (const ev of evals) {
      if (!ev.rule.enabled) continue;
      if (ev.rule.scope === 'agent' && ev.rule.agent !== agent) continue;
      const blocked = source === 'manual' ? ev.blockingManual : ev.blockingUnattended;
      if (!blocked) continue;

      const scopeLabel = ev.rule.scope === 'global' ? '全工作台' : (AGENT_LABELS[ev.rule.agent!] ?? ev.rule.agent);
      const periodLabel = ev.rule.period === 'daily' ? '每日' : '每月';
      const detail = ev.tokenRatio !== null && ev.tokenRatio >= 1
        ? `Token 用量已达 ${ev.usedTokens.toLocaleString('en-US')} / ${ev.rule.maxTokens!.toLocaleString('en-US')}`
        : `已报告费用达到设定上限（${ev.rule.currency}）`;
      const hint = source === 'manual'
        ? '当前上限策略设为“全部拦截”，请到“监控”页调高或暂停该上限后再发送。'
        : '后台无人值守任务已自动暂停，你亲手发送的消息不受影响；可到“监控”页调高或暂停该上限。';
      const err = new AppError(429, {
        code: ErrorCode.UsageCapExceeded,
        message: `${scopeLabel}${periodLabel}上限已达到（${detail}）`,
        hint,
        actions: [{ label: '查看监控', action: ErrorActionKey.OpenMonitor }],
      });
      try {
        this.deps.events?.append({
          type: 'error',
          taskId,
          sessionId: null,
          data: { error: err.body },
        });
      } catch { /* 记录拦截事件失败不影响拒绝执行 */ }
      throw err;
    }
  }

  async overview(nowMs?: number): Promise<MonitorOverview> {
    const ts = this.currentNow(nowMs);
    const tz = this.currentTz(ts);
    const day = localDayBounds(ts, tz);
    const month = localMonthBounds(ts, tz);
    const dayKeys = recentLocalDayKeys(ts, 7, tz);
    const firstKeyParts = dayKeys[0]!.split('-').map(Number);
    const sevenDaysStart = Date.UTC(firstKeyParts[0]!, firstKeyParts[1]! - 1, firstKeyParts[2]!) + tz * 60_000;

    const todayAgg = this.aggregateWindow(day.start, day.end);
    const monthAgg = this.aggregateWindow(month.start, month.end);
    const caps = this.evaluateCaps(ts);
    const capAlertLevel = maxLevel(caps.filter((c) => c.rule.enabled).map((c) => c.level));

    // 7 天按日汇总（Token 趋势 + 失败数）
    const dailyMap = new Map<string, MonitorDailyPoint>();
    for (const key of dayKeys) {
      dailyMap.set(key, { date: key, totalTokens: 0, byAgent: {}, byProject: {}, turns: 0, failedEvents: 0 });
    }
    const recentUsage = this.db.all<UsageRow>(
      `SELECT u.task_id, u.session_id, u.usage_json, u.at,
              COALESCE(s.agent_id, t.agent) AS agent,
              t.project_id, p.name AS project_name
       FROM turn_usage u
       LEFT JOIN sessions s ON s.id = u.session_id
       LEFT JOIN tasks t ON t.id = u.task_id
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE u.at >= ? AND u.at < ?`,
      sevenDaysStart,
      day.end,
    );
    for (const row of recentUsage) {
      const point = dailyMap.get(localDateKey(row.at, tz));
      if (!point) continue;
      let parsed: TurnUsage;
      try { parsed = TurnUsage.parse(JSON.parse(row.usage_json)); } catch { continue; }
      const tokens = effectiveTurnTokens(parsed);
      point.turns++;
      point.totalTokens += tokens;
      if (row.agent) point.byAgent[row.agent] = (point.byAgent[row.agent] ?? 0) + tokens;
      if (row.project_id) point.byProject[row.project_id] = (point.byProject[row.project_id] ?? 0) + tokens;
    }

    const recentErrors = this.db.all<{ seq: number; ts: number; task_id: string | null; payload: string; task_title: string | null; agent: AgentKind | null }>(
      `SELECT e.seq, e.ts, e.task_id, e.payload, t.title AS task_title, COALESCE(s.agent_id, t.agent) AS agent
       FROM events e
       LEFT JOIN sessions s ON s.id = e.session_id
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.type = 'error' AND e.ts >= ? AND e.ts < ?
       ORDER BY e.ts DESC, e.seq DESC`,
      sevenDaysStart,
      day.end,
    );
    const errorStatsByAgent = new Map<AgentKind, { count: number; last: { code: string; message: string; at: number; taskId: string | null } }>();
    let todayFailedEvents = 0;
    for (const row of recentErrors) {
      let code = ErrorCode.AgentFailed as string;
      let message = '执行发生错误';
      try {
        const parsed = JSON.parse(row.payload) as { error?: { code?: string; message?: string } };
        if (parsed.error?.code) code = parsed.error.code.slice(0, 80);
        if (parsed.error?.message) message = parsed.error.message.slice(0, 500);
      } catch { /* 忽略畸形旧事件 */ }
      if (code === ErrorCode.UsageCapExceeded) continue;
      if (row.ts >= day.start && row.ts < day.end) todayFailedEvents++;
      const point = dailyMap.get(localDateKey(row.ts, tz));
      if (point) point.failedEvents++;
      if (!row.agent) continue;
      const stat = errorStatsByAgent.get(row.agent);
      if (!stat) {
        errorStatsByAgent.set(row.agent, { count: 1, last: { code, message, at: row.ts, taskId: row.task_id } });
      } else {
        stat.count++;
      }
    }

    const runningTasks = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('running', 'waiting')")?.n ?? 0);
    const queuedTasks = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'queued'")?.n ?? 0);
    const pendingApprovals = Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")?.n ?? 0);

    const rawAgents = await this.deps.listAgents();
    const agentNameMap = new Map<AgentKind, string>();
    for (const a of rawAgents) agentNameMap.set(a.kind, a.displayName);

    const buildAgentBreakdown = (agg: WindowAggregation): MonitorBreakdownItem[] =>
      [...agg.byAgent.entries()]
        .sort(([, a], [, b]) => b.effectiveTokens - a.effectiveTokens || b.turns - a.turns)
        .map(([agent, bucket]): MonitorBreakdownItem => ({
          key: agent,
          label: agentNameMap.get(agent) ?? AGENT_LABELS[agent] ?? agent,
          kind: 'agent',
          agent,
          tasks: bucket.taskIds.size,
          usage: toTotals(bucket),
        }));

    const buildProjectBreakdown = (agg: WindowAggregation): MonitorBreakdownItem[] =>
      [...agg.byProject.entries()]
        .sort(([, a], [, b]) => b.bucket.effectiveTokens - a.bucket.effectiveTokens || b.bucket.turns - a.bucket.turns)
        .map(([projectId, entry]): MonitorBreakdownItem => ({
          key: projectId,
          label: entry.name,
          kind: 'project',
          projectId,
          tasks: entry.bucket.taskIds.size,
          usage: toTotals(entry.bucket),
        }));

    const agents: MonitorAgentHealth[] = rawAgents.map((a) => {
      const enabled = a.enabled ?? a.status !== 'disabled';
      const errStat = errorStatsByAgent.get(a.kind);
      const quickAction: MonitorAgentHealth['quickAction'] =
        a.kind === 'independent'
          ? 'manage'
          : a.status === 'needs_login' && !a.usesNativeConfig
            ? 'login'
            : a.status === 'ready' || a.status === 'error'
              ? 'test'
              : 'manage';
      return {
        kind: a.kind,
        displayName: a.displayName,
        enabled,
        status: a.status,
        runningSessions: a.runningSessions ?? 0,
        concurrencyLimit: a.concurrencyLimit ?? null,
        lastCheckedAt: a.checkedAt ?? null,
        recentFailureCount: errStat?.count ?? 0,
        lastError: errStat?.last ?? null,
        todayUsage: toTotals(todayAgg.byAgent.get(a.kind) ?? createBucket()),
        monthUsage: toTotals(monthAgg.byAgent.get(a.kind) ?? createBucket()),
        quickAction,
      };
    });

    // 最近 30 条监控相关事件（条件前置到 SQL，避免大量已批准审批或普通 info 通知挤掉真实错误与上限拦截）
    const rawRecentEvents = this.db.all<{ seq: number; ts: number; type: string; task_id: string | null; payload: string; task_title: string | null; agent: AgentKind | null }>(
      `SELECT e.seq, e.ts, e.type, e.task_id, e.payload, t.title AS task_title, COALESCE(s.agent_id, t.agent) AS agent
       FROM events e
       LEFT JOIN sessions s ON s.id = e.session_id
       LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.type = 'error'
          OR (e.type = 'session.notice' AND json_extract(e.payload, '$.level') = 'warn')
          OR (e.type = 'approval.resolved' AND json_extract(e.payload, '$.status') IN ('rejected', 'expired'))
       ORDER BY e.seq DESC
       LIMIT 30`,
    );
    const recentEvents: MonitorRecentEvent[] = [];
    for (const row of rawRecentEvents) {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(row.payload); } catch { continue; }
      if (row.type === 'error') {
        const err = (data.error ?? {}) as { code?: string; message?: string };
        const isCap = err.code === ErrorCode.UsageCapExceeded;
        const eventAgent = row.agent ?? (typeof data.agent === 'string' ? data.agent as AgentKind : null);
        recentEvents.push({
          seq: row.seq,
          ts: row.ts,
          taskId: row.task_id,
          taskTitle: row.task_title ? row.task_title.slice(0, 200) : null,
          agent: eventAgent,
          kind: isCap ? 'cap' : 'error',
          severity: isCap ? 'warn' : 'error',
          code: typeof err.code === 'string' ? err.code.slice(0, 80) : null,
          message: typeof err.message === 'string' && err.message.trim() ? err.message.slice(0, 500) : '任务执行出错',
        });
      } else if (row.type === 'session.notice' && data.level === 'warn') {
        recentEvents.push({
          seq: row.seq,
          ts: row.ts,
          taskId: row.task_id,
          taskTitle: row.task_title ? row.task_title.slice(0, 200) : null,
          agent: row.agent,
          kind: 'session',
          severity: 'warn',
          code: null,
          message: typeof data.text === 'string' && data.text.trim() ? data.text.slice(0, 500) : '会话提醒',
        });
      } else if (row.type === 'approval.resolved' && (data.status === 'rejected' || data.status === 'expired')) {
        recentEvents.push({
          seq: row.seq,
          ts: row.ts,
          taskId: row.task_id,
          taskTitle: row.task_title ? row.task_title.slice(0, 200) : null,
          agent: row.agent,
          kind: 'approval',
          severity: 'warn',
          code: String(data.status),
          message: data.status === 'rejected' ? '审批已拒绝，操作未执行' : '审批超时未处理，已自动过期',
        });
      }
    }

    return MonitorOverview.parse({
      generatedAt: ts,
      timezoneOffsetMinutes: tz,
      counts: { runningTasks, queuedTasks, pendingApprovals, todayFailedEvents },
      today: toTotals(todayAgg.global),
      month: toTotals(monthAgg.global),
      byAgentToday: buildAgentBreakdown(todayAgg),
      byAgentMonth: buildAgentBreakdown(monthAgg),
      byProjectToday: buildProjectBreakdown(todayAgg),
      byProjectMonth: buildProjectBreakdown(monthAgg),
      dailySeries: dayKeys.map((k) => dailyMap.get(k)!),
      caps,
      capAlertLevel,
      agents,
      recentEvents,
    });
  }
}
