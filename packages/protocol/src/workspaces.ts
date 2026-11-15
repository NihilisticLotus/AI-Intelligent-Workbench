import { z } from 'zod';

// 工作区协议只新增；旧 shadow 与 inplace 的含义保持不变。
export const WorkspaceKind = z.enum(['worktree', 'copy', 'shadow', 'inplace']);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;
export const WorkspaceGlobs = z.array(z.string().trim().min(1).max(500).refine(v => !v.includes('\\') && !v.startsWith('/') && !v.includes(':') && !v.split('/').includes('..') && !v.includes('\0'), '请输入项目内的相对通配符')).max(100);
export const TaskWorkspace = z.object({
  kind: WorkspaceKind, path: z.string().nullable(), branch: z.string().nullable(), baseRef: z.string().nullable(), baseBranch: z.string().nullable(),
  state: z.enum(['preparing', 'ready', 'confirmation_required', 'failed']).optional(),
  copyBytes: z.number().nonnegative().optional(), largeFiles: z.array(z.string()).optional(), error: z.string().optional(),
  operation: z.lazy(() => WorkspaceOperationRecord.omit({ appliedFiles: true })).optional(),
});
export type TaskWorkspace = z.infer<typeof TaskWorkspace>;
export const PrepareWorkspaceBody = z.object({ confirmLargeCopy: z.literal(true) }).strict();
export const WorkspaceFile = z.object({
  path: z.string(), size: z.number().nonnegative(), mtimeMs: z.number(), hash: z.string(),
});
export type WorkspaceFile = z.infer<typeof WorkspaceFile>;
export const WorkspaceRequest = z.object({
  taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  title: z.string().max(1000), projectPath: z.string().min(1),
  ignoreGlobs: z.array(z.string()).default([]), carryGlobs: z.array(z.string()).default([]),
  confirmLargeCopy: z.boolean().default(false),
});
export type WorkspaceRequest = z.infer<typeof WorkspaceRequest>;
export const WorkspaceRecord = z.object({
  taskId: z.string(), projectId: z.string(), kind: z.enum(['worktree', 'copy']),
  path: z.string(), projectPath: z.string(), gitDir: z.string().nullable(), worktreeGitDir: z.string().nullable().default(null),
  branch: z.string().nullable(), baseBranch: z.string().nullable(), baseRef: z.string().nullable(),
  snapshotBefore: z.string().nullable(), snapshotAfter: z.string().nullable(),
  ignoreGlobs: z.array(z.string()), largeFiles: z.array(WorkspaceFile),
  sourceFiles: z.array(WorkspaceFile), snapshotFiles: z.array(WorkspaceFile).default([]), lfs: z.boolean(),
  state: z.enum(['preparing', 'ready', 'removing', 'failed']), createdAt: z.number(),
  removalRef: z.string().optional(),
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;
export const WorkspaceChange = z.object({
  path: z.string(), oldPath: z.string().optional(), status: z.enum(['A', 'M', 'D', 'R']),
  added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(),
  binary: z.boolean(), tooLarge: z.boolean(), beforeSize: z.number().nonnegative(), afterSize: z.number().nonnegative(),
});
export type WorkspaceChange = z.infer<typeof WorkspaceChange>;
export const WorkspaceChanges = z.object({ files: z.array(WorkspaceChange), added: z.number(), removed: z.number(), revision: z.string().optional() });
export type WorkspaceChanges = z.infer<typeof WorkspaceChanges>;
export const WorkspaceFileDiff = z.object({ file: WorkspaceChange, patch: z.string().nullable() });
export type WorkspaceFileDiff = z.infer<typeof WorkspaceFileDiff>;

export const RestoreWorkspaceFileBody = z.object({ path: z.string().min(1).max(4096) }).strict();
export const WorkspaceChangeTotals = WorkspaceChanges.pick({ added: true, removed: true }).extend({ fileCount: z.number().int().nonnegative() });
export const WorkspaceDiffLine = z.object({ kind: z.enum(['context', 'add', 'remove', 'header', 'note']), text: z.string(), oldLine: z.number().nullable(), newLine: z.number().nullable() });
export type WorkspaceDiffLine = z.infer<typeof WorkspaceDiffLine>;

export const MergeWorkspaceBody = z.object({ strategy: z.enum(['squash', 'merge']), message: z.string().trim().min(1).max(4000) }).strict();
export type MergeWorkspaceBody = z.infer<typeof MergeWorkspaceBody>;
export const WorkspaceOperationResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('merged'), commit: z.string() }),
  z.object({ status: z.literal('applied'), files: z.array(z.string()), skippedLargeFiles: z.array(z.string()) }),
  z.object({ status: z.literal('conflict'), files: z.array(z.string()) }),
  z.object({ status: z.literal('dirty'), files: z.array(z.string()) }),
  z.object({ status: z.literal('source_changed'), files: z.array(z.string()) }),
  z.object({ status: z.literal('wrong_branch'), expected: z.string().nullable(), actual: z.string().nullable() }),
  z.object({ status: z.literal('new_commits'), expected: z.string(), actual: z.string() }),
  z.object({ status: z.literal('rolled_back'), skippedLargeFiles: z.array(z.string()), commit: z.string().optional() }),
  z.object({ status: z.literal('discarded') }),
  z.object({ status: z.literal('no_changes') }),
]);
export type WorkspaceOperationResult = z.infer<typeof WorkspaceOperationResult>;
export const WorkspaceOperationRecord = z.object({
  taskId: z.string(), state: z.enum(['merged', 'applied', 'discarded', 'rolled_back', 'restored', 'conflict', 'pending']),
  beforeCommit: z.string().nullable(), mergeCommit: z.string().nullable(), rollbackCommit: z.string().nullable(),
  strategy: z.enum(['squash', 'merge']).nullable(), conflictFiles: z.array(z.string()),
  appliedFiles: z.array(WorkspaceFile), changedFiles: z.array(z.string()), skippedLargeFiles: z.array(z.string()),
  finishedAt: z.number(), removedAt: z.number().nullable(),
  pending: z.object({kind:z.enum(['merge','rollback']),headBefore:z.string(),expectedTree:z.string()}).optional(),
});
export type WorkspaceOperationRecord = z.infer<typeof WorkspaceOperationRecord>;
export const WorkspaceRetention = z.object({ days: z.number().int().min(1).max(365) }).strict();
export type WorkspaceRetention = z.infer<typeof WorkspaceRetention>;

// 可信文件宿主内部协议；不提供给 Agent 或网页作为任意文件写入入口。
export const WorkspaceTransferItem = z.object({path:z.string(),expectedHash:z.string().nullable(),source:z.string().nullable(),sourceHash:z.string().nullable()});
export type WorkspaceTransferItem = z.infer<typeof WorkspaceTransferItem>;
export const WorkspaceTransferReply = z.object({ok:z.boolean(),files:z.array(z.string()),reason:z.enum(['forbidden','not_found','busy','conflict','io_error','interrupted']).optional()});
