import { viewDoc, type DesignDoc, type DesignNode } from "../../packages/dsl/src/index.js";
import type { CorpusCase, View } from "./cases.js";

/** Loose text match for diagram labels and screen text: case, punctuation and plural ignored. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").map((w) => w.replace(/(ies)$/, "y").replace(/s$/, "")).join(" ");
/** Whole words: "customers" must not match "users" (it did, as a substring). */
const matches = (text: string, needle: string) => ` ${norm(text)} `.includes(` ${norm(needle)} `);

const mainText = (n: DesignNode): string => {
  const p = n.props as Record<string, unknown>;
  return [p.label, p.content, p.alt, p.name, n.type === "Input" ? p.kind : undefined].filter((v) => typeof v === "string").join(" ");
};

function all(n: DesignNode, out: DesignNode[] = []): DesignNode[] { out.push(n); n.children?.forEach((c) => all(c, out)); return out; }

/** Screen selector: "Type", "Type:text", "Title", "*:text", "root". Diagram selector: a label. */
function select(root: DesignNode, view: View, sel: string): DesignNode[] {
  const nodes = all(root);
  if (sel === "root") return [root];
  if (view !== "screen") return nodes.filter((n) => n.type === "Node" && matches(String(n.props.label ?? ""), sel));
  const [type, needle] = sel.split(":") as [string, string | undefined];
  return nodes.filter((n) => {
    if (n === root) return false;
    if (type === "Title") return n.type === "Text" && (n.props.variant === "title" || n.props.variant === "display");
    if (type !== "*" && n.type !== type) return false;
    return !needle || matches(mainText(n), needle);
  });
}

export interface Score { pass: boolean; failures: string[]; view: View }

export function score(project: DesignDoc, activeView: View, c: CorpusCase): Score {
  const e = c.expect;
  const failures: string[] = [];
  const view = e.view ?? c.view;
  if (e.view && activeView !== e.view) failures.push(`ended on ${activeView}, expected ${e.view}`);
  const root = viewDoc(project, view).root;
  const edges = all(root).filter((n) => n.type === "Edge");
  const labelOf = (id: unknown) => { const n = all(root).find((x) => x.id === id); return n ? String(n.props.label ?? "") : ""; };
  const edgeTexts = edges.map((x) => `${labelOf(x.props.from)} → ${labelOf(x.props.to)}`);

  for (const s of e.has ?? []) if (!select(root, view, s).length) failures.push(`missing ${s}`);
  for (const s of e.hasNot ?? []) if (select(root, view, s).length) failures.push(`still has ${s}`);
  for (const [s, prop, want] of e.props ?? []) {
    const hits = select(root, view, s);
    const got = hits.map((n) => String((n.props as Record<string, unknown>)[prop] ?? "—"));
    const ok = prop === "owner" ? got.some((g) => matches(g, want)) : got.includes(want);
    if (!ok) failures.push(`${s}.${prop} = ${got.join("|") || "(no element)"}, expected ${want}`);
  }
  const kids = root.children ?? [];
  if (e.first && !select(root, view, e.first).some((n) => n === kids[0])) failures.push(`first is ${kids[0]?.type}, expected ${e.first}`);
  if (e.last && !select(root, view, e.last).some((n) => n === kids.at(-1))) failures.push(`last is ${kids.at(-1)?.type}, expected ${e.last}`);

  const linked = (a: string, b: string, directed: boolean) => edges.some((x) => {
    const [f, t] = [labelOf(x.props.from), labelOf(x.props.to)];
    return (matches(f, a) && matches(t, b)) || (!directed && matches(f, b) && matches(t, a));
  });
  for (const [a, b] of e.edges ?? []) if (!linked(a, b, true)) failures.push(`no edge ${a} → ${b} (have: ${edgeTexts.join(", ") || "none"})`);
  for (const [a, b] of e.links ?? []) if (!linked(a, b, false)) failures.push(`no link ${a} — ${b} (have: ${edgeTexts.join(", ") || "none"})`);
  for (const s of e.noLinks ?? []) if (edgeTexts.some((t) => t.split(" → ").some((l) => matches(l, s)))) failures.push(`unexpected edge touching ${s}`);
  if (e.minEdges != null && edges.length < e.minEdges) failures.push(`${edges.length} edges, expected ≥ ${e.minEdges}`);
  for (const [table, cols] of e.cols ?? []) {
    const t = select(root, view, table)[0];
    const have = ((t?.props.cols as string[] | undefined) ?? []).map((cs) => cs.split(":")[0]!);
    for (const col of cols) if (!have.some((h) => h === col || norm(h).includes(norm(col)))) failures.push(`${table} lacks column ${col} (has ${have.join(",") || "no table"})`);
  }
  return { pass: failures.length === 0, failures, view: activeView };
}
