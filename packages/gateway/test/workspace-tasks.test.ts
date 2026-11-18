import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createFakeAdapter, type AgentAdapter, type SpawnOptions } from '@aic/adapters';
import { Task, PatchProjectBody, TaskMemoryList } from '@aic/protocol';
import { Git } from '../src/git';
import { WorkspaceManager } from '../src/workspaces';
import { startGw, makeProject, type TestGw } from './helpers';

let t: TestGw | undefined;
afterEach(async () => { await t?.stop(); t = undefined; });
const environment = { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: '派发测试', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: '派发测试', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
async function setup(run?: (o: SpawnOptions, signal: AbortSignal) => Promise<void>) {
  const starts: string[] = [], prompts: string[] = [], base = createFakeAdapter({ speed: 0 });
  const adapter: AgentAdapter = { ...base, async spawn(o) {
    starts.push(o.cwd); const conn = await base.spawn(o);
    return { ...conn, agentSessionId: conn.agentSessionId, setConfig: c => conn.setConfig(c), setPermission: p => conn.setPermission(p), close: () => conn.close(),
      async prompt(input, signal) { prompts.push(typeof input === 'string' ? input : input.text); await run?.(o, signal); return { stopReason: signal.aborted ? 'cancelled' : 'end_turn' }; } };
  } };
  t = await startGw({ adapters: [adapter] });
  const git = await Git.discover(environment);
  t.gw.services.tasks.workspaces = new WorkspaceManager(t.gw.services.db, git, t.dataDir);
  const token = await t.pair(), project = await makeProject(t, token);
  const create = async (deferPrompt = false) => {
    const response = await t!.api('POST', '/tasks', { token, body: { projectId: project.id, prompt: '测试派发', agent: 'fake', permission: 'ask', deferPrompt } });
    expect(response.status).toBe(201); return Task.parse(response.json);
  };
  return { token, project, starts, prompts, git, create, services: t.gw.services };
}
describe('任务工作副本接入', () => {
  it('项目已跟踪同名说明时保留两处项目文件，并把正确的账本内联给 Agent', async () => {
    const f = await setup();
    const name = '.aic/TASK.md', original = '项目自己的资产规则';
    mkdirSync(path.join(f.project.path,'.aic'));
    writeFileSync(path.join(f.project.path,name),original);
    for (const args of [['init','-b','main'],['add',name],['commit','-m','项目原有说明']]) await f.git.checked(args,{cwd:f.project.path});
    const task = await f.create(true);
    await f.services.tasks.updateMemory(task.id,()=>f.services.tasks.memory.constrain(task.id,{kind:'constraint',content:'只调整关卡存档'}));
    await f.services.tasks.prompt(task.id,'继续核对');
    await f.services.tasks.idle();
    expect(f.prompts[0]).toContain('只调整关卡存档');
    expect(f.prompts[0]).toContain('继续核对');
    expect(f.prompts[0]).not.toContain(name);
    expect(f.prompts[0]).not.toContain(original);
    const workspace = f.services.workspaces.get(task.id)!;
    expect(readFileSync(path.join(workspace.path,name),'utf8')).toBe(original);
    expect(readFileSync(path.join(f.project.path,name),'utf8')).toBe(original);
    const user = f.services.events.read({after:0,limit:100,taskId:task.id}).find(e=>e.type==='message.user');
    expect(user?.data.text).toBe('继续核对');
  });
  it('演示任务把文件、命令、最新计划和约束写入账本与任务说明，再合并项目成果', async () => {
    const f = await setup(async o => {
      const host=o.host;
      host.update({kind:'plan',items:[{text:'旧计划',status:'pending'}]});
      host.update({kind:'plan',items:[{text:'修正说明',status:'completed'}]});
      host.update({kind:'tool_start',toolId:'edit',toolKind:'edit',title:'修改说明',target:'notes.txt'});
      writeFileSync(path.join(o.cwd,'notes.txt'),'修改后\n');
      host.update({kind:'tool_update',toolId:'edit',files:[{path:'notes.txt',added:1,removed:1,created:false}]});
      host.update({kind:'tool_end',toolId:'edit',ok:true,summary:'已修改'});
      host.update({kind:'tool_start',toolId:'cmd',toolKind:'execute',title:'测试',target:'npm test'});
      host.update({kind:'tool_output',toolId:'cmd',text:'token=synthetic-test-value\n断言失败'});
      host.update({kind:'tool_end',toolId:'cmd',ok:false,summary:'测试未通过'});
    });
    writeFileSync(path.join(f.project.path,'notes.txt'),'初始\n');
    for (const args of [['init','-b','main'],['add','--all'],['commit','-m','初始']]) await f.git.checked(args,{cwd:f.project.path});
    const task=await f.create(); await f.services.tasks.idle();
    const url='/tasks/'+task.id+'/memory', auth={token:f.token};
    expect((await t!.api('GET',url)).status).toBe(401);
    expect((await t!.api('GET',url,{...auth,headers:{origin:'https://other.invalid'}})).status).toBe(403);
    expect((await t!.api('GET',url,{...auth,headers:{host:'other.invalid'}})).status).toBe(403);
    const list=TaskMemoryList.parse((await t!.api('GET',url,auth)).json);
    expect(list.items.map(i=>i.kind)).toEqual(['goal','plan','file','command']);
    expect(list.items.find(i=>i.kind==='plan')?.content).toEqual([{text:'修正说明',status:'completed'}]);
    expect(list.items.find(i=>i.kind==='file')?.content).toMatchObject({path:'notes.txt',added:1,removed:1});
    expect(list.items.find(i=>i.kind==='command')?.content).toMatchObject({ok:false,command:'npm test',output:'token=***\n断言失败'});
    expect((await t!.api('DELETE',url+'/'+list.items[0]!.id,auth)).status).toBe(400);
    const msg=f.services.events.read({after:0,limit:1000,taskId:task.id}).find(e=>e.type==='message.user')!;
    const body={kind:'constraint',sourceSeq:msg.seq};
    expect((await t!.api('POST',url,{...auth,body:{...body,kind:'goal'}})).status).toBe(400);
    const add=()=>t!.api('POST',url,{...auth,body});
    await add(); const added=TaskMemoryList.parse((await add()).json);
    const constraints=added.items.filter(i=>i.source==='user');
    expect(constraints).toHaveLength(1);
    expect(constraints[0]?.content).toBe(msg.data.text);
    const file=path.join(f.services.tasks.workspaces!.get(task.id)!.path,'.aic','TASK.md');
    const text=readFileSync(file,'utf8'); expect(text).toContain('## 约束'); expect(text).toContain('修正说明'); expect(text).toContain('notes.txt'); expect(text).toContain('npm test'); expect(text).not.toContain('synthetic-test-value');
    expect((await t!.api('DELETE',url+'/'+constraints[0]!.id,auth)).status).toBe(200);
    expect(readFileSync(file,'utf8')).not.toContain('## 约束');
    expect((await f.services.tasks.workspaces!.mergeGit(task.id,{strategy:'squash',message:'应用成果'})).status).toBe('merged');
    expect(readFileSync(path.join(f.project.path,'notes.txt'),'utf8')).toBe('修改后\n');
    expect(existsSync(path.join(f.project.path,'.aic'))).toBe(false);
  },60000);
  it.each([false, true])('%s git 项目派发 cwd 为登记副本、文件与快照不写原目录', async isGit => {
    const f = await setup(async o => { writeFileSync(path.join(o.cwd, 'result.txt'), '副本结果'); });
    writeFileSync(path.join(f.project.path, 'source.txt'), '原文件');
    if (isGit) for (const args of [['init','-b','main'],['add','--all'],['commit','-m','初始']]) await f.git.checked(args,{cwd:f.project.path});
    const task = await f.create(); await f.services.tasks.idle();
    const current = f.services.tasks.get(task.id), workspace = current.workspace!;
    expect(current.status).toBe('review'); expect(workspace.kind).toBe(isGit ? 'worktree' : 'copy');
    expect(f.starts).toEqual([workspace.path]); expect(workspace.path).not.toBe(f.project.path);
    expect(readFileSync(path.join(workspace.path!, 'result.txt'), 'utf8')).toBe('副本结果');
    expect(existsSync(path.join(f.project.path, 'result.txt'))).toBe(false);
    expect(readFileSync(path.join(f.project.path, 'source.txt'), 'utf8')).toBe('原文件');
    if (!isGit) {
      const record = f.services.tasks.workspaces!.get(task.id)!;
      expect(record.snapshotAfter).not.toBe(record.snapshotBefore);
      const count = await f.git.checked(['rev-list','--count',record.snapshotAfter!],{cwd:record.path,gitDir:record.gitDir,workTree:record.path});
      expect(count.toString().trim()).toBe('3');
    }
    expect((await f.services.tasks.workspaces!.diff(task.id)).files).toContainEqual(expect.objectContaining({path:'result.txt',status:'A'}));
  });
  it.each([true,false])('%s git：演示适配器夹具实际修改三类文件并发布合计', async isGit => {
    const f = await setup(async o => {
      o.host.update({kind:'tool_start',toolId:'three-files',toolKind:'edit',title:'三文件验收',target:'modify.txt'});
      writeFileSync(path.join(o.cwd,'added.txt'),'新增\n'); writeFileSync(path.join(o.cwd,'modify.txt'),'修改\n'); unlinkSync(path.join(o.cwd,'delete.txt'));
      o.host.update({kind:'tool_end',toolId:'three-files',ok:true,summary:'三文件写入完成'});
    });
    writeFileSync(path.join(f.project.path,'modify.txt'),'原始\n'); writeFileSync(path.join(f.project.path,'delete.txt'),'删除\n');
    if (isGit) for (const args of [['init','-b','main'],['add','--all'],['commit','-m','初始']]) await f.git.checked(args,{cwd:f.project.path});
    const task=await f.create(); await f.services.tasks.idle();
    const changes=await f.services.tasks.workspaces!.diff(task.id);
    expect(changes.files.map(x=>[x.path,x.status]).sort()).toEqual([['added.txt','A'],['delete.txt','D'],['modify.txt','M']]);
    expect(readFileSync(path.join(f.project.path,'modify.txt'),'utf8')).toBe('原始\n'); expect(existsSync(path.join(f.project.path,'delete.txt'))).toBe(true); expect(existsSync(path.join(f.project.path,'added.txt'))).toBe(false);
    const events=f.services.events.read({after:0,limit:1000,taskId:task.id}).filter(e=>e.type==='task.changes_updated');
    expect(events.at(-1)?.data).toEqual({added:2,removed:2,fileCount:3}); // 工具结束后的刷新与回合结束合并为一次（ISSUE-0100），最终统计必须正确
    expect(events.length).toBeGreaterThanOrEqual(1);
  });
  it('非 git 同项目串行，取消排队者不会释放正在运行的任务', async () => {
    const releases: (() => void)[] = [];
    const starts=Array.from({length:2},()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};});
    const f = await setup(async (_o, signal) => new Promise<void>(resolve => { releases.push(resolve);starts[releases.length-1]?.resolve();signal.addEventListener('abort',()=>resolve(),{once:true}); }));
    const first = await f.create(); await starts[0]!.promise;expect(f.starts).toHaveLength(1);
    const second = await f.create(); await expect.poll(()=>f.services.tasks.get(second.id).status).toBe('queued');
    await f.services.tasks.cancel(second.id); await expect.poll(()=>f.services.tasks.get(second.id).status).toBe('paused');
    const third = await f.create(); await expect.poll(()=>f.services.tasks.get(third.id).status).toBe('queued');
    expect(f.starts).toHaveLength(1); releases[0]!(); await starts[1]!.promise;expect(f.starts).toHaveLength(2);
    expect(f.services.tasks.get(first.id).status).toBe('review');
    releases[1]!(); await f.services.tasks.idle(); expect(f.services.tasks.get(third.id).status).toBe('review');
    expect(f.services.events.read({after:0,limit:2000,taskId:third.id})).toContainEqual(expect.objectContaining({type:'session.notice',data:expect.objectContaining({text:'等待同项目的任务结束'})}));
  });
  it('任务恢复继续用原副本，旧 inplace 任务仍在原项目运行', async () => {
    const f = await setup(); const task = await f.create(); await f.services.tasks.idle();
    const before = f.services.tasks.workspaces!.get(task.id)!;
    await f.services.tasks.prompt(task.id,'继续'); await f.services.tasks.idle();
    expect(f.services.tasks.workspaces!.get(task.id)!.path).toBe(before.path); expect(f.starts).toEqual([before.path]);
    const old = await f.create(true);
    await f.services.tasks.workspaces!.remove(old.id);
    f.services.db.run('UPDATE tasks SET workspace_kind=NULL,workspace_path=NULL,base_ref=NULL WHERE id=?',old.id);
    await f.services.tasks.prompt(old.id,'旧任务'); await f.services.tasks.idle();
    expect(f.services.tasks.get(old.id).workspace?.kind).toBe('inplace'); expect(f.starts.at(-1)).toBe(f.project.path);
    expect(existsSync(path.join(f.project.path,'.aic'))).toBe(false);
  });
  it('git 不可用时任务失败，继续发送不能回退原目录', async () => {
    const f = await setup(); f.services.tasks.workspaces = new WorkspaceManager(f.services.db,new Git(null),t!.dataDir);
    const task = await f.create(); expect(task.status).toBe('failed'); expect(task.workspace?.error).toContain('git'); expect(f.starts).toEqual([]);
    await expect(f.services.tasks.prompt(task.id,'继续')).rejects.toThrow('工作副本');
  });
  it('准备失败的 git 项目不当作非 git 原目录运行', async () => {
    const f = await setup(); f.services.db.run('UPDATE projects SET is_git=1 WHERE id=?',f.project.id);
    const task = await f.create(); expect(task.status).toBe('failed'); expect(task.workspace?.error).toContain('有效的 git'); expect(f.starts).toEqual([]);
  });
  it('大复制确认持久化且只有明确确认才复制，不创建重复任务', async () => {
    const f = await setup(); const file = await open(path.join(f.project.path,'large.bin'),'w'); await file.truncate(101 * 1024 * 1024); await file.close();
    const task = await f.create(true); expect(task.workspace?.state).toBe('confirmation_required'); expect(task.status).toBe('draft');
    expect(f.services.tasks.workspaces!.get(task.id)).toBeUndefined(); expect(f.starts).toEqual([]);
    expect((await t!.api('POST',`/tasks/${task.id}/workspace/prepare`,{token:f.token,body:{confirmLargeCopy:false}})).status).toBe(400);
    const ready = await t!.api('POST',`/tasks/${task.id}/workspace/prepare`,{token:f.token,body:{confirmLargeCopy:true}});
    expect(ready.status).toBe(200); expect(ready.json.workspace).toMatchObject({state:'ready',largeFiles:['large.bin']});
    expect(f.services.db.get<{n:number}>('SELECT COUNT(*) AS n FROM tasks')?.n).toBe(1);
    expect((await t!.api('POST',`/tasks/${task.id}/workspace/prepare`,{token:f.token,body:{confirmLargeCopy:true}})).status).toBe(409);
  });
  it('准备接口继续校验令牌、Host、Origin', async () => {
    const f = await setup(); const task = await f.create(true), url = `/tasks/${task.id}/workspace/prepare`, body={confirmLargeCopy:true};
    expect((await t!.api('POST',url,{body})).status).toBe(401);
    expect((await t!.api('POST',url,{token:f.token,headers:{host:'evil.invalid'},body})).status).toBe(403);
    expect((await t!.api('POST',url,{token:f.token,headers:{origin:'https://evil.invalid'},body})).status).toBe(403);
  });
  it('项目规则持久化，非法与越界规则不通过协议', async () => {
    const f=await setup(); mkdirSync(path.join(f.project.path,'cache')); writeFileSync(path.join(f.project.path,'cache','ignored.txt'),'忽略');
    const changed=await t!.api('PATCH',`/projects/${f.project.id}`,{token:f.token,body:{ignoreGlobs:['cache/**'],carryGlobs:['local/*.json']}});
    expect(changed.json).toMatchObject({ignoreGlobs:['cache/**'],carryGlobs:['local/*.json']});
    for(const value of ['../secret','D:/secret','/secret','a\\b']) expect(PatchProjectBody.safeParse({ignoreGlobs:[value]}).success).toBe(false);
    const task=await f.create(true); expect(existsSync(path.join(task.workspace!.path!,'cache','ignored.txt'))).toBe(false);
  });
});
