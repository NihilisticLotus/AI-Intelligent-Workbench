// 数据库薄封装：只依赖 node:sqlite（Node 内置，无需编译原生模块）。
// 以后如需换成 better-sqlite3，只改这个文件。
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type SqlValue = SQLInputValue;
export type Row = Record<string, unknown>;

export interface Db {
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<T = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T = Row>(sql: string, ...params: SqlValue[]): T[];
  exec(sql: string): void;
  /** 同步事务：fn 抛错时回滚 */
  tx<T>(fn: () => T): T;
  close(): void;
}

/** 迁移：按数组下标 +1 作为版本号，只追加，不修改已发布的迁移 */
const MIGRATIONS: string[] = [
  // v1：1.1 骨架
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
    is_git INTEGER NOT NULL DEFAULT 0, default_agent TEXT, default_profile TEXT, default_model TEXT,
    ignore_globs TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE task_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT, title TEXT NOT NULL, prompt TEXT NOT NULL,
    status TEXT NOT NULL, permission_level TEXT NOT NULL,
    agent TEXT NOT NULL, model TEXT, effort TEXT,
    auto_allow_low_risk INTEGER NOT NULL DEFAULT 0, auto_merge_on_pass INTEGER NOT NULL DEFAULT 0,
    workspace_kind TEXT, workspace_path TEXT, branch TEXT, base_ref TEXT, snapshot_before TEXT, snapshot_after TEXT,
    source TEXT NOT NULL DEFAULT 'manual', automation_id TEXT,
    last_activity_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
  );
  CREATE INDEX idx_tasks_activity ON tasks(last_activity_at DESC, id DESC);
  CREATE INDEX idx_tasks_project ON tasks(project_id);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, agent_id TEXT NOT NULL, profile_id TEXT, model TEXT,
    agent_session_id TEXT, parent_session_id TEXT, handoff_id TEXT, caps_json TEXT,
    status TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER
  );
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT, session_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, ts INTEGER NOT NULL,
    replay INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_events_task ON events(task_id, seq);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL, session_id TEXT NOT NULL, request_json TEXT NOT NULL,
    status TEXT NOT NULL, decided_by TEXT, decided_at INTEGER, created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_approvals_status ON approvals(status);
  CREATE TABLE devices (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE, last_ip TEXT, last_seen INTEGER, paired_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, action TEXT NOT NULL, detail TEXT, ts INTEGER NOT NULL);
  `,
  // v2：浏览器凭据改为“Cookie + 设备密钥”。v1 时浏览器只靠 Cookie，那些令牌的哈希也能被当成 Bearer 使用，
  // 一律作废，浏览器下次打开时重新配对即可
  `
  UPDATE devices SET revoked = 1 WHERE kind = 'browser' AND revoked = 0;
  INSERT INTO audit_log (device_id, action, detail, ts) VALUES (NULL, 'migration.v2', '作废只靠 Cookie 的浏览器设备', CAST(strftime('%s','now') AS INTEGER) * 1000);
  `,
  // v3：1.2 接入真实 Agent（phase-1.md 6.4.1、6.2.4）：账号、加密的密钥、Agent 进程登记、能力缓存
  `
  CREATE TABLE agent_profiles (
    id TEXT PRIMARY KEY, agent TEXT NOT NULL, name TEXT NOT NULL,
    kind TEXT NOT NULL,
    config_dir TEXT NOT NULL,
    base_url TEXT,
    auth_header TEXT,
    models_json TEXT,
    secret_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    last_test_at INTEGER, last_test_ok INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_profiles_default ON agent_profiles(agent) WHERE is_default = 1;
  CREATE TABLE secrets (
    id TEXT PRIMARY KEY, scheme TEXT NOT NULL,
    blob TEXT NOT NULL,
    hint TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE agent_processes (pid INTEGER NOT NULL, created_at TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT);
  CREATE TABLE agent_caps (
    agent TEXT NOT NULL, profile_id TEXT NOT NULL, adapter_version TEXT, engine_version TEXT,
    caps_json TEXT, catalog_json TEXT, commands_json TEXT, probed_at INTEGER NOT NULL,
    PRIMARY KEY (agent, profile_id)
  );
  ALTER TABLE tasks ADD COLUMN profile_id TEXT;
  `,
  // v4（2026-11-07）：任务草稿（输入框里没发出去的文字和注释），按任务保存，换设备也在
  `
  CREATE TABLE task_drafts (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    text TEXT NOT NULL, annotations_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  `,
  // v5：附件与账号下的模型失败记录，旧迁移保持不变。
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL,
    width INTEGER, height INTEGER, sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER
  );
  CREATE INDEX idx_attachments_task ON attachments(task_id);
  CREATE TABLE model_failures (
    agent TEXT NOT NULL, profile_id TEXT NOT NULL, model TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (agent, profile_id, model)
  );
  ALTER TABLE task_drafts ADD COLUMN attachments_json TEXT;
  `,
  // v6：独立工具的持久意图，不保存参数、密钥或输出正文。
  `
  CREATE TABLE independent_tool_calls (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn_id TEXT NOT NULL, call_id TEXT NOT NULL, tool_name TEXT NOT NULL, input_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected','running','succeeded','failed','cancelled','interrupted')),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    pid INTEGER, process_started_at INTEGER, outcome_json TEXT,
    UNIQUE(session_id, turn_id, call_id)
  );
  CREATE INDEX idx_independent_tools_state ON independent_tool_calls(state, session_id);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');

  // 语句缓存：同一条 SQL 只 prepare 一次
  const cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;

  const db: Db = {
    run(sql, ...params) {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get<T>(sql: string, ...params: SqlValue[]) { return stmt(sql).get(...params) as T | undefined; },
    all<T>(sql: string, ...params: SqlValue[]) { return stmt(sql).all(...params) as T[]; },
    exec(sql) { raw.exec(sql); },
    tx(fn) {
      // 支持嵌套：只有最外层真正开启 / 提交事务
      if (depth > 0) { depth++; try { return fn(); } finally { depth--; } }
      raw.exec('BEGIN IMMEDIATE');
      depth = 1;
      try { const r = fn(); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
      finally { depth = 0; }
    },
    close() { cache.clear(); raw.close(); },
  };
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const cur = Number(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0);
  if (cur > MIGRATIONS.length) {
    throw new Error(`数据库版本 ${cur} 比当前程序支持的 ${MIGRATIONS.length} 新，请升级 AI Console`);
  }
  for (let v = cur; v < MIGRATIONS.length; v++) {
    db.tx(() => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
