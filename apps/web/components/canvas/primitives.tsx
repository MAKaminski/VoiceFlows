"use client";
import { LIGHT_FILLS, type DesignNode, type SCREEN_TYPES } from "@livecanvas/dsl";
import { DynamicIcon, type IconName } from "lucide-react/dynamic";
import type { CSSProperties, ReactNode } from "react";
import { color, radius, space } from "./tokens";

// One renderer per primitive (D5). Renderers read props + token CSS vars only — no raw values.
type P = Record<string, any>;
type Renderer = (props: P, children: ReactNode) => ReactNode;

const flex = (p: P): CSSProperties => ({
  display: "flex",
  flexDirection: p.direction === "row" ? "row" : "column",
  gap: space(p.gap),
  alignItems: ({ start: "flex-start", center: "center", end: "flex-end", stretch: "stretch" } as P)[p.align ?? "stretch"],
  justifyContent: ({ start: "flex-start", center: "center", end: "flex-end", between: "space-between" } as P)[p.justify ?? "start"],
});

const textStyle: Record<string, CSSProperties> = {
  display: { fontSize: 32, fontWeight: 700, lineHeight: 1.15 },
  title: { fontSize: 22, fontWeight: 600, lineHeight: 1.25 },
  body: { fontSize: 15, lineHeight: 1.5 },
  caption: { fontSize: 12, lineHeight: 1.4, opacity: 0.7 },
};

const btnPad = { sm: "6px 10px", md: "10px 16px", lg: "14px 20px" } as const;
const iconPx = { sm: 16, md: 20, lg: 28 } as const;

export const renderers: Record<(typeof SCREEN_TYPES)[number], Renderer> = {
  Frame: (p, c) => (
    <div style={{ ...flex(p), width: p.width, minHeight: p.height, padding: space(p.padding),
      background: color(p.fill, "surface"), color: color("text"), borderRadius: 28,
      boxShadow: "0 20px 50px rgba(15,23,42,.18)", overflow: "hidden" }}>{c}</div>
  ),
  Stack: (p, c) => <div style={flex(p)}>{c}</div>,
  Text: (p) => <div style={{ ...textStyle[p.variant ?? "body"], color: color(p.color) }}>{p.content}</div>,
  Button: (p) => {
    const variant = p.variant ?? "primary";
    const token = p.color ?? (variant === "secondary" ? "secondary" : "primary");
    const tone = color(token);
    return (
      <button type="button" style={{ padding: btnPad[(p.size ?? "md") as keyof typeof btnPad], borderRadius: radius(p.radius),
        font: "inherit", fontWeight: 600, fontSize: p.size === "lg" ? 16 : 14, cursor: "pointer",
        border: variant === "ghost" ? "none" : `1px solid ${tone}`,
        background: variant === "primary" ? tone : "transparent",
        color: variant === "primary" ? color(LIGHT_FILLS.has(token) ? "text" : "surface") : tone }}>{p.label}</button>
    );
  },
  Input: (p) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, fontWeight: 500 }}>
      {p.label}
      <input readOnly type={p.kind ?? "text"} placeholder={p.placeholder}
        style={{ font: "inherit", fontSize: 15, padding: "10px 12px", borderRadius: radius("sm"),
          border: `1px solid ${color("muted")}`, background: color("surface"), outline: "none" }} />
    </label>
  ),
  Image: (p) => {
    const [w, h] = String(p.aspect ?? "16:9").split(":").map(Number);
    return p.src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={p.src} alt={p.alt} style={{ width: "100%", aspectRatio: `${w} / ${h}`, objectFit: "cover", borderRadius: radius(p.radius) }} />
    ) : (
      <div role="img" aria-label={p.alt} style={{ width: "100%", aspectRatio: `${w} / ${h}`, borderRadius: radius(p.radius),
        background: color("muted"), display: "grid", placeItems: "center", fontSize: 13, opacity: 0.8 }}>{p.alt}</div>
    );
  },
  Icon: (p) => <DynamicIcon name={p.name as IconName} size={iconPx[(p.size ?? "md") as keyof typeof iconPx]} color={color(p.color)} />,
  Card: (p, c) => (
    <div style={{ padding: space(p.padding ?? "md"), borderRadius: radius("md"), background: color(p.fill, "surface"),
      border: `1px solid ${color("muted")}`, boxShadow: `0 ${(p.elevation ?? 1) * 2}px ${(p.elevation ?? 1) * 8}px rgba(15,23,42,.08)` }}>{c}</div>
  ),
  List: (p) => (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {(p.items as P[]).map((it, i) => (
        <li key={i} style={{ padding: "10px 0", borderBottom: `1px solid ${color("muted")}` }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{it.title}</div>
          {it.subtitle && <div style={{ fontSize: 12, opacity: 0.7 }}>{it.subtitle}</div>}
        </li>
      ))}
    </ul>
  ),
  Nav: (p) => (
    <nav style={{ display: "flex", justifyContent: "space-around", padding: "10px 0", fontSize: 14, fontWeight: 500,
      borderBottom: p.position === "bottom" ? undefined : `1px solid ${color("muted")}`,
      borderTop: p.position === "bottom" ? `1px solid ${color("muted")}` : undefined }}>
      {(p.items as string[]).map((it, i) => <span key={i} style={{ color: i === 0 ? color("primary") : undefined }}>{it}</span>)}
    </nav>
  ),
  Table: (p) => (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead><tr>{(p.columns as string[]).map((c) => <th key={c} style={{ textAlign: "left", padding: 6, borderBottom: `2px solid ${color("muted")}` }}>{c}</th>)}</tr></thead>
      <tbody>{(p.rows as string[][]).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} style={{ padding: 6, borderBottom: `1px solid ${color("muted")}` }}>{v}</td>)}</tr>)}</tbody>
    </table>
  ),
  Chart: (p) => {
    const s = p.series as number[];
    const max = Math.max(1, ...s), W = 300, H = 120, bw = W / Math.max(1, s.length);
    return (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`${p.kind} chart`}>
        {p.kind === "line" ? (
          <polyline fill="none" stroke={color("primary")} strokeWidth={2.5}
            points={s.map((v, i) => `${i * bw + bw / 2},${H - (v / max) * (H - 8)}`).join(" ")} />
        ) : (
          s.map((v, i) => <rect key={i} x={i * bw + 4} width={bw - 8} y={H - (v / max) * (H - 4)} height={(v / max) * (H - 4)} rx={4} fill={color("primary")} />)
        )}
      </svg>
    );
  },
};

export type { DesignNode };
