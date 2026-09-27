import { z } from "zod";
import { DiagramKind, NodeKind, Tier } from "./primitives.js";

/** A user-defined word (ADR 0012): `phrase` draws `node` in diagrams of `kind`. */
export const VocabNode = z.object({ label: z.string().min(1).max(40), kind: NodeKind, tier: Tier.optional() });
export type VocabNode = z.infer<typeof VocabNode>;
export const VocabTerm = z.object({
  id: z.string(),
  kind: DiagramKind,
  phrase: z.string().regex(/^[a-z0-9][a-z0-9 ]{0,38}[a-z0-9]$|^[a-z0-9]$/),
  node: VocabNode,
  status: z.enum(["proposed", "confirmed"]),
});
export type VocabTerm = z.infer<typeof VocabTerm>;

/** Generic words a user can map a new term onto ("define kafka as a queue"). */
export const KIND_WORDS: Record<string, { kind: VocabNode["kind"]; tier?: VocabNode["tier"] }> = {
  queue: { kind: "queue", tier: "api" }, "message queue": { kind: "queue", tier: "api" }, stream: { kind: "queue", tier: "api" },
  database: { kind: "db", tier: "data" }, db: { kind: "db", tier: "data" }, cache: { kind: "cache", tier: "data" },
  storage: { kind: "storage", tier: "data" }, bucket: { kind: "storage", tier: "data" },
  service: { kind: "service", tier: "api" }, api: { kind: "service", tier: "api" }, server: { kind: "service", tier: "api" },
  "third party": { kind: "external", tier: "api" }, external: { kind: "external", tier: "api" }, provider: { kind: "external", tier: "api" },
  worker: { kind: "worker", tier: "api" }, job: { kind: "worker", tier: "api" }, auth: { kind: "auth", tier: "api" },
  client: { kind: "client", tier: "frontend" }, app: { kind: "client", tier: "frontend" }, frontend: { kind: "client", tier: "frontend" },
  cdn: { kind: "cdn", tier: "infra" }, host: { kind: "service", tier: "infra" }, hosting: { kind: "service", tier: "infra" },
  platform: { kind: "service", tier: "infra" }, infrastructure: { kind: "service", tier: "infra" },
  table: { kind: "entity" }, entity: { kind: "entity" }, user: { kind: "user" }, actor: { kind: "user" }, person: { kind: "user" },
};

const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Deterministic "define" commands — no model call, so defining a word never costs latency:
 *   "define kafka as a queue" · "treat kafka as a queue"
 * Only at the START of an utterance, so the lexicon and model can skip the whole utterance from its
 * first word (plan-critic M5b #1: otherwise "…as a queue" would draw a Queue before the command parses).
 * Returns null unless the target is a known kind word. ERD terms are always tables (label = phrase).
 */
export function parseDefine(text: string, kind: z.infer<typeof DiagramKind>): { phrase: string; node: VocabNode } | null {
  const t = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const m = /^(?:so\s+|okay\s+|ok\s+)?(?:define|treat)\s+((?:[a-z0-9]+\s){0,2}[a-z0-9]+)\s+as\s+(?:an?\s+|the\s+)?((?:[a-z]+\s)?[a-z]+)$/.exec(t);
  if (!m) return null;
  const phrase = m[1]!.replace(/^(?:the|a|an)\s+/, "");
  const target = KIND_WORDS[m[2]!];
  if (!target || !phrase) return null;
  if (kind === "erd") return { phrase, node: { label: phrase.replace(/\s+/g, "_"), kind: "entity" } };
  if (kind === "sequence") return { phrase, node: { label: titleCase(phrase), kind: target.kind === "entity" ? "service" : target.kind } };
  if (!target.tier) return null;
  return { phrase, node: { label: titleCase(phrase), kind: target.kind, tier: target.tier } };
}

/** First words of a vocabulary command — the lexicon and model skip such an utterance entirely. */
export const isVocabCommand = (text: string) => /^(?:so\s+|okay\s+|ok\s+|yes\s+)?(?:define|treat|confirm|lock it in)\b/i.test(text.trim());

/** "confirm" / "lock it in" / "yes confirm" — the spoken confirmation of a pending term. */
export const isConfirm = (text: string) => /(?:^|\s)(?:confirm(?:ed)?|lock it in)[.!]?\s*$/i.test(text.trim());
