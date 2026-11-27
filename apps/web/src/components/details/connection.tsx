// 右侧“详细 → 连接”小节：展示历史查询注入状态、本任务已挂载的 MCP 服务与临时启停开关。
import { FeatureKey, type AgentInfo, type TaskMcpConnections } from '@aic/protocol';
import { navigate } from '../../state/ui';

export function ConnectionDetails({
  agent,
  historyAvailable,
  mcp,
  mcpError,
  onToggleServer,
  busy,
}: {
  agent?: AgentInfo;
  historyAvailable?: boolean;
  mcp?: TaskMcpConnections | null;
  mcpError?: string | null;
  onToggleServer?: (serverId: string, nextActive: boolean) => void;
  busy?: boolean;
}) {
  const mcpCaps = agent?.caps?.mcp;
  const transports = [mcpCaps?.http ? 'HTTP' : null, mcpCaps?.sse ? 'SSE' : null].filter(Boolean);
  const assignedServers = (mcp?.servers ?? []).filter((s) => s.assigned);

  return (
    <>
      <p className="d-note">
        {historyAvailable
          ? '本次交接会话已注入 aic-history，可只读查询本任务的记录。'
          : '当前会话没有工作台注入的历史查询服务。'}
      </p>

      {mcpError ? <p className="d-note" role="alert">读取 MCP 连接失败：{mcpError}</p> : null}

      {assignedServers.length > 0 ? (
        <ul className="d-mcp-list" aria-label="本任务 MCP 工具连接">
          {assignedServers.map((srv) => (
            <li key={srv.id} className={'d-mcp-item' + (!srv.activeForTask ? ' is-off' : '')}>
              <div className="d-mcp-info">
                <strong>{srv.name}</strong>
                <span className="d-mcp-meta">
                  {srv.transport.toUpperCase()} · {srv.toolCount} 个工具
                  {srv.toolsFolded ? '（已折叠）' : ''}
                  {!srv.enabled ? ' · 全局已停用' : srv.disabledForTask ? ' · 本任务已暂停' : ' · 已挂载'}
                </span>
              </div>
              {srv.enabled && onToggleServer ? (
                <button
                  type="button"
                  className="switch"
                  role="switch"
                  aria-checked={!srv.disabledForTask}
                  aria-label={srv.disabledForTask ? `在本任务中启用 ${srv.name}` : `在本任务中暂停 ${srv.name}`}
                  disabled={busy}
                  onClick={() => onToggleServer(srv.id, srv.disabledForTask)}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="d-note">当前还没有分配给该 Agent 的 MCP 工具连接。</p>
      )}

      <div className="d-mcp-foot">
        <button
          type="button"
          className="btn xs"
          onClick={() => navigate({ page: 'feature', key: FeatureKey.PageCapabilities })}
        >
          打开能力中心
        </button>
      </div>

      <p className="d-note">
        Agent MCP 传输能力：{transports.length ? transports.join('、') : mcpCaps ? '仅支持本地 stdio' : '未报告'}。
      </p>
    </>
  );
}
