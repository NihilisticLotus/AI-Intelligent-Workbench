// 相对路径与敏感目录策略；最终文件内容的句柄检查仍由 Windows 宿主负责。
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { IndependentRelativePath } from '@aic/protocol';
import { Errors } from '../util';

const blocked = new Set(['.git', '.aic-data', '.claude', '.codex', '.codebuddy', '.workbuddy', '.zcode', '.ssh', '.aws', '.azure', 'auth.json', 'credentials.json', 'credentials', '.npmrc', '.netrc', '.pypirc']);
export function protectedFilePart(input: string) {
  const part = input.toLowerCase();
  return blocked.has(part) || part === '.env' || part.startsWith('.env.') || part.startsWith('.aic-stage-') || part.startsWith('.aic-old-') || /\.(pem|key|pfx|p12)$/.test(part);
}
export function workspaceRelative(input: string) {
  const relative = IndependentRelativePath.parse(input);
  if (relative.split('/').some(protectedFilePart)) throw Errors.forbidden('此路径属于凭据、私有状态或受保护目录，不能由独立文件工具访问');
  return relative;
}
export function independentWorkspace(input: string) {
  if (!path.isAbsolute(input) || lstatSync(input).isSymbolicLink()) throw Errors.forbidden('工作区必须是已确认的普通本机目录');
  const root = realpathSync.native(input); const stat = lstatSync(root, { bigint: true });
  if (!stat.isDirectory() || root === path.parse(root).root || root.split(/[\\/]/).some(protectedFilePart)) throw Errors.forbidden('不能把此目录用作独立文件工具的工作区');
  return { root, fingerprint: createHash('sha256').update(JSON.stringify([root.toLowerCase(), String(stat.dev), String(stat.ino)])).digest('hex') };
}
