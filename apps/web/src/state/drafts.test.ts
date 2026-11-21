import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FeatureKey, type Hello, type TaskDraft } from '@aic/protocol';
import { api, appStore } from './app';
import { clearDraft, discardSessionDrafts, flushNow, keepDraftEdits, loadDraft, pendingDraftEdits, saveDraft } from './drafts';

const draft = (text: string): TaskDraft => ({ text, annotations: [], updatedAt: 1 });
const hello: Hello = { server:'ai-console-gateway', protocol:1, version:'1', lastSeq:0, features:{[FeatureKey.Drafts]:true},
  machine:{id:'m',name:'测试电脑',os:'windows'}, device:{id:'d',name:'测试浏览器',kind:'browser'} };
beforeEach(() => appStore.set(s => ({ ...s, hello })));
afterEach(() => { discardSessionDrafts(); appStore.set(s => ({ ...s, hello:null })); vi.restoreAllMocks(); });

it('草稿读取失败后可重新拉取，重新打开可取得其他设备写入的版本', async () => {
  const get = vi.spyOn(api, 'getDraft').mockRejectedValueOnce(new Error('临时断线'))
    .mockResolvedValueOnce(draft('原稿')).mockResolvedValueOnce(draft('手机续写'));
  await expect(loadDraft('读取')).rejects.toThrow('临时断线');
  expect((await loadDraft('读取'))?.text).toBe('原稿');
  expect((await loadDraft('读取'))?.text).toBe('手机续写');
  expect(get).toHaveBeenCalledTimes(3);
});

it('先前的保存未结束时，清空草稿会排在它后面', async () => {
  let finish!: (value: TaskDraft) => void;
  const put = vi.spyOn(api, 'putDraft').mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue(draft(''));
  saveDraft('顺序', draft('已经发送'));
  const first = flushNow('顺序');
  await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
  clearDraft('顺序');
  expect(put).toHaveBeenCalledTimes(1);
  finish(draft('已经发送'));
  await first;
  await flushNow('顺序');
  expect(put.mock.calls.map(([, body]) => body.text)).toEqual(['已经发送', '']);
});

it('原稿尚未读回时保留本页输入，离开任务不把缺失字段写回', async () => {
  const put = vi.spyOn(api, 'putDraft').mockResolvedValue(draft('续写'));
  vi.spyOn(api, 'getDraft').mockResolvedValue({ ...draft('原稿'), attachments: ['原附件'] });
  keepDraftEdits('恢复', { text: '续写' });
  await flushNow();
  expect(put).not.toHaveBeenCalled();
  const original = await loadDraft('恢复');
  expect(original?.attachments).toEqual(['原附件']);
  saveDraft('恢复', { ...original!, ...pendingDraftEdits('恢复') });
  await flushNow();
  expect(put.mock.calls[0]?.[1]).toMatchObject({ text: '续写', attachments: ['原附件'] });
  expect(pendingDraftEdits('恢复')).toBeUndefined();
  keepDraftEdits('恢复', { text: '仅供当前设备' });
  discardSessionDrafts();
  expect(pendingDraftEdits('恢复')).toBeUndefined();
});
