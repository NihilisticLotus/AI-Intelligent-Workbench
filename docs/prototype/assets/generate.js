// 媒体生成（docs/design.md 第 27 节）：生成页、能力页的“生成器”标签、资产页对话里 Agent 调用 gen__image。
// 只做原型演示：生成器、模型、价格都是示例值。图片用 canvas 画渐变和噪点，音效用 WebAudio 播放现场合成的短音，视频是 canvas 动画。
// 依赖 app.js（图标、侧栏）和 interact.js（aicModal、aicToast、aicMenu、aicEsc、aicNewTask、aicAgentMsg）。
(function () {
  const page = document.body.dataset.page;
  if (!['generate', 'capabilities', 'assets'].includes(page)) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { aicToast: toast, aicModal: modal, aicMenu: menu, aicEsc: esc } = window;
  const ic = (n, c = '') => window.icon(n, c);
  const later = (ms, fn) => setTimeout(fn, ms);
  const usd = (v) => `$${v.toFixed(2)}`;
  const hhmm = () => new Date().toTimeString().slice(0, 5);
  const ymd = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const cssv = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const hash = (s) => { let x = 2166136261; for (const c of String(s)) { x ^= c.codePointAt(0); x = Math.imul(x, 16777619); } return x >>> 0; };
  const prng = (seed) => { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  // ---------- 本机保存的状态：安装、模型、密钥（只记末四位）、预算、并发、启用 ----------
  const DEF = { comfy: 'none', models: { base: false, tile: false, icon: false, anime: false, video: false }, sfxKey: '', used: 1.2, limit: 10,
    conc: { comfyui: 'exclusive', 'img-a': 'shared', 'vid-b': 'shared', 'sfx-c': 'shared' }, vidB: 'off',
    on: { comfyui: true, 'img-a': true, 'vid-b': true, 'sfx-c': true }, addr: 'http://127.0.0.1:8188', extra: [], imported: [] };
  const st = (() => {
    try {
      const v = JSON.parse(localStorage.getItem('aic-gen') || '{}');
      const o = { ...DEF, ...v, models: { ...DEF.models, ...v.models }, conc: { ...DEF.conc, ...v.conc }, on: { ...DEF.on, ...v.on }, extra: v.extra || [], imported: v.imported || [] };
      if (o.comfy === 'installing') o.comfy = 'none';
      return o;
    } catch (e) { return JSON.parse(JSON.stringify(DEF)); }
  })();
  const emit = () => document.dispatchEvent(new CustomEvent('aic-gen-change'));
  const save = () => { try { localStorage.setItem('aic-gen', JSON.stringify({ ...st, comfy: st.comfy === 'installing' ? 'none' : st.comfy })); } catch (e) { /* 忽略 */ } emit(); };

  // ---------- 生成器 ----------
  const GENS = [
    // 具体用哪些工具等调研结论（design.md 27.1），这里都是示例名称
    { id: 'comfyui', name: 'ComfyUI（示例）', icon: 'image', kind: 'image', kindText: '图片 / 视频', local: true, price: 0, unit: '张', tool: 'gen__image、gen__video' },
    { id: 'img-a', name: '图片服务 A（示例）', icon: 'image', kind: 'image', kindText: '图片', price: 0.04, unit: '张', via: '云端 API', key4: '7f3a', tool: 'gen__image' },
    { id: 'vid-b', name: '视频服务 B（示例）', icon: 'video', kind: 'video', kindText: '视频', price: 0.3, unit: '段', via: '云端 API', key4: 'c91e', tool: 'gen__video' },
    { id: 'sfx-c', name: '音效服务 C（示例）', icon: 'audio', kind: 'audio', kindText: '音效', price: 0.02, unit: '个', via: '云端 API', tool: 'gen__sfx' },
  ];
  const UNIT = { image: '张', audio: '个', video: '段' };
  const KIND_ICON = { image: 'image', audio: 'audio', video: 'video' };
  const allGens = () => [...GENS, ...st.extra.map((x) => ({ icon: x.kind === 'audio' ? 'audio' : x.kind === 'video' ? 'video' : 'image', kindText: { image: '图片', audio: '音效', video: '视频' }[x.kind], unit: x.kind === 'audio' ? '个' : x.kind === 'video' ? '段' : '张', tool: { image: 'gen__image', audio: 'gen__sfx', video: 'gen__video' }[x.kind], ...x }))];
  const genOf = (id) => allGens().find((g) => g.id === id);
  const isComfy = (g) => g.id === 'comfyui';
  const where = (g) => {
    if (isComfy(g)) return st.comfy === 'none' || st.comfy === 'installing' ? '本机工具 · 还没安装' : '本机 · 显卡 RTX 4090';
    if (g.extra) return g.local ? `本机工具 · ${g.addr}` : g.mcp ? `MCP · ${g.mcp}` : `云端 API · ${g.provider || ''}`;
    return '云端 API';
  };
  let installing = null; // { i, p }：一键安装的进度（不保存）
  const INSTALL = [
    ['检测显卡', 'NVIDIA GeForce RTX 4090 · 24 GB 显存 · 驱动 566.36：满足要求'],
    ['下载 ComfyUI', '约 2.1 GB（示例），来自 ComfyUI 官方发布页'],
    ['解压并安装依赖', '装到 %LOCALAPPDATA%\\AI_Console\\comfyui，不改动系统环境'],
    ['下载入门模型：SDXL 基础模型', '6.9 GB（示例）；其他模板的模型用到时再下载'],
    ['启动并连接', 'http://127.0.0.1:8188，只在本机监听'],
  ];
  const stateOf = (g) => {
    if (st.on[g.id] === false) return ['idle', '未连接（已停用）'];
    if (isComfy(g)) {
      if (installing) return ['run', `安装中 ${installing.i + 1}/${INSTALL.length} · ${Math.round(((installing.i + installing.p / 100) / INSTALL.length) * 100)}%`];
      if (st.comfy === 'none') return ['idle', '未安装'];
      if (st.comfy === 'stopped') return ['idle', '未连接'];
      return ['ok', '已连接'];
    }
    if (g.id === 'sfx-c' && !st.sfxKey) return ['wait', '需要 API Key'];
    if (g.id === 'vid-b' && st.vidB !== 'ok') return ['idle', '未连接'];
    return ['ok', '已连接'];
  };
  const ready = (g) => stateOf(g)[0] === 'ok';
  const statusHtml = (g, attr = '') => { const [c, t] = stateOf(g); return `<span class="status ${c}" ${attr}><span class="dot"></span>${t}</span>`; };
  const concText = (g) => ((st.conc[g.id] || g.conc || (g.local ? 'exclusive' : 'shared')) === 'exclusive' ? '独占排队' : '共享');
  const isExclusive = (g) => g.local && concText(g) === '独占排队';

  // ---------- 模型、字段、模板（相当于生成器 describe() 返回的 schema） ----------
  const MODELS = { base: ['SDXL 基础模型', '6.9 GB'], tile: ['无缝平铺 LoRA', '0.2 GB'], icon: ['图标风格 LoRA', '0.15 GB'], anime: ['动漫立绘模型', '6.5 GB'], video: ['图生视频模型', '16 GB'] };
  const F = {
    prompt: { t: 'text', label: '正向提示词', rows: 3, req: true, ph: '例如：做旧的铁箍，带锈迹和划痕，手绘风格' },
    neg: { t: 'text', label: '反向提示词', rows: 2, def: '模糊，文字，水印，低质量' },
    size: { t: 'select', label: '宽高', opts: ['1024×1024', '1024×768', '768×1024', '512×512'] },
    tsize: { t: 'select', label: '宽高', opts: ['1024×1024', '512×512', '2048×2048'] },
    isize: { t: 'select', label: '宽高', opts: ['512×512', '256×256', '128×128'] },
    csize: { t: 'select', label: '宽高', opts: ['768×1024', '1024×1536'] },
    count: { t: 'select', label: '数量', opts: ['4', '1', '2', '8'], half: true },
    steps: { t: 'number', label: '步数', def: 24, min: 4, max: 60, half: true },
    cfg: { t: 'number', label: '提示词强度 cfg', def: 7, min: 1, max: 20, half: true },
    strength: { t: 'select', label: '参考图影响', opts: ['中（0.55）', '弱（0.3）', '强（0.8）'] },
    seed: { t: 'seed', label: 'seed（随机种子）' },
    ref: { t: 'ref', label: '参考图' },
    style: { t: 'select', label: '风格', opts: ['手绘', '写实', '像素', '卡通', '概念草图'], half: true },
    ccount: { t: 'select', label: '数量', opts: ['2', '1', '3', '4'], half: true },
    sdesc: { t: 'text', label: '描述', rows: 2, req: true, ph: '例如：石板路上的皮靴脚步，轻快' },
    stype: { t: 'select', label: '类型', opts: ['脚步', 'UI 点击', '爆炸', '环境'], half: true },
    sdur: { t: 'select', label: '时长', opts: ['0.8 秒', '0.3 秒', '1.5 秒', '3 秒'], half: true },
    vars: { t: 'select', label: '变体数量', opts: ['3', '1', '2', '4', '6'], half: true },
    vdur: { t: 'select', label: '时长', opts: ['4 秒', '2 秒', '6 秒'], half: true },
    fps: { t: 'select', label: '帧率', opts: ['24', '12', '30'], half: true },
  };
  const TPLS = [
    { id: 't2i', gen: 'comfyui', look: 't2i', name: '文生图', desc: '只写提示词，一次出几张候选', ver: 'v1.2', models: ['base'], fields: ['prompt', 'neg', 'size', 'count', 'steps', 'seed'], prompt: '雾港码头的旧木箱，海盐侵蚀，手绘风格，游戏道具' },
    { id: 'i2i', gen: 'comfyui', look: 'i2i', name: '图生图（参考图）', desc: '按参考图的构图和配色出变体', ver: 'v1.1', models: ['base'], fields: [['ref', { req: true }], 'prompt', 'neg', 'strength', 'size', 'count', 'seed'], prompt: '同样的宝箱，换成深色胡桃木和黄铜包角' },
    { id: 'tile', gen: 'comfyui', look: 'tile', name: '无缝贴图', desc: '四边能无缝拼接，适合地面、墙面、材质', ver: 'v1.0', models: ['base', 'tile'], fields: ['prompt', 'neg', 'tsize', 'count', 'seed'], prompt: '做旧铁板，锈迹和划痕，可平铺' },
    { id: 'icon', gen: 'comfyui', look: 'icon', name: '图标 / UI 元素', desc: '纯色背景、主体居中、边缘干净', ver: 'v1.0', models: ['base', 'icon'], fields: ['prompt', 'isize', 'count', 'seed'], prompt: '金币图标，扁平风格，描边' },
    { id: 'char', gen: 'comfyui', look: 'char', name: '角色立绘', desc: '竖版全身立绘，可附姿势参考', ver: 'v1.0', models: ['anime'], fields: ['prompt', 'neg', 'ref', 'csize', 'count', 'seed'], prompt: '港口少女 Lina，水手服，手提风灯，全身立绘' },
    { id: 'vid', gen: 'comfyui', kind: 'video', look: 'vid', name: '短视频（首帧生成）', desc: '从一张首帧图生成几秒的动画', ver: 'v0.9', models: ['video'], fields: [['ref', { req: true, label: '首帧参考图' }], 'prompt', 'vdur', 'fps', 'seed'], prompt: '镜头缓慢推近，箱盖轻轻打开，飘起灰尘' },
  ];
  const SCHEMA = {
    'img-a': { look: 'codex', fields: [['prompt', { label: '描述' }], 'size', 'ccount', 'style', 'ref'], prompt: '宝箱的铁箍贴图，做旧，锈迹，手绘风格' },
    'vid-b': { look: 'vid', fields: [['ref', { req: true, label: '首帧参考图' }], ['prompt', { label: '描述' }], 'vdur', 'fps', 'seed'], prompt: '镜头缓慢推近，箱盖轻轻打开，飘起灰尘' },
    'sfx-c': { look: 'sfx', fields: ['sdesc', 'stype', 'sdur', 'vars', 'seed'], prompt: '宝箱打开时，木头吱呀一声' },
    image: { look: 'codex', fields: [['prompt', { label: '描述' }], 'size', 'ccount', 'ref'] },
    audio: { look: 'sfx', fields: ['sdesc', 'stype', 'sdur', 'vars', 'seed'] },
    video: { look: 'vid', fields: [['ref', { req: true, label: '首帧参考图' }], 'prompt', 'vdur', 'fps', 'seed'] },
  };
  // 导入工作流时识别到的输入节点：[节点, 名称, 字段, 默认勾选]
  const NODES = [['CLIPTextEncode #6', '正向提示词', 'prompt', true], ['CLIPTextEncode #7', '反向提示词', 'neg', true], ['KSampler #3 · seed', 'seed', 'seed', true],
    ['EmptyLatentImage #5', '宽高', 'size', true], ['LoadImage #12', '参考图', 'ref', true], ['KSampler #3 · steps', '步数', 'steps', true], ['KSampler #3 · cfg', '提示词强度 cfg', 'cfg', false]];
  const tplsOf = (gid) => [...TPLS.filter((t) => t.gen === gid), ...(gid === 'comfyui' ? st.imported : [])];
  const tplOf = (id) => [...TPLS, ...st.imported].find((t) => t.id === id);
  const missing = (tpl) => (tpl ? tpl.models.filter((m) => !st.models[m]) : []);
  const norm = (f) => (Array.isArray(f) ? [f[0], { ...F[f[0]], ...f[1] }] : [f, F[f]]);

  // ---------- 资产库里的示例资产（参考图） ----------
  const ASSETS = [
    { id: 'chest.glb', name: 'chest.glb 的截图', file: 'Assets/Art/Props/Chest/chest.glb（预览截图）', kind: '模型截图', look: 'i2i', pal: [[122, 82, 50], [141, 143, 148], [214, 166, 64]] },
    { id: 'T_Chest_Wood_D.png', name: 'T_Chest_Wood_D.png', file: 'Assets/Art/Props/Chest/Textures/T_Chest_Wood_D.png', kind: '贴图', look: 'tile', pal: [[122, 82, 50], [86, 56, 34], [168, 124, 82]] },
    { id: 'T_Chest_Iron_D.png', name: 'T_Chest_Iron_D.png', file: 'Assets/Art/Props/Chest/Textures/T_Chest_Iron_D.png', kind: '贴图', look: 'tile', pal: [[120, 122, 128], [78, 80, 86], [170, 110, 70]] },
    { id: 'UI_Btn_Normal.png', name: 'UI_Btn_Normal.png', file: 'Assets/Art/UI/Buttons/UI_Btn_Normal.png', kind: 'UI 贴图', look: 'icon', pal: [[44, 60, 104], [214, 178, 92], [28, 32, 54]] },
    { id: 'Lina_Concept.png', name: 'Lina_Concept.png', file: 'Assets/Art/Characters/Lina/Lina_Concept.png', kind: '角色概念图', look: 'char', pal: [[70, 84, 120], [240, 214, 190], [176, 64, 72]] },
  ];
  const assetOf = (id) => ASSETS.find((a) => a.id === id);

  // ---------- 示例图片：渐变 + 色块 + 噪点；t 越小噪点越多（模拟去噪过程） ----------
  const PAL = { t2i: [[58, 86, 140], [214, 166, 96], [30, 32, 48]], i2i: [[122, 82, 50], [141, 143, 148], [214, 166, 64]], tile: [[132, 96, 74], [84, 70, 62], [176, 120, 82]],
    icon: [[34, 44, 78], [244, 200, 88], [96, 150, 224]], char: [[60, 70, 108], [236, 206, 184], [176, 64, 72]], codex: [[70, 104, 92], [222, 188, 120], [40, 42, 52]], vid: [[44, 66, 104], [214, 166, 64], [24, 28, 40]] };
  const N = 72, off = document.createElement('canvas'); off.width = off.height = N;
  const mix = (a, b, w) => a + (b - a) * w;
  const paint = (cv, { seed = 1, look = 't2i', t = 1, ref = null }) => {
    const r = prng(seed), pal = (ref && assetOf(ref)?.pal) || PAL[look] || PAL.t2i;
    const oc = off.getContext('2d'), img = oc.createImageData(N, N), d = img.data;
    const blobs = Array.from({ length: 5 }, () => ({ x: r() * N, y: r() * N, rad: N * (0.18 + r() * 0.35), c: pal[Math.floor(r() * 3)] }));
    const fq = 2 + Math.floor(r() * 3), ph = r() * 6.28, shape = Math.floor(r() * 3), nz = Math.pow(1 - t, 1.3);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const gy = y / N;
      let c = [mix(pal[2][0], pal[0][0], 1 - gy), mix(pal[2][1], pal[0][1], 1 - gy), mix(pal[2][2], pal[0][2], 1 - gy)];
      if (look === 'tile') {
        // 周期函数：左右、上下边缘的值相同，所以能无缝拼接
        const v = 0.5 + 0.5 * Math.sin((2 * Math.PI * fq * x) / N + ph) * Math.sin((2 * Math.PI * fq * y) / N) * Math.cos((2 * Math.PI * x) / N);
        c = [0, 1, 2].map((k) => mix(pal[1][k], pal[2][k], v));
      } else {
        blobs.forEach((b) => { const dd = Math.hypot(x - b.x, y - b.y) / b.rad; if (dd < 1) { const w = (1 - dd) ** 2 * 0.85; c = c.map((v, k) => mix(v, b.c[k], w)); } });
      }
      if (look === 'icon') {
        const dx = (x - N / 2) / N, dy = (y - N / 2) / N, rr = shape === 0 ? Math.hypot(dx, dy) : shape === 1 ? Math.abs(dx) + Math.abs(dy) : Math.max(Math.abs(dx), Math.abs(dy));
        c = rr < 0.26 ? pal[1].map((v) => v + (0.3 - dy) * 60) : rr < 0.3 ? pal[2] : pal[0];
      }
      if (look === 'char') {
        const head = Math.hypot(x - N / 2, y - N * 0.24) < N * 0.09, body = ((x - N / 2) / (N * 0.17)) ** 2 + ((y - N * 0.62) / (N * 0.3)) ** 2 < 1;
        if (head) c = pal[1]; else if (body) c = pal[2].map((v) => v + (x < N / 2 ? 18 : -10));
      }
      const g = (r() - 0.5) * 16, n = r() * 255, i = (y * N + x) * 4;
      for (let k = 0; k < 3; k++) d[i + k] = Math.max(0, Math.min(255, mix(c[k] + g, n, nz)));
      d[i + 3] = 255;
    }
    oc.putImageData(img, 0, 0);
    const ctx = cv.getContext('2d'); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(off, 0, 0, cv.width, cv.height);
  };
  const paintAsset = (cv, id) => { const a = assetOf(id); if (a) paint(cv, { seed: hash(a.id), look: a.look, ref: a.id }); };

  // ---------- 示例视频：canvas 画的几秒动画（镜头推近、主体移动、灰尘） ----------
  const vframe = (cv, { seed = 1, ref = null }, f, total, noise = 0) => {
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, r = prng(seed), pal = (ref && assetOf(ref)?.pal) || PAL.vid, tt = total > 1 ? f / (total - 1) : 0;
    const rgb = (c, k = 0) => `rgb(${c.map((v) => Math.max(0, Math.min(255, v + k))).join(',')})`;
    const sky = ctx.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, rgb(pal[0], 30 * tt)); sky.addColorStop(1, rgb(pal[2])); ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = rgb(pal[2], -10); ctx.fillRect(0, h * 0.72, w, h * 0.28);
    const s = 1 + tt * 0.35, cx = w * (0.5 + 0.06 * Math.sin(seed)), cy = h * 0.62;
    ctx.save(); ctx.translate(cx, cy); ctx.scale(s, s);
    ctx.fillStyle = rgb(pal[0], -20); ctx.fillRect(-w * 0.16, -h * 0.12, w * 0.32, h * 0.2);
    ctx.save(); ctx.translate(-w * 0.16, -h * 0.12); ctx.rotate(-0.5 * Math.min(1, tt * 1.6)); ctx.fillStyle = rgb(pal[0]); ctx.fillRect(0, -h * 0.07, w * 0.32, h * 0.07); ctx.restore();
    ctx.fillStyle = rgb(pal[1]); ctx.fillRect(-w * 0.02, -h * 0.1, w * 0.04, h * 0.06);
    ctx.restore();
    ctx.fillStyle = 'rgba(255,240,210,0.7)';
    for (let i = 0; i < 24; i++) { const px = (r() * w + tt * 40 * (r() + 0.3)) % w, py = h * 0.7 - ((r() * h * 0.6 + tt * 60 * r()) % (h * 0.7)); ctx.fillRect(px, py, 2, 2); }
    if (noise > 0) { for (let i = 0; i < 900 * noise; i++) { const g = Math.floor(r() * 255); ctx.fillStyle = `rgba(${g},${g},${g},${noise})`; ctx.fillRect(r() * w, r() * h, 3, 3); } }
  };

  // ---------- 示例音效：按类型合成一段短音（22050 Hz，单声道） ----------
  const SR = 22050;
  const synth = ({ type, dur, seed }) => {
    const r = prng(seed), n = Math.max(1, Math.round(SR * dur)), a = new Float32Array(n), TAU = Math.PI * 2;
    let lp = 0, br = 0;
    if (type === '脚步') {
      const hits = Math.max(1, Math.round(dur / 0.4));
      for (let hI = 0; hI < hits; hI++) {
        const t0 = Math.floor((hI / hits) * n + r() * 300), f0 = 70 + r() * 30;
        for (let i = 0; i < SR * 0.14 && t0 + i < n; i++) { const nz = r() * 2 - 1; lp += (nz - lp) * 0.22; a[t0 + i] += lp * Math.exp(-i / (SR * 0.022)) * 1.2 + Math.sin((TAU * f0 * i) / SR) * Math.exp(-i / (SR * 0.035)) * 0.6; }
      }
    } else if (type === 'UI 点击') {
      const f = 900 + r() * 900, two = r() > 0.4;
      for (let i = 0; i < n; i++) { const e = Math.exp(-i / (SR * 0.025)); a[i] = (Math.sin((TAU * f * i) / SR) + 0.3 * Math.sin((TAU * 2 * f * i) / SR)) * e; }
      if (two) for (let i = 0, t0 = Math.floor(SR * 0.06); t0 + i < n; i++) a[t0 + i] += Math.sin((TAU * f * 1.5 * i) / SR) * Math.exp(-i / (SR * 0.02)) * 0.6;
    } else if (type === '爆炸') {
      for (let i = 0; i < n; i++) { const tt = i / n, e = i < SR * 0.008 ? i / (SR * 0.008) : Math.exp(-i / (SR * dur * 0.3)), nz = r() * 2 - 1; lp += (nz - lp) * (0.55 * (1 - tt) + 0.02); a[i] = lp * e * 1.4 + Math.sin((TAU * 48 * i) / SR) * e * 0.7; }
    } else {
      const lf = 0.3 + r() * 0.4;
      for (let i = 0; i < n; i++) { br = (br + 0.02 * (r() * 2 - 1)) / 1.02; const fade = Math.min(1, i / (SR * 0.3), (n - i) / (SR * 0.3)); a[i] = br * (0.6 + 0.4 * Math.sin((TAU * lf * i) / SR + seed)) * fade * 8; }
    }
    let pk = 0; for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(a[i]));
    if (pk) for (let i = 0; i < n; i++) a[i] = (a[i] / pk) * 0.85;
    return a;
  };
  const drawWave = (cv, s, upto = 1, cursor = -1) => {
    const ctx = cv.getContext('2d'), w = cv.width, h = cv.height, col = Math.floor(w / 3), step = Math.max(1, Math.floor(s.length / col));
    ctx.clearRect(0, 0, w, h);
    const fg = cssv('--accent') || '#8b95ff', dim = cssv('--line-strong') || '#565961';
    for (let c = 0; c < col; c++) {
      let pk = 0; for (let i = c * step; i < Math.min(s.length, (c + 1) * step); i++) pk = Math.max(pk, Math.abs(s[i]));
      const bh = Math.max(2, pk * (h - 4));
      ctx.fillStyle = c / col <= upto ? fg : dim;
      ctx.fillRect(c * 3, (h - bh) / 2, 2, bh);
    }
    if (cursor >= 0) { ctx.fillStyle = cssv('--fg-1') || '#fff'; ctx.fillRect(Math.round(cursor * w), 0, 2, h); }
  };
  let actx = null, playing = null;
  const stopPlaying = () => { if (playing) { try { playing.src.stop(); } catch (e) { /* 已停止 */ } playing.done(); playing = null; } };
  const mountWave = (box, s, dur, label) => {
    box.innerHTML = `<div class="wave"><canvas width="480" height="112" aria-hidden="true"></canvas>
      <div class="pl"><button type="button" class="btn sm" data-wired="1" data-play aria-pressed="false" aria-label="播放 ${esc(label)}">${ic('play')}播放</button><span class="grow"></span><span class="tm">${dur.toFixed(1)} 秒</span></div></div>`;
    const cv = $('canvas', box), b = $('[data-play]', box), tm = $('.tm', box);
    drawWave(cv, s);
    b.addEventListener('click', () => {
      if (playing && playing.btn === b) { stopPlaying(); return; }
      stopPlaying();
      try {
        actx ||= new (window.AudioContext || window.webkitAudioContext)();
        if (actx.state === 'suspended') actx.resume();
        const buf = actx.createBuffer(1, s.length, SR); buf.copyToChannel(s, 0);
        const src = actx.createBufferSource(); src.buffer = buf; src.connect(actx.destination);
        const t0 = actx.currentTime; let raf;
        const done = () => { cancelAnimationFrame(raf); b.setAttribute('aria-pressed', 'false'); b.innerHTML = `${ic('play')}播放`; b.setAttribute('aria-label', `播放 ${label}`); drawWave(cv, s); tm.textContent = `${dur.toFixed(1)} 秒`; };
        const loop = () => { const p = Math.min(1, (actx.currentTime - t0) / dur); drawWave(cv, s, p, p); tm.textContent = `${(p * dur).toFixed(1)} / ${dur.toFixed(1)} 秒`; raf = requestAnimationFrame(loop); };
        src.onended = () => { if (playing && playing.src === src) { playing = null; done(); } };
        src.start(); playing = { src, btn: b, done };
        b.setAttribute('aria-pressed', 'true'); b.innerHTML = `${ic('stop')}停止`; b.setAttribute('aria-label', `停止播放 ${label}`); loop();
      } catch (e) { toast('这个浏览器不能播放 WebAudio，换用 Chrome 或 Edge 再试', 'attn'); }
    });
  };
  const mountVideo = (box, spec, dur, fps, label) => {
    const total = Math.round(dur * fps);
    box.innerHTML = `<div class="vplay"><canvas width="384" height="216" aria-hidden="true"></canvas>
      <div class="pl"><button type="button" class="btn sm" data-wired="1" data-vplay aria-pressed="false" aria-label="播放 ${esc(label)}">${ic('play')}播放</button>
      <input type="range" min="0" max="${total - 1}" value="0" aria-label="${esc(label)} 的播放位置"><span class="tm">0.0 / ${dur.toFixed(1)} 秒</span></div></div>`;
    const cv = $('canvas', box), b = $('[data-vplay]', box), rg = $('input', box), tm = $('.tm', box);
    let f = 0, raf = null, last = 0;
    const show = () => { vframe(cv, spec, f, total); rg.value = f; const s = (f / fps).toFixed(1); tm.textContent = `${s} / ${dur.toFixed(1)} 秒`; rg.setAttribute('aria-valuetext', `${s} 秒，共 ${dur} 秒`); };
    const stop = () => { cancelAnimationFrame(raf); raf = null; b.setAttribute('aria-pressed', 'false'); b.innerHTML = `${ic('play')}播放`; b.setAttribute('aria-label', `播放 ${label}`); };
    const loop = (ts) => { if (!last) last = ts; if (ts - last >= 1000 / fps) { last = ts; f++; if (f >= total) { f = total - 1; show(); stop(); return; } show(); } raf = requestAnimationFrame(loop); };
    b.addEventListener('click', () => {
      if (raf) return stop();
      if (f >= total - 1) f = 0;
      last = 0; raf = requestAnimationFrame(loop);
      b.setAttribute('aria-pressed', 'true'); b.innerHTML = `${ic('pause')}暂停`; b.setAttribute('aria-label', `暂停 ${label}`);
    });
    rg.addEventListener('input', () => { f = +rg.value; show(); });
    show();
  };

  // ---------- 一键安装 ComfyUI：检测显卡、下载、安装、下载入门模型、连接 ----------
  const paintInstall = () => {
    const ol = $('#inst-log'); if (!ol) return;
    INSTALL.forEach(([, sub], i) => {
      const li = ol.children[i], s = $('[data-s]', li), bar = $('.qbar i', li), pb = $('.qbar', li);
      const done = !installing ? st.comfy === 'ok' : i < installing.i, now = installing && i === installing.i;
      s.className = 'status ' + (done ? 'ok' : now ? 'run' : 'idle');
      s.innerHTML = `<span class="dot"></span>${done ? '完成' : now ? `${installing.p}%` : '等待'}`;
      bar.style.width = (done ? 100 : now ? installing.p : 0) + '%';
      pb.setAttribute('aria-valuenow', done ? 100 : now ? installing.p : 0);
      $('.sub', li).textContent = sub;
    });
    const h = $('#inst-h'); if (h) h.textContent = installing ? '正在安装，可以关掉这个窗口，安装会在后台继续' : st.comfy === 'ok' ? `安装完成，已连接 ${st.addr}` : '';
    const fb = ol.closest('dialog')?.querySelector('.dlg-foot .btn');
    if (fb && !installing && st.comfy === 'ok') { fb.textContent = '完成'; fb.classList.add('primary'); }
  };
  const showInstall = () => modal({
    title: '一键安装 ComfyUI',
    body: `<p>ComfyUI 是在本机显卡上运行的免费生成工具。工作台会自动完成下面几步，不需要打开命令行。</p>
      <p class="sub" id="inst-h" aria-live="polite" style="color:var(--fg-1)"></p>
      <ol class="instlog" id="inst-log">${INSTALL.map(([n], i) => `<li><span>${i + 1}. ${n}</span><span class="status idle" data-s><span class="dot"></span>等待</span>
        <span class="qbar" role="progressbar" aria-label="${n} 进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></span><span class="sub"></span></li>`).join('')}</ol>
      <p class="note" style="margin:0;color:var(--fg-3)">大小、版本号为示例。安装位置在设置里可以改；卸载会删除整个文件夹，不影响你的项目。</p>`,
    actions: [{ label: '关闭（安装在后台继续）' }],
    onOpen: paintInstall,
  });
  const install = () => {
    if (st.comfy === 'ok') return toast('ComfyUI 已经安装并连接');
    if (installing) return showInstall();
    installing = { i: 0, p: 0 }; st.comfy = 'installing'; emit();
    showInstall();
    const t = setInterval(() => {
      installing.p += installing.i === 1 || installing.i === 3 ? 10 : 25;
      if (installing.p >= 100) { installing.i++; installing.p = 0; }
      if (installing.i >= INSTALL.length) {
        clearInterval(t); installing = null; st.comfy = 'ok'; st.models.base = true; save(); paintInstall();
        toast(`ComfyUI 已安装并连接（${st.addr}），可以开始生成了`);
        return;
      }
      paintInstall(); emit();
    }, 180);
  };
  const logDialog = (title, lines, onEnd, note = '') => {
    const d = modal({ title, body: `<pre class="genrec" aria-live="polite"></pre>${note}`, actions: [{ label: '关闭' }] });
    const log = $('pre', d), t = () => new Date().toTimeString().slice(0, 8);
    lines.forEach((l, i) => later(380 * (i + 1), () => { if (d.open) log.textContent += (log.textContent ? '\n' : '') + `${t()}  ${l}`; }));
    later(380 * (lines.length + 1), () => onEnd?.(d));
    return d;
  };
  const detect = () => logDialog('自动检测 ComfyUI', ['查找本机进程：找到 python.exe（ComfyUI\\main.py）', `连接 ${st.addr} … 成功`, '读取模型目录 models/checkpoints：找到 1 个模型（SDXL 基础模型）', '结果：已连接。以后启动 AI Console 时会自动连接'],
    () => { st.comfy = 'ok'; st.models.base = true; save(); toast('已找到本机的 ComfyUI 并连接'); });
  const testConn = (g) => {
    if (isComfy(g) && st.comfy === 'none') return toast('ComfyUI 还没安装，先点 [一键安装 ComfyUI]', 'attn');
    if (g.id === 'sfx-c' && !st.sfxKey) return toast(`先填写 ${esc(g.name)} 的 API Key`, 'attn');
    const reconnect = g.id === 'vid-b' && st.vidB !== 'ok';
    const lines = isComfy(g) || g.local
      ? [`连接 ${g.addr || st.addr}/system_stats`, '显卡：NVIDIA GeForce RTX 4090，空闲显存 21.8 GB', '打开进度通道 /ws … 成功', `结果：${st.comfy === 'stopped' && isComfy(g) ? '没有连上，ComfyUI 没有运行（点 [启动服务]）' : '一切正常，往返 0.05 秒'}`]
      : g.mcp ? [`经 MCP 入口调用 ${g.mcp} 的 tools/list`, '找到生成类工具 1 个', '结果：一切正常']
      : ['从 Windows 凭据管理器读取 API Key（不显示值）', ...(reconnect ? ['上次连接超时，重新建立连接 … 成功'] : []), '请求账号信息 … 成功，并发上限 4（示例）', '结果：一切正常，往返 0.3 秒（价格为示例值，接入时联网查证）'];
    logDialog(`测试连接：${esc(g.name)}`, lines, () => { if (reconnect) { st.vidB = 'ok'; save(); } toast(`${esc(g.name)} ${reconnect ? '已重新连接' : '测试完成'}`); });
  };
  const askKey = (g, done) => modal({
    title: `填写 ${esc(g.name)} 的 API Key`,
    body: `<div class="form-row"><label for="gk-k">API Key</label><input class="input" id="gk-k" type="password" autocomplete="off" placeholder="${st.sfxKey ? `已保存，结尾 …${st.sfxKey}。留空则不修改` : '粘贴密钥'}"></div>
      <p class="note" style="margin:0;color:var(--fg-3)">${ic('key')} 密钥存进 Windows 凭据管理器，不写进任何配置文件；界面上只显示末四位。</p>`,
    onOpen(d) { $('#gk-k', d).focus(); $('#gk-k', d).addEventListener('keydown', (e) => { if (e.key === 'Enter') $('.dlg-foot .btn.primary', d).click(); }); },
    actions: [{ label: '取消' }, { label: '保存并测试', kind: 'primary', onClick(d) {
      const k = $('#gk-k', d).value.trim();
      if (!k && !st.sfxKey) { toast('先粘贴 API Key', 'attn'); $('#gk-k', d).focus(); return false; }
      if (k) st.sfxKey = k.slice(-4);
      save(); toast(`已保存 ${esc(g.name)} 的 API Key（存进凭据管理器），连接正常`); done?.();
    } }],
  });
  const downloadModel = (m, btn) => {
    if (st.comfy !== 'ok') return toast('先安装并连接 ComfyUI，再下载模型', 'attn');
    if (btn.getAttribute('aria-busy') === 'true') return;
    let p = 0; btn.setAttribute('aria-busy', 'true');
    const t = setInterval(() => {
      p += 20; btn.textContent = `下载中 ${p}%`;
      if (p >= 100) { clearInterval(t); st.models[m] = true; save(); toast(`已下载 ${MODELS[m][0]}（${MODELS[m][1]}，示例）`); }
    }, 260);
  };
  const comfyMenu = (btn) => menu(btn, [
    ['打开 ComfyUI 界面', () => toast(`会在浏览器里打开 ${esc(st.addr)}（ComfyUI 自己的节点编辑界面）`, 'demo')],
    ['测试连接', () => testConn(genOf('comfyui'))],
    [st.comfy === 'stopped' ? '启动服务' : '停止服务', () => { st.comfy = st.comfy === 'stopped' ? 'ok' : 'stopped'; save(); toast(st.comfy === 'ok' ? 'ComfyUI 已启动' : 'ComfyUI 已停止，显卡空出来了'); }],
    ['在能力页管理生成器', () => { location.href = 'capabilities.html#gen'; }],
    ['卸载…', () => modal({ title: '卸载 ComfyUI？', body: '<p>会删除 %LOCALAPPDATA%\\AI_Console\\comfyui 整个文件夹，包括下载的模型。已经采用进项目的生成结果不受影响。</p>',
      actions: [{ label: '取消' }, { label: '卸载', kind: 'danger', onClick() { st.comfy = 'none'; Object.keys(st.models).forEach((k) => { st.models[k] = false; }); save(); toast('已卸载 ComfyUI，回到首次使用的状态'); } }] }), 'danger'],
  ]);
  // 生成记录：.aic/generations/<id>.json，和采用的文件放在一起
  const recModal = (rec, again) => modal({
    title: `生成记录 · ${esc(rec.id)}`, wide: true,
    body: `<dl class="kv"><dt>生成器</dt><dd>${esc(rec.generator)}</dd><dt>工作流</dt><dd>${esc(rec.workflow)}</dd>
        <dt>提示词</dt><dd>${esc(rec.prompt || '—')}</dd>${rec.negative ? `<dt>反向提示词</dt><dd>${esc(rec.negative)}</dd>` : ''}
        <dt>seed</dt><dd class="mono">${rec.seed}</dd><dt>参数</dt><dd>${esc(Object.entries(rec.params).map(([k, v]) => `${k} ${v}`).join('，') || '—')}</dd>
        <dt>耗时</dt><dd>${esc(rec.duration)}</dd><dt>费用</dt><dd>${esc(rec.cost)}</dd><dt>文件</dt><dd class="mono" style="font-size:12px">.aic/generations/${esc(rec.id)}.json</dd></dl>
      <pre class="genrec" tabindex="0" aria-label="生成记录 JSON">${esc(JSON.stringify(rec, null, 2))}</pre>`,
    actions: again ? [{ label: '关闭' }, { label: '用相同参数再生成', kind: 'primary', onClick: again }] : [{ label: '关闭' }],
  });
  Object.assign(window, { aicGen: { st, GENS, genOf, stateOf, ready, install, detect, testConn, askKey } });

  // ================= 生成页 =================
  if (page === 'generate') (function () {
    const SB = window.aicSB;
    const cards = $('#gen-cards'), form = $('#gen-form'), qul = $('#gen-queue'), res = $('#gen-results'), live = $('#gen-live'), budgetBtn = $('#gen-budget');
    const say = (t) => { live.textContent = ''; later(40, () => { live.textContent = t; }); };
    // 默认选云端图片服务；本机工具（ComfyUI）的安装和入门模板只在选中它时出现，不是整页的默认流程
    const cur = { gen: 'img-a', tpl: { comfyui: 't2i' }, vals: {}, ref: {} };
    const rnd = () => 1 + Math.floor(Math.random() * 2 ** 31);
    // 从资产页跳过来：?ref=chest.glb，预先选为参考图
    const pre = new URLSearchParams(location.search).get('ref');
    if (pre && assetOf(pre)) {
      cur.ref.comfyui = cur.ref['img-a'] = cur.ref['vid-b'] = pre;
      if (st.comfy === 'ok') { cur.gen = 'comfyui'; cur.tpl.comfyui = 'i2i'; }
      later(300, () => toast(`已把“${esc(assetOf(pre).name)}”设为参考图${st.comfy === 'ok' ? '，用本机 ComfyUI 的“图生图”模板' : ''}`));
    }

    // ---------- 预算 ----------
    const paintBudget = () => {
      const p = Math.min(100, (st.used / st.limit) * 100);
      budgetBtn.classList.toggle('over', p >= 90);
      budgetBtn.innerHTML = `${ic('coin')}<span>今日已用 ${usd(st.used)} / 上限 ${usd(st.limit)}</span><span class="bar" aria-hidden="true"><i style="width:${p}%"></i></span><span class="ex">示例</span>`;
      budgetBtn.setAttribute('aria-label', `本页今天的生成费用：已用 ${usd(st.used)}，上限 ${usd(st.limit)}，金额为示例。点击调整上限`);
      budgetBtn.title = '本页手动生成今天的费用（示例金额）；Agent 在任务里调用时另按每个任务的预算计算';
    };
    budgetBtn.addEventListener('click', () => modal({
      title: '生成预算',
      body: `<p>本页手动生成今天已用 <b>${usd(st.used)}</b>（示例金额）。本机 ComfyUI 不计费。</p>
        <div class="form-row"><label for="bg-l">每日上限（美元）</label><input class="input" id="bg-l" type="number" min="1" step="1" value="${st.limit}"></div>
        <label class="check-row"><input type="checkbox" checked> <span>达到上限时暂停所有付费生成<small>本机生成不受影响。Agent 在任务里调用生成器时，按每个任务单独设的预算（次数或费用）计算</small></span></label>`,
      actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) {
        const v = +$('#bg-l', d).value; if (!(v > 0)) { toast('上限要大于 0', 'attn'); return false; }
        st.limit = v; save(); paintEst(); toast(`每日上限改为 ${usd(v)}（示例）`);
      } }],
    }));

    // ---------- 生成器卡片（单选组） ----------
    const cardActs = (g) => {
      if (isComfy(g)) {
        if (installing) return `<button type="button" class="btn sm" data-op="install">${ic('download')}查看安装进度</button>`;
        if (st.comfy === 'none') return `<button type="button" class="btn sm primary" data-op="install">${ic('download')}一键安装 ComfyUI</button><button type="button" class="btn sm" data-op="detect">${ic('scan')}我已安装，自动检测</button>`;
        if (st.comfy === 'stopped') return `<button type="button" class="btn sm" data-op="start">${ic('play')}启动服务</button>`;
        return `<button type="button" class="btn sm" data-op="tpls">${ic('layers')}入门模板</button><button type="button" class="btn sm ghost" data-op="menu" aria-label="ComfyUI 的更多操作">${ic('more')}更多</button>`;
      }
      if (st.on[g.id] === false) return `<button type="button" class="btn sm" data-op="enable">${ic('play')}启用</button>`;
      if (g.id === 'sfx-c' && !st.sfxKey) return `<button type="button" class="btn sm" data-op="key">${ic('key')}填写 API Key</button>`;
      if (g.id === 'vid-b' && st.vidB !== 'ok') return `<button type="button" class="btn sm" data-op="reconnect">${ic('refresh')}重新连接</button>`;
      return '';
    };
    const renderCards = () => {
      const a = document.activeElement, c = a?.closest?.('.gcard'), fx = c ? [c.dataset.gen, a.dataset.op] : null;
      cards.innerHTML = allGens().map((g) => {
        const sel = cur.gen === g.id, acts = cardActs(g), [, stt] = stateOf(g);
        return `<div class="gcard" data-gen="${g.id}">
          <button type="button" role="radio" class="gpick" aria-checked="${sel}" tabindex="${sel ? 0 : -1}" data-pick aria-label="${esc(g.name)}，${esc(where(g))}，${stt}"><span class="gi" aria-hidden="true">${ic(g.icon)}</span><b>${esc(g.name)}</b><span class="w">${esc(where(g))}</span></button>
          <div class="gst">${statusHtml(g)}<span class="grow"></span>${g.local ? `<span class="tag-lock" title="本机显卡一次只跑一个生成任务，其他本机任务排队">${ic('lock')}${concText(g)}</span>` : `<span class="ex-tag">${g.price ? `${usd(g.price)}/${g.unit} · 示例价格` : '示例'}</span>`}</div>
          ${acts ?`<div class="gacts">${acts}</div>` : ''}</div>`;
      }).join('');
      if (fx) ($(`.gcard[data-gen="${fx[0]}"] ${fx[1] ? `[data-op="${fx[1]}"]` : '[data-pick]'}`) || $(`.gcard[data-gen="${fx[0]}"] [data-pick]`))?.focus();
    };
    const selectGen = (id) => {
      collect(); cur.gen = id; renderCards(); renderForm();
      $(`.gcard[data-gen="${id}"] [data-pick]`)?.focus();
    };
    const opRun = (op, g, btn) => ({
      install, detect, menu: () => comfyMenu(btn),
      start: () => { st.comfy = 'ok'; save(); toast('ComfyUI 已启动'); },
      key: () => askKey(genOf('sfx-c')),
      reconnect: () => testConn(g),
      tpls: () => { if (cur.gen !== 'comfyui') selectGen('comfyui'); later(0, () => { $('.tpls input:checked', form)?.focus(); $('.tpls', form)?.scrollIntoView({ block: 'nearest' }); }); },
      enable: () => { st.on[g.id] = true; save(); toast(`已启用 ${esc(g.name)}`); },
    })[op]?.();
    cards.addEventListener('click', (e) => {
      const c = e.target.closest('.gcard'); if (!c) return;
      const g = genOf(c.dataset.gen), b = e.target.closest('[data-op]');
      if (b) return opRun(b.dataset.op, g, b);
      if (e.target.closest('[data-pick]')) selectGen(g.id);
    });
    cards.addEventListener('keydown', (e) => {
      if (!e.target.matches('[data-pick]') || !['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
      e.preventDefault();
      const ids = allGens().map((g) => g.id), i = ids.indexOf(cur.gen), d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
      selectGen(ids[(i + d + ids.length) % ids.length]);
    });

    // ---------- 参数表单：按 schema 自动生成 ----------
    const valsOf = (gid) => (cur.vals[gid] ||= { seed: rnd() });
    const schemaOf = (g) => {
      if (isComfy(g)) { const t = tplOf(cur.tpl[g.id]) || tplsOf(g.id)[0]; return { tpl: t, kind: t.kind || 'image', look: t.look, fields: t.fields, prompt: t.prompt }; }
      return { tpl: null, kind: g.kind, ...(SCHEMA[g.id] || SCHEMA[g.kind]) };
    };
    const valOf = (g, sc, k, f) => {
      const v = valsOf(g.id);
      if (k === 'ref') return cur.ref[g.id];
      if (k === 'prompt' || k === 'sdesc') return v._edited ? v[k] : sc.prompt || '';
      return v[k] ?? f.def ?? f.opts?.[0] ?? '';
    };
    const countOf = (g, v) => +(v._n || v.count || v.ccount || v.vars || 1);
    const fieldHtml = ([k, f], val) => {
      const id = 'gf-' + k, req = f.req ? '<span class="req">必填</span>' : '';
      if (f.t === 'text') return `<div class="field"><label for="${id}">${f.label}${req}</label><textarea class="textarea" id="${id}" name="${k}" rows="${f.rows || 2}" placeholder="${esc(f.ph || '')}" ${f.req ? 'aria-required="true"' : ''}>${esc(val)}</textarea></div>`;
      if (f.t === 'select') return `<div class="field"><label for="${id}">${f.label}</label><select class="select" id="${id}" name="${k}">${f.opts.map((o) => `<option ${o === val ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
      if (f.t === 'number') return `<div class="field"><label for="${id}">${f.label}</label><input class="input" type="number" id="${id}" name="${k}" min="${f.min}" max="${f.max}" value="${esc(val)}"></div>`;
      if (f.t === 'seed') return `<div class="field"><label for="${id}">${f.label}</label><div class="seedrow"><input class="input" type="number" id="${id}" name="${k}" min="0" value="${esc(val)}"><button type="button" class="btn sm" data-op="dice" aria-label="随机换一个 seed">${ic('dice')}随机</button></div></div>`;
      const a = assetOf(val);
      return `<div class="field" role="group" aria-labelledby="${id}-l"><span class="lbl" id="${id}-l">${f.label}${req}</span><div class="refbox">
        ${a ? `<span class="refchip"><canvas width="32" height="32" data-asset="${a.id}" aria-hidden="true"></canvas><span title="${esc(a.file)}">${esc(a.name)}</span><button type="button" class="btn ghost icon sm" data-op="unref" aria-label="不用参考图 ${esc(a.name)}">${ic('x')}</button></span>` : '<span style="font-size:var(--fs-12);color:var(--fg-3)">没有选</span>'}
        <button type="button" class="btn sm" data-op="pickref" id="${id}">${ic('cube')}${a ? '换一张…' : '从资产库选…'}</button></div></div>`;
    };
    const alertBox = (kind, icon, title, text, btns) => `<div class="alert ${kind}" style="margin:0 0 var(--sp-3)">${ic(icon)}<div class="body"><strong>${title}</strong><p>${text}</p>${btns ? `<div class="actions" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">${btns}</div>` : ''}</div></div>`;
    const tplList = (g, sc) => `<fieldset style="border:0;padding:0;margin:0 0 var(--sp-2);min-width:0"><legend style="padding:0;margin-bottom:6px;font-size:var(--fs-12);color:var(--fg-2)">ComfyUI 入门模板（内置，选一个就能用）</legend>
      <ul class="tpls">${tplsOf(g.id).map((t) => `<li><label class="tpl"><input type="radio" name="tpl" value="${t.id}" ${t.id === sc.tpl.id ? 'checked' : ''}><span><span class="tn">${esc(t.name)}</span>${t.imported ? ' <span class="ex-tag">我的工作流</span>' : ''}<br><span class="td">${esc(t.desc)}</span></span>
        <ul class="models" aria-label="${esc(t.name)} 需要的模型">${t.models.map((m) => `<li><span class="mn">${MODELS[m][0]}</span>${st.models[m] ? '<span class="status ok"><span class="dot"></span>已下载</span>'
          : `<span class="status idle"><span class="dot"></span>未下载</span><button type="button" class="btn sm" data-op="dl" data-m="${m}" aria-label="下载 ${MODELS[m][0]}，${MODELS[m][1]}（示例大小）">${ic('download')}下载模型 · ${MODELS[m][1]}</button>`}</li>`).join('')}</ul></label></li>`).join('')}</ul>
      <p style="margin:0;font-size:11px;color:var(--fg-3)">模型名称和大小为示例。</p></fieldset>
      <div class="tpl-more">没有合适的？<button type="button" class="btn sm ghost" data-op="import">${ic('download')}导入工作流 JSON…</button></div>`;
    const renderForm = () => {
      const g = genOf(cur.gen) || allGens()[0], sc = schemaOf(g);
      let top = '';
      if (st.on[g.id] === false) top = alertBox('info', 'info', `${esc(g.name)} 已停用`, '启用后才能生成。也可以在能力页的“生成器”里管理。', `<button type="button" class="btn sm primary" data-op="enable">${ic('play')}启用</button>`);
      else if (isComfy(g) && st.comfy !== 'ok') top = installing ? alertBox('info', 'download', '正在安装 ComfyUI', '装好后这里就能生成。安装在后台进行，可以先看看模板。', `<button type="button" class="btn sm" data-op="install">查看进度</button>`)
        : st.comfy === 'stopped' ? alertBox('info', 'info', 'ComfyUI 没有运行', '启动后才能生成，显卡在 ComfyUI 停止期间是空闲的。', `<button type="button" class="btn sm primary" data-op="start">${ic('play')}启动服务</button>`)
        : alertBox('info', 'bulb', '第一次使用：先装 ComfyUI', 'ComfyUI 在你的显卡上生成图片和视频，不花钱。点下面的按钮，工作台会检测显卡、下载并装好，不需要命令行。装好后选一个内置模板就能开始。',
          `<button type="button" class="btn sm primary" data-op="install">${ic('download')}一键安装 ComfyUI</button><button type="button" class="btn sm" data-op="detect">${ic('scan')}我已安装，自动检测</button>`);
      else if (g.id === 'sfx-c' && !st.sfxKey) top = alertBox('attn', 'key', `${esc(g.name)} 需要 API Key`, '填一次就行，密钥存进 Windows 凭据管理器。', `<button type="button" class="btn sm primary" data-op="key">${ic('key')}填写 API Key</button>`);
      else if (g.id === 'vid-b' && st.vidB !== 'ok') top = alertBox('info', 'info', `${esc(g.name)} 没有连上`, '上次连接超时（示例）。重新连接后才能生成。', `<button type="button" class="btn sm primary" data-op="reconnect">${ic('refresh')}重新连接</button>`);
      const fields = sc.fields.map(norm);
      let html = '', buf = [];
      const flush = () => { if (buf.length) { html += buf.length > 1 ? `<div class="two">${buf.join('')}</div>` : buf[0]; buf = []; } };
      fields.forEach((nf) => { const h = fieldHtml(nf, valOf(g, sc, nf[0], nf[1])); if (nf[1].half) { buf.push(h); if (buf.length === 2) flush(); } else { flush(); html += h; } });
      flush();
      form.innerHTML = top + (sc.tpl ? tplList(g, sc) : '') + html + `<div class="gen-submit"><span class="est" id="gen-est"></span><span class="why" id="gen-why" role="status"></span>
        <button type="submit" class="btn primary" id="gen-go">${ic('wand')}生成</button><span style="font-size:11px;color:var(--fg-3)">Ctrl+Enter 提交 · 生成记录写到 .aic/generations/</span></div>`;
      $('#form-sub').textContent = `${g.name}${sc.tpl ? ' · ' + sc.tpl.name : ''}`;
      $$('canvas[data-asset]', form).forEach((cv) => paintAsset(cv, cv.dataset.asset));
      collect(); paintEst();
    };
    const collect = () => {
      const g = genOf(cur.gen); if (!g) return;
      const v = valsOf(g.id);
      $$('[name]', form).forEach((el) => { if (el.name !== 'tpl') v[el.name] = el.value; });
    };
    const gpuBusy = () => jobs.some((j) => (j.state === 'run' || j.state === 'queue') && j.gpu);
    const blockOf = (g, sc, v) => {
      if (!ready(g)) return st.on[g.id] === false ? '这个生成器已停用' : isComfy(g) ? (installing ? 'ComfyUI 正在安装，装好后才能生成' : st.comfy === 'stopped' ? 'ComfyUI 没有运行，先启动服务' : '先安装 ComfyUI（上面的 [一键安装 ComfyUI]）') : g.id === 'vid-b' ? '先重新连接视频服务 B' : `先填写 ${g.name} 的 API Key`;
      const m = missing(sc.tpl);
      if (m.length) return `这个模板需要的模型还没下载：${m.map((x) => `${MODELS[x][0]}（${MODELS[x][1]}，示例）`).join('、')}`;
      const cost = (g.price || 0) * countOf(g, v);
      if (cost && st.used + cost > st.limit + 1e-9) return `会超过今日生成上限 ${usd(st.limit)}，点右上角的预算调整`;
      return '';
    };
    const secsOf = (g, kind, v, n) => (kind === 'video' ? Math.round(parseFloat(v.vdur || 4) * +(v.fps || 24) * (g.local ? 0.7 : 0.4)) * n : g.local ? n * 9 : kind === 'audio' ? 2 + n : 12 + n * 2);
    const paintEst = () => {
      const g = genOf(cur.gen), est = $('#gen-est'); if (!g || !est) return;
      const sc = schemaOf(g), v = valsOf(g.id), n = countOf(g, v), why = blockOf(g, sc, v);
      est.textContent = g.price ? `预计费用 ${usd(g.price * n)}（${n} ${UNIT[sc.kind]} × ${usd(g.price)}，示例）`
        : `本机生成，不计费；预计占用显卡约 ${secsOf(g, sc.kind, v, n)} 秒${gpuBusy() && isExclusive(g) ? '。显卡正在用，会排队（独占）' : ''}`;
      $('#gen-why').textContent = why;
      $('#gen-go').setAttribute('aria-disabled', String(!!why));
      $('#gen-go').setAttribute('aria-describedby', 'gen-est gen-why');
    };
    form.addEventListener('change', (e) => {
      if (e.target.name === 'tpl') { collect(); cur.tpl[cur.gen] = e.target.value; renderForm(); $(`input[name="tpl"][value="${e.target.value}"]`, form)?.focus(); return; }
      collect(); paintEst();
    });
    form.addEventListener('input', (e) => {
      if (e.target.name === 'prompt' || e.target.name === 'sdesc') valsOf(cur.gen)._edited = true;
      if (e.target.name !== 'tpl') { collect(); paintEst(); }
    });
    form.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); form.requestSubmit(); } });
    form.addEventListener('click', (e) => {
      const b = e.target.closest('[data-op]'); if (!b) return;
      e.preventDefault();
      const g = genOf(cur.gen), op = b.dataset.op;
      if (op === 'dice') { const i = $('[name="seed"]', form); i.value = rnd(); collect(); toast(`seed 换成 ${i.value}`); }
      else if (op === 'pickref') pickRef(g);
      else if (op === 'unref') { delete cur.ref[g.id]; renderForm(); $('[data-op="pickref"]', form)?.focus(); }
      else if (op === 'dl') downloadModel(b.dataset.m, b);
      else if (op === 'import') importFlow();
      else opRun(op, g, b);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault(); collect();
      const g = genOf(cur.gen), sc = schemaOf(g), v = { ...valsOf(g.id) };
      const why = blockOf(g, sc, v);
      if (why) { toast(why, 'attn'); $('#gen-why').focus?.(); return; }
      for (const [k, f] of sc.fields.map(norm)) {
        if (!f.req) continue;
        if (k === 'ref' && !cur.ref[g.id]) { toast(`先选${f.label}`, 'attn'); $('[data-op="pickref"]', form)?.focus(); return; }
        if (k !== 'ref' && !String(v[k] || '').trim()) { toast(`先写${f.label}`, 'attn'); $(`[name="${k}"]`, form)?.focus(); return; }
      }
      const j = enqueue({ gen: g.id, sc, v, ref: cur.ref[g.id] });
      toast(j.state === 'queue' ? `#${j.id} 已加入队列：显卡被占用（独占），前一个任务完成后自动开始` : `#${j.id} 已开始生成`);
    });

    // ---------- 从资产库选参考图 ----------
    const pickRef = (g) => {
      let sel = cur.ref[g.id] || null;
      modal({
        title: '从资产库选参考图', wide: true,
        body: `<p>示例资产来自项目“雾港物语”。模型类资产用当前预览的截图作为参考图。</p>
          <div class="agrid" role="group" aria-label="资产">${ASSETS.map((a) => `<button type="button" class="apick" data-wired="1" data-a="${a.id}" aria-pressed="${a.id === sel}"><canvas width="120" height="120" aria-hidden="true"></canvas><span>${esc(a.name)}</span><span class="sub">${a.kind}</span></button>`).join('')}</div>`,
        onOpen(d) {
          $$('.apick', d).forEach((b) => {
            paintAsset($('canvas', b), b.dataset.a);
            b.addEventListener('click', () => { sel = b.dataset.a; $$('.apick', d).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
            b.addEventListener('dblclick', () => $('.dlg-foot .btn.primary', d).click());
          });
          ($('.apick[aria-pressed="true"]', d) || $('.apick', d)).focus();
        },
        actions: [{ label: '取消' }, { label: '使用这张', kind: 'primary', onClick() {
          if (!sel) { toast('先选一张', 'attn'); return false; }
          collect(); cur.ref[g.id] = sel; renderForm(); $('[data-op="pickref"]', form)?.focus();
          toast(`参考图：${esc(assetOf(sel).name)}`);
        } }],
      });
    };
    // ---------- 导入工作流 JSON（次要入口） ----------
    const importFlow = () => modal({
      title: '导入工作流 JSON', wide: true,
      body: `<p>在 ComfyUI 里用“保存（API 格式）”存下的工作流可以导入。工作台识别其中的输入节点，你勾选的会变成表单，其余节点保持原样。</p>
        <div class="form-row"><span class="lbl">文件</span><div style="display:flex;gap:8px;min-width:0"><input class="input" id="wf-f" readonly placeholder="还没有选择" aria-label="工作流文件" style="flex:1;min-width:0"><button type="button" class="btn" data-wired="1" id="wf-pick">${ic('folder')}选择文件…</button></div></div>
        <div id="wf-res" aria-live="polite"></div>`,
      onOpen(d) {
        $('#wf-pick', d).addEventListener('click', () => {
          $('#wf-f', d).value = 'D:\\Downloads\\fog_harbor_props.json';
          toast('原型模拟文件对话框：选了 fog_harbor_props.json', 'demo');
          $('#wf-res', d).innerHTML = `<p>识别到 ${NODES.length} 个输入节点，其余 23 个节点保持原样。需要的模型：SDXL 基础模型（${st.models.base ? '已下载' : '未下载'}）。</p>
            <fieldset style="border:0;padding:0;margin:0 0 var(--sp-3)"><legend style="padding:0;color:var(--fg-1)">把哪些输入暴露成表单</legend>
            <ul class="nodes">${NODES.map(([n, l, k, on]) => `<li><label><input type="checkbox" value="${k}" ${on ? 'checked' : ''}>${l}<code>${n}</code></label></li>`).join('')}</ul></fieldset>
            <div class="form-row"><label for="wf-n">名称</label><input class="input" id="wf-n" value="雾港道具（我的工作流）"></div>`;
          $('#wf-res input', d).focus();
        });
      },
      actions: [{ label: '取消' }, { label: '导入', kind: 'primary', onClick(d) {
        if (!$('#wf-res .nodes', d)) { toast('先选择工作流文件', 'attn'); $('#wf-pick', d).focus(); return false; }
        const ks = $$('#wf-res .nodes input:checked', d).map((i) => i.value);
        if (!ks.length) { toast('至少勾选一个输入', 'attn'); return false; }
        const t = { id: 'imp' + Date.now(), gen: 'comfyui', look: 't2i', name: $('#wf-n', d).value.trim() || 'fog_harbor_props.json', desc: 'fog_harbor_props.json · 导入，其余节点保持原样', ver: '修改于今天 · 哈希 3f9a…c21', models: ['base'],
          fields: ['ref', 'prompt', 'neg', 'size', 'steps', 'cfg', 'seed'].filter((k) => ks.includes(k)), imported: true, prompt: '雾港风格的码头道具，手绘' };
        st.imported.push(t); cur.tpl.comfyui = t.id; cur.gen = 'comfyui'; save();
        toast(`已导入“${esc(t.name)}”，暴露了 ${ks.length} 个输入`);
      } }],
    });

    // ---------- 队列：本机独占的任务一次只跑一个，云端的同时跑 ----------
    const jobs = []; let seq = 0;
    const TYPEKEY = { 脚步: 'footstep', 'UI 点击': 'ui_click', 爆炸: 'explosion', 环境: 'ambience' };
    const titleOf = (j) => `#${j.id} ${j.tplName} · ${j.g.name}`;
    const qempty = () => { if (!qul.children.length) qul.innerHTML = '<li class="qempty">队列是空的。本机 ComfyUI 一次只跑一个任务（独占），其他本机任务排队；云端生成器按账号并发上限同时跑。</li>'; };
    const paintQueueSub = () => {
      const r = jobs.filter((j) => j.state === 'run').length, q = jobs.filter((j) => j.state === 'queue').length;
      $('#queue-sub').textContent = r || q ? `运行中 ${r} · 排队 ${q}` : '';
    };
    const enqueue = (spec) => {
      const g = genOf(spec.gen), v = { ...spec.v }, n = countOf(g, v);
      const kind = spec.sc.kind || g.kind;
      const j = { id: ++seq, g, kind, sc: spec.sc, v, ref: spec.ref, n, pct: 0, last: -1, state: 'queue', gpu: isExclusive(g), local: !!g.local, cost: (g.price || 0) * n, tplName: spec.sc.tpl ? spec.sc.tpl.name : `${{ image: '图片', audio: '音效', video: '视频' }[kind]}生成`, created: new Date() };
      j.ms = kind === 'video' ? 7000 : g.local ? 1600 + n * 700 : kind === 'audio' ? 1400 + n * 200 : 2600;
      j.secs = secsOf(g, kind, v, n);
      if (kind === 'audio') j.prev = synth({ type: v.stype, dur: parseFloat(v.sdur), seed: +v.seed || 1 });
      jobs.push(j); addRow(j); pump(); paintQueueSub(); paintEst();
      say(`已加入队列：${titleOf(j)}`);
      return j;
    };
    const pump = () => {
      let busy = jobs.some((j) => j.state === 'run' && j.gpu);
      jobs.filter((j) => j.state === 'queue').forEach((j) => { if (j.gpu) { if (busy) return; busy = true; } j.state = 'run'; j.t0 = Date.now(); say(`${titleOf(j)} 开始生成`); });
      jobs.forEach(paintRow); paintQueueSub();
    };
    setInterval(() => {
      let fin = false;
      jobs.forEach((j) => { if (j.state !== 'run') return; j.pct = Math.min(100, ((Date.now() - j.t0) / j.ms) * 100); if (j.pct >= 100) { finish(j); fin = true; } else paintRow(j); });
      if (fin) { pump(); paintEst(); }
    }, 200);
    const finish = (j) => {
      j.state = 'done'; j.pct = 100; st.used += j.cost; save(); paintBudget();
      addBatch(j); paintRow(j);
      toast(`${titleOf(j)} 完成：${j.n} ${UNIT[j.kind]}${j.cost ? `，${usd(j.cost)}（示例）` : ''}`); say(`${titleOf(j)} 完成`);
    };
    const addRow = (j) => {
      $('.qempty', qul)?.remove();
      const text = j.v.prompt || j.v.sdesc || '';
      qul.insertAdjacentHTML('beforeend', `<li class="qrow" data-job="${j.id}"><canvas width="128" height="128" aria-hidden="true"></canvas>
        <span class="qt" title="${esc(text)}">${esc(titleOf(j))}：${esc(text)}</span>
        <button type="button" class="btn sm ghost" data-op="cancel"></button>
        <span class="qs"><span class="status" data-s><span class="dot"></span></span><span class="qbar" role="progressbar" aria-label="任务 #${j.id} 进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></span><span class="pct">0%</span></span></li>`);
      j.row = qul.lastElementChild;
    };
    const paintRow = (j) => {
      const r = j.row; if (!r || !r.isConnected) return;
      const p = Math.round(j.pct), s = $('[data-s]', r), b = $('[data-op]', r);
      r.className = 'qrow ' + (j.state === 'queue' ? 'queued' : j.state);
      const steps = +(j.v.steps || 24), frames = Math.round(parseFloat(j.v.vdur || 4) * +(j.v.fps || 24));
      const [cls, txt] = {
        queue: ['wait', j.gpu ? '排队中：显卡被占用（独占）' : '排队中：等账号的并发空位'],
        run: ['run', j.kind === 'video' ? `生成中 · 第 ${Math.max(1, Math.round((p / 100) * frames))}/${frames} 帧` : j.local ? `生成中 · 第 ${Math.max(1, Math.round((p / 100) * steps))}/${steps} 步` : '生成中'],
        done: ['ok', `已完成 · 用时 ${j.secs} 秒${j.cost ? ` · ${usd(j.cost)}（示例）` : ' · 本机不计费'}`],
        cancel: ['idle', '已取消，没有计费'],
      }[j.state];
      s.className = 'status ' + cls; s.innerHTML = `<span class="dot"></span>${txt}`;
      $('.qbar i', r).style.width = (j.state === 'queue' ? 100 : p) + '%';
      $('.qbar', r).setAttribute('aria-valuenow', j.state === 'queue' ? 0 : p);
      $('.pct', r).textContent = j.state === 'queue' ? '等待' : `${p}%`;
      const op = j.state === 'done' ? 'view' : j.state === 'cancel' ? 'remove' : 'cancel';
      if (b.dataset.op !== op || !b.innerHTML) {
        b.dataset.op = op;
        b.innerHTML = op === 'view' ? `${ic('eye')}查看结果` : op === 'remove' ? `${ic('trash')}移除` : `${ic('x')}取消`;
        b.setAttribute('aria-label', `${op === 'view' ? '查看结果' : op === 'remove' ? '从队列移除' : '取消'}：任务 #${j.id}`);
      }
      if (Math.abs(p - j.last) < 4 && j.state === 'run') return;
      j.last = p;
      const cv = $('canvas', r), t = j.state === 'done' ? 1 : j.state === 'run' ? p / 100 : 0;
      if (j.kind === 'audio') { cv.getContext('2d').clearRect(0, 0, 128, 128); drawWave(cv, j.prev, t); }
      else if (j.kind === 'video') vframe(cv, { seed: +j.v.seed || 1, ref: j.ref }, 0, 1, 1 - t);
      else paint(cv, { seed: +j.v.seed || 1, look: j.sc.look, t: Math.max(0.02, t), ref: j.ref });
    };
    qul.addEventListener('click', (e) => {
      const b = e.target.closest('[data-op]'); if (!b) return;
      const j = jobs.find((x) => x.id === +b.closest('.qrow').dataset.job); if (!j) return;
      if (b.dataset.op === 'cancel') {
        const was = j.state; j.state = 'cancel'; paintRow(j); pump(); paintEst();
        toast(`已取消 #${j.id}${was === 'run' && j.gpu ? '，显卡已空出，下一个任务自动开始' : ''}。没完成的任务不计费（示例）`);
        b.focus();
      } else if (b.dataset.op === 'remove') {
        const next = j.row.nextElementSibling || j.row.previousElementSibling;
        j.row.remove(); jobs.splice(jobs.indexOf(j), 1); qempty(); paintQueueSub();
        ($('[data-op]', next || document.createElement('i')) || $('#gen-go'))?.focus();
      } else if (b.dataset.op === 'view') {
        const sec = $(`[data-batch="${j.id}"]`, res); sec?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        later(300, () => $('[data-op="adopt"]', sec)?.focus());
      }
    });

    // ---------- 结果网格：采用、打分、再生成、换 seed、发给 Agent、生成记录 ----------
    const items = new Map();
    const folders = (it) => {
      const j = it.j, k = j.kind, t = j.sc.tpl?.id;
      if (k === 'audio') return [`Assets/Audio/SFX/${{ 脚步: 'Footsteps', 'UI 点击': 'UI', 爆炸: 'Explosions', 环境: 'Ambience' }[j.v.stype] || 'Generated'}`, 'Assets/Audio/SFX/Generated'];
      if (k === 'video') return ['Assets/Video/Generated', 'Assets/Art/Props/Chest/Preview'];
      return t === 'tile' ? ['Assets/Art/Textures/Generated', 'Assets/Art/Props/Chest/Textures'] : t === 'icon' ? ['Assets/Art/UI/Icons', 'Assets/Art/UI/Generated']
        : t === 'char' ? ['Assets/Art/Characters/Concepts', 'Assets/Art/Characters/Lina'] : ['Assets/Art/Props/Chest/Textures', 'Assets/Art/Generated'];
    };
    const recOf = (it) => {
      const j = it.j, v = j.v, params = {};
      j.sc.fields.map(norm).forEach(([k, f]) => {
        if (['prompt', 'neg', 'sdesc', 'seed'].includes(k)) return;
        if (k === 'ref') { if (j.ref) params[f.label] = assetOf(j.ref).file; return; }
        if (v[k] != null) params[f.label] = v[k];
      });
      return { id: it.rid, generator: `${j.g.name}${j.local ? `（本机 ${st.addr}）` : ''}`,
        workflow: j.sc.tpl ? `${j.sc.tpl.name} ${j.sc.tpl.ver}${j.sc.tpl.imported ? '（导入）' : '（内置模板）'}` : `${j.g.name} 默认参数`,
        models: j.sc.tpl ? j.sc.tpl.models.map((m) => MODELS[m][0]) : undefined, prompt: v.prompt || v.sdesc || '', negative: v.neg || undefined, seed: it.seed, params,
        duration: `${(j.secs / j.n).toFixed(1)} 秒（整批 ${j.secs} 秒）`, cost: j.cost ? `${usd(j.cost / j.n)}（示例）` : '0（本机）', gpu: j.local ? `${Math.round(j.secs / j.n)} 秒` : '不占用',
        file: it.adopted || `缓存：%LOCALAPPDATA%\\AI_Console\\gen-cache\\${it.file}`, adopted: !!it.adopted, rating: it.rating || undefined, created: j.created.toISOString() };
    };
    const cardHtml = (it) => {
      const k = it.j.kind, u = UNIT[it.j.kind];
      return `<li class="rcard" data-rid="${it.rid}">
        ${k === 'image' ? `<button type="button" class="rthumb" data-op="zoom" aria-label="放大查看 ${it.file}"><canvas width="256" height="256" aria-hidden="true"></canvas></button>` : '<div class="media"></div>'}
        <div class="rmeta"><span class="mono" title="${it.file}">${it.file}</span><span class="grow"></span><span>seed ${it.seed}</span></div>
        <div class="radopt" hidden></div>
        <div class="racts"><button type="button" class="btn sm primary" data-op="adopt" aria-label="采用 ${it.file}">${ic('check')}采用</button>
          <span class="stars" role="radiogroup" aria-label="给 ${it.file} 打分">${[1, 2, 3, 4, 5].map((s) => `<button type="button" role="radio" aria-checked="false" tabindex="${s === 1 ? 0 : -1}" data-star="${s}" aria-label="${s} 分">${ic('star')}</button>`).join('')}</span><span class="sv" aria-hidden="true">未打分</span>
          <span class="grow"></span>
          <button type="button" class="btn sm ghost icon" data-op="again" aria-label="用相同参数再生成 ${it.file}" title="用相同参数再生成">${ic('refresh')}</button>
          <button type="button" class="btn sm ghost icon" data-op="reseed" aria-label="只换 seed 再来 4 ${u}" title="只换 seed 再来 4 ${u}">${ic('dice')}</button>
          <button type="button" class="btn sm ghost icon" data-op="agent" aria-label="把 ${it.file} 发给 Agent" title="发给 Agent">${ic('send')}</button>
          <button type="button" class="btn sm ghost icon" data-op="rec" aria-label="查看 ${it.file} 的生成记录" title="查看生成记录">${ic('file')}</button></div></li>`;
    };
    const addBatch = (j) => {
      $('.empty', res)?.remove();
      const seed0 = +j.v.seed || 1, k = j.kind;
      const its = Array.from({ length: j.n }, (_, i) => {
        const seed = seed0 + i, rid = `g_${ymd(j.created)}_${String(j.id).padStart(3, '0')}${String.fromCharCode(97 + i)}`;
        const file = k === 'audio' ? `sfx_${TYPEKEY[j.v.stype] || 'sound'}_${seed % 100000}.wav` : k === 'video' ? `vid_${seed % 100000}.mp4` : `${String(j.sc.tpl?.id || 'img').replace(/^imp\d+/, 'wf')}_${seed % 100000}.png`;
        const it = { j, i, seed, rid, file, rating: 0, adopted: null }; items.set(rid, it); return it;
      });
      res.insertAdjacentHTML('afterbegin', `<section class="rbatch" data-batch="${j.id}" aria-labelledby="rb-${j.id}">
        <div class="rbatch-h"><b id="rb-${j.id}">#${j.id} ${esc(j.tplName)}</b><span class="sub">${esc(j.g.name)} · ${j.n} ${UNIT[j.kind]} · ${j.created.toTimeString().slice(0, 5)} · 用时 ${j.secs} 秒 · ${j.cost ? `${usd(j.cost)}（示例）` : '本机，不计费'}</span></div>
        <ul class="rgrid ${k === 'image' ? '' : 'wide'}">${its.map(cardHtml).join('')}</ul></section>`);
      const sec = res.firstElementChild;
      its.forEach((it) => {
        const li = $(`[data-rid="${it.rid}"]`, sec);
        if (k === 'image') paint($('canvas', li), { seed: it.seed, look: j.sc.look, ref: j.ref });
        else if (k === 'audio') { it.samples = synth({ type: j.v.stype, dur: parseFloat(j.v.sdur), seed: it.seed }); mountWave($('.media', li), it.samples, parseFloat(j.v.sdur), it.file); }
        else mountVideo($('.media', li), { seed: it.seed, ref: j.ref }, parseFloat(j.v.vdur), +j.v.fps, it.file);
      });
    };
    const rerun = (it, reseed) => {
      const j = it.j, v = { ...j.v };
      if (reseed) { v.seed = rnd(); v._n = 4; } else v.seed = it.seed;
      if (!reseed) v._n = 1;
      const why = blockOf(j.g, j.sc, v);
      if (why) return toast(why, 'attn');
      const nj = enqueue({ gen: j.g.id, sc: j.sc, v, ref: j.ref });
      toast(reseed ? `#${nj.id}：参数不变，seed 换成 ${v.seed}，再来 4 ${UNIT[j.kind]}` : `#${nj.id}：用相同参数（seed ${it.seed}）再生成`);
    };
    const adopt = (it, li) => {
      if (it.adopted) return toast(`已经采用：${esc(it.adopted)}`);
      const fs = folders(it), SBp = SB?.projects || [{ name: '雾港物语' }];
      modal({
        title: `采用 ${esc(it.file)}`,
        body: `<p>把这个结果复制进项目的资产目录，生成记录一起保存。没采用的结果留在缓存里，7 天后清理。</p>
          <div class="form-row"><label for="ad-p">项目</label><select class="select" id="ad-p">${SBp.map((p) => `<option>${esc(p.name)}</option>`).join('')}</select></div>
          <div class="form-row"><label for="ad-f">目标文件夹</label><select class="select" id="ad-f">${fs.map((f) => `<option>${f}</option>`).join('')}<option value="__pick">选择其他文件夹…</option></select></div>
          <div class="form-row"><label for="ad-n">文件名</label><input class="input" id="ad-n" value="${esc(it.file)}"></div>
          <p style="margin:0;color:var(--fg-3)">生成记录：<span class="mono" style="font-size:12px">.aic/generations/${it.rid}.json</span>。有任务在跑时，文件写进当前任务的工作副本，出现在“改动”面板里。</p>`,
        onOpen(d) {
          $('#ad-f', d).addEventListener('change', (e) => {
            if (e.target.value !== '__pick') return;
            toast('原型模拟文件夹对话框：选了 Assets/Art/Props/Chest', 'demo');
            e.target.insertAdjacentHTML('afterbegin', '<option>Assets/Art/Props/Chest</option>'); e.target.selectedIndex = 0;
          });
        },
        actions: [{ label: '取消' }, { label: '采用', kind: 'primary', onClick(d) {
          const name = $('#ad-n', d).value.trim();
          if (!name) { toast('文件名不能为空', 'attn'); $('#ad-n', d).focus(); return false; }
          it.adopted = `${$('#ad-f', d).value}/${name}`;
          li.classList.add('adopted');
          const ad = $('.radopt', li); ad.hidden = false; ad.innerHTML = `${ic('check')} 已采用：${esc($('#ad-p', d).value)} · <span class="mono" style="font-size:11.5px">${esc(it.adopted)}</span>`;
          const b = $('[data-op="adopt"]', li); b.innerHTML = `${ic('check')}已采用`; b.classList.remove('primary'); b.setAttribute('aria-label', `已采用 ${it.file}，位置 ${it.adopted}`);
          toast(`已采用，写进 ${esc(it.adopted)}；记录在 .aic/generations/${it.rid}.json`);
        } }],
      });
    };
    const toAgent = (it) => {
      const d = window.aicNewTask?.({ proj: '雾港物语' }); if (!d) return;
      const ta = $('#nt-d', d), g = it.j.g;
      ta.value = `参考附带的生成结果 ${it.file}（${g.name}，seed ${it.seed}），${it.j.kind === 'audio' ? '接进 Wwise 事件表，替换现在的占位音效' : it.j.kind === 'video' ? '剪进宣传片的开场' : '用在宝箱模型上，材质名不要改'}。`;
      const att = `<span class="attach" style="margin:0">${ic(KIND_ICON[it.j.kind])}${esc(it.file)}<span class="mono" style="font-size:11px">生成记录 ${it.rid}</span></span>`;
      const slot = $('.nt-attach', d); // 起始页有附件位；兜底的对话框插在描述下面
      if (slot) slot.insertAdjacentHTML('beforeend', att);
      else ta.closest('.form-row')?.insertAdjacentHTML('afterend', `<div class="form-row"><span class="lbl">附件</span><span>${att}</span></div>`);
      ta.dispatchEvent(new Event('input'));
      toast('已打开新建任务，附上了这个结果和它的生成记录');
    };
    const zoom = (it) => modal({
      title: esc(it.file), wide: true,
      body: `<canvas width="512" height="512" style="width:100%;max-width:512px;height:auto;display:block;margin:0 auto;border-radius:8px" role="img" aria-label="${esc(it.file)} 的放大预览（示例图）"></canvas>`,
      onOpen(d) { paint($('canvas', d), { seed: it.seed, look: it.j.sc.look, ref: it.j.ref }); },
      actions: [{ label: '关闭' }, { label: it.adopted ? '已采用' : '采用…', kind: 'primary', onClick() { later(0, () => adopt(it, $(`[data-rid="${it.rid}"]`, res))); } }],
    });
    const rate = (li, it, n) => {
      it.rating = n;
      $$('[data-star]', li).forEach((b) => { const on = +b.dataset.star <= n; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(+b.dataset.star === n)); b.tabIndex = +b.dataset.star === n ? 0 : -1; });
      $('.sv', li).textContent = `${n}/5`;
    };
    res.addEventListener('click', (e) => {
      const li = e.target.closest('.rcard'); if (!li) return;
      const it = items.get(li.dataset.rid), st0 = e.target.closest('[data-star]'), b = e.target.closest('[data-op]');
      if (st0) { rate(li, it, +st0.dataset.star); toast(`${esc(it.file)}：${st0.dataset.star} 分，评分会写进生成记录`); return; }
      if (!b) return;
      ({ adopt: () => adopt(it, li), again: () => rerun(it, false), reseed: () => rerun(it, true), agent: () => toAgent(it), zoom: () => zoom(it),
        rec: () => recModal(recOf(it), () => rerun(it, false)) })[b.dataset.op]?.();
    });
    res.addEventListener('keydown', (e) => {
      const s = e.target.closest('[data-star]'); if (!s) return;
      const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key]; if (!d) return;
      e.preventDefault();
      const li = s.closest('.rcard'), n = Math.min(5, Math.max(1, +s.dataset.star + d));
      rate(li, items.get(li.dataset.rid), n); $(`[data-star="${n}"]`, li).focus();
    });

    // ---------- 启动：上午已有一批图片服务 A（示例）的结果（今日已用的 $1.20 包含它），队列为空 ----------
    paintBudget(); renderCards(); renderForm(); qempty();
    const seedJob = (() => {
      const g = genOf('img-a'), d = new Date(); d.setHours(10, 12, 0, 0);
      return { id: ++seq, g, kind: 'image', sc: { tpl: null, kind: 'image', ...SCHEMA['img-a'] }, v: { prompt: '雾港码头的旧木箱，海盐侵蚀，手绘风格', size: '1024×1024', ccount: '2', style: '手绘', seed: 4127 }, ref: null, n: 2, state: 'done', cost: 0.08, secs: 16, local: false, tplName: '图片生成', created: d };
    })();
    addBatch(seedJob);
    let sig = '';
    const onChange = () => {
      paintBudget();
      const s = JSON.stringify([st.comfy, st.models, st.sfxKey, st.on, st.imported.length, !!installing]);
      if (s !== sig) { sig = s; collect(); renderCards(); renderForm(); return; }
      $$('.gcard').forEach((c) => { const g = genOf(c.dataset.gen), sp = $('.gst .status', c), [cl, t] = stateOf(g); sp.className = 'status ' + cl; sp.innerHTML = `<span class="dot"></span>${t}`; });
    };
    sig = JSON.stringify([st.comfy, st.models, st.sfxKey, st.on, st.imported.length, !!installing]);
    document.addEventListener('aic-gen-change', onChange);
    document.addEventListener('themechange', () => $$('.wave canvas').forEach((cv) => { const it = items.get(cv.closest('.rcard')?.dataset.rid); if (it?.samples) drawWave(cv, it.samples); }));
  })();

  // ================= 能力页：“生成器”标签，和 MCP、Skill 并列 =================
  if (page === 'capabilities') (function () {
    const rows = $('#gen-rows'), side = $('#cap-detail'); if (!rows || !side) return;
    let sel = 'comfyui';
    const isOn = (g) => st.on[g.id] !== false;
    const tabOn = () => $('#ct-gen')?.getAttribute('aria-selected') === 'true';
    const kindTag = (g) => `<span class="tag">${ic(g.icon)}${g.kindText}</span>`;
    const concTag = (g) => (concText(g) === '独占排队' ? `<span class="tag lock" title="本机显卡一次只跑一个生成任务，其他排队">${ic('lock')}独占</span>` : '<span class="tag">共享</span>');
    const addrOf = (g) => (g.extra ? g.addr : st.addr);
    const ext = (g) => st.extra.find((x) => x.id === g.id);
    const key4Of = (g) => (g.id === 'sfx-c' ? st.sfxKey : g.extra ? ext(g)?.key4 : st.k4?.[g.id] || g.key4);
    const render = () => {
      const a = document.activeElement, rf = a?.closest?.('#gen-rows tr')?.dataset.id, so = side.contains(a) ? a.dataset.gop : null;
      $('#cnt-gen').textContent = allGens().length;
      rows.innerHTML = allGens().map((g) => `<tr data-id="${g.id}" tabindex="0" aria-selected="${g.id === sel}" class="${isOn(g) ? '' : 'off'}">
        <td class="c-name"><b>${esc(g.name)}</b><span class="sub">${g.tool}</span></td>
        <td class="c-type">${kindTag(g)}</td>
        <td class="c-recent">${g.local ? `本机 <span class="sub">${esc(addrOf(g))}</span>` : g.mcp ? `MCP<span class="sub">${esc(g.mcp)}</span>` : `云端<span class="sub">${esc(g.via ? g.via.split('，')[0] : 'API Key')}</span>`}</td>
        <td class="c-nowrap">${statusHtml(g)}</td>
        <td class="c-conc">${concTag(g)}</td>
        <td class="c-ver c-nowrap">${g.price ? `${usd(g.price)}/${g.unit}<span class="sub">示例</span>` : '不计费'}</td>
        <td class="c-sw"><button class="switch" role="switch" data-wired="1" data-gsw aria-checked="${isOn(g)}" aria-label="启用 ${esc(g.name)}"></button><span class="sw-t">${isOn(g) ? '启用' : '停用'}</span></td>
        <td class="c-more"><button class="btn ghost icon sm" data-wired="1" data-gmore aria-label="${esc(g.name)} 的更多操作" title="更多操作">${ic('more')}</button></td></tr>`).join('');
      if (tabOn()) window.aicGenSide(side);
      if (rf) $(`#gen-rows tr[data-id="${rf}"]`)?.focus();
      if (so) $(`[data-gop="${so}"]`, side)?.focus();
    };
    const sideHtml = (g) => {
      const on = isOn(g), tools = g.tool, acts = [];
      if (isComfy(g) && installing) acts.push(`<button class="btn sm" data-wired="1" data-gop="install">${ic('download')}查看安装进度</button>`);
      else if (isComfy(g) && st.comfy === 'none') acts.push(`<button class="btn sm primary" data-wired="1" data-gop="install">${ic('download')}一键安装 ComfyUI</button>`, `<button class="btn sm" data-wired="1" data-gop="detect">${ic('scan')}我已安装，自动检测</button>`);
      if (g.id === 'sfx-c') acts.push(`<button class="btn sm ${st.sfxKey ? '' : 'primary'}" data-wired="1" data-gop="key">${ic('key')}${st.sfxKey ? '更换 API Key' : '填写 API Key'}</button>`);
      acts.push(`<button class="btn sm" data-wired="1" data-gop="test">${ic('pulse')}测试连接</button>`, `<button class="btn sm" data-wired="1" data-gop="edit">${ic('edit')}编辑</button>`,
        `<button class="btn sm" data-wired="1" data-gop="toggle">${ic(on ? 'pause' : 'play')}${on ? '停用' : '启用'}</button>`, `<button class="btn sm ghost icon" data-wired="1" data-gop="more" aria-label="更多操作">${ic('more')}</button>`);
      const k4 = key4Of(g), cred = g.local ? '本机服务，不需要密钥' : g.mcp ? `经 MCP 入口调用 ${esc(g.mcp)}，凭据由这个 MCP 自己的配置管理` : k4 ? `${ic('key')} 已存入 Windows 凭据管理器（结尾 …${esc(k4)}）` : '还没有填写';
      return `<h2 style="font-family:var(--font-ui)">${esc(g.name)}</h2>
        <p class="lead">${statusHtml(g)}${kindTag(g)}${concTag(g)}</p>
        ${g.local ? `<p class="note" style="margin:0 0 var(--sp-3)">${ic('lock')} ${concText(g) === '独占排队' ? '独占：本机显卡一次只跑一个生成任务，其他本机生成（包括 Agent 发起的）排队，排队状态在监控页可见。' : '共享：多个任务同时用显卡，显存不够时可能失败。'}</p>` : ''}
        <div class="d-acts">${acts.join('')}</div>
        <dl class="d-kv"><dt>接入</dt><dd>${g.local ? `本机 ComfyUI 服务<code class="codeline">${esc(addrOf(g))}</code>` : esc(g.via ? g.via.split('，')[0] : '云端 API')}</dd>
          <dt>凭据</dt><dd>${cred}</dd>
          <dt>并发</dt><dd>${concText(g) === '独占排队' ? '独占排队' : g.local ? '共享' : '共享，按账号并发上限排队（示例 4）'}</dd>
          <dt>费用</dt><dd>${g.price ? `${usd(g.price)} / ${g.unit}（示例，接入时联网查证）` : '本机生成，不计费；计入显卡占用时长'}</dd></dl>
        <h3>提供给 Agent 的工具</h3>
        <ul class="plain"><li><code>${tools}</code><span class="sub">经 MCP 入口提供给全部 Agent</span></li></ul>
        <p class="note">付费生成每次调用都要审批，不适用“低风险自动允许”。生成的文件写进任务的工作副本，出现在“改动”面板。</p>
        ${isComfy(g) ? `<h3>内置工作流模板</h3><ul class="plain">${tplsOf(g.id).map((t) => `<li>${esc(t.name)}<span class="sub">${t.models.map((m) => `${MODELS[m][0]}：${st.models[m] ? '已下载' : `未下载（${MODELS[m][1]}）`}`).join('；')}</span></li>`).join('')}</ul><p class="note">模型名称和大小为示例。在生成页可以下载模型、导入自己的工作流 JSON。</p>` : ''}
        <p style="margin-top:var(--sp-4)"><a class="btn sm" data-wired="1" href="generate.html">${ic('wand')}打开生成页</a></p>`;
    };
    window.aicGenSide = (el) => { const g = genOf(sel) || allGens()[0]; sel = g.id; el.innerHTML = sideHtml(g); };
    const toggle = (g) => { st.on[g.id] = !isOn(g); save(); toast(isOn(g) ? `已启用 ${esc(g.name)}，Agent 的新会话能用 ${g.tool}` : `已停用 ${esc(g.name)}，Agent 从下一步起不再看到它`); };
    const radiosC = (cur) => `<div class="radios" role="radiogroup" aria-labelledby="gc-l"><label><input type="radio" name="gc" value="exclusive" ${cur === 'exclusive' ? 'checked' : ''}>独占：一次只跑一个</label><label><input type="radio" name="gc" value="shared" ${cur === 'shared' ? 'checked' : ''}>共享：同时跑多个</label></div>`;
    const edit = (g) => {
      const cur = concText(g) === '独占排队' ? 'exclusive' : 'shared', cloudKey = !g.local && !g.mcp, k4 = key4Of(g);
      modal({
        title: `编辑 ${esc(g.name)}`,
        body: `<div class="form-row" style="align-items:start"><span class="lbl" id="gc-l">并发方式</span><div>${radiosC(cur)}<p class="note" style="margin:4px 0 0;color:var(--fg-3)">本机显卡建议独占；云端服务一般共享，按账号并发上限排队。</p></div></div>
          ${g.local ? `<details class="adv"><summary>高级</summary><div class="form-row"><label for="ge-a">地址</label><input class="input" id="ge-a" value="${esc(addrOf(g))}"></div><p class="note" style="margin:0;color:var(--fg-3)">一般不用改。只有 ComfyUI 没用默认端口 8188 时才需要改。</p></details>`
            : cloudKey ? `<div class="form-row"><label for="ge-k">API Key</label><input class="input" id="ge-k" type="password" autocomplete="off" placeholder="${k4 ? `已保存，结尾 …${esc(k4)}。留空则不修改` : '粘贴密钥'}"></div><p class="note" style="margin:0;color:var(--fg-3)">${ic('key')} 存进 Windows 凭据管理器，不写进配置文件。</p>`
            : '<p style="margin:0;color:var(--fg-3)">经 MCP 入口调用，凭据在能力页的 MCP 列表里管理。</p>'}`,
        actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) {
          const a = $('#ge-a', d), kIn = $('#ge-k', d)?.value.trim();
          if (a && !/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(a.value.trim())) { toast('地址格式不对，例如 http://127.0.0.1:8188', 'attn'); a.closest('details').open = true; a.focus(); return false; }
          st.conc[g.id] = $('input[name="gc"]:checked', d).value;
          if (a) { if (g.extra) ext(g).addr = a.value.trim(); else st.addr = a.value.trim(); }
          if (kIn) { if (g.id === 'sfx-c') st.sfxKey = kIn.slice(-4); else if (g.extra) ext(g).key4 = kIn.slice(-4); else (st.k4 ||= {})[g.id] = kIn.slice(-4); }
          save(); toast(`已保存 ${esc(g.name)}${kIn ? '，新密钥已存进凭据管理器' : ''}`);
        } }],
      });
    };
    const remove = (g) => modal({ title: `移除 ${esc(g.name)}？`, body: '<p>移除后生成页和 Agent 都不再用它。已经生成并采用的文件、生成记录都保留。</p>',
      actions: [{ label: '取消' }, { label: '移除', kind: 'danger', onClick() { st.extra.splice(st.extra.indexOf(ext(g)), 1); sel = 'comfyui'; save(); toast(`已移除 ${esc(g.name)}`); } }] });
    const more = (btn, g) => menu(btn, [
      ['测试连接', () => testConn(g)], ['编辑…', () => edit(g)], [isOn(g) ? '停用' : '启用', () => toggle(g)],
      ...(g.id === 'comfyui' && st.comfy !== 'none' && !installing ? [['卸载 ComfyUI…', () => modal({ title: '卸载 ComfyUI？', body: '<p>会删除 %LOCALAPPDATA%\\AI_Console\\comfyui 整个文件夹，包括下载的模型。已经采用进项目的生成结果不受影响。</p>',
        actions: [{ label: '取消' }, { label: '卸载', kind: 'danger', onClick() { st.comfy = 'none'; Object.keys(st.models).forEach((k) => { st.models[k] = false; }); save(); toast('已卸载 ComfyUI'); } }] }), 'danger']] : []),
      ...(g.extra ? [['移除…', () => remove(g), 'danger']] : []),
    ]);
    // 添加生成器：先选类型（本机工具 / 云端 API / MCP），再选服务商。服务商清单等调研结论，这里只放中性示例
    const PROVIDERS = {
      local: [['ComfyUI（示例）', 'image'], ['本机音效工具 X（示例）', 'audio']],
      cloud: [['图片服务 A（示例）', 'image'], ['视频服务 B（示例）', 'video'], ['音效服务 C（示例）', 'audio']],
      mcp: [['MCP 生成服务 D（示例）', 'image']],
    };
    const TYPE_NOTE = {
      local: '在这台电脑上运行，不计费，占用显卡。默认地址是本机，一般不用改。',
      cloud: '按次计费。密钥存进 Windows 凭据管理器，不写进任何配置文件；界面上只显示末四位。',
      mcp: '用能力页里已经整合的 MCP 服务器做生成器，凭据由那个 MCP 自己的配置管理。',
    };
    const addGen = () => modal({
      title: '添加生成器', wide: true,
      body: `<div class="form-row"><span class="lbl" id="ga-t-l">1. 类型</span><div class="radios" role="radiogroup" aria-labelledby="ga-t-l"><label><input type="radio" name="ga-t" value="local" checked>本机工具</label><label><input type="radio" name="ga-t" value="cloud">云端 API</label><label><input type="radio" name="ga-t" value="mcp">MCP</label></div></div>
        <div class="form-row"><label for="ga-p">2. 服务商</label><select class="select" id="ga-p"></select></div>
        <p id="ga-note" style="margin:0 0 var(--sp-3);color:var(--fg-3)"></p>
        <div class="form-row"><label for="ga-n">名称</label><input class="input" id="ga-n"></div>
        <div class="form-row"><label for="ga-kind">生成类型</label><select class="select" id="ga-kind"><option value="image">图片</option><option value="audio">音效</option><option value="video">视频</option></select></div>
        <div data-for="local"><details class="adv"><summary>高级</summary><div class="form-row"><label for="ga-a">地址</label><input class="input" id="ga-a" value="http://127.0.0.1:8189"></div><p class="note" style="margin:0;color:var(--fg-3)">默认是本机地址，一般只改端口。内置的 ComfyUI 用 8188，在列表里直接选它即可。</p></details></div>
        <div data-for="cloud" hidden><div class="form-row"><label for="ga-k">API Key</label><input class="input" id="ga-k" type="password" autocomplete="off" placeholder="粘贴密钥"></div></div>
        <div data-for="mcp" hidden><div class="form-row"><label for="ga-m">MCP 服务器</label><select class="select" id="ga-m">${(window.aicMcps || []).filter((m) => m.enabled).map((m) => `<option>${esc(m.id)}</option>`).join('') || '<option>image-gen</option>'}</select></div></div>
        <div class="form-row" style="align-items:start"><span class="lbl" id="gc-l">并发方式</span>${radiosC('exclusive')}</div>
        <div class="form-row"><span class="lbl">连接</span><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="btn sm" data-wired="1" id="ga-test">${ic('pulse')}测试连接</button><span id="ga-res" aria-live="polite" style="color:var(--fg-2)"></span></div></div>`,
      onOpen(d) {
        const type = () => $('input[name="ga-t"]:checked', d).value;
        const fillProv = () => {
          const t = type();
          $('#ga-p', d).innerHTML = PROVIDERS[t].map(([n, k], i) => `<option value="${i}" data-kind="${k}">${n}</option>`).join('') + '<option disabled>更多服务商：调研后提供</option>';
          $('#ga-note', d).textContent = TYPE_NOTE[t];
          $$('[data-for]', d).forEach((x) => { x.hidden = x.dataset.for !== t; });
          $(`input[name="gc"][value="${t === 'local' ? 'exclusive' : 'shared'}"]`, d).checked = true;
          $('#ga-res', d).textContent = '';
          pickProv();
        };
        const pickProv = () => { const o = $('#ga-p', d).selectedOptions[0]; $('#ga-n', d).value = o.textContent + (type() === 'local' ? '（另一个端口）' : ''); $('#ga-kind', d).value = o.dataset.kind; };
        d.addEventListener('change', (e) => { if (e.target.name === 'ga-t') fillProv(); else if (e.target.id === 'ga-p') pickProv(); });
        $('#ga-test', d).addEventListener('click', () => {
          const t = type(), r = $('#ga-res', d);
          if (t === 'cloud' && !$('#ga-k', d).value.trim()) { toast('先粘贴 API Key', 'attn'); $('#ga-k', d).focus(); return; }
          r.textContent = '连接中…';
          later(900, () => { r.innerHTML = `<span class="status ok"><span class="dot"></span>${t === 'cloud' ? '连接正常，账号并发上限 4（示例）' : t === 'mcp' ? `连接正常：${esc($('#ga-m', d).value)} 提供 1 个生成类工具` : `连接正常：${esc($('#ga-a', d).value)}，显卡 RTX 4090`}</span>`; });
        });
        fillProv();
      },
      actions: [{ label: '取消' }, { label: '添加', kind: 'primary', onClick(d) {
        const t = $('input[name="ga-t"]:checked', d).value, name = $('#ga-n', d).value.trim(), addr = $('#ga-a', d).value.trim(), key = $('#ga-k', d).value.trim();
        if (!name) { toast('填一下名称', 'attn'); $('#ga-n', d).focus(); return false; }
        if (t === 'local' && !/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(addr)) { toast('地址格式不对，例如 http://127.0.0.1:8188', 'attn'); $('#ga-a', d).closest('details').open = true; $('#ga-a', d).focus(); return false; }
        if (t === 'local' && addr.replace(/\/$/, '') === st.addr) { toast('这个地址就是内置的 ComfyUI，在列表里选它即可', 'attn'); return false; }
        if (t === 'cloud' && !key) { toast('先粘贴 API Key', 'attn'); $('#ga-k', d).focus(); return false; }
        const id = 'x' + Date.now(), prov = $('#ga-p', d).selectedOptions[0].textContent;
        st.extra.push({ id, name, kind: $('#ga-kind', d).value, local: t === 'local', addr: t === 'local' ? addr : '', key4: t === 'cloud' ? key.slice(-4) : '', mcp: t === 'mcp' ? $('#ga-m', d).value : '',
          provider: prov, price: t === 'local' ? 0 : 0.04, via: t === 'cloud' ? '云端 API' : t === 'mcp' ? 'MCP' : '', extra: true });
        st.conc[id] = $('input[name="gc"]:checked', d).value; st.on[id] = true; sel = id; save(); window.aicOpenSide?.();
        toast(`已添加 ${esc(name)}${t === 'cloud' ? '，API Key 已存进凭据管理器' : ''}`);
      } }],
    });
    const ops = (op, g, b) => ({ install, detect, key: () => askKey(g), test: () => testConn(g), edit: () => edit(g), toggle: () => toggle(g), more: () => more(b, g) })[op]?.();
    rows.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-id]'); if (!tr) return;
      const g = genOf(tr.dataset.id);
      if (e.target.closest('[data-gsw]')) return toggle(g);
      if (e.target.closest('[data-gmore]')) return more(e.target.closest('[data-gmore]'), g);
      sel = g.id; render(); window.aicOpenSide?.();
    });
    rows.addEventListener('keydown', (e) => {
      const tr = e.target.closest('tr[data-id]'); if (!tr || e.target !== tr) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel = tr.dataset.id; render(); window.aicOpenSide?.(); }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); (e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
    });
    side.addEventListener('click', (e) => { if (!tabOn()) return; const b = e.target.closest('[data-gop]'); if (b) ops(b.dataset.gop, genOf(sel), b); });
    $('#gen-add')?.addEventListener('click', addGen);
    document.addEventListener('aic-gen-change', render);
    render();
    if (location.hash === '#gen') { $('#ct-gen').click(); }
  })();

  // ================= 资产页：Agent 在任务中调用 gen__image，付费生成要审批 =================
  if (page === 'assets') (function () {
    const inner = $('.stream-inner'); if (!inner || !window.aicAgentMsg || !window.aicAdd) return;
    const add = window.aicAdd, files = ['T_Chest_Iron_Rust_D_01.png', 'T_Chest_Iron_Rust_D_02.png'], dir = 'Assets/Art/Props/Chest/Textures/', seeds = [90311, 90312];
    const rid = (i) => `g_${ymd()}_t7c3${String.fromCharCode(97 + i)}`;
    const local = st.comfy === 'ok';
    inner.insertAdjacentHTML('beforeend', window.aicAgentMsg('codebuddy', 'kimi-k2.5', '<p>铁箍现在是纯灰色，看起来像塑料。我调用生成器做一张可平铺的做旧铁锈贴图，用在 M_Chest_Iron 上，材质名不变。</p>'));
    inner.insertAdjacentHTML('beforeend', `<section class="approval" id="gen-ap" aria-labelledby="gap-title" tabindex="-1">
      <div class="ah">${ic('shield')}<span id="gap-title">CodeBuddy 请求调用生成器：gen__image</span><span class="meta">付费生成 · 等你确认</span></div>
      <p class="why">生成 2 张 1024×1024 的可平铺铁锈贴图，写进工作副本的 ${dir}。</p>
      <pre class="mono">gen__image {"generator": "image-service-a", "prompt": "做旧的铁箍，锈迹和划痕，可平铺，手绘风格", "size": "1024x1024", "n": 2, "seamless": true}</pre>
      <dl class="facts"><dt>生成器</dt><dd>图片服务 A（示例，云端 API）</dd><dt>预计费用</dt><dd>$0.08（2 张 × $0.04，示例）</dd><dt>本任务预算</dt><dd>已用 $0.00 / 上限 $2.00（示例）</dd>
        <dt>为什么要审批</dt><dd>付费生成需要审批，不适用低风险自动允许</dd></dl>
      <div class="acts"><button class="btn attn" data-wired="1" data-ga="ok">允许 <kbd>Enter</kbd></button>
        ${local ? '<button class="btn" data-wired="1" data-ga="local">改用本机 ComfyUI（不计费）</button>' : ''}
        <span class="grow"></span><button class="btn danger" data-wired="1" data-ga="no">拒绝… <kbd>Esc</kbd></button></div>
      <div class="reject-reason" hidden><label for="gap-rr" class="sr-only">拒绝理由</label><input class="input" id="gap-rr" placeholder="告诉 Agent 为什么拒绝（可选），例如：先用纯色，别花钱">
        <div style="display:flex;gap:8px;margin-top:8px;justify-content:flex-end"><button class="btn sm" data-wired="1" data-ga="rr-cancel">取消</button><button class="btn sm danger" data-wired="1" data-ga="rr-ok">确认拒绝</button></div></div>
    </section>`);
    const card = $('#gen-ap');
    const resolve = (ok, text) => {
      card.classList.add('resolved'); if (!ok) card.classList.add('denied');
      $('#gap-title').textContent = text; $('.ah .meta', card).textContent = `你 · ${hhmm()}`;
      $('.ah svg use', card).setAttribute('href', ok ? '#i-check' : '#i-x'); card.removeAttribute('tabindex');
    };
    let timer = null, runEl = null, useLocal = false;
    const recOf = (i) => ({ id: rid(i), generator: useLocal ? `ComfyUI（本机 ${st.addr}）` : '图片服务 A（示例）', workflow: useLocal ? '无缝贴图 v1.0（内置模板）' : '图片服务 A 默认参数', caller: 'CodeBuddy（kimi-k2.5）调用 gen__image', task: 't7c3 宝箱模型：箱盖改圆、补铁箍',
      prompt: '做旧的铁箍，锈迹和划痕，可平铺，手绘风格', seed: seeds[i], params: { 宽高: '1024×1024', 数量: 2, 可平铺: '是' }, duration: '7.0 秒（整批 14 秒）', cost: useLocal ? '0（本机）' : '$0.04（示例）', approvedBy: `你 · ${hhmm()}`, file: dir + files[i] });
    const run = (loc) => {
      useLocal = loc;
      resolve(true, `已允许：调用 gen__image（${loc ? '改用本机 ComfyUI，不计费' : '图片服务 A（示例），预计 $0.08，示例金额'}）`);
      runEl = add(`<div class="gen-run" role="group" aria-label="生成进度：gen__image">
        <div class="gh">${ic('wand')}<b>gen__image</b><span style="color:var(--fg-3);font-size:var(--fs-12)">${loc ? 'ComfyUI（本机，示例）' : '图片服务 A（示例）'} · 2 张 · 可平铺</span><span class="grow"></span><span class="status run" data-s><span class="dot"></span>生成中 0%</span><button class="btn sm ghost" data-wired="1" data-ga="cancel" aria-label="取消这次生成">${ic('x')}取消</button></div>
        <div class="qbar" role="progressbar" aria-label="gen__image 进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
        <div class="thumbs">${files.map((f) => `<figure><canvas width="224" height="224" role="img" aria-label="${f}（生成中）"></canvas><figcaption class="mono">${f}</figcaption></figure>`).join('')}</div>
        <p class="note">${loc ? '本机 ComfyUI 独占排队：显卡空闲，直接开始' : '云端生成；完成前取消不计费（示例）'}</p></div>`);
      const t0 = Date.now(), cvs = $$('canvas', runEl);
      const step = () => {
        const p = Math.min(100, ((Date.now() - t0) / 3600) * 100);
        $('.qbar i', runEl).style.width = p + '%'; $('.qbar', runEl).setAttribute('aria-valuenow', Math.round(p));
        $('[data-s]', runEl).innerHTML = `<span class="dot"></span>生成中 ${Math.round(p)}%`;
        cvs.forEach((cv, i) => paint(cv, { seed: seeds[i], look: 'tile', t: Math.max(0.02, p / 100), ref: 'T_Chest_Iron_D.png' }));
        if (p >= 100) { clearInterval(timer); timer = null; done(); }
      };
      step(); timer = setInterval(step, 250);
    };
    const done = () => {
      runEl.classList.add('done');
      const s = $('[data-s]', runEl); s.className = 'status ok'; s.innerHTML = `<span class="dot"></span>已完成 · 用时 14 秒 · ${useLocal ? '本机不计费' : '$0.08（示例）'}`;
      $('[data-ga="cancel"]', runEl)?.remove();
      $$('canvas', runEl).forEach((cv, i) => cv.setAttribute('aria-label', `${files[i]}，生成的铁锈贴图（示例图）`));
      $('.note', runEl).innerHTML = `已写进工作副本，出现在“改动”面板（标“新增 · 生成”）。生成记录：<span class="mono" style="font-size:11.5px">.aic/generations/${rid(0)}.json</span>
        <span style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"><button class="btn sm ghost" data-action="side" data-tab="t-diff">在改动面板中查看</button><button class="btn sm ghost" data-wired="1" data-ga="rec">查看生成记录</button></span>`;
      const fl = $('#p-diff .filelist');
      if (fl) {
        fl.insertAdjacentHTML('beforeend', files.map((f, i) => `<li tabindex="0" data-gfile="${i}" title="点击查看生成记录"><span class="kind a" title="新增">A</span><span class="path"><span class="dir">${dir}</span>${f}</span><span class="n">新增 · 生成</span></li>`).join(''));
        const c = $('#t-diff .count'); if (c) c.textContent = fl.children.length;
      }
      window.aicStreamReply?.('codebuddy', 'kimi-k2.5', '两张都是可平铺的。第 1 张锈迹分布更均匀，接缝看不出来，先用它；第 2 张留在工作副本里备选。材质名不动，只换 Base Color 贴图。',
        '<p>贴图生成好了。第 1 张接到了 M_Chest_Iron 的 Base Color 上，材质名没变；第 2 张留着备选，不需要的话在“改动”面板里丢弃。</p>');
    };
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ga]'), f = e.target.closest('[data-gfile]');
      if (f) return recModal(recOf(+f.dataset.gfile));
      if (!b) return;
      const op = b.dataset.ga, rr = $('.reject-reason', card);
      if (op === 'ok') run(false);
      else if (op === 'local') run(true);
      else if (op === 'no') { rr.hidden = false; $('#gap-rr').focus(); }
      else if (op === 'rr-cancel') { rr.hidden = true; $('[data-ga="no"]', card).focus(); }
      else if (op === 'rr-ok') {
        const why = $('#gap-rr').value.trim();
        resolve(false, '已拒绝调用 gen__image' + (why ? `，理由：${why}` : ''));
        add(window.aicAgentMsg('codebuddy', 'kimi-k2.5', `<p>好的，不生成贴图。${why ? `按你的意见：“${esc(why)}”。` : ''}铁箍先保持纯色，把金属度调高一点让它不像塑料。</p>`));
      } else if (op === 'cancel') {
        clearInterval(timer); timer = null; runEl.classList.add('done');
        const s = $('[data-s]', runEl); s.className = 'status idle'; s.innerHTML = '<span class="dot"></span>已取消，没有计费（示例）'; b.remove();
        $('.note', runEl).textContent = '没有文件写进工作副本。';
        add(window.aicAgentMsg('codebuddy', 'kimi-k2.5', '<p>好的，已取消生成。铁箍先保持纯色。</p>'));
      } else if (op === 'rec') recModal(recOf(0));
    });
    document.addEventListener('keydown', (e) => { const f = e.target.closest?.('[data-gfile]'); if (f && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); recModal(recOf(+f.dataset.gfile)); } });
    card.addEventListener('keydown', (e) => {
      if (e.target !== card) return;
      if (e.key === 'Enter') { e.preventDefault(); run(false); }
      if (e.key === 'Escape') { e.preventDefault(); $('[data-ga="no"]', card).click(); }
    });
    $('#gap-rr').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-ga="rr-ok"]', card).click(); });
  })();
})();
