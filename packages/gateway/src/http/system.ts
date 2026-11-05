// 握手、配对、设备
import { Hono } from 'hono';
import { FeatureKey, PairingCompleteBody, PROTOCOL_VERSION, type Hello, type PairingCompleteResult } from '@aic/protocol';
import { TOKEN_IDLE_TTL_MS } from '../auth';
import type { Services } from '../services';
import type { Env } from './app';
import { credsOf, readBody } from './app';

export function systemRoutes(s: Services) {
  const r = new Hono<Env>();

  r.get('/hello', (c) => {
    const d = c.get('device');
    const body: Hello = {
      server: 'ai-console-gateway',
      version: s.version,
      protocol: PROTOCOL_VERSION,
      features: {
        [FeatureKey.FakeAgent]: true,
        [FeatureKey.RealAgents]: false,
        [FeatureKey.Approvals]: true,
        [FeatureKey.Groups]: true,
        [FeatureKey.FsBrowse]: true,
        [FeatureKey.Worktrees]: false,
        [FeatureKey.Handoff]: false,
        [FeatureKey.Lan]: false,
        [FeatureKey.PageAssets]: false,
        [FeatureKey.PageGenerate]: false,
        [FeatureKey.PageAutomations]: false,
        [FeatureKey.PageMonitor]: false,
        [FeatureKey.PageCapabilities]: false,
      },
      machine: s.machine,
      device: { id: d.id, name: d.name, kind: d.kind },
      lastSeq: s.events.lastSeq(),
      bootId: s.bootId,
    };
    return c.json(body);
  });

  // 重新生成配对码：只允许本机请求；配对码只打印在终端窗口里，不经网络返回
  r.post('/pairing/start', (c) => c.json(s.auth.requestPairingCode(c.get('ip'))));

  r.post('/pairing/complete', async (c) => {
    const body = await readBody(c, PairingCompleteBody);
    // 同一个客户端带着仍然有效的凭据重新配对：新设备建好后吊销旧的（轮换），不让旧令牌闲置着继续有效
    const previous = s.auth.authenticate(credsOf(c), c.get('ip'));
    const { device, token, key } = s.auth.completePairing(c.get('ip'), body, previous?.id ?? null);
    const out: PairingCompleteResult = { device };
    if (body.tokenDelivery === 'cookie') {
      // Cookie 单独不够：设备密钥只在这里返回一次，网页存进按源隔离的本地存储，之后放在 X-AIC-Key 头里
      c.header('Set-Cookie', s.auth.sessionCookie(token, Math.floor(TOKEN_IDLE_TTL_MS / 1000)));
      out.key = key;
    } else {
      out.token = token; // 桌面 / 手机应用自己保存到安全存储，以后用 Authorization: Bearer
    }
    return c.json(out);
  });

  r.get('/devices', (c) => c.json({ items: s.auth.listDevices(c.get('device').id), nextCursor: null }));

  r.delete('/devices/:id', (c) => {
    const id = c.req.param('id');
    s.auth.revoke(id, c.get('device').id);
    // 吊销的是自己：顺手清掉 Cookie
    if (id === c.get('device').id) c.header('Set-Cookie', s.auth.sessionCookie('', 0));
    return c.json({ ok: true });
  });

  return r;
}
