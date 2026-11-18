import type { TaskMemoryItem } from '@aic/protocol';
import { redact } from '@aic/adapters';

export const TASK_FILE_BYTES = 32 * 1024;

export function taskSummaryBody(items: TaskMemoryItem[]): string {
  const sections = new Map<string,string[]>(['任务目标','约束','计划','改动文件','命令与结果','决策','问题','下一步'].map(name => [name,[]]));
  const labels = {goal:'任务目标', constraint:'约束', plan:'计划', file:'改动文件', command:'命令与结果', decision:'决策', issue:'问题', next:'下一步'};
  const statuses = {pending:'待处理', in_progress:'进行中', completed:'已完成'};
  const operations = {create:'创建', edit:'修改', delete:'删除'};
  for (const item of items) {
    let text: string;
    switch (item.kind) {
      case 'file': {
        const file = item.content;
        text = operations[file.operation]+' '+file.path+'（新增 '+(file.added ?? '未知')+'，删除 '+(file.removed ?? '未知')+'）';
        break;
      }
      case 'command': text = (item.content.ok ? '成功' : '失败')+'：'+item.content.command+'\n'+item.content.output; break;
      case 'plan': text = item.content.map(p=>statuses[p.status]+'：'+p.text).join('\n'); break;
      default: text = item.content;
    }
    sections.get(labels[item.kind])!.push(text);
  }
  return ['# 任务说明',...Array.from(sections, ([name, lines]) => lines.length ? '## '+name+'\n\n'+lines.join('\n\n') : '').filter(Boolean)].join('\n\n')+'\n';
}

export function limitTaskSummary(body: string, secrets: readonly string[] = []): string {
  // 用户保存的短 Key 也要在截断前完整替换。
  let masked = body;
  for (const secret of secrets.filter(Boolean).sort((a,b)=>b.length-a.length)) masked = masked.split(secret).join('***');
  const clean = redact(masked);
  const bytes = Buffer.from(clean);
  if (bytes.length <= TASK_FILE_BYTES) return clean;
  const suffix = '\n\n（文件达到大小上限，完整记录见工作台任务账本。）\n';
  let end = TASK_FILE_BYTES - Buffer.byteLength(suffix);
  while ((bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.toString('utf8',0,end)+suffix;
}
