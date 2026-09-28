import { VIEWS, viewDoc, type DesignDoc, type DesignNode, type DocKind } from "./doc.js";
import { utilization } from "./layout.js";

/**
 * The PRD (ADR 0021): a product requirements document compiled from the six views — deterministic, $0,
 * recompiled on every version, so it is always exactly what the design says (no model paraphrase). Sections
 * for empty views become "Open questions", which is what a PRD review would ask anyway.
 */
type N = DesignNode;
const all = (n: N, out: N[] = []): N[] => { out.push(n); n.children?.forEach((c) => all(c, out)); return out; };
const label = (n: N) => String(n.props.label ?? n.props.content ?? "");
const byId = (root: N) => new Map(all(root).map((n) => [n.id, n]));
const inferredTag = (n: N) => (n.inferred ? " _(inferred)_" : "");

export function compilePrd(project: DesignDoc): string {
  const v = (k: DocKind) => viewDoc(project, k).root;
  const props = project.root.props as { title?: string; notes?: string };
  const title = props.title?.trim() || "Untitled product";
  const out: string[] = [`# ${title} — Product requirements`, ""];
  const open: string[] = [];

  out.push("## Overview", props.notes?.trim() || "_Say what you're building and for whom — it becomes this overview._", "");

  // Users & screens
  const screen = v("screen");
  const elements = all(screen).slice(1);
  if (elements.length) {
    const screenTitle = elements.find((n) => n.type === "Text" && (n.props.variant === "title" || n.props.variant === "display"));
    out.push("## Users & screens", `**${screenTitle ? label(screenTitle) : "Main screen"}**`);
    for (const n of elements) {
      if (n === screenTitle || n.type === "Card" || n.type === "Stack") continue;
      const p = n.props;
      const what = n.type === "Input" ? `${label(n) || "Field"} (${p.kind ?? "text"} field)` : n.type === "Button" ? `“${label(n)}” button` : n.type === "Image" ? `${p.alt ?? "Image"}` : `${n.type}: ${label(n) || "—"}`;
      out.push(`- ${what}`);
    }
    out.push("");
  } else open.push("Which screens do users see first?");

  // Architecture
  const arch = v("architecture");
  const archNodes = all(arch).filter((n) => n.type === "Node");
  if (archNodes.length) {
    out.push("## Architecture");
    for (const lane of (arch.children ?? []).filter((c) => c.type === "Layer" && c.children?.length)) {
      out.push(`- **${String(lane.props.label ?? lane.props.tier)}:** ${lane.children!.map((n) => `${label(n)}${n.props.tech && n.props.tech !== label(n) ? ` (${n.props.tech})` : ""}${n.props.owner ? ` — owned by ${n.props.owner}` : ""}${inferredTag(n)}`).join(", ")}`);
    }
    const ids = byId(arch);
    const edges = all(arch).filter((n) => n.type === "Edge");
    if (edges.length) {
      out.push("", "Integrations:");
      for (const e of edges) out.push(`- ${label(ids.get(String(e.props.from))!)} → ${label(ids.get(String(e.props.to))!)}${e.props.label ? `: ${e.props.label}` : ""}${e.props.style === "async" ? " (async)" : ""}`);
    }
    out.push("");
  } else open.push("Which systems and services does it need?");

  // Data model
  const erd = v("erd");
  const tables = all(erd).filter((n) => n.type === "Node");
  if (tables.length) {
    out.push("## Data model");
    for (const t of tables) {
      const cols = ((t.props.cols as string[] | undefined) ?? []).map((c) => c.split(":")[0]).filter((c) => c !== "id");
      out.push(`- **${label(t)}**${cols.length ? `: ${cols.join(", ")}` : ""}${inferredTag(t)}`);
    }
    const ids = byId(erd);
    for (const e of all(erd).filter((n) => n.type === "Edge")) {
      const card = String(e.props.card ?? "1:n");
      out.push(`- ${label(ids.get(String(e.props.from))!)} ${card === "1:1" ? "has one" : card === "n:n" ? "many-to-many with" : "has many"} ${label(ids.get(String(e.props.to))!)}`);
    }
    out.push("");
  } else open.push("What data does it store?");

  // Key flows
  const seq = v("sequence");
  const msgs = all(seq).filter((n) => n.type === "Edge");
  if (msgs.length) {
    const ids = byId(seq);
    out.push("## Key flows");
    msgs.forEach((m, i) => out.push(`${i + 1}. ${label(ids.get(String(m.props.from))!)} → ${label(ids.get(String(m.props.to))!)}: ${m.props.label ?? "message"}${m.props.style === "return" ? " (reply)" : m.props.style === "async" ? " (async)" : ""}`));
    out.push("");
  } else open.push("What happens, step by step, when a user does the main thing?");

  // Constraints
  const con = all(v("constraints")).filter((n) => n.type === "Node");
  const measured = con.filter((n) => n.props.demand != null || n.props.capacity != null || n.props.latency != null);
  if (measured.length) {
    out.push("## Constraints & bottlenecks");
    for (const n of measured) {
      const u = utilization(n);
      const parts = [n.props.demand != null ? `peak ${n.props.demand}/s` : "", n.props.capacity != null ? `capacity ${n.props.capacity}/s` : "", n.props.latency != null ? `p50 ${n.props.latency} ms` : ""].filter(Boolean);
      out.push(`- **${label(n)}**${n.props.unit ? ` (${n.props.unit})` : ""}: ${parts.join(" · ")}${u != null && u >= 0.8 ? ` — **bottleneck at ${Math.round(u * 100)}% of capacity**` : ""}`);
    }
    out.push("");
  } else open.push("What load must it handle, and where are the limits?");

  // Cost-value
  const items = all(v("cva")).filter((n) => n.type === "Node");
  const scored = items.filter((n) => typeof n.props.cost === "number" && typeof n.props.value === "number");
  if (scored.length) {
    const quad = (n: N) => { const c = Number(n.props.cost), val = Number(n.props.value); return val >= 3 ? (c <= 2 ? "Quick wins" : "Big bets") : (c <= 2 ? "Fill-ins" : "Money pits"); };
    out.push("## Cost-value priorities");
    for (const q of ["Quick wins", "Big bets", "Fill-ins", "Money pits"]) {
      const inQ = scored.filter((n) => quad(n) === q);
      if (inQ.length) out.push(`- **${q}:** ${inQ.map((n) => `${label(n)} (cost ${n.props.cost}, value ${n.props.value})`).join(", ")}`);
    }
    const unscored = items.filter((n) => !scored.includes(n));
    if (unscored.length) out.push(`- _Not scored yet:_ ${unscored.map(label).join(", ")}`);
    out.push("");
  } else open.push("Which features are worth their cost?");

  if (open.length) out.push("## Open questions", ...open.map((q) => `- ${q}`), "");
  return out.join("\n").trim() + "\n";
}

/** How complete the PRD is: the share of the six views with content (for the drawer's progress bar). */
export const prdCoverage = (project: DesignDoc) =>
  VIEWS.filter((x) => all(viewDoc(project, x.kind).root).length > (x.kind === "architecture" ? 5 : 1)).length / VIEWS.length;
