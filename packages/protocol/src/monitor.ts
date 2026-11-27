// 监控、调用统计账本与花费/Token 双口径上限阀门共享协议（2.2 步，零本机路径零密钥）。
import { z } from 'zod';

const MonitorId = z.string().min(1).max(64);
const MonitorTs = z.number().int().nonnegative();
const MonitorAgentKind = z.enum(['fake', 'claude', 'codex', 'codebuddy', 'zcode', 'workbuddy', 'antigravity', 'independent']);
const MonitorAgentStatus = z.enum(['ready', 'needs_login', 'not_installed', 'error', 'disabled']);
const NonNegInt = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const NullableNonNegInt = NonNegInt.nullable();

/** 任务发起触发来源：manual 为制作人亲手发起；其余为后台无人值守来源 */
export const TaskSource = z.enum(['manual', 'automation', 'webhook', 'delegated']);
export type TaskSource = z.infer<typeof TaskSource>;

export const CapScope = z.enum(['global', 'agent']);
export type CapScope = z.infer<typeof CapScope>;

export const CapPeriod = z.enum(['daily', 'monthly']);
export type CapPeriod = z.infer<typeof CapPeriod>;

/** 触发策略：默认仅暂停无人值守任务，绝不拦制作人手动发消息；可手动切为全部拦截 */
export const CapEnforcement = z.enum(['block_unattended', 'block_all']);
export type CapEnforcement = z.infer<typeof CapEnforcement>;

export const CapAlertLevel = z.enum(['ok', 'warn', 'exceeded']);
export type CapAlertLevel = z.infer<typeof CapAlertLevel>;

export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, '币种须为 3 位大写字母，例如 USD 或 CNY');

const UsageCapFields = {
  scope: CapScope,
  agent: MonitorAgentKind.nullable(),
  period: CapPeriod,
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  maxCostMicros: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
  currency: CurrencyCode.default('USD'),
  enforcement: CapEnforcement.default('block_unattended'),
  enabled: z.boolean().default(true),
};

function refineCapRule(
  val: { scope: CapScope; agent: z.infer<typeof MonitorAgentKind> | null; maxTokens: number | null; maxCostMicros: number | null },
  ctx: z.RefinementCtx,
) {
  if (val.scope === 'global' && val.agent !== null) {
    ctx.addIssue({ code: 'custom', path: ['agent'], message: '全工作台上限不能指定单个 Agent' });
  }
  if (val.scope === 'agent' && val.agent === null) {
    ctx.addIssue({ code: 'custom', path: ['agent'], message: '按 Agent 设置上限时必须选择具体 Agent' });
  }
  if (val.maxTokens === null && val.maxCostMicros === null) {
    ctx.addIssue({ code: 'custom', path: ['maxTokens'], message: 'Token 上限和费用上限至少填写一项' });
  }
}

export const UsageCapRule = z.object({
  id: MonitorId,
  ...UsageCapFields,
  createdAt: MonitorTs,
  updatedAt: MonitorTs,
}).strict().superRefine(refineCapRule);
export type UsageCapRule = z.infer<typeof UsageCapRule>;

export const UpsertUsageCapBody = z.object({
  id: MonitorId.optional(),
  ...UsageCapFields,
}).strict().superRefine(refineCapRule);
export type UpsertUsageCapBody = z.infer<typeof UpsertUsageCapBody>;

export const ReportedCurrencyCost = z.object({
  currency: CurrencyCode,
  micros: NonNegInt,
}).strict();
export type ReportedCurrencyCost = z.infer<typeof ReportedCurrencyCost>;

/** 汇总统计：未报告字段保持 null，不以 0 冒充；费用仅包含真实报告或预留金额 */
export const MonitorUsageTotals = z.object({
  turns: NonNegInt,
  reportedTurns: NonNegInt,
  inputTokens: NullableNonNegInt,
  outputTokens: NullableNonNegInt,
  thoughtTokens: NullableNonNegInt,
  cacheReadTokens: NullableNonNegInt,
  cacheWriteTokens: NullableNonNegInt,
  totalTokens: NullableNonNegInt,
  reportedCosts: z.array(ReportedCurrencyCost),
}).strict();
export type MonitorUsageTotals = z.infer<typeof MonitorUsageTotals>;

export const UsageCapEvaluation = z.object({
  rule: UsageCapRule,
  windowStart: MonitorTs,
  windowEnd: MonitorTs,
  usedTokens: NonNegInt,
  /** 若统计窗口内没有任何真实报告/预留的对应币种费用，则为 null（不以 0 误导订阅账号） */
  usedCostMicros: NullableNonNegInt,
  tokenRatio: z.number().nonnegative().nullable(),
  costRatio: z.number().nonnegative().nullable(),
  level: CapAlertLevel,
  blockingUnattended: z.boolean(),
  blockingManual: z.boolean(),
}).strict();
export type UsageCapEvaluation = z.infer<typeof UsageCapEvaluation>;

export const MonitorBreakdownItem = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(200),
  kind: z.enum(['agent', 'project']),
  agent: MonitorAgentKind.optional(),
  projectId: MonitorId.optional(),
  tasks: NonNegInt,
  usage: MonitorUsageTotals,
}).strict();
export type MonitorBreakdownItem = z.infer<typeof MonitorBreakdownItem>;

export const MonitorDailyPoint = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalTokens: NonNegInt,
  byAgent: z.record(z.string(), NonNegInt),
  byProject: z.record(z.string(), NonNegInt),
  turns: NonNegInt,
  failedEvents: NonNegInt,
}).strict();
export type MonitorDailyPoint = z.infer<typeof MonitorDailyPoint>;

export const MonitorAgentHealth = z.object({
  kind: MonitorAgentKind,
  displayName: z.string().min(1).max(100),
  enabled: z.boolean(),
  status: MonitorAgentStatus,
  runningSessions: NonNegInt,
  concurrencyLimit: NonNegInt.nullable(),
  lastCheckedAt: MonitorTs.nullable(),
  recentFailureCount: NonNegInt,
  lastError: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
    at: MonitorTs,
    taskId: MonitorId.nullable(),
  }).strict().nullable(),
  todayUsage: MonitorUsageTotals,
  monthUsage: MonitorUsageTotals,
  quickAction: z.enum(['login', 'test', 'manage', 'none']),
}).strict();
export type MonitorAgentHealth = z.infer<typeof MonitorAgentHealth>;

export const MonitorRecentEvent = z.object({
  seq: z.number().int().nonnegative(),
  ts: MonitorTs,
  taskId: MonitorId.nullable(),
  taskTitle: z.string().max(200).nullable(),
  agent: MonitorAgentKind.nullable(),
  kind: z.enum(['error', 'cap', 'approval', 'session']),
  severity: z.enum(['info', 'warn', 'error']),
  code: z.string().max(80).nullable(),
  message: z.string().min(1).max(500),
}).strict();
export type MonitorRecentEvent = z.infer<typeof MonitorRecentEvent>;

export const MonitorOverview = z.object({
  generatedAt: MonitorTs,
  timezoneOffsetMinutes: z.number().int().min(-840).max(840),
  counts: z.object({
    runningTasks: NonNegInt,
    queuedTasks: NonNegInt,
    pendingApprovals: NonNegInt,
    todayFailedEvents: NonNegInt,
  }).strict(),
  today: MonitorUsageTotals,
  month: MonitorUsageTotals,
  byAgentToday: z.array(MonitorBreakdownItem),
  byAgentMonth: z.array(MonitorBreakdownItem),
  byProjectToday: z.array(MonitorBreakdownItem),
  byProjectMonth: z.array(MonitorBreakdownItem),
  dailySeries: z.array(MonitorDailyPoint),
  caps: z.array(UsageCapEvaluation),
  capAlertLevel: CapAlertLevel,
  agents: z.array(MonitorAgentHealth),
  recentEvents: z.array(MonitorRecentEvent),
}).strict();
export type MonitorOverview = z.infer<typeof MonitorOverview>;
