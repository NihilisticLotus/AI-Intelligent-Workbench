// 工作区只由登记记录寻址；任务副本与原项目之间不建立链接。
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceRecord, WorkspaceRequest, type WorkspaceChange, type WorkspaceChanges, type WorkspaceFile, type WorkspaceFileDiff } from '@aic/protocol';
import type { Db } from './db';
import { Git, GitError } from './git';

export const SNAPSHOT_FILE_LIMIT = 50 * 1024 * 1024;
export const COPY_CONFIRM_LIMIT = 100 * 1024 * 1024;
export const FILE_DIFF_LIMIT = 1024 * 1024;
const IGNORED = new Set(['.git', 'node_modules', 'dist', '.venv', 'Library', 'Temp', 'Intermediate', 'DerivedDataCache', 'Binaries', '.aic-data'].map(x => x.toLowerCase()));

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly files: string[] = [], readonly bytes?: number) { super(message); }
}
function fail(code: string, message: string): never { throw new WorkspaceError(code, message); }
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
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
async function fileInfo(root: string, relative: string): Promise<WorkspaceFile> {
  const file = await safePath(root, relative);
  const before = await lstat(file);
  if (!before.isFile()) fail('workspace.file', '工作区只支持普通文件。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await lstat(await safePath(root, relative));
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) fail('workspace.changed', '准备工作区时文件发生变化，请重试。');
  return { path: relative, size: before.size, mtimeMs: before.mtimeMs, hash: hash.digest('hex') };
}
async function enumerate(root: string, ignores: string[], builtins: boolean): Promise<WorkspaceFile[]> {
  // 先校验规则，空目录也不能绕过非法规则校验。
  for (const glob of ignores) matches('aic-validation', [glob]);
  const result: WorkspaceFile[] = [];
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
      if (entry.name.toLowerCase() === '.git' || (builtins && IGNORED.has(entry.name.toLowerCase())) || matches(rel, ignores)) continue;
      const file = await safePath(root, rel);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) result.push(await fileInfo(root, rel));
      else fail('workspace.file', '工作区包含不能复制的特殊文件。');
    }
  };
  await visit(root);
  return result.sort((a,b) => a.path.localeCompare(b.path));
}
function equivalent(a: WorkspaceFile[], b: WorkspaceFile[]) {
  return a.length === b.length && a.every((f,i) => f.path === b[i]?.path && f.hash === b[i]?.hash);
}

export class WorkspaceManager {
  private pending = new Map<string, Promise<unknown>>();
  private changesCache = new Map<string, { fingerprint: string; until: number; value: { result: WorkspaceChanges; tree: string } }>();
  invalidate(taskId: string) { this.changesCache.delete(taskId); }
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
          if (matches(rel, request.carryGlobs)) sourceFiles.push(await fileInfo(source, rel));
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
      try { result.push(await fileInfo(record.path, file)); }
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
      if (small.length) await this.git.checked(['add','-f','--pathspec-from-file=-','--pathspec-file-nul'], {
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
    const before = new Map(record.sourceFiles.map(f => [f.path, f.hash]));
    const after = new Map(current.map(f => [f.path, f.hash]));
    return [...new Set([...before.keys(), ...after.keys()])].filter(p => before.get(p) !== after.get(p));
  }

  private async changes(record: WorkspaceRecord): Promise<{ result: WorkspaceChanges; tree: string }> {
    if (!record.baseRef) return fail('workspace.base', '工作副本没有可比较的基准。');
    const opts = this.options(record);
    const current = record.kind === 'copy' ? record.snapshotFiles : await this.currentFiles(record);
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
    const status = (await this.git.checked([...common, '--name-status','-z'],opts)).toString().split('\0');
    const stats = (await this.git.checked([...common, '--numstat','-z'],opts)).toString().split('\0');
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
    for (const initial of record.largeFiles) if (!afterSizes.has(initial.path) && !files.some(f => f.path === initial.path)) {
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

  removeWorktree(taskId: string): Promise<void> { return this.remove(taskId); }
  remove(taskId: string): Promise<void> {
    return this.exclusive(taskId, async () => {
      const pending = this.get(taskId);
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
        record.state = 'removing'; this.save(record);
        await this.git.checked(['worktree','remove','--force',record.path], { cwd: record.projectPath });
        await this.git.checked(['branch','-D','--',record.branch], { cwd: record.projectPath });
      } else {
        record.state = 'removing'; this.save(record);
        // checkedRecord 已验证绝对路径与数据目录登记一致，再次拒绝目录联接。
        await this.location(record); await rm(record.path, { recursive: true });
        if (record.gitDir) { await this.location(record, 'shadow'); await rm(record.gitDir, { recursive: true, force: true }); }
      }
      this.db.run('DELETE FROM workspace_records WHERE task_id=?', taskId);
    });
  }
}
