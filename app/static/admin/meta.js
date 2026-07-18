// 编排模板元数据：展示文案 + 结构规则（与后端 graph_templates.py 保持一致，
// 后端 /api/admin/meta 为最终权威，加载后会覆盖这里的结构规则）。

export const TEMPLATES = {
  topic_auction: {
    label: '话题竞价',
    icon: '🎯',
    description: '每条消息按关键词、话题与难度为各智能体打分，得分最高者应答。适合多领域客服与问答分流。',
    hint: '本模板由路由器自动分发，节点之间不需要也不允许连线。',
    roles: { agent: { min: 1, max: 32, label: '竞价智能体', color: '#4f5ce5' } },
    edges: [],
    workflowRoles: ['agent'],
    settings: ['max_turns', 'continuity_bonus'],
  },
  supervisor: {
    label: '主管调度',
    icon: '🧭',
    description: '主管智能体阅读对话并决定派发给哪个专家，专家完成后交还主管复核。',
    hint: '主管与每个专家之间需要双向连线（可用「补全必需连线」一键生成）。',
    roles: {
      supervisor: { min: 1, max: 1, label: '主管', color: '#b25e09' },
      specialist: { min: 1, max: 31, label: '专家', color: '#4f5ce5' },
    },
    edges: [['supervisor', 'specialist'], ['specialist', 'supervisor']],
    workflowRoles: [],
    settings: ['max_turns'],
  },
  handoff: {
    label: '接力协作',
    icon: '🤝',
    description: '智能体在预设的移交路径上接力处理对话，由每个智能体自行决定移交对象。',
    hint: '连线定义允许的移交方向；图中不允许循环，且所有节点必须能从入口到达。',
    roles: { agent: { min: 2, max: 32, label: '协作智能体', color: '#4f5ce5' } },
    edges: [['agent', 'agent']],
    workflowRoles: [],
    settings: ['max_turns', 'entry_node'],
  },
  parallel_review: {
    label: '并行评审',
    icon: '⚖️',
    description: '起草智能体产出初稿，多个评审并行审阅，裁判汇总评审意见给出最终回复。',
    hint: '初稿 → 每个评审 → 裁判的连线为必需（可用「补全必需连线」一键生成）。',
    roles: {
      source: { min: 1, max: 1, label: '起草', color: '#12805c' },
      reviewer: { min: 1, max: 29, label: '评审', color: '#4f5ce5' },
      judge: { min: 1, max: 1, label: '裁判', color: '#b25e09' },
    },
    edges: [['source', 'reviewer'], ['reviewer', 'judge']],
    workflowRoles: [],
    settings: ['max_turns'],
  },
  plan_execute: {
    label: '计划执行',
    icon: '📋',
    description: '规划者拆解任务，执行者逐步完成，复盘者判断是否结束或继续迭代。',
    hint: '三个角色各一个节点，连线固定为 规划 → 执行 → 复盘 →（回到执行）。',
    roles: {
      planner: { min: 1, max: 1, label: '规划', color: '#12805c' },
      executor: { min: 1, max: 1, label: '执行', color: '#4f5ce5' },
      replanner: { min: 1, max: 1, label: '复盘', color: '#b25e09' },
    },
    edges: [['planner', 'executor'], ['executor', 'replanner'], ['replanner', 'executor']],
    workflowRoles: ['executor'],
    settings: ['max_turns'],
  },
};

/** 用后端 /api/admin/meta 的结构规则覆盖本地副本，保证与服务端一致。 */
export function applyServerMeta(serverMeta) {
  for (const [name, rules] of Object.entries(serverMeta?.templates ?? {})) {
    const local = TEMPLATES[name];
    if (!local) continue;
    for (const [role, bounds] of Object.entries(rules.roles ?? {})) {
      local.roles[role] = { label: role, color: '#4f5ce5', ...local.roles[role], ...bounds };
    }
    if (rules.edges) local.edges = rules.edges;
    if (rules.workflow_roles) local.workflowRoles = rules.workflow_roles;
  }
}

export const roleMeta = (template, role) =>
  TEMPLATES[template]?.roles?.[role] ?? { label: role, color: '#9095a1', min: 0, max: 99 };

export const edgeAllowed = (template, sourceRole, targetRole) =>
  (TEMPLATES[template]?.edges ?? []).some(([s, t]) => s === sourceRole && t === targetRole);

export const workflowAllowed = (template, role) =>
  (TEMPLATES[template]?.workflowRoles ?? []).includes(role);

/** 计算模板要求的必需连线（与后端 _required_edges 一致）。 */
export function requiredEdges(draft) {
  const byRole = {};
  for (const node of draft.nodes) (byRole[node.role] ??= []).push(node.id);
  const t = draft.template;
  if (t === 'supervisor' && byRole.supervisor?.length) {
    const manager = byRole.supervisor[0];
    return (byRole.specialist ?? []).flatMap((s) => [[manager, s], [s, manager]]);
  }
  if (t === 'parallel_review' && byRole.source?.length && byRole.judge?.length) {
    const [source] = byRole.source;
    const [judge] = byRole.judge;
    return (byRole.reviewer ?? []).flatMap((r) => [[source, r], [r, judge]]);
  }
  if (t === 'plan_execute' && byRole.planner?.length && byRole.executor?.length && byRole.replanner?.length) {
    const [p] = byRole.planner;
    const [e] = byRole.executor;
    const [r] = byRole.replanner;
    return [[p, e], [e, r], [r, e]];
  }
  return [];
}

/** 判断某智能体可否绑定到指定模板角色。 */
export function agentUsable(agent, template, role) {
  if (!agent?.enabled) return false;
  if (agent.kind === 'coze_workflow') return workflowAllowed(template, role);
  return agent.kind === 'coze_chat';
}

/** 为新建编排生成初始草稿（带默认节点、必需连线与布局）。 */
export function initialDraft(template, defaultAgentId) {
  const meta = TEMPLATES[template];
  const nodes = [];
  let row = 0;
  for (const [role, spec] of Object.entries(meta.roles)) {
    for (let i = 0; i < spec.min; i += 1) {
      nodes.push({
        id: spec.min > 1 || spec.max > 1 ? `${role}_${i + 1}` : role,
        role,
        agent_id: defaultAgentId,
        position: { x: 120 + row * 300, y: 120 + i * 140 },
        config: template === 'topic_auction' ? { base_bid: 0.5, keywords: [] } : {},
      });
    }
    row += 1;
  }
  // handoff 至少需要 2 个节点。
  if (template === 'handoff') {
    nodes.length = 0;
    nodes.push(
      { id: 'agent_1', role: 'agent', agent_id: defaultAgentId, position: { x: 120, y: 160 }, config: {} },
      { id: 'agent_2', role: 'agent', agent_id: defaultAgentId, position: { x: 440, y: 160 }, config: {} },
    );
  }
  const draft = { template, nodes, edges: [], settings: { max_turns: 8 } };
  draft.edges = requiredEdges(draft).map(([source, target]) => ({ source, target, condition: null }));
  if (template === 'handoff') {
    draft.edges = [{ source: 'agent_1', target: 'agent_2', condition: null }];
    draft.settings.entry_node = 'agent_1';
  }
  return draft;
}

export const SLUG_RE = /^[a-z][a-z0-9_-]{2,79}$/;
export const NODE_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/;
