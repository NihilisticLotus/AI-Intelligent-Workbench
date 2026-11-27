// 设置：外观、设备与访问、工作区、交接和关于。
import { useApp } from '../state/app';
import { setPref, usePref, type ThoughtMode } from '../state/prefs';
import { Icon } from '../components/Icon';
import { NetworkSettingsSection } from './network-settings';
import { FeatureKey } from '@aic/protocol';
import { HandoffSettingsSection } from './handoff-settings';
import { WorkspaceSettingsSection } from './workspace-settings';
import { DeviceAccessSection, NotificationSoundSetting } from './device-access-section';
import { SecurityStatusSection } from './security-status-section';

export function SettingsPage() {
  const theme = usePref('theme');
  const thought = usePref('thought');
  const hello = useApp((s) => s.hello);

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
            <NotificationSoundSetting />
            <p style={{ margin: 'var(--sp-2) 0 0', fontSize: 'var(--fs-12)', color: 'var(--fg-3)' }}>这些设置只保存在这台设备上。</p>
          </section>

          <DeviceAccessSection />
          <SecurityStatusSection />

          <NetworkSettingsSection />
          <WorkspaceSettingsSection />
          {hello?.features[FeatureKey.Handoff]?<HandoffSettingsSection/>:null}

          {hello ? (
            <section className="set-sec" aria-labelledby="s-about">
              <h3 id="s-about">关于</h3>
              <dl className="ctx">
                <dt>服务版本</dt><dd>{hello.version}（协议 {hello.protocol}）</dd>
                <dt>这台电脑</dt><dd>{hello.machine.name}</dd>
                <dt>上次退出</dt><dd>{hello.lastExit ? (hello.lastExit.clean ? '正常退出' : '没有正常退出') + ' · ' + (hello.lastExit.reason ?? '原因未知') + ' · ' + new Date(hello.lastExit.at).toLocaleString('zh-CN') : '没有记录'}</dd>
                <dt>当前设备</dt><dd>{hello.device.name}</dd>
              </dl>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
