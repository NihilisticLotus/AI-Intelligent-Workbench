// 起始页规则只依赖已报告的数据，不调用模型做推荐，也不自动派发。
import { visionOf, type AgentInfo, type AgentKind, type IndependentTaskOptions, type Task } from '@aic/protocol';
import { isEnabled } from './agents';
import { profileInfo } from './picker';

export function greeting(hour: number): string {
  return hour >= 5 && hour < 11 ? '早上好' : hour >= 11 && hour < 14 ? '中午好' : hour >= 14 && hour < 18 ? '下午好' : '晚上好';
}

export function recommendAgent(prompt: string, hasImage: boolean, projectId: string, agents: AgentInfo[], tasks: Task[]) {
  if (!prompt.trim()) return null;
  const enabled = agents.filter(isEnabled);
  if (hasImage) {
    for (const entry of enabled) {
      const info = profileInfo(entry, null)!;
      const model = info.models.find((m) => visionOf(info, m.id) === true);
      if (model) return { agent: info.kind, model: model.id, label: `${info.displayName} · ${model.name}`, reason: '已添加图片，这个模型明确支持看图。' };
    }
    return null;
  }
  const previous = tasks.filter((t) => t.projectId === projectId).sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
  const info = enabled.find((a) => a.kind === previous?.agent);
  if (!previous || !info) return null;
  const model = previous.agent === 'independent' ? previous.independent?.modelId ?? previous.model : previous.model;
  return { agent: info.kind, model: model ?? '', label: `${info.displayName} · ${info.models.find((m) => m.id === model)?.name ?? model ?? 'Agent 默认模型'}`, reason: '这是你上次在这个项目使用的 Agent 和模型。' };
}

export const quickTemplates = [
  { id: 'fix', label: '报错修复', text: '请定位并修复下面的报错，说明原因并验证修复：\n[粘贴报错信息]', placeholder: '[粘贴报错信息]' },
  { id: 'weekly', label: '周报总结', text: '请根据以下工作记录整理本周进展、问题和下周计划：\n[补充工作记录]', placeholder: '[补充工作记录]' },
  { id: 'asset', label: '资产处理', text: '请处理以下资产，并说明处理步骤与输出位置：\n[描述资产和目标]', placeholder: '[描述资产和目标]' },
  { id: 'slides', label: 'PPT 制作', text: '请制作一份演示文稿，先整理大纲：\n[补充主题、受众和页数]', placeholder: '[补充主题、受众和页数]' },
] as const;
export function templateDraft(template: typeof quickTemplates[number]) {
  const start = template.text.indexOf(template.placeholder);
  return { text: template.text, start, end: start + template.placeholder.length };
}

export function newTaskBody(draft: {
  projectId: string; groupId: string; prompt: string; agent: AgentKind; model: string; effort: string;
  permission: 'readonly' | 'ask'; profileId: string; independent: IndependentTaskOptions | null; hasAttachments: boolean;
}) {
  return {
    projectId: draft.projectId, groupId: draft.groupId || null, prompt: draft.prompt.trim(), agent: draft.agent,
    model: draft.agent === 'independent' ? null : draft.model || null,
    effort: draft.agent === 'independent' ? null : draft.effort || null, permission: draft.permission,
    ...(draft.agent === 'independent' && draft.independent ? { independent: draft.independent } : {}),
    ...(draft.profileId && draft.agent !== 'independent' ? { profileId: draft.profileId } : {}),
    ...(draft.hasAttachments ? { deferPrompt: true } : {}),
  };
}
