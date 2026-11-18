import type { EventEnvelope, HistoryQuery, HistoryGrant } from '@aic/protocol';
import type { Services } from '../services';
import { Errors } from '../util';
import { clipBytes } from './budget';
import { environmentValues, HandoffRedactor, isEnvSource } from './redact';
import { pathAliases } from './path-aliases';
import { independentLines } from './transcript';


export const HISTORY_BYTES=32*1024;

/** 工具拿到的是本任务事件的可读投影。流式片段在打码前合并，用末条序号定位正文。 */
function projectEvents(s:Services,taskId:string) {
  const rows=s.db.all<{seq:number;session_id:string|null;type:string;payload:string}>(
    'SELECT seq,session_id,type,payload FROM events WHERE task_id=? AND replay=0 ORDER BY seq',taskId);
  const items:{seq:number;type:string;text:string;env:boolean}[]=[];
  const streams=new Map<string,{text:string;at:number}>();
  const envTools=new Map<string,boolean>();
  for(const row of rows) {
    const e={type:row.type,data:JSON.parse(row.payload)} as EventEnvelope;
    let text:string, env=false;
    const prefix=(row.session_id??'')+'\0';
    if(e.type==='thought.delta') continue;
    switch(e.type) {
      case 'message.user': text=e.data.text;break;
      case 'message.delta': case 'message.done': case 'tool.output': {
        const isTool=e.type==='tool.output';
        const key=isTool?prefix+'tool:'+e.data.toolId:prefix+'msg:'+e.data.messageId;
        const previous=streams.get(key);
        text=e.type==='message.done'&&e.data.text!==undefined?e.data.text:(previous?.text??'')+(e.data.text??'');
        if(previous) items[previous.at]!.text='（分片已合并至事件 '+row.seq+'）';
        env=isTool && !!envTools.get(prefix+e.data.toolId);
        streams.set(key,{text,at:items.length});break;
      }
      case 'tool.start': case 'tool.update': {
        const id=prefix+e.data.toolId;
        if(e.type==='tool.start') {envTools.delete(id);streams.delete(prefix+'tool:'+e.data.toolId);}
        env=isEnvSource((e.data.target??'')+' '+(e.data.title??'')) ||
          (e.type==='tool.update' && (e.data.files??[]).some(file=>isEnvSource(file.path)));
        if(env) {
          envTools.set(id,true);
          const prior=streams.get(prefix+'tool:'+e.data.toolId);
          if(prior) items[prior.at]!.env=true;
        }
        text=JSON.stringify(e.data);break;
      }
      case 'tool.end':env=!!envTools.get(prefix+e.data.toolId);text=JSON.stringify(e.data);break;
      case 'approval.requested': {
        const a=e.data.approval;text=[a.title,a.detail,a.reason].join('\n');env=isEnvSource(text);break;
      }
      case 'task.created':text=e.data.task.prompt;break;
      case 'plan.update':case 'approval.resolved':case 'session.started':case 'session.ended':
      case 'session.notice':case 'task.file_restored':text=JSON.stringify(e.data);break;
      default:continue;
    }
    items.push({seq:row.seq,type:row.type,text,env});
  }
  return items;
}

function boundedText(input:string,maxBytes=HISTORY_BYTES) {
  let limit=maxBytes-64;
  while (true) {
    const text=clipBytes(input,limit);
    const result={text,truncated:text!==input};
    const bytes=Buffer.byteLength(JSON.stringify(result));
    if(bytes<=maxBytes) return result;
    limit=Math.floor(limit*(maxBytes-64)/bytes);
  }
}

export function outgoingRedactor(s:Services,taskId:string,rows=projectEvents(s,taskId),extraValues:readonly string[]=[]) {
  const envOutputs=rows.filter(row=>row.env && row.type==='tool.output').map(row=>row.text);
  for (const session of s.db.all<{id:string}>("SELECT id FROM sessions WHERE task_id=? AND agent_id='independent'",taskId)) {
    const portable=independentLines(s.independentRuntime.portableEntries(taskId,session.id));
    envOutputs.push(...portable.flatMap(line=>line.env && line.output ? [line.output] : []));
  }
  const environment=[...environmentValues(envOutputs),...extraValues];
  const aliases=pathAliases(s.db,taskId,environment);
  const clean=async(input:string,source?:string)=>{
    const r=new HandoffRedactor([...await s.secrets.forRedaction(input),...s.tasks.sessionSecrets(taskId)],environment,aliases);
    return r.text(input,source);
  };
  return {clean,aliases,environment};
}

export async function readHistory(s:Services,grant:HistoryGrant,q:HistoryQuery) {
  const {taskId,handoffId}=grant;
  const record=s.db.get<{document_json:string}>('SELECT document_json FROM handoffs WHERE task_id=? AND id=?',taskId,handoffId);
  if(!record) throw Errors.notFound('本任务没有这次交接');
  const stored=JSON.parse(record.document_json);
  const rows=projectEvents(s,taskId);
  const {clean,aliases,environment}=outgoingRedactor(s,taskId,rows);
  if(q.name==='get_file_at') {
    const found=s.db.get("SELECT 1 FROM handoffs WHERE task_id=? AND json_extract(document_json,'$.meta.checkpoint')=? LIMIT 1",taskId,q.arguments.checkpoint);
    if(!found) throw Errors.forbidden('只能读取本任务已经登记的检查点');
    const alias=[...aliases].find(([,label])=>label===q.arguments.path);
    const path=alias?.[0]??q.arguments.path;
    const text=await s.workspaces.checkpointFile(taskId,q.arguments.checkpoint,path);
    return boundedText(await clean(text,path));
  }
  if(q.name==='list_decisions') {
    const items=s.db.all<{content:string}>(
      "SELECT content FROM task_memory WHERE task_id=? AND kind IN ('constraint','decision') AND superseded_by IS NULL ORDER BY created_at,rowid",taskId
    ).map(row=>JSON.parse(row.content)).filter((value:unknown):value is string=>typeof value==='string');
    const decisions:string[]=Array.isArray(stored.decisions)?stored.decisions.filter((v:unknown)=>typeof v==='string'):[];
    const corrections:string[]=Array.isArray(stored.corrections)?stored.corrections.filter((v:unknown)=>typeof v==='string'):[];
    const past=[...new Set([...corrections,...decisions])];
    const sections=[
      items.length ? '当前任务账本\n'+[...new Set(items)].join('\n') : '',
      past.length ? '本次交接当时的记录\n'+past.join('\n') : '',
    ];
    const text=await clean(sections.filter(Boolean).join('\n\n'));
    return boundedText(text);
  }
  const keys=await s.secrets.forRedaction(rows.map(r=>r.text).join('\n'));
  const redactor=new HandoffRedactor([...keys,...s.tasks.sessionSecrets(taskId)],environment,aliases);
  const results:{seq:number;type:string;text:string}[]=[];
  let bytes=0, truncated=false;
  for(const row of rows) {
    if(q.name==='get_events' && (row.seq<q.arguments.fromSeq || row.seq>q.arguments.toSeq))continue;
    const masked=redactor.text(row.text,row.env?'.env':undefined);
    if(q.name==='search' && !masked.toLocaleLowerCase().includes(q.arguments.query.toLocaleLowerCase()))continue;
    const clipped=boundedText(masked,8192);
    const result={seq:row.seq,type:row.type,text:clipped.text};
    if(clipped.truncated) truncated=true;
    const size=Buffer.byteLength(JSON.stringify(result))+1;
    if(bytes+size>HISTORY_BYTES-256 || results.length>=100) {truncated=true;break;}
    bytes+=size;results.push(result);
  }
  return {items:results,truncated};
}
