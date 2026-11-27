// 能力中心（下）：技能库（Skills）管理、全包静态安全扫描与本机只读导入向导（第 2.4 步）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentKind, ApiError, CreateSkillBody, PatchSkillBody, SkillDetail, SkillExtraFileInput, SkillLocalCandidate,
  SkillLocalScanResult, SkillLocalSourceKind, SkillScanReport, SkillSummary,
} from '@aic/protocol';
import { toApiError } from '../api/http';
import { Icon } from '../components/Icon';
import { confirmDialog, ErrorNotice } from '../components/ui';
import { agentFallback } from '../lib/format';
import { api, useApp, useRemoteAccess } from '../state/app';
import { toast, toastError } from '../state/ui';

const ALL_AGENT_KINDS: AgentKind[] = ['independent', 'claude', 'codex', 'codebuddy', 'zcode', 'workbuddy', 'antigravity', 'fake'];

const LOCAL_SOURCE_OPTIONS: ReadonlyArray<{ kind: SkillLocalSourceKind; label: string; hint: string }> = [
  { kind: 'agents_public', label: '跨工具公共技能目录（~/.agents/skills）', hint: '默认推荐，纯公开技能目录' },
  { kind: 'claude_skills', label: 'Claude Code 技能目录（仅 skills/ 子目录）', hint: '绝不读取登录凭据或主配置' },
  { kind: 'codex_skills', label: 'Codex 技能目录（仅 skills/ 子目录）', hint: '绝不读取 auth.json 或令牌' },
  { kind: 'codebuddy_skills', label: 'CodeBuddy 技能目录（仅 skills/ 子目录）', hint: '仅只读扫描公开技能文件夹' },
  { kind: 'zcode_skills', label: 'ZCode 技能目录（仅 skills/ 子目录）', hint: '仅只读扫描公开技能文件夹' },
  { kind: 'antigravity_skills', label: 'Antigravity 技能目录（仅 skills/ 子目录）', hint: '仅只读扫描公开技能文件夹' },
];

interface SkillFormState {
  id?: string;
  name: string;
  description: string;
  version: string;
  markdown: string;
  extraFiles: SkillExtraFileInput[];
  sourceKind: 'manual' | 'upload';
  agents: AgentKind[];
  enabled: boolean;
  approveRisks: boolean;
}

function emptySkillForm(): SkillFormState {
  return {
    name: '',
    description: '',
    version: '',
    markdown: `---\nname: design-checklist\ndescription: 策划案评审检查清单，在审阅系统策划文档或数值方案时使用。\nversion: "1.0"\n---\n\n# 策划案评审检查清单\n\n1. 核心循环是否闭环，目标、反馈与奖励是否清晰。\n2. 边界异常与数值膨胀点是否列出应对策略。\n3. 验收标准是否可量化、可测试。\n`,
    extraFiles: [],
    sourceKind: 'manual',
    agents: [],
    enabled: true,
    approveRisks: false,
  };
}

function formFromSkill(detail: SkillDetail): SkillFormState {
  return {
    id: detail.id,
    name: detail.name,
    description: detail.description,
    version: detail.version,
    markdown: detail.markdown,
    extraFiles: [],
    sourceKind: detail.sourceKind === 'upload' ? 'upload' : 'manual',
    agents: [...detail.agents],
    enabled: detail.enabled,
    approveRisks: detail.risksApproved,
  };
}

function riskMeta(level: SkillScanReport['riskLevel']): { label: string; cls: string; mark: string } {
  if (level === 'danger') return { label: '高危告警', cls: 'err', mark: '■' };
  if (level === 'warn') return { label: '需留意', cls: 'wait', mark: '◆' };
  return { label: '安全通过', cls: 'ok', mark: '●' };
}

function conflictLabel(c: SkillLocalCandidate['conflict']): { label: string; cls: string } {
  if (c === 'new') return { label: '新发现', cls: 'ok' };
  if (c === 'identical') return { label: '与工作台一致', cls: 'neutral' };
  return { label: '内容有差异', cls: 'hot' };
}

function ScanFindingsBox({ scan, title }: { scan: SkillScanReport; title?: string }) {
  const rm = riskMeta(scan.riskLevel);
  return (
    <div className={'skill-scan-box is-' + scan.riskLevel}>
      <div className="skill-scan-head">
        <span className={'monitor-status ' + rm.cls}><span aria-hidden="true">{rm.mark}</span> {title ? `${title}：` : ''}{rm.label}</span>
        <span className="skill-scan-meta">
          已扫描 {scan.scannedFiles} 个文件
          {scan.hasScripts ? ` · 含 ${scan.scriptFiles.length} 个脚本（${scan.scriptFiles.join('、')}）` : ' · 无可执行脚本'}
          {scan.findings.length ? ` · 命中 ${scan.findings.length} 项提示` : ' · 未发现可疑指令'}
        </span>
      </div>
      {scan.findings.length > 0 ? (
        <ul className="skill-finding-list">
          {scan.findings.map((f, idx) => (
            <li key={idx} className={'skill-finding is-' + f.severity}>
              <div className="skill-finding-top">
                <span className={'monitor-pill ' + (f.severity === 'danger' ? 'hot' : 'neutral')}>
                  {f.severity === 'danger' ? '高危' : '警告'}
                </span>
                <strong>{f.title}</strong>
                <code>{f.file}:{f.line}</code>
              </div>
              <p className="skill-finding-detail">{f.detail}</p>
              {f.excerpt ? <code className="skill-finding-excerpt">{f.excerpt}</code> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SkillsPanel({
  skills,
  loading,
  error,
  onReload,
  openCreateToken,
}: {
  skills: SkillSummary[];
  loading: boolean;
  error: ApiError | null;
  onReload: (soft?: boolean) => Promise<void>;
  openCreateToken?: number;
}) {
  const remote = useRemoteAccess();
  const knownAgents = useApp((s) => s.agents);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  const [editing, setEditing] = useState<SkillFormState | null>(null);
  const [previewScan, setPreviewScan] = useState<SkillScanReport | null>(null);
  const [scanningContent, setScanningContent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailsCache, setDetailsCache] = useState<Record<string, SkillDetail>>({});
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  // 本机只读扫描导入向导状态
  const [wizardOpen, setWizardOpen] = useState(false);
  const [selectedSources, setSelectedSources] = useState<SkillLocalSourceKind[]>(['agents_public']);
  const [customDir, setCustomDir] = useState('');
  const [scanningLocal, setScanningLocal] = useState(false);
  const [localResult, setLocalResult] = useState<SkillLocalScanResult | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);
  const [pickedIds, setPickedIds] = useState<Record<string, boolean>>({});
  const [overwriteIds, setOverwriteIds] = useState<Record<string, boolean>>({});
  const [approveIds, setApproveIds] = useState<Record<string, boolean>>({});
  const [importingLocal, setImportingLocal] = useState(false);

  const lastTokenRef = useRef(openCreateToken ?? 0);
  useEffect(() => {
    if (openCreateToken && openCreateToken !== lastTokenRef.current) {
      lastTokenRef.current = openCreateToken;
      if (!remote) {
        setWizardOpen(false);
        setPreviewScan(null);
        setFormError(null);
        setEditing(emptySkillForm());
      }
    }
  }, [openCreateToken, remote]);

  const agentDisplayName = (kind: AgentKind) =>
    knownAgents.find((a) => a.kind === kind)?.displayName ?? agentFallback[kind]?.name ?? kind;

  const openCreate = () => {
    if (remote) return;
    setWizardOpen(false);
    setPreviewScan(null);
    setFormError(null);
    setEditing(emptySkillForm());
  };

  const openEdit = async (srv: SkillSummary) => {
    if (remote || saving) return;
    setWizardOpen(false);
    setFormError(null);
    setPreviewScan(srv.scan);
    try {
      const detail = detailsCache[srv.id] ?? await api.skill(srv.id);
      if (!mountedRef.current) return;
      setDetailsCache((prev) => ({ ...prev, [srv.id]: detail }));
      setEditing(formFromSkill(detail));
    } catch (e) {
      if (mountedRef.current) toastError(toApiError(e));
    }
  };

  const togglePreview = async (srv: SkillSummary) => {
    if (expandedId === srv.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(srv.id);
    if (detailsCache[srv.id]) return;
    setLoadingDetailId(srv.id);
    try {
      const detail = await api.skill(srv.id);
      if (!mountedRef.current) return;
      setDetailsCache((prev) => ({ ...prev, [srv.id]: detail }));
    } catch (e) {
      if (mountedRef.current) toastError(toApiError(e));
    } finally {
      if (mountedRef.current) setLoadingDetailId(null);
    }
  };

  const runContentScan = useCallback(async (markdown: string, extraFiles: SkillExtraFileInput[]) => {
    if (remote || !markdown.trim()) return;
    setScanningContent(true);
    setFormError(null);
    try {
      const report = await api.scanSkillContent({ markdown, extraFiles });
      if (!mountedRef.current) return;
      setPreviewScan(report);
    } catch (e) {
      if (mountedRef.current) setFormError(toApiError(e).message);
    } finally {
      if (mountedRef.current) setScanningContent(false);
    }
  }, [remote]);

  /** 支持用户选择单个 .md 文件或整个技能文件夹导入正文与附属文件。 */
  const handleFileUpload = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0 || !editing) return;
    const files = Array.from(fileList).slice(0, 32);
    let mainMd = '';
    let inferredName = editing.name;
    const extras: SkillExtraFileInput[] = [];

    for (const file of files) {
      if (file.size > 256 * 1024) continue;
      const relRaw = ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replace(/\\/g, '/');
      const segs = relRaw.split('/').filter(Boolean);
      const rel = segs.length > 1 ? segs.slice(1).join('/') : segs[0]!;
      if (segs.length > 1 && !inferredName) inferredName = segs[0]!;
      const text = await file.text();
      if (rel.toLowerCase() === 'skill.md' || (files.length === 1 && /\.md$/i.test(rel))) {
        mainMd = text;
        if (!inferredName) inferredName = file.name.replace(/\.md$/i, '');
      } else if (rel && !rel.startsWith('.')) {
        extras.push({ path: rel, content: text });
      }
    }

    if (!mainMd) {
      setFormError('所选文件中未找到 SKILL.md 或 Markdown 文件');
      return;
    }

    const nextForm: SkillFormState = {
      ...editing,
      name: inferredName,
      markdown: mainMd,
      extraFiles: extras,
      sourceKind: 'upload',
      approveRisks: false,
    };
    setEditing(nextForm);
    toast(`已载入技能文件（共 ${1 + extras.length} 个），正在自动安全扫描…`);
    await runContentScan(mainMd, extras);
  };

  const submitForm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || remote || saving) return;
    if (!editing.markdown.trim()) {
      setFormError('请填写技能说明正文（SKILL.md）');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editing.id) {
        const patch: PatchSkillBody = {
          ...(editing.name.trim() ? { name: editing.name.trim() } : {}),
          description: editing.description.trim(),
          version: editing.version.trim(),
          markdown: editing.markdown,
          agents: editing.agents,
          enabled: editing.enabled,
          approveRisks: editing.approveRisks,
        };
        const updated = await api.patchSkill(editing.id, patch);
        if (!mountedRef.current) return;
        setDetailsCache((prev) => ({ ...prev, [updated.id]: updated }));
        toast(updated.requiresApproval && !updated.risksApproved ? '技能已保存，因检测到风险项暂未启用' : '技能已更新');
      } else {
        const body: CreateSkillBody = {
          ...(editing.name.trim() ? { name: editing.name.trim() } : {}),
          ...(editing.description.trim() ? { description: editing.description.trim() } : {}),
          ...(editing.version.trim() ? { version: editing.version.trim() } : {}),
          markdown: editing.markdown,
          extraFiles: editing.extraFiles,
          sourceKind: editing.sourceKind,
          agents: editing.agents,
          enabled: editing.enabled,
          approveRisks: editing.approveRisks,
        };
        const created = await api.createSkill(body);
        if (!mountedRef.current) return;
        setDetailsCache((prev) => ({ ...prev, [created.id]: created }));
        toast(
          created.requiresApproval && !created.risksApproved
            ? `已保存「${created.name}」（检测到风险/脚本，已自动拦截为待确认状态）`
            : `已添加技能「${created.name}」`,
        );
      }
      setEditing(null);
      setPreviewScan(null);
      await onReload(true);
    } catch (err) {
      if (!mountedRef.current) return;
      const apiErr = toApiError(err);
      setFormError(apiErr.message);
      toastError(apiErr);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const toggleEnabled = async (srv: SkillSummary) => {
    if (remote || saving) return;
    if (!srv.enabled && srv.requiresApproval && !srv.risksApproved) {
      setExpandedId(srv.id);
      toast('请先在下方展开核对安全告警与脚本清单，再点击“确认风险并启用”', 'err');
      return;
    }
    setSaving(true);
    try {
      await api.patchSkill(srv.id, { enabled: !srv.enabled });
      if (!mountedRef.current) return;
      toast(srv.enabled ? `已停用技能「${srv.name}」` : `已启用技能「${srv.name}」`);
      await onReload(true);
    } catch (err) {
      if (mountedRef.current) toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const approveAndEnable = async (srv: SkillSummary) => {
    if (remote || saving) return;
    setSaving(true);
    try {
      const updated = await api.patchSkill(srv.id, { approveRisks: true, enabled: true });
      if (!mountedRef.current) return;
      setDetailsCache((prev) => ({ ...prev, [updated.id]: updated }));
      toast(`已确认风险并启用「${srv.name}」`);
      await onReload(true);
    } catch (err) {
      if (mountedRef.current) toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const removeSkill = async (srv: SkillSummary) => {
    if (remote || saving) return;
    const ok = await confirmDialog({
      title: `删除技能「${srv.name}」？`,
      body: '只会删除工作台技能库里的受控副本，绝不改动本机其他编码工具里的原文件。',
      ok: '确认删除',
      danger: true,
    });
    if (!ok || !mountedRef.current) return;
    setSaving(true);
    try {
      await api.deleteSkill(srv.id);
      if (!mountedRef.current) return;
      if (editing?.id === srv.id) setEditing(null);
      if (expandedId === srv.id) setExpandedId(null);
      toast(`已删除技能「${srv.name}」`);
      await onReload(true);
    } catch (err) {
      if (mountedRef.current) toastError(toApiError(err));
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  const runLocalScan = async () => {
    if (remote || scanningLocal) return;
    if (selectedSources.length === 0 && !customDir.trim()) {
      setWizardError('请至少勾选一个技能来源目录，或填写自定义技能文件夹路径');
      return;
    }
    setScanningLocal(true);
    setWizardError(null);
    try {
      const res = await api.scanLocalSkills({
        sources: selectedSources,
        ...(customDir.trim() ? { customDir: customDir.trim() } : {}),
      });
      if (!mountedRef.current) return;
      setLocalResult(res);
      const nextPicked: Record<string, boolean> = {};
      const nextOverwrite: Record<string, boolean> = {};
      const nextApprove: Record<string, boolean> = {};
      for (const c of res.candidates) {
        nextPicked[c.candidateId] = c.conflict === 'new';
        nextOverwrite[c.candidateId] = false;
        nextApprove[c.candidateId] = false;
      }
      setPickedIds(nextPicked);
      setOverwriteIds(nextOverwrite);
      setApproveIds(nextApprove);
      toast(res.candidates.length ? `扫描完成，发现 ${res.candidates.length} 个技能包` : '扫描完成，所选目录暂未发现 SKILL.md 技能包');
    } catch (err) {
      if (mountedRef.current) setWizardError(toApiError(err).message);
    } finally {
      if (mountedRef.current) setScanningLocal(false);
    }
  };

  const runLocalImport = async () => {
    if (!localResult || remote || importingLocal) return;
    const chosen = localResult.candidates.filter((c) => pickedIds[c.candidateId]);
    if (!chosen.length) {
      setWizardError('请先勾选至少一个要导入的技能');
      return;
    }
    setImportingLocal(true);
    setWizardError(null);
    try {
      const res = await api.importLocalSkills({
        scanId: localResult.scanId,
        items: chosen.map((c) => ({
          candidateId: c.candidateId,
          overwrite: Boolean(overwriteIds[c.candidateId]),
          approveRisks: Boolean(approveIds[c.candidateId]),
        })),
      });
      if (!mountedRef.current) return;
      const msg = `成功导入 ${res.imported.length} 个技能${res.skipped.length ? `，跳过 ${res.skipped.length} 个` : ''}`;
      toast(msg);
      setWizardOpen(false);
      setLocalResult(null);
      await onReload(true);
    } catch (err) {
      if (mountedRef.current) setWizardError(toApiError(err).message);
    } finally {
      if (mountedRef.current) setImportingLocal(false);
    }
  };

  return (
    <>
      <div className="skill-toolbar">
        <span className="skill-toolbar-note">
          统一存放于工作台受控库，采用三层按需读取（不塞爆上下文、不改第三方工具目录）。
        </span>
        <div className="skill-toolbar-acts">
          <button
            type="button"
            className="btn"
            disabled={remote || saving}
            onClick={() => {
              setEditing(null);
              setWizardError(null);
              setWizardOpen((v) => !v);
            }}
          >
            <Icon name="wand" />{wizardOpen ? '收起导入向导' : '本机只读导入'}
          </button>
          <button type="button" className="btn primary" disabled={remote || saving} onClick={openCreate}>
            <Icon name="plus" />新建技能
          </button>
        </div>
      </div>

      {error ? <ErrorNotice error={error} onRetry={() => void onReload(true)} /> : null}

      {/* 本机只读扫描导入向导 */}
      {wizardOpen ? (
        <section className="set-sec cap-section" aria-label="本机只读扫描导入向导">
          <div className="cap-sec-head">
            <h3>从本机公开技能目录只读导入</h3>
            <button type="button" className="btn xs" onClick={() => setWizardOpen(false)}>收起</button>
          </div>
          <p className="skill-safe-banner">
            安全承诺：扫描器内置凭据防火墙，<strong>严格只读</strong>且仅进入所选纯 <code>skills/</code> 子目录，绝不读取任何登录凭据或修改第三方原文件；导入前自动执行全包静态安全扫描。
          </p>

          <div className="skill-source-grid">
            {LOCAL_SOURCE_OPTIONS.map((opt) => {
              const checked = selectedSources.includes(opt.kind);
              return (
                <label key={opt.kind} className="skill-source-chip">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={remote || scanningLocal}
                    onChange={() => {
                      setSelectedSources((prev) =>
                        checked ? prev.filter((k) => k !== opt.kind) : [...prev, opt.kind],
                      );
                    }}
                  />
                  <div>
                    <strong>{opt.label}</strong>
                    <span>{opt.hint}</span>
                  </div>
                </label>
              );
            })}
          </div>

          <label className="skill-custom-dir">
            <span>自定义本机技能文件夹（可选，拒绝凭据或敏感系统目录）</span>
            <input
              type="text"
              placeholder="例如 D:\MyGame\shared-skills"
              value={customDir}
              disabled={remote || scanningLocal}
              onChange={(e) => setCustomDir(e.target.value)}
            />
          </label>

          {wizardError ? <p className="monitor-form-err" role="alert">{wizardError}</p> : null}

          <div className="cap-form-acts">
            <button type="button" className="btn primary" disabled={remote || scanningLocal} onClick={() => void runLocalScan()}>
              {scanningLocal ? '正在安全扫描…' : '开始只读安全扫描'}
            </button>
          </div>

          {localResult ? (
            <div className="skill-scan-results">
              <div className="skill-source-pills">
                {localResult.checkedSources.map((s, idx) => (
                  <span key={idx} className={'monitor-pill ' + (s.foundCount > 0 ? 'ok' : 'neutral')}>
                    {s.label}：{s.available ? `发现 ${s.foundCount} 个` : (s.skippedReason || '未找到')}
                  </span>
                ))}
              </div>

              {localResult.candidates.length === 0 ? (
                <p className="cap-card-desc">所选目录中未发现包含 <code>SKILL.md</code> 的技能包。</p>
              ) : (
                <>
                  <div className="cap-list">
                    {localResult.candidates.map((cand) => {
                      const cf = conflictLabel(cand.conflict);
                      const rm = riskMeta(cand.scan.riskLevel);
                      const needsConfirm = cand.scan.riskLevel === 'danger' || cand.hasScripts;
                      return (
                        <div key={cand.candidateId} className="skill-cand-card">
                          <div className="cap-card-top">
                            <label className="cap-check-chip">
                              <input
                                type="checkbox"
                                checked={Boolean(pickedIds[cand.candidateId])}
                                disabled={importingLocal}
                                onChange={(e) => setPickedIds((prev) => ({ ...prev, [cand.candidateId]: e.target.checked }))}
                              />
                              <strong>{cand.name}</strong>
                            </label>
                            <div className="cap-card-title">
                              <span className="monitor-pill neutral">{cand.sourceLabel}</span>
                              <span className={'monitor-pill ' + cf.cls}>{cf.label}</span>
                              <span className={'monitor-status ' + rm.cls}>{rm.mark} {rm.label}</span>
                              <span className="monitor-pill neutral">{cand.filesCount} 个文件</span>
                            </div>
                          </div>
                          {cand.description ? <p className="cap-card-desc">{cand.description}</p> : null}
                          {cand.scan.findings.length > 0 ? <ScanFindingsBox scan={cand.scan} title="安全扫描" /> : null}
                          <div className="skill-cand-opts">
                            {cand.conflict === 'modified' ? (
                              <label className="cap-check-chip">
                                <input
                                  type="checkbox"
                                  checked={Boolean(overwriteIds[cand.candidateId])}
                                  onChange={(e) => setOverwriteIds((prev) => ({ ...prev, [cand.candidateId]: e.target.checked }))}
                                />
                                <span>覆盖工作台里的同名旧版</span>
                              </label>
                            ) : null}
                            {needsConfirm ? (
                              <label className="cap-check-chip">
                                <input
                                  type="checkbox"
                                  checked={Boolean(approveIds[cand.candidateId])}
                                  onChange={(e) => setApproveIds((prev) => ({ ...prev, [cand.candidateId]: e.target.checked }))}
                                />
                                <span>我已核对告警/脚本并允许导入后启用（不勾选则导入后默认停用）</span>
                              </label>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="cap-form-acts">
                    <button type="button" className="btn primary" disabled={remote || importingLocal} onClick={() => void runLocalImport()}>
                      {importingLocal ? '正在复制导入…' : '复制导入已勾选技能'}
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* 新建 / 编辑技能表单 */}
      {editing ? (
        <section className="set-sec cap-section" aria-label={editing.id ? '编辑技能' : '新建技能'}>
          <div className="cap-sec-head">
            <h3>{editing.id ? `编辑技能：${editing.name}` : '新建或上传技能包（SKILL.md）'}</h3>
            <button type="button" className="btn xs" disabled={saving} onClick={() => { setEditing(null); setPreviewScan(null); setFormError(null); }}>
              收起
            </button>
          </div>

          {!editing.id ? (
            <div className="skill-upload-bar">
              <span>也可以直接从本地选择 Markdown 文件或包含 <code>SKILL.md</code> 的技能文件夹：</span>
              <div className="skill-upload-btns">
                <label className="btn xs">
                  选择 .md 文件
                  <input type="file" accept=".md,.txt" hidden disabled={remote || saving} onChange={(e) => void handleFileUpload(e.target.files)} />
                </label>
                <label className="btn xs">
                  选择技能文件夹
                  <input
                    type="file"
                    hidden
                    disabled={remote || saving}
                    {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                    onChange={(e) => void handleFileUpload(e.target.files)}
                  />
                </label>
              </div>
              {editing.extraFiles.length > 0 ? (
                <span className="cap-parse-badge">已附带 {editing.extraFiles.length} 个附属文件</span>
              ) : null}
            </div>
          ) : null}

          <form className="cap-form" onSubmit={(e) => void submitForm(e)}>
            <div className="cap-form-grid">
              <label>
                <span>技能名称（留空则自动读取 SKILL.md 标题）</span>
                <input
                  type="text"
                  placeholder="例如 策划案检查清单"
                  value={editing.name}
                  disabled={remote || saving}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </label>
              <label>
                <span>版本号（可选）</span>
                <input
                  type="text"
                  placeholder="例如 1.0"
                  value={editing.version}
                  disabled={remote || saving}
                  onChange={(e) => setEditing({ ...editing, version: e.target.value })}
                />
              </label>
              <label className="cap-form-wide">
                <span>一句话适用场景（供 Agent 按需发现，留空自动提取）</span>
                <input
                  type="text"
                  placeholder="例如 审阅系统策划文档或数值表结构时自动参考"
                  value={editing.description}
                  disabled={remote || saving}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </label>
              <label className="cap-form-wide">
                <span>技能正文（SKILL.md，支持标准 YAML Frontmatter + Markdown）</span>
                <textarea
                  rows={10}
                  className="skill-editor-ta"
                  value={editing.markdown}
                  disabled={remote || saving}
                  onChange={(e) => setEditing({ ...editing, markdown: e.target.value, approveRisks: false })}
                />
              </label>
            </div>

            <div className="cap-field-block">
              <span className="cap-field-title">分配给哪些 Agent（都不选表示全部可用）</span>
              <div className="cap-agent-checks">
                {ALL_AGENT_KINDS.map((kind) => {
                  const has = editing.agents.includes(kind);
                  return (
                    <label key={kind} className="cap-check-chip">
                      <input
                        type="checkbox"
                        checked={has}
                        disabled={remote || saving}
                        onChange={() => setEditing({ ...editing, agents: has ? editing.agents.filter((a) => a !== kind) : [...editing.agents, kind] })}
                      />
                      <span>{agentDisplayName(kind)}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="cap-form-acts">
              <button
                type="button"
                className="btn"
                disabled={remote || scanningContent || !editing.markdown.trim()}
                onClick={() => void runContentScan(editing.markdown, editing.extraFiles)}
              >
                {scanningContent ? '正在安全预检…' : '运行静态安全预检'}
              </button>
            </div>

            {previewScan ? <ScanFindingsBox scan={previewScan} title="静态安全预检结果" /> : null}

            {previewScan && (previewScan.riskLevel === 'danger' || previewScan.hasScripts) ? (
              <label className="cap-check-chip skill-confirm-risk">
                <input
                  type="checkbox"
                  checked={editing.approveRisks}
                  disabled={remote || saving}
                  onChange={(e) => setEditing({ ...editing, approveRisks: e.target.checked })}
                />
                <span>我已核对以上风险告警与脚本清单，确认来源可信并允许启用（不勾选则会安全保存但默认停用）</span>
              </label>
            ) : null}

            {formError ? <p className="monitor-form-err" role="alert">{formError}</p> : null}

            <div className="cap-form-acts">
              <button type="submit" className="btn primary" disabled={remote || saving}>
                {saving ? '保存中…' : (editing.id ? '保存修改' : '保存到技能库')}
              </button>
              <button type="button" className="btn" disabled={saving} onClick={() => { setEditing(null); setPreviewScan(null); setFormError(null); }}>
                取消
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {/* 技能列表 */}
      {loading && skills.length === 0 ? (
        <div className="empty"><p>正在读取技能库…</p></div>
      ) : skills.length === 0 && !editing && !wizardOpen ? (
        <section className="set-sec cap-section">
          <div className="cap-empty">
            <h3>还没有配置工作台技能包（Skills）</h3>
            <p>把你常用的策划检查清单、美术验收标准、代码审查套路做成 <code>SKILL.md</code>，或从本机 <code>~/.agents/skills</code> 一键只读导入；启用后所有 Agent 都会按需自动读取。</p>
            <div className="cap-form-acts">
              <button type="button" className="btn primary" disabled={remote} onClick={openCreate}>
                <Icon name="plus" />新建第一个技能
              </button>
              <button type="button" className="btn" disabled={remote} onClick={() => setWizardOpen(true)}>
                <Icon name="wand" />本机只读导入
              </button>
            </div>
          </div>
        </section>
      ) : (
        <div className="cap-list">
          {skills.map((sk) => {
            const rm = riskMeta(sk.scan.riskLevel);
            const waitingRisk = sk.requiresApproval && !sk.risksApproved;
            const expanded = expandedId === sk.id;
            const detail = detailsCache[sk.id];
            return (
              <article key={sk.id} className={'set-sec cap-card' + (!sk.enabled ? ' is-off' : '')}>
                <div className="cap-card-top">
                  <div className="cap-card-title">
                    <strong>{sk.name}</strong>
                    <span className="monitor-pill neutral">{sk.slug}</span>
                    {waitingRisk ? (
                      <span className="monitor-status err"><span aria-hidden="true">■</span> 待风险确认</span>
                    ) : sk.enabled ? (
                      <span className="monitor-status ok"><span aria-hidden="true">●</span> 已启用</span>
                    ) : (
                      <span className="monitor-status idle"><span aria-hidden="true">○</span> 已停用</span>
                    )}
                    <span className={'monitor-pill ' + (sk.scan.riskLevel === 'danger' ? 'hot' : sk.scan.riskLevel === 'warn' ? 'neutral' : 'ok')}>
                      {rm.label}
                    </span>
                    {sk.hasScripts ? (
                      <span className="monitor-pill hot">含 {sk.scriptFiles.length} 个脚本</span>
                    ) : null}
                  </div>
                  <div className="cap-card-acts">
                    <button
                      type="button"
                      className="switch"
                      role="switch"
                      aria-checked={sk.enabled}
                      aria-label={sk.enabled ? `停用技能 ${sk.name}` : `启用技能 ${sk.name}`}
                      disabled={remote || saving}
                      onClick={() => void toggleEnabled(sk)}
                    />
                    <button type="button" className="btn xs" onClick={() => void togglePreview(sk)}>
                      {expanded ? '收起详情' : (waitingRisk ? '核对风险' : '查看内容')}
                    </button>
                    <button type="button" className="btn xs" disabled={remote || saving} onClick={() => void openEdit(sk)}>编辑</button>
                    <button type="button" className="btn xs danger" disabled={remote || saving} onClick={() => void removeSkill(sk)}>删除</button>
                  </div>
                </div>

                {sk.description ? <p className="cap-card-desc">{sk.description}</p> : null}

                <div className="cap-meta-grid">
                  <div>
                    <span className="cap-meta-k">来源</span>
                    <span>{sk.sourceLabel}{sk.version ? ` · v${sk.version}` : ''}</span>
                  </div>
                  <div>
                    <span className="cap-meta-k">适用 Agent</span>
                    <span>{sk.agents.length ? sk.agents.map(agentDisplayName).join('、') : '全部 Agent'}</span>
                  </div>
                  <div>
                    <span className="cap-meta-k">包内文件</span>
                    <span>{sk.files.map((f) => f.path).join('、')}</span>
                  </div>
                  <div>
                    <span className="cap-meta-k">内容摘要</span>
                    <code className="cap-meta-code">{sk.contentHash.slice(0, 16)}</code>
                  </div>
                </div>

                {waitingRisk ? (
                  <div className="skill-gate-bar">
                    <span>检测到高危告警或附带可执行脚本，系统已自动拦截；确认可信后才可启用。</span>
                    <div className="cap-card-acts">
                      <button type="button" className="btn xs primary" disabled={remote || saving} onClick={() => void approveAndEnable(sk)}>
                        我已核对风险并启用
                      </button>
                    </div>
                  </div>
                ) : null}

                {expanded ? (
                  <div className="skill-detail-box">
                    <ScanFindingsBox scan={sk.scan} title="安全扫描记录" />
                    {loadingDetailId === sk.id ? (
                      <p className="cap-card-desc">正在读取 SKILL.md 正文…</p>
                    ) : detail ? (
                      <pre className="skill-md-pre">{detail.markdown}</pre>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
