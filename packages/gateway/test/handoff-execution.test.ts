import { afterEach, describe, expect, it } from 'vitest';
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFakeAdapter } from '@aic/adapters';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';
import type { PromptInput } from '@aic/protocol';

let gw:TestGw | undefined;
afterEach(async()=>{await gw?.stop();gw=undefined;});

describe('发送时交接',()=>{
  it.each([
    ['ask', 'codex', true], ['readonly', 'codex', false], ['ask', 'claude', false],
  ] as const)('%s 权限交给 %s 时按接收方提供编辑工具提示',async (permission,agent,expectsHint)=>{
    const fake=createFakeAdapter({speed:0});
    let received='';
    gw=await startGw({adapters:[{...fake,async spawn(opts){
      const conn=await fake.spawn(opts);
      conn.prompt=async()=>({stopReason:'end_turn'});
      return conn;
    }},{...fake,id:agent,async spawn(opts){
      const conn=await fake.spawn(opts);
      conn.prompt=async input=>{received=input.text;return {stopReason:'end_turn'};};
      return conn;
    }}]});
    const token=await gw.pair(),project=await makeProject(gw,token),s=gw.gw.services;
    const task=await s.tasks.create({projectId:project.id,agent:'fake',permission,prompt:'验收关卡',deferPrompt:true});
    await s.tasks.prompt(task.id,'记录当前目标');await s.tasks.idle();
    await s.tasks.prompt(task.id,'仅新增 Result.txt',[],{agent});await s.tasks.idle();
    expect(received).toContain('仅新增 Result.txt');
    expect(received.includes('tools.apply_patch')).toBe(expectsHint);
    if (expectsHint) expect(received).toContain('禁止命令也适用于读取文件');
  });
  it('两次交接后原生切回，较早的分隔条重新成为可操作记录',async()=>{
    const fake=createFakeAdapter({speed:0});
    const resumable:typeof fake={...fake,
      async probeCapabilities(c){return {...await fake.probeCapabilities(c),resume:true};},
      async spawn(opts){
        const connection=await fake.spawn(opts);
        if(opts.resume)Object.assign(connection,{resumed:true});
        connection.prompt=async()=>({stopReason:'end_turn'});
        return connection;
      },
    };
    gw=await startGw({adapters:[resumable,{...resumable,id:'codex'}]});
    const token=await gw.pair(),project=await makeProject(gw,token),s=gw.gw.services;
    const task=await s.tasks.create({projectId:project.id,agent:'fake',permission:'readonly',prompt:'分两次交接',deferPrompt:true});
    await s.tasks.prompt(task.id,'开始核对');await s.tasks.idle();
    for(const agent of ['codex','fake'] as const){
      await s.tasks.prompt(task.id,'继续核对',[],{agent});await s.tasks.idle();
    }
    const records=s.db.all<{id:string}>('SELECT id FROM handoffs WHERE task_id=? ORDER BY ordinal',task.id);
    expect(records).toHaveLength(2);
    const urls=records.map(r=>'/tasks/'+task.id+'/handoff/'+r.id);
    const current=async()=>Promise.all(urls.map(async url=>(await gw!.api('GET',url,{token})).json.latestSent));
    expect(await current()).toEqual([false,true]);
    expect((await gw.api('POST',urls[1]+'/return',{token,body:{}})).json.level).toBe('H1');
    expect(await current()).toEqual([true,false]);
    expect((await gw.api('POST',urls[0]+'/return',{token,body:{}})).json.level).toBe('H1');
    expect(await current()).toEqual([false,false]);
  });
  it.each(['审批到期','首轮拒绝'])('%s 时不发布成功收据，原会话能继续',async reason=>{
    const fake=createFakeAdapter({speed:0});
    let calls=0;
    gw=await startGw({approvalTimeoutMs:80,adapters:[{...fake,async spawn(opts){
      const c=await fake.spawn(opts);
      c.prompt=async()=>{calls++;return {stopReason:'end_turn'};};
      return c;
    }},{...fake,id:'codex',async spawn(opts){
      const c=await fake.spawn(opts);
      c.prompt=async(_input,signal)=>{
        if(reason==='首轮拒绝')return {stopReason:'refusal'};
        await opts.host.requestPermission({toolId:'history',title:'工具审批',detail:'查询历史',reason:'',cwd:opts.cwd,
          options:[{id:'once',label:'允许一次',kind:'allow_once'}]},signal);
        return {stopReason:'end_turn'};
      };
      return c;
    }}]});
    const s=gw.gw.services,project=await makeProject(gw,await gw.pair());
    const task=await s.tasks.create({projectId:project.id,agent:'fake',permission:'ask',prompt:'核对入口',deferPrompt:true});
    await s.tasks.prompt(task.id,'记录入口');await s.tasks.idle();
    await s.tasks.prompt(task.id,'继续核对',[],{agent:'codex'});await s.tasks.idle();
    expect(s.db.get('SELECT state FROM handoffs WHERE task_id=?',task.id)).toEqual({state:'failed'});
    expect(s.events.read({after:0,taskId:task.id,limit:200}).some(e=>e.type==='session.handoff')).toBe(false);
    expect(s.tasks.get(task.id).agent).toBe('fake');
    await s.tasks.prompt(task.id,'继续原会话');await s.tasks.idle();
    expect(calls).toBe(2);
  });
  it.each(['等待','中断'])('当前轮执行中选择%s，只有空闲时才能按目标权限交接',async mode=>{
    const fake=createFakeAdapter({speed:0});
    let finish: (()=>void) | undefined;
    let starts=0;
    gw=await startGw({adapters:[{...fake,async spawn(o){
      const c=await fake.spawn(o);
      c.prompt=async(_input,signal)=>{
        await new Promise<void>(resolve=>{finish=resolve;signal.addEventListener('abort',()=>resolve(),{once:true});});
        return {stopReason:signal.aborted?'cancelled':'end_turn'};
      };return c;
    }},{...fake,id:'codex',async spawn(o){
      starts++;const c=await fake.spawn(o);c.prompt=async()=>({stopReason:'end_turn'});return c;
    }}]});
    const token=await gw.pair(),project=await makeProject(gw,token),s=gw.gw.services;
    const {json:task}=await gw.api('POST','/tasks',{token,body:{projectId:project.id,agent:'fake',permission:'full',prompt:'保护运行中的任务',deferPrompt:true}});
    await s.tasks.prompt(task.id,'继续当前工作');await expect.poll(()=>!!finish).toBe(true);
    const switchAgent=()=>s.tasks.prompt(task.id,'核对结果',[],{agent:'codex'});
    await expect(switchAgent()).rejects.toThrow('正在执行');expect(starts).toBe(0);
    if(mode==='中断')await s.tasks.cancel(task.id);else finish!();
    await s.tasks.idle();
    await expect(switchAgent()).rejects.toThrow('仅支持只读或需审批');
    expect(s.db.get('SELECT id FROM handoffs WHERE task_id=?',task.id)).toBeUndefined();
    await s.tasks.patch(task.id,{permission:'readonly'});
    await switchAgent();await s.tasks.idle();
    expect(starts).toBe(1);expect(s.tasks.get(task.id).agent).toBe('codex');
  });
  it.each([false,true])('目标首轮失败后来源能继续同一会话（声明支持恢复：%s）',async resume=>{
    const fake=createFakeAdapter({speed:0});
    const turns:number[]=[];
    let succeeds=false,closed=0;
    gw=await startGw({adapters:[{...fake,async probeCapabilities(c){return {...await fake.probeCapabilities(c),resume};},async spawn(options){
      const c=await fake.spawn(options);
      let n=0;
      c.close=async()=>{closed++;};
      c.prompt=async()=>{
        turns.push(++n);
        return {stopReason:'end_turn'};
      };
      return c;
    }},{...fake,id:'codex',async spawn(options){
      const c=await fake.spawn(options);
      c.prompt=async()=>{
        expect(closed).toBe(0);
        expect(turns).toEqual(succeeds?[1,2]:[1]);
        return {stopReason:succeeds?'end_turn':'error'};
      };
      return c;
    }}]});
    const token=await gw.pair(),project=await makeProject(gw,token),s=gw.gw.services;
    const created=await gw.api('POST','/tasks',{token,body:{projectId:project.id,agent:'fake',permission:'readonly',prompt:'保留回合状态',deferPrompt:true}});
    const id=created.json.id;
    await s.tasks.prompt(id,'记住当前进度');await s.tasks.idle();
    await s.tasks.prompt(id,'交给另一 Agent',[],{agent:'codex'});await s.tasks.idle();
    expect(s.db.get('SELECT state FROM handoffs WHERE task_id=?',id)).toMatchObject({state:'failed'});
    expect(s.tasks.get(id).agent).toBe('fake');
    await s.tasks.prompt(id,'继续上一轮');await s.tasks.idle();
    expect(turns).toEqual([1,2]);
    expect(closed).toBe(0);
    succeeds=true;
    await s.tasks.prompt(id,'现在再交接',[],{agent:'codex'});await s.tasks.idle();
    expect(s.tasks.get(id).agent).toBe('codex');expect(closed).toBe(1);
    expect(s.db.all("SELECT agent_id FROM sessions WHERE task_id=? AND status='active'",id)).toEqual([{agent_id:'codex'}]);
    const sent=s.db.get<{id:string}>("SELECT id FROM handoffs WHERE task_id=? AND state='sent'",id)!;
    const returnUrl='/tasks/'+id+'/handoff/'+sent.id+'/return';
    await gw.api('PUT','/settings/handoff',{token,body:{confirmBeforeSend:true}});
    const back=await gw.api('POST',returnUrl,{token,body:{}});
    expect(back.json.pendingHandoffId).toBeTruthy();expect(s.tasks.get(id).agent).toBe('codex');
    expect((await gw.api('POST',returnUrl,{token,body:{confirmedId:back.json.pendingHandoffId}})).status).toBe(200);
    await s.tasks.idle();
    expect(s.tasks.get(id).agent).toBe('fake');
    expect(s.db.get('SELECT state FROM handoffs WHERE id=?',sent.id)).toEqual({state:'returned'});
  });
  it('确认后发送嵌入资源；只更正一次并在前十个工具内告警；按清单恢复并切回指定原生会话',async()=>{
    const fake=createFakeAdapter({speed:0});
    const prompts:PromptInput[]=[];
    const resumed:string[]=[];
    let targetStarted=0, targetCwd='',hasHistory=false;
    gw=await startGw({adapters:[{...fake,async probeCapabilities(c){return {...await fake.probeCapabilities(c),resume:true};},async spawn(o){
      const c=await fake.spawn(o);
      if(o.resume){resumed.push(o.resume.agentSessionId);Object.assign(c,{resumed:true});}
      c.prompt=async()=>({stopReason:'end_turn'});
      return c;
    }},{...fake,id:'codex',async spawn(o){
      targetStarted++;targetCwd=o.cwd;hasHistory=!!o.mcpServers?.some(s=>s.name==='aic-history');
      const c=await fake.spawn(o),caps=await fake.probeCapabilities(c);
      Object.assign(c,{caps:{...caps,prompt:{...caps.prompt,embeddedContext:true}}});
      c.prompt=async input=>{
        prompts.push(input);
        o.host.update({kind:'message',messageId:'reply'+prompts.length,text:prompts.length===1?'我先看 Wrong.cs。':'已核对 Level.cs。'});
        o.host.update({kind:'message_done',messageId:'reply'+prompts.length});
        if(prompts.length===1)for(let i=1;i<=11;i++) {
          o.host.update({kind:'tool_start',toolId:'t'+i,toolKind:i===2?'edit':'execute',target:i===2?'Level.cs':i===1||i===11?'npm test':'其他',title:'测试'});
          o.host.update({kind:'tool_end',toolId:'t'+i,ok:true,summary:null});
        }
        return {stopReason:'end_turn'};
      };
      return c;
    }}]});
    const token=await gw.pair(),p=await makeProject(gw,token),s=gw.gw.services;
    const {json:task}=await gw.api('POST','/tasks',{token,body:{projectId:p.id,agent:'fake',permission:'readonly',prompt:'检查关卡',deferPrompt:true}});
    await s.tasks.prompt(task.id,'第一轮目标');await s.tasks.idle();
    const first=s.db.get<{id:string;agent_session_id:string}>('SELECT id,agent_session_id FROM sessions WHERE task_id=?',task.id)!;
    await writeFile(path.join(task.workspace.path,'Level.cs'),'原版本');
    await s.tasks.updateMemory(task.id,()=>s.tasks.memory.constrain(task.id,{kind:'constraint',content:'不要修改 Level.cs'}));
    s.events.append({type:'tool.start',taskId:task.id,sessionId:first.id,data:{toolId:'past',kind:'execute',title:'验证',target:'npm test'}});
    s.events.append({type:'tool.end',taskId:task.id,sessionId:first.id,data:{toolId:'past',ok:true,summary:'已通过'}});
    expect((await gw.api('PUT','/settings/handoff',{token,body:{confirmBeforeSend:true}})).status).toBe(200);
    const ws=await WsClient.connect(gw.port,token);
    try {
      const next={taskId:task.id,text:'核对现状',target:{agent:'codex' as const}};
      const pending=await ws.call({op:'prompt',data:next});
      expect(pending.ok).toBe(true);
      const id=(pending.result as {pendingHandoffId:string}).pendingHandoffId;
      expect(targetStarted).toBe(0);expect(s.tasks.get(task.id).agent).toBe('fake');
      const url='/tasks/'+task.id+'/handoff/'+id;
      const ack=await ws.call({op:'prompt',data:{...next,handoff:{confirmedId:id,markdown:'编辑过的交接 Bearer synthetic-confirmation'}}});
      expect(ack.ok).toBe(true);await s.tasks.idle();
      expect(targetCwd).toBe(task.workspace.path);expect(hasHistory).toBe(true);
      expect(prompts).toHaveLength(2);
      expect(prompts[0]?.text).toContain(next.text);expect(prompts[0]?.resources?.length).toBe(2);
      expect(prompts[0]?.resources?.[1]?.text).toBe('编辑过的交接 Bearer ***');
      expect(prompts[1]?.text).toContain('Level.cs');
      const {json:record}=await gw.api('GET',url,{token});
      expect(record).toMatchObject({edited:true,state:'sent',quality:{restatement:{matched:false,corrected:true}}});
      expect(record.quality.warnings).toHaveLength(2);
      expect(s.db.get('SELECT parent_session_id,handoff_id FROM sessions WHERE id=?',record.document.meta.to.sessionId)).toMatchObject({parent_session_id:first.id,handoff_id:id});
      await writeFile(path.join(targetCwd,'Level.cs'),'后续版本');
      const preview=await gw.api('GET',url+'/restore',{token});expect(preview.json.files).toEqual(['Level.cs']);
      const back=await gw.api('POST',url+'/return',{token,body:{restoreRevision:preview.json.revision}});
      expect(back.json).toMatchObject({level:'H1'});
      expect(resumed).toEqual([first.agent_session_id]);expect(s.tasks.get(task.id).agent).toBe('fake');
      expect(await readFile(path.join(targetCwd,'Level.cs'),'utf8')).toBe('原版本');
    } finally {await ws.close();}
  });
  it('已发送环境附件的普通配置在以后的交接、历史和任务说明中继续打码',async()=>{
    const fake=createFakeAdapter({speed:0});
    let received='';
    gw=await startGw({adapters:[fake,{...fake,id:'codex',async spawn(opts){
      const c=await fake.spawn(opts);c.prompt=async input=>{received=JSON.stringify(input);return {stopReason:'end_turn'};};return c;
    }}]});
    const token=await gw.pair(),p=await makeProject(gw,token),s=gw.gw.services;
    const scene='AutumnVillage',weather='ClearMorning';
    const t=await s.tasks.create({projectId:p.id,agent:'fake',permission:'readonly',prompt:'检查场景',deferPrompt:true});
    const file=s.attachments.upload(t.id,'.env.关卡',Buffer.from('SCENE='+scene+'\nWEATHER="'+weather+'" # 天气\n'));
    await s.tasks.prompt(t.id,'检查本轮配置',[file.id]);await s.tasks.idle();
    const text='已选场景 '+scene+'，天气 '+weather;
    await s.tasks.updateMemory(t.id,()=>s.tasks.memory.constrain(t.id,{kind:'constraint',content:text}));
    await s.tasks.prompt(t.id,text,[],{agent:'codex'});await s.tasks.idle();
    const r=s.db.get<{id:string;to_session_id:string}>('SELECT id,to_session_id FROM handoffs WHERE task_id=?',t.id)!;
    const {readHistory}=await import('../src/handoff/history');
    const history=await readHistory(s,{taskId:t.id,handoffId:r.id,sessionId:r.to_session_id},{name:'get_events',arguments:{fromSeq:1,toSeq:99999}});
    for(const content of [received,JSON.stringify(history),await readFile(path.join(s.workspaces.get(t.id)!.path,'.aic','TASK.md'),'utf8')]){
      expect.soft(content).not.toContain(scene);expect.soft(content).not.toContain(weather);
    }
    expect(received).toContain('已选场景');expect(JSON.stringify(history)).toContain('已选场景');
  });
  it('交给另一 Agent 的带校验值二进制附件不能暴露命中的密钥字节',async()=>{
    const fake=createFakeAdapter({speed:0});
    const marker='sk-'+'synthetic'.repeat(3);
    const binary=Buffer.concat([Buffer.from([0,1,2]),Buffer.from(marker)]);
    const checksum=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
    expect(checksum(binary)).not.toBe(checksum(Buffer.from(binary.toString('latin1').replace(marker,'***'),'latin1')));
    const received:string[]=[];
    let targetStarts=0;
    gw=await startGw({adapters:[fake,{...fake,id:'codex',async spawn(options){
      targetStarts++;
      const connection=await fake.spawn(options);
      connection.prompt=async input=>{
        if(typeof input!=='string') for(const item of input.attachments??[]) {
          received.push(checksum(await readFile(item.path)));
        }
        return {stopReason:'end_turn'};
      };
      return connection;
    }}]});
    const token=await gw.pair(),project=await makeProject(gw,token),s=gw.gw.services;
    const created=await gw.api('POST','/tasks',{token,body:{projectId:project.id,agent:'fake',permission:'readonly',prompt:'核对素材',deferPrompt:true}});
    expect(created.status).toBe(201);
    const id=created.json.id,attachment=s.attachments.upload(id,'level.asset',binary);
    expect(attachment.mime).toBe('application/octet-stream');
    await s.tasks.prompt(id,'先登记素材');
    await s.tasks.idle();
    const current=s.db.get("SELECT id FROM sessions WHERE task_id=? AND status='active'",id);
    expect(current).toBeDefined();
    const draft={text:'按附件校验值核对素材',annotations:[],attachments:[attachment.id]};
    expect((await gw.api('PUT','/tasks/'+id+'/draft',{token,body:draft})).status).toBe(200);
    await expect(s.tasks.prompt(id,draft.text,[attachment.id],{agent:'codex'})).rejects.toThrow('替换或移除');
    expect(targetStarts).toBe(0);
    expect(s.tasks.get(id).agent).toBe('fake');
    expect(s.db.get("SELECT id FROM sessions WHERE task_id=? AND status='active'",id)).toEqual(current);
    expect(s.db.get('SELECT id FROM handoffs WHERE task_id=?',id)).toBeUndefined();
    expect(s.db.get('SELECT ref FROM handoff_checkpoints WHERE task_id=?',id)).toBeUndefined();
    expect((await gw.api('GET','/tasks/'+id+'/draft',{token})).json).toMatchObject(draft);
    const replacement=Buffer.from([0,4,5]);
    const safe=s.attachments.upload(id,'level.asset',replacement);
    await s.tasks.prompt(id,draft.text,[safe.id],{agent:'codex'});
    await s.tasks.idle();
    expect(received).toEqual([checksum(replacement)]);
    expect(s.tasks.get(id).agent).toBe('codex');
  });
});
