// 固定核对的官方声明；不是在线探测，不从模型名推测未知服务或套餐的能力。
import type { IndependentDiscoveredModel, IndependentService } from '@aic/protocol';
import { evidenceBuilder } from './metadata-parser';

const REVIEWED_AT = Date.UTC(2026, 10, 8, 12, 17);
const VERSION = 'bigmodel-responses-official-2026-11-08-v1';
const INTRO = 'https://docs.bigmodel.cn/cn/guide/develop/responses/introduction';
const RESPONSE = 'https://docs.bigmodel.cn/api-reference/response/%E5%88%9B%E5%BB%BA-response';
const MODELS = {
  'glm-5.3': 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
  'glm-5.3-flash': 'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash',
} as const;

/** 只追加可追溯证据，调用方仍须预览 / 勾选导入；旧人工值不在此处操作。 */
export function supplementOfficial(service: IndependentService, items: IndependentDiscoveredModel[]) {
  if (service.protocol !== 'responses' || service.baseUrl.replace(/\/$/, '') !== 'https://open.bigmodel.cn/api/v1'
    || service.apiVersion !== null || service.plan !== null || service.providerId !== null && service.providerId !== 'zhipuai') return [];
  let matched = 0;
  for (const item of items) {
    const id = item.remoteModelId;
    if (id !== 'glm-5.3' && id !== 'glm-5.3-flash') continue;
    matched++;
    const model = evidenceBuilder(service, id, MODELS[id], VERSION, REVIEWED_AT, 'official');
    model.modalities(id === 'glm-5.3' ? ['text'] : ['text', 'image', 'video', 'file'], 'inputModalities', '输入模态');
    if (id === 'glm-5.3-flash') model.modalities(['text'], 'outputModalities', '输出模态');
    const api = evidenceBuilder(service, id, RESPONSE, VERSION, REVIEWED_AT, 'official');
    api.add('outputLimit', 131072, 'max_output_tokens.maximum');
    api.add('tools', true, 'tools.function');
    api.add('streaming', true, 'stream');
    const reasoning = evidenceBuilder(service, id, INTRO, VERSION, REVIEWED_AT, 'official');
    reasoning.add('thinking', true, 'reasoning');
    reasoning.add('effortLevels', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'reasoning.effort');
    reasoning.add('defaultEffort', 'max', 'reasoning.effort.default');
    // 核对时间固定，重复本地读取不能把旧声明伪装成刚获取；7 天后按既有规则标过期。
    item.evidence.push(...[...model.evidence, ...api.evidence, ...reasoning.evidence].map((e, index) => ({ ...e, id: `official-${index}`, expiresAt: REVIEWED_AT + 7 * 24 * 60 * 60 * 1000 })));
  }
  return matched ? [
    `已匹配 ${matched} 个模型的官方资料快照（2026-11-08），不代表账号可用或已实测能力`,
    '官方上下文只标 1M，未换算精确窗口或输入上限；思考关闭语义未统一，保留未知。Responses 的 low / medium 映射 high，xhigh 映射 max；不套用 Chat 的档位列表',
  ] : [];
}
