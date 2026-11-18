// 工作区只由登记记录寻址；任务副本与原项目之间不建立链接。
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile, chmod, mkdtemp, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WorkspaceRetention, WorkspaceOperationRecord, WorkspaceRecord, WorkspaceRequest, type MergeWorkspaceBody, type WorkspaceOperationResult, type WorkspaceChange, type WorkspaceChanges, type WorkspaceFile, type WorkspaceFileDiff } from '@aic/protocol';
import type { Db } from './db';
import { Git, GitError } from './git';
import { IndependentCommandExecutor } from './independent/commands';
import { WorkspaceTransferReply, type WorkspaceTransferItem } from '@aic/protocol';

export const SNAPSHOT_FILE_LIMIT = 50 * 1024 * 1024;
export const COPY_CONFIRM_LIMIT = 100 * 1024 * 1024;
export const FILE_DIFF_LIMIT = 1024 * 1024;
const IGNORED = new Set(['.git', 'node_modules', 'dist', '.venv', 'Library', 'Temp', 'Intermediate', 'DerivedDataCache', 'Binaries', '.aic-data'].map(x => x.toLowerCase()));

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly files: string[] = [], readonly bytes?: number) { super(message); }
}
function fail(code: string, message: string): never { throw new WorkspaceError(code, message); }
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
// 只保留副本根的工作台目录，子目录中的同名文件仍属于项目。
function consolePath(relative: string): boolean {
  return samePath(relative.split('/')[0]!, '.aic');
}
const consoleSpec = process.platform === 'win32' ? ':(top,icase,literal).aic' : ':(top,literal).aic';
const excludeConsole = process.platform === 'win32' ? ':(top,exclude,icase,literal).aic' : ':(top,exclude,literal).aic';
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}
export function workspaceRelative(value: string): string {
  if (!value || value.includes('\0') || value.includes(':') || value.includes('\\') || value.startsWith('/') || value.split('/').some(x => !x || x === '.' || x === '..')) {
    return fail('workspace.path', '文件路径不在工作区内。');
  }
  return value;
}
function matches(file: string, globs: string[]): boolean {
  return globs.some(raw => {
    const glob = raw.replaceAll('\\', '/').replace(/\/$/, '');
    if (!glob || glob.startsWith('/') || glob.includes(':') || glob.split('/').includes('..')) return fail('workspace.glob', '文件规则必须是工作区内的相对通配符。');
    const candidate = process.platform === 'win32' ? file.toLowerCase() : file;
    const pattern = process.platform === 'win32' ? glob.toLowerCase() : glob;
    return path.posix.matchesGlob(candidate, pattern) || path.posix.matchesGlob(candidate, `${pattern}/**`);
  });
}
async function safePath(root: string, relative: string, missing = false): Promise<string> {
  const parts = workspaceRelative(relative).split('/');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) fail('workspace.link', '工作区包含符号链接或目录联接，不能安全操作。');
      const actual = await realpath(cursor);
      if (!isInside(root, actual)) fail('workspace.path', '文件路径越过工作区边界。');
      if (stat.isFile() && stat.nlink > 1) fail('workspace.link', '工作区文件具有硬链接，不能安全操作。');
    } catch (e) {
      if (missing && (e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
  }
  return cursor;
}
/** 只用于显示改动的哈希缓存：大小、修改时间和文件编号都没变时不重读内容（ISSUE-0100）。 */
export type HashCache = Map<string, { size: number; mtimeMs: number; ino: number; hash: string }>;
async function fileInfo(root: string, relative: string, cache?: HashCache): Promise<WorkspaceFile> {
  const file = await safePath(root, relative);
  const before = await lstat(file);
  if (!before.isFile()) fail('workspace.file', '工作区只支持普通文件。');
  const known = cache?.get(file);
  if (known && known.size === before.size && known.mtimeMs === before.mtimeMs && known.ino === before.ino) return { path: relative, size: before.size, mtimeMs: before.mtimeMs, hash: known.hash };
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await lstat(await safePath(root, relative));
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('workspace.changed', '准备工作区时文件发生变化，请重试。');
  const digest = hash.digest('hex');
  // 与 git 的“同一时刻写入”判断一致：刚修改不到 2 秒的文件不缓存，避免同一时间戳内的再次写入被漏掉。
  if (cache && Date.now() - before.mtimeMs > 2000) cache.set(file, { size: before.size, mtimeMs: before.mtimeMs, ino: before.ino, hash: digest });
  return { path: relative, size: before.size, mtimeMs: before.mtimeMs, hash: digest };
}
async function enumerate(root: string, ignores: string[], builtins: boolean, legacyFiles: readonly string[] = []): Promise<WorkspaceFile[]> {
  // 先校验规则，空目录也不能绕过非法规则校验。
  for (const glob of ignores) matches('aic-validation', [glob]);
  const result: WorkspaceFile[] = [];
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
      if (consolePath(rel) || entry.name.toLowerCase() === '.git' || (builtins && IGNORED.has(entry.name.toLowerCase())) || matches(rel, ignores)) continue;
      const file = await safePath(root, rel);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) result.push(await fileInfo(root, rel));
      else fail('workspace.file', '工作区包含不能复制的特殊文件。');
    }
  };
  await visit(root);
  // 旧应用凭据只授权核对列出的路径，不遍历项目自己的 .aic。
  for (const name of legacyFiles) {
    try { result.push(await fileInfo(root, name)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result.sort((a,b) => a.path.localeCompare(b.path));
}
function equivalent(a: WorkspaceFile[], b: WorkspaceFile[]) {
  return a.length === b.length && a.every((f,i) => f.path === b[i]?.path && f.hash === b[i]?.hash);
}

export class WorkspaceManager {
  private projectOperations = new Set<string>();
  private pending = new Map<string, Promise<unknown>>();
  private changesCache = new Map<string, { fingerprint: string; until: number; value: { result: WorkspaceChanges; tree: string } }>();
  private hashCaches = new Map<string, HashCache>();
  invalidate(taskId: string) { this.changesCache.delete(taskId); }
  async settle() { await Promise.allSettled([...this.pending.values()]); }
  constructor(private readonly db: Db, readonly git: Git, private readonly dataDir: string) {}

  get(taskId: string): WorkspaceRecord | undefined {
    const row = this.db.get<{ record_json: string }>('SELECT record_json FROM workspace_records WHERE task_id=?', taskId);
    return row ? WorkspaceRecord.parse(JSON.parse(row.record_json)) : undefined;
  }
  private save(record: WorkspaceRecord) {
    this.db.run('INSERT INTO workspace_records(task_id,record_json,updated_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET record_json=excluded.record_json,updated_at=excluded.updated_at', record.taskId, JSON.stringify(record), Date.now());
  }
  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(id);
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(operation);
    this.pending.set(id, next);
    try { return await next; } finally { if (this.pending.get(id) === next) this.pending.delete(id); }
  }
  private async root() {
    await mkdir(this.dataDir, { recursive: true });
    return realpath(this.dataDir);
  }
  private async location(request: Pick<WorkspaceRequest, 'projectId' | 'taskId'>, parent = 'worktrees') {
    // ID 不解析；用完整 ID 保证不同任务的短前缀碰撞不会覆盖目录。
    for (const id of [request.projectId, request.taskId]) if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) fail('workspace.id', '工作区标识无效。');
    return safePath(await this.root(), `${parent}/${request.projectId}/${request.taskId}`, true);
  }
  private async checkedRecord(id: string) {
    const record = this.get(id);
    if (!record) return fail('workspace.missing', '没有登记的工作副本。');
    if (record.taskId !== id) fail('workspace.id', '工作副本登记标识不匹配。');
    const expected = await this.location(record);
    if (!samePath(expected, record.path)) return fail('workspace.path', '工作副本登记路径不匹配，已停止操作。');
    if (!samePath(await realpath(record.path), record.path)) return fail('workspace.path', '工作副本路径发生变化，已停止操作。');
    if (record.gitDir && !samePath(await this.location(record, 'shadow'), record.gitDir)) fail('workspace.path', '影子仓库路径不匹配。');
    if (!samePath(await realpath(record.projectPath), record.projectPath)) fail('workspace.path', '原项目位置发生变化。');
    if (record.kind === 'worktree') {
      const pointer = await readFile(await safePath(record.path, '.git'), 'utf8');
      const match = /^gitdir: (.+)\r?\n?$/.exec(pointer);
      if (!match || !record.worktreeGitDir || !samePath(path.resolve(record.path, match[1]!.trim()), record.worktreeGitDir)) fail('workspace.registration', '工作副本的 git 登记文件发生变化。');
      const backlink = (await readFile(path.join(record.worktreeGitDir,'gitdir'),'utf8')).trim();
      if (!samePath(path.resolve(backlink),path.join(record.path,'.git'))) fail('workspace.registration', 'git 工作副本登记不匹配。');
    }
    return record;
  }
  async runtimePath(taskId: string): Promise<string> {
    const record = await this.checkedRecord(taskId);
    if (record.state !== 'ready') return fail('workspace.state', '工作副本尚未准备好，不能启动任务。');
    return record.path;
  }
  private options(record: WorkspaceRecord) {
    const gitDir = record.gitDir ?? record.worktreeGitDir;
    return { cwd: record.path, gitDir, workTree: gitDir ? record.path : undefined };
  }
  private async create(input: WorkspaceRequest, kind: 'worktree' | 'copy') {
    const request = WorkspaceRequest.parse(input);
    return this.exclusive(request.taskId, async () => {
      if (!this.git.available) throw new GitError('unavailable', 'worktree');
      if (this.get(request.taskId)) fail('workspace.exists', '任务已经有登记的工作副本。');
      const source = await realpath(request.projectPath);
      const data = await this.root();
      if (samePath(source, data) || isInside(source, data) || isInside(data, source)) fail('workspace.overlap', '项目与数据目录不能互相包含。');
      const target = await this.location(request);
      try { await lstat(target); return fail('workspace.exists', '工作副本目录已存在，不能覆盖。'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      let sourceFiles: WorkspaceFile[];
      let baseRef: string | null = null, baseBranch: string | null = null, branch: string | null = null;
      if (kind === 'worktree') {
        const cwd = { cwd: source };
        if ((await this.git.checked(['rev-parse','--is-inside-work-tree'], cwd)).toString().trim() !== 'true') fail('workspace.git', '项目目录不是有效的 git 仓库。');
        const top = (await this.git.checked(['rev-parse','--show-toplevel'], cwd)).toString().trim();
        if (!samePath(await realpath(top), source)) fail('workspace.git', '请使用 git 仓库的根目录创建项目。');
        baseRef = (await this.git.checked(['rev-parse','--verify','HEAD'], cwd)).toString().trim();
        const symbolic = await this.git.run(['symbolic-ref','--quiet','--short','HEAD'], cwd);
        baseBranch = symbolic.code === 0 ? symbolic.stdout.toString().trim() : null;
        const slug = request.title.toLowerCase().match(/[a-z0-9]+/g)?.join('-').slice(0, 40);
        branch = `aic/${request.taskId}${slug ? `-${slug}` : ''}`;
        const exists = await this.git.run(['show-ref','--verify','--quiet',`refs/heads/${branch}`], cwd);
        if (exists.code === 0) fail('workspace.exists', '任务分支已经存在，不能接管或覆盖。');
        if (exists.code !== 1) throw new GitError('failed', 'show-ref', exists.code);
        const allUntracked = request.carryGlobs.length ? await this.git.checked(['ls-files','--others','-z'], cwd) : Buffer.alloc(0);
        sourceFiles = [];
        for (const rel of allUntracked.toString().split('\0').filter(Boolean)) {
          if (!consolePath(rel) && matches(rel, request.carryGlobs)) sourceFiles.push(await fileInfo(source, rel));
        }
      } else sourceFiles = await enumerate(source, request.ignoreGlobs, true);
      const bytes = sourceFiles.reduce((sum,f) => sum + f.size, 0);
      if (bytes > COPY_CONFIRM_LIMIT && !request.confirmLargeCopy) throw new WorkspaceError('workspace.copy_confirmation', '需要确认复制超过 100 MB 的文件。', sourceFiles.map(f => f.path), bytes);
      let lfs = false;
      try { lfs = /filter\s*=\s*lfs/.test(await readFile(await safePath(source,'.gitattributes'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const record: WorkspaceRecord = {
        taskId: request.taskId, projectId: request.projectId, kind, path: target, projectPath: source,
        gitDir: kind === 'copy' ? await this.location(request, 'shadow') : null, worktreeGitDir: null, branch, baseBranch, baseRef,
        snapshotBefore: null, snapshotAfter: null, ignoreGlobs: request.ignoreGlobs,
        largeFiles: sourceFiles.filter(f => f.size > SNAPSHOT_FILE_LIMIT), sourceFiles, snapshotFiles: [], lfs, state: 'preparing', createdAt: Date.now(),
      };
      this.save(record);
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await this.location(request);
        if (kind === 'worktree') {
          await this.git.checked(['worktree','add','-b',branch!,target,baseRef!], { cwd: source });
          record.worktreeGitDir = await realpath((await this.git.checked(['rev-parse','--absolute-git-dir'], { cwd: target })).toString().trim());
          this.save(record);
          record.largeFiles = (await this.currentFiles(record)).filter(f => f.size > SNAPSHOT_FILE_LIMIT);
        }
        else {
          await mkdir(target);
          await mkdir(record.gitDir!, { recursive: true });
          await this.git.checked(['init'], this.options(record));
        }
        for (const file of sourceFiles) {
          const from = await safePath(source, file.path);
          const to = await safePath(target, file.path, true);
          await mkdir(path.dirname(to), { recursive: true });
          await safePath(target, file.path, true);
          await copyFile(from, to, 1); // COPYFILE_EXCL：不覆盖已检出的文件。
          const copied = await fileInfo(target, file.path);
          const current = await fileInfo(source, file.path);
          if (copied.hash !== file.hash || current.hash !== file.hash) fail('workspace.changed', '复制时原文件发生变化，已停止准备。');
        }
        if (kind === 'copy' && !equivalent(sourceFiles, await enumerate(source, request.ignoreGlobs, true))) fail('workspace.changed', '复制期间原目录发生变化，已停止准备。');
        // 检出后的链接也必须拒绝，避免后续 Agent 沿链接触碰原项目。
        await this.currentFiles(record);
        record.state = 'ready'; this.save(record);
        if (kind === 'copy') await this.takeSnapshot(record, '任务开始前');
        return this.get(record.taskId)!;
      } catch (e) {
        record.state = 'failed'; this.save(record);
        // 保留失败登记供安全清理，不假装已经准备好，也不退回原目录执行。
        throw e;
      }
    });
  }
  createWorktree(input: WorkspaceRequest) { return this.create(input, 'worktree'); }
  createCopy(input: WorkspaceRequest) { return this.create(input, 'copy'); }

  private async currentFiles(record: WorkspaceRecord): Promise<WorkspaceFile[]> {
    if (record.kind === 'copy') return enumerate(record.path, record.ignoreGlobs, true);
    const names = (await this.git.checked(['ls-files','--cached','--others','--exclude-standard','-z'], this.options(record))).toString().split('\0').filter(Boolean);
    // 暂存区里已删除但磁盘仍存在的基线文件也要比较，不能被新 .gitignore 隐藏。
    if (record.baseRef) names.push(...(await this.git.checked(['ls-tree','-r','--name-only','-z',record.baseRef],this.options(record))).toString().split('\0').filter(Boolean));
    const result: WorkspaceFile[] = [];
    for (const file of [...new Set(names)]) {
      if (consolePath(file)) continue;
      let cache = this.hashCaches.get(record.taskId); if (!cache) { cache = new Map(); this.hashCaches.set(record.taskId, cache); }
      try { result.push(await fileInfo(record.path, file, cache)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return result;
  }

  private async buildTree(record: WorkspaceRecord, files: WorkspaceFile[]): Promise<string> {
    const index = path.join(await this.root(), `workspace-index-${randomUUID()}`);
    const opts = { ...this.options(record), env: { GIT_INDEX_FILE: index } };
    try {
      await this.git.checked(['read-tree','--empty'], opts);
      const small = files.filter(f => f.size <= SNAPSHOT_FILE_LIMIT);
      // 显式文件清单含未跟踪文件；私有索引不修改 Agent 或用户已经暂存的内容。
      if(record.kind==='copy') {
        // 影子快照必须保存原始字节，不能让 autocrlf 或 attributes 过滤器改变回滚内容。
        const entries:string[]=[];
        for(const file of small) {
          const target=await safePath(record.path,file.path);
          const oid=(await this.git.checked(['hash-object','-w','--no-filters','--',target],opts)).toString().trim();
          entries.push(`100644 ${oid}\t${workspaceRelative(file.path)}\0`);
        }
        if(entries.length)await this.git.checked(['update-index','-z','--index-info'],{...opts,input:entries.join('')});
      } else if (small.length) await this.git.checked(['add','-f','--pathspec-from-file=-','--pathspec-file-nul'], {
        ...opts, input: Buffer.from(small.map(f => workspaceRelative(f.path)).join('\0') + '\0'),
        env: { ...opts.env, GIT_LITERAL_PATHSPECS: '1' },
      });
      const tree = (await this.git.checked(['write-tree'], opts)).toString().trim();
      const current = await this.currentFiles(record);
      if (!equivalent([...files].sort((a,b)=>a.path.localeCompare(b.path)), [...current].sort((a,b)=>a.path.localeCompare(b.path)))) fail('workspace.changed', '读取改动时文件发生变化，请刷新。');
      return tree;
    } finally {
      await rm(index, { force: true }); await rm(`${index}.lock`, { force: true });
    }
  }
  private async takeSnapshot(record: WorkspaceRecord, label: string) {
    const files = await this.currentFiles(record);
    const tree = await this.buildTree(record, files);
    const args = ['commit-tree', tree, '-m', label];
    if (record.snapshotAfter) args.push('-p', record.snapshotAfter);
    const oid = (await this.git.checked(args, { ...this.options(record), env: {
      GIT_AUTHOR_NAME: 'AI Console', GIT_AUTHOR_EMAIL: 'snapshot@ai-console.local',
      GIT_COMMITTER_NAME: 'AI Console', GIT_COMMITTER_EMAIL: 'snapshot@ai-console.local',
    } })).toString().trim();
    await this.git.checked(['update-ref','refs/heads/aic/snapshots', oid], this.options(record));
    record.snapshotBefore ??= oid; record.snapshotAfter = oid; record.baseRef ??= oid; record.snapshotFiles = files;
    // 首次大文件清单作为回滚能力依据；后续大文件的变化通过 diff 单独检测。
    this.save(record);
    return oid;
  }
  snapshot(taskId: string, label: string): Promise<string> {
    return this.exclusive(taskId, async () => {
      const record = await this.checkedRecord(taskId);
      if (record.kind !== 'copy' || record.state !== 'ready') return fail('workspace.state', '此工作区不能创建影子快照。');
      return this.takeSnapshot(record, label);
    });
  }

  async sourceChanges(taskId: string): Promise<string[]> {
    const record = await this.checkedRecord(taskId);
    const current = await enumerate(record.projectPath, record.ignoreGlobs, true);
    const before = new Map(record.sourceFiles.filter(f => !consolePath(f.path)).map(f => [f.path, f.hash]));
    const after = new Map(current.map(f => [f.path, f.hash]));
    return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p));
  }

  private async changes(record: WorkspaceRecord): Promise<{ result: WorkspaceChanges; tree: string }> {
    if (!record.baseRef) return fail('workspace.base', '工作副本没有可比较的基准。');
    const opts = this.options(record);
    const current = record.kind === 'copy' ? record.snapshotFiles.filter(f => !consolePath(f.path)) : await this.currentFiles(record);
    // git 内容指纹让外部编辑立即失效；copy 以最新快照为准，快照完成即失效。
    const fingerprint = JSON.stringify([record.baseRef, record.snapshotAfter, current.map(f => [f.path, f.hash, f.size])]);
    const cached = this.changesCache.get(record.taskId);
    if (cached && cached.until > Date.now() && cached.fingerprint === fingerprint) return cached.value;
    const tree = record.kind === 'copy' ? record.snapshotAfter! : await this.buildTree(record, current);
    const baseEntries = (await this.git.checked(['ls-tree','-rlz', record.baseRef], opts)).toString().split('\0').filter(Boolean);
    const baseSizes = new Map<string, number>();
    for (const entry of baseEntries) {
      const match = /^\d+ blob [a-f0-9]+\s+(\d+)\t([\s\S]*)$/.exec(entry);
      if (match) baseSizes.set(match[2]!, Number(match[1]));
    }
    const afterSizes = new Map(current.map(f => [f.path, f.size]));
    const common = ['diff','--no-ext-diff','--no-textconv','--find-renames',record.baseRef,tree];
    const status = (await this.git.checked([...common, '--name-status','-z','--','.',excludeConsole],opts)).toString().split('\0');
    const stats = (await this.git.checked([...common, '--numstat','-z','--','.',excludeConsole],opts)).toString().split('\0');
    const counts = new Map<string, { added: number; removed: number; binary: boolean }>();
    for (let i = 0; i < stats.length && stats[i]; i++) {
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(stats[i]!);
      if (!m) fail('workspace.diff', '无法解析改动统计。');
      let file = m[3]!;
      if (!file) { i++; file = stats[++i]!; }
      counts.set(file, { added: m[1] === '-' ? 0 : Number(m[1]), removed: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
    }
    const files: WorkspaceChange[] = [];
    for (let i = 0; i < status.length && status[i]; i++) {
      const mode = status[i]![0];
      const oldPath = workspaceRelative(status[++i]!);
      const file = mode === 'R' ? workspaceRelative(status[++i]!) : oldPath;
      if (!['A','M','D','R','T'].includes(mode!)) fail('workspace.diff', '改动类型暂不支持。');
      const beforeSize = baseSizes.get(oldPath) ?? 0, afterSize = afterSizes.get(file) ?? 0;
      files.push({ path: file, ...(mode === 'R' ? { oldPath } : {}), status: (mode === 'T' ? 'M' : mode) as WorkspaceChange['status'],
        ...(counts.get(file) ?? { added: 0, removed: 0, binary: false }), beforeSize, afterSize,
        tooLarge: beforeSize > FILE_DIFF_LIMIT || afterSize > FILE_DIFF_LIMIT });
    }
    // 快照不存大文件，但不能把它们的变化静默丢掉或误显示成删除。
    const largeBase = new Map(record.largeFiles.map(f => [f.path, f]));
    for (const f of current) {
      const initial = largeBase.get(f.path);
      if (f.size <= SNAPSHOT_FILE_LIMIT && !initial) continue;
      if (initial?.hash === f.hash) {
        const at = files.findIndex(x => x.path === f.path);
        if (at >= 0) files.splice(at, 1);
        continue;
      }
      const at = files.findIndex(x => x.path === f.path);
      const change: WorkspaceChange = { path: f.path, status: initial || baseSizes.has(f.path) ? 'M' : 'A', added: 0, removed: 0, binary: true, tooLarge: true, beforeSize: initial?.size ?? baseSizes.get(f.path) ?? 0, afterSize: f.size };
      if (at >= 0) files[at] = change; else files.push(change);
    }
    for (const initial of record.largeFiles) if (!consolePath(initial.path) && !afterSizes.has(initial.path) && !files.some(f => f.path === initial.path)) {
      files.push({ path: initial.path, status: 'D', added: 0, removed: 0, binary: true, tooLarge: true, beforeSize: initial.size, afterSize: 0 });
    }
    const value = { tree, result: { files, revision: createHash('sha256').update(fingerprint).digest('hex'), added: files.reduce((n,f) => n+f.added,0), removed: files.reduce((n,f) => n+f.removed,0) } };
    this.changesCache.set(record.taskId, { fingerprint, until: Date.now() + 1500, value });
    return value;
  }
  diff(taskId: string): Promise<WorkspaceChanges> {
    return this.exclusive(taskId, async () => (await this.changes(await this.checkedRecord(taskId))).result);
  }
  fileDiff(taskId: string, relative: string): Promise<WorkspaceFileDiff> {
    workspaceRelative(relative);
    return this.exclusive(taskId, async () => {
      const record = await this.checkedRecord(taskId);
      const { result, tree } = await this.changes(record);
      const file = result.files.find(f => f.path === relative);
      if (!file) return fail('workspace.file', '该文件不在任务改动列表中。');
      if (file.binary || file.tooLarge) return { file, patch: null };
      try {
        const patch = await this.git.checked(['diff','--no-ext-diff','--no-textconv','--find-renames',record.baseRef!,tree,'--', ...(file.oldPath ? [file.oldPath] : []), file.path], {
          ...this.options(record), maxOutput: FILE_DIFF_LIMIT, env: { GIT_LITERAL_PATHSPECS: '1' },
        });
        return { file, patch: patch.toString('utf8') };
      } catch (e) {
        if (e instanceof GitError && e.kind === 'output_limit') return { file: { ...file, tooLarge: true }, patch: null };
        throw e;
      }
    });
  }

  restoreFile(taskId: string, relative: string): Promise<WorkspaceChanges> {
    workspaceRelative(relative);
    return this.exclusive(taskId, async () => {
      const record = await this.checkedRecord(taskId);
      if (record.state !== 'ready') return fail('workspace.state', '工作副本尚未准备好。');
      const { result } = await this.changes(record);
      const file = result.files.find(f => f.path === relative);
      if (!file) return fail('workspace.file', '该文件不在任务改动列表中。');
      if (record.largeFiles.some(f => f.path === relative || f.path === file.oldPath)) return fail('workspace.large', '此文件超过快照上限，不能还原。');
      const names = [...new Set([file.path, ...(file.oldPath ? [file.oldPath] : [])])];
      if (record.kind === 'worktree' && (await this.lfsFiles(record.path, names)).length) return fail('workspace.lfs', '此文件由 Git LFS 管理，工作台不能还原它的内容，请用你自己的 git 工具处理。');
      const before = await Promise.all(names.map(async name => {
        const target = await safePath(record.path, name, true);
        try {
          const stat = await lstat(target);
          if (!stat.isFile() || stat.size > SNAPSHOT_FILE_LIMIT) return fail('workspace.large', '此文件无法安全还原，请先备份后手动处理。');
          return { name, target, bytes: await readFile(target), mode: stat.mode };
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return { name, target, bytes: null, mode: null }; }
      }));
      const basePath = file.oldPath ?? file.path;
      const bytes = file.status === 'A' ? null : await this.git.checked(['show', record.baseRef! + ':' + basePath], { ...this.options(record), maxOutput: SNAPSHOT_FILE_LIMIT });
      try {
        for (const item of before) {
          await safePath(record.path, item.name, true);
          if (item.name === basePath && bytes !== null) {
            await mkdir(path.dirname(item.target), { recursive: true });
            await safePath(record.path, item.name, true); await writeFile(item.target, bytes);
          } else await rm(item.target, { force: true });
        }
        if (record.kind === 'copy') await this.takeSnapshot(record, '还原单个文件');
      } catch (e) {
        for (const item of before) {
          await safePath(record.path, item.name, true);
          if (item.bytes === null) await rm(item.target, { force: true });
          else { await writeFile(item.target, item.bytes); if (process.platform !== 'win32') await chmod(item.target, item.mode!); }
        }
        throw e;
      } finally { this.invalidate(taskId); }
      return (await this.changes(record)).result;
    });
  }


  operation(taskId: string): WorkspaceOperationRecord | undefined {
    const row = this.db.get<{ record_json: string }>('SELECT record_json FROM workspace_operations WHERE task_id=?', taskId);
    return row ? WorkspaceOperationRecord.parse(JSON.parse(row.record_json)) : undefined;
  }
  private saveOperation(record: WorkspaceOperationRecord) {
    this.db.run('INSERT INTO workspace_operations(task_id,record_json) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET record_json=excluded.record_json', record.taskId, JSON.stringify(record));
  }
  private operationRecord(taskId: string, state: WorkspaceOperationRecord['state']): WorkspaceOperationRecord {
    return {taskId,state,beforeCommit:null,mergeCommit:null,rollbackCommit:null,strategy:null,conflictFiles:[],appliedFiles:[],changedFiles:[],skippedLargeFiles:[],finishedAt:Date.now(),removedAt:null};
  }
  private projectOperation<T>(taskId: string, action: (record: WorkspaceRecord) => Promise<T>): Promise<T> {
    return this.exclusive(taskId, async () => {
      const record=await this.checkedRecord(taskId), key=record.projectPath.toLowerCase();
      if (this.projectOperations.has(key)) return fail('workspace.busy','同项目正在执行合并或回滚，请稍后重试。');
      if (record.state !== 'ready') return fail('workspace.state','工作副本尚未准备好。');
      if(this.operation(taskId)?.state==='pending')return fail('workspace.recovery','上次项目操作尚未确认完成，请重启工作台核对操作记录；不要重复合并。');
      this.projectOperations.add(key);
      try { return await action(record); } finally { this.projectOperations.delete(key); this.invalidate(taskId); }
    });
  }
  /** 这些路径里由 Git LFS 管理的文件（ISSUE-0097）：工作台不下载 LFS 对象，代为检出只会写出指针文本。 */
  private async lfsFiles(cwd: string, files: string[]): Promise<string[]> {
    if (!files.length) return [];
    const out = (await this.git.checked(['check-attr','-z','--stdin','filter'], { cwd, input: files.join('\0') + '\0' })).toString().split('\0');
    const result: string[] = [];
    for (let i = 0; i + 2 < out.length; i += 3) if (out[i + 2] === 'lfs') result.push(out[i]!);
    return result;
  }
  /** 任务改了提交钩子所在目录时，不能在用户项目里运行它们（ISSUE-0098）。 */
  private async hookFiles(projectPath: string, files: string[]): Promise<string[]> {
    const configured = await this.git.run(['config','--get','core.hooksPath'], { cwd: projectPath });
    const dirs = ['.husky', '.githooks'];
    if (configured.code === 0) {
      const value = configured.stdout.toString().trim();
      const resolved = path.resolve(projectPath, value);
      if (value && isInside(projectPath, resolved)) dirs.push(path.relative(projectPath, resolved).split(path.sep).join('/'));
    }
    const fold = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
    return files.filter(file => dirs.some(dir => fold(file) === fold(dir) || fold(file).startsWith(fold(dir) + '/')));
  }
  private async head(cwd: string) { return (await this.git.checked(['rev-parse','--verify','HEAD'],{cwd})).toString().trim(); }
  private async currentBranch(cwd: string) {
    const result=await this.git.run(['symbolic-ref','--quiet','--short','HEAD'],{cwd});
    if (result.code!==0 && result.code!==1) throw new GitError('failed','symbolic-ref',result.code);
    return result.code===0 ? result.stdout.toString().trim() : null;
  }
  private async dirtyFiles(cwd: string, untrackedAllowed: ReadonlySet<string> = new Set()) {
    const fields=(await this.git.checked(['status','--porcelain=v1','-z','--untracked-files=all'],{cwd})).toString().split('\0');
    const files: string[]=[];
    for(let i=0;i<fields.length && fields[i];i++) {
      const entry=fields[i]!;
      if(entry.startsWith('?? ')&&untrackedAllowed.has(process.platform==='win32'?entry.slice(3).toLowerCase():entry.slice(3)))continue;
      files.push(workspaceRelative(entry.slice(3)));
      if (/[RC]/.test(entry.slice(0,2))) files.push(workspaceRelative(fields[++i]!));
    }
    return [...new Set(files)];
  }
  private async originalReady(record: WorkspaceRecord): Promise<WorkspaceOperationResult | null> {
    const actual=await this.currentBranch(record.projectPath);
    if (!record.baseBranch || actual!==record.baseBranch) return {status:'wrong_branch',expected:record.baseBranch,actual};
    // 带入副本的本地文件在项目里是未跟踪文件，合并不会碰它们；只排除这些未跟踪项，任何已跟踪改动仍阻止（ISSUE-0099）。
    const carried=new Set(record.kind==='worktree'?record.sourceFiles.map(f=>process.platform==='win32'?f.path.toLowerCase():f.path):[]);
    const files=(await this.dirtyFiles(record.projectPath,carried));
    return files.length ? {status:'dirty',files} : null;
  }

  private changedPaths(before: WorkspaceFile[], after: WorkspaceFile[]): string[] {
    const a=new Map(before.map(f=>[f.path,f.hash])), b=new Map(after.map(f=>[f.path,f.hash]));
    return [...new Set([...a.keys(),...b.keys()])].filter(name=>a.get(name)!==b.get(name)).sort();
  }
  private async guardedTransfer(root: string, files:WorkspaceTransferItem[], temporary: string) {
    const privateRoot=await this.root();
    const request=path.join(temporary,randomUUID()+'.json');
    const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
    const host=fileURLToPath(new URL('./workspace-transfer.ps1',import.meta.url));
    const guard=fileURLToPath(new URL('./independent/file-guard.cs',import.meta.url));
    const bootstrap=`& ([scriptblock]::Create([IO.File]::ReadAllText(${quote(host)},[Text.Encoding]::UTF8))) ${quote(request)} ${quote(guard)}`;
    await writeFile(request,JSON.stringify({root,protectedRoot:privateRoot,managed:isInside(privateRoot,root),files}),{flag:'wx',mode:0o600});
    const executor=new IndependentCommandExecutor(privateRoot);
    const result=await executor.run({program:path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),args:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],timeoutMs:120000,maxOutputBytes:1024*1024},{cwd:root});
    if(result.reason!=='completed'||result.exitCode!==0)fail('workspace.recovery','文件操作被中断；已保留恢复材料，请先核对目录。');
    let reply;
    try {reply=WorkspaceTransferReply.parse(JSON.parse(result.stdout));}catch{fail('workspace.recovery','文件宿主未完整返回结果，已保留恢复材料。');}
    if(reply.files.some((name,i)=>name!==files[i]?.path))fail('workspace.recovery','文件宿主返回的清单不一致，已保留恢复材料。');
    if(!reply.ok)throw new WorkspaceError(reply.reason==='interrupted'?'workspace.recovery':'workspace.transfer','文件已变化、被占用或无法安全替换，操作已停止。',reply.files);
    if(reply.files.length!==files.length)fail('workspace.recovery','文件宿主返回的清单不完整，已保留恢复材料。');
  }
  /** 备份与候选内容先放在数据目录；校验整批后才写目标，异常时仅恢复本次已写入的文件。 */
  private async transferFiles(record: WorkspaceRecord, targetRoot: string, expected: WorkspaceFile[], names: string[], source: (name: string) => Promise<Buffer | string | null>, done: () => Promise<void>, legacyFiles: readonly string[] = []) {
    const privateRoot=await this.root(); const transfers=await safePath(privateRoot,'workspace-transfers',true);await mkdir(transfers,{recursive:true});
    const temporary=await mkdtemp(path.join(transfers,record.taskId+'-'));
    const saved=new Map<string,{backup:string|null; prepared:string|null; expected:string|null; result:string|null}>();
    const written: string[]=[]; const createdDirs: string[]=[]; let keep=false;
    const inspect=()=>enumerate(targetRoot,record.ignoreGlobs,true,legacyFiles);
    const check=async(name:string,hash:string|null)=>{
      try { const info=await fileInfo(targetRoot,name); if(info.hash!==hash) fail('workspace.changed','目标文件已变化，停止操作。'); }
      catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT' && hash===null) return; throw e; }
    };
    try {
      if(!equivalent(expected,await inspect())) fail('workspace.changed','目标目录已偏离预检基线，未应用任何文件。');
      const hashes=new Map(expected.map(f=>[f.path,f.hash]));
      for(let i=0;i<names.length;i++) {
        const name=workspaceRelative(names[i]!); const previous=hashes.get(name)??null;
        const backup=previous===null?null:path.join(temporary,i+'.before');
        if(backup) { await copyFile(await safePath(targetRoot,name),backup,1); if((await fileInfo(temporary,path.basename(backup))).hash!==previous) fail('workspace.changed','备份期间目标文件发生变化。'); }
        const value=await source(name); const prepared=value===null?null:path.join(temporary,i+'.after');
        if(prepared) { if(typeof value==='string') await copyFile(value,prepared,1);else await writeFile(prepared,value!,{flag:'wx'}); }
        const result=prepared?(await fileInfo(temporary,path.basename(prepared))).hash:null;
        saved.set(name,{backup,prepared,expected:previous,result});
      }
      if(!equivalent(expected,await inspect())) fail('workspace.changed','准备期间目标目录发生变化，未应用任何文件。');
      for(const name of names) {
        const item=saved.get(name)!;await check(name,item.expected);
        await safePath(targetRoot,name,true);
        if(item.prepared) {
          const parts=name.split('/').slice(0,-1);let relative='';
          for(const part of parts){relative=relative?relative+'/'+part:part;const dir=await safePath(targetRoot,relative,true);try { await lstat(dir); }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;createdDirs.push(dir);}}
        }
      }
      await writeFile(path.join(temporary,'manifest.json'),JSON.stringify({targetRoot,files:[...saved].map(([name,item])=>({path:name,...item}))}),{flag:'wx',mode:0o600});
      try {await this.guardedTransfer(targetRoot,names.map(name=>{const item=saved.get(name)!;return {path:name,expectedHash:item.expected,source:item.prepared,sourceHash:item.result};}),temporary);written.push(...names);}
      catch(e){if(e instanceof WorkspaceError)written.push(...e.files);throw e;}
      await done();
    } catch(e) {
      if(e instanceof WorkspaceError && e.code==='workspace.recovery')keep=true;
      try {const undo:WorkspaceTransferItem[]=[];for(const name of [...written].reverse()){const item=saved.get(name)!;await check(name,item.result);undo.push({path:name,expectedHash:item.result,source:item.backup,sourceHash:item.expected});}if(undo.length)await this.guardedTransfer(targetRoot,undo,temporary);}catch {keep=true;}
      for(const dir of [...new Set(createdDirs)].reverse()) { try { await rmdir(dir); }catch { /* 非空目录保留，不递归清理用户新增文件。 */ } }
      if(keep) fail('workspace.recovery','操作未完整恢复；已保留本次恢复材料，请先核对原目录，不要再次应用。');
      throw e;
    } finally {
      if(!isInside(transfers,temporary)||path.dirname(temporary)!==transfers) fail('workspace.path','恢复目录登记不匹配。');
      if(!keep) await rm(temporary,{recursive:true,force:true});
    }
  }
  async applyCopy(taskId: string): Promise<WorkspaceOperationResult> {
    return this.projectOperation(taskId,async record=>{
      if(record.kind!=='copy') return fail('workspace.kind','此操作只用于非 git 独立副本。');
      if(['applied','merged','discarded','rolled_back'].includes(this.operation(taskId)?.state??''))return fail('workspace.finished','此任务已结束。');
      const original=await enumerate(record.projectPath,record.ignoreGlobs,true);
      const current=await this.currentFiles(record);
      if(!equivalent(record.snapshotFiles.filter(f=>!consolePath(f.path)),current))return fail('workspace.changed','副本在最新快照后发生变化，请先完成一轮任务更新快照再应用。');
      const names=this.changedPaths(record.sourceFiles,current).filter(name=>!consolePath(name));if(!names.length)return {status:'no_changes'};
      // 只有任务要写的文件在项目里也被改过才算冲突；用户对其他文件的改动不阻止应用，也不会被覆盖（ISSUE-0101）。
      const touched=new Set(names);
      const drift=this.changedPaths(record.sourceFiles,original).filter(name=>touched.has(name));if(drift.length)return {status:'source_changed',files:drift};
      for(const name of names) {
        const initial=record.sourceFiles.find(f=>f.path===name);if(!initial||initial.size>SNAPSHOT_FILE_LIMIT)continue;
        const bytes=await this.git.checked(['show',record.baseRef!+':'+name],{...this.options(record),maxOutput:SNAPSHOT_FILE_LIMIT});
        if(createHash('sha256').update(bytes).digest('hex')!==initial.hash)fail('workspace.snapshot','初始快照无法按原始字节回滚，已停止应用。请从新任务重新准备副本。');
      }
      const after=new Map(current.map(f=>[f.path,f]));
      const large=names.filter(name=>[...record.sourceFiles,...current].some(f=>f.path===name&&f.size>SNAPSHOT_FILE_LIMIT));
      await this.transferFiles(record,record.projectPath,original,names,async name=>{
        const file=after.get(name);if(!file)return null;
        const currentFile=await fileInfo(record.path,name);if(currentFile.hash!==file.hash)fail('workspace.changed','副本文件发生变化，停止应用。');
        return safePath(record.path,name);
      },async()=>{
        const applied=await enumerate(record.projectPath,record.ignoreGlobs,true);
        const want=new Map(current.map(f=>[f.path,f.hash])),got=new Map(applied.map(f=>[f.path,f.hash]));
        if(names.some(name=>want.get(name)!==got.get(name)))fail('workspace.changed','应用时目标或副本发生变化，正在恢复本次写入。');
        this.saveOperation({...this.operationRecord(taskId,'applied'),appliedFiles:applied,changedFiles:names,skippedLargeFiles:large});
      });
      return {status:'applied',files:names,skippedLargeFiles:large};
    });
  }
  async rollbackCopy(taskId: string): Promise<WorkspaceOperationResult> {
    return this.projectOperation(taskId,async record=>{
      if(record.kind!=='copy')return fail('workspace.kind','此操作只用于非 git 独立副本。');
      const operation=this.operation(taskId), applied=operation?.state==='applied';
      if(operation && ['discarded','rolled_back','merged'].includes(operation.state))return fail('workspace.finished','没有可以回滚的副本或应用。');
      const legacy = applied && this.db.get('SELECT 1 FROM workspace_operations WHERE task_id=? AND legacy_applied=1', taskId);
      const legacyFiles = legacy ? operation.changedFiles.filter(consolePath) : [];
      const root=applied?record.projectPath:record.path, current=await enumerate(root,record.ignoreGlobs,true,legacyFiles);
      // 撤销应用只处理当初应用的文件；用户之后对其他文件的改动保留，不算冲突（ISSUE-0101）。
      const appliedNames=applied?new Set(operation.changedFiles):null;
      if(applied) { const drift=this.changedPaths(operation.appliedFiles,current).filter(name=>appliedNames!.has(name));if(drift.length)return {status:'source_changed',files:drift}; }
      const names=this.changedPaths(record.sourceFiles,current).filter(name=>(!consolePath(name)||legacyFiles.includes(name))&&(!appliedNames||appliedNames.has(name)));
      const skipped=names.filter(name=>[...record.sourceFiles,...current].some(f=>f.path===name&&f.size>SNAPSHOT_FILE_LIMIT));
      const small=names.filter(name=>!skipped.includes(name));const originals=new Map(record.sourceFiles.map(f=>[f.path,f]));
      const previous=structuredClone(record);
      try {await this.transferFiles(record,root,current,small,async name=>{
        const initial=originals.get(name);if(!initial)return null;
        const bytes=await this.git.checked(['show',record.baseRef!+':'+name],{...this.options(record),maxOutput:SNAPSHOT_FILE_LIMIT});
        if(createHash('sha256').update(bytes).digest('hex')!==initial.hash)fail('workspace.snapshot','初始快照与原始文件字节不一致，停止回滚。');return bytes;
      },async()=>{
        if(!applied)await this.takeSnapshot(record,'回滚副本到任务开始前');
        this.saveOperation({...operation??this.operationRecord(taskId,'restored'),taskId,state:applied?'rolled_back':'restored',changedFiles:names,skippedLargeFiles:skipped,finishedAt:Date.now()});
      },legacyFiles);}catch(e){if(!applied){await this.git.checked(['update-ref','refs/heads/aic/snapshots',previous.snapshotAfter!],this.options(previous));this.save(previous);}throw e;}
      return {status:'rolled_back',skippedLargeFiles:skipped};
    });
  }

  async mergeGit(taskId: string, body: MergeWorkspaceBody): Promise<WorkspaceOperationResult> {
    return this.projectOperation(taskId, async record => {
      if (record.kind!=='worktree') return fail('workspace.kind','此操作只用于 git 工作副本。');
      if (['merged','applied','discarded','rolled_back'].includes(this.operation(taskId)?.state ?? '')) return fail('workspace.finished','此任务已结束。');
      if (!record.branch || await this.currentBranch(record.path)!==record.branch) return fail('workspace.branch','任务分支发生变化，不能合并。');
      const blocked=await this.originalReady(record); if(blocked) return blocked;
      const before=await this.head(record.projectPath), opts={cwd:record.path};
      // 即使最终树已删掉说明，中间提交也会随“保留提交记录”进入项目历史。
      const internalCommit = await this.git.checked(['rev-list','--full-history','-1',before+'..HEAD','--',consoleSpec],opts);
      if (internalCommit.length) return fail('workspace.private_history','任务提交包含工作台专用目录 .aic，不能将该历史合并进项目。');
      if ((await this.dirtyFiles(record.path)).length) {
        await this.git.checked(['add','--all','--','.',excludeConsole],opts);
        // 只排除 add 无法移除其他进程先前放入暂存区的任务说明。
        await this.git.checked(['reset','-q','HEAD','--',consoleSpec],opts);
        // 从项目带入的本地文件只供副本运行使用，不能进入任务提交和用户仓库历史（ISSUE-0099）。
        const carried=record.sourceFiles.map(f=>workspaceRelative(f.path));
        if(carried.length)await this.git.checked(['reset','-q','--pathspec-from-file=-','--pathspec-file-nul'],{...opts,input:carried.join('\0')+'\0',env:{GIT_LITERAL_PATHSPECS:'1'}});
        const staged=await this.git.run(['diff','--cached','--quiet'],opts);
        if(staged.code===1) await this.git.checked(['commit','-m',body.message],opts);
        else if(staged.code!==0) throw new GitError('failed','diff',staged.code);
      }
      const merge=await this.git.run(['merge','--no-edit','-m','整合项目基准分支',before],opts);
      if(merge.code!==0) {
        const files=(await this.git.checked(['diff','--name-only','--diff-filter=U','-z'],opts)).toString().split('\0').filter(Boolean).map(workspaceRelative);
        const merging=await this.git.run(['rev-parse','--verify','MERGE_HEAD'],opts);
        if(merging.code===0) await this.git.checked(['merge','--abort'],opts);
        if(!files.length) throw new GitError('failed','merge',merge.code);
        this.saveOperation({...this.operationRecord(taskId,'conflict'),conflictFiles:files,beforeCommit:before});
        return {status:'conflict',files};
      }
      const second=await this.originalReady(record); if(second) return second;
      const current=await this.head(record.projectPath);
      if(current!==before) return {status:'new_commits',expected:before,actual:current};
      const taskHead=await this.head(record.path);
      const same=await this.git.run(['diff','--quiet',before,taskHead],opts);
      if(same.code===0) return {status:'no_changes'};
      if(same.code!==1) throw new GitError('failed','diff',same.code);
      const changed=(await this.git.checked(['diff','--name-only','-z',before,taskHead],opts)).toString().split('\0').filter(Boolean).map(workspaceRelative);
      if (changed.some(consolePath)) return fail('workspace.private_history','合并结果涉及工作台专用目录 .aic，已停止合并。');
      const lfs = await this.lfsFiles(record.path, changed); if (lfs.length) return { status: 'manual_required', reason: 'lfs', files: lfs };
      const hooks = await this.hookFiles(record.projectPath, changed); if (hooks.length) return { status: 'manual_required', reason: 'hooks', files: hooks };
      // 被忽略的本地文件也不能因新增受跟踪文件而被静默覆盖。
      const ignored=(await this.git.checked(['ls-files','--others','--ignored','--exclude-standard','-z'],{cwd:record.projectPath})).toString().split('\0').filter(Boolean);
      const collisions=ignored.filter(file=>changed.some(p=>samePath(p,file)||isInside(p,file)||isInside(file,p)));
      if(collisions.length) return {status:'dirty',files:collisions};
      const original={cwd:record.projectPath};
      const pending={...this.operationRecord(taskId,'pending'),beforeCommit:before,strategy:body.strategy,changedFiles:changed,
        pending:{kind:'merge' as const,headBefore:before,expectedTree:(await this.git.checked(['rev-parse',taskHead+'^{tree}'],opts)).toString().trim()}};
      // 先登记意图；提交已产生而最终登记失败时，重启只核对提交并补记录，不重写项目。
      this.saveOperation(pending);
      try {
        if(body.strategy==='squash') {
          await this.git.checked(['merge','--squash','--no-commit','--no-overwrite-ignore',record.branch],original);
          await this.git.checked(['commit','-m',body.message],{...original,userCommit:true});
        } else await this.git.checked(['merge','--no-ff','--no-edit','--no-overwrite-ignore','-m',body.message,record.branch],{...original,userCommit:true});
      } catch(e) {
        const merging=await this.git.run(['rev-parse','--verify','MERGE_HEAD'],original);
        if(merging.code===0) await this.git.checked(['merge','--abort'],original);
        else if(await this.head(record.projectPath)===before) {
          // 原项目在操作前已确认干净；这里只撤回本次失败压缩合并写入的索引和文件。
          await this.git.checked(['reset','--merge',before],original);
        }
        if(await this.head(record.projectPath)===before && !(await this.dirtyFiles(record.projectPath)).length)this.db.run('DELETE FROM workspace_operations WHERE task_id=?',taskId);
        throw e;
      }
      const commit=await this.head(record.projectPath);
      this.saveOperation({...this.operationRecord(taskId,'merged'),beforeCommit:before,mergeCommit:commit,strategy:body.strategy,changedFiles:changed});
      return {status:'merged',commit};
    });
  }
  async rollbackGit(taskId: string): Promise<WorkspaceOperationResult> {
    return this.projectOperation(taskId, async record => {
      const operation=this.operation(taskId);
      if(record.kind!=='worktree'||operation?.state!=='merged'||!operation.mergeCommit) return fail('workspace.state','没有可撤销的合并。');
      const blocked=await this.originalReady(record); if(blocked) return blocked;
      const actual=await this.head(record.projectPath);
      if(actual!==operation.mergeCommit) return {status:'new_commits',expected:operation.mergeCommit,actual};
      const opts={cwd:record.projectPath};
      const lfs=await this.lfsFiles(record.projectPath,operation.changedFiles);if(lfs.length)return {status:'manual_required',reason:'lfs',files:lfs};
      this.saveOperation({...operation,state:'pending',pending:{kind:'rollback',headBefore:actual,expectedTree:(await this.git.checked(['rev-parse',operation.beforeCommit+'^{tree}'],opts)).toString().trim()}});
      try {
        await this.git.checked(['revert','--no-commit',...(operation.strategy==='merge'?['-m','1']:[]),operation.mergeCommit],opts);
        await this.git.checked(['commit','-m','撤销任务合并','-m',`撤销的合并提交：${operation.mergeCommit}`],{...opts,userCommit:true});
      }catch(e) {
        const state=await this.git.run(['rev-parse','--verify','REVERT_HEAD'],opts);
        if(state.code===0)await this.git.checked(['revert','--abort'],opts);
        else if(await this.head(record.projectPath)===actual)await this.git.checked(['reset','--merge',actual],opts);
        if(await this.head(record.projectPath)===actual&&!(await this.dirtyFiles(record.projectPath)).length)this.saveOperation(operation);throw e;
      }
      const commit=await this.head(record.projectPath);
      this.saveOperation({...operation,state:'rolled_back',rollbackCommit:commit,finishedAt:Date.now()});
      return {status:'rolled_back',skippedLargeFiles:[],commit};
    });
  }

  async recoverOperations() {
    const unresolved:string[]=[];
    for(const {task_id:id} of this.db.all<{task_id:string}>('SELECT task_id FROM workspace_operations')) {
      const operation=this.operation(id);if(operation?.state!=='pending'||!operation.pending)continue;
      try {
        const record=await this.checkedRecord(id),pending=operation.pending;
        if(record.kind!=='worktree'||await this.currentBranch(record.projectPath)!==record.baseBranch){unresolved.push(id);continue;}
        const head=await this.head(record.projectPath),opts={cwd:record.projectPath};
        if(head===pending.headBefore) {
          if((await this.dirtyFiles(record.projectPath)).length){unresolved.push(id);continue;}
          if(pending.kind==='merge')this.db.run('DELETE FROM workspace_operations WHERE task_id=?',id);
          else {const {pending:_pending,...rest}=operation;this.saveOperation({...rest,state:'merged'});}
        }else {
          const parent=(await this.git.checked(['rev-parse',head+'^'],opts)).toString().trim();
          const tree=(await this.git.checked(['rev-parse',head+'^{tree}'],opts)).toString().trim();
          if(parent!==pending.headBefore||tree!==pending.expectedTree){unresolved.push(id);continue;}
          const {pending:_pending,...rest}=operation;
          this.saveOperation({...rest,state:pending.kind==='merge'?'merged':'rolled_back',...(pending.kind==='merge'?{mergeCommit:head}:{rollbackCommit:head}),finishedAt:Date.now()});
        }
      }catch{unresolved.push(id);}
    }
    return unresolved;
  }
  async discard(taskId: string): Promise<WorkspaceOperationResult> {
    const operation=this.operation(taskId);
    if(operation && ['merged','applied','rolled_back','pending'].includes(operation.state))return fail('workspace.finished','已合并、应用或待核对的任务不能丢弃，请先核对操作记录。');
    if(!this.get(taskId))return fail('workspace.missing','没有可以丢弃的登记副本。');
    // 先持久化终态；清理中断时不再允许恢复 Agent，后续清理可以重试。
    this.saveOperation(operation?.state==='discarded'?operation:this.operationRecord(taskId,'discarded'));
    await this.remove(taskId);
    return {status:'discarded'};
  }
  retention(): WorkspaceRetention {
    const row=this.db.get<{value:string}>("SELECT value FROM meta WHERE key='workspace_retention'");
    return row?WorkspaceRetention.parse(JSON.parse(row.value)):{days:7};
  }
  setRetention(input: WorkspaceRetention) {
    const value=WorkspaceRetention.parse(input);
    this.db.run("INSERT INTO meta(key,value) VALUES('workspace_retention',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",JSON.stringify(value));return value;
  }
  async cleanup(beforeRemove: (id: string) => Promise<boolean> = async()=>true, at=Date.now()) {
    const cutoff=at-this.retention().days*86400000;
    const rows=this.db.all<{task_id:string}>('SELECT task_id FROM workspace_records');
    const removed:string[]=[],failed:string[]=[];
    for(const row of rows) {
      const operation=this.operation(row.task_id);
      if(!operation || operation.removedAt!==null || !['merged','applied','discarded','rolled_back'].includes(operation.state)||operation.finishedAt>cutoff)continue;
      try { if(await beforeRemove(row.task_id)){await this.remove(row.task_id);removed.push(row.task_id);} }catch{failed.push(row.task_id);}
    }
    return {removed,failed};
  }
  async open(taskId:string) {
    const directory=await this.runtimePath(taskId);
    if(process.platform!=='win32')return fail('workspace.platform','当前资源管理器入口仅支持 Windows。');
    await new Promise<void>((resolve,reject)=>{
      const child=spawn(path.join(process.env.SystemRoot??'C:\\Windows','explorer.exe'),[directory],{shell:false,windowsHide:false,stdio:'ignore'});
      child.once('error',()=>reject(new WorkspaceError('workspace.open','资源管理器未能打开。')));
      child.once('spawn',()=>{child.unref();resolve();});
    });
  }

  removeWorktree(taskId: string): Promise<void> { return this.remove(taskId); }
  remove(taskId: string): Promise<void> {
    return this.exclusive(taskId, async () => {
      const pending = this.get(taskId);
      if(pending?.state==='removing') {
        const expected=await this.location(pending);
        if(!samePath(expected,pending.path))fail('workspace.path','清理登记不匹配。');
        let missing=false;try{await lstat(expected);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;missing=true;}
        if(missing) {
          if(pending.kind==='worktree') {
            if(!pending.branch?.startsWith(`aic/${taskId}`)||!pending.removalRef)fail('workspace.registration','缺少分支清理登记。');
            const ref=`refs/heads/${pending.branch}`,current=await this.git.run(['rev-parse','--verify',ref],{cwd:pending.projectPath});
            const registrations=(await this.git.checked(['worktree','list','--porcelain','-z'],{cwd:pending.projectPath})).toString();
            if(registrations.split('\0').includes(`branch ${ref}`))fail('workspace.registration','分支已被其他工作副本使用，已停止清理。');
            if(current.code===0)await this.git.checked(['update-ref','-d',ref,pending.removalRef],{cwd:pending.projectPath});
            else if(current.code!==128)throw new GitError('failed','rev-parse',current.code);
          }else if(pending.gitDir){const shadow=await this.location(pending,'shadow');if(!samePath(shadow,pending.gitDir))fail('workspace.path','影子仓库清理登记不匹配。');await rm(shadow,{recursive:true,force:true});}
          this.finishRemoval(taskId);return;
        }
      }
      // git add 尚未成功的准备记录可能没有目录；只移除自己的失败登记，不猜测分支归属。
      if (pending?.state === 'failed' && !pending.worktreeGitDir) {
        const expected = await this.location(pending);
        if (!samePath(expected, pending.path)) fail('workspace.path', '工作副本登记路径不匹配。');
        try { await lstat(expected); }
        catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          this.db.run('DELETE FROM workspace_records WHERE task_id=?',taskId); return;
        }
      }
      const record = await this.checkedRecord(taskId);
      if (record.kind === 'worktree') {
        if (!record.branch?.startsWith(`aic/${record.taskId}`)) fail('workspace.branch', '拒绝删除非本任务分支。');
        const list = (await this.git.checked(['worktree','list','--porcelain','-z'], { cwd: record.projectPath })).toString();
        const block = list.split('\0\0').find(x => x.startsWith(`worktree ${record.path.split(path.sep).join('/')}\0`) || x.startsWith(`worktree ${record.path}\0`));
        if (!block?.split('\0').includes(`branch refs/heads/${record.branch}`)) fail('workspace.registration', 'git 工作副本登记不匹配，已停止删除。');
        record.removalRef=(await this.git.checked(['rev-parse','--verify',`refs/heads/${record.branch}`],{cwd:record.projectPath})).toString().trim();
        record.state = 'removing'; this.save(record);
        await this.git.checked(['worktree','remove','--force',record.path], { cwd: record.projectPath });
        await this.git.checked(['update-ref','-d',`refs/heads/${record.branch}`,record.removalRef], { cwd: record.projectPath });
      } else {
        record.state = 'removing'; this.save(record);
        // checkedRecord 已验证绝对路径与数据目录登记一致，再次拒绝目录联接。
        await this.location(record); await rm(record.path, { recursive: true });
        if (record.gitDir) { await this.location(record, 'shadow'); await rm(record.gitDir, { recursive: true, force: true }); }
      }
      this.finishRemoval(taskId);
    });
  }
  private finishRemoval(taskId:string) {
    this.db.tx(()=>{
      this.db.run('DELETE FROM workspace_records WHERE task_id=?',taskId);this.hashCaches.delete(taskId);
      const operation=this.operation(taskId);if(operation)this.saveOperation({...operation,removedAt:Date.now()});
    });this.invalidate(taskId);
  }
}
