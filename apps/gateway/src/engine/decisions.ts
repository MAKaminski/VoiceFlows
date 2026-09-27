import { lexTokens, occurrenceKeys, type DesignDoc, type DesignNode, type DocKind } from "@livecanvas/dsl";
import type { JevAnswer, JevQuestion } from "./jev.js";

/**
 * Jev decisions tier (ADR 0017): turns an utterance + the active view into typed questions, and turns
 * confident answers into ordinary compact op lines — the same lines Haiku would write — so validation,
 * folds, versions and rollback are shared. Pure; no network.
 *
 * Structural decisions only: which mentioned components connect and in which direction, sync/async,
 * cardinality, reply vs request, where an element moves. Anything that needs new text (column names,
 * copy, labels the user didn't say) or a low-confidence answer stays with Haiku.
 */
export const CHOICE_MIN = 0.8;   // bake-off: confidence ≥ 0.8 was 100 % correct (85 % of decisions)
export const NOUL_YES = 0.85;
export const NOUL_NO = 0.15;
const MAX_MENTIONS = 5;          // 5 mentions → 20 ordered pairs → ≤ 40 questions in one request

const STOP = new Set(["the", "a", "an", "and", "which", "that", "then", "it", "its", "their", "also", "so", "um", "uh", "like"]);
const singular = (w: string) => w.replace(/ies$/, "y").replace(/(ss|sh|ch|x)es$/, "$1").replace(/s$/, "");
const norm = (w: string) => singular(w.toLowerCase());

export interface Mention { id: string; label: string; start: number; end: number } // token span [start, end)

/** Elements whose label appears in the transcript (first occurrence), in transcript order. */
export function mentions(nodes: Array<{ id: string; label: string }>, words: string[]): Mention[] {
  const ws = words.map(norm);
  const out: Mention[] = [];
  for (const n of nodes) {
    const lt = lexTokens(n.label.replace(/_/g, " ")).map(norm);
    if (!lt.length) continue;
    for (let i = 0; i + lt.length <= ws.length; i++) {
      if (lt.every((t, k) => ws[i + k] === t)) { out.push({ id: n.id, label: n.label, start: i, end: i + lt.length }); break; }
    }
  }
  // Longest label wins where spans overlap ("genesys bot" over "genesys").
  const kept = out.sort((a, b) => (b.end - b.start) - (a.end - a.start))
    .filter((m, i, all) => !all.slice(0, i).some((x) => m.start < x.end && x.start < m.end));
  return kept.sort((a, b) => a.start - b.start).slice(0, MAX_MENTIONS);
}

export interface Plan {
  view: DocKind;
  state: string;
  questions: Record<string, JevQuestion>;
  pairs: Array<{ key: string; from: Mention; to: Mention }>;
  screen?: { targets: Mention[] };
  words: string[];
}

const REL: Record<string, (a: string, b: string) => string> = {
  architecture: (a, b) => `${a} sends to / calls / writes to / reads from / publishes to ${b}`,
  erd: (a, b) => `each ${a} has many (or one) ${b} — ${a} is the one side`,
  sequence: (a, b) => `${a} sends a message to ${b}`,
};
const STYLE: Record<string, { key: string; q: (t: string) => JevQuestion }> = {
  architecture: { key: "style", q: (t) => ({ type: "choice", instructions: `How does this connection communicate? Transcript: "${t}"`, criteria: { sync: "Request/response: calls, queries, reads, writes", async: "Fire-and-forget: queues, events, publishes, webhooks" } }) },
  erd: { key: "card", q: (t) => ({ type: "choice", instructions: `Cardinality from the first table to the second? Transcript: "${t}"`, criteria: { "1:n": "one to many", "1:1": "one to one" } }) },
  sequence: { key: "kind", q: (t) => ({ type: "choice", instructions: `What kind of message is it? Transcript: "${t}"`, criteria: { sync: "A request or call", return: "A reply that returns something to the caller", async: "Fire-and-forget (enqueue, notify)" } }) },
};
const labelOf = (n: DesignNode): string => {
  const p = n.props as Record<string, unknown>;
  return String(p.label ?? p.content ?? p.alt ?? p.name ?? "");
};

/** Questions for the active view — or null when there is nothing structural to decide. */
export function planDecisions(view: DesignDoc, kind: DocKind, text: string): Plan | null {
  const words = lexTokens(text);
  const root = view.root;
  const kids = (root.children ?? []);
  const questions: Record<string, JevQuestion> = {};
  const pairs: Plan["pairs"] = [];
  let screen: Plan["screen"];
  let state: string;

  if (kind === "screen") {
    const pos = words.some((w) => ["top", "first", "bottom", "last", "above", "below"].includes(w));
    if (!pos) return null;
    const els = kids.map((c) => ({ id: c.id, label: labelOf(c) || c.type })).filter((c) => c.label);
    const targets = mentions(els, words);
    if (!targets.length) return null;
    state = `Phone screen, top to bottom: ${els.map((e) => `${e.id} (${e.label})`).join(", ")}. Transcript: "${text}"`;
    questions.target = { type: "choice", instructions: "Which element does the transcript move?", criteria: Object.fromEntries([...targets.map((m) => [m.id, `the ${m.label}`]), ["none", "nothing is moved"]]) };
    questions.position = { type: "choice", instructions: "Where does it go?", criteria: { first: "To the top / first", last: "To the bottom / last", unchanged: "No move" } };
    screen = { targets };
  } else {
    const nodes: Array<{ id: string; label: string }> = [];
    const walk = (n: DesignNode) => { if (n.type === "Node") nodes.push({ id: n.id, label: labelOf(n) }); n.children?.forEach(walk); };
    walk(root);
    const ms = mentions(nodes, words);
    if (ms.length < 2) return null;
    state = `${kind === "erd" ? "Entity-relationship diagram" : kind === "sequence" ? "Sequence diagram" : "Architecture diagram"}. Elements mentioned: ${ms.map((m) => m.label).join(", ")}. Transcript: "${text}"`;
    // One 3-way Choice per ADJACENT pair of mentions (a→b, b→a, none) — the format re-measured in the
    // bake-off with multi-clause, passive and negative sentences (plan-critic M6 #2).
    for (let i = 0; i + 1 < ms.length; i++) {
      const a = ms[i]!, b = ms[i + 1]!;
      const key = `${i}`;
      pairs.push({ key, from: a, to: b });
      questions[`rel:${key}`] = { type: "choice", instructions: `Does the transcript connect ${a.label} and ${b.label}, and in which direction?`,
        criteria: { [`${a.id}->${b.id}`]: REL[kind]!(a.label, b.label), [`${b.id}->${a.id}`]: REL[kind]!(b.label, a.label), none: `No connection between ${a.label} and ${b.label} is described` } };
      const s = STYLE[kind]!;
      questions[`${s.key}:${key}`] = s.q(text);
    }
    if (!pairs.length) return null;
  }
  return { view: kind, state, questions, pairs, ...(screen ? { screen } : {}), words };
}

export interface Decided { lines: string[]; covered: string[]; accepted: number; unsure: number }

const AUX = new Set(["is", "are", "was", "were", "be", "been", "being", "gets", "get", "each", "every"]);
/** Words between the two mentions as a short label: "writes to", "publishes jobs to", "read" (from "is read by"). */
const verbPhrase = (words: string[], a: Mention, b: Mention): string => {
  const [lo, hi] = a.start < b.start ? [a.end, b.start] : [b.end, a.start];
  const mid = words.slice(lo, hi).filter((w) => !STOP.has(w) && !AUX.has(w));
  while (mid.length && ["to", "from", "with", "by", "in", "of", "on"].includes(mid[0]!)) mid.shift();
  while (mid.length && ["by", "with"].includes(mid[mid.length - 1]!)) mid.pop(); // passive "read by" → "read"
  return mid.slice(0, 3).join(" ");
};
const sentence = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Confident answers → compact op lines (+ the occurrence keys of the words they cover). Unsure answers
 * produce nothing — the caller leaves those words to Haiku. `cols` gives an ERD table's current columns.
 */
export function decisionsToLines(plan: Plan, answers: Record<string, JevAnswer>, cols: (id: string) => string[] = () => []): Decided {
  const lines: string[] = [];
  const coveredIdx = new Set<number>();
  let accepted = 0, unsure = 0, n = 0;
  const choice = (k: string) => { const a = answers[k]; return a?.type === "choice" && a.confidence >= CHOICE_MIN ? a.choice : null; };

  if (plan.screen) {
    const target = choice("target"), position = choice("position");
    if (target && target !== "none" && position && position !== "unchanged") {
      lines.push(position === "first" ? `^${target} >root @0` : `^${target} >root`);
      plan.words.forEach((w, i) => { if (["top", "first", "bottom", "last", "above", "below", "on", "put", "move"].includes(w)) coveredIdx.add(i); });
      accepted++;
    } else unsure++;
  }

  const fkAdded = new Map<string, string[]>();
  for (const p of plan.pairs) {
    const rel = answers[`rel:${p.key}`];
    if (rel?.type !== "choice" || rel.confidence < CHOICE_MIN) { unsure++; continue; }
    const [lo, hi] = p.from.start < p.to.start ? [p.from.end, p.to.start] : [p.to.end, p.from.start];
    if (rel.choice === "none") { accepted++; continue; } // confidently not a connection: nothing to draw
    const from = rel.choice === `${p.from.id}->${p.to.id}` ? p.from : rel.choice === `${p.to.id}->${p.from.id}` ? p.to : null;
    if (!from) { unsure++; continue; }
    const to = from === p.from ? p.to : p.from;
    const label = verbPhrase(plan.words, from, to);
    for (let i = lo; i < hi; i++) if (!STOP.has(plan.words[i]!) && !AUX.has(plan.words[i]!)) coveredIdx.add(i); // only words that mean something get highlighted
    n++;
    if (plan.view === "architecture") {
      const style = choice(`style:${p.key}`);
      lines.push(`+Edge jev${n} >root from=${from.id} to=${to.id}${style === "async" ? " style=async" : ""}${label ? ` "${label}"` : ""}`);
    } else if (plan.view === "sequence") {
      const kind = choice(`kind:${p.key}`);
      lines.push(`+Edge jev${n} >root from=${from.id} to=${to.id}${kind && kind !== "sync" ? ` style=${kind}` : ""} "${sentence(label) || "Message"}"`);
    } else {
      const card = choice(`card:${p.key}`) ?? "1:n";
      const fk = `${singular(from.label.toLowerCase()).replace(/[^a-z0-9]+/g, "_")}_id:uuid:fk`;
      const current = fkAdded.get(to.id) ?? cols(to.id);
      if (!current.some((c) => c.split(":")[0] === fk.split(":")[0])) {
        const next = [...current, fk];
        fkAdded.set(to.id, next);
        lines.push(`~${to.id} cols=${next.join(",")}`);
      }
      lines.push(`+Edge jev${n} >root from=${from.id} to=${to.id} card=${card} "${card === "1:1" ? "has one" : "has many"}"`);
    }
    accepted++;
  }
  const occ = occurrenceKeys(plan.words);
  return { lines, covered: [...coveredIdx].map((i) => occ[i]!), accepted, unsure };
}
