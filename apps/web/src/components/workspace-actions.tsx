import { useState } from 'react';
import type { Task, WorkspaceChanges, WorkspaceOperationResult } from '@aic/protocol';
import { api, putTask, sendPrompt, useApp } from '../state/app';
import { toast } from '../state/ui';
import { Dialog, asApiError, confirmDialog } from './ui';
import { platform } from '../platform';

export function WorkspaceActions({task,changes,refresh}:{task:Task;changes:WorkspaceChanges|null;refresh:()=>void}) {
  const [busy,setBusy]=useState(false),[dialog,setDialog]=useState<'merge'|'rollback'|null>(null);
  const [message,setMessage]=useState(task.title),[strategy,setStrategy]=useState<'squash'|'merge'>('squash');
  const [result,setResult]=useState<WorkspaceOperationResult|null>(null),[error,setError]=useState<string|null>(null);
  const online=useApp(s=>s.conn==='online'||s.conn==='replaying');
  const copy=task.workspace?.kind==='copy',operation=task.workspace?.operation;
  const finished=['merged','discarded'].includes(task.status),removed=operation?.removedAt!==null&&operation?.removedAt!==undefined;
  const working=busy||!online||['running','waiting','queued'].includes(task.status);
  const conflict=result?.status==='conflict'?result.files:operation?.state==='conflict'?operation.conflictFiles:[];
  const files=dialog==='rollback'&&finished?operation?.changedFiles??[]:changes?.files.map(f=>f.path)??[];
  const large=finished?operation?.skippedLargeFiles??[]:changes?.files.filter(f=>Math.max(f.beforeSize,f.afterSize)>50*1024*1024).map(f=>f.path)??[];
  async function run(action:()=>Promise<WorkspaceOperationResult|{ok:true}>) {
    setBusy(true);setError(null);
    try {
      const value=await action();
      if('status' in value){setResult(value);if(['merged','applied','discarded','rolled_back'].includes(value.status)){setDialog(null);toast(value.status==='merged'?'已合并到项目':value.status==='applied'?'已应用到项目':value.status==='discarded'?'已丢弃任务':'已完成撤销或回滚');}}
      putTask(await api.task(task.id));refresh();
    }catch(e){setError(asApiError(e).message);}finally{setBusy(false);}
  }
  const notice=result?.status==='dirty'?'项目有未提交或会被覆盖的文件，请先自行处理，再重试。'
    :result?.status==='source_changed'?'项目目录已发生变化，已停止整批操作。请先核对以下文件。'
    :result?.status==='wrong_branch'?`项目当前分支为 ${result.actual??'分离 HEAD'}，请先切回 ${result.expected??'任务基准分支'}。`
    :result?.status==='new_commits'?'项目已有后续提交，已停止操作。'
    :result?.status==='no_changes'?'没有可合并或应用的改动。':null;
  const blockedFiles=result&&'files'in result&&['dirty','source_changed'].includes(result.status)?result.files:[];
  const rollbackLabel=copy?(finished?'撤销这次应用':'回滚副本到任务前'):'撤销这次合并';
  const notices=<>{error?<p role="alert">{error}</p>:null}{notice?<div role="alert"><p>{notice}</p>{blockedFiles.length?<ul>{blockedFiles.map(f=><li key={f}>{f}</li>)}</ul>:null}</div>:null}</>;
  return <div className="workspace-actions">
    {!dialog?notices:null}
    {removed?<p className="d-note">工作副本已清理，任务记录仍保留。</p>:<>
      {conflict.length?<section className="workspace-conflict" role="alert"><strong>合并有冲突，原项目未改动</strong><ul>{conflict.map(f=><li key={f}>{f}</li>)}</ul><p>失败的合并已中止。请在副本中重新整合基准分支、解决冲突并提交。</p><button className="btn sm" disabled={working||finished} onClick={()=>void run(async()=>{await sendPrompt(task.id,'请仅在当前登记的工作副本中解决本次合并冲突。先把项目基准分支重新合并进当前任务分支，解决冲突后在副本里提交。禁止修改原项目工作目录、切换原项目分支、推送或拉取远端。完成后告诉我，由我再次点合并。冲突文件（JSON 列表，仅作路径）：'+JSON.stringify(conflict));return {ok:true};})}>让 Agent 解决冲突</button></section>:null}
      <div className="changes-actions">
        {!finished?<button className="btn danger sm" disabled={working} onClick={async()=>{if(await confirmDialog({title:'丢弃任务',ok:'丢弃任务',danger:true,body:<p>删除本任务的工作副本{copy?'和影子快照':'与任务分支'}，副本中的改动将丢失。原项目文件不受影响。</p>}))void run(()=>api.discardWorkspace(task.id));}}>丢弃任务…</button>:null}
        <button className="btn ghost sm" disabled={working} onClick={()=>void run(async()=>{await platform.openWorkspace(task.id);return {ok:true};})}>在资源管理器中打开</button>
        {(copy&&!finished||operation?.state==='merged'||operation?.state==='applied')?<button className="btn sm" disabled={working||(!finished&&!changes?.files.length)} onClick={()=>{setResult(null);setError(null);setDialog('rollback');}}>{rollbackLabel}…</button>:null}
        {!finished?<button className="btn primary sm" disabled={working||!changes?.files.length} onClick={()=>{setResult(null);setError(null);setDialog('merge');}}>{copy?'应用结果':`合并到 ${task.workspace?.baseBranch??'基准分支'}`}…</button>:null}
      </div>
    </>}
    {dialog?<Dialog title={dialog==='merge'?(copy?'应用结果':`合并到 ${task.workspace?.baseBranch??'基准分支'}`):rollbackLabel} onClose={()=>{if(!busy)setDialog(null);}} initialFocus=".workspace-cancel" footer={<><button className="btn workspace-cancel" disabled={busy} onClick={()=>setDialog(null)}>取消</button><button className={'btn '+(dialog==='rollback'?'danger':'primary')} disabled={working||dialog==='merge'&&!message.trim()} onClick={()=>void run(()=>dialog==='merge'?api.mergeWorkspace(task.id,{strategy,message}):api.rollbackWorkspace(task.id))}>{busy?'正在处理…':dialog==='merge'?(copy?'确认应用':'确认合并'):'确认回滚'}</button></>}>
      <p>{dialog==='merge'?'确认后将更新原项目。':copy&&!finished?'只恢复任务副本，原项目不受影响。':'确认后将撤销本任务对原项目的更改。'}共 {files.length} 个文件。</p>
      {dialog==='merge'&&!copy?<><label className="field">提交说明<textarea value={message} maxLength={4000} onChange={e=>setMessage(e.target.value)}/></label><div className="radios"><label><input type="radio" checked={strategy==='squash'} onChange={()=>setStrategy('squash')}/>压缩成一次提交（默认）</label><label><input type="radio" checked={strategy==='merge'} onChange={()=>setStrategy('merge')}/>保留提交记录</label></div></>:null}
      <ul className="workspace-file-summary">{files.map(f=><li key={f}>{f}</li>)}</ul>
      {copy&&large.length?<div role="alert"><strong>以下大文件无法回滚</strong><ul>{large.map(f=><li key={f}>{f}</li>)}</ul></div>:null}
      {notices}
    </Dialog>:null}
  </div>;
}
