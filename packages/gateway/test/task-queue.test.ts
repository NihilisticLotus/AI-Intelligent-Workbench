import { describe, expect, it } from 'vitest';
import { TaskQueue } from '../src/task-queue';

describe('可调序的任务名额', () => {
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
