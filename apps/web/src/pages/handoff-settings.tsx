import { useEffect, useState } from 'react';
import type { HandoffSettings, HandoffSummaryUsage } from '@aic/protocol';
import { api, useRemoteAccess } from '../state/app';
import { toast } from '../state/ui';
import { asApiError } from '../components/ui';

export function HandoffSettingsSection({ initialSettings }: { initialSettings?: HandoffSettings | null }) {
  const remote = useRemoteAccess();
  const [settings,setSettings]=useState<HandoffSettings|null>(initialSettings??null),[usage,setUsage]=useState<HandoffSummaryUsage|null>(null);
  const [models,setModels]=useState<Array<{id:string;name:string;service:string}>>([]);
  const [count,setCount]=useState(''),[money,setMoney]=useState(false),[currency,setCurrency]=useState('CNY');
  const [total,setTotal]=useState(''),[perCall,setPerCall]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    let live=true;
    async function load() {
      const [saved,spent,services]=await Promise.all([api.handoffSettings(),api.summaryUsage(),api.independentServices()]);
      const options=await Promise.all(services.filter(s=>s.enabled).map(async s=>(await api.independentModels(s.id))
        .filter(m=>m.enabled).map(m=>({id:m.id,name:s.name+' · '+m.name,service:s.id}))));
      if(!live)return;
      setSettings(saved);setUsage(spent);setModels(options.flat());setCount(saved.summaryBudget?.maxRequests.toString()??'');
      const cap=saved.summaryBudget?.money;
      if(cap){setMoney(true);setCurrency(cap.currency);setTotal(String(cap.maxReservedMicros/1e6));setPerCall(cap.modelCeilingMicros===null?'':String(cap.modelCeilingMicros/1e6));}
    }
    load().catch(e=>{if(live)setError(asApiError(e).message);});
    return ()=>{live=false;};
  },[]);
  async function save() {
    if(!settings)return;
    setBusy(true);setError('');
    try {
      const budget=count?{maxRequests:Number(count),money:money?{currency,maxReservedMicros:Math.round(Number(total)*1e6),
        modelCeilingMicros:perCall?Math.round(Number(perCall)*1e6):null,counterCeilingMicros:settings.summaryBudget?.money?.counterCeilingMicros??null}:null}:undefined;
      const saved=await api.saveHandoffSettings({...settings,summaryBudget:budget});
      setSettings(saved);setUsage(await api.summaryUsage());toast('已保存交接设置');
    } catch(e){setError(asApiError(e).message);} finally{setBusy(false);}
  }
  return <section className="set-sec" aria-labelledby="s-handoff"><h3 id="s-handoff">交接</h3>
    {remote?<p className="muted-note">请到运行 AI Console 的电脑上操作（修改交接设置仅限本机）。</p>:null}
    {settings?<form onSubmit={e=>{e.preventDefault();if(!remote)void save();}}><fieldset disabled={busy||remote}>
      <div className="set-row"><label><input type="checkbox" checked={settings.confirmBeforeSend} onChange={e=>setSettings({...settings,confirmBeforeSend:e.target.checked})}/> 交接前让我确认</label></div>
      <div className="set-row"><label className="lbl" htmlFor="summary-model">交接摘要模型</label><select className="select" id="summary-model" value={settings.summaryModel?.modelId??''}
        onChange={e=>{const model=models.find(m=>m.id===e.target.value);setSettings({...settings,summaryModel:model?{serviceId:model.service,modelId:model.id}:null});}}>
        <option value="">不使用（只用确定性内容）</option>
        {settings.summaryModel&&!models.some(m=>m.id===settings.summaryModel?.modelId)?<option value={settings.summaryModel.modelId}>原模型已停用或不可用</option>:null}
        {models.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></div>
      {settings.summaryModel||settings.summaryBudget?<><p className="hint">摘要和探针共用以下额度，所有任务累计。任务本身的执行额度单独计算。</p>
        <div className="set-row"><label className="lbl" htmlFor="summary-count">累计请求上限</label><input id="summary-count" type="number" min={Math.max(1,usage?.count??0)} max={1e9} step="1" required value={count} onChange={e=>setCount(e.target.value)}/></div>
        <div className="set-row"><label><input type="checkbox" checked={money} disabled={!!usage?.count} onChange={e=>setMoney(e.target.checked)}/> 同时限制预留金额</label></div>
        {money?<><div className="set-row"><label htmlFor="summary-currency">币种</label><input id="summary-currency" value={currency} pattern="[A-Z]{3}" required disabled={!!usage?.count} onChange={e=>setCurrency(e.target.value.toUpperCase())}/></div>
          <div className="set-row"><label htmlFor="summary-total">累计预留上限</label><input id="summary-total" type="number" min="0" step="0.000001" value={total} required onChange={e=>setTotal(e.target.value)}/></div>
          <div className="set-row"><label htmlFor="summary-call">单次模型请求预留金额</label><input id="summary-call" type="number" min="0" step="0.000001" value={perCall} onChange={e=>setPerCall(e.target.value)}/></div></>:null}
      </>:null}
      {usage?<p>已占用 {usage.count} 次 · 待核对 {usage.pending} 次{settings.summaryBudget?.money?' · 已预留 '+(usage.reserved/1e6)+' '+settings.summaryBudget.money.currency:''}</p>:null}
      <button className="btn" type="submit">保存交接设置</button>
    </fieldset></form>:!error?<p role="status">正在读取交接设置…</p>:null}
    {error?<p role="alert">{error}</p>:null}
  </section>;
}
