// 设置页“安全防护状态”卡片：只读展示已默认开启的工作台安全底盘，使用非技术人员可读的中文说明。
import { useEffect, useRef, useState } from 'react';
import type { ApiError, SecurityStatus } from '@aic/protocol';
import { api } from '../state/app';
import { Icon } from '../components/Icon';
import { ErrorNotice, asApiError } from '../components/ui';

interface SecurityRow {
  key: string;
  title: string;
  enabled: boolean;
  badgeText?: string;
  description: string;
}

function buildRows(status: SecurityStatus): SecurityRow[] {
  return [
    {
      key: 'provenance',
      title: '消息来源防伪隔离',
      enabled: status.provenanceFence.active,
      description: '自动区分你发送的指令、交接背景和历史/外部参考资料，防止参考文本冒充你的命令或篡改审批级别。',
    },
    {
      key: 'subprocess',
      title: '子进程环境白名单隔离',
      enabled: status.subprocessEnvIsolation.active,
      description: '受控命令与子进程只在最小运行环境与独立临时目录中执行，不继承本机其他工具或账号的密钥。',
    },
    {
      key: 'egress',
      title: '出站防内网探测门禁',
      enabled: status.egressGuard.active,
      description: status.egressGuard.allowFakeIpProxy
        ? '拦截外部请求探测本机、内网与工作台自身端口；当前仅放行域名解析出的代理 fake-ip 网段（198.18.x）。'
        : '默认拦截联网请求探测本机、局域网与工作台自身端口，防止借外部请求访问内网资源。',
    },
    {
      key: 'secrets',
      title: '本机密钥系统加密保存',
      enabled: status.secretStorage.mode === 'dpapi',
      badgeText: status.secretStorage.mode === 'dpapi' ? '已开启' : '未启用',
      description: status.secretStorage.mode === 'dpapi'
        ? `工作台已通过 Windows 系统加密（DPAPI）妥善保存 ${status.secretStorage.encryptedCount} 项密钥，绝不以明文写入项目目录。`
        : '当前运行环境不支持 Windows 本机加密存储，暂时无法在工作台保存新密钥。',
    },
    {
      key: 'lan',
      title: '局域网与本机操作边界',
      enabled: status.lanBoundary.localOnlyWriteGuard,
      description: `${status.lanBoundary.lanEnabled ? '局域网访问已开启' : '局域网访问未开启'} · 当前为${status.lanBoundary.currentConnection === 'lan' ? '局域网设备' : '本机电脑'}连接；增删密钥、改设置等高敏操作仅限运行工作台的电脑。`,
    },
    {
      key: 'markdown',
      title: '对话正文外链与图片拦截',
      enabled: status.markdownSafety.blockRemoteImages && status.markdownSafety.blockNonHttpLinks,
      description: 'Agent 回复中的远程图片不会静默向外发请求，脚本等非常规协议链接自动降级为纯文本。',
    },
  ];
}

export function SecurityStatusSection({ initialStatus }: { initialStatus?: SecurityStatus | null }) {
  const [status, setStatus] = useState<SecurityStatus | null>(initialStatus ?? null);
  const [loading, setLoading] = useState(initialStatus === undefined);
  const [error, setError] = useState<ApiError | null>(null);
  const mountedRef = useRef(true);
  const reqIdRef = useRef(0);

  const load = () => {
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    api.securityStatus().then(
      (data) => {
        if (!mountedRef.current || reqIdRef.current !== id) return;
        setStatus(data);
        setLoading(false);
      },
      (err) => {
        if (!mountedRef.current || reqIdRef.current !== id) return;
        setError(asApiError(err));
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    mountedRef.current = true;
    if (initialStatus !== undefined) {
      reqIdRef.current++;
      setStatus(initialStatus);
      setLoading(false);
      return () => {
        mountedRef.current = false;
      };
    }
    load();
    return () => {
      mountedRef.current = false;
    };
  }, [initialStatus]);

  const rows = status ? buildRows(status) : [];

  return (
    <section className="set-sec" aria-labelledby="s-security">
      <div className="security-head">
        <h3 id="s-security">
          <Icon name="shieldcheck" />
          <span>安全防护状态</span>
        </h3>
        {initialStatus === undefined ? (
          <button type="button" className="btn sm ghost" disabled={loading} onClick={load}>
            <Icon name="refresh" />
            {loading ? '正在检查…' : '重新检查'}
          </button>
        ) : null}
      </div>
      <p className="security-lead">工作台默认开启以下基础防护，减少误操作与信息泄露风险；以下条目仅作透明展示，不暴露任何路径或密钥。</p>
      {error ? <ErrorNotice error={error} onRetry={load} /> : null}
      {!status && loading ? <p role="status">正在读取安全防护状态…</p> : null}
      {status ? (
        <ul className="security-list" aria-label="安全防护检查列表">
          {rows.map((row) => (
            <li key={row.key} className="security-item">
              <div className="security-item-top">
                <span className="security-item-title">{row.title}</span>
                <span className={'security-badge ' + (row.enabled ? 'on' : 'warn')}>
                  {row.badgeText ?? (row.enabled ? '已开启' : '未开启')}
                </span>
              </div>
              <p className="security-item-desc">{row.description}</p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
