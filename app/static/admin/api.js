// 后端 API 封装：统一错误、CSRF 与序列化。

const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? '';

export class ApiError extends Error {
  constructor(status, detail) {
    super(typeof detail === 'string' ? detail : (detail?.code ?? `http_${status}`));
    this.status = status;
    this.detail = detail;
  }
}

const ERROR_TEXT = {
  not_authenticated: '登录已过期，请重新登录',
  invalid_session: '登录已过期，请重新登录',
  admin_required: '需要管理员权限',
  invalid_csrf_token: '会话校验失败，请刷新页面',
  token_required: '请填写 Service Token',
  connection_name_exists: '连接名称已存在',
  connection_not_found: '连接不存在',
  connection_in_use: '该连接仍被智能体引用，无法删除',
  agent_slug_exists: '智能体标识已存在',
  agent_not_found: '智能体不存在',
  agent_used_by_published_revision: '该智能体已被发布版本引用，无法删除',
  orchestration_slug_exists: '编排标识已存在',
  orchestration_not_found: '编排不存在',
  revision_not_found: '版本不存在',
  draft_version_conflict: '草稿已在其他窗口被修改，请刷新后重试',
  username_exists: '用户名已存在',
  user_not_found: '用户不存在',
  cannot_delete_current_user: '不能删除当前登录账户',
  cannot_delete_last_admin: '至少保留一名管理员',
  cannot_demote_last_admin: '至少保留一名启用的管理员',
};

export function errorText(error) {
  if (error instanceof ApiError) {
    const code = typeof error.detail === 'string' ? error.detail : error.detail?.code;
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code];
    if (error.status === 422) {
      const first = Array.isArray(error.detail) ? error.detail[0] : null;
      if (first?.msg) return `输入无效：${first.msg}`;
      return '输入内容未通过校验';
    }
    if (typeof code === 'string') return code;
    return `请求失败（${error.status}）`;
  }
  return error?.message || '网络请求失败';
}

export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...headers } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (method !== 'GET') init.headers['X-CSRF-Token'] = csrf;
  const response = await fetch(path, init);
  if (!response.ok) {
    let detail = null;
    try { detail = (await response.json()).detail; } catch { detail = response.statusText; }
    throw new ApiError(response.status, detail);
  }
  return response.status === 204 ? null : response.json();
}
