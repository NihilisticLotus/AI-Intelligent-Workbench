import { describe, expect, it } from 'vitest';
import { CreateIndependentServiceBody, IndependentBaseUrl, IndependentService, IndependentCapabilityEvidence, IndependentCapabilityPatch, IndependentDefault, PatchIndependentServiceBody, EventEnvelope, DiscoverIndependentModelsBody, ImportIndependentModelsBody, IndependentDiscoveredModel, IndependentDiscoveryState, IndependentDiscoveryDiagnostics, IndependentDiscoverySnapshot } from './index';

const service = { name: '服务一', protocol: 'chat_completions', baseUrl: 'https://example.com/api/v1', authentication: 'api_key', apiVersion: null, providerId: null, plan: null, enabled: true };
const evidence = { id: 'e', field: 'imageInput', value: false, kind: 'endpoint', scope: { serviceId: 's', configRevision: 1, protocol: 'chat_completions', apiVersion: null, providerId: null, plan: null, remoteModelId: 'model' }, sourceUrl: 'https://example.com/api/v1/models', sourceVersion: 'fixture-v1', fieldPath: 'data.image', observedAt: 1, expiresAt: 2 };
describe('独立模型配置协议', () => {
  it('解析失败分类只追加可选字段，拒绝任意文本和错误阶段推断', () => {
    const old = {stage:'service_parse',serviceRequests:1,publicCatalogRequests:0,parsedPages:0,httpStatus:200};
    expect(IndependentDiscoveryDiagnostics.parse(old)).toEqual(old);
    for (const parseFailure of ['data_not_array','data_limit','duplicate_id','pagination_state','pagination_cursor'])
      expect(IndependentDiscoveryDiagnostics.parse({...old,parseFailure}).parseFailure).toBe(parseFailure);
    for (const change of [{parseFailure:'fixture-private-body'},{parseFailure:null},{parseFailure:{body:'fixture'}},{parseFailure:'data_not_array',stage:'service_request'},{parseFailure:'data_not_array',httpStatus:null},{parseFailure:'data_not_array',serviceRequests:0}])
      expect(IndependentDiscoveryDiagnostics.safeParse({...old,...change}).success).toBe(false);
  });
  it('识别范围只追加可选字段，旧请求与旧快照原样保留，已有模型允许零网络读取', () => {
    const body={expectedConfigRevision:1,includeCatalog:false};
    expect(DiscoverIndependentModelsBody.parse(body)).toEqual(body);
    expect(DiscoverIndependentModelsBody.parse({...body,source:'configured'}).source).toBe('configured');
    for(const source of ['automatic',null,1])expect(DiscoverIndependentModelsBody.safeParse({...body,source}).success).toBe(false);
    expect(DiscoverIndependentModelsBody.safeParse({...body,source:'configured',apiKey:'fixture'}).success).toBe(false);
    const old={id:'s',serviceId:'service',configRevision:1,items:[],skipped:0,pageCount:0,requestCount:0,fetchedAt:1,expiresAt:2,includeCatalog:false,notices:[]};
    expect(IndependentDiscoverySnapshot.parse(old)).toEqual(old);
    expect(IndependentDiscoverySnapshot.parse({...old,source:'configured'}).requestCount).toBe(0);
  });
  it('发现诊断可选且有界，不接受响应正文、任意阶段或秘密字段', () => {
    const old = {snapshot:null,stale:true,lastError:{message:'历史失败',at:1}};
    expect(IndependentDiscoveryState.parse(old)).toEqual(old);
    const diagnostics = {stage:'service_parse',serviceRequests:1,publicCatalogRequests:0,parsedPages:0,httpStatus:200};
    expect(IndependentDiscoveryState.parse({...old,lastError:{...old.lastError,diagnostics}}).lastError?.diagnostics).toEqual(diagnostics);
    for (const change of [{stage:'fixture-secret'},{serviceRequests:11},{publicCatalogRequests:2},{parsedPages:-1},{httpStatus:600},{body:'fixture-secret'},{headers:{Authorization:'fixture-secret'}}]) expect(IndependentDiscoveryDiagnostics.safeParse({...diagnostics,...change}).success).toBe(false);
  });
  it('发现请求须明确修订与公共目录选择，导入只接受快照身份和唯一勾选项', () => {
    expect(DiscoverIndependentModelsBody.safeParse({expectedConfigRevision:1}).success).toBe(false);
    expect(DiscoverIndependentModelsBody.parse({expectedConfigRevision:1,includeCatalog:false}).includeCatalog).toBe(false);
    for(const extra of [{remoteModelIds:[]},{remoteModelIds:['m','m']},{evidence:[]},{baseUrl:'https://evil.example'}])expect(ImportIndependentModelsBody.safeParse({snapshotId:'s',expectedConfigRevision:1,remoteModelIds:['m'],...extra}).success).toBe(false);
    expect(IndependentDiscoveredModel.safeParse({remoteModelId:'m',name:'模型',evidence:[],apiKey:'fixture-key'}).success).toBe(false);
  });
  it('配置写入和读取分离，精确值不转换，修订必须明确', () => {
    expect(CreateIndependentServiceBody.parse({ ...service, apiKey: 'fixture-private-value' }).name).toBe('服务一');
    expect(IndependentService.safeParse({ ...service, id: 's', revision: 1, configRevision: 1, hasSecret: true, secretHint: 'alue', createdAt: 1, updatedAt: 1, apiKey: 'fixture-private-value' }).success).toBe(false);
    expect(PatchIndependentServiceBody.safeParse({ name: '名称' }).success).toBe(false);
    expect(PatchIndependentServiceBody.safeParse({ expectedRevision: '1' }).success).toBe(false);
  });
  it('地址拒绝内嵌认证、查询、片段、远端 HTTP 与协议混淆', () => {
    for (const url of ['https://user:pass@example.com', 'https://example.com?key=fixture', 'https://example.com#fragment', 'http://example.com', 'file:///tmp', 'https://example.com\\path']) expect(IndependentBaseUrl.safeParse(url).success).toBe(false);
    for (const url of ['https://example.com/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:1234/v1']) expect(IndependentBaseUrl.parse(url)).toBe(url);
  });
  it('保留人工 false 和恢复自动 null，按字段校验证据类型与范围', () => {
    expect(IndependentCapabilityPatch.parse({ imageInput: false, contextWindow: null })).toEqual({ imageInput: false, contextWindow: null });
    expect(IndependentCapabilityEvidence.parse(evidence).value).toBe(false);
    for (const change of [{ value: 'false' }, { field: 'contextWindow', value: 0 }, { field: 'effortLevels', value: ['high', 'high'] }, { expiresAt: 0 }, { scope: { ...evidence.scope, configRevision: 0 } }]) expect(IndependentCapabilityEvidence.safeParse({ ...evidence, ...change }).success).toBe(false);
  });
  it('默认选择明确包含服务和本地模型身份，可清空且不隐式补值', () => {
    expect(IndependentDefault.parse({ selection: null })).toEqual({ selection: null });
    expect(IndependentDefault.parse({ selection: { serviceId: 's', modelId: 'm' } }).selection?.serviceId).toBe('s');
    expect(IndependentDefault.safeParse({ selection: { modelId: 'm' } }).success).toBe(false);
  });
  it('目录变化事件只允许身份，不携带密钥或目录正文', () => {
    const event = { seq: 1, ts: 1, taskId: null, sessionId: null, type: 'independent.catalog_changed', data: { scope: 'service', action: 'created', serviceId: 's', modelId: null } };
    expect(EventEnvelope.parse(event)).toEqual(event);
    expect(EventEnvelope.safeParse({ ...event, data: { ...event.data, apiKey: 'fixture-private-value' } }).success).toBe(false);
  });
});
