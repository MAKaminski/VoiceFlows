"use client";
import { gateway, HTTP_BASE } from "@/lib/gateway";
import { authedFetch } from "@/lib/access";
import { VIEWS } from "@livecanvas/dsl";
import { useEffect, useState } from "react";

interface Row { id: string; title: string; updatedAt: string; counts: Record<string, number> }

/**
 * The shared workspace list of saved projects (ADR 0020). Opening one reconnects this tab to it; if someone
 * is editing it right now, it opens read-only instead. Remove = archive (reversible from “Archived”).
 */
export function ProjectsModal({ onClose, currentId }: { onClose: () => void; currentId?: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setRows(null);
    authedFetch(`${HTTP_BASE}/projects${archived ? "?archived=1" : ""}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { projects: Row[] }) => setRows(d.projects), (e: Error) => setError(e.message));
  };
  useEffect(load, [archived]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (id: string, to: "archive" | "restore") => { await authedFetch(`${HTTP_BASE}/projects/${id}/${to}`, { method: "POST" }); load(); };
  const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  return (
    <div role="dialog" aria-modal="true" aria-label="Projects" data-testid="projects-modal" onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.35)", display: "grid", placeItems: "center", zIndex: 50 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(720px, calc(100vw - 32px))", maxHeight: "80vh", overflow: "auto", background: "var(--lc-bg, #fff)", color: "inherit", borderRadius: 16, padding: 20, boxShadow: "0 20px 60px rgba(15,23,42,.3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          <strong style={{ fontSize: 18 }}>Projects</strong>
          <span style={{ fontSize: 12, opacity: 0.6 }}>Shared workspace — everyone with the link sees saved projects</span>
          <label style={{ marginLeft: "auto", fontSize: 13, display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Archived
          </label>
          <button type="button" onClick={onClose} aria-label="Close" style={{ font: "inherit", border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: "inherit" }}>×</button>
        </div>
        {error && <p style={{ color: "#dc2626" }}>Couldn’t load projects ({error}).</p>}
        {!rows && !error && <p style={{ opacity: 0.6 }}>Loading…</p>}
        {rows && !rows.length && <p style={{ opacity: 0.6 }}>{archived ? "Nothing archived." : "No saved projects yet — press Save or say “save the project”."}</p>}
        {rows?.map((r) => (
          <div key={r.id} data-testid={`project-${r.id}`} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 4px", borderTop: "1px solid var(--lc-chrome-border)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}{r.id === currentId && <span style={{ fontSize: 11, marginLeft: 8, opacity: 0.6 }}>(open here)</span>}</div>
              <div style={{ fontSize: 12, opacity: 0.65 }}>
                Edited {when(r.updatedAt)} · {VIEWS.map((v) => `${v.label} ${r.counts[v.kind] ?? 0}`).join(" · ")}
              </div>
            </div>
            {!archived && r.id !== currentId && <button type="button" data-testid={`open-${r.id}`} onClick={() => gateway.openDocument(r.id)} style={{ font: "inherit", fontWeight: 600, padding: "6px 14px", borderRadius: 999, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer" }}>Open</button>}
            <button type="button" onClick={() => toggle(r.id, archived ? "restore" : "archive")} style={{ font: "inherit", padding: "6px 12px", borderRadius: 999, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit", cursor: "pointer" }}>
              {archived ? "Restore" : "Remove"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
