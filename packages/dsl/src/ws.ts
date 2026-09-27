import { z } from "zod";
import { DesignDocSchema, DocKind } from "./doc.js";
import { PatchOp } from "./ops.js";
import { Flags } from "./features.js";
import { DiagramKind } from "./primitives.js";
import { VocabNode, VocabTerm } from "./vocabulary.js";

/** Response of `POST /stt/token` (ADR 0008): how this browser should get speech-to-text. */
export const SttGrant = z.discriminatedUnion("mode", [
  // Browser → Deepgram directly with a short-lived JWT (needs a key allowed to call /v1/auth/grant).
  z.object({ mode: z.literal("direct"), provider: z.literal("deepgram-flux"), url: z.string().url(), token: z.string(), expiresIn: z.number() }),
  // Browser → gateway (binary 80 ms PCM frames) → Deepgram; the key never leaves the server.
  z.object({ mode: z.literal("relay"), provider: z.literal("deepgram-flux") }),
  // No STT key configured: browser Web Speech API (Chrome/Edge), dev only.
  z.object({ mode: z.literal("webspeech") }),
]);
export type SttGrant = z.infer<typeof SttGrant>;

const Transcript = {
  utteranceSeq: z.number().int().nonnegative(),
  text: z.string(),
  isFinal: z.boolean(),
  tMs: z.number(), // ms since this session's audio started (client clock in direct/webspeech, gateway clock in relay)
  lastWordEndMs: z.number().optional(), // audio-clock end of the newest word (Flux word timings) — TTFV anchor
  eager: z.boolean().optional(), // Flux EagerEndOfTurn: probably finished speaking (settle early)
};

// Client → gateway (JSON text frames; relay-mode audio travels as binary frames alongside)
export const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), sessionId: z.string().optional() }),
  z.object({ type: z.literal("stt_start"), mode: z.enum(["direct", "relay", "webspeech"]) }),
  z.object({ type: z.literal("stt_stop") }),
  z.object({ type: z.literal("partial"), ...Transcript }),
  z.object({ type: z.literal("prompt"), text: z.string().min(1).max(2000) }), // typed prompt (M3)
  z.object({ type: z.literal("first_render"), jobId: z.string(), tMs: z.number() }),
  // Dev HUD sliders (M4): per-session scheduler tunables.
  z.object({ type: z.literal("tune"), minGapMs: z.number().int().min(0).max(5000).optional(), callsPerMin: z.number().int().min(1).max(120).optional() }),
  // Client-measured per-utterance metrics (reflows need real layout).
  z.object({ type: z.literal("metrics"), utteranceSeq: z.number().int(), reflows: z.number().int().nonnegative(), maxReflowsPerElement: z.number().int().nonnegative() }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("redo") }),
  // Start a new blank doc of a kind (screen or one of the three diagrams, ADR 0011). Undoable.
  z.object({ type: z.literal("new_doc"), kind: DocKind }),
  // User vocabulary (ADR 0012). UI adds are confirmed at once; voice definitions arrive as proposals.
  z.object({ type: z.literal("vocab_define"), kind: DiagramKind, phrase: z.string().min(1).max(40), node: VocabNode, confirm: z.boolean().optional() }),
  z.object({ type: z.literal("vocab_confirm"), id: z.string() }),
  z.object({ type: z.literal("vocab_delete"), id: z.string() }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

/** Who produced an op batch — M4's "keep ops that still validate" rule needs origin + jobId. */
export const OpOrigin = z.enum(["model", "lexicon", "undo", "redo", "rollback"]);
export type OpOrigin = z.infer<typeof OpOrigin>;

const VersionInfo = { version: z.number().int().nonnegative(), canUndo: z.boolean(), canRedo: z.boolean() };

// Gateway → client. The gateway is the only writer of the doc (ADR 0009); the browser applies ops in order.
export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), sessionId: z.string(), version: z.number().int(), resumed: z.boolean().optional(), flags: Flags.optional() }),
  z.object({ type: z.literal("flags"), flags: Flags }), // an admin flipped a flag (ADR 0012)
  z.object({ type: z.literal("vocab"), terms: z.array(VocabTerm) }), // this document's words, after any change
  z.object({ type: z.literal("vocab_proposed"), term: VocabTerm }), // a spoken "define … as …" awaiting confirm
  z.object({ type: z.literal("doc"), doc: DesignDocSchema, ...VersionInfo }), // full snapshot on welcome/resume
  z.object({ type: z.literal("transcript"), ...Transcript }), // relay mode
  // trigMs: audio-clock time of the word that caused this batch (TTFV = render time − trigMs).
  z.object({ type: z.literal("ops"), jobId: z.string(), origin: OpOrigin, ops: z.array(PatchOp), trigMs: z.number().optional() }),
  z.object({
    type: z.literal("job"), jobId: z.string(), state: z.enum(["running", "done", "aborted", "failed"]),
    kind: z.enum(["typed", "speculative", "settle"]).optional(), text: z.string().optional(), firstOpMs: z.number().optional(),
    opCount: z.number().int().optional(), detail: z.string().optional(), inputTokens: z.number().int().optional(), outputTokens: z.number().int().optional(),
  }),
  z.object({ type: z.literal("version"), ...VersionInfo }),
  z.object({ type: z.literal("status"), pending: z.string().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
