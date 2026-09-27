"use client";
import { Canvas } from "@/components/canvas/Canvas";
import { HTTP_BASE } from "@/lib/gateway";
import { docKind, SharedDoc } from "@livecanvas/dsl";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

/** Read-only view of a shared version (ADR 0013). No gateway socket, no editing — one GET. */
const KIND = { screen: "Screen", architecture: "Architecture diagram", erd: "Entity-relationship diagram", sequence: "Sequence diagram" } as const;

export default function Shared() {
  const { token } = useParams<{ token: string }>();
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
        {state.status === "ok" && (
          <span style={{ fontSize: 13, opacity: 0.7 }}>
            {KIND[docKind(state.data.doc)]} · shared view · version {state.data.version} · {new Date(state.data.updatedAt).toLocaleString()}
          </span>
        )}
      </header>
      {state.status === "ok" && <div style={{ flex: 1 }}><Canvas doc={state.data.doc} /></div>}
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
