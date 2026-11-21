import { useEffect, useState, type FormEvent } from 'react';
import type { ApiError, LanPairingStatus } from '@aic/protocol';
import { ApiRequestError, toApiError } from '../api/http';
import { ErrorNotice } from '../components/ui';
import { localDeadline, pairingResultMessage, pollingOutcome } from '../lib/lan-access';
import { useCountdown } from '../lib/use-countdown';
import { api, finishLanPairing, submitLanPairing, useApp } from '../state/app';

export function LanPairingPage() {
  const initial = useApp((s) => s.initialPairCode);
  const [code, setCode] = useState(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: string; deadline: number } | null>(null);
  const [retryDeadline, setRetryDeadline] = useState<number>();
  const remaining = useCountdown(pending?.deadline);
  const retry = useCountdown(retryDeadline);

  useEffect(() => {
    const request = pending;
    if (!request) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: keyof typeof pairingResultMessage) => {
      setPending(null);
      setError(null);
      setCode('');
      setMessage(pairingResultMessage[status]);
    };
    async function poll() {
      let result: LanPairingStatus | null = null;
      try {
        result = await api.lanPairingStatus(request!.id);
        if (!active) return;
        if (result.status === 'paired') {
          setError(null);
          await finishLanPairing(result);
          return;
        }
        setError(null);
      } catch (failure) {
        if (!active) return;
        if (failure instanceof ApiRequestError && failure.status === 404) { finish('unavailable'); return; }
        setError(toApiError(failure));
      }
      if (!active) return;
      const next = pollingOutcome(result, request!.deadline);
      if (next !== 'pending' && next !== 'paired') { finish(next); return; }
      timer = setTimeout(() => void poll(), 1000);
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [pending]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || retry || !/^\d{6}$/.test(code)) return;
    setBusy(true);
    setError(null);
    setRetryDeadline(undefined);
    setMessage('');
    try {
      const response = await submitLanPairing(code);
      setPending({ id: response.id, deadline: localDeadline(response.expiresAt, response.serverTime) });
    } catch (failure) {
      const problem = toApiError(failure);
      setError(problem);
      if (problem.retryAt !== undefined) setRetryDeadline(localDeadline(problem.retryAt, problem.serverTime));
    }
    finally { setBusy(false); }
  };

  return <main className="pair-page lan-pair-page">
    <div className="pair-card">
      <span className="brand"><span className="brand-mark" aria-hidden="true">AI</span>AI Console</span>
      <h1>{pending ? '请在电脑上确认' : '连接电脑上的 AI Console'}</h1>
      {pending ? <>
        <p role="status">配对请求已发出。请在电脑上的工作台点击“允许”。</p>
        <p>剩余 {remaining} 秒</p>
      </> : <>
        <p>在电脑的“设置 → 设备与访问”中点击“配对新设备”，把六位配对码填在这里。</p>
        {message ? <p className="lan-pair-result" role="alert">{message}</p> : null}
        <form className="lan-pair-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="lan-pair-code">六位配对码</label>
          <input id="lan-pair-code" className="input code-input" autoComplete="one-time-code" inputMode="numeric" maxLength={6}
            value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} disabled={busy}
            aria-invalid={error ? true : undefined} />
          <button type="submit" className="btn primary" disabled={busy || retry > 0 || !/^\d{6}$/.test(code)} aria-busy={busy}>
            {busy ? '正在提交…' : '配对'}
          </button>
        </form>
      </>}
      {error ? <ErrorNotice error={retryDeadline !== undefined ? { ...error, hint: retry ? `请 ${retry} 秒后再试` : '现在可以重新配对' } : error} /> : null}
    </div>
  </main>;
}
