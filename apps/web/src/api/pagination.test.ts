import { afterEach, expect, it, vi } from 'vitest';
import { api, appStore, loadHistory } from '../state/app';
import { parseHash } from '../state/ui';
import { HttpClient } from './http';

afterEach(() => vi.restoreAllMocks());

it('任务和账号目录读到末页，重复游标给出错误', async () => {
  const client = new HttpClient();
  const request = vi.spyOn(client, 'request').mockImplementation(async (_method, _path, opts) => {
    const page = Number(opts?.query?.cursor ?? 0);
    return { items: [{ id: String(page) }], nextCursor: page < 52 ? String(page + 1) : null };
  });
  expect(await client.tasks()).toHaveLength(53);
  expect(await client.profiles()).toHaveLength(53);
  request.mockResolvedValue({ items: [], nextCursor: '同一页' });
  await expect(client.tasks()).rejects.toMatchObject({ code: 'client.bad_response' });
});

it('长对话在第两百页之后继续读取，游标停滞时允许重试', async () => {
  const page = vi.spyOn(api, 'taskEvents').mockImplementation(async (_id, after) => ({
    items: [], rawCount: 500, skipped: 500, lastSeq: after + 500,
    nextCursor: after < 100000 ? String(after + 500) : null,
  }));
  await loadHistory('长对话');
  expect(page).toHaveBeenCalledTimes(201);
  page.mockResolvedValue({ items: [], rawCount: 500, skipped: 500, lastSeq: 0, nextCursor: '0' });
  await expect(loadHistory('停滞')).rejects.toThrow();
  expect(appStore.get().history['停滞']).toBe('error');
});

it('被截断的网址可返回首页，有效的中文和百分号标识仍能打开', () => {
  for (const hash of ['#/t/%E4','#/agents/a/%','#/projects/%/settings','#/p/%']) expect(parseHash(hash)).toEqual({page:'home'});
  expect(parseHash('#/t/%E4%BB%BB%E5%8A%A1%25')).toEqual({page:'task',taskId:'任务%'});
});
