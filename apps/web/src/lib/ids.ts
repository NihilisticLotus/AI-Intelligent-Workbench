// 客户端指令 id：用 getRandomValues 生成。
// 局域网 HTTP 页面可以使用 getRandomValues，randomUUID 需要安全上下文。
export function newOpId(prefix = 'c'): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `${prefix}_${hex}`;
}
