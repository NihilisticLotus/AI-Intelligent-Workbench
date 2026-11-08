// 浏览器离线验收专用：只监听本机，返回固定模型 / 工具调用，不连接外网或执行模型指令。
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const data = path.resolve('.aic-data'); mkdirSync(data, { recursive: true });
const workspace = mkdtempSync(path.join(tmpdir(), 'aic-browser-independent-'));
writeFileSync(path.join(workspace, 'AGENTS.md'), '请使用中文。仅操作本次临时验收项目。\n');
writeFileSync(path.join(data, 'runtime-fixture-workspace.txt'), workspace);
let requests = 0;
const server = createServer((req, res) => { void (async () => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'browser-one' }, { id: 'browser-two' }] })); return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString()); requests++;
  writeFileSync(path.join(data, 'runtime-fixture-count.txt'), String(requests));
  const last = input.messages.at(-1), text = Array.isArray(last?.content) ? last.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : String(last?.content ?? '');
  if (last?.role === 'user' && text.includes('网络等待')) return;
  let name, args;
  if (last?.role === 'user' && /写入|拒绝/.test(text)) {
    name = 'write_file'; args = { kind: 'create', path: text.includes('拒绝') ? 'browser-rejected.txt' : 'browser-proof.txt', content: '浏览器本机夹具已写入\n', createParents: false };
  } else if (last?.role === 'user' && text.includes('命令')) {
    name = 'command'; args = { program: process.execPath, args: ['-e', text.includes('停止') ? 'process.stdout.write("本机夹具开始等待");setInterval(()=>{},1000)' : 'process.stdout.write("本机命令夹具已完成")'], timeoutMs: 60_000, maxOutputBytes: 4096 };
  } else if (last?.role === 'user' && text.includes('读取')) {
    name = 'read_file'; args = { path: 'AGENTS.md', startLine: 1, maxLines: 100 };
  }
  const message = name ? { role: 'assistant', content: '', tool_calls: [{ id: `fixture-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    : { role: 'assistant', content: `本机模拟接口已回复（${input.model}）。${last?.role === 'tool' ? '已收到工具结果，请在原始记录中核对实际状态。' : '本次没有连接真实模型。'}` };
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: name ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: name ? 40 : 20 } }));
})().catch(() => res.destroy()); });
server.listen(Number(process.env.AIC_FIXTURE_PORT ?? 0), '127.0.0.1', () => {
  writeFileSync(path.join(data, 'runtime-fixture-port.txt'), String(server.address().port));
  console.log('独立 Agent 本机浏览器夹具已启动；端口与临时项目位置记录在忽略目录。');
});
