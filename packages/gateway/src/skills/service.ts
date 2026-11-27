// 工作台统一技能库服务（第 2.4 步）：
// - 所有技能以受控副本存于 <dataDir>/skills/<id>/，不向第三方工具目录写入任何文件或符号链接；
// - 创建、编辑、导入全部强制过静态安全扫描器，命中高危或携带可执行脚本时默认禁止启用，须用户显式核对确认；
// - 提供三层渐进式披露接口（L1 摘要目录 + 按需只读 aic_skills__list / aic_skills__read），零本机路径泄露且必套 2.1 防注入围栏。
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  CreateSkillBody, ImportLocalSkillsBody, ImportLocalSkillsResult, PatchSkillBody, PutTaskSkillOverridesBody,
  ScanLocalSkillsBody, ScanSkillContentBody, SkillDetail, SkillLocalScanResult, SkillScanReport, SkillSummary,
  TaskSkillsState,
  type AgentKind, type SkillFileEntry, type SkillSourceKind,
} from '@aic/protocol';
import type { Db } from '../db';
import { formatMcpToolResult, MCP_MAX_RESULT_CHARS } from '../mcp/client';
import { wrapProvenance } from '../security/provenance';
import { Errors, newId, now } from '../util';
import {
  assertNotCredentialPath, PRESET_LOCAL_SKILL_SOURCES, resolvePresetSkillDir, scanDirectoryForSkills,
  type ScannedLocalSkillBundle,
} from './importer';
import {
  classifySkillFile, computeSkillContentHash, normalizeRelativeSkillPath, normalizeSkillSlug, parseSkillFrontmatter,
  scanSkillPackage,
} from './scanner';

const SCAN_CACHE_TTL_MS = 15 * 60_000;
const SOURCE_LABELS: Record<SkillSourceKind, string> = {
  manual: '手动新建',
  upload: '文件/文件夹上传',
  agents_public: '跨工具公共技能目录（~/.agents/skills）',
  claude_skills: 'Claude Code 技能目录（skills/）',
  codex_skills: 'Codex 技能目录（skills/）',
  codebuddy_skills: 'CodeBuddy 技能目录（skills/）',
  zcode_skills: 'ZCode 技能目录（skills/）',
  antigravity_skills: 'Antigravity 技能目录（skills/）',
  custom_folder: '本机自定义文件夹',
};

type SkillRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  content_hash: string;
  source_kind: SkillSourceKind;
  source_label: string;
  agents_json: string;
  enabled: number;
  has_scripts: number;
  script_files_json: string;
  risks_approved: number;
  scan_json: string;
  files_json: string;
  created_at: number;
  updated_at: number;
};

interface CachedLocalScan {
  createdAt: number;
  candidates: Map<string, ScannedLocalSkillBundle>;
}

export interface SkillServiceOptions {
  /** 仅离线测试注入隔离主目录；生产环境默认使用 os.homedir() */
  homeDir?: string;
  maxReadChars?: number;
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function requiresApprovalOf(scan: SkillScanReport): boolean {
  return scan.riskLevel === 'danger' || scan.hasScripts;
}

export class SkillService {
  private skillsRoot: string;
  private scanCache = new Map<string, CachedLocalScan>();

  constructor(
    private db: Db,
    dataDir: string,
    private opts: SkillServiceOptions = {},
  ) {
    this.skillsRoot = path.join(dataDir, 'skills');
    mkdirSync(this.skillsRoot, { recursive: true });
  }

  private homeDir(): string {
    return this.opts.homeDir ?? homedir();
  }

  private skillDir(id: string): string {
    return path.join(this.skillsRoot, id);
  }

  private getRow(id: string): SkillRow {
    const row = this.db.get<SkillRow>('SELECT * FROM skills WHERE id = ?', id);
    if (!row) throw Errors.notFound('找不到这个技能');
    return row;
  }

  private toSummary(row: SkillRow): SkillSummary {
    const agents = safeJson<AgentKind[]>(row.agents_json, []);
    const scriptFiles = safeJson<string[]>(row.script_files_json, []);
    const files = safeJson<SkillFileEntry[]>(row.files_json, []);
    const scan = SkillScanReport.parse(safeJson(row.scan_json, {
      riskLevel: 'safe',
      hasScripts: false,
      scriptFiles: [],
      findings: [],
      scannedFiles: 1,
      scannedAt: row.updated_at,
    }));
    const requiresApproval = requiresApprovalOf(scan);
    return SkillSummary.parse({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: row.version,
      contentHash: row.content_hash,
      sourceKind: row.source_kind,
      sourceLabel: row.source_label,
      agents,
      enabled: !!row.enabled,
      requiresApproval,
      risksApproved: !!row.risks_approved,
      hasScripts: !!row.has_scripts,
      scriptFiles,
      files,
      scan,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private readSkillMarkdown(id: string): string {
    const file = path.join(this.skillDir(id), 'SKILL.md');
    if (!existsSync(file)) return '';
    try { return readFileSync(file, 'utf8'); } catch { return ''; }
  }

  private writeSkillFiles(id: string, files: ReadonlyArray<{ path: string; content: string }>): SkillFileEntry[] {
    const dir = this.skillDir(id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const manifest: SkillFileEntry[] = [];
    for (const f of files) {
      const rel = normalizeRelativeSkillPath(f.path);
      const target = path.resolve(dir, rel);
      const check = path.relative(dir, target);
      if (check.startsWith('..') || path.isAbsolute(check)) {
        throw Errors.badRequest(`技能文件路径非法：${rel}`);
      }
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, f.content, 'utf8');
      manifest.push({
        path: rel,
        kind: classifySkillFile(rel),
        size: Buffer.byteLength(f.content, 'utf8'),
      });
    }
    return manifest.sort((a, b) => (a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)));
  }

  private ensureUniqueSlug(baseSlug: string, excludeId?: string): string {
    let candidate = baseSlug;
    let seq = 2;
    while (true) {
      const row = excludeId
        ? this.db.get<{ id: string }>('SELECT id FROM skills WHERE slug = ? AND id <> ?', candidate, excludeId)
        : this.db.get<{ id: string }>('SELECT id FROM skills WHERE slug = ?', candidate);
      if (!row) return candidate;
      candidate = `${baseSlug.slice(0, 56)}-${seq++}`;
    }
  }

  list(): SkillSummary[] {
    return this.db
      .all<SkillRow>('SELECT * FROM skills ORDER BY enabled DESC, updated_at DESC')
      .map((r) => this.toSummary(r));
  }

  get(id: string): SkillDetail {
    const row = this.getRow(id);
    return SkillDetail.parse({
      ...this.toSummary(row),
      markdown: this.readSkillMarkdown(row.id),
    });
  }

  /** 在保存前预扫描技能正文及附属文件，供界面实时标红/标黄提醒。 */
  scanContent(input: ScanSkillContentBody): SkillScanReport {
    const body = ScanSkillContentBody.parse(input);
    const files: Array<{ path: string; content: string }> = [{ path: 'SKILL.md', content: body.markdown }];
    for (const extra of body.extraFiles) {
      const rel = normalizeRelativeSkillPath(extra.path);
      if (rel.toLowerCase() === 'skill.md') continue;
      files.push({ path: rel, content: extra.content });
    }
    return scanSkillPackage(files);
  }

  /** 新建或上传导入一个技能包。命中高危或带可执行脚本且未确认风险时，默认以未启用状态保存。 */
  create(input: CreateSkillBody): SkillDetail {
    const body = CreateSkillBody.parse(input);
    const parsed = parseSkillFrontmatter(body.markdown);
    const name = (body.name || parsed.name || '未命名技能').trim().slice(0, 80);
    const description = (body.description !== undefined ? body.description : (parsed.description ?? '')).trim().slice(0, 1024);
    const version = (body.version !== undefined ? body.version : (parsed.version ?? '')).trim().slice(0, 64);

    const files: Array<{ path: string; content: string }> = [{ path: 'SKILL.md', content: body.markdown }];
    const seen = new Set<string>(['skill.md']);
    for (const extra of body.extraFiles) {
      const rel = normalizeRelativeSkillPath(extra.path);
      if (seen.has(rel.toLowerCase())) continue;
      seen.add(rel.toLowerCase());
      files.push({ path: rel, content: extra.content });
    }

    const scan = scanSkillPackage(files);
    const contentHash = computeSkillContentHash(files);
    const needsApproval = requiresApprovalOf(scan);
    const risksApproved = needsApproval ? body.approveRisks : true;
    const enabled = needsApproval && !risksApproved ? false : body.enabled;

    const id = newId('sk');
    const slug = this.ensureUniqueSlug(normalizeSkillSlug(parsed.name || name));
    const manifest = this.writeSkillFiles(id, files);
    const ts = now();

    try {
      this.db.run(
        `INSERT INTO skills (
          id, slug, name, description, version, content_hash, source_kind, source_label,
          agents_json, enabled, has_scripts, script_files_json, risks_approved, scan_json, files_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        slug,
        name,
        description,
        version,
        contentHash,
        body.sourceKind,
        SOURCE_LABELS[body.sourceKind],
        JSON.stringify([...new Set(body.agents)]),
        enabled ? 1 : 0,
        scan.hasScripts ? 1 : 0,
        JSON.stringify(scan.scriptFiles),
        risksApproved ? 1 : 0,
        JSON.stringify(scan),
        JSON.stringify(manifest),
        ts,
        ts,
      );
    } catch (err) {
      rmSync(this.skillDir(id), { recursive: true, force: true });
      throw err;
    }

    return this.get(id);
  }

  /** 修改技能信息、正文、分配范围、确认风险或启停开关。 */
  patch(id: string, input: PatchSkillBody): SkillDetail {
    const body = PatchSkillBody.parse(input);
    const row = this.getRow(id);
    const currentFiles = safeJson<SkillFileEntry[]>(row.files_json, []);
    let scan = SkillScanReport.parse(safeJson(row.scan_json, null));
    let contentHash = row.content_hash;
    let nextFiles = currentFiles;
    let nextRisksApproved = !!row.risks_approved;

    let nextName = body.name ?? row.name;
    let nextDesc = body.description ?? row.description;
    let nextVersion = body.version ?? row.version;

    if (body.markdown !== undefined) {
      // 重建当前技能完整文件集用于重新扫描（保留既有 references/scripts/assets）
      const fullFiles: Array<{ path: string; content: string }> = [{ path: 'SKILL.md', content: body.markdown }];
      const dir = this.skillDir(id);
      for (const f of currentFiles) {
        if (f.path.toLowerCase() === 'skill.md') continue;
        const p = path.resolve(dir, f.path);
        if (existsSync(p)) {
          try { fullFiles.push({ path: f.path, content: readFileSync(p, 'utf8') }); } catch { /* ignore */ }
        }
      }
      scan = scanSkillPackage(fullFiles);
      contentHash = computeSkillContentHash(fullFiles);
      nextFiles = this.writeSkillFiles(id, fullFiles);
      const parsed = parseSkillFrontmatter(body.markdown);
      if (body.name === undefined && parsed.name) nextName = parsed.name;
      if (body.description === undefined && parsed.description) nextDesc = parsed.description;
      if (body.version === undefined && parsed.version) nextVersion = parsed.version;
      // 内容发生变更后，如仍命中高危/脚本且本次未显式 approveRisks，须重新确认
      nextRisksApproved = requiresApprovalOf(scan) ? body.approveRisks === true : true;
    } else if (body.approveRisks !== undefined) {
      nextRisksApproved = body.approveRisks;
    }

    const needsApproval = requiresApprovalOf(scan);
    let nextEnabled = body.enabled !== undefined ? body.enabled : !!row.enabled;
    if (needsApproval && !nextRisksApproved) {
      if (body.enabled === true) {
        throw Errors.badRequest('该技能包含高危风险告警或附带可执行脚本，请先查看安全扫描结果并勾选“我已核对风险”后再启用');
      }
      nextEnabled = false;
    }

    const nextAgents = body.agents !== undefined ? [...new Set(body.agents)] : safeJson<AgentKind[]>(row.agents_json, []);
    const ts = now();
    this.db.run(
      `UPDATE skills
       SET name = ?, description = ?, version = ?, content_hash = ?,
           agents_json = ?, enabled = ?, has_scripts = ?, script_files_json = ?,
           risks_approved = ?, scan_json = ?, files_json = ?, updated_at = ?
       WHERE id = ?`,
      nextName,
      nextDesc,
      nextVersion,
      contentHash,
      JSON.stringify(nextAgents),
      nextEnabled ? 1 : 0,
      scan.hasScripts ? 1 : 0,
      JSON.stringify(scan.scriptFiles),
      nextRisksApproved ? 1 : 0,
      JSON.stringify(scan),
      JSON.stringify(nextFiles),
      ts,
      id,
    );

    return this.get(id);
  }

  delete(id: string): void {
    this.getRow(id);
    this.db.run('DELETE FROM skills WHERE id = ?', id);
    rmSync(this.skillDir(id), { recursive: true, force: true });
  }

  private pruneScanCache(): void {
    const cutoff = now() - SCAN_CACHE_TTL_MS;
    for (const [id, entry] of this.scanCache) {
      if (entry.createdAt < cutoff) this.scanCache.delete(id);
    }
  }

  /** 只读扫描本机允许的纯技能目录（全部受 assertNotCredentialPath 凭据防火墙保护，零路径回传给浏览器）。 */
  scanLocal(input: ScanLocalSkillsBody): SkillLocalScanResult {
    const body = ScanLocalSkillsBody.parse(input);
    this.pruneScanCache();

    const existingRows = this.db.all<SkillRow>('SELECT * FROM skills');
    const bySlug = new Map<string, SkillRow>();
    const byNameLower = new Map<string, SkillRow>();
    for (const r of existingRows) {
      bySlug.set(r.slug, r);
      byNameLower.set(r.name.toLowerCase(), r);
    }

    const checkedSources: SkillLocalScanResult['checkedSources'] = [];
    const candidates: SkillLocalScanResult['candidates'] = [];
    const candidateMap = new Map<string, ScannedLocalSkillBundle>();

    const collectFrom = (dir: string, sourceKind: SkillSourceKind, label: string) => {
      // 显式过凭据防火墙：若自定义路径企图触碰凭据/工具根目录，直接抛出 403
      const safeDir = assertNotCredentialPath(dir);
      if (!existsSync(safeDir)) {
        checkedSources.push({ sourceKind, label, available: false, foundCount: 0, skippedReason: '目录不存在' });
        return;
      }
      const found = scanDirectoryForSkills(safeDir, sourceKind, label);
      checkedSources.push({ sourceKind, label, available: true, foundCount: found.length });
      for (const bundle of found) {
        const candidateId = newId('cand');
        candidateMap.set(candidateId, bundle);
        const existing = bySlug.get(bundle.slug) ?? byNameLower.get(bundle.name.toLowerCase()) ?? null;
        const conflict = !existing ? 'new' : existing.content_hash === bundle.contentHash ? 'identical' : 'modified';
        candidates.push({
          candidateId,
          name: bundle.name,
          slug: bundle.slug,
          description: bundle.description,
          version: bundle.version,
          sourceKind: bundle.sourceKind,
          sourceLabel: bundle.sourceLabel,
          conflict,
          existingSkillId: existing?.id ?? null,
          contentHash: bundle.contentHash,
          filesCount: bundle.files.length,
          hasScripts: bundle.scan.hasScripts,
          scriptFiles: bundle.scan.scriptFiles,
          scan: bundle.scan,
        });
      }
    };

    const uniqueSources = [...new Set(body.sources)];
    for (const sourceKind of uniqueSources) {
      const spec = PRESET_LOCAL_SKILL_SOURCES[sourceKind];
      const dir = resolvePresetSkillDir(sourceKind, this.homeDir());
      collectFrom(dir, sourceKind, spec.label);
    }

    if (body.customDir) {
      collectFrom(body.customDir, 'custom_folder', SOURCE_LABELS.custom_folder);
    }

    const scanId = newId('scan');
    this.scanCache.set(scanId, { createdAt: now(), candidates: candidateMap });
    return SkillLocalScanResult.parse({ scanId, checkedSources, candidates });
  }

  /** 将扫描结果中勾选的技能只读复制到工作台统一技能库（绝不修改原目录）。 */
  importLocal(input: ImportLocalSkillsBody): ImportLocalSkillsResult {
    const body = ImportLocalSkillsBody.parse(input);
    this.pruneScanCache();
    const cached = this.scanCache.get(body.scanId);
    if (!cached) {
      throw Errors.badRequest('扫描结果已过期，请重新点击“扫描本机技能”后再导入');
    }

    const imported: SkillSummary[] = [];
    const skipped: ImportLocalSkillsResult['skipped'] = [];

    for (const item of body.items) {
      const bundle = cached.candidates.get(item.candidateId);
      if (!bundle) {
        skipped.push({ candidateId: item.candidateId, name: '未知条目', reason: '扫描缓存中不存在该条目' });
        continue;
      }

      const existing = this.db.get<SkillRow>(
        'SELECT * FROM skills WHERE slug = ? OR LOWER(name) = LOWER(?) LIMIT 1',
        bundle.slug,
        bundle.name,
      );

      if (existing && !item.overwrite) {
        skipped.push({
          candidateId: item.candidateId,
          name: bundle.name,
          reason: existing.content_hash === bundle.contentHash ? '工作台已有完全相同的技能' : '工作台已有同名技能（未勾选覆盖）',
        });
        continue;
      }

      const needsApproval = requiresApprovalOf(bundle.scan);
      const risksApproved = needsApproval ? item.approveRisks : true;
      const enabled = needsApproval && !risksApproved ? false : true;
      const ts = now();

      if (existing) {
        const manifest = this.writeSkillFiles(existing.id, bundle.files);
        this.db.run(
          `UPDATE skills
           SET name = ?, description = ?, version = ?, content_hash = ?,
               source_kind = ?, source_label = ?, enabled = ?,
               has_scripts = ?, script_files_json = ?, risks_approved = ?,
               scan_json = ?, files_json = ?, updated_at = ?
           WHERE id = ?`,
          bundle.name,
          bundle.description,
          bundle.version,
          bundle.contentHash,
          bundle.sourceKind,
          bundle.sourceLabel,
          enabled ? 1 : 0,
          bundle.scan.hasScripts ? 1 : 0,
          JSON.stringify(bundle.scan.scriptFiles),
          risksApproved ? 1 : 0,
          JSON.stringify(bundle.scan),
          JSON.stringify(manifest),
          ts,
          existing.id,
        );
        imported.push(this.toSummary(this.getRow(existing.id)));
      } else {
        const id = newId('sk');
        const slug = this.ensureUniqueSlug(bundle.slug);
        const manifest = this.writeSkillFiles(id, bundle.files);
        try {
          this.db.run(
            `INSERT INTO skills (
              id, slug, name, description, version, content_hash, source_kind, source_label,
              agents_json, enabled, has_scripts, script_files_json, risks_approved, scan_json, files_json,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            slug,
            bundle.name,
            bundle.description,
            bundle.version,
            bundle.contentHash,
            bundle.sourceKind,
            bundle.sourceLabel,
            '[]',
            enabled ? 1 : 0,
            bundle.scan.hasScripts ? 1 : 0,
            JSON.stringify(bundle.scan.scriptFiles),
            risksApproved ? 1 : 0,
            JSON.stringify(bundle.scan),
            JSON.stringify(manifest),
            ts,
            ts,
          );
        } catch (err) {
          rmSync(this.skillDir(id), { recursive: true, force: true });
          throw err;
        }
        imported.push(this.toSummary(this.getRow(id)));
      }
    }

    return ImportLocalSkillsResult.parse({ imported, skipped });
  }

  /** 查询指定任务的技能挂载状态（右侧“详细 → 连接”面板使用）。 */
  taskSkills(taskId: string, agent: AgentKind): TaskSkillsState {
    const rows = this.db.all<SkillRow>('SELECT * FROM skills ORDER BY enabled DESC, updated_at DESC');
    const disabledSet = new Set(
      this.db
        .all<{ skill_id: string }>('SELECT skill_id FROM task_skill_overrides WHERE task_id = ? AND disabled = 1', taskId)
        .map((r) => r.skill_id),
    );
    const skills = rows.map((row) => {
      const summary = this.toSummary(row);
      const assigned = summary.agents.length === 0 || summary.agents.includes(agent);
      const disabledForTask = disabledSet.has(summary.id);
      const approvedReady = !summary.requiresApproval || summary.risksApproved;
      return {
        id: summary.id,
        slug: summary.slug,
        name: summary.name,
        description: summary.description,
        enabled: summary.enabled,
        assigned,
        disabledForTask,
        activeForTask: summary.enabled && approvedReady && assigned && !disabledForTask,
        riskLevel: summary.scan.riskLevel,
        hasScripts: summary.hasScripts,
        requiresApproval: summary.requiresApproval,
        risksApproved: summary.risksApproved,
      };
    });
    return TaskSkillsState.parse({ taskId, agent, skills });
  }

  /** 更新指定任务的临时停用技能列表（仅影响该任务）。 */
  setTaskOverrides(taskId: string, agent: AgentKind, disabledSkillIds: readonly string[]): TaskSkillsState {
    const body = PutTaskSkillOverridesBody.parse({ disabledSkillIds: [...disabledSkillIds] });
    const validIds = new Set(this.db.all<{ id: string }>('SELECT id FROM skills').map((r) => r.id));
    const cleaned = [...new Set(body.disabledSkillIds.filter((id) => validIds.has(id)))];
    this.db.tx(() => {
      this.db.run('DELETE FROM task_skill_overrides WHERE task_id = ?', taskId);
      for (const skillId of cleaned) {
        this.db.run('INSERT INTO task_skill_overrides (task_id, skill_id, disabled) VALUES (?, ?, 1)', taskId, skillId);
      }
    });
    return this.taskSkills(taskId, agent);
  }

  // ---------- 三层渐进式披露（供独立 Agent 与 McpHub 统一使用） ----------

  /** 返回当前任务真正生效且通过安全确认的技能清单。 */
  activeSkillsFor(taskId: string, agent: AgentKind): SkillSummary[] {
    const disabledSet = new Set(
      this.db
        .all<{ skill_id: string }>('SELECT skill_id FROM task_skill_overrides WHERE task_id = ? AND disabled = 1', taskId)
        .map((r) => r.skill_id),
    );
    const out: SkillSummary[] = [];
    for (const row of this.db.all<SkillRow>('SELECT * FROM skills WHERE enabled = 1 ORDER BY updated_at DESC')) {
      if (disabledSet.has(row.id)) continue;
      const summary = this.toSummary(row);
      if (summary.requiresApproval && !summary.risksApproved) continue;
      if (summary.agents.length > 0 && !summary.agents.includes(agent)) continue;
      out.push(summary);
    }
    return out;
  }

  /** L1 发现层摘要（供独立 Agent 系统提示词极轻量注入，每个技能仅占一行，引导按需调用 aic_skills__read）。 */
  l1PromptSummaryFor(taskId: string, agent: AgentKind): string {
    const active = this.activeSkillsFor(taskId, agent);
    if (!active.length) return '';
    const lines = active.slice(0, 40).map((s) => {
      const desc = s.description ? `：${s.description.slice(0, 120)}` : '';
      return `- ${s.slug}（${s.name}）${desc}`;
    });
    return `\n\n工作台已为当前任务挂载以下技能包（仅列出摘要以节省上下文；当任务需要对应流程或规范时，请调用 aic_skills__read 读取完整说明）：\n${lines.join('\n')}`;
  }

  /** L1/L2 工具返回：aic_skills__list（始终包裹 2.1 external_data 围栏）。 */
  executeSkillList(taskId: string, agent: AgentKind, query = ''): { text: string; isError: boolean } {
    const active = this.activeSkillsFor(taskId, agent);
    const q = query.trim().toLowerCase();
    const matched = active.filter((s) => !q
      || s.slug.toLowerCase().includes(q)
      || s.name.toLowerCase().includes(q)
      || s.description.toLowerCase().includes(q));
    if (!matched.length) {
      const msg = active.length
        ? `当前任务共有 ${active.length} 个已启用技能，但未找到匹配「${query}」的技能。`
        : '当前任务尚未启用任何技能包。';
      return { text: wrapProvenance('external_data', '工作台技能目录', msg), isError: false };
    }
    const lines = matched.map((s) => {
      const extraFiles = s.files.filter((f) => f.path !== 'SKILL.md').map((f) => f.path);
      const extraNote = extraFiles.length ? `（附属文件：${extraFiles.join('、')}）` : '';
      return `- ${s.slug}「${s.name}」：${s.description || '无说明'}${extraNote}`;
    });
    const body = `当前任务可用技能（共 ${matched.length} 个）：\n${lines.join('\n')}\n\n提示：调用 aic_skills__read(name="<slug>") 读取完整 SKILL.md，传 file 参数可按需读取附属参考文档。`;
    return { text: wrapProvenance('external_data', '工作台技能目录', body), isError: false };
  }

  /** L2/L3 工具返回：aic_skills__read（严格禁止路径穿越、零本机路径、自动 8,000 字限流与防注入围栏）。 */
  executeSkillRead(
    taskId: string,
    agent: AgentKind,
    nameOrSlug: string,
    relativeFile?: string,
    onOverflow?: (redactedText: string) => string | null,
  ): { text: string; isError: boolean; skillName: string; overflowId?: string | null } {
    const needle = nameOrSlug.trim().toLowerCase();
    const active = this.activeSkillsFor(taskId, agent);
    const skill = active.find((s) => s.slug.toLowerCase() === needle || s.name.toLowerCase() === needle || s.id === nameOrSlug.trim());
    if (!skill) {
      return {
        text: wrapProvenance('external_data', '工作台技能读取', `当前任务未启用名为「${nameOrSlug}」的技能，请先调用 aic_skills__list 查看可用清单。`),
        isError: true,
        skillName: nameOrSlug,
      };
    }

    const rel = relativeFile && relativeFile.trim() ? normalizeRelativeSkillPath(relativeFile) : 'SKILL.md';
    const entry = skill.files.find((f) => f.path.toLowerCase() === rel.toLowerCase());
    if (!entry) {
      const avail = skill.files.map((f) => f.path).join('、');
      return {
        text: wrapProvenance('external_data', `技能 ${skill.name}`, `技能「${skill.name}」中不存在文件「${rel}」。可用文件：${avail}`),
        isError: true,
        skillName: skill.name,
      };
    }

    const dir = this.skillDir(skill.id);
    const target = path.resolve(dir, entry.path);
    const check = path.relative(dir, target);
    if (check.startsWith('..') || path.isAbsolute(check) || !existsSync(target)) {
      return {
        text: wrapProvenance('external_data', `技能 ${skill.name}`, `无法读取技能文件「${entry.path}」。`),
        isError: true,
        skillName: skill.name,
      };
    }

    const rawText = readFileSync(target, 'utf8');
    const formatted = formatMcpToolResult(
      `技能:${skill.name}`,
      entry.path,
      { content: [{ type: 'text', text: rawText }] },
      [],
      this.opts.maxReadChars ?? MCP_MAX_RESULT_CHARS,
      onOverflow,
    );
    return {
      text: formatted.text,
      isError: false,
      skillName: skill.name,
      overflowId: formatted.overflowId,
    };
  }
}
