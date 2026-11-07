import { describe, expect, it } from 'vitest';
import type { IndependentService } from '@aic/protocol';
import { parseEndpointPage, supplementCatalog } from '../src/independent/metadata-parser';
const service = (extra: Partial<IndependentService> = {}): IndependentService => ({id:'s',name:'服务',revision:1,configRevision:1,protocol:'chat_completions',baseUrl:'https://example.com/v1',authentication:'none',apiVersion:null,providerId:null,plan:null,enabled:true,hasSecret:false,secretHint:null,createdAt:1,updatedAt:1,...extra});
const parse = (s: IndependentService, data: unknown) => parseEndpointPage(s,data,`${s.baseUrl}/models`,'fixture');
const values = (evidence: ReturnType<typeof parse>['items'][number]['evidence']) => Object.fromEntries(evidence.map((e) => [e.field,e.value]));
function directory() { return {p:{id:'p',models:{m:{id:'m',limit:{context:32000,input:28000,output:4000},modalities:{input:['text','image/png'],output:['text']},capabilities:{tools:{supported:true},reasoning:{supported:true,toggle:true,effort:['none','medium'],default:{type:'effort',value:'medium'},budget:{min:-1,max:999}},stream_usage:false,structured_output:true},api:{responses:{base_url:'https://example.com/v1',capabilities:{tools:{strict:true}}}}}}}}; }
describe('模型发现字段语义', () => {
  it('标准或未知兼容接口只识别 ID，保留原样且不推测模型名、声明或外链', () => {
    const s = service(); const r = parse(s,{data:[{id:'model/image-high',context_window:999,image_input:true,url:'https://evil.example/',api_key:'fixture'}],next:'https://evil.example/'});
    expect(r.items).toEqual([{remoteModelId:'model/image-high',name:'model/image-high',evidence:[]}]); expect(r.notices).toHaveLength(1);
  });
  it('坏条目跳过；未知根结构和重复 ID 整体拒绝', () => {
    expect(parse(service(),{data:[null,{id:5},{id:'bad\n'},{id:'ok'}]}).skipped).toBe(3);
    expect(() => parse(service(),{models:[]})).toThrow('未知'); expect(() => parse(service(),{data:[{id:'a'},{id:'a'}]})).toThrow('重复');
  });
  it('Messages 输入上限不当总窗口，false 与全部实际档位保留，分页游标只作参数', () => {
    const s = service({protocol:'anthropic_messages',apiVersion:'2026-10-21'});
    const r = parse(s,{data:[{id:'m',max_input_tokens:180000,max_tokens:32000,capabilities:{image_input:{supported:false},thinking:{supported:true,types:{disabled:{supported:false}}},effort:Object.fromEntries(['low','medium','high','xhigh','max'].map((x) => [x,{supported:x === 'medium'}]))}}],has_more:true,last_id:'https://evil.example/'});
    expect(values(r.items[0]!.evidence)).toEqual({inputLimit:180000,outputLimit:32000,imageInput:false,thinking:true,thinkingCanDisable:false,effortLevels:['medium']}); expect(r.next).toBe('https://evil.example/');
  });
  it('未接入的 Messages 版本、零上限、空能力保持未知；缺分页状态拒绝', () => {
    expect(parse(service({protocol:'anthropic_messages',apiVersion:'2023-06-01'}),{data:[{id:'m',max_tokens:999}],has_more:false}).items[0]!.evidence).toEqual([]);
    expect(parse(service({protocol:'anthropic_messages',apiVersion:'2026-10-21'}),{data:[{id:'m',max_tokens:0,max_input_tokens:null,capabilities:{}}],has_more:false}).items[0]!.evidence).toEqual([]);
    expect(() => parse(service({protocol:'anthropic_messages'}),{data:[]})).toThrow('分页');
  });
  it('DeepSeek 仅对官方地址解释扩展；空 effort 列表与无图片的完整模态有效', () => {
    const data = {data:[{id:'m',context_window:128000,max_output_tokens:8000,input_modalities:['text'],effort:{supported_levels:[],default_level:'high'}}]};
    expect(values(parse(service({baseUrl:'https://api.deepseek.com/v1'}),data).items[0]!.evidence)).toEqual({contextWindow:128000,outputLimit:8000,inputModalities:['text'],imageInput:false,effortLevels:[]});
    expect(parse(service(),data).items[0]!.evidence).toEqual([]);
  });
  it('OpenRouter 不用 top_provider 限制，不以 tools 缺席推断不支持', () => {
    const r = parse(service({baseUrl:'https://openrouter.ai/api/v1'}),{data:[{id:'m',context_length:128000,architecture:{input_modalities:['text','image']},supported_parameters:['reasoning'],top_provider:{max_completion_tokens:42}}]});
    expect(values(r.items[0]!.evidence)).toEqual({contextWindow:128000,inputModalities:['text','image'],imageInput:true});
  });
  it('v2 精确匹配服务商、原始模型、协议和 URL，识别 MIME 图片及来源范围', () => {
    const s = service({protocol:'responses',providerId:'p'}); const items = parse(s,{data:[{id:'m'}]}).items;
    supplementCatalog(s,items,directory(),'hash',123);
    expect(values(items[0]!.evidence)).toEqual({contextWindow:32000,inputLimit:28000,outputLimit:4000,inputModalities:['text','image/png'],imageInput:true,outputModalities:['text'],tools:true,structuredOutput:true,streamUsage:false,thinking:true,effortLevels:['none','medium'],defaultEffort:'medium'});
    expect(items[0]!.evidence.every((e) => e.kind === 'catalog' && e.scope.protocol === 'responses' && e.sourceVersion.includes('hash'))).toBe(true);
    // 推理开关可否关闭、预算单位和一般 streaming 未经明确核实，不映射。
    expect(items[0]!.evidence.some((e) => ['thinkingBudgetMin','thinkingBudgetMax','thinkingCanDisable','streaming'].includes(e.field))).toBe(false);
  });
  it.each([{protocol:'chat_completions' as const},{baseUrl:'https://relay.example/v1'},{providerId:'other'},{plan:'paid'},{apiVersion:'2026-10-21'}])('范围不同不套用公共目录 %j', (extra) => {
    const s = service({protocol:'responses',providerId:'p',...extra}); const items = parse(s,{data:[{id:'m'}]}).items;
    supplementCatalog(s,items,directory(),'hash'); expect(items[0]!.evidence).toEqual([]);
  });
  it('额外 API path、模板、v1 或不兼容结构不降级套用', () => {
    const s = service({protocol:'responses',providerId:'p'});
    for (const raw of [{p:{models:{m:{limit:{context:9}}}}},null,directory()]) {
      if (raw && 'p' in raw && 'id' in raw.p) Object.assign(raw.p.models.m.api.responses,{path:'/special'});
      const items = parse(s,{data:[{id:'m'}]}).items; supplementCatalog(s,items,raw,'hash'); expect(items[0]!.evidence).toEqual([]);
    }
  });
});
