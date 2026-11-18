import type { AgentKind } from '@aic/protocol';
import type { Db } from '../db';

/** 恢复和预览共享来源选择。历史收据保留失败的接收段，继续对话时跳过它。 */
export function sourceSession(db:Db, taskId:string, agent:AgentKind, explicitId?:string, nativeOnly=false) {
  return db.get<{id:string;handoff_id:string|null;agent_session_id:string|null;profile_id:string|null;caps_json:string|null}>(`
    SELECT s.id,s.handoff_id,s.agent_session_id,s.profile_id,s.caps_json FROM sessions s
    LEFT JOIN handoffs h ON h.id=s.handoff_id AND h.task_id=s.task_id
    WHERE s.task_id=? AND s.agent_id=? AND (?=0 OR s.agent_session_id IS NOT NULL)
      AND (? IS NULL OR s.id=?) AND (h.id IS NULL OR h.state<>'failed')
    ORDER BY (s.status='active') DESC,
      COALESCE((SELECT MAX(e.seq) FROM events e WHERE e.task_id=s.task_id AND e.session_id=s.id AND e.type='session.started' AND e.replay=0),0) DESC,
      s.started_at DESC,s.rowid DESC LIMIT 1`,taskId,agent,Number(nativeOnly),explicitId??null,explicitId??null);
}
