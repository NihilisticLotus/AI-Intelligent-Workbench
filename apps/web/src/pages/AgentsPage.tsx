// Agent 页：列出 /agents 的卡片。安装、登录、账号在 1.2 提供。
import { useState } from 'react';
import type { AgentInfo } from '@aic/protocol';
import { refreshAgents, useApp } from '../state/app';
import { AgentBadge, StatusMark, toastErrorOf } from '../components/ui';
import { Icon } from '../components/Icon';
import { agentStatusText } from '../components/dialogs';
import { toast } from '../state/ui';
import type { StatusShape } from '../lib/format';

const shapeOf: Record<AgentInfo['status'], StatusShape> = { ready: 'ok', needs_login: 'wait', not_installed: 'idle', error: 'err', disabled: 'idle' };

export function AgentsPage() {
  const agents = useApp((s) => s.agents);
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { await refreshAgents(); toast('已重新检测'); } catch (e) { toastErrorOf(e); } finally { setBusy(false); }
  };
  return (
    <main className="main">
      <header className="main-head">
        <h1>Agent 管理</h1><span className="grow" />
        <button type="button" className="btn" onClick={refresh} aria-busy={busy}><Icon name="refresh" />重新检测</button>
      </header>
      <div className="content-scroll">
        <div className="page">
          <p className="page-lead">这里列出这台电脑上能用的 Agent。安装、登录、账号配置会在第 1.2 步接入真实 Agent 时提供，都在这里点按钮完成，不需要打开命令行。</p>
          {!agents.length ? <div className="empty"><h3>还没有检测到 Agent</h3><p>点右上角的“重新检测”。</p></div> : null}
          <div className="cards">
            {agents.map((a) => (
              <article key={a.kind} className="agent-card" aria-label={a.displayName}>
                <span className="top">
                  <AgentBadge kind={a.kind} size="lg" />
                  <span><span className="name">{a.displayName}</span><br /><span className="src">{a.kind === 'fake' ? '内置，用来体验工作台' : '本机安装'}</span></span>
                  <span style={{ marginLeft: 'auto' }}><StatusMark shape={shapeOf[a.status]} text={agentStatusText(a.status)} /></span>
                </span>
                {a.message ? (
                  <div className={'alert ' + (a.status === 'error' ? 'err' : a.status === 'ready' ? 'info' : 'attn')} style={{ padding: '8px 10px' }}>
                    <Icon name={a.status === 'ready' ? 'info' : 'warn'} /><div className="body"><p style={{ margin: 0 }}>{a.message}</p></div>
                  </div>
                ) : null}
                <dl>
                  <dt>版本</dt>
                  <dd>{a.version ?? '—'}{a.version ? (a.verified ? '（已验证）' : '') : ''}
                    {a.version && !a.verified ? <span style={{ color: 'var(--attn)' }}> <Icon name="warn" size={13} /> 未验证版本</span> : null}</dd>
                  <dt>模型</dt><dd>{a.models.length ? a.models.map((m) => m.name).join('、') : '由 Agent 决定'}</dd>
                  <dt>思考强度</dt><dd>{a.efforts?.length ? a.efforts.join(' / ') : '由模型自己决定'}</dd>
                </dl>
              </article>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
