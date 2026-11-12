import path from 'node:path';
import { TaskFile, type ToolFile, type EventEnvelope } from '@aic/protocol';
import type { Db } from './db';
import { Errors } from './util';

/** 工具记录只是修改线索；只汇总成功工具和已写入回执，不读取项目文件正文。 */
export function taskFiles(db: Db, taskId: string): TaskFile[] {
  const task = db.get<{ agent: string; path: string }>('SELECT t.agent,p.path FROM tasks t JOIN projects p ON t.project_id=p.id WHERE t.id=?', taskId);
  if (!task) throw Errors.notFound('找不到任务');
  const result = new Map<string, TaskFile>();
  const add = (file: ToolFile, sessionId: string | null, at: number, source: TaskFile['source']) => {
    const absolute = path.resolve(task.path, file.path), relative = path.relative(task.path, absolute);
    const display = relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : absolute;
    const key = `${sessionId ?? ''}\0${process.platform === 'win32' ? absolute.toLowerCase() : absolute}`;
    const old = result.get(key);
    const sum = (a: number | null, b: number | null) => a === null || b === null || !Number.isSafeInteger(a + b) ? null : a + b;
    result.set(key, TaskFile.parse({ ...file, path: display, name: path.basename(display), directory: path.dirname(display), sessionId, source,
      updatedAt: Math.max(old?.updatedAt ?? 0, at), created: file.created || !!old?.created,
      added: old ? sum(old.added, file.added) : file.added, removed: old ? sum(old.removed, file.removed) : file.removed }));
  };
  if (task.agent === 'independent') {
    const rows = db.all<{ path: string; session_id: string; updated_at: number; before_hash: string | null }>(
      "SELECT path,session_id,updated_at,before_hash FROM independent_file_receipts WHERE task_id=? AND state='written' ORDER BY updated_at,id", taskId);
    for (const r of rows) add({ path: r.path, added: null, removed: null, created: r.before_hash === null }, r.session_id, r.updated_at, 'independent');
  } else {
    const tools = new Map<string, { sessionId: string | null; kind: string; target: string | null; at: number; ok: boolean; files: Map<string, ToolFile> }>();
    const rows = db.all<{ session_id: string | null; type: string; payload: string; ts: number }>(
      "SELECT session_id,type,payload,ts FROM events WHERE task_id=? AND type IN ('tool.start','tool.update','tool.end') ORDER BY seq", taskId);
    for (const row of rows) {
      const event = { type: row.type, data: JSON.parse(row.payload) } as Extract<EventEnvelope, { type: 'tool.start' | 'tool.update' | 'tool.end' }>;
      const key = `${row.session_id ?? ''}\0${event.data.toolId}`;
      if (event.type === 'tool.start') tools.set(key, { sessionId: row.session_id, kind: event.data.kind, target: event.data.target, at: row.ts, ok: false, files: new Map() });
      const t = tools.get(key); if (!t) continue;
      t.at = row.ts;
      if (event.type === 'tool.update') {
        if (event.data.kind) t.kind = event.data.kind;
        if (event.data.target !== undefined) t.target = event.data.target;
        for (const f of event.data.files ?? []) t.files.set(f.path, f);
      }
      if (event.type === 'tool.end') t.ok = event.data.ok && !event.data.rejected;
    }
    for (const t of tools.values()) if (t.ok && ['edit', 'create', 'delete'].includes(t.kind)) {
      const files = t.files.size ? [...t.files.values()] : t.target ? [{ path: t.target, added: null, removed: null, created: t.kind === 'create' }] : [];
      for (const file of files) add(file, t.sessionId, t.at, 'agent');
    }
  }
  return [...result.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
}
