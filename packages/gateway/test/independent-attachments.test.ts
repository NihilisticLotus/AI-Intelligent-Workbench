import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer, type Server } from 'node:http';
import { deflateSync } from 'node:zlib';
import { IndependentCommandSpec } from '@aic/protocol';
import { openDb, type Db } from '../src/db';
import { AttachmentService } from '../src/attachments';
import { IndependentAttachments } from '../src/independent/attachments';
import { IndependentCommandExecutor } from '../src/independent/commands';
import { IndependentApiDriver } from '../src/independent/model-driver';
import { IndependentCatalog } from '../src/independent/catalog';
import { EventBus, EventStore } from '../src/events';
import { MemorySecretStore, SecretService } from '../src/secrets';
import { seed } from './fixtures/independent-journal';

const fixtures: { directory: string; db: Db; executor: IndependentCommandExecutor }[] = [], servers: Server[] = [];
const digest = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), 'aic-independent-attachments-')), data = path.join(directory, '.aic-data'); mkdirSync(data);
  const db = openDb(':memory:'); seed(db); const executor = new IndependentCommandExecutor(data), attachments = new AttachmentService(db, data, executor);
  const loader = new IndependentAttachments(attachments); fixtures.push({ directory, db, executor });
  return { directory, data, db, attachments, executor, loader, signal: new AbortController().signal };
}
// 完整的 RGBA PNG，附加合法文本块用于验证大于普通命令输出上限的私有管道。
function png(extra = 0) {
  const chunk = (name: string, bytes: Buffer) => {
    const type = Buffer.from(name), raw = Buffer.concat([type, bytes]); let crc = 0xffffffff;
    for (const byte of raw) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4), check = Buffer.alloc(4); length.writeUInt32BE(bytes.length); check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, raw, check]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), ...(extra ? [chunk('tEXt', Buffer.concat([Buffer.from('fixture\0'), Buffer.alloc(extra, 65)]))] : []),
    chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255]))), chunk('IEND', Buffer.alloc(0))]);
}
afterEach(async () => {
  vi.restoreAllMocks(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
  for (const f of fixtures.splice(0)) {
    await f.executor.close(); f.db.close(); const target = path.resolve(f.directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('aic-independent-attachments-')) throw Error('拒绝范围外清理');
    rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe('独立附件的实际上传与受限读取', () => {
  it('文本保留字节、BOM / 换行和上传摘要，不走普通路径读取，使用后保留引用', async () => {
    const f = setup(), bytes = Buffer.from('\ufeff第一行\r\n第二行\r\n'), a = f.attachments.upload('task', '文件.txt', bytes);
    const read = vi.spyOn(f.attachments, 'read'), get = vi.spyOn(f.attachments, 'get');
    expect(await f.loader.load('task', a.id, f.signal)).toMatchObject({ attachmentId: a.id, name: a.name, kind: 'text', base64: bytes.toString('base64') });
    expect(f.attachments.snapshot('task', a.id).sha256).toBe(digest(bytes)); expect(read).toHaveBeenCalledTimes(1); expect(get).not.toHaveBeenCalled();
    expect(f.db.get<{ used_at: number }>('SELECT used_at FROM attachments WHERE id=?', a.id)!.used_at).toBeGreaterThan(0);
    expect(f.db.all('SELECT * FROM events')).toHaveLength(0);
  });
  it('完整 PNG 达到 5 MiB 仍可准确读取，公开命令上限保持 1 MiB', async () => {
    const f = setup(), bytes = png(5 * 1024 * 1024 - png().length - 20), a = f.attachments.upload('task', '图片.png', bytes); expect(bytes.length).toBe(5 * 1024 * 1024);
    const reply = await f.loader.load('task', a.id, f.signal); expect(reply.kind).toBe('image'); expect(Buffer.from(reply.base64, 'base64')).toEqual(bytes);
    expect(IndependentCommandSpec.safeParse({ program: '任意程序', args: [], timeoutMs: 1000, maxOutputBytes: 1024 * 1024 + 1 }).success).toBe(false);
  });
  it('跨任务身份、缺失 / 非法编号、二进制和超限文本在启动宿主前拒绝', async () => {
    const f = setup(), a = f.attachments.upload('task', '文本', Buffer.from('仅此任务')), binary = f.attachments.upload('task', '二进制', Buffer.from([0,1,2])), large = f.attachments.upload('task', '大文本', Buffer.alloc(512 * 1024 + 1, 65));
    const run = vi.spyOn(f.executor, 'run');
    for (const [task, id] of [['other',a.id],['task','att_missing'],['../task',a.id],['task','../file'],['task',binary.id],['task',large.id]]) await expect(f.loader.load(task!, id!, f.signal)).rejects.toBeDefined();
    expect(run).not.toHaveBeenCalled();
  });
  it.each(['hash','size','missing'])('上传后磁盘 %s 变化不能读取为原附件', async (mode) => {
    const f = setup(), a = f.attachments.upload('task', '文本', Buffer.from('original')), file = f.attachments.get('task', a.id).path;
    if (mode === 'missing') rmSync(file); else writeFileSync(file, mode === 'hash' ? 'modified' : 'longer than original');
    await expect(f.loader.load('task', a.id, f.signal)).rejects.toBeDefined();
  });
  it('已有外部硬链接在正文读取前拒绝，外部原文不变', async () => {
    const f = setup(), a = f.attachments.upload('task', '文本', Buffer.from('无密钥的临时夹具')), file = f.attachments.get('task', a.id).path;
    const outside = path.join(f.directory, 'external'); linkSync(file, outside);
    await expect(f.loader.load('task', a.id, f.signal)).rejects.toBeDefined(); expect(readFileSync(outside, 'utf8')).toBe('无密钥的临时夹具');
  });
  it.each(['attachments','task'])('附件 %s 目录联接在读取前拒绝', async (mode) => {
    const f = setup(), a = f.attachments.upload('task', '文本', Buffer.from('只在临时夹具'));
    const original = path.join(f.data, 'attachments', ...(mode === 'task' ? ['task'] : [])), outside = path.join(f.directory, 'moved');
    renameSync(original, outside); symlinkSync(outside, original, 'junction');
    await expect(f.loader.load('task', a.id, f.signal)).rejects.toBeDefined();
  });
  it('其他写句柄阻止读取，解除占用后可按原摘要读取', async () => {
    const f = setup(), a = f.attachments.upload('task', '文本', Buffer.from('锁定内容')), file = f.attachments.get('task', a.id).path;
    const handle = openSync(file, 'r+'); try { await expect(f.loader.load('task', a.id, f.signal)).rejects.toBeDefined(); } finally { closeSync(handle); }
    expect((await f.loader.load('task', a.id, f.signal)).base64).toBe(Buffer.from('锁定内容').toString('base64'));
  });
  it('通用下载保留 20 MiB 二进制范围，停止服务后拒绝再派发读取', async () => {
    const f = setup(), bytes = Buffer.alloc(20 * 1024 * 1024, 1), a = f.attachments.upload('task', '二进制', bytes);
    const read = await f.attachments.read('task', a.id); expect(read.bytes.length).toBe(bytes.length); expect(digest(read.bytes)).toBe(digest(bytes));
    await f.attachments.close(); const run = vi.spyOn(f.executor, 'run'); await expect(f.attachments.read('task', a.id)).rejects.toMatchObject({ body: { code: 'attachment.read_failed' } }); expect(run).not.toHaveBeenCalled();
  }, 30_000);
  it('私有数据根位于模拟原生凭据目录时拒绝读取', async () => {
    const f = setup(), root = path.join(f.directory, '.claude', 'fake-data'); mkdirSync(root, { recursive: true });
    const service = new AttachmentService(f.db, root, f.executor), a = service.upload('task', '无密钥夹具', Buffer.from('仅临时文本'));
    await expect(service.read('task', a.id)).rejects.toMatchObject({ body: { code: 'attachment.read_failed' } });
  });
  it('回传后任务元数据变化拒绝，取消前不派发宿主', async () => {
    const f = setup(), a = f.attachments.upload('task', '文本', Buffer.from('上传内容')), run = f.executor.run.bind(f.executor);
    vi.spyOn(f.executor, 'run').mockImplementationOnce(async (spec, options) => { const result = await run(spec, options); f.db.run('UPDATE attachments SET name=? WHERE id=?', '另一份元数据', a.id); return result; });
    await expect(f.loader.load('task', a.id, f.signal)).rejects.toBeDefined();
    const spy = vi.spyOn(f.executor, 'run'); spy.mockClear(); await expect(f.loader.load('task', a.id, AbortSignal.abort())).rejects.toMatchObject({ reason: 'cancelled' }); expect(spy).not.toHaveBeenCalled();
  });
  it('读取宿主最多同时两个、最多等待 32 个，取消队列不派发程序', async () => {
    const f = setup(), bytes = Buffer.from('队列夹具'), a = f.attachments.upload('task', '文本', bytes);
    const release: (() => void)[] = [], result = { reason: 'completed' as const, exitCode: 0, stdout: JSON.stringify({ ok: true, data: bytes.toString('base64'), hash: digest(bytes) }), stderr: '', outputBytes: 100, truncated: false, durationMs: 1 };
    const run = vi.spyOn(f.executor, 'run').mockImplementation(() => new Promise((resolve) => release.push(() => resolve(result))));
    const abort = new AbortController(), ended: string[] = [];
    const reads = Array.from({ length: 35 }, () => f.attachments.read('task', a.id, abort.signal).then(() => '意外成功', (e) => { ended.push(e.body.code); return e.body.code; }));
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2)); await vi.waitFor(() => expect(ended).toHaveLength(1)); abort.abort(); release.forEach((r) => r());
    expect((await Promise.all(reads)).every((code) => code === 'attachment.read_failed')).toBe(true); expect(run).toHaveBeenCalledTimes(2);
  });
  it.each(['cancel','shutdown'])('读取期间 %s 真正收尾作业并解除文件锁，私有请求不含正文', async (mode) => {
    const f = setup(), bytes = Buffer.from('不可写入请求文件的附件正文'), a = f.attachments.upload('task', '文本', bytes), marker = path.join(f.directory, 'paused');
    const source = fileURLToPath(new URL('../src/independent/file-guard.cs', import.meta.url)), copy = path.join(f.directory, 'guard-copy.cs');
    const anchor = 'if (stream.Length != expectedSize || stream.Length > maximum) throw Error("conflict");'; const original = readFileSync(source, 'utf8'); expect(original.split(anchor)).toHaveLength(2);
    writeFileSync(copy, original.replace(anchor, `System.IO.File.WriteAllText(@"${marker.replaceAll('"', '""')}", "paused"); System.Threading.Thread.Sleep(30000); ${anchor}`));
    const run = f.executor.run.bind(f.executor); let requestFile = '';
    vi.spyOn(f.executor, 'run').mockImplementationOnce((spec, options) => {
      const args = [...spec.args], command = Buffer.from(args.at(-1)!, 'base64').toString('utf16le');
      requestFile = command.match(/\)\)\) '([^']+request\.json)'/)?.[1] ?? '';
      args[args.length - 1] = Buffer.from(command.replace(source, copy), 'utf16le').toString('base64'); return run({ ...spec, args }, options);
    });
    const abort = new AbortController(), loading = f.loader.load('task', a.id, abort.signal); await vi.waitFor(() => expect(existsSync(marker)).toBe(true), { timeout: 10_000 });
    expect(requestFile).toBeTruthy(); expect(readFileSync(requestFile, 'utf8')).not.toContain(bytes.toString());
    const rejected = expect(loading).rejects.toMatchObject({ reason: mode === 'cancel' ? 'cancelled' : 'request' });
    if (mode === 'cancel') abort.abort(); else await f.attachments.close();
    await rejected; writeFileSync(f.attachments.get('task', a.id).path, bytes); expect(existsSync(requestFile)).toBe(false);
  }, 20_000);
  it.each(['chat_completions','responses','anthropic_messages'] as const)('%s 接入真实上传与宿主读取后只发送内联内容，原始会话仍仅引用', async (protocol) => {
    const f = setup(), image = png(), a = f.attachments.upload('task', '真实 PNG', image), text = f.attachments.upload('task', '说明', Buffer.from('附件内文夹具')); let body: any;
    const server = createServer((req, res) => { void (async () => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk); body = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(protocol === 'chat_completions'
        ? { choices: [{ index: 0, message: { role: 'assistant', content: '已接收' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        : protocol === 'responses' ? { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已接收' }] }], usage: { input_tokens: 1, output_tokens: 1 } }
          : { type: 'message', role: 'assistant', content: [{ type: 'text', text: '已接收' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); })().catch(() => res.destroy()); });
    servers.push(server); await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const catalog = new IndependentCatalog(f.db, new SecretService(f.db, new MemorySecretStore()), new EventStore(f.db, new EventBus()));
    const service = await catalog.createService({ name: '回环夹具', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, protocol, authentication: 'none', enabled: true, apiVersion: '2023-06-01', providerId: null, plan: null });
    let model = catalog.createModel(service.id, { name: '图片夹具', remoteModelId: 'fixture' }); model = catalog.overrides(service.id, model.id, { expectedRevision: model.revision, values: { imageInput: true } });
    const binding = catalog.bind('task', { serviceId: service.id, modelId: model.id }), messages = [{ role: 'user' as const, text: '看附件', attachments: [{ attachmentId: a.id }, { attachmentId: text.id }] }];
    const driver = new IndependentApiDriver(catalog, { loadAttachment: (task, id, signal) => f.loader.load(task, id, signal) });
    expect((await driver.complete({ binding, messages, checkpoint: null, systemPrompt: '', maxOutputTokens: 100 }, f.signal)).text).toBe('已接收');
    expect(JSON.stringify(body)).toContain(image.toString('base64')); expect(JSON.stringify(body)).toContain('附件内文夹具'); expect(JSON.stringify(body)).not.toContain(f.directory);
    expect(JSON.stringify(messages)).not.toContain(image.toString('base64')); expect(JSON.stringify(messages)).not.toContain('附件内文夹具');
  }, 30_000);
});
