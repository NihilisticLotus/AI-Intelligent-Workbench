// 跨组件的“请聚焦某个审批卡片”请求：侧栏“等你处理”、待审批条、Ctrl+Shift+A 都用它。
// 审批到来时不会自动抢焦点（ui-design.md 6.3），只有用户主动跳转时才聚焦。
import { createStore } from '../state/store';

export const focusApprovalStore = createStore<{ id: string; n: number } | null>(null);
let n = 0;
export function requestFocusApproval(id: string) {
  focusApprovalStore.set(() => ({ id, n: ++n }));
}
