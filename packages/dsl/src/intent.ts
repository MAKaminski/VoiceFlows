import { z } from "zod";
import { PrimitiveType } from "./primitives.js";

export const IntentAction = z.enum(["add", "modify", "remove", "restyle", "layout", "undo", "reset", "none"]);

// Full intent (INTENT_ENGINE.md) — used by the structural/Sonnet path and persisted in INTENTS.intent.
export const Intent = z.object({
  action: IntentAction,
  targets: z.array(z.object({ ref: z.string(), primitive: PrimitiveType.optional() })),
  attributes: z.record(z.string(), z.unknown()),
  structural: z.boolean(),
  explicit_command: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type Intent = z.infer<typeof Intent>;

// Fused-path header (ADR 0001): first line of the stream, scored before any op is applied.
export const IntentHeader = z.object({
  a: IntentAction,
  t: z.array(z.string()).or(z.string()).optional(),
  c: z.number().min(0).max(1),
  s: z.boolean().optional(),
  x: z.boolean().optional(), // explicit command
});
export type IntentHeader = z.infer<typeof IntentHeader>;

export const DELTA_WEIGHTS = { action: 0.35, targets: 0.3, attributes: 0.2, structural: 0.15 } as const;

const jaccardDistance = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return 1 - inter / (a.size + b.size - inter);
};

/** Weighted delta between a candidate intent and the last committed one (INTENT_ENGINE.md). */
export function deltaScore(next: Intent, prev: Intent | null): number {
  if (!prev) return next.action === "none" ? 0 : 1;
  const targets = (i: Intent) => new Set(i.targets.map((t) => `${t.primitive ?? ""}:${t.ref}`));
  const attrs = (i: Intent) => new Set(Object.entries(i.attributes).map(([k, v]) => `${k}=${JSON.stringify(v)}`));
  const tn = targets(next), tp = targets(prev);
  const targetChanged = tn.size !== tp.size || [...tn].some((t) => !tp.has(t)) ? 1 : 0;
  return (
    DELTA_WEIGHTS.action * (next.action !== prev.action ? 1 : 0) +
    DELTA_WEIGHTS.targets * targetChanged +
    DELTA_WEIGHTS.attributes * jaccardDistance(attrs(next), attrs(prev)) +
    DELTA_WEIGHTS.structural * (next.structural !== prev.structural ? 1 : 0)
  );
}

/**
 * Compressed header line (ADR 0006): `<action> <confidence> [s] [x] [target ...]`, e.g.
 * `add .9 logo`, `layout .8 s`, `undo 1 x`, `none 0`. ≈ 5 tokens instead of ≈ 23 for JSON.
 * A leading `{` is parsed as the older JSON header. Returns null when the line is not a header.
 */
export function parseHeader(line: string): IntentHeader | null {
  const l = line.trim();
  if (l.startsWith("{")) {
    try { const h = IntentHeader.safeParse(JSON.parse(l)); return h.success ? h.data : null; } catch { return null; }
  }
  const [a, c, ...rest] = l.split(/\s+/);
  const action = IntentAction.safeParse(a);
  const conf = Number(c);
  if (!action.success || !Number.isFinite(conf) || conf < 0 || conf > 1) return null;
  const flags = new Set(rest.filter((r) => r === "s" || r === "x"));
  return { a: action.data, c: conf, s: flags.has("s"), x: flags.has("x"), t: rest.filter((r) => r !== "s" && r !== "x") };
}
