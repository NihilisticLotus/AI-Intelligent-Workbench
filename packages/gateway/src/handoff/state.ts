import { EventEnvelope, type HandoffDocument, type HandoffTarget } from '@aic/protocol';
import type { Services } from '../services';
import { usableCapability } from '../independent/capabilities';
import { targetWindow } from './budget';
import { acpLines, independentLines } from './transcript';

export async function readHandoffState(s:Services,id:string,destination:HandoffTarget) {
  const task=s.tasks.get(id);
  const rows=s.db.all<{seq:number;ts:number;session_id:string|null;type:string;payload:string}>(
    'SELECT seq,ts,session_id,type,payload FROM events WHERE task_id=? AND replay=0 ORDER BY seq',id);
  const events=rows.map(r=>EventEnvelope.parse({seq:r.seq,ts:r.ts,sessionId:r.session_id,taskId:id,type:r.type,data:JSON.parse(r.payload)}));
  const sessions=s.db.all<{id:string;agent_id:string;status:string}>('SELECT id,agent_id,status FROM sessions WHERE task_id=? ORDER BY started_at,rowid',id);
  const ledger=s.tasks.memory.list(id);
  const workspace=s.workspaces.get(id);
  const ready=workspace?.state==='ready';
  const vcs=ready?await s.workspaces.handoffChanges(id):{files:[],commits:[]};
  const changed=vcs.files.map(({path,oldPath,status,added,removed})=>({path,oldPath,operation:({A:'创建',D:'删除',M:'修改',R:'重命名'})[status],added,removed}));
  const commands=ledger.flatMap(i=>i.kind==='command' && i.sourceSeq!==null ? [{seq:i.sourceSeq,...i.content}]:[]).sort((a,b)=>a.seq-b.seq);
  const constraints=ledger.flatMap(i=>i.kind==='constraint'?[i.content]:[]);
  const tasks=ledger.flatMap(i=>i.kind==='plan'?i.content:[]);
  const fileMap=new Map<string,HandoffDocument['files']['changed'][number]>();
  for(const item of ledger) if(item.kind==='file') {
    const {path,operation,added,removed}=item.content;
    fileMap.set(path,{path,operation:({create:'创建',edit:'修改',delete:'删除'})[operation],added,removed});
  }
  for(const file of changed) fileMap.set(file.path,file);
  const reads=new Map<string,number>();
  const readTools=new Map<string,string>();
  for (const e of events) {
    if(e.type==='tool.start') {
      const key=e.sessionId+'\0'+e.data.toolId;
      readTools.delete(key);
      if (e.data.kind==='read' && e.data.target) readTools.set(key,e.data.target);
    }
    if(e.type==='tool.end' && e.data.ok && !e.data.rejected) {
      const name=readTools.get(e.sessionId+'\0'+e.data.toolId);
      if(name) reads.set(name,(reads.get(name)??0)+1);
    }
  }
  const userMessages=events.flatMap(e=>e.type==='message.user'?[{seq:e.seq,text:e.data.text}]:[]);
  const corrections=[...constraints,...events.flatMap(e=>e.type==='task.file_restored'?['用户已还原 '+e.data.path]:[])];
  const report=s.db.get<{size:number}>(`SELECT json_extract(e.payload,'$.size') AS size FROM events e
    JOIN sessions ss ON ss.id=e.session_id AND ss.task_id=e.task_id
    WHERE e.type='session.usage' AND e.replay=0 AND ss.agent_id=? AND (? IS NULL OR ss.model=?) AND json_extract(e.payload,'$.size')>0 ORDER BY e.seq DESC LIMIT 1`,
    destination.agent,destination.model??null,destination.model??null);
  const adapter=s.agents.get(destination.agent);
  const catalogWindow=adapter?s.agentSvc.info(adapter).models.find(m=>m.id===destination.model)?.contextWindow:null;
  let independentWindow:unknown;
  if(destination.agent==='independent') {
    const bound=s.db.get<{service_id:string;model_id:string}>('SELECT service_id,model_id FROM independent_task_models WHERE task_id=?',id);
    if(bound) independentWindow=usableCapability(s.independent.getModel(bound.service_id,bound.model_id),'contextWindow');
  }
  const document:HandoffDocument={
    meta:{taskId:id,from:{agent:task.agent,model:task.model,sessionId:sessions.findLast(s=>s.agent_id===task.agent && s.status==='active')?.id??events.findLast(e=>e.type==='session.started'&&e.data.agent===task.agent)?.sessionId??sessions.findLast(s=>s.agent_id===task.agent)?.id??null},
      to:{agent:destination.agent,model:destination.model??null,sessionId:null},checkpoint:null,level:'H2',fromSeq:events[0]?.seq??null,toSeq:events.at(-1)?.seq??null},
    intent:{goal:task.prompt,constraints}, userMessages,corrections,tasks,
    files:{changed:[...fileMap.values()],read:[...reads].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([path,count])=>({path,count}))},
    vcs:{branch:workspace?.branch??null,baseBranch:workspace?.baseBranch??null,baseRef:workspace?.baseRef??null,changed,commits:vcs.commits},
    commands:{items:commands.filter((c,i)=>!c.ok || i>=commands.length-5),lastTest:commands.findLast(c=>/\b(?:test|vitest|jest|pytest|ctest)\b/i.test(c.command))??null},
    env:{workspace:workspace?.path??null,branch:workspace?.branch??null},
  };
  const lines=acpLines(events,task.agent);
  for(const session of sessions) if(session.agent_id==='independent') lines.push(...independentLines(s.independentRuntime.portableEntries(id,session.id)));
  lines.sort((a,b)=>a.at-b.at);
  const marked=new Set(ledger.flatMap(i=>i.kind==='constraint' && i.source==='user' && i.sourceSeq!==null?[i.sourceSeq]:[]));
  return {document,lines,marked,window:targetWindow(report?.size,catalogWindow,independentWindow)};
}
