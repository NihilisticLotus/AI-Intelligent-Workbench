// 鉴权：配对码、设备令牌、Host / Origin 校验、配对限流（design.md 16.3、16.4）。
// 令牌是随机 256 位，库里只存 SHA-256 哈希。没有“本机免验证”的例外。
//
// 两种凭据：
//  - bearer（桌面 / 手机应用、脚本）：Authorization: Bearer <令牌>，库里存 sha256(令牌)。
//  - cookie（浏览器）：HttpOnly Cookie 里放令牌，另有一把“设备密钥”由网页存在按源（含端口）隔离的本地存储里，
//    每个请求放在 X-AIC-Key 头（WebSocket 用子协议）。库里存 sha256('c:' + 令牌 + ':' + 密钥)。
//    浏览器不按端口隔离 Cookie，同机其他端口的服务能收到 Cookie，但拿不到密钥，单有 Cookie 无法通过；
//    把 Cookie 值当 Bearer 令牌用也对不上哈希。
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  KEY_HEADER, sessionCookieName, WS_BEARER_PROTOCOL_PREFIX, WS_KEY_PROTOCOL_PREFIX,
  type Device, type DeviceKind, type PairingCompleteBody,
} from '@aic/protocol';
import type { Db } from './db';
import { Errors, newId, now } from './util';

export const TOKEN_IDLE_TTL_MS = 30 * 24 * 3600_000; // 30 天未使用自动失效
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export interface PairingLimits {
  /** 每个配对码最多允许输错几次，超过后作废，需要重新生成 */
  maxFailuresPerCode: number;
  /** 两次“生成新码”之间的最短间隔；配对码因输错作废后间隔翻倍（防暴力猜码），配对成功后复原 */
  startIntervalMs: number;
  /** 间隔翻倍的上限 */
  maxStartIntervalMs: number;
}

export interface AuthOptions {
  /** 配对码有效期，默认 2 分钟 */
  pairingTtlMs?: number;
  /** 开发时允许的额外 Origin（Vite 地址），逗号分隔 */
  devOrigin?: string | undefined;
  /** 配对限流参数 */
  limits?: Partial<PairingLimits>;
  /** 生成新配对码（或重新打印现有配对码）时回调：打印到终端 */
  onPairingCode?: (code: string, expiresAt: number) => void;
  /** 实例标识：决定 Cookie 名，同机不同数据目录的 Gateway 互不覆盖 */
  instanceId?: string;
}

export type DeviceRow = {
  id: string; name: string; kind: DeviceKind; token_hash: string;
  last_ip: string | null; last_seen: number | null; paired_at: number; revoked: number;
};

/** 从请求里取出的凭据（还没校验） */
export interface RequestCredentials {
  cookie?: string | null | undefined;
  authorization?: string | null | undefined;
  /** X-AIC-Key 头 */
  key?: string | null | undefined;
  /** WebSocket 握手的 Sec-WebSocket-Protocol */
  protocols?: string | null | undefined;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const bearerHash = (token: string) => sha256(token);
const cookieHash = (token: string, key: string) => sha256(`c:${token}:${key}`);

/** 是否是本机回环地址（含 IPv4 映射到 IPv6 的写法） */
export function isLoopback(ip: string | undefined | null): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k && !(k in out)) {
      try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
  }
  return out;
}

export class AuthService {
  private port = 0;
  /** 当前配对码：明文只留在内存里，用于“重新生成”时在终端重新打印同一个码 */
  private pairing: { code: string; hash: string; expiresAt: number; failures: number } | null = null;
  private lastIssuedAt = 0;
  private interval: number;
  private readonly ttl: number;
  private readonly devOrigins: string[];
  private readonly limits: PairingLimits;
  readonly cookieName: string;
  private revokeListeners = new Set<(deviceId: string) => void>();

  constructor(private db: Db, private opts: AuthOptions = {}) {
    this.ttl = opts.pairingTtlMs ?? 120_000;
    this.devOrigins = (opts.devOrigin ?? '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
    this.limits = { maxFailuresPerCode: 5, startIntervalMs: 10_000, maxStartIntervalMs: 10 * 60_000, ...opts.limits };
    this.interval = this.limits.startIntervalMs;
    this.cookieName = sessionCookieName(opts.instanceId ?? 'default');
  }

  setPort(port: number) { this.port = port; }

  // ---------- Host / Origin ----------

  /** 只接受 127.0.0.1:<端口> 或 localhost:<端口>，防 DNS 重绑定 */
  checkHost(host: string | undefined | null): boolean {
    if (!host) return false;
    const h = host.toLowerCase();
    return h === `127.0.0.1:${this.port}` || h === `localhost:${this.port}`;
  }

  /** 没有 Origin 视为非浏览器客户端（由令牌把关）；有 Origin 时必须同源或是开发用的 Vite 地址 */
  checkOrigin(origin: string | undefined | null): boolean {
    if (origin == null || origin === '') return true;
    const o = origin.toLowerCase().replace(/\/$/, '');
    if (o === `http://127.0.0.1:${this.port}` || o === `http://localhost:${this.port}`) return true;
    return this.devOrigins.some((d) => d.toLowerCase() === o);
  }

  // ---------- 配对码 ----------

  /** 生成新的一次性配对码（旧码立即作废）。启动时调用；网页请求走 requestPairingCode */
  newPairingCode(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = now() + this.ttl;
    this.pairing = { code, hash: sha256(code), expiresAt, failures: 0 };
    this.lastIssuedAt = now();
    this.opts.onPairingCode?.(code, expiresAt);
    return { code, expiresAt };
  }

  /**
   * 网页上的 [重新生成配对码]：只允许本机请求。
   * - 现有配对码还没过期：不换码，只在终端重新打印一次（别的程序反复调用也作废不了用户正在看的码）；
   * - 否则距上次生成不足最短间隔时拒绝，间隔在配对码因输错作废后翻倍。
   */
  requestPairingCode(ip: string): { expiresAt: number } {
    if (!isLoopback(ip)) throw Errors.forbidden('只能在这台电脑上重新生成配对码');
    const t = now();
    const p = this.pairing;
    if (p && p.expiresAt > t) {
      this.opts.onPairingCode?.(p.code, p.expiresAt);
      return { expiresAt: p.expiresAt };
    }
    const wait = this.lastIssuedAt + this.interval - t;
    if (wait > 0) {
      throw Errors.rateLimited('刚刚生成过配对码', `请 ${Math.ceil(wait / 1000)} 秒后再试`);
    }
    return { expiresAt: this.newPairingCode().expiresAt };
  }

  /**
   * 完成配对。replacingDeviceId：发起请求时已经带着有效凭据的设备（同一个浏览器重新配对），
   * 新设备建好后吊销它，避免旧令牌无人持有却一直有效、设备列表越积越多。
   */
  completePairing(ip: string, body: PairingCompleteBody, replacingDeviceId: string | null = null): { device: Device; token: string; key?: string } {
    const p = this.pairing;
    const t = now();
    const given = Buffer.from(sha256(body.code.trim()), 'hex');
    const ok = !!p && p.expiresAt > t && timingSafeEqual(given, Buffer.from(p.hash, 'hex'));
    if (!ok) {
      // 失败次数按配对码计数：输错太多次这个码就作废，而不是把整个 127.0.0.1 锁住
      if (p && p.expiresAt > t && ++p.failures >= this.limits.maxFailuresPerCode) {
        this.pairing = null;
        this.interval = Math.min(this.limits.maxStartIntervalMs, Math.max(1, this.interval) * 2);
        throw Errors.pairingInvalid('配对码输错次数太多，已经作废', '请重新生成配对码', [
          { label: '重新生成配对码', action: 'pairing.start' },
        ]);
      }
      throw Errors.pairingInvalid('配对码不正确或已过期', '配对码 2 分钟内有效且只能用一次，请重新生成', [
        { label: '重新生成配对码', action: 'pairing.start' },
      ]);
    }
    // 一次性：用过立即作废；成功配对后限流间隔复原
    this.pairing = null;
    this.interval = this.limits.startIntervalMs;
    const token = randomBytes(32).toString('base64url');
    const key = body.tokenDelivery === 'cookie' ? randomBytes(32).toString('base64url') : undefined;
    const id = newId('d');
    this.db.tx(() => {
      this.db.run(
        'INSERT INTO devices (id, name, kind, token_hash, last_ip, last_seen, paired_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
        id, body.deviceName, body.kind, key ? cookieHash(token, key) : bearerHash(token), ip, t, t,
      );
      this.audit(id, 'device.paired', `${body.kind} ${body.deviceName} ${ip}`);
    });
    if (replacingDeviceId && replacingDeviceId !== id) {
      try { this.revoke(replacingDeviceId, id, 'device.replaced'); } catch { /* 已经不在了 */ }
    }
    return { device: this.toDevice(this.deviceRow(id)!, id), token, ...(key ? { key } : {}) };
  }

  // ---------- 令牌 ----------

  sessionCookie(token: string, maxAgeSec: number): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
  }

  /** 从请求里取凭据，算出要在库里查的哈希；凭据不完整时返回 null */
  credentialHash(c: RequestCredentials): string | null {
    const protocols = (c.protocols ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const fromProto = (prefix: string) => protocols.find((p) => p.startsWith(prefix))?.slice(prefix.length) || null;
    const valid = (s: string | null | undefined): s is string => !!s && s.length <= 200;

    if (c.authorization) {
      const m = /^Bearer\s+(\S+)$/i.exec(c.authorization.trim());
      return m && valid(m[1]) ? bearerHash(m[1]) : null;
    }
    const bearer = fromProto(WS_BEARER_PROTOCOL_PREFIX);
    if (bearer) return valid(bearer) ? bearerHash(bearer) : null;
    // Cookie 必须和设备密钥一起出现
    const cookie = parseCookies(c.cookie)[this.cookieName];
    const key = c.key ?? fromProto(WS_KEY_PROTOCOL_PREFIX);
    if (valid(cookie) && valid(key)) return cookieHash(cookie, key);
    return null;
  }

  /** 校验凭据，返回设备；无效时返回 null */
  authenticate(c: RequestCredentials, ip: string | null): DeviceRow | null {
    const hash = this.credentialHash(c);
    if (!hash) return null;
    const row = this.db.get<DeviceRow>('SELECT * FROM devices WHERE token_hash = ? AND revoked = 0', hash);
    if (!row) return null;
    const t = now();
    if (row.last_seen != null && t - row.last_seen > TOKEN_IDLE_TTL_MS) return null;
    if (row.last_seen == null || t - row.last_seen > LAST_SEEN_WRITE_INTERVAL_MS || row.last_ip !== ip) {
      this.db.run('UPDATE devices SET last_seen = ?, last_ip = ? WHERE id = ?', t, ip, row.id);
      row.last_seen = t; row.last_ip = ip;
    }
    return row;
  }

  // ---------- 设备 ----------

  deviceRow(id: string) { return this.db.get<DeviceRow>('SELECT * FROM devices WHERE id = ?', id); }
  deviceName(id: string | null): string | null { return id ? this.deviceRow(id)?.name ?? null : null; }

  toDevice(r: DeviceRow, currentId: string | null): Device {
    return { id: r.id, name: r.name, kind: r.kind, lastIp: r.last_ip, lastSeen: r.last_seen, pairedAt: r.paired_at, current: r.id === currentId };
  }

  listDevices(currentId: string | null): Device[] {
    return this.db.all<DeviceRow>('SELECT * FROM devices WHERE revoked = 0 ORDER BY paired_at DESC').map((r) => this.toDevice(r, currentId));
  }

  revoke(id: string, byDevice: string, action = 'device.revoked') {
    const r = this.db.run('UPDATE devices SET revoked = 1 WHERE id = ? AND revoked = 0', id);
    if (r.changes === 0) throw Errors.notFound('找不到这个设备', '它可能已经被吊销');
    this.audit(byDevice, action, id);
    for (const fn of this.revokeListeners) fn(id);
  }

  onRevoke(fn: (deviceId: string) => void) { this.revokeListeners.add(fn); }

  audit(deviceId: string | null, action: string, detail: string) {
    this.db.run('INSERT INTO audit_log (device_id, action, detail, ts) VALUES (?, ?, ?, ?)', deviceId, action, detail, now());
  }
}

/** 请求头里的设备密钥头名（小写，Node 的 headers 对象用） */
export const KEY_HEADER_LC = KEY_HEADER.toLowerCase();
