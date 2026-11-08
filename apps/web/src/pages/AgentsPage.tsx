// Agent 管理页（docs/prototype/agents.html，phase-1.md 6.7）：
// 上方每个 Agent 一张状态卡片（状态、版本、引擎、账号、运行中的会话、模型、能力；按钮只放和当前状态相关的）；
// 下方是选中 Agent 的详情：原生配置说明、工作台任务默认值、测试连接。旧认证配置仅保留待清理。
// 网页不拼本机路径：引擎位置只显示 AgentInfo.engineLocation 的文本。
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ErrorCode, FeatureKey, WORKBUDDY_APP_METHOD,
  type AgentInfo, type AgentKind, type AgentProfile, type AgentTestResult, type ApiError, type AuthMethod,
} from '@aic/protocol';
import {
  cancelLogin, clearRetiredProfileSecret, deleteProfile, loadProfiles, patchAgent, patchProfile, redetectAgents, refreshProfileModels, sendLoginCode,
  startLogin, testAgent, useApp,
} from '../state/app';
import type { LoginInfo } from '../state/core';
import { navigate, routeStore, toast } from '../state/ui';
import { useStore } from '../state/store';
import { ApiRequestError } from '../api/http';
import { platform } from '../platform';
import { clock } from '../lib/format';
import { effortLabel } from '../lib/picker';
import {
  LOGIN_TERMINAL, agentStatusView, capsSummary, emptyModelsText, engineSourceText, formatTestLog, isEnabled, isLocalLogin, isRealAgent,
  loginAnnounceText, loginMethods, loginStep, profileDesc, profileKindText, safeAuthUrl, taskDefaults, workspaceConfigNote,
} from '../lib/agents';
import { AgentBadge, ErrorNotice, StatusMark, asApiError, confirmDialog, openDialog, openMenu, toastErrorOf } from '../components/ui';
import { Icon } from '../components/Icon';
import { agentTestRequestStore } from '../components/focus';
import { ProfileDialog } from './ProfileDialog';
import { IndependentAgentPanel } from './independent-agent-panel';

/** 这个页面里发起的登录：每个 Agent 记住最近一次的 loginId */
type MyLogins = Partial<Record<AgentKind, { loginId: string; methodId: string; profileId: string | null }>>;

export function AgentsPage() {
  const allAgents = useApp((s) => s.agents);
  const toggleOn = useApp((s) => !!s.hello?.features[FeatureKey.AgentToggle]);
  // 上方卡片只放已启用的；关闭的列在下面“其他 Agent”（design.md 6.7）
  const agents = useMemo(() => allAgents.filter((a) => a.kind !== 'independent' && isEnabled(a)), [allAgents]);
  const offAgents = useMemo(() => allAgents.filter((a) => a.kind !== 'independent' && !isEnabled(a)), [allAgents]);
  const [toggling, setToggling] = useState<AgentKind | null>(null);
  const route = useStore(routeStore, (r) => r);
  const routeAgent = route.page === 'agents' ? route.agent : undefined;
  const routeProfile = route.page === 'agents' ? route.profileId : undefined;
  const [busy, setBusy] = useState(false);
  const [myLogins, setMyLogins] = useState<MyLogins>({});
  const [tests, setTests] = useState<Partial<Record<AgentKind, TestState>>>({});
  const detailRef = useRef<HTMLElement>(null);

  // 选中的 Agent：地址栏优先，其次第一个需要处理的真实 Agent，再其次第一个
  const selected = useMemo(() => {
    const byRoute = agents.find((a) => a.kind === routeAgent);
    if (byRoute) return byRoute;
    return agents.find((a) => isRealAgent(a.kind) && a.status !== 'ready') ?? agents.find((a) => isRealAgent(a.kind)) ?? agents[0];
  }, [agents, routeAgent]);

  const lastChecked = useMemo(() => {
    const ts = agents.map((a) => a.checkedAt ?? 0).filter(Boolean);
    return ts.length ? Math.max(...ts) : null;
  }, [agents]);

  const select = (kind: AgentKind, scroll = false) => {
    if (kind !== selected?.kind) navigate({ page: 'agents', agent: kind });
    if (scroll) setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
  };

  const redetect = async () => {
    if (busy) return;
    setBusy(true);
    try { await redetectAgents(); toast('已重新检测'); } catch (e) { toastErrorOf(e); } finally { setBusy(false); }
  };

  /** 发起登录。CodeBuddy 已登录时服务端返回 409：二次确认后带 force 重来（会同时退出 WorkBuddy 里的账号） */
  const login = async (a: AgentInfo, methodId: string, profileId: string | null, force = false): Promise<void> => {
    try {
      const r = await startLogin(a.kind, { methodId, ...(profileId ? { profileId } : {}), ...(force ? { force: true } : {}) });
      setMyLogins((m) => ({ ...m, [a.kind]: { loginId: r.loginId, methodId, profileId } }));
      if (methodId === WORKBUDDY_APP_METHOD) toast('已启动 WorkBuddy。在 WorkBuddy 里登录后，回来点“重新检测”');
    } catch (e) {
      if (!force && e instanceof ApiRequestError && e.status === 409 && e.code === ErrorCode.Conflict) {
        const ok = await confirmDialog({
          title: `换一个 ${a.displayName} 账号？`, ok: '退出并重新登录', danger: true,
          body: <><p>{e.error.message}</p>
            <p style={{ margin: 0 }}>重新登录会替换现在的登录。</p></>,
        });
        if (ok) return login(a, methodId, profileId, true);
        return;
      }
      toastErrorOf(e, { kind: a.kind });
    }
  };

  const runTest = async (a: AgentInfo, opts: { profileId?: string; sendMessage?: boolean } = {}) => {
    if (tests[a.kind]?.running) return;
    setTests((t) => ({ ...t, [a.kind]: { running: true, profileId: opts.profileId ?? null, sendMessage: !!opts.sendMessage, result: null, error: null } }));
    try {
      const result = await testAgent(a.kind, opts);
      setTests((t) => ({ ...t, [a.kind]: { running: false, profileId: opts.profileId ?? null, sendMessage: !!opts.sendMessage, result, error: null } }));
      toast(result.ok ? `${a.displayName}：连接正常` : `${a.displayName}：测试没有通过`, result.ok ? 'ok' : 'err');
    } catch (e) {
      setTests((t) => ({ ...t, [a.kind]: { running: false, profileId: opts.profileId ?? null, sendMessage: !!opts.sendMessage, result: null, error: asApiError(e) } }));
    }
  };

  /** 打开 / 关闭一个 Agent。打开后 Gateway 立即检测；需要桥接的（ZCode）再自动测试一次连接 */
  const toggle = async (a: AgentInfo, on: boolean) => {
    if (toggling) return;
    if (!on && (a.runningSessions ?? 0) > 0) {
      const ok = await confirmDialog({
        title: `关闭 ${a.displayName}？`, ok: '关闭', danger: true,
        body: <p style={{ margin: 0 }}>有 {a.runningSessions} 个会话正在运行。关闭后不再接新任务，运行中的会话会照常做完；已有任务的记录都保留，随时可以再打开。</p>,
      });
      if (!ok) return;
    }
    setToggling(a.kind);
    try {
      await patchAgent(a.kind, { enabled: on });
      if (on) {
        toast(`已打开 ${a.displayName}，检测完成`);
        select(a.kind, true);
        if (a.kind === 'zcode') void runTest({ ...a, enabled: true });
      } else toast(`已关闭 ${a.displayName}：不再检测，新建任务和切换器里不显示。已有任务的记录保留`);
    } catch (e) { toastErrorOf(e, { kind: a.kind }); } finally { setToggling(null); }
  };

  // 错误按钮“测试连接”：打开本页并开始测试
  const testReq = useStore(agentTestRequestStore, (s) => s);
  useEffect(() => {
    if (!testReq) return;
    const a = agents.find((x) => x.kind === testReq.kind);
    agentTestRequestStore.set(() => null);
    if (a) { select(a.kind, true); void runTest(a); }
  }, [testReq]); // eslint-disable-line react-hooks/exhaustive-deps

  // 从别处跳来（“去登录”）时滚到详情
  useEffect(() => {
    if (routeAgent) setTimeout(() => detailRef.current?.scrollIntoView({ block: 'start' }), 0);
  }, [routeAgent]);

  return (
    <main className="main">
      <header className="main-head">
        <h1>Agent 管理</h1><span className="grow" />
        <button type="button" className="btn" onClick={redetect} aria-busy={busy} disabled={busy}><Icon name="refresh" />{busy ? '正在检测…' : '重新检测'}</button>
      </header>
      <div className="content-scroll">
        <div className="page agents-page">
          <p className="page-lead">
            {lastChecked ? `上次检测：${clock(lastChecked)}。` : ''}
            第三方 Agent 沿用软件自身的 API、登录与模型设置。{toggleOn ? '只有打开的 Agent 会检测、出现在新建任务和切换器里。' : ''}
          </p>
          <IndependentAgentPanel />
          {toggleOn ? <h2 className="sec-h">已启用 <span className="muted">{agents.length} 个</span></h2> : null}
          {!allAgents.length ? <div className="empty"><h3>还没有检测到 Agent</h3><p>点右上角的“重新检测”。</p></div>
            : !agents.length ? <div className="cards-empty">还没有启用任何 Agent。在下面打开一个就能开始用。</div> : null}
          <div className="cards">
            {agents.map((a) => (
              <AgentCard key={a.kind} a={a} current={a.kind === selected?.kind} busy={busy} test={tests[a.kind]}
                onSelect={() => select(a.kind)}
                onLogin={() => {
                  select(a.kind, true);
                  const ms = loginMethods(a).filter((m) => m.id !== 'selfhosted');
                  if (ms.length === 1) void login(a, ms[0]!.id, null);
                }}
                onTest={() => { select(a.kind, true); void runTest(a); }}
                onRedetect={redetect}
                toggle={toggleOn ? <EnableSwitch a={a} busy={toggling === a.kind} onChange={(v) => void toggle(a, v)} /> : null} />
            ))}
          </div>
          {toggleOn && offAgents.length ? (
            <>
              <h2 className="sec-h">其他 Agent <span className="muted">默认关闭，需要时打开</span></h2>
              <ul className="off-list" aria-label="已关闭的 Agent">
                {offAgents.map((a) => (
                  <li key={a.kind} className="off-row">
                    <AgentBadge kind={a.kind} />
                    <span className="name">{a.displayName}</span>
                    <span className="sub">{[a.engineLocation, a.version].filter(Boolean).join(' · ') || '打开后检测'}</span>
                    <span className="lbl">{toggling === a.kind ? '正在打开…' : '已关闭'}</span>
                    <EnableSwitch a={a} busy={toggling === a.kind} onChange={(v) => void toggle(a, v)} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {selected ? (
            <section className="agent-detail" ref={detailRef} aria-label={`${selected.displayName} 详情`} tabIndex={-1}>
              <AgentDetail key={selected.kind} a={selected} focusProfileId={routeProfile ?? null}
                my={myLogins[selected.kind] ?? null} onLogin={login} onRedetect={redetect} redetecting={busy}
                test={tests[selected.kind] ?? null} onTest={(o) => void runTest(selected, o)} />
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}

/** 启用开关：role="switch"，aria-label 写清楚点了会怎样 */
function EnableSwitch({ a, busy, onChange }: { a: AgentInfo; busy: boolean; onChange: (on: boolean) => void }) {
  const on = isEnabled(a);
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} aria-busy={busy} disabled={busy}
      aria-label={`${on ? '关闭' : '打开'} ${a.displayName}`} title={on ? '已启用，点击关闭' : '已关闭，点击打开'}
      onClick={(e) => { e.stopPropagation(); onChange(!on); }} />
  );
}

interface TestState { running: boolean; profileId: string | null; sendMessage: boolean; result: AgentTestResult | null; error: ApiError | null }

// ---------------------------------------------------------------------
// 状态卡片
// ---------------------------------------------------------------------
function AgentCard({ a, current, busy, test, onSelect, onLogin, onTest, onRedetect, toggle }: {
  a: AgentInfo; current: boolean; busy: boolean; test: TestState | undefined;
  onSelect: () => void; onLogin: () => void; onTest: () => void; onRedetect: () => void; toggle: React.ReactNode;
}) {
  const st = agentStatusView(a);
  const real = isRealAgent(a.kind);
  const profiles = a.profiles ?? [];
  const engine = engineSourceText(a);
  const caps = capsSummary(a.caps);
  const version = versionText(a);
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <article className="agent-card" aria-label={a.displayName} aria-current={current || undefined} tabIndex={0}
      onClick={onSelect} onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onSelect(); } }}>
      <span className="top">
        <AgentBadge kind={a.kind} size="lg" />
        <span><span className="name">{a.displayName}</span><br /><span className="src">{!real ? '内置，用来体验工作台' : engine ?? '本机安装'}</span></span>
        <span style={{ marginLeft: 'auto' }}><StatusMark shape={st.shape} text={st.text} /></span>
        {toggle}
      </span>
      {a.message ? (
        <div className={'alert ' + (a.status === 'error' ? 'err' : a.status === 'ready' ? 'info' : 'attn')} style={{ padding: '8px 10px' }}>
          <Icon name={a.status === 'ready' ? 'info' : 'warn'} /><div className="body"><p style={{ margin: 0 }}>{a.message}</p></div>
        </div>
      ) : null}
      <dl>
        <dt>版本</dt>
        <dd className={!a.verified && version !== '—' ? 'unverified' : undefined}>
          {!a.verified && version !== '—' ? <><Icon name="warn" size={13} /> </> : null}{version}{version === '—' ? '' : a.verified ? '（已验证）' : '，未验证版本'}
        </dd>
        {real && a.usesNativeConfig ? <><dt>配置</dt><dd>沿用软件自身配置与登录</dd></> : real && profiles.length ? <><dt>账号</dt><dd>{profiles.map((p) => p.name).join('、')}</dd></> : null}
        {a.runningSessions !== undefined ? <><dt>运行中</dt><dd>{a.runningSessions} 个会话{a.concurrencyLimit ? `（并发上限 ${a.concurrencyLimit}）` : ''}</dd></> : null}
        <dt>模型</dt><dd>{a.models.length ? a.models.map((m) => m.name).join('、') : emptyModelsText(a)}</dd>
        {caps.length ? <><dt>能力</dt><dd>{caps.join('、')}</dd></> : null}
      </dl>
      {real ? (
        <div className="acts">
          {a.status === 'needs_login' && !a.usesNativeConfig ? <button type="button" className="btn sm attn" onClick={stop(onLogin)}>登录</button> : null}
          {a.status !== 'not_installed' ? (
            <button type="button" className="btn sm" onClick={stop(onTest)} aria-busy={test?.running} disabled={test?.running}>
              {test?.running ? '正在测试…' : '测试连接'}</button>
          ) : null}
          <button type="button" className="btn sm ghost" onClick={stop(onRedetect)} disabled={busy}>重新检测</button>
        </div>
      ) : null}
    </article>
  );
}

function versionText(a: AgentInfo): string {
  if (a.adapterVersion && a.engineVersion && a.adapterVersion !== a.engineVersion) return `适配器 ${a.adapterVersion}，引擎 ${a.engineVersion}`;
  return a.engineVersion ?? a.version ?? a.adapterVersion ?? '—';
}

// ---------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------
function AgentDetail({ a, focusProfileId, my, onLogin, onRedetect, redetecting, test, onTest }: {
  a: AgentInfo; focusProfileId: string | null;
  my: MyLogins[AgentKind] | null;
  onLogin: (a: AgentInfo, methodId: string, profileId: string | null, force?: boolean) => Promise<void>;
  onRedetect: () => void; redetecting: boolean;
  test: TestState | null; onTest: (o: { profileId?: string; sendMessage?: boolean }) => void;
}) {
  const real = isRealAgent(a.kind);
  const profilesOn = useApp((s) => !!s.hello?.features[FeatureKey.Profiles]);
  // 正在进行的登录：本页发起的优先；其次别的设备发起、还没结束的
  const login = useApp((s) => {
    if (my) return s.logins[my.loginId] ?? null;
    let best: LoginInfo | null = null;
    for (const l of Object.values(s.logins)) if (l.kind === a.kind && !LOGIN_TERMINAL.has(l.state) && (!best || l.ts > best.ts)) best = l;
    return best;
  });

  return (
    <>
      <h2><AgentBadge kind={a.kind} />{a.displayName}</h2>
      <div className="detail">
        <div>
          {real && a.usesNativeConfig ? <NativeConfigSection a={a} onRedetect={onRedetect} redetecting={redetecting} /> : real ? <LoginSection a={a} my={my} login={login} onLogin={onLogin} onRedetect={onRedetect} redetecting={redetecting} /> : (
            <p className="muted-note">演示 Agent 不需要登录，也没有账号。它用来体验工作台：对话、审批、换模型都能试。</p>
          )}
          {real && !a.usesNativeConfig && profilesOn ? (
            <ProfileSection a={a} focusProfileId={focusProfileId} onLogin={onLogin} onTest={onTest} test={test} />
          ) : real && !a.usesNativeConfig ? <p className="muted-note">账号配置需要更新 AI Console 服务后才能使用。</p> : null}
        </div>
        <div>
          <SettingsSection a={a} />
          <TestSection a={a} test={test} onTest={onTest} />
        </div>
      </div>
    </>
  );
}

/** 第三方认证只读；旧测试配置仅可清理工作台密钥，历史绑定继续保留。 */
function NativeConfigSection({ a, onRedetect, redetecting }: { a: AgentInfo; onRedetect: () => void; redetecting: boolean }) {
  const list = useApp((s) => s.profiles[a.kind]);
  const [err, setErr] = useState<ApiError | null>(null);
  const [clearing, setClearing] = useState<string | null>(null);
  const load = () => { setErr(null); loadProfiles(a.kind).catch((e) => setErr(asApiError(e))); };
  useEffect(load, [a.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const retired = list?.filter((p) => p.retired) ?? [];
  const clearSecret = async (p: AgentProfile) => {
    if (!await confirmDialog({ title: '清理工作台保存的旧密钥？', ok: '清理密钥', danger: true,
      body: <p>仅删除“{p.name}”在工作台中保存的加密密钥，此操作无法撤销。保留历史任务和停用配置，旧任务仍不能恢复；不会读取或清理 Agent 自己的目录、登录和设置。</p> })) return;
    setClearing(p.id); setErr(null);
    try { await clearRetiredProfileSecret(p.id); toast('工作台密钥已清理，历史记录已保留'); }
    catch (e) { setErr(asApiError(e)); }
    finally { setClearing(null); }
  };
  return <>
    <h3>软件自身配置</h3>
    <p className="muted-note">API、登录和模型由 {a.displayName} 自己管理，工作台沿用这些设置。完成配置后，回到这里重新检测。</p>
    <p className="muted-note">模型列表来自该软件报告的会话能力；已配置的自定义模型也需要由软件提供。工作台内换模型只作用于任务会话。</p>
    <button type="button" className="btn sm" disabled={redetecting} onClick={onRedetect}>重新检测</button>
    {err ? <ErrorNotice error={err} onRetry={load} /> : null}
    {!list && !err ? <p className="muted-note" role="status">正在读取旧测试配置状态…</p> : null}
    {retired.length ? <>
      <h3>已停用的工作台测试配置</h3>
      <p className="muted-note">这些配置来自旧版工作台，已停止使用。可单独清理工作台保存的密钥；配置身份、历史任务和目录保留，旧任务不会改用本机登录。此操作不清理 Agent 自己的凭据。</p>
      {retired.map((p) => <div className="acct" key={p.id}>
        <Icon name="key" /><div className="info"><b>{p.name}<span className="tag attn">已停用</span></b><span>{profileKindText[p.kind]} · {p.hasSecret ? '加密密钥已保留，不再使用' : '历史配置已保留'}</span></div>
        {p.hasSecret ? <button type="button" className="btn sm" aria-label={`清理 ${p.name} 的工作台密钥`} disabled={!!clearing} aria-busy={clearing === p.id} onClick={() => void clearSecret(p)}>清理工作台密钥</button> : null}
      </div>)}
    </> : null}
    <p className="muted-note">AI Console 自有 API 服务归本页上方的独立 Agent 管理，可在新建任务中选择独立 Agent。</p>
  </>;
}

// ---------------------------------------------------------------------
// 登录：按钮 + 分步进度（启动 → 在浏览器中授权 → 确认登录状态）
// ---------------------------------------------------------------------
function LoginSection({ a, my, login, onLogin, onRedetect, redetecting }: {
  a: AgentInfo; my: MyLogins[AgentKind] | null; login: LoginInfo | null;
  onLogin: (a: AgentInfo, methodId: string, profileId: string | null, force?: boolean) => Promise<void>;
  onRedetect: () => void; redetecting: boolean;
}) {
  const methods = loginMethods(a).filter((m) => m.id !== 'selfhosted');
  const hasApiKeyMethod = (a.authMethods ?? []).some((m) => m.flow === 'apiKey');
  const loggedIn = a.status === 'ready';
  const running = !!login && !LOGIN_TERMINAL.has(login.state);
  const [starting, setStarting] = useState<string | null>(null);

  const start = async (m: AuthMethod) => {
    if (starting || running) return;
    // CodeBuddy 已登录时“换账号”要二次确认：引擎会先退出现在的账号（Gateway 也要求 force）
    if (loggedIn && a.kind === 'codebuddy' && m.flow !== 'external_app') {
      const ok = await confirmDialog({
        title: '换一个 CodeBuddy 账号？', ok: '退出并重新登录', danger: true,
        body: <p style={{ margin: 0 }}>会先退出现在的 CodeBuddy 账号，再打开浏览器登录新账号。</p>,
      });
      if (!ok) return;
      setStarting(m.id);
      try { await onLogin(a, m.id, null, true); } finally { setStarting(null); }
      return;
    }
    setStarting(m.id);
    try { await onLogin(a, m.id, null); } finally { setStarting(null); }
  };

  const workbuddy = methods.find((m) => m.flow === 'external_app' || m.id === WORKBUDDY_APP_METHOD)
    ?? (a.kind === 'workbuddy' ? { id: WORKBUDDY_APP_METHOD, name: '在 WorkBuddy 中登录', description: '启动 WorkBuddy，在那里登录后回来点“重新检测”', flow: 'external_app' as const } : null);
  const browserMethods = methods.filter((m) => m !== workbuddy && m.flow === 'browser');

  return (
    <>
      <h3>登录{loggedIn ? <span className="tag ok">已登录</span> : a.status === 'needs_login' ? <span className="tag attn">需要登录</span> : null}</h3>
      {login && (running || my?.loginId === login.loginId) ? (
        <LoginProgress a={a} login={login} methodId={my?.loginId === login.loginId ? my.methodId : null} methodName={methods.find((m) => m.id === my?.methodId)?.name ?? null} onRedetect={onRedetect} />
      ) : null}
      {a.status === 'not_installed' ? (
        <p className="muted-note">这台电脑上没有找到 {a.displayName}。{a.kind === 'workbuddy' ? '装好 WorkBuddy 后' : '装好后'}点“重新检测”。</p>
      ) : !running ? (
        <>
          {!loggedIn ? <p className="muted-note">选一种方式登录。需要浏览器授权的，会在运行 AI Console 的这台电脑上打开浏览器，授权完这里会自动更新。</p>
            : <p className="muted-note">{a.kind === 'workbuddy' ? '已经登录（在 WorkBuddy 里登录的）。要换账号，请在 WorkBuddy 里操作。' : '已经登录。需要换账号时可以重新登录，或者在下面添加别的账号。'}</p>}
          <div className="login-methods">
            {browserMethods.map((m) => (
              <button key={m.id} type="button" className={'btn' + (!loggedIn ? ' attn' : '')} aria-busy={starting === m.id} disabled={!!starting}
                title={m.description ?? undefined} onClick={() => void start(m)}>
                {loggedIn ? (a.kind === 'codebuddy' ? `换账号：${m.name}` : `重新登录：${m.name}`) : m.name}
              </button>
            ))}
            {workbuddy && !loggedIn ? (
              <button type="button" className="btn" aria-busy={starting === workbuddy.id} disabled={!!starting} title={workbuddy.description ?? undefined}
                onClick={() => void start(workbuddy)}>{workbuddy.name}</button>
            ) : null}
          </div>
          {browserMethods.some((m) => m.description) ? (
            <ul className="method-notes">{browserMethods.filter((m) => m.description).map((m) => <li key={m.id}><b>{m.name}</b>：{m.description}</li>)}</ul>
          ) : null}
          {!browserMethods.length && !workbuddy ? <p className="muted-note">没有可以在界面里完成的登录方式。{hasApiKeyMethod ? '可以在下面添加“官方 API Key”账号。' : '点“重新检测”再看看。'}</p> : null}
          {hasApiKeyMethod ? <p className="muted-note">用 API Key：在下面“添加账号 → 官方 API Key”里粘贴密钥，不用在这里登录。</p> : null}
          {a.kind === 'workbuddy' && !loggedIn ? (
            <p className="muted-note">在 WorkBuddy 里登录后，回到这里点 <button type="button" className="linkish" onClick={onRedetect} disabled={redetecting}>重新检测</button>。</p>
          ) : null}
        </>
      ) : null}
    </>
  );
}

const STEPS = ['启动登录', '在浏览器中完成授权', '确认登录状态'];
const APP_STEPS = ['启动 WorkBuddy', '在 WorkBuddy 里登录', '确认登录状态'];

function LoginProgress({ a, login, methodId, methodName, onRedetect }: { a: AgentInfo; login: LoginInfo; methodId: string | null; methodName: string | null; onRedetect: () => void }) {
  const step = loginStep(login.state);
  const url = safeAuthUrl(login.authUrl);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  /** 取消、提交授权码失败：显示在登录框里（带按钮），不只是一条会消失的提示 */
  const [err, setErr] = useState<ApiError | null>(null);
  const running = !LOGIN_TERMINAL.has(login.state);
  /** 在 WorkBuddy 中登录：Gateway 只负责启动 WorkBuddy，登录在那边完成，没有浏览器步骤 */
  const isApp = methodId === WORKBUDDY_APP_METHOD;
  // 失败或取消时停在哪一步：记住最后一次进行中的步骤
  const lastStep = useRef(0);
  if (step >= 0 && step < 3) lastStep.current = step;
  const steps = isApp ? APP_STEPS : STEPS;

  const cancel = async () => {
    setBusy(true);
    setErr(null);
    try { await cancelLogin(a.kind, login.loginId); } catch (e) { setErr(asApiError(e)); } finally { setBusy(false); }
  };
  const submitCode = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try { await sendLoginCode(a.kind, login.loginId, code.trim()); setCode(''); } catch (e) { setErr(asApiError(e)); } finally { setBusy(false); }
  };
  // 打开外部链接、复制都走 Platform（桌面版交给系统浏览器、系统剪贴板）
  const reopen = async () => {
    if (!url) return;
    if (!(await platform.openExternal(url))) toast('没能打开浏览器，可以点“复制链接”后粘贴到浏览器里', 'attn');
  };
  const copy = async () => {
    if (!url) return;
    if (await platform.copyText(url)) toast('已复制授权链接'); else toast('复制失败，长按或右键链接复制', 'attn');
  };

  return (
    // 整个登录框不是 live 区域（里面有输入框和按钮，整段重读会打断输入）；只播报一行状态
    <div className="login-box">
      <span className="sr-only" aria-live="polite" aria-atomic="true">{loginAnnounceText(login.state, isApp)}</span>
      <div className="login-title">登录 {a.displayName}{methodName ? `：${methodName}` : ''}</div>
      {err ? <ErrorNotice error={err} ctx={{ kind: a.kind }} onDismiss={() => setErr(null)} /> : null}
      <ol className="login-steps">
        {steps.map((s, i) => {
          const state = login.state === 'failed' || login.state === 'cancelled'
            ? (i < lastStep.current ? 'done' : i === lastStep.current ? 'stop' : 'todo')
            : i < step ? 'done' : i === step ? 'now' : 'todo';
          return (
            <li key={s} className={state}>
              <span className="mk" aria-hidden="true">{state === 'done' ? <Icon name="check" size={12} /> : state === 'stop' ? <Icon name="x" size={12} /> : i + 1}</span>
              <span>{s}{i === 2 && login.state === 'succeeded' ? '：已登录' : ''}<span className="sr-only">{state === 'done' ? '（已完成）' : state === 'now' ? '（进行中）' : state === 'stop' ? '（没有完成）' : ''}</span></span>
            </li>
          );
        })}
      </ol>
      {isApp && running ? (
        <p>已启动 WorkBuddy。在 WorkBuddy 里登录，然后回到这里点 <button type="button" className="linkish" onClick={onRedetect}>重新检测</button>。</p>
      ) : null}
      {login.state === 'started' && !isApp ? <p>正在启动登录，马上会打开浏览器…</p> : null}
      {login.state === 'waiting_browser' && !isApp ? (
        <>
          <p>已在这台电脑的浏览器中打开授权页面。在浏览器里登录并确认授权，完成后这里会自动更新（最长等 10 分钟）。</p>
          {url ? (
            <p className="login-link">浏览器没有自动打开？
              <button type="button" className="btn sm" onClick={() => void reopen()}>重新打开</button>
              <button type="button" className="btn sm ghost" onClick={() => void copy()}>复制链接</button>
            </p>
          ) : null}
        </>
      ) : null}
      {login.state === 'need_code' ? (
        <div className="login-code">
          <p>浏览器里授权完成后，页面上会显示一段授权码。把它复制到这里：</p>
          {url ? <p className="login-link">授权页面：<button type="button" className="btn sm" onClick={() => void reopen()}>打开</button><button type="button" className="btn sm ghost" onClick={() => void copy()}>复制链接</button></p> : null}
          <div className="row">
            <label htmlFor={'lc-' + login.loginId} className="sr-only">授权码</label>
            <input id={'lc-' + login.loginId} className="input mono" value={code} autoComplete="off" spellCheck={false} placeholder="粘贴授权码"
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void submitCode(); } }} />
            <button type="button" className="btn primary sm" disabled={!code.trim() || busy} onClick={() => void submitCode()}>提交</button>
          </div>
        </div>
      ) : null}
      {login.state === 'succeeded' ? <div className="alert info"><Icon name="check" /><div className="body"><strong>登录成功</strong><p>{login.message ?? '现在可以用它派发任务了。'}</p></div></div> : null}
      {login.state === 'failed' ? (
        <div className="alert err"><Icon name="warn" /><div className="body"><strong>登录没有完成</strong>
          <p>{login.message ?? '可以再试一次；一直不行的话，可以添加“官方 API Key”账号。'}</p>
          <div className="err-actions"><button type="button" className="btn sm" onClick={onRedetect}>重新检测</button></div></div></div>
      ) : null}
      {login.state === 'cancelled' ? <p>已取消登录。</p> : null}
      {running ? <div className="row"><button type="button" className="btn sm" onClick={() => void cancel()} disabled={busy}>取消登录</button></div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// 账号：订阅登录 / 官方 API Key / 自定义地址。密钥只显示末 4 位
// ---------------------------------------------------------------------
function ProfileSection({ a, focusProfileId, onLogin, onTest, test }: {
  a: AgentInfo; focusProfileId: string | null;
  onLogin: (a: AgentInfo, methodId: string, profileId: string | null, force?: boolean) => Promise<void>;
  onTest: (o: { profileId?: string; sendMessage?: boolean }) => void;
  test: TestState | null;
}) {
  const list = useApp((s) => s.profiles[a.kind]);
  const [err, setErr] = useState<ApiError | null>(null);
  const load = () => { setErr(null); loadProfiles(a.kind).catch((e) => setErr(asApiError(e))); };
  useEffect(load, [a.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const methods = loginMethods(a).filter((m) => m.flow === 'browser' && m.id !== 'selfhosted');
  const experimental = a.kind === 'codebuddy';

  const openForm = (kind: AgentProfile['kind'], existing?: AgentProfile) => openDialog((close) => (
    <ProfileDialog agent={a} kind={kind} existing={existing} close={close} loginMethods={methods}
      onCreatedSubscription={(p, methodId) => void onLogin(a, methodId, p.id)} />
  ));

  const loginProfile = (p: AgentProfile, anchor: HTMLElement) => {
    if (methods.length === 1) { void onLogin(a, methods[0]!.id, p.id); return; }
    openMenu(anchor, methods.map((m) => ({ label: m.name, onSelect: () => void onLogin(a, m.id, p.id) })));
  };

  const more = (p: AgentProfile, anchor: HTMLElement) => openMenu(anchor, [
    { label: '编辑…', onSelect: () => openForm(p.kind, p) },
    { label: p.isDefault ? '✓ 默认账号' : '设为默认', disabled: p.isDefault, onSelect: () => { patchProfile(p.id, { isDefault: true }).then(() => toast(`默认账号改为“${p.name}”，新任务会用它`), (e) => setErr(asApiError(e))); } },
    ...(p.kind === 'customEndpoint' ? [{ label: '刷新模型列表', onSelect: () => { refreshProfileModels(p.id).then((x) => toast(`拿到 ${x.models.length} 个模型`), (e) => setErr(asApiError(e))); } }] : []),
    {
      label: isLocalLogin(p) ? '删除（本机登录不能删除）' : p.isDefault ? '删除（先把别的账号设为默认）' : '删除…',
      danger: true, disabled: isLocalLogin(p) || p.isDefault,
      onSelect: async () => {
        const ok = await confirmDialog({
          title: `删除账号“${p.name}”？`, ok: '删除', danger: true,
          body: <><p>用这个账号的任务会改用默认账号。{p.hasSecret ? '保存的密钥会一起删除。' : ''}</p>
            {p.configDir === 'isolated' ? <p style={{ margin: 0 }}>这个账号单独的配置目录会保留（里面可能有会话记录），需要时可以手动删除。</p> : null}</>,
        });
        if (!ok) return;
        try { const r = await deleteProfile(p); toast(r.keptDir ? `已删除账号“${p.name}”。它单独的配置目录保留在本机，需要时可以手动删除` : `已删除账号“${p.name}”`, 'ok', r.keptDir ? 6000 : 3600); } catch (e) { setErr(asApiError(e)); }
      },
    },
  ]);

  return (
    <>
      <h3>账号</h3>
      {err ? <ErrorNotice error={err} onRetry={load} /> : null}
      {!list && !err ? <p className="muted-note">正在读取账号…</p> : null}
      {list?.length === 0 ? <p className="muted-note">还没有账号。检测到 {a.displayName} 后会自动建一个“本机登录”。</p> : null}
      {list?.map((p) => {
        const testing = test?.running && test.profileId === p.id;
        return (
          <div key={p.id} className={'acct' + (focusProfileId === p.id ? ' focus' : '')} ref={(el) => { if (el && focusProfileId === p.id) el.scrollIntoView({ block: 'nearest' }); }}>
            <Icon name={p.kind === 'subscription' ? 'devices' : p.kind === 'apiKey' ? 'key' : 'plug'} />
            <div className="info">
              <b>{p.name}{p.isDefault ? <span className="tag">默认</span> : null}{p.experimental ? <span className="tag attn">实验</span> : null}</b>
              <span>{profileKindText[p.kind]} · {profileDesc(p)}</span>
            </div>
            {p.kind === 'subscription' && p.loggedIn === false && methods.length ? (
              <button type="button" className="btn sm attn" onClick={(e) => loginProfile(p, e.currentTarget)}>登录</button>
            ) : null}
            <button type="button" className="btn sm" aria-busy={testing} disabled={!!test?.running} onClick={() => onTest({ profileId: p.id })}>{testing ? '测试中…' : '测试'}</button>
            <button type="button" className="btn ghost icon sm" aria-label={`${p.name} 的更多操作`} aria-haspopup="menu" onClick={(e) => more(p, e.currentTarget)}><Icon name="more" /></button>
          </div>
        );
      })}
      <h3>添加账号</h3>
      <div className="method">
        <button type="button" disabled={!methods.length} title={methods.length ? undefined : '这个 Agent 没有可以在界面里完成的订阅登录'} onClick={() => openForm('subscription')}>
          <b>订阅登录</b><span>第二个订阅账号，在浏览器中授权</span></button>
        <button type="button" onClick={() => openForm('apiKey')}><b>官方 API Key{experimental ? '（实验）' : ''}</b><span>粘贴密钥，加密保存在本机</span></button>
        <button type="button" onClick={() => openForm('customEndpoint')}><b>自定义地址{experimental ? '（实验）' : ''}</b><span>兼容第三方中转</span></button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// 默认设置：默认模型、默认思考强度、并发上限、引擎（仅 Claude）、引擎位置、工作区设置
// ---------------------------------------------------------------------
function SettingsSection({ a }: { a: AgentInfo }) {
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const real = isRealAgent(a.kind);
  const save = async (body: Parameters<typeof patchAgent>[1], text: string) => {
    setSaving(true);
    setErr(null);
    try { await patchAgent(a.kind, body); toast(text); } catch (e) { setErr(asApiError(e)); } finally { setSaving(false); }
  };
  const source = { session: '来自最近的会话', cache: '来自上次检测', manual: '手填', none: '首次使用后显示模型列表' }[a.modelsSource ?? 'cache'];
  const def = taskDefaults(a);
  const ws = workspaceConfigNote(a);
  // 保存的默认模型不在当前列表里（例如模型下线）：仍显示出来，让用户知道并改掉
  const staleModel = real && a.defaultModel && !a.models.some((m) => m.id === a.defaultModel) ? a.defaultModel : null;
  return (
    <>
      <h3>{a.usesNativeConfig ? '工作台任务默认值' : '默认设置'}</h3>
      {a.usesNativeConfig ? <p className="muted-note">以下选项只用于工作台的新任务，不修改软件自身的默认设置。</p> : null}
      {err ? <ErrorNotice error={err} ctx={{ kind: a.kind }} onDismiss={() => setErr(null)} /> : null}
      {real ? (
        <div className="field"><label htmlFor={'dm-' + a.kind}>默认模型</label>
          <span>
            <select id={'dm-' + a.kind} className="select" value={staleModel ?? def.model} disabled={saving || !a.models.length}
              onChange={(e) => void save({ defaultModel: e.target.value || null }, e.target.value ? `新任务默认用 ${a.models.find((m) => m.id === e.target.value)?.name ?? e.target.value}` : '新任务默认用 Agent 自己的默认模型')}>
              <option value="">Agent 自己的默认模型</option>
              {staleModel ? <option value={staleModel}>{staleModel}（现在不可用）</option> : null}
              {a.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <span className="note">{a.models.length ? `${source}；派发时可以换` : emptyModelsText(a)}</span>
          </span></div>
      ) : (
        <div className="field"><span className="lbl">模型</span>
          <span>{a.models.length ? a.models.map((m) => m.name).join('、') : emptyModelsText(a)}</span></div>
      )}
      {real && a.efforts?.length ? (
        <div className="field"><label htmlFor={'de-' + a.kind}>默认思考强度</label>
          <select id={'de-' + a.kind} className="select" value={def.effort} disabled={saving}
            onChange={(e) => void save({ defaultEffort: e.target.value || null }, e.target.value ? `新任务默认思考强度：${effortLabel(e.target.value)}` : '新任务默认用 Agent 自己的思考强度')}>
            <option value="">Agent 默认</option>
            {a.efforts.map((x) => <option key={x} value={x}>{effortLabel(x)}</option>)}
          </select></div>
      ) : (
        <div className="field"><span className="lbl">思考强度</span><span>{a.efforts?.length ? a.efforts.map(effortLabel).join(' / ') : '由模型自己决定'}</span></div>
      )}
      {ws ? <div className="field"><span className="lbl">工作区设置</span><span className={ws.warn ? 'note unverified' : undefined}>{ws.text}</span></div> : null}
      {real && a.concurrencyLimit !== undefined ? (
        <div className="field"><label htmlFor={'cc-' + a.kind}>并发上限</label>
          <select id={'cc-' + a.kind} className="select" value={a.concurrencyLimit} disabled={saving}
            onChange={(e) => void save({ concurrencyLimit: Number(e.target.value) }, `并发上限改为 ${e.target.value}`)}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} 个会话</option>)}
          </select></div>
      ) : null}
      {a.kind === 'claude' && a.engineSource ? (
        <div className="field"><label htmlFor="eng-claude">引擎</label>
          <select id="eng-claude" className="select" value={a.engineSource === 'local' ? 'local' : 'bundled'} disabled={saving}
            onChange={(e) => void save({ engine: e.target.value as 'bundled' | 'local' }, e.target.value === 'local' ? '改为使用本机的 Claude Code' : '改为使用适配器自带的引擎')}>
            <option value="bundled">适配器自带（已和适配器一起测过，推荐）</option>
            <option value="local">本机安装的 Claude Code</option>
          </select></div>
      ) : null}
      {a.engineLocation ? <div className="field"><span className="lbl">引擎位置</span><span className="mono loc">{a.engineLocation}</span></div> : null}
      {a.adapterVersion || a.engineVersion ? (
        <div className="field"><span className="lbl">版本</span><span>{[a.adapterVersion ? `适配器 ${a.adapterVersion}` : null, a.engineVersion ? `引擎 ${a.engineVersion}` : null].filter(Boolean).join('，')}
          {!a.verified ? <span className="note unverified">不在已验证的版本表里：照常可用，遇到问题请反馈</span> : null}</span></div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------
// 测试连接：找到引擎 → 握手 → 新建会话 → 读模型列表 → 关闭；可选发一条测试消息
// ---------------------------------------------------------------------
function TestSection({ a, test, onTest }: { a: AgentInfo; test: TestState | null; onTest: (o: { profileId?: string; sendMessage?: boolean }) => void }) {
  const profileName = useApp((s) => (test?.profileId ? s.profiles[a.kind]?.find((p) => p.id === test.profileId)?.name : null));
  const running = !!test?.running;
  return (
    <>
      <h3>测试连接<span className="grow" />
        <button type="button" className="btn sm" disabled={running || a.status === 'not_installed'} aria-busy={running && !test?.sendMessage}
          onClick={() => onTest({})}><Icon name="refresh" />{test?.result || test?.error ? '再测一次' : '测试连接'}</button>
      </h3>
      <p className="muted-note">只做握手和新建会话，不发消息，不花钱。</p>
      <button type="button" className="btn sm ghost" disabled={running || a.status !== 'ready'} aria-busy={running && test?.sendMessage}
        onClick={() => onTest({ sendMessage: true })}>发送测试消息（会产生少量费用）</button>
      {running ? <pre className="testlog mono" role="status">正在测试{profileName ? `“${profileName}”` : ''}…</pre> : null}
      {test?.error ? <ErrorNotice error={test.error} /> : null}
      {test?.result && !running ? (
        <pre className={'testlog mono' + (test.result.ok ? '' : ' bad')} aria-label="测试日志">
          {profileName ? `账号：${profileName}\n` : ''}{formatTestLog(test.result)}
        </pre>
      ) : null}
    </>
  );
}
