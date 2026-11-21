import type { WorkspaceChange, WorkspaceDiffLine } from '@aic/protocol';

/** 工具可能上报绝对路径，只在它属于当前副本时取相对路径，与服务端改动逐项核对。 */
export function resolveChangeTarget(files: Pick<WorkspaceChange, 'path' | 'oldPath'>[], target: string, root: string | null) {
  const source = target.replaceAll('\\', '/');
  let relative = source.replace(/^(\.\/)+/, '');
  const windows = !!root && /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(root);
  if (/^(?:\/|[a-z]:\/)/i.test(source)) {
    if (!root) return null;
    const prefix = root.replaceAll('\\', '/').replace(/\/+$/, '') + '/';
    if (!(windows ? source.toLowerCase().startsWith(prefix.toLowerCase()) : source.startsWith(prefix))) return null;
    relative = source.slice(prefix.length);
  }
  const current = files.find(file => file.path === relative);
  if (current) return current.path;
  const renamed = files.filter(file => file.oldPath === relative);
  if (renamed.length === 1) return renamed[0]!.path;
  if (!windows) return null;
  const folded = relative.toLowerCase();
  const matches = files.filter(file => file.path.toLowerCase() === folded || file.oldPath?.toLowerCase() === folded);
  return matches.length === 1 ? matches[0]!.path : null;
}

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
