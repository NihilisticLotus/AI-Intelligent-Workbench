import type { AgentKind, HandoffTarget } from '@aic/protocol';
import { createStore, useStore } from './store';

const pending = createStore<Record<string, HandoffTarget | undefined>>({});
const submitting=createStore<Record<string,boolean>>({});
export function setHandoffSending(id:string,value:boolean) {
  submitting.set(all=>({...all,[id]:value}));
}
export function useHandoffSending(id:string) {
  return useStore(submitting,all=>!!all[id]);
}
export function nextTarget(current: AgentKind, choice?: HandoffTarget) {
  return choice?.agent !== current ? choice : undefined;
}
export function selectTarget(taskId: string, current: AgentKind, choice?: HandoffTarget) {
  pending.set(all => ({ ...all, [taskId]: nextTarget(current, choice) }));
}
export function useTarget(taskId: string, current: AgentKind) {
  return useStore(pending, all => nextTarget(current, all[taskId]));
}
