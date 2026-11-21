import type { LanExecutor } from './windows-executor';

// 已过滤的管理员令牌也包含管理员组 SID，不能只用当前进程是否已提升来挑选提示策略。
const readUac = String.raw`
$policy = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
$rows = @(& "$env:SystemRoot\System32\whoami.exe" /groups /fo csv /nh)
if ($LASTEXITCODE -ne 0) { exit 1 }
$groups = @($rows | ConvertFrom-Csv -Header GroupName,Type,Sid,Attributes)
if (-not ($groups.Sid -contains 'S-1-1-0')) { exit 1 }
@{
  enabled = $policy.EnableLUA
  interactive = [Environment]::UserInteractive -and ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0)
  elevated = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  adminGroup = $groups.Sid -contains 'S-1-5-32-544'
  adminPolicy = $policy.ConsentPromptBehaviorAdmin
  userPolicy = $policy.ConsentPromptBehaviorUser
} | ConvertTo-Json -Compress
`;

export async function uacProblem(execute: LanExecutor): Promise<string | null> {
  const unknown = '无法确认 Windows 能否显示权限提示，请检查用户账户控制设置后重试。';
  const result = await execute({ kind: 'uac-check', script: readUac, timeoutMs: 10_000 });
  if (result.status !== 'ok') return unknown;
  let decoded: unknown;
  try { decoded = JSON.parse(result.stdout); } catch { return unknown; }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) return unknown;
  const state = decoded as Record<string, unknown>;
  if (state.enabled === 0) return 'Windows 已关闭 UAC，请启用用户账户控制并重启电脑后再试。';
  if (state.enabled !== 1 || typeof state.elevated !== 'boolean' || typeof state.interactive !== 'boolean' ||
      typeof state.adminGroup !== 'boolean') return unknown;
  if (!state.interactive) return '请在 Windows 交互式桌面登录并启动工作台，再确认权限。';
  if (state.elevated) return '工作台已使用管理员权限。请退出工作台，以普通权限重新打开后再试。';
  if (state.adminGroup) {
    if (state.adminPolicy === 0) return 'Windows 当前设置为提升权限时不提示。请启用用户账户控制提示后再试。';
    return typeof state.adminPolicy === 'number' && [1, 2, 3, 4, 5].includes(state.adminPolicy) ? null : unknown;
  }
  if (state.userPolicy === 0) return 'Windows 当前设置为自动拒绝提升权限。请联系这台电脑的管理员启用权限提示。';
  return state.userPolicy === 1 || state.userPolicy === 3 ? null : unknown;
}
