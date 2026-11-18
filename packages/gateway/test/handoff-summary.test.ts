import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createFakeAdapter } from '@aic/adapters';
import { makeProject, startGw, type TestGw } from './helpers';
import { previewHandoff } from '../src/handoff/preview';
import { IndependentRequestLedger } from '../src/independent/request-ledger';

let gw:TestGw|undefined, server:Server|undefined;

afterEach(async()=>{
  await gw?.stop();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>(resolve=>server!.close(()=>resolve()));
  }
  gw=undefined; server=undefined;
});

async function setup(mode:'correct'|'wrong'|'invalid'|'timeout', window=4000) {
  const seen:string[]=[];
  const goal='修复关卡入口';
  const latest='请保持门的位置';
  server=createServer((req,res)=>{
    void (async()=>{
      const chunks:Buffer[]=[];
      for await(const chunk of req) chunks.push(Buffer.from(chunk));
      const raw=Buffer.concat(chunks).toString();
      seen.push(raw);
      if(mode==='timeout') return;
      const messages=JSON.parse(raw).messages;
      const detail=messages.at(-1).content[0].text;
      let content=JSON.stringify({decisions:['保持门的位置','更新 ghost/file.ts'],current:'复核入口'});
      if(mode==='invalid') content='不是 JSON';
      if(detail.includes('"问题":')) {
        const qs:string[]=JSON.parse(detail).问题;
        const answers=qs.map(q=>{
          if(mode==='wrong') return '无关答案';
          if(q.includes('最初')) return goal;
          if(q.includes('用户消息')) return latest;
          if(q.includes('交出')) return 'fake';
          if(q.includes('接收')) return 'codex';
          if(q.includes('分支')) return JSON.parse(detail).交接内容.match(/任务分支：([^\n]+)/)?.[1]??'未记录';
          return '0';
        });
        content=JSON.stringify({answers});
      }
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],
        usage:{prompt_tokens:20,completion_tokens:10}}));
    })().catch(()=>res.destroy());
  });
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));
  const fake=createFakeAdapter({speed:0});
  gw=await startGw({adapters:[fake,{...fake,id:'codex'}]});
  const s=gw.gw.services, token=await gw.pair(), project=await makeProject(gw,token);
  const service=await s.independent.createService({name:'本机摘要',baseUrl:'http://127.0.0.1:'+(server.address() as {port:number}).port+'/v1',
    authentication:'none',protocol:'chat_completions',apiVersion:'2023-06-01',enabled:true,providerId:null,plan:null});
  const model=s.independent.createModel(service.id,{name:'摘要夹具',remoteModelId:'fixture'});
  const selection={serviceId:service.id,modelId:model.id};
  const settings={confirmBeforeSend:true,summaryModel:selection,summaryBudget:{maxRequests:2,money:null}};
  const save=await gw.api('PUT','/settings/handoff',{token,body:settings});
  expect(save.status).toBe(200);
  async function task() {
    const reply=await gw!.api('POST','/tasks',{token,body:{projectId:project.id,agent:'fake',permission:'readonly',prompt:goal,deferPrompt:true}});
    const id=reply.json.id, session='fixture-'+id;
    s.db.run("INSERT INTO sessions(id,task_id,agent_id,status,started_at) VALUES (?,?,'codex','ended',1)",session,id);
    s.events.append({taskId:id,sessionId:session,type:'session.usage',data:{used:0,size:window}});
    s.events.append({taskId:id,sessionId:null,type:'message.done',data:{messageId:'fixture',text:'历史材料'.repeat(500)+' ghp_fixtureSecret1234567890'}});
    s.events.append({taskId:id,sessionId:null,type:'message.user',data:{messageId:'latest',text:latest}});
    return id as string;
  }
  const id=await task();
  return {s,seen,id,task,settings,selection};
}

describe('交接摘要与探针',()=>{
  it('正常发送入口生成 H3，两笔费用记在本任务并占用所有任务的摘要额度',async()=>{
    const {s,id,seen,task,settings}=await setup('correct');
    expect((await previewHandoff(s,id,{agent:'codex'})).level).toBe('H4');
    expect(seen).toHaveLength(0);
    const response=await s.tasks.prompt(id,'继续修复',[],{agent:'codex'});
    const record=s.tasks.handoffs!.get(id,response.pendingHandoffId!);
    expect(record.level).toBe('H3');
    expect(record.quality.probe!.passed).toEqual(record.quality.probe!.total);
    expect(record.quality.probe?.items).toHaveLength(record.quality.probe!.total);
    expect(record.quality.probe?.items?.every(f=>f.passed && f.question)).toBe(true);
    expect(record.document.decisions).toEqual(['保持门的位置']);
    expect(record.quality.inconsistent).toContain('未找到来源：ghost/file.ts');
    expect(seen).toHaveLength(2);
    expect(seen.join('')).not.toContain('ghp_fixtureSecret1234567890');
    expect(seen[1]).not.toContain('历史材料'.repeat(100));
    expect(s.db.all('SELECT task_id, state, json_extract(attempt_json,\'$.purpose\') AS purpose FROM handoff_summary_requests'))
      .toEqual(Array(2).fill({task_id:id,state:'succeeded',purpose:'handoff_summary'}));
    expect(s.db.all('SELECT task_id FROM independent_task_models')).toEqual([]);
    expect(s.db.all("SELECT id FROM sessions WHERE agent_id='independent'")).toEqual([]);
    s.tasks.handoffs!.settings({...settings,summaryModel:null});
    s.tasks.handoffs!.settings(settings);
    const second=await task();
    const execution=new IndependentRequestLedger(s.db);
    const binding=s.independent.bind(second,settings.summaryModel);
    execution.create(binding,{maxRequests:3,money:null});
    const next=await s.tasks.prompt(second,'继续',[],{agent:'codex'});
    expect(s.tasks.handoffs!.get(second,next.pendingHandoffId!).level).toBe('H4');
    expect(execution.snapshot(second).remainingRequests).toBe(3);
    expect(seen).toHaveLength(2);
  },60000);

  it('最后一次摘要额度用完后不发送探针，失败与重启也不会退回金额预留', async()=>{
    const {s,id,seen,selection,settings}=await setup('correct');
    const money={currency:'CNY',maxReservedMicros:10,modelCeilingMicros:10,counterCeilingMicros:null};
    const execution=s.tasks.handoffs!;
    execution.settings({...settings,summaryBudget:{maxRequests:2,money}});
    const result=await previewHandoff(s,id,{agent:'codex'},{summaryModel:selection});
    expect(result.level).toBe('H4');
    expect(result.quality.summaryFailure).toBe('probe');
    expect(result.document.decisions).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(execution.summaryLedger.summaryUsage()).toEqual({count:1,reserved:10,pending:0});
    expect(()=>execution.settings(settings)).toThrow('币种');
    execution.settings({...settings,summaryBudget:{maxRequests:2,money:{...money,maxReservedMicros:20}}});
    const binding=s.independent.summarySource(id,selection).bound(id);
    const ledger=execution.summaryLedger;
    const request=ledger.reserve(binding,{kind:'model',requestHash:'b'.repeat(64)});
    const recovered=new IndependentRequestLedger(s.db,'summary');
    expect(recovered.recover().map(row=>row.id)).toEqual([request]);
    expect(recovered.get(request).status).toBe('interrupted');
    expect(recovered.summaryUsage()).toEqual({count:2,reserved:20,pending:0});
    expect(()=>ledger.reserve(binding,{kind:'model',requestHash:'b'.repeat(64)})).toThrow('预留不足');
    expect(seen).toHaveLength(1);
  },60000);

  it.each(['invalid','timeout'] as const)('摘要 %s 后使用 H4，保留一次占额并停止',async mode=>{
    const {s,id,seen,selection}=await setup(mode);
    const result=await previewHandoff(s,id,{agent:'codex'},{summaryModel:selection,summaryTimeoutMs:mode==='timeout'?250:2000});
    expect(result.level).toBe('H4');
    expect(result.quality.summaryFailure).toBe('summary');
    expect(result.document.decisions).toBeUndefined();
    expect(result.quality.probe).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(s.tasks.handoffs!.summaryLedger.summaryUsage()).toEqual({count:1,reserved:0,pending:0});
  },60000);

  it('最小交接和关键原文仍放不下才等用户选择，原 Agent 保留', async()=>{
    const {s,id,settings,seen}=await setup('wrong',40);
    s.tasks.handoffs!.settings({...settings,confirmBeforeSend:false});
    const result=await s.tasks.prompt(id,'继续',[],{agent:'codex'});
    const record=s.tasks.handoffs!.get(id,result.pendingHandoffId!);
    expect(record.level).toBe('H4');
    expect(record.quality.windowConfirmation).toBe(true);
    expect(record.quality.probe?.passed).toBe(0);
    expect(s.tasks.get(id).agent).toBe('fake');
    expect(seen).toHaveLength(2);
  },60000);

  it.each([4000,800])('探针全错时按窗口 %i 升级或补入原文，不追加模型请求',async window=>{
    const {s,id,seen,selection}=await setup('wrong',window);
    const result=await previewHandoff(s,id,{agent:'codex'},{summaryModel:selection});
    expect(result.quality.probe?.passed).toBe(0);
    expect(result.level).toBe(window===4000?'H2':'H3');
    if(window===800) expect(result.markdown).toContain('探针核对的原始事实');
    expect(seen).toHaveLength(2);
  },60000);
});
