// 对话注释（对照 Codex，用户 2026-11-07）：选中对话里的文字 → [添加到对话] → 可选评论。
// 发送时把注释附在消息后面一起发给 Agent；Gateway 和协议不需要改动。

export interface AnnotationData {
  id: string;
  /** 选中的原文 */
  text: string;
  /** 用户评论，可以为空 */
  comment: string;
}

/** 单条选中文字的上限，避免误选整页对话把消息撑得过大 */
export const ANNOTATION_TEXT_MAX = 4000;

export function clipSelection(text: string): string {
  const t = text.trim();
  return t.length > ANNOTATION_TEXT_MAX ? t.slice(0, ANNOTATION_TEXT_MAX) + '…' : t;
}

/** 消息 + 注释 → 发给 Agent 的正文。没有注释时原样返回 */
export function composeWithAnnotations(text: string, annos: readonly AnnotationData[]): string {
  const body = text.trim();
  if (!annos.length) return body;
  const list = annos.map((a, i) => {
    const quote = a.text.split('\n').map((l) => '> ' + l).join('\n');
    const comment = a.comment.trim();
    return `${i + 1}. 所选文本：\n${quote}${comment ? `\n\n   用户评论：${comment}` : ''}`;
  }).join('\n\n');
  const head = annos.length === 1 ? '我在对话里标注了 1 处内容：' : `我在对话里标注了 ${annos.length} 处内容：`;
  return (body ? body + '\n\n---\n\n' : '') + head + '\n\n' + list;
}
