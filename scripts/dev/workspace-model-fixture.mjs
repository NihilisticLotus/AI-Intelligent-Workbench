// 只供本机界面验收：合成模型协议回复，不调用外网、不读取凭据或执行文件操作。
import { createServer } from 'node:http';
const server = createServer((req, res) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = body.messages ?? [];
    const lastUser = messages.findLastIndex(m => m.role === 'user');
    const hasResult = messages.slice(lastUser + 1).some(m => m.role === 'tool');
    const message = hasResult ? { role: 'assistant', content: '离线夹具已收到工具结果，请在工作副本中核对文件。' } : {
      role: 'assistant', content: '', tool_calls: [{ id: 'offline-create', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({path:'offline-proof.txt',content:'离线副本验证',createParents:false}) } }],
    };
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices:[{ index:0,message,finish_reason:hasResult?'stop':'tool_calls' }], usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15} }));
  })().catch(() => { res.writeHead(400); res.end(); });
});
server.listen(0,'127.0.0.1',()=>console.log('离线模型夹具：http://127.0.0.1:'+server.address().port+'/v1'));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
