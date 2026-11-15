import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAdapter } from '@aic/adapters';
import { type AgentKind, type PermissionLevel } from '@aic/protocol';
import { makeProject, startGw, type TestGw } from './helpers';

let gateway:TestGw|undefined;
afterEach(async()=>{await gateway?.stop();gateway=undefined;});
async function setup(){gateway=await startGw();const token=await gateway.pair(),project=await makeProject(gateway,token);return {token,project,service:gateway.gw.services.tasks};}
describe('任务自动权限范围',{timeout:30000},()=>{
  it.each(['readonly','ask','workspace','full'] as PermissionLevel[])('演示隔离任务可以创建和切换 %s',async permission=>{
    const {service,project}=await setup();const task=await service.create({projectId:project.id,agent:'fake',permission,prompt:'',deferPrompt:true});
    expect(task.workspace?.kind).toBe('copy');expect(task.permissionLevels).toEqual(['readonly','ask','workspace','full']);expect(task.permission).toBe(permission);
    expect((await service.patch(task.id,{permission})).permission).toBe(permission);
  });
  it.each(['claude','codex','codebuddy','workbuddy','zcode'] as AgentKind[])('第三方 %s 即使声明四档也不能创建自动任务',async kind=>{
    const fake=createFakeAdapter({speed:0});gateway=await startGw({adapters:[{...fake,id:kind,permissionLevels:['readonly','ask','workspace','full']}]});
    const token=await gateway.pair(),project=await makeProject(gateway,token);
    await gateway.api('PATCH',`/agents/${kind}`,{token,body:{enabled:true}});
    const info=(await gateway.api('GET','/agents',{token})).json.items.find((a:{kind:string})=>a.kind===kind);expect(info.permissionLevels).toEqual(['readonly','ask']);
    for(const permission of ['workspace','full'])expect((await gateway.api('POST','/tasks',{token,body:{projectId:project.id,agent:kind,permission,prompt:'不得启动',deferPrompt:true}})).status).toBe(400);
    expect(gateway.gw.services.db.all('SELECT * FROM tasks')).toEqual([]);
    const task=await gateway.gw.services.tasks.create({projectId:project.id,agent:kind,permission:'ask',prompt:'',deferPrompt:true});
    expect(task.permissionLevels).toEqual(['readonly','ask']);
    for(const permission of ['workspace','full'] as const)await expect(gateway.gw.services.tasks.patch(task.id,{permission})).rejects.toThrow('第三方');
    expect(gateway.gw.services.tasks.get(task.id).permission).toBe('ask');
  });
  it('旧直写任务不能切换自动档，旧数据已为自动也不能启动',async()=>{
    const {service,project}=await setup();const task=await service.create({projectId:project.id,agent:'fake',permission:'ask',prompt:'',deferPrompt:true});
    gateway!.gw.services.db.run('UPDATE tasks SET workspace_kind=NULL,workspace_path=NULL WHERE id=?',task.id);
    expect(service.get(task.id).permissionLevels).toEqual(['readonly','ask']);
    for(const permission of ['workspace','full'] as const)await expect(service.patch(task.id,{permission})).rejects.toThrow('旧任务');
    gateway!.gw.services.db.run("UPDATE tasks SET permission_level='full' WHERE id=?",task.id);
    await service.prompt(task.id,'旧记录');await service.idle();expect(service.get(task.id).status).not.toBe('review');expect(service.listApprovals('pending')).toEqual([]);
  });
  it('工作区内自动不询问修改，规则外命令仍审批',async()=>{
    const {service,project}=await setup();const task=await service.create({projectId:project.id,agent:'fake',permission:'workspace',prompt:'演示'});
    await expect.poll(()=>service.listApprovals('pending').length,{timeout:10000}).toBe(1);
    const approval=service.listApprovals('pending')[0]!;expect(approval.title).toContain('执行命令');
    const events=gateway!.gw.services.events.read({taskId:task.id,after:0,limit:1000});expect(events.filter(e=>e.type==='approval.requested')).toHaveLength(1);
    await service.approve(approval.id,'reject',undefined,'test');await service.idle();
  });
  it('演示全自动的文件修改仍受项目禁止规则约束',async()=>{
    const {service,project}=await setup();service.permissions.put(project.id,{revision:0,items:[{action:'deny',tool:'edit',match:null,path:'**'}]});
    const task=await service.create({projectId:project.id,agent:'fake',permission:'full',prompt:'演示'});await service.idle();
    const events=gateway!.gw.services.events.read({taskId:task.id,after:0,limit:1000});expect(events.some(e=>e.type==='session.notice'&&e.data.text.includes('已拒绝操作'))).toBe(true);
    expect(events.some(e=>e.type==='tool.start'&&e.data.kind==='edit')).toBe(false);expect(service.listApprovals('pending')).toEqual([]);
  });
  it('演示全自动的命令仍经过固定禁止检查',async()=>{
    const fake=createFakeAdapter({speed:0});gateway=await startGw({adapters:[{...fake,spawn:options=>fake.spawn({...options,host:{...options.host,requestPermission:(req,signal)=>options.host.requestPermission(req.operation?.tool==='shell'?{...req,operation:{...req.operation,command:'git push origin main'}}:req,signal)}})}]});
    const token=await gateway.pair(),project=await makeProject(gateway,token),service=gateway.gw.services.tasks;
    const task=await service.create({projectId:project.id,agent:'fake',permission:'full',prompt:'演示固定禁止'});await service.idle();
    const events=gateway.gw.services.events.read({taskId:task.id,after:0,limit:1000});expect(events.some(e=>e.type==='session.notice'&&e.data.text.includes('始终禁止'))).toBe(true);
    expect(events.some(e=>e.type==='tool.end'&&e.data.rejected)).toBe(true);expect(service.listApprovals('pending')).toEqual([]);
  });
});
