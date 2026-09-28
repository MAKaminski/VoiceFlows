"use client";
import { ViewGrid } from "@/components/ViewGrid";
import { gateway, HTTP_BASE } from "@/lib/gateway";
import { DesignDocSchema, toProject, type DesignDoc } from "@livecanvas/dsl";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Read-only view of a saved project (ADR 0020) — offered when someone else is editing it right now, so opening
 * from the library never kicks them out. All four views at once; refresh to see their latest.
 */
export default function ReadOnlyProject() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ status: "loading" } | { status: "ok"; doc: DesignDoc; title: string; updatedAt: string } | { status: "gone" }>({ status: "loading" });
  useEffect(() => {
    fetch(`${HTTP_BASE}/projects/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return setState({ status: "gone" });
        const d = await r.json();
        const doc = DesignDocSchema.safeParse(d.doc);
        setState(doc.success ? { status: "ok", doc: toProject(doc.data), title: d.title, updatedAt: d.updatedAt } : { status: "gone" });
      })
      .catch(() => setState({ status: "gone" }));
  }, [id]);
  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--lc-chrome-border)", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong>LiveCanvas</strong>
        {state.status === "ok" && <span style={{ fontSize: 13, opacity: 0.7 }}>{state.title} · read-only (being edited elsewhere) · {new Date(state.updatedAt).toLocaleString()}</span>}
        <button type="button" onClick={() => location.reload()} style={{ marginLeft: "auto", font: "inherit", fontWeight: 600, padding: "6px 14px", borderRadius: 999, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit", cursor: "pointer" }}>Refresh</button>
        <button type="button" onClick={() => gateway.openDocument(id)} style={{ font: "inherit", fontWeight: 600, padding: "6px 14px", borderRadius: 999, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer" }}>Try editing again</button>
      </header>
      {state.status === "ok" ? <ViewGrid project={state.doc} active={null} readOnly /> : (
        <div style={{ flex: 1, display: "grid", placeItems: "center", opacity: 0.75 }}>{state.status === "loading" ? "Loading…" : "This project isn’t in the shared list (removed, or never saved)."}</div>
      )}
    </main>
  );
}
