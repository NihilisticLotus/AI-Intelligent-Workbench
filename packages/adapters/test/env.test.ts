// 账号环境变量（phase-1.md 6.4.2）：buildEnv 是纯函数，逐格对照表格；适配器不接触密钥存储，密钥由 Gateway 传入。
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildChildEnv, CODEX_KEY_ENV, createClaudeAdapter, createCodebuddyAdapter, createCodexAdapter, type AccountProfile, type AgentAdapter,
} from '../src/index';

const rt = { log: () => {} };
const claude = createClaudeAdapter(rt);
const codex = createCodexAdapter(rt);
const codebuddy = createCodebuddyAdapter({ ...rt, enginePath: null });
const DIR = path.join('D:', 'data', 'profiles', 'pf_1');
const KEY = 'sk-test-abcdefghijklmnop1234';

const prof = (agent: AgentAdapter, p: Partial<AccountProfile>): AccountProfile => ({
  id: 'pf_1', agentId: agent.id, name: '测试', authMethod: 'oauth', kind: 'subscription', configDir: 'shared', profileDir: DIR, ...p,
});

describe('订阅登录', () => {
  it('shared：三家都不注入任何变量', () => {
    for (const a of [claude, codex, codebuddy]) expect(a.buildEnv(prof(a, {}), null)).toEqual({});
  });
  it('isolated：各自的配置目录指向账号目录', () => {
    expect(claude.buildEnv(prof(claude, { configDir: 'isolated' }), null)).toEqual({ CLAUDE_CONFIG_DIR: path.join(DIR, 'claude') });
    expect(codex.buildEnv(prof(codex, { configDir: 'isolated' }), null)).toEqual({ CODEX_HOME: path.join(DIR, 'codex') });
    expect(codebuddy.buildEnv(prof(codebuddy, { configDir: 'isolated' }), null)).toEqual({ CODEBUDDY_CONFIG_DIR: path.join(DIR, 'codebuddy') });
  });
});

describe('官方 API Key', () => {
  it('Claude：ANTHROPIC_API_KEY，配置目录不变', () => {
    expect(claude.buildEnv(prof(claude, { kind: 'apiKey', authMethod: 'apiKey' }), KEY)).toEqual({ ANTHROPIC_API_KEY: KEY });
  });
  it('Codex：独立 CODEX_HOME + 会话级 provider，密钥只走环境变量', () => {
    const env = codex.buildEnv(prof(codex, { kind: 'apiKey', authMethod: 'apiKey' }), KEY);
    expect(env.CODEX_HOME).toBe(path.join(DIR, 'codex'));
    expect(env[CODEX_KEY_ENV]).toBe(KEY);
    const cfg = JSON.parse(env.CODEX_CONFIG!);
    expect(cfg).toMatchObject({ model_provider: 'aic', model_providers: { aic: { base_url: 'https://api.openai.com/v1', env_key: CODEX_KEY_ENV, wire_api: 'responses' } } });
    // 密钥不出现在 CODEX_CONFIG 里（CODEX_CONFIG 可能被 Agent 写进日志）
    expect(env.CODEX_CONFIG).not.toContain(KEY);
  });
  it('CodeBuddy：CODEBUDDY_API_KEY（实验）', () => {
    expect(codebuddy.buildEnv(prof(codebuddy, { kind: 'apiKey', authMethod: 'apiKey' }), KEY)).toMatchObject({ CODEBUDDY_API_KEY: KEY });
    expect(codebuddy.experimentalProfile?.('apiKey')).toBe(true);
    expect(claude.experimentalProfile?.('apiKey')).toBe(false);
  });
});

describe('自定义地址', () => {
  const base = { kind: 'customEndpoint' as const, authMethod: 'customEndpoint' as const, baseUrl: 'https://relay.example.com/v1', models: [{ id: 'm-1', name: 'M1', contextWindow: null }] };
  it('Claude：x-api-key → ANTHROPIC_API_KEY；bearer → ANTHROPIC_AUTH_TOKEN；手填模型 → ANTHROPIC_CUSTOM_MODEL_OPTION', () => {
    expect(claude.buildEnv(prof(claude, { ...base, authHeader: 'x-api-key' }), KEY)).toEqual({
      ANTHROPIC_BASE_URL: base.baseUrl, ANTHROPIC_API_KEY: KEY, ANTHROPIC_CUSTOM_MODEL_OPTION: 'm-1',
    });
    expect(claude.buildEnv(prof(claude, { ...base, authHeader: 'bearer' }), KEY)).toEqual({
      ANTHROPIC_BASE_URL: base.baseUrl, ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_CUSTOM_MODEL_OPTION: 'm-1',
    });
  });
  it('Codex：provider 的 base_url 换成用户填的地址，wire_api 可选', () => {
    const env = codex.buildEnv(prof(codex, { ...base, wireApi: 'chat' }), KEY);
    expect(JSON.parse(env.CODEX_CONFIG!)).toMatchObject({ model: 'm-1', model_providers: { aic: { base_url: base.baseUrl, wire_api: 'chat' } } });
    expect(env[CODEX_KEY_ENV]).toBe(KEY);
  });
  it('CodeBuddy：CODEBUDDY_BASE_URL + 密钥（实验）', () => {
    const env = codebuddy.buildEnv(prof(codebuddy, base), KEY);
    expect(env.CODEBUDDY_BASE_URL).toBe(base.baseUrl);
    expect(Object.values(env)).toContain(KEY);
  });
});

describe('与删除清单配合', () => {
  it('账号变量在删除清单之后叠加，父进程的同名变量不会混进来', () => {
    const parent = { PATH: 'p', ANTHROPIC_API_KEY: 'parent-key', CODEX_HOME: 'C:/other', CODEBUDDY_CONFIG_DIR: 'C:/x', OPENAI_API_KEY: 'o' };
    const env = buildChildEnv(claude.buildEnv(prof(claude, { kind: 'apiKey', authMethod: 'apiKey' }), KEY), parent);
    expect(env).toEqual({ PATH: 'p', ANTHROPIC_API_KEY: KEY });
  });
});
