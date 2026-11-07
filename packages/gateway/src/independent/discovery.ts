// 发现只读取元数据；预览与导入分开，任何目录内容都不能更改请求目标。
import {
  DiscoverIndependentModelsBody, IndependentDiscoveryState, IndependentDiscoverySnapshot, ImportIndependentModelsBody,
  ErrorCode, type IndependentDiscoveredModel,
} from '@aic/protocol';
import type { Db } from '../db';
import { AppError, Errors, newId } from '../util';
import type { IndependentCatalog } from './catalog';
import { MetadataHttpError, readMetadataJson } from './metadata-http';
import { MODEL_CATALOG_URL, parseEndpointPage, supplementCatalog } from './metadata-parser';

export class IndependentDiscovery {
  private running = new Map<string,AbortController>(); private closed = false;
  constructor(private db: Db, private catalog: IndependentCatalog, private read = readMetadataJson) {}
  close() { this.closed = true; for (const controller of this.running.values()) controller.abort(); }
  state(serviceId: string): IndependentDiscoveryState {
    const service = this.catalog.getService(serviceId);
    const row = this.db.get('SELECT * FROM independent_discoveries WHERE service_id=?',serviceId);
    const snapshot = row?.snapshot_json ? IndependentDiscoverySnapshot.parse(JSON.parse(String(row.snapshot_json))) : null;
    const lastError = row?.last_error_json ? JSON.parse(String(row.last_error_json)) : null;
    return IndependentDiscoveryState.parse({snapshot,lastError,stale:!snapshot || snapshot.configRevision !== service.configRevision || snapshot.expiresAt <= Date.now() || !!lastError});
  }
  private check(serviceId: string, revision: number) {
    if (this.closed) throw Errors.invalidState('服务正在退出，发现已取消');
    const service = this.catalog.getService(serviceId);
    if (service.configRevision !== revision) throw Errors.conflict('服务配置已变化，请重新获取模型预览');
    if (!service.enabled) throw Errors.invalidState('所选 API 服务已停用'); return service;
  }
  async refresh(serviceId: string, input: DiscoverIndependentModelsBody): Promise<IndependentDiscoveryState> {
    const body = DiscoverIndependentModelsBody.parse(input); const service = this.check(serviceId,body.expectedConfigRevision);
    if (this.running.has(serviceId)) throw Errors.conflict('这个服务正在获取模型，请等待完成');
    const row = this.db.get('SELECT attempted_at,last_error_json FROM independent_discoveries WHERE service_id=?',serviceId);
    if (row && Date.now() - Number(row.attempted_at) < (row.last_error_json ? 30_000 : 10_000)) throw Errors.rateLimited('获取过于频繁，请稍后重试');
    const controller = new AbortController(); this.running.set(serviceId,controller);
    const timer = setTimeout(() => controller.abort(),30_000); timer.unref();
    try {
      this.db.run('INSERT INTO independent_discoveries(service_id,attempted_at) VALUES (?,?) ON CONFLICT(service_id) DO UPDATE SET attempted_at=excluded.attempted_at',serviceId,Date.now());
      const {key} = await this.catalog.discoveryCredentials(serviceId,body.expectedConfigRevision);
      const base = new URL(service.baseUrl); const url = new URL(`${base.href.replace(/\/$/,'')}/models`);
      const headers: Record<string,string> = {};
      if (service.protocol === 'anthropic_messages') {
        if (!service.apiVersion || !/^\d{4}-\d{2}-\d{2}$/.test(service.apiVersion)) throw Errors.badRequest('Messages 发现需要明确填写日期格式的 API 版本');
        headers['anthropic-version'] = service.apiVersion; if(key) headers['x-api-key'] = key;
        url.searchParams.set('limit','100');
      } else if (key) headers.Authorization = `Bearer ${key}`;
      const items: IndependentDiscoveredModel[] = []; const notices: string[] = []; const ids = new Set<string>(); const cursors = new Set<string>();
      let skipped = 0; let pageCount = 0; let requestCount = 0;
      for (;;) {
        this.check(serviceId,body.expectedConfigRevision); if(controller.signal.aborted) throw new MetadataHttpError('元数据读取已取消或超时');
        requestCount++; const result = await this.read({url:new URL(url),base,publicCatalog:false,headers,signal:controller.signal});
        const page = parseEndpointPage(service,result.json,url.href,result.digest); pageCount++; skipped += page.skipped; notices.push(...page.notices);
        for (const item of page.items) {
          if (ids.has(item.remoteModelId)) throw new MetadataHttpError('模型分页重复 ID，未保存本次预览'); ids.add(item.remoteModelId);
          if (items.length < 500) items.push(item); else skipped++;
        }
        if (!page.next) break;
        if (cursors.has(page.next)) throw new MetadataHttpError('模型分页游标重复，未保存本次预览'); cursors.add(page.next);
        if (pageCount >= 10 || items.length >= 500) {notices.push('已达到 10 页或 500 个模型的预览上限，列表可能不完整');break;}
        url.searchParams.set('after_id',page.next);
      }
      if (skipped) notices.push(`有 ${skipped} 个条目无效或超过上限，未加入预览`);
      if (body.includeCatalog) {
        this.check(serviceId,body.expectedConfigRevision);
        if (controller.signal.aborted) throw new MetadataHttpError('元数据读取已取消或超时');
        try {
          requestCount++; const result = await this.read({base:new URL('https://models.dev'),url:new URL(MODEL_CATALOG_URL),publicCatalog:true,signal:controller.signal});
          notices.push(...supplementCatalog(service,items,result.json,result.digest));
        } catch { notices.push('公共目录读取失败或结构不兼容，仅保留本次接口声明；没有降级套用旧目录'); }
      }
      this.check(serviceId,body.expectedConfigRevision);
      if (controller.signal.aborted) throw new MetadataHttpError('元数据读取已取消或超时');
      const at = Date.now(); const snapshot = IndependentDiscoverySnapshot.parse({id:newId('ids'),serviceId,configRevision:service.configRevision,items,skipped,pageCount,requestCount,fetchedAt:at,expiresAt:at+24*60*60*1000,includeCatalog:body.includeCatalog,notices:[...new Set(notices)].slice(0,32)});
      this.db.run('UPDATE independent_discoveries SET snapshot_json=?,last_error_json=NULL WHERE service_id=?',JSON.stringify(snapshot),serviceId);
      return this.state(serviceId);
    } catch (error) {
      const message = error instanceof AppError || error instanceof MetadataHttpError ? error.message : '元数据结构无法识别，未替换上次预览';
      if (!this.closed && this.db.get('SELECT id FROM independent_services WHERE id=?',serviceId)) this.db.run('UPDATE independent_discoveries SET last_error_json=? WHERE service_id=?',JSON.stringify({message,at:Date.now()}),serviceId);
      if (error instanceof AppError) throw error;
      throw new AppError(502,{code:ErrorCode.IndependentDiscoveryFailed,message,actions:[]});
    } finally {clearTimeout(timer);this.running.delete(serviceId);}
  }
  import(serviceId: string, input: ImportIndependentModelsBody, deviceId: string | null = null) {
    const body = ImportIndependentModelsBody.parse(input);
    return this.db.tx(() => {
      this.check(serviceId,body.expectedConfigRevision); const state = this.state(serviceId); const snapshot = state.snapshot;
      if (!snapshot || snapshot.id !== body.snapshotId || state.stale) throw Errors.conflict('发现预览已变化或过期，请重新获取后核对');
      const selected = body.remoteModelIds.map((id) => snapshot.items.find((item) => item.remoteModelId === id));
      if (selected.some((item) => !item)) throw Errors.badRequest('选中模型不属于本次发现预览');
      const items = selected.map((item) => {
        const model = this.catalog.createModel(serviceId,{remoteModelId:item!.remoteModelId,name:item!.name},deviceId);
        return item!.evidence.length ? this.catalog.recordEvidence(serviceId,model.id,item!.evidence,deviceId) : model;
      });
      return {items,nextCursor:null};
    });
  }
}
