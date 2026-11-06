// CodeBuddy 引擎版本（联调时发现卡片显示 0.0.0）：cli/package.json 写的是 0.0.0，真实版本嵌在 codebuddy.js 里。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readCodebuddyVersion } from '../src/codebuddy/index';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function engine(pkgVersion: string, js: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'aic-cb-ver-'));
  dirs.push(root);
  mkdirSync(path.join(root, 'dist'));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@genie/agent-cli', version: pkgVersion }));
  const file = path.join(root, 'dist', 'codebuddy.js');
  writeFileSync(file, js);
  return file;
}

describe('readCodebuddyVersion', () => {
  it('package.json 是 0.0.0 时，从 codebuddy.js 里嵌入的包信息读取', () => {
    const js = engine('0.0.0', 'var a=1;var p={"name":"@tencent-ai/codebuddy-code","version":"2.115.0","keywords":["codebuddy"]};');
    expect(readCodebuddyVersion(js)).toBe('2.115.0');
  });
  it('package.json 有真实版本时直接用', () => {
    expect(readCodebuddyVersion(engine('3.0.1', ''))).toBe('3.0.1');
  });
  it('都找不到时退回 package.json 的值', () => {
    expect(readCodebuddyVersion(engine('0.0.0', 'nothing here'))).toBe('0.0.0');
  });
});
