import { openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import path from 'node:path';

/** 只读小型普通文件；拒绝链接、超大文件与无效 UTF-8，不启动 git。 */
function smallText(file: string): string {
  const before = lstatSync(file);
  if (!before.isFile() || before.size > 4096) throw new Error('不是小型普通文件');
  const fd = openSync(file, 'r');
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > 4096 || before.ino !== opened.ino) throw new Error('文件已变化');
    const bytes = Buffer.alloc(4097), length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 4096) throw new Error('文件过大');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)).trim();
  } finally { closeSync(fd); }
}

export function projectBranch(root: string): string | null {
  try {
    let git = path.join(root, '.git'); const stat = lstatSync(git);
    if (stat.isFile()) {
      const pointer = /^gitdir: ([^\r\n\0]+)$/.exec(smallText(git));
      if (!pointer) return null;
      git = path.resolve(root, pointer[1]!);
      if (!lstatSync(git).isDirectory()) return null;
    } else if (!stat.isDirectory()) return null;
    const head = smallText(path.join(git, 'HEAD'));
    if (/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/.test(head)) return head.slice(0, 7);
    const branch = /^ref: refs\/heads\/(.+)$/.exec(head)?.[1];
    if (!branch || branch.length > 200 || /[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch) || branch.includes('..') || branch.includes('@{')
      || branch.endsWith('.') || branch.split('/').some((p) => !p || p.startsWith('.') || p.endsWith('.lock'))) return null;
    return branch;
  } catch { return null; }
}
