import { emptyDoc } from "@livecanvas/dsl";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/** Seeded by migrate.ts until magic-link auth lands in M5 (ASSUMPTIONS.md, 2026-09-26). */
export const ANON_EMAIL = "anonymous@livecanvas.local";

export interface Segment { utteranceSeq: number; text: string; isFinal: boolean; tMs: number }

/**
 * Transcript persistence, always off the hot path: `record` returns immediately and writes are
 * chained per session so rows land in order. Failures are logged, never thrown to the caller.
 */
export interface Persistence {
  openSession(): Promise<string>;
  setProvider(sessionId: string, provider: string): void;
  record(sessionId: string, seg: Segment): void;
  endSession(sessionId: string): void;
  flush(): Promise<void>;
}

export function memoryPersistence(): Persistence & { rows: Array<Segment & { sessionId: string }> } {
  const rows: Array<Segment & { sessionId: string }> = [];
  return {
    rows,
    openSession: async () => randomUUID(),
    setProvider: () => {},
    record: (sessionId, seg) => void rows.push({ sessionId, ...seg }),
    endSession: () => {},
    flush: async () => {},
  };
}

export function pgPersistence(sql: postgres.Sql, log: (e: unknown) => void = console.error, info: (m: string) => void = () => {}): Persistence {
  const chains = new Map<string, Promise<unknown>>();
  const utterances = new Map<string, string>(); // `${sessionId}:${seq}` → utterance id
  const enqueue = (sessionId: string, job: () => Promise<unknown>) => {
    const next = (chains.get(sessionId) ?? Promise.resolve()).then(job).catch(log);
    chains.set(sessionId, next);
  };

  return {
    async openSession() {
      const [row] = await sql<{ id: string }[]>`
        with doc as (
          insert into design_documents (user_id, current_doc, token_set_id)
          select u.id, ${sql.json(emptyDoc() as never)}, t.id
          from users u, token_sets t where u.email = ${ANON_EMAIL} and t.name = 'default'
          returning id, user_id)
        insert into sessions (user_id, document_id, stt_provider)
        select user_id, id, 'pending' from doc
        returning id`;
      if (!row) throw new Error("seed rows missing: run migrate (anonymous user + default token set)");
      return row.id;
    },
    setProvider(sessionId, provider) {
      enqueue(sessionId, () => sql`update sessions set stt_provider = ${provider} where id = ${sessionId}`);
    },
    record(sessionId, seg) {
      enqueue(sessionId, async () => {
        const key = `${sessionId}:${seg.utteranceSeq}`;
        let uid = utterances.get(key);
        if (!uid) {
          const [u] = await sql<{ id: string }[]>`
            insert into utterances (session_id, seq) values (${sessionId}, ${seg.utteranceSeq})
            on conflict (session_id, seq) do update set seq = excluded.seq
            returning id`;
          uid = u!.id;
          utterances.set(key, uid);
        }
        await sql`insert into transcript_segments (utterance_id, is_final, text, t_ms)
                  values (${uid}, ${seg.isFinal}, ${seg.text}, ${Math.round(seg.tMs)})`;
        if (seg.isFinal) {
          await sql`update utterances set final_text = ${seg.text}, finalized_at = now() where id = ${uid}`;
          info(`persist: session ${sessionId} utterance ${seg.utteranceSeq} finalized (${seg.text.split(/\s+/).length} words)`);
        }
      });
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
  };
}
