import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  CreateIndependentServiceBody, CreateIndependentModelBody, FeatureKey,
  type IndependentCapabilityField, type IndependentDefault, type IndependentModel, type IndependentService,
} from '@aic/protocol';
import { api, useApp } from '../state/app';
import { ApiRequestError } from '../api/http';
import { Dialog, ErrorNotice, asApiError, confirmDialog, openDialog } from '../components/ui';
import { toast } from '../state/ui';
import { capabilityKinds, capabilityLabels, capabilityText, evidenceApplies, latestRequest, overridePatch, sourceLabels } from '../lib/independent';
import { IndependentDiscoveryDialog } from './independent-discovery-dialog';

const protocolLabels = { chat_completions: 'Chat Completions', responses: 'Responses', anthropic_messages: 'Anthropic Messages' };

export function IndependentAgentPanel() {
  const available = useApp((s) => !!s.hello?.features[FeatureKey.IndependentCatalog]);
  const discovery = useApp((s) => !!s.hello?.features[FeatureKey.IndependentDiscovery]);
  const version = useApp((s) => s.independentCatalogVersion);
  const conn = useApp((s) => s.conn);
  const [snapshot, setSnapshot] = useState<{ services: IndependentService[]; models: Record<string, IndependentModel[]>; selection: IndependentDefault['selection'] } | null>(null);
  const [error, setError] = useState<ReturnType<typeof asApiError> | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const requests = useRef(latestRequest());
  const refresh = async () => {
    const id = requests.current.begin(); setLoading(true);
    try {
      const [services, def] = await Promise.all([api.independentServices(), api.independentDefault()]);
      const lists = await Promise.all(services.map(async (s) => [s.id, await api.independentModels(s.id)] as const));
      if (requests.current.current(id)) { setSnapshot({ services, models: Object.fromEntries(lists), selection: def.selection }); setError(null); }
    } catch (e) { if (requests.current.current(id)) setError(asApiError(e)); }
    finally { if (requests.current.current(id)) setLoading(false); }
  };
  useEffect(() => {
    if (available) void refresh();
    return () => requests.current.invalidate();
  }, [available, version, conn]);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return; setBusy(true);
    try { await fn(); toast('已保存独立 Agent 配置'); await refresh(); }
    catch (e) { setError(asApiError(e)); } finally { setBusy(false); }
  };
  const serviceDialog = (service?: IndependentService) => openDialog((close) => <ServiceDialog initial={service} close={close} saved={refresh} />);
  const modelDialog = (service: IndependentService, model?: IndependentModel) => openDialog((close) => <ModelDialog service={service} initial={model} close={close} saved={refresh} />);
  const selectedService = snapshot?.services.find((s) => s.id === snapshot.selection?.serviceId);
  const selectedModel = selectedService ? snapshot?.models[selectedService.id]?.find((m) => m.id === snapshot.selection?.modelId) : null;
  return <section className="independent-panel" aria-labelledby="independent-title">
    <div className="independent-heading"><div><h2 id="independent-title">工作台独立 Agent</h2><p>自己的 API 服务与模型目录，可添加多个服务，每个服务保留多个模型。</p></div>
    <span className="tag">支持独立任务 · 待真实补验</span></div>
    <p className="muted">可管理配置、获取模型与能力、手动修订和设置默认值。新建任务中选择“AI Console 独立 Agent”，填写模型、上下文与请求预算后派发。“刷新已保存目录”只读取工作台资料，在线获取需进入服务后明确操作。</p>
    {!available ? <p role="status">当前 Gateway 未提供独立模型目录，请更新服务后刷新页面。</p> : <>
      <div className="independent-actions"><button className="btn primary" onClick={() => serviceDialog()}>添加 API 服务</button>
        <button className="btn" disabled={loading} onClick={() => void refresh()}>{loading ? '正在读取…' : '刷新已保存目录'}</button></div>
      {error ? <ErrorNotice error={error} /> : null}
      <p role="status">默认模型：{selectedService && selectedModel ? `${selectedService.name} / ${selectedModel.name}${!selectedService.enabled || !selectedModel.enabled ? '（已停用）' : ''}` : snapshot?.selection ? '目录尚未读取完整' : '尚未设置'}
        {snapshot?.selection ? <button className="btn ghost" disabled={busy} onClick={() => void run(() => api.putIndependentDefault({ selection: null }))}>清空默认值</button> : null}</p>
      {!snapshot && loading ? <p role="status">正在读取服务与模型…</p> : snapshot && !snapshot.services.length ? <div className="cards-empty">还没有 API 服务。添加后可以在服务下继续添加模型。</div> : null}
      {snapshot?.services.map((service) => <details className="independent-service" key={service.id}>
        <summary><strong>{service.name}</strong><span>{protocolLabels[service.protocol]} · {snapshot.models[service.id]?.length ?? 0} 个模型 · {service.enabled ? '已启用' : '已停用'}</span></summary>
        <div className="independent-service-body">
          <p className="mono independent-url">{service.baseUrl}</p>
          <p className="muted">{service.authentication === 'none' ? '明确使用无认证服务' : service.hasSecret ? `密钥已加密保存在工作台 · 结尾 …${service.secretHint ?? ''}` : '尚未保存密钥，不能运行'} · 配置修订 {service.configRevision}</p>
          <div className="independent-actions"><button className="btn" onClick={() => serviceDialog(service)}>编辑服务</button>
            <button className="btn" onClick={() => modelDialog(service)}>添加模型</button>
            {discovery ? <button className="btn" disabled={!service.enabled} onClick={() => openDialog((close) => <IndependentDiscoveryDialog initialService={service} close={close} saved={refresh} />)}>获取模型与能力</button> : null}
            <button className="btn" disabled={busy} onClick={() => void run(() => api.patchIndependentService(service.id, { expectedRevision: service.revision, enabled: !service.enabled }))}>{service.enabled ? '停用服务' : '启用服务'}</button>
            <button className="btn danger" disabled={busy} onClick={async () => {
              if (await confirmDialog({ title: `删除“${service.name}”？`, body: <p>会删除本服务的模型和工作台保存的密钥。若有任务绑定，服务端会拒绝删除。不会选择其他默认模型。</p>, ok: '删除服务', danger: true })) void run(() => api.deleteIndependentService(service.id));
            }}>删除服务</button></div>
          {!snapshot.models[service.id]?.length ? <p className="muted">还没有模型。请使用服务提供的原始模型 ID 手动添加；不会从名字猜测能力。</p> : null}
          {snapshot.models[service.id]?.map((model) => <article className="independent-model" key={model.id} aria-label={`模型 ${model.name}`}>
            <div className="independent-heading"><div><h3>{model.name}</h3><code>{model.remoteModelId}</code></div><span>{model.enabled ? '已启用' : '已停用'}{snapshot.selection?.modelId === model.id ? ' · 默认模型' : ''}</span></div>
            <dl className="independent-summary">{(['contextWindow', 'imageInput', 'tools', 'effortLevels'] as const).map((field) => {
              const cap = model.capabilities.find((c) => c.field === field);
              return <div key={field}><dt>{capabilityLabels[field]}</dt><dd>{capabilityText(cap?.value ?? null)}{cap?.conflict ? ' · 来源冲突' : ''}{cap?.stale ? ' · 来源过期或配置变更' : ''}</dd></div>;
            })}</dl>
            <div className="independent-actions"><button className="btn" onClick={() => openDialog((close) => <CapabilitiesDialog service={service} initial={model} close={close} saved={refresh} />)}>能力与来源</button>
              <button className="btn" onClick={() => modelDialog(service, model)}>编辑模型</button>
              <button className="btn" disabled={busy || !service.enabled || !model.enabled || snapshot.selection?.modelId === model.id} onClick={() => void run(() => api.putIndependentDefault({ selection: { serviceId: service.id, modelId: model.id } }))}>设为默认</button>
              <button className="btn" disabled={busy} onClick={() => void run(() => api.patchIndependentModel(service.id, model.id, { expectedRevision: model.revision, enabled: !model.enabled }))}>{model.enabled ? '停用模型' : '启用模型'}</button>
              <button className="btn danger" disabled={busy} onClick={async () => {
                if (await confirmDialog({ title: `删除模型“${model.name}”？`, body: <p>仅删除当前服务下的此模型和能力记录。若它是默认模型，会清空默认值；有任务绑定时不能删除。</p>, ok: '删除模型', danger: true })) void run(() => api.deleteIndependentModel(service.id, model.id));
              }}>删除模型</button></div>
          </article>)}
        </div>
      </details>)}
    </>}
  </section>;
}

/** 不自动重试写入；冲突时保留表单，由用户明确放弃输入后载入最新版本。 */
function useWrite() {
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [conflict, setConflict] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    if (busy) return; setBusy(true); setError(null);
    try { await fn(); setConflict(false); }
    catch (e) { setError(e instanceof ApiRequestError ? e.error.message : e instanceof Error ? e.message : '保存失败，请重试'); setConflict(e instanceof ApiRequestError && e.status === 409); }
    finally { setBusy(false); }
  };
  return { busy, error, conflict, run };
}
function WriteDialog({ title, close, write, submit, reload, children, initialFocus = 'input' }: {
  title: string; close: () => void; write: ReturnType<typeof useWrite>; submit: () => Promise<void>; reload?: () => Promise<void>; children: ReactNode; initialFocus?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (write.error && !write.busy) errorRef.current?.focus(); }, [write.error, write.busy]);
  return <Dialog title={title} onClose={() => { if (!write.busy) close(); }} wide initialFocus={initialFocus}
    footer={<><button className="btn" disabled={write.busy} onClick={close}>取消</button>
      {write.conflict && reload ? <button className="btn" disabled={write.busy} onClick={() => void write.run(reload)}>放弃输入并载入最新版本</button> : null}
      <button className="btn primary" disabled={write.busy || write.conflict} aria-busy={write.busy} onClick={() => form.current?.requestSubmit()}>{write.busy ? '正在保存…' : '保存'}</button></>}>
    <form ref={form} autoComplete="off" onSubmit={(e) => { e.preventDefault(); if (!write.conflict) void write.run(submit); }}>
      {write.error ? <p ref={errorRef} tabIndex={-1} className="form-problem" role="alert">{write.error}{write.conflict ? '。配置已经变化，输入仍保留。请核对后载入最新版本，再重新编辑。' : ''}</p> : null}
      <fieldset className="independent-fieldset" disabled={write.busy}>{children}</fieldset>
      <button type="submit" hidden />
    </form>
  </Dialog>;
}
const emptyService = { name: '', protocol: 'chat_completions' as IndependentService['protocol'], baseUrl: '', authentication: 'api_key' as IndependentService['authentication'], apiVersion: '', providerId: '', plan: '', enabled: true };
function serviceDraft(s?: IndependentService) { return s ? { name: s.name, protocol: s.protocol, baseUrl: s.baseUrl, authentication: s.authentication, apiVersion: s.apiVersion ?? '', providerId: s.providerId ?? '', plan: s.plan ?? '', enabled: s.enabled } : emptyService; }
function ServiceDialog({ initial, close, saved }: { initial?: IndependentService; close: () => void; saved: () => Promise<void> }) {
  const [service, setService] = useState(initial); const [draft, setDraft] = useState(serviceDraft(initial));
  const [key, setKey] = useState(''); const [clearKey, setClearKey] = useState(false); const write = useWrite();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const validateField = (field: 'name' | 'baseUrl' | 'apiKey', value: string) => {
    const valid = field === 'apiKey' && !value || CreateIndependentServiceBody.shape[field].safeParse(field === 'apiKey' ? value : value.trim()).success;
    const message = field === 'name' ? '请填写 1～100 个字符的服务名称' : field === 'apiKey' ? '密钥须为 8～8192 个字符，不含空白或控制字符' : '请填写 HTTPS 基础地址（本机可用 HTTP），不含用户信息、查询或片段';
    setFieldErrors((s) => ({ ...s, [field]: valid ? '' : message }));
  };
  const submit = async () => {
    if (key && clearKey) throw new Error('请在填写新密钥与清除旧密钥之间选择一项');
    if (draft.authentication === 'none' && key) throw new Error('无认证服务不能同时填写密钥，请清空新密钥输入');
    if (draft.authentication === 'none' && service?.hasSecret && !clearKey) throw new Error('改为无认证会删除旧密钥，请先勾选确认清除');
    const parsed = CreateIndependentServiceBody.safeParse({ ...draft, name: draft.name.trim(), baseUrl: draft.baseUrl.trim(), apiVersion: draft.apiVersion.trim() || null, providerId: draft.providerId.trim() || null, plan: draft.plan.trim() || null, ...(key ? { apiKey: key } : {}) });
    if (!parsed.success) {
      const field = String(parsed.error.issues[0]?.path[0] ?? '');
      throw new Error(field === 'baseUrl' ? 'API 基础地址：须为 HTTPS（本机可用 HTTP），不能含用户名、密码、查询或片段'
        : field === 'apiKey' ? '密钥：至少 8 个字符，最多 8192 个字符，且不含空白或控制字符'
        : field === 'name' ? '服务名称：请填写 1～100 个字符' : '请检查服务表单，各项高级信息最多 100 个字符');
    }
    if (service) await api.patchIndependentService(service.id, { ...parsed.data, expectedRevision: service.revision, ...(clearKey ? { apiKey: null } : {}) });
    else await api.createIndependentService(parsed.data);
    setKey(''); close(); toast('服务已保存'); await saved();
  };
  const reload = service ? async () => { const fresh = await api.independentService(service.id); setService(fresh); setDraft(serviceDraft(fresh)); setKey(''); setClearKey(false); setFieldErrors({}); } : undefined;
  return <WriteDialog title={service ? '编辑 API 服务' : '添加 API 服务'} close={close} write={write} submit={submit} reload={reload}>
    <p>此配置归工作台独立 Agent 管理。保存不会发起连接或模型请求。</p>
    <div className="form-row"><label htmlFor="is-name">服务名称</label><input className="input" id="is-name" required maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} onBlur={(e) => validateField('name', e.target.value)} aria-invalid={!!fieldErrors.name} aria-describedby="is-name-error" /></div>
    <p id="is-name-error" className="form-problem">{fieldErrors.name}</p>
    <div className="form-row"><label htmlFor="is-protocol">接口协议</label><select className="select" id="is-protocol" value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as typeof draft.protocol })}>{Object.entries(protocolLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
    <div className="form-row"><label htmlFor="is-url">API 基础地址</label><input className="input mono" id="is-url" type="url" required maxLength={2000} placeholder="https://api.example.com/v1" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} onBlur={(e) => validateField('baseUrl', e.target.value)} aria-invalid={!!fieldErrors.baseUrl} aria-describedby="is-url-note is-url-error" /></div>
    <p id="is-url-error" className="form-problem">{fieldErrors.baseUrl}</p>
    <p className="form-note" id="is-url-note">按服务提供方说明填写完整基础地址，工作台不会自动猜测路径。</p>
    <div className="form-row"><label htmlFor="is-auth">鉴权方式</label><select className="select" id="is-auth" value={draft.authentication} onChange={(e) => setDraft({ ...draft, authentication: e.target.value as typeof draft.authentication })}><option value="api_key">API 密钥</option><option value="none">无需认证（明确选择）</option></select></div>
    <div className="form-row"><label htmlFor="is-key">{service ? '新密钥（可选）' : '密钥（可稍后填写）'}</label><input className="input mono" id="is-key" type="password" autoComplete="new-password" maxLength={8192} spellCheck={false} value={key} placeholder={service?.hasSecret ? `留空保留原密钥（结尾 …${service.secretHint ?? ''}）` : '尚未保存密钥'} onChange={(e) => setKey(e.target.value)} onBlur={(e) => validateField('apiKey', e.target.value)} aria-invalid={!!fieldErrors.apiKey} aria-describedby="is-key-note is-key-error" /></div>
    <p id="is-key-error" className="form-problem">{fieldErrors.apiKey}</p>
    <p className="form-note" id="is-key-note">密钥加密保存在工作台，保存后只显示结尾提示。改为无认证会删除已保存的旧密钥，需勾选下方确认清除。</p>
    {service?.hasSecret ? <label className="independent-check"><input type="checkbox" checked={clearKey} onChange={(e) => setClearKey(e.target.checked)} />清除工作台保存的旧密钥</label> : null}
    <details><summary>高级信息（能力识别范围）</summary><p className="form-note">按服务实际情况填写，可留空。修改地址、凭据、协议或这些信息后，旧能力证据会保留供查阅，但不再适用于新配置。</p>
      {(['apiVersion', 'providerId', 'plan'] as const).map((field, i) => <div className="form-row" key={field}><label htmlFor={`is-${field}`}>{['API 版本', '服务商标识', '套餐'][i]}</label><input className="input" id={`is-${field}`} maxLength={100} value={draft[field]} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })} /></div>)}
    </details>
    <label className="independent-check"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />启用服务</label>
  </WriteDialog>;
}
function ModelDialog({ service, initial, close, saved }: { service: IndependentService; initial?: IndependentModel; close: () => void; saved: () => Promise<void> }) {
  const [model, setModel] = useState(initial); const [name, setName] = useState(initial?.name ?? ''); const [remoteId, setRemoteId] = useState(initial?.remoteModelId ?? ''); const write = useWrite();
  const submit = async () => {
    const parsed = CreateIndependentModelBody.safeParse({ name: name.trim(), remoteModelId: remoteId });
    if (!parsed.success) throw new Error('请填写显示名称和原始模型 ID（最多 200 字符）');
    if (model) await api.patchIndependentModel(service.id, model.id, { expectedRevision: model.revision, name: parsed.data.name });
    else await api.createIndependentModel(service.id, parsed.data);
    close(); toast(model ? '模型已保存' : '已添加模型；若 ID 已存在，则保留原条目'); await saved();
  };
  return <WriteDialog title={model ? '编辑模型' : '添加模型'} close={close} write={write} submit={submit} reload={model ? async () => { const fresh = await api.independentModel(service.id, model.id); setModel(fresh); setName(fresh.name); setRemoteId(fresh.remoteModelId); } : undefined}>
    <p>所属服务：{service.name}。添加不会改变已有模型、能力设置或默认选择。</p>
    <div className="form-row"><label htmlFor="im-name">显示名称</label><input className="input" id="im-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></div>
    <div className="form-row"><label htmlFor="im-id">原始模型 ID</label><input className="input mono" id="im-id" required maxLength={200} readOnly={!!model} value={remoteId} onChange={(e) => setRemoteId(e.target.value)} aria-describedby="im-note" /></div>
    <p className="form-note" id="im-note">复制服务提供的原始 ID；不同服务可以使用相同 ID。模型 ID 保存后不可修改，可另加模型；也可在服务中“获取模型与能力”后批量导入。</p>
  </WriteDialog>;
}
function CapabilitiesDialog({ service: initialService, initial, close, saved }: { service: IndependentService; initial: IndependentModel; close: () => void; saved: () => Promise<void> }) {
  const [service, setService] = useState(initialService);
  const [model, setModel] = useState(initial); const [draft, setDraft] = useState<Partial<Record<IndependentCapabilityField, string>>>({}); const write = useWrite();
  const submit = async () => {
    if (!Object.keys(draft).length) { close(); return; }
    const fresh = await api.patchIndependentOverrides(service.id, model.id, { expectedRevision: model.revision, expectedConfigRevision: service.configRevision, values: overridePatch(draft) });
    setModel(fresh); setDraft({}); toast('能力修订已保存'); await saved();
  };
  return <WriteDialog title={`能力与来源：${model.name}`} close={close} write={write} submit={submit} initialFocus="summary" reload={async () => { const [fresh, freshService] = await Promise.all([api.independentModel(service.id, model.id), api.independentService(service.id)]); setService(freshService); setModel(fresh); setDraft({}); }}>
    <p>{service.name} / {model.remoteModelId}。服务中可获取模型与能力并导入来源；未知不会当作不支持。手动设置仅作用于此服务下的此模型。</p>
    <p className="form-note">展开字段可查看来源并修订；“恢复自动”会清除此字段人工值，保存后生效。列表用逗号分隔，[] 表示无可选项；沿用服务原始名称，不预填通用思考强度。</p>
    <div className="independent-capabilities">{(Object.keys(capabilityLabels) as IndependentCapabilityField[]).map((field) => {
      const cap = model.capabilities.find((c) => c.field === field); const evidence = model.evidence.filter((e) => e.field === field);
      const manual = evidence.find((e) => e.kind === 'manual' && evidenceApplies(service, model, e));
      const automatic = draft[field] === '' || (draft[field] === undefined && !manual);
      const input = draft[field] ?? (manual ? Array.isArray(manual.value) ? manual.value.length ? manual.value.join(', ') : '[]' : String(manual.value) : '');
      const kind = capabilityKinds[field]; const id = `ic-${field}`;
      return <details key={field} className="independent-capability"><summary><strong>{capabilityLabels[field]}</strong><span>{capabilityText(cap?.value ?? null)} · {cap?.sourceKind ? sourceLabels[cap.sourceKind] : '无已知来源'}{cap?.conflict ? ' · 来源冲突' : ''}{cap?.stale ? ' · 已过期或配置已变更' : ''}{draft[field] !== undefined ? ' · 待保存' : ''}</span></summary>
        <div className="independent-capability-body"><div className="form-row"><label htmlFor={id}>手动设置</label>
          {kind === 'flag' ? <select className="select" id={id} value={input} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}><option value="">自动（无来源时未知）</option><option value="true">支持</option><option value="false">不支持</option></select>
            : <input className="input" id={id} type="text" inputMode={kind === 'number' ? 'numeric' : 'text'} maxLength={kind === 'list' ? 3300 : 100} value={input} placeholder={automatic ? '自动（无来源时未知）' : ''} onChange={(e) => setDraft({ ...draft, [field]: e.target.value })} />}
        </div><button type="button" className="btn" onClick={() => setDraft({ ...draft, [field]: '' })}>恢复自动</button>
        <p className="form-note">{automatic ? '保存后使用自动来源；没有有效来源则未知。' : '保存后人工值优先；后续刷新保留。'}</p>
        {!evidence.length ? <p className="muted">没有来源记录，未验证此能力。</p> : <ul className="independent-evidence">{evidence.map((ev) => <li key={ev.id}>
          <strong>{sourceLabels[ev.kind]}：{capabilityText(ev.value)}</strong>
          <p>{evidenceApplies(service, model, ev) ? '适用当前配置' : '旧配置记录，不再生效'} · 获取 {new Date(ev.observedAt).toLocaleString('zh-CN')}{ev.expiresAt !== null ? ` · 失效 ${new Date(ev.expiresAt).toLocaleString('zh-CN')}` : ' · 未声明失效时间'}</p>
          <p>来源版本 {ev.sourceVersion} · 字段 {ev.fieldPath}</p>
          {ev.sourceUrl ? <p className="mono independent-url">来源：{ev.sourceUrl}</p> : null}
          <p>范围：配置修订 {ev.scope.configRevision} · {protocolLabels[ev.scope.protocol]} · API 版本 {ev.scope.apiVersion ?? '未指定'} · 服务商 {ev.scope.providerId ?? '未指定'} · 套餐 {ev.scope.plan ?? '未指定'} · 模型 {ev.scope.remoteModelId}</p>
        </li>)}</ul>}
        </div></details>;
    })}</div>
  </WriteDialog>;
}
