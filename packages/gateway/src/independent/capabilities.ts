// 只解析已经校验的证据，不请求网络、不从模型名猜测能力。
import { IndependentCapabilityField, type IndependentCapabilityEvidence, type IndependentCapabilityScope, type IndependentCapabilityResolution, type IndependentService, type IndependentModel } from '@aic/protocol';

/**
 * 运行时取能力值的唯一入口（ISSUE-0059）：来源过期（stale）的值继续使用，界面另行提示需复核；
 * 只有来源冲突或没有适用于当前配置的证据（此时 value 本身为 null）才算未知。
 */
export function usableCapability(model: Pick<IndependentModel, 'capabilities'>, field: IndependentCapabilityField) {
  const c = model.capabilities.find((item) => item.field === field);
  return c && !c.conflict ? c.value : null;
}

export function capabilityScope(service: IndependentService, remoteModelId: string): IndependentCapabilityScope {
  return { serviceId: service.id, configRevision: service.configRevision, protocol: service.protocol,
    apiVersion: service.apiVersion, providerId: service.providerId, plan: service.plan, remoteModelId };
}
export const sameCapabilityScope = (a: IndependentCapabilityScope, b: IndependentCapabilityScope) =>
  a.serviceId === b.serviceId && a.configRevision === b.configRevision && a.protocol === b.protocol &&
  a.apiVersion === b.apiVersion && a.providerId === b.providerId && a.plan === b.plan && a.remoteModelId === b.remoteModelId;

const comparable = (value: IndependentCapabilityEvidence['value']) => JSON.stringify(Array.isArray(value) ? [...value].sort() : value);
const priority = { manual: 0, endpoint: 1, official: 2, catalog: 3, observation: 4 };
export function resolveCapabilities(evidence: IndependentCapabilityEvidence[], scope: IndependentCapabilityScope, at = Date.now()): IndependentCapabilityResolution[] {
  return IndependentCapabilityField.options.map((field) => {
    const all = evidence.filter((e) => e.field === field && e.kind !== 'observation' && e.value !== null);
    const applicable = all.filter((e) => sameCapabilityScope(e.scope, scope));
    const manual = applicable.find((e) => e.kind === 'manual');
    const automatic = applicable.filter((e) => e.kind !== 'manual');
    // 低级目录即使更新，也不能覆盖接口已声明的限制；只在同级来源中比较新鲜程度。
    const tier = Math.min(...automatic.map((e) => priority[e.kind]));
    const pool = automatic.filter((e) => priority[e.kind] === tier);
    const fresh = pool.filter((e) => e.expiresAt === null || e.expiresAt > at);
    const selected = fresh.length ? fresh : pool;
    const conflict = new Set(selected.map((e) => comparable(e.value))).size > 1;
    if (manual) return { field, value: manual.value, sourceKind: 'manual', stale: false,
      conflict: conflict || selected.some((e) => comparable(e.value) !== comparable(manual.value)), evidenceIds: [manual.id, ...selected.map((e) => e.id)] };
    return { field, value: conflict ? null : selected[0]?.value ?? null, sourceKind: conflict ? null : selected[0]?.kind ?? null,
      conflict, stale: selected.length ? fresh.length === 0 : all.length > 0, evidenceIds: selected.map((e) => e.id) };
  });
}
