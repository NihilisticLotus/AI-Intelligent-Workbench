// 日志与错误文本脱敏（phase-1.md 6.2.1）。stderr 进日志前、事件里的 error.message 都要经过这里。
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+\S+/gi,
  /((?:api[_-]?key|token|secret|password)\W*[:=]\s*)\S+/gi,
];

/** 把 text 里的密钥替换成 ***。extra：本次启动注入的密钥原文（太短的不处理，避免误伤） */
export function redact(text: string, extra: readonly string[] = []): string {
  let out = text;
  for (const s of extra) {
    if (s && s.length >= 6) out = out.split(s).join('***');
  }
  out = out.replace(PATTERNS[0]!, '***');
  out = out.replace(PATTERNS[1]!, 'Bearer ***');
  out = out.replace(PATTERNS[2]!, '$1***');
  return out;
}

/** 截断到 n 个字符 */
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** 只按密钥原文脱敏（不套用通用规则，免得把 Agent 回复里的 “password = …” 之类的正常内容也打码） */
export function redactExact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('***');
  return out;
}

/**
 * 流式内容脱敏：密钥可能被拆在两个分片里，所以每条流（按 key，例如 messageId）留一小段尾巴，
 * 等下一片到来或流结束（flush）时再一起处理。只有尾巴可能是某个密钥的开头时才扣留，其余立即放行。
 */
export class StreamRedactor {
  private held = new Map<string, string>();
  constructor(private secrets: readonly string[]) {}

  get active() { return this.secrets.some((s) => s && s.length >= 6); }

  /** 放进一片，返回现在可以发出去的部分（可能为空字符串） */
  push(key: string, text: string): string {
    if (!this.active) return text;
    const buf = redactExact((this.held.get(key) ?? '') + text, this.secrets);
    const keep = this.tailToHold(buf);
    if (keep > 0) this.held.set(key, buf.slice(buf.length - keep)); else this.held.delete(key);
    return buf.slice(0, buf.length - keep);
  }

  /** 结束一条流，返回扣留的尾巴 */
  flush(key: string): string {
    const h = this.held.get(key) ?? '';
    this.held.delete(key);
    return h;
  }

  /** 所有还有尾巴的流 */
  keys(): string[] { return [...this.held.keys()]; }

  /** buf 末尾最长的、恰好是某个密钥开头（但不是整个密钥）的那段长度 */
  private tailToHold(buf: string): number {
    let best = 0;
    for (const s of this.secrets) {
      if (!s || s.length < 6) continue;
      const max = Math.min(s.length - 1, buf.length);
      for (let n = max; n > best; n--) {
        if (buf.endsWith(s.slice(0, n))) { best = n; break; }
      }
    }
    return best;
  }
}
