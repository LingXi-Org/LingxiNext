// 共享数据缓存：各视图按需刷新，避免重复请求。

import { api } from './api.js';
import { applyServerMeta } from './meta.js';

export const store = {
  user: { username: document.querySelector('meta[name="current-user"]')?.content ?? '', role: 'admin' },
  connections: [],
  agents: [],
  orchestrations: [],
  educationScenarios: [],
  users: [],
  ready: false,
};

export async function loadAll() {
  const [meta, scenarios, connections, agents, orchestrations, users] = await Promise.all([
    store.ready ? null : api('/api/admin/meta'),
    store.ready ? null : api('/api/admin/education/scenarios'),
    api('/api/admin/connections'),
    api('/api/admin/agents'),
    api('/api/admin/orchestrations'),
    api('/api/admin/users'),
  ]);
  if (meta) applyServerMeta(meta);
  if (scenarios) store.educationScenarios = scenarios.items;
  store.connections = connections.items;
  store.agents = agents.items;
  store.orchestrations = orchestrations.items;
  store.users = users.items;
  store.ready = true;
}

export const agentById = (id) => store.agents.find((a) => a.id === id);
export const connectionById = (id) => store.connections.find((c) => c.id === id);
