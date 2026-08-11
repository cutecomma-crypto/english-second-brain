// Minimal hand-rolled force-directed graph renderer on <canvas>.
// No external library — small personal-scale graphs (tens to low
// hundreds of nodes) don't need d3.

const TYPE_COLOR = {
  word: "#1B6F63",
  phrase: "#B3541E",
  grammar: "#6D4AA8",
  course: "#5B7A99",
};
const TYPE_COLOR_DARK = {
  word: "#4FBFAE",
  phrase: "#E0954F",
  grammar: "#B29AE0",
  course: "#8FAFC9",
};

export class GraphView {
  constructor(canvas, { onNodeClick } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.onNodeClick = onNodeClick;
    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.width = 0;
    this.height = 0;
    this.dragging = null;
    this.pan = { x: 0, y: 0 };
    this.dprCache = 1;

    this._resize = this._resize.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._tick = this._tick.bind(this);

    window.addEventListener("resize", this._resize);
    canvas.addEventListener("pointerdown", this._onPointerDown);
    canvas.addEventListener("pointermove", this._onPointerMove);
    window.addEventListener("pointerup", this._onPointerUp);

    this._resize();
    this.running = false;
  }

  destroy() {
    window.removeEventListener("resize", this._resize);
    window.removeEventListener("pointerup", this._onPointerUp);
    this.stop();
  }

  setData(nodes, edges, { overdueIds = new Set() } = {}) {
    const prevPositions = new Map(this.nodes.map((n) => [n.id, n]));
    this.overdueIds = overdueIds;
    this.nodes = nodes.map((n) => {
      const prev = prevPositions.get(n.id);
      return {
        ...n,
        x: prev?.x ?? this.width / 2 + (Math.random() - 0.5) * 120,
        y: prev?.y ?? this.height / 2 + (Math.random() - 0.5) * 120,
        vx: prev?.vx ?? 0,
        vy: prev?.vy ?? 0,
      };
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.edges = edges
      .map((e) => ({ ...e, a: this.byId.get(e.from_node_id), b: this.byId.get(e.to_node_id) }))
      .filter((e) => e.a && e.b);
    this._settleFrames = 260;
  }

  start() {
    if (this.running) return;
    this.running = true;
    requestAnimationFrame(this._tick);
  }
  stop() {
    this.running = false;
  }

  focusNode(id) {
    const n = this.byId.get(id);
    if (!n) return;
    this.pan.x = this.width / 2 - n.x;
    this.pan.y = this.height / 2 - n.y;
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dprCache = dpr;
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  _isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  _onPointerDown(e) {
    const { x, y } = this._toWorld(e);
    const hit = this._hitTest(x, y);
    if (hit) {
      this.dragging = { node: hit, offsetX: hit.x - x, offsetY: hit.y - y, moved: false };
    } else {
      this.dragging = { pan: true, startX: e.clientX, startY: e.clientY, panStart: { ...this.pan } };
    }
  }
  _onPointerMove(e) {
    if (!this.dragging) return;
    if (this.dragging.pan) {
      const dx = e.clientX - this.dragging.startX;
      const dy = e.clientY - this.dragging.startY;
      this.pan.x = this.dragging.panStart.x + dx;
      this.pan.y = this.dragging.panStart.y + dy;
    } else {
      const { x, y } = this._toWorld(e);
      this.dragging.node.x = x + this.dragging.offsetX;
      this.dragging.node.y = y + this.dragging.offsetY;
      this.dragging.node.vx = 0;
      this.dragging.node.vy = 0;
      this.dragging.moved = true;
      this._settleFrames = Math.max(this._settleFrames, 60);
    }
  }
  _onPointerUp(e) {
    if (this.dragging && this.dragging.node && !this.dragging.moved) {
      const { x, y } = this._toWorld(e);
      const hit = this._hitTest(x, y);
      if (hit && this.onNodeClick) this.onNodeClick(hit.id);
    }
    this.dragging = null;
  }

  _toWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left - this.pan.x,
      y: e.clientY - rect.top - this.pan.y,
    };
  }

  _hitTest(x, y) {
    let found = null;
    for (const n of this.nodes) {
      const r = this._radius(n);
      if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r * r) found = n;
    }
    return found;
  }

  _radius(n) {
    return n.type === "course" ? 20 : n.type === "word" ? 22 : n.type === "phrase" ? 18 : n.type === "grammar" ? 16 : 14;
  }

  _tick() {
    if (!this.running) return;
    this._simulate();
    this._draw();
    requestAnimationFrame(this._tick);
  }

  _simulate() {
    const nodes = this.nodes;
    const n = nodes.length;
    if (n === 0) return;
    const settling = (this._settleFrames = Math.max(0, (this._settleFrames || 0) - 1));
    const damping = 0.82;
    const repelStrength = 2600;
    const springLength = 90;
    const springStrength = 0.02;
    const centerStrength = 0.0012;

    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      let fx = 0,
        fy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const b = nodes[j];
        let dx = a.x - b.x,
          dy = a.y - b.y;
        let distSq = dx * dx + dy * dy || 0.01;
        const dist = Math.sqrt(distSq);
        const force = repelStrength / distSq;
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }
      fx += (this.width / 2 - a.x) * centerStrength;
      fy += (this.height / 2 - a.y) * centerStrength;
      a.fx = fx;
      a.fy = fy;
    }
    for (const e of this.edges) {
      const dx = e.b.x - e.a.x,
        dy = e.b.y - e.a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const diff = dist - springLength;
      const force = diff * springStrength;
      const fx = (dx / dist) * force,
        fy = (dy / dist) * force;
      e.a.fx += fx;
      e.a.fy += fy;
      e.b.fx -= fx;
      e.b.fy -= fy;
    }
    for (const a of nodes) {
      if (this.dragging && this.dragging.node === a) continue;
      a.vx = (a.vx + a.fx) * damping;
      a.vy = (a.vy + a.fy) * damping;
      a.x += a.vx * 0.016;
      a.y += a.vy * 0.016;
    }
    if (settling <= 0) {
      for (const a of nodes) {
        a.vx *= 0.5;
        a.vy *= 0.5;
      }
    }
  }

  _draw() {
    const ctx = this.ctx;
    const dark = this._isDark();
    const ink = dark ? "#E8ECEF" : "#14181D";
    const inkFaint = dark ? "#64707A" : "#87919B";
    const surface = dark ? "#161C20" : "#FFFFFF";
    const overdueColor = dark ? "#E0954F" : "#B3541E";
    const typeColor = dark ? TYPE_COLOR_DARK : TYPE_COLOR;

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.save();
    ctx.translate(this.pan.x, this.pan.y);

    ctx.lineWidth = 1.2;
    ctx.strokeStyle = dark ? "rgba(255,255,255,0.14)" : "rgba(20,24,29,0.14)";
    for (const e of this.edges) {
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.stroke();
    }

    ctx.font = '600 11px "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    for (const node of this.nodes) {
      const r = this._radius(node);
      const isOverdue = this.overdueIds && this.overdueIds.has(node.id);
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = typeColor[node.type] || typeColor.word;
      ctx.globalAlpha = 0.16;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = isOverdue ? 2.6 : 1.6;
      ctx.strokeStyle = isOverdue ? overdueColor : typeColor[node.type] || typeColor.word;
      ctx.stroke();

      ctx.fillStyle = ink;
      const label = node.headword.length > 12 ? node.headword.slice(0, 11) + "…" : node.headword;
      ctx.fillText(label, node.x, node.y + r + 13);
    }
    ctx.restore();
  }
}
