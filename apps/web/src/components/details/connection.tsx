import type { AgentInfo } from '@aic/protocol';
export function ConnectionDetails({ agent }: { agent?: AgentInfo }) {
  const mcp = agent?.caps?.mcp;
  const transports = [mcp?.http ? 'HTTP' : null, mcp?.sse ? 'SSE' : null].filter(Boolean);
  return <><p className="d-note">工作台没有为本任务注入 MCP 服务。</p><p className="d-note">Agent 未报告 MCP 服务列表。</p><p className="d-note">MCP 传输支持：{transports.length ? transports.join('、') : mcp ? '不支持 HTTP 或 SSE' : '未报告'}。</p></>;
}
