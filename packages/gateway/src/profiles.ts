// 账号配置（phase-1.md 6.4）。接口永远不返回密钥明文：只有 hasSecret 和结尾 4 位。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { ModelInfo, type AgentKind, type AgentProfile, type CreateProfileBody, type PatchProfileBody, type ProfileKind, type ProfileSummary } from '@aic/protocol';
import { buildNativeEnv, type AccountProfile, type AgentAdapter } from '@aic/adapters';
import type { Db } from './db';
import type { SecretService } from './secrets';
import { Errors, newId, now } from './util';

export type ProfileRow = {
  id: string; agent: AgentKind; name: string; kind: ProfileKind; config_dir: 'shared' | 'isolated';
  base_url: string | null; auth_header: 'x-api-key' | 'bearer' | null; models_json: string | null; secret_id: string | null;
  is_default: number; last_test_at: number | null; last_test_ok: number | null; created_at: number; updated_at: number;
};

/** 自动建的默认账号“本机登录”：id 固定，不能删除 */
export const localProfileId = (agent: AgentKind) => `pf_local_${agent}`;
const LOCAL_NAME: Partial<Record<AgentKind, string>> = { workbuddy: '沿用 WorkBuddy 登录' };

export interface ProfileServiceOptions {
  dataDir: string;
  adapter(kind: AgentKind): AgentAdapter | undefined;
  /** 账号的登录状态（AgentService 维护） */
  loggedIn(profileId: string): boolean | null;
  audit(deviceId: string | null, action: string, detail: string): void;
}

export class ProfileService {
  constructor(private db: Db, private secrets: SecretService, private o: ProfileServiceOptions) {}

  /** 每个 Agent 首次检测时自动建一个默认账号“本机登录”（subscription，shared） */
  ensureLocal(agent: AgentKind): ProfileRow {
    const id = localProfileId(agent);
    let r = this.db.get<ProfileRow>('SELECT * FROM agent_profiles WHERE id = ?', id);
    if (!r) {
      const t = now();
      const hasDefault = !!this.db.get('SELECT id FROM agent_profiles WHERE agent = ? AND is_default = 1', agent);
      this.db.run(
        `INSERT INTO agent_profiles (id, agent, name, kind, config_dir, is_default, created_at, updated_at) VALUES (?, ?, ?, 'subscription', 'shared', ?, ?, ?)`,
        id, agent, LOCAL_NAME[agent] ?? '本机登录', hasDefault ? 0 : 1, t, t,
      );
      r = this.db.get<ProfileRow>('SELECT * FROM agent_profiles WHERE id = ?', id)!;
    } else if (agent === 'codebuddy' && r.name === '沿用 WorkBuddy 登录') {
      // CodeBuddy 和 WorkBuddy 拆成两个 Agent 之后（ISSUE-0016），旧数据里的名称改为通用的“本机登录”
      this.db.run('UPDATE agent_profiles SET name = ?, updated_at = ? WHERE id = ?', '本机登录', now(), id);
      r = this.db.get<ProfileRow>('SELECT * FROM agent_profiles WHERE id = ?', id)!;
    }
    return r;
  }

  row(id: string): ProfileRow {
    const r = this.db.get<ProfileRow>('SELECT * FROM agent_profiles WHERE id = ?', id);
    if (!r) throw Errors.notFound('找不到这个账号');
    return r;
  }

  defaultRow(agent: AgentKind): ProfileRow {
    if (this.o.adapter(agent)?.usesNativeConfig) return this.ensureLocal(agent);
    return this.db.get<ProfileRow>('SELECT * FROM agent_profiles WHERE agent = ? AND is_default = 1', agent) ?? this.ensureLocal(agent);
  }

  /** 任务的账号：profile_id 为空用默认账号 */
  resolve(agent: AgentKind, profileId: string | null | undefined): ProfileRow {
    if (!profileId) return this.defaultRow(agent);
    const r = this.row(profileId);
    if (r.agent !== agent) throw Errors.badRequest('这个账号不属于这个 Agent');
    this.assertUsable(r);
    return r;
  }

  /** 旧账号可以查看或清理，但不能再给第三方进程替换认证。 */
  assertUsable(r: ProfileRow) {
    if (this.o.adapter(r.agent)?.usesNativeConfig && (r.id !== localProfileId(r.agent) || r.kind !== 'subscription' || r.config_dir !== 'shared' || r.secret_id)) {
      throw Errors.nativeConfiguration('这个 Agent 沿用软件自身的配置与登录', '旧的工作台测试账号已停止使用；自定义 API 属于 AI Console 独立 Agent');
    }
  }

  toApi(r: ProfileRow): AgentProfile {
    const a = this.o.adapter(r.agent);
    return {
      id: r.id, agent: r.agent, name: r.name, kind: r.kind, configDir: r.config_dir,
      baseUrl: r.base_url, authHeader: r.auth_header, models: parseModels(r.models_json),
      hasSecret: !!r.secret_id, secretHint: this.secrets.hint(r.secret_id),
      isDefault: a?.usesNativeConfig ? r.id === localProfileId(r.agent) : !!r.is_default, loggedIn: this.o.loggedIn(r.id),
      experimental: a?.experimentalProfile?.(r.kind) ?? false,
      lastTestAt: r.last_test_at, lastTestOk: r.last_test_ok === null ? null : !!r.last_test_ok,
      createdAt: r.created_at, updatedAt: r.updated_at,
      ...(a?.usesNativeConfig ? { retired: r.id !== localProfileId(r.agent) } : {}),
    };
  }

  summary(agent: AgentKind): ProfileSummary[] {
    return this.rows(agent).filter((r) => !this.o.adapter(agent)?.usesNativeConfig || r.id === localProfileId(agent)).map((r) => ({ id: r.id, name: r.name, kind: r.kind, isDefault: this.toApi(r).isDefault, loggedIn: this.o.loggedIn(r.id), sessionStore: this.sessionStore(r) }));
  }

  /** 会话存在哪：键相同的账号之间可以恢复彼此的会话（换账号是否需要交接） */
  sessionStore(r: ProfileRow): string {
    return this.o.adapter(r.agent)?.sessionStore?.({ id: r.id, kind: r.kind, configDir: r.config_dir })
      ?? (r.config_dir === 'isolated' ? `profile:${r.id}` : 'shared');
  }

  rows(agent?: AgentKind): ProfileRow[] {
    return agent
      ? this.db.all<ProfileRow>('SELECT * FROM agent_profiles WHERE agent = ? ORDER BY is_default DESC, created_at', agent)
      : this.db.all<ProfileRow>('SELECT * FROM agent_profiles ORDER BY agent, is_default DESC, created_at');
  }

  list(agent?: AgentKind): AgentProfile[] {
    if (agent) this.ensureLocal(agent);
    return this.rows(agent).map((r) => this.toApi(r));
  }

  get(id: string): AgentProfile { return this.toApi(this.row(id)); }

  /** 只清理已停用配置的工作台密钥；保留身份与历史绑定，不接触 Agent 目录。 */
  clearRetiredSecret(id: string, inUse: (id: string) => boolean, deviceId: string | null): AgentProfile {
    this.db.tx(() => {
      const r = this.row(id);
      if (!this.o.adapter(r.agent)?.usesNativeConfig || r.id === localProfileId(r.agent)) {
        throw Errors.badRequest('只能清理已停用的工作台测试配置密钥');
      }
      if (inUse(id)) throw Errors.profileInUse('这个配置还有正在运行的会话', '请先停止相关任务');
      if (!r.secret_id) return;
      // 不能因异常共享引用而删除其他配置仍在使用的密钥。
      if (this.db.get('SELECT id FROM agent_profiles WHERE secret_id = ? AND id <> ?', r.secret_id, id)
        || this.db.get('SELECT id FROM independent_services WHERE secret_id = ?', r.secret_id)) {
        throw Errors.badRequest('密钥仍被其他配置引用，请先核对配置归属');
      }
      this.secrets.delete(r.secret_id);
      this.db.run('UPDATE agent_profiles SET secret_id = NULL, updated_at = ? WHERE id = ?', now(), id);
      this.o.audit(deviceId, 'profile.secret.clear', id);
    });
    return this.get(id);
  }

  /** 账号专属目录：.aic-data/profiles/<id>/ */
  dirOf(id: string) { return path.join(this.o.dataDir, 'profiles', id); }

  async create(body: CreateProfileBody, deviceId: string | null): Promise<AgentProfile> {
    const a = this.o.adapter(body.agent);
    if (!a || !a.real) throw Errors.badRequest('这个 Agent 不需要账号');
    if (a.usesNativeConfig) throw Errors.nativeConfiguration('第三方 Agent 的 API 与登录由软件自己管理', '请在对应软件中完成配置；工作台自定义 API 将由独立 Agent 使用');
    this.ensureLocal(body.agent);
    if (body.kind === 'customEndpoint' && !body.baseUrl) throw Errors.badRequest('自定义地址需要填写 Base URL');
    if (body.kind !== 'subscription' && !body.apiKey) throw Errors.badRequest('请填写 API Key');
    if (body.kind === 'subscription' && body.apiKey) throw Errors.badRequest('订阅登录的账号不需要 API Key');
    const id = newId('pf');
    // 新的订阅账号默认用独立的配置目录（第二个订阅账号）；API Key 和自定义地址沿用 Agent 的配置目录（保留设置、技能和 MCP）
    const configDir = body.configDir ?? (body.kind === 'subscription' ? 'isolated' : 'shared');
    const secret = body.apiKey ? await this.secrets.save(body.apiKey) : null;
    const t = now();
    this.db.run(
      `INSERT INTO agent_profiles (id, agent, name, kind, config_dir, base_url, auth_header, models_json, secret_id, is_default, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id, body.agent, body.name, body.kind, configDir, body.kind === 'customEndpoint' ? body.baseUrl ?? null : null,
      body.kind === 'customEndpoint' ? body.authHeader ?? 'x-api-key' : null,
      body.models ? JSON.stringify(body.models) : null, secret?.id ?? null, t, t,
    );
    if (configDir === 'isolated') mkdirSync(this.dirOf(id), { recursive: true });
    // 审计详情里只写账号 ID 和名称
    this.o.audit(deviceId, 'profile.create', `${id} ${body.name}`);
    return this.get(id);
  }

  async patch(id: string, body: PatchProfileBody, deviceId: string | null): Promise<AgentProfile> {
    const r = this.row(id);
    if (this.o.adapter(r.agent)?.usesNativeConfig) throw Errors.nativeConfiguration('工作台不修改这个 Agent 的认证配置', '旧测试配置仅保留待清理；请在对应软件中管理 API 与登录');
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (body.name !== undefined) { sets.push('name = ?'); params.push(body.name); }
    if (body.configDir !== undefined) {
      if (r.id === localProfileId(r.agent) && body.configDir !== 'shared') throw Errors.badRequest('“本机登录”账号只能使用 Agent 自己的配置目录');
      sets.push('config_dir = ?'); params.push(body.configDir);
    }
    if (body.baseUrl !== undefined) {
      if (r.kind !== 'customEndpoint') throw Errors.badRequest('只有自定义地址的账号才有 Base URL');
      sets.push('base_url = ?'); params.push(body.baseUrl);
    }
    if (body.authHeader !== undefined) { sets.push('auth_header = ?'); params.push(body.authHeader); }
    if (body.models !== undefined) { sets.push('models_json = ?'); params.push(JSON.stringify(body.models)); }
    let oldSecret: string | null = null;
    if (body.apiKey !== undefined) {
      if (r.kind === 'subscription') throw Errors.badRequest('订阅登录的账号不需要 API Key');
      const s = await this.secrets.save(body.apiKey);
      sets.push('secret_id = ?'); params.push(s.id);
      oldSecret = r.secret_id;
      this.o.audit(deviceId, 'profile.secret', `${id} ${r.name}`);
    }
    if (sets.length) {
      sets.push('updated_at = ?'); params.push(now());
      this.db.run(`UPDATE agent_profiles SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    }
    this.secrets.delete(oldSecret);
    if (body.isDefault) {
      this.db.tx(() => {
        this.db.run('UPDATE agent_profiles SET is_default = 0 WHERE agent = ? AND is_default = 1', r.agent);
        this.db.run('UPDATE agent_profiles SET is_default = 1, updated_at = ? WHERE id = ?', now(), id);
      });
    }
    if (body.configDir === 'isolated') mkdirSync(this.dirOf(id), { recursive: true });
    return this.get(id);
  }

  /** 删除：有运行中的会话时拒绝；引用它的任务改用默认账号；isolated 目录保留（避免误删会话记录） */
  delete(id: string, inUse: (id: string) => boolean, deviceId: string | null): { keptDir: string | null } {
    const r = this.row(id);
    if (r.id === localProfileId(r.agent)) throw Errors.badRequest('默认的“本机登录”账号不能删除');
    if (this.o.adapter(r.agent)?.usesNativeConfig) throw Errors.nativeConfiguration('旧测试配置已停用，清理功能尚未开放', '清理前需要保留历史任务的认证归属，避免任务自动改用其他账号；当前不会读取或使用旧密钥');
    if (inUse(id)) throw Errors.profileInUse('这个账号还有正在运行的会话', '请先停止使用这个账号的任务');
    this.db.tx(() => {
      this.db.run('UPDATE tasks SET profile_id = NULL WHERE profile_id = ?', id);
      this.db.run('DELETE FROM agent_profiles WHERE id = ?', id);
      this.db.run('DELETE FROM agent_caps WHERE profile_id = ?', id);
      if (r.is_default) this.db.run('UPDATE agent_profiles SET is_default = 1 WHERE id = ?', this.ensureLocal(r.agent).id);
    });
    this.secrets.delete(r.secret_id);
    this.o.audit(deviceId, 'profile.delete', `${id} ${r.name}`);
    return { keptDir: r.config_dir === 'isolated' ? this.dirOf(id) : null };
  }

  setTest(id: string, ok: boolean) {
    this.db.run('UPDATE agent_profiles SET last_test_at = ?, last_test_ok = ? WHERE id = ?', now(), ok ? 1 : 0, id);
  }

  setModels(id: string, models: ModelInfo[]) {
    this.db.run('UPDATE agent_profiles SET models_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(models), now(), id);
  }

  /** 给适配器的账号描述（不含密钥） */
  account(r: ProfileRow): AccountProfile {
    return {
      id: r.id, agentId: r.agent, name: r.name,
      authMethod: r.kind === 'subscription' ? 'oauth' : r.kind,
      ...(r.base_url ? { baseUrl: r.base_url } : {}),
      kind: r.kind, configDir: r.config_dir, profileDir: this.dirOf(r.id), authHeader: r.auth_header,
      models: parseModels(r.models_json),
    };
  }

  /** 启动 Agent 用的环境变量：解密密钥 → buildEnv。返回需要脱敏的原文 */
  async envFor(adapter: AgentAdapter, r: ProfileRow): Promise<{ env: Record<string, string>; redact: string[]; account: AccountProfile }> {
    const account = this.account(r);
    if (adapter.usesNativeConfig) {
      this.assertUsable(r);
      const env = adapter.buildEnv(account);
      const redact = Object.entries(buildNativeEnv(env)).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && value.length >= 4).map(([, value]) => value);
      return { env, redact, account };
    }
    const secret = r.secret_id ? await this.secrets.read(r.secret_id) : null;
    if (r.kind !== 'subscription' && !secret) throw Errors.secretUnavailable('这个账号没有保存 API Key', '请在 Agent 页给这个账号重新填写 API Key');
    const env = adapter.buildEnv(account, secret);
    return { env, redact: secret ? [secret] : [], account };
  }

  /** 只取密钥（请求 /models 用） */
  async secretOf(r: ProfileRow): Promise<string | null> {
    this.assertUsable(r);
    return r.secret_id ? this.secrets.read(r.secret_id) : null;
  }
}

function parseModels(json: string | null): ModelInfo[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.flatMap((m) => {
      if (!m || typeof m.id !== 'string') return [];
      const result = ModelInfo.safeParse({ ...m, name: m.name ?? m.id, contextWindow: m.contextWindow ?? null });
      return result.success ? [result.data] : [];
    }) : [];
  } catch { return []; }
}
