// 已验证版本表（phase-1.md 6.2.4、design.md 6.3）：不在表里的组合照常使用，但卡片标黄“未验证版本”。
import type { AgentKind } from '@aic/protocol';

export const VERIFIED: Partial<Record<AgentKind, { adapter: string | null; engine: string | null }[]>> = {
  claude: [{ adapter: '0.100.0', engine: '2.1.316' }],
  codex: [{ adapter: '2.5.0', engine: '0.165.0' }],
  codebuddy: [{ adapter: null, engine: '2.115.0' }],
};

export function isVerified(kind: AgentKind, adapter: string | null | undefined, engine: string | null | undefined): boolean {
  const list = VERIFIED[kind];
  if (!list) return false;
  return list.some((v) => (v.adapter === null || v.adapter === adapter) && (v.engine === null || v.engine === engine));
}
