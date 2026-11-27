// 公共出站网络策略与 DNS-pinned 防内网探测门禁（Egress Policy）。
// 默认采用严格公网模式，供独立模型/元数据、后续 MCP HTTP、Webhook 与受控浏览器统一复用。
import { lookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/** 公共拒绝网段（IPv4）：0/8、私网、CGNAT、回环、链路本地/云元数据、基准测试(fake-ip)、保留/组播等 */
const BLOCKED_V4 = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(ip, bits, 'ipv4');
}

/** 仅认可全球单播 2000::/3，并排除特殊/文档/6to4/Teredo/SRv6 测试等不可公开路由前缀 */
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');

const BLOCKED_V6 = new BlockList();
for (const [ip, bits] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(ip, bits, 'ipv6');
}

/** 允许作为独立本地服务例外出现的传统内网/回环网段 */
const PRIVATE_LOCAL = new BlockList();
for (const [ip, bits] of [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE_LOCAL.addSubnet(ip, bits, 'ipv4');
}
PRIVATE_LOCAL.addAddress('::1', 'ipv6');
PRIVATE_LOCAL.addSubnet('fc00::', 7, 'ipv6');

/** 本机透明代理（fake-ip 模式）分配网段 198.18.0.0/15 */
const FAKE_IP_V4 = new BlockList();
FAKE_IP_V4.addSubnet('198.18.0.0', 15, 'ipv4');

export type EgressRejectReason =
  | 'invalid_url'
  | 'credentials'
  | 'blocked_address'
  | 'blocked_local_port'
  | 'fake_ip_proxy'
  | 'dns_failed';

export class EgressPolicyError extends Error {
  constructor(message: string, readonly reason: EgressRejectReason = 'blocked_address') {
    super(message);
    this.name = 'EgressPolicyError';
  }
}

export type PortListInput = readonly number[] | (() => readonly number[]);

export interface EgressPolicyOptions {
  /** 默认 false（严格公网）；仅用户明确配置的独立模型 localhost 服务等可开启 */
  allowLocalhost?: boolean;
  /** 默认 false（严格公网）；允许配置与 URL host 一致的显式私网/回环 IPv4/ULA IPv6 */
  allowExplicitPrivateIp?: boolean;
  /** 默认 false；允许公网域名解析落入 198.18.0.0/15 代理 fake-ip 网段 */
  allowFakeIpProxy?: boolean;
  /** Gateway 自身监听端口（含本机与局域网监听端口）；即使允许 localhost 也禁止回打 */
  blockedLocalPorts?: PortListInput;
  /** 多段同源请求时用于校验与基准一致的 base URL */
  baseUrl?: URL;
}

export const hostOfUrl = (url: URL) => url.hostname.replace(/^\[|\]$/g, '');

function parseIpv6Words(address: string): number[] | null {
  let work = address;
  const dotIdx = work.lastIndexOf('.');
  if (dotIdx >= 0) {
    const colonIdx = work.lastIndexOf(':');
    if (colonIdx < 0) return null;
    const v4Part = work.slice(colonIdx + 1);
    if (isIP(v4Part) !== 4) return null;
    const octets = v4Part.split('.').map(Number);
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    work = `${work.slice(0, colonIdx)}:${high}:${low}`;
  }
  const halves = work.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (words.length !== 8) return null;
  const parsed = words.map((w) => Number.parseInt(w, 16));
  if (parsed.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return parsed;
}

/**
 * 归一化 IP 字符串：
 * - 剥离 URL 方括号与 `%eth0` 区域标识
 * - 将 `::ffff:127.0.0.1`、`::ffff:7f00:1`、`0:0:0:0:0:ffff:a9fe:a9fe` 等 IPv4 映射 IPv6 解包为规范 IPv4
 */
export function normalizeIp(raw: string): string {
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const family = isIP(ip);
  if (!family) return ip.toLowerCase();
  if (family === 4) return ip;
  const words = parseIpv6Words(ip);
  if (
    words &&
    words[0] === 0 &&
    words[1] === 0 &&
    words[2] === 0 &&
    words[3] === 0 &&
    words[4] === 0 &&
    words[5] === 0xffff
  ) {
    const w6 = words[6]!;
    const w7 = words[7]!;
    return `${(w6 >> 8) & 0xff}.${w6 & 0xff}.${(w7 >> 8) & 0xff}.${w7 & 0xff}`;
  }
  return ip.toLowerCase();
}

/** 判断地址是否严格属于可公开路由的公网 IPv4 / IPv6（含 ::ffff: 映射拆包）。 */
export function isPublicAddress(address: string): boolean {
  const normalized = normalizeIp(address);
  const family = isIP(normalized);
  if (!family) return false;
  if (family === 4) return !BLOCKED_V4.check(normalized, 'ipv4');
  return GLOBAL_V6.check(normalized, 'ipv6') && !BLOCKED_V6.check(normalized, 'ipv6');
}

/** 判定原始 IPv4 是否落入透明代理 fake-ip 网段 198.18.0.0/15（不放行 ::ffff: 映射地址）。 */
export function isFakeIpProxyAddress(address: string): boolean {
  return isIP(address) === 4 && FAKE_IP_V4.check(address, 'ipv4');
}

export function resolveBlockedPorts(input?: PortListInput): Set<number> {
  const list = typeof input === 'function' ? input() : (input ?? []);
  const set = new Set<number>();
  for (const port of list) {
    if (Number.isInteger(port) && port > 0 && port <= 65535) set.add(port);
  }
  return set;
}

export function effectivePort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

/** 按当前出站策略判断单个已解析 IP 是否允许连接。 */
export function isAddressAllowed(targetUrl: URL, address: string, options: EgressPolicyOptions = {}): boolean {
  const normalized = normalizeIp(address);
  const family = isIP(normalized);
  if (!family) return false;

  const base = options.baseUrl ?? targetUrl;
  const rawHost = hostOfUrl(base);
  if (rawHost.toLowerCase() === 'localhost') {
    return options.allowLocalhost === true && (address === '127.0.0.1' || address === '::1');
  }
  if (isPublicAddress(normalized)) return true;

  if (options.allowFakeIpProxy === true && isIP(rawHost) === 0 && isFakeIpProxyAddress(address)) {
    return true;
  }

  if (options.allowExplicitPrivateIp === true && isIP(rawHost) !== 0 && rawHost === address) {
    const rawFamily = isIP(address);
    return PRIVATE_LOCAL.check(address, rawFamily === 6 ? 'ipv6' : 'ipv4');
  }
  return false;
}

/**
 * 在发起连接前校验出站 URL 的协议、认证段、自身回打端口及字面量 IP / localhost 策略。
 * 默认不传入宽容项即处于严格公网模式。
 */
export function assertEgressUrl(url: URL, options: EgressPolicyOptions = {}): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressPolicyError('仅允许 http 或 https 出站请求', 'invalid_url');
  }
  if (url.username || url.password) {
    throw new EgressPolicyError('出站地址不能包含用户名或密码', 'credentials');
  }

  const rawHost = hostOfUrl(url);
  const normalizedHost = normalizeIp(rawHost);
  const hostLower = rawHost.toLowerCase();
  const blockedPorts = resolveBlockedPorts(options.blockedLocalPorts);
  const port = effectivePort(url);
  const isLocalLiteral = hostLower === 'localhost' || hostLower.endsWith('.localhost') || (isIP(normalizedHost) !== 0 && !isPublicAddress(normalizedHost));

  if (isLocalLiteral && blockedPorts.has(port)) {
    throw new EgressPolicyError('禁止出站请求连接本机 AI Console 服务端口', 'blocked_local_port');
  }

  if (hostLower === 'localhost' || hostLower.endsWith('.localhost')) {
    if (!(hostLower === 'localhost' && options.allowLocalhost === true)) {
      throw new EgressPolicyError('出站策略禁止访问本机回环域名', 'blocked_address');
    }
    return;
  }

  if (isIP(normalizedHost) !== 0 && !isAddressAllowed(url, rawHost, options)) {
    throw new EgressPolicyError('出站地址被网络规则拒绝', 'blocked_address');
  }
}

/**
 * 构造固定单次 DNS-pinned 的 lookup 回调：
 * 强制以 `{ all: true }` 读取全部 A/AAAA 候选地址；只要存在任意越权记录或回打 Gateway 端口即整次拒绝。
 */
export function createPinnedLookup(
  targetUrl: URL,
  options: EgressPolicyOptions = {},
  resolver: typeof lookup = lookup,
  onReject?: (error: EgressPolicyError, reason: EgressRejectReason) => Error,
): typeof lookup {
  const base = options.baseUrl ?? targetUrl;
  const blockedPorts = resolveBlockedPorts(options.blockedLocalPorts);
  const port = effectivePort(targetUrl);

  return ((host: string, lookupOptionsOrCb: unknown, maybeCb?: unknown) => {
    const callback = (typeof lookupOptionsOrCb === 'function' ? lookupOptionsOrCb : maybeCb) as (
      err: NodeJS.ErrnoException | null,
      address: unknown,
      family?: number,
    ) => void;
    const lookupOptions = typeof lookupOptionsOrCb === 'object' && lookupOptionsOrCb !== null
      ? (lookupOptionsOrCb as Parameters<typeof lookup>[1])
      : {};
    const wantAll = Boolean((lookupOptions as { all?: boolean }).all);

    resolver(host, { ...lookupOptions, all: true }, (err, rawAddresses) => {
      const addresses = Array.isArray(rawAddresses) ? rawAddresses : [];
      if (err || !addresses.length) {
        const policyError = new EgressPolicyError('域名解析失败或没有可用地址', 'dns_failed');
        callback(onReject ? onReject(policyError, 'dns_failed') : policyError, wantAll ? [] : '', 4);
        return;
      }

      if (blockedPorts.has(port) && addresses.some((a) => !isPublicAddress(a.address))) {
        const policyError = new EgressPolicyError('禁止出站请求连接本机 AI Console 服务端口', 'blocked_local_port');
        callback(onReject ? onReject(policyError, 'blocked_local_port') : policyError, wantAll ? [] : '', 4);
        return;
      }

      if (addresses.some((a) => !isAddressAllowed(base, a.address, options))) {
        const isFakeIpHint =
          !options.allowFakeIpProxy &&
          addresses.some((a) => isFakeIpProxyAddress(a.address)) &&
          addresses.every((a) => isFakeIpProxyAddress(a.address) || isAddressAllowed(base, a.address, { ...options, allowFakeIpProxy: false }));
        const reason: EgressRejectReason = isFakeIpHint ? 'fake_ip_proxy' : 'blocked_address';
        const message = isFakeIpHint
          ? '域名解析到本机代理的 fake-ip 网段（198.18.x），可在设置里允许'
          : '域名解析到受限地址';
        const policyError = new EgressPolicyError(message, reason);
        callback(onReject ? onReject(policyError, reason) : policyError, wantAll ? [] : '', 4);
        return;
      }

      const chosen = addresses[0]!;
      if (wantAll) {
        callback(null, addresses);
      } else {
        callback(null, chosen.address, chosen.family);
      }
    });
  }) as typeof lookup;
}
