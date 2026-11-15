// 显式模型必须在 prompt 前生效；只启动本机假 ACP，默认测试不调用真实 Agent。
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentConnection } from '../src/index';
import { fakeAdapter, MODELS, RecordingHost, scenario, type Scenario } from './helpers';

const scenarios: Scenario[] = [], connections: AgentConnection[] = [];
afterEach(async () => { for (const c of connections.splice(0)) await c.close(); for (const s of scenarios.splice(0)) s.cleanup(); });
const make = (extra: Record<string, unknown> = {}) => { const s = scenario({ config: { models: MODELS, currentModel: 'alpha' }, ...extra }); scenarios.push(s); return s; };
async function send(s: Scenario, model: string | null, effort: string | null = null, resume = false) {
  const host = new RecordingHost();
  const conn = await fakeAdapter(s).spawn({ cwd: s.dir, model, effort, permission: 'ask', host, ...(resume ? { resume: { agentSessionId: 'existing' } } : {}) });
  connections.push(conn); conn.ready?.();
  await conn.prompt({ text: '只用于验证是否发给了正确模型' }, new AbortController().signal);
  return { conn, host };
}
const prompts = (s: Scenario) => s.log().filter(e => e.method === 'session/prompt');

describe('显式模型启动保护', () => {
  it.each([false, true])('模型目录失效时停止，不发送消息（恢复=%s）', async resume => {
    const s = make();
    await expect(send(s, 'expired-model', null, resume)).rejects.toMatchObject({ body: { message: '假 Agent 没能使用任务指定的模型，已停止' } });
    expect(prompts(s)).toHaveLength(0);
  });
  it('模型设置失败时不回退默认值发送消息', async () => {
    const s = make({ setErrors: { 'model:beta': { code: -32602, message: '模型设置被拒绝' } } });
    await expect(send(s, 'beta')).rejects.toMatchObject({ body: { code: 'agent.unavailable' } });
    expect(prompts(s)).toHaveLength(0);
    expect(s.log().some(e => e.method === 'session/set_config_option' && e.params.value === 'beta')).toBe(true);
  });
  it('设置返回成功但实际模型未改变时不发送消息', async () => {
    const s = make({ stickyModel: true });
    await expect(send(s, 'beta')).rejects.toMatchObject({ body: { code: 'agent.unavailable' } });
    expect(prompts(s)).toHaveLength(0);
  });
  it('明确选择原生默认时保留默认模型并正常发送', async () => {
    const s = make(), { conn } = await send(s, null);
    expect(conn.config?.().model).toBe('alpha'); expect(prompts(s)).toHaveLength(1);
  });
  it('模型设置成功后只发送一次，保留指定模型', async () => {
    const s = make(), { conn } = await send(s, 'beta');
    expect(conn.config?.().model).toBe('beta'); expect(prompts(s)).toHaveLength(1);
  });
  it('思考强度单独失败不改变已生效模型，仍明确提示', async () => {
    const s = make({ config: { models: MODELS, currentModel: 'alpha', efforts: ['low', 'high'], currentEffort: 'low' }, setErrors: { 'effort:high': { code: -32602, message: '强度设置被拒绝' } } });
    const { conn, host } = await send(s, 'beta', 'high');
    expect(conn.config?.().model).toBe('beta'); expect(prompts(s)).toHaveLength(1);
    expect(host.of('notice').some(e => e.text.includes('没能恢复原来的思考强度'))).toBe(true);
  });
});
