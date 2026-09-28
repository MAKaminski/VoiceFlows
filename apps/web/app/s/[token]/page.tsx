"use client";
import { Canvas } from "@/components/canvas/Canvas";
import { ViewGrid } from "@/components/ViewGrid";
import { HTTP_BASE } from "@/lib/gateway";
import { toProject, viewCount, viewDoc, VIEWS, SharedDoc, type DocKind } from "@livecanvas/dsl";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

/** Read-only view of a shared version (ADR 0013) — all four views of the project as tabs (ADR 0016). One GET. */
export default function Shared() {
  const { token } = useParams<{ token: string }>();
  const [tab, setTab] = useState<DocKind | "all" | null>(null);
  const [state, setState] = useState<{ status: "loading" } | { status: "ok"; data: SharedDoc } | { status: "gone" } | { status: "error" }>({ status: "loading" });

  useEffect(() => {
    fetch(`${HTTP_BASE}/share/${encodeURIComponent(token)}`, { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 404) return setState({ status: "gone" });
        const parsed = SharedDoc.safeParse(await r.json());
        setState(parsed.success ? { status: "ok", data: parsed.data } : { status: "error" });
      })
      .catch(() => setState({ status: "error" }));
  }, [token]);

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "12px 24px", borderBottom: "1px solid var(--lc-chrome-border)", display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>LiveCanvas</strong>
        {state.status === "ok" && (() => {
          const p = toProject(state.data.doc);
          const title = p.root.props.title as string | undefined;
          return (
            <>
              <span style={{ fontSize: 13, opacity: 0.7 }}>{title ? `${title} · ` : ""}shared view · version {state.data.version} · {new Date(state.data.updatedAt).toLocaleString()}</span>
              <span role="tablist" style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
                {VIEWS.map((v) => {
                  const n = viewCount(viewDoc(p, v.kind).root);
                  const on = (tab ?? VIEWS.find((x) => viewCount(viewDoc(p, x.kind).root) > 0)?.kind ?? "screen") === v.kind;
                  return (
                    <button key={v.kind} type="button" role="tab" aria-selected={on} disabled={!n} onClick={() => setTab(v.kind)}
                      style={{ font: "inherit", fontSize: 13, fontWeight: 600, padding: "4px 12px", borderRadius: 999, border: "1px solid var(--lc-chrome-border)",
                        cursor: n ? "pointer" : "default", opacity: n ? 1 : 0.4, background: on ? "#0f172a" : "transparent", color: on ? "#fff" : "inherit" }}>
                      {v.label}{n ? <span style={{ marginLeft: 6, fontSize: 11, opacity: 0.65 }}>{n}</span> : null}
                    </button>
                  );
                })}
                <button type="button" role="tab" aria-selected={tab === "all"} data-testid="share-all-views" onClick={() => setTab("all")}
                  style={{ font: "inherit", fontSize: 13, fontWeight: 600, padding: "4px 12px", borderRadius: 999, border: "1px solid var(--lc-chrome-border)", cursor: "pointer",
                    background: tab === "all" ? "#0f172a" : "transparent", color: tab === "all" ? "#fff" : "inherit" }}>All views</button>
              </span>
            </>
          );
        })()}
      </header>
      {state.status === "ok" && (() => {
        const p = toProject(state.data.doc);
        if (tab === "all") return <ViewGrid project={p} active={null} readOnly />;
        const shown = tab ?? VIEWS.find((x) => viewCount(viewDoc(p, x.kind).root) > 0)?.kind ?? "screen";
        return <div style={{ flex: 1 }}><Canvas doc={viewDoc(p, shown)} /></div>;
      })()}
      {state.status !== "ok" && (
        <div style={{ flex: 1, display: "grid", placeItems: "center", padding: 24, textAlign: "center", opacity: 0.75 }}>
          {state.status === "loading" ? "Loading…"
            : state.status === "gone" ? "This link was revoked, or it never existed."
            : "Couldn’t load this link — try again in a moment."}
        </div>
      )}
    </main>
  );
}
