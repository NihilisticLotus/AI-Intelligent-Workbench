import { createHash } from 'node:crypto';
import path from 'node:path';
import type { LanFirewallState } from '@aic/protocol';
import { Errors } from '../util';
import type { LanExecutor } from './windows-executor';

export interface FirewallTarget {
  address: string;
  port: number;
  program: string;
}

interface FirewallRule {
  address?: string;
  remoteAddress?: string;
  port?: string;
  program?: string;
  profiles?: number;
  protocol?: number;
  direction?: number;
  action?: number;
  enabled?: boolean;
  edge?: boolean;
}

export function firewallRuleName(dataDir: string): string {
  const instance = process.platform === 'win32' ? dataDir.toLowerCase() : dataDir;
  const hash = createHash('sha256').update(instance).digest('hex').slice(0, 16);
  return `AI Console LAN ${hash}`;
}

const normalizeProgram = (value: string) => path.win32.normalize(value).toLowerCase();

export function firewallRuleMatches(rule: FirewallRule, target: FirewallTarget): boolean {
  return rule.enabled === true && rule.profiles === 2 && rule.protocol === 6 && rule.direction === 1 && rule.action === 1 &&
    rule.edge === false && typeof rule.remoteAddress === 'string' && rule.remoteAddress.toLowerCase() === 'localsubnet' &&
    [target.address, `${target.address}/32`, `${target.address}/255.255.255.255`].includes(rule.address ?? '') &&
    rule.port === String(target.port) && typeof rule.program === 'string' &&
    normalizeProgram(rule.program) === normalizeProgram(target.program);
}

export function firewallChangeArgs(name: string, action: 'add' | 'set' | 'delete', target: FirewallTarget | null): string[] {
  const args = ['advfirewall', 'firewall', action, 'rule', `name=${name}`];
  if (action === 'delete') return args;
  if (!target) throw new Error('防火墙规则缺少目标');
  if (action === 'set') args.push('new');
  return args.concat('dir=in', 'action=allow', 'enable=yes', 'profile=private', 'protocol=TCP', 'edge=no',
    'remoteip=localsubnet', `localip=${target.address}`, `localport=${target.port}`, `program=${target.program}`);
}

export class LanFirewall {
  constructor(private readonly name: string, private readonly execute: LanExecutor) {}

  async state(target: FirewallTarget | null): Promise<LanFirewallState> {
    const result = await this.execute({
      kind: 'firewall-query', timeoutMs: 10_000, env: { AIC_LAN_RULE_NAME: this.name },
      script: [
        '& "$env:SystemRoot\\System32\\netsh.exe" advfirewall firewall show rule "name=$env:AIC_LAN_RULE_NAME" verbose | Out-Null',
        '$shown = $LASTEXITCODE',
        '$policy = New-Object -ComObject HNetCfg.FwPolicy2',
        '$rules = @(foreach ($rule in $policy.Rules) {',
        '  if ($rule.Name -eq $env:AIC_LAN_RULE_NAME) {',
        '    @{ address = $rule.LocalAddresses; remoteAddress = $rule.RemoteAddresses;',
        '       port = $rule.LocalPorts; program = $rule.ApplicationName; profiles = [int]$rule.Profiles;',
        '       protocol = [int]$rule.Protocol; direction = [int]$rule.Direction; action = [int]$rule.Action;',
        '       enabled = [bool]$rule.Enabled; edge = [bool]$rule.EdgeTraversal }',
        '  }',
        '})',
        // 规则属性从 COM 读取，避免按 Windows 的显示语言解析 netsh 输出。
        'if ($shown -notin @(0, 1) -or ($shown -eq 0) -ne ($rules.Count -gt 0)) { exit 1 }',
        'ConvertTo-Json -InputObject $rules -Compress',
      ].join('\n'),
    });
    if (result.status !== 'ok') return 'unknown';
    let rules: unknown;
    try { rules = JSON.parse(result.stdout); } catch { return 'unknown'; }
    if (!Array.isArray(rules)) return 'unknown';
    if (!rules.length) return 'missing';
    if (rules.length !== 1 || !rules[0] || !target) return 'mismatch';
    return firewallRuleMatches(rules[0], target) ? 'matched' : 'mismatch';
  }

  async change(action: 'add' | 'set' | 'delete', target: FirewallTarget | null = null): Promise<void> {
    // Start-Process 直接启动 netsh；每个参数作为一个 Windows 命令行参数，网卡名不参与命令。
    const args = firewallChangeArgs(this.name, action, target).map((arg) => `"${arg}"`).join(' ');
    const result = await this.execute({
      kind: 'firewall-change', timeoutMs: 90_000, env: { AIC_LAN_RULE_ARGS: args },
      script: [
        'try {',
        '  $p = Start-Process -FilePath "$env:SystemRoot\\System32\\netsh.exe" -Verb RunAs -WindowStyle Hidden -ArgumentList $env:AIC_LAN_RULE_ARGS -Wait -PassThru',
        '  if ($p.ExitCode -ne 0) { exit 1 }',
        '} catch {',
        '  for ($e = $_.Exception; $null -ne $e; $e = $e.InnerException) {',
        '    if ($e -is [System.ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 1223) { exit 23 }',
        '  }',
        '  exit 1',
        '}',
      ].join('\n'),
    });
    const adding = action !== 'delete';
    if (result.status === 'cancelled') throw Errors.forbidden(adding
      ? '没有添加防火墙规则，局域网设备连不上' : '已取消删除防火墙规则，请重新确认 Windows 权限');
    if (result.status === 'timeout') throw Errors.conflict('等待 Windows 防火墙操作超时', '请关闭仍打开的 Windows 权限窗口，再检查规则状态');
    if (result.status !== 'ok') throw Errors.conflict(adding ? 'Windows 防火墙规则写入失败' : 'Windows 防火墙规则删除失败');
  }
}
