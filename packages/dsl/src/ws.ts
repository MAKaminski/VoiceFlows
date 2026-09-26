import { z } from "zod";
import { PatchOp } from "./ops.js";

// Client → gateway
export const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), sessionId: z.string().optional() }),
  z.object({
    type: z.literal("partial"),
    utteranceSeq: z.number().int().nonnegative(),
    text: z.string(),
    isFinal: z.boolean(),
    tMs: z.number(), // client clock, relative to utterance start (ADR 0003)
  }),
  z.object({ type: z.literal("provisional_ops"), utteranceSeq: z.number().int(), ops: z.array(PatchOp) }),
  z.object({ type: z.literal("first_render"), jobId: z.string(), tMs: z.number() }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("redo") }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

// Gateway → client
export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), sessionId: z.string(), version: z.number().int() }),
  z.object({ type: z.literal("ops"), jobId: z.string(), ops: z.array(PatchOp) }),
  z.object({ type: z.literal("rollback"), jobId: z.string(), ops: z.array(PatchOp) }),
  z.object({ type: z.literal("status"), pending: z.string().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;
