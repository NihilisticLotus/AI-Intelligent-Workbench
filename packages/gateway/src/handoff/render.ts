import type { HandoffDocument } from '@aic/protocol';
import { HISTORY_NOTICE } from './transcript';

export function renderHandoff(d:HandoffDocument,blocks:string[],inlineSummary:boolean,historyAvailable:boolean): string {
  const {from,to,level}=d.meta;
  const party=(p:typeof from)=>p.agent+(p.model?'（'+p.model+'）':'');
  const guidance = historyAvailable
    ? '先读正在改的文件再动手，不确定时先用 aic_history 查询。'
    : '请依据下文已核实的事实继续。'+(level==='H2'?'本次无法调用历史查询工具。':'本次不能回查省略的细节。');
  const sections=['以工作区当前文件为准。以下步骤已经执行，请勿重复。'+guidance,
    '# 交接：从 '+party(from)+' 到 '+party(to)+'（'+level+'）'];
  function section(title:string,lines:(string|null|undefined)[]) {
    const content=lines.filter(Boolean);
    if(content.length) sections.push('## '+title+'\n\n'+content.join('\n\n'));
  }
  section('任务目标与约束',[d.intent.goal,...d.intent.constraints]);
  const status={pending:'待处理',in_progress:'进行中',completed:'已完成'};
  section('当前状态',[...d.tasks.map(t=>status[t.status]+'：'+t.text),...d.corrections.filter(s=>!d.intent.constraints.includes(s))]);
  section('尝试过的方案',d.attempts??[]);
  section('关键决策与原因',d.decisions??[]);
  section('工作副本',[d.env.workspace,d.vcs.branch && '任务分支：'+d.vcs.branch,d.vcs.baseBranch && '基准分支：'+d.vcs.baseBranch,
    d.vcs.baseRef && '基准：'+d.vcs.baseRef,...d.vcs.commits.map(c=>c.id.slice(0,12)+' '+c.title)]);
  const fileLine=(f:HandoffDocument['files']['changed'][number])=>f.operation+' '+(f.oldPath?f.oldPath+' → ':'')+f.path+'（新增 '+(f.added??'未知')+'，删除 '+(f.removed??'未知')+'）';
  if(d.files.changed.length>50) {
    const groups=new Map<string,string[]>();
    for(const file of d.files.changed) {
      const dir=file.path.match(/^(.*)[/\\]/)?.[1]??'项目根目录';
      const group=groups.get(dir)??[];
      group.push(fileLine(file)); groups.set(dir,group);
    }
    section('已改动文件',[...groups].map(([dir,files])=>dir+'（'+files.length+' 个文件）\n'+files.join('\n')));
  } else section('已改动文件',d.files.changed.map(fileLine));
  section('已读文件',d.files.read.map(f=>f.path+'（'+f.count+' 次）'));
  const command=(c:HandoffDocument['commands']['items'][number])=>(c.ok?'成功':'失败')+'：'+c.command+(c.output?'\n'+c.output:'');
  section('执行过的命令与结果',d.commands.items.map(command));
  section('最近测试结果',d.commands.lastTest?[command(d.commands.lastTest)]:[]);
  section('已知问题与注意事项',d.openIssues??[]);
  section('用户原话',d.userMessages.map(m=>m.text));
  section('最近对话',blocks.length?[HISTORY_NOTICE,...blocks]:[]);
  section('下一步',[d.current]);
  if(level!=='H2' && historyAvailable) sections.push(inlineSummary?'任务说明已内联。需要更多细节时请用 aic_history 查询本任务历史。':'先读 .aic/TASK.md，需要更多细节时用 aic_history 查询本任务历史。');
  return sections.join('\n\n');
}
