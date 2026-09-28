"use client";
import { gateway } from "@/lib/gateway";
import { useFeatures } from "@/store/features";
import type { DocKind } from "@livecanvas/dsl";

/**
 * Implied suggestions for one view (ADR 0020) as chips with ✓ / ✕ — never applied on their own. ERD column
 * suggestions show inside the tables; here they appear as one chip per table. Say “approve” to accept all.
 */
export function SuggestionTray({ view }: { view: DocKind }) {
  const { suggestions, flags } = useFeatures();
  const items = suggestions.filter((s) => s.view === view);
  if (!flags.suggestions || !items.length) return null;
  const chip = { font: "inherit", fontSize: 12, padding: "2px 8px", borderRadius: 999, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" } as const;
  const stop = (e: { stopPropagation(): void }) => e.stopPropagation();
  return (
    <div data-testid={`tray-${view}`} onClick={stop} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", padding: "6px 10px", fontSize: 12,
      borderTop: "1px dashed #cbd5e1", background: "rgba(254,252,232,.7)" }}>
      <span style={{ fontWeight: 650, color: "#92400e" }}>Suggested</span>
      {items.map((s) => (
        <span key={s.id} data-testid={`suggestion-${s.id}`} title={s.source === "model" ? "Suggested by the model" : "Usually belongs here"}
          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 4px 2px 10px", borderRadius: 999, border: "1px dashed #d97706", background: "#fff" }}>
          {s.title}
          <button type="button" aria-label={`Approve ${s.title}`} style={{ ...chip, color: "#166534" }} onClick={() => gateway.send({ type: "suggestion_approve", ids: [s.id] })}>✓</button>
          <button type="button" aria-label={`Reject ${s.title}`} style={chip} onClick={() => gateway.send({ type: "suggestion_reject", ids: [s.id] })}>✕</button>
        </span>
      ))}
      <span style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
        <button type="button" data-testid={`approve-all-${view}`} style={{ ...chip, fontWeight: 600, color: "#166534" }} onClick={() => gateway.send({ type: "suggestion_approve", ids: items.map((s) => s.id) })}>Approve all</button>
        <button type="button" style={chip} onClick={() => gateway.send({ type: "suggestion_reject", ids: items.map((s) => s.id) })}>Reject all</button>
      </span>
    </div>
  );
}
