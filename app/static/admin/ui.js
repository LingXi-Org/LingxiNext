// 通用 UI 原语：转义、格式化、Toast、模态框、确认框、浮层菜单。

export const esc = (value) =>
  String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function timeAgo(value) {
  if (!value) return '—';
  const diff = Date.now() - new Date(value).getTime();
  if (Number.isNaN(diff)) return '—';
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDate(value);
}

export function debounce(fn, wait = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ---------- Toast ---------- */

const toastRoot = () => document.getElementById('toast-root');

export function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'error' : ''}`;
  const icon = kind === 'success'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="#6ee7b7" stroke-width="2.4" stroke-linecap="round"><path d="M4 12.5 9.5 18 20 6.5"/></svg>'
    : kind === 'error'
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="#ff9d94" stroke-width="2.2" stroke-linecap="round"><path d="M12 7v6m0 4v.1"/></svg>'
      : '';
  el.innerHTML = `${icon}<span>${esc(message)}</span>`;
  toastRoot().appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 260);
  }, kind === 'error' ? 4200 : 2600);
}

/* ---------- 模态框 ---------- */

const modalRoot = () => document.getElementById('modal-root');

export function closeModal() {
  modalRoot().innerHTML = '';
  document.removeEventListener('keydown', onModalKeydown, true);
}

function onModalKeydown(event) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    closeModal();
  }
}

/**
 * 打开表单模态框。
 * fieldsHtml: modal-body 内的 HTML；onSubmit(form, helpers) 抛错则展示错误并保持打开。
 */
export function openModal({ title, fieldsHtml, submitText = '保存', wide = false, danger = false, onSubmit, onOpen }) {
  closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <form class="modal ${wide ? 'wide' : ''}" novalidate>
      <div class="modal-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-button" data-close aria-label="关闭">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </div>
      <div class="modal-body">${fieldsHtml}<div class="form-error" data-error hidden></div></div>
      <div class="modal-foot">
        <button type="button" class="button ghost" data-close>取消</button>
        <button type="submit" class="button ${danger ? 'danger' : ''}" data-submit>${esc(submitText)}</button>
      </div>
    </form>`;
  overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) closeModal(); });
  overlay.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
  const form = overlay.querySelector('form');
  const errorBox = overlay.querySelector('[data-error]');
  const submitBtn = overlay.querySelector('[data-submit]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    submitBtn.disabled = true;
    try {
      await onSubmit(form, { close: closeModal });
    } catch (error) {
      errorBox.textContent = error?.userMessage || error?.message || '操作失败';
      errorBox.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });
  modalRoot().appendChild(overlay);
  document.addEventListener('keydown', onModalKeydown, true);
  onOpen?.(form);
  form.querySelector('input:not([readonly]), select, textarea')?.focus();
  return form;
}

/** 危险操作确认框，resolve(true/false)。 */
export function confirmDanger({ title, message, confirmText = '删除' }) {
  return new Promise((resolve) => {
    closeModal();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="alertdialog">
        <div class="modal-body" style="padding-top:22px">
          <div class="confirm-body">
            <div class="confirm-icon"><svg viewBox="0 0 24 24"><path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z"/></svg></div>
            <div><h2 style="font-size:15.5px">${esc(title)}</h2><p>${message}</p></div>
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="button ghost" data-no>取消</button>
          <button type="button" class="button danger" data-yes>${esc(confirmText)}</button>
        </div>
      </div>`;
    const done = (value) => { overlay.remove(); resolve(value); };
    overlay.addEventListener('pointerdown', (event) => { if (event.target === overlay) done(false); });
    overlay.querySelector('[data-no]').addEventListener('click', () => done(false));
    overlay.querySelector('[data-yes]').addEventListener('click', () => done(true));
    modalRoot().appendChild(overlay);
    overlay.querySelector('[data-yes]').focus();
  });
}

/* ---------- 浮层菜单（下拉 / 右键） ---------- */

let openMenu = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  document.removeEventListener('pointerdown', onMenuPointerDown, true);
  window.removeEventListener('blur', closeMenu);
}

function onMenuPointerDown(event) {
  if (openMenu && !openMenu.contains(event.target)) closeMenu();
}

/**
 * items: [{label, icon?, danger?, disabled?, kbd?, onClick} | 'sep' | {label, header:true}]
 */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  for (const item of items) {
    if (item === 'sep') { menu.appendChild(document.createElement('hr')); continue; }
    if (item.header) {
      const label = document.createElement('div');
      label.className = 'menu-label';
      label.textContent = item.label;
      menu.appendChild(label);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = item.danger ? 'danger' : '';
    button.disabled = Boolean(item.disabled);
    button.innerHTML = `${item.icon ?? ''}<span>${esc(item.label)}</span>${item.kbd ? `<span class="kbd">${esc(item.kbd)}</span>` : ''}`;
    button.addEventListener('click', () => { closeMenu(); item.onClick?.(); });
    menu.appendChild(button);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  openMenu = menu;
  setTimeout(() => {
    document.addEventListener('pointerdown', onMenuPointerDown, true);
    window.addEventListener('blur', closeMenu);
  });
  return menu;
}

/* ---------- 小部件 ---------- */

export const icons = {
  edit: '<svg viewBox="0 0 24 24"><path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8 1.8-1.8z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>',
  search: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>',
  bolt: '<svg viewBox="0 0 24 24"><path d="M11 21h-1l1-7H7.5c-.9 0-.4-.8-.4-.8L13 3h1l-1 7h3.5c.9 0 .4.8.4.8L11 21z"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M13 3a9 9 0 0 0-9 9H1l3.9 3.9L9 12H6a7 7 0 1 1 2 4.9l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8H12z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg>',
};

export function emptyState({ title, hint, actionHtml = '' }) {
  return `<div class="empty">
    <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M8 14h5"/></svg>
    <b>${esc(title)}</b><span>${esc(hint)}</span>${actionHtml}
  </div>`;
}

export function switchHtml(checked, attrs = '') {
  return `<label class="switch"><input type="checkbox" ${checked ? 'checked' : ''} ${attrs} /><i></i></label>`;
}
