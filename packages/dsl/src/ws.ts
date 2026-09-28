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

/** Bumped when the doc contract grows in a way an older web bundle can't parse (M7: colour tokens, Card fill). */
export const PROTOCOL = 2;

/** 128-bit random, base64url — unguessable; the link is the only credential (ADR 0013). */
export const ShareToken = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
/** Public payload of GET /share/:token. */
export const SharedDoc = z.object({ doc: DesignDocSchema, version: z.number().int().nonnegative(), updatedAt: z.string() });
export type SharedDoc = z.infer<typeof SharedDoc>;

// Client → gateway (JSON text frames; relay-mode audio travels as binary frames alongside)
export const ClientMsg = z.discriminatedUnion("type", [
  // documentId: reopen this browser's last document in a new tab (flag remember_document, ADR 0014).
  // open: the user picked this project from the library — it wins over the tab's previous session (ADR 0020).
  z.object({ type: z.literal("hello"), sessionId: z.string().optional(), documentId: z.string().uuid().optional(), open: z.boolean().optional() }),
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
  // Share links (ADR 0013): a read-only public link to the version on screen; one live link per version.
  z.object({ type: z.literal("set_view"), view: DocKind }), // speak to another view of the project (ADR 0016)
  z.object({ type: z.literal("set_title"), title: z.string().max(80) }),
  z.object({ type: z.literal("goto_version"), version: z.number().int().nonnegative() }), // version timeline (ADR 0015)
  z.object({ type: z.literal("share_create") }),
  z.object({ type: z.literal("share_revoke"), token: ShareToken }),
  // Implied suggestions (ADR 0020): approve or reject by id; `cols` narrows a column suggestion to some columns.
  z.object({ type: z.literal("suggestion_approve"), ids: z.array(z.string()).min(1).max(50), cols: z.record(z.string(), z.array(z.string())).optional() }),
  z.object({ type: z.literal("suggestion_reject"), ids: z.array(z.string()).min(1).max(50), cols: z.record(z.string(), z.array(z.string())).optional() }),
  // Project library (ADR 0020): keep this project in the shared list, optionally naming it.
  z.object({ type: z.literal("save_project"), title: z.string().max(80).optional() }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

/** Who produced an op batch — M4's "keep ops that still validate" rule needs origin + jobId. */
export const OpOrigin = z.enum(["model", "lexicon", "undo", "redo", "rollback", "goto", "jev", "approve"]);
export type OpOrigin = z.infer<typeof OpOrigin>;

/** drawn = the lexicon drew it (0 ms) · yours = drawn from the user's own word · model = sent to the model. */
export const WordMark = z.object({ key: z.string(), as: z.enum(["drawn", "yours", "model", "command"]), label: z.string().optional() });

/**
 * An implied suggestion (ADR 0020): what usually belongs with what was said, NOT in the doc until approved —
 * so versions, undo and share links never carry it. `cols` = a column suggestion for table `target` (its ops are
 * computed at approve time against the table's current columns); otherwise `lines` are compact op lines.
 */
export const Suggestion = z.object({
  id: z.string(), view: DocKind, title: z.string(), source: z.enum(["rule", "model"]),
  target: z.string().optional(), cols: z.array(z.string()).optional(), lines: z.array(z.string()).optional(),
});
export type Suggestion = z.infer<typeof Suggestion>;
export type WordMark = z.infer<typeof WordMark>;

export const VersionSummary = z.object({
  version: z.number().int().nonnegative(),
  parent: z.number().int().nonnegative().nullable(),
  at: z.string().optional(), // ISO time the version was written
  kind: DocKind,
  nodes: z.number().int().nonnegative(), // elements in the doc (Nodes, Edges, screen elements)
  added: z.number().int().nonnegative(), // vs its parent version, by node id
  removed: z.number().int().nonnegative(),
  changed: z.number().int().nonnegative(),
});
export type VersionSummary = z.infer<typeof VersionSummary>;

const VersionInfo = { version: z.number().int().nonnegative(), canUndo: z.boolean(), canRedo: z.boolean() };

// Gateway → client. The gateway is the only writer of the doc (ADR 0009); the browser applies ops in order.
export const ServerMsg = z.discriminatedUnion("type", [
  // protocol: the gateway's PROTOCOL — a tab built for an older one reloads (new tokens/props would not parse there).
  z.object({ type: z.literal("welcome"), sessionId: z.string(), documentId: z.string().optional(), version: z.number().int(), resumed: z.boolean().optional(), flags: Flags.optional(), protocol: z.number().int().optional() }),
  z.object({ type: z.literal("flags"), flags: Flags }), // an admin flipped a flag (ADR 0012)
  // This tab no longer owns the document: it was opened in another tab (ADR 0014). The socket stays open, idle.
  z.object({ type: z.literal("taken_over") }),
  z.object({ type: z.literal("view"), view: DocKind }), // the view this tab speaks to (ADR 0016)
  z.object({ type: z.literal("vocab"), terms: z.array(VocabTerm) }), // this document's words, after any change
  z.object({ type: z.literal("vocab_proposed"), term: VocabTerm }), // a spoken "define … as …" awaiting confirm
  // Transcript highlighting: which words of the client's utterance did what (occurrence keys, `word#k`).
  // This document's live share links, each pinned to the version it was created from (ADR 0013).
  z.object({ type: z.literal("shares"), links: z.array(z.object({ token: ShareToken, version: z.number().int().nonnegative() })) }),
  z.object({ type: z.literal("words"), utteranceSeq: z.number().int().nonnegative(), marks: z.array(WordMark) }),
  z.object({ type: z.literal("doc"), doc: DesignDocSchema, ...VersionInfo }), // full snapshot on welcome/resume
  z.object({ type: z.literal("transcript"), ...Transcript }), // relay mode
  // trigMs: audio-clock time of the word that caused this batch (TTFV = render time − trigMs).
  z.object({ type: z.literal("ops"), jobId: z.string(), origin: OpOrigin, ops: z.array(PatchOp), trigMs: z.number().optional() }),
  z.object({
    type: z.literal("job"), jobId: z.string(), state: z.enum(["running", "done", "aborted", "failed"]),
    kind: z.enum(["typed", "speculative", "settle", "notes", "suggest"]).optional(), text: z.string().optional(), firstOpMs: z.number().optional(),
    opCount: z.number().int().optional(), detail: z.string().optional(), inputTokens: z.number().int().optional(), outputTokens: z.number().int().optional(),
  }),
  z.object({ type: z.literal("version"), ...VersionInfo }),
  // Version timeline (ADR 0015): summaries only — never the docs themselves.
  // path = ancestors of `current` plus the redo chain ahead of it (drawn solid); `items` are the last 200.
  z.object({ type: z.literal("versions"), current: z.number().int().nonnegative(), path: z.array(z.number().int().nonnegative()), items: z.array(VersionSummary) }),
  z.object({ type: z.literal("status"), pending: z.string().nullable() }),
  z.object({ type: z.literal("suggestions"), items: z.array(Suggestion) }), // pending, all views (ADR 0020)
  // Library state of this project: saved = listed in the shared workspace (ADR 0020).
  z.object({ type: z.literal("project"), savedAt: z.string().nullable(), title: z.string().optional() }),
  // Opened from the library while another tab is editing it: never taken over — offered read-only instead.
  z.object({ type: z.literal("in_use"), documentId: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
