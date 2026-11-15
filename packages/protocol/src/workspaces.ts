import { z } from 'zod';

// 工作区协议只新增；旧 shadow 与 inplace 的含义保持不变。
export const WorkspaceKind = z.enum(['worktree', 'copy', 'shadow', 'inplace']);
export type WorkspaceKind = z.infer<typeof WorkspaceKind>;
export const WorkspaceGlobs = z.array(z.string().trim().min(1).max(500).refine(v => !v.includes('\\') && !v.startsWith('/') && !v.includes(':') && !v.split('/').includes('..') && !v.includes('\0'), '请输入项目内的相对通配符')).max(100);
export const TaskWorkspace = z.object({
  kind: WorkspaceKind, path: z.string().nullable(), branch: z.string().nullable(), baseRef: z.string().nullable(), baseBranch: z.string().nullable(),
  state: z.enum(['preparing', 'ready', 'confirmation_required', 'failed']).optional(),
  copyBytes: z.number().nonnegative().optional(), largeFiles: z.array(z.string()).optional(), error: z.string().optional(),
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
});
export type WorkspaceRecord = z.infer<typeof WorkspaceRecord>;
export const WorkspaceChange = z.object({
  path: z.string(), oldPath: z.string().optional(), status: z.enum(['A', 'M', 'D', 'R']),
  added: z.number().int().nonnegative(), removed: z.number().int().nonnegative(),
  binary: z.boolean(), tooLarge: z.boolean(), beforeSize: z.number().nonnegative(), afterSize: z.number().nonnegative(),
});
export type WorkspaceChange = z.infer<typeof WorkspaceChange>;
export const WorkspaceChanges = z.object({ files: z.array(WorkspaceChange), added: z.number(), removed: z.number() });
export type WorkspaceChanges = z.infer<typeof WorkspaceChanges>;
export const WorkspaceFileDiff = z.object({ file: WorkspaceChange, patch: z.string().nullable() });
export type WorkspaceFileDiff = z.infer<typeof WorkspaceFileDiff>;
