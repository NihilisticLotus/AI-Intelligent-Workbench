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

// ---------------------------------------------------------------------
// 恢复注释的位置：草稿里存原文和它在对话文字里的大致位置（字符偏移），
// 页面重建后按原文重新找，多处相同时取离原位置最近的一处
// ---------------------------------------------------------------------
/** 在全文里找 raw，返回离 hint 最近的起点；找不到返回 -1 */
export function nearestIndex(all: string, raw: string, hint: number): number {
  if (!raw) return -1;
  let best = -1;
  for (let i = all.indexOf(raw); i >= 0; i = all.indexOf(raw, i + 1)) {
    if (best < 0 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
  }
  return best;
}

function textNodes(root: Node): { nodes: [Text, number][]; all: string } {
  const nodes: [Text, number][] = [];
  let all = '';
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) { nodes.push([n as Text, all.length]); all += (n as Text).data; }
  return { nodes, all };
}

/** 选区起点在 root 全部文字里的偏移；不在 root 里返回 -1 */
export function offsetIn(root: Node, range: Range): number {
  const { nodes } = textNodes(root);
  const hit = nodes.find(([n]) => n === range.startContainer);
  return hit ? hit[1] + range.startOffset : -1;
}

/** 按原文在 root 里重新建选区；找不到返回 null */
export function locate(root: Node, raw: string, hint: number): Range | null {
  const { nodes, all } = textNodes(root);
  const start = nearestIndex(all, raw, hint);
  if (start < 0) return null;
  const at = (pos: number): [Text, number] | null => {
    for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k]![1] <= pos) return [nodes[k]![0], pos - nodes[k]![1]];
    return null;
  };
  const a = at(start), b = at(start + raw.length);
  if (!a || !b) return null;
  const r = document.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], b[1]);
  return r;
}
