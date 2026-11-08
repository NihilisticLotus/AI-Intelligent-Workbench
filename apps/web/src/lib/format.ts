// 文案与格式化：状态、权限级别、工具动词、时间。界面上的中文说法集中在这里，保持一致。
import type { AgentKind, PermissionLevel, TaskStatus } from '@aic/protocol';

/** 状态形状：run 脉冲圆点、wait 菱形、ok 圆点、err 方块、idle 空心圈（状态不只靠颜色） */
export type StatusShape = 'run' | 'wait' | 'ok' | 'err' | 'idle';

export const taskStatusText: Record<TaskStatus, [string, StatusShape]> = {
  draft: ['草稿', 'idle'],
  queued: ['排队中', 'idle'],
  running: ['运行中', 'run'],
  waiting: ['等待审批', 'wait'],
  paused: ['已暂停', 'idle'],
  review: ['待验收', 'ok'],
  merged: ['已合并', 'ok'],
  discarded: ['已丢弃', 'idle'],
  failed: ['失败', 'err'],
  interrupted: ['已中断', 'err'],
};

export interface PermInfo { label: string; desc: string; icon: string; level: string }
export const permInfo: Record<PermissionLevel, PermInfo> = {
  readonly: { label: '只读', desc: '只能读文件和搜索，任何修改和命令都拒绝', icon: 'eye', level: 'ro' },
  ask: { label: '需审批', desc: '读操作自动允许；修改文件、执行命令都要你确认', icon: 'shield', level: 'ask' },
  workspace: { label: '工作区内自动', desc: '工作区内的修改和常见命令自动允许，只有越界操作才问你', icon: 'shieldcheck', level: 'ws' },
  full: { label: '全自动', desc: '除“始终禁止”清单外全部放行，建议只用在可以随时丢弃的任务上', icon: 'unlock', level: 'full' },
};
export const permOrder: PermissionLevel[] = ['readonly', 'ask', 'workspace', 'full'];

export const toolVerb: Record<string, string> = {
  read: '读取', search: '搜索', edit: '修改', create: '新建', delete: '删除',
  execute: '执行', fetch: '获取', think: '思考', other: '操作',
};

/** 没拿到 /agents 时的兜底名称与字母徽标 */
export const agentFallback: Record<AgentKind, { name: string; mono: string }> = {
  fake: { name: '演示 Agent', mono: 'D' },
  claude: { name: 'Claude Code', mono: 'C' },
  codex: { name: 'Codex', mono: 'X' },
  codebuddy: { name: 'CodeBuddy', mono: 'B' },
  zcode: { name: 'ZCode', mono: 'Z' },
  workbuddy: { name: 'WorkBuddy', mono: 'W' },
  independent: { name: 'AI Console 独立 Agent', mono: 'A' },
};

/** 相对时间：“刚刚 / 5 分钟 / 3 小时 / 昨天 / 4 天” */
export function ago(ts: number, now = Date.now()): string {
  const m = Math.max(0, (now - ts) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${Math.round(m)} 分钟`;
  if (m < 1440) return `${Math.round(m / 60)} 小时`;
  if (m < 2880) return '昨天';
  return `${Math.round(m / 1440)} 天`;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 消息头部时间：今天只显示时分，其余带日期 */
export function clock(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === n.toDateString()) return `今天 ${hm}`;
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

export function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${s % 60} 秒`;
}

/** 浏览器的设备名：用于配对时告诉 Gateway 这是哪台设备 */
export function guessDeviceName(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '浏览器';
  return `${b} 浏览器（本机）`;
}
