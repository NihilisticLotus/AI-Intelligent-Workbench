// configOptions 解析（phase-1.md 6.3.2）：一律按 category 找配置项，不写死 id。
// category model → 模型；thought_level → 思考强度；mode → 模式。
import type { ModelInfo, SessionConfigState } from '../types';
import { isRecord, str } from '../util';

interface SelectOption { value: string; name: string; description: string | null; vision?: boolean }
interface SelectConfig { id: string; category: string | null; currentValue: string | null; options: SelectOption[] }

// CodeBuddy 的 toAcpModelInfo 明确报告这个扩展；没有字段时保持未知。
const imageCapability = (item: Record<string, unknown>): { vision?: boolean } =>
  isRecord(item._meta) && typeof item._meta.supportsImages === 'boolean' ? { vision: item._meta.supportsImages } : {};

/** 把 select 的 options 拍平（ACP 允许分组：{ group, name, options: [...] }） */
function flatOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) return [];
  const out: SelectOption[] = [];
  for (const o of raw) {
    if (!isRecord(o)) continue;
    if (Array.isArray(o.options)) { out.push(...flatOptions(o.options)); continue; }
    const value = str(o.value) ?? str(o.id);
    if (value === null) continue;
    out.push({ value, name: str(o.name) ?? value, description: str(o.description), ...imageCapability(o) });
  }
  return out;
}

export function parseSelects(configOptions: unknown): SelectConfig[] {
  if (!Array.isArray(configOptions)) return [];
  const out: SelectConfig[] = [];
  for (const c of configOptions) {
    if (!isRecord(c) || typeof c.id !== 'string') continue;
    if (c.type !== undefined && c.type !== 'select') continue;
    const cv = c.currentValue;
    out.push({
      id: c.id, category: str(c.category),
      currentValue: typeof cv === 'string' ? cv : typeof cv === 'boolean' || typeof cv === 'number' ? String(cv) : null,
      options: flatOptions(c.options),
    });
  }
  return out;
}

/** Codex 旧字段的组合 id：<model>[<effort>] */
const COMBO = /^(.*)\[([^\]]+)\]$/;
const stripEffortName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '');

export const EMPTY_CONFIG: SessionConfigState = {
  model: null, effort: null, mode: null, models: [], efforts: null, modes: [], source: 'none',
  ids: { model: null, effort: null, mode: null },
};

/**
 * 从 session/new、resume、load、set_config_option 的返回（或 config_option_update 推送）解析配置状态。
 * prev：上一次的状态，用于补齐返回里没有的部分（例如只推了 configOptions，没有 modes）。
 */
export function parseConfigState(resp: Record<string, unknown>, prev: SessionConfigState = EMPTY_CONFIG): SessionConfigState {
  const st: SessionConfigState = { ...prev, ids: { ...prev.ids } };
  const hasConfig = Array.isArray(resp.configOptions);
  if (hasConfig) {
    const selects = parseSelects(resp.configOptions);
    const model = selects.find((s) => s.category === 'model');
    const effort = selects.find((s) => s.category === 'thought_level');
    const mode = selects.find((s) => s.category === 'mode');
    st.ids = { model: model?.id ?? null, effort: effort?.id ?? null, mode: mode?.id ?? null };
    if (model) {
      st.models = model.options.map((o) => {
        const vision = o.vision ?? prev.models.find((m) => m.id === o.value)?.vision;
        return { id: o.value, name: o.name, contextWindow: null, ...(vision === undefined ? {} : { vision }) };
      });
      st.model = model.currentValue;
      st.source = 'configOptions';
    } else {
      st.models = [];
      st.model = null;
    }
    if (effort) { st.efforts = effort.options.map((o) => o.value); st.effort = effort.currentValue; }
    else { st.efforts = null; st.effort = null; }
    if (mode) { st.modes = mode.options.map((o) => ({ id: o.value, name: o.name })); st.mode = mode.currentValue; }
  }

  // 旧字段 models（unstable）：只在没有 model 类配置项时使用
  if (!st.ids.model && isRecord(resp.models)) {
    const avail = Array.isArray(resp.models.availableModels) ? resp.models.availableModels : [];
    const items = avail.filter(isRecord).map((m) => ({ id: str(m.modelId) ?? str(m.id) ?? '', name: str(m.name) ?? str(m.modelId) ?? '', ...imageCapability(m) })).filter((m) => m.id);
    const cur = str(resp.models.currentModelId);
    const combo = items.length > 0 && items.every((m) => COMBO.test(m.id));
    if (combo) {
      const models: ModelInfo[] = [];
      const efforts: string[] = [];
      for (const m of items) {
        const [, base, eff] = COMBO.exec(m.id)!;
        if (!models.some((x) => x.id === base)) models.push({ ...m, id: base!, name: stripEffortName(m.name), contextWindow: null });
        if (!efforts.includes(eff!)) efforts.push(eff!);
      }
      st.models = models;
      const cm = cur ? COMBO.exec(cur) : null;
      st.model = cm ? cm[1]! : cur;
      if (!st.ids.effort) { st.efforts = efforts; st.effort = cm ? cm[2]! : null; }
    } else {
      st.models = items.map((m) => ({ ...m, contextWindow: null }));
      st.model = cur;
    }
    st.source = items.length ? 'legacy' : st.source;
  }

  // 新配置优先保留模型顺序；旧 models 返回可补充明确的能力元数据。
  if (st.ids.model && isRecord(resp.models) && Array.isArray(resp.models.availableModels)) {
    const reported = resp.models.availableModels.filter(isRecord);
    st.models = st.models.map((m) => ({ ...m, ...imageCapability(reported.find((x) => (str(x.modelId) ?? str(x.id)) === m.id) ?? {}) }));
  }

  // 旧字段 modes
  if (!st.ids.mode && isRecord(resp.modes)) {
    const avail = Array.isArray(resp.modes.availableModes) ? resp.modes.availableModes : [];
    st.modes = avail.filter(isRecord).map((m) => ({ id: str(m.id) ?? '', name: str(m.name) ?? str(m.id) ?? '' })).filter((m) => m.id);
    st.mode = str(resp.modes.currentModeId) ?? st.mode;
  }
  if (!hasConfig && !isRecord(resp.models) && !isRecord(resp.modes)) return prev;
  if (st.source !== 'configOptions' && st.source !== 'legacy') st.source = st.models.length ? st.source : 'none';
  return st;
}

/** 旧字段是不是组合 id（Codex） */
export function legacyIsCombo(resp: Record<string, unknown>): boolean {
  if (!isRecord(resp.models) || !Array.isArray(resp.models.availableModels)) return false;
  const ids = resp.models.availableModels.filter(isRecord).map((m) => str(m.modelId) ?? '');
  return ids.length > 0 && ids.every((id) => COMBO.test(id));
}

export function modelSwitchOf(st: SessionConfigState, resp: Record<string, unknown>): 'configOption' | 'unstableSetModel' | 'none' {
  if (st.ids.model) return 'configOption';
  if (isRecord(resp.models) && Array.isArray(resp.models.availableModels) && resp.models.availableModels.length > 0) return 'unstableSetModel';
  return 'none';
}

/** 状态签名：用于判断有没有变化（CodeBuddy 一次切换会连发 2–3 条同样的推送） */
export const configSignature = (s: SessionConfigState) => JSON.stringify([s.model, s.effort, s.mode, s.models.map((m) => [m.id,m.vision]), s.efforts, s.modes.map((m) => m.id)]);
