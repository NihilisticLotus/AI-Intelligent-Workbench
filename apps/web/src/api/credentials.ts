// 设备凭据：配对结果的保存、启动时载入、请求头和 WebSocket 子协议的生成、失效时清除。
// 和运行环境无关：存哪里由 Platform.secureStorage 决定，要哪种凭据由 Platform.tokenDelivery 决定。
//  - cookie（浏览器）：令牌在 HttpOnly Cookie 里（脚本读不到），设备密钥存在本地存储，放进 X-AIC-Key 头；
//  - bearer（桌面 / 手机）：令牌存在安全存储，放进 Authorization: Bearer。
// WebSocket 不能自定义请求头：凭据经子协议传递（aic-key.<密钥> 或 aic-bearer.<令牌>），并总带上 aic.v1。
import {
  KEY_HEADER, WS_BEARER_PROTOCOL_PREFIX, WS_KEY_PROTOCOL_PREFIX, WS_SUBPROTOCOL, type PairingCompleteResult,
} from '@aic/protocol';
import type { SecureStorage } from '../platform/types';

const STORE_KEY = 'credential';

export class Credentials {
  /** 启动时从安全存储读进内存；之后同步使用 */
  private value: string | null = null;
  private loaded = false;

  constructor(private storage: SecureStorage, readonly delivery: 'cookie' | 'bearer') {}

  async load(): Promise<void> {
    try { this.value = await this.storage.get(STORE_KEY); } catch { this.value = null; }
    this.loaded = true;
  }

  get isLoaded() { return this.loaded; }
  /** 本地有没有凭据（cookie 方式下只说明有密钥，Cookie 是否还在要问服务端） */
  get has() { return !!this.value; }

  /** 配对成功后保存服务端返回的密钥或令牌 */
  async save(r: PairingCompleteResult): Promise<void> {
    const v = this.delivery === 'cookie' ? r.key : r.token;
    this.value = v ?? null;
    if (v) await this.storage.set(STORE_KEY, v);
    else await this.storage.remove(STORE_KEY);
  }

  /** 令牌失效或设备被吊销时清掉 */
  async clear(): Promise<void> {
    this.value = null;
    try { await this.storage.remove(STORE_KEY); } catch { /* 忽略 */ }
  }

  headers(): Record<string, string> {
    if (!this.value) return {};
    return this.delivery === 'cookie' ? { [KEY_HEADER]: this.value } : { authorization: `Bearer ${this.value}` };
  }

  wsProtocols(): string[] {
    if (!this.value) return [WS_SUBPROTOCOL];
    return [WS_SUBPROTOCOL, (this.delivery === 'cookie' ? WS_KEY_PROTOCOL_PREFIX : WS_BEARER_PROTOCOL_PREFIX) + this.value];
  }
}
