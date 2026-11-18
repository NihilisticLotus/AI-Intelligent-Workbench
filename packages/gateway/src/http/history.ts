import { Hono } from 'hono';
import { HistoryQuery } from '@aic/protocol';
import type { Services } from '../services';
import { Errors } from '../util';
import { readBody, type Env } from './app';
import { readHistory } from '../handoff/history';

export function historyRoutes(s: Services) {
  const routes = new Hono<Env>();
  routes.post('/internal/history/read', async c => {
    const header = c.req.header('authorization');
    const grant = s.history.authenticate(header);
    const query = await readBody(c, HistoryQuery);
    const result = await readHistory(s, grant, query);
    // 读取检查点或打码期间可能关闭会话，返回结果和增加计数前再次核对。
    s.history.authenticate(header);
    const recorded = s.db.run(
      `UPDATE handoffs SET quality_json=json_set(quality_json,'$.historyCalls',
        COALESCE(json_extract(quality_json,'$.historyCalls'),0)+1) WHERE id=? AND task_id=?`,
      grant.handoffId, grant.taskId,
    );
    if (!recorded.changes) throw Errors.notFound('找不到交接记录');
    return c.json(result);
  });
  return routes;
}
