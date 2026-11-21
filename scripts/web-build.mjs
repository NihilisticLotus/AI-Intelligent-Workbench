// 双击启动前检查网页文件。可用隔离目录验证，无需启动服务或安装依赖。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** 递归取最新的修改时间（跳过 node_modules / dist） */
function newest(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = st.mtimeMs;
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name === 'dist') continue;
    t = Math.max(t, newest(path.join(p, name)));
  }
  return t;
}

/** 只检查构建器写入入口的本地资源。 */
function entriesReady(index) {
  const html = readFileSync(index, 'utf8');
  const assets = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']\/assets\/([\w.-]+)["'][^>]*>/gi)];
  if (!assets.some(([tag]) => tag.startsWith('<script'))) return false;
  return assets.every(([, name]) => {
    const stat = statSync(path.join(path.dirname(index), 'assets', name), { throwIfNoEntry: false });
    return stat?.isFile() && stat.size > 0;
  });
}

/** 网页入口缺失、产物不完整或构建输入更新时重新构建。 */
export function webNeedsBuild(root) {
  const distIndex = path.join(root, 'apps', 'web', 'dist', 'index.html');
  if (!existsSync(distIndex) || !entriesReady(distIndex)) return true;
  const built = statSync(distIndex).mtimeMs;
  const sources = [
    path.join(root, 'package-lock.json'),
    path.join(root, 'tsconfig.base.json'),
    path.join(root, 'apps', 'web', 'src'),
    path.join(root, 'apps', 'web', 'index.html'),
    path.join(root, 'apps', 'web', 'vite.config.ts'),
    path.join(root, 'apps', 'web', 'tsconfig.json'),
    path.join(root, 'apps', 'web', 'package.json'),
    path.join(root, 'packages', 'protocol', 'src'),
    path.join(root, 'packages', 'protocol', 'package.json'),
  ];
  return Math.max(...sources.map(newest)) > built;
}
