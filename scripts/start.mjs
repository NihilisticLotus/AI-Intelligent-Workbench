// “启动 AI Console.bat” 调用的启动器：首次安装依赖 → 网页需要时构建 → 启动 Gateway（由它打开浏览器）。
// 放在 Node 里做，而不是写在 .bat 里：cmd 在 UTF-8 代码页下调用 npm.cmd 之后会读错批处理文件的位置，导致中文行被截断。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.title = 'AI Console - 关闭这个窗口会停止 AI Console';
const say = (s = '') => console.log(s ? `  ${s}` : '');

/** 递归取最新的修改时间（跳过 node_modules / dist） */
function newest(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let t = st.mtimeMs;
  for (const name of readdirSync(p)) {
    if (name === 'node_modules' || name === 'dist') continue;
    t = Math.max(t, newest(path.join(p, name)));
  }
  return t;
}

/** apps/web/dist 不存在或比源码旧时需要构建 */
export function webNeedsBuild() {
  const distIndex = path.join(root, 'apps', 'web', 'dist', 'index.html');
  if (!existsSync(distIndex)) return true;
  const built = statSync(distIndex).mtimeMs;
  const sources = [
    path.join(root, 'apps', 'web', 'src'),
    path.join(root, 'apps', 'web', 'index.html'),
    path.join(root, 'apps', 'web', 'vite.config.ts'),
    path.join(root, 'apps', 'web', 'package.json'),
    path.join(root, 'packages', 'protocol', 'src'),
  ];
  return Math.max(...sources.map(newest)) > built;
}

/** 运行 npm 命令（npm 在 Windows 上是 .cmd，需要经过 shell；参数都是固定字面量，没有外部输入） */
function npm(args) {
  const r = spawnSync(`npm ${args.join(' ')}`, { cwd: root, stdio: 'inherit', shell: true });
  return r.status === 0;
}

function fail(msg) {
  say();
  say(msg);
  process.exit(1);
}

say('==============================================');
say('  AI Console 正在启动');
say('  关闭这个窗口会停止 AI Console');
say('==============================================');
say();

if (!existsSync(path.join(root, 'node_modules', '.package-lock.json'))) {
  say('第一次运行，正在安装依赖，大约需要一两分钟……');
  if (!npm(['install', '--no-fund', '--no-audit'])) fail('安装依赖失败。请检查网络连接后，重新双击“启动 AI Console”。');
  say();
}

if (webNeedsBuild()) {
  say('正在准备网页界面……');
  if (!npm(['run', 'build'])) fail('网页界面构建失败，请把上面的信息发给开发同事。');
  say();
}

say('正在启动服务，浏览器会自动打开。');
say('使用期间请保持这个窗口开着，关闭这个窗口会停止 AI Console。');
say();

const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const server = path.join(root, 'packages', 'gateway', 'src', 'server.ts');
// 正式启动不带任何开发用变量：即使用户或系统环境里设置了它们，也不会传给 Gateway
const env = { ...process.env };
for (const k of Object.keys(env)) {
  if (/^AIC_DEV/i.test(k)) delete env[k];
}
const child = spawn(process.execPath, [tsx, '--disable-warning=ExperimentalWarning', server], { cwd: root, stdio: 'inherit', env });
// Ctrl+C、关闭窗口（Windows 上是 SIGHUP）时子进程会一起收到信号并自己收尾，这里只等它退出
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});
child.on('exit', (code) => {
  say();
  if (code === 3) {
    say('已经有一个 AI Console 在运行，已为你打开浏览器。这个窗口可以关闭。');
    process.exit(0);
  }
  say(code === 0 ? 'AI Console 已停止。' : 'AI Console 意外停止了，请查看上面的信息。');
  process.exit(code ?? 1);
});
