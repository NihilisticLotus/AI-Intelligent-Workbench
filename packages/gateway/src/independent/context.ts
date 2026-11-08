// 只对最终协议输入做有来源的估算；未知保留未知，不探测窗口、不压缩原始历史。
import { createHash } from 'node:crypto';
import { IndependentContextPolicy, IndependentContextReport, type IndependentApiProtocol, type IndependentModel } from '@aic/protocol';
import { ModelTransportError, modelBody } from './model-http';

/** 仅接受已生成的协议对象，不从模型名猜计数接口或图片成本。 */
export function contextInput(protocol: IndependentApiProtocol, body: Record<string, any>) {
  const keys = protocol === 'responses' ? ['model', 'input', 'instructions', 'tools', 'reasoning']
    : protocol === 'anthropic_messages' ? ['model', 'messages', 'system', 'tools', 'thinking', 'output_config'] : ['model', 'messages', 'tools', 'reasoning_effort'];
  const input = Object.fromEntries(keys.filter((key) => body[key] !== undefined).map((key) => [key, structuredClone(body[key])]));
  return input;
}

export function contextCounter(protocol: IndependentApiProtocol) {
  if (protocol === 'responses') return 'responses/input_tokens' as const;
  if (protocol === 'anthropic_messages') return 'messages/count_tokens' as const;
  throw new ModelTransportError('request');
}

export function contextCountReply(protocol: IndependentApiProtocol, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ModelTransportError('protocol');
  const reply = value as Record<string, unknown>;
  if (protocol === 'responses' && reply.object !== 'response.input_tokens' || typeof reply.input_tokens !== 'number'
    || !Number.isSafeInteger(reply.input_tokens) || reply.input_tokens < 0 || reply.input_tokens > 1_000_000_000_000) throw new ModelTransportError('protocol');
  return reply.input_tokens;
}

export function contextReport(protocol: IndependentApiProtocol, body: Record<string, any>, model: IndependentModel,
  policyInput: IndependentContextPolicy, endpointCount?: number): IndependentContextReport {
  const policy = IndependentContextPolicy.parse(policyInput), input = contextInput(protocol, body), text = structuredClone(input);
  let imageCount = 0;
  // 仅处理协议消息中的图像块；不递归改写工具 schema 或文本内看起来像 JSON 的内容。
  for (const message of text[protocol === 'responses' ? 'input' : 'messages'] ?? []) if (Array.isArray(message.content)) for (const block of message.content) {
    if (protocol === 'responses' && block.type === 'input_image') { imageCount++; block.image_url = ''; }
    else if (protocol === 'chat_completions' && block.type === 'image_url') { imageCount++; block.image_url.url = ''; }
    else if (protocol === 'anthropic_messages' && block.type === 'image') { imageCount++; block.source.data = ''; }
  }
  const cap = (field: 'inputLimit' | 'contextWindow') => { const c = model.capabilities.find((item) => item.field === field && !item.stale && !item.conflict);
    return typeof c?.value === 'number' ? c.value : null; };
  const safetyTokens = policy.safetyTokens ?? 2048, modelInputLimit = cap('inputLimit'), contextWindow = cap('contextWindow');
  const localInputLimit = policy.localInputLimit ?? null, imageTokensPerImage = policy.mode === 'local' ? policy.imageTokensPerImage ?? null : null;
  // 一字节按一个 token 估算并包含完整 JSON 包装；这是保守启发式，不能承诺任意 tokenizer 的数学上界。
  const estimatedInputTokens = policy.mode === 'endpoint' ? endpointCount ?? null : imageCount && imageTokensPerImage === null ? null
    : Buffer.byteLength(JSON.stringify(text)) + imageCount * (imageTokensPerImage ?? 0);
  const outputTokens = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  let status: IndependentContextReport['status'] = 'ready';
  if (modelInputLimit === null && contextWindow === null && localInputLimit === null) status = 'limits_unknown';
  else if (estimatedInputTokens === null) status = 'input_unknown';
  else if ([modelInputLimit, localInputLimit].some((limit) => limit !== null && estimatedInputTokens + safetyTokens > limit)) status = 'input_exceeded';
  else if (contextWindow !== null && estimatedInputTokens + safetyTokens + outputTokens > contextWindow) status = 'window_exceeded';
  return IndependentContextReport.parse({ requestHash: createHash('sha256').update(modelBody(body)).digest('hex'),
    method: policy.mode === 'endpoint' ? 'endpoint' : 'local_bytes', estimatedInputTokens, imageCount, imageTokensPerImage,
    outputTokens, safetyTokens, modelInputLimit, contextWindow, localInputLimit, counterRequests: endpointCount === undefined ? 0 : 1, status });
}
