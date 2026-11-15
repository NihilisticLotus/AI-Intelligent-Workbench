// 只供本机界面验收：合成模型协议回复，不调用外网、不读取凭据或执行文件操作。
import { createServer } from 'node:http';

// 只允许命中这两个固定验收文件；兼容 git 检出时的 CRLF，不依赖用户换行配置。
function modifyFixture() {
  const fs = require('fs');
  if (!process.cwd().includes('worktrees')) throw Error('不是验收副本');
  for (const [file, expected] of [['modify.txt', '旧内容\n'], ['delete.txt', '待删除\n']]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n') !== expected) throw Error('验收文件不匹配');
  }
  fs.writeFileSync('modify.txt', '新内容\n新增行\n'); fs.unlinkSync('delete.txt');
  console.log('已修改并删除副本验收文件');
}

const server = createServer((req, res) => {
  void (async () => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const messages = body.messages ?? [];
    const lastUser = messages.findLastIndex(m => m.role === 'user');
    const hasResult = messages.slice(lastUser + 1).some(m => m.role === 'tool');
    let message = hasResult ? { role: 'assistant', content: '离线夹具已收到工具结果，请在工作副本中核对文件。' } : {
      role: 'assistant', content: '', tool_calls: [{ id: 'offline-create', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({path:'offline-proof.txt',content:'离线副本验证',createParents:false}) } }],
    };
    if (JSON.stringify(messages[lastUser]?.content).includes('阶段 3')) {
      const step = messages.slice(lastUser + 1).filter(m => m.role === 'tool').length;
      const operations = [
        ['create_file', { path:'added.txt', content:'新增文件\n', createParents:false }],
        ['command', { program:process.execPath, args:['-e', '(' + modifyFixture.toString() + ')()'], timeoutMs:10000, maxOutputBytes:4096 }],
      ];
      const op = operations[step];
      message = op ? { role:'assistant', content:'', tool_calls:[{id:'offline-stage3-'+step,type:'function',function:{name:op[0],arguments:JSON.stringify(op[1])}}] } : {role:'assistant',content:'离线三文件操作完成，请核对新增、修改、删除与原目录。'};
    }
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({ choices:[{ index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop' }], usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15} }));
  })().catch(() => { res.writeHead(400); res.end(); });
});
server.listen(Number(process.env.AIC_FIXTURE_PORT ?? 0),'127.0.0.1',()=>console.log('离线模型夹具：http://127.0.0.1:'+server.address().port+'/v1'));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
