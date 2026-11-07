// session/update → AgentUpdate（phase-1.md 6.2.2 映射表）。
import type { AgentUpdate, ToolKindT } from '../types';
import { isRecord, newId, str } from '../util';

const TOOL_KIND: Record<string, ToolKindT> = {
  read: 'read', edit: 'edit', move: 'edit', delete: 'delete', search: 'search', execute: 'execute', fetch: 'fetch', think: 'think',
};
export const mapToolKind = (k: unknown): ToolKindT => (typeof k === 'string' && TOOL_KIND[k]) || 'other';

/** 工具的目标：locations[0].path，没有时依次取 rawInput.command / file_path / path */
export function toolTarget(u: Record<string, unknown>): string | null {
  if (Array.isArray(u.locations)) {
    const l = u.locations.find(isRecord);
    if (l && typeof l.path === 'string') return l.path;
  }
  const ri = u.rawInput;
  if (isRecord(ri)) {
    const cmd = ri.command;
    if (typeof cmd === 'string') return cmd;
    if (Array.isArray(cmd) && cmd.every((x) => typeof x === 'string')) return cmd.join(' ');
    if (typeof ri.file_path === 'string') return ri.file_path;
    if (typeof ri.path === 'string') return ri.path;
  }
  return null;
}

/** 内容块 → 文本：图片、资源块写成占位文字 */
export function blockText(c: unknown): string | null {
  if (!isRecord(c)) return null;
  switch (c.type) {
    case 'text': return typeof c.text === 'string' ? c.text : null;
    case 'image': return '[图片]';
    case 'audio': return '[音频]';
    case 'resource_link': return `[附件：${str(c.name) ?? str(c.title) ?? str(c.uri) ?? '未命名'}]`;
    case 'resource': {
      const r = isRecord(c.resource) ? c.resource : {};
      return `[附件：${str(r.uri) ?? '未命名'}]`;
    }
    default: return null;
  }
}

const lines = (s: unknown) => (typeof s === 'string' && s.length ? s.split(/\r?\n/) : []);

/** diff 块：只写“修改 <path>（+a −b）”，正文留给 1.3 的 diff 面板。行数按去掉相同的开头和结尾后统计 */
function diffSummary(d: Record<string, unknown>): string {
  const a = lines(d.oldText);
  const b = lines(d.newText);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  return `修改 ${str(d.path) ?? '文件'}（+${b.length - p - q} −${a.length - p - q}）`;
}

const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed']);

export interface MapperHooks {
  unknown(type: string): void;
  thought(): void;
  commands(names: string[]): void;
  mode(modeId: string): void;
  configOptions(update: Record<string, unknown>): void;
  sessionInfo(update: Record<string, unknown>): void;
}

interface ToolState { id: string; ended: boolean; rejected: boolean; title?: string; target?: string | null; toolKind?: ToolKindT }

/** 一个会话一个 mapper：维护消息段、工具 ID、被拒绝过的工具 */
export class UpdateMapper {
  /** 回放期间（session/load）的 update 全部丢弃 */
  replaying = false;
  private msgId: string | null = null;
  private agentMsgId: string | null = null;
  private thoughtId: string | null = null;
  private tools = new Map<string, ToolState>();
  private seq = 0;

  constructor(private tag: string, private emit: (u: AgentUpdate) => void, private hooks: MapperHooks) {}

  /** toolCallId → 本会话内唯一、长度可控的 toolId */
  private tool(toolCallId: string): ToolState {
    let t = this.tools.get(toolCallId);
    if (!t) {
      t = { id: `tc_${this.tag}_${++this.seq}`, ended: false, rejected: false };
      this.tools.set(toolCallId, t);
    }
    return t;
  }

  /** 结束正在输出的回复段（补发 message_done），思考段也一并结束 */
  private closeText(keep?: 'message' | 'thought') {
    if (keep !== 'message' && this.msgId) {
      this.emit({ kind: 'message_done', messageId: this.msgId });
      this.msgId = null;
      this.agentMsgId = null;
    }
    if (keep !== 'thought') this.thoughtId = null;
  }

  markRejected(toolCallId: string) { this.tool(toolCallId).rejected = true; }

  /** 权限请求里带的工具没见过时，先补一条 tool_start */
  ensureTool(toolCall: Record<string, unknown>) {
    const id = str(toolCall.toolCallId);
    if (!id || this.tools.has(id)) return;
    this.closeText();
    const t = this.tool(id);
    Object.assign(t, { toolKind: mapToolKind(toolCall.kind), title: str(toolCall.title) ?? '工具调用', target: toolTarget(toolCall) });
          this.emit({ kind: 'tool_start', toolId: t.id, toolKind: t.toolKind!, title: t.title!, target: t.target ?? null });
  }

  handle(update: Record<string, unknown>) {
    this.emit({ kind: 'activity' });
    const type = str(update.sessionUpdate);
    if (!type) return;
    if (type === 'session_info_update') { this.hooks.sessionInfo(update); return; }
    if (this.replaying) return;
    switch (type) {
      case 'agent_message_chunk': {
        const text = blockText(update.content);
        if (text === null || text === '') return;
        const mid = str(update.messageId);
        if (this.msgId && mid && this.agentMsgId && mid !== this.agentMsgId) this.closeText();
        this.closeText('message');
        if (!this.msgId) { this.msgId = newId('m'); this.agentMsgId = mid; }
        this.emit({ kind: 'message', messageId: this.msgId, text });
        return;
      }
      case 'agent_thought_chunk': {
        const text = blockText(update.content);
        if (text === null || text === '') return;
        this.closeText('thought');
        if (!this.thoughtId) this.thoughtId = newId('th');
        this.hooks.thought();
        this.emit({ kind: 'thought', messageId: this.thoughtId, text });
        return;
      }
      case 'user_message_chunk': return; // 用户消息已由 Gateway 记录
      case 'tool_call': {
        const id = str(update.toolCallId);
        if (!id) return;
        this.closeText();
        const existed = this.tools.has(id);
        const t = this.tool(id);
        if (!existed) {
          Object.assign(t, { toolKind: mapToolKind(update.kind), title: str(update.title) ?? '工具调用', target: toolTarget(update) });
          this.emit({ kind: 'tool_start', toolId: t.id, toolKind: t.toolKind!, title: t.title!, target: t.target ?? null });
        }
        this.toolContent(t, update);
        this.toolStatus(t, update.status);
        return;
      }
      case 'tool_call_update': {
        const id = str(update.toolCallId);
        if (!id) return;
        const seen = this.tools.has(id);
        const t = this.tool(id);
        if (!seen) {
          this.closeText();
          Object.assign(t, { toolKind: mapToolKind(update.kind), title: str(update.title) ?? '工具调用', target: toolTarget(update) });
          this.emit({ kind: 'tool_start', toolId: t.id, toolKind: t.toolKind!, title: t.title!, target: t.target ?? null });
        }
        if (seen) {
          const changes: { title?: string; target?: string | null; toolKind?: ToolKindT } = {};
          if (typeof update.title === 'string' && update.title !== t.title) changes.title = update.title;
          if (('locations' in update || 'rawInput' in update) && toolTarget(update) !== t.target) changes.target = toolTarget(update);
          if (typeof update.kind === 'string' && mapToolKind(update.kind) !== t.toolKind) changes.toolKind = mapToolKind(update.kind);
          if (Object.keys(changes).length) { Object.assign(t, changes); this.emit({ kind: 'tool_update', toolId: t.id, ...changes }); }
        }
        this.toolContent(t, update);
        this.toolStatus(t, update.status);
        return;
      }
      case 'plan': {
        this.closeText();
        const entries = Array.isArray(update.entries) ? update.entries.filter(isRecord) : [];
        this.emit({
          kind: 'plan',
          items: entries.map((e) => ({
            text: str(e.content) ?? '',
            status: (PLAN_STATUS.has(String(e.status)) ? e.status : 'pending') as 'pending' | 'in_progress' | 'completed',
          })),
        });
        return;
      }
      case 'usage_update': {
        const used = Number(update.used);
        const size = Number(update.size);
        if (!Number.isFinite(used) || !Number.isFinite(size)) return;
        const cost = isRecord(update.cost) && Number.isFinite(Number(update.cost.amount))
          ? { amount: Number(update.cost.amount), currency: str(update.cost.currency) ?? 'USD' } : undefined;
        this.emit({ kind: 'usage', used: Math.max(0, used), size: Math.max(0, size), ...(cost ? { cost } : {}) });
        return;
      }
      case 'current_mode_update': {
        const m = str(update.currentModeId) ?? str(update.modeId);
        if (m) this.hooks.mode(m);
        return;
      }
      case 'config_option_update': this.hooks.configOptions(update); return;
      case 'available_commands_update': {
        const cmds = Array.isArray(update.availableCommands) ? update.availableCommands : [];
        this.hooks.commands(cmds.filter(isRecord).map((c) => str(c.name)).filter((n): n is string => !!n));
        return;
      }
      default:
        this.hooks.unknown(type);
    }
  }

  private toolContent(t: ToolState, u: Record<string, unknown>) {
    if (!Array.isArray(u.content)) return;
    for (const c of u.content) {
      if (!isRecord(c)) continue;
      if (c.type === 'content') {
        const text = blockText(c.content);
        if (text) this.emit({ kind: 'tool_output', toolId: t.id, text });
      } else if (c.type === 'diff') {
        this.emit({ kind: 'tool_output', toolId: t.id, text: diffSummary(c) });
      }
      // terminal 块不会出现（没有声明 terminal 能力）
    }
  }

  private toolStatus(t: ToolState, status: unknown) {
    if (t.ended) return;
    if (status === 'completed') {
      t.ended = true;
      this.emit({ kind: 'tool_end', toolId: t.id, ok: true, summary: null });
    } else if (status === 'failed') {
      t.ended = true;
      this.emit(t.rejected
        ? { kind: 'tool_end', toolId: t.id, ok: false, summary: '已拒绝，没有执行', rejected: true }
        : { kind: 'tool_end', toolId: t.id, ok: false, summary: '执行失败' });
    }
  }

  /** 回合结束：补发 message_done，把没收尾的工具收尾（界面不会留下一直在转的卡片） */
  endTurn(reason: 'end_turn' | 'cancelled' | 'error') {
    this.closeText();
    for (const t of this.tools.values()) {
      if (t.ended) continue;
      t.ended = true;
      if (t.rejected) this.emit({ kind: 'tool_end', toolId: t.id, ok: false, summary: '已拒绝，没有执行', rejected: true });
      // 正常结束的回合里没有收到最终状态的工具按完成处理；取消和出错时按未完成处理
      else if (reason === 'end_turn') this.emit({ kind: 'tool_end', toolId: t.id, ok: true, summary: null });
      else this.emit({ kind: 'tool_end', toolId: t.id, ok: false, summary: reason === 'cancelled' ? '已取消' : '出错' });
    }
  }
}
