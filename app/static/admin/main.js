// 入口：hash 路由 + 视图挂载 + 全屏编排编辑器切换。

import { errorText } from './api.js';
import { toast, closeMenu, closeModal } from './ui.js';
import { store, loadAll } from './store.js';
import * as views from './views.js';
import { mountEditor, unmountEditor, editorGuard } from './flow/editor.js';

const viewRoot = document.getElementById('view');
const editorRoot = document.getElementById('editor-root');

const ROUTES = {
  dashboard: views.renderDashboard,
  orchestrations: views.renderOrchestrations,
  agents: views.renderAgents,
  connections: views.renderConnections,
  sessions: views.renderSessions,
  system: views.renderSystem,
  users: views.renderUsers,
  audit: views.renderAudit,
};

let currentRoute = '';

function parseHash() {
  const hash = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, id] = hash.split('/');
  return { name, id };
}

async function route() {
  closeMenu();
  closeModal();
  const { name, id } = parseHash();

  // 全屏编辑器路由：#/orchestrations/<id>
  if (name === 'orchestrations' && id) {
    document.querySelectorAll('.nav-item').forEach((el) =>
      el.classList.toggle('active', el.dataset.route === 'orchestrations'));
    editorRoot.hidden = false;
    await mountEditor(editorRoot, id);
    currentRoute = `orchestrations/${id}`;
    return;
  }

  unmountEditor();
  editorRoot.hidden = true;

  const render = ROUTES[name] ?? views.renderDashboard;
  const active = ROUTES[name] ? name : 'dashboard';
  document.querySelectorAll('.nav-item').forEach((el) =>
    el.classList.toggle('active', el.dataset.route === active));
  currentRoute = active;
  viewRoot.innerHTML = '<div class="page"><div class="skeleton" style="height:120px"></div></div>';
  try {
    await render(viewRoot);
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      viewRoot.innerHTML = `<div class="page"><div class="empty"><b>会话已失效</b><span>请重新<a href="/">登录</a>后再访问控制台。</span></div></div>`;
      return;
    }
    viewRoot.innerHTML = `<div class="page"><div class="empty"><b>加载失败</b><span>${errorText(error)}</span></div></div>`;
  }
  viewRoot.scrollTop = 0;
}

window.addEventListener('hashchange', (event) => {
  // 编辑器有未保存修改时拦截离开。
  if (currentRoute.startsWith('orchestrations/') && !parseHash().id && !editorGuard()) {
    history.replaceState(null, '', `#/${currentRoute}`);
    return;
  }
  route();
});

window.addEventListener('beforeunload', (event) => {
  if (!editorGuard(true)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// 头像首字母
const avatar = document.getElementById('me-avatar');
if (avatar) avatar.textContent = (store.user.username || '?').slice(0, 1);

loadAll()
  .then(route)
  .catch((error) => {
    toast(errorText(error), 'error');
    route();
  });
