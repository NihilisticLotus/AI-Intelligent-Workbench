// MCP 智能粘贴解析器与安全校验（第 2.3 步）。
// 支持 JSON 片段、claude mcp add 命令、单行启动命令（npx/uvx/node/python 等）与 HTTP/HTTPS URL；
// 严格拒绝命令注入元字符、危险环境变量键及非 http(s) / 含凭据 URL。
import { McpParseResult, type McpConcurrency, type McpParsedCandidate } from '@aic/protocol';
import { isForbiddenSubprocessEnvKey } from '../security/env-policy';
import { Errors } from '../util';

const DESKTOP_EXCLUSIVE_RE = /(?:^|[-_.\s])(blender|houdini|fxhoudini|renderdoc|unity|unreal)(?:$|[-_.\s])/i;
/** 禁止出现在命令字符串里的 shell 拼接或重定向元字符 */
const SHELL_META_RE = /[;&|`<>]|\$\(|\r|\n|\0/;
/** 禁止直接作为启动命令的通用 shell 或脚本宿主解释器（避免通过 sh -c / cmd /c / wsl 绕过参数审计） */
const SHELL_EXEC_RE = /^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|wsl(?:\.exe)?|mshta(?:\.exe)?|wscript(?:\.exe)?|cscript(?:\.exe)?|sh|bash|zsh|fish|csh|ksh)$/i;
const SAFE_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SAFE_HEADER_KEY_RE = /^[A-Za-z0-9-]{1,128}$/;

export function defaultConcurrencyForName(name: string): McpConcurrency {
  return DESKTOP_EXCLUSIVE_RE.test(name) ? 'exclusive' : 'shared';
}

export function normalizeMcpName(raw: string, fallback = 'mcp-server'): string {
  const cleaned = raw
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
}

export function validateMcpCommandAndArgs(command: string, args: readonly string[]): void {
  const cmd = command.trim();
  if (!cmd) throw Errors.badRequest('启动命令不能为空');
  if (SHELL_META_RE.test(cmd)) {
    throw Errors.badRequest('启动命令包含不安全的管道、分号或命令替换字符，已拒绝');
  }
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  if (SHELL_EXEC_RE.test(base)) {
    throw Errors.badRequest(`不允许直接把系统 Shell（${base}）登记为 MCP 命令，请填写实际可执行程序（如 node、npx、uvx、python）`);
  }
  for (const arg of args) {
    if (arg.includes('\0') || arg.includes('\r') || arg.includes('\n')) {
      throw Errors.badRequest('命令参数包含非法控制字符，已拒绝');
    }
  }
}

export function validateMcpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw Errors.badRequest('MCP 服务地址不是有效的网址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw Errors.badRequest('MCP 服务地址只支持 http:// 或 https://');
  }
  if (url.username || url.password) {
    throw Errors.badRequest('MCP 服务地址不能直接包含用户名或密码，请通过“密钥请求头”填写认证信息');
  }
  return url;
}

export function validateMcpEnvKey(key: string): void {
  if (!SAFE_ENV_KEY_RE.test(key)) {
    throw Errors.badRequest(`环境变量名无效：${key}（仅允许字母、数字与下划线）`);
  }
  if (isForbiddenSubprocessEnvKey(key)) {
    throw Errors.badRequest(`安全策略禁止为 MCP 覆盖系统或工作台受保护环境变量：${key}`);
  }
  const upper = key.toUpperCase();
  if (['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].includes(upper)) {
    throw Errors.badRequest(`安全策略禁止 MCP 覆盖系统路径环境变量：${key}`);
  }
}

export function validateMcpHeaderKey(key: string): void {
  if (!SAFE_HEADER_KEY_RE.test(key)) {
    throw Errors.badRequest(`请求头名称无效：${key}`);
  }
  const lower = key.toLowerCase();
  if (['host', 'content-length', 'transfer-encoding', 'connection'].includes(lower)) {
    throw Errors.badRequest(`不允许覆盖底层 HTTP 传输头：${key}`);
  }
}

/** 安全拆分命令行（支持单引号、双引号与反斜杠转义，拒绝未闭合引号与 shell 拼接元字符） */
export function tokenizeCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < line.length) {
        const next = line[i + 1]!;
        if (next === '"' || next === '\\') {
          cur += next;
          i++;
          continue;
        }
      }
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    // 非引号状态下出现 shell 连接符、管道、重定向、命令替换直接拒绝
    if (ch === ';' || ch === '|' || ch === '&' || ch === '`' || ch === '>' || ch === '<') {
      throw Errors.badRequest(`命令中包含不安全的 Shell 控制字符（${ch}），已拒绝解析`);
    }
    if (ch === '$' && line[i + 1] === '(') {
      throw Errors.badRequest('命令中包含不安全的命令替换（$(...)），已拒绝解析');
    }
    if (ch === '\r' || ch === '\n' || ch === '\0') {
      throw Errors.badRequest('单行命令不允许包含换行或空字符');
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(cur);
        cur = '';
        hasToken = false;
      }
      continue;
    }
    cur += ch;
    hasToken = true;
  }

  if (quote) throw Errors.badRequest('命令中存在未闭合的引号，请核对后重试');
  if (hasToken) tokens.push(cur);
  return tokens;
}

function inferNameFromUrl(url: URL): string {
  const segs = url.pathname.split('/').filter(Boolean);
  const tail = segs.at(-1);
  if (tail && tail.toLowerCase() !== 'mcp' && tail.toLowerCase() !== 'sse') {
    return normalizeMcpName(tail);
  }
  const hostPart = url.hostname.replace(/^www\./i, '').split('.')[0] ?? 'remote-mcp';
  return normalizeMcpName(hostPart, 'remote-mcp');
}

function inferNameFromCommand(command: string, args: readonly string[]): string {
  for (const arg of args) {
    if (arg.startsWith('-')) continue;
    const pkg = arg.replace(/^@[^/]+\//, '').replace(/@[\d.^~a-z-]+$/i, '');
    const cleaned = pkg.replace(/^mcp-server-|^server-|-mcp$/gi, '');
    if (cleaned && !/^[./\\]/.test(cleaned)) return normalizeMcpName(cleaned, 'mcp-tool');
    const file = arg.split(/[\\/]/).pop()?.replace(/\.[a-z0-9]+$/i, '');
    if (file) return normalizeMcpName(file, 'mcp-tool');
  }
  const base = command.split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|mjs|js|py)$/i, '') ?? 'mcp-tool';
  return normalizeMcpName(base, 'mcp-tool');
}

function parseJsonInput(trimmed: string): McpParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw Errors.badRequest('JSON 格式有误，请检查括号与引号是否完整');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw Errors.badRequest('JSON 顶层必须是一个对象（例如 { "mcpServers": { ... } }）');
  }
  const obj = raw as Record<string, unknown>;
  const warnings: string[] = [];
  const entries: Array<[string, Record<string, unknown>]> = [];

  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    for (const [k, v] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) entries.push([k, v as Record<string, unknown>]);
    }
  } else if (typeof obj.command === 'string' || typeof obj.url === 'string') {
    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : '';
    entries.push([name, obj]);
  } else {
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const rec = v as Record<string, unknown>;
        if (typeof rec.command === 'string' || typeof rec.url === 'string') {
          entries.push([k, rec]);
        }
      }
    }
  }

  if (!entries.length) {
    throw Errors.badRequest('JSON 中没有找到有效的 MCP 服务定义（需要包含 command 或 url）');
  }
  if (entries.length > 20) {
    throw Errors.badRequest('单次最多解析 20 个 MCP 服务配置');
  }

  const candidates: McpParsedCandidate[] = [];
  for (const [rawName, spec] of entries) {
    const hasUrl = typeof spec.url === 'string' && spec.url.trim().length > 0;
    const hasCmd = typeof spec.command === 'string' && spec.command.trim().length > 0;
    if (!hasUrl && !hasCmd) {
      throw Errors.badRequest(`配置项「${rawName || '未命名'}」缺少 command 或 url`);
    }
    const envValues: Record<string, string> = {};
    if (spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env)) {
      for (const [k, v] of Object.entries(spec.env as Record<string, unknown>)) {
        validateMcpEnvKey(k);
        if (typeof v === 'string' && v.length > 0) envValues[k] = v;
      }
    }
    const headerValues: Record<string, string> = {};
    if (spec.headers && typeof spec.headers === 'object' && !Array.isArray(spec.headers)) {
      for (const [k, v] of Object.entries(spec.headers as Record<string, unknown>)) {
        validateMcpHeaderKey(k);
        if (typeof v === 'string' && v.length > 0) headerValues[k] = v;
      }
    }
    const description = typeof spec.description === 'string' ? spec.description.trim().slice(0, 300) : '';

    if (hasUrl) {
      const parsedUrl = validateMcpUrl(String(spec.url));
      const name = normalizeMcpName(rawName || inferNameFromUrl(parsedUrl), 'remote-mcp');
      if (spec.type === 'sse' || spec.transport === 'sse') {
        warnings.push(`「${name}」声明为 sse 传输，已按标准 HTTP MCP 入口解析，建议保存后先点“测试连接”确认。`);
      }
      candidates.push({
        name,
        description,
        transport: 'http',
        command: null,
        args: [],
        url: parsedUrl.toString(),
        envValues,
        headerValues,
        concurrency: defaultConcurrencyForName(name),
      });
    } else {
      const command = String(spec.command).trim();
      const args = Array.isArray(spec.args) ? spec.args.map((x) => String(x)) : [];
      validateMcpCommandAndArgs(command, args);
      const name = normalizeMcpName(rawName || inferNameFromCommand(command, args), 'mcp-tool');
      candidates.push({
        name,
        description,
        transport: 'stdio',
        command,
        args,
        url: null,
        envValues,
        headerValues,
        concurrency: defaultConcurrencyForName(name),
      });
    }
  }

  return McpParseResult.parse({ format: 'json', warnings, candidates });
}

function parseClaudeCli(tokens: string[]): McpParseResult {
  // 形态：claude mcp add [--transport http|stdio|sse] [-s|--scope ...] [-e KEY=VAL] [-H|--header "K: V"] <name> [--] <command|url> [args...]
  const warnings: string[] = [];
  let transport: 'stdio' | 'http' | null = null;
  const envValues: Record<string, string> = {};
  const headerValues: Record<string, string> = {};
  const positional: string[] = [];
  let afterDoubleDash = false;

  for (let i = 3; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (afterDoubleDash) {
      positional.push(tok);
      continue;
    }
    if (tok === '--') {
      afterDoubleDash = true;
      continue;
    }
    if ((tok === '--transport' || tok === '-t') && i + 1 < tokens.length) {
      const tVal = tokens[++i]!.toLowerCase();
      if (tVal === 'http' || tVal === 'sse') {
        transport = 'http';
        if (tVal === 'sse') warnings.push('检测到 --transport sse，已按 HTTP MCP 模式解析，建议保存后先测试连接。');
      } else if (tVal === 'stdio') {
        transport = 'stdio';
      } else {
        throw Errors.badRequest(`不支持的传输类型：${tVal}`);
      }
      continue;
    }
    if ((tok === '--scope' || tok === '-s') && i + 1 < tokens.length) {
      i++; // 忽略 Claude 自身 scope 参数
      continue;
    }
    if ((tok === '--env' || tok === '-e') && i + 1 < tokens.length) {
      const pair = tokens[++i]!;
      const eq = pair.indexOf('=');
      if (eq <= 0) throw Errors.badRequest(`环境变量参数格式无效：${pair}（应为 KEY=VALUE）`);
      const k = pair.slice(0, eq).trim();
      const v = pair.slice(eq + 1);
      validateMcpEnvKey(k);
      if (v) envValues[k] = v;
      continue;
    }
    if ((tok === '--header' || tok === '-H') && i + 1 < tokens.length) {
      const rawH = tokens[++i]!;
      const colon = rawH.indexOf(':');
      if (colon <= 0) throw Errors.badRequest(`请求头参数格式无效：${rawH}（应为 Header-Name: Value）`);
      const k = rawH.slice(0, colon).trim();
      const v = rawH.slice(colon + 1).trim();
      validateMcpHeaderKey(k);
      if (v) headerValues[k] = v;
      continue;
    }
    if (tok.startsWith('-') && positional.length === 0) {
      throw Errors.badRequest(`无法识别的选项参数：${tok}`);
    }
    positional.push(tok);
  }

  if (positional.length < 2) {
    throw Errors.badRequest('claude mcp add 命令缺少名称或目标命令/地址');
  }
  const name = normalizeMcpName(positional[0]!, 'mcp-tool');
  const target = positional[1]!;
  const restArgs = positional.slice(2);

  if (transport === 'http' || /^https?:\/\//i.test(target)) {
    const parsedUrl = validateMcpUrl(target);
    return McpParseResult.parse({
      format: 'claude_cli',
      warnings,
      candidates: [{
        name,
        description: '',
        transport: 'http',
        command: null,
        args: [],
        url: parsedUrl.toString(),
        envValues,
        headerValues,
        concurrency: defaultConcurrencyForName(name),
      }],
    });
  }

  validateMcpCommandAndArgs(target, restArgs);
  return McpParseResult.parse({
    format: 'claude_cli',
    warnings,
    candidates: [{
      name,
      description: '',
      transport: 'stdio',
      command: target,
      args: restArgs,
      url: null,
      envValues,
      headerValues,
      concurrency: defaultConcurrencyForName(name),
    }],
  });
}

/** 智能解析用户粘贴的任意 MCP 配置（JSON / claude mcp add / 单行命令 / URL）。 */
export function parseMcpInput(input: string): McpParseResult {
  const trimmed = input.trim();
  if (!trimmed) throw Errors.badRequest('请先粘贴 MCP 配置文本、启动命令或服务地址');

  // 1. JSON（含 Markdown ```json 代码块包裹）
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (unfenced.startsWith('{')) {
    return parseJsonInput(unfenced);
  }

  // 2. 纯 URL
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) && !/\s/.test(trimmed)) {
    const url = validateMcpUrl(trimmed);
    const name = inferNameFromUrl(url);
    return McpParseResult.parse({
      format: 'url',
      warnings: [],
      candidates: [{
        name,
        description: '',
        transport: 'http',
        command: null,
        args: [],
        url: url.toString(),
        envValues: {},
        headerValues: {},
        concurrency: defaultConcurrencyForName(name),
      }],
    });
  }

  // 3. 命令行（claude mcp add 或普通单行命令）
  const tokens = tokenizeCommandLine(trimmed);
  if (!tokens.length) throw Errors.badRequest('没有识别到有效命令');

  if (tokens.length >= 3 && tokens[0]!.toLowerCase() === 'claude' && tokens[1]!.toLowerCase() === 'mcp' && tokens[2]!.toLowerCase() === 'add') {
    return parseClaudeCli(tokens);
  }

  // 提取前置 KEY=VAL 环境变量
  const envValues: Record<string, string> = {};
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) {
    const pair = tokens[idx]!;
    const eq = pair.indexOf('=');
    const k = pair.slice(0, eq);
    const v = pair.slice(eq + 1);
    validateMcpEnvKey(k);
    if (v) envValues[k] = v;
    idx++;
  }

  if (idx >= tokens.length) throw Errors.badRequest('命令行缺少可执行程序名');
  const command = tokens[idx]!;
  const args = tokens.slice(idx + 1);
  validateMcpCommandAndArgs(command, args);
  const name = inferNameFromCommand(command, args);

  return McpParseResult.parse({
    format: 'command',
    warnings: [],
    candidates: [{
      name,
      description: '',
      transport: 'stdio',
      command,
      args,
      url: null,
      envValues,
      headerValues: {},
      concurrency: defaultConcurrencyForName(name),
    }],
  });
}
