import type { EventEnvelope, HistoryQuery, HistoryGrant } from '@aic/protocol';
import type { Services } from '../services';
import { createHash } from 'node:crypto';
import { Errors } from '../util';
import { clipBytes } from './budget';
import { environmentValues, HandoffRedactor, isEnvSource } from './redact';
import { pathAliases } from './path-aliases';
import { independentLines } from './transcript';


export const HISTORY_BYTES=32*1024;

/** 工具拿到的是本任务事件的可读投影。流式片段在打码前合并，用末条序号定位正文。 */
function projectEvents(s:Services,taskId:string,toolsOnly=false) {
  const rows=s.db.all<{seq:number;session_id:string|null;type:string;payload:string}>(
    `SELECT seq,session_id,type,payload FROM events WHERE task_id=? AND replay=0
     ${toolsOnly?"AND type IN ('tool.start','tool.update','tool.output','tool.end')":''} ORDER BY seq`,taskId);
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

/** 只读取本任务已经发送的环境文本附件，未发送的草稿不参与历史脱敏。 */
export async function attachmentEnvironment(s:Services,taskId:string) {
  const values=new Set<string>();
  const sent=s.db.all<{id:string;name:string}>("SELECT id,name FROM attachments WHERE task_id=? AND used_at IS NOT NULL AND mime LIKE 'text/%'",taskId);
  for (const item of sent) {
    if (!isEnvSource(item.name)) continue;
    const {bytes}=await s.attachments.read(taskId,item.id);
    for (const value of environmentValues([bytes.toString('utf8')])) values.add(value);
  }
  return [...values];
}

export async function outgoingRedactor(s:Services,taskId:string,rows=projectEvents(s,taskId,true),extraValues:readonly string[]=[]) {
  const envOutputs=rows.flatMap(row=>{
    if (!row.env) return [];
    if (row.type==='tool.output') return [row.text];
    if (row.type==='tool.end') return [String(JSON.parse(row.text).summary??'')];
    return [];
  });
  for (const session of s.db.all<{id:string}>("SELECT id FROM sessions WHERE task_id=? AND agent_id='independent'",taskId)) {
    const portable=independentLines(s.independentRuntime.portableEntries(taskId,session.id));
    envOutputs.push(...portable.flatMap(line=>line.env && line.output ? [line.output] : []));
  }
  const environment=[...environmentValues(envOutputs),...await attachmentEnvironment(s,taskId),...extraValues];
  const aliases=pathAliases(s.db,taskId,environment);
  const clean=async(input:string,source?:string)=>{
    const r=new HandoffRedactor([...await s.secrets.forRedaction(input),...s.tasks.sessionSecrets(taskId)],environment,aliases);
    return r.text(input,source);
  };
  return {clean,aliases,environment};
}

type HistoryContext={fingerprint:string;rows:ReturnType<typeof projectEvents>;redactor:HandoffRedactor;masked:Map<number,string>}
  & Awaited<ReturnType<typeof outgoingRedactor>>;
const historyCache=new Map<string,HistoryContext>();
/** 同一任务连续查询时复用投影与打码结果；事件、已发送附件、保存的 Key、路径别名或会话密钥变化时重建（1.6 代码审查）。 */
async function historyContext(s:Services,taskId:string):Promise<HistoryContext> {
  const fingerprint=createHash('sha256').update(JSON.stringify([
    s.db.get<{n:number|null}>('SELECT MAX(seq) AS n FROM events WHERE task_id=?',taskId)?.n??0,
    s.db.get("SELECT COUNT(*) AS n,MAX(used_at) AS u FROM attachments WHERE task_id=? AND used_at IS NOT NULL",taskId),
    s.db.get("SELECT COUNT(*) AS n,group_concat(id||':'||hint) AS k FROM secrets"),
    s.db.get('SELECT COUNT(*) AS n FROM handoff_path_aliases WHERE task_id=?',taskId),
    s.db.get("SELECT COUNT(*) AS n,MAX(m.created_at) AS at FROM independent_messages m JOIN sessions x ON x.id=m.session_id WHERE x.task_id=?",taskId),
    s.tasks.sessionSecrets(taskId),
  ])).digest('hex');
  const cached=historyCache.get(taskId);
  if(cached?.fingerprint===fingerprint) return cached;
  const rows=projectEvents(s,taskId);
  const outgoing=await outgoingRedactor(s,taskId,rows);
  const keys=await s.secrets.forRedaction(rows.map(r=>r.text).join('\n'));
  const context={...outgoing,fingerprint,rows,masked:new Map<number,string>(),
    redactor:new HandoffRedactor([...keys,...s.tasks.sessionSecrets(taskId)],outgoing.environment,outgoing.aliases)};
  historyCache.delete(taskId);
  historyCache.set(taskId,context);
  while(historyCache.size>16) historyCache.delete(historyCache.keys().next().value!);
  return context;
}

export async function readHistory(s:Services,grant:HistoryGrant,q:HistoryQuery) {
  const {taskId,handoffId}=grant;
  const record=s.db.get<{document_json:string}>('SELECT document_json FROM handoffs WHERE task_id=? AND id=?',taskId,handoffId);
  if(!record) throw Errors.notFound('本任务没有这次交接');
  const stored=JSON.parse(record.document_json);
  const {clean,aliases,rows,redactor,masked:cache}=await historyContext(s,taskId);
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
  const results:{seq:number;type:string;text:string}[]=[];
  let bytes=0, truncated=false;
  for(const row of rows) {
    if(q.name==='get_events' && (row.seq<q.arguments.fromSeq || row.seq>q.arguments.toSeq))continue;
    let masked=cache.get(row.seq);
    if(masked===undefined) {masked=redactor.text(row.text,row.env?'.env':undefined);cache.set(row.seq,masked);}
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
