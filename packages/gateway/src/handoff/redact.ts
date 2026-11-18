const sensitiveFile = /(?:^|[\s/\\'"=:(])\.env(?:\.[^\s/\\'":,;)\]]*)?(?=$|[\s/\\'":,;)\]])/i;
export const isEnvSource = (source: string) => sensitiveFile.test(source);

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|PRIVATE|DSN|COOKIE|SESSION)/i;
const COMMON =/^(?:true|false|yes|no|on|off|null|none|nil|undefined|dev|development|prod|production|test|testing|staging|local|localhost|debug|info|warn|warning|error|utf-?8|0\.0\.0\.0|127\.0\.0\.1|::1)$/i;
/** 开关、端口、环境名、本机地址和过短的值到处都会出现，全局打码只会毁掉无关文本（1.6 代码审查）。 */
export function worthMasking(value: string) {
  if (value.length < 6 || COMMON.test(value) || /^[\d\s.,:_+-]+$/.test(value)) return false;
  return !/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?\/?$/i.test(value);
}

/** 环境文件中的赋值可能被随后消息引用；整份材料使用相同的打码集合。 */
export function environmentValues(outputs: string[]): string[] {
  const values = new Set<string>();
  for (const output of outputs) {
    for (const line of output.split(/\r?\n/)) {
      const literal=line.trim();
      // 赋值行只打码值（见下）；注释与普通配置值不进入全局打码集合。
      if(literal && !literal.startsWith('#') && !/^(?:export\s+)?[\w.-]+\s*=/.test(literal) && worthMasking(literal)) values.add(literal);
    }
    for (const match of output.matchAll(/^\s*(?:export\s+)?([\w.-]+)\s*=\s*([^\r\n]+)/gm)) {
      const raw = match[2]!.trim();
      const quoted = /^(["'])(.*?)\1(?:\s*#.*)?$/.exec(raw);
      const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/,'').trim();
      // 名称像密钥的变量即使值很短也打码。
      if (value && (worthMasking(value) || SECRET_NAME.test(match[1]!))) values.add(value);
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
  // 只有名称像密钥的环境变量赋值整行打码；NODE_ENV=production 之类保持原样。
  /^(\s*(?:export\s+)?[A-Z_0-9]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|AUTH|PRIVATE|DSN|COOKIE|SESSION)[A-Z_0-9]*\s*=\s*).+$/gm,
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
