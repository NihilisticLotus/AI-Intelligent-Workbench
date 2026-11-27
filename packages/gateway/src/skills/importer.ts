// 本机公开技能目录只读扫描器与凭据路径防火墙（第 2.4 步）：
// - 强硬凭据黑名单守卫 assertNotCredentialPath：任何触碰登录凭据、令牌、.env、.aic-data、~/.ssh 或第三方工具根目录的路径一律抛错拒绝；
// - 预设扫描源仅进入各工具显式白名单的纯 skills/ 子目录（绝不打开父目录或读取主配置文件）；
// - 严禁跟随越界符号链接，单文件 ≤256 KB、单技能 ≤1 MB、最多 40 文件，严格只读不修改源目录。
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { SkillLocalSourceKind, SkillSourceKind } from '@aic/protocol';
import { Errors } from '../util';
import {
  computeSkillContentHash, isScriptSkillPath, normalizeRelativeSkillPath, normalizeSkillSlug, parseSkillFrontmatter,
  scanSkillPackage,
} from './scanner';

const MAX_SKILL_FILES = 40;
const MAX_SINGLE_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_SKILL_BYTES = 1024 * 1024;
const MAX_WALK_DEPTH = 3;

/** 严禁触碰的敏感目录段（全小写比对） */
const FORBIDDEN_DIR_SEGMENTS = new Set([
  '.aic-data',
  '.ssh',
  '.aws',
  '.gnupg',
  '.workbuddy',
  '.azure',
  '.kube',
  '.docker',
  'gcloud',
  'keychain',
]);

/** 第三方编码工具配置根目录名：只允许读取其下的 skills 子目录，绝不允许扫描根目录本身 */
const TOOL_ROOT_ONLY_SKILLS = new Set([
  '.claude',
  '.codex',
  '.codebuddy',
  '.zcode',
  '.gemini',
]);

/** 严禁读取的敏感文件名或后缀模式 */
const FORBIDDEN_FILE_PATTERNS: readonly RegExp[] = [
  /^\.credentials/i,
  /^credentials(?:\.|$)/i,
  /^auth\.json$/i,
  /^\.env(?:\.|$)/i,
  /^data\.db(?:-wal|-shm)?$/i,
  /^secrets?\.(?:json|db|ya?ml|toml|txt)$/i,
  /^cookies(?:\.|$)/i,
  /^tokens?\.json$/i,
  /^dev-pairing-code\.txt$/i,
  /^id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$/i,
  /^\.(?:npmrc|netrc|git-credentials|pypirc)$/i,
  /\.(?:pem|key|pfx|p12|jks|kdbx)$/i,
];

export interface PresetSourceSpec {
  sourceKind: SkillLocalSourceKind;
  label: string;
  segments: readonly string[];
}

export const PRESET_LOCAL_SKILL_SOURCES: Record<SkillLocalSourceKind, PresetSourceSpec> = {
  agents_public: {
    sourceKind: 'agents_public',
    label: '跨工具公共技能目录（~/.agents/skills）',
    segments: ['.agents', 'skills'],
  },
  claude_skills: {
    sourceKind: 'claude_skills',
    label: 'Claude Code 技能目录（skills/）',
    segments: ['.claude', 'skills'],
  },
  codex_skills: {
    sourceKind: 'codex_skills',
    label: 'Codex 技能目录（skills/）',
    segments: ['.codex', 'skills'],
  },
  codebuddy_skills: {
    sourceKind: 'codebuddy_skills',
    label: 'CodeBuddy 技能目录（skills/）',
    segments: ['.codebuddy', 'skills'],
  },
  zcode_skills: {
    sourceKind: 'zcode_skills',
    label: 'ZCode 技能目录（skills/）',
    segments: ['.zcode', 'skills'],
  },
  antigravity_skills: {
    sourceKind: 'antigravity_skills',
    label: 'Antigravity 技能目录（skills/）',
    segments: ['.gemini', 'antigravity', 'skills'],
  },
};

function checkPathSegments(resolved: string): void {
  const normalized = path.resolve(resolved);
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  const lowerParts = parts.map((p) => p.toLowerCase());

  for (let i = 0; i < lowerParts.length; i++) {
    const seg = lowerParts[i]!;
    if (FORBIDDEN_DIR_SEGMENTS.has(seg)) {
      throw Errors.forbidden(`安全策略禁止扫描或读取敏感凭据/数据目录：${parts[i]}`);
    }
    if (TOOL_ROOT_ONLY_SKILLS.has(seg)) {
      // 第三方工具根目录只允许访问其下的 skills 子目录（或 .gemini/antigravity/skills）
      const tail = lowerParts.slice(i + 1);
      const allowedSub = seg === '.gemini'
        ? (tail[0] === 'antigravity' && tail[1] === 'skills') || tail[0] === 'skills'
        : tail[0] === 'skills';
      if (!allowedSub) {
        throw Errors.forbidden(`安全策略禁止读取第三方工具根目录或凭据位置（${parts[i]}），仅允许只读扫描其 skills/ 子目录`);
      }
    }
  }

  const base = lowerParts.at(-1) ?? '';
  for (const re of FORBIDDEN_FILE_PATTERNS) {
    if (re.test(base)) {
      throw Errors.forbidden(`安全策略禁止读取凭据或敏感配置文件：${parts.at(-1)}`);
    }
  }
}

/** 凭据路径硬编码防火墙：同时校验逻辑路径与真实物理路径（防止符号链接绕过）。 */
export function assertNotCredentialPath(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed || trimmed.includes('\0')) throw Errors.badRequest('目录路径无效');
  const resolved = path.resolve(trimmed);
  checkPathSegments(resolved);
  if (existsSync(resolved)) {
    let real: string;
    try {
      real = realpathSync(resolved);
    } catch {
      throw Errors.badRequest('无法访问目标路径');
    }
    checkPathSegments(real);
    return real;
  }
  return resolved;
}

export interface ScannedLocalSkillBundle {
  name: string;
  slug: string;
  description: string;
  version: string;
  sourceKind: SkillSourceKind;
  sourceLabel: string;
  contentHash: string;
  markdown: string;
  files: Array<{ path: string; content: string; size: number }>;
  scan: ReturnType<typeof scanSkillPackage>;
}

function isLikelyBinary(buf: Buffer): boolean {
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** 安全只读加载单个技能目录（必须包含 SKILL.md），禁止越界符号链接与凭据文件。 */
export function readSkillFolderSafely(
  skillDir: string,
  sourceKind: SkillSourceKind,
  sourceLabel: string,
): ScannedLocalSkillBundle | null {
  const realRoot = assertNotCredentialPath(skillDir);
  if (!existsSync(realRoot) || !statSync(realRoot).isDirectory()) return null;

  const collected: Array<{ path: string; content: string; size: number }> = [];
  let totalBytes = 0;

  const walk = (dir: string, relPrefix: string, depth: number) => {
    if (depth > MAX_WALK_DEPTH || collected.length >= MAX_SKILL_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (collected.length >= MAX_SKILL_FILES) break;
      const name = ent.name;
      if (name === '.git' || name === 'node_modules' || name === '__pycache__' || name === '.DS_Store') continue;
      const full = path.join(dir, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;

      // 每个文件/子目录都过一遍凭据防火墙，并防止符号链接逃逸出技能目录
      let lstat;
      try { lstat = lstatSync(full); } catch { continue; }
      let realEntry: string;
      try { realEntry = assertNotCredentialPath(full); } catch { continue; }
      const relFromRoot = path.relative(realRoot, realEntry);
      if (relFromRoot.startsWith('..') || path.isAbsolute(relFromRoot)) continue;

      if (lstat.isDirectory() || (lstat.isSymbolicLink() && statSync(realEntry).isDirectory())) {
        walk(realEntry, rel, depth + 1);
        continue;
      }

      let st;
      try { st = statSync(realEntry); } catch { continue; }
      if (!st.isFile()) continue;

      const safeRel = normalizeRelativeSkillPath(rel);
      if (st.size > MAX_SINGLE_FILE_BYTES || totalBytes + st.size > MAX_TOTAL_SKILL_BYTES) {
        if (isScriptSkillPath(safeRel)) {
          collected.push({ path: safeRel, content: '# （文件体积超出预览上限，仅登记脚本名用于安全提示）', size: st.size });
        }
        continue;
      }

      let buf: Buffer;
      try { buf = readFileSync(realEntry); } catch { continue; }
      if (isLikelyBinary(buf)) {
        if (isScriptSkillPath(safeRel)) {
          collected.push({ path: safeRel, content: '# （二进制可执行文件，仅登记文件名用于安全提示）', size: buf.length });
        }
        continue;
      }

      totalBytes += buf.length;
      collected.push({ path: safeRel, content: buf.toString('utf8'), size: buf.length });
    }
  };

  walk(realRoot, '', 0);

  const skillMd = collected.find((f) => f.path.toLowerCase() === 'skill.md');
  if (!skillMd) return null;

  // 统一把主文件规范命名为 SKILL.md
  skillMd.path = 'SKILL.md';
  const parsed = parseSkillFrontmatter(skillMd.content);
  const folderName = path.basename(realRoot);
  const name = (parsed.name || folderName).slice(0, 80);
  const slug = normalizeSkillSlug(parsed.name || folderName);
  const description = (parsed.description || '').slice(0, 1024);
  const version = (parsed.version || '').slice(0, 64);
  const scan = scanSkillPackage(collected);
  const contentHash = computeSkillContentHash(collected);

  return {
    name,
    slug,
    description,
    version,
    sourceKind,
    sourceLabel,
    contentHash,
    markdown: skillMd.content,
    files: collected,
    scan,
  };
}

/** 扫描一个目录（可以是单个技能目录，也可以是包含多个技能子目录的公共目录）。 */
export function scanDirectoryForSkills(
  dirPath: string,
  sourceKind: SkillSourceKind,
  sourceLabel: string,
): ScannedLocalSkillBundle[] {
  const realDir = assertNotCredentialPath(dirPath);
  if (!existsSync(realDir) || !statSync(realDir).isDirectory()) return [];

  // 1) 目录本身就是一个技能包（直接含 SKILL.md）
  const direct = readSkillFolderSafely(realDir, sourceKind, sourceLabel);
  if (direct) return [direct];

  // 2) 目录是技能库根目录，扫描其直接子目录（每个子目录里找 SKILL.md）
  const out: ScannedLocalSkillBundle[] = [];
  let entries;
  try {
    entries = readdirSync(realDir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (out.length >= 60) break;
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const child = path.join(realDir, ent.name);
    let realChild: string;
    try { realChild = assertNotCredentialPath(child); } catch { continue; }
    try {
      if (!statSync(realChild).isDirectory()) continue;
    } catch {
      continue;
    }
    const bundle = readSkillFolderSafely(realChild, sourceKind, sourceLabel);
    if (bundle) out.push(bundle);
  }
  return out;
}

/** 解析预设本机技能目录的完整路径（支持测试注入隔离 homeDir，绝不碰真实主目录）。 */
export function resolvePresetSkillDir(sourceKind: SkillLocalSourceKind, homeDir = homedir()): string {
  const spec = PRESET_LOCAL_SKILL_SOURCES[sourceKind];
  return path.join(homeDir, ...spec.segments);
}
