// 各服务的集合，路由和 WebSocket 共用
import type { AuthService } from './auth';
import type { AgentRegistry } from './agents/registry';
import type { Db } from './db';
import type { EventStore } from './events';
import type { GroupService, ProjectService } from './projects';
import type { TaskService } from './tasks';

export interface Services {
  db: Db;
  auth: AuthService;
  events: EventStore;
  agents: AgentRegistry;
  projects: ProjectService;
  groups: GroupService;
  tasks: TaskService;
  /** 实际监听的端口 */
  port(): number;
  machine: { id: string; name: string; os: string };
  version: string;
  /** 每次启动都会变：客户端据此判断服务是否重启过（断线前未确认的指令不重发） */
  bootId: string;
}
