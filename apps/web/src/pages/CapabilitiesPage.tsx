// 能力中心（第 2.3 / 2.4 步）：MCP 工具管家、技能库（Skills）、静态安全扫描与本机只读导入管理界面。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentKind, ApiError, CreateMcpServerBody, McpConcurrency, McpParsedCandidate, McpParseResult,
  McpServerSummary, McpTestResult, McpTransport, PatchMcpServerBody, SkillSummary,
} from '@aic/protocol';
import { toApiError } from '../api/http';
import { Icon } from '../components/Icon';
import { confirmDialog, ErrorNotice } from '../components/ui';
import { agentFallback, clock } from '../lib/format';
import { api, useApp, useRemoteAccess } from '../state/app';
import { toast, toastError } from '../state/ui';
import { SkillsPanel } from './skills-panel';

interface KvRow {
  key: string;
  value: string;
}

interface McpFormState {
  id?: string;
  name: string;
  description: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  url: string;
  concurrency: McpConcurrency;
  agents: AgentKind[];
  enabled: boolean;
  envRows: KvRow[];
  headerRows: KvRow[];
  existingEnvKeys: Array<{ key: string; hint: string }>;
  existingHeaderKeys: Array<{ key: string; hint: string }>;
  removeEnvKeys: string[];
  removeHeaderKeys: string[];
}

const ALL_AGENT_KINDS: AgentKind[] = ['independent', 'claude', 'codex', 'codebuddy', 'zcode', 'workbuddy', 'antigravity', 'fake'];

function emptyForm(): McpFormState {
  return {
    name: '',
    description: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    url: '',
    concurrency: 'shared',
    agents: [],
    enabled: true,
    envRows: [],
    headerRows: [],
    existingEnvKeys: [],
    existingHeaderKeys: [],
    removeEnvKeys: [],
    removeHeaderKeys: [],
  };
}

function formFromServer(srv: McpServerSummary): McpFormState {
  return {
    id: srv.id,
    name: srv.name,
    description: srv.description,
    transport: srv.transport,
    command: srv.command ?? '',
    argsText: srv.args.join('\n'),
    url: srv.url ?? '',
    concurrency: srv.concurrency,
    agents: [...srv.agents],
    enabled: srv.enabled,
    envRows: [],
    headerRows: [],
    existingEnvKeys: srv.envSecrets.map((s) => ({ key: s.key, hint: s.hint })),
    existingHeaderKeys: srv.headerSecrets.map((s) => ({ key: s.key, hint: s.hint })),
    removeEnvKeys: [],
    removeHeaderKeys: [],
  };
}

function formFromCandidate(cand: McpParsedCandidate): McpFormState {
  return {
    name: cand.name,
    description: cand.description,
    transport: cand.transport,
    command: cand.command ?? '',
    argsText: cand.args.join('\n'),
    url: cand.url ?? '',
    concurrency: cand.concurrency,
    agents: [],
    enabled: true,
    envRows: Object.entries(cand.envValues).map(([key, value]) => ({ key, value })),
    headerRows: Object.entries(cand.headerValues).map(([key, value]) => ({ key, value })),
    existingEnvKeys: [],
    existingHeaderKeys: [],
    removeEnvKeys: [],
    removeHeaderKeys: [],
  };
}

function statusMeta(srv: McpServerSummary): { label: string; cls: string; mark: string } {
  if (!srv.enabled || srv.status === 'disabled') return { label: '已停用', cls: 'idle', mark: '○' };
  switch (srv.status) {
    case 'ready': return { label: '就绪', cls: 'ok', mark: '●' };
    case 'starting': return { label: '连接中', cls: 'wait', mark: '◆' };
    case 'error': return { label: '连接失败', cls: 'err', mark: '■' };
    default: return { label: '未测试', cls: 'idle', mark: '○' };
  }
}

function formatLabel(fmt: McpParseResult['format']): string {
  if (fmt === 'json') return 'JSON 配置片段';
  if (fmt === 'claude_cli') return 'claude mcp add 命令';
  if (fmt === 'url') return '远程 HTTP 地址';
  return '单行启动命令';
}

export function CapabilitiesPage({
  initialServers,
  initialSkills,
  initialTab,
}: {
  initialServers?: McpServerSummary[] | null;
  initialSkills?: SkillSummary[] | null;
  initialTab?: 'mcp' | 'skills';
}) {
  const remote = useRemoteAccess();
  const knownAgents = useApp((s) => s.agents);
  const [tab, setTab] = useState<'mcp' | 'skills'>(initialTab ?? 'mcp');
  const [servers, setServers] = useState<McpServerSummary[]>(initialServers ?? []);
  const [skills, setSkills] = useState<SkillSummary[]>(initialSkills ?? []);
  const [loading, setLoading] = useState(initialServers === undefined);
  const [skillsLoading, setSkillsLoading] = useState(initialSkills === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [skillsError, setSkillsError] = useState<ApiError | null>(null);
  const [skillCreateToken, setSkillCreateToken] = useState(0);

  const [editing, setEditing] = useState<McpFormState | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [parseResult, setParseResult] = useState<McpParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, McpTestResult>>({});
  const [expandedToolsId, setExpandedToolsId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const reqIdRef = useRef(0);
  const skillReqIdRef = useRef(0);

  const loadSkills = useCallback(async (soft = false) => {
    const id = ++skillReqIdRef.current;
    if (!soft) setSkillsLoading(true);
    setSkillsError(null);
    try {
      const items = await api.skills();
      if (!mountedRef.current || id !== skillReqIdRef.current) return;
      setSkills(items);
    } catch (e) {
      if (!mountedRef.current || id !== skillReqIdRef.current) return;
      setSkillsError(toApiError(e));
    } finally {
      if (mountedRef.current && id === skillReqIdRef.current) {
        setSkillsLoading(false);
      }
    }
  }, []);

  const load = useCallback(async (soft = false) => {
    const id = ++reqIdRef.current;
    if (soft) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const items = await api.mcpServers();
      if (!mountedRef.current || id !== reqIdRef.current) return;
      setServers(items);
    } catch (e) {
      if (!mountedRef.current || id !== reqIdRef.current) return;
      setError(toApiError(e));
    } finally {
      if (mountedRef.current && id === reqIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (initialServers === undefined) void load(false);
    if (initialSkills === undefined) void loadSkills(false);
    return () => { mountedRef.current = false; };
  }, [initialServers, initialSkills, load, loadSkills]);

  const agentDisplayName = (kind: AgentKind) =>
    knownAgents.find((a) => a.kind === kind)?.displayName ?? agentFallback[kind]?.name ?? kind;

  const openCreate = () => {
    if (remote) return;
    setTab('mcp');
    setPasteText('');
    setParseResult(null);
    setFormError(null);
    setEditing(emptyForm());
  };

  const openEdit = (srv: McpServerSummary) => {
    if (remote) return;
    setPasteText('');
    setParseResult(null);
    setFormError(null);
    setEditing(formFromServer(srv));
  };

  const runSmartParse = async () => {
    if (remote || parsing || !pasteText.trim()) return;
    setParsing(true);
    setFormError(null);
    try {
      const res = await api.parseMcp(pasteText);
      if (!mountedRef.current) return;
      setParseResult(res);
      setEditing(formFromCandidate(res.candidates[0]!));
      toast(`已识别为 ${formatLabel(res.format)}，请核对后保存`);
    } catch (err) {
      if (!mountedRef.current) return;
      setFormError(toApiError(err).message);
    } finally {
      if (mountedRef.current) setParsing(false);
    }
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || remote || saving) return;
    const name = editing.name.trim();
    if (!name) { setFormError('请填写 MCP 名称'); return; }
    const args = editing.argsText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const envValues: Record<string, string> = {};
    for (const row of editing.envRows) {
      const k = row.key.trim();
      const v = row.value;
      if (k && v) envValues[k] = v;
    }
    const headerValues: Record<string, string> = {};
    for (const row of editing.headerRows) {
      const k = row.key.trim();
      const v = row.value;
      if (k && v) headerValues[k] = v;
    }

    if (editing.transport === 'stdio' && !editing.command.trim()) {
      setFormError('请填写本机启动命令（例如 node、npx 或 uvx）');
      return;
    }
    if (editing.transport === 'http' && !editing.url.trim()) {
      setFormError('请填写远程 MCP 服务地址（http:// 或 https://）');
      return;
    }

    setFormError(null);
    setSaving(true);
    try {
      if (editing.id) {
        const patch: PatchMcpServerBody = {
          name,
          description: editing.description.trim(),
          transport: editing.transport,
          command: editing.transport === 'stdio' ? editing.command.trim() : null,
          args: editing.transport === 'stdio' ? args : [],
          url: editing.transport === 'http' ? editing.url.trim() : null,
          concurrency: editing.concurrency,
          agents: editing.agents,
          enabled: editing.enabled,
          ...(Object.keys(envValues).length ? { envValues } : {}),
          ...(editing.removeEnvKeys.length ? { removeEnvKeys: editing.removeEnvKeys } : {}),
          ...(Object.keys(headerValues).length ? { headerValues } : {}),
          ...(editing.removeHeaderKeys.length ? { removeHeaderKeys: editing.removeHeaderKeys } : {}),
        };
        await api.patchMcpServer(editing.id, patch);
        if (!mountedRef.current) return;
        toast('MCP 配置已更新');
      } else {
        const body: CreateMcpServerBody = {
          name,
          description: editing.description.trim(),
          transport: editing.transport,
          command: editing.transport === 'stdio' ? editing.command.trim() : null,
          args: editing.transport === 'stdio' ? args : [],
          url: editing.transport === 'http' ? editing.url.trim() : null,
          concurrency: editing.concurrency,
          agents: editing.agents,
          enabled: editing.enabled,
          ...(Object.keys(envValues).length ? { envValues } : {}),
          ...(Object.keys(headerValues).length ? { headerValues } : {}),
        };
        await api.createMcpServer(body);
        if (!mountedRef.current) return;
        toast('已添加 MCP 服务，建议点击“测试连接”读取工具列表');
      }
      setEditing(null);
      setParseResult(null);
      setPasteText('');
      await load(true);
    } catch (err) {
      if (!mountedRef.current) return;
      const apiErr = toApiError(err);
      setFormError(apiErr.message);
      toastError(apiErr);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const toggleEnabled = async (srv: McpServerSummary) => {
    if (remote || saving) return;
    setSaving(true);
    try {
      await api.patchMcpServer(srv.id, { enabled: !srv.enabled });
      if (!mountedRef.current) return;
      toast(srv.enabled ? `已停用「${srv.name}」` : `已启用「${srv.name}」`);
      await load(true);
    } catch (err) {
      if (!mountedRef.current) return;
      toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const removeServer = async (srv: McpServerSummary) => {
    if (remote || saving) return;
    const ok = await confirmDialog({
      title: `删除 MCP「${srv.name}」？`,
      body: '删除后会同时清除工作台内为该服务加密保存的密钥，不会改动各第三方 Agent 自身的配置文件。',
      ok: '确认删除',
      danger: true,
    });
    if (!ok || !mountedRef.current) return;
    setSaving(true);
    try {
      await api.deleteMcpServer(srv.id);
      if (!mountedRef.current) return;
      if (editing?.id === srv.id) setEditing(null);
      toast(`已删除「${srv.name}」`);
      await load(true);
    } catch (err) {
      if (!mountedRef.current) return;
      toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const runTest = async (srv: McpServerSummary) => {
    if (remote || testingId) return;
    setTestingId(srv.id);
    try {
      const res = await api.testMcpServer(srv.id);
      if (!mountedRef.current) return;
      setTestResults((prev) => ({ ...prev, [srv.id]: res }));
      setExpandedToolsId(srv.id);
      if (res.ok) toast(`「${srv.name}」连接成功，发现 ${res.tools.length} 个工具`);
      else toast(`「${srv.name}」连接失败：${res.error ?? '请查看详情'}`, 'err');
      await load(true);
    } catch (err) {
      if (!mountedRef.current) return;
      toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setTestingId(null);
    }
  };

  const toggleAgentChoice = (kind: AgentKind) => {
    if (!editing) return;
    const has = editing.agents.includes(kind);
    setEditing({
      ...editing,
      agents: has ? editing.agents.filter((a) => a !== kind) : [...editing.agents, kind],
    });
  };

  return (
    <main className="main">
      <header className="main-head">
        <h1>能力</h1>
        <div className="cap-head-acts">
          <button
            type="button"
            className="btn"
            disabled={loading || skillsLoading || refreshing}
            onClick={() => { void load(true); void loadSkills(true); }}
          >
            <Icon name="refresh" />{refreshing ? '刷新中…' : '刷新'}
          </button>
          {tab === 'mcp' ? (
            <button type="button" className="btn primary" disabled={remote || saving} onClick={openCreate}>
              <Icon name="plus" />添加 MCP
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={remote || saving} onClick={() => setSkillCreateToken((n) => n + 1)}>
              <Icon name="plus" />新建技能
            </button>
          )}
        </div>
      </header>
      <div className="content-scroll">
        <div className={'page cap-page' + (refreshing ? ' refetch' : '')}>
          <p className="cap-intro">
            把各 Agent 常用的工具连接（MCP）和技能包收拢到工作台统一管理：密钥只存本机加密库，进程按需常驻共享并自动回收，工具过多时自动切换渐进式搜索，返回超 8,000 字保留头尾摘要、支持分页回查并套上防注入围栏。
          </p>

          <div className="tabs cap-tabs" role="tablist" aria-label="能力分类">
            <button type="button" role="tab" aria-selected={tab === 'mcp'} onClick={() => setTab('mcp')}>
              <Icon name="plug" />工具连接（MCP）<span className="cap-count">{servers.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === 'skills'} onClick={() => setTab('skills')}>
              <Icon name="layers" />技能包（Skills）<span className="cap-count">{skills.length}</span>
            </button>
          </div>

          {remote ? (
            <p className="monitor-remote-note" role="status">
              请到运行 AI Console 的电脑上操作（管理与导入 MCP 工具连接和技能包仅限本机）。
            </p>
          ) : null}

          {tab === 'skills' ? (
            <SkillsPanel
              skills={skills}
              loading={skillsLoading}
              error={skillsError}
              onReload={loadSkills}
              openCreateToken={skillCreateToken}
            />
          ) : (
            <>
              {error ? <ErrorNotice error={error} onRetry={() => void load(true)} /> : null}
              {/* 智能粘贴与添加/编辑表单 */}
              {editing ? (
                <section className="set-sec cap-section" aria-label={editing.id ? '编辑 MCP 服务' : '添加 MCP 服务'}>
                  <div className="cap-sec-head">
                    <h3>{editing.id ? `编辑 MCP：${editing.name}` : '添加 MCP 工具连接'}</h3>
                    <button type="button" className="btn xs" disabled={saving} onClick={() => { setEditing(null); setParseResult(null); setFormError(null); }}>
                      收起
                    </button>
                  </div>

                  {!editing.id ? (
                    <div className="cap-smart-box">
                      <label htmlFor="mcp-smart-paste">智能粘贴识别（支持 JSON、`claude mcp add ...`、`npx/uvx ...` 命令或 HTTP 地址）</label>
                      <textarea
                        id="mcp-smart-paste"
                        rows={3}
                        placeholder={'例如：claude mcp add my-tools -e API_KEY=xxx -- npx -y @demo/mcp-server\n或粘贴 {"mcpServers": {...}} / https://mcp.example.com/mcp'}
                        value={pasteText}
                        disabled={remote || parsing}
                        onChange={(e) => setPasteText(e.target.value)}
                      />
                      <div className="cap-smart-acts">
                        <button type="button" className="btn" disabled={remote || parsing || !pasteText.trim()} onClick={() => void runSmartParse()}>
                          <Icon name="wand" />{parsing ? '正在识别…' : '智能识别并填表'}
                        </button>
                        {parseResult ? (
                          <span className="cap-parse-badge">已识别：{formatLabel(parseResult.format)}（{parseResult.candidates.length} 项）</span>
                        ) : null}
                      </div>
                      {parseResult && parseResult.candidates.length > 1 ? (
                        <div className="cap-candidates">
                          <span>检测到多个服务，点击切换要导入的项：</span>
                          {parseResult.candidates.map((cand) => (
                            <button key={cand.name} type="button" className="btn xs" onClick={() => setEditing(formFromCandidate(cand))}>
                              {cand.name}
                            </button>
                          ))}
                        </div>
                      ) : null}
                      {parseResult?.warnings.map((w, idx) => (
                        <p key={idx} className="cap-warn-line">{w}</p>
                      ))}
                    </div>
                  ) : null}

                  <form className="cap-form" onSubmit={(e) => void submitForm(e)}>
                    <div className="cap-form-grid">
                      <label>
                        <span>名称</span>
                        <input
                          type="text"
                          placeholder="例如 blender 或 sentry"
                          value={editing.name}
                          disabled={remote || saving}
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        />
                      </label>

                      <label>
                        <span>连接方式</span>
                        <select
                          value={editing.transport}
                          disabled={remote || saving}
                          onChange={(e) => setEditing({ ...editing, transport: e.target.value as McpTransport })}
                        >
                          <option value="stdio">本机命令（stdio，无黑框隔离运行）</option>
                          <option value="http">远程接口（HTTP JSON-RPC）</option>
                        </select>
                      </label>

                      <label className="cap-form-wide">
                        <span>用途说明（可选）</span>
                        <input
                          type="text"
                          placeholder="一句话写清楚这个工具用来做什么，方便日后查阅"
                          value={editing.description}
                          disabled={remote || saving}
                          onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                        />
                      </label>

                      {editing.transport === 'stdio' ? (
                        <>
                          <label>
                            <span>启动命令</span>
                            <input
                              type="text"
                              placeholder="例如 node、npx、uvx 或绝对路径"
                              value={editing.command}
                              disabled={remote || saving}
                              onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                            />
                          </label>
                          <label>
                            <span>并发控制</span>
                            <select
                              value={editing.concurrency}
                              disabled={remote || saving}
                              onChange={(e) => setEditing({ ...editing, concurrency: e.target.value as McpConcurrency })}
                            >
                              <option value="shared">共享（多个任务可同时调用）</option>
                              <option value="exclusive">独占锁（同时只允许一个任务调用，适合 Blender/Houdini 等桌面软件）</option>
                            </select>
                          </label>
                          <label className="cap-form-wide">
                            <span>启动参数（每行一个参数，不经过系统 Shell）</span>
                            <textarea
                              rows={3}
                              placeholder={'例如：\n-y\n@modelcontextprotocol/server-everything'}
                              value={editing.argsText}
                              disabled={remote || saving}
                              onChange={(e) => setEditing({ ...editing, argsText: e.target.value })}
                            />
                          </label>
                        </>
                      ) : (
                        <>
                          <label>
                            <span>服务地址（http:// 或 https://）</span>
                            <input
                              type="text"
                              placeholder="https://mcp.example.com/mcp"
                              value={editing.url}
                              disabled={remote || saving}
                              onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                            />
                          </label>
                          <label>
                            <span>并发控制</span>
                            <select
                              value={editing.concurrency}
                              disabled={remote || saving}
                              onChange={(e) => setEditing({ ...editing, concurrency: e.target.value as McpConcurrency })}
                            >
                              <option value="shared">共享（多个任务可同时调用）</option>
                              <option value="exclusive">独占锁（同一时间只允许一个任务调用）</option>
                            </select>
                          </label>
                        </>
                      )}
                    </div>

                    {/* 分配给哪些 Agent */}
                    <div className="cap-field-block">
                      <span className="cap-field-title">分配给哪些 Agent（都不选表示全部可用）</span>
                      <div className="cap-agent-checks">
                        {ALL_AGENT_KINDS.map((kind) => (
                          <label key={kind} className="cap-check-chip">
                            <input
                              type="checkbox"
                              checked={editing.agents.includes(kind)}
                              disabled={remote || saving}
                              onChange={() => toggleAgentChoice(kind)}
                            />
                            <span>{agentDisplayName(kind)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* 密钥环境变量 / 请求头 */}
                    <div className="cap-field-block">
                      <div className="cap-field-head">
                        <span className="cap-field-title">
                          {editing.transport === 'stdio' ? '密钥环境变量（DPAPI 加密保存，不落明文）' : '密钥请求头（DPAPI 加密保存，不落明文）'}
                        </span>
                        <button
                          type="button"
                          className="btn xs"
                          disabled={remote || saving}
                          onClick={() => {
                            if (editing.transport === 'stdio') {
                              setEditing({ ...editing, envRows: [...editing.envRows, { key: '', value: '' }] });
                            } else {
                              setEditing({ ...editing, headerRows: [...editing.headerRows, { key: '', value: '' }] });
                            }
                          }}
                        >
                          <Icon name="plus" />新增一项
                        </button>
                      </div>

                      {(editing.transport === 'stdio' ? editing.existingEnvKeys : editing.existingHeaderKeys).map((item) => {
                        const removeList = editing.transport === 'stdio' ? editing.removeEnvKeys : editing.removeHeaderKeys;
                        const marked = removeList.includes(item.key);
                        return (
                          <div key={item.key} className="cap-saved-secret">
                            <code>{item.key}</code>
                            <span className="cap-secret-hint">
                              {marked ? '保存后将删除此密钥' : `已加密保存${item.hint ? `（结尾 …${item.hint}）` : ''}`}
                            </span>
                            <button
                              type="button"
                              className="btn xs"
                              disabled={remote || saving}
                              onClick={() => {
                                const next = marked ? removeList.filter((k) => k !== item.key) : [...removeList, item.key];
                                if (editing.transport === 'stdio') setEditing({ ...editing, removeEnvKeys: next });
                                else setEditing({ ...editing, removeHeaderKeys: next });
                              }}
                            >
                              {marked ? '撤销删除' : '删除'}
                            </button>
                          </div>
                        );
                      })}

                      {(editing.transport === 'stdio' ? editing.envRows : editing.headerRows).map((row, idx) => (
                        <div key={idx} className="cap-kv-row">
                          <input
                            type="text"
                            placeholder={editing.transport === 'stdio' ? '变量名（如 API_KEY）' : '请求头名（如 Authorization）'}
                            value={row.key}
                            disabled={remote || saving}
                            onChange={(e) => {
                              const list = [...(editing.transport === 'stdio' ? editing.envRows : editing.headerRows)];
                              list[idx] = { ...row, key: e.target.value };
                              if (editing.transport === 'stdio') setEditing({ ...editing, envRows: list });
                              else setEditing({ ...editing, headerRows: list });
                            }}
                          />
                          <input
                            type="password"
                            autoComplete="new-password"
                            placeholder="填写密钥值（只写不回显）"
                            value={row.value}
                            disabled={remote || saving}
                            onChange={(e) => {
                              const list = [...(editing.transport === 'stdio' ? editing.envRows : editing.headerRows)];
                              list[idx] = { ...row, value: e.target.value };
                              if (editing.transport === 'stdio') setEditing({ ...editing, envRows: list });
                              else setEditing({ ...editing, headerRows: list });
                            }}
                          />
                          <button
                            type="button"
                            className="btn xs"
                            disabled={remote || saving}
                            onClick={() => {
                              const list = (editing.transport === 'stdio' ? editing.envRows : editing.headerRows).filter((_, i) => i !== idx);
                              if (editing.transport === 'stdio') setEditing({ ...editing, envRows: list });
                              else setEditing({ ...editing, headerRows: list });
                            }}
                          >
                            移除
                          </button>
                        </div>
                      ))}
                    </div>

                    {formError ? <p className="monitor-form-err" role="alert">{formError}</p> : null}
                    <div className="cap-form-acts">
                      <button type="submit" className="btn primary" disabled={remote || saving}>
                        {saving ? '保存中…' : (editing.id ? '保存修改' : '保存 MCP 服务')}
                      </button>
                      <button type="button" className="btn" disabled={saving} onClick={() => { setEditing(null); setFormError(null); }}>
                        取消
                      </button>
                    </div>
                  </form>
                </section>
              ) : null}

              {/* MCP 列表 */}
              {loading && servers.length === 0 ? (
                <div className="empty"><p>正在读取 MCP 工具清单…</p></div>
              ) : servers.length === 0 && !editing ? (
                <section className="set-sec cap-section">
                  <div className="cap-empty">
                    <h3>还没有配置 MCP 工具连接</h3>
                    <p>粘贴一行 <code>npx ...</code> / <code>claude mcp add ...</code> 命令、JSON 片段或 HTTP 地址，就能把外部工具统一接入工作台。</p>
                    <button type="button" className="btn primary" disabled={remote} onClick={openCreate}>
                      <Icon name="plus" />添加第一个 MCP
                    </button>
                  </div>
                </section>
              ) : (
                <div className="cap-list">
                  {servers.map((srv) => {
                    const st = statusMeta(srv);
                    const testRes = testResults[srv.id];
                    const showTools = expandedToolsId === srv.id;
                    const secretCount = srv.envSecrets.length + srv.headerSecrets.length;
                    return (
                      <article key={srv.id} className={'set-sec cap-card' + (!srv.enabled ? ' is-off' : '')}>
                        <div className="cap-card-top">
                          <div className="cap-card-title">
                            <strong>{srv.name}</strong>
                            <span className="monitor-pill neutral">{srv.transport.toUpperCase()}</span>
                            <span className={'monitor-status ' + st.cls}>
                              <span aria-hidden="true">{st.mark}</span> {st.label}
                            </span>
                            {srv.concurrency === 'exclusive' ? (
                              <span className="monitor-pill hot" title="同一时间只允许一个任务调用，避免桌面软件冲突">独占锁</span>
                            ) : null}
                            <span className="monitor-pill neutral">{srv.toolCount} 个工具</span>
                            {srv.toolsFolded ? (
                              <span className="monitor-pill hot" title="工具数超过 40 个，已自动折叠为搜索/查看/调用 3 步避免占满上下文">
                                已自动折叠
                              </span>
                            ) : null}
                          </div>
                          <div className="cap-card-acts">
                            <button
                              type="button"
                              className="switch"
                              role="switch"
                              aria-checked={srv.enabled}
                              aria-label={srv.enabled ? `停用 ${srv.name}` : `启用 ${srv.name}`}
                              disabled={remote || saving}
                              onClick={() => void toggleEnabled(srv)}
                            />
                            <button
                              type="button"
                              className="btn xs"
                              disabled={remote || testingId !== null}
                              onClick={() => void runTest(srv)}
                            >
                              {testingId === srv.id ? '测试中…' : '测试连接'}
                            </button>
                            <button type="button" className="btn xs" disabled={remote || saving} onClick={() => openEdit(srv)}>编辑</button>
                            <button type="button" className="btn xs danger" disabled={remote || saving} onClick={() => void removeServer(srv)}>删除</button>
                          </div>
                        </div>

                        {srv.description ? <p className="cap-card-desc">{srv.description}</p> : null}

                        <div className="cap-meta-grid">
                          <div>
                            <span className="cap-meta-k">{srv.transport === 'stdio' ? '启动命令' : '服务地址'}</span>
                            <code className="cap-meta-code">
                              {srv.transport === 'stdio' ? [srv.command, ...srv.args].filter(Boolean).join(' ') : srv.url}
                            </code>
                          </div>
                          <div>
                            <span className="cap-meta-k">适用 Agent</span>
                            <span>{srv.agents.length ? srv.agents.map(agentDisplayName).join('、') : '全部 Agent'}</span>
                          </div>
                          <div>
                            <span className="cap-meta-k">加密凭据</span>
                            <span>{secretCount ? `已通过 DPAPI 加密保存 ${secretCount} 项` : '无'}</span>
                          </div>
                          <div>
                            <span className="cap-meta-k">最近调用</span>
                            <span>
                              {srv.lastCalledAt && srv.lastCalledTool
                                ? `${srv.lastCalledTool} · ${clock(srv.lastCalledAt)}`
                                : '尚无调用'}
                            </span>
                          </div>
                        </div>

                        {srv.lastError ? (
                          <p className="cap-err-box" role="alert">最近错误：{srv.lastError}</p>
                        ) : null}

                        {testRes ? (
                          <div className={'cap-test-log' + (testRes.ok ? ' ok' : ' err')}>
                            <div className="cap-test-head">
                              <strong>{testRes.ok ? `测试通过（耗时 ${testRes.durationMs} ms）` : '测试未通过'}</strong>
                            </div>
                            <ul>
                              {testRes.steps.map((step, i) => (
                                <li key={i}>
                                  <span aria-hidden="true">{step.ok ? '✓' : '✕'}</span> {step.step}：{step.detail}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {srv.tools.length > 0 ? (
                          <div className="cap-tools-wrap">
                            <button
                              type="button"
                              className="btn xs ghost"
                              aria-expanded={showTools}
                              onClick={() => setExpandedToolsId(showTools ? null : srv.id)}
                            >
                              <Icon name={showTools ? 'down' : 'right'} />
                              {showTools ? '收起工具清单' : `查看工具清单（${srv.tools.length} 个）`}
                            </button>
                            {showTools ? (
                              <ul className="cap-tool-list">
                                {srv.tools.map((tool) => (
                                  <li key={tool.name}>
                                    <code>{tool.name}</code>
                                    <span>{tool.description || '无说明'}</span>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </main>
  );
}
