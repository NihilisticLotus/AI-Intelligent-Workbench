// 能力值只按协议解释；不根据模型名猜窗口、图片或思考档位。
import { IndependentCapabilityPatch, type IndependentCapabilityField, type IndependentModel, type IndependentService } from '@aic/protocol';

export const capabilityLabels = {
  contextWindow: '上下文总窗口（令牌）', inputLimit: '最大输入（令牌）', outputLimit: '最大输出（令牌）',
  imageInput: '图片输入', tools: '工具调用', streaming: '流式输出', streamUsage: '流式用量', structuredOutput: '结构化输出',
  thinking: '思考能力', thinkingCanDisable: '允许关闭思考', effortLevels: '思考强度列表', defaultEffort: '默认思考强度',
  thinkingBudgetMin: '最小思考预算（令牌）', thinkingBudgetMax: '最大思考预算（令牌）', inputModalities: '输入模态', outputModalities: '输出模态',
} satisfies Record<IndependentCapabilityField, string>;
export const capabilityKinds: Record<IndependentCapabilityField, 'number' | 'flag' | 'list' | 'text'> = {
  contextWindow: 'number', inputLimit: 'number', outputLimit: 'number', imageInput: 'flag', tools: 'flag', streaming: 'flag', streamUsage: 'flag', structuredOutput: 'flag',
  thinking: 'flag', thinkingCanDisable: 'flag', effortLevels: 'list', defaultEffort: 'text', thinkingBudgetMin: 'number', thinkingBudgetMax: 'number', inputModalities: 'list', outputModalities: 'list',
};
export const sourceLabels = { manual: '手动设置', endpoint: '服务接口声明', official: '官方文档', catalog: '模型目录', observation: '有限样本观察' };

export function capabilityText(value: IndependentModel['capabilities'][number]['value']) {
  if (value === null) return '未知';
  if (typeof value === 'boolean') return value ? '支持' : '不支持';
  if (Array.isArray(value)) return value.length ? value.join('、') : '无可选项';
  return String(value);
}

/** 空白表示清除此字段人工值；只发送用户编辑的字段，保留其余人工值。 */
export function overridePatch(draft: Partial<Record<IndependentCapabilityField, string>>): IndependentCapabilityPatch {
  const values: Record<string, unknown> = {};
  for (const [field, text] of Object.entries(draft)) {
    const kind = capabilityKinds[field as IndependentCapabilityField]; const v = text.trim();
    if (!v) values[field] = null;
    else if (kind === 'flag') {
      if (v !== 'true' && v !== 'false') throw new Error(`${capabilityLabels[field as IndependentCapabilityField]}：请选择支持或不支持`);
      values[field] = v === 'true';
    } else if (kind === 'number') {
      // 不让 Number 把指数、十六进制或小数静默变成窗口大小。
      if (!/^\d+$/.test(v)) throw new Error(`${capabilityLabels[field as IndependentCapabilityField]}：请输入整数`);
      values[field] = Number(v);
    } else if (kind === 'list') values[field] = v === '[]' ? [] : v.split(/[,，\n]/).map((x) => x.trim()).filter(Boolean);
    else values[field] = v;
  }
  const parsed = IndependentCapabilityPatch.safeParse(values);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]; const field = issue?.path[0] as IndependentCapabilityField;
    throw new Error(`${capabilityLabels[field] ?? '能力值'}：格式或范围不正确；列表不能重复，每项最多 100 字，最多 32 项`);
  }
  return parsed.data;
}

export function evidenceApplies(service: IndependentService, model: IndependentModel, evidence: IndependentModel['evidence'][number]) {
  const s = evidence.scope;
  return s.serviceId === service.id && s.configRevision === service.configRevision && s.protocol === service.protocol
    && s.apiVersion === service.apiVersion && s.providerId === service.providerId && s.plan === service.plan && s.remoteModelId === model.remoteModelId;
}

/** 后发请求胜出：迟到结果不能将已删除/切换后的目录倒回旧快照。 */
export function latestRequest() {
  let version = 0;
  return { begin: () => ++version, current: (id: number) => id === version, invalidate: () => { version++; } };
}
