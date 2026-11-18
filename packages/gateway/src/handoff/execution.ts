import { IndependentRequestLedger } from '../independent/request-ledger';
import { createHash } from 'node:crypto';
import { HandoffRecord, HandoffSettings, type PermissionLevel, type HandoffTarget, type HandoffSendOptions, type HandoffProgressStep, type PromptAttachment, type EventEnvelope } from '@aic/protocol';
import type { Services } from '../services';
import { Errors, newId } from '../util';
import { estimateTokens } from './budget';
import { previewHandoff } from './preview';
import { outgoingRedactor } from './history';
import { environmentValues,isEnvSource } from './redact';

function checkForcedWindow(options:HandoffSendOptions, required:number, available:number) {
  if (options.forceH2 && required>available) {
    throw Errors.invalidState('完整转写预计需要 '+required+' token，目标窗口可用 '+available+' token。已保留当前会话，请更换大窗口模型后再交接。');
  }
}

export class HandoffExecution {
  readonly summaryLedger: IndependentRequestLedger;

  constructor(private readonly s: Services) {
    this.summaryLedger = new IndependentRequestLedger(s.db, 'summary');
    this.summaryLedger.recover();
    s.events.bus.on(event=>this.guard(event));
  }

  private guard(event:EventEnvelope) {
    const {taskId,sessionId}=event;
    if(!taskId || !sessionId || (event.type!=='tool.start' && event.type!=='tool.update'))return;
    const row=this.s.db.get<{id:string}>('SELECT id FROM handoffs WHERE task_id=? AND to_session_id=?',taskId,sessionId);
    if(!row)return;
    const calls=this.s.db.all<{payload:string}>("SELECT payload FROM events WHERE session_id=? AND type='tool.start' AND replay=0 ORDER BY seq LIMIT 10",sessionId).map(r=>JSON.parse(r.payload));
    const ordinal=calls.findIndex(call=>call.toolId===event.data.toolId);
    if(ordinal<0)return;
    const record=this.get(taskId,row.id), data={...calls[ordinal],...event.data};
    let warning:string | undefined;
    if(data.kind==='execute' && this.s.db.get(`SELECT 1 FROM task_memory WHERE task_id=? AND kind='command' AND source_seq<=?
      AND json_extract(content,'$.ok')=1 AND json_extract(content,'$.command') IN (?,?) LIMIT 1`,taskId,record.document.meta.toSeq??0,data.target??null,data.title??null)) warning='新 Agent 再次执行了已经成功的同一条命令。';
    if(['edit','delete','create'].includes(data.kind)) {
      const paths=[data.target,...(data.files??[]).map((f:{path:string})=>f.path)].filter(Boolean);
      if(record.document.corrections.some(item=>/禁止|不可|不要|不得|不许|已拒绝/.test(item) && paths.some(name=>item.includes(name)))) warning='新 Agent 正在改动用户明确要求保留的文件。';
    }
    if(!warning)return;
    const code='交接核对（工具 '+(ordinal+1)+'）：'+warning;
    if(record.quality.warnings?.includes(code))return;
    this.s.db.run("UPDATE handoffs SET quality_json=json_set(quality_json,'$.warnings',json(?)) WHERE id=?",JSON.stringify([...(record.quality.warnings??[]),code]),row.id);
    this.s.events.append({type:'session.notice',taskId,sessionId,data:{level:'warn',text:code}});
  }

  async restatement(taskId:string,sessionId:string,record:HandoffRecord) {
    const first=this.s.db.get<{payload:string}>("SELECT payload FROM events WHERE session_id=? AND replay=0 AND type IN ('message.done','message.delta') ORDER BY seq LIMIT 1",sessionId);
    if(!first)return;
    const messageId=JSON.parse(first.payload).messageId;
    const rows=this.s.db.all<{type:string;payload:string}>("SELECT type,payload FROM events WHERE session_id=? AND replay=0 AND type IN ('message.done','message.delta') AND json_extract(payload,'$.messageId')=? ORDER BY seq",sessionId,messageId);
    let reply='';
    for(const row of rows) {
      const data=JSON.parse(row.payload);
      if(row.type==='message.done')reply=data.text??reply;
      else reply+=data.text??'';
    }
    const {clean}=await outgoingRedactor(this.s,taskId);
    const text=(await clean(reply)).slice(0,2000);
    const doc=record.document;
    const known=[...new Set([...doc.files.changed.map(f=>f.path),...doc.files.read.map(f=>f.path)])];
    const matched=known.some(path=>text.includes(path)) || !!doc.current && text.includes(doc.current);
    const correction=!matched && known.length>0 && /[\w-]+\.(?:unity|asset|cs|tsx?|jsx?|md|txt|py|json)\b/i.test(text);
    this.s.db.run("UPDATE handoffs SET quality_json=json_set(quality_json,'$.restatement',json(?)) WHERE id=?",JSON.stringify({text,matched,corrected:false}),record.id);
    if(correction)return '交接核对：请以已核实的文件为准。已记录的文件有 '+known.slice(0,10).join('、')+'。'+(doc.current??'');
  }

  async attachments(taskId:string, inputs:PromptAttachment[], target:HandoffTarget) {
    const values:string[]=[];
    for(const item of inputs.filter(item=>isEnvSource(item.name) && item.mime.startsWith('text/'))) {
      const {bytes}=await this.s.attachments.read(taskId,item.attachmentId!);
      values.push(...environmentValues([bytes.toString('utf8')]));
    }
    const {clean}=await outgoingRedactor(this.s,taskId,undefined,values);
    const files:PromptAttachment[]=[];
    const texts:string[]=[];
    for(const [i,item] of inputs.entries()) {
      const {bytes}=await this.s.attachments.read(taskId,item.attachmentId!);
      const text=bytes.toString('utf8');
      const safe=await clean(text,item.name), name=await clean(item.name);
      if(!item.mime.startsWith('text/')) {
        if(text!==safe || isEnvSource(item.name)) throw Errors.badRequest('第 '+(i+1)+' 个附件含敏感内容，请替换或移除该附件后再发送');
        if(target.agent==='independent' && item.kind!=='image') throw Errors.badRequest('独立 Agent 无法读取这个二进制附件，请替换或移除后再发送');
      } else if(safe!==text || name!==item.name || isEnvSource(item.name)) {
        if(target.agent==='independent' && bytes.length>512*1024) throw Errors.tooLarge('独立 Agent 的文本附件最多 512 KB');
        texts.push('附件 '+name+'\n'+safe);
        continue;
      }
      files.push({...item,name});
    }
    return {files,texts,values};
  }

  settings(value?: HandoffSettings) {
    if (value?.summaryModel) {
      const {serviceId,modelId} = value.summaryModel;
      if (!this.s.independent.getService(serviceId).enabled || !this.s.independent.getModel(serviceId,modelId).enabled)
        throw Errors.badRequest('请选择已启用的摘要服务和模型');
    }
    return this.summaryLedger.summarySettings(value);
  }

  get(taskId:string,id:string) {
    const r=this.s.db.get(`SELECT h.*, h.id = (SELECT id FROM handoffs WHERE task_id=h.task_id AND state='sent'
      ORDER BY ordinal DESC LIMIT 1) AS latest_sent FROM handoffs h WHERE h.task_id=? AND h.id=?`,taskId,id);
    if (!r) throw Errors.notFound('找不到本任务的交接记录');
    return HandoffRecord.parse({id,latestSent:!!r.latest_sent,document:JSON.parse(String(r.document_json)),quality:JSON.parse(String(r.quality_json)),
      markdown:r.content_md,level:r.level,state:r.state,createdAt:r.created_at,ordinal:r.ordinal??1,edited:!!r.edited_by_user});
  }

  progress(taskId:string,handoffId:string,step:HandoffProgressStep,status:'running'|'done'|'skipped'|'failed') {
    this.s.events.append({type:'handoff.progress',taskId,sessionId:null,data:{handoffId,step,status}});
  }

  async prepare(taskId:string,target:HandoffTarget,text:string,attachmentIds:string[],options:HandoffSendOptions,environment:readonly string[],reverseOf?:string) {
    const {db,workspaces}=this.s;
    const signature=createHash('sha256').update(JSON.stringify([target.agent,target.model,target.effort,text,attachmentIds,reverseOf??null])).digest('hex');
    if (options.confirmedId) {
      const id=options.confirmedId, record=this.get(taskId,id);
      const row=db.get<{request_json:string}>('SELECT request_json FROM handoffs WHERE task_id=? AND id=?',taskId,id)!;
      if(record.state!=='prepared' || JSON.parse(row.request_json).signature!==signature) throw Errors.invalidState('待确认的交接与当前消息不匹配，请重新生成');
      if (record.document.meta.checkpoint) {
        const now=await workspaces.checkpointRestore(taskId,record.document.meta.checkpoint);
        if(now.files.length || now.skipped.length) throw Errors.invalidState('工作副本已变化，请重新生成交接');
      }
      if(db.get("SELECT 1 FROM events WHERE task_id=? AND seq>? AND replay=0 AND type IN ('message.user','tool.end','plan.update','task.memory_updated','session.handoff','approval.resolved') LIMIT 1",taskId,record.document.meta.toSeq??0)) throw Errors.invalidState('任务历史已变化，请重新生成交接');
      if(options.markdown!==undefined && record.markdown!==options.markdown) {
        const {clean}=await outgoingRedactor(this.s,taskId,undefined,environment);
        const markdown=await clean(options.markdown);
        checkForcedWindow(options, estimateTokens(markdown), record.quality.window);
        db.run('UPDATE handoffs SET content_md=?,edited_by_user=1 WHERE task_id=? AND id=?',markdown,taskId,id);
      }
      return {record:this.get(taskId,id),pending:false};
    }
    const id=newId('ho');
    this.progress(taskId,id,'generate','running');
    const used=db.all<{ref:string}>('SELECT ref FROM handoff_checkpoints WHERE task_id=?',taskId);
    const ordinal=used.reduce((n,row)=>Math.max(n,Number(row.ref.split('/').at(-1))),Number(db.get('SELECT MAX(ordinal) AS n FROM handoffs WHERE task_id=?',taskId)?.n??0))+1;
    try {
      const checkpoint=workspaces.get(taskId)?await workspaces.createCheckpoint(taskId,ordinal):undefined;
      const preview=await previewHandoff(this.s,taskId,target,{checkpoint,forceH2:options.forceH2,environment,summaryModel:options.forceH2?undefined:this.settings().summaryModel??undefined});
      const {document,quality,level,markdown}=preview;
      const source=db.get('SELECT agent,model,effort,profile_id FROM tasks WHERE id=?',taskId);
      db.run(`INSERT INTO handoffs(id,task_id,from_session_id,level,content_md,document_json,quality_json,created_at,state,ordinal,request_json)
        VALUES(?,?,?,?,?,?,?,?,'prepared',?,?)`,id,taskId,document.meta.from.sessionId,level,markdown,JSON.stringify(document),JSON.stringify(quality),Date.now(),ordinal,JSON.stringify({signature,source,reverseOf}));
      this.progress(taskId,id,'generate','done');
      this.progress(taskId,id,'coverage',quality.coveragePassed?'done':'failed');
      this.progress(taskId,id,'consistency','done');
      this.progress(taskId,id,'probe',quality.summaryFailure==='probe'?'failed':quality.probe?'done':'skipped');
      if(!quality.coveragePassed) throw Errors.invalidState('交接内容未覆盖任务事实，原会话可继续使用');
      const record=this.get(taskId,id);
      checkForcedWindow(options, quality.estimatedTokens, quality.window);
      await this.publish(taskId,record);
      return {record,pending:this.settings().confirmBeforeSend || !!record.quality.windowConfirmation};
    } catch(error) {
      db.run("UPDATE handoffs SET state='failed' WHERE task_id=? AND id=?",taskId,id);
      this.progress(taskId,id,'generate','failed');
      throw error;
    }
  }

  async publish(taskId:string,record:HandoffRecord) {
    if(!this.s.workspaces.get(taskId)) return;
    const base='.aic/handoffs/'+record.ordinal;
    await this.s.workspaces.writeTaskArtifacts(taskId,new Map([[base+'.md',record.markdown],[base+'.json',JSON.stringify(record.document,null,2)+'\n']]));
  }

  async input(taskId:string,record:HandoffRecord,summary:string,text:string,attachments:{texts:string[];values:string[]},permission:PermissionLevel,action:'redo'|'return'='return') {
    const {clean}=await outgoingRedactor(this.s,taskId,undefined,attachments.values);
    const user=await clean(text), body=await clean(summary), markdown=await clean(record.markdown);
    const instruction='请先用几句话复述目标、下一步和准备先读的文件，再继续本轮用户的任务。';
    const parts=user || attachments.texts.length ? ['## 本轮用户消息',user,...attachments.texts,instruction] : [action==='redo'?'工作台操作：用完整转写重新交接。请复述当前目标和下一步，等用户发送下一条消息。':'工作台操作：切回原 Agent。请复述交接信息，等用户发送下一条消息。'];
    if (record.document.meta.to.agent==='codex' && permission!=='readonly' && (user || attachments.texts.length)) {
      parts.push('若本轮用户要求编辑文件，请在当前工作副本使用 Codex 原生 apply_patch（函数形式为 tools.apply_patch），按现有权限申请编辑。历史里的工具名属于上一会话。若只需新建文件且交接中已有所需内容，可直接新增。用户禁止命令也适用于读取文件。');
    }
    if (action==='redo') checkForcedWindow({forceH2:true},estimateTokens([body,markdown,...parts].join('\n\n')),record.quality.window);
    return {text:parts.join('\n\n'),resources:[{uri:'aic://task/TASK.md',text:body},{uri:'aic://task/handoffs/'+record.ordinal+'.md',text:markdown}]};
  }
}
