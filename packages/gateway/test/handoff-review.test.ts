import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFakeAdapter } from '@aic/adapters';
import { makeProject, startGw, type TestGw } from './helpers';
import { environmentValues, HandoffRedactor } from '../src/handoff/redact';
import { mergeNarrative } from '../src/handoff/preview';
import { readHistory } from '../src/handoff/history';

// 1.6 代码审查修复（ISSUE-0138～0146）的回归测试，全部离线、使用假适配器。
let gw:TestGw | undefined;
afterEach(async()=>{await gw?.stop();gw=undefined;});

type Fake=ReturnType<typeof createFakeAdapter>;
type Spawn=Parameters<Fake['spawn']>[0];
type Conn=Awaited<ReturnType<Fake['spawn']>>;
function adapters(source:(o:Spawn,c:Conn,n:number)=>void,target:(o:Spawn,c:Conn)=>void,resume=false) {
  const fake=createFakeAdapter({speed:0});
  let sourceStarts=0;
  return [{...fake,async probeCapabilities(c:Conn){return {...await fake.probeCapabilities(c),resume,loadSession:false};},async spawn(o:Spawn){
    const c=await fake.spawn(o);sourceStarts++;
    if(o.resume)Object.assign(c,{resumed:true,agentSessionId:o.resume.agentSessionId});
    c.prompt=async()=>({stopReason:'end_turn'});source(o,c,sourceStarts);return c;
  }},{...fake,id:'codex' as const,async spawn(o:Spawn){const c=await fake.spawn(o);c.prompt=async()=>({stopReason:'end_turn'});target(o,c);return c;}}];
}

async function begin(gw:TestGw) {
  const token=await gw.pair(),project=await makeProject(gw,token),s=gw.gw.services;
  const task=await s.tasks.create({projectId:project.id,agent:'fake',permission:'ask',prompt:'整理关卡',deferPrompt:true});
  await s.tasks.prompt(task.id,'第一轮');await s.tasks.idle();
  return {token,s,task,dir:s.workspaces.get(task.id)!.path};
}

describe('接收方首轮没有正常结束（ISSUE-0138）',()=>{
  it('接收方已动手后失败：保留交接，任务留在接收方',async()=>{
    gw=await startGw({adapters:adapters(()=>{},(o,c)=>{c.prompt=async()=>{
      o.host.update({kind:'tool_start',toolId:'e1',toolKind:'edit',target:'Level.txt',title:'编辑'});
      await writeFile(path.join(o.cwd,'Level.txt'),'接收方改过');
      throw new Error('进程崩溃');
    };})});
    const {s,task}=await begin(gw);
    await s.tasks.prompt(task.id,'接手',[],{agent:'codex'});await s.tasks.idle();
    expect(s.tasks.get(task.id).agent).toBe('codex');
    expect(s.db.get('SELECT state FROM handoffs WHERE task_id=?',task.id)).toEqual({state:'sent'});
    expect(s.db.get("SELECT 1 AS ok FROM events WHERE task_id=? AND type='session.handoff'",task.id)).toEqual({ok:1});
  });
  it('接收方没有动手就失败：仍回到原 Agent',async()=>{
    gw=await startGw({adapters:adapters(()=>{},(_o,c)=>{c.prompt=async()=>{throw new Error('启动后立即失败');};})});
    const {s,task}=await begin(gw);
    await s.tasks.prompt(task.id,'接手',[],{agent:'codex'});await s.tasks.idle();
    expect(s.tasks.get(task.id).agent).toBe('fake');
    expect(s.db.get('SELECT state FROM handoffs WHERE task_id=?',task.id)).toEqual({state:'failed'});
  });
});

describe('切回失败时不留下已恢复的文件（ISSUE-0139）',()=>{
  async function handedOff(gw:TestGw) {
    const ctx=await begin(gw);
    await writeFile(path.join(ctx.dir,'Level.txt'),'原版本');
    await ctx.s.tasks.prompt(ctx.task.id,'接手',[],{agent:'codex'});await ctx.s.tasks.idle();
    await writeFile(path.join(ctx.dir,'Level.txt'),'后续版本');
    const id=ctx.s.db.get<{id:string}>("SELECT id FROM handoffs WHERE task_id=? AND state='sent'",ctx.task.id)!.id;
    const preview=await ctx.s.tasks.previewReturn(ctx.task.id,id);
    expect(preview.files).toContain('Level.txt');
    return {...ctx,id,revision:preview.revision};
  }
  it('原生恢复失败：工作副本保持切回前',async()=>{
    gw=await startGw({adapters:adapters((o,_c,n)=>{if(n>1 && o.resume)throw new Error('恢复失败');},()=>{},true)});
    const {s,task,dir,id,revision}=await handedOff(gw);
    await expect(s.tasks.returnHandoff(task.id,id,revision)).rejects.toThrow();
    expect(await readFile(path.join(dir,'Level.txt'),'utf8')).toBe('后续版本');
    expect(s.tasks.get(task.id).agent).toBe('codex');
  });
  it('反向交接没有完成：按反向交接的检查点还原',async()=>{
    gw=await startGw({adapters:adapters((_o,c,n)=>{if(n>1)c.prompt=async()=>{throw new Error('原 Agent 启动后失败');};},()=>{})});
    const {s,task,dir,id,revision}=await handedOff(gw);
    await s.tasks.returnHandoff(task.id,id,revision);await s.tasks.idle();
    expect(s.tasks.get(task.id).agent).toBe('codex');
    expect(await readFile(path.join(dir,'Level.txt'),'utf8')).toBe('后续版本');
  });
  it('反向交接完成：文件恢复到检查点',async()=>{
    gw=await startGw({adapters:adapters(()=>{},()=>{})});
    const {s,task,dir,id,revision}=await handedOff(gw);
    await s.tasks.returnHandoff(task.id,id,revision);await s.tasks.idle();
    expect(s.tasks.get(task.id).agent).toBe('fake');
    expect(await readFile(path.join(dir,'Level.txt'),'utf8')).toBe('原版本');
  });
});

describe('取消确认清理待发送的交接（ISSUE-0145）',()=>{
  it('删除检查点引用与说明文件，记录标为已取消',async()=>{
    gw=await startGw({adapters:adapters(()=>{},()=>{})});
    const {s,task,dir,token}=await begin(gw);
    expect((await gw.api('PUT','/settings/handoff',{token,body:{confirmBeforeSend:true}})).status).toBe(200);
    const {pendingHandoffId:id}=await s.tasks.prompt(task.id,'接手',[],{agent:'codex'});
    expect(id).toBeTruthy();
    expect(existsSync(path.join(dir,'.aic','handoffs','1.md'))).toBe(true);
    const r=await gw.api('DELETE','/tasks/'+task.id+'/handoff/'+id,{token});
    expect(r.status).toBe(200);expect(r.json.state).toBe('cancelled');
    expect(s.db.get('SELECT COUNT(*) AS n FROM handoff_checkpoints WHERE task_id=?',task.id)).toEqual({n:0});
    expect(existsSync(path.join(dir,'.aic','handoffs','1.md'))).toBe(false);
    expect((await gw.api('DELETE','/tasks/'+task.id+'/handoff/'+id,{token})).status).toBe(409);
    expect(s.tasks.get(task.id).agent).toBe('fake');
  });
});

describe('编辑工具提示不点名某一家（ISSUE-0146）',()=>{
  it('任何接收方都收到通用说明',async()=>{
    let received='';
    gw=await startGw({adapters:adapters(()=>{},(_o,c)=>{c.prompt=async input=>{received=input.text;return {stopReason:'end_turn'};};})});
    const {s,task}=await begin(gw);
    await s.tasks.prompt(task.id,'新增 Result.txt',[],{agent:'codex'});await s.tasks.idle();
    expect(received).toContain('你自己的文件编辑工具');expect(received).not.toContain('apply_patch');
  });
});

describe('历史查询复用打码结果（ISSUE-0142）与事件会话索引（ISSUE-0143）',()=>{
  it('事件不变时不重新计算，新事件后重建',async()=>{
    gw=await startGw({adapters:adapters(()=>{},()=>{})});
    const {s,task}=await begin(gw);
    await s.tasks.prompt(task.id,'接手',[],{agent:'codex'});await s.tasks.idle();
    const h=s.db.get<{id:string;to_session_id:string}>('SELECT id,to_session_id FROM handoffs WHERE task_id=?',task.id)!;
    const grant={taskId:task.id,handoffId:h.id,sessionId:h.to_session_id};
    const spy=vi.spyOn(s.secrets,'forRedaction');
    await readHistory(s,grant,{name:'search',arguments:{query:'第一轮'}});
    const first=spy.mock.calls.length;
    const again=await readHistory(s,grant,{name:'search',arguments:{query:'第一轮'}});
    expect(spy.mock.calls.length).toBe(first);
    expect(JSON.stringify(again)).toContain('第一轮');
    s.events.append({type:'message.user',taskId:task.id,sessionId:h.to_session_id,data:{messageId:'later',text:'第一轮之后的新消息'}});
    const later=await readHistory(s,grant,{name:'search',arguments:{query:'新消息'}});
    expect(spy.mock.calls.length).toBeGreaterThan(first);
    expect(JSON.stringify(later)).toContain('第一轮之后的新消息');
    expect(s.db.all<{name:string}>("SELECT name FROM pragma_index_list('events')").map(r=>r.name)).toContain('idx_events_session');
  });
});

describe('环境值打码只针对像密钥的值（ISSUE-0141）',()=>{
  it('常见配置值不进入全局打码，密钥类与较长值仍打码',()=>{
    const values=environmentValues(['NODE_ENV=production\nPORT=8080\nHOST=localhost\nDEBUG=true\nURL=http://localhost:3000\nDB_PASSWORD=ab12\nSCENE=AutumnVillage\n# 注释行\n']);
    expect(values).toEqual(expect.arrayContaining(['ab12','AutumnVillage']));
    for(const common of ['production','8080','localhost','true','http://localhost:3000','NODE_ENV=production','# 注释行'])expect(values).not.toContain(common);
    const r=new HandoffRedactor([],values);
    expect(r.text('在 localhost:8080 用 production 构建，NODE_ENV=production npm run build')).toBe('在 localhost:8080 用 production 构建，NODE_ENV=production npm run build');
    expect(r.text('场景 AutumnVillage')).toBe('场景 ***');
    expect(r.text('API_TOKEN=abcdef')).toBe('API_TOKEN=***');
  });
});

describe('多次交接的叙述增量合并（ISSUE-0140）',()=>{
  it('尝试与决策累积，未决问题与当前进展取最新',()=>{
    expect(mergeNarrative({attempts:['试过 A'],decisions:['保留比例'],openIssues:['贴图模糊'],current:'调整灯光'},
      {attempts:['试过 B','试过 A'],openIssues:[]}))
      .toEqual({attempts:['试过 A','试过 B'],decisions:['保留比例'],openIssues:[],current:'调整灯光'});
    expect(mergeNarrative(undefined,{current:'新'})).toEqual({current:'新'});
  });
});
