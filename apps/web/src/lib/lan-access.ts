import type { AccessOperation, AccessPrompt, EventEnvelope, Hello, LanInterface, LanPairingStatus, LanState } from '@aic/protocol';
export type { AccessPrompt } from '@aic/protocol';

export function isLanHostname(hostname: string): boolean {
  return !!hostname && !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname.toLowerCase());
}

export function isRemoteAccess(hello: Hello | null): boolean {
  return hello?.lanConnection === true || hello?.device.source === 'lan';
}

export function pairCodeFromHash(hash: string): string | null {
  return new URLSearchParams(hash.replace(/^#/, '')).get('pair');
}

export function secondsUntil(time: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((time - now) / 1000));
}

/** 服务端返回剩余时长的两个端点，换算到手机时钟。旧服务只提供绝对截止时间。 */
export function localDeadline(expiresAt: number, serverTime?: number, receivedAt = Date.now()): number {
  return serverTime === undefined ? expiresAt : receivedAt + Math.max(0, expiresAt - serverTime);
}

/** 服务端仍回复等待时继续等：手机与电脑的时钟可能不一致，只有查询失败时才按本地时钟判超时。 */
export function pollingOutcome(result: LanPairingStatus | null, deadline: number, now = Date.now()): LanPairingStatus['status'] {
  if (result) return result.status;
  return deadline <= now ? 'expired' : 'pending';
}

export const pairingResultMessage: Record<Exclude<LanPairingStatus['status'], 'paired' | 'pending'>, string> = {
  rejected: '电脑上拒绝了配对。要再试，请在电脑上获取新的配对码。',
  expired: '配对确认超时。请在电脑上获取新的配对码。',
  unavailable: '电脑上的工作台已断开。请打开工作台并重新配对。',
  claimed: '这条配对请求已经用过。请在电脑上获取新的配对码。',
};

export function networkChoice(state: LanState, previous: LanInterface | null): LanInterface | null {
  return state.selected
    ?? state.interfaces.find((item) => previous && item.name === previous.name && item.address === previous.address)
    ?? (state.interfaces.length === 1 ? state.interfaces[0]! : null);
}

export const networkCategory: Record<LanInterface['category'], string> = {
  private: '专用网络', public: '公用网络', domain: '域网络', unknown: '未知网络',
};

export const firewallLabel: Record<LanState['firewall'], string> = {
  missing: '未安装规则', matched: '防火墙规则正常', mismatch: '防火墙规则需要更新', unknown: '无法读取防火墙规则',
};

/** 开关按“用户是否要求开启”显示：启动时没能恢复的局域网仍算开启，关掉后重启才不会自动再开。 */
export function lanSwitchOn(state: LanState): boolean {
  return state.enabled || state.requested;
}

export function lanStatusText(state: LanState): string {
  if (state.enabled) return '已开启';
  return state.requested ? '已开启，暂未生效' : '已关闭，只有这台电脑能访问';
}

export function canToggleLan(state: LanState | null, choice: LanInterface | null, remote: boolean): boolean {
  return !!state && !remote && (lanSwitchOn(state) || choice?.category === 'private');
}

export const operationLabel: Record<AccessOperation, string> = {
  'task.permission': '开启自动权限', 'project.permissions': '修改项目权限规则', 'project.delete': '删除项目', 'device.revoke': '吊销设备',
  'workspace.merge': '合并改动', 'workspace.apply': '应用改动', 'workspace.rollback': '回滚工作副本', 'workspace.discard': '丢弃工作副本',
  'workspace.restore_file': '还原文件', 'workspace.delete_task': '删除任务和工作副本', 'workspace.restore_handoff': '恢复交接检查点',
};

export function updateAccessPrompts(current: AccessPrompt[], event: EventEnvelope, now = Date.now()): AccessPrompt[] {
  if (event.type === 'pairing.resolved' || event.type === 'access.confirm_resolved') return current.filter(({ request }) => request.id !== event.data.id);
  if (event.type !== 'pairing.requested' && event.type !== 'access.confirm_requested') return current;
  if (event.data.expiresAt <= now || current.some(({ request }) => request.id === event.data.id)) return current;
  return event.type === 'pairing.requested'
    ? [...current, { kind: 'pairing', request: event.data }]
    : [...current, { kind: 'operation', request: event.data }];
}
