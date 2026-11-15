import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, open, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WorkspaceRequest } from '@aic/protocol';
import { openDb, type Db } from '../src/db';
import { Git } from '../src/git';
import { WorkspaceManager, SNAPSHOT_FILE_LIMIT, COPY_CONFIRM_LIMIT, workspaceRelative, isInside } from '../src/workspaces';

let sandbox: string, project: string, data: string, db: Db, git: Git, manager: WorkspaceManager;
const request = (id = 'task_123', extra: Record<string, unknown> = {}) => WorkspaceRequest.parse({ taskId: id, projectId: 'project_123', title: '修复 Save File', projectPath: project, ...extra });
async function put(root: string, file: string, content: string | Buffer) { await mkdir(path.dirname(path.join(root,file)), { recursive: true }); await writeFile(path.join(root,file),content); }
async function sparse(root: string, file: string, size: number) { const handle = await open(path.join(root,file),'w'); try { await handle.truncate(size); } finally { await handle.close(); } }
const run = async (...args: string[]) => (await git.checked(args, { cwd: project })).toString().trim();
async function init() { await run('init','-b','main'); await put(project,'before.txt','旧内容\n'); await run('add','--all'); await run('commit','-m','初始提交'); }

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(tmpdir(),'aic-workspace-test-'));
  project = path.join(sandbox,'project'); data = path.join(sandbox,'data');
  await mkdir(project); await mkdir(data);
  git = await Git.discover({ ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: '工作区测试', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: '工作区测试', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
  expect(git.available).toBe(true);
  db = openDb(path.join(data,'test.db'));
  manager = new WorkspaceManager(db,git,data);
});
afterEach(async () => {
  db?.close();
  // 只清理由本测试创建的绝对临时目录。
  if (!sandbox || !isInside(tmpdir(),sandbox) || !path.basename(sandbox).startsWith('aic-workspace-test-')) throw new Error('测试清理路径不合法');
  await rm(sandbox,{ recursive:true, force:true });
});

describe('git 子进程封装', () => {
  const fixture = fileURLToPath(new URL('./fixtures/git-process.mjs',import.meta.url));
  const fake = (mode: string) => new Git(process.execPath, process.env, [fixture, mode]);
  it('从绝对 PATH 解析 git 并报告版本', () => { expect(path.isAbsolute(git.executable!)).toBe(true); expect(git.version).toMatch(/^git version /); });
  it('git 不存在时明确拒绝', async () => { const absent = await Git.discover({ PATH: '' }); expect(absent.available).toBe(false); await expect(absent.run(['status'],{cwd:project})).rejects.toMatchObject({kind:'unavailable'}); });
  it('参数中的 shell 字符只是单个字面参数', async () => { const output = await fake('args').checked(['status','a & b; $(noop)'],{cwd:project}); expect(JSON.parse(output.toString())).toContain('a & b; $(noop)'); });
  it('超时结束自己创建的子进程', async () => { await expect(fake('hang').run(['status'],{cwd:project,timeoutMs:150})).rejects.toMatchObject({kind:'timeout'}); });
  it('可取消运行中的子进程', async () => { const ctrl = new AbortController(); const result = fake('hang').run(['status'],{cwd:project,signal:ctrl.signal}); setTimeout(()=>ctrl.abort(),150); await expect(result).rejects.toMatchObject({kind:'cancelled'}); });
  it('已取消时不启动进程', async () => { await expect(git.run(['status'],{cwd:project,signal:AbortSignal.abort()})).rejects.toMatchObject({kind:'cancelled'}); });
  it.each(['output','stderr'])('限制 %s 字节总量',async mode => { await expect(fake(mode).run(['status'],{cwd:project,maxOutput:1024})).rejects.toMatchObject({kind:'output_limit'}); });
  it('失败不暴露原始 stderr 或命令参数',async () => { await expect(fake('fail').checked(['status','私密文件'],{cwd:project})).rejects.toMatchObject({message:'git status 执行失败（退出码 7）'}); });
  it('派发时不会退回到原项目目录',async () => { const missing = new WorkspaceManager(db,new Git(null),data); await expect(missing.createCopy(request())).rejects.toMatchObject({kind:'unavailable'}); expect(missing.get('task_123')).toBeUndefined(); });
});

describe('独立工作副本', () => {
  it('创建 / 持久化 / 删除 worktree，不改变主目录或分支', async () => {
    await init(); const head = await run('rev-parse','HEAD');
    const record = await manager.createWorktree(request());
    expect(record).toMatchObject({kind:'worktree',state:'ready',branch:'aic/task_123-save-file',baseBranch:'main',baseRef:head});
    expect(await readFile(path.join(record.path,'before.txt'),'utf8')).toBe('旧内容\n');
    expect(new WorkspaceManager(db,git,data).get(record.taskId)).toEqual(record);
    await put(record.path,'before.txt','副本修改\n');
    expect(await readFile(path.join(project,'before.txt'),'utf8')).toBe('旧内容\n');
    expect(await run('status','--porcelain')).toBe(''); expect(await run('rev-parse','HEAD')).toBe(head);
    await manager.removeWorktree(record.taskId);
    expect(manager.get(record.taskId)).toBeUndefined(); expect(await run('branch','--list','aic/*')).toBe('');
    expect(await run('branch','--show-current')).toBe('main');
  });
  it('标题无 ASCII 时仅使用任务 ID，不因短 ID 前缀重复而冲突', async () => {
    await init(); const a = await manager.createWorktree(request('same_prefix_1',{title:'修复存档'}));
    const b = await manager.createWorktree(request('same_prefix_2',{title:'修复存档'}));
    expect(a.branch).toBe('aic/same_prefix_1'); expect(a.path).not.toBe(b.path);
  });
  it('复制匹配的未跟踪及 gitignored 文件，不复制未选文件', async () => {
    await init(); await put(project,'.gitignore','.local\n'); await run('add','--all'); await run('commit','-m','忽略规则');
    await put(project,'.local','本机数据'); await put(project,'scratch.txt','不带入');
    const record = await manager.createWorktree(request('carry',{carryGlobs:['.local']}));
    expect(await readFile(path.join(record.path,'.local'),'utf8')).toBe('本机数据');
    await expect(stat(path.join(record.path,'scratch.txt'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('git 项目无有效提交或不是仓库时失败', async () => { await expect(manager.createWorktree(request())).rejects.toThrow(); expect(manager.get('task_123')).toBeUndefined(); });
  it('不接管或删除同名的既有 aic 分支',async () => {
    await init(); await run('branch','aic/task_123-save-file');
    await expect(manager.createWorktree(request())).rejects.toMatchObject({code:'workspace.exists'});
    expect(manager.get('task_123')).toBeUndefined(); expect(await run('branch','--list','aic/*')).toContain('aic/task_123-save-file');
  });
  it('检测 LFS 声明但不触发联网拉取', async () => {
    await init(); await put(project,'.gitattributes','*.asset filter=lfs diff=lfs merge=lfs -text\n'); await run('add','--all'); await run('commit','-m','LFS 声明');
    expect((await manager.createWorktree(request())).lfs).toBe(true);
  });
  it('非 git 使用独立副本和按任务影子仓库，忽略大目录和项目规则', async () => {
    await put(project,'notes.txt','原文件\n'); await put(project,'node_modules/a.js','忽略'); await put(project,'cache/temp.txt','忽略');
    const record = await manager.createCopy(request('copy',{ignoreGlobs:['cache/**']}));
    expect(record.kind).toBe('copy'); expect(record.path).not.toBe(project); expect(record.gitDir).toContain('shadow');
    expect(record.snapshotBefore).toBeTruthy();
    await expect(stat(path.join(record.path,'node_modules'))).rejects.toMatchObject({code:'ENOENT'});
    await expect(stat(path.join(project,'.git'))).rejects.toMatchObject({code:'ENOENT'});
    await put(record.path,'notes.txt','副本内容\n'); await manager.snapshot(record.taskId,'一轮结束');
    expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('原文件\n');
    expect((await manager.diff(record.taskId)).files[0]?.status).toBe('M');
    await manager.remove(record.taskId); expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('原文件\n');
  });
  it('空目录、空改动也有前后快照', async () => {
    const record = await manager.createCopy(request()); const after = await manager.snapshot(record.taskId,'无改动');
    expect(after).not.toBe(record.snapshotBefore); expect((await manager.diff(record.taskId)).files).toEqual([]);
  });
  it('50 MB 以上文件复制但不入快照，初始无改动且记录不可回滚项', async () => {
    await sparse(project,'large.bin',SNAPSHOT_FILE_LIMIT+1);
    const record = await manager.createCopy(request());
    expect(record.largeFiles.map(f=>f.path)).toEqual(['large.bin']);
    expect((await manager.diff(record.taskId)).files).toEqual([]);
    expect((await git.checked(['ls-tree','-r',record.snapshotBefore!],{cwd:record.path,gitDir:record.gitDir,workTree:record.path})).toString()).not.toContain('large.bin');
    await rm(path.join(record.path,'large.bin')); await manager.snapshot(record.taskId,'删除大文件');
    expect((await manager.diff(record.taskId)).files).toEqual([expect.objectContaining({path:'large.bin',status:'D',tooLarge:true})]);
  });
  it.each(['copy','worktree'])('%s 超过 100 MB 未确认时拒绝，确认后才复制', async kind => {
    if (kind === 'worktree') await init(); await sparse(project,'large.bin',COPY_CONFIRM_LIMIT+1);
    const input = request('large',{carryGlobs:['large.bin']});
    const create = () => kind === 'copy' ? manager.createCopy(input) : manager.createWorktree(input);
    await expect(create()).rejects.toMatchObject({code:'workspace.copy_confirmation',bytes:COPY_CONFIRM_LIMIT+1}); expect(manager.get('large')).toBeUndefined();
    input.confirmLargeCopy = true; const record = await create();
    expect((await stat(path.join(record.path,'large.bin'))).size).toBe(COPY_CONFIRM_LIMIT+1);
  });
  it('原目录增加、删除、同大小改写均被基线检查发现', async () => {
    await put(project,'a.txt','aaa'); await put(project,'b.txt','bbb'); const record=await manager.createCopy(request());
    expect(await manager.sourceChanges(record.taskId)).toEqual([]);
    await put(project,'a.txt','zzz'); await rm(path.join(project,'b.txt')); await put(project,'c.txt','ccc');
    expect((await manager.sourceChanges(record.taskId)).sort()).toEqual(['a.txt','b.txt','c.txt']);
  });
});

describe('改动与路径安全', () => {
  it('累计列出新增、修改、删除、重命名、二进制与未提交改动，保留真实索引', async () => {
    await init(); await put(project,'delete.txt','删除\n'); await put(project,'rename.txt','这是重命名文件\n重复内容\n'); await put(project,'binary.dat',Buffer.from([0,1]));
    await run('add','--all'); await run('commit','-m','增加基线文件');
    const record = await manager.createWorktree(request());
    await put(record.path,'before.txt','新内容\n'); await put(record.path,'中文 文件.txt','新建\n'); await rm(path.join(record.path,'delete.txt'));
    await rename(path.join(record.path,'rename.txt'),path.join(record.path,'renamed.txt')); await put(record.path,'binary.dat',Buffer.from([0,2,3]));
    await git.checked(['add','--','before.txt'],{cwd:record.path});
    const staged = await git.checked(['diff','--cached'],{cwd:record.path});
    const changes = await manager.diff(record.taskId);
    expect(changes.files).toEqual(expect.arrayContaining([
      expect.objectContaining({path:'before.txt',status:'M',added:1,removed:1}),
      expect.objectContaining({path:'中文 文件.txt',status:'A',added:1}),
      expect.objectContaining({path:'delete.txt',status:'D',removed:1}),
      expect.objectContaining({path:'renamed.txt',oldPath:'rename.txt',status:'R'}),
      expect.objectContaining({path:'binary.dat',binary:true,beforeSize:2,afterSize:3}),
    ]));
    expect((await manager.fileDiff(record.taskId,'before.txt')).patch).toContain('+新内容');
    expect((await manager.fileDiff(record.taskId,'binary.dat')).patch).toBeNull();
    expect(await git.checked(['diff','--cached'],{cwd:record.path})).toEqual(staged);
    await git.checked(['commit','-m','任务中间提交'],{cwd:record.path});
    expect((await manager.diff(record.taskId)).files.find(f=>f.path==='before.txt')?.status).toBe('M');
  });
  it('非 git 改动严格使用最新快照，未快照内容不混入', async () => {
    await put(project,'before.txt','原始\n'); const record=await manager.createCopy(request());
    await put(record.path,'before.txt','第一次\n'); await manager.snapshot(record.taskId,'第一轮');
    await put(record.path,'before.txt','尚未快照\n新增行\n');
    expect((await manager.fileDiff(record.taskId,'before.txt')).patch).toContain('+第一次');
    expect((await manager.diff(record.taskId)).files[0]?.added).toBe(1);
  });
  it('暂存删除再忽略的基线文件仍按磁盘实际内容比较',async () => {
    await init(); const record=await manager.createWorktree(request());
    await git.checked(['rm','--cached','--','before.txt'],{cwd:record.path});
    await put(record.path,'.gitignore','before.txt\n'); await put(record.path,'before.txt','实际新内容\n');
    expect((await manager.diff(record.taskId)).files.find(f=>f.path==='before.txt')).toMatchObject({status:'M',added:1,removed:1});
  });
  it('文本过大只返回提示，不返回无限 diff', async () => {
    await init(); const record=await manager.createWorktree(request()); await put(record.path,'big.txt','a\n'.repeat(600_000));
    const file=await manager.fileDiff(record.taskId,'big.txt'); expect(file.patch).toBeNull(); expect(file.file.tooLarge).toBe(true);
  });
  it.each(['../secret','/root','C:/private','a/../../x','a\\x','a//b','a/./b','file:stream'])('拒绝越界或歧义路径 %s', value => { expect(()=>workspaceRelative(value)).toThrow(); });
  it('拒绝文件列表之外的单文件请求',async () => { await init(); const record=await manager.createWorktree(request()); await expect(manager.fileDiff(record.taskId,'before.txt')).rejects.toMatchObject({code:'workspace.file'}); });
  it('拒绝原项目中的目录联接，不能沿联接复制',async () => {
    const outside=path.join(sandbox,'outside'); await mkdir(outside); await put(outside,'private.txt','不可读取');
    await symlink(outside,path.join(project,'link'),'junction');
    await expect(manager.createCopy(request())).rejects.toMatchObject({code:'workspace.link'});
  });
  it('删除时拒绝被替换为目录联接的登记目录',async () => {
    await put(project,'notes.txt','原始'); const record=await manager.createCopy(request());
    await rename(record.path,`${record.path}-original`); await symlink(project,record.path,'junction');
    await expect(manager.remove(record.taskId)).rejects.toMatchObject({code:'workspace.link'});
    expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('原始');
  });
  it('删除时拒绝篡改登记路径或非任务分支',async () => {
    await init(); const record=await manager.createWorktree(request());
    db.run('UPDATE workspace_records SET record_json=? WHERE task_id=?',JSON.stringify({...record,path:project}),record.taskId);
    await expect(manager.remove(record.taskId)).rejects.toMatchObject({code:'workspace.path'});
    db.run('UPDATE workspace_records SET record_json=? WHERE task_id=?',JSON.stringify({...record,branch:'main'}),record.taskId);
    await expect(manager.remove(record.taskId)).rejects.toMatchObject({code:'workspace.branch'});
    expect(await run('branch','--show-current')).toBe('main');
  });
  it('拒绝被重定向到原项目的 worktree git 登记文件',async () => {
    await init(); const record=await manager.createWorktree(request());
    // Windows 上 git 把此文件设为隐藏；r+ 能改已有文件，w 的创建语义会被系统拒绝。
    const pointer=await open(path.join(record.path,'.git'),'r+');
    try { await pointer.truncate(0); await pointer.writeFile(`gitdir: ${path.join(project,'.git')}\n`); } finally { await pointer.close(); }
    await expect(manager.diff(record.taskId)).rejects.toMatchObject({code:'workspace.registration'});
    expect(await run('status','--porcelain')).toBe('');
  });
  it('git 基线里的超大文件未改动时不误报删除，修改时报告过大',async () => {
    await init(); await sparse(project,'large.bin',SNAPSHOT_FILE_LIMIT+1); await run('add','--all'); await run('commit','-m','大文件基线');
    const record=await manager.createWorktree(request());
    expect((await manager.diff(record.taskId)).files).toEqual([]);
    await sparse(record.path,'large.bin',SNAPSHOT_FILE_LIMIT+2);
    expect((await manager.diff(record.taskId)).files).toEqual([expect.objectContaining({path:'large.bin',status:'M',tooLarge:true})]);
  });
  it('拒绝项目与数据目录互相包含',async () => { await expect(manager.createCopy(request('overlap',{projectPath:sandbox}))).rejects.toMatchObject({code:'workspace.overlap'}); });
  it('重复创建不覆盖已有副本',async () => { const record=await manager.createCopy(request()); await put(record.path,'keep.txt','保留'); await expect(manager.createCopy(request())).rejects.toMatchObject({code:'workspace.exists'}); expect(await readFile(path.join(record.path,'keep.txt'),'utf8')).toBe('保留'); });
  it('数据库追加大文件列且旧任务工作区列仍保留',()=> { const fields=db.all<{name:string}>('PRAGMA table_info(tasks)').map(f=>f.name); expect(fields).toEqual(expect.arrayContaining(['workspace_kind','workspace_path','branch','base_ref','snapshot_before','snapshot_after','workspace_large_files'])); });
  it('v14 工作区占位数据升级到 v15 后保持原含义，重复打开不重建', () => {
    const file=path.join(data,'test.db');
    db.run("INSERT INTO tasks(id,project_id,title,prompt,status,permission_level,agent,workspace_kind,workspace_path,branch,base_ref,snapshot_before,snapshot_after,last_activity_at,created_at,updated_at) VALUES('old','p','旧任务','旧内容','review','ask','fake','inplace','旧路径','旧分支','旧基准','旧快照前','旧快照后',1,1,1)");
    db.close(); const previous=new DatabaseSync(file);
    previous.exec('DROP TABLE workspace_records; ALTER TABLE tasks DROP COLUMN workspace_large_files; PRAGMA user_version=14;'); previous.close();
    for(let i=0;i<2;i++) {
      db=openDb(file);
      expect(db.get('SELECT workspace_kind,workspace_path,branch,base_ref,snapshot_before,snapshot_after,workspace_large_files FROM tasks WHERE id=?','old')).toEqual({workspace_kind:'inplace',workspace_path:'旧路径',branch:'旧分支',base_ref:'旧基准',snapshot_before:'旧快照前',snapshot_after:'旧快照后',workspace_large_files:null});
      if(i===0) db.close();
    }
  });
  it('迁移失败关闭数据库句柄，Windows 上可立即删除临时数据库',async () => {
    const file=path.join(sandbox,'invalid.db'); const invalid=new DatabaseSync(file);
    invalid.exec('PRAGMA user_version=999;'); invalid.close();
    expect(()=>openDb(file)).toThrow('请升级');
    await expect(rm(file)).resolves.toBeUndefined();
  });
});
