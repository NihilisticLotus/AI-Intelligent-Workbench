// stdio 进程只连接绑定的本机 Gateway，环境中的会话令牌不写入日志。
import { createInterface } from 'node:readline';
import { request } from 'node:http';

const port = Number(process.env.AIC_HISTORY_PORT);
const token = process.env.AIC_HISTORY_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(1);
delete process.env.AIC_HISTORY_TOKEN;

const string = { type: 'string' };
const integer = { type: 'integer' };
function tool(name, description, properties) {
  return { name, description, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, inputSchema: {
    type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
  } };
}
const tools = [
  tool('search', '在本任务已脱敏的历史里搜索原话、工具与结果。', { query: string }),
  tool('get_events', '按事件序号读取本任务的历史。', { fromSeq: integer, toSeq: integer }),
  tool('get_file_at', '读取本任务检查点内的项目相对路径。', { checkpoint: string, path: string }),
  tool('list_decisions', '列出本任务的约束、纠正和有来源的决策。', {}),
];

function readHistory(query) {
  const data = JSON.stringify(query);
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/api/v1/internal/history/read', method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    }, res => {
      let bytes = 0;
      const chunks = [];
      res.on('error', reject);
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 32768) res.destroy(new Error('历史响应超过大小上限'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(Buffer.concat(chunks).toString('utf8'));
        else reject(new Error('历史请求被拒绝'));
      });
    });
    req.setTimeout(10_000, () => req.destroy(new Error('查询超时')));
    req.on('error', reject);
    req.end(data);
  });
}

function send(id, value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...value }) + '\n');
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try {
    if (Buffer.byteLength(line) > 65536) throw new Error();
    message = JSON.parse(line);
  } catch {
    send(null, { error: { code: -32700, message: '无法解析请求' } });
    continue;
  }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    send(null, { error: { code: -32600, message: '请求无效' } });
    continue;
  }
  const { id, method, params } = message;
  if (id === undefined) continue;
  switch (method) {
    case 'initialize':
      send(id, { result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'aic-history', version: '1.0.0' } } });
      break;
    case 'ping':
      send(id, { result: {} });
      break;
    case 'tools/list':
      send(id, { result: { tools } });
      break;
    case 'tools/call':
      try {
        if (!tools.some(entry => entry.name === params?.name)) throw new Error();
        const text = await readHistory({ name: params.name, arguments: params.arguments ?? {} });
        send(id, { result: { content: [{ type: 'text', text }] } });
      } catch {
        send(id, { result: { isError: true, content: [{ type: 'text', text: '本次查询不可用，请核对范围或会话状态。' }] } });
      }
      break;
    default:
      send(id, { error: { code: -32601, message: '不支持的历史查询' } });
  }
}
