import { emptyDoc, type DesignDoc, type FeatureKey, type Flags, type IntentHeader, type PatchOp, type VocabTerm } from "@livecanvas/dsl";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/** Seeded by migrate.ts until magic-link auth lands in M5 (ASSUMPTIONS.md, 2026-09-26). */
export const ANON_EMAIL = "anonymous@livecanvas.local";

export interface Segment { utteranceSeq: number; text: string; isFinal: boolean; tMs: number }
export interface VersionRow { version: number; parent: number | null; doc: DesignDoc }
export interface OpenedSession { sessionId: string; documentId: string; versions: VersionRow[]; current: number }

/**
 * Persistence, always off the hot path (ARCHITECTURE §4.2): every write method returns at once and
 * is queued per session so rows land in FK order; failures are logged, never thrown. The gateway
 * generates row ids, so later rows can reference earlier ones without waiting for the database.
 * Only open/resume are awaited — they run at connect, before any speech.
 */
export interface Persistence {
  openSession(): Promise<OpenedSession>;
  resumeSession(sessionId: string): Promise<OpenedSession | null>;
  setProvider(sessionId: string, provider: string): void;
  /** Utterance row (created once per seq); returns its id immediately. */
  utterance(sessionId: string, seq: number, source: "voice" | "typed", finalText?: string): string;
  record(sessionId: string, seg: Segment): void;
  intent(sessionId: string, r: { id: string; utteranceId: string; header: IntentHeader; delta: number; path: "haiku" | "sonnet" | "fused" | "lexicon"; tMs: number }): void;
  jobStart(sessionId: string, r: { id: string; intentId: string; model: string }): void;
  op(sessionId: string, r: { jobId: string; seq: number; op: PatchOp; primitive: string | null; tMs: number }): void;
  jobEnd(sessionId: string, r: { id: string; status: "done" | "aborted" | "failed"; inputTokens?: number; outputTokens?: number }): void;
  version(sessionId: string, r: { documentId: string; version: number; parent: number | null; doc: DesignDoc; jobId: string | null }): void;
  setCurrent(sessionId: string, r: { documentId: string; version: number; doc: DesignDoc }): void;
  /** latency_events row (job- or utterance-scoped; schema CHECK requires one). tMs = audio clock. */
  latency(sessionId: string, r: { jobId?: string; utteranceId?: string; stage: string; tMs: number }): void;
  endSession(sessionId: string): void;
  flush(): Promise<void>;
  // ── Flags & usage (ADR 0012). Reads run at boot, session open and in admin calls — never mid-speech.
  loadFlags(): Promise<Partial<Flags>>;
  setFlag(key: FeatureKey, enabled: boolean): Promise<void>;
  featureEvent(sessionId: string | null, key: FeatureKey, action: FeatureAction): void;
  flagStats(days: number): Promise<Partial<Record<FeatureKey, Record<FeatureAction, number>>>>;
  // ── Vocabulary, scoped to a document until accounts exist.
  listVocab(documentId: string): Promise<VocabTerm[]>;
  putVocab(sessionId: string, documentId: string, t: VocabTerm): void;
  deleteVocab(sessionId: string, documentId: string, id: string): void;
}
export type FeatureAction = "exposed" | "used" | "blocked";

type Call = { method: string; args: unknown[] };

/** In-memory persistence for tests and DB-less dev; `calls` records every write in order. */
export function memoryPersistence(): Persistence & { rows: Array<Segment & { sessionId: string }>; calls: Call[]; events: Array<{ sessionId: string | null; key: FeatureKey; action: FeatureAction }> } {
  const rows: Array<Segment & { sessionId: string }> = [];
  const calls: Call[] = [];
  const sessions = new Map<string, OpenedSession>();
  const ids = new Map<string, string>();
  const log = (method: string) => (...args: unknown[]) => void calls.push({ method, args });
  const flags: Partial<Flags> = {};
  const events: Array<{ sessionId: string | null; key: FeatureKey; action: FeatureAction }> = [];
  const vocab = new Map<string, VocabTerm[]>();
  return {
    rows, calls, events,
    openSession: async () => {
      const s = { sessionId: randomUUID(), documentId: randomUUID(), versions: [{ version: 0, parent: null, doc: emptyDoc() }], current: 0 };
      sessions.set(s.sessionId, s);
      return structuredClone(s);
    },
    resumeSession: async (id) => (sessions.has(id) ? structuredClone(sessions.get(id)!) : null),
    setProvider: log("setProvider"),
    utterance: (sessionId, seq, source, finalText) => {
      const key = `${sessionId}:${seq}`;
      if (!ids.has(key)) { ids.set(key, randomUUID()); calls.push({ method: "utterance", args: [sessionId, seq, source, finalText] }); }
      return ids.get(key)!;
    },
    record: (sessionId, seg) => void rows.push({ sessionId, ...seg }),
    intent: log("intent"),
    jobStart: log("jobStart"),
    op: log("op"),
    jobEnd: log("jobEnd"),
    version: (sessionId, r) => {
      calls.push({ method: "version", args: [sessionId, r] });
      const s = [...sessions.values()].find((x) => x.documentId === r.documentId);
      s?.versions.push({ version: r.version, parent: r.parent, doc: structuredClone(r.doc) });
    },
    setCurrent: (sessionId, r) => {
      calls.push({ method: "setCurrent", args: [sessionId, r] });
      const s = [...sessions.values()].find((x) => x.documentId === r.documentId);
      if (s) s.current = r.version;
    },
    latency: log("latency"),
    endSession: log("endSession"),
    flush: async () => {},
    loadFlags: async () => ({ ...flags }),
    setFlag: async (key, enabled) => { flags[key] = enabled; },
    featureEvent: (sessionId, key, action) => void events.push({ sessionId, key, action }),
    flagStats: async () => {
      const out: Partial<Record<FeatureKey, Record<FeatureAction, number>>> = {};
      for (const e of events) { const r = (out[e.key] ??= { exposed: 0, used: 0, blocked: 0 }); r[e.action]++; }
      return out;
    },
    listVocab: async (documentId) => structuredClone(vocab.get(documentId) ?? []),
    putVocab: (_s, documentId, t) => {
      const list = (vocab.get(documentId) ?? []).filter((x) => x.id !== t.id && !(x.kind === t.kind && x.phrase === t.phrase));
      vocab.set(documentId, [...list, structuredClone(t)]);
    },
    deleteVocab: (_s, documentId, id) => void vocab.set(documentId, (vocab.get(documentId) ?? []).filter((x) => x.id !== id)),
  };
}

export function pgPersistence(sql: postgres.Sql, log: (e: unknown) => void = console.error, info: (m: string) => void = () => {}): Persistence {
  const chains = new Map<string, Promise<unknown>>();
  const utterances = new Map<string, string>(); // `${sessionId}:${seq}` → utterance id
  const enqueue = (sessionId: string, job: () => Promise<unknown>) => {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(job).catch(log);
    chains.set(sessionId, next);
  };
  const json = (v: unknown) => sql.json(v as never);

  const load = async (sessionId: string): Promise<OpenedSession | null> => {
    const [s] = await sql<{ document_id: string; current_version: number }[]>`
      select s.document_id, d.current_version from sessions s join design_documents d on d.id = s.document_id where s.id = ${sessionId}`;
    if (!s) return null;
    let rows = await sql<{ version: number; parent_version: number | null; doc: DesignDoc }[]>`
      select version, parent_version, doc from design_versions where document_id = ${s.document_id} order by version`;
    if (rows.length === 0) {
      // Documents created before M3 have no version rows: their current doc becomes v0.
      rows = await sql<{ version: number; parent_version: number | null; doc: DesignDoc }[]>`
        insert into design_versions (document_id, version, doc)
        select id, 0, current_doc from design_documents where id = ${s.document_id}
        returning version, parent_version, doc`;
      return { sessionId, documentId: s.document_id, current: 0, versions: rows.map((r) => ({ version: r.version, parent: r.parent_version, doc: r.doc })) };
    }
    return { sessionId, documentId: s.document_id, current: s.current_version, versions: rows.map((r) => ({ version: r.version, parent: r.parent_version, doc: r.doc })) };
  };

  return {
    async openSession() {
      const doc = emptyDoc();
      const [row] = await sql<{ session_id: string; document_id: string }[]>`
        with d as (
          insert into design_documents (user_id, current_doc, token_set_id)
          select u.id, ${json(doc)}, t.id from users u, token_sets t where u.email = ${ANON_EMAIL} and t.name = 'default'
          returning id, user_id),
        v as (insert into design_versions (document_id, version, doc) select id, 0, ${json(doc)} from d),
        s as (insert into sessions (user_id, document_id, stt_provider) select user_id, id, 'pending' from d returning id, document_id)
        select id as session_id, document_id from s`;
      if (!row) throw new Error("seed rows missing: run migrate (anonymous user + default token set)");
      return { sessionId: row.session_id, documentId: row.document_id, versions: [{ version: 0, parent: null, doc }], current: 0 };
    },
    resumeSession: (sessionId) => load(sessionId).catch((e) => { log(e); return null; }),
    setProvider(sessionId, provider) {
      enqueue(sessionId, () => sql`update sessions set stt_provider = ${provider} where id = ${sessionId}`);
    },
    utterance(sessionId, seq, source, finalText) {
      const key = `${sessionId}:${seq}`;
      let id = utterances.get(key);
      if (id) return id;
      id = randomUUID();
      utterances.set(key, id);
      const uid = id;
      enqueue(sessionId, () => sql`
        insert into utterances (id, session_id, seq, source, final_text, finalized_at)
        values (${uid}, ${sessionId}, ${seq}, ${source}, ${finalText ?? null}, ${finalText ? sql`now()` : null})
        on conflict (session_id, seq) do nothing`);
      return id;
    },
    record(sessionId, seg) {
      const uid = this.utterance(sessionId, seg.utteranceSeq, "voice");
      enqueue(sessionId, async () => {
        await sql`insert into transcript_segments (utterance_id, is_final, text, t_ms) values (${uid}, ${seg.isFinal}, ${seg.text}, ${Math.round(seg.tMs)})`;
        if (seg.isFinal) {
          await sql`update utterances set final_text = ${seg.text}, finalized_at = now() where id = ${uid}`;
          info(`persist: session ${sessionId} utterance ${seg.utteranceSeq} finalized (${seg.text.split(/\s+/).length} words)`);
        }
      });
    },
    intent(sessionId, r) {
      enqueue(sessionId, () => sql`
        insert into intents (id, utterance_id, intent, delta_score, committed, path, t_ms)
        values (${r.id}, ${r.utteranceId}, ${json(r.header)}, ${r.delta}, true, ${r.path}, ${Math.round(r.tMs)})`);
    },
    jobStart(sessionId, r) {
      enqueue(sessionId, () => sql`
        insert into generation_jobs (id, intent_id, session_id, model, status) values (${r.id}, ${r.intentId}, ${sessionId}, ${r.model}, 'running')`);
    },
    op(sessionId, r) {
      enqueue(sessionId, () => sql`
        insert into patch_ops (job_id, seq, op, path, value, primitive, applied, t_ms)
        values (${r.jobId}, ${r.seq}, ${r.op.op}, ${r.op.path}, ${"value" in r.op ? json(r.op.value) : null}, ${r.primitive}, true, ${Math.round(r.tMs)})`);
    },
    jobEnd(sessionId, r) {
      enqueue(sessionId, () => sql`
        update generation_jobs set status = ${r.status}, input_tokens = ${r.inputTokens ?? null}, output_tokens = ${r.outputTokens ?? null}, ended_at = now()
        where id = ${r.id}`);
    },
    version(sessionId, r) {
      enqueue(sessionId, () => sql`
        insert into design_versions (document_id, version, parent_version, doc, job_id)
        values (${r.documentId}, ${r.version}, ${r.parent}, ${json(r.doc)}, ${r.jobId})`);
    },
    setCurrent(sessionId, r) {
      enqueue(sessionId, () => sql`update design_documents set current_version = ${r.version}, current_doc = ${json(r.doc)} where id = ${r.documentId}`);
    },
    latency(sessionId, r) {
      enqueue(sessionId, () => sql`
        insert into latency_events (job_id, utterance_id, stage, t_ms)
        values (${r.jobId ?? null}, ${r.utteranceId ?? null}, ${r.stage}, ${Math.round(r.tMs)})`);
    },
    endSession(sessionId) {
      enqueue(sessionId, () => sql`update sessions set status = 'ended', ended_at = now() where id = ${sessionId}`);
      enqueue(sessionId, async () => {
        chains.delete(sessionId);
        for (const k of utterances.keys()) if (k.startsWith(`${sessionId}:`)) utterances.delete(k);
      });
    },
    async flush() {
      await Promise.all(chains.values());
    },
    async loadFlags() {
      const rows = await sql<{ key: FeatureKey; enabled: boolean }[]>`select key, enabled from feature_flags`;
      return Object.fromEntries(rows.map((r) => [r.key, r.enabled])) as Partial<Flags>;
    },
    async setFlag(key, enabled) {
      await sql`update feature_flags set enabled = ${enabled}, updated_at = now() where key = ${key}`;
    },
    featureEvent(sessionId, key, action) {
      enqueue(sessionId ?? "global", () => sql`insert into feature_events (feature_key, session_id, action) values (${key}, ${sessionId}, ${action})`);
    },
    async flagStats(days) {
      const rows = await sql<{ key: FeatureKey; action: FeatureAction; n: number }[]>`
        select feature_key as key, action, count(*)::int as n from feature_events
        where created_at > now() - make_interval(days => ${days}) group by 1, 2`;
      const out: Partial<Record<FeatureKey, Record<FeatureAction, number>>> = {};
      for (const r of rows) (out[r.key] ??= { exposed: 0, used: 0, blocked: 0 })[r.action] = r.n;
      return out;
    },
    async listVocab(documentId) {
      const rows = await sql<{ id: string; kind: VocabTerm["kind"]; phrase: string; node: VocabTerm["node"]; status: VocabTerm["status"] }[]>`
        select id, kind, phrase, node, status from vocabulary_terms where document_id = ${documentId} order by created_at`;
      return rows.map((r) => ({ ...r }));
    },
    putVocab(sessionId, documentId, t) {
      enqueue(sessionId, () => sql`
        insert into vocabulary_terms (id, document_id, kind, phrase, node, status, confirmed_at)
        values (${t.id}, ${documentId}, ${t.kind}, ${t.phrase}, ${json(t.node)}, ${t.status}, ${t.status === "confirmed" ? sql`now()` : null})
        on conflict (document_id, kind, phrase) do update
          set id = excluded.id, node = excluded.node, status = excluded.status, confirmed_at = excluded.confirmed_at`);
    },
    deleteVocab(sessionId, documentId, id) {
      enqueue(sessionId, () => sql`delete from vocabulary_terms where id = ${id} and document_id = ${documentId}`);
    },
  };
}
