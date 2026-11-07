// 选择器的显示和行为纯函数，与 React 和浏览器无关。
import { visionOf, type AgentInfo, type AgentKind } from '@aic/protocol';
import { agentStatusText, isEnabled, pickEfforts, pickModels, profileSwitchKind } from './agents';
import type { SessionCfg } from '../state/core';
export const effortLabel = (value: string) => value === 'enabled' ? '自动' : value;
export function profileInfo(info: AgentInfo | undefined, profileId: string | null): AgentInfo | undefined {
  if (!info) return info;
  const profile = info.profiles?.find((p) => p.id === profileId) ?? info.profiles?.find((p) => p.isDefault);
  return profile ? { ...info, ...(profile.models !== undefined ? { models: profile.models } : {}),
    ...(profile.efforts !== undefined ? { efforts: profile.efforts } : {}), ...(profile.caps ? { caps: profile.caps } : {}),
    ...(profile.modelsSource ? { modelsSource: profile.modelsSource } : {}) } : info;
}
export function profileDefaults(info: AgentInfo | undefined, profileId: string, model: string, effort: string) {
  const next = profileInfo(info, profileId);
  return { model: next?.models.some((m) => m.id === model) ? model : next?.models[0]?.id ?? '',
    effort: next?.efforts?.includes(effort) ? effort : '' };
}
export function pickerRows(agents: AgentInfo[], current: AgentKind, cfg: SessionCfg) {
  return agents.filter((a) => isEnabled(a) || a.kind === current).map((a) => ({ info: a,
    meta: a.kind === current ? `${pickModels(a,cfg).find((m)=>m.id===cfg.model)?.name ?? cfg.model ?? 'Agent 默认模型'}${pickEfforts(a,cfg) && cfg.effort ? ' · 思考 '+effortLabel(cfg.effort) : ''} ✓`
      : a.status !== 'ready' ? agentStatusText(a.status) : `${a.models.length} 个模型`,
  }));
}
export function pickerItems(info: AgentInfo, current: AgentKind, cfg: SessionCfg, profileId: string | null, mode: 'task' | 'new') {
  info = profileInfo(info, info.kind === current ? profileId : null)!;
  const session = info.kind === current && mode === 'task' ? cfg : undefined;
  const models = pickModels(info,session).map((m) => ({ ...m, cannotSee: visionOf({...info,models:pickModels(info,session)},m.id) === false,
    failure: info.modelFailures?.find((f)=>f.model===m.id && f.profileId===(profileId ?? info.profiles?.find((p)=>p.isDefault)?.id ?? null))?.reason ?? null,
  }));
  const efforts = pickEfforts(info,session)?.slice().sort((a,b)=>a==='enabled'?-1:b==='enabled'?1:0) ?? null;
  const profiles = info.kind === current && (info.profiles?.length ?? 0)>1 ? info.profiles!.map((p)=>({ ...p,
    blocked: mode==='task' && p.id!==profileId && profileSwitchKind(info.profiles?.find((x)=>x.id===profileId) ?? null,p)==='handoff',
  })) : [];
  return { models, efforts, profiles };
}
export const pickerAction = (current: AgentKind, selected: AgentKind, mode: 'task' | 'new') => current === selected ? 'switch' : mode === 'new' ? 'select' : 'explain';
