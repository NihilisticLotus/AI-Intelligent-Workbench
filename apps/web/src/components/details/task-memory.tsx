import { useEffect, useState } from 'react';
import { FeatureKey, type TaskMemoryItem } from '@aic/protocol';
import { api, useApp } from '../../state/app';
import { asApiError } from '../ui';

const kinds={goal:'目标',constraint:'约束',decision:'决定',issue:'问题',next:'下一步',plan:'计划',file:'改动文件',command:'命令'};
function content(item:TaskMemoryItem) {
  switch(item.kind) {
    case 'plan': return <ul>{item.content.map((p,i)=><li key={i}>{{pending:'待处理',in_progress:'进行中',completed:'已完成'}[p.status]} · {p.text}</li>)}</ul>;
    case 'command': return <details><summary>{item.content.ok?'成功':'失败'} · {item.content.command}</summary><pre>{item.content.output||'没有输出'}</pre></details>;
    case 'file': return ({create:'新增',edit:'修改',delete:'删除'}[item.content.operation])+' · '+item.content.path;
    default:return item.content;
  }
}
export function TaskMemoryDetails({id}:{id:string}) {
  const enabled=useApp(s=>!!s.hello?.features[FeatureKey.TaskMemory]);
  const revision=useApp(s=>s.logs[id]?.findLast(e=>['task.memory_updated','plan.update','tool.end','approval.resolved','turn.usage'].includes(e.type))?.seq);
  const [items,setItems]=useState<TaskMemoryItem[]|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    if(!enabled)return;
    let live=true;
    api.taskMemory(id).then(list=>{if(live){setItems(list.items.filter(x=>!x.supersededBy));setError('');}},e=>{if(live)setError(asApiError(e).message);});
    return ()=>{live=false;};
  },[id,enabled,revision]);
  if(!enabled)return null;
  return <section><h4>任务账本</h4>{error?<p role="alert">{error}</p>:!items?<p>正在读取…</p>:items.length===0?<p>暂无记录</p>:
    (Object.keys(kinds) as TaskMemoryItem['kind'][]).map(kind=>{const rows=items.filter(x=>x.kind===kind);
      return rows.length?<div key={kind}><h5>{kinds[kind]}</h5><ul>{rows.map(x=><li key={x.id}>{content(x)}</li>)}</ul></div>:null;})}</section>;
}
