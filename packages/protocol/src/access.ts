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

export const DeviceSource = z.enum(['local', 'lan']);
export type DeviceSource = z.infer<typeof DeviceSource>;

export const LanPairingRequestId = z.string().regex(/^lp_[A-Za-z0-9_-]{32}$/);
const PairingTime = z.number().int().nonnegative();

export const LanPairingCode = z.object({ code: z.string().regex(/^\d{6}$/), expiresAt: PairingTime, address: z.url() });
export type LanPairingCode = z.infer<typeof LanPairingCode>;

export const LanPairingRequest = z.object({
  id: LanPairingRequestId, name: z.string().min(1).max(100), browser: z.string().max(40), ip: z.string().max(64), expiresAt: PairingTime,
});
export type LanPairingRequest = z.infer<typeof LanPairingRequest>;

export const LanPairingPending = z.object({ status: z.literal('pending'), id: LanPairingRequestId, expiresAt: PairingTime });
export type LanPairingPending = z.infer<typeof LanPairingPending>;

export const LanPairingResolution = z.enum(['allowed', 'rejected', 'expired', 'unavailable']);
export type LanPairingResolution = z.infer<typeof LanPairingResolution>;

export const LanPairingResolved = z.object({ id: LanPairingRequestId, status: LanPairingResolution });
export const LanPairingDecision = z.object({ allow: z.boolean() }).strict();
export const RevokeLanResult = z.object({ revoked: z.number().int().nonnegative() });
export type RevokeLanResult = z.infer<typeof RevokeLanResult>;
