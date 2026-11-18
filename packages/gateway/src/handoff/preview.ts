import { HandoffPreview, type HandoffDocument, type HandoffTarget, type HandoffNarrative, type HandoffLevel, type IndependentSelection } from '@aic/protocol';
import type { Services } from '../services';
import { readHandoffState } from './state';
import { environmentValues, HandoffRedactor } from './redact';
import { estimateTokens, handoffLevel, recentWithin, sectionBudgets } from './budget';
import { transcriptBlocks } from './transcript';
import { checkNarrative, coverageComplete, restoreCoverage } from './checks';
import { renderHandoff } from './render';
import { summaryRequests, probeFacts, assessProbe } from './summary';
import { pathAliases } from './path-aliases';

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
  summaryModel?:IndependentSelection;summaryTimeoutMs?:number;narrative?:HandoffNarrative;forceH2?:boolean;checkpoint?:string;environment?:readonly string[];
}={}):Promise<HandoffPreview> {
  const {document:raw,lines,marked,window}=await readHandoffState(s,id,target);
  const values:string[]=[];
  JSON.stringify(raw,(_key,value)=>{if(typeof value==='string') values.push(value); return value;});
  for(const l of lines) values.push(l.text,l.output??'');
  if(options.narrative) values.push(...Object.values(options.narrative).flat());
  const keys=await s.secrets.forRedaction(values.join('\n'));
  const envValues=[...environmentValues(lines.flatMap(line=>line.env && line.output ? [line.output] : [])),...(options.environment??[])];
  const paths=raw.files.changed.flatMap(file=>file.oldPath?[file.path,file.oldPath]:[file.path]);
  paths.push(...raw.files.read.map(file=>file.path));
  const aliases=pathAliases(s.db,id,envValues,paths);
  const redactor=new HandoffRedactor([...keys,...s.tasks.sessionSecrets(id)],envValues,aliases);
  const source=sanitizeDocument(raw,redactor);
  const fullBlocks=transcriptBlocks(lines,redactor);
  const fullTokens=estimateTokens(JSON.stringify(source)+'\n'+fullBlocks.join('\n'));
  // 独立运行时使用任务自己的工具清单。只有 ACP 接收会话会挂载历史服务。
  const historyAvailable = target.agent !== 'independent';
  const inline = !historyAvailable || !s.workspaces.get(id) || await s.workspaces.artifactConflicts(id,'.aic/TASK.md');
  function build(level:HandoffLevel, generated?:HandoffNarrative):HandoffPreview {
    let blocks=fullBlocks;
    const doc=structuredClone(source); doc.meta.level=level; doc.meta.checkpoint=options.checkpoint??null;
    const narrative:HandoffNarrative={};
    for(const field of ['attempts','decisions','openIssues'] as const) {
      if(generated?.[field]) narrative[field]=generated[field].map(v=>redactor.text(v));
    }
    if(generated?.current) narrative.current=redactor.text(generated.current);
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
    const markdown=renderHandoff(doc,blocks,inline,historyAvailable);
    return HandoffPreview.parse({document:doc,markdown,level,quality:{added,inconsistent:rejected,redactions:redactor.count,historyAvailable,
      coveragePassed:coverageComplete(raw,raw) && new Set(source.vcs.changed.map(file=>file.path)).size===new Set(raw.vcs.changed.map(file=>file.path)).size
        && coverageComplete(doc,source),consistencyPassed:!rejected.length,window,estimatedTokens:estimateTokens(markdown)}});
  }
  if (!options.summaryModel) return build(options.forceH2?'H2':handoffLevel(fullTokens,window,!!options.narrative), options.narrative);
  let generated: HandoffNarrative;
  let calls: ReturnType<typeof summaryRequests>;
  try {
    calls=summaryRequests(s,id,options.summaryModel,options.summaryTimeoutMs);
    const previous=s.db.get<{through:number; at:number}>(`SELECT e.seq AS through,e.ts AS at FROM handoffs h
      JOIN events e ON e.seq=json_extract(h.document_json,'$.meta.toSeq') AND e.task_id=h.task_id
      WHERE h.task_id=? AND h.state IN ('sent','returned') ORDER BY h.ordinal DESC LIMIT 1`,id);
    const incremental=previous ? fullBlocks.filter((_,i)=>{
      const line=lines[i]!;
      return line.seq===undefined ? line.at>=previous.at : line.seq>previous.through;
    }) : fullBlocks;
    generated=await calls.narrative(incremental.join('\n'));
    // 模型输出也需要按工作台已存 Key 检查，摘要输入中可能从未出现这些值。
    const outputKeys=await s.secrets.forRedaction(Object.values(generated).flat().join('\n'));
    const scrub=new HandoffRedactor(outputKeys,envValues,aliases);
    for (const key of ['attempts','decisions','openIssues'] as const) {
      if (generated[key]) generated[key]=generated[key].map(value=>scrub.text(value));
    }
    if (generated.current) generated.current=scrub.text(generated.current);
    redactor.count+=scrub.count;
  } catch {
    const fallback=build('H4');
    fallback.quality.summaryFailure='summary';
    return fallback;
  }
  const result=build(options.forceH2?'H2':handoffLevel(fullTokens,window,true),generated);
  if (result.level!=='H3') return result;
  const facts=probeFacts(source);
  let answers:string[];
  try { answers=await calls.probe(result.markdown,facts.map(f=>f.question)); }
  catch {
    const fallback=build('H4');
    fallback.quality.summaryFailure='probe';
    return fallback;
  }
  const {score,missed}=assessProbe(facts,answers);
  result.quality.probe=score;
  if (score.passed/score.total>=0.85) return result;
  const absent=missed.filter(f=>!result.markdown.includes(f.answer));
  const additions=absent.map(f=>'探针补齐：'+f.question);
  // 已呈现在交接正文中仍被答错的题不能算作修复；保留模型第一次的实际分数。
  if ((score.passed+absent.length)/score.total<0.85) {
    const full=build('H2',generated);
    if (full.quality.estimatedTokens<=window) {
      full.quality.probe=score;
      full.quality.added.push(...additions);
      return full;
    }
  }
  const excerpts='\n\n## 探针核对的原始事实\n\n'+missed.map(f=>f.question+'\n'+f.answer).join('\n\n');
  if ((score.passed+absent.length)/score.total<0.85 && estimateTokens(result.markdown+excerpts)>window) {
    const minimal=build('H4');
    minimal.markdown+=excerpts;
    minimal.quality.probe=score;
    minimal.quality.added.push(...missed.map(f=>'探针补齐：'+f.question));
    minimal.quality.estimatedTokens=estimateTokens(minimal.markdown);
    if (minimal.quality.estimatedTokens>window) minimal.quality.windowConfirmation=true;
    return minimal;
  }
  result.markdown+=excerpts;
  result.quality.added.push(...missed.map(f=>'探针补齐：'+f.question));
  result.quality.estimatedTokens=estimateTokens(result.markdown);
  return result;
}
