const csrf = document.querySelector('meta[name="csrf-token"]').content;
const state = { connections: [], agents: [], orchestrations: [], users: [], selected: null, selectedNode: null, connectSource: null, drag: null };
const templates = {
  topic_auction: { label: 'Topic 竞价', roles: ['agent'], defaults: [['agent', 'agent_1']], edges: [] },
  supervisor: { label: 'Supervisor', roles: ['supervisor', 'specialist'], defaults: [['supervisor', 'supervisor'], ['specialist', 'specialist_1']], edges: [['supervisor', 'specialist_1'], ['specialist_1', 'supervisor']] },
  handoff: { label: 'Handoff', roles: ['agent'], defaults: [['agent', 'agent_1'], ['agent', 'agent_2']], edges: [['agent_1', 'agent_2']] },
  parallel_review: { label: '并行评审', roles: ['source', 'reviewer', 'judge'], defaults: [['source', 'source'], ['reviewer', 'reviewer_1'], ['judge', 'judge']], edges: [['source', 'reviewer_1'], ['reviewer_1', 'judge']] },
  plan_execute: { label: 'Plan / Execute', roles: ['planner', 'executor', 'replanner'], defaults: [['planner', 'planner'], ['executor', 'executor'], ['replanner', 'replanner']], edges: [['planner', 'executor'], ['executor', 'replanner'], ['replanner', 'executor']] },
};
const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const headers = { Accept: 'application/json', ...options.headers };
  if (options.body && typeof options.body !== 'string') { headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(options.body); }
  if ((options.method || 'GET') !== 'GET') headers['X-CSRF-Token'] = csrf;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  if (!response.ok) { let detail; try { detail = await response.json(); } catch { detail = { detail: response.statusText }; } throw new Error(typeof detail.detail === 'string' ? detail.detail : JSON.stringify(detail.detail || detail)); }
  return response.status === 204 ? null : response.json();
}
function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 2800); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function formatDate(value) { return value ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—'; }

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', async () => {
  document.querySelectorAll('.nav-item,.view').forEach(el => el.classList.remove('active'));
  button.classList.add('active'); const name = button.dataset.view; $(`view-${name}`).classList.add('active');
  $('view-title').textContent = button.textContent.replace(/^\d+/, '').trim();
  if (name === 'audit') await loadAudit();
}));

function field(label, name, type = 'text', options = []) {
  if (type === 'select') return `<label>${label}<select name="${name}">${options.map(([v,l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join('')}</select></label>`;
  return `<label>${label}<input name="${name}" type="${type}" ${type === 'password' ? 'autocomplete="new-password"' : ''} required /></label>`;
}
function openDialog({ title, kicker = 'CREATE', fields, submit }) {
  $('dialog-title').textContent = title; $('dialog-kicker').textContent = kicker; $('dialog-fields').innerHTML = fields; $('dialog-error').classList.add('hidden');
  const dialog = $('resource-dialog'); dialog.showModal();
  $('resource-form').onsubmit = async (event) => { event.preventDefault(); const button = event.submitter; if (button?.value === 'cancel') { dialog.close(); return; }
    try { await submit(Object.fromEntries(new FormData(event.currentTarget))); dialog.close(); toast(`${title}完成`); await loadAll(); }
    catch (error) { $('dialog-error').textContent = error.message; $('dialog-error').classList.remove('hidden'); }
  };
}

async function loadAll() {
  const [connections, agents, orchestrations, users] = await Promise.all([
    api('/api/admin/connections'), api('/api/admin/agents'), api('/api/admin/orchestrations'), api('/api/admin/users')
  ]);
  state.connections = connections.items; state.agents = agents.items; state.orchestrations = orchestrations.items; state.users = users.items;
  renderConnections(); renderAgents(); renderOrchestrations(); renderUsers();
  if (state.selected) { const fresh = state.orchestrations.find(x => x.id === state.selected.id); if (fresh) selectOrchestration(fresh); }
}

function renderConnections() {
  $('connection-grid').innerHTML = state.connections.map(item => `<article class="resource-card"><header><div><h3>${escapeHtml(item.name)}</h3><span class="pill ${item.enabled?'live':''}">${item.enabled?'ACTIVE':'DISABLED'}</span></div></header><p>${escapeHtml(item.base_url)}</p><dl><dt>Service Token</dt><dd>${escapeHtml(item.masked_token)}</dd><dt>到期时间</dt><dd>${formatDate(item.token_expires_at)}</dd></dl><div class="card-actions"><button class="button ghost" data-test-connection="${item.id}">测试连接</button></div></article>`).join('') || '<p class="empty-copy">尚未配置 Coze 连接。</p>';
  document.querySelectorAll('[data-test-connection]').forEach(btn => btn.onclick = async () => { const result = await api(`/api/admin/connections/${btn.dataset.testConnection}/test`, { method: 'POST' }); toast(result.message); });
}
function renderAgents() {
  $('agent-grid').innerHTML = state.agents.map(item => `<article class="resource-card"><header><div><h3>${escapeHtml(item.display_name)}</h3><span class="pill ${item.enabled?'live':''}">${escapeHtml(item.kind.replace('coze_','').toUpperCase())}</span></div></header><p>${escapeHtml(item.description || '无描述')}</p><dl><dt>标识</dt><dd>${escapeHtml(item.slug)}</dd><dt>连接</dt><dd>${escapeHtml(item.connection_name)}</dd><dt>远端 ID</dt><dd>${escapeHtml(item.remote_id)}</dd><dt>容错</dt><dd>${item.timeout_seconds}s · ${item.max_retries} retries</dd></dl></article>`).join('') || '<p class="empty-copy">先创建 Coze 连接，再注册智能体。</p>';
}
function renderUsers() { $('user-table').innerHTML = state.users.map(item => `<tr><td>${escapeHtml(item.username)}</td><td>${escapeHtml(item.role)}</td><td>${item.active?'启用':'停用'}</td><td>${formatDate(item.created_at)}</td></tr>`).join(''); }
function renderOrchestrations() {
  $('orchestration-list').innerHTML = state.orchestrations.map(item => `<button class="stack-item ${state.selected?.id===item.id?'active':''}" data-orchestration="${item.id}"><b>${escapeHtml(item.name)}</b><small>${escapeHtml(templates[item.draft.template]?.label || item.draft.template)} · draft v${item.draft_version}</small><span class="pill ${item.active_revision_id&&item.enabled?'live':''}">${item.active_revision_id ? (item.enabled?'PUBLISHED':'HIDDEN') : 'DRAFT'}</span></button>`).join('') || '<p class="empty-copy">还没有编排方案。</p>';
  document.querySelectorAll('[data-orchestration]').forEach(btn => btn.onclick = () => selectOrchestration(state.orchestrations.find(x => x.id === btn.dataset.orchestration)));
}
function selectOrchestration(item) {
  state.selected = structuredClone(item); state.selectedNode = null; state.connectSource = null; renderOrchestrations();
  $('canvas-name').textContent = item.name; $('canvas-meta').textContent = `${templates[item.draft.template].label} · 草稿 v${item.draft_version}${item.active_revision_id?' · 已发布':''}`;
  ['add-node','connect-mode','validate-draft','save-draft','publish-draft'].forEach(id => $(id).disabled = false);
  $('canvas-empty').classList.toggle('hidden', item.draft.nodes.length > 0); renderCanvas(); renderInspector();
}
function nodeById(id) { return state.selected?.draft.nodes.find(n => n.id === id); }
function renderCanvas() {
  if (!state.selected) return; const edges = $('edge-layer'); const nodes = $('node-layer'); edges.innerHTML = ''; nodes.innerHTML = '';
  state.selected.draft.edges.forEach(edge => { const a=nodeById(edge.source), b=nodeById(edge.target); if(!a||!b)return; const x1=a.position.x+150,y1=a.position.y+39,x2=b.position.x,y2=b.position.y+39; const bend=Math.max(55,Math.abs(x2-x1)*.42); const p=document.createElementNS('http://www.w3.org/2000/svg','path'); p.setAttribute('class','edge'); p.setAttribute('d',`M${x1},${y1} C${x1+bend},${y1} ${x2-bend},${y2} ${x2},${y2}`); edges.appendChild(p); });
  state.selected.draft.nodes.forEach(node => { const g=document.createElementNS('http://www.w3.org/2000/svg','g'); g.setAttribute('class',`node ${state.selectedNode===node.id?'selected':''} ${state.connectSource===node.id?'connect-source':''}`); g.dataset.nodeId=node.id; g.setAttribute('transform',`translate(${node.position.x},${node.position.y})`); g.innerHTML=`<rect width="150" height="78"></rect><circle class="node-dot" cx="16" cy="20" r="4"></circle><text class="node-title" x="28" y="25">${escapeHtml(node.id)}</text><text class="node-role" x="16" y="48">${escapeHtml(node.role)}</text><text class="node-role" x="16" y="64">${escapeHtml(state.agents.find(a=>a.id===node.agent_id)?.display_name || '未绑定')}</text>`; nodes.appendChild(g);
    g.addEventListener('pointerdown', event => startDrag(event,node)); g.addEventListener('click', event => { event.stopPropagation(); if(state.connectSource){ connectTo(node.id); } else { state.selectedNode=node.id; renderCanvas(); renderInspector(); } });
  });
}
function startDrag(event,node){ if(state.connectSource)return; const svg=$('graph-canvas'); const point=svg.createSVGPoint(); point.x=event.clientX;point.y=event.clientY;const start=point.matrixTransform(svg.getScreenCTM().inverse());state.drag={node,start,x:node.position.x,y:node.position.y};event.currentTarget.setPointerCapture(event.pointerId);event.currentTarget.onpointermove=moveDrag;event.currentTarget.onpointerup=endDrag; }
function moveDrag(event){ if(!state.drag)return;const svg=$('graph-canvas'),p=svg.createSVGPoint();p.x=event.clientX;p.y=event.clientY;const now=p.matrixTransform(svg.getScreenCTM().inverse());state.drag.node.position.x=Math.max(0,Math.min(1040,state.drag.x+now.x-state.drag.start.x));state.drag.node.position.y=Math.max(0,Math.min(620,state.drag.y+now.y-state.drag.start.y));renderCanvas(); }
function endDrag(){state.drag=null;}
function connectTo(target){ if(target===state.connectSource){state.connectSource=null;renderCanvas();return;} const exists=state.selected.draft.edges.some(e=>e.source===state.connectSource&&e.target===target);if(!exists)state.selected.draft.edges.push({source:state.connectSource,target,condition:null});state.connectSource=null;renderCanvas();toast('连接已加入草稿');}
$('graph-canvas').addEventListener('click',()=>{state.selectedNode=null;renderCanvas();renderInspector();});

function renderInspector(){ const node=nodeById(state.selectedNode);$('inspector-empty').classList.toggle('hidden',!!node);$('node-inspector').classList.toggle('hidden',!node);if(!node)return;$('node-id').value=node.id;$('node-role').value=node.role;$('node-agent').innerHTML=state.agents.filter(a=>a.enabled&&(a.kind==='coze_chat'||(a.kind==='coze_workflow'&&((state.selected.draft.template==='topic_auction'&&node.role==='agent')||(state.selected.draft.template==='plan_execute'&&node.role==='executor'))))).map(a=>`<option value="${a.id}" ${a.id===node.agent_id?'selected':''}>${escapeHtml(a.display_name)} · ${a.kind.replace('coze_','')}</option>`).join('');document.querySelectorAll('.topic-only').forEach(el=>el.classList.toggle('hidden',state.selected.draft.template!=='topic_auction'));$('node-bid').value=node.config.base_bid??0.5;$('node-keywords').value=(node.config.keywords||[]).join('\n');}
$('node-agent').onchange=event=>{nodeById(state.selectedNode).agent_id=event.target.value;renderCanvas();};$('node-bid').onchange=event=>{nodeById(state.selectedNode).config.base_bid=Number(event.target.value);};$('node-keywords').onchange=event=>{nodeById(state.selectedNode).config.keywords=event.target.value.split('\n').map(x=>x.trim()).filter(Boolean);};
$('delete-node').onclick=()=>{const id=state.selectedNode;state.selected.draft.nodes=state.selected.draft.nodes.filter(n=>n.id!==id);state.selected.draft.edges=state.selected.draft.edges.filter(e=>e.source!==id&&e.target!==id);state.selectedNode=null;renderCanvas();renderInspector();};
$('connect-mode').onclick=()=>{ if(!state.selectedNode){toast('先选择起点节点');return;}state.connectSource=state.selectedNode;renderCanvas();toast('请选择目标节点');};
$('add-node').onclick=()=>{const tpl=templates[state.selected.draft.template],role=tpl.roles.length===1?tpl.roles[0]:prompt(`输入角色：${tpl.roles.join(' / ')}`,tpl.roles[0]);if(!tpl.roles.includes(role))return toast('该模板不允许此角色');const base=role.replace(/[^a-z0-9_]/gi,'_'),count=state.selected.draft.nodes.filter(n=>n.role===role).length+1,id=`${base}_${count}`;const agent=state.agents.find(a=>a.enabled);if(!agent)return toast('请先创建可用智能体');state.selected.draft.nodes.push({id,role,agent_id:agent.id,position:{x:80+count*45,y:80+count*95},config:{base_bid:.5,keywords:[]}});renderCanvas();};

$('save-draft').onclick=async()=>{try{$('save-state').textContent='保存中…';const result=await api(`/api/admin/orchestrations/${state.selected.id}/draft`,{method:'PUT',headers:{'If-Match':`"${state.selected.draft_version}"`},body:{name:state.selected.name,description:state.selected.description,draft:state.selected.draft}});state.selected=result;$('save-state').textContent='已同步';toast('草稿已保存');await loadAll();}catch(error){$('save-state').textContent='保存冲突';toast(error.message);}};
$('validate-draft').onclick=async()=>{try{const result=await api(`/api/admin/orchestrations/${state.selected.id}/validate`,{method:'POST'});showValidation(result);return result;}catch(error){showValidation({valid:false,issues:[{message:error.message}]});}};
$('publish-draft').onclick=async()=>{const result=await $('validate-draft').onclick();if(!result?.valid)return;try{await api(`/api/admin/orchestrations/${state.selected.id}/publish`,{method:'POST'});toast('不可变版本已发布，新的 Chainlit 会话可以选择它');await loadAll();}catch(error){toast(error.message);}};
function showValidation(result){const bar=$('validation-bar');bar.classList.remove('hidden','ok','error');bar.classList.add(result.valid?'ok':'error');bar.textContent=result.valid?'✓ 图结构、角色和智能体绑定全部通过校验':result.issues.map(x=>`${x.path||''} ${x.message}`).join(' · ');}

$('new-connection').onclick=()=>openDialog({title:'新建 Coze 连接',fields:field('连接名称','name')+field('Base URL','base_url')+field('Service Token','token','password')+field('Token 到期时间（可留空）','token_expires_at','datetime-local'),submit:form=>api('/api/admin/connections',{method:'POST',body:{...form,base_url:form.base_url||'https://api.coze.cn',token_expires_at:form.token_expires_at||null,enabled:true}})});
$('new-agent').onclick=()=>{if(!state.connections.length)return toast('请先创建 Coze 连接');openDialog({title:'注册智能体',fields:field('唯一标识','slug')+field('显示名称','display_name')+field('类型','kind','select',[['coze_chat','Coze Chat'],['coze_workflow','Coze Workflow']])+field('连接','connection_id','select',state.connections.map(x=>[x.id,x.name]))+field('Bot / Workflow ID','remote_id'),submit:form=>api('/api/admin/agents',{method:'POST',body:{...form,description:'',enabled:true,timeout_seconds:60,max_retries:3}})});};
$('new-user').onclick=()=>openDialog({title:'新建平台用户',fields:field('用户名','username')+field('初始密码','password','password')+field('角色','role','select',[['user','普通用户'],['admin','管理员']]),submit:form=>api('/api/admin/users',{method:'POST',body:{...form,active:true}})});
$('new-orchestration').onclick=()=>{if(!state.agents.length)return toast('请先注册至少一个智能体');openDialog({title:'新建编排方案',fields:field('唯一标识','slug')+field('显示名称','name')+field('安全模板','template','select',Object.entries(templates).map(([k,v])=>[k,v.label])),submit:async form=>{const tpl=templates[form.template],agent=state.agents.find(a=>a.enabled),nodes=tpl.defaults.map(([role,id],index)=>({id,role,agent_id:agent.id,position:{x:80+(index%2)*300,y:90+Math.floor(index/2)*180},config:{base_bid:.5,keywords:[]}})),draft={template:form.template,nodes,edges:tpl.edges.map(([source,target])=>({source,target,condition:null})),settings:{max_turns:8,...(form.template==='handoff'?{entry_node:nodes[0].id}:{})}};await api('/api/admin/orchestrations',{method:'POST',body:{slug:form.slug,name:form.name,description:'',draft,enabled:true}});}});};

async function loadAudit(){const data=await api('/api/admin/audit');$('audit-table').innerHTML=data.items.map(item=>`<tr><td>${formatDate(item.created_at)}</td><td>${escapeHtml(item.actor)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.resource_type)} · ${escapeHtml(item.resource_id)}</td></tr>`).join('');}
$('refresh-audit').onclick=loadAudit;

loadAll().catch(error=>toast(`加载失败：${error.message}`));
