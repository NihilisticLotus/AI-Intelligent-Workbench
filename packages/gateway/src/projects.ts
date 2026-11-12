// 项目与分组
import type { AgentKind, Group, PatchProjectBody, Project } from '@aic/protocol';
import type { Db } from './db';
import { validateProjectDir } from './fsbrowse';
import type { TaskService } from './tasks';
import { Errors, newId, now } from './util';
import { projectBranch } from './project-branch';

type ProjectRow = { id: string; name: string; path: string; is_git: number; default_agent: string | null; created_at: number };
type GroupRow = { id: string; name: string; ord: number; created_at: number };

const toProject = (r: ProjectRow): Project => ({
  id: r.id, name: r.name, path: r.path, isGit: !!r.is_git, branch: projectBranch(r.path), defaultAgent: r.default_agent as AgentKind | null, createdAt: r.created_at,
});
const toGroup = (r: GroupRow): Group => ({ id: r.id, name: r.name, ord: r.ord, createdAt: r.created_at });

export class ProjectService {
  constructor(private db: Db) {}

  list(): Project[] { return this.db.all<ProjectRow>('SELECT * FROM projects ORDER BY created_at').map(toProject); }

  get(id: string): Project {
    const r = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id);
    if (!r) throw Errors.notFound('找不到这个项目');
    return toProject(r);
  }

  create(input: { name: string; path: string }): Project {
    const { path, isGit } = validateProjectDir(input.path);
    // Windows 路径不区分大小写
    if (this.db.get('SELECT id FROM projects WHERE lower(path) = lower(?)', path)) {
      throw Errors.conflict('这个文件夹已经添加过了');
    }
    const id = newId('p');
    this.db.run('INSERT INTO projects (id, name, path, is_git, created_at) VALUES (?, ?, ?, ?, ?)', id, input.name.trim(), path, isGit ? 1 : 0, now());
    return this.get(id);
  }

  patch(id: string, body: PatchProjectBody): Project {
    this.get(id);
    if (body.name !== undefined) this.db.run('UPDATE projects SET name = ? WHERE id = ?', body.name.trim(), id);
    if (body.defaultAgent !== undefined) this.db.run('UPDATE projects SET default_agent = ? WHERE id = ?', body.defaultAgent, id);
    return this.get(id);
  }

  /** 只移除工作台里的记录，不删除磁盘上的文件；项目下还有任务时拒绝 */
  delete(id: string) {
    this.get(id);
    const n = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', id)?.n ?? 0;
    if (n > 0) throw Errors.conflict(`项目下还有 ${n} 个任务，暂时不能移除`, '请先处理完这些任务');
    this.db.run('DELETE FROM projects WHERE id = ?', id);
  }
}

export class GroupService {
  constructor(private db: Db, private tasks: TaskService) {}

  list(): Group[] { return this.db.all<GroupRow>('SELECT * FROM task_groups ORDER BY ord, created_at').map(toGroup); }

  get(id: string): Group {
    const r = this.db.get<GroupRow>('SELECT * FROM task_groups WHERE id = ?', id);
    if (!r) throw Errors.notFound('找不到这个分组');
    return toGroup(r);
  }

  create(name: string): Group {
    const ord = (this.db.get<{ m: number | null }>('SELECT MAX(ord) AS m FROM task_groups')?.m ?? -1) + 1;
    const id = newId('g');
    this.db.run('INSERT INTO task_groups (id, name, ord, created_at) VALUES (?, ?, ?, ?)', id, name.trim(), ord, now());
    return this.get(id);
  }

  patch(id: string, body: { name?: string | undefined; ord?: number | undefined }): Group {
    this.get(id);
    if (body.name !== undefined) this.db.run('UPDATE task_groups SET name = ? WHERE id = ?', body.name.trim(), id);
    if (body.ord !== undefined) this.db.run('UPDATE task_groups SET ord = ? WHERE id = ?', body.ord, id);
    return this.get(id);
  }

  /** 删除分组：任务不删除，groupId 置空，并为每个受影响的任务推送 task.updated */
  delete(id: string) {
    this.get(id);
    const affected = this.db.tx(() => {
      const ids = this.db.all<{ id: string }>('SELECT id FROM tasks WHERE group_id = ?', id).map((r) => r.id);
      this.db.run('UPDATE tasks SET group_id = NULL, updated_at = ? WHERE group_id = ?', now(), id);
      this.db.run('DELETE FROM task_groups WHERE id = ?', id);
      return ids;
    });
    for (const t of affected) this.tasks.emitUpdated(t);
  }
}
