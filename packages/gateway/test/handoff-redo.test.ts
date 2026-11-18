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
