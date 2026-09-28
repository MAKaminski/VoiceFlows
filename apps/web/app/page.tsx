"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

/**
 * The front door (ADR 0021): what LiveCanvas is, a narrated demo anyone can watch, and the invite code that
 * opens the product. Public; the studio, library and admin sit behind the invite gate.
 */
const VIEWS = [
  { name: "Screen", what: "The wireframe people will use", tint: "#eff6ff", ink: "#1d4ed8" },
  { name: "Architecture", what: "Systems, services and how they connect", tint: "#f5f3ff", ink: "#6d28d9" },
  { name: "ERD", what: "The data model — tables, columns, relations", tint: "#ecfdf5", ink: "#047857" },
  { name: "Sequence", what: "Who talks to whom, step by step", tint: "#fffbeb", ink: "#b45309" },
  { name: "Constraints", what: "Rates, capacity, latency — and the bottlenecks", tint: "#fef2f2", ink: "#b91c1c" },
  { name: "Cost-Value", what: "What's worth building first", tint: "#f0fdfa", ink: "#0f766e" },
];

function Enter() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [code, setCode] = useState("");
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true, error: null });
    const r = await fetch("/api/enter", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }).catch(() => null);
    const d = (await r?.json().catch(() => ({}))) as { ok?: boolean; error?: string } | undefined;
    if (r?.ok && d?.ok) router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : "/studio");
    else setState({ busy: false, error: d?.error ?? "Couldn’t check that code — try again" });
  };
  return (
    <form onSubmit={submit} data-testid="invite-form" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
      <label htmlFor="invite" style={{ position: "absolute", left: -9999 }}>Invite code</label>
      <input id="invite" data-testid="invite-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Invite code" autoComplete="off"
        style={{ font: "inherit", fontSize: 16, padding: "12px 16px", borderRadius: 999, border: "1px solid var(--lc-chrome-border)", minWidth: 220, background: "transparent", color: "inherit" }} />
      <button type="submit" disabled={!code.trim() || state.busy}
        style={{ font: "inherit", fontSize: 16, fontWeight: 650, padding: "12px 22px", borderRadius: 999, border: "none", background: "#0f172a", color: "#fff", cursor: "pointer", opacity: code.trim() && !state.busy ? 1 : 0.6 }}>
        {state.busy ? "Checking…" : "Enter the studio"}
      </button>
      {state.error && <span role="alert" data-testid="invite-error" style={{ color: "#dc2626", fontSize: 14, width: "100%" }}>{state.error}</span>}
    </form>
  );
}

export default function Home() {
  return (
    <main style={{ minHeight: "100vh", background: "var(--lc-chrome-bg)", color: "var(--lc-chrome-fg)" }}>
      <header style={{ maxWidth: 1120, margin: "0 auto", padding: "20px 24px", display: "flex", alignItems: "center", gap: 16 }}>
        <strong style={{ fontSize: 18 }}>LiveCanvas</strong>
        <a href="/demo" style={{ marginLeft: "auto", fontWeight: 600, color: "inherit", textDecoration: "none" }}>Demo</a>
        <a href="/studio" style={{ fontWeight: 600, color: "#2563eb", textDecoration: "none" }}>Studio →</a>
      </header>

      <section style={{ maxWidth: 1120, margin: "0 auto", padding: "56px 24px 40px", display: "grid", gap: 24 }}>
        <h1 style={{ fontSize: "clamp(36px, 6vw, 64px)", lineHeight: 1.05, letterSpacing: -1.5, margin: 0, maxWidth: 880 }}>
          Speak a product.<br />Watch it build.
        </h1>
        <p style={{ fontSize: 20, lineHeight: 1.5, margin: 0, maxWidth: 720, opacity: 0.8 }}>
          Describe what you want out loud. LiveCanvas draws the screens, the architecture, the data model, the flows,
          the constraints and the cost-value trade-offs — all at once, while you talk — and writes the PRD as it goes.
        </p>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <a href="/demo" data-testid="watch-demo" style={{ fontSize: 16, fontWeight: 650, padding: "12px 22px", borderRadius: 999, background: "#2563eb", color: "#fff", textDecoration: "none" }}>
            ▶ Watch the demo
          </a>
          <div id="join"><Suspense><Enter /></Suspense></div>
        </div>
      </section>

      <section style={{ maxWidth: 1120, margin: "0 auto", padding: "8px 24px 48px" }}>
        <h2 style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: 1, opacity: 0.6, margin: "0 0 16px" }}>Six views, one conversation</h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
          {VIEWS.map((v) => (
            <div key={v.name} style={{ padding: 20, borderRadius: 16, background: v.tint, color: "#0f172a" }}>
              <div style={{ fontWeight: 700, color: v.ink, marginBottom: 6 }}>{v.name}</div>
              <div style={{ fontSize: 15, lineHeight: 1.45 }}>{v.what}</div>
            </div>
          ))}
        </div>
      </section>

      <section style={{ maxWidth: 1120, margin: "0 auto", padding: "8px 24px 72px", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 24 }}>
        {[
          ["1 · Talk", "“A support app — customers open cases, agents answer them, it runs on Salesforce and Postgres.” No forms, no diagram tools."],
          ["2 · Everything fills in", "Say it once in any view; the others scaffold themselves. Tables get their usual columns, suggested for you to approve."],
          ["3 · Walk away with a PRD", "Screens, systems, data, flows, bottlenecks and priorities — compiled into a product requirements doc you can copy."],
        ].map(([t, d]) => (
          <div key={t}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>{t}</div>
            <div style={{ fontSize: 15, lineHeight: 1.5, opacity: 0.8 }}>{d}</div>
          </div>
        ))}
      </section>
    </main>
  );
}
