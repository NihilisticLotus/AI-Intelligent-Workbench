import type { HandoffDocument, HandoffNarrative } from '@aic/protocol';

/** 在预算裁剪后逐条按来源比对；缺失的事实直接从原记录补回。 */
export function restoreCoverage(doc:HandoffDocument, source:HandoffDocument): string[] {
  const added:string[]=[];
  function restore<T>(into:T[],required:T[],key:(x:T)=>string,label:string) {
    const keys=new Set(into.map(key));
    for (const x of required) if (!keys.has(key(x))) {
      into.push(x); keys.add(key(x)); added.push(label+'：'+key(x));
    }
  }
  restore(doc.files.changed,source.vcs.changed,f=>f.path,'改动文件');
  restore(doc.commands.items,source.commands.items.filter(c=>!c.ok),c=>String(c.seq),'失败命令事件');
  restore(doc.intent.constraints,source.intent.constraints,s=>s,'约束');
  restore(doc.corrections,source.corrections,s=>s,'纠正');
  restore(doc.tasks,source.tasks.filter(p=>p.status!=='completed'),p=>p.text+'\0'+p.status,'未完成计划');
  return added.map(s=>s.replaceAll('\0',' · '));
}

export function coverageComplete(doc:HandoffDocument,source:HandoffDocument):boolean {
  const paths=new Set(doc.files.changed.map(f=>f.path));
  const failed=new Set(doc.commands.items.filter(c=>!c.ok).map(c=>c.seq));
  const plans=new Set(doc.tasks.map(p=>JSON.stringify([p.status,p.text])));
  return source.vcs.changed.every(f=>paths.has(f.path))
    && source.commands.items.every(c=>c.ok || failed.has(c.seq))
    && source.intent.constraints.every(s=>doc.intent.constraints.includes(s))
    && source.corrections.every(s=>doc.corrections.includes(s))
    && source.tasks.every(p=>p.status==='completed'||plans.has(JSON.stringify([p.status,p.text])));
}

/** 叙述不生成事实。没有来源的路径、行内命令与相矛盾的测试结论从摘要剔除。 */
export function checkNarrative(narrative:HandoffNarrative,doc:HandoffDocument,evidence:string) {
  const rejected:string[]=[];
  const clean:HandoffNarrative={};
  const validate=(statement:string)=>{
    const quoted=Array.from(statement.matchAll(/\x60([^\x60]+)\x60/g),m=>m[1]!);
    const paths=statement.match(/(?:[\w.-]+[\\/])+[\w.-]+|[\w-]+\.(?:tsx?|jsx?|mjs|json|md|cs|py|txt|cpp|h|asset|unity)\b/gi)??[];
    const commands=statement.match(/\b(?:npm|pnpm|yarn|git|node|python|dotnet|cargo|pytest)\s+[\w./:\\-]+(?:[ \t]+[\w./:\\-]+)*/g)??[];
    const unknown=[...quoted,...paths,...commands].find(token=>!evidence.includes(token));
    if (unknown) { rejected.push('未找到来源：'+unknown); return false; }
    if (doc.commands.lastTest?.ok===false && /(?:测试.{0,4}(?:全部|均|已)?通过|全部通过)/.test(statement)) {
      rejected.push('最近一次测试失败，与叙述矛盾'); return false;
    }
    return true;
  };
  for(const key of ['attempts','decisions','openIssues'] as const) {
    const statements=narrative[key]?.filter(validate).filter(Boolean);
    if(statements?.length) clean[key]=statements;
  }
  if(narrative.current && validate(narrative.current)) clean.current=narrative.current;
  return {clean,rejected};
}
