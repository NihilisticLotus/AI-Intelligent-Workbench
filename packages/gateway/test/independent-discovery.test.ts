import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { DiscoverIndependentModelsBody, IndependentCapabilityEvidence } from '@aic/protocol';
import { FeatureKey } from '@aic/protocol';
import { MetadataHttpError, readMetadataJson } from '../src/independent/metadata-http';
import { MemorySecretStore } from '../src/secrets';
import { startGw, type TestGw } from './helpers';
let gw: TestGw | undefined; const servers: Server[] = [];
afterEach(async () => {vi.restoreAllMocks(); await gw?.stop(); gw=undefined; for(const s of servers.splice(0)){s.closeAllConnections();await new Promise<void>((r)=>s.close(()=>r()));}});
const body: DiscoverIndependentModelsBody = {expectedConfigRevision:1,includeCatalog:false};
async function setup(reader: typeof readMetadataJson = async () => ({json:{data:[{id:'m'}]},digest:'fixture'}), extra: Record<string,unknown> = {}) {
  gw = await startGw({metadataReader:reader,secretStore:new MemorySecretStore()}); const token = await gw.pair();
  const r = await gw.api('POST','/independent/services',{token,body:{name:'服务',protocol:'chat_completions',baseUrl:'https://example.com/v1',authentication:'none',apiVersion:null,providerId:null,plan:null,enabled:true,...extra}});
  expect(r.status).toBe(201); const service = r.json;
  const route = `/independent/services/${service.id}`; return {t:gw,token,service,route,s:gw.gw.services};
}
describe('模型发现预览与追加导入', () => {
  it('实际本机接口发现、缓存与导入均走 REST，不修改默认或原模型', async () => {
    let calls=0; const server=createServer((req,res)=>{calls++;expect(req.url).toBe('/v1/models');res.writeHead(200,{'content-type':'application/json'});res.end('{"data":[{"id":"m"},{"id":"n"}]}');});servers.push(server);await new Promise<void>((r)=>server.listen(0,'127.0.0.1',r));
    const baseUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    const {t,token,route,s,service}=await setup(readMetadataJson,{baseUrl});
    const old=s.independent.createModel(service.id,{remoteModelId:'m',name:'原名称'});s.independent.setDefault({selection:{serviceId:service.id,modelId:old.id}});
    const discovered=await t.api('POST',`${route}/discovery`,{token,body});expect(discovered.status).toBe(200);expect(discovered.json.snapshot.items).toHaveLength(2);expect(s.independent.listModels(service.id)).toHaveLength(1);
    const cached=await t.api('GET',`${route}/discovery`,{token});expect(cached.json).toEqual(discovered.json);expect(calls).toBe(1);
    const imported=await t.api('POST',`${route}/models/import`,{token,body:{snapshotId:cached.json.snapshot.id,expectedConfigRevision:1,remoteModelIds:['m','n']}});
    expect(imported.status).toBe(200);expect(imported.json.items.map((m: {name:string})=>m.name)).toEqual(['原名称','n']);expect(s.independent.getDefault().selection?.modelId).toBe(old.id);
    expect((await t.api('POST',`${route}/discovery`,{token,body})).status).toBe(429);expect(calls).toBe(1);
  });
  it('发现三条路由都执行令牌、Host、Origin 检查，夹带证据不能导入', async () => {
    const read=vi.fn(async()=>({json:{data:[]},digest:'fixture'}));const {t,token,route}=await setup(read);
    for(const [method,path,payload] of [['GET',`${route}/discovery`,undefined],['POST',`${route}/discovery`,body],['POST',`${route}/models/import`,{snapshotId:'x',expectedConfigRevision:1,remoteModelIds:['m']}]] as const){
      expect((await t.api(method,path,{body:payload})).status).toBe(401);
      expect((await t.api(method,path,{token,body:payload,headers:{Host:'evil.example'}})).status).toBe(403);
      expect((await t.api(method,path,{token,body:payload,headers:{Origin:'https://evil.example'}})).status).toBe(403);
    }
    expect(read).not.toHaveBeenCalled();
    expect((await t.api('POST',`${route}/models/import`,{token,body:{snapshotId:'x',expectedConfigRevision:1,remoteModelIds:['m'],evidence:[]}})).status).toBe(400);
    const hello=await t.api('GET','/hello',{token});expect(hello.json.features[FeatureKey.IndependentDiscovery]).toBe(true);expect(hello.json.features[FeatureKey.IndependentRuntime]).toBe(false);
  });
  it('两服务密钥仅送自己的模型接口，公共目录不带认证；事件与缓存无密钥', async () => {
    const calls: Parameters<typeof readMetadataJson>[0][]=[];
    const {s,t,service,token,route}=await setup(async(input)=>{calls.push(input);return {json:input.publicCatalog?{}:{data:[{id:'m'}]},digest:'fixture'};},{authentication:'api_key',apiKey:'fixture-key-one'});
    const other=await s.independent.createService({name:'其他服务',protocol:'responses',baseUrl:'https://other.example/v1',authentication:'api_key',apiKey:'fixture-key-two',apiVersion:null,providerId:null,plan:null,enabled:true});
    await s.independentDiscovery.refresh(service.id,{...body,includeCatalog:true});await s.independentDiscovery.refresh(other.id,body);
    expect(calls.map((c)=>c.headers?.Authorization)).toEqual(['Bearer fixture-key-one',undefined,'Bearer fixture-key-two']);expect(calls[1]!.publicCatalog).toBe(true);
    const persisted=JSON.stringify(s.db.all('SELECT * FROM independent_discoveries'))+JSON.stringify(s.db.all('SELECT * FROM events'))+JSON.stringify(s.db.all('SELECT * FROM audit_log'));
    expect(persisted).not.toContain('fixture-key');expect((await t.api('GET',`${route}/discovery`,{token})).text).not.toContain('fixture-key');
  });
  it('分页只改变原服务查询参数，跨页去重和循环游标拒绝，不跟随响应链接', async () => {
    const urls:string[]=[];
    const {s,service}=await setup(async(input)=>{urls.push(input.url.href);return {json:urls.length===1?{data:[{id:'a'}],has_more:true,last_id:'https://evil.example/'}:{data:[{id:'b'}],has_more:false,next:'https://evil.example'},digest:'fixture'};},{protocol:'anthropic_messages',apiVersion:'2026-10-21'});
    const state=await s.independentDiscovery.refresh(service.id,body);expect(state.snapshot?.pageCount).toBe(2);expect(new URL(urls[1]!).origin).toBe('https://example.com');expect(new URL(urls[1]!).searchParams.get('after_id')).toBe('https://evil.example/');
    s.db.run('UPDATE independent_discoveries SET attempted_at=0');urls.length=0;
    const duplicate=await s.independent.createService({name:'重复',protocol:'anthropic_messages',baseUrl:'https://example.com/v1',authentication:'none',apiVersion:'2026-10-21',providerId:null,plan:null,enabled:true});
    // 让第二页也返回首条 ID，整个新预览不能留下半份缓存。
    const read=vi.spyOn(s.independentDiscovery as unknown as {read:typeof readMetadataJson},'read').mockResolvedValue({json:{data:[{id:'a'}],has_more:true,last_id:'same'},digest:'fixture'});
    await expect(s.independentDiscovery.refresh(duplicate.id,body)).rejects.toThrow('重复');expect(s.independentDiscovery.state(duplicate.id).snapshot).toBeNull();read.mockRestore();
  });
  it('10 页及 500 模型上限可见，目录最多额外一次', async () => {
    let count=0;const {s,service}=await setup(async(input)=>{count++;return {json:input.publicCatalog?{}:{data:[{id:`m${count}`}],has_more:true,last_id:`m${count}`},digest:'fixture'};},{protocol:'anthropic_messages',apiVersion:'2026-10-21'});
    const state=await s.independentDiscovery.refresh(service.id,{...body,includeCatalog:true});expect(state.snapshot?.pageCount).toBe(10);expect(state.snapshot?.requestCount).toBe(11);expect(state.snapshot?.notices.join('')).toContain('预览上限');
  });
  it('单页超过 500 个模型不会扩大预览，坏条目和截断有明确计数', async () => {
    const {s,service}=await setup(async()=>({json:{data:[...Array.from({length:502},(_,i)=>({id:`m${i}`})),{id:null}]},digest:'fixture'}));
    const state=await s.independentDiscovery.refresh(service.id,body);expect(state.snapshot?.items).toHaveLength(500);expect(state.snapshot?.skipped).toBe(3);expect(state.snapshot?.requestCount).toBe(1);expect(state.snapshot?.notices.join('')).toContain('超过上限');
  });
  it('Messages 未填 API 版本不发请求；整体退出取消在途请求且不更新缓存', async () => {
    const read=vi.fn(async()=>({json:{data:[]},digest:'fixture'}));const {s,service}=await setup(read,{protocol:'anthropic_messages'});
    await expect(s.independentDiscovery.refresh(service.id,body)).rejects.toThrow('明确填写');expect(read).not.toHaveBeenCalled();
    const pendingRead=vi.spyOn(s.independentDiscovery as unknown as {read:typeof readMetadataJson},'read').mockImplementation(async(input)=>new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(new MetadataHttpError('元数据读取已取消或超时')),{once:true})));
    const other=await s.independent.createService({name:'退出测试',protocol:'responses',baseUrl:'https://example.com/v1',authentication:'none',apiVersion:null,providerId:null,plan:null,enabled:true});
    const pending=s.independentDiscovery.refresh(other.id,body);await vi.waitFor(()=>expect(pendingRead).toHaveBeenCalledOnce());s.independentDiscovery.close();await expect(pending).rejects.toThrow('取消或超时');expect(s.independentDiscovery.state(other.id).snapshot).toBeNull();
  });
  it('缓存跨数据库重开保留，改配置后不能导入其他服务或旧修订的快照', async () => {
    const {s,service,t,route,token}=await setup();const state=await s.independentDiscovery.refresh(service.id,body);
    const other=await s.independent.createService({name:'另一个服务',protocol:'responses',baseUrl:'https://example.com/v1',authentication:'none',apiVersion:null,providerId:null,plan:null,enabled:true});
    const selected={snapshotId:state.snapshot!.id,expectedConfigRevision:1,remoteModelIds:['m']};expect(()=>s.independentDiscovery.import(other.id,selected)).toThrow('预览已变化');
    await s.independent.patchService(service.id,{expectedRevision:1,baseUrl:'https://other.example/v1'});expect(()=>s.independentDiscovery.import(service.id,selected)).toThrow('配置已变化');expect(s.independent.listModels(service.id)).toEqual([]);
    // 重新打开同一数据目录，缓存可查但旧配置仍然不可导入。
    const dir=t.dataDir;await t.gw.close();gw=await startGw({metadataReader:async()=>{throw new Error('不应联网');}},dir);
    const freshToken=await gw.pair();const cached=await gw.api('GET',route+'/discovery',{token:freshToken});expect(cached.json.snapshot.id).toBe(state.snapshot!.id);expect(cached.json.stale).toBe(true);expect(token).toBeTypeOf('string');
  });
  it('上游失败保留旧缓存、记录固定摘要并退避；目录失败保留本次列表', async () => {
    let fail=false;const {s,service}=await setup(async(input)=>{if(fail)throw new MetadataHttpError('元数据接口返回 HTTP 401',401);if(input.publicCatalog)throw new Error('fixture-secret');return {json:{data:[{id:'m'}]},digest:'fixture'};});
    const good=await s.independentDiscovery.refresh(service.id,{...body,includeCatalog:true});expect(good.snapshot?.notices.join('')).toContain('公共目录读取失败');
    s.db.run('UPDATE independent_discoveries SET attempted_at=0');fail=true;await expect(s.independentDiscovery.refresh(service.id,body)).rejects.toThrow('401');
    const old=s.independentDiscovery.state(service.id);expect(old.snapshot?.id).toBe(good.snapshot?.id);expect(old.stale).toBe(true);expect(old.lastError?.message).toContain('401');await expect(s.independentDiscovery.refresh(service.id,body)).rejects.toThrow('获取过于频繁');
    expect(()=>s.independentDiscovery.import(service.id,{snapshotId:good.snapshot!.id,expectedConfigRevision:1,remoteModelIds:['m']})).toThrow('过期');
  });
  it('配置变化、停用、缺密钥、缺 Messages 版本在发请求前拒绝', async () => {
    const read=vi.fn(async()=>({json:{data:[]},digest:'fixture'}));const {s,service}=await setup(read,{authentication:'api_key'});
    await expect(s.independentDiscovery.refresh(service.id,body)).rejects.toThrow('尚未保存');expect(read).not.toHaveBeenCalled();
    const changed=await s.independent.patchService(service.id,{expectedRevision:1,baseUrl:'https://other.example/v1'});await expect(s.independentDiscovery.refresh(service.id,body)).rejects.toThrow('配置已变化');
    await s.independent.patchService(service.id,{expectedRevision:changed.revision,enabled:false});await expect(s.independentDiscovery.refresh(service.id,{...body,expectedConfigRevision:changed.configRevision})).rejects.toThrow('已停用');
  });
  it('在途配置变化或退出不落入当前预览，并发刷新不再发请求', async () => {
    let release!: ()=>void;const pending=new Promise<void>((r)=>release=r);const read=vi.fn(async()=>{await pending;return {json:{data:[{id:'m'}]},digest:'fixture'};});const {s,service}=await setup(read);
    const running=s.independentDiscovery.refresh(service.id,body);await vi.waitFor(()=>expect(read).toHaveBeenCalledOnce());await expect(s.independentDiscovery.refresh(service.id,body)).rejects.toThrow('正在获取');
    await s.independent.patchService(service.id,{expectedRevision:1,baseUrl:'https://other.example/v1'});release();await expect(running).rejects.toThrow('配置已变化');expect(s.independentDiscovery.state(service.id).snapshot).toBeNull();
  });
  it('导入规范化能力保留人工 false、名称、停用和默认；事务失败不留下部分模型或通知', async () => {
    const {s,service,t,token,route}=await setup(async()=>({json:{data:[{id:'m',max_input_tokens:900,max_tokens:100,capabilities:{image_input:{supported:true}}},{id:'n'}],has_more:false},digest:'fixture'}),{protocol:'anthropic_messages',apiVersion:'2026-10-21'});
    let old=s.independent.createModel(service.id,{remoteModelId:'m',name:'原名'});s.independent.setDefault({selection:{serviceId:service.id,modelId:old.id}});old=s.independent.overrides(service.id,old.id,{expectedRevision:old.revision,values:{imageInput:false}});old=s.independent.patchModel(service.id,old.id,{expectedRevision:old.revision,enabled:false});
    const state=await s.independentDiscovery.refresh(service.id,body);const input={snapshotId:state.snapshot!.id,expectedConfigRevision:1,remoteModelIds:['m','n']};
    const fail=vi.spyOn(s.independent,'recordEvidence').mockImplementation(()=>{throw new Error('故障');});expect(()=>s.independentDiscovery.import(service.id,{...input,remoteModelIds:['n','m']})).toThrow('故障');expect(s.independent.listModels(service.id)).toHaveLength(1);fail.mockRestore();
    const imported=await t.api('POST',route+'/models/import',{token,body:input});expect(imported.status).toBe(200);const model=imported.json.items[0]!;expect(model.name).toBe('原名');expect(model.enabled).toBe(false);expect(model.capabilities.find((c: {field:string;value:unknown})=>c.field==='imageInput')?.value).toBe(false);expect(model.capabilities.find((c: {field:string;value:unknown})=>c.field==='inputLimit')?.value).toBe(900);expect(s.independent.getDefault().selection?.modelId).toBe(old.id);
    expect(s.db.get('SELECT device_id FROM audit_log WHERE action=? ORDER BY rowid DESC LIMIT 1','independent.model.updated')!.device_id).toBeTypeOf('string');
    expect(()=>s.independentDiscovery.import(service.id,{...input,remoteModelIds:['missing']})).toThrow('不属于');
    const saved=JSON.parse(String(s.db.get('SELECT snapshot_json FROM independent_discoveries')!.snapshot_json));saved.expiresAt=1;s.db.run('UPDATE independent_discoveries SET snapshot_json=?',JSON.stringify(saved));expect(s.independentDiscovery.state(service.id).stale).toBe(true);expect(()=>s.independentDiscovery.import(service.id,input)).toThrow('过期');
  });
});
