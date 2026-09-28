import { VIEWS, viewDoc, type DesignDoc, type DesignNode, type DocKind } from "./doc.js";
import { lexTokens } from "./lexicon.js";

/**
 * Cross-view scaffolding (ADR 0021): what a sentence added in one view fills in the others — an architecture
 * component becomes a sequence participant and a constraints node, a login screen brings users, a Web app,
 * an API and a sign-in flow. Pure rules, $0, run ONCE per sentence at commit (plan-critic M9 #7), only for what
 * that sentence ADDED (so an inferred element the user removed is never re-added), to a fixpoint (≤ 3 rounds).
 *
 * The output is compact op lines per view; the gateway marks every node they add `inferred`. Placeholders are
 * matched by SLOT (lane/kind), not label (M9 #8): the user's own "API gateway" takes over an inferred "API" —
 * renamed in place everywhere it was copied — instead of sitting next to it.
 */
export interface ScaffoldStep { view: DocKind; lines: string[] }

type N = DesignNode;
function all(root: N, out: N[] = []): N[] { out.push(root); root.children?.forEach((c) => all(c, out)); return out; }
const nodesOf = (root: N) => all(root).filter((n) => n.type === "Node");
const edgesOf = (root: N) => all(root).filter((n) => n.type === "Edge");
const label = (n: N) => String(n.props.label ?? "");
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const slug = (s: string) => lexTokens(s).join("_").slice(0, 24) || "x";
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;

/** Architecture lane for a node kind. */
const LANE_OF: Record<string, string> = { client: "frontend", user: "frontend", service: "api", auth: "api", worker: "api", queue: "api", external: "api", db: "data", cache: "data", storage: "data", cdn: "infra" };
/** The kinds that stand in for one another in a slot (a placeholder "API" is any service). */
const SLOT_KINDS: Record<string, string[]> = { client: ["client"], service: ["service"], auth: ["auth"], db: ["db"] };

interface ViewState { root: N; nodes: N[] }
/** Screen elements are Text/Input/Button…, diagram elements are Nodes. */
const stateOf = (p: DesignDoc): Record<DocKind, ViewState> =>
  Object.fromEntries(VIEWS.map((v) => {
    const root = viewDoc(p, v.kind).root;
    return [v.kind, { root, nodes: v.kind === "screen" ? all(root).slice(1) : nodesOf(root) }];
  })) as Record<DocKind, ViewState>;

/** Rename + take-over pass: a real node added this sentence replaces an inferred placeholder in the same slot. */
export function takeOver(project: DesignDoc, base: DesignDoc): { steps: ScaffoldStep[]; renames: Array<[string, string]> } {
  const steps: ScaffoldStep[] = [];
  const renames: Array<[string, string]> = [];
  const now = stateOf(project), baseNodes = VIEWS.flatMap((v) => nodesOf(viewDoc(base, v.kind).root));
  const before = new Set(baseNodes.map((n) => n.id));
  // A placeholder is one inferred when the sentence began: the model may already have touched it (and cleared
  // the mark) in the same sentence that names its replacement — the race seen on production (2026-09-28).
  const wasInferred = new Set(baseNodes.filter((n) => n.inferred).map((n) => n.id));
  const placeholder = (n: N) => !!n.inferred || wasInferred.has(n.id);
  for (const v of VIEWS) {
    const { root, nodes } = now[v.kind];
    const lines: string[] = [];
    for (const fresh of nodes.filter((n) => !before.has(n.id) && !n.inferred)) {
      const kind = String(fresh.props.kind ?? "");
      const slotKinds = SLOT_KINDS[kind];
      if (!slotKinds) continue;
      // Same slot: architecture = same lane and kind; other views = same kind.
      const lane = v.kind === "architecture" ? laneOf(root, fresh.id) : null;
      const ph = nodes.find((n) => placeholder(n) && n.id !== fresh.id && slotKinds.includes(String(n.props.kind)) && (lane == null || laneOf(root, n.id) === lane));
      if (!ph || same(label(ph), label(fresh))) continue;
      for (const e of edgesOf(root)) {
        if (e.props.from === ph.id) lines.push(`~${e.id} from=${fresh.id}`);
        if (e.props.to === ph.id) lines.push(`~${e.id} to=${fresh.id}`);
      }
      lines.push(`-${ph.id}`);
      renames.push([label(ph), label(fresh)]);
    }
    if (lines.length) steps.push({ view: v.kind, lines });
  }
  // Copies of a renamed placeholder elsewhere follow the new name (still inferred).
  for (const [from, to] of renames) {
    for (const v of VIEWS) {
      const hit = now[v.kind].nodes.find((n) => n.inferred && same(label(n), from));
      if (hit && !now[v.kind].nodes.some((n) => same(label(n), to))) steps.push({ view: v.kind, lines: [`~${hit.id} ${q(to)}`] });
    }
  }
  return { steps, renames };
}
function laneOf(root: N, id: string): string | null {
  for (const l of root.children ?? []) if (l.type === "Layer" && l.children?.some((c) => c.id === id)) return String(l.props.tier);
  return null;
}

/** One round: what `project` added since `base` → lines for the other views. */
export function scaffold(project: DesignDoc, base: DesignDoc): ScaffoldStep[] {
  const now = stateOf(project), was = stateOf(base);
  const added = (k: DocKind) => { const old = new Set(was[k].nodes.map((n) => n.id)); return now[k].nodes.filter((n) => !old.has(n.id)); };
  const addedEdges = (k: DocKind) => { const old = new Set(edgesOf(was[k].root).map((n) => n.id)); return edgesOf(now[k].root).filter((n) => !old.has(n.id)); };
  const out = new Map<DocKind, string[]>();
  const planned = new Map<DocKind, Set<string>>(); // labels already queued this round, per view
  const has = (k: DocKind, l: string) => now[k].nodes.some((n) => same(label(n), l)) || (planned.get(k)?.has(l.toLowerCase()) ?? false);
  const hasKind = (k: DocKind, kinds: string[]) => now[k].nodes.some((n) => kinds.includes(String(n.props.kind)));
  const push = (k: DocKind, line: string, l?: string) => {
    (out.get(k) ?? out.set(k, []).get(k)!).push(line);
    if (l) (planned.get(k) ?? planned.set(k, new Set()).get(k)!).add(l.toLowerCase());
  };
  const laneId = (tier: string) => (now.architecture.root.children ?? []).find((c) => c.type === "Layer" && c.props.tier === tier)?.id;
  const addNode = (k: DocKind, l: string, kind: string) => {
    if (has(k, l)) return;
    if (k === "architecture") {
      const lane = laneId(LANE_OF[kind] ?? "api");
      if (!lane) return;
      push(k, `+Node s_${slug(l)} >${lane} k=${kind} ${q(l)}`, l);
    } else push(k, `+Node s_${slug(l)} >root k=${kind}${k === "erd" ? " cols=id:uuid:pk" : ""} ${q(l)}`, l);
  };
  /** A placeholder in the architecture only if its SLOT is empty (critic M9 #8). */
  const addSlot = (l: string, kind: string) => { if (!hasKind("architecture", SLOT_KINDS[kind] ?? [kind])) addNode("architecture", l, kind); };
  const idOf = (k: DocKind, l: string) => now[k].nodes.find((n) => same(label(n), l))?.id ?? (planned.get(k)?.has(l.toLowerCase()) ? `s_${slug(l)}` : null);
  const edgeBetween = (k: DocKind, a: string | null, b: string | null) =>
    !!a && !!b && edgesOf(now[k].root).some((e) => (e.props.from === a && e.props.to === b) || (e.props.from === b && e.props.to === a));
  let edgeN = 0;
  const addEdge = (k: DocKind, fromL: string, toL: string, text: string) => {
    const a = idOf(k, fromL), b = idOf(k, toL);
    if (!a || !b || a === b || edgeBetween(k, a, b)) return;
    push(k, `+Edge se${++edgeN}_${slug(fromL)} >root from=${a} to=${b}${text ? ` ${q(text)}` : ""}`);
  };

  // Architecture → sequence, constraints, cost-value.
  for (const n of added("architecture")) {
    const kind = String(n.props.kind ?? "service");
    addNode("sequence", label(n), kind);
    addNode("constraints", label(n), kind);
    if (kind === "external" || kind === "auth") addNode("cva", label(n), "feature");
  }
  for (const e of addedEdges("architecture")) {
    const from = now.architecture.nodes.find((n) => n.id === e.props.from), to = now.architecture.nodes.find((n) => n.id === e.props.to);
    if (!from || !to) continue;
    addEdge("sequence", label(from), label(to), String(e.props.label ?? ""));
    addEdge("constraints", label(from), label(to), String(e.props.label ?? ""));
  }
  // ERD → a database in the architecture and the sequence (once).
  if (added("erd").length) {
    addSlot("Database", "db");
    if (!hasKind("sequence", ["db"])) addNode("sequence", "Database", "db");
  }
  // Sequence participants → architecture components (by lane).
  for (const n of added("sequence")) {
    const kind = String(n.props.kind ?? "service");
    if (kind === "user") continue; // people aren't components
    if (!has("architecture", label(n))) addNode("architecture", label(n), kind);
  }
  // Screen → the pieces a login / checkout implies.
  const screenNew = added("screen");
  const said = (re: RegExp) => screenNew.some((n) => re.test(`${String(n.props.content ?? "")} ${String(n.props.label ?? "")} ${String(n.props.kind ?? "")}`.toLowerCase()));
  if (said(/log in|sign in|password/)) {
    addSlot("Web app", "client"); addSlot("API", "service"); addSlot("Auth", "auth");
    addNode("erd", "users", "entity");
    const user = now.sequence.nodes.find((n) => n.props.kind === "user") ? label(now.sequence.nodes.find((n) => n.props.kind === "user")!) : "User";
    addNode("sequence", user, "user"); addNode("sequence", "Web app", "client"); addNode("sequence", "API", "service");
    addEdge("sequence", user, "Web app", "signs in");
    addEdge("sequence", "Web app", "API", "logs in");
    addNode("cva", "Sign in", "feature");
  }
  if (said(/sign up|create account/)) { addNode("erd", "users", "entity"); addNode("cva", "Sign up", "feature"); }
  if (said(/checkout|cart|pay/)) {
    for (const t of ["orders", "items", "payments"]) addNode("erd", t, "entity");
    addNode("cva", "Checkout", "feature");
  }
  return [...out].map(([view, lines]) => ({ view, lines }));
}
