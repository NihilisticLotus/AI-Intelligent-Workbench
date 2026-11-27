// 握手、配对、设备
import { Hono } from 'hono';
import {
  WorkspaceRetention, FeatureKey, PairingCompleteBody, PROTOCOL_VERSION, HandoffSettings,
  LanPairingDecision, LanPairingRequestId, PROVENANCE_TIERS, SecurityStatus,
  type Hello, type PairingCompleteResult, type RevokeLanResult,
} from '@aic/protocol';
import { TOKEN_IDLE_TTL_MS } from '../auth';
import type { Services } from '../services';
import type { Env } from './app';
import { credsOf, isLocalRequest, readBody } from './app';
import { Errors, toApiError } from '../util';
import { auditAccess, confirmRemote, requireLocal } from './access-guard';

export function systemRoutes(s: Services) {
  const r = new Hono<Env>();
  r.get('/settings/handoff/usage',c=>c.json(s.tasks.handoffs!.summaryLedger.summaryUsage()));
  r.get('/settings/handoff',c=>c.json(s.tasks.handoffs!.settings()));
  r.put('/settings/handoff',async c=>{requireLocal(c,'请在这台电脑上修改交接设置');return c.json(s.tasks.handoffs!.settings(await readBody(c,HandoffSettings)));});
  r.get('/settings/workspaces',c=>c.json(s.workspaces.retention()));
  r.put('/settings/workspaces',async c=>{requireLocal(c,'请在这台电脑上修改工作副本保留设置');return c.json(s.workspaces.setRetention(await readBody(c,WorkspaceRetention)));});
  r.get('/security/status', (c) => {
    const row = s.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM secrets');
    const dpapiActive = s.secrets.store.scheme === 'dpapi-user-v1' && s.secrets.store.available;
    const status = SecurityStatus.parse({
      provenanceFence: {
        active: true,
        tiers: [...PROVENANCE_TIERS],
      },
      subprocessEnvIsolation: {
        active: true,
      },
      egressGuard: {
        active: true,
        allowFakeIpProxy: s.independent.getNetwork().allowFakeIpProxy,
        blockedLocalPortsCount: s.port() > 0 ? 1 : 0,
      },
      secretStorage: {
        mode: dpapiActive ? 'dpapi' : 'unavailable',
        encryptedCount: Number(row?.count ?? 0),
      },
      lanBoundary: {
        lanEnabled: s.lan.activeAddress() !== null,
        currentConnection: c.get('lanConnection') ? 'lan' : 'local',
        localOnlyWriteGuard: true,
      },
      markdownSafety: {
        blockRemoteImages: true,
        blockNonHttpLinks: true,
      },
    });
    return c.json(status);
  });

  r.get('/hello', (c) => {
    const d = c.get('device');
    const body: Hello = {
      server: 'ai-console-gateway',
      version: s.version,
      protocol: PROTOCOL_VERSION,
      features: {
        [FeatureKey.TaskUsage]: true,
        [FeatureKey.FakeAgent]: true,
        [FeatureKey.RealAgents]: s.agents.all().some((a) => a.real),
        [FeatureKey.Profiles]: true,
        [FeatureKey.Approvals]: true,
        [FeatureKey.Groups]: true,
        [FeatureKey.FsBrowse]: isLocalRequest(c),
        [FeatureKey.Worktrees]: s.workspaces.git.available,
        [FeatureKey.Handoff]: true,
        [FeatureKey.TaskMemory]: true,
        [FeatureKey.Lan]: true,
        [FeatureKey.SideChat]: false,
        [FeatureKey.AgentToggle]: true,
        [FeatureKey.Drafts]: true,
        [FeatureKey.IndependentCatalog]: true,
        [FeatureKey.IndependentDiscovery]: true,
        [FeatureKey.IndependentRuntime]: true,
        [FeatureKey.PageAssets]: false,
        [FeatureKey.PageGenerate]: false,
        [FeatureKey.PageAutomations]: false,
        [FeatureKey.PageMonitor]: true,
        [FeatureKey.PageCapabilities]: false,
      },
      machine: s.machine,
      device: { id: d.id, name: d.name, kind: d.kind, source: d.pairing_source },
      lastSeq: s.events.lastSeq(),
      bootId: s.bootId,
      lastExit: s.lastExit,
      lanConnection: c.get('lanConnection'),
    };
    return c.json(body);
  });

  // 重新生成配对码：只允许本机请求；配对码只打印在终端窗口里，不经网络返回
  r.post('/pairing/start', async (c) => {
    if (!isLocalRequest(c)) throw Errors.forbidden('只能在这台电脑上重新生成配对码');
    return c.json(await auditAccess(c, s, 'pairing.start', undefined, () => s.auth.requestPairingCode(c.get('ip'))));
  });

  r.post('/pairing/local-code', async (c) => {
    if (!isLocalRequest(c)) throw Errors.forbidden('只能在这台电脑上查看新的配对码');
    return c.json(await auditAccess(c, s, 'pairing.issue', undefined, () => s.lanPairing.issue()));
  });

  r.post('/pairing/complete', (c) => s.lanPairing.attempts.run(c.get('ip'), c.get('lanConnection') ? 'lan' : 'local', async () => {
    const body = await readBody(c, PairingCompleteBody);
    // 同一个客户端带着仍然有效的凭据重新配对：新设备建好后吊销旧的（轮换），不让旧令牌闲置着继续有效
    const previous = s.auth.authenticate(credsOf(c), c.get('ip'));
    if (c.get('lanConnection')) {
      const request = s.lanPairing.submit(c.get('ip'), c.req.header('user-agent') ?? '', body,
        previous?.pairing_source === 'lan' ? previous.id : null);
      return c.json(request, 202);
    }
    if (!isLocalRequest(c) || previous?.pairing_source === 'lan') throw Errors.forbidden('请从本机浏览器重新配对');
    const { device, token, key } = s.auth.completePairing(c.get('ip'), body, previous?.id ?? null);
    s.accessAudit.write('pairing.local', { id: device.id, ip: c.get('ip') }, 'ok', device.id);
    const out: PairingCompleteResult = { device };
    if (body.tokenDelivery === 'cookie') {
      // Cookie 单独不够：设备密钥只在这里返回一次，网页存进按源隔离的本地存储，之后放在 X-AIC-Key 头里
      c.header('Set-Cookie', s.auth.sessionCookie(token, Math.floor(TOKEN_IDLE_TTL_MS / 1000)));
      out.key = key;
    } else {
      out.token = token; // 桌面 / 手机应用自己保存到安全存储，以后用 Authorization: Bearer
    }
    return c.json(out);
  }).catch((error: unknown) => {
    if (isLocalRequest(c)) {
      s.accessAudit.write('pairing.local', { id: null, ip: c.get('ip') }, toApiError(error).status === 403 ? 'denied' : 'failed');
    }
    throw error;
  }));

  r.get('/pairing/requests/:id', (c) => {
    // 路由器默认将 HEAD 分派到 GET。只读响应头不能消耗一次性的浏览器凭据。
    if (c.req.method === 'HEAD') return c.body(null, 405, { Allow: 'GET' });
    if (!c.get('lanConnection')) throw Errors.forbidden('请在发起配对的设备上查看请求');
    const id = LanPairingRequestId.safeParse(c.req.param('id'));
    if (!id.success) throw Errors.notFound('找不到这条配对请求');
    const { body, token } = s.lanPairing.status(id.data, c.get('ip'));
    if (token) c.header('Set-Cookie', s.auth.sessionCookie(token, Math.floor(TOKEN_IDLE_TTL_MS / 1000)));
    return c.json(body);
  });

  r.post('/pairing/requests/:id/decision', async (c) => {
    if (!isLocalRequest(c)) throw Errors.forbidden('只能在这台电脑上确认配对');
    const id = LanPairingRequestId.safeParse(c.req.param('id'));
    if (!id.success) throw Errors.notFound('找不到这条配对请求');
    const { allow } = await readBody(c, LanPairingDecision);
    s.lanPairing.decide(id.data, allow);
    return c.json({ ok: true });
  });

  r.get('/devices', (c) => c.json({ items: s.auth.listDevices(c.get('device').id), nextCursor: null }));

  r.delete('/devices/lan', async (c) => {
    if (!isLocalRequest(c)) throw Errors.forbidden('只能在这台电脑上吊销全部局域网设备');
    const revoked = await auditAccess(c, s, 'device.revoke_lan', undefined, () => {
      const count = s.auth.revokeLanDevices(c.get('device').id);
      s.lanPairing.invalidateAll();
      return count;
    });
    const result: RevokeLanResult = { revoked };
    return c.json(result);
  });

  r.delete('/devices/:id', async (c) => {
    const id = c.req.param('id');
    await confirmRemote(c, s, 'device.revoke', id);
    await auditAccess(c, s, 'device.revoke', id, () => s.auth.revoke(id, c.get('device').id));
    // 吊销的是自己：顺手清掉 Cookie
    if (id === c.get('device').id) c.header('Set-Cookie', s.auth.sessionCookie('', 0));
    return c.json({ ok: true });
  });

  return r;
}
