// 独立任务参数由用户在派发 / 应用配置时确认；能力未知不猜测，预算不隐式清零。
import { useEffect, useId, useState } from 'react';
import { IndependentTaskOptions, type IndependentService, type IndependentModel } from '@aic/protocol';
import { api, useApp } from '../state/app';
import { ErrorNotice, asApiError } from './ui';

const initial = (): IndependentTaskOptions => ({ selection: { serviceId: '', modelId: '' }, generation: {}, context: { mode: 'local', safetyTokens: 1024 },
  limits: { maxModelCalls: 5, maxToolCalls: 10, maxOutputTokens: 4096, timeoutMs: 300_000, maxContextBytes: 1024 * 1024 }, requestBudget: { maxRequests: 10, money: null } });

export function IndependentTaskConfig({ initialOptions, initialModelId, onChange, disabled = false }: {
  initialOptions?: IndependentTaskOptions; initialModelId?: string; onChange: (value: IndependentTaskOptions | null) => void; disabled?: boolean;
}) {
  const prefix = useId(), version = useApp((s) => s.independentCatalogVersion);
  const [draft, setDraft] = useState(initialOptions ?? initial), [services, setServices] = useState<IndependentService[]>([]);
  const [models, setModels] = useState<IndependentModel[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<ReturnType<typeof asApiError> | null>(null);
  useEffect(() => {
    let live = true; setLoading(true);
    void (async () => {
      const [all, chosen] = await Promise.all([api.independentServices(), api.independentDefault()]);
      const lists = await Promise.all(all.map((s) => api.independentModels(s.id))); if (!live) return;
      const entries = lists.flat(); setServices(all); setModels(entries); setError(null);
      setDraft((old) => {
        if (initialOptions || old.selection.modelId) return old;
        const selected = entries.find((m) => m.id === initialModelId);
        return { ...old, selection: selected ? { serviceId: selected.serviceId, modelId: selected.id } : chosen.selection ?? old.selection };
      });
    })().catch((e) => { if (live) setError(asApiError(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [version]); // 用户已编辑的参数不被后台刷新替换。
  useEffect(() => {
    const selected = models.find((m) => m.id === initialModelId);
    if (selected) setDraft((old) => old.selection.modelId === selected.id ? old : ({ ...old, selection: { serviceId: selected.serviceId, modelId: selected.id }, generation: {} }));
  }, [initialModelId, models, !!initialOptions]);
  const parsed = IndependentTaskOptions.safeParse(draft);
  const service = services.find((s) => s.id === draft.selection.serviceId), model = models.find((m) => m.id === draft.selection.modelId);
  const capability = (field: string) => model?.capabilities.find((c) => c.field === field && !c.stale && !c.conflict)?.value;
  const blockedTools = draft.limits.maxToolCalls > 0 && capability('tools') !== true;
  const usable = !!service?.enabled && !!model?.enabled && model.serviceId === service.id && !blockedTools;
  useEffect(() => { onChange(parsed.success && usable && !loading ? parsed.data : null); }, [draft, usable, loading]);
  const efforts = capability('effortLevels');
  const number = (label: string, value: number | undefined, update: (value: number | undefined) => void, min: number, max: number, optional = false) => {
    const id = prefix + label;
    const invalid = value === undefined ? !optional : !Number.isInteger(value) || value < min || value > max;
    return <div className="form-row" key={label}><label htmlFor={id}>{label}</label><div><input id={id} className="input" type="number" min={min} max={max} step={1}
      value={Number.isNaN(value) ? '' : value ?? ''} placeholder={optional ? '未设置' : undefined} disabled={disabled} aria-invalid={invalid || undefined} aria-describedby={invalid ? id + '-error' : undefined}
      onChange={(e) => update(e.target.value === '' && optional ? undefined : e.target.valueAsNumber)} />{invalid ? <p className="hint attn" id={id + '-error'}>需要 {min}～{max} 的整数</p> : null}</div></div>;
  };
  const limit = (key: keyof IndependentTaskOptions['limits'], label: string, min: number, max: number) => number(label, draft.limits[key],
    (v) => setDraft({ ...draft, limits: { ...draft.limits, [key]: v } }), min, max);
  const context = (key: 'safetyTokens' | 'localInputLimit' | 'imageTokensPerImage', label: string, min: number, max: number) => number(label, draft.context[key],
    (v) => { const next = { ...draft.context }; if (v === undefined) delete next[key]; else next[key] = v; setDraft({ ...draft, context: next }); }, min, max, true);
  return <fieldset className="independent-config" disabled={disabled || loading}>
    <legend>独立 Agent 配置</legend>
    {error ? <ErrorNotice error={error} /> : null}{loading ? <p role="status">正在读取自有服务与模型…</p> : null}
    <div className="form-row"><label htmlFor={prefix + 'service'}>API 服务</label><select id={prefix + 'service'} className="select" value={draft.selection.serviceId}
      onChange={(e) => setDraft({ ...draft, selection: { serviceId: e.target.value, modelId: '' }, generation: {} })}>
      <option value="">请选择服务</option>{services.map((s) => <option key={s.id} value={s.id} disabled={!s.enabled}>{s.name}{s.enabled ? '' : '（已停用）'}</option>)}
    </select></div>
    <div className="form-row"><label htmlFor={prefix + 'model'}>模型</label><select id={prefix + 'model'} className="select" value={draft.selection.modelId}
      onChange={(e) => setDraft({ ...draft, selection: { ...draft.selection, modelId: e.target.value }, generation: {} })}>
      <option value="">请选择模型</option>{models.filter((m) => m.serviceId === draft.selection.serviceId).map((m) => <option key={m.id} value={m.id} disabled={!m.enabled}>{m.name} · {m.remoteModelId}{m.enabled ? '' : '（已停用）'}</option>)}
    </select></div>
    {model ? <p className="hint">总窗口：{String(capability('contextWindow') ?? '未知')}；图片：{capability('imageInput') === true ? '支持' : capability('imageInput') === false ? '不支持' : '未知'}；工具：{capability('tools') === true ? '支持' : capability('tools') === false ? '不支持' : '未知'}。来源、冲突和人工修订可在 Agent 管理中查看。</p> : <p className="hint">先在 Agent 管理中添加 API 与模型。选择服务和模型后才能派发。</p>}
    {model && blockedTools ? <p className="hint attn" role="alert">工具能力未知或不支持。请在 Agent 管理中核对能力，或展开下方配置，将每回合工具次数设为 0。</p> : null}
    <div className="form-row"><label htmlFor={prefix + 'effort'}>思考强度</label><select id={prefix + 'effort'} className="select" value={draft.generation.effort ?? ''}
      onChange={(e) => setDraft({ ...draft, generation: { ...draft.generation, effort: e.target.value || undefined } })}>
      <option value="">不发送该参数</option>{Array.isArray(efforts) && capability('thinking') === true ? efforts.map((x) => <option key={String(x)} value={String(x)}>{String(x)}</option>) : null}
    </select></div>
    <div className="form-row"><label htmlFor={prefix + 'thinking'}>思考开关</label><select id={prefix + 'thinking'} className="select" value={draft.generation.thinking?.mode ?? ''}
      onChange={(e) => setDraft({ ...draft, generation: { ...draft.generation, thinking: e.target.value ? { mode: e.target.value as 'enabled' | 'disabled' } : undefined } })}>
      <option value="">不发送该参数</option><option value="enabled" disabled={service?.protocol !== 'anthropic_messages' || capability('thinking') !== true}>开启</option><option value="disabled" disabled={service?.protocol !== 'anthropic_messages' || capability('thinkingCanDisable') !== true}>关闭</option>
    </select></div>
    {draft.generation.thinking?.mode === 'enabled' ? number('思考 token 预算', draft.generation.thinking.budgetTokens,
      (v) => setDraft({ ...draft, generation: { ...draft.generation, thinking: { mode: 'enabled', ...(v === undefined ? {} : { budgetTokens: v }) } } }), 1024, 10_000_000, true) : null}
    <p className="hint">本任务累计最多 {draft.requestBudget.maxRequests} 次请求；每回合最多 {draft.limits.maxModelCalls} 次模型调用、{draft.limits.maxToolCalls} 次工具调用。{draft.requestBudget.money ? `已设置 ${draft.requestBudget.money.currency} 人工金额预留。` : '未设置金额上限，实际费用未知。'}</p>
    <details><summary>上下文、回合上限与费用预算</summary>
      <p className="hint">以下是本次任务的控制上限，可自行修改。费用始终以供应商账单为准，未知费用显示为未知。</p>
      <div className="form-row"><label htmlFor={prefix + 'stream'}>响应方式</label><select id={prefix + 'stream'} className="select" value={draft.generation.stream === undefined ? '' : String(draft.generation.stream)}
        onChange={(e) => setDraft({ ...draft, generation: { ...draft.generation, stream: e.target.value === '' ? undefined : e.target.value === 'true' } })}>
        <option value="">按已知能力选择</option><option value="true" disabled={capability('streaming') === false}>流式</option><option value="false">完整响应</option></select></div>
      {service?.protocol === 'chat_completions' ? <div className="form-row"><label htmlFor={prefix + 'token-field'}>输出参数</label><select id={prefix + 'token-field'} className="select" value={draft.generation.chatTokenLimitField ?? ''}
        onChange={(e) => setDraft({ ...draft, generation: { ...draft.generation, chatTokenLimitField: e.target.value === '' ? undefined : e.target.value as 'max_tokens' | 'max_completion_tokens' } })}>
        <option value="">默认 max_completion_tokens</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></div> : null}
      <div className="form-row"><label htmlFor={prefix + 'count'}>输入预检</label><select id={prefix + 'count'} className="select" value={draft.context.mode}
        onChange={(e) => setDraft({ ...draft, context: { ...draft.context, mode: e.target.value as 'local' | 'endpoint' } })}>
        <option value="local">本地字节估算（不是精确 tokenizer）</option><option value="endpoint" disabled={service?.protocol === 'chat_completions'}>同服务计数接口（额外请求，可能计费）</option></select></div>
      {context('safetyTokens', '安全余量', 0, 1_000_000)}{context('localInputLimit', '人工输入上限', 1, 1_000_000_000)}{context('imageTokensPerImage', '每张图片估算量', 1, 100_000_000)}
      <p className="hint">模型输入规格未知时可以明确设置人工上限；图片缺少计数或估算依据时停止。不会发送长文本或图片探测极限。</p>
      {limit('maxModelCalls', '每回合模型次数', 1, 100)}{limit('maxToolCalls', '每回合工具次数', 0, 500)}
      {capability('tools') !== true && draft.limits.maxToolCalls > 0 ? <p className="hint attn">工具能力尚未确认，请在 Agent 管理中核对，或将工具次数改为 0。</p> : null}
      {limit('maxOutputTokens', '每回合输出上限', 1, 10_000_000)}{limit('timeoutMs', '每回合时限（毫秒）', 1, 3_600_000)}{limit('maxContextBytes', '会话正文上限（字节）', 1024, 8 * 1024 * 1024)}
      {number('任务请求总上限', draft.requestBudget.maxRequests, (v) => setDraft({ ...draft, requestBudget: { ...draft.requestBudget, maxRequests: v! } }), 1, 1000)}
      <label className="independent-check"><input type="checkbox" checked={draft.requestBudget.money !== null} onChange={(e) => setDraft({ ...draft,
        requestBudget: { ...draft.requestBudget, money: e.target.checked ? { currency: 'CNY', maxReservedMicros: 0, modelCeilingMicros: null, counterCeilingMicros: null } : null } })} />设置人工金额预留（已有请求后不能改变币种或记账方式）</label>
      {draft.requestBudget.money ? <>
        <div className="form-row"><label htmlFor={prefix + 'currency'}>币种</label><input id={prefix + 'currency'} className="input" maxLength={3} value={draft.requestBudget.money.currency}
          onChange={(e) => setDraft({ ...draft, requestBudget: { ...draft.requestBudget, money: { ...draft.requestBudget.money!, currency: e.target.value.toUpperCase() } } })} /></div>
        {(['maxReservedMicros', 'modelCeilingMicros', 'counterCeilingMicros'] as const).map((key, i) => number(['总预留额度（微单位）', '每次生成预留（微单位）', '每次计数预留（微单位）'][i]!, draft.requestBudget.money![key] ?? undefined,
          (v) => setDraft({ ...draft, requestBudget: { ...draft.requestBudget, money: { ...draft.requestBudget.money!, [key]: v ?? null } } }), 0, 1_000_000_000_000, i > 0))}
        <p className="hint">1 元 = 1,000,000 微单位。每次发请求前先占用你填写的预留，失败和中断不退回；每次预留未知时阻止请求。这是人工额度控制，不能保证供应商扣费不超出预留。</p>
      </> : null}
    </details>
    {!parsed.success ? <p className="hint attn" role="alert">请填写有效的服务、模型和上限；数值不能留空或超出范围。</p> : null}
  </fieldset>;
}
