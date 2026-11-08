// 独立模型驱动只使用固定任务目录凭据；没有 SDK 认证发现、环境 Key 或其他服务兜底。
import type { lookup } from 'node:dns';
import { IndependentModelRequest, IndependentModelAttachment, IndependentGenerationOptions, IndependentModelToolDefinition,
  type IndependentModelDriver, type IndependentModelDriverConfig, type IndependentModelBinding, type IndependentCapabilityField } from '@aic/protocol';
import { StreamRedactor } from '@aic/adapters';
import { sniffAttachment } from '../attachments';
import { IndependentCatalog } from './catalog';
import { ModelTransportError, postModel } from './model-http';
import { modelWire } from './model-wire';

export class IndependentApiDriver implements IndependentModelDriver {
  private active = new Map<string, Promise<unknown>>();
  private config: IndependentModelDriverConfig;
  constructor(private catalog: IndependentCatalog, config: IndependentModelDriverConfig = {}, private resolver?: typeof lookup) {
    this.config = { ...config, tools: config.tools ? structuredClone(config.tools.map((t) => IndependentModelToolDefinition.parse(t))) : undefined,
      generation: config.generation ? IndependentGenerationOptions.parse(config.generation) : undefined };
    if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 600_000)) throw new ModelTransportError('request');
  }
  checkBinding(binding: IndependentModelBinding) {
    const current = this.catalog.bound(binding.taskId);
    if (Object.keys(current).some((key) => current[key as keyof typeof current] !== binding[key as keyof typeof current])) throw new ModelTransportError('request');
  }
  complete(input: IndependentModelRequest, signal: AbortSignal) {
    let request: IndependentModelRequest;
    try { request = IndependentModelRequest.parse(input); } catch { return Promise.reject(new ModelTransportError('request')); }
    if (this.active.has(request.binding.taskId)) return Promise.reject(new ModelTransportError('request'));
    const promise = Promise.resolve().then(() => this.run(request, signal))
      .catch((error) => { throw error instanceof ModelTransportError ? error : new ModelTransportError('request'); })
      .finally(() => this.active.delete(request.binding.taskId));
    this.active.set(request.binding.taskId, promise); return promise;
  }
  async waitForIdle(binding: IndependentModelBinding) { await this.active.get(binding.taskId)?.catch(() => {}); }
  private async run(request: IndependentModelRequest, signal: AbortSignal) {
    const check = () => { if (signal.aborted) throw new ModelTransportError('cancelled'); this.checkBinding(request.binding); };
    check(); const { service, model, key } = await this.catalog.credentials(request.binding.taskId); check();
    const capability = (field: IndependentCapabilityField) => { const c = model.capabilities.find((v) => v.field === field); return c && !c.stale && !c.conflict ? c.value : null; };
    request = { ...request, tools: request.tools ?? this.config.tools ?? [], generation: { ...this.config.generation, ...request.generation } };
    if (new Set(request.tools!.map((t) => t.name)).size !== request.tools!.length) throw new ModelTransportError('request');
    if ((request.tools!.length || request.messages.some((m) => m.role === 'assistant' && m.toolCalls.length)) && capability('tools') !== true) throw new ModelTransportError('request');
    const generation = request.generation!;
    if (generation.effort && (capability('thinking') !== true || !Array.isArray(capability('effortLevels')) || !(capability('effortLevels') as string[]).includes(generation.effort))) throw new ModelTransportError('request');
    if (generation.thinking) {
      if (generation.thinking.mode === 'disabled' ? capability('thinkingCanDisable') !== true : capability('thinking') !== true) throw new ModelTransportError('request');
      const budget = generation.thinking.budgetTokens, min = capability('thinkingBudgetMin'), max = capability('thinkingBudgetMax');
      if (budget !== undefined && (typeof min === 'number' && budget < min || typeof max === 'number' && budget > max)) throw new ModelTransportError('request');
    }
    if (service.protocol !== 'chat_completions' && generation.chatTokenLimitField !== undefined) throw new ModelTransportError('request');
    // Chat 没有流用量证据时默认读完整 JSON，避免工具循环因缺账单被迫停在首轮；不将此默认记作能力证据。
    if (generation.stream === undefined && service.protocol === 'chat_completions' && capability('streamUsage') !== true) generation.stream = false;
    if (capability('streaming') === false) { if (generation.stream === true) throw new ModelTransportError('request'); generation.stream = false; }
    const attachments = new Map<string, IndependentModelAttachment>();
    let attachmentBytes = 0;
    for (const message of request.messages) if (message.role === 'user') for (const ref of message.attachments) {
      if (attachments.has(ref.attachmentId)) continue;
      if (attachments.size >= 50) throw new ModelTransportError('limit');
      if (!this.config.loadAttachment) throw new ModelTransportError('request');
      const a = IndependentModelAttachment.parse(await this.config.loadAttachment(request.binding.taskId, ref.attachmentId, signal)); check();
      if (a.attachmentId !== ref.attachmentId) throw new ModelTransportError('request');
      const bytes = Buffer.from(a.base64, 'base64');
      if (bytes.length > (a.kind === 'image' ? 5 * 1024 * 1024 : 512 * 1024)) throw new ModelTransportError('limit');
      attachmentBytes += bytes.length;
      if (attachmentBytes > 16 * 1024 * 1024) throw new ModelTransportError('limit');
      if (a.kind === 'image') {
        if (capability('imageInput') !== true || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(a.mime)) throw new ModelTransportError('request');
        const sniffed = sniffAttachment(bytes); if (sniffed.kind !== 'image' || sniffed.mime !== a.mime) throw new ModelTransportError('request');
        const formats = capability('inputModalities'); if (Array.isArray(formats) && !formats.includes('image') && !formats.includes(a.mime)) throw new ModelTransportError('request');
      } else { try { if (bytes.includes(0)) throw Error(); new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ModelTransportError('request'); } }
      attachments.set(ref.attachmentId, a);
    }
    const redactor = new StreamRedactor(key ? [key] : []);
    const emit = (delta: Parameters<NonNullable<IndependentModelDriverConfig['onDelta']>>[1]) => {
      check(); const text = redactor.push(delta.type, delta.text); if (text) this.config.onDelta?.(request.binding, { type: delta.type, text });
    };
    const wire = modelWire(request, service, model, attachments, emit); check();
    const headers: Record<string, string> = {};
    if (service.protocol === 'anthropic_messages') {
      if (!service.apiVersion || !/^\d{4}-\d{2}-\d{2}$/.test(service.apiVersion)) throw new ModelTransportError('request');
      headers['anthropic-version'] = service.apiVersion; if (key) headers['x-api-key'] = key;
    } else if (key) headers.Authorization = `Bearer ${key}`;
    try {
      await postModel({ base: new URL(service.baseUrl), endpoint: wire.endpoint, headers, body: JSON.stringify(wire.body), signal,
        timeoutMs: this.config.timeoutMs ?? 120_000, onEvent: wire.event, onJson: wire.json, lookup: this.resolver });
      check(); const reply = wire.result();
      if (reply.toolCalls.some((call) => !request.tools!.some((definition) => definition.name === call.name))) throw new ModelTransportError('protocol');
      // 若不可信上游回显服务 Key，不让其进入工具参数、持久会话或界面；不能静默篡改签名续传。
      const containsKey = (value: unknown): boolean => typeof value === 'string' ? !!key && value.includes(key)
        : value !== null && typeof value === 'object' && Object.values(value).some(containsKey);
      if (key && (containsKey(reply) || reply.continuation && containsKey(JSON.parse(reply.continuation)))) throw new ModelTransportError('protocol');
      for (const type of ['text_delta', 'thinking_delta'] as const) { const text = redactor.flush(type); if (text) this.config.onDelta?.(request.binding, { type, text }); }
      return reply;
    } catch (error) { throw error instanceof ModelTransportError ? error : new ModelTransportError('protocol'); }
  }
}
