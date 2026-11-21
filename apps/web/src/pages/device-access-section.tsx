import { useEffect, useRef, useState } from 'react';
import { FeatureKey, type AccessAuditEntry, type ApiError, type Device, type LanInterface, type LanPairingCode, type LanState } from '@aic/protocol';
import { asApiError, confirmDialog, ErrorNotice, toastErrorOf } from '../components/ui';
import { Icon } from '../components/Icon';
import { ago } from '../lib/format';
import { canToggleLan, firewallLabel, lanStatusText, lanSwitchOn, networkCategory, networkChoice, operationLabel } from '../lib/lan-access';
import { useCountdown } from '../lib/use-countdown';
import { platform } from '../platform';
import { api, lanSuspendedSeq, loadDevices, pairingUsedSeq, revokeDevice, useApp, useRemoteAccess } from '../state/app';
import { useStore } from '../state/store';
import { setPref, usePref } from '../state/prefs';
import { toast } from '../state/ui';

interface LanControlsProps {
  state: LanState;
  choice: LanInterface | null;
  remote: boolean;
  busy: boolean;
  onSelect: (choice: LanInterface) => void;
  onToggle: () => void;
  onUpdate: () => void;
}

export function LanControls({ state, choice, remote, busy, onSelect, onToggle, onUpdate }: LanControlsProps) {
  const selectedIndex = state.interfaces.findIndex((item) => item.name === choice?.name && item.address === choice?.address);
  const on = lanSwitchOn(state);
  const leftover = !on && state.firewall === 'mismatch';
  return <>
    <div className="set-row">
      <span className="lbl" id="lan-state-label">局域网访问</span>
      <div className="lan-row">
        {!remote ? <button type="button" role="switch" className="switch lan-switch" aria-labelledby="lan-state-label" aria-checked={on}
          disabled={busy || !canToggleLan(state, choice, remote)} onClick={onToggle} /> : null}
        <span role={busy ? 'status' : undefined}>{busy ? '正在处理…' : lanStatusText(state)}</span>
      </div>
    </div>
    {remote ? <div className="set-row"><span className="lbl">电脑上的网卡</span><span>{state.selected ? `${state.selected.name} · ${networkCategory[state.selected.category]}` : '局域网未开启'}</span></div> :
      <div className="set-row">
        <label className="lbl" htmlFor="lan-interface">网卡</label>
        <div>
          <select className="select" id="lan-interface" value={selectedIndex < 0 ? '' : String(selectedIndex)} disabled={busy || on || !state.interfaces.length}
            onChange={(event) => { const item = state.interfaces[Number(event.target.value)]; if (event.target.value !== '' && item) onSelect(item); }}>
            <option value="">请选择网卡</option>
            {state.interfaces.map((item, index) => <option key={`${item.name}/${item.address}`} value={index}>
              {item.name} · {item.address} · {networkCategory[item.category]}
            </option>)}
          </select>
          {choice?.category === 'public' ? <p className="lan-note">此网卡在公用网络上。请在 Windows 设置里改为专用网络后再开启。</p> : null}
          {choice?.category === 'domain' || choice?.category === 'unknown' ? <p className="lan-note">只可在确认是专用网络的网卡上开启。</p> : null}
        </div>
      </div>}
    {state.unavailableReason ? <p className="lan-note" role="status">{state.unavailableReason}</p> : null}
    <div className="set-row">
      <span className="lbl">Windows 防火墙</span>
      <div className="lan-row"><span>{leftover ? '有残留规则，点“更新规则”删除' : firewallLabel[state.firewall]}</span>
        {!remote ? <button type="button" className="btn sm" disabled={busy} onClick={onUpdate}>更新规则</button> : null}
      </div>
    </div>
  </>;
}

const auditResults = { ok: '成功', failed: '失败', requested: '已请求', allowed: '已允许', denied: '已拒绝', expired: '已超时', unavailable: '已失效' };
const auditActions: Record<string, string> = {
  'lan.suspended': '网卡或网络类别变化，暂停局域网',
  'pairing.start': '请求本机配对码',
  'lan.enable': '开启局域网', 'lan.disable': '关闭局域网', 'firewall.add': '添加防火墙规则', 'firewall.set': '替换防火墙规则',
  'firewall.delete': '删除防火墙规则', 'firewall.update': '更新防火墙规则', 'pairing.issue': '生成配对码', 'pairing.requested': '请求配对',
  'pairing.resolved': '处理配对', 'pairing.claimed': '领取配对凭据', 'pairing.local': '本机配对', 'device.revoke': '吊销设备',
  'device.revoke_lan': '吊销全部局域网设备', 'ws.prompt': '发送消息', 'ws.approve': '处理审批', 'ws.cancel': '停止任务', 'ws.switch': '切换任务配置',
};

function auditLabel(action: string): string {
  if (action.startsWith('confirm.')) return `电脑确认 · ${operationLabel[action.slice(8) as keyof typeof operationLabel] ?? '远程操作'}`;
  if (action.startsWith('http.')) return `局域网请求 · ${action.slice(5)}`;
  return auditActions[action] ?? '访问操作';
}

export function DeviceAccessSection() {
  const devices = useApp((s) => s.devices);
  const available = useApp((s) => !!s.hello?.features[FeatureKey.Lan]);
  const remote = useRemoteAccess();
  const suspended = useStore(lanSuspendedSeq, seq => seq);
  const used = useStore(pairingUsedSeq, seq => seq);
  const readVersion = useRef(0);
  const [state, setState] = useState<LanState | null>(null);
  const [choice, setChoice] = useState<LanInterface | null>(null);
  const [lanError, setLanError] = useState<ApiError | null>(null);
  const [deviceError, setDeviceError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setPairing] = useState<{ code: LanPairingCode; used: number } | null>(null);
  const pairing = issued?.used === used ? issued.code : null;
  const [manual, setManual] = useState<{ label: string; text: string } | null>(null);
  const seconds = useCountdown(pairing?.expiresAt);

  const refreshDevices = () => { setDeviceError(null); void loadDevices().catch((error) => setDeviceError(asApiError(error))); };
  const applyLan = (next: LanState) => {
    setState(next);
    setChoice((previous) => networkChoice(next, previous));
    if (!next.enabled) { setPairing(null); setManual(null); }
  };
  const refreshLan = () => {
    const version = ++readVersion.current;
    setLanError(null);
    void api.lanState().then(next => { if (version === readVersion.current) applyLan(next); },
      error => { if (version === readVersion.current) setLanError(asApiError(error)); });
  };
  useEffect(refreshDevices, []);
  useEffect(() => { if (available) refreshLan(); return () => { readVersion.current++; }; }, [available, suspended]);

  const mutateLan = async (doUpdate: () => Promise<LanState>) => {
    readVersion.current++;
    setBusy(true);
    setLanError(null);
    try {
      const next = await doUpdate();
      readVersion.current++;
      applyLan(next);
    }
    catch (failure) {
      setLanError(asApiError(failure));
      try {
        const next = await api.lanState();
        readVersion.current++;
        applyLan(next);
      } catch { /* 保留操作报错 */ }
    } finally { setBusy(false); }
  };
  const toggle = () => {
    if (state && lanSwitchOn(state)) void mutateLan(() => api.putLan({ enabled: false }));
    else if (choice) void mutateLan(() => api.putLan({ enabled: true, name: choice.name, address: choice.address }));
  };
  const issue = async () => {
    setBusy(true);
    setLanError(null);
    try { setManual(null); setPairing({ code: await api.localPairingCode(), used }); await loadDevices(); }
    catch (failure) { setLanError(asApiError(failure)); }
    finally { setBusy(false); }
  };
  const copy = async (label: string, text: string) => {
    if (await platform.copyText(text)) { setManual(null); toast(`已复制${label}`); }
    else setManual({ label, text });
  };

  const revoke = async (device: Device) => {
    if (!await confirmDialog({ title: `吊销“${device.name}”？`, ok: '吊销', danger: true, body: <p>这台设备会立刻失去访问权限，再访问时需要重新配对。</p> })) return;
    try { await revokeDevice(device.id); toast(`已吊销“${device.name}”`); } catch (failure) { toastErrorOf(failure); }
  };
  const revokeAll = async () => {
    if (!await confirmDialog({ title: '吊销全部局域网设备？', ok: '全部吊销', danger: true, body: <p>所有通过局域网配对的设备都需要重新配对。本机设备仍可访问。</p> })) return;
    try { const result = await api.revokeLanDevices(); setPairing(null); setManual(null); await loadDevices(); toast(`已吊销 ${result.revoked} 台局域网设备`); }
    catch (failure) { toastErrorOf(failure); }
  };

  const address = state?.enabled && state.selected ? `http://${state.selected.address}:${state.port}/` : null;
  return <section className="set-sec lan-access" aria-labelledby="s-dev">
    <h3 id="s-dev">设备与访问</h3>
    {remote ? <p className="alert attn lan-warning">局域网连接没有加密，只在家庭或公司等可信网络使用。</p> : null}
    {available && !state && !lanError ? <p role="status">正在读取局域网状态…</p> : null}
    {lanError ? <ErrorNotice error={lanError} onRetry={refreshLan} /> : null}
    {state ? <LanControls state={state} choice={choice} remote={remote} busy={busy} onSelect={setChoice} onToggle={toggle}
      onUpdate={() => void mutateLan(() => api.updateLanFirewall())} /> : null}
    {available && !remote ? <button type="button" className="btn sm" disabled={busy} onClick={refreshLan}>刷新网络状态</button> : null}
    {address ? <div className="set-row"><span className="lbl">访问地址</span><div>
      <div className="lan-row"><span className="mono lan-address">{address}</span>
        <button type="button" className="btn sm" onClick={() => void copy('地址', address)}>复制地址</button>
        {!remote ? <button type="button" className="btn primary" disabled={busy} onClick={() => void issue()}>配对新设备</button> : null}
      </div>
      {pairing && seconds ? <div className="lan-code">
        <span>六位配对码</span><strong className="mono lan-code-value">{pairing.code}</strong><span>剩余 {seconds} 秒</span>
        <button type="button" className="btn sm" onClick={() => void copy('配对码', pairing.code)}>复制配对码</button>
      </div> : pairing ? <p className="lan-note">配对码已过期。请再次点击“配对新设备”。</p> : null}
      {manual && (manual.label !== '配对码' || seconds > 0) ? <label className="lan-manual">手动复制{manual.label}
        <input className="input mono" readOnly value={manual.text} onFocus={(event) => event.target.select()} />
      </label> : null}
    </div></div> : null}
    <div className="lan-list-heading"><h4>已配对设备</h4><button type="button" className="btn sm" onClick={refreshDevices}>刷新设备</button>
      {!remote && devices?.some((device) => device.source === 'lan') ? <button type="button" className="btn sm danger" onClick={() => void revokeAll()}>吊销全部局域网设备</button> : null}
    </div>
    {deviceError ? <ErrorNotice error={deviceError} onRetry={refreshDevices} /> : null}
    {devices === null && !deviceError ? <p role="status">正在载入…</p> : null}
    <ul className="device-list">
      {devices?.map((device) => <li key={device.id}>
        <Icon name="devices" />
        <div className="info"><b>{device.name}{device.current ? '（这台设备）' : ''}</b>
          <span>{device.source === 'lan' ? '局域网' : '本机'}{device.lastSeen ? ` · 最近使用 ${ago(device.lastSeen)}` : ''}{device.lastIp ? ` · ${device.lastIp}` : ''}</span></div>
        {!remote ? <button type="button" className="btn sm danger" onClick={() => void revoke(device)} aria-label={`吊销 ${device.name}`}>吊销</button> : null}
      </li>)}
    </ul>
    {available ? <AccessAuditSection /> : null}
  </section>;
}

function AccessAuditSection() {
  const devices = useApp((s) => s.devices);
  const [page, setPage] = useState<{ items: AccessAuditEntry[]; nextCursor: string | null } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api.accessAudit(cursor);
      setPage((old) => ({ items: cursor && old ? [...old.items, ...next.items] : next.items, nextCursor: next.nextCursor }));
    } catch (failure) { setError(asApiError(failure)); }
    finally { setLoading(false); }
  };
  return <details className="lan-audit" onToggle={(event) => { if (event.currentTarget.open && !page && !loading) void load(); }}>
    <summary>审计日志</summary>
    <p className="lan-note">查看最近 90 天的局域网操作、配对和防火墙变更。</p>
    {error ? <ErrorNotice error={error} onRetry={() => void load()} /> : null}
    {loading && !page ? <p role="status">正在载入…</p> : null}
    {page?.items.length === 0 ? <p>还没有审计记录。</p> : null}
    <ul className="lan-audit-list">
      {page?.items.map((item) => <li key={item.id}>
        <strong>{auditLabel(item.action)}</strong><span>{auditResults[item.result]}</span>
        <small>{new Date(item.at).toLocaleString('zh-CN')}{item.ip ? ` · ${item.ip}` : ''}</small>
        {item.deviceId ? <small>设备 {devices?.find((device) => device.id === item.deviceId)?.name ?? item.deviceId}</small> : null}
        {item.objectId ? <small>对象 {item.objectId}</small> : null}
      </li>)}
    </ul>
    <div className="lan-row"><button type="button" className="btn sm" disabled={loading} onClick={() => void load()}>刷新日志</button>
      {page?.nextCursor ? <button type="button" className="btn sm" disabled={loading} onClick={() => void load(page.nextCursor!)}>加载更多</button> : null}
    </div>
  </details>;
}

export function NotificationSoundSetting() {
  const sound = usePref('notificationSound');
  return <div className="set-row"><span className="lbl" id="lan-sound">页面提醒音</span>
    <div className="lan-row"><button type="button" role="switch" className="switch lan-switch" aria-labelledby="lan-sound" aria-checked={sound}
      onClick={() => setPref('notificationSound', !sound)} /><span>{sound ? '已开启' : '已关闭'}</span></div>
  </div>;
}
