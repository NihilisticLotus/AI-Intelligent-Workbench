// 三种协议各自编码；只传函数工具，不启用供应商托管工具、自动执行或远程文件下载。
import { createHash } from 'node:crypto';
import { IndependentAssistantMessage, IndependentToolArguments, type IndependentModelRequest, type IndependentModelAttachment,
  type IndependentService, type IndependentModel, type IndependentModelDelta, type IndependentUsage } from '@aic/protocol';
import { ModelTransportError, modelJson } from './model-http';

const bad = (): never => { throw new ModelTransportError('protocol'); };
const obj = (v: unknown): Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : bad();
const str = (v: unknown): string => typeof v === 'string' ? v : bad();
const list = (v: unknown): any[] => Array.isArray(v) ? v : bad();
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const unknownUsage = (): IndependentUsage => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null });
function usage(raw: unknown, kind: 'chat' | 'responses' | 'messages'): IndependentUsage {
  if (raw == null) return unknownUsage(); const u = obj(raw);
  return { inputTokens: count(kind === 'chat' ? u.prompt_tokens : u.input_tokens), outputTokens: count(kind === 'chat' ? u.completion_tokens : u.output_tokens),
    cacheReadTokens: count(kind === 'chat' ? u.prompt_tokens_details?.cached_tokens : kind === 'responses' ? u.input_tokens_details?.cached_tokens : u.cache_read_input_tokens),
    cacheWriteTokens: count(kind === 'chat' ? u.prompt_tokens_details?.cache_write_tokens : kind === 'messages' ? u.cache_creation_input_tokens : undefined) };
}
const args = (value: unknown) => { try { return IndependentToolArguments.parse(typeof value === 'string' ? modelJson(value) : value); } catch { return bad(); } };

export function modelWire(request: IndependentModelRequest, service: IndependentService, model: IndependentModel,
  attachments: Map<string, IndependentModelAttachment>, emit: (delta: IndependentModelDelta) => void) {
  const protocol = service.protocol, tools = request.tools ?? [], generation = request.generation ?? {};
  const scope = hash({ binding: request.binding, protocol, baseUrl: service.baseUrl, remoteModelId: model.remoteModelId });
  const prefix = (through: number) => hash({ system: request.systemPrompt, checkpoint: request.checkpoint,
    tools, messages: request.messages.slice(0, through) });
  const identity = (m: { text: string; toolCalls: unknown }) => hash({ text: m.text, toolCalls: m.toolCalls });
  const unpack = (m: Extract<IndependentModelRequest['messages'][number], { role: 'assistant' }>, i: number) => {
    if (!m.continuation) return null;
    const c = obj(modelJson(m.continuation));
    if (c.version !== 1 || c.scope !== scope || c.prefix !== prefix(i) || c.identity !== identity(m)) throw new ModelTransportError('request');
    return c.payload;
  };
  const seal = (message: IndependentAssistantMessage, payload: unknown) => {
    if (payload !== null && (message.stopReason === 'complete' || message.stopReason === 'tool_calls')) message.continuation = JSON.stringify({ version: 1, scope,
      prefix: prefix(request.messages.length), identity: identity(message), payload });
    try { return IndependentAssistantMessage.parse(message); } catch { return bad(); }
  };
  const system = request.systemPrompt + (request.checkpoint ? '\n\n历史压缩摘要（原始记录仍保留）：\n' + request.checkpoint.summary : '');
  const userContent = (message: Extract<IndependentModelRequest['messages'][number], { role: 'user' }>) => {
    const result: any[] = [];
    const text = (value: string) => result.push(protocol === 'responses' ? { type: 'input_text', text: value } : { type: 'text', text: value });
    if (message.text) text(message.text);
    for (const ref of message.attachments) {
      const a = attachments.get(ref.attachmentId); if (!a) throw new ModelTransportError('request');
      if (a.kind === 'text') { let body: string; try { body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(a.base64, 'base64')); } catch { throw new ModelTransportError('request'); }
        text(`\n附件：${a.name}\n<attachment>\n${body}\n</attachment>`); continue; }
      const url = `data:${a.mime};base64,${a.base64}`;
      result.push(protocol === 'anthropic_messages' ? { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.base64 } }
        : protocol === 'responses' ? { type: 'input_image', image_url: url, detail: 'auto' } : { type: 'image_url', image_url: { url, detail: 'auto' } });
    }
    if (!result.length) text(''); return result;
  };
  // 工具结果必须与前一助手声明逐项成对，禁止将缺失 / 乱序历史发给供应商。
  let pending: { id: string; name: string }[] = [];
  for (const message of request.messages) {
    if (message.role === 'tool') { const next = pending.shift(); if (!next || next.id !== message.callId || next.name !== message.name) throw new ModelTransportError('request'); }
    else { if (pending.length) throw new ModelTransportError('request'); if (message.role === 'assistant') pending = [...message.toolCalls]; }
  }
  if (pending.length) throw new ModelTransportError('request');

  const messages: any[] = [];
  if (protocol === 'chat_completions' && system) messages.push({ role: 'system', content: system });
  for (let i = 0; i < request.messages.length; i++) {
    const m = request.messages[i]!;
    if (m.role === 'user') { messages.push({ role: 'user', content: userContent(m) }); continue; }
    if (m.role === 'tool') {
      if (protocol === 'chat_completions') messages.push({ role: 'tool', tool_call_id: m.callId, content: m.text });
      else if (protocol === 'responses') messages.push({ type: 'function_call_output', call_id: m.callId, output: m.text });
      else { const block = { type: 'tool_result', tool_use_id: m.callId, content: m.text, is_error: m.outcome !== 'ok' };
        const previous = messages.at(-1); if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((b: any) => b.type === 'tool_result')) previous.content.push(block);
        else messages.push({ role: 'user', content: [block] }); }
      continue;
    }
    const saved = unpack(m, i);
    if (protocol === 'chat_completions') {
      const item: any = { role: 'assistant', content: m.text || null };
      if (m.toolCalls.length) item.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } }));
      if (saved !== null) item.reasoning_content = str(obj(saved).reasoning_content);
      messages.push(item);
    } else if (protocol === 'responses') {
      if (saved !== null) { const output = list(saved); const normalized = responseParts(output, 'completed'); if (identity(normalized) !== identity(m)) throw new ModelTransportError('request'); messages.push(...output); }
      else { if (m.text) messages.push({ role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
        for (const c of m.toolCalls) messages.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments) }); }
    } else {
      let content: any[];
      if (saved !== null) { content = list(saved); const normalized = messageParts(content, m.toolCalls.length ? 'tool_use' : 'end_turn'); if (identity(normalized) !== identity(m)) throw new ModelTransportError('request'); }
      else content = [...(m.text ? [{ type: 'text', text: m.text }] : []), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments }))];
      if (!content.length) content = [{ type: 'text', text: '（上一回合未产生可用回复）' }];
      messages.push({ role: 'assistant', content });
    }
  }
  const outputLimit = model.capabilities.find((c) => c.field === 'outputLimit' && !c.conflict && !c.stale)?.value;
  const maxOutput = Math.min(request.maxOutputTokens, typeof outputLimit === 'number' ? outputLimit : request.maxOutputTokens);
  const body: Record<string, any> = { model: model.remoteModelId, stream: generation.stream !== false };
  if (protocol === 'chat_completions') {
    body.messages = messages; body[generation.chatTokenLimitField ?? 'max_completion_tokens'] = maxOutput;
    if (body.stream && model.capabilities.some((c) => c.field === 'streamUsage' && c.value === true && !c.stale && !c.conflict)) body.stream_options = { include_usage: true };
    if (tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { ...t, strict: false } }));
    if (generation.effort) body.reasoning_effort = generation.effort;
    if (generation.thinking) throw new ModelTransportError('request');
  } else if (protocol === 'responses') {
    body.input = messages; body.instructions = system; body.max_output_tokens = maxOutput; body.store = false; body.include = ['reasoning.encrypted_content'];
    if (tools.length) body.tools = tools.map((t) => ({ type: 'function', ...t, strict: false }));
    if (generation.effort) body.reasoning = { effort: generation.effort };
    if (generation.thinking) throw new ModelTransportError('request');
  } else {
    body.messages = messages; body.system = system; body.max_tokens = maxOutput;
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (generation.effort) body.output_config = { effort: generation.effort };
    if (generation.thinking) {
      const thinking = generation.thinking;
      if (thinking.mode === 'enabled' && (thinking.budgetTokens === undefined || thinking.budgetTokens >= maxOutput) || thinking.mode !== 'enabled' && thinking.budgetTokens !== undefined) throw new ModelTransportError('request');
      body.thinking = { type: thinking.mode, ...(thinking.budgetTokens !== undefined ? { budget_tokens: thinking.budgetTokens } : {}) };
    }
  }

  function messageParts(content: any[], reason: string) {
    let text = ''; const toolCalls: IndependentAssistantMessage['toolCalls'] = [];
    for (const raw of content) { const b = obj(raw);
      if (b.type === 'text') text += str(b.text);
      else if (b.type === 'tool_use') { if (reason === 'tool_use') toolCalls.push({ id: str(b.id), name: str(b.name), arguments: args(b.input) }); }
      else if (b.type === 'thinking') { if (['tool_use','end_turn','stop_sequence'].includes(reason)) { str(b.thinking); if (!str(b.signature)) bad(); } }
      else if (b.type === 'redacted_thinking') { if (!str(b.data)) bad(); } else bad();
    }
    return { text, toolCalls };
  }
  function responseParts(output: any[], status: string) {
    let text = ''; const toolCalls: IndependentAssistantMessage['toolCalls'] = [];
    for (const raw of output) { const item = obj(raw);
      if (item.type === 'message') { if (item.role !== 'assistant') bad(); for (const rawPart of list(item.content)) { const p = obj(rawPart); if (p.type === 'output_text') text += str(p.text); else if (p.type === 'refusal') text += str(p.refusal); else bad(); } }
      else if (item.type === 'function_call') { if (status === 'completed') { if (item.status !== undefined && item.status !== 'completed') bad(); toolCalls.push({ id: str(item.call_id), name: str(item.name), arguments: args(item.arguments) }); } }
      else if (item.type !== 'reasoning') bad();
    }
    return { text, toolCalls };
  }
  let result: IndependentAssistantMessage | undefined;
  const finishChat = (value: unknown) => {
    const v = obj(value); if (v.error) bad(); const choices = list(v.choices); if (choices.length !== 1 || obj(choices[0]).index !== 0) bad();
    const choice = obj(choices[0]), message = obj(choice.message), reason = choice.finish_reason;
    if (message.role !== undefined && message.role !== 'assistant') bad();
    const stop = reason === 'stop' ? 'complete' : reason === 'tool_calls' ? 'tool_calls' : reason === 'length' ? 'length' : 'error';
    const calls = stop === 'tool_calls' ? list(message.tool_calls).map((raw) => { const c = obj(raw); if (c.type !== 'function') bad(); const f = obj(c.function); return { id: str(c.id), name: str(f.name), arguments: args(f.arguments) }; }) : [];
    if (stop === 'complete' && message.tool_calls?.length) bad();
    result = seal({ role: 'assistant', text: message.content == null ? '' : str(message.content), toolCalls: calls, stopReason: stop, usage: usage(v.usage, 'chat') },
      typeof message.reasoning_content === 'string' ? { reasoning_content: message.reasoning_content } : null);
  };
  const finishResponse = (value: unknown) => {
    const v = obj(value), output = list(v.output), status = str(v.status); const parts = responseParts(output, status);
    if (status === 'completed' && v.error != null) bad();
    const stop = status === 'completed' ? (parts.toolCalls.length ? 'tool_calls' : 'complete') : status === 'incomplete' && v.incomplete_details?.reason === 'max_output_tokens' ? 'length' : 'error';
    if (parts.toolCalls.length && output.some((i) => i.type === 'reasoning' && (typeof i.encrypted_content !== 'string' || !i.encrypted_content))) bad();
    result = seal({ role: 'assistant', ...parts, toolCalls: stop === 'tool_calls' ? parts.toolCalls : [], stopReason: stop, usage: usage(v.usage, 'responses') },
      output.some((i) => i.type === 'function_call' || i.type === 'reasoning' && typeof i.encrypted_content === 'string')
        ? output.filter((i) => i.type !== 'reasoning' || typeof i.encrypted_content === 'string') : null);
  };
  const finishMessage = (value: unknown) => {
    const v = obj(value), content = list(v.content), reason = str(v.stop_reason), parts = messageParts(content, reason);
    if (v.type !== 'message' || v.role !== 'assistant') bad();
    const stop = reason === 'tool_use' ? 'tool_calls' : reason === 'end_turn' || reason === 'stop_sequence' ? 'complete' : reason === 'max_tokens' ? 'length' : 'error';
    if (stop === 'complete' && content.some((b) => b.type === 'tool_use')) bad();
    result = seal({ role: 'assistant', ...parts, stopReason: stop, usage: usage(v.usage, 'messages') }, content.some((b) => b.type !== 'text') ? content : null);
  };
  const json = (value: unknown) => { if (result) bad(); if (protocol === 'chat_completions') finishChat(value); else if (protocol === 'responses') finishResponse(value); else finishMessage(value); };
  let chatText = '', chatThinking = '', chatReason: string | null = null, chatUsage: unknown = null; const chatCalls = new Map<number, any>();
  let started = false, messageReason: string | null = null, messageUsage: any = {}; let messageOutput: number | null = null;
  const blocks = new Map<number, any>(), open = new Set<number>(), partial = new Map<number, string>();
  const event = (data: string, name: string) => {
    if (result) bad();
    if (protocol === 'chat_completions' && data === '[DONE]') {
      if (!chatReason) bad(); finishChat({ choices: [{ index: 0, finish_reason: chatReason, message: { content: chatText, reasoning_content: chatThinking || undefined, tool_calls: [...chatCalls.entries()].sort((a,b) => a[0]-b[0]).map((p) => p[1]) } }], usage: chatUsage }); return true;
    }
    const e = obj(modelJson(data));
    if (protocol === 'chat_completions') {
      if (e.error) bad(); if (e.usage != null) chatUsage = e.usage;
      for (const raw of list(e.choices)) { const c = obj(raw); if (c.index !== 0 || chatReason !== null) bad(); const d = obj(c.delta);
        if (d.role !== undefined && d.role !== 'assistant') bad();
        if (d.content != null) { const text = str(d.content); chatText += text; emit({ type: 'text_delta', text }); }
        if (d.reasoning_content != null) { const text = str(d.reasoning_content); chatThinking += text; emit({ type: 'thinking_delta', text }); }
        if (d.tool_calls !== undefined) for (const rawCall of list(d.tool_calls)) { const call = obj(rawCall); if (!Number.isInteger(call.index) || call.index < 0 || call.index > 63) bad();
          const old = chatCalls.get(call.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (call.type !== undefined && call.type !== 'function') bad(); if (call.id !== undefined) old.id += str(call.id);
          if (call.function !== undefined) { const f = obj(call.function); if (f.name !== undefined) old.function.name += str(f.name); if (f.arguments !== undefined) old.function.arguments += str(f.arguments); }
          chatCalls.set(call.index, old);
        }
        if (c.finish_reason != null) chatReason = str(c.finish_reason);
      }
      if (chatText.length > 1024 * 1024 || chatThinking.length > 256 * 1024) throw new ModelTransportError('limit'); return false;
    }
    if (typeof e.type !== 'string' || name && name !== e.type || e.type === 'error') bad();
    if (protocol === 'responses') {
      if (e.type === 'response.output_text.delta') emit({ type: 'text_delta', text: str(e.delta) });
      if (e.type === 'response.reasoning_summary_text.delta') emit({ type: 'thinking_delta', text: str(e.delta) });
      if (['response.completed', 'response.incomplete', 'response.failed'].includes(e.type)) {
        if (obj(e.response).status !== e.type.slice('response.'.length)) bad();
        finishResponse(e.response); return true;
      }
      return false;
    }
    if (e.type === 'message_start') { if (started) bad(); started = true; const m = obj(e.message); if (m.role !== 'assistant' || list(m.content).length) bad(); messageUsage = obj(m.usage); }
    else if (e.type === 'content_block_start') {
      if (!started || messageReason || !Number.isInteger(e.index) || e.index !== blocks.size || blocks.size >= 64) bad();
      const b = obj(e.content_block); blocks.set(e.index, { ...b }); open.add(e.index); if (b.type === 'tool_use') partial.set(e.index, '');
      if (b.type === 'text' && b.text) emit({ type: 'text_delta', text: str(b.text) });
    } else if (e.type === 'content_block_delta') {
      if (!open.has(e.index)) bad(); const b = blocks.get(e.index)!, d = obj(e.delta);
      if (d.type === 'text_delta' && b.type === 'text') { const text = str(d.text); b.text = str(b.text) + text; emit({ type: 'text_delta', text }); }
      else if (d.type === 'thinking_delta' && b.type === 'thinking') { const text = str(d.thinking); b.thinking = str(b.thinking) + text; emit({ type: 'thinking_delta', text }); }
      else if (d.type === 'signature_delta' && b.type === 'thinking') b.signature = (b.signature ?? '') + str(d.signature);
      else if (d.type === 'input_json_delta' && b.type === 'tool_use') partial.set(e.index, partial.get(e.index)! + str(d.partial_json)); else bad();
    } else if (e.type === 'content_block_stop') { if (!open.delete(e.index)) bad(); }
    else if (e.type === 'message_delta') { if (!started || open.size || messageReason) bad(); messageReason = str(obj(e.delta).stop_reason); if (e.usage) { const u = obj(e.usage); messageOutput = count(u.output_tokens); messageUsage = { ...messageUsage, ...u }; } }
    else if (e.type === 'message_stop') {
      if (!started || open.size || !messageReason) bad();
      if (messageReason === 'tool_use') for (const [index, raw] of partial) { const b = blocks.get(index)!; if (raw) b.input = args(raw); }
      finishMessage({ type: 'message', role: 'assistant', content: [...blocks.values()], stop_reason: messageReason, usage: { ...messageUsage, output_tokens: messageOutput } }); return true;
    }
    return false;
  };
  return { body, endpoint: protocol === 'chat_completions' ? 'chat/completions' as const : protocol === 'responses' ? 'responses' as const : 'messages' as const,
    event, json, result: () => result ?? bad() };
}
