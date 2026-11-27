import { useEffect, useState } from 'react';
import { api, useRemoteAccess } from '../state/app';
import { toast } from '../state/ui';
import { asApiError } from '../components/ui';

export function WorkspaceSettingsSection() {
  const remote = useRemoteAccess();
  const [days,setDays]=useState('7'),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  useEffect(()=>{void api.workspaceRetention().then(v=>{setDays(String(v.days));setReady(true);},e=>setError(asApiError(e).message));},[]);
  async function save(){if(remote)return;setBusy(true);setError(null);try{await api.setWorkspaceRetention({days:Number(days)});toast('已保存工作副本保留天数');}catch(e){setError(asApiError(e).message);}finally{setBusy(false);}}
  return <section className="set-sec" aria-labelledby="s-workspaces"><h3 id="s-workspaces">工作副本</h3>{remote?<p className="muted-note">请到运行 AI Console 的电脑上操作（修改工作副本保留设置仅限本机）。</p>:null}<div className="set-row"><label className="lbl" htmlFor="workspace-days">工作副本保留天数<span className="note">已合并、已应用或已丢弃的任务，默认保留 7 天。到期清理副本与任务分支，任务记录仍保留。</span></label><input id="workspace-days" type="number" min="1" max="365" value={days} disabled={!ready||busy||remote} onChange={e=>setDays(e.target.value)}/><button className="btn" disabled={!ready||busy||remote||!Number.isInteger(Number(days))||Number(days)<1||Number(days)>365} onClick={()=>void save()}>保存</button></div>{error?<p role="alert">{error}</p>:null}</section>;
}
