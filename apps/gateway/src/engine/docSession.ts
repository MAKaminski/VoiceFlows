import {
  applyOp, DesignDocSchema, docKind, refreshProvisional, emptyProject, emptyView, expandCompact, mapOpPaths, toProject, toProjectPath, viewDoc, VIEWS, viewCount, withView, findNode, isConfirm, isModifier, isVocabCommand, kindFeature, kindKey, lexicon,
  lexTokens, occurrenceKeys, parseDefine, parseHeader, serializeCompact, type CompactContext, type DesignDoc, type DesignNode, type DocKind, type FeatureKey,
  type Flags, type IntentHeader, type VersionSummary, type WordMark, type OpOrigin, type PatchOp, type ServerMsg, type VocabNode, type VocabTerm,
} from "@livecanvas/dsl";
import { randomUUID } from "node:crypto";
import type { OpenedSession, Persistence, VersionRow } from "../persist.js";
import type { ModelClient } from "./model.js";
import { decisionsToLines, planDecisions } from "./decisions.js";
import type { JevClient } from "./jev.js";

export interface EngineConfig { model: string; system: string; render: (vars: Record<string, string>) => string }
export interface Tunables { minGapMs: number; callsPerMin: number; burst: number; silenceSettleMs: number }
/** silenceSettleMs: commit after this much audio silence since the last word, without waiting for Flux's
 *  end-of-turn signal (~685 ms after the last word, whatever eager_eot_threshold is). 0 = off. The test
 *  sentence's longest natural pause is 240 ms (2026-09-27). */
export const DEFAULT_TUNABLES: Tunables = { minGapMs: 150, callsPerMin: 20, burst: 2, silenceSettleMs: 400 };

type JobKind = "typed" | "speculative" | "settle";
const BRIEF_CHARS = 480; // ≈ 120 tokens — the project-context cap (ADR 0016 cost math)
interface ActiveJob {
  id: string; kind: JobKind; text: string; abort: AbortController; baseDoc: DesignDoc; applied: number;
  lexOps: PatchOp[]; trigMs?: number;
  view: DocKind; // the view the job edits — pinned, so switching views mid-call never misroutes its ops (ADR 0016)
  protectedIds: Set<string>; // nodes this job folded a re-add into — its later `-` lines must not delete them
  todo?: string[]; // the uncovered words (occurrence keys) that started this voice job
  started?: boolean; // generation_jobs row written (phase 0 and the model phase share one job)
}
interface Utterance {
  seq: number; baseDoc: DesignDoc; text: string; lastWordEndMs?: number;
  handled: Set<string>; // occurrence keys (`button#1`) the lexicon turned into nodes this utterance
  lexIds: Set<string>; // nodes the lexicon drew this utterance (fold targets even after commit clears provisional)
  calledFor: Set<string>; // uncovered content words already sent to the model
  labels: Map<string, { label: string; mine: boolean }>; // noun occurrence key → what it drew (transcript highlighting)
  drawnAt: Map<string, string>;
  settledWords?: number; // word count when it was committed — more words later means the speaker went on // noun occurrence key → the node the lexicon drew for it (label refresh, ADR 0017)
  lastCallAt: number; ending: boolean; settled: boolean;
}

// Content words: a new one since the last model call is what makes a speculative call worthwhile.
const CONTENT = new Set(["button", "email", "password", "username", "logo", "image", "photo", "picture", "avatar", "title", "heading", "icon",
  "card", "list", "nav", "navigation", "menu", "table", "chart", "graph", "big", "large", "small", "blue", "red", "purple", "gray", "grey",
  "white", "black", "top", "bottom", "left", "right", "center", "row", "column", "remove", "delete", "move", "bigger", "smaller", "undo", "reset", "form", "field", "input", "text", "header", "footer"]);
/**
 * Diagram content words (ADR 0011): relationships, columns and edits — what the lexicon can't draw.
 * An allowlist, not "every non-stopword", so continuous speech can't drain the call budget (plan-critic #5).
 */
const EDIT = ["remove", "delete", "rename", "move", "undo", "reset", "instead", "change", "replace", "label", "title", "called", "named"];
const DIAGRAM_CONTENT: Record<Exclude<DocKind, "screen">, Set<string>> = {
  architecture: new Set([...EDIT, "calls", "call", "talks", "sends", "send", "reads", "writes", "queries", "hits", "connects", "connected",
    "uses", "through", "via", "behind", "proxies", "caches", "publishes", "subscribes", "consumes", "enqueues", "pushes", "pulls", "streams",
    "stores", "deployed", "deploy", "hosted", "hosts", "runs", "https", "grpc", "rest", "webhook", "webhooks", "events", "async", "sync",
    "service", "services", "lambda", "functions", "microservice", "search", "analytics", "cron", "scheduler", "email", "sms", "payments", "login"]),
  erd: new Set([...EDIT, "has", "have", "many", "belongs", "references", "foreign", "key", "column", "columns", "field", "fields",
    "join", "between", "one", "id", "email", "name", "status", "price", "total", "amount", "created", "updated", "date", "timestamp",
    "type", "unique", "index", "nullable", "boolean", "count", "quantity", "role", "password", "url", "description", "slug", "owner"]),
  sequence: new Set([...EDIT, "calls", "call", "sends", "send", "requests", "request", "returns", "return", "responds", "replies", "then",
    "queries", "query", "checks", "validates", "verifies", "authenticates", "logs", "login", "signs", "submits", "clicks", "opens", "loads",
    "fetches", "saves", "stores", "writes", "reads", "creates", "updates", "deletes", "publishes", "enqueues", "notifies", "emails",
    "redirects", "renders", "streams", "forwards", "caches", "error", "fails", "ok", "token", "jwt", "session", "webhook", "charge", "pays"]),
};
/**
 * Content-word positions the lexicon did NOT handle — the only words worth a model call (M4 timeline).
 * A modifier is still waiting for its noun ("big blue … button") until 4 words pass or speech ends;
 * after that it is an edit the model must make ("make it blue").
 */
const MODIFIER_WINDOW = 4;
const uncovered = (text: string, handled: Set<string>, ending = false, kind: DocKind = "screen") => {
  const toks = lexTokens(text);
  const occ = occurrenceKeys(toks);
  const content = kind === "screen" ? CONTENT : DIAGRAM_CONTENT[kind];
  // Diagrams: a relationship word waits for its object ("the api calls … postgres") — it is pending
  // once the lexicon drew a node after it, 3 words have passed, or speech ended.
  const lastDrawn = Math.max(-1, ...toks.map((_, i) => (handled.has(occ[i]!) ? i : -1)));
  return toks.flatMap((w, i) => {
    if (!content.has(w) || handled.has(occ[i]!)) return [];
    if (kind !== "screen" && !ending && lastDrawn < i && toks.length - 1 - i < 3) return [];
    if (isModifier(w) && !ending && toks.length - 1 - i < MODIFIER_WINDOW) return [];
    return [occ[i]!];
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
  /** The whole project — what versions store and the browser mirrors (ADR 0016). */
  project: DesignDoc;
  /** The view the user is looking at and speaking to. */
  activeView: DocKind = "screen";
  /** The view the engine is working on right now: `activeView`, except while a pinned job's lines apply. */
  private focus: DocKind = "screen";
  /** The engine works on one view doc; writes flow back into the project with structural sharing. */
  get doc(): DesignDoc { return viewDoc(this.project, this.focus); }
  set doc(v: DesignDoc) { this.project = withView(this.project, this.focus, v.root); }
  /** Recent utterances across views, for the notes rewrite (ADR 0016). */
  recent: Array<{ view: DocKind; text: string }> = [];
  private commitsSinceNotes = 0;
  private notesAt = -Infinity;
  private notesRunning = false;
  tunables: Tunables = { ...DEFAULT_TUNABLES };
  private versions = new Map<number, VersionRow>();
  private current: number;
  private active: ActiveJob | null = null;
  private utt: Utterance | null = null;
  private nextSeq = 0;
  private bucket = { tokens: DEFAULT_TUNABLES.burst, at: performance.now() };
  /** Lexicon-drawn nodes the model has not edited yet — fold targets across utterances (Flux may end
   *  the turn mid-sentence, so "…button." and "logo on top" arrive as separate utterances). */
  private lexOrigin = new Set<string>();

  constructor(
    private readonly opened: OpenedSession,
    private readonly deps: {
      persistence: Persistence; model: ModelClient | null; send: (m: ServerMsg) => void; log?: (m: string) => void;
      engine: EngineConfig; // screen prompt
      engines?: Partial<Record<DocKind, EngineConfig>>; // per diagram kind (ADR 0011); falls back to `engine`
      flags?: () => Flags; // ADR 0012; absent = everything on
      notesEngine?: EngineConfig; // ADR 0016: the project-notes rewrite (background, never on the draw path)
      jev?: JevClient; // ADR 0017: typed structural decisions before (or instead of) the model call
    },
  ) {
    // Every version is upgraded on read, so old single-view docs and their history open as projects.
    for (const v of opened.versions) this.versions.set(v.version, { ...v, doc: toProject(v.doc) });
    if (!this.versions.has(0)) this.versions.set(0, { version: 0, parent: null, doc: emptyProject() });
    this.current = this.versions.has(opened.current) ? opened.current : 0;
    this.project = structuredClone(this.versions.get(this.current)!.doc);
    // Open on the first view with content (a fresh project opens on the screen).
    this.activeView = this.focus = VIEWS.find((v) => viewCount(viewDoc(this.project, v.kind).root) > 0)?.kind ?? "screen";
  }

  /** This document's user words (ADR 0012): confirmed ones draw; at most one `proposed` awaits confirm. */
  terms: VocabTerm[] = [];
  static readonly MAX_TERMS = 50;

  get sessionId() { return this.opened.sessionId; }
  get documentId() { return this.opened.documentId; }
  private flagOn(k: FeatureKey) { return this.deps.flags?.()[k] ?? true; }
  private feature(k: FeatureKey, action: "used" | "blocked") { this.deps.persistence.featureEvent(this.sessionId, k, action); }
  versionInfo() {
    return { version: this.current, canUndo: this.versions.get(this.current)?.parent != null || this.dirty(), canRedo: this.redoTarget() != null };
  }
  snapshot(): ServerMsg { return { type: "doc", doc: this.project, ...this.versionInfo() }; }
  viewMsg(): ServerMsg { return { type: "view", view: this.activeView }; }
  allocSeq(): number { return this.nextSeq++; }
  tune(t: Partial<Tunables>) { this.tunables = { ...this.tunables, ...t }; }

  private dirty() { return JSON.stringify(this.project) !== JSON.stringify(this.versions.get(this.current)!.doc); }
  /** View-doc ops → project paths of the focused view, then out to the browser. */
  private emitOps(jobId: string, origin: OpOrigin, ops: PatchOp[], trigMs?: number) {
    const f = this.focus;
    this.emitRaw(jobId, origin, ops.map((op) => mapOpPaths(op, (p) => toProjectPath(p, f))), trigMs);
  }
  private emitRaw(jobId: string, origin: OpOrigin, ops: PatchOp[], trigMs?: number) {
    if (ops.length) this.deps.send({ type: "ops", jobId, origin, ops, ...(trigMs != null ? { trigMs } : {}) });
  }
  /** Puts one view back (rollback of a job in the focused view). */
  private restoreView(doc: DesignDoc, jobId: string, origin: OpOrigin) {
    this.doc = structuredClone(doc);
    this.emitOps(jobId, origin, [{ op: "replace", path: "/root", value: this.doc.root }]);
  }
  /** Puts the whole project back (undo / redo / jump). */
  private restoreProject(doc: DesignDoc, jobId: string, origin: OpOrigin) {
    this.project = structuredClone(doc);
    this.emitRaw(jobId, origin, [{ op: "replace", path: "/root", value: this.project.root }]);
  }
  /** Runs `f` with the engine focused on `view` (a pinned job's view), then back on the active view. */
  private within<T>(view: DocKind, f: () => T): T {
    const prev = this.focus;
    this.focus = view;
    try { return f(); } finally { this.focus = prev; }
  }
  /** Every id in the project — new ids must be unique across all four views. */
  private projectIds(): Set<string> {
    const ids = new Set<string>();
    const walk = (n: DesignNode) => { ids.add(n.id); n.children?.forEach(walk); };
    walk(this.project.root);
    return ids;
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
    if (!this.flagOn("speak_to_create")) {
      if (this.utt?.seq !== seq) { this.utt = null; this.feature("speak_to_create", "blocked"); this.deps.send({ type: "error", message: "Speaking to create is turned off" }); }
      this.utt = { seq, baseDoc: this.project, text, handled: new Set(), lexIds: new Set(), calledFor: new Set(), labels: new Map(), drawnAt: new Map(), lastCallAt: -Infinity, ending: true, settled: true };
      return;
    }
    if (!this.utt || this.utt.seq !== seq) {
      if (this.utt && !this.utt.settled) this.commitUtterance();
      this.utt = { seq, baseDoc: this.project, text: "", handled: new Set(), lexIds: new Set(), calledFor: new Set(), labels: new Map(), drawnAt: new Map(), lastCallAt: -Infinity, ending: false, settled: false };
    }
    const u = this.utt;
    // Speech resumed after an early settle (silence rule or Flux TurnResumed): reopen the utterance as a
    // new part. Any new word counts — before, only model-worthy words did, so nouns the lexicon draws were
    // dropped for the rest of the turn.
    const grew = u.settledWords != null && lexTokens(text).length > u.settledWords;
    if (u.settled && !isVocabCommand(text) && (grew || (!isFinal && uncovered(text, u.handled, true, docKind(this.doc)).some((k) => !u.calledFor.has(k))))) {
      u.settled = false; u.ending = false; u.baseDoc = this.project;
    }
    if (u.settled) return;
    u.text = text;
    u.lastWordEndMs = lastWordEndMs ?? u.lastWordEndMs;

    // "define kafka as a queue" / "confirm": a vocabulary command — no drawing, no model call (ADR 0012).
    if (isVocabCommand(text)) {
      if (isFinal || eager) this.vocabCommand(u);
      return;
    }

    // Tier 0: lexicon → provisional nodes, no model call (ADR 0001/0009).
    // Naming another view switches to it and draws there; nothing in the old view is touched (ADR 0016).
    const allowed = (k: DocKind) => this.flagOn("projects") && this.flagOn(kindFeature(k));
    let lex = lexicon(text, this.doc, u.handled, this.terms, allowed, this.projectIds());
    if (lex.view) { this.setView(lex.view); lex = lexicon(text, this.doc, u.handled, this.terms, allowed, this.projectIds()); }
    for (const k of lex.consumed) u.handled.add(k);
    for (const c of lex.created) u.labels.set(c.key, { label: labelOf(lex.ops, c.id), mine: !!c.mine });
    if (lex.ops.length) { this.applyLexicon(lex.ops, seq, lastWordEndMs, lex.created.map((c) => c.id)); lex.created.forEach((c) => { u.lexIds.add(c.id); this.lexOrigin.add(c.id); u.drawnAt.set(c.key, c.id); }); }
    // STT revised a word ("sign and" → "sign in"): fix the label of what the lexicon already drew.
    const fixes = refreshProvisional(text, this.doc, u.drawnAt);
    if (fixes.length) this.applyLexicon(fixes, seq, lastWordEndMs, []);

    // Final or Flux EagerEndOfTurn: the speaker (probably) stopped — settle as soon as nothing is pending.
    if (isFinal || eager) { u.ending = true; this.settleIfReady(); return; }
    this.maybeSpeculate();
  }

  /**
   * Relay-mode audio clock (ms of audio received since listening started — the clock Flux's word times
   * use). After `silenceSettleMs` of silence past the last word, with nothing pending, settle now instead
   * of waiting for Flux's end-of-turn signal.
   */
  onAudioClock(audioMs: number) {
    const u = this.utt;
    const quiet = this.tunables.silenceSettleMs;
    if (!quiet || !u || u.settled || u.ending || this.active || u.lastWordEndMs == null) return;
    if (audioMs - u.lastWordEndMs < quiet || this.pending(u).length) return;
    u.ending = true;
    this.settleIfReady();
  }

  /**
   * What each word of the current utterance did, for transcript highlighting (no model, no DB):
   * nouns and their modifiers the lexicon drew, and the content words sent to the model.
   */
  wordMarks(): WordMark[] {
    const u = this.utt;
    if (!u) return [];
    const marks: WordMark[] = [];
    for (const k of u.handled) {
      const l = u.labels.get(k);
      marks.push({ key: k, as: l?.mine ? "yours" : "drawn", ...(l ? { label: l.label } : {}) });
    }
    for (const k of u.calledFor) if (!u.handled.has(k)) marks.push({ key: k, as: "model" });
    return marks;
  }

  private pending(u: Utterance) { return uncovered(u.text, u.handled, u.ending, docKind(this.doc)).filter((k) => !u.calledFor.has(k)); }

  private maybeSpeculate(force = false) {
    const u = this.utt;
    if (!u || u.settled || this.active || (!this.deps.model && !this.deps.jev)) return;
    const todo = this.pending(u);
    if (!todo.length) return;
    if (!force && performance.now() - u.lastCallAt < this.tunables.minGapMs) return;
    if (!this.takeCall() && !force) return; // the end-of-utterance call may overdraw by one
    todo.forEach((k) => u.calledFor.add(k));
    u.lastCallAt = performance.now();
    void this.runJob(u.ending ? "settle" : "speculative", u.text, u.seq, u.lastWordEndMs, todo).then(() => this.afterVoiceJob());
  }

  /** At (eager) end of turn: commit now if nothing is uncovered, else one forced call then commit. */
  private settleIfReady() {
    const u = this.utt;
    if (!u || u.settled || this.active) return;
    if (this.pending(u).length && (this.deps.model || this.deps.jev)) return this.maybeSpeculate(true);
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
    if (this.active?.view === this.focus) this.active.lexOps.push(...ops); // replayed if the running job is rolled back (critique M3 #4)
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
    u.settledWords = lexTokens(u.text).length;
    const clear: PatchOp[] = [];
    const walk = (n: DesignNode, path: string) => {
      if (n.provisional) clear.push({ op: "remove", path: `${path}/provisional` });
      n.children?.forEach((c, i) => walk(c, `${path}/children/${i}`));
    };
    walk(this.project.root, "/root"); // an utterance can span views: clear provisional flags project-wide
    if (clear.length) { for (const op of clear) this.project = applyOp(this.project, op); this.emitRaw(randomUUID(), "model", clear); }
    if (JSON.stringify(this.project) !== JSON.stringify(u.baseDoc)) {
      this.writeVersion(null);
      this.feature("speak_to_create", "used");
      this.remember(u.text);
    }
    const uid = this.deps.persistence.utterance(this.sessionId, u.seq, "voice");
    this.deps.persistence.latency(this.sessionId, { utteranceId: uid, stage: "settled", tMs: u.lastWordEndMs ?? 0 });
    this.announceVersion();
  }

  // ── Typed prompts (M3 semantics) ─────────────────────────────────────────────────────────
  async run(text: string, source: "voice" | "typed", seq: number): Promise<void> {
    this.abortActive();
    this.feature("speak_to_create", "used");
    this.remember(text);
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
      this.within(job.view, () => this.restoreView(doc, job.id, "rollback"));
    }
    this.deps.send({ type: "job", jobId: job.id, state: "aborted", kind: job.kind, detail: reason });
    this.deps.persistence.jobEnd(this.sessionId, { id: job.id, status: "aborted" });
  }

  private async runJob(kind: JobKind, text: string, seq: number, trigMs?: number, todo?: string[]): Promise<void> {
    const { persistence } = this.deps;
    const sid = this.sessionId;
    const job: ActiveJob = { id: randomUUID(), kind, text, abort: new AbortController(), baseDoc: this.doc, applied: 0, lexOps: [], trigMs, protectedIds: new Set(), view: this.activeView, ...(todo ? { todo } : {}) };
    this.active = job;
    const utteranceId = persistence.utterance(sid, seq, kind === "typed" ? "typed" : "voice", kind === "typed" ? text : undefined);
    this.deps.send({ type: "job", jobId: job.id, state: "running", kind, text });
    const dk = docKind(this.doc);
    const aliases = new Map<string, string>();
    const ctx: CompactContext = {
      resolve: (ref) => (ref === "root" ? "/root" : findNode(this.doc.root, aliases.get(ref) ?? ref)?.path ?? null),
      assignId: (alias) => {
        const base = `n_${alias.toLowerCase().replace(/^n_/, "").replace(/[^a-z0-9_]/g, "") || "node"}`;
        let id = base, n = 2;
        while (findNode(this.project.root, id) || [...aliases.values()].includes(id)) id = `${base}_${n++}`;
        aliases.set(alias, id);
        return id;
      },
      idOf: (ref) => aliases.get(ref) ?? (findNode(this.doc.root, ref) ? ref : null),
    };
    const typeOf = (ref: string) => findNode(this.doc.root, aliases.get(ref) ?? ref)?.node.type ?? null;
    let opSeq = 0, firstOpMs: number | undefined;

    // ── Phase 0 (ADR 0017): Jev decides the structural part (~90 ms); Haiku only for what's left. ──
    if (kind !== "typed" && this.deps.jev && this.flagOn("jev_decisions")) {
      const r = await this.jevPhase(job, text, seq, utteranceId, (line, atMs) => {
        let ops: PatchOp[];
        try { ops = this.enforceEdits(job, expandCompact(line, ctx, typeOf), aliases); }
        catch (e) { this.deps.log?.(`jev: dropped line "${line}" (${(e as Error).message})`); return; }
        if (this.applyValidated(job, ops, atMs, opSeq, "jev")) {
          opSeq += ops.length;
          if (firstOpMs == null) { firstOpMs = atMs; persistence.latency(sid, { jobId: job.id, stage: "first_op", tMs: atMs }); }
        }
      });
      if (this.active !== job) return;
      if (r === "covered") return this.finish(job, "done", undefined, firstOpMs);
    }
    if (!this.deps.model) return this.finish(job, "failed", "no model key configured");
    const engine = this.deps.engines?.[dk] ?? this.deps.engine;
    const stream = this.deps.model({
      model: engine.model,
      system: engine.system,
      user: engine.render({ project_brief: this.brief(), doc_compact: compactFor(this.doc) || `(empty ${dk === "screen" ? "screen" : "diagram"}: root)`, partial_text: text }),
      signal: job.abort.signal,
    });

    let header: IntentHeader | null = null;
    try {
      for await (const { line, atMs } of stream.lines) {
        if (this.active !== job) return;
        this.focus = job.view; // pinned: this line edits the job's view even if the user switched away
        try {
        if (!header) {
          const parsed = parseHeader(line);
          header = parsed ?? { a: "add", c: 0.5, s: false, x: false, t: [] };
          const intentId = randomUUID();
          persistence.intent(sid, { id: intentId, utteranceId, header, delta: 1, path: "haiku", tMs: atMs });
          if (!job.started) { job.started = true; persistence.jobStart(sid, { id: job.id, intentId, model: engine.model }); }
          if (header.a === "none") break;
          if (header.a === "undo" && header.x) { this.finish(job, "done"); this.undo(); return; }
          if (header.a === "reset" && header.x) { this.applyValidated(job, [{ op: "replace", path: "/root", value: emptyView(dk) }], atMs, opSeq++); continue; } // "start over" clears this view only
          if (parsed) continue;
        }
        let ops: PatchOp[];
        try { ops = this.enforceEdits(job, expandCompact(line, ctx, typeOf), aliases); }
        catch (e) { this.deps.log?.(`engine: dropped line "${line}" (${(e as Error).message})`); continue; }
        if (this.applyValidated(job, ops, atMs, opSeq)) {
          opSeq += ops.length;
          if (firstOpMs == null) { firstOpMs = atMs; persistence.latency(sid, { jobId: job.id, stage: "first_op", tMs: atMs }); }
        }
        } finally { this.focus = this.activeView; }
      }
      if (this.active !== job) return;
      const usage = await stream.usage;
      this.finish(job, "done", undefined, firstOpMs, usage);
    } catch (e) {
      if (this.active !== job) return;
      this.deps.log?.(`engine: job failed (${(e as Error).message})`);
      if (job.applied > 0) this.within(job.view, () => this.restoreView(job.baseDoc, job.id, "rollback"));
      this.finish(job, "failed", (e as Error).message);
    }
  }

  /**
   * Phase 0 of a voice job (ADR 0017): one Jev request decides connections, direction, style, cardinality
   * and "on top" moves; confident answers are applied as ordinary compact lines through `apply`. Returns
   * "covered" when every word that started the job is now handled (no model call needed).
   */
  private async jevPhase(job: ActiveJob, text: string, seq: number, utteranceId: string, apply: (line: string, atMs: number) => void): Promise<"covered" | "partial" | "skipped"> {
    const plan = this.within(job.view, () => planDecisions(this.doc, job.view, text));
    if (!plan) return "skipped";
    let res: { answers: Record<string, never>; ms: number } | Awaited<ReturnType<JevClient>>;
    if (!Object.keys(plan.questions).length) res = { answers: {}, ms: 0 }; // decided by grammar alone ("logo on top")
    else {
      try { res = await this.deps.jev!({ state: plan.state, questions: plan.questions, signal: job.abort.signal }); }
      catch (e) { this.deps.log?.(`jev: fell back to the model (${(e as Error).message})`); return "skipped"; }
    }
    if (this.active !== job) return "skipped";
    const cols = (id: string) => (findNode(this.doc.root, id)?.node.props.cols as string[] | undefined) ?? [];
    const d = this.within(job.view, () => decisionsToLines(plan, res.answers, cols));
    const u = this.utt?.seq === seq ? this.utt : null;
    if (d.lines.length) {
      const intentId = randomUUID();
      this.deps.persistence.intent(this.sessionId, { id: intentId, utteranceId, header: { a: "add", c: 1, s: false, x: false, t: [] }, delta: 1, path: "jev", tMs: res.ms });
      job.started = true;
      this.deps.persistence.jobStart(this.sessionId, { id: job.id, intentId, model: "jev" });
      this.focus = job.view;
      try { for (const line of d.lines) apply(line, res.ms); } finally { this.focus = this.activeView; }
    }
    for (const k of d.covered) { u?.handled.add(k); u?.labels.set(k, { label: "a connection", mine: false }); }
    this.deps.log?.(`jev: ${Math.round(res.ms)} ms · ${d.accepted} decided · ${d.unsure} unsure · ${d.lines.length} ops`);
    const todo = job.todo ?? [];
    const done = todo.length > 0 && todo.every((k) => d.covered.includes(k) || u?.handled.has(k));
    return done ? "covered" : "partial";
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
      // A second connection between the same two components (Jev drew it, then the model does too, maybe
      // with another label) is the same connection: update it instead (plan-critic M6 #1). Sequence
      // messages may legitimately repeat, so there only this job's own edges fold.
      if (node.type === "Edge") {
        const kids = this.doc.root.children ?? [];
        const seqView = this.doc.root.props.kind === "sequence";
        const i = kids.findIndex((c) => c.type === "Edge" && c.props.from === node.props.from && c.props.to === node.props.to && (!seqView || job.protectedIds.has(c.id)));
        if (i >= 0) {
          const hit = kids[i]!;
          for (const [a, id] of aliases) if (id === node.id) aliases.set(a, hit.id);
          job.protectedIds.add(hit.id);
          for (const [k, v] of Object.entries(node.props)) if (JSON.stringify(hit.props[k]) !== JSON.stringify(v)) out.push({ op: "replace", path: `/root/children/${i}/props/${k}`, value: v } as PatchOp);
          continue;
        }
      }
      const key = kindKey(node);
      const all: Array<{ node: DesignNode; path: string; parentPath: string }> = [];
      const walk = (n: DesignNode, path: string, parentPath: string) => {
        if (path !== "/root") all.push({ node: n, path, parentPath });
        n.children?.forEach((c, i) => walk(c, `${path}/children/${i}`, path));
      };
      walk(this.doc.root, "/root", "");
      // Fold targets by type: provisional nodes, or nodes the lexicon drew in this utterance (an eager
      // end-of-turn commit clears the flag mid-sentence — browser run, 2026-09-27).
      const lexIds = this.utt?.lexIds ?? new Set<string>();
      const provisionalOfType = all.filter((x) => (x.node.provisional || lexIds.has(x.node.id) || this.lexOrigin.has(x.node.id)) && x.node.type === node.type);
      // Diagram nodes fold only on an exact key: the lexicon's Postgres must never absorb the model's
      // Redis just because it is the only provisional Node (plan-critic #1).
      const exactOnly = node.type === "Node" || node.type === "Edge" || node.type === "Layer";
      const match = (key.includes(":") && (all.find((x) => x.node.provisional && kindKey(x.node) === key) ?? all.find((x) => kindKey(x.node) === key)))
        || (!exactOnly && provisionalOfType.length === 1 ? provisionalOfType[0] : undefined);
      if (!match) { out.push(op); continue; }
      for (const [alias, id] of aliases) if (id === node.id) aliases.set(alias, match.node.id);
      job.protectedIds.add(match.node.id);
      this.lexOrigin.delete(match.node.id); // the model has now taken ownership of it
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
  private applyValidated(job: ActiveJob, ops: PatchOp[], atMs: number, seq: number, origin: OpOrigin = "model"): boolean {
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
      // Removing a Node takes its edges with it (undo restores both via the version).
      for (const op of pruneDanglingEdges(candidate, edgeIds(this.doc))) { candidate = applyOp(candidate, op); extra.push(op); }
    } catch (e) { this.deps.log?.(`engine: dropped ops (${(e as Error).message})`); return false; }
    if (!DesignDocSchema.safeParse(candidate).success) { this.deps.log?.("engine: dropped ops (doc failed validation)"); return false; }
    this.doc = candidate;
    const all = [...ops, ...extra];
    job.applied += all.length;
    this.emitOps(job.id, origin, all, job.trigMs);
    all.forEach((op, i) => this.deps.persistence.op(this.sessionId, {
      jobId: job.id, seq: seq + i, op, tMs: atMs,
      primitive: op.op === "add" && typeof op.value === "object" && op.value && "type" in op.value ? String((op.value as DesignNode).type) : null,
    }));
    return true;
  }

  private writeVersion(jobId: string | null) {
    const version = Math.max(0, ...this.versions.keys()) + 1;
    const row: VersionRow = { version, parent: this.current, doc: structuredClone(this.project), at: new Date().toISOString() };
    this.versions.set(version, row);
    this.current = version;
    this.redoHint = null; // a new edit starts a new branch
    this.deps.persistence.version(this.sessionId, { documentId: this.opened.documentId, version, parent: row.parent, doc: row.doc, jobId });
    this.deps.persistence.setCurrent(this.sessionId, { documentId: this.opened.documentId, version, doc: row.doc });
  }

  private finish(job: ActiveJob, state: "done" | "failed", detail?: string, firstOpMs?: number, usage?: { inputTokens: number; outputTokens: number }) {
    if (this.active === job) this.active = null;
    // Typed prompts version per job (M3); voice versions once per utterance at commit.
    if (state === "done" && job.kind === "typed" && job.applied > 0) {
      this.writeVersion(job.id);
      this.announceVersion();
    }
    this.deps.persistence.jobEnd(this.sessionId, { id: job.id, status: state, ...usage });
    this.deps.send({ type: "job", jobId: job.id, state, kind: job.kind, firstOpMs, opCount: job.applied, detail, ...usage });
  }

  /** `version` + (with the flag) the timeline — every place the pointer moves calls this. */
  private announceVersion() {
    this.deps.send({ type: "version", ...this.versionInfo() });
    if (this.flagOn("version_timeline")) this.deps.send(this.timelineMsg());
  }

  private summaries = new Map<number, VersionSummary>(); // versions are immutable: summarise each once
  /** Summaries of every version (ADR 0015) — counts only, never docs, so the message stays small. */
  timelineMsg(): Extract<ServerMsg, { type: "versions" }> {
    const ids = (d: DesignDoc) => {
      const m = new Map<string, string>();
      const walk = (n: DesignNode) => { if (n.id !== "n_root" && !n.id.startsWith("n_view_") && n.type !== "Layer") m.set(n.id, JSON.stringify(n.props)); n.children?.forEach(walk); };
      walk(d.root);
      return m;
    };
    const items = [...this.versions.values()].sort((a, b) => a.version - b.version).map((v) => {
      let s = this.summaries.get(v.version);
      if (!s) {
        const cur = ids(v.doc);
        const par = v.parent != null && this.versions.has(v.parent) ? ids(this.versions.get(v.parent)!.doc) : new Map<string, string>();
        let added = 0, removed = 0, changed = 0;
        for (const [id, p] of cur) { if (!par.has(id)) added++; else if (par.get(id) !== p) changed++; }
        for (const id of par.keys()) if (!cur.has(id)) removed++;
        // The view this version changed (the first whose subtree differs from its parent's).
        const pv = v.parent != null ? this.versions.get(v.parent)?.doc : undefined;
        const kind = VIEWS.find((x) => !pv || JSON.stringify(viewDoc(v.doc, x.kind).root) !== JSON.stringify(viewDoc(pv, x.kind).root))?.kind ?? "screen";
        s = { version: v.version, parent: v.parent, ...(v.at ? { at: v.at } : {}), kind, nodes: cur.size, added, removed, changed };
        this.summaries.set(v.version, s);
      }
      return s;
    });
    const path = new Set<number>();
    for (let v: number | null | undefined = this.current; v != null; v = this.versions.get(v)?.parent) path.add(v);
    for (let v = this.redoTarget(this.current); v != null && !path.has(v); v = this.redoTarget(v)) path.add(v);
    return { type: "versions", current: this.current, path: [...path].sort((a, b) => a - b), items: items.slice(-200) };
  }

  /** Jump to any version (ADR 0015) — the undo/redo path; the next edit branches from it. */
  gotoVersion(version: number) {
    if (!this.versions.has(version)) return;
    this.abortActive("goto");
    if (this.utt && !this.utt.settled) this.utt.settled = true; // an uncommitted utterance is discarded, as with undo
    // Redo retraces the jump: from an ancestor, redo walks back toward where we came from (plan-critic #3).
    if (this.isAncestor(version, this.current)) this.redoHint = this.current;
    this.moveTo(version, "goto");
    this.feature("version_timeline", "used");
  }

  /** Version redo moves to from `from`: toward the jump origin if we jumped back, else the newest child. */
  private redoTarget(from: number = this.current): number | null {
    const hint = this.redoHint;
    if (hint != null && hint !== from && this.isAncestor(from, hint)) {
      let v: number | null | undefined = hint;
      while (v != null && this.versions.get(v)?.parent !== from) v = this.versions.get(v)?.parent;
      if (v != null) return v;
    }
    let best: number | null = null;
    for (const v of this.versions.values()) if (v.parent === from && (best == null || v.version > best)) best = v.version;
    return best;
  }
  private redoHint: number | null = null;
  private isAncestor(a: number, b: number): boolean {
    for (let v: number | null | undefined = this.versions.get(b)?.parent; v != null; v = this.versions.get(v)?.parent) if (v === a) return true;
    return false;
  }

  private moveTo(version: number, origin: "undo" | "redo" | "goto") {
    const row = this.versions.get(version);
    if (!row) return;
    this.current = version;
    this.lexOrigin.clear(); // stale lexicon ids from another version must not become fold targets
    this.restoreProject(row.doc, randomUUID(), origin);
    this.deps.persistence.setCurrent(this.sessionId, { documentId: this.opened.documentId, version, doc: row.doc });
    this.announceVersion();
  }

  /** Undo: abort the running job; an uncommitted utterance is discarded alone (pointer unchanged). */
  undo() {
    this.abortActive("undo");
    if (this.utt && !this.utt.settled) this.utt.settled = true;
    if (this.dirty()) {
      this.restoreProject(this.versions.get(this.current)!.doc, randomUUID(), "undo");
      this.announceVersion();
      return;
    }
    const parent = this.versions.get(this.current)?.parent;
    if (parent != null) { this.redoHint ??= this.current; this.moveTo(parent, "undo"); }
  }
  redo() {
    this.abortActive("redo");
    const t = this.redoTarget();
    if (t != null) this.moveTo(t, "redo");
  }

  /** Kept for old clients: a kind request now switches to that view (ADR 0016) — nothing is replaced. */
  newDoc(kind: DocKind) { this.setView(kind); }

  /**
   * Switch the view the user speaks to (ADR 0016). Never destructive; a running model job keeps editing
   * the view it started in. Triggers a project-notes rewrite (background).
   */
  setView(view: DocKind) {
    if (view === this.activeView) { this.deps.send(this.viewMsg()); return; }
    this.activeView = this.focus = view;
    this.deps.send(this.viewMsg());
    if (view !== "screen") this.feature(kindFeature(view), "used");
    this.feature("projects", "used");
    this.maybeRewriteNotes("view");
  }

  /** Sets the project title — one version, like any edit. */
  setTitle(title: string) {
    const t = title.trim().slice(0, 80);
    const op: PatchOp = t ? { op: "add", path: "/root/props/title", value: t } : { op: "remove", path: "/root/props/title" };
    if ((this.project.root.props.title ?? "") === t) return;
    this.project = applyOp(this.project, op);
    this.emitRaw(randomUUID(), "model", [op]);
    this.writeVersion(null);
    this.announceVersion();
  }

  // ── Project context (ADR 0016) ─────────────────────────────────────────────────────────────
  /**
   * ≤ 120 tokens prepended to every model call: title, notes, and the named elements of the OTHER
   * views — so a call on the ERD knows the architecture's systems. Built in memory, no extra hop.
   */
  brief(): string {
    const p = this.project.root.props as { title?: string; notes?: string };
    const parts: string[] = [];
    if (p.title) parts.push(`Project: ${p.title}`);
    if (p.notes) parts.push(`Notes: ${p.notes}`);
    for (const v of VIEWS) {
      if (v.kind === this.focus) continue;
      const names: string[] = [];
      const walk = (n: DesignNode) => {
        const q = n.props as Record<string, unknown>;
        const name = n.type === "Node" ? q.label : n.type === "Text" || n.type === "Button" || n.type === "Input" ? (q.content ?? q.label) : undefined;
        if (typeof name === "string" && name) names.push(name);
        n.children?.forEach(walk);
      };
      walk(viewDoc(this.project, v.kind).root);
      if (names.length) parts.push(`${v.label}: ${[...new Set(names)].join(", ")}`);
    }
    const out = parts.join("\n");
    return out ? (out.length > BRIEF_CHARS ? `${out.slice(0, BRIEF_CHARS - 1)}…` : out) : "(nothing else yet)";
  }

  private remember(text: string) {
    if (!text.trim()) return;
    this.recent = [...this.recent, { view: this.activeView, text: text.trim() }].slice(-12);
    if (++this.commitsSinceNotes >= 8) this.maybeRewriteNotes("utterances");
  }

  /**
   * Background rewrite of `Project.props.notes` (≤ 80 tokens): what the user wants, distilled from
   * everything said so far — so a fact said at utterance 1 still shapes utterance 20. Never on the
   * draw path; at most one per 30 s; flag `project_notes`.
   */
  maybeRewriteNotes(reason: "view" | "utterances") {
    const engine = this.deps.notesEngine;
    if (!engine || !this.deps.model || this.notesRunning || !this.flagOn("project_notes")) return;
    if (!this.recent.length || performance.now() - this.notesAt < 30_000) return;
    this.notesRunning = true;
    this.notesAt = performance.now();
    this.commitsSinceNotes = 0;
    const jobId = randomUUID();
    const said = this.recent.map((r) => `[${r.view}] ${r.text}`).join("\n");
    const stream = this.deps.model({
      model: engine.model, system: engine.system, maxTokens: 120, signal: new AbortController().signal,
      user: engine.render({ notes: String(this.project.root.props.notes ?? "(none)"), recent: said, project_brief: this.brief() }),
    });
    this.deps.send({ type: "job", jobId, state: "running", kind: "notes", text: reason });
    void (async () => {
      let text = "";
      try {
        for await (const { line } of stream.lines) text += (text ? " " : "") + line;
        const usage = await stream.usage;
        // Plain text only: Haiku sometimes adds markdown (**Architecture:**) despite the prompt (live run 2026-09-27).
        const notes = text.replace(/[*#_`>]+/g, "").replace(/^\s*[-•]\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 560);
        if (notes && notes !== this.project.root.props.notes) {
          const op: PatchOp = { op: "add", path: "/root/props/notes", value: notes };
          this.project = applyOp(this.project, op);
          this.emitRaw(jobId, "model", [op]); // becomes part of the next version, like any edit
        }
        this.deps.send({ type: "job", jobId, state: "done", kind: "notes", ...usage });
      } catch (e) {
        this.deps.log?.(`notes: rewrite failed (${(e as Error).message})`);
        this.deps.send({ type: "job", jobId, state: "failed", kind: "notes" });
      } finally { this.notesRunning = false; }
    })();
  }

  // ── Vocabulary (ADR 0012) ────────────────────────────────────────────────────────────────
  private vocabCommand(u: Utterance) {
    u.settled = true; u.ending = true;
    const say = (message: string) => this.deps.send({ type: "error", message });
    if (!this.flagOn("custom_vocabulary")) { this.feature("custom_vocabulary", "blocked"); return say("Adding words is turned off"); }
    if (isConfirm(u.text)) {
      const p = this.terms.find((t) => t.status === "proposed");
      return p ? void this.confirmTerm(p.id) : say("Nothing to confirm — say “define <word> as a queue” first");
    }
    const kind = docKind(this.doc);
    if (kind === "screen") return say("Switch to a diagram to define words");
    const d = parseDefine(u.text, kind);
    if (!d) return say("Say “define <word> as a …” — queue, database, cache, service, external, table, user…");
    this.defineTerm(kind, d.phrase, d.node, false);
  }

  /** Adds a word. UI adds are confirmed at once (the click is the confirmation); spoken ones are proposed. */
  defineTerm(kind: Exclude<DocKind, "screen">, phrase: string, node: VocabNode, confirm: boolean): VocabTerm | null {
    const p = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
    if (!p) return null;
    if (this.terms.filter((t) => t.status === "confirmed").length >= DocSession.MAX_TERMS) {
      this.deps.send({ type: "error", message: `This document already has ${DocSession.MAX_TERMS} words` });
      return null;
    }
    const term: VocabTerm = { id: randomUUID(), kind, phrase: p, node, status: confirm ? "confirmed" : "proposed" };
    // One proposal at a time; re-defining a phrase replaces it.
    this.terms = [...this.terms.filter((t) => t.status !== "proposed" && !(t.kind === kind && t.phrase === p)), term];
    this.deps.persistence.putVocab(this.sessionId, this.documentId, term);
    this.feature("custom_vocabulary", "used");
    if (!confirm) this.deps.send({ type: "vocab_proposed", term });
    this.deps.send({ type: "vocab", terms: this.terms });
    return term;
  }

  confirmTerm(id: string) {
    const t = this.terms.find((x) => x.id === id && x.status === "proposed");
    if (!t) return;
    t.status = "confirmed";
    this.deps.persistence.putVocab(this.sessionId, this.documentId, t);
    this.feature("custom_vocabulary", "used");
    this.deps.send({ type: "vocab", terms: this.terms });
  }

  deleteTerm(id: string) {
    if (!this.terms.some((t) => t.id === id)) return;
    this.terms = this.terms.filter((t) => t.id !== id);
    this.deps.persistence.deleteVocab(this.sessionId, this.documentId, id);
    this.deps.send({ type: "vocab", terms: this.terms });
  }
}

/** The four standard lanes are named in the architecture prompt; re-sending them costs ~60 tokens a call. */
const STANDARD_LANE = /^\+Layer n_(frontend|api|data|infra) >root /;
function compactFor(doc: DesignDoc): string {
  return serializeCompact(doc.root).split("\n").filter((l) => !STANDARD_LANE.test(l)).join("\n");
}

/** Display label of a node an op batch added (label, text, alt…), for transcript tooltips. */
function labelOf(ops: PatchOp[], id: string): string {
  for (const op of ops) {
    const v = op.op === "add" ? (op.value as DesignNode) : null;
    if (v?.id === id) { const p = v.props; return String(p.label ?? p.content ?? p.alt ?? p.name ?? v.type) || v.type; }
  }
  return "";
}

const edgeIds = (doc: DesignDoc) => new Set((doc.root.children ?? []).filter((c) => c.type === "Edge").map((c) => c.id));

/** Remove ops (highest index first) for pre-existing Edges whose endpoint was just removed. A NEW edge
 *  to a missing node is not pruned — it fails validation and the line is dropped (live run 2026-09-27). */
function pruneDanglingEdges(doc: DesignDoc, before: Set<string>): PatchOp[] {
  if (doc.root.type !== "Diagram") return [];
  const ids = new Set<string>();
  const walk = (n: DesignNode) => { if (n.type === "Node") ids.add(n.id); n.children?.forEach(walk); };
  walk(doc.root);
  return (doc.root.children ?? []).flatMap((c, i) => (c.type === "Edge" && before.has(c.id) && (!ids.has(String(c.props.from)) || !ids.has(String(c.props.to))) ? [i] : []))
    .reverse().map((i) => ({ op: "remove" as const, path: `/root/children/${i}` }));
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
