"use client";
import { fmtRate, layoutDiagram, utilization, type DesignDoc, type DesignNode, type DiagramLayout, type EdgeRoute, type Rect } from "@livecanvas/dsl";
import {
  Boxes, Cloud, Cog, Database, Globe, HardDrive, KeyRound, Layers, Link2, Monitor, Network, Server, Table2, User, Zap, type LucideIcon,
} from "lucide-react";
import { memo, useMemo, type CSSProperties } from "react";
import { gateway } from "@/lib/gateway";
import { useFeatures } from "@/store/features";

/**
 * Renders the three diagram kinds (ADR 0011) from `layoutDiagram` — positions are computed, never
 * stored. Boxes are HTML (crisp type, `data-node-id` for the reflow metric); edges are one SVG layer
 * beneath them. No position transitions: a moved box would be sampled mid-animation (plan-critic #6).
 */

type Tone = { accent: string; tint: string; border: string };
const TONES: Record<string, Tone> = {
  frontend: { accent: "#2563eb", tint: "#eff6ff", border: "#bfdbfe" },
  api: { accent: "#7c3aed", tint: "#f5f3ff", border: "#ddd6fe" },
  data: { accent: "#059669", tint: "#ecfdf5", border: "#a7f3d0" },
  infra: { accent: "#d97706", tint: "#fffbeb", border: "#fde68a" },
  other: { accent: "#475569", tint: "#f8fafc", border: "#cbd5e1" }, // a named extra lane (ADR 0016)
};
const KIND_TIER: Record<string, keyof typeof TONES> = {
  user: "frontend", client: "frontend", service: "api", auth: "api", worker: "api", queue: "api", external: "api",
  db: "data", cache: "data", storage: "data", entity: "data", cdn: "infra",
};
const KIND_ICON: Record<string, LucideIcon> = {
  user: User, client: Monitor, service: Server, db: Database, cache: Zap, queue: Layers, storage: HardDrive,
  external: Globe, cdn: Cloud, auth: KeyRound, worker: Cog, entity: Table2,
};
const LANE_ICON: Record<string, LucideIcon> = { frontend: Monitor, api: Network, data: Database, infra: Boxes };

const EMPTY: Record<string, string> = {
  erd: "Name your tables — “users, orders, products…”",
  sequence: "Name who talks — “the user, the web app, the API…”",
  constraints: "Say the load — “500 requests a second at peak, Postgres handles 200 writes a second”",
  cva: "Weigh features — “sign in is cheap and high value, AI routing is expensive but high value”",
};
/** Scaffolded from another view (ADR 0021): dashed and marked until this view's own speech touches it. */
const inferredCls = (n: DesignNode) => [n.provisional ? "lc-provisional" : "", n.inferred ? "lc-inferred" : ""].filter(Boolean).join(" ") || undefined;
const InferredBadge = ({ n }: { n: DesignNode }) => (n.inferred
  ? <span title="Inferred from another view — say it here to confirm or change it" style={{ position: "absolute", bottom: -9, left: 10, fontSize: 10, fontWeight: 600, padding: "0 6px", borderRadius: 999, background: "#f1f5f9", color: "#64748b", border: "1px dashed #94a3b8" }}>inferred</span>
  : null);

const INK = "#0f172a", MUTED = "#64748b", LINE = "#94a3b8", EDGE = "#475569";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function DiagramCanvas({ doc }: { doc: DesignDoc }) {
  // Keyed on the view root: viewDoc() builds a new wrapper object on every render, the root is shared (M8 grid).
  const layout = useMemo(() => layoutDiagram(doc), [doc.root]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggested = useFeatures((s) => s.suggestions);
  if (!layout) return null;
  const byId = new Map<string, DesignNode>();
  const walk = (n: DesignNode) => { byId.set(n.id, n); n.children?.forEach(walk); };
  walk(doc.root);
  const title = doc.root.props.title as string | undefined;
  const empty = !Object.keys(layout.nodes).length;

  return (
    <div data-node-id={doc.root.id} data-type="Diagram" data-view-root="" data-view={String(doc.root.props.kind)} style={{ display: "contents" }}>
      <div style={{
        position: "relative", width: layout.width, height: layout.height, flex: "none",
        background: "#fff", borderRadius: 20, boxShadow: "0 1px 2px rgba(15,23,42,.06), 0 20px 50px rgba(15,23,42,.12)",
        backgroundImage: "radial-gradient(#e2e8f0 1px, transparent 1px)", backgroundSize: "18px 18px",
        color: INK, fontFamily: "inherit",
      }}>
        {title && <div style={{ position: "absolute", left: 24, top: -34, fontSize: 18, fontWeight: 650, letterSpacing: -0.2 }}>{title}</div>}
        {layout.kind === "cva" ? <Quadrants layout={layout} /> : layout.lanes.map((l) => <Lane key={l.id} lane={l} count={byId.get(l.id)?.children?.length ?? 0} />)}
        <Edges layout={layout} ns={doc.root.id} />
        <EdgeLabels layout={layout} />
        {Object.entries(layout.nodes).map(([id, r]) => {
          const n = byId.get(id);
          if (!n) return null;
          if (layout.kind === "erd") return <Entity key={id} node={n} rect={r} />;
          if (layout.kind === "constraints") return <Gauge key={id} node={n} rect={r} tone={toneFor(n, byId, doc)} />;
          if (layout.kind === "cva") return <Item key={id} node={n} rect={r} />;
          return <Box key={id} node={n} rect={r} tone={toneFor(n, byId, doc)} />;
        })}
        {layout.kind === "erd" && suggested.filter((x) => x.cols && x.target && layout.nodes[x.target]).map((x) => (
          <SuggestedCols key={x.id} id={x.id} cols={x.cols!} rect={layout.nodes[x.target!]!} />
        ))}
        {empty && layout.kind !== "architecture" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: MUTED, fontSize: 14 }}>
            {EMPTY[layout.kind] ?? ""}
          </div>
        )}
      </div>
    </div>
  );
}

function toneFor(n: DesignNode, byId: Map<string, DesignNode>, doc: DesignDoc): Tone {
  if (doc.root.props.kind === "architecture") {
    const lane = (doc.root.children ?? []).find((l) => l.children?.some((c) => c.id === n.id));
    if (lane) return TONES[String(lane.props.tier)] ?? TONES.api!;
  }
  return TONES[KIND_TIER[String(n.props.kind)] ?? "api"]!;
}

const Lane = memo(function Lane({ lane, count }: { lane: DiagramLayout["lanes"][number]; count: number }) {
  const t = TONES[lane.tier] ?? TONES.api!;
  const Icon = LANE_ICON[lane.tier] ?? Layers;
  return (
    <div data-node-id={lane.id} data-type="Layer" style={{ display: "contents" }}>
      <div style={{ position: "absolute", left: lane.x, top: lane.y, width: lane.w, height: lane.h, borderRadius: 16,
        background: t.tint, border: `1px solid ${t.border}`, zIndex: 0 }}>
        <div style={{ position: "absolute", left: 18, top: 0, bottom: 0, display: "flex", alignItems: "center", gap: 10, width: 128 }}>
          <span style={{ width: 30, height: 30, borderRadius: 9, background: "#fff", border: `1px solid ${t.border}`, display: "grid", placeItems: "center", flex: "none" }}>
            <Icon size={16} color={t.accent} strokeWidth={2.2} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 650, color: t.accent }}>{lane.label}</span>
            <span style={{ fontSize: 11, color: MUTED }}>{count ? `${count} component${count === 1 ? "" : "s"}` : "say one…"}</span>
          </span>
        </div>
      </div>
    </div>
  );
});

const cardBase: CSSProperties = {
  position: "absolute", background: "#fff", borderRadius: 12, zIndex: 2, boxSizing: "border-box",
  boxShadow: "0 1px 2px rgba(15,23,42,.06), 0 6px 16px rgba(15,23,42,.07)",
};

const Box = memo(function Box({ node, rect, tone }: { node: DesignNode; rect: Rect; tone: Tone }) {
  const Icon = KIND_ICON[String(node.props.kind)] ?? Server;
  const raw = node.props.tech as string | undefined;
  const tech = raw && raw.toLowerCase() !== String(node.props.label).toLowerCase() ? raw : undefined; // "Postgres / Postgres" reads as noise
  return (
    <div data-node-id={node.id} data-type="Node" style={{ display: "contents" }}>
      <div className={inferredCls(node)} style={{ ...cardBase, left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        border: `1px solid ${tone.border}`, display: "flex", alignItems: "center", gap: 12, padding: "0 14px", ...(node.provisional ? {} : { animation: "lc-pop .18s ease-out" }) }}>
        <InferredBadge n={node} />
        <span style={{ width: 36, height: 36, borderRadius: 10, background: tone.tint, display: "grid", placeItems: "center", flex: "none" }}>
          <Icon size={18} color={tone.accent} strokeWidth={2.2} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, lineHeight: 1.25 }}>
          <span style={{ fontSize: 14, fontWeight: 650, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{String(node.props.label)}</span>
          {tech && <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tech}</span>}
        </span>
        {typeof node.props.owner === "string" && (
          <span title={`Owned by ${node.props.owner}`} style={{ position: "absolute", top: -9, right: 10, maxWidth: 150, fontSize: 10.5, fontWeight: 600,
            padding: "1px 7px", borderRadius: 999, background: "#0f172a", color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{String(node.props.owner)}</span>
        )}
      </div>
    </div>
  );
});

const Entity = memo(function Entity({ node, rect }: { node: DesignNode; rect: Rect }) {
  const t = TONES.data!;
  const cols = ((node.props.cols as string[] | undefined) ?? []).map((c) => c.split(":"));
  return (
    <div data-node-id={node.id} data-type="Node" style={{ display: "contents" }}>
      <div className={inferredCls(node)} style={{ ...cardBase, left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        border: `1px solid ${t.border}`, overflow: "hidden", ...(node.provisional ? {} : { animation: "lc-pop .18s ease-out" }) }}>
        <div style={{ height: 42, display: "flex", alignItems: "center", gap: 8, padding: "0 14px", background: t.tint, borderBottom: `1px solid ${t.border}` }}>
          <Table2 size={16} color={t.accent} strokeWidth={2.2} />
          <span style={{ fontFamily: MONO, fontSize: 13.5, fontWeight: 700, color: INK }}>{String(node.props.label)}</span>
        </div>
        {cols.map(([name, type, flag], i) => (
          <div key={i} style={{ height: 28, display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderTop: i ? "1px solid #f1f5f9" : undefined, fontFamily: MONO, fontSize: 12.5 }}>
            <span style={{ width: 14, display: "grid", placeItems: "center" }}>
              {flag === "pk" ? <KeyRound size={13} color="#d97706" strokeWidth={2.4} /> : flag === "fk" ? <Link2 size={13} color="#2563eb" strokeWidth={2.4} /> : null}
            </span>
            <span style={{ flex: 1, color: INK, fontWeight: flag === "pk" ? 700 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
            <span style={{ color: "#94a3b8" }}>{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
});

// ── Edges ────────────────────────────────────────────────────────────────────────────────────────

/** Marker ids are namespaced per view: the all-views grid mounts three diagrams on one page (ADR 0020). */
function Edges({ layout, ns }: { layout: DiagramLayout; ns: string }) {
  return (
    <svg width={layout.width} height={layout.height} style={{ position: "absolute", inset: 0, zIndex: 1, overflow: "visible", pointerEvents: "none" }}>
      <defs>
        <marker id={`lc-arrow-${ns}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={EDGE} />
        </marker>
        <marker id={`lc-arrow-open-${ns}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M1,1 L9,5 L1,9" fill="none" stroke={EDGE} strokeWidth="1.6" />
        </marker>
        <marker id={`lc-one-${ns}`} viewBox="0 0 16 16" refX="15" refY="8" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
          <path d="M9,2 V14 M13,2 V14" stroke={EDGE} strokeWidth="1.6" />
        </marker>
        <marker id={`lc-many-${ns}`} viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16" orient="auto-start-reverse">
          <path d="M15,1 L5,8 L15,15 M15,8 H3 M5,2 V14" fill="none" stroke={EDGE} strokeWidth="1.6" />
        </marker>
      </defs>
      {layout.lifelines.map((l) => <line key={l.id} x1={l.x} x2={l.x} y1={l.y1} y2={l.y2} stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="5 5" />)}
      {layout.edges.map((e) => <EdgePath key={e.id} e={e} seq={layout.kind === "sequence"} ns={ns} />)}
    </svg>
  );
}

const mark = (end: string, ns: string) => (end === "none" ? undefined : `url(#lc-${end}-${ns})`);

const EdgePath = memo(function EdgePath({ e, seq, ns }: { e: EdgeRoute; seq: boolean; ns: string }) {
  const dashed = e.style !== "sync";
  const end = e.end === "arrow" && e.style === "async" ? `url(#lc-arrow-open-${ns})` : mark(e.end, ns);
  const [sx, sy] = e.points[0]!;
  const self = e.from === e.to;
  const rightward = !self && (e.points[1]?.[0] ?? sx) >= sx;
  return (
    <g data-edge-id={e.id} style={{ animation: "lc-fade .2s ease-out" }}>
      <path d={e.d} fill="none" stroke={EDGE} strokeWidth={1.6} strokeDasharray={dashed ? "6 5" : undefined}
        strokeLinecap="round" strokeLinejoin="round" markerStart={mark(e.start, ns)} markerEnd={end} />
      {seq && e.step != null && (
        <g transform={`translate(${sx + (rightward ? 14 : -14)}, ${sy})`}>
          <circle r={9} fill="#2563eb" />
          <text textAnchor="middle" dy="3.5" fontSize={10} fontWeight={700} fill="#fff">{e.step}</text>
        </g>
      )}
    </g>
  );
});

/** Edge labels on their own layer above the cards, so a label is never hidden behind a box. */
function EdgeLabels({ layout }: { layout: DiagramLayout }) {
  return (
    <svg width={layout.width} height={layout.height} style={{ position: "absolute", inset: 0, zIndex: 3, overflow: "visible", pointerEvents: "none" }}>
      {layout.edges.filter((e) => e.label).map((e) => {
        const w = Math.min(220, e.label!.length * 6.6 + 16);
        return (
          <g key={e.id} transform={`translate(${e.labelX}, ${e.labelY})`} style={{ animation: "lc-fade .2s ease-out" }}>
            <rect x={-w / 2} y={-10} width={w} height={20} rx={10} fill="#fff" stroke="#e2e8f0" />
            <text textAnchor="middle" dy="4" fontSize={11.5} fill={INK} fontWeight={500} style={{ fontFamily: "inherit" }}>{e.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Suggested columns (ADR 0020): dimmed, dashed rows drawn just BELOW the table as an overlay — outside the
 * layout, so nothing moves when they arrive — each with ✓ / ✕, plus the whole set.
 */
function SuggestedCols({ id, cols, rect }: { id: string; cols: string[]; rect: Rect }) {
  const btn: CSSProperties = { font: "inherit", fontSize: 11, lineHeight: 1, padding: "2px 5px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" };
  return (
    <div data-testid={`suggested-${id}`} style={{ position: "absolute", left: rect.x + 6, top: rect.y + rect.h - 2, width: rect.w - 12, zIndex: 4,
      border: "1.5px dashed #94a3b8", borderTop: "none", borderRadius: "0 0 10px 10px", background: "rgba(248,250,252,.92)", fontFamily: MONO, fontSize: 12 }}>
      {cols.map((c) => {
        const [name, type] = c.split(":");
        return (
          <div key={c} className="lc-suggest-row" style={{ height: 24, display: "flex", alignItems: "center", gap: 6, padding: "0 8px", color: "#64748b", fontStyle: "italic" }}>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>+ {name}</span>
            <span style={{ opacity: 0.7 }}>{type}</span>
            <button type="button" title={`Add ${name}`} style={btn} onClick={() => gateway.send({ type: "suggestion_approve", ids: [id], cols: { [id]: [c] } })}>✓</button>
            <button type="button" title={`Not ${name}`} style={btn} onClick={() => gateway.send({ type: "suggestion_reject", ids: [id], cols: { [id]: [c] } })}>✕</button>
          </div>
        );
      })}
      <div style={{ display: "flex", gap: 6, padding: "4px 8px 6px", fontFamily: "inherit" }}>
        <button type="button" data-testid={`approve-${id}`} style={{ ...btn, fontWeight: 600, color: "#166534" }} onClick={() => gateway.send({ type: "suggestion_approve", ids: [id] })}>✓ Add all</button>
        <button type="button" style={btn} onClick={() => gateway.send({ type: "suggestion_reject", ids: [id] })}>Dismiss</button>
      </div>
    </div>
  );
}

// ── Constraints (ADR 0021) ───────────────────────────────────────────────────────────────────────

/** A component with its load: demand vs capacity as a bar (red at ≥ 80% — a bottleneck), latency as a chip. */
const Gauge = memo(function Gauge({ node, rect, tone }: { node: DesignNode; rect: Rect; tone: Tone }) {
  const Icon = KIND_ICON[String(node.props.kind)] ?? Server;
  const u = utilization(node);
  const hot = u != null && u >= 0.8;
  const unit = String(node.props.unit ?? "req");
  const fmt = (v: unknown) => (typeof v === "number" ? `${fmtRate(v)}/s` : "—");
  return (
    <div data-node-id={node.id} data-type="Node" style={{ display: "contents" }}>
      <div className={inferredCls(node)} style={{ ...cardBase, left: rect.x, top: rect.y, width: rect.w, height: rect.h, padding: "10px 14px",
        border: `1.5px solid ${hot ? "#dc2626" : tone.border}`, display: "flex", flexDirection: "column", gap: 6, animation: "lc-pop .18s ease-out" }}>
        <InferredBadge n={node} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon size={16} color={tone.accent} strokeWidth={2.2} />
          <span style={{ fontSize: 14, fontWeight: 650, color: INK, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(node.props.label)}</span>
          {typeof node.props.latency === "number" && <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 999, background: "#f1f5f9", color: MUTED }}>{node.props.latency} ms</span>}
        </div>
        <div style={{ height: 8, borderRadius: 999, background: "#f1f5f9", overflow: "hidden" }}>
          <div style={{ width: `${Math.min(100, Math.round((u ?? 0) * 100))}%`, height: "100%", background: hot ? "#dc2626" : u != null && u >= 0.6 ? "#d97706" : "#16a34a" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: MUTED }}>
          <span>demand {fmt(node.props.demand)}</span>
          <span style={{ color: hot ? "#dc2626" : MUTED, fontWeight: hot ? 700 : 500 }}>{hot ? `bottleneck · ${Math.round(u! * 100)}%` : `capacity ${fmt(node.props.capacity)}`}</span>
        </div>
        <span style={{ fontSize: 10.5, color: "#94a3b8" }}>{unit}</span>
      </div>
    </div>
  );
});

// ── Cost-value (ADR 0021) ────────────────────────────────────────────────────────────────────────

const QUAD: Record<string, { tint: string; ink: string; hint: string }> = {
  quick: { tint: "#ecfdf5", ink: "#047857", hint: "low cost · high value" },
  big: { tint: "#eff6ff", ink: "#1d4ed8", hint: "high cost · high value" },
  fill: { tint: "#f8fafc", ink: "#475569", hint: "low cost · low value" },
  pit: { tint: "#fef2f2", ink: "#b91c1c", hint: "high cost · low value" },
};
function Quadrants({ layout }: { layout: DiagramLayout }) {
  const [a, , , d] = layout.lanes;
  return (
    <>
      {layout.lanes.map((q) => (
        <div key={q.id} style={{ position: "absolute", left: q.x, top: q.y, width: q.w, height: q.h, background: QUAD[q.tier]?.tint, border: "1px solid #e2e8f0" }}>
          <div style={{ position: "absolute", left: 10, top: 8, fontSize: 12, fontWeight: 700, color: QUAD[q.tier]?.ink }}>{q.label}</div>
          <div style={{ position: "absolute", left: 10, top: 24, fontSize: 10.5, color: MUTED }}>{QUAD[q.tier]?.hint}</div>
        </div>
      ))}
      {a && d && <>
        <div style={{ position: "absolute", left: a.x, top: d.y + d.h + 8, width: a.w * 2, textAlign: "center", fontSize: 11.5, color: MUTED, fontWeight: 600 }}>cost →</div>
        <div style={{ position: "absolute", left: a.x - 30, top: a.y + a.h - 6, transform: "rotate(-90deg)", transformOrigin: "left top", fontSize: 11.5, color: MUTED, fontWeight: 600, whiteSpace: "nowrap" }}>value →</div>
        {Object.keys(layout.nodes).length > 0 && <div style={{ position: "absolute", left: a.x, top: d.y + d.h + 30, fontSize: 11, color: MUTED }}>Not scored yet</div>}
      </>}
    </>
  );
}
const Item = memo(function Item({ node, rect }: { node: DesignNode; rect: Rect }) {
  const scored = typeof node.props.cost === "number" && typeof node.props.value === "number";
  return (
    <div data-node-id={node.id} data-type="Node" style={{ display: "contents" }}>
      <div className={inferredCls(node)} title={scored ? `cost ${node.props.cost}/5 · value ${node.props.value}/5` : "Not scored — say how costly and how valuable it is"}
        style={{ ...cardBase, left: rect.x, top: rect.y, width: rect.w, height: rect.h, padding: "0 10px", display: "flex", alignItems: "center", gap: 6,
          border: `1px ${scored ? "solid" : "dashed"} #cbd5e1`, fontSize: 12.5, fontWeight: 600, color: INK, animation: "lc-pop .18s ease-out" }}>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{String(node.props.label)}</span>
        {scored && <span style={{ fontSize: 10.5, color: MUTED, fontWeight: 500 }}>{String(node.props.cost)}·{String(node.props.value)}</span>}
      </div>
    </div>
  );
});
