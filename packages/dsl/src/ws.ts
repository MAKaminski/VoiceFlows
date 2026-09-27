import { z } from "zod";
import { DesignDocSchema } from "./doc.js";
import { PatchOp } from "./ops.js";

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
};

// Client → gateway (JSON text frames; relay-mode audio travels as binary frames alongside)
export const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), sessionId: z.string().optional() }),
  z.object({ type: z.literal("stt_start"), mode: z.enum(["direct", "relay", "webspeech"]) }),
  z.object({ type: z.literal("stt_stop") }),
  z.object({ type: z.literal("partial"), ...Transcript }),
  z.object({ type: z.literal("prompt"), text: z.string().min(1).max(2000) }), // typed prompt (M3)
  z.object({ type: z.literal("first_render"), jobId: z.string(), tMs: z.number() }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("redo") }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

/** Who produced an op batch — M4's "keep ops that still validate" rule needs origin + jobId. */
export const OpOrigin = z.enum(["model", "lexicon", "undo", "redo", "rollback"]);
export type OpOrigin = z.infer<typeof OpOrigin>;

const VersionInfo = { version: z.number().int().nonnegative(), canUndo: z.boolean(), canRedo: z.boolean() };

// Gateway → client. The gateway is the only writer of the doc (ADR 0009); the browser applies ops in order.
export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), sessionId: z.string(), version: z.number().int(), resumed: z.boolean().optional() }),
  z.object({ type: z.literal("doc"), doc: DesignDocSchema, ...VersionInfo }), // full snapshot on welcome/resume
  z.object({ type: z.literal("transcript"), ...Transcript }), // relay mode
  z.object({ type: z.literal("ops"), jobId: z.string(), origin: OpOrigin, ops: z.array(PatchOp) }),
  z.object({ type: z.literal("job"), jobId: z.string(), state: z.enum(["running", "done", "aborted", "failed"]), text: z.string().optional(), firstOpMs: z.number().optional(), opCount: z.number().int().optional(), detail: z.string().optional() }),
  z.object({ type: z.literal("version"), ...VersionInfo }),
  z.object({ type: z.literal("status"), pending: z.string().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
