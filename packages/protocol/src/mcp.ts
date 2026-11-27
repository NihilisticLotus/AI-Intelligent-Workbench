// 能力中心（上）：MCP 工具管家、智能粘贴解析、连接测试与任务级连接覆盖共享协议（第 2.3 步）。
// 所有密钥字段只写不读，响应仅暴露变量名与脱敏尾号 hint，绝不回传明文密钥。
import { z } from 'zod';

const McpId = z.string().min(1).max(64);
const McpTs = z.number().int().nonnegative();
const McpAgentKind = z.enum(['fake', 'claude', 'codex', 'codebuddy', 'zcode', 'workbuddy', 'antigravity', 'independent']);

export const McpTransport = z.enum(['stdio', 'http']);
export type McpTransport = z.infer<typeof McpTransport>;

export const McpConcurrency = z.enum(['shared', 'exclusive']);
export type McpConcurrency = z.infer<typeof McpConcurrency>;

export const McpStatus = z.enum(['idle', 'starting', 'ready', 'error', 'disabled']);
export type McpStatus = z.infer<typeof McpStatus>;

export const McpSecretEntry = z.object({
  key: z.string().min(1).max(128),
  hint: z.string().max(16),
  hasValue: z.boolean(),
}).strict();
export type McpSecretEntry = z.infer<typeof McpSecretEntry>;

export const McpToolInfo = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1000).default(''),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: 'object', properties: {} }),
}).strict();
export type McpToolInfo = z.infer<typeof McpToolInfo>;

export const McpServerSummary = z.object({
  id: McpId,
  name: z.string().min(1).max(64),
  description: z.string().max(300),
  transport: McpTransport,
  command: z.string().max(500).nullable(),
  args: z.array(z.string().max(500)).max(64),
  url: z.string().max(1000).nullable(),
  envSecrets: z.array(McpSecretEntry),
  headerSecrets: z.array(McpSecretEntry),
  concurrency: McpConcurrency,
  /** 空数组表示分配给全部 Agent；非空则仅对所选 Agent 生效 */
  agents: z.array(McpAgentKind).max(16),
  enabled: z.boolean(),
  status: McpStatus,
  lastError: z.string().max(500).nullable(),
  lastCheckedAt: McpTs.nullable(),
  lastCalledAt: McpTs.nullable(),
  lastCalledTool: z.string().max(128).nullable(),
  toolCount: z.number().int().nonnegative(),
  toolsFolded: z.boolean(),
  tools: z.array(McpToolInfo).max(500),
  createdAt: McpTs,
  updatedAt: McpTs,
}).strict();
export type McpServerSummary = z.infer<typeof McpServerSummary>;

const SecretMap = z.record(z.string().min(1).max(128), z.string().min(1).max(4096));

function validateTransportFields(
  val: { transport?: McpTransport; command?: string | null; url?: string | null },
  ctx: z.RefinementCtx,
) {
  if (val.transport === 'stdio') {
    if (!val.command || !val.command.trim()) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: '本机命令（stdio）模式必须填写启动命令' });
    }
    if (val.url) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: '本机命令（stdio）模式不需要服务地址' });
    }
  } else if (val.transport === 'http') {
    if (!val.url || !val.url.trim()) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: '远程接口（HTTP）模式必须填写服务地址' });
    }
    if (val.command) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: '远程接口（HTTP）模式不需要启动命令' });
    }
  }
}

export const CreateMcpServerBody = z.object({
  name: z.string().trim().min(1, '请填写 MCP 名称').max(64),
  description: z.string().trim().max(300).default(''),
  transport: McpTransport,
  command: z.string().trim().max(500).nullable().default(null),
  args: z.array(z.string().max(500)).max(64).default([]),
  url: z.string().trim().max(1000).nullable().default(null),
  envValues: SecretMap.optional(),
  headerValues: SecretMap.optional(),
  concurrency: McpConcurrency.default('shared'),
  agents: z.array(McpAgentKind).max(16).default([]),
  enabled: z.boolean().default(true),
}).strict().superRefine(validateTransportFields);
export type CreateMcpServerBody = z.infer<typeof CreateMcpServerBody>;

export const PatchMcpServerBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().trim().max(300).optional(),
  transport: McpTransport.optional(),
  command: z.string().trim().max(500).nullable().optional(),
  args: z.array(z.string().max(500)).max(64).optional(),
  url: z.string().trim().max(1000).nullable().optional(),
  envValues: SecretMap.optional(),
  removeEnvKeys: z.array(z.string().min(1).max(128)).max(64).optional(),
  headerValues: SecretMap.optional(),
  removeHeaderKeys: z.array(z.string().min(1).max(128)).max(64).optional(),
  concurrency: McpConcurrency.optional(),
  agents: z.array(McpAgentKind).max(16).optional(),
  enabled: z.boolean().optional(),
}).strict();
export type PatchMcpServerBody = z.infer<typeof PatchMcpServerBody>;

export const McpParseRequestBody = z.object({
  input: z.string().min(1, '请粘贴配置文本、命令或地址').max(32_768),
}).strict();
export type McpParseRequestBody = z.infer<typeof McpParseRequestBody>;

export const McpParsedCandidate = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(300),
  transport: McpTransport,
  command: z.string().max(500).nullable(),
  args: z.array(z.string().max(500)).max(64),
  url: z.string().max(1000).nullable(),
  envValues: z.record(z.string().min(1).max(128), z.string().max(4096)),
  headerValues: z.record(z.string().min(1).max(128), z.string().max(4096)),
  concurrency: McpConcurrency,
}).strict();
export type McpParsedCandidate = z.infer<typeof McpParsedCandidate>;

export const McpParseResult = z.object({
  format: z.enum(['json', 'claude_cli', 'command', 'url']),
  warnings: z.array(z.string().max(300)),
  candidates: z.array(McpParsedCandidate).min(1).max(20),
}).strict();
export type McpParseResult = z.infer<typeof McpParseResult>;

export const McpTestStep = z.object({
  step: z.string().min(1).max(80),
  ok: z.boolean(),
  detail: z.string().max(500),
}).strict();
export type McpTestStep = z.infer<typeof McpTestStep>;

export const McpTestResult = z.object({
  server: McpServerSummary,
  ok: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  steps: z.array(McpTestStep),
  tools: z.array(McpToolInfo).max(500),
  folded: z.boolean(),
  error: z.string().max(500).nullable(),
}).strict();
export type McpTestResult = z.infer<typeof McpTestResult>;

export const TaskMcpServerEntry = z.object({
  id: McpId,
  name: z.string().min(1).max(64),
  transport: McpTransport,
  enabled: z.boolean(),
  /** 是否适用于该任务的 Agent（未限制或包含该 Agent） */
  assigned: z.boolean(),
  /** 是否在当前任务里临时停用 */
  disabledForTask: z.boolean(),
  /** 当前任务实际生效状态（enabled && assigned && !disabledForTask） */
  activeForTask: z.boolean(),
  status: McpStatus,
  concurrency: McpConcurrency,
  toolCount: z.number().int().nonnegative(),
  toolsFolded: z.boolean(),
  lastCalledAt: McpTs.nullable(),
  lastCalledTool: z.string().max(128).nullable(),
}).strict();
export type TaskMcpServerEntry = z.infer<typeof TaskMcpServerEntry>;

export const TaskMcpConnections = z.object({
  taskId: McpId,
  agent: McpAgentKind,
  servers: z.array(TaskMcpServerEntry),
}).strict();
export type TaskMcpConnections = z.infer<typeof TaskMcpConnections>;

export const PutTaskMcpOverridesBody = z.object({
  disabledServerIds: z.array(McpId).max(100),
}).strict();
export type PutTaskMcpOverridesBody = z.infer<typeof PutTaskMcpOverridesBody>;
