// 托管网页构建产物（apps/web/dist）。非文件路径一律回退到 index.html（单页应用）。
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Ctx } from './app';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const NOT_BUILT = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AI Console</title>
<style>body{font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif;background:#1e1f22;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:520px;padding:24px}code{background:#2b2d31;padding:2px 6px;border-radius:4px}</style></head>
<body><main><h1>AI Console 已启动</h1><p>但网页界面还没有构建。请关掉这个窗口，重新双击“启动 AI Console”，它会自动完成构建。</p>
<p>开发者可以运行 <code>npm run build</code> 后刷新本页。</p></main></body></html>`;

async function fileIfExists(p: string) {
  try { const st = await stat(p); return st.isFile() ? p : null; } catch { return null; }
}

export function staticHandler(distDir: string) {
  const root = path.resolve(distDir);
  return async (c: Ctx) => {
    let rel: string;
    try { rel = decodeURIComponent(c.req.path); } catch { return c.text('地址不正确', 400); }
    if (rel.includes('\0')) return c.text('地址不正确', 400);
    const target = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
    // 防止路径穿越：解析后必须仍在 dist 目录内
    if (target !== root && !target.startsWith(root + path.sep)) return c.text('地址不正确', 400);

    let file = await fileIfExists(target);
    const looksLikeAsset = path.extname(rel) !== '';
    if (!file && !looksLikeAsset) file = await fileIfExists(path.join(root, 'index.html'));
    if (!file) {
      if (looksLikeAsset) return c.text('找不到文件', 404);
      return c.html(NOT_BUILT, 200, { 'Cache-Control': 'no-store' });
    }
    const ext = path.extname(file).toLowerCase();
    const body = await readFile(file);
    const isIndex = path.basename(file) === 'index.html';
    // Vite 产物带内容哈希，可以长期缓存；index.html 每次都重新取
    const cache = isIndex ? 'no-cache' : rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    return c.body(body, 200, { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Cache-Control': cache });
  };
}
