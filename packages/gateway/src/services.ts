// 各服务的集合，路由和 WebSocket 共用
import type { AttachmentService } from './attachments';
import type { IndependentCatalog } from './independent/catalog';
import type { IndependentDiscovery } from './independent/discovery';
import type { IndependentTaskRuntime } from './independent/task-runtime';
import type { Hello } from '@aic/protocol';
import type { AuthService } from './auth';
import type { AgentRegistry } from './agents/registry';
import type { AgentService } from './agents/service';
import type { ProfileService } from './profiles';
import type { SecretService } from './secrets';
import type { ProcessRegistry } from './processes';
import type { Db } from './db';
import type { EventStore } from './events';
import type { GroupService, ProjectService } from './projects';
import type { TaskService } from './tasks';

export interface Services {
  db: Db;
  attachments: AttachmentService;
  independent: IndependentCatalog;
  independentDiscovery: IndependentDiscovery;
  independentRuntime: IndependentTaskRuntime;
  lastExit: Hello['lastExit'];
  auth: AuthService;
  events: EventStore;
  agents: AgentRegistry;
  /** 1.2：检测缓存、能力缓存、登录、测试连接、并发上限 */
  agentSvc: AgentService;
  profiles: ProfileService;
  secrets: SecretService;
  processes: ProcessRegistry;
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
