const sensitiveFile = /(?:^|[\s/\\'"=:(])\.env(?:\.[\w.-]+)?(?=$|[\s/\\'":,;)\]])/i;
export const isEnvSource = (source: string) => sensitiveFile.test(source);

const patterns = [
  /\x60{3}(?:dotenv|\.env(?:\.[\w.-]+)?|env)[^\n]*\n[\s\S]*?(?:\x60{3}|$)/gi,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  /\b(?:sk-[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9_]{16,}|github_pat_[a-zA-Z0-9_]{16,}|AKIA[A-Z0-9]{16}|AIza[a-zA-Z0-9_-]{30,})\b/g,
  /(\bBearer\s+)[^\s"',;]+/gi,
  /((?:api[_-]?key|token|password|secret|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
  /^(\s*(?:export\s+)?[A-Z_][A-Z_0-9]*\s*=\s*).+$/gm,
];

/** 计数对应打码动作，已打码的片段重复经过同一规则时不重复计数。 */
export class HandoffRedactor {
  count = 0;
  constructor(private keys: readonly string[]) {}
  text(input: string, source?: string): string {
    if (!input) return input;
    if (source && isEnvSource(source)) {
      this.count++;
      return '（环境文件内容已打码）';
    }
    let result = input;
    for (const key of new Set(this.keys.filter(Boolean).sort((a,b)=>b.length-a.length))) {
      const pieces = result.split(key);
      this.count += pieces.length - 1;
      result = pieces.join('***');
    }
    for (const pattern of patterns) {
      result = result.replace(pattern,(match, first: unknown) => {
        const prefix = typeof first === 'string' ? first : '';
        if (match === prefix+'***') return match;
        this.count++;
        return prefix+'***';
      });
    }
    return result;
  }
}
