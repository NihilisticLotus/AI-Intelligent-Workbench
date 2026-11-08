import {
  CreateIndependentModelBody, IndependentCapabilityEvidence, IndependentCapabilityValues,
  type IndependentCapabilityField, type IndependentDiscoveredModel, type IndependentService,
  type IndependentDiscoveryParseFailure, type IndependentDiscoveryRootShape,
} from '@aic/protocol';
import { capabilityScope } from './capabilities';

export const objectOf = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
/** 只携带本地校验分类；不把服务返回的值、字段名或错误正文带出解析器。 */
export class MetadataParseError extends Error {
  constructor(readonly reason: IndependentDiscoveryParseFailure, readonly rootShape?: IndependentDiscoveryRootShape) {
    super({data_not_array:'未知模型列表结构',data_limit:'未知模型列表结构',duplicate_id:'模型列表包含重复 ID',pagination_state:'Messages 模型列表缺少分页状态',pagination_cursor:'Messages 分页游标不正确'}[reason]);
    this.name = 'MetadataParseError';
  }
}
const kindOf = (v: unknown) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'null';
/**
 * 列表结构不符时只记 JSON 形状（ISSUE-0029）：根类型、data 类型、顶层键数量、有没有常见错误标记。
 * 不记任何键名、值或正文，因此不能据此判断供应商的具体错误或认证状态。
 */
export function rootShapeOf(raw: unknown): IndependentDiscoveryRootShape {
  const root = kindOf(raw) as IndependentDiscoveryRootShape['root'];
  if (root !== 'object') return { root, data: null, errorMarker: null, topLevelKeys: null };
  const o = raw as Record<string, unknown>; const keys = Object.keys(o);
  // 只在 data 不是数组时调用（data_not_array），所以这里不会出现 array
  const data = !Object.prototype.hasOwnProperty.call(o, 'data') ? 'missing' : kindOf(o.data);
  return { root, data: data as NonNullable<IndependentDiscoveryRootShape['data']>,
    errorMarker: ['error', 'code', 'msg', 'message'].some((k) => Object.prototype.hasOwnProperty.call(o, k)), topLevelKeys: Math.min(keys.length, 10_000) };
}
const atPath = (value: unknown, path: string) => path.split('.').reduce<unknown>((v, key) => objectOf(v)[key], value);
export function evidenceBuilder(service: IndependentService, modelId: string, sourceUrl: string, version: string, at: number, kind: 'endpoint' | 'catalog' | 'official' = 'endpoint') {
  // 证据 URL 沿用既有无查询协议；分页参数不属于能力来源身份，实际固定目录参数由解析器版本限定。
  const source = new URL(sourceUrl); source.search = '';
  const evidence: IndependentCapabilityEvidence[] = [];
  const add = (field: IndependentCapabilityField, value: unknown, fieldPath: string) => {
    if (value === null || value === undefined || !IndependentCapabilityValues.shape[field].safeParse(value).success) return;
    const parsed = IndependentCapabilityEvidence.safeParse({ id: `pending-${evidence.length}`, field, value, kind, scope: capabilityScope(service, modelId), sourceUrl:source.href,
      sourceVersion: version, fieldPath, observedAt: at, expiresAt: at + 24 * 60 * 60 * 1000 });
    if (parsed.success) evidence.push(parsed.data);
  };
  const modalities = (value: unknown, field: 'inputModalities' | 'outputModalities', fieldPath: string) => {
    if (!IndependentCapabilityValues.shape[field].safeParse(value).success || value === null) return;
    add(field, value, fieldPath);
    if (field === 'inputModalities') add('imageInput', (value as string[]).some((v) => v === 'image' || v.startsWith('image/')), fieldPath);
  };
  return { evidence, add, modalities };
}

export const MODEL_CATALOG_URL = 'https://models.dev/experimental/v2.0/api.json?type=chat';
/** 实验目录无版本号，固定本地解析器并把响应摘要记入来源；地址永不参与请求路由。 */
export function supplementCatalog(service: IndependentService, items: IndependentDiscoveredModel[], raw: unknown, digest: string, at = Date.now()) {
  const providerId = service.providerId;
  if (!providerId || service.plan !== null || service.apiVersion !== null) return ['公共目录无法核对服务商、套餐或独立 API 版本，未套用其能力'];
  const provider = objectOf(objectOf(raw)[providerId]); const models = objectOf(provider.models);
  if (provider.id !== providerId || !Object.keys(models).length) return ['公共目录未找到精确服务商结构，未套用其能力'];
  const protocol = {chat_completions:'chat-completions',responses:'responses',anthropic_messages:'messages'}[service.protocol];
  let matched = 0;
  const canonical = (value: unknown) => { try { return typeof value === 'string' ? new URL(value).href.replace(/\/$/,'') : null; } catch { return null; } };
  for (const item of items) {
    const model = objectOf(models[item.remoteModelId]); const api = objectOf(objectOf(model.api)[protocol]);
    if (model.id !== item.remoteModelId || typeof api.base_url !== 'string' || api.path != null || api.base_url.includes('{') || canonical(api.base_url) !== canonical(service.baseUrl)) continue;
    matched++; const b = evidenceBuilder(service,item.remoteModelId,MODEL_CATALOG_URL,`models-dev-v2-parser-1:${digest}`,at,'catalog');
    const limit = objectOf(model.limit); const caps = objectOf(model.capabilities); const reasoning = objectOf(caps.reasoning);
    b.add('contextWindow',limit.context,'limit.context'); b.add('inputLimit',limit.input,'limit.input'); b.add('outputLimit',limit.output,'limit.output');
    b.modalities(objectOf(model.modalities).input,'inputModalities','modalities.input'); b.modalities(objectOf(model.modalities).output,'outputModalities','modalities.output');
    b.add('tools',objectOf(caps.tools).supported,'capabilities.tools.supported');
    b.add('structuredOutput',caps.structured_output,'capabilities.structured_output'); b.add('streamUsage',caps.stream_usage,'capabilities.stream_usage');
    b.add('thinking',reasoning.supported,'capabilities.reasoning.supported');
    // toggle 的可关闭语义、budget 的单位尚未核实，不把目录开关和数字猜成执行参数。
    b.add('effortLevels',reasoning.effort,'capabilities.reasoning.effort');
    const initial = objectOf(reasoning.default);
    if (initial.type === 'effort' && Array.isArray(reasoning.effort) && reasoning.effort.includes(initial.value)) b.add('defaultEffort',initial.value,'capabilities.reasoning.default.value');
    item.evidence.push(...b.evidence);
  }
  return matched ? [`公共目录精确匹配 ${matched} 个模型；目录声明未经实际能力验证`] : ['公共目录无精确的模型、协议和基础地址匹配，能力保持未知'];
}

/** 已知传输不等于已知元数据扩展；OpenAI 兼容仅保证读取 ID。 */
export function parseEndpointPage(service: IndependentService, raw: unknown, sourceUrl: string, digest: string, at = Date.now()) {
  const root = objectOf(raw);
  if (!Array.isArray(root.data)) throw new MetadataParseError('data_not_array', rootShapeOf(raw));
  if (root.data.length > 10_000) throw new MetadataParseError('data_limit');
  const url = new URL(service.baseUrl);
  const deepseek = service.protocol === 'chat_completions' && url.origin === 'https://api.deepseek.com' && ['/', '/v1', '/v1/'].includes(url.pathname);
  const openrouter = service.protocol === 'chat_completions' && url.origin === 'https://openrouter.ai' && ['/api/v1','/api/v1/'].includes(url.pathname);
  const anthropic = service.protocol === 'anthropic_messages';
  const knownAnthropic = anthropic && service.apiVersion === '2026-10-21';
  let skipped = 0; const items: IndependentDiscoveredModel[] = []; const seen = new Set<string>();
  for (const row of root.data) {
    const r = objectOf(row); const id = r.id;
    const parsed = CreateIndependentModelBody.safeParse({ remoteModelId: id, name: typeof (r.display_name ?? r.name) === 'string' ? String(r.display_name ?? r.name).slice(0,100) : typeof id === 'string' ? id.slice(0,100) : '' });
    if (!parsed.success || typeof id !== 'string' || /[\x00-\x1f\x7f]/.test(id)) { skipped++; continue; }
    if (seen.has(id)) throw new MetadataParseError('duplicate_id'); seen.add(id);
    const b = evidenceBuilder(service, id, sourceUrl, `endpoint-v1:${digest}`, at);
    if (knownAnthropic) {
      b.add('inputLimit', r.max_input_tokens, 'max_input_tokens'); b.add('outputLimit', r.max_tokens, 'max_tokens');
      for (const [field, path] of [['imageInput','image_input.supported'],['structuredOutput','structured_outputs.supported'],['thinking','thinking.supported'],['thinkingCanDisable','thinking.types.disabled.supported']] as const) b.add(field, atPath(r.capabilities, path), `capabilities.${path}`);
      const effort = objectOf(objectOf(r.capabilities).effort); const levels = ['low','medium','high','xhigh','max'];
      // 只有全部档位的显式布尔声明齐全，才把它当作完整可选列表。
      if (levels.every((level) => typeof objectOf(effort[level]).supported === 'boolean')) b.add('effortLevels', levels.filter((level) => objectOf(effort[level]).supported === true), 'capabilities.effort');
    } else if (deepseek) {
      b.add('contextWindow', r.context_window, 'context_window'); b.add('outputLimit', r.max_output_tokens, 'max_output_tokens');
      b.modalities(r.input_modalities, 'inputModalities', 'input_modalities'); b.modalities(r.output_modalities, 'outputModalities', 'output_modalities');
      const effort = objectOf(r.effort); b.add('effortLevels', effort.supported_levels, 'effort.supported_levels');
      if (Array.isArray(effort.supported_levels) && effort.supported_levels.includes(effort.default_level)) b.add('defaultEffort', effort.default_level, 'effort.default_level');
    } else if (openrouter) {
      b.add('contextWindow', r.context_length, 'context_length');
      b.modalities(objectOf(r.architecture).input_modalities, 'inputModalities', 'architecture.input_modalities');
      b.modalities(objectOf(r.architecture).output_modalities, 'outputModalities', 'architecture.output_modalities');
      // 聚合模型顶层声明可记录；top_provider 不是当前账户实际选中端点，不照搬其限制。
      if (Array.isArray(r.supported_parameters) && r.supported_parameters.includes('tools')) b.add('tools', true, 'supported_parameters');
    }
    items.push({ ...parsed.data, evidence: b.evidence });
  }
  if (anthropic && typeof root.has_more !== 'boolean') throw new MetadataParseError('pagination_state');
  const next = anthropic && root.has_more === true ? root.last_id : null;
  if (anthropic && root.has_more === true && (typeof next !== 'string' || !next || next.length > 200 || /[\x00-\x1f\x7f]/.test(next))) throw new MetadataParseError('pagination_cursor');
  // 非标准分页不能静默声称发现完整；保留本页并明确提示。
  const notices = !anthropic && (root.has_more === true || root.next !== undefined || root.next_cursor !== undefined) ? ['服务返回未识别的分页字段，仅预览本页；未抓取远端链接'] : [];
  if (anthropic && !knownAnthropic) notices.push('当前 API 版本未接入能力解析，仅识别模型 ID 与名称');
  return { items, skipped, next: next as string | null, notices };
}
