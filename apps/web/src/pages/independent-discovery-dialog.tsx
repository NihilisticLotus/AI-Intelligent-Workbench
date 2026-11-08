import { useEffect, useRef, useState } from 'react';
import { type DiscoverIndependentModelsBody, type IndependentDiscoveryDiagnostics, type IndependentDiscoveryState, type IndependentModel, type IndependentService } from '@aic/protocol';
import { api } from '../state/app';
import { Dialog, ErrorNotice, asApiError } from '../components/ui';
import { capabilityLabels, capabilityText, discoveryParseFailureText, discoveryRootShapeText, latestRequest, sourceLabels } from '../lib/independent';
import { toast } from '../state/ui';
import { ApiRequestError } from '../api/http';

const discoveryStageLabels = {prepare:'检查配置与准备请求',service_request:'读取服务目录',service_parse:'解析服务模型列表',catalog_request:'读取公共目录',snapshot:'核对并保存预览'} satisfies Record<IndependentDiscoveryDiagnostics['stage'],string>;

/** 打开只读取缓存；网络获取和追加导入均需用户明确点击。 */
export function IndependentDiscoveryDialog({ initialService, close, saved }: {initialService:IndependentService;close:()=>void;saved:()=>Promise<void>}) {
  const [service,setService] = useState(initialService); const [models,setModels] = useState<IndependentModel[]>([]);
  const [state,setState] = useState<IndependentDiscoveryState | null>(null); const [query,setQuery] = useState('');
  const [selected,setSelected] = useState<string[]>([]); const [includeCatalog,setIncludeCatalog] = useState(false);
  const [source,setSource] = useState<NonNullable<DiscoverIndependentModelsBody['source']>>('service');
  const [busy,setBusy] = useState(false); const [error,setError] = useState<ReturnType<typeof asApiError> | null>(null);
  const [conflict,setConflict] = useState(false);
  const requests = useRef(latestRequest()); const errorRef = useRef<HTMLDivElement>(null);
  const load = async () => {
    const id=requests.current.begin();setBusy(true);
    try {
      const [fresh,cached,current] = await Promise.all([api.independentService(initialService.id),api.independentDiscovery(initialService.id),api.independentModels(initialService.id)]);
      if(requests.current.current(id)){setService(fresh);setState(cached);setModels(current);setSelected([]);setError(null);setConflict(false);}
    } catch(e){if(requests.current.current(id))setError(asApiError(e));}
    finally {if(requests.current.current(id))setBusy(false);}
  };
  useEffect(()=>{void load();return()=>requests.current.invalidate();},[]);
  useEffect(()=>{if(error&&!busy)errorRef.current?.focus();},[error,busy]);
  const refresh = async () => {
    if(busy)return; const id=requests.current.begin();setBusy(true);setError(null);setSelected([]);
    try {const fresh=await api.discoverIndependentModels(service.id,{expectedConfigRevision:service.configRevision,includeCatalog,source});if(requests.current.current(id))setState(fresh);}
    catch(e){if(requests.current.current(id)){setError(asApiError(e));if(e instanceof ApiRequestError&&e.status===409)setConflict(true);try{const cached=await api.independentDiscovery(service.id);if(requests.current.current(id))setState(cached);}catch{/* 保留可见缓存与原错误。 */}}}
    finally {if(requests.current.current(id))setBusy(false);}
  };
  const snapshot=state?.snapshot; const stale=conflict || !!state?.stale || !!snapshot && snapshot.configRevision !== service.configRevision || !!snapshot && snapshot.expiresAt <= Date.now();
  const visible=snapshot?.items.filter((item)=>`${item.name}\n${item.remoteModelId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))??[];
  const importSelected = async () => {
    if(busy||!snapshot||stale||!selected.length)return;setBusy(true);setError(null);
    try {await api.importIndependentModels(service.id,{snapshotId:snapshot.id,expectedConfigRevision:service.configRevision,remoteModelIds:selected});toast(`已追加或更新 ${selected.length} 个模型，默认选择与人工值保留`);close();await saved();}
    catch(e){setError(asApiError(e));if(e instanceof ApiRequestError&&e.status===409)setConflict(true);}finally{setBusy(false);}
  };
  return <Dialog title={`获取模型与能力：${service.name}`} onClose={()=>{if(!busy)close();}} wide initialFocus="#discovery-refresh"
    footer={<><button className="btn" disabled={busy} onClick={close}>关闭</button><button className="btn primary" disabled={busy||stale||!selected.length} aria-busy={busy} onClick={()=>void importSelected()}>导入所选（{selected.length}）</button></>}>
    <p>先选择识别范围，再生成预览并勾选导入；不会发送模型消息。</p>
    <p className="mono independent-url">当前地址：{service.baseUrl} · 配置修订 {service.configRevision}</p>
    <fieldset className="independent-fieldset" disabled={busy}>
      <label className="form-row" htmlFor="discovery-source"><span>识别范围</span><select id="discovery-source" className="input" value={source} onChange={(e)=>setSource(e.target.value as NonNullable<DiscoverIndependentModelsBody['source']>)}><option value="service">获取服务模型列表</option><option value="configured">识别已添加模型（无需服务目录）</option></select></label>
      <p className="form-note">{source==='configured'?'仅核对已添加模型与内置官方资料，不访问服务、不读取密钥，不验证账号权限或完整模型列表。勾选公共目录后才会联网，最多 1 次匿名请求。':'获取此服务的模型列表和能力声明，最多 10 次服务请求；勾选公共目录后最多再加 1 次匿名请求。'}</p>
      <label className="independent-check"><input type="checkbox" checked={includeCatalog} onChange={(e)=>setIncludeCatalog(e.target.checked)}/>同时读取 models.dev 公共目录（不携带服务密钥）</label>
      <p className="form-note">公共目录需精确核对高级信息中的服务商标识、协议、模型 ID 与地址；有独立 API 版本或套餐而目录未说明时，不套用能力。未知保持未知，服务接口声明优先。</p>
      <div className="independent-actions"><button id="discovery-refresh" className="btn primary" disabled={!service.enabled||conflict} onClick={()=>void refresh()}>{busy?'正在处理…':source==='configured'?'生成能力预览':'获取最新预览'}</button><button className="btn" onClick={()=>void load()}>载入最新配置与缓存</button></div>
    </fieldset>
    {error?<div ref={errorRef} tabIndex={-1}><ErrorNotice error={error}/></div>:null}
    {conflict?<p className="form-problem">旧预览已停止提交。请点击“载入最新配置与缓存”，核对地址后重新获取并勾选。</p>:null}
    {state?.lastError?<p className="form-problem">上次获取失败（{new Date(state.lastError.at).toLocaleString('zh-CN')}）：{state.lastError.message}。旧预览保留，需重新获取成功后导入。</p>:null}
    {state?.lastError?<details><summary>查看本次获取诊断</summary>{state.lastError.diagnostics?<>
      <p>失败阶段：{discoveryStageLabels[state.lastError.diagnostics.stage]} · HTTP 状态：{state.lastError.diagnostics.httpStatus ?? '未确认'}</p>
      {state.lastError.diagnostics.stage==='service_parse'?<p>解析校验：{discoveryParseFailureText(state.lastError.diagnostics.parseFailure)}</p>:null}
      {state.lastError.diagnostics.parseFailure==='data_not_array'?<p>响应根结构：{discoveryRootShapeText(state.lastError.diagnostics.rootShape)}</p>:null}
      <p>服务请求尝试 {state.lastError.diagnostics.serviceRequests} 次 · 公共目录请求尝试 {state.lastError.diagnostics.publicCatalogRequests} 次 · 已解析 {state.lastError.diagnostics.parsedPages} 页</p>
      <p className="form-note">次数表示工作台发起的读取尝试，不证明上游收到或计费。诊断不包含响应正文、响应头、字段名或密钥；根结构只描述 JSON 形状，不能据此判断供应商的具体错误或认证状态。</p>
    </>:<p className="form-note">这条历史记录未包含诊断，阶段、次数和 HTTP 状态未确认。不会自动重试获取。</p>}</details>:null}
    {snapshot?<>
      <p role="status">{snapshot.source==='configured'?'已有模型能力预览（不含服务完整列表）':'服务模型列表预览'} · {snapshot.items.length} 个候选 · {snapshot.pageCount} 页 · {snapshot.requestCount} 次请求 · 获取 {new Date(snapshot.fetchedAt).toLocaleString('zh-CN')} · 失效 {new Date(snapshot.expiresAt).toLocaleString('zh-CN')}{stale?' · 预览不可导入（过期、配置变化或上次获取失败）':''}</p>
      {snapshot.notices.length?<ul>{snapshot.notices.map((notice)=><li key={notice}>{notice}</li>)}</ul>:null}
      <p className="form-note">只导入勾选项。已有模型保留名称、启停、人工修订和默认值；新增来源可能改变自动能力或产生冲突，可在“能力与来源”逐项核对。目录声明不代表实际验证通过。</p>
      <label className="form-row" htmlFor="discovery-search"><span>搜索候选模型</span><input id="discovery-search" className="input" type="search" value={query} maxLength={200} onChange={(e)=>setQuery(e.target.value)}/></label>
      <div className="independent-actions"><button className="btn" disabled={busy||stale||!visible.length} onClick={()=>setSelected([...new Set([...selected,...visible.map((item)=>item.remoteModelId)])])}>选中筛选结果（{visible.length}）</button><button className="btn" disabled={busy||!selected.length} onClick={()=>setSelected([])}>清空选择</button></div>
      <div className="independent-discovery-list">{visible.map((item)=>{
        const existing=models.find((m)=>m.remoteModelId===item.remoteModelId);
        return <article className="independent-model" key={item.remoteModelId}>
          <label className="independent-check"><input type="checkbox" disabled={busy||stale} checked={selected.includes(item.remoteModelId)} onChange={(e)=>setSelected(e.target.checked?[...selected,item.remoteModelId]:selected.filter((id)=>id!==item.remoteModelId))}/><strong>{item.name}</strong></label>
          <code>{item.remoteModelId}</code><p className="form-note">{existing?`已存在：${existing.name}，保留其${existing.enabled?'启用':'停用'}状态`:'新增模型，不改变默认选择'} · {item.evidence.length?'有能力来源，展开核对':'仅识别到模型 ID，能力未知'}</p>
          {item.evidence.length?<details><summary>核对能力与来源（{item.evidence.length} 条）</summary><ul className="independent-evidence">{item.evidence.map((ev,i)=><li key={`${ev.kind}-${ev.field}-${i}`}><strong>{capabilityLabels[ev.field]}：{capabilityText(ev.value)}</strong><p>{sourceLabels[ev.kind]} · {ev.fieldPath} · 核对 {new Date(ev.observedAt).toLocaleString('zh-CN')} · {ev.expiresAt===null?'未声明有效期':`到期 ${new Date(ev.expiresAt).toLocaleString('zh-CN')}`}</p>
            {existing?<p>当前生效值：{capabilityText(existing.capabilities.find((c)=>c.field===ev.field)?.value??null)}；导入后按来源优先级解析，人工值保留。</p>:null}
            <p className="mono independent-url">{ev.sourceUrl} · {ev.sourceVersion}</p></li>)}</ul></details>:null}
        </article>;
      })}{!visible.length?<p className="muted">没有符合条件的候选模型；可调整搜索，或手动添加模型。</p>:null}</div>
    </>:<p role="status">{busy?'正在读取已保存预览…':'还没有发现预览。选择识别范围并点击上方按钮开始；不会自动获取。'}</p>}
  </Dialog>;
}
