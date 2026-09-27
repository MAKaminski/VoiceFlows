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
