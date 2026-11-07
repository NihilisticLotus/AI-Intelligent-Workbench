// 添加 / 编辑账号：订阅登录、官方 API Key、自定义地址（phase-1.md 6.4）。
// 密钥输入框是 password 类型，只随这一次请求发给服务端；接口不会再返回明文，界面只显示末 4 位。
import { useState } from 'react';
import type { AgentInfo, AgentProfile, ApiError, AuthMethod, ProfileKind } from '@aic/protocol';
import { createProfile, patchProfile } from '../state/app';
import { toast } from '../state/ui';
import { SECRET_STORE_TEXT, parseModelList, profileKindText, validateProfileDraft, type ProfileDraft } from '../lib/agents';
import { Dialog, ErrorNotice, asApiError } from '../components/ui';
import { Icon } from '../components/Icon';

export function ProfileDialog({ agent, kind, existing, close, loginMethods, onCreatedSubscription }: {
  agent: AgentInfo; kind: ProfileKind; existing?: AgentProfile | undefined; close: () => void;
  /** 订阅登录可用的浏览器登录方式 */
  loginMethods: AuthMethod[];
  /** 新建订阅账号后，用选定的登录方式开始登录 */
  onCreatedSubscription: (p: AgentProfile, methodId: string) => void;
}) {
  const editing = !!existing;
  const [d, setD] = useState<ProfileDraft>(() => ({
    kind,
    name: existing?.name ?? defaultName(agent, kind),
    baseUrl: existing?.baseUrl ?? '',
    authHeader: existing?.authHeader ?? 'x-api-key',
    apiKey: '',
    models: existing?.models.map((m) => m.id).join('\n') ?? '',
  }));
  const [methodId, setMethodId] = useState(loginMethods[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const up = (patch: Partial<ProfileDraft>) => { setD((x) => ({ ...x, ...patch })); setProblem(null); };

  const experimental = agent.kind === 'codebuddy' && kind !== 'subscription';
  // 鉴权头：Claude 区分 x-api-key 和 Bearer；CodeBuddy 区分 API_KEY 和 AUTH_TOKEN；Codex 用 provider 的 env_key，不需要选
  const showAuthHeader = kind === 'customEndpoint' && agent.kind !== 'codex';

  const submit = async () => {
    if (busy) return;
    const p = validateProfileDraft(d, editing);
    if (p) { setProblem(p); return; }
    if (kind === 'subscription' && !editing && !methodId) { setProblem('这个 Agent 没有可以在界面里完成的订阅登录'); return; }
    setBusy(true);
    setErr(null);
    const models = kind === 'customEndpoint' ? parseModelList(d.models) : undefined;
    const apiKey = d.apiKey.trim() || undefined;
    try {
      if (existing) {
        const saved = await patchProfile(existing.id, {
          name: d.name.trim(),
          ...(kind === 'customEndpoint' ? { baseUrl: d.baseUrl.trim(), models: models ?? [] } : {}),
          ...(showAuthHeader ? { authHeader: d.authHeader } : {}),
          ...(apiKey ? { apiKey } : {}),
        });
        toast(apiKey && saved.secretHint ? `已保存，密钥结尾 …${saved.secretHint}` : '已保存');
        close();
        return;
      }
      const saved = await createProfile({
        agent: agent.kind, name: d.name.trim(), kind,
        // 第二个订阅账号用单独的配置目录；API Key 和自定义地址由服务端决定
        ...(kind === 'subscription' ? { configDir: 'isolated' as const } : {}),
        ...(kind === 'customEndpoint' ? { baseUrl: d.baseUrl.trim(), ...(models?.length ? { models } : {}) } : {}),
        ...(showAuthHeader ? { authHeader: d.authHeader } : {}),
        ...(apiKey ? { apiKey } : {}),
      });
      close();
      if (kind === 'subscription') {
        toast(`已添加“${saved.name}”，正在打开浏览器登录`);
        onCreatedSubscription(saved, methodId);
      } else {
        toast(saved.secretHint ? `已添加“${saved.name}”，密钥结尾 …${saved.secretHint}。可以点“测试”试一下` : `已添加“${saved.name}”`);
      }
    } catch (e) {
      setErr(asApiError(e));
      setBusy(false);
    }
  };

  const title = `${editing ? '编辑' : '添加'} ${agent.displayName} 账号：${profileKindText[kind]}`;
  return (
    <Dialog title={title} onClose={close} initialFocus="#pf-name"
      footer={<>
        <button type="button" className="btn" onClick={close}>取消</button>
        <button type="button" className="btn primary" aria-busy={busy} disabled={busy} onClick={() => void submit()}>
          {editing ? '保存' : kind === 'subscription' ? '添加并登录' : '保存'}</button>
      </>}>
      {err ? <ErrorNotice error={err} /> : null}
      {experimental ? (
        <div className="alert attn"><Icon name="warn" /><div className="body"><strong>实验功能</strong>
          <p>CodeBuddy 的 API Key 和自定义地址只有源码依据，还没有实测。保存后先点“测试”。</p></div></div>
      ) : null}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} autoComplete="off">
        <div className="form-row"><label htmlFor="pf-name">名称</label>
          <input id="pf-name" className="input" value={d.name} maxLength={100} onChange={(e) => up({ name: e.target.value })} />
        </div>
        {kind === 'subscription' ? (
          <>
            {!editing && loginMethods.length > 1 ? (
              <div className="form-row"><label htmlFor="pf-m">登录方式</label>
                <select id="pf-m" className="select" value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                  {loginMethods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            ) : null}
            {!editing ? (
              <p className="form-note">这个账号用单独的配置目录，和这台电脑上已有的登录互不影响。保存后会在浏览器里打开授权页面，按页面提示登录。</p>
            ) : null}
          </>
        ) : null}
        {kind === 'customEndpoint' ? (
          <>
            <div className="form-row"><label htmlFor="pf-url">地址</label>
              <input id="pf-url" className="input mono" value={d.baseUrl} maxLength={500} spellCheck={false} inputMode="url"
                placeholder="https://relay.example.com" onChange={(e) => up({ baseUrl: e.target.value })} />
            </div>
            {showAuthHeader ? (
              <div className="form-row"><label htmlFor="pf-h">鉴权方式</label>
                <select id="pf-h" className="select" value={d.authHeader} onChange={(e) => up({ authHeader: e.target.value as ProfileDraft['authHeader'] })}>
                  <option value="x-api-key">{agent.kind === 'codebuddy' ? 'API Key' : 'x-api-key 头（官方格式）'}</option>
                  <option value="bearer">{agent.kind === 'codebuddy' ? 'Auth Token' : 'Authorization: Bearer（多数中转用这个）'}</option>
                </select>
              </div>
            ) : null}
          </>
        ) : null}
        {kind !== 'subscription' ? (
          <div className="form-row"><label htmlFor="pf-key">{editing ? '新密钥' : '密钥'}</label>
            <input id="pf-key" className="input mono" type="password" value={d.apiKey} maxLength={4000} autoComplete="new-password" spellCheck={false}
              placeholder={editing ? (existing?.secretHint ? `留空表示不修改（现在结尾 …${existing.secretHint}）` : '留空表示不修改') : '粘贴密钥'}
              onChange={(e) => up({ apiKey: e.target.value })} />
          </div>
        ) : null}
        {kind !== 'subscription' ? <p className="form-note"><Icon name="shield" size={13} /> {SECRET_STORE_TEXT}。保存后只显示结尾 4 位，任何接口都不会再返回完整密钥。</p> : null}
        {kind !== 'subscription' && agent.kind === 'codex' ? <p className="form-note">Codex 还会在这个账号的独立目录里保存自己的 API 登录凭据。删除账号会移除工作台保存的密钥，Agent 的历史与独立目录会保留。</p> : null}
        {kind === 'customEndpoint' ? (
          <div className="form-row top"><label htmlFor="pf-models">模型（可选）</label>
            <textarea id="pf-models" className="textarea mono" rows={3} value={d.models} spellCheck={false}
              placeholder="每行一个模型 ID" onChange={(e) => up({ models: e.target.value })} />
          </div>
        ) : null}
        {kind === 'customEndpoint' ? <p className="form-note">留空时会请求地址的 /models 自动获取；拿不到时用这里手填的列表。</p> : null}
        {problem ? <p className="form-problem" role="alert"><Icon name="warn" size={13} /> {problem}</p> : null}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function defaultName(a: AgentInfo, kind: ProfileKind): string {
  switch (kind) {
    case 'subscription': return '第二个订阅账号';
    case 'apiKey': return `${a.displayName} API Key`;
    case 'customEndpoint': return '第三方中转';
  }
}
