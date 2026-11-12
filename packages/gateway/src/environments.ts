import { SavedEnvironment, type CreateEnvironmentBody } from '@aic/protocol';
import type { Db } from './db';
import { Errors, newId } from './util';

export function environments(db: Db): SavedEnvironment[] {
  return db.all('SELECT id,name,project_id AS projectId,branch FROM saved_environments ORDER BY created_at,id').map((r) => SavedEnvironment.parse(r));
}
export function saveEnvironment(db: Db, body: CreateEnvironmentBody): SavedEnvironment {
  return db.tx(() => {
    if (!db.get('SELECT id FROM projects WHERE id=?', body.projectId)) throw Errors.notFound('找不到项目');
    if (Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM saved_environments')?.n) >= 50) throw Errors.conflict('最多保存 50 个常用环境，请先移除不再使用的组合');
    const item = SavedEnvironment.parse({ ...body, id: newId('env') });
    db.run('INSERT INTO saved_environments(id,name,project_id,branch,created_at) VALUES (?,?,?,?,?)', item.id, item.name, item.projectId, item.branch, Date.now());
    return item;
  });
}
export function deleteEnvironment(db: Db, id: string) {
  if (!db.run('DELETE FROM saved_environments WHERE id=?', id).changes) throw Errors.notFound('找不到常用环境');
}
