// 受控 ACP MCP Hub 桥接进程：只连接本机绑定的 Gateway，不写入任何明文密钥或磁盘配置。
import { createInterface } from 'node:readline';
import { request } from 'node:http';

const port = Number(process.env.AIC_MCP_PORT);
const token = process.env.AIC_MCP_TOKEN;
if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) process.exit(1);
delete process.env.AIC_MCP_TOKEN;

function callHub(payload) {
  const data = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/api/v1/internal/mcp/rpc',
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('error', reject);
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 512 * 1024) res.destroy(new Error('MCP Hub 响应超过大小上限'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch { reject(new Error('MCP Hub 返回格式无效')); }
        } else {
          reject(new Error('MCP Hub 请求被拒绝'));
        }
      });
    });
    req.setTimeout(50_000, () => req.destroy(new Error('MCP Hub 调用超时')));
    req.on('error', reject);
    req.end(data);
  });
}

function send(id, value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...value }) + '\n');
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let msg;
  try {
    if (Buffer.byteLength(line) > 256 * 1024) throw new Error();
    msg = JSON.parse(line);
  } catch {
    send(null, { error: { code: -32700, message: '无法解析请求' } });
    continue;
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    send(null, { error: { code: -32600, message: '请求无效' } });
    continue;
  }
  const { id, method, params } = msg;
  if (id === undefined) continue;
  switch (method) {
    case 'initialize':
      send(id, {
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'aic-mcp-hub', version: '1.0.0' },
        },
      });
      break;
    case 'ping':
      send(id, { result: {} });
      break;
    case 'tools/list':
      try {
        const result = await callHub({ method: 'tools/list' });
        send(id, { result });
      } catch (e) {
        send(id, { error: { code: -32000, message: e instanceof Error ? e.message : '读取 MCP 工具清单失败' } });
      }
      break;
    case 'tools/call':
      try {
        const result = await callHub({ method: 'tools/call', name: params?.name, arguments: params?.arguments ?? {} });
        send(id, { result });
      } catch (e) {
        send(id, { result: { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : 'MCP 工具调用失败' }] } });
      }
      break;
    default:
      send(id, { error: { code: -32601, message: '不支持的 MCP 请求' } });
  }
}
