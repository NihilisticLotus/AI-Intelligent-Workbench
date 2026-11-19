import { useEffect, useState } from 'react';
import type { ApiError } from '@aic/protocol';
import { ApiRequestError, toApiError } from '../api/http';
import { operationLabel, type AccessPrompt } from '../lib/lan-access';
import { useCountdown } from '../lib/use-countdown';
import { accessPromptStore, api, dismissAccessPrompt, useRemoteAccess } from '../state/app';
import { useStore } from '../state/store';
import { Dialog, ErrorNotice } from './ui';

export function AccessPrompts() {
  const first = useStore(accessPromptStore, (items) => items[0]);
  const remote = useRemoteAccess();
  return first && !remote ? <PromptDialog key={first.request.id} prompt={first} /> : null;
}

function PromptDialog({ prompt }: { prompt: AccessPrompt }) {
  const { id, ip, expiresAt } = prompt.request;
  const remaining = useCountdown(expiresAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => { if (!remaining) dismissAccessPrompt(id); }, [id, remaining]);

  const decide = async (allow: boolean) => {
    if (busy || !remaining) return;
    setBusy(true);
    setError(null);
    try {
      if (prompt.kind === 'pairing') await api.decideLanPairing(id, allow);
      else await api.decideRemoteAction(id, allow);
      dismissAccessPrompt(id);
    } catch (failure) {
      if (failure instanceof ApiRequestError && failure.status === 409) dismissAccessPrompt(id);
      else setError(toApiError(failure));
    } finally { setBusy(false); }
  };

  return <Dialog title={prompt.kind === 'pairing' ? '有新设备请求连接' : '确认远程操作'} className="lan-dialog"
    onClose={() => void decide(false)} initialFocus="[data-reject]" footer={<>
      <button type="button" className="btn" data-reject disabled={busy || !remaining} onClick={() => void decide(false)}>拒绝</button>
      <button type="button" className="btn primary" disabled={busy || !remaining} onClick={() => void decide(true)}>允许</button>
    </>}>
    <dl className="ctx lan-facts">
      <dt>设备</dt><dd>{prompt.kind === 'pairing' ? prompt.request.name : prompt.request.deviceName}</dd>
      {prompt.kind === 'pairing' ? <><dt>浏览器</dt><dd>{prompt.request.browser}</dd></> : <>
        <dt>操作</dt><dd>{operationLabel[prompt.request.operation]}</dd>
        <dt>对象</dt><dd>{prompt.request.objectName || prompt.request.objectId || '当前工作台'}</dd>
      </>}
      <dt>IP</dt><dd>{ip}</dd>
      <dt>剩余时间</dt><dd>{remaining} 秒</dd>
    </dl>
    {error ? <ErrorNotice error={error} /> : null}
  </Dialog>;
}
