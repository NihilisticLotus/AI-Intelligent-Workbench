// 2026-11-26 全项目审查回归测试（适配器层）：覆盖权限归一化漏口、ZCode XDG 隔离、环境变量剥离、脱敏词表与 args 更新。
import { describe, expect, it } from 'vitest';
import { normalizePermission } from '../src/acp/permissions';
import { UpdateMapper } from '../src/acp/updates';
import { buildChildEnv, buildNativeEnv } from '../src/acp/launch';
import { redact } from '../src/redact';
import { zcodeBridgeEnv } from '../src/zcode';

describe('2026-11-26 适配器审查回归', () => {
  it('ISSUE-0182：ZCode / CodeBuddy 省略 kind 时按 _meta 工具名识别为 edit，不降级为 any', () => {
    const zcode = normalizePermission({
      toolCall: {
        toolCallId: 'tc-1',
        title: 'Write: D:\\Orig\\hack.ts',
        kind: 'other',
        _meta: { claudeCode: { toolName: 'Write' } },
        rawInput: { filePath: 'D:\\Orig\\hack.ts' },
      },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    }, { agentName: 'ZCode', cwd: 'D:\\Worktree' });
    expect(zcode.request.operation?.tool).toBe('edit');
    expect(zcode.request.operation?.paths).toContain('D:\\Orig\\hack.ts');

    const nb = normalizePermission({
      toolCall: {
        toolCallId: 'tc-2',
        title: 'NotebookEdit',
        kind: 'other',
        rawInput: { notebook_path: 'C:\\Users\\Alice\\.claude\\x.ipynb', edit_mode: 'delete' },
      },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    }, { agentName: 'Claude Code', cwd: 'D:\\Worktree' });
    expect(nb.request.operation?.tool).toBe('edit');
    expect(nb.request.operation?.deletion).toBe(true);
    expect(nb.request.operation?.paths).toContain('C:\\Users\\Alice\\.claude\\x.ipynb');
  });

  it('ISSUE-0182：Antigravity PascalCase TargetFile 与跨目录 Cwd 正确纳入校验', () => {
    const edit = normalizePermission({
      toolCall: {
        toolCallId: 'tc-3',
        kind: 'edit',
        args: { TargetFile: 'D:\\Orig\\secret.txt' },
      },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    }, { agentName: 'Antigravity', cwd: 'D:\\Worktree' });
    expect(edit.request.operation?.paths).toContain('D:\\Orig\\secret.txt');

    const shell = normalizePermission({
      toolCall: {
        toolCallId: 'tc-4',
        kind: 'execute',
        args: { CommandLine: 'Remove-Item foo.txt', Cwd: 'D:\\Orig' },
      },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    }, { agentName: 'Antigravity', cwd: 'D:\\Worktree' });
    expect(shell.request.operation?.tool).toBe('shell');
    expect(shell.request.operation?.paths).toContain('D:\\Orig');
    expect(shell.request.operation?.complete).toBe(false);
  });

  it('ISSUE-0182：tool_call_update 通过 Antigravity 的 args 补传目标路径时触发 tool_update', () => {
    const events: unknown[] = [];
    const mapper = new UpdateMapper('t1', (u) => events.push(u), {
      unknown() {}, thought() {}, commands() {}, mode() {}, configOptions() {}, sessionInfo() {},
    });
    mapper.handle({ sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'edit', title: 'edit_file' });
    mapper.handle({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', args: { TargetFile: 'src/a.ts' } });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'tool_update', target: 'src/a.ts' }));
  });

  it('ISSUE-0183：zcodeBridgeEnv 显式隔离 XDG_CONFIG_HOME 防止外部 config.json 覆盖受控参数', () => {
    const env = zcodeBridgeEnv('C:\\fake\\zcode.cjs', 'build');
    expect(env.XDG_CONFIG_HOME).toMatch(/aic-zcode-xdg-empty$/);
    expect(env.ZCODE_ACP_REMOTE).toBe('0');
    expect(env.ZCODE_ACP_MODE).toBe('build');
  });

  it('ISSUE-0187：buildNativeEnv 与 buildChildEnv 剥离工作台 AIC_* 及覆盖引擎路径变量', () => {
    const base = {
      PATH: 'C:\\Windows\\System32',
      AIC_DATA_DIR: 'D:\\secret\\.aic-data',
      AIC_PORT: '17890',
      CLAUDE_CODE_EXECUTABLE: 'C:\\rogue\\claude.exe',
      CODEX_PATH: 'C:\\rogue\\codex.cmd',
      APP_SERVER_LOGS: 'C:\\tmp\\leak.log',
      ZCODE_BIN: 'C:\\rogue\\zcode.cjs',
      CUSTOM_KEEP: 'ok',
    };
    const native = buildNativeEnv({}, base);
    expect(native.AIC_DATA_DIR).toBeUndefined();
    expect(native.AIC_PORT).toBeUndefined();
    expect(native.CLAUDE_CODE_EXECUTABLE).toBeUndefined();
    expect(native.CODEX_PATH).toBeUndefined();
    expect(native.APP_SERVER_LOGS).toBeUndefined();
    expect(native.ZCODE_BIN).toBeUndefined();
    expect(native.CUSTOM_KEEP).toBe('ok');

    const child = buildChildEnv({}, base);
    expect(child.AIC_DATA_DIR).toBeUndefined();
    expect(child.AIC_PORT).toBeUndefined();
  });

  it('ISSUE-0187：redact 覆盖 Google/GitHub/AWS 密钥及工作台 Cookie 与请求头', () => {
    const sample = [
      'gemini=AIzaSyDummyExampleKey1234567890abcdef123',
      'gh=ghp_1234567890abcdef1234567890abcdef1234',
      'aws=AKIAIOSFODNN7EXAMPLE',
      'url=https://api.example.com/v1?key=secret999&a=1',
      'Cookie: aic_session_1234abcd=tok_val; x-aic-key: mykey123',
      'proto=aic-bearer.supersecrettoken',
    ].join('\n');
    const out = redact(sample);
    expect(out).not.toContain('AIzaSyDummy');
    expect(out).not.toContain('ghp_123456');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('secret999');
    expect(out).not.toContain('tok_val');
    expect(out).not.toContain('mykey123');
    expect(out).not.toContain('supersecrettoken');
  });
});
