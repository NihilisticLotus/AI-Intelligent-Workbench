import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemorySecretStore } from '../src/secrets';
import { startGw, type TestGw } from './helpers';
import type { readMetadataJson } from '../src/independent/metadata-http';
let gw:TestGw|undefined;
afterEach(async()=>{vi.restoreAllMocks();await gw?.stop();gw=undefined;});
async function setup(reader:typeof readMetadataJson=async()=>{throw new Error('不应联网');}){
  gw=await startGw({metadataReader:reader,secretStore:new MemorySecretStore()});const token=await gw.pair();
  const response=await gw.api('POST','/independent/services',{token,body:{name:'官方资料测试',protocol:'responses',baseUrl:'https://open.bigmodel.cn/api/v1',authentication:'api_key',apiVersion:null,providerId:'zhipuai',plan:null,enabled:true}});
  expect(response.status).toBe(201);return {t:gw,token,service:response.json,s:gw.gw.services,route:`/independent/services/${response.json.id}`};
}
const body={expectedConfigRevision:1,includeCatalog:false,source:'configured' as const};
describe('已有模型能力预览',()=>{
  it('缺少 Key 仍可零网络预览，不读取密钥或修改模型；导入保留人工值、名称、停用及默认',async()=>{
    const read=vi.fn(async()=>{throw new Error('不应联网');});const {t,token,service,s,route}=await setup(read);
    let model=s.independent.createModel(service.id,{remoteModelId:'glm-5.3-flash',name:'人工名称'});
    s.independent.setDefault({selection:{serviceId:service.id,modelId:model.id}});
    model=s.independent.overrides(service.id,model.id,{expectedRevision:model.revision,values:{imageInput:false,contextWindow:1000000}});
    model=s.independent.patchModel(service.id,model.id,{expectedRevision:model.revision,enabled:false});
    s.independent.createModel(service.id,{remoteModelId:'unknown-image-high',name:'未知模型'});
    const credentialRead=vi.spyOn(s.independent,'discoveryCredentials');
    const before=JSON.stringify({models:s.independent.listModels(service.id),service:s.independent.getService(service.id),defaults:s.independent.getDefault()});
    const response=await t.api('POST',route+'/discovery',{token,body});expect(response.status).toBe(200);
    expect(response.json.snapshot).toMatchObject({source:'configured',pageCount:0,requestCount:0,includeCatalog:false});
    expect(response.json.snapshot.items).toHaveLength(2);expect(response.json.snapshot.items[1].evidence).toEqual([]);
    expect(credentialRead).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify({models:s.independent.listModels(service.id),service:s.independent.getService(service.id),defaults:s.independent.getDefault()})).toBe(before);
    const imported=await t.api('POST',route+'/models/import',{token,body:{snapshotId:response.json.snapshot.id,expectedConfigRevision:1,remoteModelIds:['glm-5.3-flash']}});
    expect(imported.status).toBe(200);const result=imported.json.items[0];
    expect(result).toMatchObject({id:model.id,name:'人工名称',enabled:false});
    expect(result.capabilities.find((c:{field:string})=>c.field==='imageInput')).toMatchObject({value:false,sourceKind:'manual',conflict:true});
    expect(result.capabilities.find((c:{field:string})=>c.field==='contextWindow').value).toBe(1000000);
    expect(result.capabilities.find((c:{field:string})=>c.field==='effortLevels').sourceKind).toBe('official');
    expect(result.capabilities.find((c:{field:string})=>c.field==='thinkingCanDisable').value).toBeNull();
    expect(s.independent.getDefault().selection?.modelId).toBe(model.id);expect(s.independent.listModels(service.id)).toHaveLength(2);
    expect(read).not.toHaveBeenCalled();expect(s.db.get('SELECT COUNT(*) AS n FROM independent_request_attempts')!.n).toBe(0);
  });
  it('显式公共目录只发一次无认证读取，补精确窗口但不覆盖官方图片声明',async()=>{
    const calls:Parameters<typeof readMetadataJson>[0][]=[];
    const {s,service}=await setup(async input=>{calls.push(input);return {digest:'fixture',json:{zhipuai:{id:'zhipuai',models:{'glm-5.3':{id:'glm-5.3',limit:{context:1000123},modalities:{input:['text','image']},api:{responses:{base_url:'https://open.bigmodel.cn/api/v1'}}}}}}};});
    s.independent.createModel(service.id,{remoteModelId:'glm-5.3',name:'模型'});const key=vi.spyOn(s.independent,'discoveryCredentials');
    const state=await s.independentDiscovery.refresh(service.id,{...body,includeCatalog:true});
    expect(calls).toHaveLength(1);expect(calls[0]).toMatchObject({publicCatalog:true});expect(calls[0]!.url.href).toBe('https://models.dev/experimental/v2.0/api.json?type=chat');expect(calls[0]!.headers).toBeUndefined();expect(key).not.toHaveBeenCalled();
    expect(state.snapshot).toMatchObject({pageCount:0,requestCount:1});
    const imported=s.independentDiscovery.import(service.id,{snapshotId:state.snapshot!.id,expectedConfigRevision:1,remoteModelIds:['glm-5.3']}).items[0]!;
    expect(imported.capabilities.find(c=>c.field==='contextWindow')).toMatchObject({value:1000123,sourceKind:'catalog'});
    expect(imported.capabilities.find(c=>c.field==='imageInput')).toMatchObject({value:false,sourceKind:'official'});
  });
  it('公共目录失败保留官方资料但不读取服务；没有模型时不伪造模型',async()=>{
    const read=vi.fn(async()=>{throw new Error('fixture-private-response');});const {s,service}=await setup(read);
    const empty=await s.independentDiscovery.refresh(service.id,body);expect(empty.snapshot?.items).toEqual([]);expect(empty.snapshot?.requestCount).toBe(0);expect(read).not.toHaveBeenCalled();
    s.db.run('UPDATE independent_discoveries SET attempted_at=0');s.independent.createModel(service.id,{remoteModelId:'glm-5.3',name:'模型'});
    const result=await s.independentDiscovery.refresh(service.id,{...body,includeCatalog:true});expect(read).toHaveBeenCalledOnce();expect(result.snapshot?.notices.join('')).toContain('仅保留本次已识别资料');expect(result.snapshot?.items[0]!.evidence.length).toBeGreaterThan(0);expect(JSON.stringify(result)).not.toContain('fixture-private-response');
  });
  it('配置修订、停用及鉴权仍受检查；旧服务模式失败不会暗中切换已有模型',async()=>{
    const read=vi.fn(async()=>{throw new Error('不应联网');});const {s,service,t,token,route}=await setup(read);
    s.independent.createModel(service.id,{remoteModelId:'glm-5.3',name:'模型'});
    expect((await t.api('POST',route+'/discovery',{body})).status).toBe(401);
    for(const headers of [{Host:'evil.example'},{Origin:'https://evil.example'}] as Record<string,string>[])expect((await t.api('POST',route+'/discovery',{token,body,headers})).status).toBe(403);
    await expect(s.independentDiscovery.refresh(service.id,{expectedConfigRevision:1,includeCatalog:false})).rejects.toThrow('尚未保存');
    expect(s.independentDiscovery.state(service.id).snapshot).toBeNull();expect(read).not.toHaveBeenCalled();
    await expect(s.independentDiscovery.refresh(service.id,{...body,expectedConfigRevision:2})).rejects.toThrow('配置已变化');
    await s.independent.patchService(service.id,{expectedRevision:1,enabled:false});
    await expect(s.independentDiscovery.refresh(service.id,body)).rejects.toThrow('已停用');expect(read).not.toHaveBeenCalled();
  });
});
