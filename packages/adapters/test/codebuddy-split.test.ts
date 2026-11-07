// CodeBuddy 和 WorkBuddy 拆成两个独立 Agent（ISSUE-0016）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapters, createCodebuddyAdapter, createWorkbuddyAdapter, findCodebuddyStandalone, isLiteOnlyEngine } from '../src/index';

const rt = { log: () => {} };
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

/** 造一个 WorkBuddy 的 cli 目录：bin/codebuddy + dist 里指定的文件 */
function fakeCli(distFiles: string[]) {
  const root = mkdtempSync(path.join(tmpdir(), 'aic-wb-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'bin', 'codebuddy'), '#!/usr/bin/env node\n');
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '2.165.0' }));
  for (const f of distFiles) writeFileSync(path.join(root, 'dist', f), '');
  return path.join(root, 'bin', 'codebuddy');
}

describe('CodeBuddy / WorkBuddy 拆分', () => {
  it('Agent 列表里是两个独立的 Agent', () => {
    const ids = createAdapters(rt).map((a) => a.id);
    expect(ids).toContain('codebuddy');
    expect(ids).toContain('workbuddy');
  });

  it('CodeBuddy 默认用工作台自带的独立版引擎（node_modules），不依赖 WorkBuddy 的安装目录', () => {
    const loc = findCodebuddyStandalone();
    expect(loc.js).toBeTruthy();
    expect(loc.js!.replace(/\\/g, '/')).toMatch(/@tencent-ai\/codebuddy-code\/bin\/codebuddy$/);
    expect(loc.js!.toLowerCase()).not.toContain('workbuddy');
  });

  it('只带精简引擎的 WorkBuddy 识别为“暂不支持”，带完整引擎时正常', () => {
    expect(isLiteOnlyEngine(fakeCli(['codebuddy-lite-wb.mjs']))).toBe(true);
    expect(isLiteOnlyEngine(fakeCli(['codebuddy-lite-wb.mjs', 'codebuddy-headless.js']))).toBe(false);
    expect(isLiteOnlyEngine(fakeCli(['codebuddy.js']))).toBe(false);
    expect(isLiteOnlyEngine('C:/x/dist/codebuddy.js')).toBe(false);
  });

  it('WorkBuddy 精简引擎：检测结果为 unsupported，不启动引擎，启动时给出明确原因', async () => {
    const wb = createWorkbuddyAdapter({ ...rt, enginePath: fakeCli(['codebuddy-lite-wb.mjs']) });
    const d = await wb.detect({ force: true });
    expect(d.installed).toBe(true);
    expect(d.unsupported).toBe(true);
    expect(d.loggedIn).toBe(false);
    expect(d.message).toContain('ISSUE-0016');
    expect(d.engineSource).toBe('app');
  });

  it('登录方式分开：CodeBuddy 在浏览器里登录，WorkBuddy 只能在 WorkBuddy 里登录', async () => {
    const cb = createCodebuddyAdapter({ ...rt, enginePath: path.join(tmpdir(), 'aic-not-there') });
    const d = await cb.detect({ force: true });
    expect(d.installed).toBe(false);
    expect((d.authMethods ?? []).map((m) => m.id)).not.toContain('workbuddy-app');
    expect(d.message).not.toContain('WorkBuddy');
    const wb = createWorkbuddyAdapter({ ...rt, enginePath: fakeCli(['codebuddy-lite-wb.mjs']) });
    expect(((await wb.detect({ force: true })).authMethods ?? []).map((m) => m.id)).toEqual(['workbuddy-app']);
    expect(wb.authMethods).toEqual(['oauth']);
  });
});
