"use client";
import { layoutDiagram, type DesignDoc, type DesignNode, type DiagramLayout, type EdgeRoute, type Rect } from "@livecanvas/dsl";
import {
  Boxes, Cloud, Cog, Database, Globe, HardDrive, KeyRound, Layers, Link2, Monitor, Network, Server, Table2, User, Zap, type LucideIcon,
} from "lucide-react";
import { memo, useMemo, type CSSProperties } from "react";

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

const INK = "#0f172a", MUTED = "#64748b", LINE = "#94a3b8", EDGE = "#475569";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export function DiagramCanvas({ doc }: { doc: DesignDoc }) {
  const layout = useMemo(() => layoutDiagram(doc), [doc]);
  if (!layout) return null;
  const byId = new Map<string, DesignNode>();
  const walk = (n: DesignNode) => { byId.set(n.id, n); n.children?.forEach(walk); };
  walk(doc.root);
  const title = doc.root.props.title as string | undefined;
  const empty = !Object.keys(layout.nodes).length;

  return (
    <div data-node-id="n_root" data-type="Diagram" style={{ display: "contents" }}>
      <div style={{
        position: "relative", width: layout.width, height: layout.height, flex: "none",
        background: "#fff", borderRadius: 20, boxShadow: "0 1px 2px rgba(15,23,42,.06), 0 20px 50px rgba(15,23,42,.12)",
        backgroundImage: "radial-gradient(#e2e8f0 1px, transparent 1px)", backgroundSize: "18px 18px",
        color: INK, fontFamily: "inherit",
      }}>
        {title && <div style={{ position: "absolute", left: 24, top: -34, fontSize: 18, fontWeight: 650, letterSpacing: -0.2 }}>{title}</div>}
        {layout.lanes.map((l) => <Lane key={l.id} lane={l} count={byId.get(l.id)?.children?.length ?? 0} />)}
        <Edges layout={layout} />
        {Object.entries(layout.nodes).map(([id, r]) => {
          const n = byId.get(id);
          if (!n) return null;
          return layout.kind === "erd" ? <Entity key={id} node={n} rect={r} /> : <Box key={id} node={n} rect={r} tone={toneFor(n, byId, doc)} />;
        })}
        {empty && layout.kind !== "architecture" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: MUTED, fontSize: 14 }}>
            {layout.kind === "erd" ? "Name your tables — “users, orders, products…”" : "Name who talks — “the user, the web app, the API…”"}
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
  const tech = node.props.tech as string | undefined;
  return (
    <div data-node-id={node.id} data-type="Node" style={{ display: "contents" }}>
      <div className={node.provisional ? "lc-provisional" : undefined} style={{ ...cardBase, left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        border: `1px solid ${tone.border}`, display: "flex", alignItems: "center", gap: 12, padding: "0 14px", ...(node.provisional ? {} : { animation: "lc-pop .18s ease-out" }) }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, background: tone.tint, display: "grid", placeItems: "center", flex: "none" }}>
          <Icon size={18} color={tone.accent} strokeWidth={2.2} />
        </span>
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, lineHeight: 1.25 }}>
          <span style={{ fontSize: 14, fontWeight: 650, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{String(node.props.label)}</span>
          {tech && <span style={{ fontSize: 12, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{tech}</span>}
        </span>
      </div>
    </div>
  );
});

const Entity = memo(function Entity({ node, rect }: { node: DesignNode; rect: Rect }) {
  const t = TONES.data!;
  const cols = ((node.props.cols as string[] | undefined) ?? []).map((c) => c.split(":"));
  return (
    <div data-node-id={node.id} data-type="Node" style={{ display: "contents" }}>
      <div className={node.provisional ? "lc-provisional" : undefined} style={{ ...cardBase, left: rect.x, top: rect.y, width: rect.w, height: rect.h,
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

function Edges({ layout }: { layout: DiagramLayout }) {
  return (
    <svg width={layout.width} height={layout.height} style={{ position: "absolute", inset: 0, zIndex: 1, overflow: "visible", pointerEvents: "none" }}>
      <defs>
        <marker id="lc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={EDGE} />
        </marker>
        <marker id="lc-arrow-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
          <path d="M1,1 L9,5 L1,9" fill="none" stroke={EDGE} strokeWidth="1.6" />
        </marker>
        <marker id="lc-one" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
          <path d="M9,2 V14 M13,2 V14" stroke={EDGE} strokeWidth="1.6" />
        </marker>
        <marker id="lc-many" viewBox="0 0 16 16" refX="15" refY="8" markerWidth="16" markerHeight="16" orient="auto-start-reverse">
          <path d="M15,1 L5,8 L15,15 M15,8 H3 M5,2 V14" fill="none" stroke={EDGE} strokeWidth="1.6" />
        </marker>
      </defs>
      {layout.lifelines.map((l) => <line key={l.id} x1={l.x} x2={l.x} y1={l.y1} y2={l.y2} stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="5 5" />)}
      {layout.edges.map((e) => <EdgePath key={e.id} e={e} seq={layout.kind === "sequence"} />)}
    </svg>
  );
}

const MARK: Record<string, string | undefined> = { arrow: "url(#lc-arrow)", one: "url(#lc-one)", many: "url(#lc-many)", none: undefined };

const EdgePath = memo(function EdgePath({ e, seq }: { e: EdgeRoute; seq: boolean }) {
  const dashed = e.style !== "sync";
  const end = e.end === "arrow" && e.style === "async" ? "url(#lc-arrow-open)" : MARK[e.end];
  const labelW = e.label ? Math.min(220, e.label.length * 6.6 + 16) : 0;
  const [sx, sy] = e.points[0]!;
  const self = e.from === e.to;
  const rightward = !self && (e.points[1]?.[0] ?? sx) >= sx;
  return (
    <g data-edge-id={e.id} style={{ animation: "lc-fade .2s ease-out" }}>
      <path d={e.d} fill="none" stroke={EDGE} strokeWidth={1.6} strokeDasharray={dashed ? "6 5" : undefined}
        strokeLinecap="round" strokeLinejoin="round" markerStart={MARK[e.start]} markerEnd={end} />
      {e.label && (
        <g transform={`translate(${e.labelX}, ${e.labelY})`}>
          <rect x={-labelW / 2} y={-10} width={labelW} height={20} rx={10} fill="#fff" stroke="#e2e8f0" />
          <text textAnchor="middle" dy="4" fontSize={11.5} fill={INK} fontWeight={500} style={{ fontFamily: "inherit" }}>{e.label}</text>
        </g>
      )}
      {seq && e.step != null && (
        <g transform={`translate(${sx + (rightward ? 14 : -14)}, ${sy})`}>
          <circle r={9} fill="#2563eb" />
          <text textAnchor="middle" dy="3.5" fontSize={10} fontWeight={700} fill="#fff">{e.step}</text>
        </g>
      )}
    </g>
  );
});
