import { isIPv4 } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { LanInterface } from '@aic/protocol';

export function isPrivateIpv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.').map(Number) as [number, number, number, number];
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function listPrivateInterfaces(read: typeof networkInterfaces = networkInterfaces): Array<Omit<LanInterface, 'category'>> {
  return Object.entries(read()).flatMap(([name, addresses]) => (addresses ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
    .map(({ address }) => ({ name, address })));
}
