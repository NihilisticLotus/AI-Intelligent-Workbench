// 自有推理连接：固定一次 POST，不用代理 / 全局池，不重定向、不重试、不回显上游错误正文。
import { lookup } from 'node:dns';
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';
import { IndependentBaseUrl } from '@aic/protocol';
import { metadataAddressAllowed, parseMetadataJson } from './metadata-http';

export class ModelTransportError extends Error {
  constructor(readonly reason: 'request' | 'network' | 'cancelled' | 'timed_out' | 'limit' | 'protocol' | 'authentication' | 'quota' | 'upstream', readonly status: number | null = null) {
    const messages = { request: '模型请求参数或能力不满足条件', network: '模型服务连接失败', cancelled: '模型连接已取消', timed_out: '模型连接已超时',
      limit: '模型传输内容超过本地限制', protocol: '模型服务返回不完整或无法识别的协议内容', authentication: '模型服务拒绝认证，请核对该服务设置',
      quota: '模型服务额度或请求频率受限', upstream: '模型服务暂时无法完成请求' };
    super(messages[reason]);
  }
}
export const modelJson = (raw: string) => {
  try { return parseMetadataJson(Buffer.from(raw), 100_000); } catch { throw new ModelTransportError('protocol'); }
};

/** SSE 行按 UTF-8、CR / LF 和多行 data 解析；事件不是工具执行授权。 */
export class ModelSse {
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private line = ''; private data: string[] = []; private event = ''; private cr = false; private bytes = 0; private events = 0;
  constructor(private accept: (data: string, event: string) => boolean) {}
  private endLine() {
    const line = this.line; this.line = '';
    if (!line) {
      const data = this.data; const event = this.event; this.data = []; this.event = ''; this.bytes = 0;
      if (data.length && ++this.events > 100_000) throw new ModelTransportError('limit');
      return data.length > 0 && this.accept(data.join('\n'), event);
    }
    if (line.startsWith(':')) return false;
    const split = line.indexOf(':'); const key = split < 0 ? line : line.slice(0, split);
    let value = split < 0 ? '' : line.slice(split + 1); if (value.startsWith(' ')) value = value.slice(1);
    if (key === 'data') this.data.push(value); if (key === 'event') this.event = value;
    return false;
  }
  push(chunk: Uint8Array, final = false) {
    let text: string; try { text = this.decoder.decode(chunk, { stream: !final }); } catch { throw new ModelTransportError('protocol'); }
    for (const ch of text) {
      this.bytes += Buffer.byteLength(ch); if (this.bytes > 1024 * 1024) throw new ModelTransportError('limit');
      if (this.cr) { this.cr = false; if (ch === '\n') continue; }
      if (ch === '\r' || ch === '\n') { this.cr = ch === '\r'; if (this.endLine()) return true; }
      else this.line += ch;
    }
    // 不把 EOF 当隐式空行；没有完整结束事件的流由调用者拒绝。
    return false;
  }
}

export async function postModel(input: {
  base: URL; endpoint: 'chat/completions' | 'responses' | 'messages'; headers: Record<string, string>; body: string;
  signal: AbortSignal; timeoutMs: number; onEvent: (data: string, event: string) => boolean; onJson: (json: unknown) => void;
  lookup?: typeof lookup;
}) {
  if (!IndependentBaseUrl.safeParse(input.base.href.replace(/\/$/, '')).success || input.base.search || input.base.hash) throw new ModelTransportError('request');
  if (Buffer.byteLength(input.body) > 24 * 1024 * 1024) throw new ModelTransportError('limit');
  if (input.signal.aborted) throw new ModelTransportError('cancelled');
  const url = new URL(input.base.href.replace(/\/$/, '') + '/' + input.endpoint), host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !metadataAddressAllowed(input.base, host, false)) throw new ModelTransportError('request');
  const resolver = input.lookup ?? lookup;
  const agent = url.protocol === 'https:' ? new HttpsAgent({ keepAlive: false, proxyEnv: {} }) : new HttpAgent({ keepAlive: false, proxyEnv: {} });
  const abort = new AbortController(); let timedOut = false; let response: IncomingMessage | undefined;
  const externalAbort = () => abort.abort(); input.signal.addEventListener('abort', externalAbort, { once: true });
  if (input.signal.aborted) abort.abort();
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, input.timeoutMs); timer.unref();
  let requestClosed: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        agent, method: 'POST', signal: abort.signal, maxHeaderSize: 16 * 1024,
        headers: { ...input.headers, 'Content-Type': 'application/json', Accept: 'text/event-stream, application/json', 'Accept-Encoding': 'identity', 'Content-Length': Buffer.byteLength(input.body) },
        lookup: (hostname, options, callback) => resolver(hostname, { ...options, all: true }, (error, addresses) => {
          if (error || !addresses?.length || addresses.some((a) => !metadataAddressAllowed(input.base, a.address, false))) return callback(new ModelTransportError('network'), '', 4);
          const chosen = addresses[0]!; callback(null, options.all ? addresses : chosen.address, chosen.family);
        }),
      }, (res) => {
        response = res;
        void (async () => {
          const status = res.statusCode ?? 0;
          if (status !== 200) throw new ModelTransportError(status === 401 || status === 403 ? 'authentication' : status === 402 || status === 429 ? 'quota' : 'upstream', status);
          if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw new ModelTransportError('protocol');
          const mime = String(res.headers['content-type'] ?? ''); const sse = /^text\/event-stream(?:\s*;|$)/i.test(mime);
          if (!sse && !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(mime)) throw new ModelTransportError('protocol');
          const max = 16 * 1024 * 1024; if (Number(res.headers['content-length']) > max) throw new ModelTransportError('limit');
          const parser = new ModelSse(input.onEvent); let bytes = 0; const chunks: Buffer[] = [];
          for await (const chunk of res) {
            bytes += chunk.length; if (bytes > max) throw new ModelTransportError('limit');
            if (sse) { if (parser.push(chunk)) { resolve(); res.destroy(); return; } }
            else chunks.push(Buffer.from(chunk));
          }
          if (sse) { parser.push(new Uint8Array(), true); throw new ModelTransportError('protocol'); }
          if (!res.complete) throw new ModelTransportError('protocol');
          let value: unknown; try { value = parseMetadataJson(Buffer.concat(chunks), 100_000); } catch { throw new ModelTransportError('protocol'); }
          input.onJson(value); resolve();
        })().catch((error) => { res.destroy(); reject(error); });
      });
      requestClosed = new Promise<void>((done) => request.once('close', done));
      request.on('error', (error) => reject(error));
      request.end(input.body);
    });
  } catch (error) {
    if (abort.signal.aborted) throw new ModelTransportError(timedOut ? 'timed_out' : 'cancelled');
    throw error instanceof ModelTransportError ? error : new ModelTransportError('network');
  } finally {
    clearTimeout(timer); input.signal.removeEventListener('abort', externalAbort); response?.destroy(); agent.destroy();
    // close 之后才 settle，调用方可据此等待实际连接生命周期收尾。
    await requestClosed;
  }
}
