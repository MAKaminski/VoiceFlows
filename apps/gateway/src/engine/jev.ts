import { Agent, fetch as ufetch } from "undici";

/**
 * TypeSafe Jev — a typed-decision "System One" model (ADR 0017). It answers named questions in one pass:
 * Choice (pick one of ≤ 255 options), Noul (probability a statement is true), Score. It never writes
 * text, so it can't invent components. Bake-off from Railway sfo: p50 90 ms, 97.9 % correct, 100 % when
 * confidence ≥ 0.8 (docs/m6/2026-09-27-jev-bakeoff-railway-sfo.json).
 */
export type JevQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string };
export type JevAnswer =
  | { type: "choice"; choice: string; confidence: number }
  | { type: "noul"; noul: number };
export interface JevResult { answers: Record<string, JevAnswer>; ms: number; inputTokens: number }
/** Injected so tests can fake it. Rejects on timeout or HTTP error — callers fall back to Haiku. */
export type JevClient = (req: { state: string; questions: Record<string, JevQuestion>; signal?: AbortSignal }) => Promise<JevResult>;

const pool = new Agent({ keepAliveTimeout: 60_000, connections: 8 });

export function typesafeJev(apiKey: string, timeoutMs = 1_500): JevClient {
  return async ({ state, questions, signal }) => {
    const t0 = performance.now();
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await ufetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST", dispatcher: pool, signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
    });
    const body = (await res.json()) as { answers?: Record<string, { type: string; choice?: string; confidence?: number; noul?: number }>; usage?: { input_tokens?: number } };
    if (!res.ok || !body.answers) throw new Error(`jev ${res.status}`);
    const answers: Record<string, JevAnswer> = {};
    for (const [k, a] of Object.entries(body.answers)) {
      answers[k] = a.type === "noul" ? { type: "noul", noul: a.noul ?? 0 } : { type: "choice", choice: a.choice ?? "", confidence: a.confidence ?? 0 };
    }
    return { answers, ms: performance.now() - t0, inputTokens: body.usage?.input_tokens ?? 0 };
  };
}
