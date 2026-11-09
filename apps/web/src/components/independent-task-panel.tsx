import { useEffect, useRef, useState } from 'react';
import type { Task, IndependentTaskOptions, IndependentTaskState, IndependentHistoryPage, IndependentApprovalDetail } from '@aic/protocol';
import { api, useApp } from '../state/app';
import { Dialog, ErrorNotice, asApiError, openDialog } from './ui';
import { toast } from '../state/ui';
import { requestFailureText } from '../lib/independent';
import { IndependentTaskConfig } from './independent-task-config';

const idle = (task: Task) => !['running','waiting','queued','merged','discarded'].includes(task.status);
const contextText = { ready: '输入预检通过', input_unknown: '输入量未知，已停止', limits_unknown: '模型规格与人工上限未知，已停止', input_exceeded: '超过输入上限，已停止', window_exceeded: '超过上下文总窗口，已停止' };
const requestText = { reserved: '结果待核对', succeeded: '已返回', failed: '失败', interrupted: '中断，账单未知' };
const toolText = { pending: '待审批', approved: '已批准', rejected: '已拒绝', running: '执行中', succeeded: '已完成', failed: '失败', cancelled: '已停止', interrupted: '副作用待核对' };

export function openIndependentConfig(taskId: string, initialModelId?: string) {
  openDialog((close) => <ConfigDialog taskId={taskId} initialModelId={initialModelId} close={close} />);
}
function ConfigDialog({ taskId, initialModelId, close }: { taskId: string; initialModelId?: string; close: () => void }) {
  const task = useApp((s) => s.tasks[taskId]);
  const [state, setState] = useState<IndependentTaskState | null>(null), [next, setNext] = useState<IndependentTaskOptions | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<ReturnType<typeof asApiError> | null>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { let live = true; void api.independentTask(taskId).then((s) => { if (live) setState(s); }).catch((e) => { if (live) setError(asApiError(e)); }); return () => { live = false; }; }, [taskId]);
  const save = async () => {
    if (!state || !next || busy) return; setBusy(true); setError(null);
    try { await api.configureIndependentTask(taskId, state.revision, next); toast('已应用配置，历史请求与已占额度继续保留'); close(); }
    catch (e) { setError(asApiError(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  return <Dialog title="独立任务配置" onClose={close} wide footer={<><button className="btn" onClick={close}>取消</button>
    <button className="btn primary" disabled={!task || !idle(task) || !next || !state || busy || state.recoveryRequired} aria-busy={busy} onClick={() => void save()}>应用配置</button></>}>
    <p>任务空闲时可以更换 API、模型、强度与预算。切换后保留完整原始记录，已发生的请求和金额预留不会清空；原模型专用续传资料不交给新模型。</p>
    {error ? <div ref={errorRef} tabIndex={-1}><ErrorNotice error={error} /><button className="btn" onClick={() => { setState(null); void api.independentTask(taskId).then(setState).catch((e) => setError(asApiError(e))); }}>重新载入并核对</button></div> : null}
    {state ? <IndependentTaskConfig key={state.revision} initialOptions={state.options} initialModelId={initialModelId} onChange={setNext} disabled={busy || !task || !idle(task)} /> : <p role="status">正在读取任务配置…</p>}
  </Dialog>;
}

export function IndependentTaskPanel({ task }: { task: Task }) {
  const log = useApp((s) => s.logs[task.id]), conn = useApp((s) => s.conn);
  const update = log?.filter((e) => e.type === 'independent.task_changed').at(-1)?.seq;
  const [state, setState] = useState<IndependentTaskState | null>(null), [error, setError] = useState<ReturnType<typeof asApiError> | null>(null), [busy, setBusy] = useState(false);
  const refresh = async () => { try { setState(await api.independentTask(task.id)); setError(null); } catch (e) { setError(asApiError(e)); } };
  useEffect(() => {
    let live = true;
    void api.independentTask(task.id).then((value) => { if (live) { setState(value); setError(null); } }).catch((e) => { if (live) setError(asApiError(e)); });
    return () => { live = false; };
  }, [task.id, task.status, task.independent?.revision, update, conn]);
  const recover = async () => {
    if (!state || busy) return; setBusy(true);
    try { setState(await api.recoverIndependentTask(task.id, state.revision)); setError(null); toast('已记为中断，未重发请求或工具；可以继续发消息'); }
    catch (e) { setError(asApiError(e)); } finally { setBusy(false); }
  };
  return <details className="independent-task-panel">
    <summary>独立 Agent · 上下文与请求预算{state ? ` · 已占 ${state.budget.attemptedRequests}/${state.budget.policy.maxRequests} 次` : ''}{state?.recoveryRequired ? ' · 需要核对中断' : ''}</summary>
    {error ? <ErrorNotice error={error} /> : null}
    <div className="independent-actions"><button className="btn sm" disabled={!idle(task)} onClick={() => openIndependentConfig(task.id)}>模型与运行配置</button>
      <button className="btn sm" onClick={() => void refresh()}>刷新状态</button><button className="btn sm" onClick={() => openDialog((close) => <HistoryDialog task={task} close={close} />)}>原始记录与人工总结</button></div>
    {state ? <>
      <p role="status">{state.context ? contextText[state.context.status] : '尚未进行输入预检'}。实际费用：未知。</p>
      {state.context ? <p className="hint">{state.context.method === 'local_bytes' ? '本地字节估算，非精确 tokenizer' : '同服务计数接口'}；输入 {state.context.estimatedInputTokens ?? '未知'}，输出预留 {state.context.outputTokens}，安全余量 {state.context.safetyTokens}，总窗口 {state.context.contextWindow ?? '未知'}。</p> : null}
      <p className="hint">任务累计请求 {state.budget.attemptedRequests} 次，剩余 {state.budget.remainingRequests} 次，待核对 {state.budget.pendingRequests} 次。计数和生成分别记账；失败和中断仍占次数。</p>
      {state.budget.policy.money ? <p className="hint">人工预留：{state.budget.reservedMicros} / {state.budget.policy.money.maxReservedMicros} 微单位 {state.budget.policy.money.currency}（1 单位 = 1,000,000 微单位）；不代表实际扣费。</p> : <p className="hint">未设置人工金额预留；本任务按请求次数限制，供应商实际扣费未知。</p>}
      {state.recoveryRequired ? <div className="alert attn"><div><strong>上次执行需要核对</strong><p>请查看下面的请求、工具和原始记录，核对实际文件、命令与供应商账单。确认后只把未定记录标为中断，不重发请求、不自动重做工具。</p>
        <button className="btn attn" disabled={!idle(task) || busy} aria-busy={busy} onClick={() => void recover()}>我已核对，允许后续继续</button></div></div> : null}
      {state.lastTurn ? <p className="hint">最近回合：模型 {state.lastTurn.modelCalls}/{state.lastTurn.limits.maxModelCalls} 次，工具 {state.lastTurn.toolCalls}/{state.lastTurn.limits.maxToolCalls} 次，输出 {state.lastTurn.outputTokens ?? '未知'}/{state.lastTurn.limits.maxOutputTokens}；状态 {state.lastTurn.status === 'running' ? '执行中' : state.lastTurn.status === 'completed' ? '已完成' : '已停止'}。</p> : null}
      {state.checkpoint ? <details><summary>当前人工总结（截至第 {state.checkpoint.throughSeq} 条）</summary><pre>{state.checkpoint.summary}</pre><p className="hint">来源摘要：{state.checkpoint.sourceHash}。完整原文可在“原始记录与人工总结”中回查。</p></details> : null}
      {state.requests.length ? <details><summary>请求记录（最近 20 条，共 {state.requests.length} 条）</summary><div className="independent-table-scroll"><table><thead><tr><th>序号</th><th>类型</th><th>状态</th><th>输入 / 输出</th><th>预留</th></tr></thead><tbody>
        {state.requests.slice(-20).reverse().map((r) => <tr key={r.id}><td>{r.ordinal}</td><td>{r.attempt.kind === 'counter' ? '计数' : '生成'}</td><td>{requestText[r.status]}{requestFailureText(r.settlement) ? `（${requestFailureText(r.settlement)}）` : ''}</td><td>{r.settlement?.usage?.inputTokens ?? r.settlement?.countedInputTokens ?? '未知'} / {r.settlement?.usage?.outputTokens ?? '未知'}</td><td>{r.reservedMicros ?? '未设'} {r.currency ?? ''}</td></tr>)}
      </tbody></table></div></details> : null}
      {state.tools.length ? <details><summary>工具记录（最近 {state.tools.length} 条）</summary><ul>{state.tools.map((t) => <li key={t.id}>{t.toolName === 'command' ? '命令' : '文件修改'}：{toolText[t.state]}{t.fileOutcome ? `；${t.fileOutcome.path}；${t.fileOutcome.message}` : ''}{t.outcome ? `；退出码 ${t.outcome.exitCode ?? '未知'}；输出 ${t.outcome.outputBytes} 字节${t.outcome.truncated ? '（已截断）' : ''}` : ''}</li>)}</ul></details> : null}
    </> : <p role="status">正在读取独立任务状态…</p>}
  </details>;
}

function HistoryDialog({ task, close }: { task: Task; close: () => void }) {
  const [page, setPage] = useState<IndependentHistoryPage>({ items: [], nextCursor: null }), [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<ReturnType<typeof asApiError> | null>(null), [busy, setBusy] = useState(false), [summary, setSummary] = useState(''), [through, setThrough] = useState('');
  const current = useApp((s) => s.tasks[task.id] ?? task);
  const load = async (after = 0) => {
    setBusy(true); try { const next = await api.independentHistory(task.id, after); setPage((old) => ({ ...next, items: after ? [...old.items, ...next.items] : next.items })); setLoaded(true); setError(null); }
    catch (e) { setError(asApiError(e)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [task.id]);
  const save = async () => {
    const tail = page.items.at(-1); if (!tail || !summary.trim() || page.nextCursor !== null) return; setBusy(true);
    try { await api.checkpointIndependentTask(task.id, { throughSeq: Number(through), summary, expectedTailHash: tail.hash }); toast('人工总结已保存，原始记录继续保留'); close(); }
    catch (e) { setError(asApiError(e)); } finally { setBusy(false); }
  };
  return <Dialog title="原始记录与人工总结" onClose={close} wide footer={<><button className="btn" onClick={close}>关闭</button><button className="btn primary" disabled={busy || !idle(current) || !summary.trim() || !through || page.nextCursor !== null} onClick={() => void save()}>保存人工总结</button></>}>
    <p>完整原始记录保存在本机。这里只显示可移植的文字、工具和附件身份；供应商私有续传资料不向网页公开。总结不会删除原记录，也不自动调用模型。</p>
    {error ? <ErrorNotice error={error} /> : null}{!loaded ? <p role="status">正在读取…</p> : null}
    <div className="independent-history">{page.items.map((entry) => <details key={entry.seq}><summary>第 {entry.seq} 条 · {entry.message.role === 'user' ? '用户' : entry.message.role === 'assistant' ? '助手' : '工具'} · 回合 {entry.turnId}</summary><pre>{JSON.stringify(entry.message, null, 2)}</pre></details>)}</div>
    {page.nextCursor !== null ? <button className="btn" disabled={busy} onClick={() => void load(page.nextCursor!)}>继续读取原始记录</button> : null}
    <div className="form-row"><label htmlFor="independent-through">总结到第几条</label><input id="independent-through" className="input" type="number" min={1} max={page.items.at(-1)?.seq} value={through} onChange={(e) => setThrough(e.target.value)} /></div>
    <p className="hint">必须位于完整结束回合的最后一条；读取到最新记录并核对后才能保存。记录变化时会拒绝旧总结。</p>
    <div className="form-row top"><label htmlFor="independent-summary">人工总结</label><textarea id="independent-summary" className="textarea" rows={5} maxLength={100_000} value={summary} onChange={(e) => setSummary(e.target.value)} /></div>
  </Dialog>;
}

export function IndependentApproval({ taskId, toolId, ready }: { taskId: string; toolId: string; ready: (value: boolean) => void }) {
  const [detail, setDetail] = useState<IndependentApprovalDetail | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<ReturnType<typeof asApiError> | null>(null);
  const load = async () => { setBusy(true); try { setDetail(await api.independentApproval(taskId, toolId)); ready(true); setError(null); } catch (e) { setError(asApiError(e)); } finally { setBusy(false); } };
  return <div className="independent-approval-detail">{!detail ? <button className="btn" disabled={busy} onClick={() => void load()}>{busy ? '正在读取…' : '查看本次操作详情'}</button> : detail.kind === 'file' ? <>
    <p><strong>{detail.proposal.kind === 'create' ? '创建文件' : '替换文本'}：</strong>{detail.proposal.path}</p>
    <details open><summary>修改前</summary><pre>{detail.proposal.beforeText ?? '新文件，尚不存在'}</pre></details><details open><summary>修改后</summary><pre>{detail.proposal.afterText}</pre></details>
    <p className="hint">执行前会再次核对工作区、项目规则和原内容摘要；冲突时停止。</p>
  </> : <><p className="attn">{detail.warning}</p><strong>可执行文件</strong><pre>{detail.spec.program}</pre><strong>参数（按原始数组展示）</strong><pre>{JSON.stringify(detail.spec.args, null, 2)}</pre><p>时限 {detail.spec.timeoutMs} 毫秒；输出上限 {detail.spec.maxOutputBytes} 字节。</p></>}
    {error ? <ErrorNotice error={error} /> : null}
  </div>;
}
