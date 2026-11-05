// 搜索（Ctrl+K）：按任务标题搜索，另带几个常用操作。上下键选择，Enter 打开。
import { useMemo, useState } from 'react';
import { useApp } from '../state/app';
import { navigate } from '../state/ui';
import { setPref, prefsStore } from '../state/prefs';
import { taskStatusText } from '../lib/format';
import { Dialog, openDialog } from './ui';
import { openNewTask } from './dialogs';

export function openPalette() {
  openDialog((close) => <Palette close={close} />);
}

interface Entry { key: string; label: string; meta: string; run: () => void }

function Palette({ close }: { close: () => void }) {
  const tasks = useApp((s) => s.tasks);
  const projects = useApp((s) => s.projects);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);

  const entries = useMemo<Entry[]>(() => {
    const k = q.trim().toLowerCase();
    const list = Object.values(tasks)
      .filter((t) => !k || t.title.toLowerCase().includes(k))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, 30)
      .map((t) => ({
        key: 't:' + t.id, label: t.title,
        meta: `${taskStatusText[t.status][0]} · ${projects.find((p) => p.id === t.projectId)?.name ?? ''}`,
        run: () => navigate({ page: 'task', taskId: t.id }),
      }));
    const ops: Entry[] = [
      { key: 'o:new', label: '新建任务…', meta: '操作', run: () => openNewTask() },
      { key: 'o:theme', label: '切换日间 / 夜间模式', meta: '操作', run: () => setPref('theme', prefsStore.get().theme === 'light' ? 'dark' : 'light') },
      { key: 'o:agents', label: 'Agent 管理', meta: '页面', run: () => navigate({ page: 'agents' }) },
      { key: 'o:settings', label: '设置', meta: '页面', run: () => navigate({ page: 'settings' }) },
    ].filter((o) => !k || o.label.toLowerCase().includes(k));
    return [...list, ...ops];
  }, [q, tasks, projects]);

  const pick = (e: Entry | undefined) => { if (!e) return; close(); e.run(); };
  const cur = Math.min(sel, Math.max(0, entries.length - 1));

  return (
    <Dialog title="搜索" onClose={close} initialFocus="#pal-q">
      <label htmlFor="pal-q" className="sr-only">搜索任务标题</label>
      <input id="pal-q" className="input" value={q} placeholder="输入任务标题里的字…" role="combobox" aria-expanded="true"
        aria-controls="pal-list" aria-activedescendant={entries[cur] ? 'pal-' + cur : undefined} autoComplete="off"
        onChange={(e) => { setQ(e.target.value); setSel(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((cur + 1) % Math.max(1, entries.length)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setSel((cur - 1 + entries.length) % Math.max(1, entries.length)); }
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); pick(entries[cur]); }
        }} />
      <ul className="palette-list" role="listbox" id="pal-list" aria-label="搜索结果">
        {entries.map((en, i) => (
          <li key={en.key} id={'pal-' + i} role="option" aria-selected={i === cur} onMouseEnter={() => setSel(i)} onClick={() => pick(en)}>
            <span>{en.label}</span><span className="meta">{en.meta}</span>
          </li>
        ))}
        {!entries.length ? <li aria-disabled="true" style={{ color: 'var(--fg-3)', cursor: 'default' }}>没有找到标题包含“{q}”的任务</li> : null}
      </ul>
    </Dialog>
  );
}
