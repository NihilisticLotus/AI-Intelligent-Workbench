import { visionOf, type AgentInfo } from '@aic/protocol';
export const screenshotName = (at: Date) => '截图-' + [at.getHours(),at.getMinutes(),at.getSeconds()].map((x)=>String(x).padStart(2,'0')).join('') + '.png';
export function clipboardFiles(items: ArrayLike<{ kind: string; getAsFile(): File | null }>): File[] { return Array.from(items).filter((x)=>x.kind==='file').map((x)=>x.getAsFile()).filter((x):x is File=>x!==null); }
export function attachmentLimit(size: number, count: number) { return count>=10?'每条消息最多 10 个附件':size>20*1024*1024?'附件太大，最大 20 MB':null; }
export function visionWarning(info: AgentInfo | undefined, model: string | null, count: number) {
  const vision=visionOf(info,model);
  const recommendation=info?.models.find((m)=>m.id!==model && visionOf(info,m.id)===true)??null;
  return { vision, recommendation, text: !count||vision===true?'':vision===false?`${info?.displayName??'当前 Agent'} · ${model??'当前模型'} 看不了图片，这 ${count} 张图片发过去它收不到`:'没有报告能不能看图片，可能收不到' };
}
