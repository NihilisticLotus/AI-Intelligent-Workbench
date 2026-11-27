// 离线测试用假 MCP Stdio 服务器：支持常规回显、超长输出、防注入测试、>40 工具折叠与超时挂起测试。
import { createInterface } from 'node:readline';

const manyArg = process.argv.find((a) => a.startsWith('--many='));
const manyCount = manyArg ? Number(manyArg.slice('--many='.length)) : 0;

function buildTools() {
  if (manyCount > 0) {
    return Array.from({ length: manyCount }, (_, i) => ({
      name: `tool_${String(i + 1).padStart(2, '0')}`,
      description: i === 12 ? '查找场景里的灯光与摄像机节点' : `批量测试工具 #${i + 1}`,
      inputSchema: { type: 'object', properties: { note: { type: 'string' } } },
    }));
  }
  return [
    {
      name: 'echo',
      description: '回显文本或检查环境变量隔离情况',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          repeat: { type: 'integer' },
          checkEnv: { type: 'boolean' },
          delayMs: { type: 'integer' },
        },
      },
    },
    {
      name: 'hang',
      description: '故意不响应以测试看门狗超时与进程回收',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

const tools = buildTools();
function send(id, payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...payload }) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  const { id, method, params } = msg;
  if (id === undefined) continue;
  if (method === 'initialize') {
    send(id, {
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send(id, { result: { tools } });
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'hang') {
      // 故意不回复，等待看门狗强杀
      continue;
    }
    if (args.delayMs && Number(args.delayMs) > 0) {
      await new Promise((r) => setTimeout(r, Number(args.delayMs)));
    }
    if (name === 'echo') {
      if (args.checkEnv) {
        const info = {
          hasDemoSecret: process.env.DEMO_SECRET === 'fixture-mcp-secret-9x8y',
          rawDemoSecret: process.env.DEMO_SECRET ?? '',
          leakedAic: Object.keys(process.env).some((k) => k.startsWith('AIC_')),
          leakedOpenAi: Boolean(process.env.OPENAI_API_KEY),
          pid: process.pid,
        };
        send(id, { result: { content: [{ type: 'text', text: JSON.stringify(info) }] } });
      } else {
        const base = String(args.text ?? 'ok');
        const rep = Math.max(1, Math.min(2000, Number(args.repeat ?? 1)));
        send(id, { result: { content: [{ type: 'text', text: base.repeat(rep) }] } });
      }
    } else if (tools.some((t) => t.name === name)) {
      send(id, { result: { content: [{ type: 'text', text: `called:${name}:${args.note ?? ''}` }] } });
    } else {
      send(id, { result: { isError: true, content: [{ type: 'text', text: `unknown tool: ${name}` }] } });
    }
  } else {
    send(id, { error: { code: -32601, message: 'method not found' } });
  }
}
