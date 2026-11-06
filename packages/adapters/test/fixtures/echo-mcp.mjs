// 只回显的 stdio MCP 服务（冒烟测试注入为 aic-echo，验证 ISSUE-0001“模型能否调用注入的工具”）。
// 不依赖 MCP SDK：按行读 JSON-RPC，只实现 initialize、tools/list、tools/call。
// 收到的方法名逐行记进 ECHO_LOG（只记方法名和工具参数，不记其他内容）。
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logFile = process.env.ECHO_LOG;
const log = (o) => { if (logFile) appendFileSync(logFile, `${JSON.stringify({ ts: Date.now(), ...o })}\n`); };
const send = (o) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);

log({ event: 'started', pid: process.pid, ppid: process.ppid });

createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  log({ method, ...(method === 'tools/call' ? { args: params?.arguments ?? null } : {}) });
  if (id === undefined || id === null) return; // 通知
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'aic-echo', version: '0.0.1' } } });
  } else if (method === 'tools/list') {
    send({ id, result: { tools: [{ name: 'echo', description: 'Echo back the given text. 原样返回 text 参数。', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } });
  } else if (method === 'tools/call') {
    const text = String(params?.arguments?.text ?? '');
    send({ id, result: { content: [{ type: 'text', text: `echo:${text}` }] } });
  } else if (method === 'ping') {
    send({ id, result: {} });
  } else {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
});
