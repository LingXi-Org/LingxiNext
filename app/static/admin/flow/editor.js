// 编排画布编辑器：草稿模型、历史（撤销/重做）、检查器、校验、发布与版本管理。

import { api, errorText } from '../api.js';
import { store, loadAll, agentById } from '../store.js';
import {
  TEMPLATES, roleMeta, edgeAllowed, requiredEdges, agentUsable, NODE_ID_RE,
} from '../meta.js';
import {
  esc, toast, showMenu, confirmDanger, openModal, closeModal, icons, formatDate, timeAgo, debounce,
} from '../ui.js';
import { FlowCanvas } from './canvas.js';

let ed = null; // 当前编辑器实例状态

export function editorGuard(silent = false) {
  if (!ed?.dirty) return true;
  if (silent) return false;
  return window.confirm('画布有未保存的修改，确定离开吗？');
}

export function unmountEditor() {
  if (!ed) return;
  document.removeEventListener('keydown', ed.onKeydown, true);
  ed.canvas?.destroy();
  ed.root.innerHTML = '';
  ed = null;
}

export async function mountEditor(root, id) {
  if (ed?.record?.id === id) return;
  unmountEditor();
  root.innerHTML = '<div class="skeleton" style="height:100%;border-radius:0"></div>';
  let record;
  try {
    if (!store.ready) await loadAll();
    record = await api(`/api/admin/orchestrations/${id}`);
  } catch (error) {
    toast(errorText(error), 'error');
    location.hash = '#/orchestrations';
    return;
  }

  ed = {
    root,
    record,
    draft: structuredClone(record.draft),
    name: record.name,
    description: record.description,
    dirty: false,
    undoStack: [],
    redoStack: [],
    validation: null,
    canvas: null,
    onKeydown: null,
  };

  renderShell();
  bindShell();

  ed.canvas = new FlowCanvas(root.querySelector('[data-stage]'), {
    renderNode,
    allowSourcePort: (node) => hasEdgeCapability(node.role, 'source'),
    allowTargetPort: (node) => hasEdgeCapability(node.role, 'target'),
    canConnect,
    onConnect: (source, target) => {
      ed.draft.edges.push({ source, target, condition: null });
      commit();
      ed.canvas.setSelection([], [[source, target]]);
    },
    onMoveCommit: (moves) => {
      for (const { id: nodeId, x, y } of moves) {
        const node = nodeById(nodeId);
        if (node) node.position = { x, y };
      }
      commit({ skipCanvas: true });
    },
    onSelectionChange: renderInspector,
    onNodeContext: nodeContextMenu,
    onEdgeContext: edgeContextMenu,
    onCanvasContext: canvasContextMenu,
  });

  sync();
  ed.canvas.fitView();

  ed.onKeydown = onKeydown;
  document.addEventListener('keydown', ed.onKeydown, true);
}

/* ---------- 模型操作 ---------- */

const nodeById = (id) => ed.draft.nodes.find((n) => n.id === id);
const template = () => TEMPLATES[ed.draft.template] ?? { label: ed.draft.template, roles: {}, edges: [], settings: [] };

function snapshot() {
  return JSON.stringify({ draft: ed.draft, name: ed.name, description: ed.description });
}

function restore(json) {
  const data = JSON.parse(json);
  ed.draft = data.draft;
  ed.name = data.name;
  ed.description = data.description;
}

/** 变更提交：记录历史、标脏、同步画布。调用前先修改 ed.draft。 */
function commit({ skipCanvas = false } = {}) {
  ed.undoStack.push(ed.lastSnapshot ?? ed.baseSnapshot);
  if (ed.undoStack.length > 100) ed.undoStack.shift();
  ed.redoStack = [];
  ed.lastSnapshot = snapshot();
  ed.dirty = true;
  ed.validation = null;
  sync({ skipCanvas });
}

function undo() {
  if (!ed.undoStack.length) return;
  ed.redoStack.push(snapshot());
  restore(ed.undoStack.pop());
  ed.lastSnapshot = snapshot();
  ed.dirty = true;
  ed.validation = null;
  sync();
}

function redo() {
  if (!ed.redoStack.length) return;
  ed.undoStack.push(snapshot());
  restore(ed.redoStack.pop());
  ed.lastSnapshot = snapshot();
  ed.dirty = true;
  ed.validation = null;
  sync();
}

/** 全量同步 UI（画布、面板、头部、检查器）。 */
function sync({ skipCanvas = false } = {}) {
  if (!ed.baseSnapshot) ed.baseSnapshot = snapshot();
  if (!ed.lastSnapshot) ed.lastSnapshot = snapshot();
  if (!skipCanvas) ed.canvas.setData(ed.draft.nodes, ed.draft.edges);
  renderPalette();
  renderHead();
  renderInspector();
  renderValidation();
}

/* ---------- 结构规则 ---------- */

function hasEdgeCapability(role, side) {
  return template().edges.some(([s, t]) => (side === 'source' ? s === role : t === role));
}

function canConnect(sourceId, targetId) {
  if (sourceId === targetId) return false;
  const source = nodeById(sourceId);
  const target = nodeById(targetId);
  if (!source || !target) return false;
  if (!edgeAllowed(ed.draft.template, source.role, target.role)) return false;
  return !ed.draft.edges.some((e) => e.source === sourceId && e.target === targetId);
}

function roleCount(role) {
  return ed.draft.nodes.filter((n) => n.role === role).length;
}

function defaultAgentFor(role) {
  return store.agents.find((a) => agentUsable(a, ed.draft.template, role)) ?? null;
}

function uniqueNodeId(role) {
  let index = roleCount(role) + 1;
  let candidate = `${role}_${index}`;
  while (nodeById(candidate)) { index += 1; candidate = `${role}_${index}`; }
  return candidate;
}

function addNode(role, position) {
  const meta = roleMeta(ed.draft.template, role);
  if (roleCount(role) >= meta.max) {
    toast(`角色「${meta.label}」最多 ${meta.max} 个节点`, 'error');
    return;
  }
  const agent = defaultAgentFor(role);
  if (!agent) {
    toast('没有可用于该角色的启用智能体，请先在「智能体」页注册', 'error');
    return;
  }
  const node = {
    id: uniqueNodeId(role),
    role,
    agent_id: agent.id,
    position: { x: Math.round(position.x / 8) * 8, y: Math.round(position.y / 8) * 8 },
    config: ed.draft.template === 'topic_auction' ? { base_bid: 0.5, keywords: [] } : {},
  };
  ed.draft.nodes.push(node);
  commit();
  ed.canvas.setSelection([node.id]);
  ed.canvas.centerOnNode(node.id);
}

function deleteSelection() {
  const { nodes, edges } = ed.canvas.getSelection();
  if (!nodes.length && !edges.length) return;
  const removed = new Set(nodes);
  ed.draft.nodes = ed.draft.nodes.filter((n) => !removed.has(n.id));
  const edgeSet = new Set(edges.map(([s, t]) => `${s}→${t}`));
  ed.draft.edges = ed.draft.edges.filter((e) =>
    !removed.has(e.source) && !removed.has(e.target) && !edgeSet.has(`${e.source}→${e.target}`));
  if (removed.has(ed.draft.settings?.entry_node)) delete ed.draft.settings.entry_node;
  commit();
}

function renameNode(oldId, newId) {
  if (oldId === newId) return true;
  if (!NODE_ID_RE.test(newId)) { toast('节点 ID 只能包含字母、数字、_ 和 -，最长 80 位', 'error'); return false; }
  if (nodeById(newId)) { toast('节点 ID 已存在', 'error'); return false; }
  nodeById(oldId).id = newId;
  for (const edge of ed.draft.edges) {
    if (edge.source === oldId) edge.source = newId;
    if (edge.target === oldId) edge.target = newId;
  }
  if (ed.draft.settings?.entry_node === oldId) ed.draft.settings.entry_node = newId;
  commit();
  ed.canvas.setSelection([newId]);
  return true;
}

function duplicateNode(id) {
  const node = nodeById(id);
  if (!node) return;
  const meta = roleMeta(ed.draft.template, node.role);
  if (roleCount(node.role) >= meta.max) { toast(`角色「${meta.label}」已达上限`, 'error'); return; }
  const clone = structuredClone(node);
  clone.id = uniqueNodeId(node.role);
  clone.position = { x: node.position.x + 40, y: node.position.y + 96 };
  ed.draft.nodes.push(clone);
  commit();
  ed.canvas.setSelection([clone.id]);
}

function fillRequiredEdges() {
  const existing = new Set(ed.draft.edges.map((e) => `${e.source}→${e.target}`));
  const missing = requiredEdges(ed.draft).filter(([s, t]) => !existing.has(`${s}→${t}`));
  if (!missing.length) { toast('必需连线已齐全', 'success'); return; }
  for (const [source, target] of missing) ed.draft.edges.push({ source, target, condition: null });
  commit();
  toast(`已补全 ${missing.length} 条必需连线`, 'success');
}

function autoLayout() {
  const nodes = ed.draft.nodes;
  if (!nodes.length) return;
  if (!ed.draft.edges.length) {
    // 无连线（话题竞价）：网格排布
    const cols = Math.ceil(Math.sqrt(nodes.length));
    nodes.forEach((node, index) => {
      node.position = { x: 120 + (index % cols) * 280, y: 120 + Math.floor(index / cols) * 128 };
    });
  } else {
    const rank = new Map(nodes.map((n) => [n.id, 0]));
    const entry = ed.draft.settings?.entry_node;
    // 有限次松弛求最长路径层级（容忍环）
    for (let pass = 0; pass < nodes.length + 1; pass += 1) {
      let changed = false;
      for (const edge of ed.draft.edges) {
        if (!rank.has(edge.source) || !rank.has(edge.target)) continue;
        const next = rank.get(edge.source) + 1;
        if (next > rank.get(edge.target) && next <= nodes.length) {
          rank.set(edge.target, next);
          changed = true;
        }
      }
      if (!changed) break;
    }
    if (entry && rank.has(entry)) rank.set(entry, 0);
    const byRank = new Map();
    for (const node of nodes) {
      const r = rank.get(node.id) ?? 0;
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r).push(node);
    }
    const ranks = [...byRank.keys()].sort((a, b) => a - b);
    const maxRows = Math.max(...ranks.map((r) => byRank.get(r).length));
    ranks.forEach((r, col) => {
      const column = byRank.get(r);
      const offset = ((maxRows - column.length) * 128) / 2;
      column.forEach((node, row) => {
        node.position = { x: 120 + col * 320, y: 120 + offset + row * 128 };
      });
    });
  }
  commit();
  ed.canvas.fitView();
}

/* ---------- 外壳渲染 ---------- */

function renderShell() {
  ed.root.innerHTML = `
    <header class="ed-head">
      <button class="icon-button" data-back title="返回编排列表">
        <svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2z"/></svg>
      </button>
      <div class="ed-title">
        <b data-title></b>
        <small><span data-subtitle></span><span class="save-dot" data-save-dot></span><span data-save-text>已保存</span></small>
      </div>
      <div class="ed-sep"></div>
      <button class="icon-button" data-undo title="撤销 (Ctrl+Z)"><svg viewBox="0 0 24 24"><path d="M12.5 8H7.8l2.6-2.6L9 4 4 9l5 5 1.4-1.4L7.8 10h4.7a4.5 4.5 0 0 1 0 9H7v2h5.5a6.5 6.5 0 0 0 0-13z"/></svg></button>
      <button class="icon-button" data-redo title="重做 (Ctrl+Shift+Z)"><svg viewBox="0 0 24 24"><path d="M11.5 8h4.7l-2.6-2.6L15 4l5 5-5 5-1.4-1.4 2.6-2.6h-4.7a4.5 4.5 0 0 0 0 9H17v2h-5.5a6.5 6.5 0 0 1 0-13z"/></svg></button>
      <div class="ed-sep"></div>
      <button class="button ghost small" data-layout title="按连线层级自动排布节点">自动布局</button>
      <button class="button ghost small" data-fill-edges title="生成模板要求但缺失的连线">补全必需连线</button>
      <span class="spacer"></span>
      <button class="button ghost small" data-history>${icons.history}版本历史</button>
      <button class="button subtle small" data-validate>校验</button>
      <button class="button subtle small" data-save>保存草稿</button>
      <button class="button small" data-publish>${icons.play}发布</button>
    </header>
    <div class="ed-body">
      <aside class="ed-palette">
        <div class="ed-section">
          <h4>节点库</h4>
          <p class="palette-note" data-palette-note></p>
          <div data-palette></div>
        </div>
        <div class="ed-section">
          <h4>模板说明</h4>
          <p class="palette-note" data-template-hint></p>
        </div>
      </aside>
      <div class="ed-stage" data-stage>
        <div class="validation-panel" data-validation hidden></div>
      </div>
      <aside class="ed-inspector" data-inspector></aside>
    </div>`;
}

function bindShell() {
  const $ = (sel) => ed.root.querySelector(sel);
  $('[data-back]').addEventListener('click', () => { location.hash = '#/orchestrations'; });
  $('[data-undo]').addEventListener('click', undo);
  $('[data-redo]').addEventListener('click', redo);
  $('[data-layout]').addEventListener('click', autoLayout);
  $('[data-fill-edges]').addEventListener('click', fillRequiredEdges);
  $('[data-history]').addEventListener('click', openHistoryDrawer);
  $('[data-validate]').addEventListener('click', () => validate(true));
  $('[data-save]').addEventListener('click', save);
  $('[data-publish]').addEventListener('click', publish);
}

function renderHead() {
  const $ = (sel) => ed.root.querySelector(sel);
  $('[data-title]').textContent = ed.name;
  $('[data-subtitle]').textContent =
    `${template().icon ?? ''} ${template().label} · 草稿 v${ed.record.draft_version}${ed.record.active_revision_id ? ' · 已发布' : ''}`;
  $('[data-save-dot]').classList.toggle('dirty', ed.dirty);
  $('[data-save-text]').textContent = ed.dirty ? '未保存' : '已保存';
  $('[data-undo]').disabled = !ed.undoStack.length;
  $('[data-redo]').disabled = !ed.redoStack.length;
  $('[data-save]').disabled = !ed.dirty;
}

/* ---------- 节点库 ---------- */

function renderPalette() {
  const host = ed.root.querySelector('[data-palette]');
  const meta = template();
  ed.root.querySelector('[data-template-hint]').textContent = `${meta.description ?? ''}${meta.hint ? ' ' + meta.hint : ''}`;
  ed.root.querySelector('[data-palette-note]').textContent = '点击添加节点，或拖拽到画布指定位置。';
  host.innerHTML = Object.entries(meta.roles).map(([role, spec]) => {
    const count = roleCount(role);
    const full = count >= spec.max;
    return `<button type="button" class="palette-item" data-role="${role}" ${full ? 'disabled' : ''}>
      <span class="p-swatch" style="background:${spec.color};color:${spec.color}"></span>
      <span class="p-body"><b>${esc(spec.label)}</b><small>${spec.min === spec.max ? `需要 ${spec.min} 个` : `${spec.min}–${spec.max} 个`}</small></span>
      <span class="p-count">${count}/${spec.max}</span>
    </button>`;
  }).join('');

  host.querySelectorAll('[data-role]').forEach((item) => {
    const role = item.dataset.role;
    item.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || item.disabled) return;
      startPaletteDrag(event, role, roleMeta(ed.draft.template, role).label);
    });
  });
}

/** 从节点库拖拽到画布：4px 阈值内视为点击（加到视口中心）。 */
function startPaletteDrag(event, role, label) {
  const start = { x: event.clientX, y: event.clientY };
  let ghost = null;
  const stage = ed.root.querySelector('[data-stage]');
  const onMove = (ev) => {
    if (!ghost && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 5) return;
    if (!ghost) {
      ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = `+ ${label}`;
      document.body.appendChild(ghost);
    }
    ghost.style.left = `${ev.clientX}px`;
    ghost.style.top = `${ev.clientY}px`;
  };
  const onUp = (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    if (!ghost) {
      // 点击：加到视口中心
      const rect = stage.getBoundingClientRect();
      const world = ed.canvas.screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
      addNode(role, { x: world.x - 104, y: world.y - 32 });
      return;
    }
    ghost.remove();
    const rect = stage.getBoundingClientRect();
    if (ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
      const world = ed.canvas.screenToWorld(ev.clientX, ev.clientY);
      addNode(role, { x: world.x - 104, y: world.y - 32 });
    }
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

/* ---------- 节点渲染（供画布调用） ---------- */

function renderNode(node) {
  const meta = roleMeta(ed.draft.template, node.role);
  const agent = agentById(node.agent_id);
  const usable = agent && agentUsable(agent, ed.draft.template, node.role);
  return `
    <div class="fnode-accent" style="background:${meta.color}"></div>
    <div class="fnode-head">
      <span class="role-swatch" style="background:${meta.color};color:${meta.color}"></span>
      <b>${esc(node.id)}</b>
      <span class="role-tag">${esc(meta.label)}</span>
    </div>
    <div class="fnode-body">
      <span class="agent-ico"><svg viewBox="0 0 24 24"><path d="M12 3a2 2 0 0 1 2 2v1h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3V5a2 2 0 0 1 2-2Zm-3.5 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm7 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg></span>
      <span class="agent-name ${usable ? '' : 'missing'}">${agent ? esc(agent.display_name) + (usable ? '' : '（不可用）') : '未绑定智能体'}</span>
    </div>`;
}

/* ---------- 上下文菜单 ---------- */

function nodeContextMenu(nodeId, x, y) {
  const node = nodeById(nodeId);
  const meta = roleMeta(ed.draft.template, node.role);
  const items = [
    { label: '重命名', icon: icons.edit, onClick: () => { ed.canvas.setSelection([nodeId]); ed.root.querySelector('[data-node-id-input]')?.focus(); } },
    { label: '复制节点', icon: icons.plus, disabled: roleCount(node.role) >= meta.max, onClick: () => duplicateNode(nodeId) },
  ];
  if (ed.draft.template === 'handoff') {
    items.push({
      label: '设为入口节点', icon: icons.play,
      disabled: ed.draft.settings?.entry_node === nodeId,
      onClick: () => { ed.draft.settings.entry_node = nodeId; commit(); },
    });
  }
  items.push('sep', { label: '删除节点', icon: icons.trash, danger: true, kbd: 'Del', onClick: deleteSelection });
  showMenu(x, y, items);
}

function edgeContextMenu(source, target, x, y) {
  showMenu(x, y, [
    { label: `${source} → ${target}`, header: true },
    { label: '删除连线', icon: icons.trash, danger: true, kbd: 'Del', onClick: deleteSelection },
  ]);
}

function canvasContextMenu(x, y, worldX, worldY) {
  const meta = template();
  const items = [{ label: '添加节点', header: true }];
  for (const [role, spec] of Object.entries(meta.roles)) {
    items.push({
      label: spec.label,
      disabled: roleCount(role) >= spec.max,
      onClick: () => addNode(role, { x: worldX - 104, y: worldY - 32 }),
    });
  }
  items.push('sep',
    { label: '适应视图', kbd: 'F', onClick: () => ed.canvas.fitView() },
    { label: '自动布局', onClick: autoLayout });
  showMenu(x, y, items);
}

/* ---------- 检查器 ---------- */

function renderInspector() {
  const host = ed.root.querySelector('[data-inspector]');
  if (!host) return;
  const { nodes, edges } = ed.canvas.getSelection();

  if (nodes.length === 1) { renderNodeInspector(host, nodeById(nodes[0])); return; }
  if (nodes.length === 0 && edges.length === 1) { renderEdgeInspector(host, edges[0]); return; }
  if (nodes.length + edges.length > 1) {
    host.innerHTML = `<div class="ed-section">
      <h4>多选</h4>
      <p class="insp-empty">已选择 ${nodes.length} 个节点、${edges.length} 条连线。</p>
      <button class="button danger-subtle small block" data-del-sel>${icons.trash}删除所选</button>
    </div>`;
    host.querySelector('[data-del-sel]').addEventListener('click', deleteSelection);
    return;
  }
  renderSettingsInspector(host);
}

function renderNodeInspector(host, node) {
  if (!node) { renderSettingsInspector(host); return; }
  const meta = roleMeta(ed.draft.template, node.role);
  const agents = store.agents.filter((a) => agentUsable(a, ed.draft.template, node.role));
  const bound = agentById(node.agent_id);
  const isTopic = ed.draft.template === 'topic_auction';
  const config = node.config ?? {};

  host.innerHTML = `
    <div class="ed-section">
      <h4>节点</h4>
      <div class="fields">
        <label class="field"><span>节点 ID</span><input data-node-id-input value="${esc(node.id)}" maxlength="80" /></label>
        <div class="field"><span>角色</span>
          <div style="display:flex;align-items:center;gap:8px;height:34px;padding:0 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface-2)">
            <span class="role-swatch" style="width:9px;height:9px;border-radius:3px;background:${meta.color}"></span>
            <span style="font-size:13px">${esc(meta.label)}</span>
            <span class="mono" style="margin-left:auto;color:var(--text-3)">${esc(node.role)}</span>
          </div>
        </div>
        <label class="field"><span>绑定智能体</span>
          <select data-agent>
            ${bound && !agents.some((a) => a.id === bound.id) ? `<option value="${bound.id}" selected>${esc(bound.display_name)}（当前不可用）</option>` : ''}
            ${agents.map((a) => `<option value="${a.id}" ${a.id === node.agent_id ? 'selected' : ''}>${esc(a.display_name)} · ${a.kind === 'coze_chat' ? 'Chat' : 'Workflow'}</option>`).join('')}
          </select>
          ${agents.length ? '' : '<span class="hint">没有可用于该角色的智能体</span>'}
        </label>
      </div>
    </div>
    ${isTopic ? `
    <div class="ed-section">
      <h4>竞价参数</h4>
      <div class="fields">
        <div class="form-grid" style="gap:10px">
          <label class="field"><span>基础出价</span><input data-cfg="base_bid" type="number" step="0.05" min="-100" max="100" value="${config.base_bid ?? 0.5}" /></label>
          <label class="field"><span>关键词加成</span><input data-cfg="keyword_bonus" type="number" step="0.05" min="-100" max="100" value="${config.keyword_bonus ?? 0.25}" /></label>
          <label class="field"><span>话题加成</span><input data-cfg="topic_bonus" type="number" step="0.05" min="-100" max="100" value="${config.topic_bonus ?? 0.2}" /></label>
          <label class="field"><span>难度权重</span><input data-cfg="difficulty_weight" type="number" step="0.05" min="-100" max="100" value="${config.difficulty_weight ?? 0}" /></label>
        </div>
        <label class="field"><span>关键词 <span class="hint">每行一个，命中即加成</span></span><textarea data-cfg-list="keywords" rows="3">${esc((config.keywords ?? []).join('\n'))}</textarea></label>
        <label class="field"><span>订阅话题 <span class="hint">每行一个</span></span><textarea data-cfg-list="topics" rows="2">${esc((config.topics ?? []).join('\n'))}</textarea></label>
        <label class="field"><span>独占关键词 <span class="hint">命中时强制由本节点应答</span></span><textarea data-cfg-list="exclusive_keywords" rows="2">${esc((config.exclusive_keywords ?? []).join('\n'))}</textarea></label>
      </div>
    </div>` : ''}
    <div class="ed-section">
      <button class="button danger-subtle small block" data-del>${icons.trash}删除节点（Del）</button>
    </div>`;

  const idInput = host.querySelector('[data-node-id-input]');
  idInput.addEventListener('change', () => {
    if (!renameNode(node.id, idInput.value.trim())) idInput.value = node.id;
  });
  host.querySelector('[data-agent]').addEventListener('change', (event) => {
    node.agent_id = event.target.value;
    commit();
  });
  host.querySelectorAll('[data-cfg]').forEach((input) =>
    input.addEventListener('change', () => {
      node.config = { ...node.config, [input.dataset.cfg]: Number(input.value) };
      commit({ skipCanvas: true });
    }));
  host.querySelectorAll('[data-cfg-list]').forEach((area) =>
    area.addEventListener('change', () => {
      const list = area.value.split('\n').map((s) => s.trim()).filter(Boolean);
      node.config = { ...node.config, [area.dataset.cfgList]: list };
      commit({ skipCanvas: true });
    }));
  host.querySelector('[data-del]').addEventListener('click', deleteSelection);
}

function renderEdgeInspector(host, [source, target]) {
  const required = requiredEdges(ed.draft).some(([s, t]) => s === source && t === target);
  host.innerHTML = `
    <div class="ed-section">
      <h4>连线</h4>
      <div class="fields">
        <div class="field"><span>路径</span>
          <div class="mono" style="padding:8px 10px;border:1px solid var(--border);border-radius:7px;background:var(--surface-2)">${esc(source)} → ${esc(target)}</div>
        </div>
        ${required ? '<p class="insp-empty">这是模板要求的必需连线，删除后将无法通过校验。</p>' : ''}
        <button class="button danger-subtle small block" data-del>${icons.trash}删除连线（Del）</button>
      </div>
    </div>`;
  host.querySelector('[data-del]').addEventListener('click', deleteSelection);
}

function renderSettingsInspector(host) {
  const meta = template();
  const settings = ed.draft.settings ?? (ed.draft.settings = {});
  host.innerHTML = `
    <div class="ed-section">
      <h4>编排信息</h4>
      <div class="fields">
        <label class="field"><span>名称</span><input data-set-name value="${esc(ed.name)}" maxlength="160" /></label>
        <label class="field"><span>描述</span><textarea data-set-desc rows="2" maxlength="2000" placeholder="展示在聊天入口">${esc(ed.description ?? '')}</textarea></label>
      </div>
    </div>
    <div class="ed-section">
      <h4>运行设置</h4>
      <div class="fields">
        <label class="field"><span>最大轮次 <span class="hint">1–40，防止无限循环</span></span>
          <input data-set-turns type="number" min="1" max="40" value="${settings.max_turns ?? 8}" /></label>
        ${meta.settings?.includes('entry_node') ? `
        <label class="field"><span>入口节点 <span class="hint">对话从此节点开始</span></span>
          <select data-set-entry>
            <option value="">未指定</option>
            ${ed.draft.nodes.map((n) => `<option value="${esc(n.id)}" ${settings.entry_node === n.id ? 'selected' : ''}>${esc(n.id)}</option>`).join('')}
          </select></label>` : ''}
        ${meta.settings?.includes('continuity_bonus') ? `
        <label class="field"><span>连续性加成 <span class="hint">上一轮应答者的额外出价</span></span>
          <input data-set-cont type="number" step="0.05" min="0" max="10" value="${settings.continuity_bonus ?? 0.1}" /></label>` : ''}
      </div>
    </div>
    <div class="ed-section">
      <h4>快捷键</h4>
      <div class="insp-shortcuts">
        <div><span>平移画布</span><span><span class="kbd">拖拽空白</span></span></div>
        <div><span>框选</span><span><span class="kbd">Shift</span> + 拖拽</span></div>
        <div><span>缩放</span><span><span class="kbd">滚轮</span></span></div>
        <div><span>连线</span><span>拖拽节点右侧端口</span></div>
        <div><span>删除所选</span><span><span class="kbd">Del</span></span></div>
        <div><span>撤销 / 重做</span><span><span class="kbd">Ctrl Z</span> / <span class="kbd">Ctrl ⇧ Z</span></span></div>
        <div><span>全选 / 取消</span><span><span class="kbd">Ctrl A</span> / <span class="kbd">Esc</span></span></div>
        <div><span>保存</span><span><span class="kbd">Ctrl S</span></span></div>
        <div><span>适应视图</span><span><span class="kbd">F</span></span></div>
      </div>
    </div>`;

  host.querySelector('[data-set-name]').addEventListener('change', (event) => {
    ed.name = event.target.value.trim() || ed.name;
    event.target.value = ed.name;
    commit({ skipCanvas: true });
  });
  host.querySelector('[data-set-desc]').addEventListener('change', (event) => {
    ed.description = event.target.value;
    commit({ skipCanvas: true });
  });
  host.querySelector('[data-set-turns]').addEventListener('change', (event) => {
    const value = Math.max(1, Math.min(40, Number(event.target.value) || 8));
    event.target.value = value;
    ed.draft.settings.max_turns = value;
    commit({ skipCanvas: true });
  });
  host.querySelector('[data-set-entry]')?.addEventListener('change', (event) => {
    if (event.target.value) ed.draft.settings.entry_node = event.target.value;
    else delete ed.draft.settings.entry_node;
    commit({ skipCanvas: true });
  });
  host.querySelector('[data-set-cont]')?.addEventListener('change', (event) => {
    ed.draft.settings.continuity_bonus = Number(event.target.value) || 0;
    commit({ skipCanvas: true });
  });
}

/* ---------- 校验 / 保存 / 发布 ---------- */

async function save() {
  if (!ed.dirty) return true;
  try {
    const updated = await api(`/api/admin/orchestrations/${ed.record.id}/draft`, {
      method: 'PUT',
      headers: { 'If-Match': `"${ed.record.draft_version}"` },
      body: { name: ed.name, description: ed.description, draft: ed.draft },
    });
    ed.record = updated;
    ed.dirty = false;
    renderHead();
    toast('草稿已保存', 'success');
    loadAll().catch(() => {});
    return true;
  } catch (error) {
    if (error?.detail?.code === 'draft_version_conflict') {
      const reload = await confirmDanger({
        title: '草稿版本冲突',
        message: '草稿已在其他窗口被修改。<b>放弃本地修改并重新加载</b>，或先取消手动备份画布内容。',
        confirmText: '重新加载',
      });
      if (reload) {
        const id = ed.record.id;
        unmountEditor();
        await mountEditor(document.getElementById('editor-root'), id);
      }
    } else {
      toast(errorText(error), 'error');
    }
    return false;
  }
}

async function validate(showSuccess) {
  if (ed.dirty && !(await save())) return null;
  try {
    const result = await api(`/api/admin/orchestrations/${ed.record.id}/validate`, { method: 'POST' });
    ed.validation = result;
    renderValidation();
    if (result.valid && showSuccess) toast('校验通过', 'success');
    return result;
  } catch (error) {
    toast(errorText(error), 'error');
    return null;
  }
}

function renderValidation() {
  const panel = ed.root.querySelector('[data-validation]');
  if (!panel) return;
  const result = ed.validation;
  const errorNodes = new Set();
  if (result && !result.valid) {
    for (const issue of result.issues) {
      const match = issue.path?.match(/^nodes\.(\d+)/);
      if (match) {
        const node = ed.draft.nodes[Number(match[1])];
        if (node) errorNodes.add(node.id);
      }
    }
  }
  ed.canvas?.setNodeErrors(errorNodes);
  if (!result) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.className = `validation-panel ${result.valid ? 'ok' : 'bad'}`;
  if (result.valid) {
    panel.innerHTML = `<div class="vp-head">${icons.check}<span class="grow">图结构、角色与智能体绑定全部通过校验</span>
      <button class="icon-button" data-close-vp><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`;
  } else {
    panel.innerHTML = `
      <div class="vp-head"><span class="grow">发现 ${result.issues.length} 个问题</span>
        <button class="icon-button" data-close-vp><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
      <div class="vp-list">${result.issues.map((issue, index) => `
        <button type="button" class="vp-item" data-issue="${index}">
          <span class="vp-code">${esc(issue.code ?? '')}</span><span>${esc(issue.message)}</span>
        </button>`).join('')}</div>`;
    panel.querySelectorAll('[data-issue]').forEach((button) =>
      button.addEventListener('click', () => {
        const issue = result.issues[Number(button.dataset.issue)];
        const nodeMatch = issue.path?.match(/^nodes\.(\d+)/);
        if (nodeMatch) {
          const node = ed.draft.nodes[Number(nodeMatch[1])];
          if (node) { ed.canvas.setSelection([node.id]); ed.canvas.centerOnNode(node.id); }
          return;
        }
        const edgeMatch = issue.path?.match(/^edges\.(\d+)/);
        if (edgeMatch) {
          const edge = ed.draft.edges[Number(edgeMatch[1])];
          if (edge) ed.canvas.setSelection([], [[edge.source, edge.target]]);
        }
      }));
  }
  panel.querySelector('[data-close-vp]').addEventListener('click', () => { panel.hidden = true; });
}

async function publish() {
  const result = await validate(false);
  if (!result) return;
  if (!result.valid) {
    toast('存在未解决的校验问题，无法发布', 'error');
    return;
  }
  openModal({
    title: '发布新版本',
    submitText: '确认发布',
    fieldsHtml: `
      <p style="color:var(--text-2);font-size:13.5px;line-height:1.7">
        将把当前草稿发布为 <b>${esc(ed.name)}</b> 的不可变版本：
      </p>
      <div class="panel" style="padding:12px 16px;box-shadow:none">
        <dl class="meta" style="display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:13px;margin:0">
          <dt style="color:var(--text-3)">模板</dt><dd style="margin:0">${template().icon} ${esc(template().label)}</dd>
          <dt style="color:var(--text-3)">规模</dt><dd style="margin:0">${ed.draft.nodes.length} 个节点 · ${ed.draft.edges.length} 条连线</dd>
          <dt style="color:var(--text-3)">生效</dt><dd style="margin:0">新会话立即使用该版本；进行中的会话不受影响</dd>
        </dl>
      </div>`,
    onSubmit: async () => {
      try {
        const published = await api(`/api/admin/orchestrations/${ed.record.id}/publish`, { method: 'POST' });
        closeModal();
        ed.record.active_revision_id = published.revision_id;
        renderHead();
        toast(`已发布 v${published.version}`, 'success');
        loadAll().catch(() => {});
      } catch (error) {
        throw Object.assign(error, { userMessage: errorText(error) });
      }
    },
  });
}

/* ---------- 版本历史 ---------- */

async function openHistoryDrawer() {
  const overlay = document.createElement('div');
  overlay.className = 'drawer-overlay';
  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <div class="drawer-head"><h3>版本历史</h3>
      <button class="icon-button" data-close><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>
    <div class="drawer-body"><div class="skeleton" style="height:120px"></div></div>`;
  const close = () => { overlay.remove(); drawer.remove(); };
  overlay.addEventListener('pointerdown', close);
  drawer.querySelector('[data-close]').addEventListener('click', close);
  document.body.append(overlay, drawer);

  const body = drawer.querySelector('.drawer-body');
  try {
    const { items } = await api(`/api/admin/orchestrations/${ed.record.id}/revisions`);
    if (!items.length) {
      body.innerHTML = '<p class="insp-empty">尚未发布过版本。通过校验后点击「发布」创建首个不可变版本。</p>';
      return;
    }
    body.innerHTML = items.map((rev) => `
      <div class="rev-item">
        <div class="rev-top"><b>v${rev.version}</b>
          ${rev.id === ed.record.active_revision_id ? '<span class="badge ok" style="height:20px">当前生效</span>' : ''}
        </div>
        <div class="rev-meta">${esc(rev.published_by)} 发布于 ${esc(formatDate(rev.published_at))}<br />
          <span class="mono">digest ${esc(rev.digest.slice(0, 12))}…</span></div>
        <div class="rev-actions">
          <button class="button subtle small" data-restore="${rev.id}" data-version="${rev.version}">恢复到画布</button>
        </div>
      </div>`).join('');
    body.querySelectorAll('[data-restore]').forEach((button) =>
      button.addEventListener('click', async () => {
        const ok = await confirmDanger({
          title: `恢复 v${button.dataset.version} 到画布`,
          message: '当前画布草稿将被该版本的内容<b>覆盖</b>（已发布版本不受影响）。',
          confirmText: '恢复',
        });
        if (!ok) return;
        try {
          const updated = await api(
            `/api/admin/orchestrations/${ed.record.id}/revisions/${button.dataset.restore}/restore`,
            { method: 'POST' },
          );
          close();
          ed.record = updated;
          ed.draft = structuredClone(updated.draft);
          ed.dirty = false;
          ed.undoStack = [];
          ed.redoStack = [];
          ed.lastSnapshot = null;
          ed.baseSnapshot = null;
          ed.validation = null;
          sync();
          ed.canvas.fitView();
          toast(`已恢复 v${button.dataset.version} 的内容`, 'success');
        } catch (error) {
          toast(errorText(error), 'error');
        }
      }));
  } catch (error) {
    body.innerHTML = `<p class="insp-empty">${esc(errorText(error))}</p>`;
  }
}

/* ---------- 快捷键 ---------- */

function onKeydown(event) {
  if (!ed) return;
  const inInput = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '')
    || document.activeElement?.isContentEditable;
  const mod = event.ctrlKey || event.metaKey;

  if (mod && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
    return;
  }
  if (mod && event.key.toLowerCase() === 'z') {
    if (inInput) return;
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if (mod && event.key.toLowerCase() === 'y') {
    if (inInput) return;
    event.preventDefault();
    redo();
    return;
  }
  if (inInput) return;
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault();
    deleteSelection();
  } else if (mod && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    ed.canvas.selectAll();
  } else if (event.key === 'Escape') {
    ed.canvas.setSelection();
  } else if (event.key.toLowerCase() === 'f') {
    ed.canvas.fitView();
  } else if (event.key.startsWith('Arrow')) {
    const { nodes } = ed.canvas.getSelection();
    if (!nodes.length) return;
    event.preventDefault();
    const step = event.shiftKey ? 24 : 8;
    const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
    const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
    for (const nodeId of nodes) {
      const node = nodeById(nodeId);
      node.position = { x: node.position.x + dx, y: node.position.y + dy };
    }
    commit();
    ed.canvas.setSelection(nodes);
  }
}
