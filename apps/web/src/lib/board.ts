import type { ApiError, IndependentTaskState, IndependentTurnStop, IndependentTurnRecord, IndependentRequestRecord, Task } from '@aic/protocol';
import { requestFailureText } from './independent';

export const boardColumns = [
  ['queued', '排队中'], ['running', '运行中'], ['waiting', '等待审批'],
  ['review', '待验收'], ['failed', '失败或中断'], ['done', '已完成近 7 天'],
] as const;

export function boardColumn(task: Task, now: number): typeof boardColumns[number][0] | null {
  if (task.workspace?.operation?.state === 'rolled_back' || ['merged', 'discarded'].includes(task.status)) {
    return now - (task.workspace?.operation?.finishedAt ?? task.updatedAt) <= 7 * 86400000 ? 'done' : null;
  }
  if (['failed', 'interrupted', 'paused'].includes(task.status)) return 'failed';
  if (task.status === 'draft') return null;
  return task.status as 'queued' | 'running' | 'waiting' | 'review';
}
export function queueKey(task: Task) { return task.queue ? `${task.queue.scope}:${task.queue.key}` : ''; }
export function sameQueue(a: Task, b: Task) { return a.status === 'queued' && b.status === 'queued' && !!a.queue && !!b.queue && queueKey(a) === queueKey(b); }
export function queueKeyPosition(task: Task, key: string, alt: boolean) {
  if (!alt || task.status !== 'queued' || !task.queue || !['ArrowUp', 'ArrowDown'].includes(key)) return null;
  const position = task.queue.position + (key === 'ArrowUp' ? -1 : 1);
  return position >= 1 && position <= task.queue.total ? position : null;
}
export function sortBoardTasks(a: Task, b: Task) {
  if (a.queue && b.queue) return queueKey(a).localeCompare(queueKey(b)) || a.queue.position - b.queue.position;
  return b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id);
}

const turnStopText: Record<IndependentTurnStop, string> = {
  completed: '本轮已完成', model_error: '模型请求失败', tool_error: '工具执行失败', model_limit: '达到本轮模型调用上限',
  tool_limit: '达到本轮工具调用上限', output_limit: '达到输出上限', usage_unknown: '用量未知，已停止', context_limit: '上下文超出限制',
  configuration_changed: '配置已变化，需要核对', cancelled: '本轮已取消', timed_out: '本轮运行超时', interrupted: '本轮已中断', request_budget: '请求预算不足',
};
/** 独立循环的失败保存在请求与回合记录，不一定产生通用 error 事件；只解释当前回合。 */
export function boardIndependentError(state: Pick<IndependentTaskState, 'recoveryRequired'> & { lastTurn: Pick<IndependentTurnRecord, 'status' | 'stop' | 'createdAt'> | null; requests: Pick<IndependentRequestRecord, 'createdAt' | 'settlement'>[] }): ApiError | null {
  if (state.recoveryRequired) return { code: 'client.independent_recovery', message: '有未定的请求或工具结果，需要先核对', hint: '打开对话，在独立 Agent 面板核对后再继续。', actions: [] };
  const turn = state.lastTurn;
  if (!turn || ['completed', 'running'].includes(turn.status) || !turn.stop) return null;
  const request = [...state.requests].reverse().find(item => item.createdAt >= turn.createdAt && item.settlement?.failure);
  const reason = turn.stop === 'model_error' ? requestFailureText(request?.settlement) : null;
  return { code: 'client.independent_failed', message: reason ?? turnStopText[turn.stop], hint: '本轮已停止，没有自动重试。可核对配置后在对话中继续。', actions: [{ label: '查看配置', action: 'task.switch_model' }] };
}
