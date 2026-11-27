// 共享安全协议：消息来源权威档位与只读安全自检摘要（不含任何本机路径、密钥或网络地址原文）。
import { z } from 'zod';

/** 消息来源权威档位：制作人本人指令 / 受托子任务与交接上下文 / 外部仅作参考资料 */
export const PROVENANCE_TIERS = ['producer', 'delegated', 'external_data'] as const;
export const ProvenanceTier = z.enum(PROVENANCE_TIERS);
export type ProvenanceTier = z.infer<typeof ProvenanceTier>;

/** 单项安全自检条目（只含开关、固定键与通俗中文说明） */
export const SecurityCheckItem = z.object({
  key: z.string().min(1).max(64),
  enabled: z.boolean(),
  label: z.string().min(1).max(100),
  detail: z.string().min(1).max(300),
}).strict();
export type SecurityCheckItem = z.infer<typeof SecurityCheckItem>;

/** GET /api/v1/security/status 响应：严格只暴露布尔、枚举与计数，禁止包含本机路径、端口或密钥信息 */
export const SecurityStatus = z.object({
  provenanceFence: z.object({
    active: z.boolean(),
    tiers: z.array(ProvenanceTier),
  }).strict(),
  subprocessEnvIsolation: z.object({
    active: z.boolean(),
  }).strict(),
  egressGuard: z.object({
    active: z.boolean(),
    allowFakeIpProxy: z.boolean(),
    blockedLocalPortsCount: z.number().int().nonnegative(),
  }).strict(),
  secretStorage: z.object({
    mode: z.enum(['dpapi', 'unavailable']),
    encryptedCount: z.number().int().nonnegative(),
  }).strict(),
  lanBoundary: z.object({
    lanEnabled: z.boolean(),
    currentConnection: z.enum(['local', 'lan']),
    localOnlyWriteGuard: z.boolean(),
  }).strict(),
  markdownSafety: z.object({
    blockRemoteImages: z.boolean(),
    blockNonHttpLinks: z.boolean(),
  }).strict(),
}).strict();
export type SecurityStatus = z.infer<typeof SecurityStatus>;
