import { describe, expect, it } from 'vitest';
import { TaskQueue } from '../src/task-queue';

describe('可调序的任务名额', () => {
  it('取消和释放时通知失败仍唤醒下一任务并报告各次失败', async () => {
    const errors: string[] = [];
    let failing = false;
    const queue = new TaskQueue(() => 1, () => { if (failing) throw new Error('保存失败'); }, message => errors.push(message));
    const first = await queue.acquire('agent', '甲'), abort = new AbortController();
    const cancelled = expect(queue.acquire('agent', '乙', undefined, abort.signal)).rejects.toThrow();
    const next = queue.acquire('agent', '丙');
    failing = true;
    abort.abort(); await cancelled; first!();
    expect(queue.position('乙')).toBeUndefined();
    expect(queue.running('agent')).toBe(1);
    expect(errors).toHaveLength(2);
    failing = false; (await next)!();
  });
  it('调序通知保存失败时保留原先的等待顺序', async () => {
    let failing = false;
    const queue = new TaskQueue(() => 1, () => { if (failing) throw new Error('保存失败'); });
    const first = await queue.acquire('agent', '甲');
    const second = queue.acquire('agent', '乙'), third = queue.acquire('agent', '丙');
    failing = true;
    expect(() => queue.move('丙', 1)).toThrow('保存失败');
    failing = false;
    expect(queue.position('乙')?.position).toBe(1);
    first!(); (await second)!(); (await third)!();
  });
  it('登记排队状态失败后移除等待者，后续任务可以获得名额', async () => {
    const queue = new TaskQueue(() => 1);
    const release = await queue.acquire('agent', '运行中');
    await expect(queue.acquire('agent', '失败', () => { throw new Error('无法保存状态'); })).rejects.toThrow('无法保存状态');
    expect(queue.position('失败')).toBeUndefined();
    release!();
    const next = await queue.acquire('agent', '下一个', undefined, undefined, false);
    expect(next).toBeTypeOf('function');
    next!();
  });
  it('立即分配时通知失败也归还名额', async () => {
    let fail = true;
    const queue = new TaskQueue(() => 1, () => { if (fail) throw new Error('无法通知'); });
    await expect(queue.acquire('agent', '失败')).rejects.toThrow('无法通知');
    fail = false;
    expect(queue.running('agent')).toBe(0);
    (await queue.acquire('agent', '下一个'))!();
  });
  it('调序改变实际唤醒顺序，重复释放不挤占新任务', async () => {
    const queue = new TaskQueue(() => 1), started: string[] = [];
    const first = await queue.acquire('fake', 'a');
    const b = queue.acquire('fake', 'b').then(release => { started.push('b'); return release; });
    const c = queue.acquire('fake', 'c').then(release => { started.push('c'); return release; });
    queue.move('c', 1); expect(queue.position('b')?.position).toBe(2);
    first!(); const endC = await c; first!();
    expect(started).toEqual(['c']); expect(queue.running('fake')).toBe(1);
    endC!(); (await b)!(); expect(started).toEqual(['c', 'b']); expect(queue.running('fake')).toBe(0);
  });
  it('取消等待者更新位置且不释放运行者', async () => {
    const updates: string[][] = [], queue = new TaskQueue(() => 1, (_key, ids) => updates.push(ids));
    const first = await queue.acquire('project', 'a'), abort = new AbortController();
    const b = queue.acquire('project', 'b', undefined, abort.signal); const rejected = expect(b).rejects.toThrow();
    const c = queue.acquire('project', 'c'); abort.abort(); await rejected;
    expect(queue.position('c')).toEqual({ key: 'project', position: 1, total: 1 });
    expect(queue.running('project')).toBe(1); expect(updates.some(ids => ids.includes('b') && ids.includes('c'))).toBe(true);
    first!(); (await c)!();
  });
  it('增大名额按调后顺序填满，降低上限不终止运行者', async () => {
    let limit = 1; const queue = new TaskQueue(() => limit);
    const a = await queue.acquire('agent', 'a'); const b = queue.acquire('agent', 'b'), c = queue.acquire('agent', 'c');
    queue.move('c', 1); limit = 2; queue.drain('agent'); const endC = await c;
    expect(queue.position('b')?.position).toBe(1); limit = 1; a!(); expect(queue.position('b')).toBeDefined();
    endC!(); (await b)!();
  });
  it('不同资源独立，运行任务、越界和重复申请均不能调序', async () => {
    const queue = new TaskQueue(() => 1); const a = await queue.acquire('one', 'a'), b = await queue.acquire('two', 'b');
    expect(() => queue.move('a', 1)).toThrow(); expect(await queue.acquire('one', 'skip', undefined, undefined, false)).toBeNull();
    await expect(queue.acquire('two', 'a')).rejects.toThrow();
    const c = queue.acquire('one', 'c'); expect(() => queue.move('c', 0)).toThrow(); expect(() => queue.move('c', 2)).toThrow();
    expect(() => queue.move('c', 1.5)).toThrow(); a!(); (await c)!(); b!();
  });
});
