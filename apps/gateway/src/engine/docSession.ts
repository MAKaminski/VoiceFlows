import {
  applyOp, DesignDocSchema, emptyDoc, expandCompact, findNode, isModifier, kindKey, lexicon, lexTokens, parseHeader, serializeCompact,
  type CompactContext, type DesignDoc, type DesignNode, type IntentHeader, type OpOrigin, type PatchOp, type ServerMsg,
} from "@livecanvas/dsl";
import { randomUUID } from "node:crypto";
import type { OpenedSession, Persistence, VersionRow } from "../persist.js";
import type { ModelClient } from "./model.js";

export interface EngineConfig { model: string; system: string; render: (vars: Record<string, string>) => string }
export interface Tunables { minGapMs: number; callsPerMin: number; burst: number }
export const DEFAULT_TUNABLES: Tunables = { minGapMs: 150, callsPerMin: 20, burst: 2 };

type JobKind = "typed" | "speculative" | "settle";
interface ActiveJob {
  id: string; kind: JobKind; text: string; abort: AbortController; baseDoc: DesignDoc; applied: number;
  lexOps: PatchOp[]; trigMs?: number;
  protectedIds: Set<string>; // nodes this job folded a re-add into — its later `-` lines must not delete them
}
interface Utterance {
  seq: number; baseDoc: DesignDoc; text: string; lastWordEndMs?: number;
  handled: Set<string>; // `${index}:${word}` the lexicon turned into nodes this utterance
  calledFor: Set<string>; // uncovered content words already sent to the model
  lastCallAt: number; ending: boolean; settled: boolean;
}

// Content words: a new one since the last model call is what makes a speculative call worthwhile.
const CONTENT = new Set(["button", "email", "password", "username", "logo", "image", "photo", "picture", "avatar", "title", "heading", "icon",
  "card", "list", "nav", "navigation", "menu", "table", "chart", "graph", "big", "large", "small", "blue", "red", "purple", "gray", "grey",
  "white", "black", "top", "bottom", "left", "right", "center", "row", "column", "remove", "delete", "move", "bigger", "smaller", "undo", "reset", "form", "field", "input", "text", "header", "footer"]);
/**
 * Content-word positions the lexicon did NOT handle — the only words worth a model call (M4 timeline).
 * A modifier is still waiting for its noun ("big blue … button") until 4 words pass or speech ends;
 * after that it is an edit the model must make ("make it blue").
 */
const MODIFIER_WINDOW = 4;
const uncovered = (text: string, handled: Set<string>, ending = false) => {
  const toks = lexTokens(text);
  return toks.flatMap((w, i) => {
    if (!CONTENT.has(w) || handled.has(`${i}:${w}`)) return [];
    if (isModifier(w) && !ending && toks.length - 1 - i < MODIFIER_WINDOW) return [];
    return [`${i}:${w}`];
  });
};

/**
 * One design session — the only writer of its doc (ADR 0009).
 *  Voice (M4): every transcript runs the lexicon (tier 0, no model). A model job runs only for content
 *  words the lexicon could not handle itself (positions, edits of existing elements, structure) —
 *  when none is in flight, the gap has passed and the call budget allows (≤ 20/min, burst 2 — cost
 *  cap). A new partial never aborts a job. At Flux EagerEndOfTurn/EndOfTurn the utterance settles as
 *  soon as nothing is uncovered, committing ONE version (M4 timeline analysis, 2026-09-27).
 *  Typed prompts (M3) run immediately, abort the running job, and version per job.
 *  Undo mid-utterance discards the uncommitted utterance only (critique #2).
 */
export class DocSession {
  doc: DesignDoc;
  tunables: Tunables = { ...DEFAULT_TUNABLES };
  private versions = new Map<number, VersionRow>();
  private current: number;
  private active: ActiveJob | null = null;
  private utt: Utterance | null = null;
  private nextSeq = 0;
  private bucket = { tokens: DEFAULT_TUNABLES.burst, at: performance.now() };

  constructor(
    private readonly opened: OpenedSession,
    private readonly deps: { persistence: Persistence; model: ModelClient | null; engine: EngineConfig; send: (m: ServerMsg) => void; log?: (m: string) => void },
  ) {
    for (const v of opened.versions) this.versions.set(v.version, v);
    if (!this.versions.has(0)) this.versions.set(0, { version: 0, parent: null, doc: emptyDoc() });
    this.current = this.versions.has(opened.current) ? opened.current : 0;
    this.doc = structuredClone(this.versions.get(this.current)!.doc);
  }

  get sessionId() { return this.opened.sessionId; }
  versionInfo() {
    return { version: this.current, canUndo: this.versions.get(this.current)?.parent != null || this.dirty(), canRedo: this.redoTarget() != null };
  }
  snapshot(): ServerMsg { return { type: "doc", doc: this.doc, ...this.versionInfo() }; }
  allocSeq(): number { return this.nextSeq++; }
  tune(t: Partial<Tunables>) { this.tunables = { ...this.tunables, ...t }; }

  private dirty() { return JSON.stringify(this.doc) !== JSON.stringify(this.versions.get(this.current)!.doc); }
  private emitOps(jobId: string, origin: OpOrigin, ops: PatchOp[], trigMs?: number) {
    if (ops.length) this.deps.send({ type: "ops", jobId, origin, ops, ...(trigMs != null ? { trigMs } : {}) });
  }
  private restore(doc: DesignDoc, jobId: string, origin: OpOrigin) {
    this.doc = structuredClone(doc);
    this.emitOps(jobId, origin, [{ op: "replace", path: "/root", value: this.doc.root }]);
  }

  /** Token bucket: `callsPerMin` sustained, `burst` at once. Every started model call spends one. */
  private takeCall(): boolean {
    const now = performance.now();
    const perMs = this.tunables.callsPerMin / 60_000;
    this.bucket.tokens = Math.min(this.tunables.burst, this.bucket.tokens + (now - this.bucket.at) * perMs);
    this.bucket.at = now;
    if (this.bucket.tokens < 1) return false;
    this.bucket.tokens -= 1;
    return true;
  }

  // ── Voice ────────────────────────────────────────────────────────────────────────────────
  onTranscript(seq: number, text: string, isFinal: boolean, lastWordEndMs?: number, eager = false) {
    if (!text) return;
    if (!this.utt || this.utt.seq !== seq) {
      if (this.utt && !this.utt.settled) this.commitUtterance();
      this.utt = { seq, baseDoc: this.doc, text: "", handled: new Set(), calledFor: new Set(), lastCallAt: -Infinity, ending: false, settled: false };
    }
    const u = this.utt;
    // Speech resumed after an eager settle (Flux TurnResumed): reopen the utterance as a new part.
    if (u.settled && !isFinal && uncovered(text, u.handled, true).some((k) => !u.calledFor.has(k))) {
      u.settled = false; u.ending = false; u.baseDoc = this.doc;
    }
    if (u.settled) return;
    u.text = text;
    u.lastWordEndMs = lastWordEndMs ?? u.lastWordEndMs;

    // Tier 0: lexicon → provisional nodes, no model call (ADR 0001/0009).
    const lex = lexicon(text, this.doc);
    const toks = lexTokens(text);
    for (const i of lex.consumed) u.handled.add(`${i}:${toks[i]}`);
    if (lex.ops.length) this.applyLexicon(lex.ops, seq, lastWordEndMs, lex.created.map((c) => c.id));

    // Final or Flux EagerEndOfTurn: the speaker (probably) stopped — settle as soon as nothing is pending.
    if (isFinal || eager) { u.ending = true; this.settleIfReady(); return; }
    this.maybeSpeculate();
  }

  private pending(u: Utterance) { return uncovered(u.text, u.handled, u.ending).filter((k) => !u.calledFor.has(k)); }

  private maybeSpeculate(force = false) {
    const u = this.utt;
    if (!u || u.settled || this.active || !this.deps.model) return;
    const todo = this.pending(u);
    if (!todo.length) return;
    if (!force && performance.now() - u.lastCallAt < this.tunables.minGapMs) return;
    if (!this.takeCall() && !force) return; // the end-of-utterance call may overdraw by one
    todo.forEach((k) => u.calledFor.add(k));
    u.lastCallAt = performance.now();
    void this.runJob(u.ending ? "settle" : "speculative", u.text, u.seq, u.lastWordEndMs).then(() => this.afterVoiceJob());
  }

  /** At (eager) end of turn: commit now if nothing is uncovered, else one forced call then commit. */
  private settleIfReady() {
    const u = this.utt;
    if (!u || u.settled || this.active) return;
    if (this.pending(u).length && this.deps.model) return this.maybeSpeculate(true);
    this.commitUtterance();
  }

  private afterVoiceJob() {
    const u = this.utt;
    if (!u || u.settled) return;
    if (u.ending) this.settleIfReady();
    else this.maybeSpeculate();
  }

  private applyLexicon(ops: PatchOp[], seq: number, trigMs: number | undefined, created: string[]) {
    let next = this.doc;
    try { for (const op of ops) next = applyOp(next, op); } catch { return; }
    this.doc = next;
    const jobId = randomUUID();
    this.emitOps(jobId, "lexicon", ops, trigMs);
    this.active?.lexOps.push(...ops); // replayed if the running job is rolled back (critique M3 #4)
    const { persistence } = this.deps;
    const uid = persistence.utterance(this.sessionId, seq, "voice");
    const intentId = randomUUID();
    const header: IntentHeader = { a: "add", c: 1, s: false, x: false, t: created };
    persistence.intent(this.sessionId, { id: intentId, utteranceId: uid, header, delta: 1, path: "lexicon", tMs: trigMs ?? 0 });
    persistence.jobStart(this.sessionId, { id: jobId, intentId, model: "lexicon" });
    ops.forEach((op, i) => persistence.op(this.sessionId, { jobId, seq: i, op, primitive: op.op === "add" ? String((op.value as DesignNode).type) : null, tMs: trigMs ?? 0 }));
    persistence.jobEnd(this.sessionId, { id: jobId, status: "done" });
    persistence.latency(this.sessionId, { jobId, stage: "first_op", tMs: trigMs ?? 0 });
  }

  /** Accept the utterance: clear remaining provisional flags, write ONE version if anything changed. */
  private commitUtterance() {
    const u = this.utt;
    if (!u || u.settled) return;
    u.settled = true;
    const clear: PatchOp[] = [];
    const walk = (n: DesignNode, path: string) => {
      if (n.provisional) clear.push({ op: "remove", path: `${path}/provisional` });
      n.children?.forEach((c, i) => walk(c, `${path}/children/${i}`));
    };
    walk(this.doc.root, "/root");
    if (clear.length) { for (const op of clear) this.doc = applyOp(this.doc, op); this.emitOps(randomUUID(), "model", clear); }
    if (JSON.stringify(this.doc) !== JSON.stringify(u.baseDoc)) this.writeVersion(null);
    const uid = this.deps.persistence.utterance(this.sessionId, u.seq, "voice");
    this.deps.persistence.latency(this.sessionId, { utteranceId: uid, stage: "settled", tMs: u.lastWordEndMs ?? 0 });
    this.deps.send({ type: "version", ...this.versionInfo() });
  }

  // ── Typed prompts (M3 semantics) ─────────────────────────────────────────────────────────
  async run(text: string, source: "voice" | "typed", seq: number): Promise<void> {
    this.abortActive();
    await this.runJob("typed", text, seq);
  }

  abortActive(reason = "superseded") {
    const job = this.active;
    if (!job) return;
    this.active = null;
    job.abort.abort();
    if (job.applied > 0) {
      // Restore the pre-job doc, then replay lexicon ops that landed during the job (if they still apply).
      let doc = job.baseDoc;
      for (const op of job.lexOps) { try { doc = applyOp(doc, op); } catch { /* no longer applies */ } }
      this.restore(doc, job.id, "rollback");
    }
    this.deps.send({ type: "job", jobId: job.id, state: "aborted", kind: job.kind, detail: reason });
    this.deps.persistence.jobEnd(this.sessionId, { id: job.id, status: "aborted" });
  }

  private async runJob(kind: JobKind, text: string, seq: number, trigMs?: number): Promise<void> {
    const { persistence } = this.deps;
    const sid = this.sessionId;
    const job: ActiveJob = { id: randomUUID(), kind, text, abort: new AbortController(), baseDoc: this.doc, applied: 0, lexOps: [], trigMs, protectedIds: new Set() };
    this.active = job;
    const utteranceId = persistence.utterance(sid, seq, kind === "typed" ? "typed" : "voice", kind === "typed" ? text : undefined);
    this.deps.send({ type: "job", jobId: job.id, state: "running", kind, text });
    if (!this.deps.model) return this.finish(job, "failed", "no model key configured");

    const stream = this.deps.model({
      model: this.deps.engine.model,
      system: this.deps.engine.system,
      user: this.deps.engine.render({ doc_compact: serializeCompact(this.doc.root) || "(empty screen: root)", partial_text: text }),
      signal: job.abort.signal,
    });
    const aliases = new Map<string, string>();
    const ctx: CompactContext = {
      resolve: (ref) => (ref === "root" ? "/root" : findNode(this.doc.root, aliases.get(ref) ?? ref)?.path ?? null),
      assignId: (alias) => {
        const base = `n_${alias.toLowerCase().replace(/[^a-z0-9_]/g, "") || "node"}`;
        let id = base, n = 2;
        while (findNode(this.doc.root, id) || [...aliases.values()].includes(id)) id = `${base}_${n++}`;
        aliases.set(alias, id);
        return id;
      },
    };
    const typeOf = (ref: string) => findNode(this.doc.root, aliases.get(ref) ?? ref)?.node.type ?? null;

    let header: IntentHeader | null = null;
    let opSeq = 0, firstOpMs: number | undefined;
    try {
      for await (const { line, atMs } of stream.lines) {
        if (this.active !== job) return;
        if (!header) {
          const parsed = parseHeader(line);
          header = parsed ?? { a: "add", c: 0.5, s: false, x: false, t: [] };
          const intentId = randomUUID();
          persistence.intent(sid, { id: intentId, utteranceId, header, delta: 1, path: "haiku", tMs: atMs });
          persistence.jobStart(sid, { id: job.id, intentId, model: this.deps.engine.model });
          if (header.a === "none") break;
          if (header.a === "undo" && header.x) { this.finish(job, "done"); this.undo(); return; }
          if (header.a === "reset" && header.x) { this.applyValidated(job, [{ op: "replace", path: "/root", value: emptyDoc().root }], atMs, opSeq++); continue; }
          if (parsed) continue;
        }
        let ops: PatchOp[];
        try { ops = this.enforceEdits(job, expandCompact(line, ctx, typeOf), aliases); }
        catch (e) { this.deps.log?.(`engine: dropped line "${line}" (${(e as Error).message})`); continue; }
        if (this.applyValidated(job, ops, atMs, opSeq)) {
          opSeq += ops.length;
          if (firstOpMs == null) { firstOpMs = atMs; persistence.latency(sid, { jobId: job.id, stage: "first_op", tMs: atMs }); }
        }
      }
      if (this.active !== job) return;
      const usage = await stream.usage;
      this.finish(job, "done", undefined, firstOpMs, usage);
    } catch (e) {
      if (this.active !== job) return;
      this.deps.log?.(`engine: job failed (${(e as Error).message})`);
      if (job.applied > 0) this.restore(job.baseDoc, job.id, "rollback");
      this.finish(job, "failed", (e as Error).message);
    }
  }

  /**
   * Enforces "edit what the user already sees" (M4 live run: Haiku rebuilt the screen and deleted the
   * provisional nodes in 2/3 samples):
   *  - an `add` whose kind key matches an existing node — or, for a type with exactly one provisional
   *    node, any add of that type (the lexicon's "Button" vs the model's "Sign in") — becomes an update
   *    of that node plus a move into the parent the model asked for (so a requested Card wrap still
   *    happens, without duplicates). The alias is re-pointed to the existing node;
   *  - `remove` of a provisional node, or of a node folded earlier in this job, is dropped.
   * Types keyed only by type (Card, List, Icon…) are never folded: several are legitimate.
   */
  private enforceEdits(job: ActiveJob, ops: PatchOp[], aliases: Map<string, string>): PatchOp[] {
    const out: PatchOp[] = [];
    for (const op of ops) {
      if (op.op === "remove") {
        const hit = findNodeAt(this.doc, op.path);
        if (hit && (hit.node.provisional || job.protectedIds.has(hit.node.id))) { this.deps.log?.(`engine: kept ${hit.node.id} (model tried to remove it)`); continue; }
        out.push(op); continue;
      }
      const isChildAdd = op.op === "add" && (op.path.endsWith("/children/-") || /\/children\/\d+$/.test(op.path));
      if (!isChildAdd) { out.push(op); continue; }
      const node = (op as { value: DesignNode }).value;
      const key = kindKey(node);
      const all: Array<{ node: DesignNode; path: string; parentPath: string }> = [];
      const walk = (n: DesignNode, path: string, parentPath: string) => {
        if (path !== "/root") all.push({ node: n, path, parentPath });
        n.children?.forEach((c, i) => walk(c, `${path}/children/${i}`, path));
      };
      walk(this.doc.root, "/root", "");
      const provisionalOfType = all.filter((x) => x.node.provisional && x.node.type === node.type);
      const match = (key.includes(":") && (all.find((x) => x.node.provisional && kindKey(x.node) === key) ?? all.find((x) => kindKey(x.node) === key)))
        || (provisionalOfType.length === 1 ? provisionalOfType[0] : undefined);
      if (!match) { out.push(op); continue; }
      for (const [alias, id] of aliases) if (id === node.id) aliases.set(alias, match.node.id);
      job.protectedIds.add(match.node.id);
      for (const [k, v] of Object.entries(node.props)) {
        if (JSON.stringify(match.node.props[k]) !== JSON.stringify(v)) out.push({ op: "replace", path: `${match.path}/props/${k}`, value: v });
      }
      if (match.node.provisional) out.push({ op: "remove", path: `${match.path}/provisional` });
      // Honour the requested parent (e.g. into a new Card). Same parent → leave it where it is (no reflow).
      const targetParent = op.path.replace(/\/children\/(-|\d+)$/, "");
      if (targetParent !== match.parentPath) out.push({ op: "move", from: match.path, path: shiftAfterRemoval(op.path, match.path) });
    }
    return out;
  }

  /** Apply ops to a candidate doc, clear provisional flags on touched nodes, validate, commit + push. */
  private applyValidated(job: ActiveJob, ops: PatchOp[], atMs: number, seq: number): boolean {
    let candidate = this.doc;
    const extra: PatchOp[] = [];
    try {
      for (const op of ops) candidate = applyOp(candidate, op);
      for (const op of ops) {
        const m = /^(\/root(?:\/children\/\d+)*)/.exec(op.op === "move" ? op.path : op.path);
        const target = m && findNodeAt(candidate, m[1]!);
        if (target?.node.provisional && !extra.some((x) => x.path === `${target.path}/provisional`)) {
          const clear: PatchOp = { op: "remove", path: `${target.path}/provisional` };
          candidate = applyOp(candidate, clear);
          extra.push(clear);
        }
      }
    } catch (e) { this.deps.log?.(`engine: dropped ops (${(e as Error).message})`); return false; }
    if (!DesignDocSchema.safeParse(candidate).success) { this.deps.log?.("engine: dropped ops (doc failed validation)"); return false; }
    this.doc = candidate;
    const all = [...ops, ...extra];
    job.applied += all.length;
    this.emitOps(job.id, "model", all, job.trigMs);
    all.forEach((op, i) => this.deps.persistence.op(this.sessionId, {
      jobId: job.id, seq: seq + i, op, tMs: atMs,
      primitive: op.op === "add" && typeof op.value === "object" && op.value && "type" in op.value ? String((op.value as DesignNode).type) : null,
    }));
    return true;
  }

  private writeVersion(jobId: string | null) {
    const version = Math.max(0, ...this.versions.keys()) + 1;
    const row: VersionRow = { version, parent: this.current, doc: structuredClone(this.doc) };
    this.versions.set(version, row);
    this.current = version;
    this.deps.persistence.version(this.sessionId, { documentId: this.opened.documentId, version, parent: row.parent, doc: row.doc, jobId });
    this.deps.persistence.setCurrent(this.sessionId, { documentId: this.opened.documentId, version, doc: row.doc });
  }

  private finish(job: ActiveJob, state: "done" | "failed", detail?: string, firstOpMs?: number, usage?: { inputTokens: number; outputTokens: number }) {
    if (this.active === job) this.active = null;
    // Typed prompts version per job (M3); voice versions once per utterance at commit.
    if (state === "done" && job.kind === "typed" && job.applied > 0) {
      this.writeVersion(job.id);
      this.deps.send({ type: "version", ...this.versionInfo() });
    }
    this.deps.persistence.jobEnd(this.sessionId, { id: job.id, status: state, ...usage });
    this.deps.send({ type: "job", jobId: job.id, state, kind: job.kind, firstOpMs, opCount: job.applied, detail, ...usage });
  }

  private redoTarget(): number | null {
    let best: number | null = null;
    for (const v of this.versions.values()) if (v.parent === this.current && (best == null || v.version > best)) best = v.version;
    return best;
  }

  private moveTo(version: number, origin: "undo" | "redo") {
    const row = this.versions.get(version);
    if (!row) return;
    this.current = version;
    this.restore(row.doc, randomUUID(), origin);
    this.deps.persistence.setCurrent(this.sessionId, { documentId: this.opened.documentId, version, doc: row.doc });
    this.deps.send({ type: "version", ...this.versionInfo() });
  }

  /** Undo: abort the running job; an uncommitted utterance is discarded alone (pointer unchanged). */
  undo() {
    this.abortActive("undo");
    if (this.utt && !this.utt.settled) this.utt.settled = true;
    if (this.dirty()) {
      this.restore(this.versions.get(this.current)!.doc, randomUUID(), "undo");
      this.deps.send({ type: "version", ...this.versionInfo() });
      return;
    }
    const parent = this.versions.get(this.current)?.parent;
    if (parent != null) this.moveTo(parent, "undo");
  }
  redo() {
    this.abortActive("redo");
    const t = this.redoTarget();
    if (t != null) this.moveTo(t, "redo");
  }
}

/** RFC 6902 `move` removes `from` first: a later sibling on the target path shifts up by one. */
function shiftAfterRemoval(target: string, from: string): string {
  const m = /^(.*\/children\/)(\d+)$/.exec(from);
  if (!m) return target;
  const [, prefix, idx] = m;
  if (!target.startsWith(prefix!)) return target;
  const rest = target.slice(prefix!.length);
  const n = /^(\d+)(.*)$/.exec(rest);
  if (!n || Number(n[1]) <= Number(idx)) return target;
  return `${prefix}${Number(n[1]) - 1}${n[2]}`;
}

function findNodeAt(doc: DesignDoc, path: string): { node: DesignNode; path: string } | null {
  const parts = path.split("/").slice(2); // after "/root"
  let node: DesignNode | undefined = doc.root;
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] !== "children") return null;
    node = node?.children?.[Number(parts[i + 1])];
  }
  return node ? { node, path } : null;
}
