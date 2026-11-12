// 添加项目对话框与新建任务入口。
import { useState } from 'react';
import type { ApiError } from '@aic/protocol';
import { platform, type PickedFolder } from '../platform';
import { createProject } from '../state/app';
import { navigate, toast, type NewTaskPreset } from '../state/ui';
import { Dialog, ErrorNotice, asApiError, openDialog } from './ui';
import { Icon } from './Icon';

// ---------------------------------------------------------------------
// 添加项目：用 /fs/browse 浏览选文件夹，不让用户手打路径
// ---------------------------------------------------------------------
export function openAddProject(then?: (projectId: string) => void) {
  openDialog((close) => <AddProject close={close} then={then} />);
}
function AddProject({ close, then }: { close: () => void; then?: (id: string) => void }) {
  const [picked, setPicked] = useState<PickedFolder | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const pick = async () => {
    const f = await platform.pickFolder();
    if (f) { setPicked(f); setErr(null); }
  };
  const submit = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      const p = await createProject(name.trim() || picked.name, picked.path);
      toast(`已添加项目“${p.name}”`);
      close();
      then?.(p.id);
    } catch (e) { setErr(asApiError(e)); setBusy(false); }
  };
  return (
    <Dialog title="添加项目" onClose={close}
      footer={<>
        <button type="button" className="btn" onClick={close}>取消</button>
        <button type="button" className="btn primary" disabled={!picked} aria-busy={busy} onClick={submit}>添加</button>
      </>}>
      <p>选择本机的一个项目文件夹，之后就能在这个项目里派发任务。</p>
      {err ? <ErrorNotice error={err} /> : null}
      <div className="form-row">
        <span className="lbl" id="ap-l">文件夹</span>
        <div style={{ display: 'flex', gap: 8, minWidth: 0 }}>
          <span className="fs-cur" aria-labelledby="ap-l" title={picked?.path ?? ''}>{picked?.path ?? '还没有选择'}</span>
          <button type="button" className="btn" onClick={pick} autoFocus><Icon name="folder" />选择文件夹…</button>
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="ap-name">显示名称</label>
        <input id="ap-name" className="input" value={name} maxLength={200} placeholder={picked?.name ?? '默认用文件夹名'} onChange={(e) => setName(e.target.value)} />
      </div>
      {picked ? (
        <div className="alert info" style={{ margin: 0 }}>
          <Icon name="info" />
          <div className="body"><strong>检测结果</strong>
            <p>{picked.isGit ? '是 git 仓库。' : '不是 git 仓库。'}引擎类型和工作副本方式在有了独立工作副本后提供。</p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------
// 所有入口统一进入起始页，预设保存在 hash 查询参数中。
// ---------------------------------------------------------------------
export function openNewTask(preset: NewTaskPreset = {}) { navigate({ page: 'new', preset }); }

/** 兼容旧引用：状态文案集中在 lib/agents.ts */
export { agentStatusText } from '../lib/agents';
