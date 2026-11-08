// 工作台自有目录：只保存显式配置，元数据入口仅供内部适配器使用，不访问上游或第三方配置。
import { createHash } from 'node:crypto';
import {
  CreateIndependentServiceBody, PatchIndependentServiceBody, IndependentService, IndependentModel,
  CreateIndependentModelBody, PatchIndependentModelBody, PatchIndependentOverridesBody,
  IndependentCapabilityEvidence, IndependentDefault, IndependentNetworkSettings, IndependentModelBinding,
  type IndependentSelection, type EventOf,
} from '@aic/protocol';
import type { Db, Row } from '../db';
import type { EventStore } from '../events';
import type { SecretService } from '../secrets';
import { AppError, Errors, newId, now } from '../util';
import { capabilityScope, resolveCapabilities, sameCapabilityScope } from './capabilities';

const DEFAULT_KEY = 'independent.default';
const NETWORK_KEY = 'independent.network';
const serviceConfig = (s: Omit<CreateIndependentServiceBody, 'apiKey'>) => ({ name: s.name, protocol: s.protocol, baseUrl: s.baseUrl,
  authentication: s.authentication, apiVersion: s.apiVersion, providerId: s.providerId, plan: s.plan, enabled: s.enabled });

export class IndependentCatalog {
  constructor(private db: Db, private secrets: SecretService, private events: EventStore) {}

  private change<T>(data: EventOf<'independent.catalog_changed'>['data'], operation: () => T, deviceId: string | null = null): T {
    return this.db.tx(() => {
      const value = operation();
      const event = this.events.persist({ type: 'independent.catalog_changed', taskId: null, sessionId: null, data });
      this.db.afterCommit(() => this.events.bus.emit(event));
      this.db.run('INSERT INTO audit_log(device_id,action,detail,ts) VALUES (?,?,?,?)', deviceId, `independent.${data.scope}.${data.action}`, JSON.stringify({ serviceId: data.serviceId, modelId: data.modelId }), now());
      return value;
    });
  }

  private row(id: string) {
    const row = this.db.get('SELECT * FROM independent_services WHERE id = ?', id);
    if (!row) throw Errors.notFound('找不到这个 API 服务');
    return row;
  }
  getService(id: string): IndependentService {
    const r = this.row(id);
    return IndependentService.parse({ ...JSON.parse(String(r.config_json)), id: r.id, revision: r.revision, configRevision: r.config_revision,
      hasSecret: !!r.secret_id, secretHint: this.secrets.hint(r.secret_id as string | null), createdAt: r.created_at, updatedAt: r.updated_at });
  }
  listServices(): IndependentService[] { return this.db.all('SELECT id FROM independent_services ORDER BY created_at,id').map((r) => this.getService(String(r.id))); }
  private expectRevision(actual: number, expected: number) { if (actual !== expected) throw Errors.conflict('配置已在其他操作中改变，请刷新后重试'); }
  private async saveSecret(key: string): Promise<string> {
    try { return (await this.secrets.save(key)).id; }
    catch { throw Errors.secretUnavailable('密钥保存失败，请重新填写或检查本机安全存储'); }
  }

  async createService(input: CreateIndependentServiceBody, deviceId: string | null = null): Promise<IndependentService> {
    const body = CreateIndependentServiceBody.parse(input);
    if (body.authentication === 'none' && body.apiKey !== undefined) throw Errors.badRequest('无认证服务不能同时保存密钥');
    const secretId = body.apiKey ? await this.saveSecret(body.apiKey) : null;
    const id = newId('isv');
    try {
      return this.change({ scope: 'service', action: 'created', serviceId: id, modelId: null }, () => {
        if (this.listServices().length >= 100) throw Errors.badRequest('最多保存 100 个 API 服务');
        const at = now();
        this.db.run('INSERT INTO independent_services(id,config_json,revision,config_revision,secret_id,created_at,updated_at) VALUES (?,?,1,1,?,?,?)', id, JSON.stringify(serviceConfig(body)), secretId, at, at);
        return this.getService(id);
      }, deviceId);
    } catch (error) {
      this.secrets.delete(secretId);
      if (error instanceof AppError) throw error;
      throw Errors.internal('API 服务保存失败');
    }
  }

  async patchService(id: string, input: PatchIndependentServiceBody, deviceId: string | null = null): Promise<IndependentService> {
    const body = PatchIndependentServiceBody.parse(input); const before = this.getService(id);
    this.expectRevision(before.revision, body.expectedRevision);
    const config = serviceConfig({ ...before, ...body });
    if (config.authentication === 'none' && body.apiKey != null) throw Errors.badRequest('无认证服务不能同时保存密钥');
    const newSecret = body.apiKey ? await this.saveSecret(body.apiKey) : null;
    try {
      return this.change({ scope: 'service', action: 'updated', serviceId: id, modelId: null }, () => {
        const old = this.getService(id); this.expectRevision(old.revision, body.expectedRevision);
        const row = this.row(id); const previousSecret = row.secret_id as string | null;
        const secretId = config.authentication === 'none' || body.apiKey === null ? null : newSecret ?? previousSecret;
        const connectionChanged = body.apiKey !== undefined || ['protocol', 'baseUrl', 'authentication', 'apiVersion', 'providerId', 'plan'].some((key) => config[key as keyof typeof config] !== old[key as keyof typeof config]);
        this.db.run('UPDATE independent_services SET config_json=?,revision=revision+1,config_revision=config_revision+?,secret_id=?,updated_at=? WHERE id=?', JSON.stringify(config), connectionChanged ? 1 : 0, secretId, now(), id);
        if (previousSecret !== secretId) this.secrets.delete(previousSecret);
        return this.getService(id);
      }, deviceId);
    } catch (error) {
      this.secrets.delete(newSecret);
      if (error instanceof AppError) throw error;
      throw Errors.internal('API 服务修改失败');
    }
  }

  private modelRow(serviceId: string, id: string): Row {
    this.row(serviceId);
    const row = this.db.get('SELECT * FROM independent_models WHERE id=? AND service_id=?', id, serviceId);
    if (!row) throw Errors.notFound('这个服务中没有该模型');
    return row;
  }
  getModel(serviceId: string, id: string): IndependentModel {
    const row = this.modelRow(serviceId, id); const service = this.getService(serviceId);
    const evidence = IndependentCapabilityEvidence.array().parse(JSON.parse(String(row.evidence_json)));
    return IndependentModel.parse({ id: row.id, serviceId, remoteModelId: row.remote_model_id, name: row.name, enabled: !!row.enabled,
      revision: row.revision, evidence, capabilities: resolveCapabilities(evidence, capabilityScope(service, String(row.remote_model_id))), createdAt: row.created_at, updatedAt: row.updated_at });
  }
  listModels(serviceId: string): IndependentModel[] {
    this.row(serviceId);
    return this.db.all('SELECT id FROM independent_models WHERE service_id=? ORDER BY created_at,id', serviceId).map((r) => this.getModel(serviceId, String(r.id)));
  }
  createModel(serviceId: string, input: CreateIndependentModelBody, deviceId: string | null = null): IndependentModel {
    const body = CreateIndependentModelBody.parse(input); this.row(serviceId);
    const old = this.db.get('SELECT id FROM independent_models WHERE service_id=? AND remote_model_id=?', serviceId, body.remoteModelId);
    if (old) return this.getModel(serviceId, String(old.id));
    const id = newId('imd');
    return this.change({ scope: 'model', action: 'created', serviceId, modelId: id }, () => {
      if (Number(this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM independent_models WHERE service_id=?', serviceId)?.count) >= 500) throw Errors.badRequest('每个服务最多保存 500 个模型');
      const at = now();
      this.db.run('INSERT INTO independent_models(id,service_id,remote_model_id,name,revision,created_at,updated_at) VALUES (?,?,?,?,1,?,?)', id, serviceId, body.remoteModelId, body.name, at, at);
      return this.getModel(serviceId, id);
    }, deviceId);
  }
  patchModel(serviceId: string, id: string, input: PatchIndependentModelBody, deviceId: string | null = null): IndependentModel {
    const body = PatchIndependentModelBody.parse(input);
    return this.change({ scope: 'model', action: 'updated', serviceId, modelId: id }, () => {
      const old = this.getModel(serviceId, id); this.expectRevision(old.revision, body.expectedRevision);
      this.db.run('UPDATE independent_models SET name=?,enabled=?,revision=revision+1,updated_at=? WHERE id=?', body.name ?? old.name, (body.enabled ?? old.enabled) ? 1 : 0, now(), id);
      return this.getModel(serviceId, id);
    }, deviceId);
  }
  private saveEvidence(serviceId: string, id: string, evidence: IndependentCapabilityEvidence[]): IndependentModel {
    for (const field of new Set(evidence.map((e) => e.field))) if (evidence.filter((e) => e.field === field).length > 16) throw Errors.badRequest('单字段来源超过 16 个，请先核对旧来源');
    this.db.run('UPDATE independent_models SET evidence_json=?,revision=revision+1,updated_at=? WHERE id=?', JSON.stringify(evidence), now(), id);
    return this.getModel(serviceId, id);
  }
  overrides(serviceId: string, id: string, input: PatchIndependentOverridesBody, deviceId: string | null = null): IndependentModel {
    const body = PatchIndependentOverridesBody.parse(input);
    return this.change({ scope: 'model', action: 'updated', serviceId, modelId: id }, () => {
      const model = this.getModel(serviceId, id); this.expectRevision(model.revision, body.expectedRevision);
      const fields = Object.keys(body.values); const kept = model.evidence.filter((e) => e.kind !== 'manual' || !fields.includes(e.field));
      const service = this.getService(serviceId);
      if (body.expectedConfigRevision !== undefined) this.expectRevision(service.configRevision, body.expectedConfigRevision);
      const scope = capabilityScope(service, model.remoteModelId);
      for (const [field, value] of Object.entries(body.values)) if (value !== null && value !== undefined) kept.push(IndependentCapabilityEvidence.parse({ id: newId('ice'), field, value, kind: 'manual', scope, sourceUrl: null, sourceVersion: 'manual-v1', fieldPath: field, observedAt: now(), expiresAt: null }));
      return this.saveEvidence(serviceId, id, kept);
    }, deviceId);
  }

  /** 内部元数据接缝：不公开写入路由，不允许把客户端值冒充接口声明。 */
  recordEvidence(serviceId: string, id: string, input: IndependentCapabilityEvidence[], deviceId: string | null = null): IndependentModel {
    const incoming = IndependentCapabilityEvidence.array().max(256).parse(input);
    return this.change({ scope: 'model', action: 'updated', serviceId, modelId: id }, () => {
      const model = this.getModel(serviceId, id); const scope = capabilityScope(this.getService(serviceId), model.remoteModelId);
      const merged = new Map(model.evidence.map((e) => [e.id, e]));
      for (const e of incoming) {
        if (e.kind === 'manual' || !e.sourceUrl || !sameCapabilityScope(e.scope, scope) || e.observedAt > now() + 300_000) throw Errors.badRequest('元数据来源或适用范围不一致');
        if (e.value === null) continue;
        const fingerprint = JSON.stringify({ field: e.field, kind: e.kind, sourceUrl: e.sourceUrl, fieldPath: e.fieldPath, scope });
        const evidenceId = `ice_${createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)}`;
        merged.set(evidenceId, { ...e, id: evidenceId });
      }
      return this.saveEvidence(serviceId, id, [...merged.values()]);
    }, deviceId);
  }

  /** 网络设置（ISSUE-0053）：默认不放行 fake-ip 网段；读取失败或旧库没有这一项时按关闭处理 */
  getNetwork(): IndependentNetworkSettings {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', NETWORK_KEY);
    const parsed = row ? IndependentNetworkSettings.safeParse((() => { try { return JSON.parse(row.value); } catch { return null; } })()) : null;
    return parsed?.success ? parsed.data : { allowFakeIpProxy: false };
  }
  setNetwork(input: IndependentNetworkSettings, deviceId: string | null = null): IndependentNetworkSettings {
    const body = IndependentNetworkSettings.parse(input);
    return this.change({ scope: 'network', action: 'updated', serviceId: null, modelId: null }, () => {
      this.db.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', NETWORK_KEY, JSON.stringify(body));
      return body;
    }, deviceId);
  }

  getDefault(): IndependentDefault {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key=?', DEFAULT_KEY);
    return IndependentDefault.parse(row ? JSON.parse(row.value) : { selection: null });
  }
  private usable(selection: IndependentSelection) {
    const service = this.getService(selection.serviceId); const model = this.getModel(service.id, selection.modelId);
    if (!service.enabled || !model.enabled) throw Errors.invalidState('所选服务或模型已停用');
    return { service, model };
  }
  setDefault(input: IndependentDefault, deviceId: string | null = null): IndependentDefault {
    const body = IndependentDefault.parse(input);
    return this.change({ scope: 'default', action: 'updated', serviceId: body.selection?.serviceId ?? null, modelId: body.selection?.modelId ?? null }, () => {
      if (body.selection) this.usable(body.selection);
      this.db.run('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', DEFAULT_KEY, JSON.stringify(body));
      return body;
    }, deviceId);
  }
  private clearDefault(serviceId: string, modelId?: string) {
    const selection = this.getDefault().selection;
    if (selection?.serviceId === serviceId && (!modelId || selection.modelId === modelId)) this.db.run('DELETE FROM meta WHERE key=?', DEFAULT_KEY);
  }
  deleteModel(serviceId: string, id: string, deviceId: string | null = null): void {
    this.change({ scope: 'model', action: 'deleted', serviceId, modelId: id }, () => {
      this.modelRow(serviceId, id);
      if (this.db.get('SELECT task_id FROM independent_task_models WHERE model_id=? LIMIT 1', id)) throw Errors.conflict('模型仍关联任务，请先处理关联任务');
      this.clearDefault(serviceId, id); this.db.run('DELETE FROM independent_models WHERE id=?', id);
    }, deviceId);
  }
  deleteService(id: string, deviceId: string | null = null): void {
    this.change({ scope: 'service', action: 'deleted', serviceId: id, modelId: null }, () => {
      const row = this.row(id);
      if (this.db.get('SELECT task_id FROM independent_task_models WHERE service_id=? LIMIT 1', id)) throw Errors.conflict('服务仍关联任务，请先处理关联任务');
      this.clearDefault(id); this.db.run('DELETE FROM independent_services WHERE id=?', id); this.secrets.delete(row.secret_id as string | null);
    }, deviceId);
  }
  /** 正式任务接入前的内部绑定接口；不允许旧绑定被默认值或重发悄悄替换。 */
  bind(taskId: string, selection: IndependentSelection): IndependentModelBinding {
    return this.db.tx(() => {
      if (!this.db.get('SELECT id FROM tasks WHERE id=?', taskId)) throw Errors.notFound('找不到任务');
      const { service, model } = this.usable(selection);
      const old = this.db.get('SELECT * FROM independent_task_models WHERE task_id=?', taskId);
      if (old) {
        if (old.service_id !== service.id || old.model_id !== model.id) throw Errors.conflict('任务已有其他模型绑定，需要明确切换');
        return this.bound(taskId);
      }
      this.db.run('INSERT INTO independent_task_models(task_id,service_id,model_id,config_revision,model_revision,created_at) VALUES (?,?,?,?,?,?)', taskId, service.id, model.id, service.configRevision, model.revision, now());
      return this.bound(taskId);
    });
  }
  bound(taskId: string): IndependentModelBinding {
    const row = this.db.get('SELECT * FROM independent_task_models WHERE task_id=?', taskId);
    if (!row) throw Errors.notFound('任务尚未选择独立模型');
    const { service, model } = this.usable({ serviceId: String(row.service_id), modelId: String(row.model_id) });
    if (service.configRevision !== row.config_revision || model.revision !== row.model_revision) throw Errors.conflict('任务所选配置已修订，请核对后明确继续');
    return IndependentModelBinding.parse({ taskId, serviceId: service.id, modelId: model.id, configRevision: row.config_revision, modelRevision: row.model_revision, createdAt: row.created_at });
  }
  /** 用户在空闲任务明确核对后使用；事务内核对旧快照，不借默认值换服务。 */
  rebind(taskId: string, selection: IndependentSelection, expected: IndependentModelBinding): IndependentModelBinding {
    return this.db.tx(() => {
      const old = this.db.get('SELECT * FROM independent_task_models WHERE task_id=?', taskId);
      if (!old || old.service_id !== expected.serviceId || old.model_id !== expected.modelId || old.config_revision !== expected.configRevision
        || old.model_revision !== expected.modelRevision || old.created_at !== expected.createdAt || expected.taskId !== taskId) throw Errors.conflict('任务绑定已变化，请重新核对');
      const { service, model } = this.usable(selection);
      // 仅调整任务控制值时保持同一绑定，不能仅因保存时间变化使私有续传失效。
      if (old.service_id === service.id && old.model_id === model.id && old.config_revision === service.configRevision
        && old.model_revision === model.revision) return this.bound(taskId);
      this.db.run('UPDATE independent_task_models SET service_id=?,model_id=?,config_revision=?,model_revision=?,created_at=? WHERE task_id=?',
        service.id, model.id, service.configRevision, model.revision, now(), taskId);
      return this.bound(taskId);
    });
  }

  /** 仅发现服务内部使用；没有公开读取密钥的路由，不从进程环境或其他服务兜底。 */
  async discoveryCredentials(serviceId: string, expectedConfigRevision: number) {
    const check = () => { const s = this.getService(serviceId); this.expectRevision(s.configRevision, expectedConfigRevision); if (!s.enabled) throw Errors.invalidState('所选 API 服务已停用'); return s; };
    const service = check(); const secretId = this.row(serviceId).secret_id as string | null;
    let key: string | null;
    try { key = service.authentication === 'none' ? null : secretId ? await this.secrets.read(secretId) : null; }
    catch { throw Errors.secretUnavailable('这个 API 服务的密钥无法读取'); }
    check();
    if (service.authentication === 'api_key' && !key) throw Errors.secretUnavailable('这个 API 服务尚未保存可用密钥');
    return { service, key };
  }

  /** 仅按任务固定绑定读取运行凭据。 */
  async credentials(taskId: string) {
    const binding = this.bound(taskId); const { service, model } = this.usable(binding);
    const secretId = this.row(service.id).secret_id as string | null;
    const key = service.authentication === 'none' ? null : secretId ? await this.secrets.read(secretId) : null;
    if (service.authentication === 'api_key' && !key) throw Errors.secretUnavailable('这个 API 服务尚未保存可用密钥');
    this.bound(taskId);
    return { service, model, key };
  }
}
