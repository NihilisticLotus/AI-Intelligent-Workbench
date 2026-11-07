// 侧边聊天（design.md 第 26 节）：右侧面板“侧聊”标签。只做原型演示，不代表正式实现。
// 依赖 app.js、interact.js 先运行（图标、aicStreamReply、aicModal、aicMenu、aicToast、aicCur、aicNewTask）。
(function () {
  const panel = document.getElementById('p-side');
  const tab = document.getElementById('t-side');
  if (!panel || !tab) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicModal: modal, aicEsc: esc, aicAgents: agents, aicHhmm: hhmm } = window;
  const ic = (n, c) => window.icon(n, c);
  const page = document.body.dataset.page;
  const SB = window.aicSB;

  // 同一家的模型，第一个是默认的便宜模型；和主会话同一家时上下文能命中提示缓存
  const cheap = { claude: ['Haiku 5.5', 'Sonnet 5', 'Opus 5.5'], codex: ['gpt-5.5-codex-mini', 'gpt-5.5-codex'], codebuddy: ['deepseek-v3-2', 'glm-5.1', 'kimi-k2.5'], zcode: ['glm-5.1'] };
  const modes = { quick: '快速提问', investigate: '侧边调查' };

  // ---------- 示例内容：随页面上的示例任务变化 ----------
  const T = (verb, target, end, out) => ({ verb, target, end, out });
  const D = page === 'assets' ? {
    ctx: { quick: '基于完整转写 H2 · 约 5k token', investigate: '只读会话，首条消息是完整转写 H2 · 约 5k token' },
    base: ['三角面 1000 以内', '材质名 M_Chest_Wood、M_Chest_Iron 不能改'],
    examples: { quick: ['为什么材质名不能改？', 'LOD1 用什么方法减面？', '哪些预制体用了 M_Chest_Iron？'], investigate: ['哪些预制体用了 M_Chest_Iron？', 'LOD1 用什么方法减面？'] },
    answers: [
      { re: /预制体|哪些|引用|用了/, quick: { thought: '交接内容里只记了“Unity 已绑定材质”，没有列出具体是哪些预制体。快速提问不能搜索项目，只能如实说明。', html: '<p>快速提问不读文件，只能按会话记录回答：记录里只写了“材质名在 Unity 里已经绑定”，没有列出具体是哪些预制体。</p><p>要列全，需要在项目里搜索。</p><p><button class="btn sm" data-sc-upgrade>改为侧边调查</button></p>' },
        inv: { tools: [T('搜索', '"M_Chest_Iron" 于 Assets', '5 处匹配', 'Assets/Prefabs/Props/Chest.prefab\nAssets/Prefabs/Props/Chest_Gold.prefab\nAssets/Prefabs/Props/Chest_Mimic.prefab\nAssets/Art/Props/Chest/chest.glb.meta\nAssets/Scenes/Harbor.unity'), T('读取', 'scripts/chest_rework.py', '96 行', '第 12–20 行：只替换网格数据，材质槽按名字保留'), T('查询', 'aic_history search "材质"', '2 条记录', 'seq 7712  你：材质名不要改，Unity 里已经绑了\nseq 7740  CodeBuddy：导出时保留材质槽顺序')],
          thought: '5 处匹配里 3 个是预制体，1 个是场景，1 个是导入设置。脚本只换网格，材质槽按名字保留，引用不会断。', html: '<p>结论：3 个预制体和 1 个场景用了 <code>M_Chest_Iron</code>：<code>Chest</code>、<code>Chest_Gold</code>、<code>Chest_Mimic</code> 和 <code>Harbor</code> 场景。</p><p><code>chest_rework.py</code> 只替换网格、按名字保留材质槽，这次改动不会断开这些引用。</p>', rule: '改宝箱模型时不动材质槽：Chest、Chest_Gold、Chest_Mimic 三个预制体都按名字引用材质' } },
      { re: /材质/, quick: { thought: '这是第一条消息里的约束，记录原样保留。原因是 Unity 预制体按材质名绑定。', html: '<p>因为 Unity 里的预制体是按材质名绑定的：<code>M_Chest_Wood</code>、<code>M_Chest_Iron</code> 一改名，重新导入后宝箱会变成缺材质的粉色，场景里的宝箱都要重新指定材质。</p><p class="sc-src">依据：你的第一条消息（约束原样保留在会话记录里）</p>', rule: '模型改动只动网格，不改材质名和材质槽顺序' } },
      { re: /LOD|减面|面数|三角/i, quick: { thought: '记录里的思考过程提到了 Decimate collapse 模式和保留 UV 接缝。当前面数 404。', html: '<p>LOD1 用 Blender 的 Decimate（collapse 模式），目标约为当前 404 个三角面的一半，勾选保留 UV 接缝，避免贴图错位。</p><p class="sc-src">依据：会话记录里 CodeBuddy 的计划和思考过程</p>', rule: 'LOD1 用 Decimate collapse 模式减到约 50%，保留 UV 接缝' },
        inv: { tools: [T('读取', 'scripts/chest_rework.py', '96 行', '第 61–78 行：make_lod(ratio=0.5, mode="COLLAPSE", use_symmetry=False)'), T('搜索', '"LODGroup" 于 Assets/Prefabs/Props', '3 处匹配', 'Chest.prefab  LOD0 60%  LOD1 25%  剔除 5%'), T('查询', 'aic_history search "LOD"', '3 条记录', 'seq 7802  CodeBuddy：接下来生成 LOD1，目标是当前面数的 50%')],
          thought: '脚本里已经写好 make_lod，比例 0.5，collapse 模式。预制体的 LODGroup 阈值已经配好，生成后直接替换即可。', html: '<p>结论：<code>chest_rework.py</code> 里已经有 <code>make_lod(ratio=0.5, mode="COLLAPSE")</code>，生成约 200 个三角面。<code>Chest.prefab</code> 的 LODGroup 已配好切换阈值（LOD1 在 25%），生成后不用改预制体。</p>', rule: 'LOD1 用 Decimate collapse 模式减到约 50%，保留 UV 接缝' } },
    ],
    fallback: (q) => ({ thought: '记录里没有直接回答这个问题的内容，按任务目标和当前状态给出大致判断。', html: `<p>按会话记录回答“${esc(q)}”：这个任务在把 chest.glb 改圆、加铁箍和拉环，当前 404 个三角面，下一步生成 LOD1。记录里没有直接提到你问的内容，需要看文件时可以改为侧边调查。</p><p class="sc-src">原型示例回答</p>` }),
    invFallback: { tools: [T('读取', 'scripts/chest_rework.py', '96 行', '只读，未修改'), T('搜索', '"chest" 于 Assets/Art/Props', '7 处匹配', 'Assets/Art/Props/Chest/chest.glb …'), T('查询', 'aic_history search', '4 条记录', '最近 4 条相关事件')], thought: '查了脚本、资产目录和历史记录。', html: '<p>查了 <code>chest_rework.py</code>、资产目录和历史记录，没有发现和你的问题冲突的地方。（原型示例结论）</p>' },
  } : {
    ctx: { quick: '基于交接内容 H3 · 约 8k token', investigate: '只读会话，首条消息是交接内容 H3 · 约 8k token' },
    base: ['不改存档格式，老存档必须能读'],
    examples: { quick: ['为什么不用文件锁？', 'File.Replace 在 Steam Deck 上可靠吗？', '项目里还有哪些地方这样写？'], investigate: ['项目里还有哪些地方直接覆盖写文件？', '为什么不用文件锁？'] },
    answers: [
      { re: /文件锁|加锁|锁/, quick: { thought: '交接内容“关键决策与原因”里有一条：不加文件锁，Steam 云同步进程不认我们的锁。“试过的方案”里也记了加锁被放弃。直接按这两处回答，不用读文件。', html: '<p>因为 Steam 云同步进程不认我们的锁。上传是 Steam 客户端在游戏退出后自己读存档目录，我们在游戏进程里加的锁拦不住它，它照样可能读到写了一半的文件。</p><p>所以改成“临时文件 → 落盘 → 原子替换”：磁盘上的存档任何时刻要么是完整的旧版，要么是完整的新版，谁来读都不会读到半截。</p><p class="sc-src">依据：交接内容 · 关键决策与原因、试过的方案</p>', rule: '不用文件锁防云同步读到半截存档（Steam 云同步进程不认我们的锁），统一用原子替换' },
        inv: { tools: [T('查询', 'aic_history search "文件锁"', '2 条记录', 'seq 10102  CodeBuddy：考虑在 Save 期间用 FileShare.None 加锁\nseq 10131  CodeBuddy：放弃加锁，Steam 客户端进程不受游戏内的锁约束'), T('读取', 'Assets/Scripts/Platform/SteamCloudSync.cs', '74 行', '关键位置：第 27–33 行 OnApplicationQuit()，退出时调用 UploadSaves()'), T('搜索', '"FileShare" 于 Assets/Scripts', '0 处匹配', '没有找到 FileShare 的用法')],
          thought: '历史记录里 seq 10131 放弃了加锁。代码里没有 FileShare。SteamCloudSync 退出时上传，工作副本里已改为先等写入完成。', html: '<p>结论：不用文件锁是对的。记录里 CodeBuddy 在 seq 10131 放弃了加锁，原因是 Steam 客户端是独立进程，游戏里用 <code>FileShare.None</code> 锁不住它；代码里也没有任何 <code>FileShare</code> 用法。</p><p><code>SteamCloudSync.OnApplicationQuit()</code> 退出时会上传，工作副本里已改成先等写入完成，和原子替换配合可以避开半截文件。</p>', rule: '不用文件锁防云同步读到半截存档（Steam 云同步进程不认我们的锁），统一用原子替换' } },
      { re: /其他|还有哪些|别的地方|哪些地方|这样写/, quick: { thought: '交接内容只记了 SaveManager.cs 的改动，最早那次搜索有 4 处匹配，另外 3 处没有细节。快速提问不能读文件。', html: '<p>快速提问不读文件，只能按交接内容回答：最早搜索 <code>WriteAllText</code> 时有 4 处匹配，交接内容里只处理了 <code>SaveManager.cs</code>，另外 3 处没有记录细节。</p><p>要确认另外 3 处有没有同样的风险，需要看代码。</p><p><button class="btn sm" data-sc-upgrade>改为侧边调查</button></p>' },
        inv: { tools: [T('搜索', '"File.WriteAllText" 于 Assets', '4 处匹配', 'Assets/Scripts/Save/SaveManager.cs:44        File.WriteAllText(SavePath, json);（工作副本里已替换）\nAssets/Scripts/Save/SettingsStore.cs:31      File.WriteAllText(path, text);\nAssets/Editor/BuildReport.cs:88              File.WriteAllText(reportPath, html);\nAssets/Scripts/Debug/LogDump.cs:19           File.WriteAllText(dumpPath, log);'), T('读取', 'Assets/Scripts/Save/SettingsStore.cs', '58 行', '第 12 行：path = Path.Combine(Application.persistentDataPath, "settings.json")（在云同步目录里）'), T('读取', 'Assets/Scripts/Save/SaveManager.cs', '186 行', '第 51–55 行 ReplaceAtomically() 可以复用'), T('查询', 'aic_history get_events 10021..10060', '6 条', '最早那次搜索的结果和现在一致；另外 3 处没有讨论过')],
          thought: 'SettingsStore 的文件也在 persistentDataPath 下，会被云同步上传，风险和存档一样。BuildReport 是编辑器工具，LogDump 是调试日志，都不进云同步。', html: '<p>还有 3 处直接覆盖写，只有 1 处需要处理：</p><ul><li><code>SettingsStore.cs:31</code>：设置文件也在云同步目录里，同样可能被同步成空文件。<b>建议同样改成原子替换</b>，可以复用 <code>ReplaceAtomically</code>。</li><li><code>BuildReport.cs:88</code>：编辑器工具，不进游戏包，不用改。</li><li><code>LogDump.cs:19</code>：调试日志，写坏了不影响存档，不用改。</li></ul><p>SettingsStore 不在当前任务范围里，适合单独开一个任务。</p>', rule: '云同步目录里的所有文件写入都用原子替换（SettingsStore.cs 同样适用）' } },
      { re: /File\.?Replace|原子|Steam ?Deck|Proton|可靠/i, quick: { thought: '交接内容里有 File.Replace 同盘原子、留 .bak 的判断，思考过程提到 Proton 下 Wine 支持这个调用。没验证过实机。', html: '<p>按交接内容判断是可靠的：<code>File.Replace</code> 在同一磁盘上是原子操作，还会顺带留一份 <code>.bak</code>。Steam Deck 上游戏跑在 Proton 里，Wine 也实现了这个调用。</p><p>还没验证的是实机表现：EditMode 测试在 Windows 上跑，覆盖不到 Proton。合并前最好在 Steam Deck 上手动退出几次游戏看看存档。</p><p class="sc-src">依据：交接内容 · 关键决策与原因</p>', rule: '存档替换用 File.Replace（同盘原子替换），临时文件和存档放在同一目录' },
        inv: { tools: [T('读取', 'Assets/Scripts/Save/SaveManager.cs', '186 行', '第 51–55 行 ReplaceAtomically：目标存在时 File.Replace，否则 File.Move'), T('搜索', '"SavePath" 于 Assets/Scripts', '6 处匹配', 'SavePath = Path.Combine(Application.persistentDataPath, "save.json")；tmp 和存档在同一目录'), T('查询', 'aic_history search "Proton"', '1 条记录', 'seq 10187  Claude Code（思考）：Proton/Wine 支持 ReplaceFileW')],
          thought: '临时文件和目标在同一目录，File.Replace 同盘原子。第一次存档走 File.Move，也是原子的。', html: '<p>结论：可靠。临时文件 <code>save.json.tmp</code> 和存档在同一个目录，<code>File.Replace</code> 是同盘替换，属于原子操作；第一次存档目标不存在时走 <code>File.Move</code>，也是原子的。</p><p>唯一没覆盖的是 Proton 下的实机表现，建议合并前在 Steam Deck 上手动验证一次。</p>', rule: '存档替换用 File.Replace（同盘原子替换），临时文件和存档放在同一目录' } },
      { re: /bak|回退|备份/i, quick: { thought: '交接内容“当前状态”写了读取失败回退 .bak。.bak 来自 File.Replace。', html: '<p>读取时先解析主存档，解析失败（空文件或 JSON 不完整）就读 <code>.bak</code>。<code>.bak</code> 是 <code>File.Replace</code> 替换时自动留下的上一版，所以最坏情况是丢最后一次存档，不会从头开始。</p><p class="sc-src">依据：交接内容 · 当前状态</p>', rule: '主存档解析失败时必须回退到 .bak，不能直接新建空存档' } },
      { re: /WriteAllText|截断|空文件|覆盖/, quick: { thought: '交接内容和 CodeBuddy 的结论：WriteAllText 先把文件截断成 0 字节再写。', html: '<p><code>File.WriteAllText</code> 会先把原文件截断成 0 字节再写入。云同步恰好在这几十毫秒里读文件，读到的就是空文件，上传后玩家下次打开就是空存档。日志里两条时间戳只差 40 毫秒。</p><p class="sc-src">依据：交接内容 · 最近对话</p>' } },
    ],
    fallback: (q) => ({ thought: '交接内容里没有直接回答这个问题的条目，按任务目标和当前状态给出大致判断。', html: `<p>按交接内容回答“${esc(q)}”：这个任务在修复 Steam Deck 退出后存档偶发变空，写入已改成原子替换、读取失败回退 .bak，现在等审批跑 EditMode 测试。交接内容里没有直接提到你问的内容，需要看代码时可以改为侧边调查。</p><p class="sc-src">原型示例回答</p>` }),
    invFallback: { tools: [T('搜索', '"File.WriteAllText" 于 Assets', '4 处匹配', '见上一次搜索结果'), T('读取', 'Assets/Scripts/Save/SaveManager.cs', '186 行', '只读，未修改'), T('查询', 'aic_history search', '3 条记录', '最近 3 条相关事件')], thought: '查了 SaveManager.cs 和历史记录。', html: '<p>查了 <code>SaveManager.cs</code> 和历史记录，没有发现和你的问题冲突的地方。（原型示例结论）</p>' },
  };
  const pick = (q, quote) => D.answers.find((a) => a.re.test(q + ' ' + (quote || '')));

  // ---------- 状态 ----------
  const threads = [];
  let active = null, quote = '', seq = 0, mseq = 0;
  const msgs = {};                                    // 回答编号 → { q, rule, el }
  const constraints = window.aicTaskConstraints = [];

  panel.innerHTML = `<div class="sc-top">
      <div class="sc-list-head"><span class="sc-h">本任务的侧聊</span><span class="grow"></span><button class="btn sm" data-sc-new>${ic('plus')}新建侧聊</button></div>
      <ul class="sc-list" aria-label="侧聊列表"></ul>
    </div>
    <div class="sc-meta"></div>
    <div class="sc-streams"></div>
    <div class="sc-compose" hidden>
      <div class="sc-quote" hidden><span class="sc-quote-t"></span><button class="btn ghost icon xs" data-sc-unquote aria-label="去掉引用" title="去掉引用">${ic('x')}</button></div>
      <div class="compose-box">
        <label for="sc-input" class="sr-only">在侧聊里提问</label>
        <textarea id="sc-input" rows="2" placeholder="问个问题，不打断主 Agent。Enter 发送，Shift+Enter 换行"></textarea>
        <div class="compose-bar"><span class="sc-hint">Ctrl+/ 回到主输入框</span><span class="grow"></span><button class="btn primary sm" data-sc-send>${ic('send')}提问</button></div>
      </div>
    </div>
    <div class="sr-only" aria-live="polite" id="sc-live"></div>`;
  const list = $('.sc-list', panel), meta = $('.sc-meta', panel), streams = $('.sc-streams', panel);
  const compose = $('.sc-compose', panel), input = $('#sc-input'), sendBtn = $('[data-sc-send]', panel);
  const live = (t) => { $('#sc-live').textContent = t; };

  const paintTab = () => {
    const running = threads.some((t) => t.running);
    tab.innerHTML = `侧聊${threads.length ? ` <span class="count">${threads.length}</span>` : ''}${running ? ' <span class="status run sc-run"><span class="dot"></span>调查中</span>' : ''}`;
    tab.setAttribute('aria-label', `侧聊${threads.length ? `，${threads.length} 个` : ''}${running ? '，侧边调查进行中' : ''}`);
  };
  const paintList = () => {
    list.innerHTML = threads.map((t) => `<li><button class="sc-item" data-sc-pick="${t.id}" ${t === active ? 'aria-current="true"' : ''}>
        ${ic(t.mode === 'quick' ? 'sidechat' : 'search')}<span class="t">${esc(t.title)}</span><span class="sc-tag">${modes[t.mode]}</span>${t.running ? '<span class="status run"><span class="dot"></span>调查中</span>' : ''}</button>
      <button class="btn ghost icon xs" data-sc-del="${t.id}" aria-label="删除侧聊“${esc(t.title)}”" title="删除">${ic('trash')}</button></li>`).join('');
    list.hidden = !threads.length;
  };
  const paintMeta = () => {
    compose.hidden = !active;
    if (!active) { meta.innerHTML = ''; return; }
    const t = active, models = cheap[t.agent];
    meta.innerHTML = `<dl class="kv sc-kv">
        <dt>模式</dt><dd class="sc-mode"><b>${modes[t.mode]}</b><span>${t.mode === 'quick' ? '只回答，不读文件' : '可以读文件、搜索、查历史'}</span>${t.mode === 'quick' ? '<button class="btn sm ghost" data-sc-upgrade>改为侧边调查</button>' : ''}</dd>
        <dt><label for="sc-model">模型</label></dt><dd><select class="select sc-model" id="sc-model">${models.map((m, i) => `<option value="${esc(m)}" ${m === t.model ? 'selected' : ''}>${agents[t.agent][0]} · ${esc(m)}${i === 0 ? '（便宜，默认）' : ''}</option>`).join('')}</select></dd>
        <dt>上下文</dt><dd>${esc(D.ctx[t.mode])}</dd>
        ${t.tokens ? `<dt>用量</dt><dd>约 ${(t.tokens / 1000).toFixed(1)}k token，上下文命中提示缓存；计入调用统计（来源：侧聊）</dd>` : ''}
      </dl>
      ${t.mode === 'investigate' ? `<p class="sc-ro">${ic('lock')}<span><b>只读：不会修改文件</b>，也不执行有副作用的命令。读取都在工作副本内，不会触发审批。</span></p>` : ''}
      <p class="sc-note">${ic('info')}<span>主 Agent 看不到这里的内容，主对话照常进行。要带回去，用回答下面的按钮。</span></p>`;
  };
  const paintCompose = () => {
    const busy = active && active.busy;
    sendBtn.setAttribute('aria-busy', String(!!busy));
    sendBtn.innerHTML = busy ? '回答中' : `${ic('send')}提问`;
    const qb = $('.sc-quote', panel);
    qb.hidden = !quote;
    $('.sc-quote-t', qb).innerHTML = quote ? `${ic('quote')}<span>引用：${esc(quote.length > 80 ? quote.slice(0, 80) + '…' : quote)}</span>` : '';
  };
  const examplesHtml = (t) => `<div class="sc-ex"><p>可以这样问：</p>${D.examples[t.mode].map((q) => `<button class="sc-exq" data-sc-ex="${esc(q)}">${esc(q)}</button>`).join('')}</div>`;
  const paintEmpty = () => {
    $('.sc-empty', streams)?.remove();
    if (threads.length) return;
    streams.insertAdjacentHTML('beforeend', `<div class="empty sc-empty"><h3>还没有侧聊</h3><p>临时问个问题，主 Agent 照常干活，问答也不进主对话。</p><button class="btn" data-sc-new>${ic('plus')}新建侧聊</button></div>`);
  };
  const paint = () => {
    threads.forEach((t) => { t.el.hidden = t !== active; });
    paintTab(); paintList(); paintMeta(); paintCompose(); paintEmpty();
  };

  const create = (mode = 'quick') => {
    const agent = window.aicCur?.agent || 'claude';
    const t = { id: 's' + ++seq, title: '新侧聊', mode, agent, model: cheap[agent][0], tokens: 0, busy: false, running: false, rounds: 0 };
    t.el = document.createElement('div');
    t.el.className = 'sc-stream';
    t.el.tabIndex = 0;
    t.el.setAttribute('aria-label', '侧聊记录');
    t.el.innerHTML = examplesHtml(t);
    streams.appendChild(t.el);
    threads.push(t); active = t; paint();
    return t;
  };
  const select = (t) => { active = t; paint(); };
  const remove = (t) => modal({
    title: `删除侧聊“${esc(t.title)}”？`,
    body: `<p>删除这段侧聊记录${t.running ? '，并停止正在进行的侧边调查' : ''}。已经带回主对话、约束或新任务的内容不受影响。</p>`,
    actions: [{ label: '取消' }, { label: '删除', kind: 'danger', onClick() {
      const i = threads.indexOf(t); threads.splice(i, 1); t.el.remove(); t.dead = true;
      if (active === t) active = threads[Math.min(i, threads.length - 1)] || null;
      paint(); toast(`已删除侧聊“${esc(t.title)}”`);
      setTimeout(() => (active ? input : $('[data-sc-new]', panel))?.focus());
    } }],
  });
  const note = (t, text) => { t.el.insertAdjacentHTML('beforeend', `<div class="sysnote" role="note"><span>${text}</span></div>`); t.el.scrollTop = t.el.scrollHeight; };
  const upgrade = (t) => {
    if (t.mode === 'investigate') return;
    t.mode = 'investigate';
    $('.sc-ex', t.el)?.remove();
    note(t, `${ic('search')}已改为侧边调查：另开只读会话，已有的 ${t.rounds} 轮问答一并带过去`);
    if (!t.rounds) t.el.insertAdjacentHTML('beforeend', examplesHtml(t));
    $$('[data-sc-upgrade]', t.el).forEach((b) => { b.disabled = true; b.textContent = '已改为侧边调查'; });
    paint(); toast('已改为侧边调查，只读，不会修改文件'); input.focus();
  };

  // ---------- 提问与回答 ----------
  const carryBar = (id) => `<div class="sc-carry" role="group" aria-label="把这条回答带回">
      <button class="btn sm ghost" data-carry="main" data-mid="${id}">${ic('reply')}发给主 Agent</button>
      <button class="btn sm ghost" data-carry="constraint" data-mid="${id}">${ic('pin')}记为约束</button>
      <button class="btn sm ghost" data-carry="task" data-mid="${id}">${ic('plus')}新建任务</button></div>`;
  const ask = (text) => {
    const t = active; if (!t || t.busy) return;
    const q = text.trim(); if (!q) { input.focus(); return; }
    const qt = quote; quote = '';
    $('.sc-ex', t.el)?.remove();
    if (t.title === '新侧聊') t.title = q.length > 18 ? q.slice(0, 18) + '…' : q;
    t.el.insertAdjacentHTML('beforeend', `<article class="msg user"><div class="who"><span class="me">黄</span></div><div>
      <div class="head"><b>你</b><span>${hhmm()}</span></div><div class="text">${qt ? `<blockquote class="sc-bq">${esc(qt)}</blockquote>` : ''}<p>${esc(q)}</p></div></div></article>`);
    t.el.scrollTop = t.el.scrollHeight;
    t.busy = true; input.value = '';
    const a = pick(q, qt);
    const mode = t.mode;
    const ans = mode === 'quick' ? (a?.quick || D.fallback(q)) : (a?.inv || a?.quick && { tools: D.invFallback.tools, ...a.quick } || D.invFallback);
    if (mode === 'investigate') t.running = true;
    paint();
    const id = 'm' + ++mseq;
    const reply = () => window.aicStreamReply(t.agent, t.model, ans.thought, ans.html + carryBar(id), (el) => {
      msgs[id] = { q: qt ? `${q}（引用：${qt}）` : q, rule: ans.rule, el, t };
      t.busy = false; t.running = false; t.rounds++;
      t.tokens += (mode === 'quick' ? 8200 : 14600) + Math.round(ans.html.length * 0.6);
      if (t.dead) return;
      paint(); live('侧聊回答完成');
      if (active === t && document.activeElement === document.body) input.focus();
    }, { into: t.el, label: `${t.model} · ${modes[mode]}` });
    if (mode === 'quick') { reply(); return; }
    // 侧边调查：先逐条显示只读工具调用，再给结论
    t.el.insertAdjacentHTML('beforeend', `<div class="tools-group sc-tools" role="group" aria-label="只读工具调用"></div>`);
    const g = t.el.lastElementChild;
    let i = 0;
    const step = () => {
      if (t.dead) return;
      if (i >= ans.tools.length) { reply(); return; }
      const tl = ans.tools[i++];
      g.insertAdjacentHTML('beforeend', `<details class="tool"><summary>${ic('right', 'chev')}<span class="verb">${tl.verb}</span><span class="target">${esc(tl.target)}</span><span class="end thinking">进行中</span></summary>
        <div class="detail"><pre>${esc(tl.out)}</pre><div class="foot">${ic('lock')}只读<span class="grow"></span></div></div></details>`);
      t.el.scrollTop = t.el.scrollHeight;
      setTimeout(() => { const e = $('.tool:last-child .end', g); e.className = 'end'; e.textContent = tl.end; step(); }, 650);
    };
    step();
  };

  // ---------- 带回主对话 ----------
  const plain = (el) => { const c = $('.text', el).cloneNode(true); $$('.sc-carry, button, .sc-src', c).forEach((x) => x.remove()); return c.textContent.replace(/\s+/g, ' ').trim().replace(/^结论：/, ''); };
  const markDone = (b, text) => { b.innerHTML = `${ic('check')}${text}`; b.setAttribute('aria-disabled', 'true'); b.classList.add('done'); b.title = '已带回'; };
  // 主对话里的排队消息：等主 Agent 当前步骤结束（原型里是测试跑完、任务变成“待验收”）后发送
  const queued = () => $$('.stream .msg.sc-queued');
  const headStatus = $('.main-head .status');
  if (headStatus) new MutationObserver(() => {
    if (!headStatus.classList.contains('ok')) return;
    queued().forEach((m) => { m.classList.remove('sc-queued'); const s = $('.sc-qs', m); s.className = 'status ok sc-qs'; s.innerHTML = `<span class="dot"></span>已发送 ${hhmm()}`; });
  }).observe(headStatus, { attributes: true, attributeFilter: ['class'] });
  const sendMain = (b, m) => modal({
    title: '发给主 Agent',
    body: `<p>作为一条补充消息排队，等 ${agents[window.aicCur.agent][0]} 当前步骤结束后发送。发送前可以改写。</p>
      <label for="sc-send-ta" class="sr-only">要发给主 Agent 的内容</label><textarea class="textarea" id="sc-send-ta" rows="6"></textarea>`,
    onOpen(d) { const ta = $('#sc-send-ta', d); ta.value = `关于“${m.q}”，侧聊里的结论是：${plain(m.el)}`; ta.focus(); },
    actions: [{ label: '取消' }, { label: '加入排队', kind: 'primary', onClick(d) {
      const text = $('#sc-send-ta', d).value.trim();
      if (!text) { toast('内容不能为空', 'attn'); $('#sc-send-ta', d).focus(); return false; }
      window.aicAdd(`<article class="msg user sc-queued" data-from="side"><div class="who"><span class="me">黄</span></div><div>
        <div class="head"><b>你</b><span class="sc-from">${ic('sidechat')}来自侧聊</span><span class="status idle sc-qs"><span class="dot"></span>排队中：等当前步骤结束后发送</span></div>
        <div class="text"><p>${esc(text)}</p></div></div></article>`);
      markDone(b, '已排队发给主 Agent');
      toast('已加入主对话的排队，等当前步骤结束后发送');
    } }],
  });
  // 计划标签的上下文信息里列出约束；没有上下文区的页面补一个
  const plan = $('#p-plan');
  let consList = null;
  if (plan) {
    let dl = $('dl', plan);
    if (!dl) {
      plan.insertAdjacentHTML('beforeend', '<h3 class="sc-ctx-h">上下文</h3><dl class="sc-ctx"></dl>');
      dl = $('dl', plan);
    }
    dl.insertAdjacentHTML('beforeend', `<dt style="color:var(--fg-3)">约束</dt><dd style="margin:0"><ul class="sc-cons" aria-label="任务约束">${D.base.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></dd>`);
    consList = $('.sc-cons', plan);
  }
  const addConstraint = (b, m) => {
    const rule = m.rule || (() => { const p = plain(m.el); return p.length > 60 ? p.slice(0, 60) + '…' : p; })();
    constraints.push(rule);
    consList?.insertAdjacentHTML('beforeend', `<li class="sc-new">${esc(rule)}<span class="sc-tag">${ic('sidechat')}来自侧聊</span></li>`);
    markDone(b, '已记为约束');
    toast(`已写进任务说明的约束：${esc(rule)}<br>以后的会话和交接都会带上，可在“计划”标签查看。`);
  };
  const newTask = (b, m) => {
    const before = SB.tasks.length;
    const proj = SB.tasks.find((x) => x.id === document.body.dataset.task)?.proj;
    const d = window.aicNewTask(proj ? { proj } : {});
    const ta = $('#nt-d', d);
    ta.value = `${m.q}\n\n侧聊结论：${plain(m.el)}`;
    ta.dispatchEvent(new Event('input'));
    d.addEventListener('close', () => { if (SB.tasks.length > before) markDone(b, '已新建任务'); });
  };

  // ---------- 事件 ----------
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.matches('[data-sc-new]')) { create(); input.focus(); }
    else if (b.dataset.scPick) { select(threads.find((t) => t.id === b.dataset.scPick)); }
    else if (b.dataset.scDel) remove(threads.find((t) => t.id === b.dataset.scDel));
    else if (b.matches('[data-sc-upgrade]')) { const t = threads.find((x) => x.el.contains(b)) || active; if (t) upgrade(t); }
    else if (b.dataset.scEx) { if (active && !active.busy) ask(b.dataset.scEx); }
    else if (b.matches('[data-sc-send]')) ask(input.value);
    else if (b.matches('[data-sc-unquote]')) { quote = ''; paintCompose(); input.focus(); }
    else if (b.dataset.carry) {
      if (b.getAttribute('aria-disabled') === 'true') { toast('这条已经带回过了'); return; }
      const m = msgs[b.dataset.mid]; if (!m) return;
      ({ main: sendMain, constraint: addConstraint, task: newTask })[b.dataset.carry](b, m);
    }
  });
  panel.addEventListener('change', (e) => {
    if (!e.target.matches('.sc-model') || !active) return;
    active.model = e.target.value;
    note(active, `后面的回答改用 ${esc(active.model)}`);
    toast(`侧聊模型改为 ${esc(active.model)}`);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(input.value); } });

  // ---------- 入口：工具条 [侧聊]、Ctrl+/、对话里选中文字后右键 ----------
  const stream = $('.stream');
  const selected = () => {
    const s = getSelection();
    if (!stream || !s.rangeCount || s.isCollapsed || !stream.contains(s.anchorNode) || !stream.contains(s.focusNode)) return '';
    return s.toString().replace(/\s+/g, ' ').trim().slice(0, 400);
  };
  const open = (q) => {
    window.aicOpenSide('t-side');
    if (!active) create();
    if (q) { quote = q; paintCompose(); }
    setTimeout(() => input.focus());
  };
  const bar = $('.composer .compose-bar');
  if (bar) {
    const after = $('#mcp-chip', bar) || $('.aa-chip', bar) || $('.switcher', bar);
    after.insertAdjacentHTML('afterend', `<button class="perm-chip sc-chip" data-wired="1" aria-label="打开侧聊（Ctrl+/）：问的问题不进主对话，主 Agent 照常干活" title="侧聊 Ctrl+/">${ic('sidechat')}<span class="lbl">侧聊</span></button>`);
    $('.sc-chip', bar).addEventListener('click', () => open(selected()));
  }
  document.addEventListener('keydown', (e) => {
    if (!e.ctrlKey || e.shiftKey || e.altKey || (e.key !== '/' && e.code !== 'Slash')) return;
    if (document.querySelector('dialog[open]')) return;
    e.preventDefault();
    if (document.activeElement === input) { $('.composer textarea')?.focus(); return; }
    open(selected());
  });
  // 选中文字后的小菜单（design.md 15.2、ui-design.md 5.15）：[添加到对话] 加为注释（对照 Codex）；
  // [在侧边聊天中提问] 正式版由功能开关 chat.side 控制，侧聊上线前不显示；原型里画出来演示
  // 注释：评论框“添加可选评论…” → 原文旁编号圆点 → 输入框上方“N 条注释” → 发送时附在消息后面
  const annos = [];
  let annoSeq = 0, annoEd = null;
  const ic2 = (n) => `<svg class="i" aria-hidden="true"><use href="#i-${n}"/></svg>`;
  const annoChipHost = () => $('.composer .compose-box');
  const annoClose = () => { annoEd?.remove(); annoEd = null; CSS.highlights?.delete('aic-anno'); };
  const annoRender = () => {
    $$('.anno-badge').forEach((b) => b.remove());
    const sr = stream.getBoundingClientRect();
    annos.forEach((a, i) => {
      const rs = a.range.getClientRects(); const r = rs[rs.length - 1];
      if (!r || r.top < sr.top || r.top > sr.bottom - 10) return;
      document.body.insertAdjacentHTML('beforeend', `<button type="button" data-wired="1" class="anno-badge" style="left:${r.right}px;top:${r.top}px" aria-label="注释 ${i + 1}，点击修改">${i + 1}<span class="anno-tip">${esc(a.comment || a.text)}</span></button>`);
      const b = document.body.lastElementChild;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => annoEdit(a, false));
    });
    const host = annoChipHost(); if (!host) return;
    $('.anno-chip-wrap', host)?.remove();
    if (!annos.length) return;
    host.insertAdjacentHTML('afterbegin', `<div class="anno-chip-wrap"><div class="anno-chip"><button type="button" data-wired="1" class="anno-chip-main">${ic2('chat')}${annos.length} 条注释</button><button type="button" data-wired="1" class="anno-chip-x" aria-label="清空全部注释">${ic2('x')}</button></div>
      <div class="anno-list" hidden>${annos.map((a, i) => `<div class="anno-item"><span class="n">${i + 1}.</span><div><div class="lbl">所选文本：</div><div class="quote">${esc(a.text)}</div>${a.comment ? `<div class="lbl">用户评论：</div><div>${esc(a.comment)}</div>` : ''}</div><div class="acts"><button type="button" data-wired="1" class="btn ghost icon sm" data-anno-del="${a.id}" aria-label="删除注释 ${i + 1}">${ic2('trash')}</button></div></div>`).join('')}</div></div>`);
    const w = $('.anno-chip-wrap', host), list = $('.anno-list', w);
    w.addEventListener('mouseenter', () => { list.hidden = false; });
    w.addEventListener('mouseleave', () => { list.hidden = true; });
    $('.anno-chip-main', w).addEventListener('click', () => { list.hidden = !list.hidden; });
    $('.anno-chip-x', w).addEventListener('click', () => { annos.length = 0; annoClose(); annoRender(); });
    $$('[data-anno-del]', w).forEach((b) => b.addEventListener('click', () => { annos.splice(annos.findIndex((a) => a.id === b.dataset.annoDel), 1); annoClose(); annoRender(); }));
  };
  const annoEdit = (a, isNew) => {
    annoClose();
    if (typeof Highlight !== 'undefined') CSS.highlights?.set('aic-anno', new Highlight(a.range));
    const r = a.range.getClientRects()[0], sr = stream.getBoundingClientRect();
    const below = r.top - sr.top < 120;
    document.body.insertAdjacentHTML('beforeend', `<div class="anno-editor${isNew ? ' new' : ''}${below ? ' below' : ''}" role="dialog" aria-label="${isNew ? '给选中的内容加评论' : '修改注释'}" style="left:${Math.max(sr.left + 8, r.left - 24)}px;top:${below ? r.bottom + 8 : r.top - 8}px">
      <textarea rows="${isNew ? 1 : 2}" placeholder="添加可选评论…" aria-label="评论（可以不填）">${esc(a.comment)}</textarea>
      ${isNew ? `<button type="button" data-wired="1" class="anno-send" aria-label="完成">${ic2('send')}</button>` : `<div class="anno-acts"><button type="button" data-wired="1" class="btn ghost icon sm" data-a="del" aria-label="删除这条注释">${ic2('trash')}</button><span class="grow"></span><button type="button" data-wired="1" class="btn sm" data-a="cancel">取消</button><button type="button" data-wired="1" class="btn sm primary" data-a="save">保存</button></div>`}</div>`);
    annoEd = document.body.lastElementChild;
    const ta = $('textarea', annoEd); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    const save = () => { a.comment = ta.value.trim(); annoClose(); annoRender(); };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); save(); } if (e.key === 'Escape') { e.preventDefault(); isNew ? save() : annoClose(); } });
    annoEd.addEventListener('click', (e) => {
      const act = e.target.closest('.anno-send') ? 'save' : e.target.closest('[data-a]')?.dataset.a;
      if (act === 'save') save(); else if (act === 'cancel') annoClose();
      else if (act === 'del') { annos.splice(annos.indexOf(a), 1); annoClose(); annoRender(); }
    });
    annoEd.dataset.isNew = isNew ? '1' : '';
    annoEd._save = save;
  };
  const annoAdd = (text, range) => {
    const a = { id: 'an' + (++annoSeq), text, comment: '', range };
    annos.push(a); annoRender(); annoEdit(a, true);
  };
  document.addEventListener('mousedown', (e) => {
    if (!annoEd || annoEd.contains(e.target) || e.target.closest('.anno-badge')) return;
    annoEd.dataset.isNew ? annoEd._save() : annoClose();
  });
  stream?.addEventListener('scroll', () => { if (annos.length) annoRender(); }, { passive: true });
  window.addEventListener('resize', () => { if (annos.length) annoRender(); });
  // 发送时取走注释（interact.js 调用）
  window.aicAnnos = {
    take() {
      if (!annos.length) return '';
      const out = `我在对话里标注了 ${annos.length} 处内容：\n\n` + annos.map((a, i) => `${i + 1}. 所选文本：${a.text}${a.comment ? `\n   用户评论：${a.comment}` : ''}`).join('\n');
      annos.length = 0; annoClose(); annoRender();
      return out;
    },
  };
  let selMenu = null;
  const hideSel = () => { selMenu?.remove(); selMenu = null; };
  const showSel = () => {
    hideSel();
    const s = getSelection();
    const raw = s && !s.isCollapsed && stream.contains(s.anchorNode) && stream.contains(s.focusNode) ? s.toString().trim() : '';
    if (!raw) return;
    const r = s.getRangeAt(0).getBoundingClientRect();
    document.body.insertAdjacentHTML('beforeend', `<div class="sel-menu" role="toolbar" aria-label="选中内容的操作" style="left:${r.left + r.width / 2}px;top:${r.top}px"><button type="button" data-wired="1" data-sel="add">添加到对话</button><button type="button" data-wired="1" data-sel="side" title="正式版在侧边聊天上线后才显示">在侧边聊天中提问</button></div>`);
    selMenu = document.body.lastElementChild;
    selMenu.addEventListener('mousedown', (e) => e.preventDefault());
    selMenu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sel]'); if (!b) return;
      if (b.dataset.sel === 'add') {
        annoAdd(raw, getSelection().getRangeAt(0).cloneRange());
      } else open(selected());
      getSelection().removeAllRanges(); hideSel();
    });
  };
  stream?.addEventListener('mouseup', () => setTimeout(showSel));
  stream?.addEventListener('keyup', (e) => { if (e.key === 'Escape') hideSel(); else if (e.shiftKey) setTimeout(showSel); });
  stream?.addEventListener('scroll', hideSel);
  document.addEventListener('mousedown', (e) => { if (selMenu && !selMenu.contains(e.target)) hideSel(); });

  // 右键菜单；键盘用菜单键或 Shift+F10，同样会触发
  stream?.addEventListener('contextmenu', (e) => {
    const text = selected(); if (!text) return;
    e.preventDefault(); hideSel();
    let r = (e.clientX || e.clientY) ? { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY } : getSelection().getRangeAt(0).getBoundingClientRect();
    // 键盘触发时选区可能已滚出视野：菜单放到对话区可见范围内
    const sr = stream.getBoundingClientRect();
    const y = Math.min(Math.max(r.bottom, sr.top + 8), sr.bottom - 8), x = Math.min(Math.max(r.left, sr.left + 8), sr.right - 8);
    r = { left: x, right: x, top: y, bottom: y };
    window.aicMenu({ getBoundingClientRect: () => r, focus: () => stream.focus() }, [
      ['在侧聊中问', () => open(text)],
      ['复制', () => navigator.clipboard?.writeText(text).then(() => toast('已复制'), () => toast('浏览器不允许写剪贴板，请用 Ctrl+C', 'attn'))],
    ]);
  });

  paint();
})();
