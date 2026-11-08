// 只演示目录交互，不存储凭据、不请求任何服务。
(() => {
  const root = document.querySelector('#independent-preview'); if (!root) return;
  const esc = window.aicEsc;
  const services = [{ name: '示例服务', protocol: 'Chat Completions', url: 'https://example.com/v1', models: [{ id: 'example-model', name: '示例模型', context: '', image: '', effort: '' }] }];
  let selected = null;
  const render = () => {
    root.querySelector('[data-independent-default]').textContent = '默认模型：' + (selected ? `${selected.service.name} / ${selected.model.name}` : '尚未设置');
    root.querySelector('[data-independent-list]').innerHTML = services.map((s, i) => `<details open style="margin-top:16px;border:1px solid var(--line);padding:12px;border-radius:8px"><summary><b>${esc(s.name)}</b> · ${esc(s.protocol)} · ${s.models.length} 个模型</summary>
      <p class="mono">${esc(s.url)}</p><p class="muted">原型不保存密钥、不联网；发现只演示虚构候选</p><button class="btn" data-add-model="${i}" data-wired>添加模型</button> <button class="btn" data-discover="${i}" data-wired>获取模型与能力（演示）</button>
      ${s.models.map((m, j) => `<article style="margin-top:12px;padding:12px;background:var(--bg-1);border-radius:8px"><h3>${esc(m.name)}</h3><code>${esc(m.id)}</code>
        <p>上下文：${esc(m.context || '未知')} · 图片：${m.image === '' ? '未知' : m.image === 'false' ? '不支持' : '支持'} · 思考强度：${esc(m.effort || '未知')} · 来源：${m.auto ? '模拟目录' : '手动 / 未知'}</p>
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
    root.querySelectorAll('[data-discover]').forEach((b) => b.onclick = () => {
      const service = services[Number(b.dataset.discover)];
      let candidates = [];
      window.aicModal({title:'获取模型与能力（原型）',body:`<p>这里只演示虚构资料，不请求网络。正式版获取服务列表最多 10 次服务请求；识别已有模型不访问服务、不读取密钥，可选公共目录另有 1 次匿名读取，不发模型消息。</p><div class="form-row"><label for="pic-source">识别范围</label><select id="pic-source" class="select"><option value="service">获取服务模型列表</option><option value="configured">识别已添加模型（无需服务目录）</option></select></div><p>正式版内置官方资料只精确匹配已核对服务、协议和模型；显示固定核对时间与有效期，未知仍未知，不证明账号可用。已有名称、人工值、启停和默认值保留。</p><button id="pic-preview" class="btn primary">生成演示预览</button><p id="pic-preview-status" role="status">尚未生成预览；本原型不联网</p><p class="muted">正式版失败时可展开“查看本次获取诊断”：固定阶段、尝试计数、已解析页数与 HTTP 状态；解析阶段追加列表结构、单页上限、重复标识或分页的固定校验分类，旧分类缺失时明确未记录；旧记录保持未确认，不展示上游正文 / 响应头，不自动重试。</p><div class="form-row"><label for="pic-search">搜索候选</label><input id="pic-search" class="input" type="search"></div><div id="pic-candidates"></div>`,onOpen(d){
        const filter=()=>{const q=d.querySelector('#pic-search').value.toLowerCase();d.querySelectorAll('[data-candidate-row]').forEach(row=>{const m=candidates[Number(row.dataset.candidateRow)];row.style.display=(m.id+m.name).toLowerCase().includes(q)?'block':'none';});};
        d.querySelector('#pic-search').oninput=filter;
        d.querySelector('#pic-source').onchange=()=>{candidates=[];d.querySelector('#pic-candidates').innerHTML='';d.querySelector('#pic-preview-status').textContent='识别范围已改变，请重新生成演示预览';};
        d.querySelector('#pic-preview').onclick=()=>{
          const configured=d.querySelector('#pic-source').value==='configured';
          candidates=configured?service.models.map(m=>({...m})): [{id:'demo-vision',name:'图片候选（虚构）',context:'32000',image:'true',effort:'low, medium',auto:true},{id:'demo-unknown',name:'未知候选（虚构）',context:'',image:'',effort:'',auto:true}];
          d.querySelector('#pic-preview-status').textContent=configured?'已有模型能力预览（不含完整服务列表）；示例服务无已核对官方资料，保留人工 / 未知':'虚构服务列表预览；不代表真实模型';
          d.querySelector('#pic-candidates').innerHTML=candidates.map((m,i)=>`<label data-candidate-row="${i}" style="display:block;padding:12px"><input type="checkbox" data-candidate="${i}"> ${esc(m.name)} · ${esc(m.id)} · ${configured?'保留已有记录':m.context?'窗口 32000，图片支持，low / medium（模拟目录）':'能力未知'}</label>`).join('');filter();
        };
      },actions:[{label:'取消'},{label:'导入勾选项',kind:'primary',onClick(d){
        const checked=[...d.querySelectorAll('[data-candidate]:checked')];if(!checked.length){window.aicToast('请先勾选候选模型','attn');return false;}
        checked.forEach((input)=>{const m=candidates[Number(input.dataset.candidate)];if(!service.models.some((old)=>old.id===m.id))service.models.push({...m});});render();
      }}]});
    });
    root.querySelectorAll('[data-cap]').forEach((b) => b.onclick = () => {
      const [i, j] = b.dataset.cap.split(':').map(Number); const m = services[i].models[j];
      window.aicModal({ title: `能力与来源：${esc(m.name)}（原型）`, body: `<p>来源：${m.auto ? '模拟目录（虚构数据，非实际验证）' : '手动 / 未知'}。正式版保留来源和人工修订；此简化原型编辑后整项按手动显示。</p>
        <div class="form-row"><label for="pic-context">上下文总窗口</label><input id="pic-context" class="input" inputmode="numeric" value="${esc(m.context)}" placeholder="未知"></div>
        <div class="form-row"><label for="pic-image">图片输入</label><select id="pic-image" class="select"><option value="">自动（未知）</option><option value="true">支持</option><option value="false">不支持</option></select></div>
        <div class="form-row"><label for="pic-effort">思考强度列表</label><input id="pic-effort" class="input" value="${esc(m.effort)}" placeholder="沿用服务原始名称，逗号分隔"></div><p class="muted">正式版提供全部 16 个字段和逐字段来源日期、冲突与范围。</p>`, onOpen(d) { d.querySelector('#pic-image').value = m.image; }, actions: [{ label: '取消' }, { label: '保存', kind: 'primary', onClick(d) {
          const context = d.querySelector('#pic-context').value.trim(); if (context && !/^[1-9]\d*$/.test(context)) { window.aicToast('上下文请输入正整数', 'attn'); return false; }
          m.context = context; m.image = d.querySelector('#pic-image').value; m.effort = d.querySelector('#pic-effort').value.trim(); m.auto=false; render();
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
