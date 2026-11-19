import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ErrorCode, type DeviceSource, type LanPairingCode, type LanPairingPending, type LanPairingRequest,
  type LanPairingResolution, type LanPairingStatus, type PairingCompleteBody,
} from '@aic/protocol';
import type { AuthService } from '../auth';
import type { EventStore } from '../events';
import { AppError, Errors } from '../util';

const MINUTE = 60_000;
const LOCK_DURATION = 15 * MINUTE;
const REQUEST_TTL = 2 * MINUTE;

interface Attempts {
  times: number[];
  failures: number;
  lockedUntil: number;
}

export class PairingAttempts {
  private readonly clients = new Map<string, Attempts>();
  private lastPruned = 0;
  constructor(private readonly clock: () => number = Date.now) {}

  async run<T>(ip: string, source: DeviceSource, run: () => Promise<T>): Promise<T> {
    const time = this.clock();
    if (time >= this.lastPruned + MINUTE) {
      this.lastPruned = time;
      for (const [key, record] of this.clients) {
        if (record.lockedUntil <= time && (record.times.at(-1) ?? 0) <= time - 24 * 60 * MINUTE) this.clients.delete(key);
      }
    }
    const key = `${source}:${ip.replace(/^::ffff:/i, '')}`;
    let record = this.clients.get(key);
    if (!record) {
      if (this.clients.size >= 4096) throw this.wait(time + MINUTE);
      record = { times: [], failures: 0, lockedUntil: 0 };
      this.clients.set(key, record);
    }
    if (record.lockedUntil > time) throw this.wait(record.lockedUntil, true);
    if (record.lockedUntil) {
      record.lockedUntil = 0;
      record.failures = 0;
    }
    record.times = record.times.filter((at) => at > time - MINUTE);
    if (record.times.length >= 5) throw this.wait(record.times[0]! + MINUTE);
    record.times.push(time);

    try {
      const result = await run();
      record.failures = 0;
      return result;
    } catch (error) {
      if (error instanceof AppError && error.status === 400 && ++record.failures >= 10) {
        record.lockedUntil = this.clock() + LOCK_DURATION;
        throw this.wait(record.lockedUntil, true);
      }
      throw error;
    }
  }

  private wait(retryAt: number, locked = false) {
    return new AppError(429, {
      code: locked ? ErrorCode.PairingLocked : ErrorCode.RateLimited,
      message: locked ? '配对连续失败次数太多，已暂时锁定' : '配对请求太频繁',
      hint: `请 ${Math.max(1, Math.ceil((retryAt - this.clock()) / 1000))} 秒后再试`, retryAt, actions: [],
    });
  }
}

interface RequestEntry {
  info: LanPairingRequest;
  status: 'pending' | 'claimed' | LanPairingResolution;
  replacing: string | null;
  timer: ReturnType<typeof setTimeout>;
}

export interface LanPairingOptions {
  clock?: () => number;
  requestTtlMs?: number;
}

function browserType(agent: string): string {
  if (/Edg(?:A|iOS)?\//.test(agent)) return 'Edge';
  if (/(?:Chrome|CriOS)\//.test(agent)) return 'Chrome';
  if (/(?:Firefox|FxiOS)\//.test(agent)) return 'Firefox';
  if (/Safari\//.test(agent)) return 'Safari';
  return '浏览器';
}

export class LanPairing {
  private readonly clock: () => number;
  private readonly ttl: number;
  readonly attempts: PairingAttempts;
  private code: (LanPairingCode & { failures: number }) | null = null;
  private readonly requests = new Map<string, RequestEntry>();
  private readonly localPages = new Set<symbol>();

  constructor(private readonly auth: AuthService, private readonly events: EventStore,
    private readonly address: () => string | null, private readonly log: (message: string) => void, options: LanPairingOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.ttl = options.requestTtlMs ?? REQUEST_TTL;
    this.attempts = new PairingAttempts(this.clock);
  }

  hasLocalPage(): boolean { return this.localPages.size > 0; }

  registerLocalPage(): () => void {
    const id = Symbol();
    this.localPages.add(id);
    return () => {
      if (!this.localPages.delete(id) || this.hasLocalPage()) return;
      for (const request of this.requests.values()) if (request.status === 'pending') this.resolve(request, 'unavailable');
    };
  }

  issue(): LanPairingCode {
    const address = this.address();
    if (!address) throw Errors.invalidState('请先在这台电脑上开启局域网访问');
    if (this.code?.address !== address || this.code.expiresAt <= this.clock()) {
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      this.code = { code, address, expiresAt: this.clock() + REQUEST_TTL, failures: 0 };
    }
    const { code, expiresAt } = this.code;
    return { code, expiresAt, address };
  }

  submit(ip: string, userAgent: string, body: PairingCompleteBody, replacing: string | null): LanPairingPending {
    if (body.kind !== 'browser' || body.tokenDelivery !== 'cookie') throw Errors.badRequest('局域网配对只支持浏览器');
    const code = this.code;
    const time = this.clock();
    if (!code || code.expiresAt <= time || !/^\d{6}$/.test(body.code) ||
      !timingSafeEqual(Buffer.from(code.code), Buffer.from(body.code))) {
      if (code && code.expiresAt > time && ++code.failures >= 5) this.code = null;
      throw Errors.pairingInvalid('配对码不正确或已过期', '请在电脑上点击“配对新设备”获取有效配对码');
    }
    this.code = null;
    if (!this.hasLocalPage()) throw Errors.conflict('电脑上没有打开已连接的工作台', '请在电脑上打开工作台，再生成配对码');

    for (const [id, request] of this.requests) {
      if (request.info.expiresAt + REQUEST_TTL > time) continue;
      clearTimeout(request.timer);
      this.requests.delete(id);
    }
    const id = `lp_${randomBytes(24).toString('base64url')}`;
    const info = { id, name: body.deviceName, browser: browserType(userAgent), ip, expiresAt: time + this.ttl };
    const timer = setTimeout(() => this.expire(id), this.ttl);
    timer.unref();
    this.requests.set(id, { info, status: 'pending', replacing, timer });
    try { this.events.append({ taskId: null, sessionId: null, type: 'pairing.requested', data: info }); } catch (error) {
      clearTimeout(timer);
      this.requests.delete(id);
      throw error;
    }
    this.log('有新设备请求连接，请在本机页面确认');
    return { status: 'pending', id, expiresAt: info.expiresAt };
  }

  decide(id: string, allow: boolean) {
    const request = this.lookup(id);
    if (request.status !== 'pending') throw Errors.invalidState('这条配对请求已处理或已失效');
    this.resolve(request, allow ? 'allowed' : 'rejected');
  }

  status(id: string, ip: string): { body: LanPairingStatus; token?: string } {
    const request = this.lookup(id, ip);
    switch (request.status) {
      case 'pending': return { body: { status: 'pending', id, expiresAt: request.info.expiresAt } };
      case 'allowed': {
        const { device, key, token } = this.auth.issueDevice(ip, {
          deviceName: request.info.name, kind: 'browser', tokenDelivery: 'cookie',
        }, request.replacing, 'lan');
        if (!key) throw Errors.internal('没有生成浏览器设备密钥');
        request.status = 'claimed';
        clearTimeout(request.timer);
        return { body: { status: 'paired', device, key }, token };
      }
      default: return { body: { status: request.status } };
    }
  }

  isPending(id: string): boolean {
    const entry = this.requests.get(id);
    return entry?.status === 'pending' && entry.info.expiresAt > this.clock();
  }

  closeLan() {
    this.code = null;
    for (const request of this.requests.values()) {
      if (request.status === 'pending') this.resolve(request, 'unavailable');
      if (request.status === 'allowed') {
        request.status = 'unavailable';
        clearTimeout(request.timer);
      }
    }
  }

  stop() {
    this.code = null;
    for (const request of this.requests.values()) clearTimeout(request.timer);
    this.requests.clear();
    this.localPages.clear();
  }

  private lookup(id: string, ip?: string): RequestEntry {
    const request = this.requests.get(id);
    if (!request || (ip !== undefined && request.info.ip !== ip)) throw Errors.notFound('找不到这条配对请求');
    if (request.info.expiresAt <= this.clock()) this.expire(id);
    return request;
  }

  private expire(id: string) {
    const request = this.requests.get(id);
    if (request?.status === 'pending') this.resolve(request, 'expired');
    if (request?.status === 'allowed') {
      request.status = 'expired';
      clearTimeout(request.timer);
    }
  }

  private resolve(request: RequestEntry, status: LanPairingResolution) {
    request.status = status;
    if (status !== 'allowed') clearTimeout(request.timer);
    try {
      this.events.append({ taskId: null, sessionId: null, type: 'pairing.resolved', data: { id: request.info.id, status } });
    } catch { this.log('无法记录局域网配对结果，请在设备与访问中核对'); }
  }
}
