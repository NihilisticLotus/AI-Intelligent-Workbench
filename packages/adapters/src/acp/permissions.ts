// session/request_permission → 工作台审批卡片（phase-1.md 6.2.3）。
import { clip } from '../redact';
import type { PermissionOptionKind, PermissionRequest } from '../types';
import { isRecord, str } from '../util';
import { mapToolKind, toolTarget } from './updates';

const STD_KINDS = new Set<PermissionOptionKind>(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

/** Agent 给的常见英文选项名 → 中文（其余原样显示） */
const LABELS: Record<string, string> = {
  'yes': '允许', 'allow': '允许', 'allow once': '允许一次', 'no': '拒绝', 'reject': '拒绝', 'deny': '拒绝',
  'yes, proceed': '允许执行', 'yes, just this once': '仅这一次允许', 'always allow': '总是允许',
  'no, continue without running it': '不执行，继续', 'no, and tell codex what to do differently': '不执行，我来告诉它怎么做',
  'yes, manually approve edits': '允许（之后的修改仍逐个审批）', 'yes, implement this plan': '按这个计划执行',
};
const label = (name: string) => LABELS[name.trim().toLowerCase()] ?? name;

export interface NormalizedOption { id: string; label: string; kind: PermissionOptionKind; visible: boolean }

export interface NormalizedPermission {
  request: PermissionRequest;
  /** 全部能识别的选项（含隐藏的），用来判断用户选的是允许还是拒绝 */
  options: NormalizedOption[];
  toolCallId: string | null;
  toolCall: Record<string, unknown> | null;
  /** 一个可见选项都没有时：自动选的拒绝类选项（没有就回 cancelled） */
  auto: { optionId: string } | 'cancelled' | null;
  warnings: string[];
}

/** 归一化 kind：兼容 CodeBuddy 沙箱拦截时用的非标准 allow / reject */
export function normalizeKind(kind: unknown, optionId: string): PermissionOptionKind | null {
  if (typeof kind !== 'string') return null;
  if (STD_KINDS.has(kind as PermissionOptionKind)) return kind as PermissionOptionKind;
  if (kind === 'allow') return /session|always/i.test(optionId) ? 'allow_always' : 'allow_once';
  if (kind === 'reject') return 'reject_once';
  return null;
}

const KIND_VERB: Record<string, string> = {
  execute: '执行命令', edit: '修改文件', delete: '删除文件', read: '读取文件', search: '搜索', fetch: '访问网络', think: '思考', other: '使用工具',
};

export function normalizePermission(params: Record<string, unknown>, ctx: { agentName: string; cwd: string | null }): NormalizedPermission {
  const warnings: string[] = [];
  const toolCall = isRecord(params.toolCall) ? params.toolCall : null;
  const toolCallId = toolCall ? str(toolCall.toolCallId) : null;
  const raw = Array.isArray(params.options) ? params.options.filter(isRecord) : [];

  const all: NormalizedOption[] = [];
  const rejectRaw: string[] = [];
  for (const o of raw) {
    const id = str(o.optionId);
    if (!id) continue;
    if (o.kind === 'reject' || o.kind === 'reject_once' || o.kind === 'reject_always') rejectRaw.push(id);
    const kind = normalizeKind(o.kind, id);
    if (!kind) { warnings.push(`未知的审批选项 kind：${String(o.kind)}（${id}），已丢弃`); continue; }
    if (all.some((x) => x.id === id)) continue;
    all.push({ id, label: label(str(o.name) ?? id), kind, visible: true });
  }
  // “总是”类选项本步隐藏（它会写进 Agent 自己的配置文件；规则引擎在 1.3，ISSUE-0006）。
  // 例外：没有任何 allow_once 时保留 allow_always；没有 reject_once 时保留 reject_always
  const hasAllowOnce = all.some((o) => o.kind === 'allow_once');
  const hasRejectOnce = all.some((o) => o.kind === 'reject_once');
  for (const o of all) {
    if (o.kind === 'allow_always' && hasAllowOnce) o.visible = false;
    if (o.kind === 'reject_always' && hasRejectOnce) o.visible = false;
  }
  const visible = all.filter((o) => o.visible);

  let auto: NormalizedPermission['auto'] = null;
  if (visible.length === 0) {
    const rej = all.find((o) => o.kind.startsWith('reject'))?.id ?? rejectRaw[0];
    auto = rej ? { optionId: rej } : 'cancelled';
  }

  // 标题：toolCall.title；没有时按工具生成（CodeBuddy 用 _meta 里的工具名）
  const meta = toolCall && isRecord(toolCall._meta) ? toolCall._meta : {};
  const toolName = str(meta['codebuddy.ai/toolName']);
  const kind = toolCall ? mapToolKind(toolCall.kind) : 'other';
  const title = (toolCall && str(toolCall.title))
    ?? (toolName ? `${ctx.agentName} 请求使用工具：${toolName}` : `${ctx.agentName} 请求${KIND_VERB[kind] ?? '使用工具'}`);

  // 详情：完整的命令或文件路径（rawInput）
  const ri = toolCall && isRecord(toolCall.rawInput) ? toolCall.rawInput : null;
  let detail = toolCall ? toolTarget(toolCall) : null;
  if (!detail && ri) {
    try { detail = clip(JSON.stringify(ri), 2000); } catch { detail = null; }
  }
  const reason = ri ? (str(ri.description) ?? str(ri.reason) ?? str(ri.explanation) ?? '') : '';

  return {
    request: {
      toolId: toolCallId ?? '',
      title: clip(title, 300),
      reason: clip(reason, 2000),
      detail: clip(detail ?? title, 8000),
      cwd: ctx.cwd,
      options: visible.map(({ id, label: l, kind: k }) => ({ id, label: l, kind: k })),
    },
    options: all, toolCallId, toolCall, auto, warnings,
  };
}
