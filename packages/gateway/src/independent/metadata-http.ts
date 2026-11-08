// 独立的元数据客户端：固定目标、连接时校验 DNS，不使用代理环境、Cookie 或全局 Agent。
import { lookup } from 'node:dns';
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { createHash } from 'node:crypto';
import { IndependentBaseUrl } from '@aic/protocol';

const blocked = new BlockList();
for (const [ip, bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const) blocked.addSubnet(ip, bits);
blocked.addSubnet('2001::', 23, 'ipv6'); blocked.addSubnet('2001:db8::', 32, 'ipv6'); blocked.addSubnet('2002::', 16, 'ipv6'); blocked.addSubnet('3fff::', 20, 'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const local = new BlockList();
for (const [ip,bits] of [['10.0.0.0',8],['127.0.0.0',8],['172.16.0.0',12],['192.168.0.0',16]] as const) local.addSubnet(ip,bits);
local.addAddress('::1','ipv6'); local.addSubnet('fc00::',7,'ipv6');
const hostOf = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');
export const isPublicMetadataAddress = (address: string) => {
  const family = isIP(address); if (!family) return false;
  return family === 4 ? !blocked.check(address) : globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
};

/** 私网例外仅来自用户明确保存的 IP 或 localhost，不允许域名解析扩大范围。 */
export function metadataAddressAllowed(base: URL, address: string, publicCatalog: boolean) {
  const host = hostOf(base);
  if (host === 'localhost') return !publicCatalog && (address === '127.0.0.1' || address === '::1');
  if (isPublicMetadataAddress(address)) return true;
  if (publicCatalog) return false;
  return isIP(host) !== 0 && host === address && local.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

/** 只解析有限 JSON，不保留原文；危险键和过深结构整体拒绝。 */
export function parseMetadataJson(bytes: Buffer, maxNodes = 500_000): unknown {
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); let nodes = 0;
  const visit = (v: unknown, depth: number) => {
    if (++nodes > maxNodes) throw new MetadataHttpError('目录节点超过限制');
    if (depth > 24) throw new MetadataHttpError('目录嵌套超过限制');
    if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) {
      if (['__proto__','prototype','constructor'].includes(key)) throw new MetadataHttpError('目录包含危险键');
      visit(child, depth + 1);
    }
  }; visit(raw, 0); return raw;
}

export class MetadataHttpError extends Error {
  constructor(message: string, readonly status: number | null = null) { super(message); }
}

export async function readMetadataJson(input: {
  url: URL; base: URL; publicCatalog: boolean; headers?: Record<string,string>;
  maxBytes?: number; timeoutMs?: number; signal?: AbortSignal;
  /** 测试只替换解析器，仍经过实际连接路径的地址检查。 */
  lookup?: typeof lookup;
}) {
  const { url, base, publicCatalog } = input;
  const maxBytes = input.maxBytes ?? (publicCatalog ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
  if (!IndependentBaseUrl.safeParse(base.href.replace(/\/$/, '')).success || url.origin !== base.origin || url.username || url.password || url.hash
    || !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/') || (publicCatalog && (base.href !== 'https://models.dev/' || url.href !== 'https://models.dev/experimental/v2.0/api.json?type=chat'))) throw new MetadataHttpError('元数据请求目标不符合范围');
  if (publicCatalog && Object.keys(input.headers ?? {}).length) throw new MetadataHttpError('公共目录不能携带服务认证');
  const hostname = hostOf(url);
  if (isIP(hostname) && !metadataAddressAllowed(base, hostname, publicCatalog)) throw new MetadataHttpError('元数据地址被网络规则拒绝');
  const resolver = input.lookup ?? lookup;
  // 新 Agent 不继承全局代理配置或连接池；固定 lookup 在每次实际连接前校验地址。
  const agent = url.protocol === 'https:' ? new HttpsAgent({ keepAlive: false, proxyEnv: {} }) : new HttpAgent({ keepAlive: false, proxyEnv: {} });
  const controller = new AbortController(); let response: IncomingMessage | undefined; let decoder: ReturnType<typeof createGunzip> | undefined;
  const abort = () => controller.abort(); input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, input.timeoutMs ?? 15_000); timer.unref();
  try {
    return await new Promise<{ json: unknown; digest: string }>((resolve,reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', agent, signal: controller.signal, maxHeaderSize: 16 * 1024,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br', ...input.headers },
        lookup: (host, options, callback) => {
          resolver(host, { ...options, all: true }, (err, addresses) => {
            if (err || !addresses?.length || addresses.some((a) => !metadataAddressAllowed(base, a.address, publicCatalog))) return callback(new MetadataHttpError('元数据域名解析到受限地址'), '', 4);
            // 把已校验的这一个地址直接交给连接，不能再次解析产生重绑定。
            const chosen = addresses[0]!; callback(null, options.all ? addresses : chosen.address, chosen.family);
          });
        },
      }, (res) => {
        response = res;
        void (async () => {
          if (res.statusCode !== 200) throw new MetadataHttpError(res.statusCode && res.statusCode >= 300 && res.statusCode < 400 ? '元数据重定向已拒绝' : `元数据接口返回 HTTP ${res.statusCode ?? '未知'}`, res.statusCode ?? null);
          if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(String(res.headers['content-type'] ?? ''))) throw new MetadataHttpError('元数据接口未返回 JSON');
          const length = Number(res.headers['content-length']); if (Number.isFinite(length) && length > maxBytes) throw new MetadataHttpError('元数据响应超过体积限制');
          const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase();
          decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
          if (encoding !== 'identity' && !decoder) throw new MetadataHttpError('不支持的元数据压缩格式');
          let encoded = 0; res.on('data', (chunk: Buffer) => { encoded += chunk.length; if (encoded > maxBytes) res.destroy(new MetadataHttpError('压缩响应超过体积限制')); });
          if (decoder) res.on('error', (error) => decoder?.destroy(error));
          const body = decoder ? res.pipe(decoder) : res; let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of body) { size += chunk.length; if (size > maxBytes) throw new MetadataHttpError('解压后元数据超过体积限制'); chunks.push(Buffer.from(chunk)); }
          if (!res.complete) throw new MetadataHttpError('元数据响应不完整');
          const bytes = Buffer.concat(chunks); resolve({ json: parseMetadataJson(bytes,publicCatalog ? 1_000_000 : 500_000), digest: createHash('sha256').update(bytes).digest('hex') });
        })().catch((error) => { res.destroy(); decoder?.destroy(); reject(new MetadataHttpError(error instanceof MetadataHttpError ? error.message : '元数据内容无法识别',res.statusCode ?? null)); });
      });
      request.on('error', (error) => reject(error instanceof MetadataHttpError ? error : new MetadataHttpError(controller.signal.aborted ? '元数据读取已取消或超时' : '元数据连接失败')));
      request.end();
    });
  } finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); response?.destroy(); decoder?.destroy(); agent.destroy(); }
}
