import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FsBrowseResult } from '@aic/protocol';
import { startGw, type TestGw } from './helpers';

let t: TestGw; let token: string; let root: string;
beforeEach(async () => {
  t = await startGw();
  token = await t.pair();
  root = mkdtempSync(path.join(t.dataDir, 'browse-'));
  mkdirSync(path.join(root, 'UnityGame', '.git'), { recursive: true });
  mkdirSync(path.join(root, 'Art'));
  writeFileSync(path.join(root, 'readme.txt'), 'x');
  writeFileSync(path.join(root, 'Art', 'hero.png'), 'x');
});
afterEach(async () => { await t.stop(); });

const browse = (p?: string) => t.api('GET', `/fs/browse${p === undefined ? '' : `?path=${encodeURIComponent(p)}`}`, { token });

describe('/fs/browse', () => {
  it('不传 path 时列出盘符和常用位置', async () => {
    const r = await browse();
    expect(r.status).toBe(200);
    const body = r.json as FsBrowseResult;
    expect(body.path).toBeNull();
    expect(body.entries.some((e) => e.kind === 'drive')).toBe(true);
    expect(body.entries.some((e) => e.kind === 'home')).toBe(true);
  });

  it('只列目录，不列文件；标出 git 项目；给出上一级', async () => {
    const r = await browse(root);
    expect(r.status).toBe(200);
    const body = r.json as FsBrowseResult;
    expect(body.entries.map((e) => e.name).sort()).toEqual(['Art', 'UnityGame']);
    expect(body.entries.find((e) => e.name === 'UnityGame')!.isGit).toBe(true);
    expect(body.entries.find((e) => e.name === 'Art')!.isGit).toBe(false);
    expect(body.parent).toBe(path.dirname(root));
    // 返回的 path 可以原样再传回来
    const sub = await browse(body.entries.find((e) => e.name === 'Art')!.path);
    expect(sub.json.entries).toEqual([]);
  });

  it('不允许路径穿越、相对路径、网络路径', async () => {
    for (const p of [
      path.join(root, 'Art') + `${path.sep}..${path.sep}..`,
      `${root}/Art/../../..`,
      'Art',
      '..\\..\\Windows',
      '\\\\server\\share',
      '//server/share',
      '\\\\?\\C:\\Windows',
      `${root}\u0000x`,
    ]) {
      const r = await browse(p);
      expect(r.status, p).toBe(400);
      expect(r.json.code).toBe('request.invalid');
    }
  });

  it('文件路径和不存在的路径报错', async () => {
    expect((await browse(path.join(root, 'readme.txt'))).status).toBe(400);
    expect((await browse(path.join(root, 'nope'))).status).toBe(404);
  });

  it('需要令牌', async () => {
    expect((await t.api('GET', '/fs/browse')).status).toBe(401);
  });
});

describe('/fs/browse 分页', () => {
  it('先全量排序再按游标分页，不会静默截断', async () => {
    const big = path.join(root, 'Content');
    mkdirSync(big);
    // 名字故意打乱：分页结果必须是整体排序后的连续切片
    const names = Array.from({ length: 25 }, (_, i) => `Level_${String((i * 7) % 25).padStart(2, '0')}`);
    for (const n of names) mkdirSync(path.join(big, n));
    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    do {
      const q = `?path=${encodeURIComponent(big)}&limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const r = await t.api('GET', `/fs/browse${q}`, { token });
      expect(r.status).toBe(200);
      const body = r.json as FsBrowseResult;
      expect(body.entries.length).toBeLessThanOrEqual(10);
      seen.push(...body.entries.map((e) => e.name));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...names].sort());
    expect((await t.api('GET', `/fs/browse?path=${encodeURIComponent(big)}&cursor=bad!`, { token })).status).toBe(400);
  });
});
