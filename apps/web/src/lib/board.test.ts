import { describe, expect, it } from 'vitest';
import type { Task } from '@aic/protocol';
import { boardColumn, boardIndependentError, queueKeyPosition, sameQueue, sortBoardTasks } from './board';
const task = (over: Partial<Task> = {}): Task => ({ id: 't', projectId: 'p', groupId: null, title: '任务', prompt: '', status: 'queued', permission: 'ask', agent: 'fake', model: null, effort: null,
  autoAllowLowRisk: false, autoMergeOnPass: false, lastActivityAt: 10, createdAt: 1, updatedAt: 10, ...over });
describe('独立失败卡片', () => {
  const state: Parameters<typeof boardIndependentError>[0] = { recoveryRequired: false, lastTurn: { status: 'failed', stop: 'model_error', createdAt: 10 }, requests: [{ createdAt: 11, settlement: { outcome: 'failed', failure: 'upstream', usage: null, countedInputTokens: null } }] };
  it('没有通用错误事件也从本轮请求显示固定失败原因，提供配置入口而不重发', () => {
    expect(boardIndependentError(state)).toMatchObject({ message: '服务暂时不可用', actions: [{ label: '查看配置', action: 'task.switch_model' }] });
  });
  it('旧轮请求和其他停止原因不能误显示成当前服务错误', () => {
    expect(boardIndependentError({ ...state, requests: [{ ...state.requests[0]!, createdAt: 9 }] })?.message).toBe('模型请求失败');
    expect(boardIndependentError({ ...state, lastTurn: { ...state.lastTurn!, stop: 'request_budget' } })?.message).toBe('请求预算不足');
    expect(boardIndependentError({ ...state, lastTurn: { ...state.lastTurn!, status: 'completed', stop: 'completed' } })).toBeNull();
  });
  it('未定副作用只引导核对，不提供直接重发或配置修改入口', () => {
    expect(boardIndependentError({ ...state, recoveryRequired: true })).toMatchObject({ message: '有未定的请求或工具结果，需要先核对', actions: [] });
  });
});
describe('六列任务归类', () => {
  it.each(['queued', 'running', 'waiting', 'review'] as const)('%s 保留对应列', status => { expect(boardColumn(task({ status }), 10)).toBe(status); });
  it.each(['failed', 'interrupted', 'paused'] as const)('%s 进入可恢复列', status => { expect(boardColumn(task({ status }), 10)).toBe('failed'); });
  it('草稿不冒充排队，完成任务在七天边界后隐藏', () => {
    expect(boardColumn(task({ status: 'draft' }), 10)).toBeNull();
    for (const status of ['merged', 'discarded'] as const) {
      expect(boardColumn(task({ status }), 10 + 7 * 86400000)).toBe('done');
      expect(boardColumn(task({ status }), 11 + 7 * 86400000)).toBeNull();
    }
  });
  it('回滚后的完成时间优先于旧任务更新时间', () => {
    const rolled = task({ status: 'merged', workspace: { kind: 'copy', path: null, branch: null, baseBranch: null, baseRef: null, operation: { taskId: 't', state: 'rolled_back', beforeCommit: null, mergeCommit: null, rollbackCommit: null, strategy: null, conflictFiles: [], changedFiles: [], skippedLargeFiles: [], finishedAt: 8 * 86400000, removedAt: null } } });
    expect(boardColumn(rolled, 9 * 86400000)).toBe('done'); expect(boardColumn(rolled, 16 * 86400000)).toBeNull();
  });
});
describe('键盘与拖动调序边界', () => {
  const middle = task({ queue: { scope: 'agent', key: 'fake', position: 2, total: 3 } });
  it('Alt 方向键生成正确目标位置，其余按键不发送请求', () => {
    expect(queueKeyPosition(middle, 'ArrowUp', true)).toBe(1); expect(queueKeyPosition(middle, 'ArrowDown', true)).toBe(3);
    expect(queueKeyPosition(middle, 'ArrowUp', false)).toBeNull(); expect(queueKeyPosition(middle, 'Enter', true)).toBeNull();
    expect(queueKeyPosition({ ...middle, status: 'running' }, 'ArrowUp', true)).toBeNull();
    expect(queueKeyPosition(task(), 'ArrowUp', true)).toBeNull();
  });
  it('首尾不能越界，不同 Agent 或项目不能互相拖入', () => {
    expect(queueKeyPosition({ ...middle, queue: { ...middle.queue!, position: 1 } }, 'ArrowUp', true)).toBeNull();
    expect(queueKeyPosition({ ...middle, queue: { ...middle.queue!, position: 3 } }, 'ArrowDown', true)).toBeNull();
    expect(sameQueue(middle, { ...middle, id: 'other' })).toBe(true);
    expect(sameQueue(middle, { ...middle, queue: { ...middle.queue!, key: 'claude' } })).toBe(false);
    expect(sameQueue(middle, { ...middle, queue: { ...middle.queue!, scope: 'project' } })).toBe(false);
    expect(sameQueue(middle, { ...middle, status: 'running' })).toBe(false);
  });
  it('卡片展示遵循服务端排队位置，不按创建时间重排', () => {
    const next = { ...middle, id: 'next', lastActivityAt: 0, queue: { ...middle.queue!, position: 1 } };
    expect([middle, next].sort(sortBoardTasks).map(t => t.id)).toEqual(['next', 't']);
  });
});
