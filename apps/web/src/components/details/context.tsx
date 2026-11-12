import { contextValue } from '../../lib/details';
import { formatTokens } from '../../lib/tokens';
import { effortLabel } from '../../lib/picker';
import type { SessionCfg } from '../../state/core';
export function ContextDetails({ value, agent, model, config }: { value: ReturnType<typeof contextValue>; agent: string; model: string | null; config: SessionCfg }) {
  const ratio = value.percent === null ? 0 : Math.min(100, Math.max(0, value.percent));
  return <><dl className="d-dl"><dt>Agent</dt><dd>{agent}</dd><dt>模型</dt><dd>{model ?? '默认'}</dd>
    {config.effort ? <><dt>思考强度</dt><dd>{effortLabel(config.effort)}</dd></> : null}</dl>
    <div className="d-total"><b>{value.percent === null ? '上下文' : `已用 ${value.percent}%`}{value.estimated ? '（估算）' : ''}</b><span>{formatTokens(value.used)}{value.size ? ` / ${formatTokens(value.size)}` : ''}</span></div>
    {value.percent !== null ? <><div className="context-bar" role="img" aria-label={`已用 ${value.percent}%，剩余 ${Math.max(0,100-value.percent)}%`}><span style={{ width: `${ratio}%` }} /></div><div className="d-legend"><span>已用 {formatTokens(value.used)}</span><span>剩余 {formatTokens(Math.max(0,value.size! - value.used!))}</span></div></> : <p className="d-note">{value.used === null ? '上下文用量未报告' : '窗口大小未报告'}</p>}
    <p className="d-note">分类明细 Agent 未报告{value.estimated ? '。当前值来自独立 Agent 最近一次上下文预检，属于估算。' : '。'}</p></>;
}
