"use client";
import { gateway } from "@/lib/gateway";
import { IMPORT_MAX_BYTES, importSummary, parseImport } from "@livecanvas/dsl";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";

/**
 * Bring your systems (ADR 0022): paste or drop what you already have — a SQL schema or pg_dump, a Prisma schema,
 * OpenAPI JSON, a package.json. The preview is parsed here (same parser as the gateway); Apply sends it to the
 * gateway, the doc's only writer, which lands it as one undoable version and scaffolds the other views.
 */
export function ImportDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [result, setResult] = useState<{ summary: string; applied: boolean } | null>(null);
  const preview = useMemo(() => (text.trim() ? parseImport(text) : null), [text]);
  useEffect(() => gateway.on((m) => {
    if (m.type === "import_result") { setResult(m); if (m.applied) setTimeout(onClose, 900); }
    if (m.type === "error" && /Import/.test(m.message)) setResult({ summary: m.message, applied: false });
  }), [onClose]);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > IMPORT_MAX_BYTES) { setResult({ summary: "That file is over 512 KB — paste the schema part", applied: false }); return; }
    setName(f.name); setText(await f.text()); setResult(null);
  };
  const box = { font: "inherit", fontSize: 13, padding: 10, borderRadius: 8, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit" } as const;
  return (
    <div role="dialog" aria-label="Import" data-testid="import-dialog" onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.4)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: "100%", background: "var(--lc-chrome-bg)", color: "var(--lc-chrome-fg)", borderRadius: 16, padding: 20, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <strong>Bring your systems</strong>
          <span style={{ fontSize: 13, opacity: 0.7 }}>SQL schema · pg_dump · Prisma · OpenAPI JSON · package.json</span>
          <button type="button" aria-label="Close" onClick={onClose} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        <textarea data-testid="import-text" value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} rows={12} spellCheck={false}
          placeholder={"create table customers (id uuid primary key, email text);\ncreate table cases (id uuid primary key, customer_id uuid references customers(id));"}
          style={{ ...box, fontFamily: "ui-monospace, monospace", resize: "vertical" }} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input type="file" accept=".sql,.prisma,.json,.txt" onChange={onFile} style={{ fontSize: 13 }} />
          <span data-testid="import-preview" style={{ flex: 1, fontSize: 13, opacity: 0.8 }}>
            {result ? <span style={{ color: result.applied ? "#16a34a" : "#b45309" }}>{result.applied ? "✓ " : ""}{result.summary}</span>
              : text.trim() ? (preview ? `${preview.kind.toUpperCase()}: ${importSummary(preview)}` : "Not recognised yet") : "Nothing is stored beyond what lands in your design."}
          </span>
          <button type="button" data-testid="import-apply" disabled={!preview || text.length > IMPORT_MAX_BYTES}
            onClick={() => gateway.send({ type: "import", text, ...(name ? { name } : {}), ...(preview ? { kind: preview.kind } : {}) })}
            style={{ font: "inherit", fontWeight: 600, padding: "8px 18px", borderRadius: 999, border: "none", background: "#2563eb", color: "#fff", cursor: "pointer", opacity: preview ? 1 : 0.5 }}>Apply</button>
        </div>
      </div>
    </div>
  );
}
