// HTTP 应用：中间件（Host / Origin / 令牌 / 请求体大小）+ 各组路由 + 静态网页。
// 网页也是 /api/v1 的普通客户端，这里没有任何“只给本机网页”的捷径。
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { HttpBindings } from '@hono/node-server';
import { API_BASE, ErrorCode } from '@aic/protocol';
import type { z } from 'zod';
import { KEY_HEADER_LC, type AuthService, type DeviceRow, type RequestCredentials } from '../auth';
import { AppError, Errors, toApiError, zodMessage } from '../util';
import type { Services } from '../services';
import { attachmentError } from '../attachments';
import { systemRoutes } from './system';
import { projectRoutes } from './projects';
import { taskRoutes } from './tasks';
import { agentRoutes } from './agents';
import { staticHandler } from './static';

export type Env = { Bindings: HttpBindings; Variables: { device: DeviceRow; ip: string } };
export type Ctx = Context<Env>;

/** 不需要令牌的接口（配对本身） */
const PUBLIC_API = new Set([`${API_BASE}/pairing/start`, `${API_BASE}/pairing/complete`]);
const MAX_BODY = 1024 * 1024; // 1 MB

export const ipOf = (c: Ctx) => c.env?.incoming?.socket?.remoteAddress ?? '';
/** 请求里的凭据：Bearer，或浏览器的 Cookie + 设备密钥 */
export const credsOf = (c: Ctx): RequestCredentials => ({
  cookie: c.req.header('cookie'), authorization: c.req.header('authorization'), key: c.req.header(KEY_HEADER_LC),
});

const fail = (c: Ctx, e: AppError) => c.json(e.body, e.status as 400);

/** 读取并校验 JSON 请求体 */
export async function readBody<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<z.infer<S>> {
  const ct = c.req.header('content-type') ?? '';
  if (!/^application\/json\b/i.test(ct)) throw Errors.badRequest('请求体必须是 JSON（Content-Type: application/json）');
  let raw: unknown;
  try { raw = await c.req.json(); } catch { throw Errors.badRequest('请求体不是有效的 JSON'); }
  const r = schema.safeParse(raw);
  if (!r.success) throw Errors.badRequest(zodMessage(r.error.issues));
  return r.data;
}

export function parseQuery<S extends z.ZodTypeAny>(c: Ctx, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw Errors.badRequest(zodMessage(r.error.issues));
  return r.data;
}

export function createApp(s: Services, opts: { webDist: string }) {
  const app = new Hono<Env>();
  const auth: AuthService = s.auth;

  // 1. 所有请求：安全响应头 + Host 校验（防 DNS 重绑定）
  app.use('*', async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (!auth.checkHost(c.req.header('host'))) {
      return fail(c, Errors.forbiddenHost('访问地址不正确', `请用 http://127.0.0.1:${s.port()} 打开 AI Console`));
    }
    await next();
  });

  // 2. /api/v1/*：Origin 校验（不开 CORS）→ 请求体大小 → 令牌
  app.use(`${API_BASE}/*`, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!auth.checkOrigin(c.req.header('origin'))) {
      return fail(c, Errors.forbiddenOrigin('拒绝了来自其他网页的请求', '请直接在 AI Console 页面里操作'));
    }
    const ip = ipOf(c);
    c.set('ip', ip);
    if (!PUBLIC_API.has(c.req.path)) {
      const device = auth.authenticate(credsOf(c), ip);
      if (!device) {
        return fail(c, Errors.unauthorized('还没有连接到 AI Console', '请从 AI Console 启动脚本打开，或重新生成配对码', [
          { label: '重新生成配对码', action: 'pairing.start' },
        ]));
      }
      c.set('device', device);
    }
    await next();
  });

  // 3. 请求体大小（按实际读到的字节数，不只看 Content-Length）
  app.use(`${API_BASE}/*`, async (c, next) => {
    const upload = c.req.method === 'POST' && /^\/api\/v1\/tasks\/[^/]+\/attachments$/.test(c.req.path);
    return bodyLimit({ maxSize: upload ? 20 * 1024 * 1024 : MAX_BODY,
      onError: (ctx) => fail(ctx as Ctx, upload ? attachmentError(413, ErrorCode.AttachmentTooLarge, '附件太大，最大 20 MB') : Errors.tooLarge('请求内容太大')),
    })(c, next);
  });

  app.route(API_BASE, systemRoutes(s));
  app.route(API_BASE, projectRoutes(s));
  app.route(API_BASE, taskRoutes(s));
  app.route(API_BASE, agentRoutes(s));

  // 没有匹配的 API：统一 404 ApiError；其他路径交给静态网页
  app.all(`${API_BASE}/*`, (c) => fail(c, Errors.notFound('没有这个接口')));
  app.get('*', staticHandler(opts.webDist));

  app.onError((e, c) => {
    const { status, body } = toApiError(e);
    if (status >= 500) console.error('[http] 处理请求出错', c.req.method, c.req.path, e);
    return c.json(body, status as 500);
  });
  app.notFound((c) => fail(c, Errors.notFound('没有这个地址')));
  return app;
}
