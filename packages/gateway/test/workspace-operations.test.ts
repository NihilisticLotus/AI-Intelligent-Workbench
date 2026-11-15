import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access, link, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WorkspaceRequest } from '@aic/protocol';
import { Git, GitError } from '../src/git';
import { openDb, type Db } from '../src/db';
import { WorkspaceManager, isInside, SNAPSHOT_FILE_LIMIT } from '../src/workspaces';

let base:string, project:string, data:string, db:Db, git:Git, manager:WorkspaceManager;
const put=(root:string,name:string,value:string)=>writeFile(path.join(root,name),value);
const run=async(root:string,...args:string[])=>(await git.checked(args,{cwd:root})).toString().trim();
async function workspace(id='task_merge') { return manager.createWorktree(WorkspaceRequest.parse({taskId:id,projectId:'project_merge',projectPath:project,title:'合并测试'})); }
const merge=(id:string,strategy:'squash'|'merge'='squash')=>manager.mergeGit(id,{strategy,message:'验收合并'});
beforeEach(async()=>{
  base=await mkdtemp(path.join(tmpdir(),'aic-workspace-ops-'));project=path.join(base,'project');data=path.join(base,'data');await mkdir(project);await mkdir(data);
  git=await Git.discover({...process.env,GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_AUTHOR_NAME:'合并测试',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'合并测试',GIT_COMMITTER_EMAIL:'test@example.invalid'});
  db=openDb(path.join(data,'test.db'));manager=new WorkspaceManager(db,git,data);
  await run(project,'init','-b','main');await put(project,'notes.txt','初始\n');await run(project,'add','--all');await run(project,'commit','-m','初始');
});

async function copyWorkspace() {
  const source=path.join(base,'copy-project');await mkdir(source);await put(source,'notes.txt','初始\n');await put(source,'delete.txt','保留\n');
  const record=await manager.createCopy(WorkspaceRequest.parse({taskId:'task_copy',projectId:'project_copy',projectPath:source,title:'副本验收'}));
  await put(record.path,'notes.txt','修改\n');await rm(path.join(record.path,'delete.txt'));await mkdir(path.join(record.path,'new'));await put(record.path,'new/added.bin','\0新增');await manager.snapshot(record.taskId,'任务结束');
  return record;
}
// 每个完整应用 / 撤销用例包含六次真实 Windows 句柄宿主启动，单独预留执行预算。
describe('非 git 应用与回滚保护',{timeout:60000},()=>{
  it('应用新增修改删除及二进制，撤销应用恢复原文件',async()=>{
    const record=await copyWorkspace();expect(await manager.applyCopy(record.taskId)).toMatchObject({status:'applied',files:['delete.txt','new/added.bin','notes.txt']});
    expect(await readFile(path.join(record.projectPath,'notes.txt'),'utf8')).toBe('修改\n');expect(await readFile(path.join(record.projectPath,'new/added.bin'),'utf8')).toBe('\0新增');await expect(access(path.join(record.projectPath,'delete.txt'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await manager.rollbackCopy(record.taskId)).toEqual({status:'rolled_back',skippedLargeFiles:[]});
    expect(await readFile(path.join(record.projectPath,'notes.txt'),'utf8')).toBe('初始\n');expect(await readFile(path.join(record.projectPath,'delete.txt'),'utf8')).toBe('保留\n');await expect(access(path.join(record.projectPath,'new/added.bin'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('未应用时回滚只改副本并更新快照',async()=>{
    const record=await copyWorkspace();expect((await manager.rollbackCopy(record.taskId)).status).toBe('rolled_back');
    expect(await readFile(path.join(record.projectPath,'notes.txt'),'utf8')).toBe('初始\n');expect(await readFile(path.join(record.path,'notes.txt'),'utf8')).toBe('初始\n');expect((await manager.diff(record.taskId)).files).toEqual([]);expect(manager.operation(record.taskId)?.state).toBe('restored');
  });
  it('原目录任意文件漂移都整批阻止应用，包括无关新增文件',async()=>{
    const record=await copyWorkspace();await put(record.projectPath,'user.txt','用户');expect(await manager.applyCopy(record.taskId)).toEqual({status:'source_changed',files:['user.txt']});
    expect(await readFile(path.join(record.projectPath,'notes.txt'),'utf8')).toBe('初始\n');expect(await readFile(path.join(record.projectPath,'delete.txt'),'utf8')).toBe('保留\n');await expect(access(path.join(record.projectPath,'new'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('应用后原目录漂移时整批阻止撤销',async()=>{
    const record=await copyWorkspace();await manager.applyCopy(record.taskId);await put(record.projectPath,'user.txt','用户');expect(await manager.rollbackCopy(record.taskId)).toEqual({status:'source_changed',files:['user.txt']});expect(await readFile(path.join(record.projectPath,'notes.txt'),'utf8')).toBe('修改\n');
  });
  it('最新快照后副本被修改时拒绝应用',async()=>{
    const record=await copyWorkspace();await put(record.path,'notes.txt','额外修改');await expect(manager.applyCopy(record.taskId)).rejects.toMatchObject({code:'workspace.changed'});expect(await readFile(path.join(record.projectPath,'notes.txt'),'utf8')).toBe('初始\n');
  });
  it('CRLF 和 attributes 规范化不会改变快照回滚的原始字节',async()=>{
    const source=path.join(base,'crlf-project');await mkdir(source);await put(source,'.gitattributes','*.txt text eol=lf\n');await put(source,'notes.txt','原始\r\n第二行\r\n');
    const record=await manager.createCopy(WorkspaceRequest.parse({taskId:'task_crlf',projectId:'project_crlf',projectPath:source,title:'原始字节'}));await put(record.path,'notes.txt','变化\n');await manager.snapshot(record.taskId,'变化');await manager.applyCopy(record.taskId);await manager.rollbackCopy(record.taskId);
    expect(await readFile(path.join(source,'notes.txt'),'utf8')).toBe('原始\r\n第二行\r\n');
  });
  it('最终登记失败时恢复已经应用的整批文件',async()=>{
    const record=await copyWorkspace();const run=db.run.bind(db);vi.spyOn(db,'run').mockImplementation((sql,...args)=>{if(sql.startsWith('INSERT INTO workspace_operations'))throw Error('模拟登记失败');return run(sql,...args);});
    await expect(manager.applyCopy(record.taskId)).rejects.toThrow('模拟登记失败');expect(await readFile(path.join(record.projectPath,'notes.txt'),'utf8')).toBe('初始\n');expect(await readFile(path.join(record.projectPath,'delete.txt'),'utf8')).toBe('保留\n');await expect(access(path.join(record.projectPath,'new'))).rejects.toMatchObject({code:'ENOENT'});expect(manager.operation(record.taskId)).toBeUndefined();
  });
  it.each(['hard','junction'] as const)('目标 %s 链接拒绝写入，外部内容不变',async kind=>{
    const record=await copyWorkspace();const outside=path.join(base,'outside');await mkdir(outside);await put(outside,'notes.txt','外部');
    if(kind==='hard'){await rm(path.join(record.projectPath,'notes.txt'));await link(path.join(outside,'notes.txt'),path.join(record.projectPath,'notes.txt'));}
    else await symlink(outside,path.join(record.projectPath,'escape'),'junction');
    await expect(manager.applyCopy(record.taskId)).rejects.toBeDefined();expect(await readFile(path.join(outside,'notes.txt'),'utf8')).toBe('外部');
  });
  it('超过 50 MB 文件可应用，回滚明确跳过而小文件仍恢复',async()=>{
    const source=path.join(base,'large-project');await mkdir(source);await put(source,'notes.txt','初始');await writeFile(path.join(source,'large.bin'),Buffer.alloc(SNAPSHOT_FILE_LIMIT+1,1));
    const record=await manager.createCopy(WorkspaceRequest.parse({taskId:'task_large',projectId:'project_large',projectPath:source,title:'大文件'}));
    await put(record.path,'notes.txt','修改');await writeFile(path.join(record.path,'large.bin'),Buffer.alloc(SNAPSHOT_FILE_LIMIT+1,2));await manager.snapshot(record.taskId,'大文件修改');
    expect(await manager.applyCopy(record.taskId)).toMatchObject({status:'applied',skippedLargeFiles:['large.bin']});expect((await readFile(path.join(source,'large.bin')))[0]).toBe(2);
    expect(await manager.rollbackCopy(record.taskId)).toEqual({status:'rolled_back',skippedLargeFiles:['large.bin']});expect(await readFile(path.join(source,'notes.txt'),'utf8')).toBe('初始');expect((await readFile(path.join(source,'large.bin')))[0]).toBe(2);
  });
});
afterEach(async()=>{await manager?.settle();vi.restoreAllMocks();db?.close();if(!isInside(tmpdir(),base)||!path.basename(base).startsWith('aic-workspace-ops-'))throw Error('清理范围错误');await rm(base,{recursive:true,force:true});},60000);

describe('临时仓库合并与撤销',()=>{
  it.each(['squash','merge'] as const)('%s 合并生成正确父提交，撤销保留历史并恢复文件',async strategy=>{
    const record=await workspace(),before=await run(project,'rev-parse','HEAD');
    await put(record.path,'notes.txt','任务修改\n');await put(record.path,'new.txt','新增\n');
    const result=await merge(record.taskId,strategy);expect(result.status).toBe('merged');
    expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('任务修改\n');expect(await readFile(path.join(project,'new.txt'),'utf8')).toBe('新增\n');
    const commit=await run(project,'rev-parse','HEAD');expect(commit).not.toBe(before);
    expect((await run(project,'rev-list','--parents','-n','1','HEAD')).split(' ')).toHaveLength(strategy==='merge'?3:2);
    const reverted=await manager.rollbackGit(record.taskId);expect(reverted.status).toBe('rolled_back');expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('初始\n');await expect(access(path.join(project,'new.txt'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await run(project,'rev-parse','HEAD^')).toBe(commit);expect(await run(project,'status','--porcelain')).toBe('');
    expect(await run(project,'log','-1','--format=%s')).toBe('撤销任务合并');
    expect(manager.operation(record.taskId)).toMatchObject({state:'rolled_back',mergeCommit:commit});
  });
  it('未提交修改和未跟踪文件都会阻止合并，不 stash、不 reset',async()=>{
    const record=await workspace(),before=await run(project,'rev-parse','HEAD');await put(record.path,'notes.txt','任务\n');await put(project,'notes.txt','用户未提交\n');await put(project,'mine.txt','用户新增');
    const spy=vi.spyOn(git,'checked');const result=await merge(record.taskId);
    expect(result).toEqual({status:'dirty',files:['notes.txt','mine.txt']});expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('用户未提交\n');expect(await run(project,'rev-parse','HEAD')).toBe(before);
    expect(spy.mock.calls.some(([args])=>args.includes('stash')||args.includes('reset'))).toBe(false);
  });
  it('原项目切到其他分支时拒绝，其他分支和标签不改写',async()=>{
    const record=await workspace();await put(record.path,'notes.txt','任务\n');await run(project,'checkout','-b','user-work');await run(project,'tag','user-tag');const before=await run(project,'rev-parse','user-work');
    expect(await merge(record.taskId)).toEqual({status:'wrong_branch',expected:'main',actual:'user-work'});expect(await run(project,'rev-parse','user-work')).toBe(before);expect(await run(project,'rev-parse','user-tag')).toBe(before);
  });
  it('冲突只在副本发现，中止后原目录干净，副本解决并提交后可合并',async()=>{
    const record=await workspace();await put(record.path,'notes.txt','任务内容\n');await put(project,'notes.txt','项目新提交\n');await run(project,'add','--all');await run(project,'commit','-m','项目前进');const before=await run(project,'rev-parse','HEAD');
    expect(await merge(record.taskId)).toEqual({status:'conflict',files:['notes.txt']});expect(await run(project,'rev-parse','HEAD')).toBe(before);expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('项目新提交\n');expect(await run(project,'status','--porcelain')).toBe('');
    expect((await git.run(['rev-parse','--verify','MERGE_HEAD'],{cwd:record.path})).code).not.toBe(0);
    // 模拟 Agent 只在副本重新整合、解决并提交，既有冲突已按规格中止。
    await git.run(['merge',before],{cwd:record.path});await put(record.path,'notes.txt','人工解决后\n');await run(record.path,'add','--all');await run(record.path,'commit','-m','解决冲突');
    expect((await merge(record.taskId)).status).toBe('merged');expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('人工解决后\n');
  });
  it('基准分支前进但无冲突时保留双方改动',async()=>{
    const record=await workspace();await put(record.path,'task.txt','任务');await put(project,'user.txt','用户');await run(project,'add','--all');await run(project,'commit','-m','项目前进');
    expect((await merge(record.taskId)).status).toBe('merged');expect(await readFile(path.join(project,'user.txt'),'utf8')).toBe('用户');expect(await readFile(path.join(project,'task.txt'),'utf8')).toBe('任务');
  });
  it('合并后新提交或脏文件都阻止撤销',async()=>{
    const record=await workspace();await put(record.path,'notes.txt','任务\n');await merge(record.taskId);await put(project,'notes.txt','用户修改\n');expect((await manager.rollbackGit(record.taskId)).status).toBe('dirty');
    await run(project,'add','--all');await run(project,'commit','-m','后续提交');const head=await run(project,'rev-parse','HEAD');expect((await manager.rollbackGit(record.taskId)).status).toBe('new_commits');expect(await run(project,'rev-parse','HEAD')).toBe(head);
  });
  it('压缩合并的提交失败恢复本次索引和文件，不留下新增文件',async()=>{
    const record=await workspace(),before=await run(project,'rev-parse','HEAD');await put(record.path,'notes.txt','任务');await put(record.path,'new.txt','新增');
    const real=git.checked.bind(git);vi.spyOn(git,'checked').mockImplementation(async(args,options)=>{if(args[0]==='commit'&&options.cwd===record.projectPath)throw new GitError('failed','commit',1);return real(args,options);});
    await expect(merge(record.taskId)).rejects.toMatchObject({kind:'failed'});expect(await run(project,'rev-parse','HEAD')).toBe(before);expect(await run(project,'status','--porcelain')).toBe('');expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('初始\n');await expect(access(path.join(project,'new.txt'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('被忽略的用户文件与任务新增文件冲突时也阻止覆盖',async()=>{
    await put(project,'.gitignore','local.txt\n');await run(project,'add','--all');await run(project,'commit','-m','忽略规则');const record=await workspace();await put(project,'local.txt','用户本地文件');await put(record.path,'local.txt','任务文件');await run(record.path,'add','-f','local.txt');
    expect(await merge(record.taskId)).toEqual({status:'dirty',files:['local.txt']});expect(await readFile(path.join(project,'local.txt'),'utf8')).toBe('用户本地文件');
  });
  it('检出钩子不执行，用户 git 配置原文不变',async()=>{
    const hooks=path.join(project,'hooks');await mkdir(hooks);await writeFile(path.join(hooks,'post-checkout'),'#!/bin/sh\necho unexpected > hook-ran.txt\n',{mode:0o755});await run(project,'config','core.hooksPath',hooks);
    const config=await readFile(path.join(project,'.git','config'),'utf8');const record=await workspace();await expect(access(path.join(record.path,'hook-ran.txt'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(path.join(project,'.git','config'),'utf8')).toBe(config);
  });
  it('检出和暂存不执行用户过滤器，也不改用户配置',async()=>{
    await put(project,'.gitattributes','*.txt filter=unsafe\n');await run(project,'add','--all');await run(project,'commit','-m','属性');
    await run(project,'config','filter.unsafe.smudge','echo ran > filter-ran.txt; cat');await run(project,'config','filter.unsafe.clean','echo ran > filter-ran.txt; cat');await run(project,'config','filter.unsafe.required','true');
    const config=await readFile(path.join(project,'.git','config'),'utf8'),record=await workspace();await put(record.path,'notes.txt','任务');await manager.diff(record.taskId);expect((await merge(record.taskId)).status).toBe('merged');
    for(const root of [project,record.path])await expect(access(path.join(root,'filter-ran.txt'))).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(path.join(project,'.git','config'),'utf8')).toBe(config);
  });
  it('未使用的自定义合并驱动不阻断普通合并，命中驱动时安全返回冲突',async()=>{
    await run(project,'config','merge.custom.driver','echo unsafe > driver-ran.txt');
    const ordinary=await workspace('task_ordinary');await put(ordinary.path,'new.txt','普通文件');expect((await merge(ordinary.taskId)).status).toBe('merged');
    await put(project,'.gitattributes','notes.txt merge=custom\n');await run(project,'add','--all');await run(project,'commit','-m','声明驱动');
    const conflict=await workspace('task_driver');await put(conflict.path,'notes.txt','任务修改');await put(project,'notes.txt','用户提交');await run(project,'add','--all');await run(project,'commit','-m','项目前进');
    expect(await merge(conflict.taskId)).toEqual({status:'conflict',files:['notes.txt']});
    for(const root of [project,ordinary.path,conflict.path])await expect(access(path.join(root,'driver-ran.txt'))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('差异与合并预检不运行外部 diff 或 textconv',async()=>{
    await put(project,'.gitattributes','notes.txt diff=custom\n');await run(project,'add','--all');await run(project,'commit','-m','差异属性');
    await run(project,'config','diff.external','echo unsafe > diff-ran.txt');await run(project,'config','diff.trustExitCode','true');await run(project,'config','diff.custom.textconv','echo unsafe > textconv-ran.txt');
    const record=await workspace();await put(record.path,'notes.txt','任务');await run(record.path,'diff');expect((await merge(record.taskId)).status).toBe('merged');
    for(const root of [project,record.path])for(const file of ['diff-ran.txt','textconv-ran.txt'])await expect(access(path.join(root,file))).rejects.toMatchObject({code:'ENOENT'});
  });
  it('丢弃只移除登记副本与本任务分支，原目录和用户分支保留',async()=>{
    const record=await workspace();await put(record.path,'notes.txt','副本');await run(project,'branch','user-branch');await run(project,'tag','user-tag');const before=await run(project,'rev-parse','HEAD');
    expect(await manager.discard(record.taskId)).toEqual({status:'discarded'});expect(manager.get(record.taskId)).toBeUndefined();await expect(access(record.path)).rejects.toMatchObject({code:'ENOENT'});expect(await run(project,'rev-parse','user-branch')).toBe(before);expect(await run(project,'rev-parse','user-tag')).toBe(before);expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('初始\n');
  });
  it('清理只删除到期终态登记，未完成副本和用户目录保留',async()=>{
    const done=await workspace('task_done'),active=await workspace('task_active');await put(done.path,'notes.txt','修改');await merge(done.taskId);const at=manager.operation(done.taskId)!.finishedAt;
    expect(await manager.cleanup(undefined,at+6*86400000)).toEqual({removed:[],failed:[]});expect(await manager.cleanup(undefined,at+8*86400000)).toEqual({removed:[done.taskId],failed:[]});expect(manager.get(active.taskId)).toBeDefined();await access(active.path);expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('修改');expect(manager.operation(done.taskId)?.removedAt).toBeTypeOf('number');
  });
  it('清理拒绝篡改登记路径，保留用户目录',async()=>{
    const record=await workspace();await put(record.path,'notes.txt','修改');await merge(record.taskId);const stored=manager.get(record.taskId)!;db.run('UPDATE workspace_records SET record_json=? WHERE task_id=?',JSON.stringify({...stored,path:record.projectPath}),record.taskId);
    expect((await manager.cleanup(undefined,Date.now()+8*86400000)).failed).toEqual([record.taskId]);expect(await readFile(path.join(project,'notes.txt'),'utf8')).toBe('修改');
  });
  it('删除副本后分支清理失败可重试',async()=>{
    const record=await workspace();const real=git.checked.bind(git);const spy=vi.spyOn(git,'checked').mockImplementation(async(args,options)=>{if(args[0]==='update-ref'&&args[1]==='-d')throw new GitError('failed','update-ref',1);return real(args,options);});
    await expect(manager.discard(record.taskId)).rejects.toBeDefined();spy.mockRestore();expect(manager.get(record.taskId)?.state).toBe('removing');await manager.remove(record.taskId);expect(manager.get(record.taskId)).toBeUndefined();expect((await git.run(['show-ref','--verify','--quiet',`refs/heads/${record.branch}`],{cwd:project})).code).toBe(1);
  });
  it.each(['ref','worktree'] as const)('清理中断后分支被 %s 重用时保留分支',async mode=>{
    const record=await workspace();const real=git.checked.bind(git);const spy=vi.spyOn(git,'checked').mockImplementation(async(args,options)=>{if(args[0]==='update-ref'&&args[1]==='-d')throw new GitError('failed','update-ref',1);return real(args,options);});
    await expect(manager.discard(record.taskId)).rejects.toBeDefined();spy.mockRestore();
    if(mode==='ref'){await put(project,'new.txt','用户');await run(project,'add','--all');await run(project,'commit','-m','用户新提交');await run(project,'update-ref',`refs/heads/${record.branch}`,'HEAD');}
    else await run(project,'worktree','add',path.join(base,'user-worktree'),record.branch!);
    const before=await run(project,'rev-parse',record.branch!);await expect(manager.remove(record.taskId)).rejects.toBeDefined();expect(await run(project,'rev-parse',record.branch!)).toBe(before);expect(manager.get(record.taskId)?.state).toBe('removing');
  });
  it.each(['merge','rollback'] as const)('%s 提交后登记失败只补操作记录，不重写 git 历史',async action=>{
    const record=await workspace();await put(record.path,'notes.txt','任务');if(action==='rollback')await merge(record.taskId);
    const real=db.run.bind(db);vi.spyOn(db,'run').mockImplementation((sql,...args)=>{
      if(sql.startsWith('INSERT INTO workspace_operations')){const item=JSON.parse(String(args[1]));if(item.state===(action==='merge'?'merged':'rolled_back'))throw Error('模拟最终登记失败');}return real(sql,...args);
    });
    await expect(action==='merge'?merge(record.taskId):manager.rollbackGit(record.taskId)).rejects.toThrow('模拟最终登记失败');const head=await run(project,'rev-parse','HEAD');expect(manager.operation(record.taskId)?.state).toBe('pending');
    await expect(merge(record.taskId)).rejects.toMatchObject({code:'workspace.recovery'});vi.restoreAllMocks();expect(await manager.recoverOperations()).toEqual([]);expect(await run(project,'rev-parse','HEAD')).toBe(head);expect(manager.operation(record.taskId)?.state).toBe(action==='merge'?'merged':'rolled_back');
  });
});
