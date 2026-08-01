// 资源管理视图：总览、编排列表、智能体、Coze 连接、用户、审计日志。

import { api, errorText } from './api.js';
import { store, loadAll, connectionById } from './store.js';
import { TEMPLATES, SLUG_RE, initialDraft } from './meta.js';
import {
  esc, formatDate, timeAgo, toast, openModal, closeModal, confirmDanger,
  showMenu, icons, emptyState, switchHtml, debounce,
} from './ui.js';

/* ---------- 公共 ---------- */

function pageHead(title, sub, actionsHtml = '') {
  return `<div class="page-head">
    <div><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p></div>
    <div class="page-actions">${actionsHtml}</div>
  </div>`;
}

function searchBox(placeholder) {
  return `<div class="search">${icons.search}<input type="search" data-search placeholder="${esc(placeholder)}" /></div>`;
}

const enabledBadge = (enabled) =>
  enabled
    ? '<span class="badge ok"><span class="dot"></span>启用</span>'
    : '<span class="badge"><span class="dot"></span>停用</span>';

const ROLE_LABELS = { admin: '管理员', teacher: '教师', student: '学生', user: '普通用户' };
const roleLabel = (role) => ROLE_LABELS[role] ?? role;
const audienceText = (draft) =>
  (draft?.audience_roles ?? ['teacher', 'student', 'user']).map(roleLabel).join('、');

async function run(action, { success, onDone } = {}) {
  try {
    await action();
    if (success) toast(success, 'success');
    await loadAll();
    onDone?.();
  } catch (error) {
    toast(errorText(error), 'error');
    onDone?.();
  }
}

/* ---------- 总览 ---------- */

export async function renderDashboard(root) {
  const audit = await api('/api/admin/audit?limit=8');
  const published = store.orchestrations.filter((o) => o.active_revision_id).length;
  const steps = [
    { done: store.connections.length > 0, title: '配置 Coze 连接', hint: '录入 Coze API 地址与 Service Token，凭据加密存储。', href: '#/connections' },
    { done: store.agents.length > 0, title: '注册智能体', hint: '把 Coze Bot 或 Workflow 注册为可编排的受信节点。', href: '#/agents' },
    { done: store.orchestrations.length > 0, title: '搭建编排', hint: '选择协作模板，在画布上编排多智能体协作方式。', href: '#/orchestrations' },
    { done: published > 0, title: '发布版本', hint: '通过校验后发布不可变版本，聊天入口即可选用。', href: '#/orchestrations' },
  ];
  root.innerHTML = `<div class="page">
    ${pageHead('总览', '多智能体编排平台的资源与最近动态')}
    <div class="stat-grid">
      <div class="panel stat-card">
        <span class="ico"><svg viewBox="0 0 24 24"><path d="M4 5a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm12 14a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm0-14a2 2 0 1 1 4 0 2 2 0 0 1-4 0ZM4 19a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm2-10v6m12-6v6M8 5h8M8 19h8"/></svg></span>
        <span class="num">${store.orchestrations.length}</span><span class="lbl">编排方案</span><span class="extra">${published} 个已发布</span>
      </div>
      <div class="panel stat-card">
        <span class="ico" style="background:var(--ok-soft);color:var(--ok)"><svg viewBox="0 0 24 24"><path d="M12 3a2 2 0 0 1 2 2v1h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2Zm-3.5 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg></span>
        <span class="num">${store.agents.length}</span><span class="lbl">智能体</span><span class="extra">${store.agents.filter((a) => a.enabled).length} 个启用中</span>
      </div>
      <div class="panel stat-card">
        <span class="ico" style="background:var(--warn-soft);color:var(--warn)"><svg viewBox="0 0 24 24"><path d="M10.6 13.4a4 4 0 0 1 0-5.6l3-3a4 4 0 1 1 5.6 5.6l-1.6 1.6-1.4-1.4 1.6-1.6a2 2 0 1 0-2.8-2.8l-3 3a2 2 0 0 0 0 2.8l-1.4 1.4Zm2.8-2.8a4 4 0 0 1 0 5.6l-3 3a4 4 0 0 1-5.6-5.6l1.6-1.6 1.4 1.4-1.6 1.6a2 2 0 1 0 2.8 2.8l3-3a2 2 0 0 0 0-2.8l1.4-1.4Z"/></svg></span>
        <span class="num">${store.connections.length}</span><span class="lbl">Coze 连接</span><span class="extra">${store.connections.filter((c) => c.enabled).length} 个启用中</span>
      </div>
      <div class="panel stat-card">
        <span class="ico" style="background:#fdeef7;color:#c02c8c"><svg viewBox="0 0 24 24"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0H2Zm15.5-9.3a3.5 3.5 0 0 0 0-6.4 5 5 0 0 1 0 6.4ZM22 20h-4a8.9 8.9 0 0 0-2.5-6A6.5 6.5 0 0 1 22 20Z"/></svg></span>
        <span class="num">${store.users.length}</span><span class="lbl">平台用户</span><span class="extra">${store.users.filter((u) => u.role === 'admin').length} 名管理员</span>
      </div>
    </div>
    <div class="dash-cols">
      <div class="panel">
        <div class="dash-panel-head"><h3>最近操作</h3><a href="#/audit" style="font-size:12.5px">全部审计</a></div>
        <div class="table-wrap">
          ${audit.items.length ? `<table><tbody>
            ${audit.items.map((item) => `<tr>
              <td style="width:130px;color:var(--text-3);font-size:12.5px">${esc(timeAgo(item.created_at))}</td>
              <td><b style="font-weight:550">${esc(item.actor)}</b> <span style="color:var(--text-2)">${esc(actionText(item.action))}</span></td>
              <td class="mono" style="text-align:right;color:var(--text-3)">${esc(item.resource_type)}</td>
            </tr>`).join('')}
          </tbody></table>` : emptyState({ title: '暂无操作记录', hint: '配置、发布与账户变更会记录在这里。' })}
        </div>
      </div>
      <div class="panel">
        <div class="dash-panel-head"><h3>快速开始</h3></div>
        <div class="step-list">
          ${steps.map((step, index) => `<div class="step-item ${step.done ? 'done' : ''}">
            <span class="step-no">${step.done ? '✓' : index + 1}</span>
            <div><b>${esc(step.title)}</b><small>${esc(step.hint)}</small>${step.done ? '' : ` <a href="${step.href}">前往 →</a>`}</div>
          </div>`).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

const ACTION_TEXT = {
  'connection.create': '创建了连接', 'connection.update': '更新了连接', 'connection.delete': '删除了连接',
  'agent.create': '注册了智能体', 'agent.update': '更新了智能体', 'agent.delete': '删除了智能体',
  'orchestration.create': '创建了编排', 'orchestration.delete': '删除了编排',
  'orchestration.create_from_scenario': '从教育场景创建了编排',
  'orchestration.draft.update': '保存了编排草稿', 'orchestration.draft.restore': '回滚了编排草稿',
  'orchestration.publish': '发布了编排版本', 'orchestration.toggle': '切换了编排状态',
  'user.create': '创建了用户', 'user.update': '更新了用户', 'user.delete': '删除了用户', 'user.bootstrap': '初始化了账户',
};
const actionText = (action) => ACTION_TEXT[action] ?? action;

/* ---------- 编排列表 ---------- */

export async function renderOrchestrations(root) {
  root.innerHTML = `<div class="page">
    ${pageHead('智能体编排', '选择协作模板，用画布搭建、校验并发布多智能体图', `<button class="button" data-new>${icons.plus}新建编排</button>`)}
    <div class="toolbar">${searchBox('搜索名称或标识…')}</div>
    <div data-list></div>
  </div>`;
  const list = root.querySelector('[data-list]');
  const input = root.querySelector('[data-search]');

  const draw = () => {
    const query = input.value.trim().toLowerCase();
    const items = store.orchestrations.filter((o) =>
      !query || o.name.toLowerCase().includes(query) || o.slug.toLowerCase().includes(query));
    if (!items.length) {
      list.innerHTML = emptyState({
        title: query ? '没有匹配的编排' : '还没有编排方案',
        hint: query ? '换个关键词试试。' : '从一个协作模板开始，在画布上搭建多智能体协作。',
      });
      return;
    }
    list.innerHTML = `<div class="card-grid">${items.map((item) => {
      const template = TEMPLATES[item.draft?.template] ?? { label: item.draft?.template, icon: '⬡' };
      const status = item.active_revision_id
        ? (item.enabled ? '<span class="badge ok"><span class="dot"></span>已发布</span>' : '<span class="badge warn"><span class="dot"></span>已下线</span>')
        : '<span class="badge accent"><span class="dot"></span>草稿</span>';
      return `<article class="panel res-card" data-id="${item.id}">
        <header>
          <div style="min-width:0"><h3>${esc(item.name)}</h3><span class="mono" style="color:var(--text-3)">${esc(item.slug)}</span></div>
          ${status}
        </header>
        <p class="desc">${esc(item.description || template.label + ' 模板')}</p>
        <dl class="meta">
          <dt>模板</dt><dd>${template.icon} ${esc(template.label)}</dd>
          <dt>受众</dt><dd>${esc(audienceText(item.draft))}</dd>
          ${item.draft?.scenario_key ? `<dt>场景</dt><dd>${esc(item.draft.scenario_key)}</dd>` : ''}
          <dt>节点</dt><dd>${item.draft?.nodes?.length ?? 0} 个 · 草稿 v${item.draft_version}</dd>
          <dt>更新</dt><dd>${esc(timeAgo(item.updated_at))}</dd>
        </dl>
        <footer>
          <button class="button subtle small" data-open>打开画布</button>
          <span class="spacer"></span>
          ${switchHtml(item.enabled, `data-toggle title="${item.enabled ? '对聊天可见' : '已对聊天隐藏'}"`)}
          <button class="icon-button" data-menu aria-label="更多操作">${icons.more}</button>
        </footer>
      </article>`;
    }).join('')}</div>`;

    list.querySelectorAll('[data-id]').forEach((card) => {
      const id = card.dataset.id;
      const item = store.orchestrations.find((o) => o.id === id);
      card.querySelector('[data-open]').addEventListener('click', () => { location.hash = `#/orchestrations/${id}`; });
      card.querySelector('input[data-toggle]').addEventListener('change', () =>
        run(() => api(`/api/admin/orchestrations/${id}/toggle`, { method: 'POST' }), { onDone: draw }));
      card.querySelector('[data-menu]').addEventListener('click', (event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        showMenu(rect.left, rect.bottom + 4, [
          { label: '打开画布', icon: icons.edit, onClick: () => { location.hash = `#/orchestrations/${id}`; } },
          'sep',
          {
            label: '删除编排', icon: icons.trash, danger: true,
            onClick: async () => {
              const ok = await confirmDanger({
                title: '删除编排方案',
                message: `将永久删除 <b>${esc(item.name)}</b> 及其全部已发布版本${item.active_revision_id ? '，已绑定该编排的历史会话将无法继续' : ''}。此操作不可撤销。`,
              });
              if (ok) await run(() => api(`/api/admin/orchestrations/${id}`, { method: 'DELETE' }), { success: '编排已删除', onDone: draw });
            },
          },
        ]);
      });
    });
  };

  input.addEventListener('input', debounce(draw, 120));
  root.querySelector('[data-new]').addEventListener('click', openCreateOrchestration);
  draw();
}

function openCreateOrchestration() {
  const enabledAgent = store.agents.find((a) => a.enabled && a.kind === 'coze_chat') ?? store.agents.find((a) => a.enabled);
  if (!enabledAgent) {
    toast('请先在「智能体」页注册至少一个启用的智能体', 'error');
    return;
  }
  const chatAgents = store.agents.filter((agent) => agent.enabled && agent.kind === 'coze_chat');
  let selectedTemplate = 'topic_auction';
  let selectedScenarioKey = '';
  const form = openModal({
    title: '新建编排方案',
    wide: true,
    submitText: '创建并打开画布',
    fieldsHtml: `
      <div class="form-grid">
        <label class="field"><span>显示名称</span><input name="name" required maxlength="160" placeholder="如：售后问题分诊" /></label>
        <label class="field"><span>唯一标识 <span class="hint">小写字母开头，可含数字、_、-</span></span><input name="slug" required placeholder="如：aftersale-triage" /></label>
        <label class="field full"><span>描述（可选）</span><input name="description" maxlength="2000" placeholder="展示在聊天入口的说明文字" /></label>
      </div>
      <div class="field"><span>创建方式 <span class="hint">教育场景会自动生成角色、布局、连线与受众范围</span></span>
        <div class="template-picker">
          <button type="button" class="template-option selected" data-choice="">
            <span class="t-icon">⬡</span><span><b>空白编排</b><small>从通用安全模板开始，自行配置节点。</small></span>
          </button>
          ${store.educationScenarios.map((scenario) => `
            <button type="button" class="template-option" data-choice="${esc(scenario.key)}">
              <span class="t-icon">${scenario.audience_roles.includes('teacher') ? '👩‍🏫' : '🎓'}</span>
              <span><b>${esc(scenario.name)}</b><small>${esc(scenario.description)}</small></span>
            </button>`).join('')}
        </div>
      </div>
      <div class="field" data-template-section><span>协作模板 <span class="hint">决定角色与连线规则，创建后不可更改</span></span>
        <div class="template-picker">
          ${Object.entries(TEMPLATES).map(([key, t]) => `
            <button type="button" class="template-option ${key === selectedTemplate ? 'selected' : ''}" data-template="${key}">
              <span class="t-icon">${t.icon}</span>
              <span><b>${esc(t.label)}</b><small>${esc(t.description)}</small></span>
            </button>`).join('')}
        </div>
      </div>
      <div data-scenario-section hidden></div>`,
    onSubmit: async (formEl) => {
      const data = Object.fromEntries(new FormData(formEl));
      if (!SLUG_RE.test(data.slug)) throw Object.assign(new Error(), { userMessage: '标识需以小写字母开头，3-80 位，仅含小写字母、数字、_ 和 -' });
      let created;
      if (selectedScenarioKey) {
        const scenario = store.educationScenarios.find((item) => item.key === selectedScenarioKey);
        const agent_mapping = Object.fromEntries(
          scenario.roles.map((role) => [role.key, data[`agent_${role.key}`]]),
        );
        created = await api('/api/admin/orchestrations/from-scenario', {
          method: 'POST',
          body: {
            scenario_key: scenario.key, slug: data.slug, name: data.name,
            description: data.description || null, agent_mapping, enabled: true,
          },
        });
      } else {
        const draft = initialDraft(selectedTemplate, enabledAgent.id);
        created = await api('/api/admin/orchestrations', {
          method: 'POST',
          body: { slug: data.slug, name: data.name, description: data.description ?? '', draft, enabled: true },
        });
      }
      closeModal();
      await loadAll();
      toast(selectedScenarioKey ? '教育场景编排已创建' : '编排已创建', 'success');
      location.hash = `#/orchestrations/${created.id}`;
    },
  });

  const renderScenario = () => {
    const section = form.querySelector('[data-scenario-section]');
    const templateSection = form.querySelector('[data-template-section]');
    const scenario = store.educationScenarios.find((item) => item.key === selectedScenarioKey);
    templateSection.hidden = Boolean(scenario);
    section.hidden = !scenario;
    if (!scenario) { section.innerHTML = ''; return; }
    section.innerHTML = `<div class="field">
      <span>${esc(scenario.name)} <span class="hint">${esc(roleLabel(scenario.audience_roles[0]))}专属 · ${esc(TEMPLATES[scenario.template]?.label ?? scenario.template)}</span></span>
      <p class="palette-note">${esc(scenario.description)} 所有角色必须使用 Coze Chat；可以让一个智能体临时承担多个角色。</p>
      <div class="fields">
        ${scenario.roles.map((role, index) => `<label class="field"><span>${esc(role.display_name)} <span class="hint">${esc(role.description)}</span></span>
          <select name="agent_${esc(role.key)}" required>
            ${chatAgents.map((agent, agentIndex) => `<option value="${agent.id}" ${agentIndex === index % Math.max(chatAgents.length, 1) ? 'selected' : ''}>${esc(agent.display_name)} · ${esc(agent.slug)}</option>`).join('')}
          </select></label>`).join('')}
      </div>
      ${chatAgents.length ? '' : '<span class="hint" style="color:var(--danger)">没有启用的 Coze Chat 智能体，无法创建此场景。</span>'}
    </div>`;
  };

  form.querySelectorAll('[data-choice]').forEach((option) =>
    option.addEventListener('click', () => {
      selectedScenarioKey = option.dataset.choice;
      form.querySelectorAll('[data-choice]').forEach((el) => el.classList.toggle('selected', el === option));
      renderScenario();
    }));
  form.querySelectorAll('[data-template]').forEach((option) =>
    option.addEventListener('click', () => {
      selectedTemplate = option.dataset.template;
      form.querySelectorAll('[data-template]').forEach((el) => el.classList.toggle('selected', el === option));
    }));
}

/* ---------- 智能体 ---------- */

export async function renderAgents(root) {
  root.innerHTML = `<div class="page">
    ${pageHead('智能体', '将 Coze Bot 或 Workflow 注册为编排中的受信节点', `<button class="button" data-new>${icons.plus}注册智能体</button>`)}
    <div class="toolbar">
      ${searchBox('搜索名称或标识…')}
      <select data-kind style="width:150px"><option value="">全部类型</option><option value="coze_chat">Coze Chat</option><option value="coze_workflow">Coze Workflow</option></select>
      <span class="spacer"></span>
    </div>
    <div class="panel table-wrap" data-list></div>
  </div>`;
  const list = root.querySelector('[data-list]');
  const input = root.querySelector('[data-search]');
  const kindSel = root.querySelector('[data-kind]');

  const draw = () => {
    const query = input.value.trim().toLowerCase();
    const kind = kindSel.value;
    const items = store.agents.filter((a) =>
      (!kind || a.kind === kind)
      && (!query || a.display_name.toLowerCase().includes(query) || a.slug.toLowerCase().includes(query)));
    if (!items.length) {
      list.innerHTML = emptyState({
        title: query || kind ? '没有匹配的智能体' : '还没有智能体',
        hint: query || kind ? '调整搜索或筛选条件。' : store.connections.length ? '注册 Coze Bot 或 Workflow 后即可在画布中使用。' : '请先在「Coze 连接」页配置连接，再注册智能体。',
      });
      return;
    }
    list.innerHTML = `<table>
      <thead><tr><th>智能体</th><th>类型</th><th>连接</th><th>远端 ID</th><th>容错</th><th>状态</th><th style="width:90px"></th></tr></thead>
      <tbody>${items.map((item) => `<tr data-id="${item.id}">
        <td><b style="font-weight:600">${esc(item.display_name)}</b><br /><span class="mono">${esc(item.slug)}</span></td>
        <td>${item.kind === 'coze_chat' ? '<span class="badge accent">Chat</span>' : '<span class="badge warn">Workflow</span>'}</td>
        <td>${esc(item.connection_name ?? '—')}</td>
        <td class="mono">${esc(item.remote_id)}</td>
        <td style="color:var(--text-2);font-size:12.5px">${item.timeout_seconds}s · 重试 ${item.max_retries}</td>
        <td>${switchHtml(item.enabled, 'data-toggle')}</td>
        <td><div class="row-actions">
          <button class="icon-button" data-edit title="编辑">${icons.edit}</button>
          <button class="icon-button danger" data-del title="删除">${icons.trash}</button>
        </div></td>
      </tr>`).join('')}</tbody>
    </table>`;

    list.querySelectorAll('tr[data-id]').forEach((row) => {
      const item = store.agents.find((a) => a.id === row.dataset.id);
      row.querySelector('input[data-toggle]').addEventListener('change', (event) =>
        run(() => api(`/api/admin/agents/${item.id}`, { method: 'PUT', body: agentBody({ ...item, enabled: event.target.checked }) }),
          { onDone: draw }));
      row.querySelector('[data-edit]').addEventListener('click', () => openAgentModal(item, draw));
      row.querySelector('[data-del]').addEventListener('click', async () => {
        const ok = await confirmDanger({
          title: '删除智能体',
          message: `将删除 <b>${esc(item.display_name)}</b>。仍被已发布编排引用的智能体无法删除。`,
        });
        if (ok) await run(() => api(`/api/admin/agents/${item.id}`, { method: 'DELETE' }), { success: '智能体已删除', onDone: draw });
      });
    });
  };

  input.addEventListener('input', debounce(draw, 120));
  kindSel.addEventListener('change', draw);
  root.querySelector('[data-new]').addEventListener('click', () => openAgentModal(null, draw));
  draw();
}

const agentBody = (item) => ({
  slug: item.slug,
  display_name: item.display_name,
  description: item.description ?? '',
  kind: item.kind,
  connection_id: item.connection_id,
  remote_id: item.remote_id,
  enabled: item.enabled,
  timeout_seconds: item.timeout_seconds,
  max_retries: item.max_retries,
});

function openAgentModal(item, onDone) {
  if (!store.connections.length) {
    toast('请先在「Coze 连接」页创建连接', 'error');
    return;
  }
  openModal({
    title: item ? `编辑智能体 · ${item.display_name}` : '注册智能体',
    wide: true,
    fieldsHtml: `<div class="form-grid">
      <label class="field"><span>显示名称</span><input name="display_name" required maxlength="160" value="${esc(item?.display_name ?? '')}" /></label>
      <label class="field"><span>唯一标识</span><input name="slug" required value="${esc(item?.slug ?? '')}" placeholder="如：faq-bot" /></label>
      <label class="field"><span>类型 <span class="hint">Workflow 仅限特定角色使用</span></span>
        <select name="kind">
          <option value="coze_chat" ${item?.kind !== 'coze_workflow' ? 'selected' : ''}>Coze Chat（对话智能体）</option>
          <option value="coze_workflow" ${item?.kind === 'coze_workflow' ? 'selected' : ''}>Coze Workflow（工作流）</option>
        </select></label>
      <label class="field"><span>所属连接</span>
        <select name="connection_id">${store.connections.map((c) =>
          `<option value="${c.id}" ${item?.connection_id === c.id ? 'selected' : ''}>${esc(c.name)}${c.enabled ? '' : '（已停用）'}</option>`).join('')}</select></label>
      <label class="field full"><span>Bot / Workflow ID</span><input name="remote_id" required maxlength="256" value="${esc(item?.remote_id ?? '')}" placeholder="Coze 平台上的资源 ID" /></label>
      <label class="field"><span>超时（秒）</span><input name="timeout_seconds" type="number" min="5" max="600" value="${item?.timeout_seconds ?? 60}" /></label>
      <label class="field"><span>最大重试</span><input name="max_retries" type="number" min="0" max="8" value="${item?.max_retries ?? 3}" /></label>
      <label class="field full"><span>描述（可选）</span><textarea name="description" maxlength="2000" rows="2">${esc(item?.description ?? '')}</textarea></label>
    </div>`,
    onSubmit: async (formEl) => {
      const data = Object.fromEntries(new FormData(formEl));
      if (!SLUG_RE.test(data.slug)) throw Object.assign(new Error(), { userMessage: '标识需以小写字母开头，3-80 位，仅含小写字母、数字、_ 和 -' });
      const body = {
        slug: data.slug,
        display_name: data.display_name,
        description: data.description ?? '',
        kind: data.kind,
        connection_id: data.connection_id,
        remote_id: data.remote_id,
        enabled: item?.enabled ?? true,
        timeout_seconds: Number(data.timeout_seconds) || 60,
        max_retries: Number(data.max_retries) || 0,
      };
      try {
        if (item) await api(`/api/admin/agents/${item.id}`, { method: 'PUT', body });
        else await api('/api/admin/agents', { method: 'POST', body });
      } catch (error) {
        throw Object.assign(error, { userMessage: errorText(error) });
      }
      closeModal();
      toast(item ? '智能体已更新' : '智能体已注册', 'success');
      await loadAll();
      onDone();
    },
  });
}

/* ---------- Coze 连接 ---------- */

export async function renderConnections(root) {
  root.innerHTML = `<div class="page">
    ${pageHead('Coze 连接', 'API 凭据加密存储，任何接口都不会回显完整 Token', `<button class="button" data-new>${icons.plus}新建连接</button>`)}
    <div data-list></div>
  </div>`;
  const list = root.querySelector('[data-list]');

  const draw = () => {
    if (!store.connections.length) {
      list.innerHTML = emptyState({ title: '还没有 Coze 连接', hint: '连接保存 Coze API 地址与 Service Token，是注册智能体的前提。' });
      return;
    }
    list.innerHTML = `<div class="card-grid">${store.connections.map((item) => {
      const expiring = item.token_expires_at && new Date(item.token_expires_at).getTime() - Date.now() < 7 * 86_400_000;
      const expired = item.token_expires_at && new Date(item.token_expires_at).getTime() <= Date.now();
      return `<article class="panel res-card" data-id="${item.id}">
        <header>
          <div style="min-width:0"><h3>${esc(item.name)}</h3></div>
          ${expired ? '<span class="badge danger"><span class="dot"></span>Token 已过期</span>' : enabledBadge(item.enabled)}
        </header>
        <dl class="meta">
          <dt>地址</dt><dd>${esc(item.base_url)}</dd>
          <dt>Token</dt><dd>${esc(item.masked_token)}</dd>
          <dt>到期</dt><dd ${expiring && !expired ? 'style="color:var(--warn)"' : ''}>${item.token_expires_at ? esc(formatDate(item.token_expires_at)) : '长期有效'}</dd>
        </dl>
        <footer>
          <button class="button subtle small" data-test>${icons.bolt}测试连接</button>
          <span class="spacer"></span>
          ${switchHtml(item.enabled, 'data-toggle')}
          <button class="icon-button" data-edit title="编辑">${icons.edit}</button>
          <button class="icon-button danger" data-del title="删除">${icons.trash}</button>
        </footer>
      </article>`;
    }).join('')}</div>`;

    list.querySelectorAll('[data-id]').forEach((card) => {
      const item = store.connections.find((c) => c.id === card.dataset.id);
      card.querySelector('[data-test]').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '测试中…';
        try {
          const result = await api(`/api/admin/connections/${item.id}/test`, { method: 'POST' });
          toast(result.message, result.ok ? 'success' : 'error');
        } catch (error) {
          toast(errorText(error), 'error');
        }
        draw();
      });
      card.querySelector('input[data-toggle]').addEventListener('change', (event) =>
        run(() => api(`/api/admin/connections/${item.id}`, {
          method: 'PUT',
          body: { name: item.name, base_url: item.base_url, token_expires_at: item.token_expires_at, enabled: event.target.checked },
        }), { onDone: draw }));
      card.querySelector('[data-edit]').addEventListener('click', () => openConnectionModal(item, draw));
      card.querySelector('[data-del]').addEventListener('click', async () => {
        const ok = await confirmDanger({
          title: '删除连接',
          message: `将删除 <b>${esc(item.name)}</b>。仍被智能体引用的连接无法删除。`,
        });
        if (ok) await run(() => api(`/api/admin/connections/${item.id}`, { method: 'DELETE' }), { success: '连接已删除', onDone: draw });
      });
    });
  };

  root.querySelector('[data-new]').addEventListener('click', () => openConnectionModal(null, draw));
  draw();
}

function openConnectionModal(item, onDone) {
  openModal({
    title: item ? `编辑连接 · ${item.name}` : '新建 Coze 连接',
    fieldsHtml: `
      <label class="field"><span>连接名称</span><input name="name" required minlength="2" maxlength="128" value="${esc(item?.name ?? '')}" placeholder="如：生产环境" /></label>
      <label class="field"><span>Base URL</span><input name="base_url" type="url" value="${esc(item?.base_url ?? 'https://api.coze.cn')}" /></label>
      <label class="field"><span>Service Token ${item ? '<span class="hint">留空则保持不变</span>' : ''}</span>
        <input name="token" type="password" autocomplete="new-password" ${item ? '' : 'required'} minlength="8" placeholder="${item ? '••••••••（不修改请留空）' : 'pat_...'}" /></label>
      <label class="field"><span>Token 到期时间 <span class="hint">可留空表示长期有效</span></span>
        <input name="token_expires_at" type="datetime-local" value="${item?.token_expires_at ? toLocalInput(item.token_expires_at) : ''}" /></label>`,
    onSubmit: async (formEl) => {
      const data = Object.fromEntries(new FormData(formEl));
      const body = {
        name: data.name,
        base_url: data.base_url || 'https://api.coze.cn',
        token_expires_at: data.token_expires_at ? new Date(data.token_expires_at).toISOString() : null,
        enabled: item?.enabled ?? true,
      };
      if (data.token) body.token = data.token;
      try {
        if (item) await api(`/api/admin/connections/${item.id}`, { method: 'PUT', body });
        else await api('/api/admin/connections', { method: 'POST', body });
      } catch (error) {
        throw Object.assign(error, { userMessage: errorText(error) });
      }
      closeModal();
      toast(item ? '连接已更新' : '连接已创建', 'success');
      await loadAll();
      onDone();
    },
  });
}

function toLocalInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* ---------- 用户 ---------- */

export async function renderUsers(root) {
  root.innerHTML = `<div class="page">
    ${pageHead('平台用户', '由管理员创建账户，系统不开放自助注册', `<button class="button" data-new>${icons.plus}新建用户</button>`)}
    <div class="panel table-wrap" data-list></div>
  </div>`;
  const list = root.querySelector('[data-list]');

  const draw = () => {
    list.innerHTML = `<table>
      <thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th style="width:90px"></th></tr></thead>
      <tbody>${store.users.map((item) => `<tr data-id="${item.id}">
        <td><b style="font-weight:600">${esc(item.username)}</b>${item.username === store.user.username ? ' <span class="badge" style="height:19px">当前账户</span>' : ''}</td>
        <td><span class="badge ${item.role === 'admin' ? 'accent' : ''}">${esc(roleLabel(item.role))}</span></td>
        <td>${switchHtml(item.active, `data-toggle ${item.username === store.user.username ? 'disabled' : ''}`)}</td>
        <td style="color:var(--text-2)">${esc(formatDate(item.created_at))}</td>
        <td><div class="row-actions">
          <button class="icon-button" data-edit title="编辑">${icons.edit}</button>
          <button class="icon-button danger" data-del title="删除" ${item.username === store.user.username ? 'disabled' : ''}>${icons.trash}</button>
        </div></td>
      </tr>`).join('')}</tbody>
    </table>`;

    list.querySelectorAll('tr[data-id]').forEach((row) => {
      const item = store.users.find((u) => u.id === row.dataset.id);
      row.querySelector('input[data-toggle]')?.addEventListener('change', (event) =>
        run(() => api(`/api/admin/users/${item.id}`, {
          method: 'PUT',
          body: { username: item.username, role: item.role, active: event.target.checked },
        }), { onDone: draw }));
      row.querySelector('[data-edit]').addEventListener('click', () => openUserModal(item, draw));
      row.querySelector('[data-del]').addEventListener('click', async () => {
        if (row.querySelector('[data-del]').disabled) return;
        const ok = await confirmDanger({
          title: '删除用户',
          message: `将删除账户 <b>${esc(item.username)}</b>，其历史会话记录保留但无法再登录。`,
        });
        if (ok) await run(() => api(`/api/admin/users/${item.id}`, { method: 'DELETE' }), { success: '用户已删除', onDone: draw });
      });
    });
  };

  root.querySelector('[data-new]').addEventListener('click', () => openUserModal(null, draw));
  draw();
}

function openUserModal(item, onDone) {
  openModal({
    title: item ? `编辑用户 · ${item.username}` : '新建平台用户',
    fieldsHtml: `
      <label class="field"><span>用户名</span><input name="username" required minlength="3" maxlength="128" value="${esc(item?.username ?? '')}" placeholder="字母、数字、_ . @ -" /></label>
      <label class="field"><span>${item ? '重置密码 <span class="hint">留空则保持不变</span>' : '初始密码'} </span>
        <input name="password" type="password" autocomplete="new-password" ${item ? '' : 'required'} minlength="12" maxlength="256" placeholder="至少 12 位" /></label>
      <label class="field"><span>角色</span>
        <select name="role">
          <option value="student" ${item?.role === 'student' ? 'selected' : ''}>学生（学生场景 + 公共编排）</option>
          <option value="teacher" ${item?.role === 'teacher' ? 'selected' : ''}>教师（教师场景 + 公共编排）</option>
          <option value="user" ${!item || item?.role === 'user' ? 'selected' : ''}>普通用户（仅公共编排）</option>
          <option value="admin" ${item?.role === 'admin' ? 'selected' : ''}>管理员（聊天 + 控制台）</option>
        </select></label>`,
    onSubmit: async (formEl) => {
      const data = Object.fromEntries(new FormData(formEl));
      try {
        if (item) {
          const body = { username: data.username, role: data.role, active: item.active };
          if (data.password) body.password = data.password;
          await api(`/api/admin/users/${item.id}`, { method: 'PUT', body });
        } else {
          await api('/api/admin/users', { method: 'POST', body: { username: data.username, password: data.password, role: data.role, active: true } });
        }
      } catch (error) {
        throw Object.assign(error, { userMessage: errorText(error) });
      }
      closeModal();
      toast(item ? '用户已更新' : '用户已创建', 'success');
      await loadAll();
      onDone();
    },
  });
}

/* ---------- 会话监控 ---------- */

const STEP_STATUS = {
  node_completed: { label: '完成', cls: 'ok' },
  node_failed: { label: '失败', cls: 'danger' },
  node_retrying: { label: '重试', cls: 'warn' },
  node_cached: { label: '缓存', cls: '' },
};

export async function renderSessions(root) {
  root.innerHTML = `<div class="page">
    ${pageHead('会话监控', '查看每个用户会话的完整对话与编排节点执行过程', '<button class="button subtle" data-refresh>刷新</button>')}
    <div class="toolbar">
      ${searchBox('按用户或会话标题搜索…')}
      <select data-orch style="width:190px"><option value="">全部编排</option>
        ${store.orchestrations.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}
      </select>
      <select data-limit style="width:130px">
        <option value="50">最近 50 条</option>
        <option value="100">最近 100 条</option>
        <option value="200">最近 200 条</option>
      </select>
    </div>
    <div class="panel table-wrap" data-list></div>
  </div>`;
  const list = root.querySelector('[data-list]');
  const input = root.querySelector('[data-search]');
  const orchSel = root.querySelector('[data-orch]');
  const limitSel = root.querySelector('[data-limit]');

  const load = async () => {
    list.innerHTML = '<div class="skeleton" style="height:200px;margin:14px"></div>';
    const params = new URLSearchParams({ limit: limitSel.value });
    if (input.value.trim()) params.set('q', input.value.trim());
    if (orchSel.value) params.set('orchestration_id', orchSel.value);
    let items;
    try {
      items = (await api(`/api/admin/sessions?${params}`)).items;
    } catch (error) {
      list.innerHTML = emptyState({ title: '加载失败', hint: errorText(error) });
      return;
    }
    if (!items.length) {
      list.innerHTML = emptyState({ title: '暂无会话', hint: '用户在聊天入口发起对话后，会话与执行过程会出现在这里。' });
      return;
    }
    list.innerHTML = `<table>
      <thead><tr><th>会话</th><th>用户</th><th>编排</th><th>消息</th><th>开始时间</th><th style="width:80px"></th></tr></thead>
      <tbody>${items.map((item) => `<tr data-id="${esc(item.id)}" style="cursor:pointer">
        <td><b style="font-weight:600">${esc(item.name || '未命名会话')}</b><br /><span class="mono">${esc(item.id)}</span></td>
        <td>${esc(item.username || item.user_identifier || '—')}</td>
        <td>${item.orchestration_name ? `${esc(item.orchestration_name)} <span class="badge accent" style="height:19px">v${item.revision_version ?? '?'}</span>` : '<span style="color:var(--text-3)">未绑定</span>'}</td>
        <td>${item.message_count ?? 0}</td>
        <td style="color:var(--text-2)">${esc(formatDate(item.created_at))}</td>
        <td><button class="button subtle small" data-view>查看</button></td>
      </tr>`).join('')}</tbody>
    </table>`;
    list.querySelectorAll('tr[data-id]').forEach((row) => {
      const open = () => openSessionDrawer(row.dataset.id);
      row.querySelector('[data-view]').addEventListener('click', (event) => { event.stopPropagation(); open(); });
      row.addEventListener('click', open);
    });
  };

  input.addEventListener('input', debounce(load, 300));
  orchSel.addEventListener('change', load);
  limitSel.addEventListener('change', load);
  root.querySelector('[data-refresh]').addEventListener('click', load);
  await load();
}

function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms) || ms < 0) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function stepDuration(step) {
  if (!step.start || !step.finish) return '';
  return fmtMs(new Date(step.finish) - new Date(step.start));
}

/** 节点级首字时间：节点开始到产出第一个可见 token 的间隔。 */
function stepTtft(step) {
  const first = step.metadata?.first_token_at;
  const start = step.start || step.metadata?.started_at;
  if (!first || !start) return '';
  return fmtMs(new Date(first) - new Date(start));
}

async function openSessionDrawer(threadId) {
  const overlay = document.createElement('div');
  overlay.className = 'drawer-overlay';
  const drawer = document.createElement('div');
  drawer.className = 'drawer wide';
  drawer.innerHTML = `
    <div class="drawer-head"><h3>会话详情</h3>
      <button class="icon-button" data-close><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="drawer-body"><div class="skeleton" style="height:160px"></div></div>`;
  const close = () => { overlay.remove(); drawer.remove(); };
  overlay.addEventListener('pointerdown', close);
  drawer.querySelector('[data-close]').addEventListener('click', close);
  document.body.append(overlay, drawer);

  const body = drawer.querySelector('.drawer-body');
  let detail;
  try {
    detail = await api(`/api/admin/sessions/${encodeURIComponent(threadId)}`);
  } catch (error) {
    body.innerHTML = `<p class="insp-empty">${esc(errorText(error))}</p>`;
    return;
  }

  const timeline = detail.steps.map((step) => {
    if (step.type === 'user_message') {
      return `<div class="chat-row user"><div class="bubble user">${esc(step.output || step.input || '')}</div>
        <span class="chat-meta">${esc(detail.username || detail.user_identifier || '用户')} · ${esc(formatDate(step.created_at))}</span></div>`;
    }
    if (step.type === 'assistant_message') {
      const perf = [];
      if (step.metadata?.ttft_ms != null) perf.push(`首字 ${fmtMs(step.metadata.ttft_ms)}`);
      if (step.metadata?.total_ms != null) perf.push(`总耗时 ${fmtMs(step.metadata.total_ms)}`);
      return `<div class="chat-row ai"><div class="bubble ai">${esc(step.output || '')}</div>
        <span class="chat-meta">助手 · ${esc(formatDate(step.created_at))}${perf.length ? ' · ' + esc(perf.join(' · ')) : ''}</span></div>`;
    }
    const status = STEP_STATUS[step.output] ?? { label: step.output || '执行', cls: '' };
    const meta = step.metadata ?? {};
    const ttft = stepTtft(step);
    const rows = [
      ['类型', step.type || 'run'],
      ['开始', step.start ? formatDate(step.start) : '—'],
      ['结束', step.finish ? formatDate(step.finish) : '—'],
      ['总耗时', stepDuration(step) || '—'],
      ['首字时间', ttft || '—'],
      meta.task_id ? ['Task ID', meta.task_id] : null,
      meta.attempt != null ? ['重试次数', String(meta.attempt)] : null,
    ].filter(Boolean);
    const io = [
      step.input && step.input !== 'running' ? ['输入', step.input, ''] : null,
      step.output ? ['输出', step.output, ''] : null,
      meta.error ? ['错误详情', meta.error, 'error'] : null,
    ].filter(Boolean);
    return `<div class="trace-wrap">
      <button type="button" class="trace-item ${step.is_error ? 'error' : ''}" data-trace>
        <span class="trace-dot ${status.cls}"></span>
        <span class="trace-name mono">${esc(step.name || step.type)}</span>
        <span class="badge ${status.cls}" style="height:19px">${esc(status.label)}</span>
        <span class="trace-time">${esc(ttft ? `首字 ${ttft} · 总 ${stepDuration(step)}` : stepDuration(step))}</span>
        <svg class="trace-chev" viewBox="0 0 24 24"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="trace-detail" hidden>
        <div class="td-grid">${rows.map(([k, v]) => `<div><span>${esc(k)}</span><b class="mono">${esc(v)}</b></div>`).join('')}</div>
        ${io.map(([k, v, cls]) => `<div class="td-io ${cls}"><span>${esc(k)}</span><pre>${esc(v)}</pre></div>`).join('')}
      </div>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="sess-summary">
      <div><span class="lbl">会话</span><b>${esc(detail.name || '未命名会话')}</b></div>
      <div><span class="lbl">用户</span><b>${esc(detail.username || detail.user_identifier || '—')}</b></div>
      <div><span class="lbl">编排</span><b>${detail.orchestration_name ? `${esc(detail.orchestration_name)} · v${detail.revision_version ?? '?'}` : '未绑定'}</b></div>
      <div><span class="lbl">开始</span><b>${esc(formatDate(detail.created_at))}</b></div>
    </div>
    <h4 class="sess-h4">对话与执行过程 <span class="hint" style="text-transform:none;letter-spacing:0;font-weight:400">（点击执行节点可展开调试详情）</span></h4>
    <div class="chat-log">${timeline || '<p class="insp-empty">该会话暂无消息记录。</p>'}</div>`;

  body.querySelectorAll('[data-trace]').forEach((button) =>
    button.addEventListener('click', () => {
      const detail = button.nextElementSibling;
      detail.hidden = !detail.hidden;
      button.classList.toggle('open', !detail.hidden);
    }));
}

/* ---------- 系统监控 ---------- */

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes);
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function fmtUptime(seconds) {
  if (seconds == null) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分钟`;
  return `${m} 分钟`;
}

function meter(percent) {
  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const cls = value >= 90 ? 'danger' : value >= 75 ? 'warn' : '';
  return `<div class="meter ${cls}"><i style="width:${value}%"></i></div>`;
}

const kvRow = (label, value) => `<div class="sys-kv"><span>${esc(label)}</span><b>${value}</b></div>`;

export async function renderSystem(root) {
  root.innerHTML = `<div class="page">
    ${pageHead('系统监控', '单机部署的应用、主机与数据库运行状态（每 5 秒自动刷新）', '<button class="button subtle" data-refresh>立即刷新</button>')}
    <div data-body><div class="skeleton" style="height:280px"></div></div>
  </div>`;
  const bodyEl = root.querySelector('[data-body]');

  const draw = (s) => {
    const db = s.database ?? {};
    const pool = db.pool ?? {};
    const counts = db.counts ?? {};
    bodyEl.innerHTML = `
      <div class="stat-grid">
        <div class="panel stat-card">
          <span class="lbl">CPU 使用率</span>
          <span class="num">${(s.system.cpu_percent ?? 0).toFixed(0)}<small style="font-size:15px">%</small></span>
          ${meter(s.system.cpu_percent)}
          <span class="extra">${s.system.cpu_count} 核 · 进程占用 ${(s.process.cpu_percent ?? 0).toFixed(0)}%${s.system.load_1m != null ? ` · 负载 ${s.system.load_1m.toFixed(2)}` : ''}</span>
        </div>
        <div class="panel stat-card">
          <span class="lbl">内存</span>
          <span class="num">${(s.system.mem_percent ?? 0).toFixed(0)}<small style="font-size:15px">%</small></span>
          ${meter(s.system.mem_percent)}
          <span class="extra">${fmtBytes(s.system.mem_used)} / ${fmtBytes(s.system.mem_total)} · 进程 ${fmtBytes(s.process.rss_bytes)}</span>
        </div>
        <div class="panel stat-card">
          <span class="lbl">磁盘</span>
          <span class="num">${(s.system.disk_percent ?? 0).toFixed(0)}<small style="font-size:15px">%</small></span>
          ${meter(s.system.disk_percent)}
          <span class="extra">${fmtBytes(s.system.disk_used)} / ${fmtBytes(s.system.disk_total)}</span>
        </div>
        <div class="panel stat-card">
          <span class="lbl">数据库</span>
          <span class="num" style="font-size:20px;padding:3px 0">${db.ok ? '<span class="badge ok" style="height:26px;font-size:13px"><span class="dot"></span>正常</span>' : '<span class="badge danger" style="height:26px;font-size:13px"><span class="dot"></span>异常</span>'}</span>
          <span class="extra">${db.ok ? `查询延迟 ${db.latency_ms ?? '—'} ms · 数据量 ${fmtBytes(db.size_bytes)}` : '无法连接 PostgreSQL，请检查服务'}</span>
        </div>
      </div>
      <div class="dash-cols">
        <div class="panel">
          <div class="dash-panel-head"><h3>应用运行时</h3><span class="badge accent">单机部署</span></div>
          <div style="padding:8px 20px 14px">
            ${kvRow('持续运行', esc(fmtUptime(s.app.uptime_seconds)))}
            ${kvRow('启动时间', esc(formatDate(s.app.started_at)))}
            ${kvRow('应用版本', `<span class="mono">LingxiNext ${esc(s.app.version)}</span>`)}
            ${kvRow('运行环境', `<span class="mono">Python ${esc(s.app.python)} · ${esc(s.app.platform)}</span>`)}
            ${kvRow('进程线程数', esc(String(s.process.threads)))}
            ${kvRow('已编译图缓存', `${s.app.compiled_graphs} 个已发布版本在内存中就绪`)}
          </div>
        </div>
        <div class="panel">
          <div class="dash-panel-head"><h3>数据库与存储</h3></div>
          <div style="padding:8px 20px 14px">
            ${kvRow('连接池', pool.size != null ? `使用 ${pool.checked_out} / ${pool.size}（溢出 ${pool.overflow ?? 0}）` : '—')}
            ${kvRow('会话线程', `${counts.threads ?? '—'} 个（绑定 ${counts.thread_bindings ?? '—'}）`)}
            ${kvRow('消息与步骤', `${counts.steps ?? '—'} 条记录`)}
            ${kvRow('审计日志', `${counts.audit_logs ?? '—'} 条`)}
            ${kvRow('数据库体积', esc(fmtBytes(db.size_bytes)))}
          </div>
        </div>
      </div>`;
  };

  const load = async () => {
    try {
      draw(await api('/api/admin/system'));
    } catch (error) {
      bodyEl.innerHTML = emptyState({ title: '监控数据加载失败', hint: errorText(error) });
    }
  };

  const timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    load();
  }, 5000);
  root.querySelector('[data-refresh]').addEventListener('click', load);
  await load();
}

/* ---------- 审计日志 ---------- */

export async function renderAudit(root) {
  root.innerHTML = `<div class="page">
    ${pageHead('审计日志', '记录配置、发布、凭据与账户变更；不记录聊天内容或密钥明文', '<button class="button subtle" data-refresh>刷新</button>')}
    <div class="toolbar">
      ${searchBox('按操作者筛选…')}
      <select data-type style="width:150px">
        <option value="">全部资源</option>
        <option value="orchestration">编排</option>
        <option value="agent">智能体</option>
        <option value="connection">连接</option>
        <option value="user">用户</option>
      </select>
      <select data-limit style="width:120px">
        <option value="100">最近 100 条</option>
        <option value="200">最近 200 条</option>
        <option value="500">最近 500 条</option>
      </select>
    </div>
    <div class="panel table-wrap" data-list></div>
  </div>`;
  const list = root.querySelector('[data-list]');
  const input = root.querySelector('[data-search]');
  const typeSel = root.querySelector('[data-type]');
  const limitSel = root.querySelector('[data-limit]');
  let items = [];

  const draw = () => {
    const query = input.value.trim().toLowerCase();
    const type = typeSel.value;
    const rows = items.filter((item) =>
      (!type || item.resource_type === type) && (!query || item.actor.toLowerCase().includes(query)));
    list.innerHTML = rows.length ? `<table>
      <thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>资源</th></tr></thead>
      <tbody>${rows.map((item) => `<tr>
        <td style="white-space:nowrap;color:var(--text-2)">${esc(formatDate(item.created_at))}</td>
        <td><b style="font-weight:550">${esc(item.actor)}</b></td>
        <td>${esc(actionText(item.action))} <span class="mono" style="color:var(--text-3)">${esc(item.action)}</span></td>
        <td class="mono">${esc(item.resource_type)}${item.resource_id ? ` · ${esc(item.resource_id.slice(0, 8))}` : ''}</td>
      </tr>`).join('')}</tbody>
    </table>` : emptyState({ title: '没有匹配的记录', hint: '调整筛选条件或时间范围。' });
  };

  const load = async () => {
    list.innerHTML = '<div class="skeleton" style="height:200px;margin:14px"></div>';
    items = (await api(`/api/admin/audit?limit=${limitSel.value}`)).items;
    draw();
  };

  input.addEventListener('input', debounce(draw, 120));
  typeSel.addEventListener('change', draw);
  limitSel.addEventListener('change', load);
  root.querySelector('[data-refresh]').addEventListener('click', () => load().catch((e) => toast(errorText(e), 'error')));
  await load();
}
