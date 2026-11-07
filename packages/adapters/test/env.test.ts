// 第三方软件沿用自身配置；旧的工作台认证不能再注入进程（phase-1.md 9.15）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@aic/protocol';
import {
  AgentError, buildNativeEnv, createClaudeAdapter, createCodebuddyAdapter, createCodexAdapter,
  createWorkbuddyAdapter, createZcodeAdapter, specFromOptions, type AccountProfile,
} from '../src/index';
import { codexModelEnv } from '../src/codex';
import { acpSpawn } from '../src/acp/session';
import { FIXTURE, RecordingHost, scenario } from './helpers';

const rt = { log: () => {} };
const adapters = [createClaudeAdapter(rt), createCodexAdapter(rt), createCodebuddyAdapter(rt), createWorkbuddyAdapter(rt), createZcodeAdapter()];
const key = 'sk-fake-native-boundary-1234';
afterEach(() => vi.unstubAllEnvs());

describe('第三方认证边界', () => {
  it.each(adapters)('$displayName 不提供工作台登录，也不向本机配置注入变量', (a) => {
    const p: AccountProfile = { id: 'local', agentId: a.id, name: '软件自身配置', authMethod: 'oauth', kind: 'subscription', configDir: 'shared' };
    expect(a.usesNativeConfig).toBe(true);
    expect(a.startLogin).toBeUndefined();
    expect(a.authMethods).toEqual([]);
    expect(a.buildEnv(p, null)).toEqual({});
    for (const extra of [{ kind: 'apiKey' }, { kind: 'customEndpoint', baseUrl: 'https://example.test/v1' }, { configDir: 'isolated' }]) {
      try { a.buildEnv({ ...p, ...extra } as AccountProfile); throw new Error('不应允许替换认证'); }
      catch (e) { expect(e).toBeInstanceOf(AgentError); expect((e as AgentError).body.code).toBe(ErrorCode.AgentNativeConfiguration); }
    }
    expect(() => a.buildEnv(p, key)).toThrow(AgentError);
  });

  it('保留软件自己的 API、配置目录与 provider，只清理工作台残留和宿主会话标识', () => {
    const own = { PATH: 'p', ANTHROPIC_API_KEY: key, ANTHROPIC_BASE_URL: 'https://a.example.test', CLAUDE_CONFIG_DIR: 'C:/own/claude',
      CODEX_HOME: 'C:/own/codex', CODEX_CONFIG: '{"model_provider":"own"}', OPENAI_API_KEY: key,
      CODEBUDDY_CONFIG_DIR: 'C:/own/buddy', CODEBUDDY_API_KEY: key, MODEL_PROVIDER: 'own' };
    expect(buildNativeEnv({}, { ...own, AIC_PROVIDER_KEY: 'legacy', DEFAULT_AUTH_REQUEST: 'legacy', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'host' })).toEqual(own);
  });

  it('Codex 会话换模型保留原有 provider，拒绝无效配置而不退回默认服务', () => {
    const original = { model_provider: 'own', model: 'first', model_providers: { own: { base_url: 'https://own.example.test/v1', env_key: 'OWN_API_KEY' } } };
    expect(JSON.parse(codexModelEnv('second', { CODEX_CONFIG: JSON.stringify(original) }).CODEX_CONFIG!)).toEqual({ ...original, model: 'second' });
    expect(original.model).toBe('first');
    for (const invalid of ['broken', 'null', '[]', '"text"']) expect(() => codexModelEnv('second', { CODEX_CONFIG: invalid })).toThrow();
  });

  it('实际 ACP 子进程继承软件原有设置，不调用认证接口', async () => {
    vi.stubEnv('CODEX_CONFIG', '{"model_provider":"own","model":"first"}');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://native.example.test/v1');
    const sc = scenario({ watchEnv: ['CODEX_CONFIG', 'ANTHROPIC_BASE_URL'] });
    const spec = specFromOptions({ kind: 'codex', displayName: '原生配置测试', entry: FIXTURE, usesNativeConfig: true });
    spec.launchModel = (model, env) => ({ env: codexModelEnv(model, env) });
    let conn;
    try {
      conn = await acpSpawn(spec, rt, { cwd: sc.dir, env: sc.env, model: 'second', effort: null, permission: 'ask', host: new RecordingHost(), launchModel: true });
      expect(sc.log().find((x) => x.event === 'start')?.env).toEqual({ CODEX_CONFIG: '{"model_provider":"own","model":"second"}', ANTHROPIC_BASE_URL: 'https://native.example.test/v1' });
      expect(sc.log().some((x) => x.method === 'authenticate')).toBe(false);
    } finally { await conn?.close(); sc.cleanup(); }
  });
});
