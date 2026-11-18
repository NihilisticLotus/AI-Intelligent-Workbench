import { createHash } from 'node:crypto';
import type { Db } from '../db';

const digest = (taskId: string, value: string) => createHash('sha256').update(taskId+'\0'+value).digest('hex');

/** 同一任务复用已发放的序号。只有预览器登记确实出现过的文件，历史接口只读。 */
export function pathAliases(db: Db, taskId: string, environment: string[], confirmed?: string[]) {
  const hashes = new Map(environment.map(value => [digest(taskId,value),value]));
  if (confirmed) {
    const candidates = new Set(confirmed.filter(name => hashes.has(digest(taskId,name))));
    db.tx(() => {
      for (const name of candidates) {
        db.run(`INSERT OR IGNORE INTO handoff_path_aliases(task_id,digest,ordinal)
          SELECT ?,?,COALESCE(MAX(ordinal),0)+1 FROM handoff_path_aliases WHERE task_id=?`,
        taskId,digest(taskId,name),taskId);
      }
    });
  }
  const aliases = new Map<string,string>();
  for (const row of db.all<{digest:string;ordinal:number}>('SELECT digest,ordinal FROM handoff_path_aliases WHERE task_id=?',taskId)) {
    const name = hashes.get(row.digest);
    if (name) aliases.set(name,'已隐藏路径 '+row.ordinal);
  }
  return aliases;
}
