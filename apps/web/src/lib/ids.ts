// 客户端指令 id：用 getRandomValues 生成。
// 不用 crypto.randomUUID，因为以后通过局域网 http 访问时页面不是安全上下文，randomUUID 不可用。
export function newOpId(prefix = 'c'): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${prefix}_${hex}`;
}
