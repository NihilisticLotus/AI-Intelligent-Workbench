import type { Task } from '@aic/protocol';
import { api, putTask } from '../state/app';
import { confirmDialog } from './ui';

export async function confirmWorkspaceCopy(task: Task): Promise<Task | null> {
  const bytes = task.workspace?.copyBytes ?? 0;
  if (!await confirmDialog({ title: '确认复制项目文件', ok: '复制并继续', body: <>
    <p>这次需要复制约 {(bytes / 1024 / 1024).toFixed(1)} MB 到工作副本，会占用额外磁盘空间。</p>
    <p>原项目文件保持不变。大于 50 MB 的单个文件会复制，但不进入快照，不能依靠快照回滚。</p>
  </> })) return null;
  const prepared = await api.prepareWorkspace(task.id);
  putTask(prepared);
  if (prepared.workspace?.state === 'failed') throw new Error(prepared.workspace.error ?? '工作副本准备失败');
  return prepared;
}
