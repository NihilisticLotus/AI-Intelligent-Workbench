import { execFile } from 'node:child_process';
import path from 'node:path';

export type LanCommand = {
  kind: 'network-profile' | 'firewall-query' | 'firewall-change';
  script: string;
  timeoutMs: number;
  env?: Record<string, string>;
};

export type LanCommandResult = { status: 'ok'; stdout: string } | { status: 'cancelled' | 'failed' | 'timeout' };
export type LanExecutor = (command: LanCommand) => Promise<LanCommandResult>;

export const executeLanCommand: LanExecutor = async ({ script, timeoutMs, env }) => {
  if (process.platform !== 'win32') return { status: 'failed' };
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const ps = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const source = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    script,
  ].join('\n');
  const args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')];
  return new Promise((resolve) => {
    execFile(ps, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 }, (error, stdout) => {
      if (!error) resolve({ status: 'ok', stdout });
      else if (error.killed) resolve({ status: 'timeout' });
      else if (error.code === 23) resolve({ status: 'cancelled' });
      else resolve({ status: 'failed' });
    });
  });
};
