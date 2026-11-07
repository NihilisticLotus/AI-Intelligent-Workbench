// 崩溃夹具：只运行测试传入的临时命令，不加载服务、认证或真实 Agent。
import { IndependentCommandExecutor } from '../../src/independent/commands';
const [dir, script] = process.argv.slice(2);
if (!dir || !script) throw new Error('缺少测试目录或脚本');
const executor = new IndependentCommandExecutor(dir);
await executor.run({ program: process.execPath, args: ['-e', script], timeoutMs: 30_000, maxOutputBytes: 4096 }, { cwd: dir });
await executor.close();
