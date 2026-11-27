// 能力中心（下）：技能库（Skills）、静态安全扫描与本机只读扫描导入共享协议（第 2.4 步）。
// 严格零本机绝对路径回传，所有扫描候选均通过不透明 scanId + candidateId 引用。
import { z } from 'zod';

const SkillId = z.string().min(1).max(64);
const SkillTs = z.number().int().nonnegative();
const SkillAgentKind = z.enum(['fake', 'claude', 'codex', 'codebuddy', 'zcode', 'workbuddy', 'antigravity', 'independent']);

export const SkillRiskLevel = z.enum(['safe', 'warn', 'danger']);
export type SkillRiskLevel = z.infer<typeof SkillRiskLevel>;

export const SkillFindingCategory = z.enum([
  'approval_bypass',
  'provenance_spoof',
  'credential_access',
  'hidden_unicode',
  'dangerous_command',
  'memory_backdoor',
  'script_bundled',
]);
export type SkillFindingCategory = z.infer<typeof SkillFindingCategory>;

export const SkillScanFinding = z.object({
  severity: z.enum(['warn', 'danger']),
  category: SkillFindingCategory,
  file: z.string().min(1).max(200),
  line: z.number().int().positive(),
  title: z.string().min(1).max(120),
  detail: z.string().min(1).max(500),
  excerpt: z.string().max(240),
}).strict();
export type SkillScanFinding = z.infer<typeof SkillScanFinding>;

export const SkillScanReport = z.object({
  riskLevel: SkillRiskLevel,
  hasScripts: z.boolean(),
  scriptFiles: z.array(z.string().max(200)).max(64),
  findings: z.array(SkillScanFinding).max(100),
  scannedFiles: z.number().int().nonnegative(),
  scannedAt: SkillTs,
}).strict();
export type SkillScanReport = z.infer<typeof SkillScanReport>;

export const SkillLocalSourceKind = z.enum([
  'agents_public',
  'claude_skills',
  'codex_skills',
  'codebuddy_skills',
  'zcode_skills',
  'antigravity_skills',
]);
export type SkillLocalSourceKind = z.infer<typeof SkillLocalSourceKind>;

export const SkillSourceKind = z.enum([
  'manual',
  'upload',
  'agents_public',
  'claude_skills',
  'codex_skills',
  'codebuddy_skills',
  'zcode_skills',
  'antigravity_skills',
  'custom_folder',
]);
export type SkillSourceKind = z.infer<typeof SkillSourceKind>;

export const SkillFileEntry = z.object({
  path: z.string().min(1).max(200),
  kind: z.enum(['skill', 'reference', 'script', 'asset']),
  size: z.number().int().nonnegative(),
}).strict();
export type SkillFileEntry = z.infer<typeof SkillFileEntry>;

export const SkillExtraFileInput = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(262_144),
}).strict();
export type SkillExtraFileInput = z.infer<typeof SkillExtraFileInput>;

export const SkillSummary = z.object({
  id: SkillId,
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  description: z.string().max(1024),
  version: z.string().max(64),
  contentHash: z.string().min(8).max(128),
  sourceKind: SkillSourceKind,
  sourceLabel: z.string().max(120),
  /** 空数组表示分配给全部 Agent；非空则仅对所选 Agent 生效 */
  agents: z.array(SkillAgentKind).max(16),
  enabled: z.boolean(),
  /** 是否包含高危项或未审脚本（需人工核对确认后才允许启用） */
  requiresApproval: z.boolean(),
  risksApproved: z.boolean(),
  hasScripts: z.boolean(),
  scriptFiles: z.array(z.string().max(200)).max(64),
  files: z.array(SkillFileEntry).max(64),
  scan: SkillScanReport,
  createdAt: SkillTs,
  updatedAt: SkillTs,
}).strict();
export type SkillSummary = z.infer<typeof SkillSummary>;

export const SkillDetail = SkillSummary.extend({
  markdown: z.string().max(262_144),
}).strict();
export type SkillDetail = z.infer<typeof SkillDetail>;

export const CreateSkillBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(1024).optional(),
  version: z.string().trim().max(64).optional(),
  markdown: z.string().min(1, '请填写技能正文（SKILL.md）').max(262_144),
  extraFiles: z.array(SkillExtraFileInput).max(32).default([]),
  sourceKind: z.enum(['manual', 'upload']).default('manual'),
  agents: z.array(SkillAgentKind).max(16).default([]),
  enabled: z.boolean().default(true),
  approveRisks: z.boolean().default(false),
}).strict();
export type CreateSkillBody = z.infer<typeof CreateSkillBody>;

export const PatchSkillBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(1024).optional(),
  version: z.string().trim().max(64).optional(),
  markdown: z.string().min(1).max(262_144).optional(),
  agents: z.array(SkillAgentKind).max(16).optional(),
  enabled: z.boolean().optional(),
  approveRisks: z.boolean().optional(),
}).strict();
export type PatchSkillBody = z.infer<typeof PatchSkillBody>;

export const ScanSkillContentBody = z.object({
  markdown: z.string().min(1, '请先提供技能内容').max(262_144),
  extraFiles: z.array(SkillExtraFileInput).max(32).default([]),
}).strict();
export type ScanSkillContentBody = z.infer<typeof ScanSkillContentBody>;

export const ScanLocalSkillsBody = z.object({
  sources: z.array(SkillLocalSourceKind).max(10).default(['agents_public']),
  /** 可选自定义目录（仅允许从 /api/v1/fs/browse 选择或本机显式填写的非凭据目录） */
  customDir: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type ScanLocalSkillsBody = z.infer<typeof ScanLocalSkillsBody>;

export const SkillLocalSourceStatus = z.object({
  sourceKind: SkillSourceKind,
  label: z.string().max(120),
  available: z.boolean(),
  foundCount: z.number().int().nonnegative(),
  skippedReason: z.string().max(200).optional(),
}).strict();
export type SkillLocalSourceStatus = z.infer<typeof SkillLocalSourceStatus>;

export const SkillLocalCandidate = z.object({
  candidateId: SkillId,
  name: z.string().min(1).max(80),
  slug: z.string().min(1).max(64),
  description: z.string().max(1024),
  version: z.string().max(64),
  sourceKind: SkillSourceKind,
  sourceLabel: z.string().max(120),
  conflict: z.enum(['new', 'identical', 'modified']),
  existingSkillId: SkillId.nullable(),
  contentHash: z.string().min(8).max(128),
  filesCount: z.number().int().positive(),
  hasScripts: z.boolean(),
  scriptFiles: z.array(z.string().max(200)).max(64),
  scan: SkillScanReport,
}).strict();
export type SkillLocalCandidate = z.infer<typeof SkillLocalCandidate>;

export const SkillLocalScanResult = z.object({
  scanId: SkillId,
  checkedSources: z.array(SkillLocalSourceStatus),
  candidates: z.array(SkillLocalCandidate),
}).strict();
export type SkillLocalScanResult = z.infer<typeof SkillLocalScanResult>;

export const ImportLocalSkillsBody = z.object({
  scanId: SkillId,
  items: z.array(z.object({
    candidateId: SkillId,
    overwrite: z.boolean().default(false),
    approveRisks: z.boolean().default(false),
  }).strict()).min(1, '请至少勾选一个要导入的技能').max(50),
}).strict();
export type ImportLocalSkillsBody = z.infer<typeof ImportLocalSkillsBody>;

export const ImportLocalSkillsResult = z.object({
  imported: z.array(SkillSummary),
  skipped: z.array(z.object({
    candidateId: SkillId,
    name: z.string().max(80),
    reason: z.string().max(300),
  }).strict()),
}).strict();
export type ImportLocalSkillsResult = z.infer<typeof ImportLocalSkillsResult>;

export const TaskSkillEntry = z.object({
  id: SkillId,
  slug: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  description: z.string().max(1024),
  enabled: z.boolean(),
  assigned: z.boolean(),
  disabledForTask: z.boolean(),
  activeForTask: z.boolean(),
  riskLevel: SkillRiskLevel,
  hasScripts: z.boolean(),
  requiresApproval: z.boolean(),
  risksApproved: z.boolean(),
}).strict();
export type TaskSkillEntry = z.infer<typeof TaskSkillEntry>;

export const TaskSkillsState = z.object({
  taskId: SkillId,
  agent: SkillAgentKind,
  skills: z.array(TaskSkillEntry),
}).strict();
export type TaskSkillsState = z.infer<typeof TaskSkillsState>;

export const PutTaskSkillOverridesBody = z.object({
  disabledSkillIds: z.array(SkillId).max(100),
}).strict();
export type PutTaskSkillOverridesBody = z.infer<typeof PutTaskSkillOverridesBody>;
