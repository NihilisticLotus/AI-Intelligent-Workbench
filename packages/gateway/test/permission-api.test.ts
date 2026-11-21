import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeAdapter, type PermissionOutcome } from '@aic/adapters';
import { makeProject, startGw, type TestGw, WsClient } from './helpers';

let t:TestGw|null=null,ws:WsClient|null=null;
afterEach(async()=>{await ws?.close();ws=null;await t?.stop();t=null;});
async function setup(){
  const outcomes:PermissionOutcome[]=[];const fake=createFakeAdapter({speed:0});
  t=await startGw({adapters:[{...fake,spawn:async options=>{const connection=await fake.spawn(options);connection.prompt=async(_,signal)=>{
    outcomes.push(await options.host.requestPermission({toolId:'tc',title:'执行测试',detail:'npm test',reason:'离线验收',cwd:options.cwd,
      operation:{tool:'shell',command:'npm test',paths:[],complete:true,deletion:false},
      options:[{id:'once',kind:'allow_once',label:'允许'},{id:'native',kind:'allow_always',label:'原生总是'},{id:'no',kind:'reject_once',label:'拒绝'}]},signal));return {stopReason:'end_turn'};
  };return connection;}}]});
  const token=await t.pair(),project=await makeProject(t,token);ws=await WsClient.connect(t.port,token);
  const service=t.gw.services.tasks,task=await service.create({projectId:project.id,agent:'fake',prompt:'',permission:'ask',deferPrompt:true});
  const request=async()=>{await service.prompt(task.id,'测试');await vi.waitFor(()=>expect(service.listApprovals('pending')).toHaveLength(1),{timeout:10000});return service.listApprovals('pending')[0]!;};
  const settled=()=>vi.waitFor(()=>expect(service.get(task.id).status).toBe('review'),{timeout:10000});
  return {token,project,service,task,outcomes,request,settled};
}
describe('普通读取自动允许不刷屏（ISSUE-0103）',{timeout:30000},()=>{
  it('无规则的只读操作自动允许但不在对话里逐条提示',async()=>{
    const outcomes:PermissionOutcome[]=[];const fake=createFakeAdapter({speed:0});
    t=await startGw({adapters:[{...fake,spawn:async options=>{const connection=await fake.spawn(options);connection.prompt=async(_,signal)=>{
      for(const name of ['a.txt','b.txt','c.txt'])outcomes.push(await options.host.requestPermission({toolId:'r-'+name,title:'读取',detail:name,reason:'读取',cwd:options.cwd,
        operation:{tool:'read',command:null,paths:[name],complete:true,deletion:false},options:[{id:'once',kind:'allow_once',label:'允许'},{id:'no',kind:'reject_once',label:'拒绝'}]},signal));
      return {stopReason:'end_turn'};};return connection;}}]});
    const token=await t.pair(),project=await makeProject(t,token);const service=t.gw.services.tasks;
    const task=await service.create({projectId:project.id,agent:'fake',prompt:'读三个文件',permission:'ask'});
    await vi.waitFor(()=>expect(service.get(task.id).status).toBe('review'),{timeout:10000});
    expect(outcomes.every(o=>o.outcome==='selected'&&o.optionId==='once')).toBe(true);
    expect(t.gw.services.events.read({after:0,taskId:task.id,limit:1000}).filter(e=>e.type==='session.notice'&&e.data.text.includes('自动允许'))).toHaveLength(0);
  });
});
describe('权限接口与工作台总是允许',{timeout:30000},()=>{
  it.each(['提交前','规则核对期间'])('审批到期在%s也只能过期一次',async phase=>{
    const {service,task,request,outcomes}=await setup(), approval=await request();
    const time=vi.spyOn(Date,'now');
    if(phase==='提交前')time.mockReturnValue(approval.expiresAt!);
    else {
      const decide=service.permissions.decide.bind(service.permissions);
      vi.spyOn(service.permissions,'decide').mockImplementationOnce(async(...args)=>{
        const decision=await decide(...args);time.mockReturnValue(approval.expiresAt!);return decision;
      });
    }
    try {await expect(service.approve(approval.id,'once',undefined,'device')).rejects.toThrow('过期');}
    finally {time.mockRestore();}
    await service.idle();
    expect(outcomes).toEqual([{outcome:'cancelled'}]);
    expect(service.get(task.id).status).toBe('paused');
    expect(t!.gw.services.events.read({after:0,taskId:task.id,limit:1000}).filter(e=>e.type==='approval.resolved').map(e=>e.data.status)).toEqual(['expired']);
  });
  it('规则读写仍校验令牌、Host、Origin，整表修订冲突返回 409',async()=>{
    const {token,project}=await setup(),url=`/projects/${project.id}/rules`;
    expect((await t!.api('GET',url)).status).toBe(401);
    expect((await t!.api('GET',url,{token,headers:{host:'evil.invalid'}})).status).toBe(403);
    expect((await t!.api('PUT',url,{token,headers:{origin:'https://evil.invalid'},body:{revision:0,items:[]}})).status).toBe(403);
    expect((await t!.api('PUT',url,{token,body:{revision:0,items:[]}})).json.revision).toBe(1);
    expect((await t!.api('PUT',url,{token,body:{revision:0,items:[]}})).status).toBe(409);
  });
  it('先预览后确认保存工作台规则，只回一次允许；删除后恢复审批',async()=>{
    const {token,project,service,task,outcomes,request,settled}=await setup();const approval=await request();
    expect(approval.canAlwaysAllow).toBe(true);expect(approval.options.some(o=>o.id==='native')).toBe(false);
    const always=approval.options.find(o=>o.kind==='allow_always')!;
    expect((await ws!.call({op:'approve',data:{approvalId:approval.id,optionId:always.id}})).ok).toBe(false);
    expect((await t!.api('GET',`/approvals/${approval.id}/rule`)).status).toBe(401);
    const preview=(await t!.api('GET',`/approvals/${approval.id}/rule`,{token})).json;
    expect(preview.rule.match).toBe('npm test');
    expect((await ws!.call({op:'approve',data:{approvalId:approval.id,optionId:always.id,alwaysAllow:{revision:preview.revision}}})).ok).toBe(true);
    await settled();expect(outcomes).toEqual([{outcome:'selected',optionId:'once'}]);
    await service.prompt(task.id,'再次测试');await settled();expect(outcomes).toHaveLength(2);expect(outcomes[1]).toMatchObject({optionId:'once'});
    expect(t!.gw.services.events.read({after:0,taskId:task.id,limit:1000}).some(e=>e.type==='session.notice'&&e.data.text.startsWith('已按规则自动允许'))).toBe(true);
    const saved=service.permissions.get(project.id);expect(saved.items[0]?.source).toBe('always_allow');service.permissions.put(project.id,{revision:saved.revision,items:[]});
    const again=await request();expect(again.status).toBe('pending');await service.approve(again.id,'no',undefined,'test');await settled();expect(outcomes[2]).toMatchObject({optionId:'no'});
  });
  it('预览后其他设备改规则，旧确认不写入且不处理审批',async()=>{
    const {project,service,request,outcomes}=await setup();const approval=await request(),preview=await service.permissionRulePreview(approval.id);
    service.permissions.put(project.id,{revision:preview.revision,items:[]});
    await expect(service.approve(approval.id,approval.options.find(o=>o.kind==='allow_always')!.id,undefined,'device',{revision:preview.revision})).rejects.toThrow('已变化');
    expect(outcomes).toEqual([]);expect(service.listApprovals('pending')).toHaveLength(1);expect(service.permissions.get(project.id).items).toEqual([]);
  });
  it('保存审批失败时规则一并回滚，仍能重新确认',async()=>{
    const {project,service,request}=await setup();const approval=await request(),preview=await service.permissionRulePreview(approval.id),db=t!.gw.services.db;
    const run=db.run.bind(db),spy=vi.spyOn(db,'run').mockImplementation((sql,...args)=>{if(sql.startsWith('UPDATE approvals SET status'))throw Error('模拟数据库错误');return run(sql,...args);});
    try{await expect(service.approve(approval.id,approval.options.find(o=>o.kind==='allow_always')!.id,undefined,'device',{revision:preview.revision})).rejects.toThrow('模拟数据库错误');}finally{spy.mockRestore();}
    expect(service.permissions.get(project.id)).toMatchObject({revision:0,items:[]});expect(service.listApprovals('pending')).toHaveLength(1);
    await service.approve(approval.id,'once',undefined,'device');
  });
  it('审批等待期间新增禁止规则，允许按钮不能绕过新规则',async()=>{
    const {project,service,request,outcomes}=await setup();const approval=await request();
    service.permissions.put(project.id,{revision:0,items:[{action:'deny',tool:'shell',match:'npm test',path:null}]});
    await expect(service.approve(approval.id,'once',undefined,'device')).rejects.toThrow('已禁止');expect(outcomes).toEqual([]);
  });
});
