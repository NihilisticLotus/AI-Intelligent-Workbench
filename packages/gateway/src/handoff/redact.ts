const sensitiveFile = /(?:^|[\s/\\'"=:(])\.env(?:\.[\w.-]+)?(?=$|[\s/\\'":,;)\]])/i;
export const isEnvSource = (source: string) => sensitiveFile.test(source);

/** 环境文件中的赋值可能被随后消息引用；整份材料使用相同的打码集合。 */
export function environmentValues(outputs: string[]): string[] {
  const values = new Set<string>();
  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const literal=line.trim();
      if(literal) values.add(literal);
    }
    for (const match of output.matchAll(/^\s*(?:export\s+)?[\w.-]+\s*=\s*([^\r\n]+)/gm)) {
      const value = match[1]!.trim().replace(/^["']|["']$/g,'');
      if (value) values.add(value);
    }
  }
  return [...values];
}

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
  private literals = new Map<string,string>();
  private literalPattern: RegExp | undefined;
  constructor(keys: readonly string[], environment: readonly string[] = [], aliases: ReadonlyMap<string,string> = new Map()) {
    const credentials = new Set(keys.filter(Boolean));
    const alternatives: string[] = [];
    const labels = new Set(aliases.values());
    for (const value of [...new Set([...credentials,...environment,...labels])].filter(Boolean).sort((a,b)=>b.length-a.length)) {
      const literal = value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      // 普通配置的短值按完整词匹配；凭据始终打码，即使嵌在其他文本中。
      const short = !credentials.has(value) && /^[a-zA-Z0-9_]{1,4}$/.test(value);
      alternatives.push(short ? '(?<![A-Za-z0-9_])'+literal+'(?![A-Za-z0-9_])' : literal);
      this.literals.set(value,aliases.get(value) ?? (labels.has(value) && !credentials.has(value) ? value : '***'));
    }
    if (alternatives.length) this.literalPattern = new RegExp(alternatives.join('|'),'g');
  }
  text(input: string, source?: string): string {
    if (!input) return input;
    if (source && isEnvSource(source)) {
      this.count++;
      return '（环境文件内容已打码）';
    }
    let result = input;
    if (this.literalPattern) result = input.replace(this.literalPattern,match=>{
      const replacement=this.literals.get(match)!;
      if (replacement!==match) this.count++;
      return replacement;
    });
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
