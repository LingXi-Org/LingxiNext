// FlowCanvas：通用节点画布引擎。
// 交互约定（与主流节点编辑器一致）：
//   拖拽空白 = 平移；Shift+拖拽空白 = 框选；滚轮 = 以光标为中心缩放
//   拖拽节点 = 移动所选；点击 = 选中；Shift+点击 = 加选/减选
//   从输出端口拖到目标节点/输入端口 = 连线（仅高亮合法目标）
//   右键 = 上下文菜单（由宿主处理）；小地图可点击/拖拽导航

const NODE_W = 208;
const GRID = 8;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.2;

const edgeKey = (source, target) => `${source}→${target}`;

export class FlowCanvas {
  /**
   * host: .ed-stage 容器
   * hooks: {
   *   renderNode(node) -> 节点内部 HTML,
   *   allowSourcePort(node) / allowTargetPort(node) -> bool,
   *   canConnect(sourceId, targetId) -> bool,
   *   onConnect(sourceId, targetId),
   *   onMoveCommit(moves: [{id, x, y}]),
   *   onSelectionChange(),
   *   onNodeContext(nodeId, clientX, clientY),
   *   onEdgeContext(source, target, clientX, clientY),
   *   onCanvasContext(clientX, clientY, worldX, worldY),
   * }
   */
  constructor(host, hooks) {
    this.host = host;
    this.hooks = hooks;
    this.nodes = [];
    this.edges = [];
    this.geo = new Map(); // id -> {x, y, h, el}
    this.selectedNodes = new Set();
    this.selectedEdges = new Set();
    this.scale = 1;
    this.tx = 0;
    this.ty = 0;
    this.destroyed = false;

    host.insertAdjacentHTML('afterbegin', `
      <div class="canvas-viewport" data-viewport>
        <div class="canvas-world" data-world>
          <svg class="edge-svg" data-edges width="10" height="10"></svg>
        </div>
        <div class="marquee" data-marquee hidden></div>
      </div>
      <div class="canvas-controls">
        <button type="button" data-zoom-in title="放大"><svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z"/></svg></button>
        <button type="button" class="zoom-pct" data-zoom-pct title="重置为 100%">100%</button>
        <button type="button" data-zoom-out title="缩小"><svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg></button>
        <button type="button" data-zoom-fit title="适应画布"><svg viewBox="0 0 24 24"><path d="M4 9V4h5v2H6v3H4zm16 0h-2V6h-3V4h5v5zM4 15h2v3h3v2H4v-5zm14 3v-3h2v5h-5v-2h3z"/></svg></button>
      </div>
      <div class="minimap" data-minimap><svg data-minimap-svg></svg></div>`);

    this.viewport = host.querySelector('[data-viewport]');
    this.world = host.querySelector('[data-world]');
    this.edgeSvg = host.querySelector('[data-edges]');
    this.marqueeEl = host.querySelector('[data-marquee]');
    this.minimap = host.querySelector('[data-minimap]');
    this.minimapSvg = host.querySelector('[data-minimap-svg]');
    this.zoomPctEl = host.querySelector('[data-zoom-pct]');

    this._bind();
    this._applyTransform();
  }

  destroy() {
    this.destroyed = true;
    this.viewport?.remove();
    this.host.querySelector('.canvas-controls')?.remove();
    this.minimap?.remove();
  }

  /* ---------- 数据渲染 ---------- */

  setData(nodes, edges) {
    this.nodes = nodes;
    this.edges = edges;
    const alive = new Set(nodes.map((n) => n.id));
    for (const id of [...this.selectedNodes]) if (!alive.has(id)) this.selectedNodes.delete(id);
    const edgeSet = new Set(edges.map((e) => edgeKey(e.source, e.target)));
    for (const key of [...this.selectedEdges]) if (!edgeSet.has(key)) this.selectedEdges.delete(key);

    for (const [id, entry] of this.geo) if (!alive.has(id)) { entry.el.remove(); this.geo.delete(id); }

    for (const node of nodes) {
      let entry = this.geo.get(node.id);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'fnode';
        el.dataset.nodeId = node.id;
        this.world.appendChild(el);
        entry = { el, x: 0, y: 0, h: 64 };
        this.geo.set(node.id, entry);
        this._bindNode(el);
      }
      entry.x = node.position.x;
      entry.y = node.position.y;
      entry.el.style.left = `${entry.x}px`;
      entry.el.style.top = `${entry.y}px`;
      entry.el.innerHTML = `
        ${this.hooks.renderNode(node)}
        <div class="port in ${this.hooks.allowTargetPort(node) ? '' : 'disabled'}" data-port="in"></div>
        <div class="port out ${this.hooks.allowSourcePort(node) ? '' : 'disabled'}" data-port="out"></div>`;
      entry.el.classList.toggle('selected', this.selectedNodes.has(node.id));
      entry.h = entry.el.offsetHeight || 64;
    }
    this._renderEdges();
    this._renderMinimap();
  }

  _renderEdges() {
    const parts = [];
    for (const edge of this.edges) {
      const key = edgeKey(edge.source, edge.target);
      const d = this._edgePath(edge.source, edge.target);
      if (!d) continue;
      parts.push(`<g data-edge="${edge.source}|${edge.target}" class="${this.selectedEdges.has(key) ? 'selected' : ''}">
        <path class="edge-hit" d="${d.path}"></path>
        <path class="edge-line" d="${d.path}"></path>
        <path class="edge-arrow" d="M${d.x2 - 8} ${d.y2 - 4.6} L${d.x2 - 0.5} ${d.y2} L${d.x2 - 8} ${d.y2 + 4.6} Z"></path>
      </g>`);
    }
    if (this._ghost) {
      parts.push(`<path class="ghost-edge" d="${this._ghost}"></path>`);
    }
    this.edgeSvg.innerHTML = parts.join('');
  }

  _edgePath(sourceId, targetId) {
    const a = this.geo.get(sourceId);
    const b = this.geo.get(targetId);
    if (!a || !b) return null;
    const x1 = a.x + NODE_W;
    const y1 = a.y + a.h / 2;
    const x2 = b.x - 2;
    const y2 = b.y + b.h / 2;
    const bend = Math.max(48, Math.min(Math.abs(x2 - x1) * 0.45, 170));
    return { path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 8} ${y2}`, x2, y2 };
  }

  /* ---------- 视口变换 ---------- */

  _applyTransform() {
    this.world.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
    const grid = 24 * this.scale;
    this.viewport.style.backgroundSize = `${grid}px ${grid}px`;
    this.viewport.style.backgroundPosition = `${this.tx}px ${this.ty}px`;
    this.zoomPctEl.textContent = `${Math.round(this.scale * 100)}%`;
    this._renderMinimap();
  }

  screenToWorld(clientX, clientY) {
    const rect = this.viewport.getBoundingClientRect();
    return { x: (clientX - rect.left - this.tx) / this.scale, y: (clientY - rect.top - this.ty) / this.scale };
  }

  setZoom(next, cx, cy) {
    const rect = this.viewport.getBoundingClientRect();
    const px = cx ?? rect.width / 2;
    const py = cy ?? rect.height / 2;
    const world = { x: (px - this.tx) / this.scale, y: (py - this.ty) / this.scale };
    this.scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
    this.tx = px - world.x * this.scale;
    this.ty = py - world.y * this.scale;
    this._applyTransform();
  }

  fitView() {
    if (!this.nodes.length) { this.scale = 1; this.tx = 60; this.ty = 60; this._applyTransform(); return; }
    const bounds = this._bounds();
    const rect = this.viewport.getBoundingClientRect();
    const pad = 70;
    const scale = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.min((rect.width - pad * 2) / bounds.w, (rect.height - pad * 2) / bounds.h, 1.25)),
    );
    this.scale = scale;
    this.tx = (rect.width - bounds.w * scale) / 2 - bounds.x * scale;
    this.ty = (rect.height - bounds.h * scale) / 2 - bounds.y * scale;
    this._applyTransform();
  }

  centerOnNode(id) {
    const entry = this.geo.get(id);
    if (!entry) return;
    const rect = this.viewport.getBoundingClientRect();
    this.tx = rect.width / 2 - (entry.x + NODE_W / 2) * this.scale;
    this.ty = rect.height / 2 - (entry.y + entry.h / 2) * this.scale;
    this._applyTransform();
  }

  _bounds() {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const { x, y, h } of this.geo.values()) {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + NODE_W); maxY = Math.max(maxY, y + h);
    }
    return { x: minX, y: minY, w: Math.max(maxX - minX, 1), h: Math.max(maxY - minY, 1) };
  }

  /* ---------- 选择 ---------- */

  getSelection() {
    return {
      nodes: [...this.selectedNodes],
      edges: [...this.selectedEdges].map((key) => key.split('→')),
    };
  }

  setSelection(nodeIds = [], edgePairs = []) {
    this.selectedNodes = new Set(nodeIds);
    this.selectedEdges = new Set(edgePairs.map(([s, t]) => edgeKey(s, t)));
    this._paintSelection();
    this.hooks.onSelectionChange();
  }

  selectAll() {
    this.setSelection(this.nodes.map((n) => n.id), this.edges.map((e) => [e.source, e.target]));
  }

  _paintSelection() {
    for (const [id, entry] of this.geo) entry.el.classList.toggle('selected', this.selectedNodes.has(id));
    this.edgeSvg.querySelectorAll('[data-edge]').forEach((g) => {
      const [s, t] = g.dataset.edge.split('|');
      g.classList.toggle('selected', this.selectedEdges.has(edgeKey(s, t)));
    });
    this._renderMinimap();
  }

  setNodeErrors(errorIds) {
    for (const [id, entry] of this.geo) {
      const has = errorIds.has(id);
      entry.el.classList.toggle('has-error', has);
      let badge = entry.el.querySelector('.err-badge');
      if (has && !badge) {
        badge = document.createElement('span');
        badge.className = 'err-badge';
        badge.textContent = '!';
        entry.el.appendChild(badge);
      } else if (!has && badge) badge.remove();
    }
  }

  /* ---------- 事件绑定 ---------- */

  _bind() {
    const vp = this.viewport;

    vp.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = vp.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.006 : 0.0018));
      this.setZoom(this.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    vp.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.fnode') || event.target.closest('[data-edge]')) return;
      if (event.button === 2) return;
      if (event.button === 0 && event.shiftKey) { this._startMarquee(event); return; }
      if (event.button === 0 || event.button === 1) this._startPan(event);
    });

    // 连线选择
    this.edgeSvg.parentElement.addEventListener('pointerdown', (event) => {
      const g = event.target.closest?.('[data-edge]');
      if (!g || event.button !== 0) return;
      event.stopPropagation();
      const [s, t] = g.dataset.edge.split('|');
      const key = edgeKey(s, t);
      if (event.shiftKey) {
        this.selectedEdges.has(key) ? this.selectedEdges.delete(key) : this.selectedEdges.add(key);
      } else {
        this.selectedNodes.clear();
        this.selectedEdges = new Set([key]);
      }
      this._paintSelection();
      this.hooks.onSelectionChange();
    });

    vp.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      const nodeEl = event.target.closest('.fnode');
      if (nodeEl) {
        const id = nodeEl.dataset.nodeId;
        if (!this.selectedNodes.has(id)) this.setSelection([id]);
        this.hooks.onNodeContext(id, event.clientX, event.clientY);
        return;
      }
      const g = event.target.closest?.('[data-edge]');
      if (g) {
        const [s, t] = g.dataset.edge.split('|');
        this.setSelection([], [[s, t]]);
        this.hooks.onEdgeContext(s, t, event.clientX, event.clientY);
        return;
      }
      const world = this.screenToWorld(event.clientX, event.clientY);
      this.hooks.onCanvasContext(event.clientX, event.clientY, world.x, world.y);
    });

    this.host.querySelector('[data-zoom-in]').addEventListener('click', () => this.setZoom(this.scale * 1.25));
    this.host.querySelector('[data-zoom-out]').addEventListener('click', () => this.setZoom(this.scale / 1.25));
    this.host.querySelector('[data-zoom-pct]').addEventListener('click', () => this.setZoom(1));
    this.host.querySelector('[data-zoom-fit]').addEventListener('click', () => this.fitView());

    this.minimap.addEventListener('pointerdown', (event) => this._minimapNav(event, true));
  }

  _startPan(event) {
    const start = { x: event.clientX, y: event.clientY, tx: this.tx, ty: this.ty };
    let moved = false;
    const vp = this.viewport;
    vp.setPointerCapture(event.pointerId);
    const onMove = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) { moved = true; vp.classList.add('panning'); }
      this.tx = start.tx + dx;
      this.ty = start.ty + dy;
      this._applyTransform();
    };
    const onUp = () => {
      vp.classList.remove('panning');
      vp.removeEventListener('pointermove', onMove);
      vp.removeEventListener('pointerup', onUp);
      vp.removeEventListener('pointercancel', onUp);
      if (!moved) { this.setSelection(); } // 单击空白 = 清空选择
    };
    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup', onUp);
    vp.addEventListener('pointercancel', onUp);
  }

  _startMarquee(event) {
    const vp = this.viewport;
    const rect = vp.getBoundingClientRect();
    const start = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    const base = { nodes: new Set(this.selectedNodes), edges: new Set(this.selectedEdges) };
    vp.setPointerCapture(event.pointerId);
    this.marqueeEl.hidden = false;
    const onMove = (ev) => {
      const cur = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
      const box = {
        x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y),
        w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y),
      };
      Object.assign(this.marqueeEl.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
      const w1 = { x: (box.x - this.tx) / this.scale, y: (box.y - this.ty) / this.scale };
      const w2 = { x: (box.x + box.w - this.tx) / this.scale, y: (box.y + box.h - this.ty) / this.scale };
      this.selectedNodes = new Set(base.nodes);
      for (const [id, g] of this.geo) {
        if (g.x + NODE_W > w1.x && g.x < w2.x && g.y + g.h > w1.y && g.y < w2.y) this.selectedNodes.add(id);
      }
      this._paintSelection();
    };
    const onUp = () => {
      this.marqueeEl.hidden = true;
      this.marqueeEl.style.width = '0';
      vp.removeEventListener('pointermove', onMove);
      vp.removeEventListener('pointerup', onUp);
      vp.removeEventListener('pointercancel', onUp);
      this.hooks.onSelectionChange();
    };
    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup', onUp);
    vp.addEventListener('pointercancel', onUp);
  }

  _bindNode(el) {
    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      const port = event.target.closest('.port');
      if (port) {
        if (port.dataset.port === 'out' && !port.classList.contains('disabled')) {
          event.stopPropagation();
          this._startConnect(el.dataset.nodeId, event);
        }
        return;
      }
      event.stopPropagation();
      this._startNodeDrag(el.dataset.nodeId, event);
    });
  }

  _startNodeDrag(nodeId, event) {
    const wasSelected = this.selectedNodes.has(nodeId);
    const start = { x: event.clientX, y: event.clientY };
    let dragging = false;
    let dragSet = null;
    let origins = null;

    const onMove = (ev) => {
      const dx = (ev.clientX - start.x) / this.scale;
      const dy = (ev.clientY - start.y) / this.scale;
      if (!dragging && Math.abs(ev.clientX - start.x) + Math.abs(ev.clientY - start.y) < 4) return;
      if (!dragging) {
        dragging = true;
        if (!wasSelected) {
          this.selectedEdges.clear();
          if (ev.shiftKey) this.selectedNodes.add(nodeId);
          else this.selectedNodes = new Set([nodeId]);
          this._paintSelection();
          this.hooks.onSelectionChange();
        }
        dragSet = [...this.selectedNodes];
        origins = new Map(dragSet.map((id) => [id, { x: this.geo.get(id).x, y: this.geo.get(id).y }]));
        dragSet.forEach((id) => this.geo.get(id).el.classList.add('dragging'));
      }
      for (const id of dragSet) {
        const origin = origins.get(id);
        const g = this.geo.get(id);
        g.x = clampPos(Math.round((origin.x + dx) / GRID) * GRID);
        g.y = clampPos(Math.round((origin.y + dy) / GRID) * GRID);
        g.el.style.left = `${g.x}px`;
        g.el.style.top = `${g.y}px`;
      }
      this._renderEdges();
    };
    const onUp = (ev) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (dragging) {
        dragSet.forEach((id) => this.geo.get(id).el.classList.remove('dragging'));
        const moves = dragSet
          .map((id) => ({ id, x: this.geo.get(id).x, y: this.geo.get(id).y }))
          .filter(({ id, x, y }) => origins.get(id).x !== x || origins.get(id).y !== y);
        if (moves.length) this.hooks.onMoveCommit(moves);
        this._renderMinimap();
      } else {
        // 单击语义
        this.selectedEdges.clear();
        if (ev.shiftKey) {
          wasSelected ? this.selectedNodes.delete(nodeId) : this.selectedNodes.add(nodeId);
        } else {
          this.selectedNodes = new Set([nodeId]);
        }
        this._paintSelection();
        this.hooks.onSelectionChange();
      }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  _startConnect(sourceId, event) {
    const sourceGeo = this.geo.get(sourceId);
    const from = { x: sourceGeo.x + NODE_W, y: sourceGeo.y + sourceGeo.h / 2 };
    const valid = new Set();
    for (const node of this.nodes) {
      if (node.id !== sourceId && this.hooks.canConnect(sourceId, node.id)) valid.add(node.id);
    }
    for (const id of valid) this.geo.get(id).el.classList.add('drop-ok');
    this.viewport.classList.add('connecting');
    const sourcePort = sourceGeo.el.querySelector('.port.out');
    sourcePort?.classList.add('active');

    const onMove = (ev) => {
      const to = this.screenToWorld(ev.clientX, ev.clientY);
      const bend = Math.max(48, Math.min(Math.abs(to.x - from.x) * 0.45, 170));
      this._ghost = `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
      this._renderEdges();
    };
    const onUp = (ev) => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      this._ghost = null;
      this.viewport.classList.remove('connecting');
      sourcePort?.classList.remove('active');
      for (const id of valid) this.geo.get(id)?.el.classList.remove('drop-ok');
      const targetEl = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.fnode');
      const targetId = targetEl?.dataset.nodeId;
      if (targetId && valid.has(targetId)) this.hooks.onConnect(sourceId, targetId);
      else this._renderEdges();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }

  /* ---------- 小地图 ---------- */

  _renderMinimap() {
    if (this.destroyed || !this.minimapSvg) return;
    const rect = this.viewport.getBoundingClientRect();
    const view = {
      x: -this.tx / this.scale, y: -this.ty / this.scale,
      w: rect.width / this.scale, h: rect.height / this.scale,
    };
    let bounds;
    if (this.nodes.length) {
      const b = this._bounds();
      bounds = {
        x: Math.min(b.x, view.x), y: Math.min(b.y, view.y),
        x2: Math.max(b.x + b.w, view.x + view.w), y2: Math.max(b.y + b.h, view.y + view.h),
      };
    } else {
      bounds = { x: view.x, y: view.y, x2: view.x + view.w, y2: view.y + view.h };
    }
    const pad = 40;
    bounds.x -= pad; bounds.y -= pad; bounds.x2 += pad; bounds.y2 += pad;
    this.minimapSvg.setAttribute('viewBox', `${bounds.x} ${bounds.y} ${bounds.x2 - bounds.x} ${bounds.y2 - bounds.y}`);
    this.minimapSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const parts = [];
    for (const [id, g] of this.geo) {
      parts.push(`<rect class="mm-node" x="${g.x}" y="${g.y}" width="${NODE_W}" height="${g.h}" rx="10" ${this.selectedNodes.has(id) ? 'style="fill:#5457e0"' : ''}></rect>`);
    }
    parts.push(`<rect class="mm-view" x="${view.x}" y="${view.y}" width="${view.w}" height="${view.h}" rx="6" vector-effect="non-scaling-stroke"></rect>`);
    this.minimapSvg.innerHTML = parts.join('');
    this._mmBounds = bounds;
  }

  _minimapNav(event, capture) {
    event.preventDefault();
    const move = (ev) => {
      const box = this.minimap.getBoundingClientRect();
      const b = this._mmBounds;
      if (!b) return;
      const bw = b.x2 - b.x;
      const bh = b.y2 - b.y;
      // preserveAspectRatio=meet：取较小比例并居中
      const scale = Math.min(box.width / bw, box.height / bh);
      const offsetX = (box.width - bw * scale) / 2;
      const offsetY = (box.height - bh * scale) / 2;
      const wx = b.x + (ev.clientX - box.left - offsetX) / scale;
      const wy = b.y + (ev.clientY - box.top - offsetY) / scale;
      const rect = this.viewport.getBoundingClientRect();
      this.tx = rect.width / 2 - wx * this.scale;
      this.ty = rect.height / 2 - wy * this.scale;
      this._applyTransform();
    };
    move(event);
    if (!capture) return;
    const onUp = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', onUp);
  }
}

const clampPos = (value) => Math.max(-9990, Math.min(9990, value));
