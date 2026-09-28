"use client";
import { Canvas } from "@/components/canvas/Canvas";
import { SuggestionTray } from "@/components/SuggestionTray";
import { gateway } from "@/lib/gateway";
import { useFeatures } from "@/store/features";
import { kindFeature, viewCount, VIEWS, type DesignDoc, type DesignNode, type DocKind } from "@livecanvas/dsl";
import { memo, useMemo } from "react";

/**
 * All four views at once (ADR 0020): Screen · Architecture on top, ERD · Sequence below, each scaled to fit
 * and updating live. Clicking a cell makes it the one you speak to (naming a view by voice moves it too).
 */
export function ViewGrid({ project, active, readOnly }: { project: DesignDoc; active: DocKind | null; readOnly?: boolean }) {
  const { flags } = useFeatures();
  const shown = VIEWS.filter((v) => v.kind === "screen" || !flags.projects || flags[kindFeature(v.kind)]);
  return (
    <div data-testid="view-grid" style={{ flex: 1, minHeight: "calc(100vh - 190px)", display: "grid", gridTemplateColumns: `repeat(${shown.length > 4 ? 3 : 2}, 1fr)`, gridTemplateRows: `repeat(${Math.ceil(shown.length / (shown.length > 4 ? 3 : 2))}, 1fr)`, gap: 12, padding: 12 }}>
      {shown.map((v) => (
        <Cell key={v.kind} kind={v.kind} label={v.label} root={project.root.children?.[VIEWS.indexOf(v)]} project={project}
          active={active === v.kind} readOnly={!!readOnly} />
      ))}
    </div>
  );
}

const Cell = memo(function Cell({ kind, label, root, project, active, readOnly }: { kind: DocKind; label: string; root?: DesignNode; project: DesignDoc; active: boolean; readOnly: boolean }) {
  // Keyed on the view root: an edit in another view leaves this root `===`, so this cell doesn't re-render.
  const doc = useMemo(() => (root ? { ...project, root } : null), [root]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!doc) return null;
  const n = viewCount(doc.root);
  return (
    <section data-testid={`cell-${kind}`} aria-label={label} onClick={() => !readOnly && !active && gateway.send({ type: "set_view", view: kind })}
      style={{ position: "relative", minHeight: 0, minWidth: 0, display: "flex", flexDirection: "column", borderRadius: 16, overflow: "hidden",
        border: active ? "2px solid #2563eb" : "1px solid var(--lc-chrome-border)", background: "var(--lc-cell-bg, rgba(248,250,252,.6))",
        cursor: readOnly || active ? "default" : "pointer", boxShadow: active ? "0 0 0 4px rgba(37,99,235,.12)" : undefined }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 13, fontWeight: 650, borderBottom: "1px solid var(--lc-chrome-border)" }}>
        <span>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 500, opacity: 0.6 }}>{n ? `${n} element${n === 1 ? "" : "s"}` : "empty"}</span>
        {active && !readOnly && <span style={{ marginLeft: "auto", fontSize: 11, color: "#2563eb" }}>🎙 focus: {label}</span>}
      </header>
      <div style={{ flex: 1, minHeight: 0 }}><Canvas doc={doc} fit /></div>
      {!readOnly && <SuggestionTray view={kind} />}
    </section>
  );
});
