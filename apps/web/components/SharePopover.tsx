"use client";
import { gateway } from "@/lib/gateway";
import { useDoc } from "@/store/doc";
import { useFeatures } from "@/store/features";
import { useState, type CSSProperties } from "react";

/**
 * Share (ADR 0013): a public read-only link pinned to the version on screen — later edits (even a new
 * diagram) never change what was shared. One live link per version; revoke kills it on the next view.
 */
const pill = (bg: string, fg = "#fff"): CSSProperties => ({
  font: "inherit", fontWeight: 600, padding: "8px 16px", borderRadius: 999, cursor: "pointer",
  border: "1px solid var(--lc-chrome-border)", background: bg, color: fg,
});
const small: CSSProperties = { font: "inherit", fontSize: 12, fontWeight: 600, padding: "4px 10px", borderRadius: 999, cursor: "pointer", border: "1px solid #cbd5e1", background: "#fff", color: "#0f172a" };

export function SharePopover() {
  const { flags, shares } = useFeatures();
  const version = useDoc((s) => s.version);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  if (!flags.share_links) return null;
  const url = (t: string) => `${location.origin}/s/${t}`;
  const current = shares.find((l) => l.version === version);
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(url(t)); setCopied(t); setTimeout(() => setCopied(null), 1500); } catch {} };

  return (
    <div style={{ position: "relative" }}>
      <button type="button" data-testid="share" style={pill("transparent", "inherit")}
        onClick={() => { setOpen((o) => !o); if (!open && !current) gateway.send({ type: "share_create" }); }}>Share</button>
      {open && (
        <div role="dialog" aria-label="Share" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", zIndex: 20, width: 380, padding: 16, borderRadius: 14,
          background: "#fff", color: "#0f172a", border: "1px solid #e2e8f0", boxShadow: "0 12px 40px rgba(15,23,42,.18)", fontSize: 13 }}>
          <div style={{ fontWeight: 650, marginBottom: 4 }}>Share a read-only link</div>
          <div style={{ opacity: 0.65, marginBottom: 12, lineHeight: 1.4 }}>Anyone with the link sees version {version} as it is now. Later edits don’t change it — share again after editing for a new link.</div>
          {current ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input readOnly value={url(current.token)} data-testid="share-url" onFocus={(e) => e.currentTarget.select()} aria-label="Share link"
                style={{ flex: 1, minWidth: 0, font: "inherit", fontSize: 12, padding: "6px 10px", borderRadius: 8, border: "1px solid #cbd5e1", background: "#f8fafc" }} />
              <button type="button" style={small} onClick={() => copy(current.token)}>{copied === current.token ? "Copied" : "Copy"}</button>
            </div>
          ) : <div style={{ opacity: 0.6 }}>Creating link…</div>}
          {shares.length > 0 && (
            <div style={{ marginTop: 14, borderTop: "1px solid #f1f5f9", paddingTop: 10 }}>
              <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>Live links for this document</div>
              {shares.map((l) => (
                <div key={l.token} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                  <span style={{ flex: 1 }}>Version {l.version}{l.version === version ? " (on screen)" : ""}</span>
                  <a href={url(l.token)} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>Open</a>
                  <button type="button" style={{ ...small, color: "#b91c1c" }} onClick={() => gateway.send({ type: "share_revoke", token: l.token })}>Revoke</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
