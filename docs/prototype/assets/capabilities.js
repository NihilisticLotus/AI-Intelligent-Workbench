// 能力页：把各 Agent 的 MCP 和 Skill 收拢到一处统一管理；另在工作台输入框工具条上提供“本任务的 MCP”弹出层。
// 只做原型演示：数据是 docs/design.md 第 25 节本机盘点的名称，配置细节为示例，保存在内存里。
// 依赖 app.js（图标、侧栏、右侧面板）和 interact.js（aicModal、aicToast、aicMenu、aicEsc）。
(function () {
  const page = document.body.dataset.page;
  if (page !== 'capabilities' && page !== 'workbench') return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicModal: modal, aicMenu: menu, aicEsc: esc } = window;
  const ic = (n, c) => window.icon(n, c);

  // ---------- Agent ----------
  const AG = { claude: ['Claude Code', 'C'], codex: ['Codex', 'X'], codebuddy: ['CodeBuddy', 'B'], workbuddy: ['WorkBuddy', 'W'], zcode: ['ZCode', 'Z'] };
  const AGK = Object.keys(AG);
  const agName = (k) => AG[k][0];
  const agList = (list) => (list.length === AGK.length ? '全部 5 个 Agent' : list.length ? list.map(agName).join('、') : '没有分配');
  // 已分配的是实心徽标，未分配的是空心描边：不只靠颜色区分
  const agBadges = (list) => `<span class="ags" role="img" aria-label="${agList(list)}" title="${agList(list)}">${AGK.map((k) => `<span class="ag ${list.includes(k) ? k : 'no'}" aria-hidden="true">${AG[k][1]}</span>`).join('')}</span>`;
  const agChecks = (name, cur) => `<div class="checks" role="group" aria-label="分配给哪些 Agent">${AGK.map((k) => `<label><input type="checkbox" name="${name}" value="${k}" ${cur.includes(k) ? 'checked' : ''}><span class="ag ${k}" aria-hidden="true">${AG[k][1]}</span>${agName(k)}</label>`).join('')}</div>`;
  const readChecks = (d, name) => $$(`input[name="${name}"]:checked`, d).map((i) => i.value);
  const when = (m) => (m < 1 ? '刚刚' : m < 60 ? `${Math.round(m)} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`);

  // ---------- MCP 示例数据 ----------
  // 提供方式：每个 Agent 默认用 ACP 注入；CodeBuddy 示例里忽略 ACP 传入的 MCP，改为在它的配置里写一条 ai-console 入口
  const viaText = { acp: 'ACP 注入', config: '已写入 Agent 配置', sync: '原样同步' };
  const viaNote = { acp: '会话建立时把工作台的 MCP 入口传给 Agent，不改动配置文件', config: '在它的全局配置里加了一条名为 ai-console 的入口，写入前已备份', sync: '这个 MCP 无法经过工作台代理，配置转换后写进了各 Agent 的配置文件' };
  const agentVia = { claude: 'acp', codex: 'acp', codebuddy: 'config', workbuddy: 'acp', zcode: 'acp' };
  const EXCL = '它连着正在运行的桌面软件，几个会话同时操作会互相干扰。同一时间只允许一个会话调用，其他会话排队。';
  const T = '宝箱模型：箱盖改圆、补铁箍', T2 = '批量把 FBX 转成 glTF 并压缩贴图', T3 = '修复 Steam 云同步时存档偶发损坏';
  const mk = (o) => ({ type: 'stdio', st: 'run', agents: [...AGK], conc: 'shared', env: [], also: [], calls: [], enabled: true, ...o });
  const mcps = [
    mk({ id: 'blender', conc: 'exclusive', origin: 'Claude Code · ~/.claude.json', also: ['Codex · ~/.codex/config.toml', 'ZCode · ~/.zcode/cli/config.json'],
      cmd: 'uvx', args: ['blender-mcp'], tools: ['get_scene_info', 'execute_blender_code', 'look', 'import_asset'],
      calls: [[3, 'look', T, '0.6 秒'], [4, 'execute_blender_code', T, '1.8 秒'], [9, 'get_scene_info', T, '0.3 秒']] }),
    mk({ id: 'houdini', conc: 'exclusive', origin: 'Codex · ~/.codex/config.toml', also: ['Claude Code · ~/.claude.json', 'ZCode · ~/.zcode/cli/config.json（参数不同）'],
      cmd: 'hython', args: ['-m', 'houdini_mcp', '--port', '18811'], tools: ['get_scene_info', 'create_node', 'set_parm', 'cook_node', 'render_rop'],
      calls: [[42, 'cook_node', T2, '4.1 秒'], [44, 'create_node', T2, '0.5 秒']] }),
    mk({ id: 'fxhoudini', st: 'idle', origin: 'ZCode · ~/.zcode/cli/config.json', cmd: 'python', args: ['-m', 'fxhoudini_mcp'], tools: ['list_fx_presets', 'build_pyro_sim', 'export_vdb'], calls: [[2880, 'list_fx_presets', '烟雾特效预设整理', '0.9 秒']] }),
    mk({ id: 'renderdoc', conc: 'exclusive', origin: 'Claude Code · ~/.claude.json', also: ['Codex · ~/.codex/config.toml'],
      cmd: 'python', args: ['-m', 'renderdoc_mcp', '--bridge', 'qrenderdoc'], tools: ['open_capture', 'get_draw_packet', 'get_shader_code', 'export_mesh'],
      calls: [[190, 'get_draw_packet', '主菜单背景视差动画', '1.2 秒']] }),
    mk({ id: 'bilibili', origin: 'Claude Code · ~/.claude.json', also: ['Codex · ~/.codex/config.toml', 'CodeBuddy · ~/.codebuddy/mcp.json', 'ZCode · ~/.zcode/cli/config.json'],
      cmd: 'npx', args: ['-y', 'bilibili-mcp'], env: ['BILIBILI_SESSDATA'], tools: ['extract_bilibili_video', 'extract_bilibili_comments', 'extract_bilibili_danmaku'],
      calls: [[65, 'extract_bilibili_comments', '竞品宣传片评论整理', '3.4 秒']] }),
    mk({ id: 'video-analyzer', origin: 'Codex · ~/.codex/config.toml', also: ['CodeBuddy · ~/.codebuddy/mcp.json', 'ZCode · ~/.zcode/cli/config.json'],
      cmd: 'uvx', args: ['video-analyzer-mcp'], env: ['VIDEO_ANALYZER_API_KEY'], tools: ['analyze_video', 'extract_frames', 'transcribe'],
      calls: [[130, 'extract_frames', '竞品宣传片评论整理', '6.2 秒']] }),
    mk({ id: 'node_repl', st: 'idle', origin: 'Codex · ~/.codex/config.toml', cmd: 'npx', args: ['-y', 'node-repl-mcp'], tools: ['eval', 'reset'] }),
    mk({ id: 'qml_preview', st: 'err', err: '启动失败：找不到 qmlscene.exe（Qt 没有加入 PATH）', via: 'sync', origin: 'Codex · ~/.codex/config.toml',
      cmd: 'qml-preview-mcp', args: ['--qt', 'C:\\Qt\\6.8\\msvc2022_64'], tools: ['render_qml', 'list_components', 'screenshot'] }),
    mk({ id: 'zai-mcp-server', origin: 'CodeBuddy · ~/.codebuddy/mcp.json', cmd: 'npx', args: ['-y', '@z_ai/mcp-server'], env: ['Z_AI_API_KEY', 'Z_AI_MODE'],
      tools: ['analyze_image', 'analyze_video', 'ui_to_artifact'], calls: [[25, 'analyze_image', T3, '2.7 秒']] }),
    mk({ id: 'web-search-prime', type: 'http', origin: 'CodeBuddy · ~/.codebuddy/mcp.json', url: 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp', env: ['Authorization'],
      tools: ['webSearchPrime'], calls: [[12, 'webSearchPrime', T3, '1.1 秒'], [14, 'webSearchPrime', T3, '0.9 秒']] }),
    mk({ id: 'web-reader', type: 'http', origin: 'CodeBuddy · ~/.codebuddy/mcp.json', url: 'https://open.bigmodel.cn/api/mcp/web_reader/mcp', env: ['Authorization'],
      tools: ['webReader'], calls: [[13, 'webReader', T3, '2.0 秒']] }),
    mk({ id: 'zread', type: 'http', origin: 'CodeBuddy · ~/.codebuddy/mcp.json', url: 'https://open.bigmodel.cn/api/mcp/zread/mcp', env: ['Authorization'],
      tools: ['search_doc', 'read_file', 'get_repo_structure'], calls: [[300, 'get_repo_structure', '升级 Addressables 到 2.3', '1.5 秒']] }),
  ];
  window.aicMcps = mcps;

  // ---------- 工作台：输入框工具条上的“MCP 12”，临时停用只对当前任务生效 ----------
  if (page === 'workbench') {
    const chip = $('#mcp-chip'), pop = $('#pop-mcp');
    if (!chip || !pop) return;
    const off = new Set();
    const on = () => mcps.filter((m) => m.enabled && !off.has(m.id));
    const paint = () => {
      const n = on().length, all = mcps.filter((m) => m.enabled).length;
      chip.innerHTML = `${ic('plug')}<span class="lbl">MCP </span>${n}${off.size ? `<span class="muted">/${all}</span>` : ''}`;
      chip.title = `本任务可用的 MCP：${n} 个${off.size ? '（已临时停用 ' + off.size + ' 个）' : ''}，点击管理`;
      chip.setAttribute('aria-label', `本任务可用的 MCP：${n} 个${off.size ? `，临时停用了 ${off.size} 个` : ''}。点击临时停用`);
    };
    const render = () => {
      pop.innerHTML = `<div class="group-label">本任务可用的 MCP</div>
        <div class="mcp-pick">${mcps.filter((m) => m.enabled).map((m) => `<label class="mcp-opt"><input type="checkbox" value="${m.id}" ${off.has(m.id) ? '' : 'checked'}><code>${esc(m.id)}</code><span class="meta">${m.type}${m.conc === 'exclusive' ? ' · 独占' : ''}</span></label>`).join('')}</div>
        <div class="hint">取消勾选即临时停用，只对当前任务生效，从下一步开始。全局的启用、分配在“能力”页里改。</div>
        <div class="mcp-pop-foot"><button class="btn sm ghost" data-wired="1" data-mcp-reset ${off.size ? '' : 'disabled'}>全部恢复</button><span class="grow"></span><a class="btn sm ghost" data-wired="1" href="capabilities.html">打开能力页</a></div>`;
    };
    const note = (text) => { if (window.aicAdd && window.aicSysnote) window.aicAdd(window.aicSysnote(text)); };
    pop.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"]'); if (!cb) return;
      if (cb.checked) off.delete(cb.value); else off.add(cb.value);
      paint(); $('[data-mcp-reset]', pop).disabled = !off.size;
      note(cb.checked ? `本任务重新启用 MCP：${esc(cb.value)}` : `本任务临时停用 MCP：${esc(cb.value)}（只对这个任务生效）`);
      toast(cb.checked ? `本任务重新启用了 ${esc(cb.value)}` : `本任务临时停用了 ${esc(cb.value)}，其他任务不受影响`);
    });
    pop.addEventListener('click', (e) => {
      if (!e.target.closest('[data-mcp-reset]')) return;
      off.clear(); render(); paint();
      note('本任务的 MCP 已全部恢复'); toast('已恢复全部 MCP');
    });
    chip.addEventListener('click', () => setTimeout(() => { if (!pop.hidden) $('input', pop)?.focus(); }));
    render(); paint();
    return;
  }
  // ---------- Skill 示例数据 ----------
  const VIDEO = [
    ['audio-cleanup', '降噪、去掉口水音和底噪，统一响度', ['scripts/denoise.py'], true],
    ['audio-ducking', '人声出现时自动压低背景音乐', [], true],
    ['caption-styling', '字幕的字体、描边、位置和安全区规范', [], true],
    ['captions', '从音轨生成带时间轴的字幕（SRT）', ['scripts/transcribe.py'], true],
    ['claude-real-video', '把实录素材整理成可剪辑的片段清单', [], true],
    ['colour-grade', '调色：统一白平衡、套用 LUT', ['scripts/apply_lut.py'], false],
    ['general-edit', '通用剪辑流程：粗剪、精剪、导出前检查', [], true],
    ['highlight-reel', '从长视频里挑出高光片段，剪成集锦', ['scripts/find_peaks.py'], true],
    ['pacing', '检查节奏：镜头时长、停顿、转场密度', [], true],
  ];
  const skills = [
    ...VIDEO.map(([name, desc, sc, ok]) => ({ id: name, name, desc, video: true, src: 'CodeBuddy · ~/.codebuddy/skills', copies: ['~/.codebuddy/skills', '~/.agents/skills', '~/.zcode/skills'], ver: '1.2.0',
      scripts: sc.map((p) => ({ path: p, ok })), refs: ['references/checklist.md'] })),
    { id: '3dviz-pro-max', name: '3dviz-pro-max', desc: '三维可视化：搭场景、布灯光、出渲染预览', src: 'Codex · ~/.codex/skills', ver: '2.0.1', scripts: [{ path: 'scripts/render_preview.py', ok: false }], refs: ['references/lighting.md', 'assets/hdri_list.json'] },
    { id: 'ui-ux-pro-max', name: 'ui-ux-pro-max', desc: '界面与交互设计规范、评审清单', src: 'Codex · ~/.codex/skills', ver: '1.4.0', scripts: [], refs: ['references/heuristics.md'] },
    { id: 'eni-coldbrew', name: 'eni-coldbrew', desc: '（示例描述，正式版读取 SKILL.md 里的 description）', src: 'Codex · ~/.codex/skills', ver: '0.3.0', scripts: [], refs: [] },
    { id: 'fix-precedents-skill', name: 'fix-precedents-skill', desc: '（示例描述）修 bug 前先查仓库里的同类修复先例', src: 'ZCode · ~/.zcode/skills', ver: '1.0.2', scripts: [], refs: ['references/examples.md'], dist: 'copy' },
  ].map((s) => ({ agents: [...AGK], dist: 'link', enabled: true, ...s }));
  const skillDir = { claude: '~/.claude/skills', codex: '~/.codex/skills', codebuddy: '~/.codebuddy/skills', zcode: '~/.zcode/skills' };
  const NATIVE_SKILL = { claude: true, codex: true, codebuddy: true, workbuddy: false, zcode: true };
  const scriptState = (s) => (!s.scripts.length ? '' : s.scripts.every((x) => x.ok) ? 'ok' : 'wait');

  // ---------- 页面 ----------
  const state = { tab: 'mcp', mcp: 'blender', skill: 'pacing', last: null };
  const stInfo = (m) => ({ run: ['run', '运行中'], idle: ['idle', '已停止'], err: ['err', '出错'], start: ['run', '启动中'] }[m.enabled ? m.st : 'idle']);
  const stText = (m) => (m.enabled ? stInfo(m)[1] : '已停用');
  const status = (m) => `<span class="status ${stInfo(m)[0]}"><span class="dot"></span>${stText(m)}</span>`;
  const concTag = (m) => (m.conc === 'exclusive' ? `<span class="tag lock" title="${EXCL}">${ic('lock')}独占</span>` : '<span class="tag">共享</span>');
  const meta = () => {
    $('#cap-meta').textContent = `${mcps.length} 个 MCP，${mcps.filter((m) => m.enabled).length} 个启用 · ${skills.length} 个 Skill`;
    $('#cnt-mcp').textContent = mcps.length; $('#cnt-skill').textContent = skills.length;
    $('#cap-last').textContent = state.last ? `上次整合：${state.last}` : '上次整合：3 天前（12 个 MCP、13 个 Skill）';
  };
  const swCell = (on, name) => `<td class="c-sw"><button class="switch" role="switch" data-wired="1" data-sw aria-checked="${on}" aria-label="启用 ${esc(name)}"></button><span class="sw-t">${on ? '启用' : '停用'}</span></td>`;
  const moreCell = (name) => `<td class="c-more"><button class="btn ghost icon sm" data-wired="1" data-more aria-label="${esc(name)} 的更多操作" title="更多操作">${ic('more')}</button></td>`;
  const renderMcp = () => {
    $('#mcp-rows').innerHTML = mcps.map((m) => {
      const c = m.calls[0];
      return `<tr data-id="${m.id}" tabindex="0" aria-selected="${m.id === state.mcp}" class="${m.enabled ? '' : 'off'}">
        <td class="c-name"><b>${esc(m.id)}</b>${m.err && m.enabled ? `<span class="sub" style="color:var(--err)">${esc(m.err)}</span>` : ''}</td>
        <td class="c-type"><span class="tag">${m.type}</span></td>
        <td class="c-nowrap">${status(m)}</td>
        <td class="c-ags">${agBadges(m.agents)}</td>
        <td class="c-conc">${concTag(m)}</td>
        <td class="c-recent">${c ? `${when(c[0])}<span class="sub">${esc(m.id)}__${esc(c[1])}</span>` : '<span class="sub">还没有调用</span>'}</td>
        ${swCell(m.enabled, m.id)}${moreCell(m.id)}</tr>`;
    }).join('');
  };
  const renderSkill = () => {
    $('#skill-rows').innerHTML = skills.map((s) => `<tr data-id="${s.id}" tabindex="0" aria-selected="${s.id === state.skill}" class="${s.enabled ? '' : 'off'}">
        <td class="c-name"><b>${esc(s.name)}</b>${scriptState(s) === 'wait' ? '<span class="sub"><span class="status wait"><span class="dot"></span>脚本待确认</span></span>' : ''}</td>
        <td class="c-desc">${esc(s.desc)}</td>
        <td class="c-src c-nowrap"><span class="sub" style="color:var(--fg-2)">${esc(s.src.split(' · ')[0])}</span>${s.video ? '<span class="sub">已合并 3 处副本</span>' : ''}</td>
        <td class="c-ver c-nowrap">${esc(s.ver)}</td>
        <td class="c-ags">${agBadges(s.agents)}</td>
        <td class="c-dist"><span class="tag">${ic(s.dist === 'link' ? 'link' : 'copy')}${s.dist === 'link' ? '链接' : '复制'}</span></td>
        ${swCell(s.enabled, s.name)}${moreCell(s.name)}</tr>`).join('');
  };
  const render = () => { meta(); renderMcp(); renderSkill(); renderSide(); };

  // ---------- 右侧详情 ----------
  const side = $('#cap-detail');
  const mcpSide = (m) => {
    const cmd = m.type === 'http' ? m.url : [m.cmd, ...m.args].join(' ');
    const via = (k) => (m.via === 'sync' ? 'sync' : agentVia[k]);
    return `<h2>${esc(m.id)}</h2>
      <p class="lead">${status(m)}<span class="tag">${m.type}</span>${concTag(m)}</p>
      ${m.err && m.enabled ? `<div class="alert err" style="margin-bottom:var(--sp-3)">${ic('warn')}<div class="body"><strong>${esc(m.err)}</strong><p>装好 Qt 或在编辑里改成 qmlscene.exe 的完整路径，再点“测试连接”。</p></div></div>` : ''}
      ${m.conc === 'exclusive' ? `<p class="note" style="margin:0 0 var(--sp-3)">${ic('lock')} 独占：${EXCL}</p>` : ''}
      <div class="d-acts">
        <button class="btn sm primary" data-wired="1" data-op="test">${ic('pulse')}测试连接</button>
        <button class="btn sm" data-wired="1" data-op="restart" ${m.enabled ? '' : 'disabled'}>${ic('refresh')}重启</button>
        <button class="btn sm" data-wired="1" data-op="edit">${ic('edit')}编辑</button>
        <button class="btn sm" data-wired="1" data-op="toggle">${ic(m.enabled ? 'pause' : 'play')}${m.enabled ? '停用' : '启用'}</button>
        <button class="btn sm ghost icon" data-wired="1" data-op="more" aria-label="更多操作">${ic('more')}</button>
      </div>
      <dl class="d-kv">
        <dt>来源</dt><dd>${esc(m.origin)}${m.also.length ? `<span class="sub">另外 ${m.also.length} 处有同名配置：${m.also.map(esc).join('、')}</span>` : ''}</dd>
        <dt>${m.type === 'http' ? '地址' : '启动命令'}</dt><dd><code class="codeline">${esc(cmd)}</code></dd>
        <dt>环境变量</dt><dd>${m.env.length ? `<ul class="plain">${m.env.map((v) => `<li><code>${esc(v)}</code><span class="sub">${ic('key')} 已存入凭据管理器</span></li>`).join('')}</ul>` : '<span class="sub">没有</span>'}</dd>
        <dt>提供给</dt><dd>${agBadges(m.agents)} <span class="sub" style="display:inline">${agList(m.agents)}</span></dd>
      </dl>
      <h3>工具（${m.tools.length}）</h3>
      <ul class="plain">${m.tools.map((t) => `<li><code>${esc(m.id)}__${esc(t)}</code></li>`).join('')}</ul>
      <p class="note">经工作台提供时，工具名都加服务器前缀，不同服务器的同名工具不会冲突。</p>
      <h3>最近调用</h3>
      ${m.calls.length ? `<ul class="plain calls">${m.calls.map((c) => `<li><span class="status ok"><span class="dot"></span>成功</span><code>${esc(m.id)}__${esc(c[1])}</code><span class="sub">${when(c[0])} · ${esc(c[3])} · ${esc(c[2])}</span></li>`).join('')}</ul>` : '<p class="sub" style="margin:0">还没有调用记录</p>'}
      <h3>提供方式</h3>
      <ul class="plain">${m.agents.map((k) => `<li><span class="ag ${k}" aria-hidden="true">${AG[k][1]}</span>${agName(k)}<b style="font-weight:600">${viaText[via(k)]}</b><span class="sub">${viaNote[via(k)]}</span></li>`).join('') || '<li class="sub">没有分配给任何 Agent</li>'}</ul>`;
  };
  const skillMd = (s) => `---
name: ${s.name}
description: ${s.desc}
version: ${s.ver}
---

# ${s.name}

## 什么时候用
用户要求“${s.desc.replace(/^（示例描述[^）]*）/, '')}”时使用。

## 步骤
1. 先读 references/ 里的清单，确认输入素材和目标格式。
2. ${s.scripts.length ? `运行 ${s.scripts[0].path}，把结果写到工作目录。` : '按清单逐项处理，每一步说明改了什么。'}
3. 汇报结果，列出需要人工确认的地方。

（原型示例内容）`;
  const linkLine = (s, k) => {
    if (!NATIVE_SKILL[k]) return `<li><span class="ag ${k}" aria-hidden="true">${AG[k][1]}</span>${agName(k)}<span class="sub">不支持原生 Skill，通过 skills_list / skills_read 工具提供</span></li>`;
    const p = `${skillDir[k]}/${s.name}`;
    return `<li><span class="ag ${k}" aria-hidden="true">${AG[k][1]}</span><code>${esc(p)}</code><span class="sub">${s.dist === 'link' ? '→ 统一库（目录联接）' : '复制，哈希 3f9a…c21（这个位置不支持目录联接）'}</span></li>`;
  };
  const skillSide = (s) => `<h2>${esc(s.name)}</h2>
      <p class="lead"><span class="status ${s.enabled ? 'ok' : 'idle'}"><span class="dot"></span>${s.enabled ? '已启用' : '已停用'}</span><span class="tag">版本 ${esc(s.ver)}</span><span class="tag">${ic(s.dist === 'link' ? 'link' : 'copy')}${s.dist === 'link' ? '链接' : '复制'}</span></p>
      <div class="d-acts">
        <button class="btn sm" data-wired="1" data-op="update">${ic('refresh')}更新</button>
        <button class="btn sm" data-wired="1" data-op="assign">${ic('bot')}分配给…</button>
        <button class="btn sm" data-wired="1" data-op="toggle">${ic(s.enabled ? 'pause' : 'play')}${s.enabled ? '停用' : '启用'}</button>
        <button class="btn sm ghost icon" data-wired="1" data-op="more" aria-label="更多操作">${ic('more')}</button>
      </div>
      <dl class="d-kv">
        <dt>描述</dt><dd>${esc(s.desc)}</dd>
        <dt>来源</dt><dd>${esc(s.src)}${s.video ? '<span class="sub">原来在 ~/.codebuddy、~/.agents、~/.zcode 各有一份内容相同的副本，已统一成 1 份</span>' : ''}</dd>
        <dt>统一库</dt><dd><code>%APPDATA%\\AI_Console\\skills\\${esc(s.name)}</code></dd>
      </dl>
      <h3>SKILL.md</h3>
      <pre class="mdprev" tabindex="0" aria-label="SKILL.md 预览">${esc(skillMd(s))}</pre>
      <h3>包含的文件</h3>
      <ul class="plain">${['SKILL.md', ...s.refs].map((f) => `<li>${ic('file')}<code>${esc(f)}</code></li>`).join('')}${s.scripts.map((x, i) => `<li>${ic('terminal')}<code>${esc(x.path)}</code>${x.ok ? '<span class="status ok"><span class="dot"></span>脚本已确认</span>' : `<span class="status wait"><span class="dot"></span>脚本待确认</span><button class="btn sm" data-wired="1" data-op="approve" data-i="${i}">查看并确认</button>`}</li>`).join('')}</ul>
      ${s.scripts.length ? '<p class="note">带脚本的 Skill，脚本确认后才会分发给 Agent 执行。</p>' : ''}
      <h3>在各 Agent 里</h3>
      <ul class="plain">${s.agents.map((k) => linkLine(s, k)).join('') || '<li class="sub">没有分配给任何 Agent</li>'}<li>${ic('folder')}<code>~/.agents/skills/${esc(s.name)}</code><span class="sub">跨厂商公共目录 → 统一库</span></li></ul>`;
  const renderSide = () => {
    const m = mcps.find((x) => x.id === state.mcp), s = skills.find((x) => x.id === state.skill);
    if (state.tab === 'gen') { window.aicGenSide?.(side); return; } // 生成器标签的详情由 generate.js 提供
    const it = state.tab === 'mcp' ? m : s;
    side.innerHTML = it ? (state.tab === 'mcp' ? mcpSide(m) : skillSide(s)) : '<div class="empty"><p>选择左边的一项查看详情。</p></div>';
  };
  const select = (id, open = true) => {
    state[state.tab] = id;
    $$(`#${state.tab}-rows tr[data-id]`).forEach((r) => r.setAttribute('aria-selected', String(r.dataset.id === id)));
    renderSide();
    if (open) window.aicOpenSide();
  };
  // ---------- MCP 操作 ----------
  const later = (ms, fn) => setTimeout(fn, ms);
  const toggleMcp = (m) => {
    m.enabled = !m.enabled;
    if (m.enabled && m.st !== 'err') m.st = 'run';
    render();
    toast(m.enabled ? `已启用 ${esc(m.id)}，${agList(m.agents)}的新会话都能用` : `已停用 ${esc(m.id)}，正在进行的会话从下一步起不再提供它`);
  };
  const restart = (m) => {
    if (!m.enabled) return toast(`${esc(m.id)} 已停用，先启用再重启`, 'attn');
    m.st = 'start'; render(); toast(`正在重启 ${esc(m.id)}…`);
    later(1400, () => {
      if (m.err) { m.st = 'err'; render(); return toast(`${esc(m.id)} 重启失败：${esc(m.err)}`, 'err'); }
      m.st = 'run'; render(); toast(`${esc(m.id)} 已重启，进程只有一份，${m.conc === 'exclusive' ? '排队中的调用会依次继续' : '所有会话共用'}`);
    });
  };
  const testConn = (m) => {
    const lines = m.type === 'http'
      ? [`连接 ${m.url}`, '发送 initialize，协议版本 2025-06-18', `从凭据管理器读取 ${m.env[0] || '认证信息'}（不显示值）`]
      : [`启动进程：${[m.cmd, ...m.args].join(' ')}`, ...(m.env.length ? [`注入环境变量：${m.env.join('、')}（值来自凭据管理器）`] : []), '发送 initialize，协议版本 2025-06-18'];
    const fail = m.err;
    const d = modal({ title: `测试连接：${esc(m.id)}`, body: `<pre class="testlog" aria-live="polite"></pre>${m.conc === 'exclusive' ? `<p class="note">${ic('lock')} 这是独占的 MCP，测试只读取工具列表，不会操作桌面软件里的内容。</p>` : ''}`, actions: [{ label: '关闭' }] });
    const log = $('.testlog', d); const t = () => new Date().toTimeString().slice(0, 8);
    const push = (s) => { log.textContent += (log.textContent ? '\n' : '') + `${t()}  ${s}`; };
    lines.forEach((l, i) => later(350 * (i + 1), () => push(l)));
    later(350 * (lines.length + 1) + 200, () => {
      if (fail) { push(`失败：${fail}`); push('结果：没有连上'); m.st = 'err'; render(); return; }
      push(`列出工具：${m.tools.length} 个（${m.tools.slice(0, 2).map((x) => `${m.id}__${x}`).join('、')}…）`);
      push('结果：一切正常，往返 0.4 秒');
      if (m.enabled) m.st = 'run';
      render(); toast(`${esc(m.id)} 测试通过`);
    });
  };
  const removeMcp = (m) => modal({ title: `移除 ${esc(m.id)}？`,
    body: `<p>移除后工作台不再提供它，所有 Agent 在工作台里的会话都用不到 ${esc(m.id)} 的工具。</p>
      <p style="margin:0">不会改动各 Agent 自己的配置：${[m.origin, ...m.also].map((x) => `<code>${esc(x.split(' · ')[1].replace(/（.*）/, ''))}</code>`).join('、')} 里的条目都保留，在工作台之外打开 Agent 照常可用。</p>`,
    actions: [{ label: '取消' }, { label: '移除', kind: 'danger', onClick() {
      mcps.splice(mcps.indexOf(m), 1);
      if (state.mcp === m.id) state.mcp = mcps[0]?.id;
      render(); toast(`已移除 ${esc(m.id)}，各 Agent 自己的配置没有改动`);
    } }] });
  const concRadios = (cur) => `<div class="radios" role="radiogroup" aria-labelledby="me-c-l"><label><input type="radio" name="me-c" value="shared" ${cur === 'shared' ? 'checked' : ''}>共享：多个会话同时调用</label><label><input type="radio" name="me-c" value="exclusive" ${cur === 'exclusive' ? 'checked' : ''}>独占：同一时间只允许一个会话</label></div>`;
  const editMcp = (m) => modal({ title: `编辑 ${esc(m.id)}`, wide: true,
    body: `<div class="form-row" style="align-items:start"><span class="lbl">分配给</span>${agChecks('me-a', m.agents)}</div>
      <div class="form-row" style="align-items:start"><span class="lbl" id="me-c-l">并发方式</span><div>${concRadios(m.conc)}<p class="note">连着桌面软件（Blender、Houdini、RenderDoc）的建议设为独占。</p></div></div>
      ${m.type === 'http' ? `<div class="form-row"><label for="me-url">地址</label><input class="input" id="me-url" value="${esc(m.url)}"></div>`
        : `<div class="form-row"><label for="me-cmd">命令</label><input class="input" id="me-cmd" value="${esc(m.cmd)}"></div>
      <div class="form-row"><label for="me-args">参数</label><input class="input" id="me-args" value="${esc(m.args.join(' '))}" aria-describedby="me-args-n"></div>
      <p class="field-note" id="me-args-n">用空格分隔。环境变量的值不在这里改，保存在 Windows 凭据管理器里。</p>`}`,
    actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) {
      const ags = readChecks(d, 'me-a');
      if (!ags.length) { toast('至少分配给一个 Agent', 'attn'); return false; }
      m.agents = ags; m.conc = $('input[name="me-c"]:checked', d).value;
      if (m.type === 'http') m.url = $('#me-url', d).value.trim() || m.url;
      else { m.cmd = $('#me-cmd', d).value.trim() || m.cmd; m.args = $('#me-args', d).value.trim().split(/\s+/).filter(Boolean); }
      render(); toast(`已保存 ${esc(m.id)}，新会话按新设置提供`);
    } }] });
  const envRow = () => '<div class="envrow"><input class="input" placeholder="变量名，例如 API_KEY" aria-label="环境变量名"><input class="input" type="password" placeholder="值" aria-label="环境变量的值，保存到 Windows 凭据管理器" autocomplete="off"><button type="button" class="btn ghost icon sm" data-wired="1" data-env-del aria-label="删除这一行">' + ic('x') + '</button></div>';
  const newMcp = () => modal({ title: '新建 MCP', wide: true,
    body: `<div class="form-row"><label for="mn-n">名称</label><input class="input" id="mn-n" placeholder="例如 image-gen"></div>
      <div class="form-row"><span class="lbl" id="mn-t-l">类型</span><div class="radios" role="radiogroup" aria-labelledby="mn-t-l"><label><input type="radio" name="mn-t" value="stdio" checked>stdio（本机命令）</label><label><input type="radio" name="mn-t" value="http">http（网络地址）</label></div></div>
      <div class="form-row"><label for="mn-c" id="mn-c-l">命令</label><input class="input" id="mn-c" placeholder="例如 npx -y image-gen-mcp"></div>
      <div class="form-row" style="align-items:start"><span class="lbl">环境变量</span><div><div id="mn-env">${envRow()}</div>
        <button type="button" class="btn sm ghost" data-wired="1" id="mn-env-add">${ic('plus')}添加一行</button>
        <p class="note">${ic('key')} 值保存到 Windows 凭据管理器，不写进任何配置文件；之后界面上只显示变量名。</p></div></div>
      <div class="form-row" style="align-items:start"><span class="lbl">提供给</span>${agChecks('mn-a', AGK)}</div>`,
    onOpen(d) {
      d.addEventListener('change', (e) => {
        if (e.target.name !== 'mn-t') return;
        const http = e.target.value === 'http';
        $('#mn-c-l', d).textContent = http ? '地址' : '命令';
        $('#mn-c', d).placeholder = http ? '例如 https://example.com/mcp' : '例如 npx -y image-gen-mcp';
      });
      $('#mn-env-add', d).addEventListener('click', () => $('#mn-env', d).insertAdjacentHTML('beforeend', envRow()));
      $('#mn-env', d).addEventListener('click', (e) => { if (e.target.closest('[data-env-del]')) e.target.closest('.envrow').remove(); });
      $('#mn-n', d).focus();
    },
    actions: [{ label: '取消' }, { label: '创建', kind: 'primary', onClick(d) {
      const name = $('#mn-n', d).value.trim(), c = $('#mn-c', d).value.trim(), type = $('input[name="mn-t"]:checked', d).value;
      if (!/^[\w.-]+$/.test(name)) { toast('名称只能用字母、数字、短横线和下划线', 'attn'); $('#mn-n', d).focus(); return false; }
      if (mcps.some((m) => m.id === name)) { toast(`已经有一个叫 ${esc(name)} 的 MCP 了`, 'attn'); return false; }
      if (!c) { toast(type === 'http' ? '填一下地址' : '填一下启动命令', 'attn'); $('#mn-c', d).focus(); return false; }
      const env = $$('.envrow', d).map((r) => r.querySelectorAll('input')[0].value.trim()).filter(Boolean);
      const [cmd, ...args] = c.split(/\s+/);
      mcps.unshift(mk({ id: name, type, cmd, args, url: c, env, agents: readChecks(d, 'mn-a'), origin: '在工作台里新建', tools: ['tool_a', 'tool_b', 'tool_c'], st: 'start' }));
      state.mcp = name; render(); window.aicOpenSide();
      toast(`已创建 ${esc(name)}${env.length ? `，${env.length} 个变量的值已存入凭据管理器` : ''}，正在启动…`);
      later(1200, () => { const m = mcps.find((x) => x.id === name); if (m) { m.st = 'run'; render(); } });
    } }] });
  const mcpMenu = (btn, m) => menu(btn, [
    ['测试连接', () => testConn(m)],
    ['重启', () => restart(m)],
    [m.enabled ? '停用' : '启用', () => toggleMcp(m)],
    ['编辑…', () => editMcp(m)],
    ['移除…', () => removeMcp(m), 'danger'],
  ]);
  // ---------- Skill 操作 ----------
  const toggleSkill = (s) => {
    s.enabled = !s.enabled; render();
    toast(s.enabled ? `已启用 ${esc(s.name)}，各 Agent 的目录联接已恢复` : `已停用 ${esc(s.name)}，各 Agent 里的联接已暂时移除，统一库里的文件保留`);
  };
  const updateSkill = (s) => {
    toast(`正在检查 ${esc(s.name)} 的来源有没有新版本…`);
    later(1100, () => {
      if (s.name === 'pacing' && s.ver === '1.2.0') {
        modal({ title: `${esc(s.name)} 有新版本 1.3.0`, body: '<p>来源里的 SKILL.md 改了 2 处：新增“转场密度上限”一条规则；步骤 2 的说明更清楚。没有新增脚本。</p><p style="margin:0">更新的是统一库里的那一份，所有 Agent 同时生效。</p>',
          actions: [{ label: '暂不更新' }, { label: '更新到 1.3.0', kind: 'primary', onClick() { s.ver = '1.3.0'; render(); toast(`${esc(s.name)} 已更新到 1.3.0，所有 Agent 同时生效`); } }] });
      } else toast(`${esc(s.name)} 已是最新版本 ${esc(s.ver)}`);
    });
  };
  const assignSkill = (s) => modal({ title: `${esc(s.name)} 分配给哪些 Agent`,
    body: `${agChecks('sa-a', s.agents)}<p class="note" style="margin-top:var(--sp-3)">取消勾选会移除那个 Agent 目录里的联接，统一库里的文件不动。WorkBuddy 不支持原生 Skill，勾选后通过 skills_list / skills_read 工具提供。</p>`,
    actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) { s.agents = readChecks(d, 'sa-a'); render(); toast(`${esc(s.name)} 现在分配给：${agList(s.agents)}`); } }] });
  const removeSkill = (s) => modal({ title: `移除 ${esc(s.name)}？`,
    body: `<p>会删除统一库里的这一份，并移除各 Agent 目录里指向它的联接。</p><p style="margin:0">${s.video ? '整合前那 3 份原始副本已备份，' : ''}原来的来源 <code>${esc(s.src.split(' · ')[1])}</code> 里的文件不受影响。</p>`,
    actions: [{ label: '取消' }, { label: '移除', kind: 'danger', onClick() { skills.splice(skills.indexOf(s), 1); if (state.skill === s.id) state.skill = skills[0]?.id; render(); toast(`已移除 ${esc(s.name)}`); } }] });
  const approveScript = (s, i) => {
    const x = s.scripts[i];
    modal({ title: `确认脚本 ${esc(x.path)}`, body: `<p>这个脚本来自 ${esc(s.src)}。确认后，Agent 使用 ${esc(s.name)} 时可以运行它。</p>
      <pre class="mdprev"># ${esc(x.path)}（节选，原型示例）\nimport sys, subprocess\n\ndef main(src, dst):\n    subprocess.run(["ffmpeg", "-i", src, "-vf", "lut3d=grade.cube", dst], check=True)\n\nif __name__ == "__main__":\n    main(sys.argv[1], sys.argv[2])</pre>
      <p class="note">会调用：ffmpeg。不会联网，只读写传入的文件。</p>`,
      actions: [{ label: '暂不启用' }, { label: '确认脚本', kind: 'primary', onClick() { x.ok = true; render(); toast(`已确认 ${esc(x.path)}`); } }] });
  };
  const skillMenu = (btn, s) => menu(btn, [
    ['查看', () => { state.skill = s.id; select(s.id); }],
    ['更新', () => updateSkill(s)],
    ['分配给…', () => assignSkill(s)],
    [s.enabled ? '停用' : '启用', () => toggleSkill(s)],
    ['移除…', () => removeSkill(s), 'danger'],
  ]);
  const importSkill = () => {
    const sample = { name: 'level-blockout', desc: '按关卡策划文档搭白盒关卡并截图', ver: '0.9.0', scripts: ['scripts/blockout.py', 'scripts/screenshot.ps1'], refs: ['references/metrics.md'] };
    modal({ title: '导入 Skill', wide: true,
      body: `<div class="form-row"><span class="lbl">文件夹</span><div style="display:flex;gap:8px;min-width:0"><input class="input" id="si-f" readonly placeholder="选一个包含 SKILL.md 的文件夹" aria-label="Skill 文件夹" style="flex:1;min-width:0"><button type="button" class="btn" data-wired="1" id="si-pick">${ic('folder')}选择文件夹…</button></div></div>
        <div id="si-res" aria-live="polite"></div>`,
      onOpen(d) {
        $('#si-pick', d).addEventListener('click', (e) => {
          const b = e.currentTarget; b.setAttribute('aria-busy', 'true');
          $('#si-f', d).value = 'D:\\Downloads\\level-blockout';
          $('#si-res', d).innerHTML = '<p class="sub">正在读取 SKILL.md…</p>';
          toast('原型模拟文件夹对话框：选了 D:\\Downloads\\level-blockout', 'demo');
          later(800, () => {
            b.removeAttribute('aria-busy');
            $('#si-res', d).innerHTML = `<dl class="d-kv" style="margin-bottom:var(--sp-3)"><dt>名称</dt><dd><code>${sample.name}</code></dd><dt>描述</dt><dd>${sample.desc}</dd><dt>版本</dt><dd>${sample.ver}</dd>
              <dt>文件</dt><dd>SKILL.md、${sample.refs.join('、')}</dd></dl>
              <div class="alert attn">${ic('warn')}<div class="body"><strong>包含 ${sample.scripts.length} 个脚本</strong><ul class="wbfiles">${sample.scripts.map((x) => `<li>${x}</li>`).join('')}</ul>
              <label class="check-row" style="margin:8px 0 0"><input type="checkbox" id="si-ok"> <span>我看过这些脚本，允许 Agent 运行它们<small>不勾也能导入，脚本会标为“待确认”，确认前不会被运行</small></span></label></div></div>`;
          });
        });
      },
      actions: [{ label: '取消' }, { label: '导入', kind: 'primary', onClick(d) {
        if (!$('#si-f', d).value || !$('#si-res dl', d)) { toast('先选择一个 Skill 文件夹', 'attn'); return false; }
        if (skills.some((s) => s.id === sample.name)) { toast(`${sample.name} 已经在统一库里了`, 'attn'); return false; }
        const ok = $('#si-ok', d).checked;
        skills.push({ id: sample.name, name: sample.name, desc: sample.desc, ver: sample.ver, src: '导入 · D:\\Downloads\\level-blockout', scripts: sample.scripts.map((p) => ({ path: p, ok })), refs: sample.refs, agents: [...AGK], dist: 'link', enabled: true });
        state.skill = sample.name; render(); window.aicOpenSide();
        toast(`已导入 ${sample.name}，已在 4 个 Agent 的目录里建好联接${ok ? '' : '；脚本待确认'}`);
      } }] });
  };

  // ---------- 事件 ----------
  const tableEvents = (tb, kind) => {
    tb.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]'); if (!tr) return;
      const it = (kind === 'mcp' ? mcps : skills).find((x) => x.id === tr.dataset.id);
      if (e.target.closest('[data-sw]')) return kind === 'mcp' ? toggleMcp(it) : toggleSkill(it);
      if (e.target.closest('[data-more]')) return (kind === 'mcp' ? mcpMenu : skillMenu)(e.target.closest('[data-more]'), it);
      select(it.id);
    });
    tb.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]');
      if (!tr || e.target !== tr) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(tr.dataset.id); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
    });
  };
  tableEvents($('#mcp-rows'), 'mcp'); tableEvents($('#skill-rows'), 'skill');
  side.addEventListener('click', (e) => {
    const b = e.target.closest('[data-op]'); if (!b || state.tab === 'gen') return;
    if (state.tab === 'mcp') {
      const m = mcps.find((x) => x.id === state.mcp);
      ({ test: () => testConn(m), restart: () => restart(m), edit: () => editMcp(m), toggle: () => toggleMcp(m), more: () => mcpMenu(b, m) })[b.dataset.op]?.();
    } else {
      const s = skills.find((x) => x.id === state.skill);
      ({ update: () => updateSkill(s), assign: () => assignSkill(s), toggle: () => toggleSkill(s), more: () => skillMenu(b, s), approve: () => approveScript(s, +b.dataset.i) })[b.dataset.op]?.();
    }
  });
  // 标签切换由 app.js 处理显示隐藏，这里只同步右侧详情
  const syncTab = () => { const t = $('#ct-skill').getAttribute('aria-selected') === 'true' ? 'skill' : $('#ct-gen')?.getAttribute('aria-selected') === 'true' ? 'gen' : 'mcp'; if (t !== state.tab) { state.tab = t; renderSide(); } };
  $('.cap-tabs').addEventListener('click', () => setTimeout(syncTab));
  $('.cap-tabs').addEventListener('keydown', () => setTimeout(syncTab));
  $('#mcp-new').addEventListener('click', newMcp);
  $('#skill-import').addEventListener('click', importSkill);
  $('#cap-discover').addEventListener('click', (e) => {
    const b = e.target.closest('[data-disc]'); if (!b) return;
    const box = $('#cap-discover');
    if (b.dataset.disc === 'ignore') { box.remove(); return toast('已忽略 image-gen，之后不再提示；需要时可以重新扫描'); }
    modal({ title: '整合 image-gen？', body: `<dl class="d-kv"><dt>来源</dt><dd>CodeBuddy · ~/.codebuddy/mcp.json</dd><dt>启动命令</dt><dd><code class="codeline">npx -y image-gen-mcp</code></dd><dt>环境变量</dt><dd><code>IMAGE_GEN_API_KEY</code><span class="sub">整合时把值转存到凭据管理器，界面上不显示</span></dd><dt>提供给</dt><dd>全部 5 个 Agent，经工作台提供</dd></dl>`,
      actions: [{ label: '取消' }, { label: '整合', kind: 'primary', onClick() {
        mcps.push(mk({ id: 'image-gen', origin: 'CodeBuddy · ~/.codebuddy/mcp.json', cmd: 'npx', args: ['-y', 'image-gen-mcp'], env: ['IMAGE_GEN_API_KEY'], tools: ['generate_image', 'edit_image', 'upscale'] }));
        box.remove(); state.mcp = 'image-gen'; $('#ct-mcp').click(); render(); window.aicOpenSide();
        toast('已整合 image-gen，所有 Agent 都能用；CodeBuddy 自己的配置没有改动');
      } }] });
  });
  // ---------- 扫描与整合向导 ----------
  const SCAN = [
    ['claude', ['~/.claude.json（mcpServers）', '~/.claude/skills（不存在）', '~/.claude/plugins（插件市场，只列出不导入）'], '4 个 MCP · 0 个 Skill'],
    ['codex', ['~/.codex/config.toml（[mcp_servers.*]）', '~/.codex/skills'], '7 个 MCP · 12 个 Skill（3 个列入对比）'],
    ['codebuddy', ['~/.codebuddy/mcp.json', '~/.codebuddy/skills'], '6 个 MCP · 9 个 Skill'],
    ['workbuddy', ['~/.workbuddy/.mcp.json', '~/.workbuddy/skills'], '1 个 MCP · 0 个 Skill'],
    ['zcode', ['~/.zcode/cli/config.json（mcp）', '~/.zcode/skills'], '5 个 MCP · 10 个 Skill'],
    [null, ['~/.agents/skills'], '9 个 Skill'],
  ];
  // 对比矩阵：h = 有，d = 配置不同；没写的就是没有
  const MX_MCP = { blender: 'claude codex zcode', houdini: 'claude codex:d zcode:d', fxhoudini: 'zcode', renderdoc: 'claude codex', bilibili: 'claude codex codebuddy zcode',
    'video-analyzer': 'codex codebuddy zcode', node_repl: 'codex', qml_preview: 'codex', 'zai-mcp-server': 'codebuddy', 'web-search-prime': 'codebuddy', 'web-reader': 'codebuddy', zread: 'codebuddy' };
  const MX_SKILL = { ...Object.fromEntries(VIDEO.map(([n]) => [n, 'codebuddy zcode'])), '3dviz-pro-max': 'codex', 'ui-ux-pro-max': 'codex', 'eni-coldbrew': 'codex', 'fix-precedents-skill': 'zcode' };
  const cellOf = (spec, k) => { const hit = spec.split(' ').find((x) => x.split(':')[0] === k); return !hit ? 'none' : hit.endsWith(':d') ? 'diff' : 'has'; };
  const HOU = {
    codex: { file: '~/.codex/config.toml', text: 'command = "<mark>hython</mark>"\nargs = ["-m", "houdini_mcp", "--port", "<mark>18811</mark>"]' },
    zcode: { file: '~/.zcode/cli/config.json', text: '"command": "<mark>python</mark>",\n"args": ["-m", "houdini_mcp", "--port", "<mark>9876</mark>",\n         "<mark>--host</mark>", "<mark>127.0.0.1</mark>"]' },
  };
  const BACKUP_FILES = ['~/.claude.json', '~/.codex/config.toml', '~/.codebuddy/mcp.json', '~/.workbuddy/.mcp.json', '~/.zcode/cli/config.json'];
  const STEPS = ['扫描', '对比', '选择整合内容', '完成'];

  const wizard = () => {
    const w = { step: 1, scanned: false, pick: new Set([...Object.keys(MX_MCP), ...Object.keys(MX_SKILL)]), hou: null, mcpDist: 'hub', skillDist: 'link', writeback: false, timers: [] };
    const d = modal({ title: '扫描本机 Agent', wide: true, body: `<ol class="wz-steps" aria-label="步骤"></ol><div class="wz-body"></div>`, actions: [{ label: '取消' }] });
    d.classList.add('cap-wide');
    d.addEventListener('close', () => w.timers.forEach(clearTimeout));
    const body = $('.wz-body', d), foot = $('.dlg-foot', d);
    const btn = (label, kind, fn, dis) => { const b = document.createElement('button'); b.className = 'btn ' + (kind || ''); b.textContent = label; b.dataset.wired = '1'; b.disabled = !!dis; b.addEventListener('click', fn); foot.appendChild(b); return b; };
    const go = (n) => { w.step = n; paint(); $('.dlg-body', d).scrollTop = 0; };
    const picked = (list) => list.filter((n) => w.pick.has(n));
    const counts = () => {
      const m = picked(Object.keys(MX_MCP)).length, s = picked(Object.keys(MX_SKILL)).length;
      return { m, s, dup: picked(VIDEO.map(([n]) => n)).length * 2 };
    };
    const cell = (kind, name) => kind === 'has' ? `<span class="cell has">${ic('check')}有</span>`
      : kind === 'none' ? '<span class="cell none" aria-label="没有">— 没有</span>'
      : `<button class="cell diff" data-wired="1" data-hou aria-label="${name} 配置不同，点击对比并选择">${ic('warn')}配置不同</button>`;
    const matrix = () => {
      const row = (n, spec, note) => `<tr><th scope="row">${esc(n)}${note ? `<span class="sub">${note}</span>` : ''}</th>${AGK.map((k) => `<td>${cell(cellOf(spec, k), n)}</td>`).join('')}</tr>`;
      const houNote = w.hou ? `已选用 ${agName(w.hou)} 的配置` : 'Codex 和 ZCode 的启动参数不一样，点格子对比';
      return `<div class="legend"><span class="cell has">${ic('check')}有</span><span class="cell none">— 没有</span><span class="cell diff">${ic('warn')}配置不同</span><span class="sub" style="display:inline">同名但配置不同的，点开并排比较后选用一份</span></div>
        <div class="matrix-wrap" tabindex="0" aria-label="对比矩阵"><table class="matrix"><thead><tr><th scope="col">名称</th>${AGK.map((k) => `<th scope="col">${agName(k)}</th>`).join('')}</tr></thead><tbody>
        <tr class="grp"><th colspan="6" scope="rowgroup">MCP（12）</th></tr>
        ${Object.entries(MX_MCP).map(([n, s]) => row(n, s, n === 'houdini' ? houNote : n === 'bilibili' ? '4 处都有，配置相同' : '')).join('')}
        <tr><th scope="row">connector-proxy<span class="sub">WorkBuddy 自带的连接器代理，不纳入整合</span></th>${AGK.map((k) => `<td>${cell(k === 'workbuddy' ? 'has' : 'none')}</td>`).join('')}</tr>
        <tr class="grp"><th colspan="6" scope="rowgroup">Skill（13）</th></tr>
        ${Object.entries(MX_SKILL).map(([n, s]) => row(n, s, VIDEO.some(([v]) => v === n) ? '3 处重复副本（~/.codebuddy、~/.agents、~/.zcode），整合后统一成 1 份' : '')).join('')}
        </tbody></table></div>`;
    };
    const houDiff = () => modal({ title: 'houdini：选用哪一份配置', wide: true,
      body: `<p>Codex 和 ZCode 里都配置了 houdini，启动参数不一样（标出的部分）。整合后只保留一份，由工作台启动一个 houdini 进程给所有 Agent 用。</p>
        <div class="diffcols" role="radiogroup" aria-label="选用哪一份">${['codex', 'zcode'].map((k) => `<label class="diffcol"><span style="display:flex;gap:6px;align-items:center;color:var(--fg-1)"><input type="radio" name="hou" value="${k}" ${(w.hou || 'codex') === k ? 'checked' : ''}><span class="ag ${k}" aria-hidden="true">${AG[k][1]}</span><b>${agName(k)}</b><span class="sub" style="display:inline">${HOU[k].file}</span></span><pre>${HOU[k].text}</pre></label>`).join('')}</div>
        <p class="note">Claude Code 里的 houdini 和 Codex 的一样。没选用的那份不会被删除，仍留在原来的配置文件里。</p>`,
      actions: [{ label: '取消' }, { label: '选用这一份', kind: 'primary', onClick(dd) { w.hou = $('input[name="hou"]:checked', dd).value; paint(); toast(`houdini 将选用 ${agName(w.hou)} 的配置`); } }] });
    const pickList = (names, extra) => `<div class="picklist">${names.map((n) => `<label><input type="checkbox" data-pick="${esc(n)}" ${w.pick.has(n) ? 'checked' : ''}><code>${esc(n)}</code>${extra(n)}</label>`).join('')}</div>`;
    const writebackBox = () => (w.writeback || w.mcpDist === 'sync') ? `<div class="alert attn" style="margin:0 0 var(--sp-3)">${ic('warn')}<div class="body"><strong>会修改下面这些文件，修改前先备份</strong>
        <p>备份放在 %APPDATA%\\AI_Console\\backups，可以一键还原。格式不认识的文件只读不写。</p><ul class="wbfiles">${BACKUP_FILES.map((f) => `<li>${f}</li>`).join('')}<li>~/.claude/skills、~/.codex/skills、~/.zcode/skills（新建目录联接）</li></ul></div></div>` : '';
    const steps = {
      1() {
        body.innerHTML = `<p>${ic('lock')} 只读取名称、命令和变量名，不读取密钥的值。</p><ul class="scanlist">${SCAN.map(([k, locs], i) => `<li data-i="${i}"><div class="sh">${k ? `<span class="ag ${k}" aria-hidden="true">${AG[k][1]}</span>${agName(k)}` : `${ic('folder')}跨厂商公共目录`}<span class="grow"></span><span class="status idle" data-st><span class="dot"></span>等待</span></div><ul>${locs.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></li>`).join('')}</ul>`;
        if (w.scanned) { $$('[data-st]', body).forEach((s, i) => { s.className = 'status ok'; s.innerHTML = `<span class="dot"></span>已读取：${SCAN[i][2]}`; }); return; }
        SCAN.forEach((r, i) => {
          w.timers.push(later(450 * i + 150, () => { const s = $(`[data-i="${i}"] [data-st]`, body); if (s) { s.className = 'status run'; s.innerHTML = '<span class="dot"></span>读取中'; } }));
          w.timers.push(later(450 * i + 520, () => {
            const s = $(`[data-i="${i}"] [data-st]`, body); if (s) { s.className = 'status ok'; s.innerHTML = `<span class="dot"></span>已读取：${r[2]}`; }
            if (i === SCAN.length - 1) { w.scanned = true; paint(); }
          }));
        });
      },
      2() { body.innerHTML = matrix(); },
      3() {
        const c = counts();
        body.innerHTML = `<h3 class="dlg-sec">MCP <span class="sub" style="display:inline">已选 ${c.m} / 12</span><span class="grow" style="flex:1"></span><button class="btn sm ghost" data-wired="1" data-all="mcp">${c.m === 12 ? '全不选' : '全选'}</button></h3>
          ${pickList(Object.keys(MX_MCP), (n) => n === 'houdini' ? `<span class="sub">${w.hou ? `用 ${agName(w.hou)} 的` : '还没选，默认用 Codex 的'}</span>` : ['blender', 'houdini', 'renderdoc'].includes(n) ? '<span class="sub">独占</span>' : '')}
          <div class="form-row"><span class="lbl" id="wz-md-l">分发方式</span><div class="radios" role="radiogroup" aria-labelledby="wz-md-l"><label><input type="radio" name="wz-md" value="hub" ${w.mcpDist === 'hub' ? 'checked' : ''}>经工作台提供（推荐，不改各 Agent 的配置）</label><label><input type="radio" name="wz-md" value="sync" ${w.mcpDist === 'sync' ? 'checked' : ''}>原样同步到各 Agent 的配置</label></div></div>
          <h3 class="dlg-sec">Skill <span class="sub" style="display:inline">已选 ${c.s} / 13</span><span class="grow" style="flex:1"></span><button class="btn sm ghost" data-wired="1" data-all="skill">${c.s === 13 ? '全不选' : '全选'}</button></h3>
          ${pickList(Object.keys(MX_SKILL), (n) => VIDEO.some(([v]) => v === n) ? '<span class="sub">3 份 → 1 份</span>' : '')}
          <div class="form-row"><span class="lbl" id="wz-sd-l">分发方式</span><div class="radios" role="radiogroup" aria-labelledby="wz-sd-l"><label><input type="radio" name="wz-sd" value="link" ${w.skillDist === 'link' ? 'checked' : ''}>链接（推荐，改一处所有 Agent 生效）</label><label><input type="radio" name="wz-sd" value="copy" ${w.skillDist === 'copy' ? 'checked' : ''}>复制</label></div></div>
          <label class="check-row"><input type="checkbox" id="wz-wb" ${w.writeback ? 'checked' : ''}> <span>同时写回各 Agent 的原生配置<small>让它们在工作台之外直接打开时也能用整合后的清单。默认不写。</small></span></label>
          ${writebackBox()}`;
      },
      4() {
        const c = counts();
        body.innerHTML = `<p class="result-big">${ic('check')} 整合了 ${c.m} 个 MCP、${c.s} 个 Skill，去掉了 ${c.dup} 份重复副本。</p>
          <ul class="steps"><li>MCP：${w.mcpDist === 'hub' ? '经工作台提供，每个服务器只启动一份' : '已原样同步到各 Agent 的配置'}${picked(['houdini']).length ? `；houdini 用 ${agName(w.hou || 'codex')} 的配置` : ''}</li>
          <li>密钥：${picked(Object.keys(MX_MCP)).filter((n) => mcps.find((m) => m.id === n)?.env.length).length} 个 MCP 的环境变量值已转存到 Windows 凭据管理器</li>
          <li>Skill：已放进统一库，${w.skillDist === 'link' ? '在各 Agent 的目录里建了目录联接' : '复制到各 Agent 的目录并记录哈希'}；WorkBuddy 通过 skills_list / skills_read 工具使用</li>
          <li>${w.writeback || w.mcpDist === 'sync' ? `已写回 ${BACKUP_FILES.length} 个配置文件，原文件已备份` : '没有改动各 Agent 的配置文件'}</li></ul>
          <p class="note">各 Agent 自己的配置都保留，在工作台之外打开照常可用。</p>`;
      },
    };
    const paint = () => {
      $('.wz-steps', d).innerHTML = STEPS.map((t, i) => `<li ${i + 1 === w.step ? 'aria-current="step"' : ''} class="${i + 1 < w.step ? 'done' : ''}"><span class="n">${i + 1 < w.step ? '✓' : i + 1}</span>${t}</li>`).join('');
      steps[w.step]();
      foot.innerHTML = '';
      if (w.step === 4) {
        btn('撤销本次整合', 'danger', () => modal({ title: '撤销本次整合？', body: '<p>恢复到整合前：移除这次导入的条目和目录联接，删掉的重复副本从备份恢复；写回过的配置文件用备份还原。</p>',
          actions: [{ label: '取消' }, { label: '撤销', kind: 'danger', onClick() { state.last = '刚刚撤销，已恢复到整合前'; render(); d.close(); toast('已撤销本次整合，所有文件恢复到整合前'); } }] }));
        btn('完成', 'primary', () => d.close());
        return;
      }
      btn('取消', '', () => d.close());
      if (w.step > 1) btn('上一步', '', () => go(w.step - 1));
      if (w.step === 3) {
        const c = counts();
        btn('开始整合', 'primary', (e) => {
          const b = e.currentTarget; b.setAttribute('aria-busy', 'true'); b.textContent = '正在整合…';
          w.timers.push(later(1100, () => {
            if (w.pick.has('houdini') && w.hou === 'zcode') { const h = mcps.find((m) => m.id === 'houdini'); if (h) { h.cmd = 'python'; h.args = ['-m', 'houdini_mcp', '--port', '9876', '--host', '127.0.0.1']; } }
            state.last = `刚刚（${counts().m} 个 MCP、${counts().s} 个 Skill）`; render(); go(4);
          }));
        }, !(c.m + c.s));
      } else btn(w.step === 1 && !w.scanned ? '正在扫描…' : '下一步', 'primary', () => go(w.step + 1), w.step === 1 && !w.scanned);
      foot.lastElementChild.focus();
    };
    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-hou]')) return houDiff();
      const all = e.target.closest('[data-all]');
      if (all) {
        const names = Object.keys(all.dataset.all === 'mcp' ? MX_MCP : MX_SKILL);
        const every = names.every((n) => w.pick.has(n));
        names.forEach((n) => (every ? w.pick.delete(n) : w.pick.add(n))); paint();
      }
    });
    d.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.pick) { if (t.checked) w.pick.add(t.dataset.pick); else w.pick.delete(t.dataset.pick); }
      else if (t.name === 'wz-md') w.mcpDist = t.value;
      else if (t.name === 'wz-sd') w.skillDist = t.value;
      else if (t.id === 'wz-wb') w.writeback = t.checked;
      else return;
      const y = $('.dlg-body', d).scrollTop; const id = t.dataset.pick ? `[data-pick="${t.dataset.pick}"]` : t.id ? `#${t.id}` : `input[name="${t.name}"][value="${t.value}"]`;
      paint(); $('.dlg-body', d).scrollTop = y; $(id, d)?.focus();
    });
    paint();
  };
  $('#cap-scan').addEventListener('click', wizard);

  render();
  window.aicCapabilities = { mcps, skills };

})();
