import type { WorkspaceDiffLine } from '@aic/protocol';

/** 只解析补丁正文；文件名和内容始终由 React 当普通文字显示。 */
export function parseWorkspaceDiff(patch: string): WorkspaceDiffLine[] {
  const lines: WorkspaceDiffLine[] = [];
  let oldLine = 0, newLine = 0, inHunk = false;
  for (const text of patch.replace(/\n$/, '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2]); inHunk = true;
      lines.push({ kind: 'header', text, oldLine: null, newLine: null });
    } else if (inHunk && text.startsWith('+')) lines.push({ kind: 'add', text: text.slice(1), oldLine: null, newLine: newLine++ });
    else if (inHunk && text.startsWith('-')) lines.push({ kind: 'remove', text: text.slice(1), oldLine: oldLine++, newLine: null });
    else if (inHunk && text.startsWith(' ')) lines.push({ kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ });
    else if (inHunk && text.startsWith('\\')) lines.push({ kind: 'note', text: '文件末尾没有换行', oldLine: null, newLine: null });
    else { inHunk = false; if (text.startsWith('rename ') || text.startsWith('old mode') || text.startsWith('new mode')) lines.push({ kind: 'header', text, oldLine: null, newLine: null }); }
  }
  return lines;
}
export const changeLabels = { A: '新增', M: '修改', D: '删除', R: '重命名' } as const;
