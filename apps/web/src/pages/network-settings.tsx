// 设置页“网络”一节：本机代理 fake-ip 网段的显式开关（ISSUE-0053）。默认关闭，只影响工作台自己的独立 Agent。
import { useEffect, useState } from 'react';
import type { ApiError, IndependentNetworkSettings } from '@aic/protocol';
import { api } from '../state/app';
import { ErrorNotice, asApiError } from '../components/ui';
import { toast } from '../state/ui';

export function NetworkSettingsSection() {
  const [value, setValue] = useState<IndependentNetworkSettings | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => { setErr(null); api.independentNetwork().then(setValue, (e) => setErr(asApiError(e))); };
  useEffect(load, []);
  const toggle = async (on: boolean) => {
    setBusy(true); setErr(null);
    try {
      const next = await api.putIndependentNetwork({ allowFakeIpProxy: on });
      setValue(next);
      toast(on ? '已允许本机代理的 fake-ip 网段，只对工作台的独立 Agent 生效' : '已关闭：独立 Agent 不再连接 198.18.x 网段');
    } catch (e) { setErr(asApiError(e)); } finally { setBusy(false); }
  };
  return (
    <section className="set-sec" aria-labelledby="s-net">
      <h3 id="s-net">网络</h3>
      {err ? <ErrorNotice error={err} onRetry={load} /> : null}
      <label className="check-row">
        <input type="checkbox" checked={value?.allowFakeIpProxy ?? false} disabled={!value || busy}
          onChange={(e) => void toggle(e.target.checked)} />
        <span>允许本机代理的 fake-ip 网段（198.18.x）
          <small>{[
            '有些代理软件开启 fake-ip 模式后，会把供应商的域名解析成 198.18.x 的假地址再自己转发。',
            '工作台为了安全默认拒绝这类地址，所以“获取模型与能力”和独立 Agent 的对话会失败，提示“解析到本机代理的 fake-ip 网段”。',
            '打开后只放行这一个网段，并且只放行由域名解析得到的地址：直接填写的内网 IP、本机地址和公共目录仍然拒绝。',
            '请求会经过你的代理软件，它能看到你访问了哪个供应商。Claude Code、Codex、CodeBuddy 用它们自己的网络设置，不受这里影响。',
          ].join('')}</small>
        </span>
      </label>
    </section>
  );
}
