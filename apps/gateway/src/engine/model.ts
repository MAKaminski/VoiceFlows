import { Agent, fetch as ufetch } from "undici";

export interface ModelLine { line: string; atMs: number }
export interface ModelStream {
  lines: AsyncIterable<ModelLine>;
  usage: Promise<{ inputTokens: number; outputTokens: number }>;
}
/** Streams a model reply as closed lines. Abort via `signal`. Injected so tests can fake it. */
export type ModelClient = (req: { model: string; system: string; user: string; signal: AbortSignal; maxTokens?: number }) => ModelStream;

// One keep-alive pool to api.anthropic.com for the whole gateway (M0: saves 79 ms from far clients).
const pool = new Agent({ keepAliveTimeout: 60_000, connections: 16 });

export function anthropicClient(apiKey: string): ModelClient {
  return ({ model, system, user, signal, maxTokens = 600 }) => {
    const t0 = performance.now();
    let resolveUsage!: (u: { inputTokens: number; outputTokens: number }) => void;
    const usage = new Promise<{ inputTokens: number; outputTokens: number }>((r) => (resolveUsage = r));
    async function* lines(): AsyncGenerator<ModelLine> {
      let inputTokens = 0, outputTokens = 0;
      try {
        const res = await ufetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          dispatcher: pool,
          signal,
          headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model, max_tokens: maxTokens, stream: true,
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: user }],
          }),
        });
        if (!res.ok || !res.body) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const decoder = new TextDecoder();
        let sse = "", text = "";
        for await (const chunk of res.body) {
          sse += decoder.decode(chunk as Uint8Array, { stream: true });
          let idx;
          while ((idx = sse.indexOf("\n\n")) >= 0) {
            const data = sse.slice(0, idx).split("\n").find((x) => x.startsWith("data: "))?.slice(6);
            sse = sse.slice(idx + 2);
            if (!data) continue;
            const m = JSON.parse(data);
            if (m.type === "message_start") inputTokens = m.message.usage.input_tokens + (m.message.usage.cache_read_input_tokens ?? 0);
            else if (m.type === "message_delta") outputTokens = m.usage?.output_tokens ?? outputTokens;
            else if (m.type === "content_block_delta" && m.delta.type === "text_delta") {
              text += m.delta.text;
              let nl;
              while ((nl = text.indexOf("\n")) >= 0) {
                const line = text.slice(0, nl).trim();
                text = text.slice(nl + 1);
                if (line && !line.startsWith("```")) yield { line, atMs: performance.now() - t0 };
              }
            }
          }
        }
        if (text.trim() && !text.trim().startsWith("```")) yield { line: text.trim(), atMs: performance.now() - t0 };
      } finally {
        resolveUsage({ inputTokens, outputTokens });
      }
    }
    return { lines: lines(), usage };
  };
}

/**
 * Hedged requests for tail latency (M4: single slow Haiku calls failed runs at TTFV-1 1.1–1.8 s).
 * If the primary stream has not produced its first line within `hedgeMs`, an identical second call
 * starts; whichever yields a first line first wins and the other is aborted. Usage is the SUM of both
 * (an aborted call still bills its input tokens), so $/min in the HUD stays honest.
 */
export function hedgedClient(inner: ModelClient, hedgeMs: number, onHedge?: (won: boolean) => void): ModelClient {
  return (req) => {
    const ctlA = new AbortController(), ctlB = new AbortController();
    const cascade = () => { ctlA.abort(); ctlB.abort(); };
    if (req.signal.aborted) cascade(); else req.signal.addEventListener("abort", cascade, { once: true });
    const a = inner({ ...req, signal: ctlA.signal });
    let b: ModelStream | null = null;
    let resolveUsage!: (u: { inputTokens: number; outputTokens: number }) => void;
    const usage = new Promise<{ inputTokens: number; outputTokens: number }>((r) => (resolveUsage = r));

    async function* lines(): AsyncGenerator<ModelLine> {
      const itA = a.lines[Symbol.asyncIterator]();
      let itB: AsyncIterator<ModelLine> | null = null;
      const pA = itA.next();
      pA.catch(() => {});
      let winner = itA;
      let first: IteratorResult<ModelLine>;
      const timer = new Promise<"hedge">((r) => setTimeout(() => r("hedge"), hedgeMs));
      const r1 = await Promise.race([pA.then((v) => ({ src: "a" as const, v })), timer]);
      if (r1 === "hedge" && !req.signal.aborted) {
        b = inner({ ...req, signal: ctlB.signal });
        itB = b.lines[Symbol.asyncIterator]();
        const pB = itB.next();
        pB.catch(() => {});
        const r2 = await Promise.race([pA.then((v) => ({ src: "a" as const, v })), pB.then((v) => ({ src: "b" as const, v }))]);
        if (r2.src === "b") { ctlA.abort(); winner = itB; } else ctlB.abort();
        onHedge?.(r2.src === "b");
        first = r2.v;
      } else {
        first = (r1 as { v: IteratorResult<ModelLine> }).v;
      }
      try {
        if (!first.done) yield first.value;
        for (let n = await winner.next(); !n.done; n = await winner.next()) yield n.value;
      } finally {
        // The reader may stop early ("none 0", a superseded job): close both inner streams first. Their
        // usage settles only when their generators finish, so awaiting it on a suspended stream deadlocked
        // the job — and every later model call in that session (found in M7, 2026-09-28). Closing also
        // releases the pooled connection.
        ctlA.abort(); ctlB.abort();
        await Promise.allSettled([itA.return?.(undefined), itB?.return?.(undefined)]);
        const [ua, ub] = await Promise.all([a.usage, b ? (b as ModelStream).usage : Promise.resolve({ inputTokens: 0, outputTokens: 0 })]);
        resolveUsage({ inputTokens: ua.inputTokens + ub.inputTokens, outputTokens: ua.outputTokens + ub.outputTokens });
      }
    }
    return { lines: lines(), usage };
  };
}
