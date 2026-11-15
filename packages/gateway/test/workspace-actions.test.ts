import { afterEach,describe,it,expect,vi } from 'vitest';
import { writeFileSync,readFileSync,existsSync } from 'node:fs';
import path from 'node:path';
import { Task, WorkspaceOperationResult } from '@aic/protocol';
import { startGw,makeProject,type TestGw } from './helpers';

let t:TestGw|undefined;
afterEach(async()=>{vi.restoreAllMocks();await t?.stop();t=undefined;});
async function setup(git=true) {
  t=await startGw();const token=await t.pair(),project=await makeProject(t,token);
  writeFileSync(path.join(project.path,'notes.txt'),'原始\n');
  if(git)for(const args of [['init','-b','main'],['add','--all'],['commit','-m','初始']])await t.gw.services.workspaces.git.checked(args,{cwd:project.path});
  const result=await t.api('POST','/tasks',{token,body:{projectId:project.id,prompt:'操作验收',agent:'fake',deferPrompt:true}});expect(result.status).toBe(201);
  const task=Task.parse(result.json),url='/tasks/'+task.id,manager=t.gw.services.workspaces;
  return {task,url,token,project,manager,post:(suffix:string,body?:unknown)=>t!.api('POST',url+suffix,{token,body})};
}
describe('任务工作区操作接口',{timeout:60000},()=>{
  it.each([true,false])('%s git：合并或应用、终态拦截、撤销和事件一致',async git=>{
    const f=await setup(git);writeFileSync(path.join(f.task.workspace!.path!,'notes.txt'),'任务\n');if(!git)await f.manager.snapshot(f.task.id,'任务结束');
    const applied=await f.post('/merge',{strategy:'squash',message:'界面提交'});expect(applied.status).toBe(200);expect(WorkspaceOperationResult.parse(applied.json).status).toBe(git?'merged':'applied');
    expect((await t!.api('GET',f.url,{token:f.token})).json).toMatchObject({status:'merged',workspace:{operation:{state:git?'merged':'applied'}}});
    expect(readFileSync(path.join(f.project.path,'notes.txt'),'utf8')).toBe('任务\n');expect((await f.post('/discard')).status).toBe(409);expect((await f.post('/changes/restore',{path:'notes.txt'})).status).toBe(409);
    expect((await f.post('/rollback')).json.status).toBe('rolled_back');expect(readFileSync(path.join(f.project.path,'notes.txt'),'utf8')).toBe('原始\n');expect((await f.post('/rollback')).status).toBe(409);
    const events=t!.gw.services.events.read({after:0,limit:1000,taskId:f.task.id});expect(events.some(e=>e.type==='task.updated'&&e.data.task.workspace?.operation?.state==='rolled_back')).toBe(true);
  });
  it('运行或等待审批时所有写操作和打开入口拒绝',async()=>{
    const f=await setup();for(const status of ['running','waiting','queued']){
      t!.gw.services.db.run('UPDATE tasks SET status=? WHERE id=?',status,f.task.id);
      for(const suffix of ['/merge','/discard','/rollback','/workspace/open'])expect((await f.post(suffix,suffix==='/merge'?{strategy:'squash',message:'提交'}:undefined)).status).toBe(409);
      expect((await t!.api('DELETE',f.url,{token:f.token})).status).toBe(409);
    }
    expect(readFileSync(path.join(f.project.path,'notes.txt'),'utf8')).toBe('原始\n');
  });
  it('无令牌、错误 Host / Origin 均拒绝新接口',async()=>{
    const f=await setup();for(const suffix of ['/merge','/discard','/rollback','/workspace/open']){
      expect((await t!.api('POST',f.url+suffix)).status).toBe(401);
      expect((await t!.api('POST',f.url+suffix,{token:f.token,headers:{origin:'https://evil.invalid'}})).status).toBe(403);
      expect((await t!.api('POST',f.url+suffix,{token:f.token,headers:{host:'evil.invalid'}})).status).toBe(403);
    }
    expect((await t!.api('PUT','/settings/workspaces',{body:{days:1}})).status).toBe(401);
  });
  it('同任务操作并发互斥，期间不能再次合并',async()=>{
    const f=await setup();let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});const spy=vi.spyOn(f.manager,'mergeGit').mockImplementation(async()=>{await wait;return {status:'no_changes'};});
    const one=f.post('/merge',{strategy:'squash',message:'提交'});try{await vi.waitFor(()=>expect(spy).toHaveBeenCalled());expect((await f.post('/merge',{strategy:'merge',message:'另一次'})).status).toBe(409);}finally{release();}expect((await one).status).toBe(200);
  });
  it('打开只使用登记任务，返回路径参数不能改变目标',async()=>{
    const f=await setup();const spy=vi.spyOn(f.manager,'open').mockResolvedValue(undefined);expect((await f.post('/workspace/open',{path:'C:/other'})).status).toBe(200);expect(spy).toHaveBeenCalledExactlyOnceWith(f.task.id);
  });
  it('删除任务清理副本和关联数据，原目录及追加事件保留',async()=>{
    const f=await setup(false);writeFileSync(path.join(f.task.workspace!.path!,'notes.txt'),'副本');const before=t!.gw.services.events.lastSeq();
    expect((await t!.api('DELETE',f.url,{token:f.token})).status).toBe(200);expect(existsSync(f.task.workspace!.path!)).toBe(false);expect(readFileSync(path.join(f.project.path,'notes.txt'),'utf8')).toBe('原始\n');expect((await t!.api('GET',f.url,{token:f.token})).status).toBe(404);
    expect(t!.gw.services.events.read({after:before,limit:100}).at(-1)).toMatchObject({type:'task.deleted',taskId:null,data:{id:f.task.id}});expect(t!.gw.services.events.read({after:0,limit:100,taskId:f.task.id}).length).toBeGreaterThan(0);
  });
  it('保留天数默认七天、持久化并校验范围',async()=>{
    const f=await setup();expect((await t!.api('GET','/settings/workspaces',{token:f.token})).json).toEqual({days:7});expect((await t!.api('PUT','/settings/workspaces',{token:f.token,body:{days:14}})).json).toEqual({days:14});expect(f.manager.retention()).toEqual({days:14});
    for(const days of [0,366,1.5,'7'])expect((await t!.api('PUT','/settings/workspaces',{token:f.token,body:{days}})).status).toBe(400);
  });
});
