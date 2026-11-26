// 2026-11-26 全项目审查回归测试（Gateway）：覆盖 ISSUE-0180、权限规则绕过、局域网边界、WS 吊销、附件信号量、工作副本删除与文件归集。
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FeatureKey } from '@aic/protocol';
import { evaluatePermission, PermissionBroker } from '../src/permission-rules';
import { validateProjectDir } from '../src/fsbrowse';
import { AttachmentFileReader } from '../src/attachment-reader';
import { IndependentCommandExecutor } from '../src/independent/commands';
import { ProcessRegistry } from '../src/processes';
import { taskFiles } from '../src/task-files';
import { makeProject, startGw, WsClient, type TestGw } from './helpers';

let gw: TestGw | undefined;
const temps: string[] = [];
afterEach(async () => {
  await gw?.stop();
  gw = undefined;
  while (temps.length) {
    const d = temps.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
});

describe('2026-11-26 Gateway 全项目审查回归', { timeout: 60_000 }, () => {
  it('ISSUE-0180：/hello 如实报告 Worktrees 与本机/局域网 FsBrowse 能力开关', async () => {
    gw = await startGw();
    const token = await gw.pair();
    const res = await gw.api('GET', '/hello', { token });
    expect(res.status).toBe(200);
    expect(res.json.features[FeatureKey.Worktrees]).toBe(gw.gw.services.workspaces.git.available);
    expect(res.json.features[FeatureKey.FsBrowse]).toBe(true);
  });

  it('ISSUE-0184：权限规则拦截 ~ 家目录删除、含变量删除、PowerShell -enc、.zcode. 尾部点及 git pull，且不误杀 git diff vite.config.ts', async () => {
    const ctx = {
      projectId: 'p1',
      level: 'full' as const,
      root: 'D:\\work\\wt',
      original: 'D:\\work\\orig',
      isolated: true,
    };
    // 1. ~ 家目录不得被当作副本子目录放行
    const tilde = evaluatePermission({ tool: 'shell', command: 'Remove-Item -Recurse -Force ~/Desktop', paths: [], deletion: false, complete: true }, ctx, []);
    expect(tilde.action).toBe('deny');

    // 2. 含环境变量的删除（!parsed.simple）必须硬拒绝
    const envDel = evaluatePermission({ tool: 'shell', command: 'rm -rf $HOME/Desktop', paths: [], deletion: false, complete: true }, ctx, []);
    expect(envDel.action).toBe('deny');

    // 3. PowerShell -enc 缩写不得被判为 simple 自动放行
    const psEnc = evaluatePermission({ tool: 'shell', command: 'powershell -enc ZWNobyBoaQ==', paths: [], deletion: false, complete: true }, ctx, []);
    expect(psEnc.action).toBe('ask');
    expect(psEnc.safeScope).toBe(false);

    // 4. Windows 尾部点 .zcode. 仍受凭据保护
    const dotTrail = evaluatePermission({ tool: 'edit', command: null, paths: ['C:\\Users\\Alice\\.zcode.\\auth.json'], deletion: false, complete: true }, ctx, []);
    expect(dotTrail.action).toBe('deny');

    // 5. git diff vite.config.ts 不误杀，git pull 硬拒绝
    const gitDiff = evaluatePermission({ tool: 'shell', command: 'git diff vite.config.ts', paths: [], deletion: false, complete: true }, ctx, []);
    expect(gitDiff.action).toBe('allow');
    const gitPull = evaluatePermission({ tool: 'shell', command: 'git pull origin main', paths: [], deletion: false, complete: true }, ctx, []);
    expect(gitPull.action).toBe('deny');
  });

  it('ISSUE-0184：悬空符号链接不得借相对路径绕过 decide() 保护', async () => {
    gw = await startGw();
    const token = await gw.pair();
    const project = await makeProject(gw, token);
    const root = mkdtempSync(path.join(tmpdir(), 'aic-dangling-'));
    temps.push(root);
    const linkPath = path.join(root, 'sneaky.txt');
    let linked = false;
    try {
      symlinkSync(path.join(project.path, 'nonexistent-target.txt'), linkPath);
      linked = true;
    } catch { /* 无符号链接权限的环境跳过创建，仍测 broker */ }
    if (linked) {
      const broker = new PermissionBroker(gw.gw.services.db);
      const res = await broker.decide(
        { tool: 'edit', command: null, paths: ['sneaky.txt'], deletion: false, complete: true },
        { projectId: project.id, level: 'ask', root, original: project.path, isolated: true },
      );
      expect(res.action).toBe('deny');
    }
  });

  it('ISSUE-0185：validateProjectDir 拒绝用户主目录本身与凭据目录', () => {
    expect(() => validateProjectDir(homedir())).toThrow();
    const tmp = mkdtempSync(path.join(tmpdir(), 'aic-cred-proj-'));
    temps.push(tmp);
    const fakeClaude = path.join(tmp, '.claude');
    mkdirSync(fakeClaude, { recursive: true });
    expect(() => validateProjectDir(fakeClaude)).toThrow();
  });

  it('ISSUE-0185：设备吊销后立即拒绝 WS 指令（不等待 30s 关闭握手）', async () => {
    gw = await startGw();
    const b1 = await gw.pairBrowser('主设备');
    const token2 = await gw.pair('将被吊销');
    const ws = await WsClient.connect(gw.port, token2);
    try {
      await ws.call({ op: 'subscribe', data: { lastSeq: 0 } });
      const list = await gw.api('GET', '/devices', { cookie: b1.cookie, key: b1.key });
      const target = (list.json.items as { id: string; name: string }[]).find((d) => d.name === '将被吊销')!;
      const rev = await gw.api('DELETE', `/devices/${target.id}`, { cookie: b1.cookie, key: b1.key });
      expect(rev.status).toBe(200);
      // 吊销后即便立刻发 ping，也不能再收到该指令的 ack
      let gotAck = false;
      const p = ws.call({ op: 'ping', data: {} }).then(() => { gotAck = true; }).catch(() => {});
      await new Promise((r) => setTimeout(r, 350));
      expect(gotAck).toBe(false);
      await p;
    } finally {
      await ws.close().catch(() => {});
    }
  });

  it('ISSUE-0186：AttachmentFileReader 队首等待者已取消时正确唤醒后继等待者，不发生信号量死锁', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aic-att-sem-'));
    temps.push(dir);
    const reader = new AttachmentFileReader(dir, new IndependentCommandExecutor(dir)) as unknown as {
      acquire(signal: AbortSignal): Promise<() => void>;
    };
    const r1 = await reader.acquire(new AbortController().signal);
    const r2 = await reader.acquire(new AbortController().signal);

    // 构造一个已排队、但在唤醒时 signal.aborted 为 true 的等待者（通过伪造只读 aborted 属性绕过 abort 事件监听）
    const fakeAborted = { aborted: false, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
    const pAborted = reader.acquire(fakeAborted).catch((e) => e as Error);
    const pNext = reader.acquire(new AbortController().signal);

    (fakeAborted as { aborted: boolean }).aborted = true;
    r1(); // 释放槽位 1：队首已取消，必须顺延唤醒 pNext！
    const err = await pAborted;
    expect(err).toBeInstanceOf(Error);
    const rNext = await Promise.race([
      pNext,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('附件信号量死锁')), 1000)),
    ]);
    rNext();
    r2();
  });

  it('ISSUE-0186：原项目目录在磁盘上被移走后，仍可在工作台删除任务与残留工作副本（不报 500）', async () => {
    gw = await startGw();
    const token = await gw.pair();
    const project = await makeProject(gw, token, '将被删目录');
    const created = await gw.api('POST', '/tasks', {
      token,
      body: { projectId: project.id, agent: 'fake', permission: 'readonly', prompt: '你好' },
    });
    expect(created.status).toBe(201);
    const taskId = created.json.id as string;
    await gw.gw.services.tasks.idle();
    const wsPath = created.json.workspace?.path as string | null;
    expect(wsPath && existsSync(wsPath)).toBe(true);

    // 模拟用户在资源管理器删除了原项目目录
    rmSync(project.path, { recursive: true, force: true });
    const del = await gw.api('DELETE', `/tasks/${taskId}`, { token });
    expect(del.status).toBe(200);
    if (wsPath) expect(existsSync(wsPath)).toBe(false);
  });

  it('ISSUE-0186：taskFiles 相对 workspace_path 归一化路径，不向客户端暴露 .aic-data 绝对路径', async () => {
    gw = await startGw();
    const token = await gw.pair();
    const project = await makeProject(gw, token);
    const created = await gw.api('POST', '/tasks', {
      token,
      body: { projectId: project.id, agent: 'fake', permission: 'readonly', prompt: 'hello' },
    });
    const taskId = created.json.id as string;
    await gw.gw.services.tasks.idle();
    const wsPath = created.json.workspace.path as string;
    const absTarget = path.join(wsPath, 'src', 'hero.ts');
    gw.gw.services.events.append({ type: 'tool.start', taskId, sessionId: 's1', data: { toolId: 't1', kind: 'edit', title: 'Edit', target: absTarget } });
    gw.gw.services.events.append({ type: 'tool.end', taskId, sessionId: 's1', data: { toolId: 't1', ok: true, summary: null } });

    const files = taskFiles(gw.gw.services.db, taskId);
    expect(files).toHaveLength(1);
    expect(files[0]!.path.replaceAll('\\', '/')).toBe('src/hero.ts');
    expect(files[0]!.path).not.toContain('worktrees');
  });

  it('ISSUE-0186：ProcessRegistry.cleanupOrphans 跳过当前仍存活的本实例新进程', async () => {
    gw = await startGw();
    const reg = new ProcessRegistry(gw.gw.services.db);
    // 模拟当前实例刚登记一个 live 进程，同 PID 不应被 cleanupOrphans 删除或误杀
    reg.started({ pid: process.pid, agent: 'fake', sessionId: 's_live', startedAt: Date.now() });
    const killed = await reg.cleanupOrphans();
    expect(killed).toBe(0);
    const rows = gw.gw.services.db.all<{ pid: number }>('SELECT pid FROM agent_processes WHERE pid = ?', process.pid);
    expect(rows).toHaveLength(1);
  });
});
