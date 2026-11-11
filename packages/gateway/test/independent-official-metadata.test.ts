import { describe, expect, it } from 'vitest';
import type { IndependentDiscoveredModel, IndependentService } from '@aic/protocol';
import { supplementOfficial } from '../src/independent/official-metadata';
import { capabilityScope, resolveCapabilities, usableCapability } from '../src/independent/capabilities';
const service = (extra: Partial<IndependentService> = {}): IndependentService => ({id:'s',name:'服务',revision:1,configRevision:1,protocol:'responses',baseUrl:'https://open.bigmodel.cn/api/v1',authentication:'none',apiVersion:null,providerId:null,plan:null,enabled:true,hasSecret:false,secretHint:null,createdAt:1,updatedAt:1,...extra});
const items = (): IndependentDiscoveredModel[] => ['glm-5.3','glm-5.3-flash','other-image-max'].map(id=>({remoteModelId:id,name:id,evidence:[]}));
const reviewedAt=Date.UTC(2026,10,8,12,17);

describe('精确适用范围的官方资料快照',()=>{
  it('文本与多模态分别记录；只采用 Responses 明确档位，不猜上下文整数、关闭语义或用量能力',()=>{
    const s=service();const models=items();expect(supplementOfficial(s,models).join('')).toContain('不代表账号可用');
    const resolve=(i:number)=>Object.fromEntries(resolveCapabilities(models[i]!.evidence,capabilityScope(s,models[i]!.remoteModelId),reviewedAt).map(c=>[c.field,c.value]));
    expect(resolve(0)).toMatchObject({imageInput:false,inputModalities:['text'],contextWindow:null,inputLimit:null,outputLimit:131072,thinking:true,thinkingCanDisable:null,effortLevels:['none','minimal','low','medium','high','xhigh','max'],defaultEffort:'max',tools:true,streaming:true,streamUsage:null,structuredOutput:null,thinkingBudgetMin:null});
    expect(resolve(1)).toMatchObject({imageInput:true,inputModalities:['text','image','video','file'],outputModalities:['text']});
    expect(models[2]!.evidence).toEqual([]);
    for(const model of models.slice(0,2)){
      expect(new Set(model.evidence.map(e=>e.id)).size).toBe(model.evidence.length);
      expect(model.evidence.every(e=>e.kind==='official'&&e.observedAt===reviewedAt&&e.expiresAt===reviewedAt+604800000&&e.sourceUrl?.startsWith('https://docs.bigmodel.cn/')&&e.scope.remoteModelId===model.remoteModelId)).toBe(true);
      expect(model.evidence.find(e=>e.field==='effortLevels')!.sourceUrl).toContain('/responses/introduction');
    }
  });
  it.each([{protocol:'chat_completions' as const},{baseUrl:'https://open.bigmodel.cn/api/paas/v4'},{baseUrl:'https://relay.example/api/v1'},{apiVersion:'2026-10-21'},{plan:'coding'},{providerId:'other'}])('不把官方能力套给其他协议、转发或套餐 %j',extra=>{
    const models=items();expect(supplementOfficial(service(extra),models)).toEqual([]);expect(models.every(m=>m.evidence.length===0)).toBe(true);
  });
  it('核对时间不随点击更新；到期明确标旧；接口与人工证据仍有较高优先级',()=>{
    const s=service({providerId:'zhipuai',baseUrl:'https://open.bigmodel.cn/api/v1/'});const a=items(),b=items();supplementOfficial(s,a);supplementOfficial(s,b);expect(a).toEqual(b);
    const evidence=a[1]!.evidence;const scope=capabilityScope(s,'glm-5.3-flash');
    expect(resolveCapabilities(evidence,scope,reviewedAt+604800001).find(c=>c.field==='imageInput')?.stale).toBe(true);
    const original=evidence.find(e=>e.field==='imageInput')!;
    const endpoint={...original,id:'endpoint',kind:'endpoint' as const,value:false};
    expect(resolveCapabilities([...evidence,endpoint],scope,reviewedAt).find(c=>c.field==='imageInput')?.value).toBe(false);
    const manual={...original,id:'manual',kind:'manual' as const,value:false};
    expect(resolveCapabilities([...evidence,manual],scope,reviewedAt).find(c=>c.field==='imageInput')).toMatchObject({value:false,sourceKind:'manual',conflict:true});
  });
  it('到期后能力仍可用、只标需复核；冲突或配置变更后的无值才算未知（ISSUE-0059）',()=>{
    const s=service();const models=items();supplementOfficial(s,models);
    const scope=capabilityScope(s,'glm-5.3-flash');const later=reviewedAt+30*86400000;
    const caps=resolveCapabilities(models[1]!.evidence,scope,later);
    expect(caps.find(c=>c.field==='tools')).toMatchObject({value:true,stale:true,conflict:false});
    for(const field of ['tools','streaming','imageInput','thinking'] as const) expect(usableCapability({capabilities:caps},field)).toBe(true);
    expect(usableCapability({capabilities:caps},'outputLimit')).toBe(131072);
    expect(usableCapability({capabilities:caps},'effortLevels')).toEqual(['none','minimal','low','medium','high','xhigh','max']);
    // 配置修订后旧证据不适用：值为 null，仍是未知
    const revised=resolveCapabilities(models[1]!.evidence,capabilityScope({...s,configRevision:2},'glm-5.3-flash'),later);
    expect(revised.find(c=>c.field==='tools')).toMatchObject({value:null,stale:true}); expect(usableCapability({capabilities:revised},'tools')).toBeNull();
    // 冲突时即使有人工值也不用
    const original=models[1]!.evidence.find(e=>e.field==='tools')!;
    const conflicted=resolveCapabilities([...models[1]!.evidence,{...original,id:'other',sourceUrl:'https://docs.bigmodel.cn/other',value:false}],scope,later);
    expect(usableCapability({capabilities:conflicted},'tools')).toBeNull();
  });
});
