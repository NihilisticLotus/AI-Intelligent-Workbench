import type { HandoffDocument } from '@aic/protocol';
import { sanitizeProvenanceText, wrapProvenance } from '../security/provenance';
import { HISTORY_NOTICE } from './transcript';

export function renderHandoff(d:HandoffDocument,blocks:string[],inlineSummary:boolean,historyAvailable:boolean): string {
  const {from,to,level}=d.meta;
  const clean=(value:string)=>sanitizeProvenanceText(value);
  const party=(p:typeof from)=>clean(p.agent)+(p.model?'（'+clean(p.model)+'）':'');
  const guidance = historyAvailable
    ? '先读正在改的文件再动手，不确定时先用 aic_history 查询。'
    : '请依据下文已核实的事实继续。'+(level==='H2'?'本次无法调用历史查询工具。':'本次不能回查省略的细节。');
  const sections=['以工作区当前文件为准。以下步骤已经执行，请勿重复。'+guidance,
    '# 交接：从 '+party(from)+' 到 '+party(to)+'（'+level+'）'];
  function section(title:string,lines:(string|null|undefined)[]) {
    const content=lines.filter((line): line is string => Boolean(line));
    if(content.length) sections.push('## '+title+'\n\n'+content.join('\n\n'));
  }
  section('任务目标与约束',[d.intent.goal,...d.intent.constraints].map(clean));
  const status={pending:'待处理',in_progress:'进行中',completed:'已完成'};
  section('当前状态',[...d.tasks.map(t=>status[t.status]+'：'+clean(t.text)),...d.corrections.filter(s=>!d.intent.constraints.includes(s)).map(clean)]);
  section('尝试过的方案',(d.attempts??[]).map(clean));
  section('关键决策与原因',(d.decisions??[]).map(clean));
  section('工作副本',[d.env.workspace && clean(d.env.workspace),d.vcs.branch && '任务分支：'+clean(d.vcs.branch),d.vcs.baseBranch && '基准分支：'+clean(d.vcs.baseBranch),
    d.vcs.baseRef && '基准：'+clean(d.vcs.baseRef),...d.vcs.commits.map(c=>clean(c.id.slice(0,12))+' '+clean(c.title))]);
  const fileLine=(f:HandoffDocument['files']['changed'][number])=>f.operation+' '+(f.oldPath?clean(f.oldPath)+' → ':'')+clean(f.path)+'（新增 '+(f.added??'未知')+'，删除 '+(f.removed??'未知')+'）';
  if(d.files.changed.length>50) {
    const groups=new Map<string,string[]>();
    for(const file of d.files.changed) {
      const dir=clean(file.path).match(/^(.*)[/\\]/)?.[1]??'项目根目录';
      const group=groups.get(dir)??[];
      group.push(fileLine(file)); groups.set(dir,group);
    }
    section('已改动文件',[...groups].map(([dir,files])=>dir+'（'+files.length+' 个文件）\n'+files.join('\n')));
  } else section('已改动文件',d.files.changed.map(fileLine));
  section('已读文件',d.files.read.map(f=>clean(f.path)+'（'+f.count+' 次）'));
  const command=(c:HandoffDocument['commands']['items'][number])=>(c.ok?'成功':'失败')+'：'+clean(c.command)+(c.output?'\n'+clean(c.output):'');
  const commandLines=d.commands.items.map(command);
  section('执行过的命令与结果',commandLines.length?[wrapProvenance('external_data','执行过的命令与结果',commandLines.join('\n\n'))]:[]);
  section('最近测试结果',d.commands.lastTest?[wrapProvenance('external_data','最近测试结果',command(d.commands.lastTest))]:[]);
  section('已知问题与注意事项',(d.openIssues??[]).map(clean));
  section('用户原话',d.userMessages.map(m=>clean(m.text)));
  section('最近对话',blocks.length?[wrapProvenance('external_data','最近对话与历史摘录',[HISTORY_NOTICE,...blocks].join('\n\n'))]:[]);
  section('下一步',d.current?[wrapProvenance('delegated','交接下一步说明',d.current)]:[]);
  if(level!=='H2' && historyAvailable) sections.push(inlineSummary?'任务说明已内联。需要更多细节时请用 aic_history 查询本任务历史。':'先读 .aic/TASK.md，需要更多细节时用 aic_history 查询本任务历史。');
  return sections.join('\n\n');
}
