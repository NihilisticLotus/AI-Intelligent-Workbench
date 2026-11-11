// 独立模型驱动只使用固定任务目录凭据；没有 SDK 认证发现、环境 Key 或其他服务兜底。
import type { lookup } from 'node:dns';
import { createHash } from 'node:crypto';
import { IndependentModelRequest, IndependentModelAttachment, IndependentGenerationOptions, IndependentModelToolDefinition, IndependentContextPolicy,
  IndependentRequestFailure, type IndependentRequestAttempt, type IndependentRequestSettlement,
  type IndependentModelDriver, type IndependentModelDriverConfig, type IndependentModelBinding, type IndependentCapabilityField } from '@aic/protocol';
import { StreamRedactor } from '@aic/adapters';
import { sniffAttachment } from '../attachments';
import { IndependentCatalog } from './catalog';
import { ModelTransportError, modelBody, postModel } from './model-http';
import { modelWire } from './model-wire';
import { usableCapability } from './capabilities';
import { contextCounter, contextCountReply, contextInput, contextReport } from './context';

export class IndependentApiDriver implements IndependentModelDriver {
  private active = new Map<string, Promise<unknown>>();
  private config: IndependentModelDriverConfig;
  constructor(private catalog: IndependentCatalog, config: IndependentModelDriverConfig = {}, private resolver?: typeof lookup) {
    this.config = { ...config, tools: config.tools ? structuredClone(config.tools.map((t) => IndependentModelToolDefinition.parse(t))) : undefined,
      generation: config.generation ? IndependentGenerationOptions.parse(config.generation) : undefined,
      context: config.context ? IndependentContextPolicy.parse(config.context) : undefined };
    if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 600_000)) throw new ModelTransportError('request');
  }
  checkBinding(binding: IndependentModelBinding) {
    try {
      const current = this.catalog.bound(binding.taskId);
      if (Object.keys(current).some((key) => current[key as keyof typeof current] !== binding[key as keyof typeof current])) throw new ModelTransportError('request');
    } catch { throw new ModelTransportError('request'); }
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
    const capability = (field: IndependentCapabilityField) => usableCapability(model, field);
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
    const wire = modelWire(request, service, model, attachments, emit), body = modelBody(wire.body); check();
    const headers: Record<string, string> = {};
    if (service.protocol === 'anthropic_messages') {
      if (!service.apiVersion || !/^\d{4}-\d{2}-\d{2}$/.test(service.apiVersion)) throw new ModelTransportError('request');
      headers['anthropic-version'] = service.apiVersion; if (key) headers['x-api-key'] = key;
    } else if (key) headers.Authorization = `Bearer ${key}`;
    const deadline = performance.now() + (this.config.timeoutMs ?? 120_000);
    const remaining = () => { check(); const ms = Math.ceil(deadline - performance.now()); if (ms < 1) throw new ModelTransportError('timed_out'); return ms; };
    const recorded = async <T>(kind: IndependentRequestAttempt['kind'], payload: string, run: () => Promise<{ value: T; settlement: IndependentRequestSettlement }>) => {
      remaining();
      const accounting = this.config.accounting;
      // 同步持久化成功后才允许 run 接触网络；相同正文的下一次调用仍是独立收费尝试。
      const id = accounting?.reserve(structuredClone(request.binding), { kind, requestHash: createHash('sha256').update(payload).digest('hex') });
      let result: { value: T; settlement: IndependentRequestSettlement };
      try { check(); result = await run(); }
      catch (error) {
        const reason = error instanceof ModelTransportError ? IndependentRequestFailure.safeParse(error.reason) : undefined;
        const failure = reason?.success ? reason.data : 'protocol';
        // protocol 失败附带固定分类（ISSUE-0054）；其他失败或旧错误不带
        const detail = failure === 'protocol' && error instanceof ModelTransportError ? error.detail : undefined;
        const networkDetail = failure === 'network' && error instanceof ModelTransportError ? error.networkDetail : undefined;
        if (id !== undefined) accounting!.settle(id, { outcome: 'failed', failure, usage: null, countedInputTokens: null, ...(detail ? { protocolDetail: detail } : {}), ...(networkDetail ? { networkDetail } : {}) });
        throw error;
      }
      // 结算落盘失败不能再伪造 failed 或重发；遗留 reserved 交给显式恢复处理。
      if (id !== undefined) accounting!.settle(id, result.settlement);
      return result.value;
    };
    try {
      if (this.config.context) {
        const policy = this.config.context; let counted: number | undefined;
        if (policy.mode === 'endpoint') {
          const endpoint = contextCounter(service.protocol);
          if (contextReport(service.protocol, wire.body, model, policy).status !== 'limits_unknown') {
            const countBody = modelBody(contextInput(service.protocol, wire.body));
            counted = await recorded('counter', countBody, async () => {
              let count: number | undefined;
              await postModel({ base: new URL(service.baseUrl), endpoint, headers, body: countBody, signal, timeoutMs: remaining(),
                onEvent: () => { throw new ModelTransportError('protocol'); }, onJson: (value) => { count = contextCountReply(service.protocol, value); }, lookup: this.resolver, addressPolicy: this.catalog.getNetwork() });
              check(); if (count === undefined) throw new ModelTransportError('protocol');
              return { value: count, settlement: { outcome: 'succeeded', failure: null, usage: null, countedInputTokens: count } };
            });
            check();
          }
        }
        const report = contextReport(service.protocol, wire.body, model, policy, counted);
        this.config.onContext?.(structuredClone(request.binding), structuredClone(report)); check();
        if (report.status !== 'ready') throw new ModelTransportError('context');
      }
      const reply = await recorded('model', body, async () => {
        await postModel({ base: new URL(service.baseUrl), endpoint: wire.endpoint, headers, body, signal,
          timeoutMs: remaining(), onEvent: wire.event, onJson: wire.json, lookup: this.resolver, addressPolicy: this.catalog.getNetwork() });
        check(); const reply = wire.result();
        if (reply.toolCalls.some((call) => !request.tools!.some((definition) => definition.name === call.name))) throw new ModelTransportError('protocol');
        // 若不可信上游回显服务 Key，不让其进入工具参数、持久会话或界面；不能静默篡改签名续传。
        const containsKey = (value: unknown): boolean => typeof value === 'string' ? !!key && value.includes(key)
          : value !== null && typeof value === 'object' && Object.values(value).some(containsKey);
        if (key && (containsKey(reply) || reply.continuation && containsKey(JSON.parse(reply.continuation)))) throw new ModelTransportError('protocol');
        return { value: reply, settlement: { outcome: 'succeeded', failure: null, usage: reply.usage, countedInputTokens: null } };
      });
      for (const type of ['text_delta', 'thinking_delta'] as const) { const text = redactor.flush(type); if (text) this.config.onDelta?.(request.binding, { type, text }); }
      return reply;
    } catch (error) { throw error instanceof ModelTransportError ? error : new ModelTransportError('protocol'); }
  }
}
