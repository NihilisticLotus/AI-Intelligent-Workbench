// 仅供离线测试 git 封装的输出、取消和超时，不启动真实 Agent 或访问网络。
const mode = process.argv[2];
// 新的配置预检按真实 git 的“没有匹配项”返回，随后才验证目标命令的行为。
if (process.argv.includes('config')) process.exit(1);
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'output') process.stdout.write(Buffer.alloc(65536, 65));
else if (mode === 'stderr') process.stderr.write(Buffer.alloc(65536, 66));
else if (mode === 'fail') { process.stderr.write('不能向客户端暴露的原始错误'); process.exitCode = 7; }
else process.stdout.write(JSON.stringify(process.argv.slice(3)));
