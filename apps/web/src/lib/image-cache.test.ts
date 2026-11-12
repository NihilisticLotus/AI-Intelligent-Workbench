import { describe, expect, it, vi } from 'vitest';
import { createImageCache } from './image-cache';

describe('任务图片 Blob 缓存', () => {
  it('相同任务和附件合并并发读取，跨任务不复用，也不混淆分隔符', async () => {
    const cache = createImageCache(), blob = new Blob(['图']), load = vi.fn(async () => blob);
    const first = cache.get('task', 'image', load), second = cache.get('task', 'image', load);
    expect(first).toBe(second); expect(await first).toBe(blob); expect(load).toHaveBeenCalledOnce();
    expect(await cache.get('task', 'image', load)).toBe(blob); expect(load).toHaveBeenCalledOnce();
    await cache.get('another', 'image', load); await cache.get('a:b', 'c', load); await cache.get('a', 'b:c', load);
    expect(load).toHaveBeenCalledTimes(4);
  });
  it('读取失败不缓存，重试仍走原有鉴权读取', async () => {
    const cache = createImageCache(), load = vi.fn<() => Promise<Blob>>().mockRejectedValueOnce(new Error('无权读取')).mockResolvedValue(new Blob(['图']));
    await expect(cache.get('task', 'image', load)).rejects.toThrow('无权读取');
    await expect(cache.get('task', 'image', load)).resolves.toBeInstanceOf(Blob); expect(load).toHaveBeenCalledTimes(2);
  });
  it('鉴权或实例状态清空后重新读取，旧的在途响应不能回填或返回', async () => {
    const cache = createImageCache(); let resolve!: (blob: Blob) => void;
    const pending = cache.get('task', 'image', () => new Promise<Blob>((done) => { resolve = done; }));
    await Promise.resolve(); cache.clear();
    const fresh = new Blob(['新图']), load = vi.fn(async () => fresh);
    expect(await cache.get('task', 'image', load)).toBe(fresh);
    const rejected = expect(pending).rejects.toThrow('访问状态已变化'); resolve(new Blob(['旧图'])); await rejected;
    expect(await cache.get('task', 'image', load)).toBe(fresh); expect(load).toHaveBeenCalledOnce();
    cache.clear(); await cache.get('task', 'image', load); expect(load).toHaveBeenCalledTimes(2);
  });
  it('按最近使用淘汰并限制总字节，超大单图可以显示但不会常驻', async () => {
    const cache = createImageCache(2, 5), load = vi.fn(async () => new Blob(['12']));
    await cache.get('task', 'a', load); await cache.get('task', 'b', load); await cache.get('task', 'a', load); await cache.get('task', 'c', load);
    expect(load).toHaveBeenCalledTimes(3); await cache.get('task', 'b', load); expect(load).toHaveBeenCalledTimes(4);
    const large = vi.fn(async () => new Blob(['123456']));
    expect((await cache.get('task', 'large', large)).size).toBe(6); await cache.get('task', 'large', large); expect(large).toHaveBeenCalledTimes(2);
    const bytes = createImageCache(10, 3), counted = vi.fn(async () => new Blob(['12']));
    await bytes.get('t', 'a', counted); await bytes.get('t', 'b', counted); await bytes.get('t', 'a', counted); expect(counted).toHaveBeenCalledTimes(3);
  });
});
