// 适配器包内的通用小工具。Gateway 也从这里引用 AbortError，保证 instanceof 判断在两个包之间一致。
import { randomBytes } from 'node:crypto';

/** 不透明 ID：前缀 + 随机串 */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export const now = () => Date.now();

export class AbortError extends Error {
  constructor() { super('已取消'); this.name = 'AbortError'; }
}

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AbortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** 给 Promise 加超时；超时后调用 onTimeout（例如结束进程树）并以 err 拒绝 */
export function withTimeout<T>(p: Promise<T>, ms: number, err: () => Error, onTimeout?: () => void): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      try { onTimeout?.(); } catch { /* 忽略 */ }
      reject(err());
    }, ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
