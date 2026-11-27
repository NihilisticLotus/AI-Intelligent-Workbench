// 独立的元数据客户端：固定目标、连接时校验 DNS，不使用代理环境、Cookie 或全局 Agent。
import { lookup } from 'node:dns';
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { createHash } from 'node:crypto';
import { IndependentBaseUrl } from '@aic/protocol';
import {
  EgressPolicyError,
  assertEgressUrl,
  createPinnedLookup,
  isAddressAllowed,
  isFakeIpProxyAddress,
  isPublicAddress,
  type PortListInput,
} from '../security/egress';

export const isPublicMetadataAddress = (address: string) => isPublicAddress(address);
export { isFakeIpProxyAddress };
export interface AddressPolicy {
  allowFakeIpProxy?: boolean;
  blockedLocalPorts?: PortListInput;
}

/** 私网例外仅来自用户明确保存的 IP 或 localhost，不允许域名解析扩大范围。 */
export function metadataAddressAllowed(base: URL, address: string, publicCatalog: boolean, policy: AddressPolicy = {}) {
  return isAddressAllowed(base, address, {
    baseUrl: base,
    allowLocalhost: !publicCatalog,
    allowExplicitPrivateIp: !publicCatalog,
    allowFakeIpProxy: !publicCatalog && policy.allowFakeIpProxy === true,
    blockedLocalPorts: policy.blockedLocalPorts,
  });
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
  /** 用户在设置里打开的地址例外；缺省时不放行 fake-ip 网段 */
  addressPolicy?: AddressPolicy;
  /** Gateway 自身监听端口（含局域网同端口）；即使允许 localhost 也禁止回打 */
  blockedLocalPorts?: PortListInput;
  /** 测试只替换解析器，仍经过实际连接路径的地址检查。 */
  lookup?: typeof lookup;
}) {
  const { url, base, publicCatalog } = input;
  const maxBytes = input.maxBytes ?? (publicCatalog ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
  if (!IndependentBaseUrl.safeParse(base.href.replace(/\/$/, '')).success || url.origin !== base.origin || url.username || url.password || url.hash
    || !url.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/') || (publicCatalog && (base.href !== 'https://models.dev/' || url.href !== 'https://models.dev/experimental/v2.0/api.json?type=chat'))) throw new MetadataHttpError('元数据请求目标不符合范围');
  if (publicCatalog && Object.keys(input.headers ?? {}).length) throw new MetadataHttpError('公共目录不能携带服务认证');
  const egressOptions = {
    baseUrl: base,
    allowLocalhost: !publicCatalog,
    allowExplicitPrivateIp: !publicCatalog,
    allowFakeIpProxy: !publicCatalog && input.addressPolicy?.allowFakeIpProxy === true,
    blockedLocalPorts: input.blockedLocalPorts ?? input.addressPolicy?.blockedLocalPorts,
  };
  try {
    assertEgressUrl(url, egressOptions);
  } catch (error) {
    throw new MetadataHttpError(error instanceof EgressPolicyError && error.reason === 'blocked_local_port'
      ? '元数据地址被网络规则拒绝（不允许连接本机 AI Console 服务端口）'
      : '元数据地址被网络规则拒绝');
  }
  const resolver = input.lookup ?? lookup;
  // 新 Agent 不继承全局代理配置或连接池；固定 lookup 在每次实际连接前校验地址。
  const agent = url.protocol === 'https:' ? new HttpsAgent({ keepAlive: false, proxyEnv: {} }) : new HttpAgent({ keepAlive: false, proxyEnv: {} });
  const controller = new AbortController(); let response: IncomingMessage | undefined; let decoder: ReturnType<typeof createGunzip> | undefined;
  const abort = () => controller.abort(); input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, input.timeoutMs ?? 15_000); timer.unref();
  try {
    return await new Promise<{ json: unknown; digest: string }>((resolve,reject) => {
      const pinnedLookup = createPinnedLookup(url, egressOptions, resolver, (_err, reason) =>
        new MetadataHttpError(reason === 'fake_ip_proxy'
          ? '元数据域名解析到本机代理的 fake-ip 网段（198.18.x），可在设置里允许'
          : reason === 'blocked_local_port'
            ? '元数据地址被网络规则拒绝（不允许连接本机 AI Console 服务端口）'
            : '元数据域名解析到受限地址'));
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'GET', agent, signal: controller.signal, maxHeaderSize: 16 * 1024,
        headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br', ...input.headers },
        lookup: pinnedLookup,
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
