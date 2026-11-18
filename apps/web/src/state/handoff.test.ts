import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@aic/protocol';
import { HttpClient } from '../api/http';
import { buildTimeline, groupTurns } from './core';
import { nextTarget } from './handoff';

describe('发送前的目标与交接分隔条',()=>{
  it('连续选择保留最后一个目标，撤销或选回当前 Agent 后清除',()=>{
    let pending=nextTarget('fake',{agent:'claude',model:'第一项'});
    expect(pending?.agent).toBe('claude');
    pending=nextTarget('fake',{agent:'codex',model:'第二项'});
    expect(pending).toEqual({agent:'codex',model:'第二项'});
    expect(nextTarget('fake',{agent:'fake'})).toBeUndefined();
    expect(nextTarget('fake')).toBeUndefined();
  });
  it('多个交接步骤和最终收据归入原来的分隔条，用户消息保留顺序',()=>{
    const base={taskId:'task',sessionId:null,ts:1};
    const events:EventEnvelope[]=[
      {...base,seq:1,type:'handoff.progress',data:{handoffId:'one',step:'generate',status:'running'}},
      {...base,seq:2,type:'message.user',data:{messageId:'message',text:'继续'}},
      {...base,seq:3,type:'handoff.progress',data:{handoffId:'one',step:'generate',status:'done'}},
      {...base,seq:4,type:'session.handoff',data:{handoffId:'one',fromSession:null,toSession:'new',from:'fake',to:'codex',level:'H2',
        quality:{redactions:0,added:[],inconsistent:[],coveragePassed:true,consistencyPassed:true,estimatedTokens:150,window:4000}}},
      {...base,seq:5,type:'handoff.progress',data:{handoffId:'two',step:'send',status:'failed'}},
    ];
    const rows=groupTurns(buildTimeline(events));
    expect(rows.map(r=>r.kind)).toEqual(['handoff','user','handoff']);
    expect(rows[0]).toMatchObject({id:'one',steps:{generate:'done'},receipt:{to:'codex',level:'H2'}});
    expect(rows[2]).toMatchObject({id:'two',steps:{send:'failed'}});
  });
  it('设置读取与保存走版本化接口并原样保留模型和共享额度',async()=>{
    const calls:Array<[string,string]>=[];
    let saved={confirmBeforeSend:false};
    const api=new HttpClient({fetchImpl:async(url,init)=>{
      calls.push([String(url),init!.method!]);
      if (init?.body) saved=JSON.parse(String(init.body));
      return Response.json(saved);
    }});
    expect(await api.handoffSettings()).toEqual(saved);
    const next={confirmBeforeSend:true,summaryModel:{serviceId:'service',modelId:'model'},summaryBudget:{maxRequests:2,money:null}};
    expect(await api.saveHandoffSettings(next)).toEqual(next);
    expect(await api.handoffSettings()).toEqual(next);
    expect(calls).toEqual(['GET','PUT','GET'].map(method=>['/api/v1/settings/handoff',method]));
  });
});
