import { useId } from 'react';
import type { SessionCfg } from '../state/core';
import { ringState } from '../lib/usage';
import { openDetail } from '../state/details';

export function ContextRing({ usage }: { usage: SessionCfg['usage'] }) {
  const ring = ringState(usage), id = useId();
  return <span className="context-ring-wrap">
    <button type="button" className={'context-ring ' + ring.tone} aria-label={ring.text + '，查看上下文详细信息'} aria-describedby={id} onClick={() => openDetail('context')}>
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true"><circle className="track" cx="10" cy="10" r="8" fill="none" strokeWidth="2" />
        {ring.tone !== 'unknown' ? <circle className="progress" cx="10" cy="10" r="8" fill="none" strokeWidth="2" pathLength="100" strokeDasharray={`${ring.progress} 100`} transform="rotate(-90 10 10)" /> : null}
      </svg>
    </button><span className="usage-tip" role="tooltip" id={id}>{ring.text}</span>
  </span>;
}
