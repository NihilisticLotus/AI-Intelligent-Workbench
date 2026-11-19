import { z } from 'zod';

export const LanNetworkCategory = z.enum(['private', 'public', 'domain', 'unknown']);
export type LanNetworkCategory = z.infer<typeof LanNetworkCategory>;

const LanSelection = z.object({ name: z.string().min(1).max(256), address: z.ipv4() });

export const LanInterface = LanSelection.extend({ category: LanNetworkCategory });
export type LanInterface = z.infer<typeof LanInterface>;

export const LanFirewallState = z.enum(['missing', 'matched', 'mismatch', 'unknown']);
export type LanFirewallState = z.infer<typeof LanFirewallState>;

export const LanState = z.object({
  enabled: z.boolean(),
  requested: z.boolean(),
  selected: LanInterface.nullable(),
  interfaces: z.array(LanInterface),
  port: z.number().int().min(1).max(65535),
  firewall: LanFirewallState,
  unavailableReason: z.string().nullable(),
});
export type LanState = z.infer<typeof LanState>;

export const PutLanBody = z.discriminatedUnion('enabled', [
  LanSelection.extend({ enabled: z.literal(true) }).strict(),
  z.object({ enabled: z.literal(false) }).strict(),
]);
export type PutLanBody = z.infer<typeof PutLanBody>;
