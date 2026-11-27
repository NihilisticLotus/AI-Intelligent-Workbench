// 技能包（Skills）YAML Frontmatter 解析与全包静态安全扫描器（第 2.4 步）：
// 扫描 SKILL.md 及包内全部 references/、scripts/、assets/ 文本文件，识别 6 大类指令/供应链威胁与附带脚本，
// 输出风险等级（safe / warn / danger）与精确的文件名、行号、中文风险说明及可视化的脱敏摘录。
import { createHash } from 'node:crypto';
import { SkillScanReport, type SkillFileEntry, type SkillFindingCategory, type SkillRiskLevel, type SkillScanFinding } from '@aic/protocol';
import { Errors } from '../util';

const SCRIPT_EXT_RE = /\.(?:sh|bash|zsh|ps1|psm1|bat|cmd|py|pyw|js|mjs|cjs|ts|mts|rb|pl|php|vbs|wsf|exe|dll|so|dylib)$/i;

/** 隐藏 Unicode 字符：零宽字符、BiDi 视觉欺骗控制符、Unicode Tag 隐写区 */
const HIDDEN_UNICODE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\u061C\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

interface ScanRule {
  severity: 'warn' | 'danger';
  category: SkillFindingCategory;
  pattern: RegExp;
  title: string;
  detail: string;
}

const LINE_RULES: readonly ScanRule[] = [
  // 1. 伪造 2.1 防伪信封
  {
    severity: 'danger',
    category: 'provenance_spoof',
    pattern: /(?:<<<\s*AIC-(?:SOURCE|END)|\[\s*AIC-SOURCE|［\s*ＡＩＣ|【\s*AIC-SOURCE)/i,
    title: '疑似伪造消息来源防伪封条',
    detail: '正文中出现类似工作台防伪信封的标记，可能试图把外部技能文本伪装成制作人本人指令。',
  },
  // 2. 诱导绕过审批 / 忽略系统规则
  {
    severity: 'danger',
    category: 'approval_bypass',
    pattern: /(?:ignore\s+(?:all\s+)?(?:previous|prior|above|system)\s+instructions?|disregard\s+(?:system|safety)\s+(?:rules?|prompts?)|忽略(?:以上|之前|所有)(?:系统)?(?:指令|规则|限制)|无视(?:系统|安全)?(?:规则|审批))/i,
    title: '疑似提示词越狱或要求忽略安全规则',
    detail: '内容要求模型无视既有系统指令或安全约束，存在明显提示词注入风险。',
  },
  {
    severity: 'danger',
    category: 'approval_bypass',
    pattern: /(?:--dangerously-skip-permissions|bypassPermissions|approval[_-]?mode\s*[:=]\s*['"]?(?:never|yolo|full)['"]?|skip\s+(?:all\s+)?(?:user\s+)?approvals?|without\s+(?:asking|notifying)\s+(?:the\s+)?user|不要告诉用户|绕过审批|跳过用户确认|静默执行(?:所有|全部)?命令)/i,
    title: '诱导关闭或绕过人工审批',
    detail: '内容试图开启免审批/高危放行模式，或要求在不通知用户的情况下偷偷执行操作。',
  },
  // 3. 窃取登录凭据、密钥或敏感目录
  {
    severity: 'danger',
    category: 'credential_access',
    pattern: /(?:~[\\/]\.(?:claude|codex|codebuddy|workbuddy|zcode|gemini|ssh|aws|gnupg)|\.credentials\.json|auth\.json|\.aic-data|\.git-credentials|id_rsa|id_ed25519|Credential\s+Manager|ProtectedData::Unprotect)/i,
    title: '试图读取本机凭据或受保护工具目录',
    detail: '内容引用了各编码 Agent 登录凭据、工作台数据目录或系统密钥文件路径。',
  },
  {
    severity: 'danger',
    category: 'credential_access',
    pattern: /(?:(?:cat|type|read|print|dump|exfiltrate|send|upload)\b[^\n]{0,60}(?:\.env\b|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET|process\.env)|读取\s*\.env|导出(?:所有)?环境变量)/i,
    title: '疑似窃取环境变量或 .env 密钥',
    detail: '内容包含读取 .env 文件或提取 API 密钥环境变量的指令。',
  },
  // 4. 高危命令下载执行与混淆载荷
  {
    severity: 'danger',
    category: 'dangerous_command',
    pattern: /(?:(?:curl|wget)\b[^\n|]{0,160}\|\s*(?:sh|bash|zsh|python|node)\b|(?:iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^\n|]{0,160}\|\s*(?:iex|Invoke-Expression)\b|powershell(?:\.exe)?\s+[^\n]{0,60}-(?:e|enc|encodedcommand)\b|base64\s+(?:-d|--decode)[^\n|]{0,80}\|\s*(?:sh|bash)\b|eval\s*\(\s*(?:atob|Buffer\.from)\s*\()/i,
    title: '高危远程下载执行或编码混淆命令',
    detail: '检测到通过管道直接执行远程脚本、PowerShell 编码执行或 Base64 动态解码执行等高危手法。',
  },
  {
    severity: 'danger',
    category: 'dangerous_command',
    pattern: /(?:rm\s+-rf\s+(?:\/|~|\$HOME|\*)|Remove-Item\s+[^\n]{0,40}-Recurse[^\n]{0,40}-Force\s+(?:C:\\|~)|nc\s+-e\s+\/bin\/|bash\s+-i\s+>&\s*\/dev\/tcp)/i,
    title: '破坏性删盘或反弹 Shell 命令',
    detail: '检测到高破坏性删除命令或疑似反弹 Shell 语句。',
  },
  {
    severity: 'warn',
    category: 'dangerous_command',
    pattern: /(?:curl\s+[^\n]{0,120}(?:-d|--data|--upload-file|-F)\s|Invoke-RestMethod\s+[^\n]{0,80}-Method\s+Post)/i,
    title: '包含外部 HTTP 数据上传命令',
    detail: '指令或脚本包含向外发送数据的 HTTP POST/上传命令，请确认目标地址可信且不会外泄项目资料。',
  },
  // 5. 持久化记忆 / 全局规则后门
  {
    severity: 'warn',
    category: 'memory_backdoor',
    pattern: /(?:(?:append|write|inject|modify|edit)\b[^\n]{0,60}(?:CLAUDE\.md|AGENTS\.md|\.bashrc|\.zshrc|profile\.ps1|long-term memory|persistent memory)|偷偷(?:修改|写入)(?:项目规则|长期记忆|CLAUDE\.md|AGENTS\.md)|写入持久化指令)/i,
    title: '疑似试图持久化改写规则或长期记忆',
    detail: '内容要求修改全局规则文件或向长期记忆写入隐藏指令，即使删除该技能也可能残留影响。',
  },
];

export interface ParsedSkillFrontmatter {
  name: string | null;
  description: string | null;
  version: string | null;
  body: string;
}

function unquoteYaml(val: string): string {
  const trimmed = val.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** 解析标准 Agent Skills（agentskills.io）SKILL.md 的 YAML Frontmatter 与正文。 */
export function parseSkillFrontmatter(markdown: string): ParsedSkillFrontmatter {
  const clean = markdown.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(clean);
  let name: string | null = null;
  let description: string | null = null;
  let version: string | null = null;
  let body = clean;

  if (match) {
    const yaml = match[1] ?? '';
    body = clean.slice(match[0].length);
    const lines = yaml.split(/\r?\n/);
    let inMetadata = false;
    for (const rawLine of lines) {
      if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
      const top = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
      if (top) {
        const key = top[1]!.toLowerCase();
        const val = unquoteYaml(top[2] ?? '');
        inMetadata = key === 'metadata' && !val;
        if (key === 'name' && val) name = val.slice(0, 80);
        else if (key === 'description' && val) description = val.slice(0, 1024);
        else if (key === 'version' && val) version = val.slice(0, 64);
        continue;
      }
      if (inMetadata) {
        const sub = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine);
        if (sub && sub[1]!.toLowerCase() === 'version') {
          const val = unquoteYaml(sub[2] ?? '');
          if (val && !version) version = val.slice(0, 64);
        }
      }
    }
  }

  // 若 frontmatter 缺少 name/description，从正文首标题与首段温和回退提取
  if (!name) {
    const heading = /^#\s+(.+)$/m.exec(body);
    if (heading?.[1]) name = heading[1].trim().slice(0, 80);
  }
  if (!description) {
    for (const line of body.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('```') || t.startsWith('>')) continue;
      description = t.slice(0, 240);
      break;
    }
  }

  return { name, description, version, body };
}

/** 生成受控技能目录与检索用 slug（纯小写字母数字与短横线；纯中文名自动附带短哈希保证唯一）。 */
export function normalizeSkillSlug(raw: string): string {
  const ascii = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (ascii && ascii.length >= 2) return ascii;
  const hash = createHash('sha256').update(raw.trim() || 'skill').digest('hex').slice(0, 8);
  return `skill-${hash}`;
}

/** 校验并规范化技能包内相对路径（严禁路径穿越、盘符或绝对路径）。 */
export function normalizeRelativeSkillPath(rawPath: string): string {
  const normalized = rawPath.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.includes('\0')) {
    throw Errors.badRequest(`技能包内文件路径无效：${rawPath}`);
  }
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (!seg || seg === '.' || seg === '..') {
      throw Errors.badRequest(`技能包内文件路径不允许包含越界片段：${rawPath}`);
    }
  }
  const joined = segments.join('/');
  if (joined.length > 200) throw Errors.badRequest(`技能包内文件路径过长：${joined.slice(0, 60)}`);
  return joined;
}

export function isScriptSkillPath(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return lower.startsWith('scripts/') || SCRIPT_EXT_RE.test(lower);
}

export function classifySkillFile(relPath: string): SkillFileEntry['kind'] {
  const lower = relPath.toLowerCase();
  if (lower === 'skill.md') return 'skill';
  if (isScriptSkillPath(lower)) return 'script';
  if (lower.startsWith('references/') || lower.endsWith('.md') || lower.endsWith('.txt')) return 'reference';
  return 'asset';
}

/** 计算整个技能包的确定性内容哈希（用于导入去重与变更识别）。 */
export function computeSkillContentHash(files: ReadonlyArray<{ path: string; content: string }>): string {
  const h = createHash('sha256');
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    h.update(f.path);
    h.update('\0');
    h.update(f.content);
    h.update('\0');
  }
  return h.digest('hex');
}

function visualizeHiddenExcerpt(line: string): string {
  return line
    .replace(HIDDEN_UNICODE_RE, (ch) => `[U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}]`)
    .trim()
    .slice(0, 180);
}

/** 对整个技能包执行静态安全扫描，返回风险等级、脚本清单与精确到文件/行号的告警。 */
export function scanSkillPackage(
  files: ReadonlyArray<{ path: string; content: string }>,
  scannedAt = Date.now(),
): SkillScanReport {
  const findings: SkillScanFinding[] = [];
  const scriptFiles: string[] = [];
  const dedupe = new Set<string>();

  const pushFinding = (item: SkillScanFinding) => {
    if (findings.length >= 100) return;
    const key = `${item.file}:${item.line}:${item.category}:${item.title}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    findings.push(item);
  };

  for (const f of files) {
    const relPath = normalizeRelativeSkillPath(f.path);
    if (isScriptSkillPath(relPath)) {
      scriptFiles.push(relPath);
      pushFinding({
        severity: 'warn',
        category: 'script_bundled',
        file: relPath,
        line: 1,
        title: '技能包附带可执行脚本文件',
        detail: `发现脚本文件「${relPath}」。脚本不会被工作台自动运行，启用前请确认脚本来源与用途可信。`,
        excerpt: relPath,
      });
    }

    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      // 忽略文件首字符的合法 UTF-8 BOM（\uFEFF），其余位置的零宽/BiDi/Tag 一律报警
      const rawLine = lineNo === 1 ? lines[i]!.replace(/^\uFEFF/, '') : lines[i]!;
      if (!rawLine) continue;

      HIDDEN_UNICODE_RE.lastIndex = 0;
      if (HIDDEN_UNICODE_RE.test(rawLine)) {
        pushFinding({
          severity: 'danger',
          category: 'hidden_unicode',
          file: relPath,
          line: lineNo,
          title: '检测到不可见控制字符或双向欺骗字符',
          detail: '行内暗藏零宽字符、BiDi 反转符或 Unicode Tag 隐写字符，常用于隐藏恶意指令欺骗肉眼审查。',
          excerpt: visualizeHiddenExcerpt(rawLine),
        });
      }

      for (const rule of LINE_RULES) {
        if (rule.pattern.test(rawLine)) {
          pushFinding({
            severity: rule.severity,
            category: rule.category,
            file: relPath,
            line: lineNo,
            title: rule.title,
            detail: rule.detail,
            excerpt: visualizeHiddenExcerpt(rawLine),
          });
        }
      }
    }
  }

  let riskLevel: SkillRiskLevel = 'safe';
  if (findings.some((f) => f.severity === 'danger')) {
    riskLevel = 'danger';
  } else if (findings.length > 0 || scriptFiles.length > 0) {
    riskLevel = 'warn';
  }

  return SkillScanReport.parse({
    riskLevel,
    hasScripts: scriptFiles.length > 0,
    scriptFiles: scriptFiles.slice(0, 64),
    findings,
    scannedFiles: files.length,
    scannedAt,
  });
}
