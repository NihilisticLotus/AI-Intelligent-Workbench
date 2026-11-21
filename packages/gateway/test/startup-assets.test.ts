import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('双击启动会重建缺少脚本或样式的界面，并识别依赖锁变更', async () => {
  const moduleUrl = new URL('../../../scripts/web-build.mjs', import.meta.url).href;
  const { webNeedsBuild } = await import(moduleUrl);
  const root = mkdtempSync(path.join(tmpdir(), 'aic-build-test-'));
  try {
    const dist = path.join(root, 'apps/web/dist'), assets = path.join(dist, 'assets');
    mkdirSync(assets, { recursive:true });
    const index = path.join(dist, 'index.html');
    writeFileSync(index, '<script type="module" src="/assets/client.js"></script><link rel="stylesheet" href="/assets/theme.css">');
    expect(webNeedsBuild(root)).toBe(true);
    writeFileSync(path.join(assets, 'client.js'), 'void 0');
    expect(webNeedsBuild(root)).toBe(true);
    writeFileSync(path.join(assets, 'theme.css'), 'body{}');
    expect(webNeedsBuild(root)).toBe(false);
    writeFileSync(path.join(root, 'package-lock.json'), '{}');
    utimesSync(index, 10, 10);
    expect(webNeedsBuild(root)).toBe(true);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
