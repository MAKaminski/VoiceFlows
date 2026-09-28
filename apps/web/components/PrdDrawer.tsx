"use client";
import { gateway } from "@/lib/gateway";
import { compilePrd, prdCoverage, type DesignDoc } from "@livecanvas/dsl";
import { useMemo, type ReactNode } from "react";

/** Minimal markdown for the PRD: headings, bullets, numbered lines, **bold**, _italic_. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|(?<!\w)_[^_]+_(?!\w))/g).map((part, i) =>
    part.startsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : part.startsWith("_") && part.endsWith("_") && part.length > 2 ? <em key={i} style={{ opacity: 0.7 }}>{part.slice(1, -1)}</em> : part);
}
export function Markdown({ md }: { md: string }) {
  return (
    <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
      {md.split("\n").map((line, i) => {
        if (line.startsWith("# ")) return <h1 key={i} style={{ fontSize: 18, margin: "0 0 10px" }}>{inline(line.slice(2))}</h1>;
        if (line.startsWith("## ")) return <h2 key={i} style={{ fontSize: 14, margin: "16px 0 6px", textTransform: "uppercase", letterSpacing: 0.4, opacity: 0.75 }}>{inline(line.slice(3))}</h2>;
        if (line.startsWith("- ")) return <div key={i} style={{ paddingLeft: 14, textIndent: -10 }}>• {inline(line.slice(2))}</div>;
        if (/^\d+\. /.test(line)) return <div key={i} style={{ paddingLeft: 14 }}>{inline(line)}</div>;
        return line ? <p key={i} style={{ margin: "4px 0" }}>{inline(line)}</p> : <div key={i} style={{ height: 4 }} />;
      })}
    </div>
  );
}

/**
 * The PRD (ADR 0021), compiled live from the six views — the same words the design says, never paraphrased.
 * Copy / download as Markdown.
 */
export function PrdDrawer({ project, onClose, standalone }: { project: DesignDoc; onClose: () => void; standalone?: boolean }) {
  const md = useMemo(() => compilePrd(project), [project]);
  const cover = prdCoverage(project);
  const download = () => {
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `${String(project.root.props.title ?? "product").replace(/[^\w-]+/g, "-")}-PRD.md` });
    a.click(); URL.revokeObjectURL(url);
    if (!standalone) gateway.send({ type: "ui_event", feature: "prd_view", action: "used" });
  };
  const copy = async () => { await navigator.clipboard.writeText(md).catch(() => {}); if (!standalone) gateway.send({ type: "ui_event", feature: "prd_view", action: "used" }); };
  const btn = { font: "inherit", fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: 999, border: "1px solid var(--lc-chrome-border)", background: "transparent", color: "inherit", cursor: "pointer" } as const;
  return (
    <aside data-testid="prd-drawer" aria-label="Product requirements" style={{ width: 420, maxWidth: "100%", flex: "none", borderLeft: "1px solid var(--lc-chrome-border)", display: "flex", flexDirection: "column", minHeight: 0, background: "var(--lc-chrome-bg)" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 14px", borderBottom: "1px solid var(--lc-chrome-border)" }}>
        <strong style={{ fontSize: 14 }}>PRD</strong>
        <span title="Share of the six views with content" style={{ flex: 1, height: 6, borderRadius: 999, background: "var(--lc-chrome-border)", overflow: "hidden" }}>
          <span style={{ display: "block", width: `${Math.round(cover * 100)}%`, height: "100%", background: "#2563eb", transition: "width .3s" }} />
        </span>
        <button type="button" style={btn} onClick={copy}>Copy</button>
        <button type="button" style={btn} onClick={download}>.md</button>
        {!standalone && <button type="button" aria-label="Close PRD" style={{ ...btn, border: "none" }} onClick={onClose}>×</button>}
      </div>
      <div style={{ padding: 16, overflow: "auto", flex: 1 }}><Markdown md={md} /></div>
    </aside>
  );
}
