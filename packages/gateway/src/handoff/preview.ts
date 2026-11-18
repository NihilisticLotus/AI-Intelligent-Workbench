import { HandoffPreview, type HandoffDocument, type HandoffTarget, type HandoffNarrative } from '@aic/protocol';
import type { Services } from '../services';
import { readHandoffState } from './state';
import { HandoffRedactor } from './redact';
import { estimateTokens, handoffLevel, recentWithin, sectionBudgets } from './budget';
import { transcriptBlocks } from './transcript';
import { checkNarrative, coverageComplete, restoreCoverage } from './checks';
import { renderHandoff } from './render';

function sanitizeDocument(source:HandoffDocument,r:HandoffRedactor):HandoffDocument {
  const d=structuredClone(source);
  const text=(value:string)=>r.text(value), optional=(value:string|null)=>value===null?null:text(value);
  d.meta.from.model=optional(d.meta.from.model); d.meta.to.model=optional(d.meta.to.model);
  d.intent.goal=text(d.intent.goal); d.intent.constraints=d.intent.constraints.map(text);
  d.userMessages=d.userMessages.map(m=>({...m,text:text(m.text)}));
  d.corrections=d.corrections.map(text); d.tasks=d.tasks.map(t=>({...t,text:text(t.text)}));
  const cleanFile=(f:HandoffDocument['files']['changed'][number])=>({...f,path:text(f.path),...(f.oldPath?{oldPath:text(f.oldPath)}:{})});
  d.files.changed=d.files.changed.map(cleanFile); d.files.read=d.files.read.map(f=>({...f,path:text(f.path)}));
  d.vcs.changed=d.vcs.changed.map(cleanFile); d.vcs.commits=d.vcs.commits.map(c=>({...c,title:text(c.title)}));
  d.vcs.branch=optional(d.vcs.branch); d.vcs.baseBranch=optional(d.vcs.baseBranch);
  d.env.workspace=optional(d.env.workspace); d.env.branch=optional(d.env.branch);
  const command=(c:HandoffDocument['commands']['items'][number])=>({...c,command:text(c.command),output:r.text(c.output,c.command)});
  d.commands.items=d.commands.items.map(command);
  if(d.commands.lastTest) d.commands.lastTest=command(d.commands.lastTest);
  return d;
}

export async function previewHandoff(s:Services,id:string,target:HandoffTarget,options:{
  narrative?:HandoffNarrative;forceH2?:boolean;checkpoint?:string;
}={}):Promise<HandoffPreview> {
  const {document:raw,lines,marked,window}=await readHandoffState(s,id,target);
  const values:string[]=[];
  JSON.stringify(raw,(_key,value)=>{if(typeof value==='string') values.push(value); return value;});
  for(const l of lines) values.push(l.text,l.output??'');
  if(options.narrative) values.push(...Object.values(options.narrative).flat());
  const keys=await s.secrets.forRedaction(values.join('\n'));
  // 同一段环境文件内容也可能被助手引述；已观察到的值在所有出口一并打码。
  const envValues:string[]=[];
  for (const line of lines) if (line.env && line.output) {
    for (const match of line.output.matchAll(/^\s*(?:export\s+)?[\w.-]+\s*=\s*([^\r\n]+)/gm)) {
      const value=match[1]!.trim().replace(/^["']|["']$/g,'');
      if (value) envValues.push(value);
    }
  }
  const redactor=new HandoffRedactor([...keys,...s.tasks.sessionSecrets(id),...envValues]);
  const source=sanitizeDocument(raw,redactor);
  let blocks=transcriptBlocks(lines,redactor);
  const fullTokens=estimateTokens(JSON.stringify(source)+'\n'+blocks.join('\n'));
  const level=options.forceH2?'H2':handoffLevel(fullTokens,window,!!options.narrative);
  const doc=structuredClone(source); doc.meta.level=level; doc.meta.checkpoint=options.checkpoint??null;
  const narrative:HandoffNarrative={};
  for(const field of ['attempts','decisions','openIssues'] as const) {
    if(options.narrative?.[field]) narrative[field]=options.narrative[field].map(v=>redactor.text(v));
  }
  if(options.narrative?.current) narrative.current=redactor.text(options.narrative.current);
  const {clean,rejected}=checkNarrative(narrative,doc,JSON.stringify(source)+'\n'+lines.map(l=>l.text+' '+(l.output??'')).join('\n'));
  Object.assign(doc,clean);
  if(level!=='H2') {
    const budget=sectionBudgets(window);
    budget.next(0.15); budget.account([doc.intent,doc.corrections]);
    const stateRoom=budget.next(0.15);
    if(doc.openIssues) doc.openIssues=recentWithin(doc.openIssues,stateRoom,v=>v);
    budget.account([doc.tasks,doc.current,doc.openIssues]);
    const decisionRoom=budget.next(0.2);
    if(doc.decisions) doc.decisions=recentWithin(doc.decisions,decisionRoom,v=>v);
    if(doc.attempts) doc.attempts=recentWithin(doc.attempts,Math.max(0,decisionRoom-estimateTokens(JSON.stringify(doc.decisions??[]))),v=>v);
    budget.account([doc.decisions,doc.attempts]);
    const fileRoom=budget.next(0.15);
    doc.files.read=recentWithin(doc.files.read.slice().reverse(),Math.max(0,fileRoom-estimateTokens(JSON.stringify(doc.files.changed))),f=>f.path).reverse();
    doc.commands.items=recentWithin(doc.commands.items,Math.max(0,fileRoom-estimateTokens(JSON.stringify(doc.files))),c=>c.command+'\n'+c.output);
    budget.account([doc.files,doc.commands,source.commands.items.filter(c=>!c.ok && !doc.commands.items.some(kept=>kept.seq===c.seq))]);
    const dialogue=budget.next(0.25);
    const recent=recentWithin(doc.userMessages,dialogue,m=>m.text);
    const selected=new Set([doc.userMessages[0]?.seq,doc.userMessages.at(-1)?.seq,...recent.map(m=>m.seq),...marked]);
    doc.userMessages=doc.userMessages.filter(m=>selected.has(m.seq));
    blocks=level==='H3'?recentWithin(blocks,Math.max(0,dialogue-estimateTokens(JSON.stringify(doc.userMessages))),v=>v):[];
  }
  const added=restoreCoverage(doc,source);
  const inline=!s.workspaces.get(id) || await s.workspaces.artifactConflicts(id,'.aic/TASK.md');
  const markdown=renderHandoff(doc,blocks,inline);
  return HandoffPreview.parse({document:doc,markdown,level,quality:{added,inconsistent:rejected,redactions:redactor.count,
    coveragePassed:coverageComplete(doc,source),consistencyPassed:!rejected.length,window,estimatedTokens:estimateTokens(markdown)}});
}
