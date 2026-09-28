"use client";
import { gateway } from "@/lib/gateway";
import { zip } from "@/lib/zip";
import { useFeatures } from "@/store/features";
import { generateProject, WORKERS, type CodeFile, type DesignDoc } from "@livecanvas/dsl";
import { useEffect, useMemo, useState } from "react";

/** Mirrors the gateway's FILLABLE: only generated source files are worth an AI worker (ADR 0022). */
const FILLABLE = /^apps\/(api\/src\/(routes|clients)\/[a-z0-9_-]+\.ts|web\/app\/page\.tsx)$/;
type Fill = { status: "writing" | "done" | "failed"; worker: number; content?: string; error?: string };

/**
 * Build it (ADR 0022): the six views → a starter codebase, generated right here in the browser by one worker per
 * part (database, contracts, API, web, infra, load test, PRD & backlog, README) — $0, instant, regenerated as the
 * design changes. "AI fill" sends the source skeletons to the gateway's Haiku workers; each file that comes back
 * valid replaces its skeleton (labelled, and the skeleton stays one click away).
 */
export function BuildDrawer({ project, onClose, demo }: { project: DesignDoc; onClose: () => void; demo?: boolean }) {
  const { flags } = useFeatures();
  const files = useMemo(() => generateProject(project), [project]);
  const [sel, setSel] = useState<string>("README.md");
  const [fills, setFills] = useState<Record<string, Fill>>({});
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [run, setRun] = useState<{ state: "idle" | "running" | "done"; note?: string }>({ state: "idle" });

  useEffect(() => gateway.on((m) => {
    if (m.type === "fill_file") setFills((f) => ({ ...f, [m.path]: { status: m.status, worker: m.worker, content: m.content, error: m.error } }));
    if (m.type === "fill_done") setRun({ state: "done", note: `${m.filled} filled · ${m.failed} kept as skeleton · $${m.usd.toFixed(3)} · ${(m.ms / 1000).toFixed(1)} s` });
    if (m.type === "error" && /AI fill/.test(m.message)) setRun({ state: "idle", note: m.message });
  }), []);

  const final = (f: CodeFile) => (fills[f.path]?.status === "done" && fills[f.path]!.content ? fills[f.path]!.content! : f.content);
  const current = files.find((f) => f.path === sel) ?? files[0]!;
  const fillable = files.filter((f) => FILLABLE.test(f.path)).slice(0, 12);
  const download = () => {
    const data = zip(files.map((f) => ({ path: f.path, content: final(f) })));
    const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
    const name = `${String(project.root.props.title ?? "livecanvas-app").trim().replace(/[^\w-]+/g, "-") || "livecanvas-app"}.zip`;
    Object.assign(document.createElement("a"), { href: url, download: name }).click();
    URL.revokeObjectURL(url);
    if (!demo) gateway.send({ type: "ui_event", feature: "code_scaffold", action: "used" });
  };
  const fill = () => {
    setFills({});
    setRun({ state: "running" });
    gateway.send({ type: "fill", files: fillable.map((f) => ({ path: f.path, content: f.content.slice(0, 16_384) })) });
  };
  const btn = { font: "inherit", fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 999, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit", cursor: "pointer" } as const;
  const chip = (p: string) => {
    const f = fills[p];
    if (!f) return null;
    const c = f.status === "done" ? "#16a34a" : f.status === "failed" ? "#b45309" : "#2563eb";
    return <span title={f.error ?? `worker ${f.worker}`} style={{ fontSize: 10, fontWeight: 700, color: c }}>{f.status === "writing" ? `w${f.worker}…` : f.status === "done" ? "AI" : "kept"}</span>;
  };
  const shown = showSkeleton || fills[current.path]?.status !== "done" ? current.content : final(current);

  return (
    <aside data-testid="build-drawer" aria-label="Build it" style={{ width: 560, maxWidth: "100%", flex: "none", borderLeft: "1px solid var(--lc-chrome-border)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--lc-chrome-bg)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--lc-chrome-border)", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 14 }}>Build it</strong>
        <span style={{ fontSize: 12, opacity: 0.65 }}>{files.length} files · {WORKERS.length} workers</span>
        <span style={{ flex: 1 }} />
        {!demo && flags.code_scaffold_model && (
          <button type="button" data-testid="build-fill" style={btn} disabled={run.state === "running"} onClick={fill}
            title={`Up to ${fillable.length} files, 4 workers at a time, ≤ $0.15`}>{run.state === "running" ? "Workers writing…" : "✨ AI fill"}</button>
        )}
        <button type="button" data-testid="build-download" style={{ ...btn, background: "#0f172a", color: "#fff", border: "none" }} onClick={download}>Download .zip</button>
        <button type="button" aria-label="Close build" style={{ ...btn, border: "none" }} onClick={onClose}>×</button>
      </div>
      {run.note && <div data-testid="build-note" style={{ padding: "6px 14px", fontSize: 12, opacity: 0.8, borderBottom: "1px solid var(--lc-chrome-border)" }}>{run.note}</div>}
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <nav aria-label="Files" style={{ width: 210, flex: "none", overflow: "auto", borderRight: "1px solid var(--lc-chrome-border)", padding: "6px 0" }}>
          {WORKERS.map((w) => {
            const mine = files.filter((f) => f.worker === w.id);
            if (!mine.length) return null;
            return (
              <div key={w.id} style={{ padding: "4px 0" }}>
                <div style={{ padding: "2px 12px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, opacity: 0.55 }}>{w.label}</div>
                {mine.map((f) => (
                  <button key={f.path} type="button" onClick={() => setSel(f.path)} data-testid={`file-${f.path}`}
                    style={{ display: "flex", gap: 6, width: "100%", textAlign: "left", font: "inherit", fontSize: 12, padding: "3px 12px", border: "none", cursor: "pointer", color: "inherit", background: f.path === current.path ? "rgba(37,99,235,.12)" : "transparent" }}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.path.split("/").slice(-2).join("/")}</span>{chip(f.path)}
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 12px", fontSize: 12, borderBottom: "1px solid var(--lc-chrome-border)" }}>
            <code style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{current.path}</code>
            {fills[current.path]?.status === "done" && (
              <label style={{ display: "flex", gap: 4, alignItems: "center", color: "#b45309" }} title="Written by an AI worker and checked only for exports and balanced braces — review it">
                AI-written, unverified <input type="checkbox" checked={showSkeleton} onChange={(e) => setShowSkeleton(e.target.checked)} /> skeleton
              </label>
            )}
          </div>
          <pre data-testid="build-preview" style={{ margin: 0, padding: 12, overflow: "auto", flex: 1, fontSize: 12, lineHeight: 1.5 }}><code>{shown}</code></pre>
        </div>
      </div>
    </aside>
  );
}
