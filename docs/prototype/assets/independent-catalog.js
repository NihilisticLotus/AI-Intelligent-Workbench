// 只演示目录交互，不存储凭据、不请求任何服务。
(() => {
  const root = document.querySelector('#independent-preview'); if (!root) return;
  const esc = window.aicEsc;
  const services = [{ name: '示例服务', protocol: 'Chat Completions', url: 'https://example.com/v1', models: [{ id: 'example-model', name: '示例模型', context: '', image: '', effort: '' }] }];
  let selected = null;
  const render = () => {
    root.querySelector('[data-independent-default]').textContent = '默认模型：' + (selected ? `${selected.service.name} / ${selected.model.name}` : '尚未设置');
    root.querySelector('[data-independent-list]').innerHTML = services.map((s, i) => `<details open style="margin-top:16px;border:1px solid var(--line);padding:12px;border-radius:8px"><summary><b>${esc(s.name)}</b> · ${esc(s.protocol)} · ${s.models.length} 个模型</summary>
      <p class="mono">${esc(s.url)}</p><p class="muted">原型不保存密钥；在线识别尚未接入</p><button class="btn" data-add-model="${i}" data-wired>添加模型</button>
      ${s.models.map((m, j) => `<article style="margin-top:12px;padding:12px;background:var(--bg-1);border-radius:8px"><h3>${esc(m.name)}</h3><code>${esc(m.id)}</code>
        <p>上下文：${esc(m.context || '未知')} · 图片：${m.image === '' ? '未知' : m.image === 'false' ? '不支持（手动）' : '支持（手动）'} · 思考强度：${esc(m.effort || '未知')}</p>
        <button class="btn" data-cap="${i}:${j}" data-wired>能力与来源</button> <button class="btn" data-default="${i}:${j}" data-wired>设为默认</button></article>`).join('')}</details>`).join('');
    root.querySelectorAll('[data-add-model]').forEach((b) => b.onclick = () => {
      const service = services[Number(b.dataset.addModel)];
      window.aicModal({ title: '添加模型（原型）', body: `<p>所属服务：${esc(service.name)}。只追加，不改变默认值。</p><div class="form-row"><label for="pic-name">显示名称</label><input id="pic-name" class="input" maxlength="100"></div><div class="form-row"><label for="pic-id">原始模型 ID</label><input id="pic-id" class="input" maxlength="200"></div>`, actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) {
        const name = d.querySelector('#pic-name').value.trim(); const id = d.querySelector('#pic-id').value;
        if (!name || !id) { window.aicToast('请填写名称和 ID', 'attn'); return false; }
        if (!service.models.some((m) => m.id === id)) service.models.push({ id, name, context: '', image: '', effort: '' }); render();
      } }] });
    });
    root.querySelectorAll('[data-default]').forEach((b) => b.onclick = () => { const [i, j] = b.dataset.default.split(':').map(Number); selected = { service: services[i], model: services[i].models[j] }; render(); });
    root.querySelectorAll('[data-cap]').forEach((b) => b.onclick = () => {
      const [i, j] = b.dataset.cap.split(':').map(Number); const m = services[i].models[j];
      window.aicModal({ title: `能力与来源：${esc(m.name)}（原型）`, body: `<p>在线识别未接入，无自动来源记录。手动值只作用于当前服务和模型，清空即恢复自动。</p>
        <div class="form-row"><label for="pic-context">上下文总窗口</label><input id="pic-context" class="input" inputmode="numeric" value="${esc(m.context)}" placeholder="未知"></div>
        <div class="form-row"><label for="pic-image">图片输入</label><select id="pic-image" class="select"><option value="">自动（未知）</option><option value="true">支持</option><option value="false">不支持</option></select></div>
        <div class="form-row"><label for="pic-effort">思考强度列表</label><input id="pic-effort" class="input" value="${esc(m.effort)}" placeholder="沿用服务原始名称，逗号分隔"></div><p class="muted">正式版提供全部 16 个字段和逐字段来源日期、冲突与范围。</p>`, onOpen(d) { d.querySelector('#pic-image').value = m.image; }, actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) {
          const context = d.querySelector('#pic-context').value.trim(); if (context && !/^[1-9]\d*$/.test(context)) { window.aicToast('上下文请输入正整数', 'attn'); return false; }
          m.context = context; m.image = d.querySelector('#pic-image').value; m.effort = d.querySelector('#pic-effort').value.trim(); render();
        } }] });
    });
  };
  root.querySelector('[data-independent-add]').onclick = () => window.aicModal({ title: '添加 API 服务（原型）', body: `<p>正式版填写名称、协议、基础地址、鉴权和密钥。此原型不收集密钥。</p>
    <div class="form-row"><label for="pic-service">服务名称</label><input id="pic-service" class="input" maxlength="100"></div><div class="form-row"><label for="pic-protocol">接口协议</label><select id="pic-protocol" class="select"><option>Chat Completions</option><option>Responses</option><option>Anthropic Messages</option></select></div><div class="form-row"><label for="pic-url">API 基础地址</label><input id="pic-url" class="input" value="https://example.com/v1"></div>`, actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) {
      const name = d.querySelector('#pic-service').value.trim(); const url = d.querySelector('#pic-url').value.trim();
      if (!name || !/^https:\/\//.test(url)) { window.aicToast('请填写名称和 HTTPS 地址', 'attn'); return false; }
      services.push({ name, protocol: d.querySelector('#pic-protocol').value, url, models: [] }); render();
    } }] });
  render();
})();
