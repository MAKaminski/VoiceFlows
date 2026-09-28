import { fixSpeech, lexTokens, occurrenceKeys, type DesignDoc, type DesignNode, type DocKind } from "@livecanvas/dsl";
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

const STOP = new Set(["the", "a", "an", "and", "which", "that", "then", "it", "its", "their", "also", "so", "um", "uh", "like", "both", "all", "or"]);
/** Words that join mentions into one group: "the api AND the worker both write to postgres" (M7 fan-out). */
/** Prepositions that continue a list's sentence rather than start a clause ("salesforce and genesys TO shaw"). */
const PREP = new Set(["to", "from", "into", "with", "via", "through", "by", "of", "on", "in", "for", "at", "over", "behind"]);
const JOIN = new Set(["and", "or", "both", "the", "a", "an", "as", "well", "plus", "also", "um", "uh", "each", "every"]);
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
  /** gap: the token span between the two groups — the verb phrase and the words the answer covers. */
  /** owned: the ERD sentence says the FIRST belongs to the second ("each order belongs to a customer") —
   *  decided by grammar: the second is the one side, no question asked. */
  pairs: Array<{ key: string; from: Mention; to: Mention; gap: [number, number]; fan?: boolean; owned?: boolean }>;
  screen?: { targets: Mention[]; where: "first" | "last"; direct?: Mention };
  words: string[];
  /** The same tokens after speech repair ("rights to" → "writes to"); index-aligned with `words`. */
  said: string[];
}

/**
 * "X belongs to Y" and its kin put Y on the one side. Jev and Haiku both read the subject as the "one" side
 * and drew orders → customers (ADR 0017 blind spot); this is grammar, not a judgement, so it is a rule.
 * A negation in the gap leaves it to Jev.
 */
const OWNED = [["belongs", "to"], ["belong", "to"], ["belonging", "to"], ["owned", "by"], ["part", "of"], ["assigned", "to"], ["child", "of"]];
export const ownedBy = (gap: string[]) =>
  !gap.some((w) => ["not", "doesn't", "don't", "never", "no"].includes(w)) && OWNED.some(([a, b]) => gap.some((w, i) => w === a && gap[i + 1] === b));

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
/** Option key Jev can read: "Observe.AI" → "observe_ai", "Sign in" → "sign_in". */
export const readable = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "item";
const labelOf = (n: DesignNode): string => {
  const p = n.props as Record<string, unknown>;
  return String(p.label ?? p.content ?? p.alt ?? p.name ?? "");
};

/** Questions for the active view — or null when there is nothing structural to decide. */
export function planDecisions(view: DesignDoc, kind: DocKind, raw: string): Plan | null {
  const words = lexTokens(raw);
  // Jev reads the repaired sentence; word keys (highlighting) stay on the raw one (plan-critic M7).
  const text = fixSpeech(raw);
  const said = lexTokens(text);
  const root = view.root;
  const kids = (root.children ?? []);
  const questions: Record<string, JevQuestion> = {};
  const pairs: Plan["pairs"] = [];
  let screen: Plan["screen"];
  let state: string;

  if (kind === "screen") {
    const POS = ["top", "first", "bottom", "last", "above", "below"];
    const at = words.map((w, i) => (POS.includes(w) ? i : -1)).filter((i) => i >= 0).at(-1);
    if (at == null) return null;
    // Live tuning (2026-09-27, real Jev): the position word needs no model ("top" = first); Jev only
    // picks WHICH element, from those named just before it, with readable option keys and the whole
    // sentence — ids as keys and a split question left it unsure on 10/10 DoD sentences.
    const lo = Math.max(0, at - 5);
    const els = kids.map((c) => ({ id: c.id, label: labelOf(c) || c.type })).filter((c) => c.label);
    const targets = mentions(els, words.slice(lo, at)).map((m) => ({ ...m, start: m.start + lo, end: m.end + lo }));
    if (!targets.length) return null;
    const where = ["bottom", "last", "below"].includes(words[at]!) ? "last" : "first";
    // "…logo on top": the element named directly before the position words IS the target — grammar,
    // not a judgement; no network call (live: Jev picked it right every time but only at 0.59).
    const nearest = targets.at(-1)!;
    if (words.slice(nearest.end, at).every((w) => ["on", "at", "to", "the", "very", "of", "it"].includes(w))) {
      return { view: kind, state: "", questions: {}, pairs: [], screen: { targets, where, direct: nearest }, words, said };
    }
    const phrase = words.slice(lo, at + 1).join(" ");
    state = `Phone screen, top to bottom: ${els.map((e) => `${readable(e.label)} (${e.label})`).join(", ")}.`;
    questions.target = { type: "choice", instructions: `Which element is being moved ${where === "first" ? "to the top" : "to the bottom"}? They said "${phrase}". Transcript: "${text}"`,
      criteria: Object.fromEntries([...targets.map((m) => [readable(m.label), `the ${m.label}`]), ["none", "nothing is moved"]]) };
    screen = { targets, where };
  } else {
    const nodes: Array<{ id: string; label: string }> = [];
    const walk = (n: DesignNode) => { if (n.type === "Node") nodes.push({ id: n.id, label: labelOf(n) }); n.children?.forEach(walk); };
    walk(root);
    const ms = mentions(nodes, words);
    if (ms.length < 2) return null;
    state = `${kind === "erd" ? "Entity-relationship diagram" : kind === "sequence" ? "Sequence diagram" : "Architecture diagram"}. Elements mentioned: ${ms.map((m) => m.label).join(", ")}. Transcript: "${text}"`;
    // One 3-way Choice per pair of ADJACENT GROUPS of mentions (a→b, b→a, none) — the format re-measured in
    // the bake-off (plan-critic M6 #2). Mentions joined only by and/or/both form a group, so "the api and the
    // worker both write to postgres" asks api–postgres AND worker–postgres (M7: the api edge was lost).
    const groups: Mention[][] = [];
    for (const m of ms) {
      const last = groups.at(-1)?.at(-1);
      if (last && words.slice(last.end, m.start).every((w) => JOIN.has(w)) && words.slice(last.end, m.start).some((w) => w === "and" || w === "or" || w === "plus")) groups.at(-1)!.push(m);
      else groups.push([m]);
    }
    // An OBJECT list ("reads from redis and postgres") can hide a new clause: in "publishes jobs to a queue and
    // a worker consumes them" the worker is followed by its own verb, so it starts a new group (M7 flake:
    // api→worker was drawn). Subject lists ("the api and the worker both write…") are untouched.
    for (let g = 0; g < groups.length; g++) {
      const grp = groups[g]!;
      if (grp.length < 2) continue;
      let k = grp[0]!.start - 1;
      while (k >= 0 && JOIN.has(words[k]!)) k--;
      if (k < 0) continue; // nothing before the list: it is the subject
      const split = grp.findIndex((m, j) => {
        if (j === 0) return false;
        const next = ms.find((x) => x.start >= m.end)?.start ?? words.length;
        return said.slice(m.end, next).some((w) => !JOIN.has(w) && !STOP.has(w) && !PREP.has(w));
      });
      if (split > 0) groups.splice(g + 1, 0, grp.splice(split));
    }
    for (let g = 0; g + 1 < groups.length; g++) for (const a of groups[g]!) for (const b of groups[g + 1]!) {
      const key = `${pairs.length}`;
      const fan = groups[g]!.length > 1 || groups[g + 1]!.length > 1;
      const gap: [number, number] = [groups[g]!.at(-1)!.end, groups[g + 1]![0]!.start];
      if (kind === "erd" && ownedBy(said.slice(...gap))) { pairs.push({ key, from: a, to: b, gap, owned: true }); continue; } // grammar decides: no question
      pairs.push({ key, from: a, to: b, gap, ...(fan ? { fan } : {}) });
      const [ra, rb] = [readable(a.label), readable(b.label)]; // readable keys: ids halved Jev's confidence
      questions[`rel:${key}`] = { type: "choice", instructions: `Does the transcript connect ${a.label} and ${b.label}, and in which direction?`,
        criteria: { [`${ra}->${rb}`]: REL[kind]!(a.label, b.label), [`${rb}->${ra}`]: REL[kind]!(b.label, a.label), none: `No connection between ${a.label} and ${b.label} is described` } };
      const s = STYLE[kind]!;
      questions[`${s.key}:${key}`] = s.q(text);
    }
    if (!pairs.length) return null;
  }
  return { view: kind, state, questions, pairs, ...(screen ? { screen } : {}), words, said };
}

export interface Decided { lines: string[]; covered: string[]; accepted: number; unsure: number }

const AUX = new Set(["is", "are", "was", "were", "be", "been", "being", "gets", "get", "each", "every"]);
/** Words between the two groups as a short label: "writes to", "publishes jobs to", "read" (from "is read by"). */
const verbPhrase = (words: string[], [lo, hi]: [number, number], names: string[]): string => {
  const mid = words.slice(lo, hi).filter((w) => !STOP.has(w) && !AUX.has(w) && !names.includes(w));
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
    const picked = choice("target");
    const target = plan.screen.direct ?? plan.screen.targets.find((m) => readable(m.label) === picked);
    if (target) {
      lines.push(plan.screen.where === "first" ? `^${target.id} >root @0` : `^${target.id} >root`);
      plan.words.forEach((w, i) => { if (["top", "first", "bottom", "last", "above", "below", "on", "put", "move", "up", "down"].includes(w)) coveredIdx.add(i); });
      for (let i = target.start; i < target.end; i++) coveredIdx.add(i); // "put THAT LOGO on top": the mention is handled too (M7)
      accepted++;
    } else unsure++;
  }

  const fkAdded = new Map<string, string[]>();
  /** ERD relationship: `from` is the one side; the many side gets `<from>_id` as a foreign key. */
  const emitErd = (from: Mention, to: Mention, card: string, alias: string) => {
    const fk = `${singular(from.label.toLowerCase()).replace(/[^a-z0-9]+/g, "_")}_id:uuid:fk`;
    const current = fkAdded.get(to.id) ?? cols(to.id);
    if (!current.some((c) => c.split(":")[0] === fk.split(":")[0])) {
      const next = [...current, fk];
      fkAdded.set(to.id, next);
      lines.push(`~${to.id} cols=${next.join(",")}`);
    }
    lines.push(`+Edge ${alias} >root from=${from.id} to=${to.id} card=${card} "${card === "1:1" ? "has one" : "has many"}"`);
  };
  for (const p of plan.pairs) {
    const rel = answers[`rel:${p.key}`];
    const [lo, hi] = p.gap;
    if (p.owned) { // "each order belongs to a customer": customers 1:n orders, fk on orders
      for (let i = lo; i < hi; i++) if (!STOP.has(plan.words[i]!) && !AUX.has(plan.words[i]!)) coveredIdx.add(i);
      n++;
      emitErd(p.to, p.from, "1:n", `jev${n}`);
      accepted++;
      continue;
    }
    if (rel?.type !== "choice" || rel.confidence < CHOICE_MIN) { unsure++; continue; }
    // Confidently not a connection: nothing to draw. Fan-out pairs were never in the bake-off, so there a
    // "none" is left to the model instead of trusted (plan-critic M7).
    if (rel.choice === "none") { if (p.fan) unsure++; else accepted++; continue; }
    const [ra, rb] = [readable(p.from.label), readable(p.to.label)];
    const from = rel.choice === `${ra}->${rb}` ? p.from : rel.choice === `${rb}->${ra}` ? p.to : null;
    if (!from) { unsure++; continue; }
    const to = from === p.from ? p.to : p.from;
    const names = [...lexTokens(p.from.label), ...lexTokens(p.to.label)].map((w) => w.toLowerCase());
    const label = verbPhrase(plan.said, p.gap, names);
    for (let i = lo; i < hi; i++) if (!STOP.has(plan.words[i]!) && !AUX.has(plan.words[i]!)) coveredIdx.add(i); // only words that mean something get highlighted
    n++;
    if (plan.view === "architecture") {
      const style = choice(`style:${p.key}`);
      lines.push(`+Edge jev${n} >root from=${from.id} to=${to.id}${style === "async" ? " style=async" : ""}${label ? ` "${label}"` : ""}`);
    } else if (plan.view === "sequence") {
      const kind = choice(`kind:${p.key}`);
      const msg = label.replace(/\s+(to|from|on|in|at)$/, ""); // "returns token to" → "Returns token"
      lines.push(`+Edge jev${n} >root from=${from.id} to=${to.id}${kind && kind !== "sync" ? ` style=${kind}` : ""} "${sentence(msg) || "Message"}"`);
    } else emitErd(from, to, choice(`card:${p.key}`) ?? "1:n", `jev${n}`);
    accepted++;
  }
  const occ = occurrenceKeys(plan.words);
  return { lines, covered: [...coveredIdx].map((i) => occ[i]!), accepted, unsure };
}
