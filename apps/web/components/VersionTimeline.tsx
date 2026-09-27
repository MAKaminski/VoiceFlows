"use client";
import type { VersionSummary } from "@livecanvas/dsl";
import { gateway } from "@/lib/gateway";
import { useFeatures } from "@/store/features";
import { useEffect, useRef } from "react";

/**
 * Version timeline (ADR 0015): every version of this document, oldest → newest. The path through the
 * version on screen (its ancestors and what redo would reach) is solid; other branches are faded.
 * Click one to jump to it — like undo/redo, and the next edit branches from there.
 */
const KIND = { screen: "Screen", architecture: "Arch", erd: "ERD", sequence: "Seq" } as const;
const time = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");

function change(v: VersionSummary) {
  if (v.parent == null) return "start";
  const parts = [v.added && `+${v.added}`, v.removed && `−${v.removed}`, v.changed && `~${v.changed}`].filter(Boolean);
  return parts.length ? parts.join(" ") : "no change";
}

export function VersionTimeline() {
  const { flags, timeline } = useFeatures();
  const strip = useRef<HTMLDivElement>(null);
  const { current, items, path: solid } = timeline;
  useEffect(() => { strip.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" }); }, [current, items.length]);
  if (!flags.version_timeline || items.length === 0) return null;

  const path = new Set(solid);

  return (
    <div ref={strip} data-testid="timeline" role="list" aria-label="Versions"
      style={{ padding: "6px 24px", display: "flex", gap: 6, overflowX: "auto", borderBottom: "1px solid var(--lc-chrome-border)", fontSize: 12, alignItems: "center" }}>
      <span style={{ opacity: 0.6, flex: "none", marginRight: 4 }}>History</span>
      {items.map((v) => {
        const on = v.version === current, inPath = path.has(v.version);
        return (
          <button key={v.version} type="button" role="listitem" aria-current={on} data-testid={`version-${v.version}`}
            title={`Version ${v.version}${v.parent != null ? ` (from v${v.parent})` : ""} · ${KIND[v.kind]} · ${v.nodes} elements · ${change(v)}${v.at ? ` · ${new Date(v.at).toLocaleString()}` : ""}`}
            onClick={() => !on && gateway.send({ type: "goto_version", version: v.version })}
            style={{
              flex: "none", font: "inherit", fontSize: 12, cursor: on ? "default" : "pointer", borderRadius: 10, padding: "4px 10px",
              display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.25, gap: 1,
              border: on ? "1.5px solid #0f172a" : "1px solid #e2e8f0", background: on ? "#0f172a" : "#fff", color: on ? "#fff" : "#0f172a",
              opacity: inPath || on ? 1 : 0.45,
            }}>
            <span style={{ fontWeight: 650 }}>v{v.version} <span style={{ fontWeight: 500, opacity: 0.7 }}>{KIND[v.kind]}</span></span>
            <span style={{ opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>{change(v)}{v.at ? ` · ${time(v.at)}` : ""}</span>
          </button>
        );
      })}
    </div>
  );
}
