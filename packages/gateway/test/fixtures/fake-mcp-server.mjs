// 离线测试用假 MCP Stdio 服务器（第 2.3-R 步扩展）：
// 支持常规回显、有状态计数器（验证进程池复用）、故意崩溃（验证崩溃自愈）、分页工具列表、超长单行（验证 OOM 防护）、>40 工具折叠与超时挂起测试。
import { createInterface } from 'node:readline';

const manyArg = process.argv.find((a) => a.startsWith('--many='));
const manyCount = manyArg ? Number(manyArg.slice('--many='.length)) : 0;
const delayListArg = process.argv.find((a) => a.startsWith('--delay-list='));
const delayListMs = delayListArg ? Number(delayListArg.slice('--delay-list='.length)) : 0;
const paged = process.argv.includes('--paged');

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
          hugeLineBytes: { type: 'integer' },
          crash: { type: 'boolean' },
        },
      },
    },
    {
      name: 'counter',
      description: '有状态自增计数器（用于验证常驻进程复用与进程号不变）',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'hang',
      description: '故意不响应以测试看门狗超时与进程回收',
      inputSchema: { type: 'object', properties: {} },
    },
  ];
}

const tools = buildTools();
let count = 0;

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
        serverInfo: { name: 'fake-mcp', version: '1.1.0' },
      },
    });
  } else if (method === 'tools/list') {
    if (delayListMs > 0) await new Promise((r) => setTimeout(r, delayListMs));
    if (paged) {
      const cursor = params?.cursor;
      const mid = Math.ceil(tools.length / 2);
      if (!cursor) {
        send(id, { result: { tools: tools.slice(0, mid), nextCursor: 'p2' } });
      } else {
        send(id, { result: { tools: tools.slice(mid) } });
      }
    } else {
      send(id, { result: { tools } });
    }
  } else if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'hang') {
      continue;
    }
    if (args.delayMs && Number(args.delayMs) > 0) {
      await new Promise((r) => setTimeout(r, Number(args.delayMs)));
    }
    if (name === 'counter') {
      count += 1;
      send(id, { result: { content: [{ type: 'text', text: JSON.stringify({ count, pid: process.pid }) }] } });
    } else if (name === 'echo') {
      if (args.crash) {
        process.exit(2);
      }
      if (args.hugeLineBytes && Number(args.hugeLineBytes) > 0) {
        process.stdout.write('X'.repeat(Number(args.hugeLineBytes)) + '\n');
        continue;
      }
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
