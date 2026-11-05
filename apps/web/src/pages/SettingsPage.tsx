// 设置：外观（日间 / 夜间）、思考过程默认显示方式、设备列表（可吊销）、关于。
import { useEffect, useState } from 'react';
import type { ApiError, Device } from '@aic/protocol';
import { loadDevices, revokeDevice, useApp } from '../state/app';
import { setPref, usePref, type ThoughtMode } from '../state/prefs';
import { ago } from '../lib/format';
import { ErrorNotice, asApiError, confirmDialog, toastErrorOf } from '../components/ui';
import { Icon } from '../components/Icon';
import { toast } from '../state/ui';

export function SettingsPage() {
  const theme = usePref('theme');
  const thought = usePref('thought');
  const devices = useApp((s) => s.devices);
  const hello = useApp((s) => s.hello);
  const [err, setErr] = useState<ApiError | null>(null);
  const load = () => { setErr(null); loadDevices().catch((e) => setErr(asApiError(e))); };
  useEffect(load, []);

  const revoke = async (d: Device) => {
    const ok = await confirmDialog({
      title: `吊销“${d.name}”？`, ok: '吊销', danger: true,
      body: d.current
        ? <p style={{ margin: 0 }}>这就是你正在用的这台设备。吊销后这个页面会立刻失去访问权限，需要从 AI Console 启动脚本重新打开并配对。</p>
        : <p style={{ margin: 0 }}>这台设备会立刻失去访问权限，要再用需要重新配对。</p>,
    });
    if (!ok) return;
    try { await revokeDevice(d.id); toast(`已吊销“${d.name}”`); } catch (e) { toastErrorOf(e); }
  };

  return (
    <main className="main">
      <header className="main-head"><h1>设置</h1></header>
      <div className="content-scroll">
        <div className="page">
          <section className="set-sec" aria-labelledby="s-look">
            <h3 id="s-look">外观</h3>
            <div className="set-row">
              <span className="lbl" id="s-theme">日间 / 夜间</span>
              <div className="radios" role="radiogroup" aria-labelledby="s-theme">
                <label><input type="radio" name="theme" checked={theme === 'dark'} onChange={() => setPref('theme', 'dark')} /><Icon name="moon" />夜间（默认）</label>
                <label><input type="radio" name="theme" checked={theme === 'light'} onChange={() => setPref('theme', 'light')} /><Icon name="sun" />日间</label>
              </div>
            </div>
            <div className="set-row">
              <span className="lbl" id="s-th">思考过程<span className="note">Agent 提供思考内容时的显示方式</span></span>
              <div className="radios" role="radiogroup" aria-labelledby="s-th">
                {([['collapsed', '默认折叠（推荐）'], ['expanded', '默认展开'], ['hidden', '不显示']] as Array<[ThoughtMode, string]>).map(([k, l]) => (
                  <label key={k}><input type="radio" name="thought" checked={thought === k} onChange={() => setPref('thought', k)} />{l}</label>
                ))}
              </div>
            </div>
            <p style={{ margin: 'var(--sp-2) 0 0', fontSize: 'var(--fs-12)', color: 'var(--fg-3)' }}>这些设置只保存在这台设备上。</p>
          </section>

          <section className="set-sec" aria-labelledby="s-dev">
            <h3 id="s-dev">设备</h3>
            <p style={{ margin: '0 0 var(--sp-3)', fontSize: 'var(--fs-13)', color: 'var(--fg-2)' }}>
              能访问这台电脑上 AI Console 的设备。目前只能从这台电脑访问；局域网访问在第 1.5 步提供。
            </p>
            {err ? <ErrorNotice error={err} onRetry={load} /> : null}
            {devices === null && !err ? <p style={{ color: 'var(--fg-3)' }}>正在载入…</p> : null}
            <ul className="device-list">
              {devices?.map((d) => (
                <li key={d.id}>
                  <Icon name="devices" />
                  <div className="info">
                    <b>{d.name}{d.current ? '（这台设备）' : ''}</b>
                    <span>配对于 {new Date(d.pairedAt).toLocaleDateString('zh-CN')}{d.lastSeen ? `，最近使用 ${ago(d.lastSeen)}前`.replace('刚刚前', '刚刚') : ''}{d.lastIp ? `，${d.lastIp}` : ''}</span>
                  </div>
                  <button type="button" className="btn sm danger" onClick={() => void revoke(d)} aria-label={`吊销 ${d.name}`}>吊销</button>
                </li>
              ))}
            </ul>
          </section>

          {hello ? (
            <section className="set-sec" aria-labelledby="s-about">
              <h3 id="s-about">关于</h3>
              <dl className="ctx">
                <dt>服务版本</dt><dd>{hello.version}（协议 {hello.protocol}）</dd>
                <dt>这台电脑</dt><dd>{hello.machine.name}</dd>
                <dt>当前设备</dt><dd>{hello.device.name}</dd>
              </dl>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
