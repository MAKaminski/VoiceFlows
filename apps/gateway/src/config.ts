import { z } from "zod";

// All tunables from env; defaults follow ADR 0001–0003 (latency re-plan, 2026-09-26).
const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const Env = z.object({
  PORT: z.coerce.number().default(8787),
  HOST: z.string().default("0.0.0.0"),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  REDIS_URL: z.string().optional(),
  MODEL_INTENT: z.string().default("claude-haiku-4-5-20251001"),
  MODEL_PATCH_FAST: z.string().default("claude-haiku-4-5-20251001"),
  MODEL_PATCH_STRUCTURAL: z.string().default("claude-sonnet-5"),
  EXTRACT_MIN_GAP_MS: z.coerce.number().default(150),
  COMMIT_THRESHOLD: z.coerce.number().default(0.35),
  PAUSE_MS: z.coerce.number().default(350),
  MIN_CONFIDENCE: z.coerce.number().default(0.6),
  FUSED_FAST_PATH: bool.default(true),
  LEXICON_TIER: bool.default(true),
  STT_DIRECT: bool.default(true),
  // Hedge a model call whose first line hasn't arrived after this many ms (0 = off). M0: TTFT p50 ≈ 480 ms.
  MODEL_HEDGE_MS: z.coerce.number().default(600),
  // Browser origins allowed to call POST /stt/token (comma list) plus an optional regex for preview deploys.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  CORS_ORIGIN_PATTERN: z.string().optional(),
  // Admin API (ADR 0012): bearer token (unset → /admin returns 503) and the ONLY browser origins allowed
  // to call it — never the preview-deploy pattern.
  ADMIN_TOKEN: z.string().min(24).optional(),
  // Invite gate (ADR 0021): shared with the web (Vercel). Unset = open (local dev, tests).
  ACCESS_SECRET: z.string().min(32).optional(),
  // TypeSafe Jev (ADR 0017): typed structural decisions; unset → the model does everything, as before.
  TYPESAFE_API_KEY: z.string().optional(),
  JEV_TIMEOUT_MS: z.coerce.number().default(250), // bake-off p95 146 ms; past this, fall back to the model
  SILENCE_SETTLE_MS: z.coerce.number().default(0), // ADR 0018: off — measured pauses (640–800 ms) outlast Flux's end-of-turn
  ADMIN_ORIGINS: z.string().default("https://live-canvas-three.vercel.app,http://localhost:3000"),
});

export type Config = z.infer<typeof Env>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => Env.parse(env);
