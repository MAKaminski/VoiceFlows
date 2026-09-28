import type { DesignDoc, DesignNode } from "./doc.js";

/**
 * Diagram layout (ADR 0011): positions are computed from tree order only, never stored in the doc
 * and never chosen by the model. Deterministic and append-stable — appending a node never moves one
 * already drawn (architecture: left-aligned lane rows; ERD: three stacked columns; sequence: fixed
 * columns and rows), which keeps the reflow budget (< 3 per element) and makes speech feel additive.
 * Edges are orthogonal routes through the gaps between boxes, with rounded corners.
 */
export interface Rect { x: number; y: number; w: number; h: number }
export type EdgeStyle = "sync" | "async" | "return";
export type EndMark = "arrow" | "one" | "many" | "none";
export interface EdgeRoute {
  id: string; from: string; to: string;
  points: Array<[number, number]>;
  d: string; // SVG path with rounded corners
  label?: string; labelX: number; labelY: number;
  style: EdgeStyle; start: EndMark; end: EndMark;
  step?: number; // sequence message number (1-based)
}
export interface LaneBox extends Rect { id: string; tier: string; label: string }
export interface Lifeline { id: string; x: number; y1: number; y2: number }
export interface DiagramLayout {
  kind: "architecture" | "erd" | "sequence" | "constraints" | "cva";
  width: number; height: number;
  nodes: Record<string, Rect>;
  lanes: LaneBox[];
  edges: EdgeRoute[];
  lifelines: Lifeline[];
}

export const ARCH = { PAD: 24, GUTTER: 156, NODE_W: 188, NODE_H: 68, COL_GAP: 64, ROW_GAP: 48, LANE_PAD: 28, LANE_GAP: 24, WRAP: 5, MIN_COLS: 3 } as const;
export const ERD = { PAD: 48, COLS: 3, W: 240, HEAD_H: 42, ROW_H: 28, FOOT: 8, COL_GAP: 120, ROW_GAP: 44 } as const;
export const CON = { PAD: 32, W: 220, H: 104, COL_GAP: 84, ROW_GAP: 64, WRAP: 4 } as const;
export const CVA = { PAD: 40, AXIS: 36, SIZE: 520, ITEM_W: 150, ITEM_H: 38, STRIP_GAP: 36, STRIP_COLS: 4 } as const;
export const SEQ = { PAD: 32, COL_W: 212, HEAD_W: 168, HEAD_H: 56, FIRST: 48, ROW_H: 54, SELF_W: 44, TAIL: 36 } as const;

export function layoutDiagram(doc: DesignDoc): DiagramLayout | null {
  const root = doc.root;
  if (root.type !== "Diagram") return null;
  const kind = root.props.kind as DiagramLayout["kind"];
  switch (kind) { // explicit: a new kind must choose a layout, never fall into another's (ADR 0021)
    case "architecture": return layoutArchitecture(root);
    case "erd": return layoutErd(root);
    case "sequence": return layoutSequence(root);
    case "constraints": return layoutConstraints(root);
    case "cva": return layoutCva(root);
    default: return null;
  }
}

// ── Constraints (ADR 0021): a pipeline of components, append-stable rows of 4 ─────────────────────

/** demand / capacity of a constraints node, or null when either is unknown. ≥ 0.8 = a bottleneck. */
export function utilization(n: DesignNode): number | null {
  const d = Number(n.props.demand), c = Number(n.props.capacity);
  return Number.isFinite(d) && Number.isFinite(c) && c > 0 && n.props.demand != null && n.props.capacity != null ? d / c : null;
}

function layoutConstraints(root: DesignNode): DiagramLayout {
  const { PAD, W, H, COL_GAP, ROW_GAP, WRAP } = CON;
  const items = (root.children ?? []).filter((c) => c.type === "Node");
  const nodes: Record<string, Rect> = {};
  items.forEach((n, i) => {
    const row = Math.floor(i / WRAP), col = i % WRAP;
    nodes[n.id] = { x: PAD + col * (W + COL_GAP), y: PAD + row * (H + ROW_GAP), w: W, h: H };
  });
  const edges: EdgeRoute[] = [];
  for (const e of edgesOf(root)) {
    const a = nodes[String(e.props.from)], b = nodes[String(e.props.to)];
    if (!a || !b) continue;
    let pts: Array<[number, number]>;
    if (Math.abs(a.y - b.y) < 1) { // same row: straight across, or around the top when going backwards
      pts = b.x > a.x ? [[a.x + W, a.y + H / 2], [b.x, b.y + H / 2]] : [[a.x + W / 2, a.y], [a.x + W / 2, a.y - ROW_GAP / 3], [b.x + W / 2, b.y - ROW_GAP / 3], [b.x + W / 2, b.y]];
    } else { // next rows: down through the row gap
      const mid = Math.min(a.y, b.y) + H + ROW_GAP / 2;
      const [top, bot] = a.y < b.y ? [a, b] : [b, a];
      pts = [[top.x + W / 2, top.y + H], [top.x + W / 2, mid], [bot.x + W / 2, mid], [bot.x + W / 2, bot.y]];
      if (a.y > b.y) pts.reverse();
    }
    pts = simplify(pts);
    const [lx, ly] = labelPoint(pts);
    const rate = e.props.rate != null ? `${fmtRate(Number(e.props.rate))}/s` : "";
    const label = [String(e.props.label ?? ""), rate].filter(Boolean).join(" · ");
    edges.push({ id: e.id, from: String(e.props.from), to: String(e.props.to), points: pts, d: roundedPath(pts), ...(label ? { label } : {}),
      labelX: lx, labelY: ly, style: styleOf(e), start: "none", end: "arrow" });
  }
  const rows = Math.max(1, Math.ceil(items.length / WRAP)), cols = Math.max(2, Math.min(WRAP, items.length));
  return { kind: "constraints", width: PAD * 2 + cols * (W + COL_GAP) - COL_GAP, height: PAD * 2 + rows * (H + ROW_GAP) - ROW_GAP, nodes, lanes: [], edges, lifelines: [] };
}
export const fmtRate = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(Math.round(n * 10) / 10));

// ── Cost-value (ADR 0021): a 2×2 matrix, x = cost, y = value; unscored items in a strip below ─────

export const QUADRANTS = [
  { id: "quick", label: "Quick wins", hint: "low cost · high value" }, { id: "big", label: "Big bets", hint: "high cost · high value" },
  { id: "fill", label: "Fill-ins", hint: "low cost · low value" }, { id: "pit", label: "Money pits", hint: "high cost · low value" },
] as const;

function layoutCva(root: DesignNode): DiagramLayout {
  const { PAD, AXIS, SIZE, ITEM_W, ITEM_H, STRIP_GAP, STRIP_COLS } = CVA;
  const items = (root.children ?? []).filter((c) => c.type === "Node");
  const x0 = PAD + AXIS, y0 = PAD, half = SIZE / 2;
  const lanes: LaneBox[] = [
    { id: "q_quick", tier: "quick", label: "Quick wins", x: x0, y: y0, w: half, h: half },
    { id: "q_big", tier: "big", label: "Big bets", x: x0 + half, y: y0, w: half, h: half },
    { id: "q_fill", tier: "fill", label: "Fill-ins", x: x0, y: y0 + half, w: half, h: half },
    { id: "q_pit", tier: "pit", label: "Money pits", x: x0 + half, y: y0 + half, w: half, h: half },
  ];
  const nodes: Record<string, Rect> = {};
  const taken = new Map<string, number>(); // same score → stack downwards
  let unscored = 0;
  const stripY = y0 + SIZE + AXIS + STRIP_GAP;
  for (const n of items) {
    const cost = Number(n.props.cost), value = Number(n.props.value);
    if (n.props.cost == null || n.props.value == null || !Number.isFinite(cost) || !Number.isFinite(value)) {
      const col = unscored % STRIP_COLS, row = Math.floor(unscored / STRIP_COLS);
      nodes[n.id] = { x: x0 + col * (ITEM_W + 16), y: stripY + row * (ITEM_H + 12), w: ITEM_W, h: ITEM_H };
      unscored++;
      continue;
    }
    const cx = x0 + ((cost - 1) / 4) * (SIZE - ITEM_W - 24) + 12;
    const cy = y0 + ((5 - value) / 4) * (SIZE - ITEM_H - 24) + 12;
    const key = `${cost}:${value}`;
    const k = taken.get(key) ?? 0;
    taken.set(key, k + 1);
    nodes[n.id] = { x: cx, y: cy + k * (ITEM_H + 6), w: ITEM_W, h: ITEM_H };
  }
  const stripRows = Math.ceil(unscored / STRIP_COLS);
  const height = stripY + (stripRows ? stripRows * (ITEM_H + 12) : 0) + PAD;
  return { kind: "cva", width: x0 + SIZE + PAD, height, nodes, lanes, edges: [], lifelines: [] };
}

// ── Architecture ────────────────────────────────────────────────────────────────────────────────

interface Placed { rect: Rect; lane: number; row: number; col: number }

function layoutArchitecture(root: DesignNode): DiagramLayout {
  const { PAD, GUTTER, NODE_W, NODE_H, COL_GAP, ROW_GAP, LANE_PAD, LANE_GAP, WRAP, MIN_COLS } = ARCH;
  const layers = (root.children ?? []).filter((c) => c.type === "Layer");
  const cols = Math.max(MIN_COLS, ...layers.map((l) => Math.min(WRAP, l.children?.length ?? 0)));
  const laneW = GUTTER + cols * (NODE_W + COL_GAP) - COL_GAP + LANE_PAD;
  const nodes: Record<string, Rect> = {};
  const placed = new Map<string, Placed>();
  const lanes: LaneBox[] = [];
  let y = PAD;
  layers.forEach((layer, li) => {
    const kids = layer.children ?? [];
    const rows = Math.max(1, Math.ceil(kids.length / WRAP));
    const h = LANE_PAD * 2 + rows * NODE_H + (rows - 1) * ROW_GAP;
    lanes.push({ id: layer.id, tier: String(layer.props.tier), label: String(layer.props.label ?? layer.props.tier), x: PAD, y, w: laneW, h });
    kids.forEach((n, i) => {
      const row = Math.floor(i / WRAP), col = i % WRAP;
      const rect = { x: PAD + GUTTER + col * (NODE_W + COL_GAP), y: y + LANE_PAD + row * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H };
      nodes[n.id] = rect;
      placed.set(n.id, { rect, lane: li, row, col });
    });
    y += h + LANE_GAP;
  });
  const height = y - LANE_GAP + PAD;
  const width = PAD * 2 + laneW;

  // Corridors: horizontal ones sit in row gaps and lane gaps, vertical ones in the column gaps.
  const rowsOf = (li: number) => Math.max(1, Math.ceil((layers[li]?.children?.length ?? 0) / WRAP));
  const below = (p: Placed) => p.row < rowsOf(p.lane) - 1
    ? p.rect.y + NODE_H + ROW_GAP / 2
    : lanes[p.lane]!.y + lanes[p.lane]!.h + LANE_GAP / 2;
  const above = (p: Placed) => p.row > 0 ? p.rect.y - ROW_GAP / 2 : lanes[p.lane]!.y - LANE_GAP / 2;
  const colX = (c: number) => PAD + GUTTER + c * (NODE_W + COL_GAP) - COL_GAP / 2; // left of column c

  type Plan = { e: DesignNode; a: Placed; b: Placed; aSide: Side; bSide: Side };
  type Side = "top" | "bottom" | "left" | "right";
  const plans: Plan[] = [];
  for (const e of edgesOf(root)) {
    const a = placed.get(String(e.props.from)), b = placed.get(String(e.props.to));
    if (!a || !b || a === b) continue;
    let aSide: Side, bSide: Side;
    if (a.lane === b.lane && a.row === b.row) {
      if (Math.abs(a.col - b.col) === 1) { aSide = a.col < b.col ? "right" : "left"; bSide = a.col < b.col ? "left" : "right"; }
      else { aSide = "top"; bSide = "top"; }
    } else {
      const down = a.lane < b.lane || (a.lane === b.lane && a.row < b.row);
      aSide = down ? "bottom" : "top"; bSide = down ? "top" : "bottom";
    }
    plans.push({ e, a, b, aSide, bSide });
  }
  // Ports: several edges on one side of a box spread across it, ordered by where they head.
  const ports = assignPorts(plans.flatMap((p, i) => [
    { key: `${p.e.props.from}:${p.aSide}`, edge: i, end: 0 as const, rect: p.a.rect, side: p.aSide, toward: center(p.b.rect) },
    { key: `${p.e.props.to}:${p.bSide}`, edge: i, end: 1 as const, rect: p.b.rect, side: p.bSide, toward: center(p.a.rect) },
  ]));
  const offset = spreader(7); // corridor → alternating offsets so parallel edges don't overlap

  const edges: EdgeRoute[] = plans.map((p, i) => {
    const [s, t] = [ports.get(`${i}:0`)!, ports.get(`${i}:1`)!];
    let pts: Array<[number, number]>;
    if (p.aSide === "left" || p.aSide === "right") {
      const xm = (s[0] + t[0]) / 2;
      pts = s[1] === t[1] ? [s, t] : [s, [xm, s[1]], [xm, t[1]], t];
    } else {
      // Same row, not adjacent: arc through this lane's own top padding, not the gap shared with
      // edges coming from the lane above (they would cross).
      const sameRow = p.a.lane === p.b.lane && p.a.row === p.b.row;
      const hop = sameRow && p.a.row === 0 ? p.a.rect.y - LANE_PAD / 2 : null;
      const y1 = hop ?? (p.aSide === "bottom" ? below(p.a) : above(p.a));
      const y2 = hop ?? (p.bSide === "top" ? above(p.b) : below(p.b));
      if (Math.abs(y1 - y2) < 1) {
        const yy = y1 + offset(`h${Math.round(y1)}`);
        pts = s[0] === t[0] ? [s, t] : [s, [s[0], yy], [t[0], yy], t];
      } else {
        // Travel vertically in the column gap nearest the midpoint, never through a box.
        const mid = (s[0] + t[0]) / 2;
        let best = 0, bestD = Infinity;
        for (let c = 0; c <= cols; c++) { const d = Math.abs(colX(c) - mid); if (d < bestD) { bestD = d; best = c; } }
        const xc = colX(best) + offset(`v${best}`);
        const ya = y1 + offset(`h${Math.round(y1)}`), yb = y2 + offset(`h${Math.round(y2)}`);
        pts = [s, [s[0], ya], [xc, ya], [xc, yb], [t[0], yb], t];
      }
    }
    pts = simplify(pts);
    let [lx, ly] = labelPoint(pts);
    // Neighbours sit a column gap apart — too narrow for a label: lift it into the lane padding above.
    if (p.aSide === "left" || p.aSide === "right") { lx = (s[0] + t[0]) / 2; ly = Math.min(p.a.rect.y, p.b.rect.y) - LANE_PAD / 2 + 1; }
    return {
      id: p.e.id, from: String(p.e.props.from), to: String(p.e.props.to), points: pts, d: roundedPath(pts),
      ...(p.e.props.label ? { label: String(p.e.props.label) } : {}), labelX: lx, labelY: ly,
      style: styleOf(p.e), start: "none", end: "arrow",
    };
  });
  return { kind: "architecture", width, height, nodes, lanes, edges, lifelines: [] };
}

// ── ERD ─────────────────────────────────────────────────────────────────────────────────────────

const singular = (w: string) => w.toLowerCase().replace(/ies$/, "y").replace(/(ss|sh|ch|x)es$/, "$1").replace(/s$/, "");

function layoutErd(root: DesignNode): DiagramLayout {
  const { PAD, COLS, W, HEAD_H, ROW_H, FOOT, COL_GAP, ROW_GAP } = ERD;
  const entities = (root.children ?? []).filter((c) => c.type === "Node");
  const nodes: Record<string, Rect> = {};
  const colOf = new Map<string, number>();
  const heights = Array<number>(COLS).fill(PAD);
  entities.forEach((n, i) => {
    const c = i % COLS;
    const rows = Math.max(1, (n.props.cols as string[] | undefined)?.length ?? 0);
    const h = HEAD_H + rows * ROW_H + FOOT;
    nodes[n.id] = { x: PAD + c * (W + COL_GAP), y: heights[c]!, w: W, h };
    colOf.set(n.id, c);
    heights[c]! += h + ROW_GAP;
  });
  const usedCols = Math.min(COLS, Math.max(1, entities.length));
  const width = PAD * 2 + usedCols * W + (usedCols - 1) * COL_GAP;
  const height = Math.max(...heights) - ROW_GAP + PAD;
  const byId = new Map(entities.map((n) => [n.id, n]));

  /** y of the column row an edge attaches to: the fk naming the other table, else the pk, else the header. */
  const rowY = (n: DesignNode, other: DesignNode, preferFk: boolean) => {
    const r = nodes[n.id]!;
    const cols = (n.props.cols as string[] | undefined) ?? [];
    const names = cols.map((c) => c.split(":"));
    const o = singular(String(other.props.label));
    let idx = preferFk ? names.findIndex(([nm, , flag]) => flag === "fk" && nm!.toLowerCase().startsWith(o)) : -1;
    if (idx < 0 && preferFk) idx = names.findIndex(([nm]) => nm!.toLowerCase() === `${o}_id`);
    if (idx < 0) idx = names.findIndex(([, , flag]) => flag === "pk");
    return idx < 0 ? r.y + HEAD_H / 2 : r.y + HEAD_H + idx * ROW_H + ROW_H / 2;
  };
  const off = spreader(9);

  const edges: EdgeRoute[] = [];
  for (const e of edgesOf(root)) {
    const a = byId.get(String(e.props.from)), b = byId.get(String(e.props.to));
    if (!a || !b || a === b) continue;
    const [ra, rb] = [nodes[a.id]!, nodes[b.id]!];
    const card = String(e.props.card ?? "1:n");
    const [ca, cb] = card.split(":") as [string, string];
    // The "many" side carries the fk; the "one" side attaches at its pk.
    const ya = rowY(a, b, ca === "n"), yb = rowY(b, a, cb === "n");
    const [colA, colB] = [colOf.get(a.id)!, colOf.get(b.id)!];
    let pts: Array<[number, number]>;
    if (colA === colB) {
      const xr = ra.x + W + 30 + Math.abs(off(`r${colA}`));
      pts = [[ra.x + W, ya], [xr, ya], [xr, yb], [rb.x + W, yb]];
    } else if (Math.abs(colA - colB) === 1) {
      const leftToRight = colA < colB;
      const sx = leftToRight ? ra.x + W : ra.x, tx = leftToRight ? rb.x : rb.x + W;
      const xc = (sx + tx) / 2 + off(`g${Math.min(colA, colB)}`);
      pts = [[sx, ya], [xc, ya], [xc, yb], [tx, yb]];
    } else {
      // Two columns apart: go over the top through the header gutter, never through the middle column.
      const leftToRight = colA < colB;
      const sx = leftToRight ? ra.x + W : ra.x, tx = leftToRight ? rb.x : rb.x + W;
      const x1 = sx + (leftToRight ? 1 : -1) * (COL_GAP / 2), x2 = tx + (leftToRight ? -1 : 1) * (COL_GAP / 2);
      const yt = PAD / 2 - Math.abs(off("top"));
      pts = [[sx, ya], [x1, ya], [x1, yt], [x2, yt], [x2, yb], [tx, yb]];
    }
    pts = simplify(pts);
    const [lx, ly] = labelPoint(pts);
    edges.push({
      id: e.id, from: a.id, to: b.id, points: pts, d: roundedPath(pts, 8),
      ...(e.props.label ? { label: String(e.props.label) } : {}), labelX: lx, labelY: ly,
      style: styleOf(e), start: ca === "n" ? "many" : "one", end: cb === "n" ? "many" : "one",
    });
  }
  return { kind: "erd", width, height, nodes, lanes: [], edges, lifelines: [] };
}

// ── Sequence ────────────────────────────────────────────────────────────────────────────────────

function layoutSequence(root: DesignNode): DiagramLayout {
  const { PAD, COL_W, HEAD_W, HEAD_H, FIRST, ROW_H, SELF_W, TAIL } = SEQ;
  const actors = (root.children ?? []).filter((c) => c.type === "Node");
  const msgs = edgesOf(root);
  const nodes: Record<string, Rect> = {};
  const cx = new Map<string, number>();
  actors.forEach((a, i) => {
    const x = PAD + i * COL_W;
    nodes[a.id] = { x, y: PAD, w: HEAD_W, h: HEAD_H };
    cx.set(a.id, x + HEAD_W / 2);
  });
  const top = PAD + HEAD_H;
  const edges: EdgeRoute[] = [];
  let step = 0;
  msgs.forEach((m, k) => {
    const fx = cx.get(String(m.props.from)), tx = cx.get(String(m.props.to));
    if (fx == null || tx == null) return;
    const y = top + FIRST + k * ROW_H;
    step++;
    let pts: Array<[number, number]>, lx: number, ly: number;
    if (fx === tx) {
      pts = [[fx, y - 10], [fx + SELF_W, y - 10], [fx + SELF_W, y + 10], [fx, y + 10]];
      const label = String(m.props.label ?? "");
      lx = fx + SELF_W + 12 + Math.min(220, label.length * 6.6 + 16) / 2; ly = y; // right of the loop
    } else {
      pts = [[fx, y], [tx, y]];
      lx = (fx + tx) / 2; ly = y - 14;
    }
    edges.push({
      id: m.id, from: String(m.props.from), to: String(m.props.to), points: pts, d: roundedPath(pts, 6),
      ...(m.props.label ? { label: String(m.props.label) } : {}), labelX: lx, labelY: ly,
      style: styleOf(m), start: "none", end: "arrow", step,
    });
  });
  const bottom = top + FIRST + Math.max(1, msgs.length) * ROW_H - ROW_H / 2 + TAIL;
  const lifelines = actors.map((a) => ({ id: a.id, x: cx.get(a.id)!, y1: top, y2: bottom }));
  const width = PAD * 2 + Math.max(0, actors.length - 1) * COL_W + HEAD_W + SELF_W;
  return { kind: "sequence", width: Math.max(width, 360), height: bottom + PAD, nodes, lanes: [], edges, lifelines };
}

// ── Shared geometry ─────────────────────────────────────────────────────────────────────────────

function edgesOf(root: DesignNode) { return (root.children ?? []).filter((c) => c.type === "Edge"); }
function styleOf(e: DesignNode): EdgeStyle { const s = e.props.style; return s === "async" || s === "return" ? s : "sync"; }
/** Per-corridor offsets 0, +s, −s, +2s, … so parallel edges sit side by side instead of on top of each other. */
function spreader(step: number) {
  const used = new Map<string, number>();
  return (key: string) => { const n = used.get(key) ?? 0; used.set(key, n + 1); return n === 0 ? 0 : (n % 2 ? 1 : -1) * Math.ceil(n / 2) * step; };
}
const center = (r: Rect): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

function assignPorts(ends: Array<{ key: string; edge: number; end: 0 | 1; rect: Rect; side: string; toward: [number, number] }>) {
  const groups = new Map<string, typeof ends>();
  for (const e of ends) groups.set(e.key, [...(groups.get(e.key) ?? []), e]);
  const out = new Map<string, [number, number]>();
  for (const g of groups.values()) {
    const horiz = g[0]!.side === "top" || g[0]!.side === "bottom";
    g.sort((p, q) => (horiz ? p.toward[0] - q.toward[0] : p.toward[1] - q.toward[1]));
    g.forEach((p, i) => {
      const f = (i + 1) / (g.length + 1);
      const { x, y, w, h } = p.rect;
      const pt: [number, number] = p.side === "top" ? [x + w * f, y] : p.side === "bottom" ? [x + w * f, y + h]
        : p.side === "left" ? [x, y + h * f] : [x + w, y + h * f];
      out.set(`${p.edge}:${p.end}`, [Math.round(pt[0]), Math.round(pt[1])]);
    });
  }
  return out;
}

/** Drops zero-length segments and collinear midpoints. */
export function simplify(pts: Array<[number, number]>): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 0.5 && Math.abs(last[1] - p[1]) < 0.5) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!, b = out[out.length - 1]!;
      if ((Math.abs(a[0] - b[0]) < 0.5 && Math.abs(b[0] - p[0]) < 0.5) || (Math.abs(a[1] - b[1]) < 0.5 && Math.abs(b[1] - p[1]) < 0.5)) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

/** Midpoint of the longest segment — where a label reads best. */
export function labelPoint(pts: Array<[number, number]>): [number, number] {
  let best = 0, len = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1]);
    if (l > len) { len = l; best = i; }
  }
  const [a, b] = [pts[best]!, pts[best + 1] ?? pts[best]!];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Polyline → SVG path with corners rounded at radius r (clamped to half of each segment). */
export function roundedPath(pts: Array<[number, number]>, r = 12): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p, c, n] = [pts[i - 1]!, pts[i]!, pts[i + 1]!];
    const l1 = Math.hypot(c[0] - p[0], c[1] - p[1]), l2 = Math.hypot(n[0] - c[0], n[1] - c[1]);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const a: [number, number] = [c[0] - ((c[0] - p[0]) / l1) * rr, c[1] - ((c[1] - p[1]) / l1) * rr];
    const b: [number, number] = [c[0] + ((n[0] - c[0]) / l2) * rr, c[1] + ((n[1] - c[1]) / l2) * rr];
    d += ` L${fx(a[0])},${fx(a[1])} Q${c[0]},${c[1]} ${fx(b[0])},${fx(b[1])}`;
  }
  const last = pts[pts.length - 1]!;
  return `${d} L${last[0]},${last[1]}`;
}
const fx = (n: number) => Math.round(n * 10) / 10;
