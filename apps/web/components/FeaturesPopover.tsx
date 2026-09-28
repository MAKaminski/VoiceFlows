"use client";
import { useFeatures } from "@/store/features";
import { FEATURES, type FeatureKey } from "@livecanvas/dsl";
import { useState } from "react";

/** Read-only: which features are on right now, and where to change them (ADR 0020). */
export function FeaturesPopover() {
  const { flags } = useFeatures();
  const [open, setOpen] = useState(false);
  const keys = Object.keys(FEATURES) as FeatureKey[];
  const on = keys.filter((k) => flags[k]).length;
  return (
    <span style={{ position: "relative" }}>
      <button type="button" data-testid="features" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ font: "inherit", fontWeight: 600, padding: "8px 14px", borderRadius: 999, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit", cursor: "pointer" }}>
        Features <span style={{ fontSize: 11, opacity: 0.6 }}>{on}/{keys.length}</span>
      </button>
      {open && (
        <div role="dialog" aria-label="Features" style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 380, maxHeight: "70vh", overflow: "auto", zIndex: 40,
          background: "var(--lc-bg, #fff)", color: "inherit", border: "1px solid var(--lc-chrome-border)", borderRadius: 12, padding: 12, boxShadow: "0 12px 40px rgba(15,23,42,.2)", fontSize: 13 }}>
          {keys.map((k) => (
            <div key={k} style={{ display: "flex", gap: 8, padding: "5px 0", alignItems: "baseline" }}>
              <span aria-label={flags[k] ? "on" : "off"} style={{ width: 8, height: 8, borderRadius: 999, flex: "none", background: flags[k] ? "#16a34a" : "#cbd5e1" }} />
              <span style={{ opacity: flags[k] ? 1 : 0.55 }}>{FEATURES[k].description}</span>
            </div>
          ))}
          <a href="/admin" style={{ display: "block", marginTop: 8, fontWeight: 600, color: "#2563eb" }}>Change them, and see who changed what → Admin</a>
        </div>
      )}
    </span>
  );
}
