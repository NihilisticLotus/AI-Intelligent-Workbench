// Agent 进程登记（phase-1.md 6.2.1）：记下启动过的 Agent 进程；Gateway 退出时同步结束进程树；
// 下次启动时，对仍然存在且启动时间一致的 pid 结束进程树（防止 pid 被复用后误杀），然后清表。
import { killTree, killTreeSync, processStartTimes, type ProcessTracker } from '@aic/adapters';
import type { AgentKind } from '@aic/protocol';
import type { Db } from './db';

/** 记录的启动时间与系统报告的进程启动时间允许的误差 */
const START_TOLERANCE_MS = 10_000;

export class ProcessRegistry implements ProcessTracker {
  private live = new Map<number, AgentKind>();

  constructor(private db: Db, private log: (m: string) => void = () => {}) {}

  started(p: { pid: number; agent: AgentKind; sessionId: string | null; startedAt: number }) {
    this.live.set(p.pid, p.agent);
    try { this.db.run('INSERT INTO agent_processes (pid, created_at, agent, session_id) VALUES (?, ?, ?, ?)', p.pid, String(p.startedAt), p.agent, p.sessionId); } catch { /* 数据库已关闭 */ }
  }

  exited(pid: number) {
    this.live.delete(pid);
    try { this.db.run('DELETE FROM agent_processes WHERE pid = ?', pid); } catch { /* 数据库已关闭 */ }
  }

  livePids() { return [...this.live.keys()]; }

  /** Gateway 退出时：对所有还活着的 Agent 进程同步结束进程树 */
  killAllSync() {
    for (const pid of this.live.keys()) killTreeSync(pid);
    this.live.clear();
  }

  /** 启动时清理上次遗留的 Agent 进程 */
  async cleanupOrphans(): Promise<number> {
    const rows = this.db.all<{ pid: number; created_at: string; agent: string }>('SELECT pid, created_at, agent FROM agent_processes');
    if (rows.length === 0) return 0;
    const starts = await processStartTimes(rows.map((r) => r.pid));
    let killed = 0;
    for (const r of rows) {
      const actual = starts.get(r.pid);
      const recorded = Number(r.created_at);
      if (actual !== undefined && Number.isFinite(recorded) && Math.abs(actual - recorded) < START_TOLERANCE_MS) {
        await killTree(r.pid);
        killed++;
        this.log(`[agents] 结束上次遗留的 ${r.agent} 进程 ${r.pid}`);
      }
    }
    try { this.db.run('DELETE FROM agent_processes WHERE pid IN (' + rows.map(() => '?').join(',') + ')', ...rows.map((r) => r.pid)); } catch { /* 忽略 */ }
    return killed;
  }
}
