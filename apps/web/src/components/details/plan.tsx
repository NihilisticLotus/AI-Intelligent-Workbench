import type { EventOf } from '@aic/protocol';
import { PlanList } from '../Chat';
export function PlanDetails({ plan }: { plan: EventOf<'plan.update'> | null }) {
  return plan ? <PlanList items={plan.data.items} /> : <p className="d-note">还没有计划。Agent 报告步骤后会在这里显示。</p>;
}
