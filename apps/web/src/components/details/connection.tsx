import type { AgentInfo } from '@aic/protocol';
export function ConnectionDetails({ agent, historyAvailable }: { agent?: AgentInfo; historyAvailable?:boolean }) {
  const mcp = agent?.caps?.mcp;
  const transports = [mcp?.http ? 'HTTP' : null, mcp?.sse ? 'SSE' : null].filter(Boolean);
  return <><p className="d-note">{historyAvailable?'本次交接会话已注入 aic-history，可只读查询本任务的记录。':'当前会话没有工作台注入的历史查询服务。'}</p><p className="d-note">Agent 未报告 MCP 服务列表。</p><p className="d-note">MCP 传输支持：{transports.length ? transports.join('、') : mcp ? '不支持 HTTP 或 SSE' : '未报告'}。</p></>;
}
