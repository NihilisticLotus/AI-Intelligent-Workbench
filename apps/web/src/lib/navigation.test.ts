import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@aic/protocol';
import { buildTimeline, groupTurns, type TurnItem } from '../state/core';
import { currentNavigationIndex, navigationItems, navigationKey, navigationMotion } from './navigation';

describe('对话导航', () => {
  it('从稳定轮次 key 生成长短刻度、预览和待审批标记，状态变化后更新', () => {
    const events = [
      { type: 'message.user', data: { messageId: 'u1', text: '第一条\n消息' } },
      { type: 'message.done', data: { messageId: 'a1', text: '回答' } },
      { type: 'message.user', data: { messageId: 'u2', text: '第二条' } },
      { type: 'message.delta', data: { messageId: 'a2', text: '正在检查' } },
    ].map((e, i) => ({ ...e, seq: i + 1, ts: (i + 1) * 1000, taskId: 't1', sessionId: 's1' })) as EventEnvelope[];
    const view = groupTurns(buildTimeline(events));
    expect(navigationItems(view).map((x) => [x.key,x.kind,x.text])).toEqual([
      ['u:u1','user','第一条 消息'],['turn:m:a1','turn','回答'],['u:u2','user','第二条'],['turn:m:a2','turn','正在检查'],
    ]);
    const turn = view.at(-1) as TurnItem;
    expect(navigationItems([{...turn,pendingApproval:true}])[0]?.kind).toBe('attn');
    expect(navigationItems([{...turn,pendingApproval:false}])[0]?.kind).toBe('turn');
    expect(navigationItems([{...turn,answer:null,steps:[],done:false}])[0]?.text).toBe('正在回复…');
    expect(navigationItems([{...turn,answer:null,steps:[],done:true}])[0]?.text).toBe('本轮处理已结束');
  });
  it('当前位置取上方三分之一，到底即最后一项；空列表与短内容稳定', () => {
    expect(currentNavigationIndex([20,200,600],0,300,1200)).toBe(0);
    expect(currentNavigationIndex([20,200,600],200,300,1200)).toBe(1);
    expect(currentNavigationIndex([20,200,600],897,300,1200)).toBe(2);
    expect(currentNavigationIndex([],0,300,300)).toBe(-1);
    expect(currentNavigationIndex([10,80],0,300,300)).toBe(1);
  });
  it('方向键和首尾键限制在刻度范围，其他键保留原行为', () => {
    expect(['ArrowDown','ArrowUp','Home','End','Enter','Escape'].map((k)=>navigationKey(k,1,4))).toEqual([2,0,0,3,null,null]);
    expect(navigationKey('ArrowUp',0,4)).toBe(0); expect(navigationKey('ArrowDown',3,4)).toBe(3); expect(navigationKey('Home',0,0)).toBeNull();
  });
  it('减少动态效果时即时定位且不闪烁', () => {
    expect(navigationMotion(true)).toEqual({behavior:'instant',flash:false});
    expect(navigationMotion(false)).toEqual({behavior:'smooth',flash:true});
  });
});
