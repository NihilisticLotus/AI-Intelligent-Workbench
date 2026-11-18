import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync, utimesSync, unlinkSync, renameSync, mkdirSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { Task, WorkspaceChanges, WorkspaceFileDiff } from '@aic/protocol';
import { startGw, makeProject, WsClient, type TestGw } from './helpers';

let t: TestGw | undefined;
afterEach(async () => { await t?.stop(); t = undefined; });
async function setup(gitProject = true) {
  t = await startGw(); const token = await t.pair(), project = await makeProject(t, token);
  writeFileSync(path.join(project.path,'modify.txt'), '旧内容\n'); writeFileSync(path.join(project.path,'delete.txt'), '待删除\n');
  if (gitProject) for (const args of [['init','-b','main'], ['add','--all'], ['commit','-m','初始']]) await t.gw.services.workspaces.git.checked(args, {cwd:project.path});
  const result = await t.api('POST','/tasks',{token,body:{projectId:project.id,prompt:'差异测试',agent:'fake',deferPrompt:true}});
  expect(result.status).toBe(201); const task = Task.parse(result.json), root = task.workspace!.path!;
  const url = `/tasks/${task.id}/changes`;
  const get = (suffix='') => t!.api('GET',url+suffix,{token});
  const restore = (file: string) => t!.api('POST',url+'/restore',{token,body:{path:file}});
  return {token,project,task,root,url,get,restore,manager:t.gw.services.workspaces};
}
function change(root: string) {
  writeFileSync(path.join(root,'modify.txt'),'新内容\n新增行\n'); unlinkSync(path.join(root,'delete.txt')); writeFileSync(path.join(root,'added.txt'),'新增文件\n');
}

describe('任务改动 REST 与还原', () => {
  it.each([true,false])('检查点按确认清单恢复普通文件并保留环境文件，Git 工作树=%s',async gitProject => {
    const f=await setup(gitProject);
    const write=(name:string,value:string)=>writeFileSync(path.join(f.root,name),value);
    const read=(name:string)=>readFileSync(path.join(f.root,name),'utf8');
    const opts={cwd:f.root};
    write('.gitignore','.env.local\n');
    write('.env.local','SCENE=初始测试值\n');
    write('modify.txt','检查点版本\r\n');
    const git=(...args:string[])=>f.manager.git.checked(args,opts).then(out=>out.toString().trim());
    if(gitProject) await git('add','modify.txt');
    const branch=gitProject?await git('rev-parse','HEAD'):null;
    const index=gitProject?await git('write-tree'):null;
    const ref=await f.manager.createCheckpoint(f.task.id,1);
    if(gitProject) {
      const oid=await git('hash-object','--no-filters','.env.local');
      expect((await f.manager.git.run(['cat-file','-e',oid],{cwd:f.project.path})).code).not.toBe(0);
      expect(await git('ls-tree',ref,'--','.aic','.env.local')).toBe('');
    }
    write('.env.local','SCENE=当前测试值\n');
    write('modify.txt','当前修改\n'); write('new.txt','交接后新增');
    unlinkSync(path.join(f.root,'delete.txt'));
    const preview=await f.manager.checkpointRestore(f.task.id,ref);
    expect(preview.files).toEqual(['delete.txt','modify.txt','new.txt']);
    expect(preview.skipped).toEqual(['.env.local']);
    write('new.txt','确认前又改过');
    await expect(f.manager.checkpointRestore(f.task.id,ref,preview.revision)).rejects.toThrow('重新查看');
    expect(read('modify.txt')).toBe('当前修改\n');
    const fresh=await f.manager.checkpointRestore(f.task.id,ref);
    await f.manager.checkpointRestore(f.task.id,ref,fresh.revision);
    expect(read('.env.local')).toBe('SCENE=当前测试值\n');
    expect(read('modify.txt')).toBe('检查点版本\r\n'); expect(read('delete.txt').trim()).toBe('待删除');
    expect(existsSync(path.join(f.root,'new.txt'))).toBe(false);
    if(gitProject) {
      expect(await git('rev-parse','HEAD')).toBe(branch);
      expect(await git('write-tree')).toBe(index);
    }
  });
  it('预览、改动列表和单文件补丁都不会在原项目对象库留下副本的新内容',async()=>{
    const f=await setup(), cwd=f.project.path, bytes='SCENE=专用于临时验收的关卡名\n';
    const oid=(await f.manager.git.checked(['hash-object','--stdin'],{cwd,input:bytes})).toString().trim();
    const exists=async()=>(await f.manager.git.run(['cat-file','-e',oid],{cwd})).code===0;
    writeFileSync(path.join(f.root,'.env.local'),bytes);
    expect(await exists()).toBe(false);
    expect((await t!.api('POST','/tasks/'+f.task.id+'/handoff/preview',{token:f.token,body:{agent:'codex'}})).status).toBe(200);
    expect(await exists()).toBe(false);
    expect((await f.get()).json.files.map((item:{path:string})=>item.path)).toContain('.env.local');
    expect((await f.get('/file?path=.env.local')).json.patch).toContain(bytes.trim());
    expect(await exists()).toBe(false);
  });
  it('哈希缓存不漏掉同样大小的内容改动（ISSUE-0100）', async () => {
    const f=await setup(true); const file=path.join(f.root,'modify.txt');
    writeFileSync(file,'AAAA\n'); utimesSync(file,new Date(Date.now()-60_000),new Date(Date.now()-60_000));
    f.manager.invalidate(f.task.id); expect((await f.manager.diff(f.task.id)).files.find(x=>x.path==='modify.txt')).toBeDefined();
    const first=await f.manager.fileDiff(f.task.id,'modify.txt'); expect(first.patch).toContain('+AAAA');
    // 同样大小、新的修改时间：缓存必须失效
    writeFileSync(file,'BBBB\n'); utimesSync(file,new Date(Date.now()-30_000),new Date(Date.now()-30_000));
    f.manager.invalidate(f.task.id); const second=await f.manager.fileDiff(f.task.id,'modify.txt'); expect(second.patch).toContain('+BBBB');
  });
  it.each([true,false])('%s git：实际 A/M/D、补丁和逐项还原仅作用副本', async isGit => {
    const f=await setup(isGit); change(f.root);
    if (!isGit) await f.manager.snapshot(f.task.id,'测试完成');
    const list=await f.get(); expect(list.status).toBe(200); const changes=WorkspaceChanges.parse(list.json);
    expect(changes.files.map(x=>[x.path,x.status]).sort()).toEqual([['added.txt','A'],['delete.txt','D'],['modify.txt','M']]);
    expect(changes).toMatchObject({added:3,removed:2});
    const patch=WorkspaceFileDiff.parse((await f.get('/file?path=modify.txt')).json);
    expect(patch.patch).toContain('-旧内容'); expect(patch.patch).toContain('+新内容');
    for (const name of ['modify.txt','delete.txt','added.txt']) expect((await f.restore(name)).status).toBe(200);
    expect((await f.get()).json.files).toEqual([]);
    for (const root of [f.root,f.project.path]) { expect(readFileSync(path.join(root,'modify.txt'),'utf8')).toBe('旧内容\n'); expect(existsSync(path.join(root,'delete.txt'))).toBe(true); expect(existsSync(path.join(root,'added.txt'))).toBe(false); }
    const events=t!.gw.services.events.read({after:0,limit:1000,taskId:f.task.id}).filter(e=>e.type==='task.changes_updated');
    expect(events.at(-1)?.data).toEqual({added:0,removed:0,fileCount:0});
  });
  it('短缓存复用统计，外部文件变化与明确失效都会重算',async()=>{
    const f=await setup(); change(f.root); const spy=vi.spyOn(f.manager.git,'checked');
    await f.get(); const count=()=>spy.mock.calls.filter(([args])=>args.includes('--name-status')).length;
    expect(count()).toBe(1); await f.get(); expect(count()).toBe(1);
    writeFileSync(path.join(f.root,'modify.txt'),'再次修改\n一\n二\n'); expect((await f.get()).json.added).toBe(4); expect(count()).toBe(2);
    f.manager.invalidate(f.task.id); await f.get(); expect(count()).toBe(3); spy.mockRestore();
  });
  it('行数和字节数相同的内容变化仍更新修订标识与补丁',async()=>{
    const f=await setup(); writeFileSync(path.join(f.root,'modify.txt'),'新内容\n'); const first=(await f.get()).json;
    writeFileSync(path.join(f.root,'modify.txt'),'另内容\n'); const second=(await f.get()).json;
    expect(second.files).toEqual(first.files); expect(second.revision).not.toBe(first.revision);
    expect((await f.get('/file?path=modify.txt')).json.patch).toContain('+另内容');
  });
  it('非 git 最新快照改变即使缓存未过期也更新',async()=>{
    const f=await setup(false); await f.get(); change(f.root);
    expect((await f.get()).json.files).toEqual([]); await f.manager.snapshot(f.task.id,'回合完成');
    expect((await f.get()).json.files).toHaveLength(3);
  });
  it('拒绝越界、绝对路径、路径语法与不在列表的文件',async()=>{
    const f=await setup(); change(f.root);
    for (const p of ['../modify.txt','/modify.txt','C:/private','a\\b','.git/config','not-changed.txt','modify.txt\u0000']) {
      const result=await f.get('/file?path='+encodeURIComponent(p)); expect([400,409]).toContain(result.status);
      expect([400,409]).toContain((await f.restore(p)).status);
    }
    expect(readFileSync(path.join(f.project.path,'modify.txt'),'utf8')).toBe('旧内容\n');
  });
  it('二进制与过大文本只给元数据，二进制可以还原新增文件',async()=>{
    const f=await setup(); writeFileSync(path.join(f.root,'binary.bin'),Buffer.from([1,0,2,3])); writeFileSync(path.join(f.root,'huge.txt'),'a'.repeat(1024*1024+1));
    const binary=WorkspaceFileDiff.parse((await f.get('/file?path=binary.bin')).json); expect(binary).toMatchObject({file:{binary:true,afterSize:4},patch:null});
    const large=WorkspaceFileDiff.parse((await f.get('/file?path=huge.txt')).json); expect(large).toMatchObject({file:{tooLarge:true},patch:null});
    expect((await f.restore('binary.bin')).status).toBe(200); expect(existsSync(path.join(f.root,'binary.bin'))).toBe(false);
  });
  it('重命名还原原路径并删除新路径，不改 Agent 暂存区',async()=>{
    const f=await setup(); renameSync(path.join(f.root,'modify.txt'),path.join(f.root,'renamed.txt'));
    await f.manager.git.checked(['add','--all'],{cwd:f.root}); const before=await f.manager.git.checked(['diff','--cached'],{cwd:f.root});
    expect((await f.get()).json.files).toContainEqual(expect.objectContaining({path:'renamed.txt',oldPath:'modify.txt',status:'R'}));
    expect((await f.restore('renamed.txt')).status).toBe(200); expect(readFileSync(path.join(f.root,'modify.txt'),'utf8')).toBe('旧内容\n'); expect(existsSync(path.join(f.root,'renamed.txt'))).toBe(false);
    expect(await f.manager.git.checked(['diff','--cached'],{cwd:f.root})).toEqual(before);
  });
  it('运行中、终态与旧任务不允许还原',async()=>{
    const f=await setup(); change(f.root);
    for (const status of ['merged','discarded']) { t!.gw.services.db.run('UPDATE tasks SET status=? WHERE id=?',status,f.task.id); expect((await f.restore('modify.txt')).status).toBe(409); }
    t!.gw.services.db.run("UPDATE tasks SET workspace_kind='inplace',status='review' WHERE id=?",f.task.id);
    expect((await f.get()).status).toBe(409); expect((await f.restore('modify.txt')).status).toBe(409);
  });
  it('正在等待审批的任务拒绝还原，不覆盖正在执行的副本',async()=>{
    const f=await setup(); change(f.root);
    const client=await WsClient.connect(t!.port,f.token);
    try {
      await client.call({op:'subscribe',data:{lastSeq:0}});
      await t!.gw.services.tasks.prompt(f.task.id,'运行测试');
      await client.waitEvent(e=>e.taskId===f.task.id && e.type==='approval.requested');
      expect(t!.gw.services.tasks.get(f.task.id).status).toBe('waiting');
      expect((await f.restore('modify.txt')).status).toBe(409);
      expect(readFileSync(path.join(f.root,'modify.txt'),'utf8')).toBe('新内容\n新增行\n');
    } finally {
      await t!.gw.services.tasks.cancel(f.task.id); await t!.gw.services.tasks.idle();
      await client.close();
    }
  });
  it('新接口逐一校验设备令牌、Host 和 Origin',async()=>{
    const f=await setup();
    for (const [method,url,body] of [['GET',f.url,undefined],['GET',f.url+'/file?path=x',undefined],['POST',f.url+'/restore',{path:'x'}]] as const) {
      expect((await t!.api(method,url,{body})).status).toBe(401);
      expect((await t!.api(method,url,{token:f.token,body,headers:{host:'evil.invalid'}})).status).toBe(403);
      expect((await t!.api(method,url,{token:f.token,body,headers:{origin:'https://evil.invalid'}})).status).toBe(403);
    }
  });
  it('目录联接即使出现在缓存之后也拒绝读取与还原',async()=>{
    const f=await setup(); mkdirSync(path.join(f.root,'nested')); writeFileSync(path.join(f.root,'nested','new.txt'),'新'); await f.get();
    renameSync(path.join(f.root,'nested'),path.join(f.root,'moved')); symlinkSync(f.project.path,path.join(f.root,'nested'),'junction');
    const read = await f.get(), restore = await f.restore('nested/new.txt');
    expect(read.status).toBe(400); expect(read.json.code).toBe('workspace.path'); expect(restore.status).toBe(400);
    expect(readFileSync(path.join(f.project.path,'modify.txt'),'utf8')).toBe('旧内容\n');
  });
});
