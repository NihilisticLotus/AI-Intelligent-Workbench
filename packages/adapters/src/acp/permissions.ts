// session/request_permission → 工作台审批卡片（phase-1.md 6.2.3）。
import { clip } from '../redact';
import type { PermissionOptionKind, PermissionRequest } from '../types';
import { isRecord, str } from '../util';
import { inferToolKind, toolTarget } from './updates';

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

export function normalizePermission(params: Record<string, unknown>, ctx: { agentName: string; cwd: string | null; activeTitle?: (id: string) => string | undefined }): NormalizedPermission {
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
  // 原生 allow_always 保留给 Gateway 识别，但不直接执行；工作台生成自己的规则预览。
  const hasRejectOnce = all.some((o) => o.kind === 'reject_once');
  for (const o of all) {
    if (o.kind === 'reject_always' && hasRejectOnce) o.visible = false;
  }
  const visible = all.filter((o) => o.visible);

  let auto: NormalizedPermission['auto'] = null;
  if (visible.length === 0) {
    const rej = all.find((o) => o.kind.startsWith('reject'))?.id ?? rejectRaw[0];
    auto = rej ? { optionId: rej } : 'cancelled';
  }

  // 标题：toolCall.title；没有时按工具生成（CodeBuddy / ZCode 用 _meta 里的工具名）
  const meta = toolCall && isRecord(toolCall._meta) ? toolCall._meta : {};
  const toolName = str(meta['codebuddy.ai/toolName']) ?? (isRecord(meta.claudeCode) ? str(meta.claudeCode.toolName) : null);
  const kind = toolCall ? inferToolKind(toolCall) : 'other';
  const title = (toolCall && str(toolCall.title))
    ?? (toolCallId ? ctx.activeTitle?.(toolCallId) : undefined)
    ?? (toolName ? `${ctx.agentName} 请求使用工具：${toolName}` : `${ctx.agentName} 请求${KIND_VERB[kind] ?? '使用工具'}`);

  // 详情：完整的命令或文件路径（rawInput 或 Antigravity 的 args / PascalCase 字段）
  const ri = toolCall ? (isRecord(toolCall.rawInput) ? toolCall.rawInput : isRecord(toolCall.args) ? toolCall.args : null) : null;
  let detail = toolCall ? toolTarget(toolCall) : null;
  if (!detail && ri) {
    try { detail = clip(JSON.stringify(ri), 2000); } catch { detail = null; }
  }
  const reason = ri ? (str(ri.description) ?? str(ri.reason) ?? str(ri.explanation) ?? str(ri.toolSummary) ?? '') : '';
  const rawCommand=ri?.command??ri?.CommandLine;
  const command=typeof rawCommand==='string'?rawCommand:Array.isArray(rawCommand)&&rawCommand.every(x=>typeof x==='string')?rawCommand.map(x=>/\s/.test(x)?JSON.stringify(x):x).join(' '):null;
  const paths:string[]=[];
  if(toolCall&&Array.isArray(toolCall.locations))for(const location of toolCall.locations)if(isRecord(location)&&typeof location.path==='string')paths.push(location.path);
  if(toolCall&&Array.isArray(toolCall.content))for(const item of toolCall.content)if(isRecord(item)&&item.type==='diff'&&typeof item.path==='string')paths.push(item.path);
  if(ri)for(const key of ['path','file_path','filePath','notebook_path','cwd','Cwd','Path','TargetFile','AbsolutePath','DirectoryPath','SearchPath','SearchDirectory'])if(typeof ri[key]==='string'&&ri[key])paths.push(ri[key] as string);
  if(ri&&Array.isArray(ri.paths))for(const value of ri.paths)if(typeof value==='string'&&value)paths.push(value);
  let sandboxWrite=false;
  if(ri&&isRecord(ri.permissions)&&isRecord(ri.permissions.fileSystem)) {
    const fsPerm=ri.permissions.fileSystem;
    if(Array.isArray(fsPerm.write))for(const v of fsPerm.write)if(typeof v==='string'&&v){paths.push(v);sandboxWrite=true;}
    if(Array.isArray(fsPerm.read))for(const v of fsPerm.read)if(typeof v==='string'&&v)paths.push(v);
  }
  const reqCwd = ri ? (str(ri.cwd) ?? str(ri.Cwd)) : null;
  const customCwd = !!(reqCwd && ctx.cwd && reqCwd.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase() !== ctx.cwd.replaceAll('\\','/').replace(/\/+$/,'').toLowerCase());
  const deletion = kind === 'delete' || (ri ? str(ri.edit_mode) === 'delete' : false)
    || !!(toolCall && Array.isArray(toolCall.content) && toolCall.content.some(c => isRecord(c) && isRecord(c._meta) && c._meta.kind === 'delete'));
  const operationTool=command!==null?'shell':(kind==='edit'||kind==='delete'||sandboxWrite)?'edit':kind==='read'||kind==='search'?'read':'any';

  return {
    request: {
      operation:{tool:operationTool,command:command?.slice(0,32000)??null,paths:[...new Set(paths)].slice(0,100).map(p=>p.slice(0,4096)),deletion,
        complete:operationTool!=='any'&&(operationTool==='shell'?command!==null&&command.length<=32000&&!customCwd:paths.length>0)&&paths.length<=100&&paths.every(p=>p.length<=4096)},
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
