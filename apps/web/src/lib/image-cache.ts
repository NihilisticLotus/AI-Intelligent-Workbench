// 附件不可变；仅在当前页面内复用已鉴权获取的 Blob，不缓存 URL、凭据或失败结果。
export function createImageCache(maxEntries = 32, maxBytes = 64 * 1024 * 1024) {
  type Entry = { promise: Promise<Blob>; bytes: number };
  const entries = new Map<string, Entry>(); let bytes = 0, generation = 0;
  const remove = (key: string) => { const entry = entries.get(key); if (entry) { bytes -= entry.bytes; entries.delete(key); } };
  const trim = () => {
    while (entries.size > maxEntries || bytes > maxBytes) { const oldest = entries.keys().next().value; if (oldest === undefined) break; remove(oldest); }
  };
  return {
    get(taskId: string, attachmentId: string, load: () => Promise<Blob>): Promise<Blob> {
      const key = JSON.stringify([taskId, attachmentId]), found = entries.get(key);
      if (found) { entries.delete(key); entries.set(key, found); return found.promise; }
      const version = generation;
      const entry: Entry = { bytes: 0, promise: Promise.resolve().then(load).then((blob) => {
        if (version !== generation) throw new Error('图片访问状态已变化，请重新打开任务');
        if (entries.get(key) === entry) { entry.bytes = blob.size; bytes += blob.size; trim(); }
        return blob;
      }).catch((error: unknown) => { if (entries.get(key) === entry) remove(key); throw error; }) };
      entries.set(key, entry); trim(); return entry.promise;
    },
    clear() { generation++; entries.clear(); bytes = 0; },
  };
}
export const imageCache = createImageCache();
