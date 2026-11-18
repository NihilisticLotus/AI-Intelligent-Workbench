import { useEffect, useState } from 'react';
import type { ApiError, HandoffProgressStep, HandoffRecord, HandoffReturnBody, HandoffSendOptions, Task } from '@aic/protocol';
import { api, useApp } from '../state/app';
import type { HandoffItem } from '../state/core';
import { useTarget, selectTarget, useHandoffSending } from '../state/handoff';
import { asApiError, confirmDialog, Dialog, ErrorNotice, openDialog, useAgentName } from './ui';

export function PendingHandoff({task}:{task:Task}) {
  const target=useTarget(task.id,task.agent);
  const name=useAgentName(target?.agent);
  const sending=useHandoffSending(task.id);
  if (!target || sending) return null;
  return <div className="handoff-pending" role="status"><span>下一条消息交给 <strong>{name}</strong>。发送时才自动交接，不发就不交接。</span>
    <button type="button" className="linkish" onClick={()=>selectTarget(task.id,task.agent)}>撤销</button></div>;
}

export async function confirmHandoff(taskId:string,id:string):Promise<HandoffSendOptions|null> {
  const record=await api.handoff(taskId,id);
  return new Promise(resolve=>openDialog(close=><EditHandoff record={record} finish={value=>{close();resolve(value);}}/>));
}
function EditHandoff({record,finish}:{record:HandoffRecord;finish:(value:HandoffSendOptions|null)=>void}) {
  const [markdown,setMarkdown]=useState(record.markdown);
  return <Dialog title={record.quality.windowConfirmation?'目标模型的窗口不足':'确认交接内容'} wide onClose={()=>finish(null)}
    footer={<><button className="btn" onClick={()=>finish(null)}>{record.quality.windowConfirmation?'返回选择模型':'返回草稿'}</button>
    <button className="btn primary" onClick={()=>finish({confirmedId:record.id,markdown})}>{record.quality.windowConfirmation?'仍然继续':'确认发送'}</button></>}>
    {record.quality.windowConfirmation?<p>探针未通过，最小交接仍超过目标窗口。可以返回选择更大窗口的模型。</p>:null}
    <label>发给新 Agent 的内容<textarea className="textarea handoff-editor" rows={14} value={markdown} maxLength={2_000_000} onChange={e=>setMarkdown(e.target.value)} /></label>
  </Dialog>;
}

const labels:Record<HandoffProgressStep,string>={generate:'生成交接内容',coverage:'检查事实覆盖',consistency:'核对一致性',probe:'探针问答',send:'发送到新会话'};
const statuses={running:'进行中',done:'✓ 完成',skipped:'跳过',failed:'失败'};
const reasons={H2:'传递完整转写与任务状态',H3:'使用摘要与最近对话',H4:'使用确定性记录与本任务历史查询'};
function Quality({record}:{record:HandoffRecord}) {
  const q=record.quality;
  return <div><p>覆盖校验{q.coveragePassed?'通过':'未通过'} · 自动补齐 {q.added.length} 项 · 自动打码 {q.redactions} 次</p>
    {q.added.map((s,i)=><p key={'a'+i}>{s}</p>)}
    <p>一致性校验{q.consistencyPassed?'通过':'已移除缺少依据的叙述'} · 历史查询 {q.historyCalls??0} 次</p>
    {q.inconsistent.map((s,i)=><p key={'i'+i}>{s}</p>)}
    {q.probe?<><p>探针通过 {q.probe.passed}/{q.probe.total} 题</p><ul>{q.probe.items?.map((x,i)=><li key={i}>{x.passed?'通过':'未通过'} · {x.question}</li>)}</ul></>:<p>本次没有探针分数</p>}
    {q.summaryFailure?<p>{q.summaryFailure==='probe'?'探针未完成':'摘要未完成'}，已使用确定性记录。</p>:null}
    {q.restatement?<details><summary>新 Agent 复述 · {q.restatement.matched?'比对一致':q.restatement.corrected?'已发送更正':!record.document.files.changed.length&&!record.document.files.read.length&&!record.document.current?'暂无可比对的路径':'有偏差'}</summary><pre>{q.restatement.text}</pre></details>:null}
    {q.warnings?.map((w,i)=><p key={i} className="attn">{w}</p>)}
  </div>;
}
function HandoffContent({record,close}:{record:HandoffRecord;close:()=>void}) {
  const [index,setIndex]=useState(0);
  return <Dialog title="查看交接内容" onClose={close} wide footer={<button className="btn" onClick={close}>关闭</button>}>
    <div className="handoff-tabs" aria-label="内容视图">{['发给新 Agent 的内容','handoff.json','自动校验记录'].map((tab,i)=>
      <button type="button" className="btn sm" aria-pressed={index===i} key={tab} onClick={()=>setIndex(i)}>{tab}</button>)}</div>
    {index===2?<Quality record={record}/>:<pre className="handoff-text">{index===0?record.markdown:JSON.stringify(record.document,null,2)}</pre>}
  </Dialog>;
}

export function HandoffDivider({item,task}:{item:HandoffItem;task:Task}) {
  const [expanded,setExpanded]=useState(false),[restore,setRestore]=useState(false),[busy,setBusy]=useState(false);
  const [record,setRecord]=useState<HandoffRecord|null>(null),[error,setError]=useState<ApiError|null>(null);
  const latest=useApp(s=>s.logs[task.id]?.findLast(e=>e.type==='session.handoff')?.data.handoffId);
  const revision=useApp(s=>s.logs[task.id]?.findLast(e=>e.type==='session.notice'||e.type==='task.updated'||e.type==='tool.end')?.seq);
  const from=useAgentName(item.receipt?.from),to=useAgentName(item.receipt?.to);
  useEffect(()=>{
    if (!item.receipt && (!expanded || item.steps.generate!=='done')) return;
    let live=true;
    api.handoff(task.id,item.id).then(r=>{if(live){setRecord(r);}}).catch(e=>{if(live)setError(asApiError(e));});
    return ()=>{live=false;};
  },[task.id,item.id,expanded,item.receipt,item.steps.generate,expanded?revision:0]);
  const canAct=record?.state==='sent' && latest===item.id && record.document.meta.to.agent===task.agent && !['running','queued','waiting','merged','discarded'].includes(task.status);
  const action=async(kind:'return'|'redo')=>{
    if (busy || !canAct) return;
    setBusy(true); setError(null);
    try {
      let options:HandoffReturnBody={};
      if (kind==='return' && restore) {
        const preview=await api.restorePreview(task.id,item.id);
        const ok=await confirmDialog({title:'恢复交接时的检查点？',ok:'恢复并切回',body:<><p>将恢复以下文件</p><pre>{preview.files.join('\n')||'没有需要恢复的文件'}</pre>
          {preview.skipped.length?<><p>以下环境文件保持现状</p><pre>{preview.skipped.join('\n')}</pre></>:null}</>});
        if(!ok)return;
        options={restoreRevision:preview.revision};
      }
      const result=await api.handoffAction(task.id,item.id,kind,options);
      if ('pendingHandoffId' in result && result.pendingHandoffId) {
        const edited=await confirmHandoff(task.id,result.pendingHandoffId);
        if(!edited)return;
        await api.handoffAction(task.id,item.id,kind,edited);
      }
      setRecord(await api.handoff(task.id,item.id));
    } catch(e){setError(asApiError(e));} finally{setBusy(false);}
  };
  const agents=useApp(s=>s.agents);
  const party=record?.document.meta;
  const modelLabel=(p:HandoffRecord['document']['meta']['to']|undefined)=>{
    if(!p?.model)return '';
    const model=agents.find(a=>a.kind===p.agent)?.models.find(m=>m.id===p.model);
    return '（'+(model?.name??p.model)+'）';
  };
  const failed=Object.values(item.steps).includes('failed') && !item.receipt;
  return <section className="handoff-divider">
    <button className="handoff-title" type="button" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}>
      {item.receipt?<><strong>已自动交接 · {from}{modelLabel(party?.from)} → {to}{modelLabel(party?.to)}</strong>
        <span>{item.receipt.level} · {item.receipt.quality.coveragePassed?'覆盖通过':'待核对'}</span></>:<strong>{failed?'交接未完成':item.steps.generate==='done'&&!item.steps.send?'已生成交接内容':'正在交接'}</strong>}<span aria-hidden="true">{expanded?'▴':'▾'}</span>
    </button>
    {!item.receipt||expanded?<ol className="handoff-steps" aria-label="交接进度" role="status">{(Object.keys(labels) as HandoffProgressStep[]).map(k=>
      <li key={k}>{labels[k]} <small>{item.steps[k]?statuses[item.steps[k]!]: '待处理'}</small></li>)}</ol>:null}
    {expanded && record?<><p>{record.level} · {reasons[record.level]}。估算 {record.quality.estimatedTokens.toLocaleString()} token，目标窗口 {record.quality.window.toLocaleString()}。</p>
      <Quality record={record}/>
      <div className="handoff-actions"><button className="btn sm" onClick={()=>openDialog(close=><HandoffContent record={record} close={close}/>)}>查看交接内容</button>
        {canAct?<><button className="btn sm" disabled={busy} onClick={()=>void action('return')}>切回 {from}</button>
        {party?.checkpoint?<label><input type="checkbox" checked={restore} onChange={e=>setRestore(e.target.checked)}/>恢复检查点</label>:null}
        <details><summary>重新交接…</summary><button className="btn sm" disabled={busy} onClick={()=>void action('redo')}>强制 H2 重新交接</button></details></>:null}
        {record.state==='returned'?<span>已切回</span>:null}
      </div></>:null}
    {error?<ErrorNotice error={error}/>:null}
  </section>;
}
