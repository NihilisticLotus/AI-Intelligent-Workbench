// 文件夹浏览：只列目录，用于“添加项目”。客户端不接触本机路径拼接，只把返回的 path 原样传回。
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { FsBrowseResult, FsEntry } from '@aic/protocol';
import { Errors } from './util';

const isWin = process.platform === 'win32';
const P = isWin ? path.win32 : path.posix;
/** 一页默认条数（FsBrowseQuery.limit 的默认值也是它） */
export const DEFAULT_PAGE = 500;
const collator = new Intl.Collator('zh-CN', { numeric: true });
/** 排序：按中文习惯，名字比较相同时再按原始字符串，保证顺序唯一（游标分页依赖这一点） */
const byName = (a: string, b: string) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
/** 系统目录不展示 */
const HIDDEN = new Set(['system volume information', '$recycle.bin', '$windows.~bt', '$windows.~ws', 'recovery', 'config.msi']);

const hasGit = (dir: string) => { try { return existsSync(P.join(dir, '.git')); } catch { return false; } };

/**
 * 校验并规范化客户端传来的路径。
 * 只接受绝对路径；拒绝 `..` 段（路径穿越）、UNC / 设备路径（\\server、\\?\）和控制字符。
 */
const RESERVED_WIN_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const PROTECTED_PROJECT_SEGMENTS = new Set(['.claude', '.codex', '.codebuddy', '.workbuddy', '.zcode', '.gemini', '.ssh', '.aws', '.azure', '.aic-data']);

export function normalizeDirPath(input: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1000) throw Errors.badRequest('路径不正确');
  if (/[\u0000-\u001f]/.test(input)) throw Errors.badRequest('路径里有不允许的字符');
  if (/^[\\/]{2}/.test(input)) throw Errors.badRequest('不支持网络路径或设备路径', '请选择本机磁盘上的文件夹');
  const segs = input.split(/[\\/]+/);
  if (segs.some((s) => s === '..')) throw Errors.badRequest('路径里不能包含“..”');
  if (isWin && segs.some((s) => RESERVED_WIN_DEVICE.test(s))) throw Errors.badRequest('路径包含系统保留设备名');
  if (isWin) {
    if (!/^[A-Za-z]:([\\/]|$)/.test(input)) throw Errors.badRequest('请使用完整路径，例如 D:\\Projects');
    // 盘符后的冒号之外不允许再出现冒号（NTFS 备用数据流）
    if (input.indexOf(':', 2) !== -1) throw Errors.badRequest('路径里有不允许的字符');
  } else if (!input.startsWith('/')) {
    throw Errors.badRequest('请使用完整路径');
  }
  let p = P.normalize(isWin && /^[A-Za-z]:$/.test(input) ? `${input}\\` : input);
  // 去掉末尾分隔符（根目录除外）
  if (p.length > P.parse(p).root.length) p = p.replace(/[\\/]+$/, '');
  return p;
}

function roots(): FsEntry[] {
  const out: FsEntry[] = [];
  if (isWin) {
    for (let i = 67; i <= 90; i++) { // 从 C 开始，跳过软驱 A、B
      const d = `${String.fromCharCode(i)}:\\`;
      try { if (existsSync(d)) out.push({ name: `${String.fromCharCode(i)}:`, path: d, kind: 'drive', isGit: false }); } catch { /* 忽略不可用的盘 */ }
    }
  } else {
    out.push({ name: '/', path: '/', kind: 'drive', isGit: false });
  }
  const home = homedir();
  const common: [string, string][] = [['用户目录', home], ['桌面', P.join(home, 'Desktop')], ['文档', P.join(home, 'Documents')], ['下载', P.join(home, 'Downloads')]];
  for (const [name, p] of common) {
    try { if (statSync(p).isDirectory()) out.push({ name, path: p, kind: 'home', isGit: hasGit(p) }); } catch { /* 不存在就不显示 */ }
  }
  return out;
}

/** 游标：上一页最后一个文件夹的名字（不透明编码）。按名字续读，翻页期间目录有增删也不会漏或重复 */
const encodeCursor = (name: string) => Buffer.from(JSON.stringify([name]), 'utf8').toString('base64url');
function decodeCursor(c: string): string {
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  } catch { /* 下面统一报错 */ }
  throw Errors.badRequest('分页游标不正确');
}

export function browse(input?: string, page: { cursor?: string | undefined; limit?: number | undefined } = {}): FsBrowseResult {
  if (input === undefined) return { path: null, parent: null, entries: roots(), nextCursor: null };
  const limit = Math.max(1, Math.min(2000, page.limit ?? DEFAULT_PAGE));
  const after = page.cursor ? decodeCursor(page.cursor) : null;
  const dir = normalizeDirPath(input);
  let st;
  try { st = statSync(dir); } catch { throw Errors.notFound('找不到这个文件夹', '它可能已经被移动或删除'); }
  if (!st.isDirectory()) throw Errors.badRequest('这不是文件夹');
  let dirents;
  try { dirents = readdirSync(dir, { withFileTypes: true }); }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') throw Errors.forbidden('没有权限打开这个文件夹');
    throw Errors.notFound('无法打开这个文件夹');
  }
  // 先全量筛选、排序，再分页：不会因为截断而丢掉排在后面的文件夹
  const names: string[] = [];
  for (const d of dirents) {
    // 只列真正的目录；符号链接 / 目录联接（如 “Application Data”）不跟随，避免绕出所选位置
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    if (HIDDEN.has(d.name.toLowerCase()) || d.name.startsWith('$')) continue;
    names.push(d.name);
  }
  names.sort(byName);
  let start = 0;
  if (after !== null) {
    start = names.findIndex((n) => byName(n, after) > 0);
    if (start < 0) start = names.length;
  }
  const slice = names.slice(start, start + limit);
  // .git 检测要访问磁盘，只对这一页做
  const entries: FsEntry[] = slice.map((name) => { const full = P.join(dir, name); return { name, path: full, kind: 'dir', isGit: hasGit(full) }; });
  const more = start + limit < names.length;
  const parentDir = P.dirname(dir);
  return {
    path: dir, parent: parentDir === dir ? null : parentDir, entries,
    nextCursor: more && slice.length ? encodeCursor(slice[slice.length - 1]!) : null,
  };
}

/** 添加项目时校验路径：必须是存在的普通文件夹，且不能是磁盘根目录、用户主目录本身、系统目录或凭据目录 */
export function validateProjectDir(input: string): { path: string; isGit: boolean } {
  const dir = normalizeDirPath(input);
  let st;
  try { st = lstatSync(dir); } catch { throw Errors.badRequest('找不到这个文件夹', '请用“浏览”选择一个已存在的文件夹'); }
  if (st.isSymbolicLink()) throw Errors.badRequest('不能选择符号链接或目录联接作为项目目录');
  if (!st.isDirectory()) throw Errors.badRequest('请选择文件夹，而不是文件');
  const norm = dir.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const home = homedir().replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  if (dir === P.parse(dir).root || norm === home) throw Errors.badRequest('不能直接把磁盘根目录或用户主目录添加为项目', '请选择具体的项目子文件夹');
  if (/^[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata)(?:\/|$)/.test(norm) || /^\/(?:etc|usr|bin|sbin|boot|sys|proc)(?:\/|$)/.test(norm)) {
    throw Errors.badRequest('不能把系统目录添加为项目');
  }
  if (norm.split('/').some((s) => PROTECTED_PROJECT_SEGMENTS.has(s.replace(/[. ]+$/, '')))) {
    throw Errors.badRequest('不能把凭据或工作台私有数据目录添加为项目');
  }
  return { path: dir, isGit: hasGit(dir) };
}
