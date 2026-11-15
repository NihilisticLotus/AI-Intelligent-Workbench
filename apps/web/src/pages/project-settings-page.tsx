import { useEffect, useRef, useState } from 'react';
import type { AgentKind, PermissionRuleDraft, PermissionRuleSet } from '@aic/protocol';
import { api, saveProjectSettings, useApp } from '../state/app';
import { toast } from '../state/ui';
import { asApiError } from '../components/ui';

export function ProjectSettingsPage({projectId}:{projectId:string}) {
  const project=useApp(s=>s.projects.find(p=>p.id===projectId)),agents=useApp(s=>s.agents);
  const [name,setName]=useState(project?.name??''),[agent,setAgent]=useState(project?.defaultAgent??'');
  const [ignore,setIgnore]=useState(project?.ignoreGlobs?.join('\n')??''),[carry,setCarry]=useState(project?.carryGlobs?.join('\n')??'');
  const [rules,setRules]=useState<PermissionRuleSet|null>(null),[items,setItems]=useState<(PermissionRuleDraft&{uiKey:string})[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);const dragged=useRef<number|null>(null);
  const take=(value:PermissionRuleSet)=>{setRules(value);setItems(value.items.map(({id,action,tool,match,path})=>({id,action,tool,match,path,uiKey:id})));};
  const load=async()=>{setBusy(true);setError(null);try{take(await api.projectRules(projectId));}catch(e){setError(asApiError(e).message);}finally{setBusy(false);}};
  useEffect(()=>{void load();},[projectId]);
  const lines=(value:string)=>value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
  async function saveBasic(){setBusy(true);setError(null);try{await saveProjectSettings(projectId,{name:name.trim(),defaultAgent:agent as AgentKind||null,ignoreGlobs:lines(ignore),carryGlobs:lines(carry)});toast('已保存项目设置，新任务采用新的复制规则');}catch(e){setError(asApiError(e).message);}finally{setBusy(false);}}
  async function saveRules(){if(!rules)return;setBusy(true);setError(null);try{take(await api.putProjectRules(projectId,{revision:rules.revision,items:items.map(({uiKey,...rule})=>rule)}));toast('已保存权限规则');}catch(e){setError(asApiError(e).message);}finally{setBusy(false);}}
  const edit=(index:number,patch:Partial<PermissionRuleDraft>)=>setItems(old=>old.map((r,i)=>i===index?{...r,...patch}:r));
  const move=(from:number,to:number)=>{if(busy||from===to||from<0||to<0||to>=items.length)return;setItems(old=>{const next=[...old];const value=next.splice(from,1)[0]!;next.splice(to,0,value);return next;});};
  if(!project)return <main className="main"><div className="page"><h1>找不到项目</h1><p>项目可能已被移除。</p></div></main>;
  return <main className="main"><div className="content-scroll"><div className="page project-settings">
    <h1>{project.name} · 项目设置</h1>
    {error?<div role="alert" className="workspace-conflict"><p>{error}</p><p>未保存的规则仍保留在表格中。需要最新规则时，请先核对再点击“重新载入规则”。</p></div>:null}
    <section className="set-sec" aria-labelledby="project-basic"><h2 id="project-basic">基本信息</h2>
      <label className="field">名称<input value={name} maxLength={100} onChange={e=>setName(e.target.value)} disabled={busy}/></label>
      <label className="field">项目路径<input value={project.path} readOnly/></label><p>{project.isGit?'git 项目':'非 git 项目'} · 路径只读</p>
      <label className="field">默认 Agent<select value={agent} disabled={busy} onChange={e=>setAgent(e.target.value as AgentKind)}><option value="">不指定</option>{agents.map(a=><option key={a.kind} value={a.kind}>{a.displayName}</option>)}</select></label>
      <label className="field">忽略目录与文件<textarea value={ignore} rows={4} disabled={busy} placeholder={'每行一条，例如 Cache/**'} onChange={e=>setIgnore(e.target.value)}/><span className="d-note">与内置忽略项合并，只影响新任务的准备。</span></label>
      <label className="field">带入工作副本的文件<textarea value={carry} rows={4} disabled={busy} placeholder={'每行一条，例如 config/local.json'} onChange={e=>setCarry(e.target.value)}/><span className="d-note">git 项目复制匹配的未跟踪文件，超过 100 MB 会先确认；非 git 项目按忽略规则复制。</span></label>
      <button className="btn primary" disabled={busy||!name.trim()} onClick={()=>void saveBasic()}>保存基本信息</button>
    </section>
    <section className="set-sec" aria-labelledby="project-rules"><h2 id="project-rules">权限规则</h2>
      <h3>始终禁止</h3><p className="d-note">这些保护不能被项目规则覆盖。规则检查不能替代系统沙箱。</p><ul>{rules?.alwaysDenied.map(text=><li key={text}>{text}</li>)}</ul>
      <h3>项目规则</h3><p>从上到下匹配，命中即停。路径相对工作副本；* 匹配一层，** 匹配多层。可拖动行或聚焦行后按 Alt+↑ / ↓ 调序。</p>
      {!rules?<p role="status">正在读取规则…</p>:<div className="permission-table-wrap"><table className="permission-table"><thead><tr><th>顺序</th><th>动作</th><th>工具</th><th>命令通配</th><th>路径通配</th><th>来源</th><th>操作</th></tr></thead><tbody>
        {items.map((rule,index)=><tr key={rule.uiKey} tabIndex={0} aria-label={`第 ${index+1} 条权限规则`} draggable={!busy}
          onDragStart={e=>{dragged.current=index;e.dataTransfer.setData('application/x-aic-rule',String(index));}}
          onDragEnd={()=>{dragged.current=null;}} onDragOver={e=>{if(e.dataTransfer.types.includes('application/x-aic-rule'))e.preventDefault();}}
          onDrop={e=>{if(dragged.current!==null){e.preventDefault();move(dragged.current,index);dragged.current=null;}}}
          onKeyDown={e=>{if(e.altKey&&(e.key==='ArrowUp'||e.key==='ArrowDown')){e.preventDefault();move(index,index+(e.key==='ArrowUp'?-1:1));}}}>
          <td>{index+1}<button className="btn ghost xs" aria-label={`上移第 ${index+1} 条规则`} disabled={busy||index===0} onClick={()=>move(index,index-1)}>↑</button><button className="btn ghost xs" aria-label={`下移第 ${index+1} 条规则`} disabled={busy||index===items.length-1} onClick={()=>move(index,index+1)}>↓</button></td>
          <td><select aria-label={`第 ${index+1} 条规则动作`} value={rule.action} disabled={busy} onChange={e=>edit(index,{action:e.target.value as PermissionRuleDraft['action']})}><option value="allow">允许</option><option value="ask">询问</option><option value="deny">禁止</option></select></td>
          <td><select aria-label={`第 ${index+1} 条规则工具`} value={rule.tool} disabled={busy} onChange={e=>edit(index,{tool:e.target.value as PermissionRuleDraft['tool']})}><option value="shell">命令</option><option value="edit">修改</option><option value="read">读取</option><option value="any">全部</option></select></td>
          <td><input aria-label={`第 ${index+1} 条规则命令`} value={rule.match??''} maxLength={2000} disabled={busy} placeholder="不限制" onChange={e=>edit(index,{match:e.target.value||null})}/></td>
          <td><input aria-label={`第 ${index+1} 条规则路径`} value={rule.path??''} maxLength={2000} disabled={busy} placeholder="不限制" onChange={e=>edit(index,{path:e.target.value||null})}/></td>
          <td>{rules.items.find(r=>r.id===rule.id)?.source==='always_allow'?'审批时总是允许':'手动'}</td>
          <td><button className="btn danger sm" aria-label={`删除第 ${index+1} 条规则`} disabled={busy} onClick={()=>setItems(old=>old.filter((_,i)=>i!==index))}>删除</button></td>
        </tr>)}
      </tbody></table>{!items.length?<p className="d-note">还没有项目规则，按任务权限决定是否审批。</p>:null}</div>}
      <div className="changes-actions"><button className="btn" disabled={busy||!rules||items.length>=200} onClick={()=>setItems(old=>[...old,{action:'ask',tool:'shell',match:'*',path:null,uiKey:crypto.randomUUID()}])}>添加规则</button><button className="btn primary" disabled={busy||!rules} onClick={()=>void saveRules()}>保存规则</button><button className="btn ghost" disabled={busy} onClick={()=>void load()}>重新载入规则</button></div>
    </section>
  </div></div></main>;
}
