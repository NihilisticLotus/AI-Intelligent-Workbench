import { afterEach, describe, expect, it } from 'vitest';
import { createFakeAdapter } from '@aic/adapters';
import { makeProject, startGw, type TestGw } from './helpers';

let gateway:TestGw|undefined;
afterEach(async()=>{await gateway?.stop();gateway=undefined;});

async function setup() {
  const fake=createFakeAdapter({speed:0});
  let starts=0;
  const received:string[]=[];
  gateway=await startGw({adapters:[fake,{...fake,id:'codex',async spawn(options){
    starts++;
    const connection=await fake.spawn(options);
    connection.prompt=async input=>{
      received.push(typeof input==='string'?input:input.text);
      return {stopReason:'end_turn'};
    };
    return connection;
  }}]});
  const token=await gateway.pair(),project=await makeProject(gateway,token);
  const services=gateway.gw.services;
  const response=await gateway.api('POST','/tasks',{token,body:{projectId:project.id,agent:'fake',permission:'readonly',prompt:'核对关卡状态',deferPrompt:true}});
  const id=response.json.id as string;
  await services.tasks.prompt(id,'接手关卡',[],{agent:'codex'});await services.tasks.idle();
  const first=services.db.get<{id:string;to_session_id:string}>("SELECT id,to_session_id FROM handoffs WHERE task_id=? AND state='sent'",id)!;
  const redo=()=>gateway!.api('POST','/tasks/'+id+'/handoff/'+first.id+'/redo',{token,body:{}});
  return {id,services,first,redo,received,starts:()=>starts};
}

describe('在当前 Agent 重新交接',()=>{
  it('强制 H2 开新会话，保留上一轮用户消息的唯一性',async()=>{
    const {id,services,first,redo,starts}=await setup();
    expect((await redo()).status).toBe(200);
    await services.tasks.idle();
    expect(starts()).toBe(2);
    expect(services.db.get<{parent_session_id:string}>('SELECT parent_session_id FROM sessions WHERE task_id=? AND parent_session_id=?',id,first.to_session_id)).toBeTruthy();
    expect(services.db.all("SELECT id FROM handoffs WHERE task_id=? AND state='sent' AND level='H2'",id)).toHaveLength(2);
    expect(services.db.all("SELECT seq FROM events WHERE task_id=? AND type='message.user'",id)).toHaveLength(1);
  });
  it('强制 H2 保留当前会话的思考强度',async()=>{
    const {id,services,redo}=await setup();
    await services.tasks.switch(id,{effort:'高'});
    expect((await redo()).status).toBe(200);await services.tasks.idle();
    expect(services.tasks.get(id).effort).toBe('高');
  });
  it('启动恢复识别刚建立的接收会话，保留只预览的交接',async()=>{
    const {id,services:s,first}=await setup();
    const pending=await s.tasks.handoffs!.prepare(id,{agent:'fake'},'仅预览',[],{},[]);
    // 模拟已登记接收会话，尚未来得及把会话编号写回交接收据就退出。
    s.db.run("UPDATE handoffs SET state='prepared',to_session_id=NULL WHERE id=?",first.id);
    s.tasks.recoverOnStartup();
    expect(s.tasks.handoffs!.get(id,first.id).state).toBe('failed');
    expect(s.tasks.handoffs!.get(id,pending.record.id).state).toBe('prepared');
    expect(s.tasks.get(id)).toMatchObject({agent:'fake',status:'interrupted'});
    const progress=s.events.read({taskId:id,after:0,limit:500}).filter(e=>e.type==='handoff.progress' && e.data.handoffId===first.id);
    expect(progress.at(-1)?.data).toMatchObject({step:'send',status:'failed'});
  });
  it('开始发送后接收段尚未登记，重启也要结束这次交接',async()=>{
    const {id,services:s,first}=await setup();
    const {record}=await s.tasks.handoffs!.prepare(id,{agent:'fake'},'切换后继续',[],{},[]);
    s.tasks.handoffs!.progress(id,record.id,'send','running');
    s.tasks.recoverOnStartup();
    expect(s.tasks.handoffs!.get(id,record.id).state).toBe('failed');
    expect(s.tasks.get(id)).toMatchObject({agent:'codex',status:'interrupted'});
    expect(s.tasks.handoffs!.get(id,first.id).state).toBe('sent');
    const progress=s.events.read({taskId:id,after:0,limit:500}).filter(e=>e.type==='handoff.progress' && e.data.handoffId===record.id);
    expect(progress.at(-1)?.data).toMatchObject({step:'send',status:'failed'});
  });
  it('同一 Agent 重新交接失败后下一轮恢复原本的原生会话',async()=>{
    const fake=createFakeAdapter({speed:0});
    const turns:string[]=[];
    const historyTokens:string[]=[];
    let created=0;
    const mock={...fake,id:'codex' as const,real:true,
      async probeCapabilities(c:Parameters<typeof fake.probeCapabilities>[0]){return {...await fake.probeCapabilities(c),resume:true};},
      async spawn(opts:Parameters<typeof fake.spawn>[0]){
        const connection=await fake.spawn(opts);
        const service=opts.mcpServers?.find(item=>item.name==='aic-history');
        historyTokens.push(service?.env.find(entry=>entry.name==='AIC_HISTORY_TOKEN')?.value??'');
        const id=opts.resume?.agentSessionId ?? 'native-'+(++created);
        Object.assign(connection,{agentSessionId:id,resumed:!!opts.resume});
        connection.prompt=async()=>{turns.push(id);return {stopReason:id==='native-2'?'refusal':'end_turn'};};
        return connection;
      }};
    gateway=await startGw({adapters:[fake,mock]});
    const token=await gateway.pair(),project=await makeProject(gateway,token),s=gateway.gw.services;
    const t=await s.tasks.create({projectId:project.id,agent:'fake',permission:'readonly',prompt:'核对入口',deferPrompt:true});
    await s.tasks.prompt(t.id,'首次交接',[],{agent:'codex'});await s.tasks.idle();
    const first=s.db.get<{id:string;to_session_id:string}>('SELECT id,to_session_id FROM handoffs WHERE task_id=?',t.id)!;
    await s.tasks.redoHandoff(t.id,first.id);await s.tasks.idle();
    const preview=await gateway.api('POST','/tasks/'+t.id+'/handoff/preview',{token,body:{agent:'fake'}});
    expect.soft(preview.json.document.meta.from.sessionId).toBe(first.to_session_id);
    await s.tasks.prompt(t.id,'继续核对原计划');await s.tasks.idle();
    expect(turns).toEqual(['native-1','native-2','native-1']);
    expect(new Set(historyTokens).size).toBe(3);
    for(const token of historyTokens.slice(0,2))expect(()=>s.history.authenticate('Bearer '+token)).toThrow();
    expect(s.history.authenticate('Bearer '+historyTokens[2])).toMatchObject({taskId:t.id,handoffId:first.id});
  });
  it('原会话报告小窗口后，在重新交接前能识别超窗的完整转写',async()=>{
    const {id,services,first,redo,received,starts}=await setup();
    const text='上一轮关卡核验的详细结果。'.repeat(700);
    services.events.append({type:'message.done',taskId:id,sessionId:first.to_session_id,data:{messageId:'detail',text}});
    services.events.append({type:'session.usage',taskId:id,sessionId:first.to_session_id,data:{used:200,size:2048}});
    const result=await redo();await services.tasks.idle();
    const row=services.db.get<{id:string}>('SELECT id FROM handoffs WHERE task_id=? ORDER BY ordinal DESC LIMIT 1',id)!;
    const record=services.tasks.handoffs!.get(id,row.id);
    expect(result.status).toBe(409);
    expect(result.text).toContain(record.quality.estimatedTokens+' token');
    expect(result.text).toContain('2048 token');
    expect(services.db.get("SELECT id FROM sessions WHERE task_id=? AND status='active'",id)).toEqual({id:first.to_session_id});
    expect(record.quality.window).toBe(2048);
    expect(record.quality.estimatedTokens).toBeGreaterThan(record.quality.window);
    expect({status:result.status,starts:starts(),receivedFull:received.at(-1)?.includes(text)},
      '完整交接估算 '+record.quality.estimatedTokens+' token，报告窗口 '+record.quality.window).toMatchObject({starts:1,receivedFull:false});
  });
});

it('保留来源会话时两个模拟第三方进程分别占名额；重开继续遵守并发上限',async()=>{
  const fake=createFakeAdapter({speed:0});
  const adapters=(['claude','codex'] as const).map(id=>({...fake,id,real:true,async spawn(options:Parameters<typeof fake.spawn>[0]){
    const connection=await fake.spawn(options);
    connection.prompt=async()=>({stopReason:'end_turn'});
    return connection;
  }}));
  gateway=await startGw({adapters});
  const token=await gateway.pair(),project=await makeProject(gateway,token),s=gateway.gw.services;
  const task=await s.tasks.create({projectId:project.id,agent:'claude',permission:'readonly',prompt:'核对会话名额',deferPrompt:true});
  await s.tasks.prompt(task.id,'核对入口');await s.tasks.idle();
  expect(s.agentSvc.runningCount('claude')).toBe(1);
  await s.tasks.prompt(task.id,'交给接收会话',[],{agent:'codex'});await s.tasks.idle();
  expect(s.agentSvc.runningCount('claude')).toBe(0);
  expect(s.agentSvc.runningCount('codex')).toBe(1);
  const first=s.db.get<{id:string}>("SELECT id FROM handoffs WHERE task_id=? AND state='sent'",task.id)!;
  const redo=()=>s.tasks.redoHandoff(task.id,first.id);
  expect((await gateway.api('PATCH','/agents/codex',{token,body:{concurrencyLimit:1}})).status).toBe(200);
  await expect(redo()).rejects.toThrow('并发');
  expect(s.agentSvc.runningCount('codex')).toBe(1);
  expect((await gateway.api('PATCH','/agents/codex',{token,body:{concurrencyLimit:2}})).status).toBe(200);
  await redo();await s.tasks.idle();
  expect(s.agentSvc.runningCount('codex')).toBe(1);
});
