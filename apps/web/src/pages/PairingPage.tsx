// 配对页：没有有效令牌时显示。
// - 提示“请从 AI Console 启动脚本打开”（启动脚本会带上一次性配对码自动打开浏览器）
// - [重新生成配对码]：调用 POST /pairing/start（Gateway 只接受本机请求），新配对码打印在终端窗口里
// - 然后在这里输入配对码完成配对
import { useState } from 'react';
import type { ApiError } from '@aic/protocol';
import { completePairing, requestPairingCode, useApp } from '../state/app';
import { ErrorNotice } from '../components/ui';

export function PairingPage() {
  const requested = useApp((s) => s.pairRequested);
  const bootError = useApp((s) => s.bootError);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const regen = async () => {
    setBusy(true);
    setErr(await requestPairingCode());
    setBusy(false);
  };
  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    const e = await completePairing(code);
    if (e) { setErr(e); setBusy(false); }
  };
  const shown = err ?? (bootError && bootError.code !== 'auth.unauthorized' ? bootError : null);

  return (
    <main className="pair-page">
      <div className="pair-card">
        <span className="brand"><span className="brand-mark" aria-hidden="true">AI</span>AI Console</span>
        <h1>{requested ? '看终端窗口里的配对码' : '请从 AI Console 启动脚本打开'}</h1>
        {requested ? (
          <p>配对码已经打印在运行 AI Console 的那个黑色窗口里，2 分钟内有效。把它输入到下面。
            之前的配对码还没过期时，窗口里会再显示一次同一个码。</p>
        ) : (
          <p>为了安全，只有通过启动脚本打开的浏览器才能直接进入。双击“启动 AI Console”，它会自动打开这个页面。
            如果服务已经在运行，也可以点下面的按钮生成一个新的配对码。</p>
        )}
        {shown ? <ErrorNotice error={shown} /> : null}
        {requested ? (
          <>
            <label htmlFor="pair-code" className="sr-only">配对码</label>
            <input id="pair-code" className="input code-input" autoFocus autoComplete="one-time-code" inputMode="text" maxLength={16}
              value={code} placeholder="配对码" onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void submit(); }} />
            <div className="row">
              <button type="button" className="btn primary" disabled={!code.trim()} aria-busy={busy} onClick={submit}>配对</button>
              <button type="button" className="btn ghost" disabled={busy} onClick={regen}>重新生成配对码</button>
            </div>
          </>
        ) : (
          <div className="row">
            <button type="button" className="btn primary" aria-busy={busy} onClick={regen}>重新生成配对码</button>
          </div>
        )}
      </div>
    </main>
  );
}
