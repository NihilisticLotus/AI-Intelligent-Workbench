import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { lookup } from 'node:dns';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { isPublicMetadataAddress, metadataAddressAllowed, parseMetadataJson, readMetadataJson } from '../src/independent/metadata-http';

const servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); } });
async function fixture(handler: RequestListener) {
  const s = createServer(handler); servers.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as {port:number}).port;
  const base = new URL(`http://127.0.0.1:${port}/v1`); return { base, url: new URL(`${base}/models`) };
}
describe('受限模型元数据 HTTP', () => {
  it('只允许公网、用户明确的本地 IP 或 localhost，不扩大 DNS 私网例外', () => {
    for (const ip of ['8.8.8.8','2606:4700:4700::1111']) expect(isPublicMetadataAddress(ip)).toBe(true);
    for (const ip of ['127.0.0.1','10.1.1.1','169.254.169.254','100.64.1.1','192.0.2.1','::ffff:127.0.0.1','::1','fe80::1','fc00::1','2001:db8::1']) expect(isPublicMetadataAddress(ip)).toBe(false);
    expect(metadataAddressAllowed(new URL('https://10.1.1.1/v1'), '10.1.1.1', false)).toBe(true);
    expect(metadataAddressAllowed(new URL('https://10.1.1.1/v1'), '10.1.1.2', false)).toBe(false);
    expect(metadataAddressAllowed(new URL('https://example.com/v1'), '10.1.1.1', false)).toBe(false);
    expect(metadataAddressAllowed(new URL('http://localhost/v1'), '::1', false)).toBe(true);
    expect(metadataAddressAllowed(new URL('http://localhost/v1'), '::1', true)).toBe(false);
  });
  it.each(['identity','gzip','br'])('实际读取 %s JSON，不携带环境中的代理或 Cookie', async (encoding) => {
    let received: Record<string,unknown> = {}; const target = await fixture((req,res) => {
      received = req.headers; const raw = Buffer.from('{"data":[{"id":"m"}]}');
      res.writeHead(200, {'content-type':'application/json', 'content-encoding':encoding});
      res.end(encoding === 'gzip' ? gzipSync(raw) : encoding === 'br' ? brotliCompressSync(raw) : raw);
    });
    const previous = process.env.HTTP_PROXY; process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    try { const r = await readMetadataJson({...target,publicCatalog:false,headers:{Authorization:'Bearer fixture-key'}}); expect(r.json).toEqual({data:[{id:'m'}]}); expect(r.digest).toMatch(/^[a-f0-9]{64}$/); }
    finally { if (previous === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = previous; }
    expect(received.authorization).toBe('Bearer fixture-key'); expect(received.cookie).toBeUndefined();
  });
  it('重定向不跟随，错误正文和密钥不进入错误', async () => {
    let calls = 0; const target = await fixture((_req,res) => { calls++; res.writeHead(302, {location:'/secret'}); res.end('fixture-key'); });
    await expect(readMetadataJson({...target,publicCatalog:false,headers:{Authorization:'Bearer fixture-key'}})).rejects.toThrow('重定向已拒绝'); expect(calls).toBe(1);
  });
  it('地址、公共目录认证与固定目录路径在连接前拒绝', async () => {
    const target = await fixture((_req,res) => res.end());
    await expect(readMetadataJson({...target,url:new URL('/other/models',target.base),publicCatalog:false})).rejects.toThrow('请求目标');
    await expect(readMetadataJson({base:new URL('https://models.dev'),url:new URL('https://models.dev/experimental/v2.0/api.json?type=chat'),publicCatalog:true,headers:{Authorization:'Bearer fixture-key'}})).rejects.toThrow('公共目录不能');
    await expect(readMetadataJson({base:new URL('https://models.dev'),url:new URL('https://models.dev/api.json'),publicCatalog:true})).rejects.toThrow('请求目标');
    await expect(readMetadataJson({base:new URL('https://169.254.169.254'),url:new URL('https://169.254.169.254/models'),publicCatalog:false})).rejects.toThrow('网络规则');
  });
  it('连接时检查 DNS 的全部候选地址，禁止混合公网和私网结果', async () => {
    let lookups = 0; const resolver = ((_host:unknown,_options:unknown,cb:Function) => {lookups++; cb(null,[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]);}) as typeof lookup;
    await expect(readMetadataJson({base:new URL('https://example.com/v1'),url:new URL('https://example.com/v1/models'),publicCatalog:false,lookup:resolver})).rejects.toThrow('域名解析到受限地址'); expect(lookups).toBe(1);
  });
  it('localhost 通过被校验的 lookup 连接，不进行第二次解析', async () => {
    const target = await fixture((_req,res) => {res.writeHead(200,{'content-type':'application/json'});res.end('{}');});
    let lookups = 0; const resolver = ((_host:unknown,_options:unknown,cb:Function) => {lookups++;cb(null,[{address:'127.0.0.1',family:4}]);}) as typeof lookup;
    const base = new URL(target.base.href.replace('127.0.0.1','localhost'));
    expect((await readMetadataJson({base,url:new URL(`${base}/models`),publicCatalog:false,lookup:resolver})).json).toEqual({}); expect(lookups).toBe(1);
  });
  it.each(['plain','compressed','length','content-type','broken'])('拒绝超限或不可识别响应 %s', async (kind) => {
    const target = await fixture((_req,res) => {
      res.writeHead(200,{'content-type':kind === 'content-type' ? 'text/html' : 'application/json',...(kind === 'compressed' ? {'content-encoding':'gzip'} : {}),...(kind === 'length' ? {'content-length':'99999'} : {})});
      if(kind === 'broken') {res.write('{'); res.destroy();} else res.end(kind === 'compressed' ? gzipSync(Buffer.from(' '.repeat(2000))) : ' '.repeat(2000));
    });
    await expect(readMetadataJson({...target,publicCatalog:false,maxBytes:100})).rejects.toThrow();
  });
  it('整体超时覆盖无响应头和已开始的响应体，外部取消也结束连接', async () => {
    const target = await fixture((_req,res) => {res.writeHead(200,{'content-type':'application/json'});res.write('{');});
    await expect(readMetadataJson({...target,publicCatalog:false,timeoutMs:40})).rejects.toThrow();
    const controller = new AbortController(); const pending = readMetadataJson({...target,publicCatalog:false,signal:controller.signal}); controller.abort(); await expect(pending).rejects.toThrow('取消或超时');
  });
  it('拒绝危险键、过深 JSON 和非法 UTF-8', () => {
    expect(() => parseMetadataJson(Buffer.from('{"__proto__":{"x":1}}'))).toThrow('危险键');
    expect(() => parseMetadataJson(Buffer.from('['.repeat(26)+'0'+']'.repeat(26)))).toThrow('嵌套超过');
    expect(() => parseMetadataJson(Buffer.from('[1,2,3]'),3)).toThrow('节点超过');
    expect(() => parseMetadataJson(Buffer.from([0xff]))).toThrow();
  });
});
