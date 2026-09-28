import type { ServerMsg } from "@livecanvas/dsl";
import type { ModelClient } from "./model.js";

/**
 * Build it — AI fill (ADR 0022): a pool of Haiku workers, each rewriting ONE skeleton file with real logic.
 * Stateless: the browser sends the skeleton, files come back over the socket. Bounded three ways — concurrency,
 * a dollar budget per build and a wall-clock timeout — and a file that fails the checks keeps its skeleton.
 *
 * Cost math (Haiku 4.5, $1/M in, $5/M out): ≤ 12 files × (≤ 2k in + ≤ 2k out, max_tokens 2000)
 * = $0.024 + $0.120 = $0.144 worst case; `maxUsd` stops starting new files before that is exceeded.
 */
export interface FillFile { path: string; content: string }
export interface FillOptions {
  files: FillFile[];
  prd: string;
  model: ModelClient;
  modelName: string;
  system: string;
  render: (vars: Record<string, string>) => string;
  send: (m: ServerMsg) => void;
  concurrency?: number;
  maxUsd?: number;
  timeoutMs?: number;
}
export const FILL_PRICE = { inPerM: 1, outPerM: 5 } as const;
const PER_FILE_WORST = (2000 * FILL_PRICE.inPerM + 2000 * FILL_PRICE.outPerM) / 1e6; // $0.012
/** Only generated source files are worth a worker; everything else ships as generated. */
export const FILLABLE = /^apps\/(api\/src\/(routes|clients)\/[a-z0-9_-]+\.ts|web\/app\/page\.tsx)$/;

const exportedNames = (src: string) => [...src.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+(\w+)/g)].map((m) => m[1]!);
/**
 * Brace balance, skipping strings, template literals and comments — a cheap "did it stop mid-file" check. In JSX
 * an apostrophe is text ("Don't have an account?"), not a string, so `'` only opens strings outside .tsx.
 */
function balanced(src: string, jsx: boolean): boolean {
  let depth = 0, i = 0;
  while (i < src.length) {
    const c = src[i]!, n = src[i + 1];
    if (c === "/" && n === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2); if (i < 0) return false; i += 2; continue; }
    if (c === '"' || (c === "'" && !jsx) || c === "`") { const q = c; i++; while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1; i++; continue; }
    if (c === "{") depth++;
    if (c === "}" && --depth < 0) return false;
    i++;
  }
  return depth === 0;
}
export function checkFill(skeleton: string, out: string, path = ""): string | null {
  if (out.trim().length < 20) return "empty";
  for (const name of exportedNames(skeleton)) if (!exportedNames(out).includes(name)) return `lost export ${name}`;
  if (!balanced(out, path.endsWith(".tsx"))) return "unbalanced braces";
  return null;
}

export async function runFill(o: FillOptions): Promise<{ filled: number; failed: number; usd: number; ms: number }> {
  const t0 = performance.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 45_000);
  const maxUsd = o.maxUsd ?? 0.15;
  let usd = 0, reserved = 0, filled = 0, failed = 0, next = 0;
  const queue = o.files.filter((f) => FILLABLE.test(f.path));
  const worker = async (w: number) => {
    while (next < queue.length) {
      const f = queue[next++]!;
      // Reserve the worst case before starting, so concurrent workers can't jointly overshoot the budget.
      if (ctl.signal.aborted || usd + reserved + PER_FILE_WORST > maxUsd) { failed++; o.send({ type: "fill_file", path: f.path, worker: w, status: "failed", error: ctl.signal.aborted ? "timed out" : "budget reached" }); continue; }
      reserved += PER_FILE_WORST;
      o.send({ type: "fill_file", path: f.path, worker: w, status: "writing" });
      let text = "", err: string | null = null;
      const stream = o.model({ model: o.modelName, system: o.system, user: o.render({ prd: o.prd.slice(0, 6000), path: f.path, content: f.content }), signal: ctl.signal, maxTokens: 2000, raw: true });
      try { for await (const l of stream.lines) text += `${l.line}\n`; } catch (e) { err = ctl.signal.aborted ? "timed out" : (e as Error).message.slice(0, 120); }
      const u = await stream.usage.catch(() => ({ inputTokens: 0, outputTokens: 0 }));
      reserved -= PER_FILE_WORST;
      usd += (u.inputTokens * FILL_PRICE.inPerM + u.outputTokens * FILL_PRICE.outPerM) / 1e6;
      err ??= checkFill(f.content, text, f.path);
      if (err) { failed++; o.send({ type: "fill_file", path: f.path, worker: w, status: "failed", error: err }); continue; }
      filled++;
      o.send({ type: "fill_file", path: f.path, worker: w, status: "done", content: text });
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, queue.length) }, (_, w) => worker(w + 1))); }
  finally { clearTimeout(timer); }
  const r = { filled, failed, usd: +usd.toFixed(5), ms: Math.round(performance.now() - t0) };
  o.send({ type: "fill_done", ...r });
  return r;
}
