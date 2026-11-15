// git 子进程只接收参数数组；输出不写日志，不把命令参数和原始错误发给客户端。
import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { killTree } from '@aic/adapters';

export class GitError extends Error {
  constructor(readonly kind: 'unavailable' | 'failed' | 'timeout' | 'cancelled' | 'output_limit', readonly command: string, readonly exitCode: number | null = null) {
    super(kind === 'unavailable' ? '没有找到 git，请安装 git 后重试。' : `git ${command} ${({ failed: '执行失败', timeout: '执行超时', cancelled: '已取消', output_limit: '输出超过限制' } as const)[kind]}（退出码 ${exitCode ?? '未知'}）`);
  }
}

export class Git {
  version: string | null = null;
  constructor(readonly executable: string | null, private readonly environment: NodeJS.ProcessEnv = process.env, private readonly prefixArgs: string[] = []) {}
  get available() { return this.executable !== null; }

  static async discover(environment: NodeJS.ProcessEnv = process.env): Promise<Git> {
    const searchPath = Object.entries(environment).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
    for (const entry of searchPath.split(path.delimiter).filter(Boolean)) {
      // 不从当前目录或相对 PATH 项启动可执行文件。
      const dir = entry.replace(/^"|"$/g, '');
      if (!path.isAbsolute(dir)) continue;
      const file = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git');
      try {
        await access(file);
        const git = new Git(await realpath(file), environment);
        const result = await git.run(['--version'], { cwd: dir, timeoutMs: 5000, maxOutput: 1024 });
        if (result.code !== 0 || !/^git version [\d.]+/.test(result.stdout.toString())) continue;
        git.version = result.stdout.toString().trim();
        return git;
      } catch { /* 继续查找 PATH 中的下一个候选 */ }
    }
    return new Git(null, environment);
  }

  async run(args: string[], options: {
    cwd: string; gitDir?: string | null; workTree?: string; timeoutMs?: number; signal?: AbortSignal;
    maxOutput?: number; input?: string | Buffer; env?: NodeJS.ProcessEnv;
  }): Promise<{ stdout: Buffer; code: number }> {
    // 错误只包含固定命令种类，不包含路径、提交说明或 git 原始 stderr。
    const commands = new Set(['worktree','rev-parse','symbolic-ref','ls-files','ls-tree','diff','status','init','add','read-tree','write-tree','commit-tree','update-ref','cat-file','branch','config','hash-object']);
    const command = args.find(a => commands.has(a)) ?? 'command';
    if (!this.executable) throw new GitError('unavailable', command);
    if (options.signal?.aborted) throw new GitError('cancelled', command);
    const env: NodeJS.ProcessEnv = {};
    // 不继承外部仓库 / 索引重定向，配置仍由 git 按用户自身设置读取。
    for (const [k,v] of Object.entries(this.environment)) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v;
    // 测试注入的全局配置隔离及提交身份不影响生产环境，也不改磁盘配置。
    for (const k of ['GIT_CONFIG_GLOBAL','GIT_CONFIG_NOSYSTEM','GIT_AUTHOR_NAME','GIT_AUTHOR_EMAIL','GIT_COMMITTER_NAME','GIT_COMMITTER_EMAIL']) {
      if (this.environment[k] !== undefined) env[k] = this.environment[k];
    }
    Object.assign(env, options.env, { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_LFS_SKIP_SMUDGE: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
    const fullArgs = ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false'];
    if (options.gitDir) fullArgs.push(`--git-dir=${options.gitDir}`);
    if (options.workTree) fullArgs.push(`--work-tree=${options.workTree}`);
    fullArgs.push(...args);
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable!, [...this.prefixArgs, ...fullArgs], { cwd: options.cwd, env, shell: false, windowsHide: true, stdio: 'pipe' });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let reason: GitError | null = null;
      let termination: Promise<void> | undefined;
      const stop = (kind: GitError['kind']) => {
        if (reason) return;
        reason = new GitError(kind, command);
        if (child.pid) termination = killTree(child.pid);
      };
      const cancel = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), options.timeoutMs ?? 30_000);
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.signal?.aborted) cancel();
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxOutput ?? 8 * 1024 * 1024)) stop('output_limit');
        else if (!reason) chunks.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > (options.maxOutput ?? 8 * 1024 * 1024)) stop('output_limit');
      });
      // 取消时 stdin 可能被提前关闭；异常必须留在当前命令内。
      child.stdin.on('error', () => {});
      child.stdout.on('error', () => stop('failed'));
      child.stderr.on('error', () => stop('failed'));
      child.on('error', () => { reason ??= new GitError('failed', command); });
      child.on('close', async (code) => {
        clearTimeout(timer); options.signal?.removeEventListener('abort', cancel);
        await termination;
        if (reason) reject(reason);
        else resolve({ stdout: Buffer.concat(chunks), code: code ?? -1 });
      });
      child.stdin.end(options.input);
    });
  }

  async checked(args: string[], options: Parameters<Git['run']>[1]): Promise<Buffer> {
    const result = await this.run(args, options);
    if (result.code !== 0) throw new GitError('failed', /^[a-z-]+$/.test(args[0] ?? '') ? args[0]! : 'command', result.code);
    return result.stdout;
  }
}
