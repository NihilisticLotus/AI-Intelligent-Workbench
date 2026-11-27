// 监控页（第 2.2 步）：全局调用账本、Token 与费用双口径上限阀门、Agent 健康状态与最近动态。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentKind, ApiError, CapEnforcement, CapPeriod, CapScope, MonitorAgentHealth, MonitorBreakdownItem,
  MonitorOverview, ReportedCurrencyCost, UpsertUsageCapBody, UsageCapEvaluation,
} from '@aic/protocol';
import { toApiError } from '../api/http';
import { requestAgentTest, requestFocusApproval } from '../components/focus';
import { Icon } from '../components/Icon';
import { confirmDialog, ErrorNotice } from '../components/ui';
import { agentFallback, clock } from '../lib/format';
import { api, appStore, useApp, useRemoteAccess } from '../state/app';
import { setPref } from '../state/prefs';
import { navigate, toast, toastError } from '../state/ui';

const CURRENCY_OPTIONS = ['USD', 'CNY', 'EUR', 'JPY'] as const;
const SERIES_COLORS = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)', 'var(--c7)', 'var(--c8)'];

interface CapFormState {
  id?: string;
  scope: CapScope;
  agent: AgentKind;
  period: CapPeriod;
  maxTokensText: string;
  maxCostText: string;
  currency: string;
  enforcement: CapEnforcement;
  enabled: boolean;
}

function defaultCapForm(defaultAgent: AgentKind): CapFormState {
  return {
    scope: 'global',
    agent: defaultAgent,
    period: 'daily',
    maxTokensText: '200000',
    maxCostText: '',
    currency: 'USD',
    enforcement: 'block_unattended',
    enabled: true,
  };
}

function formFromRule(ev: UsageCapEvaluation, defaultAgent: AgentKind): CapFormState {
  const { rule } = ev;
  return {
    id: rule.id,
    scope: rule.scope,
    agent: rule.agent ?? defaultAgent,
    period: rule.period,
    maxTokensText: rule.maxTokens !== null ? String(rule.maxTokens) : '',
    maxCostText: rule.maxCostMicros !== null ? formatMicrosPlain(rule.maxCostMicros) : '',
    currency: rule.currency,
    enforcement: rule.enforcement,
    enabled: rule.enabled,
  };
}

export function formatTokens(n: number | null): string {
  if (n === null) return '未报告';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return n.toLocaleString('en-US');
}

export function formatMicrosPlain(micros: number): string {
  const val = micros / 1_000_000;
  return val.toFixed(6).replace(/\.?0+$/, '') || '0';
}

export function formatMoney(currency: string, micros: number): string {
  const value = micros / 1_000_000;
  const formatted = value >= 1
    ? value.toFixed(2)
    : micros > 0 && micros < 100
      ? value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
      : value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (currency === 'USD') return `$${formatted}`;
  if (currency === 'CNY') return `¥${formatted}`;
  if (currency === 'EUR') return `€${formatted}`;
  if (currency === 'JPY') return `¥${Math.round(value)} JPY`;
  return `${formatted} ${currency}`;
}

export function formatReportedCosts(costs: ReportedCurrencyCost[]): string | null {
  if (!costs.length) return null;
  return costs.map((c) => formatMoney(c.currency, c.micros)).join(' · ');
}

function effectiveSummaryTokens(totals: MonitorOverview['today']): number | null {
  if (totals.totalTokens !== null) return totals.totalTokens;
  const parts = [totals.inputTokens, totals.outputTokens, totals.thoughtTokens].filter((x): x is number => x !== null);
  return parts.length ? parts.reduce((sum, n) => sum + n, 0) : null;
}

function capScopeLabel(ev: UsageCapEvaluation, agentNames: Map<string, string>): string {
  if (ev.rule.scope === 'global') return '全工作台';
  const kind = ev.rule.agent!;
  return agentNames.get(kind) ?? agentFallback[kind]?.name ?? kind;
}

function capStatusInfo(ev: UsageCapEvaluation): { label: string; cls: string } {
  if (!ev.rule.enabled) return { label: '已暂停', cls: 'muted' };
  if (ev.level === 'exceeded') return { label: '已达上限', cls: 'over' };
  if (ev.level === 'warn') return { label: '接近上限', cls: 'hot' };
  return { label: '正常', cls: 'ok' };
}

function agentStatusInfo(agent: MonitorAgentHealth): { label: string; cls: string; mark: string } {
  if (!agent.enabled || agent.status === 'disabled') return { label: '已停用', cls: 'idle', mark: '○' };
  switch (agent.status) {
    case 'ready': return { label: '就绪', cls: 'ok', mark: '●' };
    case 'needs_login': return { label: '需登录', cls: 'wait', mark: '◆' };
    case 'not_installed': return { label: '未安装', cls: 'idle', mark: '○' };
    case 'error': return { label: '异常', cls: 'err', mark: '■' };
    default: return { label: '状态未知', cls: 'idle', mark: '○' };
  }
}

function parseCapBody(form: CapFormState): { body?: UpsertUsageCapBody; error?: string } {
  const tokenStr = form.maxTokensText.trim();
  const costStr = form.maxCostText.trim();
  let maxTokens: number | null = null;
  let maxCostMicros: number | null = null;

  if (tokenStr) {
    if (!/^\d+$/.test(tokenStr)) return { error: 'Token 上限请填写正整数' };
    const n = Number(tokenStr);
    if (!Number.isSafeInteger(n) || n <= 0) return { error: 'Token 上限必须大于 0' };
    maxTokens = n;
  }
  if (costStr) {
    if (!/^\d+(?:\.\d{1,6})?$/.test(costStr)) return { error: '费用上限请填写正数（最多 6 位小数）' };
    const micros = Math.round(Number(costStr) * 1_000_000);
    if (!Number.isSafeInteger(micros) || micros <= 0) return { error: '费用上限必须大于 0' };
    maxCostMicros = micros;
  }
  if (maxTokens === null && maxCostMicros === null) {
    return { error: '请至少填写一项 Token 上限或费用上限' };
  }
  return {
    body: {
      ...(form.id ? { id: form.id } : {}),
      scope: form.scope,
      agent: form.scope === 'agent' ? form.agent : null,
      period: form.period,
      maxTokens,
      maxCostMicros,
      currency: form.currency,
      enforcement: form.enforcement,
      enabled: form.enabled,
    },
  };
}

export function MonitorPage({ initialOverview }: { initialOverview?: MonitorOverview | null }) {
  const remote = useRemoteAccess();
  const approvals = useApp((s) => s.approvals);
  const projects = useApp((s) => s.projects);
  const [overview, setOverview] = useState<MonitorOverview | null>(initialOverview ?? null);
  const [loading, setLoading] = useState(!initialOverview);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [groupBy, setGroupBy] = useState<'agent' | 'project'>('agent');
  const [viewMode, setViewMode] = useState<'chart' | 'table'>('chart');
  const [periodTab, setPeriodTab] = useState<'today' | 'month'>('today');
  const [eventFilter, setEventFilter] = useState<'all' | 'error' | 'cap_approval'>('all');

  const [editing, setEditing] = useState<CapFormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savingCap, setSavingCap] = useState(false);

  const mountedRef = useRef(true);
  const reqIdRef = useRef(0);

  const load = useCallback(async (soft = false) => {
    const id = ++reqIdRef.current;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await api.monitorOverview();
      if (!mountedRef.current || id !== reqIdRef.current) return;
      setOverview(data);
    } catch (e) {
      if (!mountedRef.current || id !== reqIdRef.current) return;
      setError(toApiError(e));
    } finally {
      if (mountedRef.current && id === reqIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!initialOverview) void load(false);
    return () => { mountedRef.current = false; };
  }, [initialOverview, load]);

  const agentNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of overview?.agents ?? []) map.set(a.kind, a.displayName);
    return map;
  }, [overview]);

  const projectNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name);
    for (const item of [...(overview?.byProjectToday ?? []), ...(overview?.byProjectMonth ?? [])]) {
      if (item.projectId) map.set(item.projectId, item.label);
    }
    return map;
  }, [overview, projects]);

  const defaultAgent: AgentKind = useMemo(() => {
    const firstEnabled = overview?.agents.find((a) => a.enabled);
    return firstEnabled?.kind ?? 'fake';
  }, [overview]);

  const jumpToFirstApproval = () => {
    const first = Object.values(approvals)
      .filter((a) => a.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (first) {
      setPref('workView', 'chat');
      navigate({ page: 'task', taskId: first.taskId });
      requestFocusApproval(first.id);
      return;
    }
    const pendingTask = Object.values(appStore.get().tasks).find((t) => t.status === 'waiting');
    if (pendingTask) {
      setPref('workView', 'chat');
      navigate({ page: 'task', taskId: pendingTask.id });
    } else {
      navigate({ page: 'home' });
    }
  };

  const openNewCap = () => {
    if (remote) return;
    setFormError(null);
    setEditing(defaultCapForm(defaultAgent));
  };

  const openEditCap = (ev: UsageCapEvaluation) => {
    if (remote) return;
    setFormError(null);
    setEditing(formFromRule(ev, defaultAgent));
  };

  const submitCap = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || remote || savingCap) return;
    const parsed = parseCapBody(editing);
    if (parsed.error || !parsed.body) {
      setFormError(parsed.error ?? '请检查输入内容');
      return;
    }
    setFormError(null);
    setSavingCap(true);
    try {
      await api.saveMonitorCap(parsed.body);
      if (!mountedRef.current) return;
      setEditing(null);
      toast('上限规则已保存');
      await load(true);
    } catch (err) {
      if (!mountedRef.current) return;
      toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setSavingCap(false);
    }
  };

  const toggleCap = async (ev: UsageCapEvaluation) => {
    if (remote || savingCap) return;
    setSavingCap(true);
    try {
      await api.saveMonitorCap({
        id: ev.rule.id,
        scope: ev.rule.scope,
        agent: ev.rule.agent,
        period: ev.rule.period,
        maxTokens: ev.rule.maxTokens,
        maxCostMicros: ev.rule.maxCostMicros,
        currency: ev.rule.currency,
        enforcement: ev.rule.enforcement,
        enabled: !ev.rule.enabled,
      });
      if (!mountedRef.current) return;
      toast(ev.rule.enabled ? '已暂停这条上限规则' : '已启用这条上限规则');
      await load(true);
    } catch (err) {
      if (!mountedRef.current) return;
      toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setSavingCap(false);
    }
  };

  const removeCap = async (ev: UsageCapEvaluation) => {
    if (remote || savingCap) return;
    const scopeLabel = capScopeLabel(ev, agentNames);
    const periodLabel = ev.rule.period === 'daily' ? '每日' : '每月';
    const ok = await confirmDialog({
      title: '删除这条上限规则？',
      body: `删除「${scopeLabel} · ${periodLabel}」上限后，该范围将不再触发 80% 提醒或 100% 拦截。`,
      ok: '确认删除',
      danger: true,
    });
    if (!ok || !mountedRef.current) return;
    setSavingCap(true);
    try {
      await api.deleteMonitorCap(ev.rule.id);
      if (!mountedRef.current) return;
      if (editing?.id === ev.rule.id) setEditing(null);
      toast('上限规则已删除');
      await load(true);
    } catch (err) {
      if (!mountedRef.current) return;
      toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setSavingCap(false);
    }
  };

  const runAgentAction = (agent: MonitorAgentHealth) => {
    if (agent.quickAction === 'login') {
      if (remote) {
        toast('请到运行 AI Console 的电脑上登录第三方 Agent', 'attn');
        return;
      }
      navigate({ page: 'agents', agent: agent.kind });
      return;
    }
    if (agent.quickAction === 'test') {
      if (remote) {
        toast('请到运行 AI Console 的电脑上测试 Agent 连接', 'attn');
        return;
      }
      navigate({ page: 'agents', agent: agent.kind });
      requestAgentTest(agent.kind);
      return;
    }
    navigate({ page: 'agents', agent: agent.kind });
  };

  // 7 天堆叠柱状图序列（最多展示前 7 项 + 其他，匹配 8 色调色板）
  const chartModel = useMemo(() => {
    const days = overview?.dailySeries ?? [];
    const totalsByKey = new Map<string, number>();
    for (const day of days) {
      const bucket = groupBy === 'agent' ? day.byAgent : day.byProject;
      for (const [k, v] of Object.entries(bucket)) {
        if (v > 0) totalsByKey.set(k, (totalsByKey.get(k) ?? 0) + v);
      }
    }
    const sortedKeys = [...totalsByKey.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const primaryKeys = sortedKeys.slice(0, 7);
    const hasOther = sortedKeys.length > 7;
    const series = [
      ...primaryKeys.map((key, idx) => ({
        key,
        label: groupBy === 'agent'
          ? (agentNames.get(key) ?? agentFallback[key as AgentKind]?.name ?? key)
          : (projectNames.get(key) ?? '其他项目'),
        color: SERIES_COLORS[idx % SERIES_COLORS.length]!,
      })),
      ...(hasOther ? [{ key: '__other__', label: '其他', color: SERIES_COLORS[7]! }] : []),
    ];
    const maxDay = Math.max(1, ...days.map((d) => d.totalTokens));
    return { days, series, primarySet: new Set(primaryKeys), hasOther, maxDay };
  }, [overview, groupBy, agentNames, projectNames]);

  const breakdownRows: MonitorBreakdownItem[] = useMemo(() => {
    if (!overview) return [];
    if (groupBy === 'agent') return periodTab === 'today' ? overview.byAgentToday : overview.byAgentMonth;
    return periodTab === 'today' ? overview.byProjectToday : overview.byProjectMonth;
  }, [overview, groupBy, periodTab]);

  const filteredEvents = useMemo(() => {
    const list = overview?.recentEvents ?? [];
    if (eventFilter === 'error') return list.filter((e) => e.kind === 'error');
    if (eventFilter === 'cap_approval') return list.filter((e) => e.kind === 'cap' || e.kind === 'approval');
    return list;
  }, [overview, eventFilter]);

  const hasAnyUsage = !!overview && (
    overview.today.turns > 0
    || overview.month.turns > 0
    || overview.dailySeries.some((d) => d.turns > 0 || d.totalTokens > 0)
  );

  const todayTokens = overview ? effectiveSummaryTokens(overview.today) : null;
  const todayCostText = overview ? formatReportedCosts(overview.today.reportedCosts) : null;
  const exceededCaps = (overview?.caps ?? []).filter((c) => c.rule.enabled && c.level === 'exceeded');
  const warnCaps = (overview?.caps ?? []).filter((c) => c.rule.enabled && c.level === 'warn');

  const enabledAgents = (overview?.agents ?? []).filter((a) => a.enabled);
  const disabledAgents = (overview?.agents ?? []).filter((a) => !a.enabled);

  return (
    <main className="main">
      <header className="main-head">
        <h1>监控</h1>
        <div className="monitor-head-acts">
          {overview ? <span className="monitor-updated">更新于 {clock(overview.generatedAt)}</span> : null}
          <button type="button" className="btn" disabled={loading || refreshing} onClick={() => void load(true)}>
            <Icon name="refresh" />{refreshing ? '刷新中…' : '刷新'}
          </button>
        </div>
      </header>
      <div className="content-scroll">
        <div className={'page monitor-page' + (refreshing ? ' refetch' : '')}>
          {loading && !overview ? (
            <div className="empty"><p>正在读取调用账本与监控状态…</p></div>
          ) : null}
          {error ? <ErrorNotice error={error} onRetry={() => void load(!!overview)} /> : null}

          {overview ? (
            <>
              {/* 顶部预警/达限横幅 */}
              {overview.capAlertLevel === 'exceeded' ? (
                <div className="monitor-banner exceeded" role="alert">
                  <Icon name="warn" />
                  <div className="monitor-banner-body">
                    <strong>已触及花费或 Token 上限（{exceededCaps.length} 条规则达 100%）</strong>
                    <p>
                      {exceededCaps.some((c) => c.blockingManual)
                        ? '已暂停对应范围内的全部新回合（含手动消息），正在运行中的回合不会被中途打断。'
                        : '已自动暂停后台无人值守任务，你亲手发送的消息不受影响；正在运行中的回合不会被中途打断。'}
                    </p>
                  </div>
                </div>
              ) : overview.capAlertLevel === 'warn' ? (
                <div className="monitor-banner warn" role="status">
                  <Icon name="warn" />
                  <div className="monitor-banner-body">
                    <strong>接近花费或 Token 上限（{warnCaps.length} 条规则已达 80%）</strong>
                    <p>当前尚未拦截任何任务，你可以提前检查近期消耗，或在下方调高上限。</p>
                  </div>
                </div>
              ) : null}

              {/* 1. 概览四格 */}
              <section className="monitor-tiles" aria-label="工作台实时概览">
                <div className="monitor-tile">
                  <div className="monitor-tile-k">运行中任务</div>
                  <div className="monitor-tile-v">{overview.counts.runningTasks}</div>
                  <div className="monitor-tile-sub">
                    {overview.counts.queuedTasks > 0 ? `排队中 ${overview.counts.queuedTasks} 个` : '当前没有排队任务'}
                  </div>
                </div>

                <div className={'monitor-tile' + (overview.counts.pendingApprovals > 0 ? ' attn' : '')}>
                  <div className="monitor-tile-k">等你处理</div>
                  <div className="monitor-tile-v">{overview.counts.pendingApprovals}</div>
                  <div className="monitor-tile-sub">
                    {overview.counts.pendingApprovals > 0 ? (
                      <button type="button" className="btn xs" onClick={jumpToFirstApproval}>去处理</button>
                    ) : '没有待确认审批'}
                  </div>
                </div>

                <div className={'monitor-tile' + (overview.counts.todayFailedEvents > 0 ? ' bad' : '')}>
                  <div className="monitor-tile-k">今日异常</div>
                  <div className="monitor-tile-v">{overview.counts.todayFailedEvents}</div>
                  <div className="monitor-tile-sub">统计今日执行错误，不含上限提醒</div>
                </div>

                <div className="monitor-tile">
                  <div className="monitor-tile-k">今日消耗</div>
                  <div className="monitor-tile-v">
                    {overview.today.turns === 0 ? '0' : (todayTokens !== null ? formatTokens(todayTokens) : '未报告')}
                  </div>
                  <div className="monitor-tile-sub">
                    {todayCostText ? `已报告费用 ${todayCostText}` : '未报告金额（订阅制不估价）'}
                  </div>
                </div>
              </section>

              {/* 2. 花费与 Token 上限阀门 */}
              <section className="set-sec monitor-section" aria-label="花费与 Token 上限">
                <div className="monitor-sec-head">
                  <div>
                    <h3>花费与 Token 上限</h3>
                    <p className="monitor-lead">按自然日或自然月自动累计。到达 80% 时黄色提醒；到达 100% 时默认仅暂停后台无人值守任务，不中断运行中的回合。</p>
                  </div>
                  <button type="button" className="btn primary" disabled={remote || savingCap} onClick={openNewCap}>
                    <Icon name="plus" />新增上限
                  </button>
                </div>

                {remote ? (
                  <p className="monitor-remote-note" role="status">
                    请到运行 AI Console 的电脑上操作（修改花费与 Token 上限仅限本机）。
                  </p>
                ) : null}

                {overview.caps.length === 0 && !editing ? (
                  <div className="monitor-empty-inline">
                    还没有设置上限规则。点击右上角“新增上限”即可为全工作台或单个 Agent 设定每日/每月阀门。
                  </div>
                ) : null}

                {overview.caps.length > 0 ? (
                  <div className="monitor-cap-list">
                    {overview.caps.map((ev) => {
                      const status = capStatusInfo(ev);
                      const tokenPct = ev.tokenRatio !== null ? Math.min(100, Math.round(ev.tokenRatio * 100)) : null;
                      const costPct = ev.costRatio !== null ? Math.min(100, Math.round(ev.costRatio * 100)) : null;
                      const tokenCls = ev.rule.enabled && ev.tokenRatio !== null ? (ev.tokenRatio >= 1 ? ' over' : ev.tokenRatio >= 0.8 ? ' hot' : '') : '';
                      const costCls = ev.rule.enabled && ev.costRatio !== null ? (ev.costRatio >= 1 ? ' over' : ev.costRatio >= 0.8 ? ' hot' : '') : '';
                      return (
                        <div className={'monitor-cap-card' + (!ev.rule.enabled ? ' off' : '')} key={ev.rule.id}>
                          <div className="monitor-cap-top">
                            <div className="monitor-cap-title">
                              <strong>{capScopeLabel(ev, agentNames)} · {ev.rule.period === 'daily' ? '每日' : '每月'}</strong>
                              <span className={'monitor-pill ' + status.cls}>{status.label}</span>
                              <span className="monitor-pill neutral">
                                {ev.rule.enforcement === 'block_all' ? '达限拦全部' : '达限仅拦无人值守'}
                              </span>
                            </div>
                            <div className="monitor-cap-acts">
                              <button
                                type="button"
                                className="switch"
                                role="switch"
                                aria-checked={ev.rule.enabled}
                                aria-label={ev.rule.enabled ? '暂停此上限规则' : '启用此上限规则'}
                                disabled={remote || savingCap}
                                onClick={() => void toggleCap(ev)}
                              />
                              <button type="button" className="btn xs" disabled={remote || savingCap} onClick={() => openEditCap(ev)}>编辑</button>
                              <button type="button" className="btn xs danger" disabled={remote || savingCap} onClick={() => void removeCap(ev)}>删除</button>
                            </div>
                          </div>

                          {ev.rule.maxTokens !== null ? (
                            <div className="monitor-cap-metric">
                              <div className="monitor-cap-row">
                                <span>Token 用量</span>
                                <span className="mono">
                                  {ev.usedTokens.toLocaleString('en-US')} / {ev.rule.maxTokens.toLocaleString('en-US')}
                                  {ev.tokenRatio !== null ? `（${Math.round(ev.tokenRatio * 100)}%）` : ''}
                                </span>
                              </div>
                              <div className={'meter' + tokenCls} aria-label={`Token 已用 ${tokenPct ?? 0}%`}>
                                <i style={{ width: `${tokenPct ?? 0}%` }} />
                              </div>
                            </div>
                          ) : null}

                          {ev.rule.maxCostMicros !== null ? (
                            <div className="monitor-cap-metric">
                              <div className="monitor-cap-row">
                                <span>已报告费用（{ev.rule.currency}）</span>
                                <span className="mono">
                                  {ev.usedCostMicros !== null
                                    ? `${formatMoney(ev.rule.currency, ev.usedCostMicros)} / ${formatMoney(ev.rule.currency, ev.rule.maxCostMicros)}（${Math.round((ev.costRatio ?? 0) * 100)}%）`
                                    : `暂无已报告费用 / ${formatMoney(ev.rule.currency, ev.rule.maxCostMicros)}`}
                                </span>
                              </div>
                              <div className={'meter' + costCls} aria-label={`费用已用 ${costPct ?? 0}%`}>
                                <i style={{ width: `${costPct ?? 0}%` }} />
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                {editing ? (
                  <form className="monitor-cap-form" onSubmit={(e) => void submitCap(e)}>
                    <h4>{editing.id ? '编辑上限规则' : '新增上限规则'}</h4>
                    <div className="monitor-form-grid">
                      <label>
                        <span>生效范围</span>
                        <select
                          value={editing.scope}
                          disabled={remote || savingCap}
                          onChange={(e) => setEditing({ ...editing, scope: e.target.value as CapScope })}
                        >
                          <option value="global">全工作台</option>
                          <option value="agent">单个 Agent</option>
                        </select>
                      </label>

                      {editing.scope === 'agent' ? (
                        <label>
                          <span>选择 Agent</span>
                          <select
                            value={editing.agent}
                            disabled={remote || savingCap}
                            onChange={(e) => setEditing({ ...editing, agent: e.target.value as AgentKind })}
                          >
                            {(overview.agents.length ? overview.agents : [{ kind: 'fake' as AgentKind, displayName: '演示 Agent' }]).map((a) => (
                              <option key={a.kind} value={a.kind}>{a.displayName}</option>
                            ))}
                          </select>
                        </label>
                      ) : null}

                      <label>
                        <span>统计周期</span>
                        <select
                          value={editing.period}
                          disabled={remote || savingCap}
                          onChange={(e) => setEditing({ ...editing, period: e.target.value as CapPeriod })}
                        >
                          <option value="daily">每日（按本地自然日清零）</option>
                          <option value="monthly">每月（按本地自然月清零）</option>
                        </select>
                      </label>

                      <label>
                        <span>Token 上限（留空表示不限）</span>
                        <input
                          type="text"
                          inputMode="numeric"
                          placeholder="例如 200000"
                          value={editing.maxTokensText}
                          disabled={remote || savingCap}
                          onChange={(e) => setEditing({ ...editing, maxTokensText: e.target.value })}
                        />
                      </label>

                      <label>
                        <span>费用上限（留空表示不限）</span>
                        <div className="monitor-money-input">
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="例如 5.00"
                            value={editing.maxCostText}
                            disabled={remote || savingCap}
                            onChange={(e) => setEditing({ ...editing, maxCostText: e.target.value })}
                          />
                          <select
                            aria-label="费用币种"
                            value={editing.currency}
                            disabled={remote || savingCap}
                            onChange={(e) => setEditing({ ...editing, currency: e.target.value })}
                          >
                            {CURRENCY_OPTIONS.map((cur) => <option key={cur} value={cur}>{cur}</option>)}
                          </select>
                        </div>
                      </label>

                      <label className="monitor-form-wide">
                        <span>达到 100% 后的动作</span>
                        <select
                          value={editing.enforcement}
                          disabled={remote || savingCap}
                          onChange={(e) => setEditing({ ...editing, enforcement: e.target.value as CapEnforcement })}
                        >
                          <option value="block_unattended">仅拦截后台无人值守任务（推荐，你亲手发的消息不受影响）</option>
                          <option value="block_all">拦截全部新回合（含手动消息）</option>
                        </select>
                      </label>
                    </div>
                    {formError ? <p className="monitor-form-err" role="alert">{formError}</p> : null}
                    <div className="monitor-form-acts">
                      <button type="submit" className="btn primary" disabled={remote || savingCap}>
                        {savingCap ? '保存中…' : '保存上限'}
                      </button>
                      <button type="button" className="btn" disabled={savingCap} onClick={() => { setEditing(null); setFormError(null); }}>
                        取消
                      </button>
                    </div>
                  </form>
                ) : null}
              </section>

              {/* 3. 近 7 天用量趋势与明细 */}
              <section className="set-sec monitor-section" aria-label="调用账本与近 7 天趋势">
                <div className="monitor-sec-head">
                  <div>
                    <h3>近 7 天用量趋势与账本</h3>
                    <p className="monitor-lead">只展示 Agent 与模型真实报告的 Token 及金额；订阅制或未上报单价的模型不会猜测花费。</p>
                  </div>
                  <div className="monitor-toggles">
                    <div className="seg" role="group" aria-label="统计维度">
                      <button type="button" aria-pressed={groupBy === 'agent'} onClick={() => setGroupBy('agent')}>按 Agent</button>
                      <button type="button" aria-pressed={groupBy === 'project'} onClick={() => setGroupBy('project')}>按项目</button>
                    </div>
                    <div className="seg" role="group" aria-label="展示形式">
                      <button type="button" aria-pressed={viewMode === 'chart'} onClick={() => setViewMode('chart')}>图表</button>
                      <button type="button" aria-pressed={viewMode === 'table'} onClick={() => setViewMode('table')}>表格</button>
                    </div>
                  </div>
                </div>

                {!hasAnyUsage ? (
                  <div className="monitor-empty-inline">
                    <strong>还没有调用记录</strong>
                    <p>派发任务并完成至少一轮对话后，这里会自动汇总 Token 消耗、近 7 天趋势与已报告费用。</p>
                  </div>
                ) : (
                  <>
                    {viewMode === 'chart' ? (
                      <div className="viz monitor-chart-box">
                        <svg
                          viewBox="0 0 640 184"
                          className="monitor-svg"
                          role="img"
                          aria-label={`近 7 天${groupBy === 'agent' ? '按 Agent' : '按项目'} Token 消耗趋势图`}
                        >
                          {[0, 0.5, 1].map((frac) => {
                            const y = 148 - frac * 124;
                            const val = Math.round(chartModel.maxDay * frac);
                            return (
                              <g key={frac}>
                                <line x1="56" y1={y} x2="624" y2={y} className="monitor-grid-line" />
                                <text x="48" y={y + 4} textAnchor="end" className="monitor-axis-label">
                                  {formatTokens(val)}
                                </text>
                              </g>
                            );
                          })}
                          {chartModel.days.map((day, idx) => {
                            const slotW = (624 - 56) / Math.max(1, chartModel.days.length);
                            const barW = Math.min(44, slotW * 0.56);
                            const x = 56 + idx * slotW + (slotW - barW) / 2;
                            const bucket = groupBy === 'agent' ? day.byAgent : day.byProject;
                            let yCursor = 148;
                            const segments = chartModel.series.map((s) => {
                              const value = s.key === '__other__'
                                ? Object.entries(bucket).filter(([k]) => !chartModel.primarySet.has(k)).reduce((sum, [, v]) => sum + v, 0)
                                : (bucket[s.key] ?? 0);
                              const h = value > 0 ? Math.max(2, (value / chartModel.maxDay) * 124) : 0;
                              const segY = yCursor - h;
                              yCursor = segY;
                              return { ...s, value, h, segY };
                            }).filter((seg) => seg.h > 0);
                            return (
                              <g key={day.date}>
                                {segments.map((seg) => (
                                  <rect
                                    key={seg.key}
                                    x={x}
                                    y={seg.segY}
                                    width={barW}
                                    height={seg.h}
                                    rx={2}
                                    fill={seg.color}
                                  >
                                    <title>{`${day.date} · ${seg.label}：${seg.value.toLocaleString('en-US')} Token`}</title>
                                  </rect>
                                ))}
                                <text x={x + barW / 2} y="168" textAnchor="middle" className="monitor-axis-label">
                                  {day.date.slice(5)}
                                </text>
                              </g>
                            );
                          })}
                        </svg>
                        {chartModel.series.length > 0 ? (
                          <div className="monitor-legend">
                            {chartModel.series.map((s) => (
                              <span key={s.key} className="monitor-legend-item">
                                <i style={{ background: s.color }} />
                                {s.label}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="monitor-table-wrap">
                        <table className="monitor-table">
                          <thead>
                            <tr>
                              <th>日期</th>
                              <th className="num">总 Token</th>
                              <th className="num">回合数</th>
                              <th className="num">执行异常</th>
                            </tr>
                          </thead>
                          <tbody>
                            {chartModel.days.map((d) => (
                              <tr key={d.date}>
                                <td className="mono">{d.date}</td>
                                <td className="num mono">{d.totalTokens.toLocaleString('en-US')}</td>
                                <td className="num mono">{d.turns}</td>
                                <td className="num mono">{d.failedEvents}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}

                    {/* 今日 / 本月账本明细 */}
                    <div className="monitor-subhead">
                      <h4>{groupBy === 'agent' ? '按 Agent 明细' : '按项目明细'}</h4>
                      <div className="seg" role="group" aria-label="明细时间范围">
                        <button type="button" aria-pressed={periodTab === 'today'} onClick={() => setPeriodTab('today')}>今日</button>
                        <button type="button" aria-pressed={periodTab === 'month'} onClick={() => setPeriodTab('month')}>本月</button>
                      </div>
                    </div>

                    {breakdownRows.length === 0 ? (
                      <div className="monitor-empty-inline">当前所选时间范围内暂无用量记录。</div>
                    ) : (
                      <div className="monitor-table-wrap">
                        <table className="monitor-table">
                          <thead>
                            <tr>
                              <th>{groupBy === 'agent' ? 'Agent' : '项目'}</th>
                              <th className="num">任务数</th>
                              <th className="num">回合数</th>
                              <th className="num">总 Token</th>
                              <th className="num">输入 / 输出</th>
                              <th className="num">已报告费用</th>
                            </tr>
                          </thead>
                          <tbody>
                            {breakdownRows.map((item) => {
                              const costStr = formatReportedCosts(item.usage.reportedCosts);
                              return (
                                <tr key={item.key}>
                                  <td><strong>{item.label}</strong></td>
                                  <td className="num mono">{item.tasks}</td>
                                  <td className="num mono">{item.usage.turns}</td>
                                  <td className={'num mono' + (item.usage.totalTokens === null ? ' na' : '')}>
                                    {formatTokens(item.usage.totalTokens)}
                                  </td>
                                  <td className="num mono">
                                    <span className={item.usage.inputTokens === null ? 'na' : ''}>{formatTokens(item.usage.inputTokens)}</span>
                                    {' / '}
                                    <span className={item.usage.outputTokens === null ? 'na' : ''}>{formatTokens(item.usage.outputTokens)}</span>
                                  </td>
                                  <td className={'num mono' + (!costStr ? ' na' : '')}>
                                    {costStr ?? '未报告'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}
              </section>

              {/* 4. Agent 状态与异常 */}
              <section className="set-sec monitor-section" aria-label="Agent 健康状态与异常">
                <div className="monitor-sec-head">
                  <div>
                    <h3>Agent 状态与异常</h3>
                    <p className="monitor-lead">查看各 Agent 当前可用性、并发占用及近 7 天报错摘要。</p>
                  </div>
                </div>
                <div className="monitor-table-wrap">
                  <table className="monitor-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>状态</th>
                        <th className="num">会话 / 上限</th>
                        <th className="num">今日 Token</th>
                        <th className="num">本月 Token</th>
                        <th>近 7 天异常</th>
                        <th className="num">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...enabledAgents, ...disabledAgents].map((agent) => {
                        const st = agentStatusInfo(agent);
                        const actionLabel = agent.quickAction === 'login' ? '去登录' : agent.quickAction === 'test' ? '去测试' : '去管理';
                        const actionDisabled = remote && (agent.quickAction === 'login' || agent.quickAction === 'test');
                        const todayAgentTokens = effectiveSummaryTokens(agent.todayUsage);
                        const monthAgentTokens = effectiveSummaryTokens(agent.monthUsage);
                        const todayUnreported = agent.todayUsage.turns > 0 && todayAgentTokens === null;
                        const monthUnreported = agent.monthUsage.turns > 0 && monthAgentTokens === null;
                        return (
                          <tr key={agent.kind} className={!agent.enabled ? 'is-off' : undefined}>
                            <td><strong>{agent.displayName}</strong></td>
                            <td>
                              <span className={'monitor-status ' + st.cls}>
                                <span aria-hidden="true">{st.mark}</span> {st.label}
                              </span>
                            </td>
                            <td className="num mono">
                              {agent.concurrencyLimit !== null ? `${agent.runningSessions} / ${agent.concurrencyLimit}` : String(agent.runningSessions)}
                            </td>
                            <td className={'num mono' + (todayUnreported ? ' na' : '')}>
                              {agent.todayUsage.turns === 0 ? '0' : formatTokens(todayAgentTokens)}
                            </td>
                            <td className={'num mono' + (monthUnreported ? ' na' : '')}>
                              {agent.monthUsage.turns === 0 ? '0' : formatTokens(monthAgentTokens)}
                            </td>
                            <td className="monitor-err-cell">
                              {agent.recentFailureCount > 0 ? (
                                <span>
                                  <strong className="bad-text">{agent.recentFailureCount} 次</strong>
                                  {agent.lastError ? ` · ${agent.lastError.message}` : ''}
                                </span>
                              ) : <span className="na">无异常</span>}
                            </td>
                            <td className="num">
                              <button
                                type="button"
                                className="btn xs"
                                disabled={actionDisabled}
                                title={actionDisabled ? '请到运行 AI Console 的电脑上操作' : undefined}
                                onClick={() => runAgentAction(agent)}
                              >
                                {actionLabel}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              {/* 5. 最近动态 */}
              <section className="set-sec monitor-section" aria-label="最近动态">
                <div className="monitor-sec-head">
                  <div>
                    <h3>最近动态</h3>
                    <p className="monitor-lead">聚合近期执行错误、上限拦截、审批超时与会话提醒。</p>
                  </div>
                  <div className="seg" role="group" aria-label="筛选动态类型">
                    <button type="button" aria-pressed={eventFilter === 'all'} onClick={() => setEventFilter('all')}>全部</button>
                    <button type="button" aria-pressed={eventFilter === 'error'} onClick={() => setEventFilter('error')}>仅异常</button>
                    <button type="button" aria-pressed={eventFilter === 'cap_approval'} onClick={() => setEventFilter('cap_approval')}>上限与审批</button>
                  </div>
                </div>
                {filteredEvents.length === 0 ? (
                  <div className="monitor-empty-inline">目前没有需要关注的异常或提醒记录。</div>
                ) : (
                  <ul className="monitor-events">
                    {filteredEvents.map((ev) => (
                      <li key={ev.seq} className={'monitor-event ' + ev.severity}>
                        <span className="monitor-event-tag">
                          {ev.kind === 'cap' ? '上限' : ev.kind === 'approval' ? '审批' : ev.kind === 'session' ? '会话' : '异常'}
                        </span>
                        <div className="monitor-event-body">
                          <div className="monitor-event-msg">{ev.message}</div>
                          <div className="monitor-event-meta">
                            <span>{clock(ev.ts)}</span>
                            {ev.agent ? <span>{agentNames.get(ev.agent) ?? agentFallback[ev.agent]?.name ?? ev.agent}</span> : null}
                            {ev.taskId ? (
                              <a href={`#/t/${encodeURIComponent(ev.taskId)}`} className="monitor-event-link">
                                {ev.taskTitle || '查看任务'}
                              </a>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}
