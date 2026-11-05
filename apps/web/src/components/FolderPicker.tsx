// 文件夹浏览对话框：浏览器版 Platform.pickFolder 的实现，只调用 GET /fs/browse，不让用户手打路径。
// 路径是 Gateway 给的不透明字符串，这里只显示、只原样传回，不拆分、不拼接。
import { useCallback, useEffect, useState } from 'react';
import type { ApiError, FsBrowseResult, FsEntry } from '@aic/protocol';
import { api } from '../state/app';
import { registerFolderPicker } from '../platform/browser';
import type { PickedFolder } from '../platform';
import { Dialog, ErrorNotice, asApiError, openDialog } from './ui';
import { Icon } from './Icon';

export function installFolderPicker() {
  registerFolderPicker(() => new Promise<PickedFolder | null>((resolve) => {
    openDialog((close) => <FolderPicker onDone={(v) => { close(); resolve(v); }} />);
  }));
}

interface Cur { path: string | null; name: string | null; isGit: boolean }

function FolderPicker({ onDone }: { onDone: (v: PickedFolder | null) => void }) {
  const [cur, setCur] = useState<Cur>({ path: null, name: null, isGit: false });
  const [data, setData] = useState<FsBrowseResult | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreBusy, setMoreBusy] = useState(false);
  /** 进入过的目录名，用于“上一级”时恢复显示名 */
  const [trail, setTrail] = useState<Cur[]>([]);

  const load = useCallback(async (path: string | null) => {
    setBusy(true);
    setErr(null);
    try {
      setData(await api.browse(path));
    } catch (e) {
      setErr(asApiError(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void load(null); }, [load]);

  /** 子文件夹很多时分页：按游标接着取下一页，追加到列表后面 */
  const loadMore = async () => {
    if (!data?.nextCursor || moreBusy) return;
    setMoreBusy(true);
    try {
      const next = await api.browse(data.path, data.nextCursor);
      setData((d) => (d && d.path === next.path ? { ...next, entries: [...d.entries, ...next.entries] } : d));
    } catch (e) {
      setErr(asApiError(e));
    } finally {
      setMoreBusy(false);
    }
  };

  const enter = (e: FsEntry) => {
    setTrail((t) => [...t, cur]);
    setCur({ path: e.path, name: e.name, isGit: e.isGit });
    void load(e.path);
  };
  const up = () => {
    if (!data) return;
    const prev = trail[trail.length - 1];
    setTrail((t) => t.slice(0, -1));
    // 优先用服务端给的 parent；它为 null 时回到根列表
    const parent = data.parent;
    setCur(prev && prev.path === parent ? prev : { path: parent, name: prev?.name ?? null, isGit: false });
    void load(parent);
  };
  const canPick = !!data?.path;

  return (
    <Dialog title="选择项目文件夹" wide onClose={() => onDone(null)}
      footer={<>
        <button type="button" className="btn" onClick={() => onDone(null)}>取消</button>
        <button type="button" className="btn primary" disabled={!canPick}
          onClick={() => data?.path && onDone({ path: data.path, name: cur.name ?? data.path, isGit: cur.isGit })}>
          选择这个文件夹
        </button>
      </>}>
      <div className="fs-bar">
        <button type="button" className="btn sm" onClick={up} disabled={!data?.path || busy} aria-label="上一级文件夹">
          <Icon name="up" />上一级
        </button>
        <span className="fs-cur" title={data?.path ?? ''} aria-live="polite">{data?.path ?? '此电脑'}</span>
      </div>
      {err ? <ErrorNotice error={err} onRetry={() => void load(cur.path)} /> : null}
      <ul className="fs-list" aria-label="文件夹" aria-busy={busy}>
        {data && data.entries.length === 0 ? <li className="fs-empty">这里没有子文件夹。可以直接选择当前文件夹。</li> : null}
        {data?.entries.map((e) => (
          <li key={e.path}>
            <button type="button" onClick={() => enter(e)} onDoubleClick={() => enter(e)}>
              <Icon name={e.kind === 'drive' ? 'drive' : e.kind === 'home' ? 'home' : 'folder'} />
              <span>{e.name}</span>
              {e.isGit ? <span className="meta">git 仓库</span> : null}
            </button>
          </li>
        ))}
        {data?.nextCursor ? (
          <li className="fs-more">
            <button type="button" className="btn sm" aria-busy={moreBusy} disabled={moreBusy} onClick={() => void loadMore()}>
              {moreBusy ? '正在载入…' : `已显示 ${data.entries.length} 个文件夹，显示更多`}
            </button>
          </li>
        ) : null}
      </ul>
      <p style={{ margin: 'var(--sp-2) 0 0', color: 'var(--fg-3)' }}>点文件夹进入，进到项目文件夹后点“选择这个文件夹”。这里只列出文件夹，不会读取文件内容。</p>
    </Dialog>
  );
}
