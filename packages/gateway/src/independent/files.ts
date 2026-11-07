// 定位 / 字面内容搜索 / 分段读取与 AGENTS.md 规则。文件内容只经固定宿主读取。
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { IndependentFileListSpec, IndependentFileListResult, IndependentFileReadSpec, IndependentFileReadResult,
  IndependentFileSearchSpec, IndependentFileSearchResult, IndependentProjectRules } from '@aic/protocol';
import { Errors } from '../util';
import { IndependentFileHost } from './file-host';
import { protectedFilePart, workspaceRelative } from './workspace';

const generated = new Set(['node_modules', 'library', 'temp', 'intermediate', 'binaries', 'saved', 'dist', 'build', 'coverage']);
function check(signal?: AbortSignal) { if (signal?.aborted) throw Errors.invalidState('文件操作已取消'); }
function decode(bytes: Uint8Array) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function clip(text: string, maximum: number) {
  const bytes = Buffer.from(text); if (bytes.length <= maximum) return { text, truncated: false };
  let end = maximum;
  for (;;) { try { return { text: decode(bytes.subarray(0, end)), truncated: true }; } catch { end--; } }
}
export class IndependentFiles {
  constructor(readonly host: IndependentFileHost) {}
  async list(input: IndependentFileListSpec, signal?: AbortSignal): Promise<IndependentFileListResult> {
    const spec = IndependentFileListSpec.parse(input); const root = this.host.workspace.root;
    const start = spec.directory === null ? '' : this.host.relative(spec.directory); const paths: string[] = [];
    let skipped = 0; let visited = 0; let outputBytes = 0; let truncated = false; const at = Date.now();
    const walk = async (relative: string, depth: number) => {
      check(signal); if (Date.now() - at > 30_000 || depth > 32 || visited >= 10_000) { truncated = true; return; }
      const absolute = relative ? path.join(root, relative) : root;
      const stat = await lstat(absolute); if (stat.isSymbolicLink() || !stat.isDirectory()) { skipped++; return; }
      const canonical = await realpath(absolute);
      if (canonical.toLowerCase() !== absolute.toLowerCase()) { skipped++; return; }
      const entries = []; const directory = await opendir(absolute);
      for await (const entry of directory) {
        check(signal);
        if (entries.length >= 10_000 - visited) { truncated = true; break; }
        entries.push(entry);
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        check(signal); if (++visited > 10_000 || paths.length >= spec.maxEntries) { truncated = true; break; }
        const candidate = relative ? relative + '/' + entry.name : entry.name;
        if (protectedFilePart(entry.name) || entry.isSymbolicLink()) { skipped++; continue; }
        try { this.host.relative(candidate); } catch { skipped++; continue; }
        if (entry.isDirectory()) { if (generated.has(entry.name.toLowerCase())) skipped++; else await walk(candidate, depth + 1); }
        else if (entry.isFile()) {
          const details = await lstat(path.join(root, candidate));
          if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) { skipped++; continue; }
          if (!spec.query || candidate.toLowerCase().includes(spec.query.toLowerCase())) {
            const size = Buffer.byteLength(JSON.stringify(candidate)) + 1;
            if (outputBytes + size > 63 * 1024) { truncated = true; break; }
            outputBytes += size; paths.push(candidate);
          }
        } else skipped++;
      }
    };
    await walk(start, 0); return IndependentFileListResult.parse({ paths, skipped, truncated });
  }
  async read(input: IndependentFileReadSpec, signal?: AbortSignal): Promise<IndependentFileReadResult> {
    const spec = IndependentFileReadSpec.parse(input); const file = await this.host.read(spec.path, signal); check(signal);
    const text = decode(file.bytes); const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []; if (lines.at(-1) === '') lines.pop();
    const endings = new Set((text.match(/\r\n|\r|\n/g) ?? []).map((s) => s === '\r\n' ? 'crlf' : s === '\r' ? 'cr' : 'lf'));
    const selected = lines.slice(spec.startLine - 1, spec.startLine - 1 + spec.maxLines); const output = clip(selected.join(''), 64 * 1024);
    return IndependentFileReadResult.parse({ path: spec.path, sha256: file.hash, fileId: file.fileId, size: file.bytes.length,
      text: output.text, startLine: spec.startLine, endLine: Math.min(lines.length, spec.startLine - 1 + selected.length), totalLines: lines.length,
      truncated: output.truncated || spec.startLine - 1 + selected.length < lines.length, bom: file.bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])),
      lineEnding: endings.size > 1 ? 'mixed' : endings.values().next().value ?? 'none' });
  }
  async search(input: IndependentFileSearchSpec, signal?: AbortSignal): Promise<IndependentFileSearchResult> {
    const spec = IndependentFileSearchSpec.parse(input);
    if (/[\r\n]/.test(spec.query)) throw Errors.badRequest('内容搜索按行匹配，请分别查询多行');
    const listed = await this.list({ directory: spec.directory, query: '', maxEntries: 2000 }, signal);
    if (!listed.paths.length) return { matches: [], scannedFiles: 0, scannedBytes: 0, skipped: listed.skipped, truncated: listed.truncated };
    const result = await this.host.search(listed.paths, spec.query, spec.caseSensitive, spec.maxMatches, signal); check(signal);
    return IndependentFileSearchResult.parse({ matches: result.Matches.map((m) => ({ path: m.Path, line: m.Line, text: decode(Buffer.from(m.TextBase64, 'base64')), textTruncated: m.TextTruncated })),
      scannedFiles: result.ScannedFiles, scannedBytes: result.ScannedBytes, skipped: listed.skipped + result.Skipped, truncated: listed.truncated || result.Truncated });
  }
  async rules(target: string | null = null, signal?: AbortSignal): Promise<IndependentProjectRules> {
    const parts = target === null ? [] : workspaceRelative(target).split('/').slice(0, -1);
    if (parts.length > 32) throw Errors.tooLarge('目标目录过深，无法完整核对项目规则');
    const paths = ['AGENTS.md', ...parts.map((_, index) => parts.slice(0, index + 1).join('/') + '/AGENTS.md')];
    const result = await this.host.rules(paths, signal); check(signal);
    const files: IndependentProjectRules['files'] = []; const notices: string[] = [];
    for (const item of result) {
      if (!item.ok) { if (item.reason !== 'not_found') notices.push(`${item.path} 的规则无法完整读取，修改前需要核对`); continue; }
      const bytes = Buffer.from(item.data, 'base64');
      if (createHash('sha256').update(bytes).digest('hex') !== item.hash) throw Errors.invalidState('项目规则传输摘要不一致');
      files.push({ path: item.path, sha256: item.hash, text: decode(bytes) });
    }
    return IndependentProjectRules.parse({ files, fingerprint: createHash('sha256').update(JSON.stringify(files.map((f) => [f.path, f.sha256]))).digest('hex'), complete: notices.length === 0, notices });
  }
}
