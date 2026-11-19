import type { LanNetworkCategory } from '@aic/protocol';
import type { LanExecutor } from './windows-executor';

const categories: ReadonlyMap<string, LanNetworkCategory> = new Map([
  ['Private', 'private'], ['Public', 'public'], ['DomainAuthenticated', 'domain'],
]);

export function parseNetworkProfiles(stdout: string): Map<string, LanNetworkCategory> {
  const profiles = new Map<string, LanNetworkCategory>();
  let decoded: unknown;
  try { decoded = JSON.parse(stdout); } catch { return profiles; }
  if (!Array.isArray(decoded)) return profiles;
  for (const entry of decoded) {
    if (typeof entry?.name !== 'string') continue;
    const key = entry.name.toLowerCase();
    const category = categories.get(entry.category) ?? 'unknown';
    const previous = profiles.get(key);
    profiles.set(key, previous && previous !== category ? 'unknown' : category);
  }
  return profiles;
}

export async function networkProfiles(execute: LanExecutor): Promise<Map<string, LanNetworkCategory>> {
  const result = await execute({
    kind: 'network-profile', timeoutMs: 10_000,
    script: [
      '$profiles = @(Get-NetConnectionProfile | ForEach-Object {',
      '  @{ name = $_.InterfaceAlias; category = [string]$_.NetworkCategory }',
      '})',
      'ConvertTo-Json -InputObject $profiles -Compress',
    ].join('\n'),
  });
  return result.status === 'ok' ? parseNetworkProfiles(result.stdout) : new Map();
}
