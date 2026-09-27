import {
  applyOp, DesignDocSchema, emptyDoc, expandCompact, findNode, parseHeader, serializeCompact,
  type CompactContext, type DesignDoc, type DesignNode, type IntentHeader, type OpOrigin, type PatchOp, type ServerMsg,
} from "@livecanvas/dsl";
import { randomUUID } from "node:crypto";
import type { OpenedSession, Persistence, VersionRow } from "../persist.js";
import type { ModelClient } from "./model.js";

export interface EngineConfig { model: string; system: string; render: (vars: Record<string, string>) => string }

interface ActiveJob { id: string; abort: AbortController; baseDoc: DesignDoc; applied: number }

/**
 * One design session — the only writer of its doc (ADR 0009). Owns:
 *  - the live doc, pushed to the browser as ordered op batches;
 *  - the job controller: one model job at a time, a new job or an undo aborts the running one and
 *    restores the pre-job snapshot (exact; M3 has no provisional nodes);
 *  - versions (D12): monotonic numbers with parent pointers; undo/redo move `current`, a new job
 *    branches from `current` (critique #3).
 */
export class DocSession {
  doc: DesignDoc;
  private versions = new Map<number, VersionRow>();
  private current: number;
  private active: ActiveJob | null = null;
  private nextSeq = 0;

  constructor(
    private readonly opened: OpenedSession,
    private readonly deps: { persistence: Persistence; model: ModelClient | null; engine: EngineConfig; send: (m: ServerMsg) => void; log?: (m: string) => void },
  ) {
    for (const v of opened.versions) this.versions.set(v.version, v);
    // Invariant: a v0 always exists and `current` points at a real version (guards legacy sessions).
    if (!this.versions.has(0)) this.versions.set(0, { version: 0, parent: null, doc: emptyDoc() });
    this.current = this.versions.has(opened.current) ? opened.current : 0;
    this.doc = structuredClone(this.versions.get(this.current)!.doc);
  }

  get sessionId() { return this.opened.sessionId; }
  versionInfo() {
    return { version: this.current, canUndo: this.versions.get(this.current)?.parent != null, canRedo: this.redoTarget() != null };
  }
  snapshot(): ServerMsg { return { type: "doc", doc: this.doc, ...this.versionInfo() }; }

  /** Gateway-owned utterance numbering across typed prompts and every listening session. */
  allocSeq(): number { return this.nextSeq++; }
  reserveSeqs(upTo: number) { this.nextSeq = Math.max(this.nextSeq, upTo + 1); }

  private emitOps(jobId: string, origin: OpOrigin, ops: PatchOp[]) { if (ops.length) this.deps.send({ type: "ops", jobId, origin, ops }); }

  /** Replace the whole root with a snapshot (undo/redo/rollback) — one op, exact restore. */
  private restore(doc: DesignDoc, jobId: string, origin: OpOrigin) {
    this.doc = structuredClone(doc);
    this.emitOps(jobId, origin, [{ op: "replace", path: "/root", value: this.doc.root }]);
  }

  abortActive(reason = "superseded") {
    const job = this.active;
    if (!job) return;
    this.active = null;
    job.abort.abort();
    if (job.applied > 0) this.restore(job.baseDoc, job.id, "rollback");
    this.deps.send({ type: "job", jobId: job.id, state: "aborted", detail: reason });
    this.deps.persistence.jobEnd(this.sessionId, { id: job.id, status: "aborted" });
  }

  /** Run one model job for `text` (typed prompt or a final voice utterance). Resolves when it ends. */
  async run(text: string, source: "voice" | "typed", seq: number): Promise<void> {
    this.abortActive();
    const { persistence } = this.deps;
    const sid = this.sessionId;
    const job: ActiveJob = { id: randomUUID(), abort: new AbortController(), baseDoc: this.doc, applied: 0 };
    this.active = job;
    const t0 = performance.now();
    const utteranceId = persistence.utterance(sid, seq, source, source === "typed" ? text : undefined);
    this.deps.send({ type: "job", jobId: job.id, state: "running", text });

    if (!this.deps.model) {
      this.finish(job, "failed", "no model key configured");
      return;
    }
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
        if (this.active !== job) return; // aborted: the aborter already restored and reported
        if (!header) {
          header = parseHeader(line) ?? { a: "add", c: 0.5, s: false, x: false, t: [] };
          const intentId = randomUUID();
          persistence.intent(sid, { id: intentId, utteranceId, header, delta: 1, path: "haiku", tMs: atMs });
          persistence.jobStart(sid, { id: job.id, intentId, model: this.deps.engine.model });
          if (header.a === "none") break;
          if (header.a === "undo" && header.x) { this.finish(job, "done"); this.undo(); return; }
          if (header.a === "reset" && header.x) { this.applyValidated(job, [{ op: "replace", path: "/root", value: emptyDoc().root }], atMs, opSeq++); continue; }
          if (parseHeader(line)) continue; // a real header line carries no op
        }
        let ops: PatchOp[];
        try { ops = expandCompact(line, ctx, typeOf); }
        catch (e) { this.deps.log?.(`engine: dropped line "${line}" (${(e as Error).message})`); continue; }
        if (this.applyValidated(job, ops, atMs, opSeq)) { opSeq += ops.length; firstOpMs ??= atMs; }
      }
      if (this.active !== job) return;
      const usage = await stream.usage;
      this.finish(job, "done", undefined, firstOpMs, usage);
    } catch (e) {
      if (this.active !== job) return; // abort surfaces as an exception from fetch
      this.deps.log?.(`engine: job failed (${(e as Error).message})`);
      if (job.applied > 0) this.restore(job.baseDoc, job.id, "rollback");
      this.finish(job, "failed", (e as Error).message);
    }
  }

  /** Apply ops to a candidate doc, validate the whole doc, then commit and push — or drop. */
  private applyValidated(job: ActiveJob, ops: PatchOp[], atMs: number, seq: number): boolean {
    let candidate = this.doc;
    try { for (const op of ops) candidate = applyOp(candidate, op); }
    catch (e) { this.deps.log?.(`engine: dropped ops (${(e as Error).message})`); return false; }
    if (!DesignDocSchema.safeParse(candidate).success) { this.deps.log?.("engine: dropped ops (doc failed validation)"); return false; }
    this.doc = candidate;
    job.applied += ops.length;
    this.emitOps(job.id, "model", ops);
    ops.forEach((op, i) => this.deps.persistence.op(this.sessionId, {
      jobId: job.id, seq: seq + i, op, tMs: atMs,
      primitive: op.op === "add" && typeof op.value === "object" && op.value && "type" in op.value ? String((op.value as DesignNode).type) : null,
    }));
    return true;
  }

  private finish(job: ActiveJob, state: "done" | "failed", detail?: string, firstOpMs?: number, usage?: { inputTokens: number; outputTokens: number }) {
    if (this.active === job) this.active = null;
    if (state === "done" && job.applied > 0) {
      const version = Math.max(0, ...this.versions.keys()) + 1;
      const row: VersionRow = { version, parent: this.current, doc: structuredClone(this.doc) };
      this.versions.set(version, row);
      this.current = version;
      this.deps.persistence.version(this.sessionId, { documentId: this.opened.documentId, version, parent: row.parent, doc: row.doc, jobId: job.id });
      this.deps.persistence.setCurrent(this.sessionId, { documentId: this.opened.documentId, version, doc: row.doc });
      this.deps.send({ type: "version", ...this.versionInfo() });
    }
    this.deps.persistence.jobEnd(this.sessionId, { id: job.id, status: state, ...usage });
    this.deps.send({ type: "job", jobId: job.id, state, firstOpMs, opCount: job.applied, detail });
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

  /** Undo aborts any running job first, so no late op can land on the restored doc (critique #1). */
  undo() {
    this.abortActive("undo");
    const parent = this.versions.get(this.current)?.parent;
    if (parent != null) this.moveTo(parent, "undo");
  }
  redo() {
    this.abortActive("redo");
    const t = this.redoTarget();
    if (t != null) this.moveTo(t, "redo");
  }
}
