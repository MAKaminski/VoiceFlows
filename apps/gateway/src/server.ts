import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ClientMsg, FEATURES, FeatureKey, kindFeature, type DocKind, type ServerMsg } from "@livecanvas/dsl";
import { createHash, timingSafeEqual } from "node:crypto";
import { FlagService } from "./flags.js";
import Fastify from "fastify";
import { loadConfig, type Config } from "./config.js";
import { getSql } from "./db.js";
import { DocSession, type EngineConfig } from "./engine/docSession.js";
import { anthropicClient, hedgedClient, type ModelClient } from "./engine/model.js";
import { loadPrompt, type PromptName } from "@livecanvas/prompts";
import { memoryPersistence, pgPersistence, type Persistence } from "./persist.js";
import { PROVIDERS, type SttProvider, type SttSession } from "./stt/providers.js";
import { createSttGrant } from "./sttGrant.js";

export interface Deps {
  persistence: Persistence;
  sttGrant: ReturnType<typeof createSttGrant>;
  relayProvider: SttProvider;
  model: ModelClient | null;
  engine: EngineConfig;
  engines?: Partial<Record<DocKind, EngineConfig>>;
  flags?: FlagService;
}

export function defaultDeps(config: Config): Deps {
  const sql = getSql(config.DATABASE_URL);
  const persistence = sql ? pgPersistence(sql, console.error, (m) => console.log(m)) : memoryPersistence();
  return {
    persistence,
    flags: new FlagService(persistence, (m) => console.log(m)),
    sttGrant: createSttGrant(config),
    relayProvider: PROVIDERS["deepgram-flux"]!,
    model: config.ANTHROPIC_API_KEY
      ? (config.MODEL_HEDGE_MS > 0
        ? hedgedClient(anthropicClient(config.ANTHROPIC_API_KEY), config.MODEL_HEDGE_MS, (won) => console.log(`model: hedged call started (${won ? "hedge won" : "primary won"})`))
        : anthropicClient(config.ANTHROPIC_API_KEY))
      : null,
    engine: engineFor("fused_system", config),
    engines: {
      architecture: engineFor("diagram_architecture", config),
      erd: engineFor("diagram_erd", config),
      sequence: engineFor("diagram_sequence", config),
    },
  };
}

function engineFor(name: PromptName, config: Config): EngineConfig {
  const p = loadPrompt(name);
  return { model: config.MODEL_PATCH_FAST, system: p.system, render: p.render };
}

export function buildServer(config: Config = loadConfig(), deps: Deps = defaultDeps(config)) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const allowed = new Set(config.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean));
  const pattern = config.CORS_ORIGIN_PATTERN ? new RegExp(config.CORS_ORIGIN_PATTERN) : null;
  const adminOrigins = new Set(config.ADMIN_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean));
  // Route-aware CORS: /admin answers only the production web origin (never preview deploys), with
  // GET/PUT + Authorization; everything else keeps the app policy (plan-critic M5b #2).
  app.register(cors, () => (req: { url?: string }, cb: (e: Error | null, o: object) => void) => {
    if (req.url?.startsWith("/admin")) {
      return cb(null, { origin: (o: string | undefined, c: (e: Error | null, ok: boolean) => void) => c(null, !o || adminOrigins.has(o)), methods: ["GET", "PUT"], allowedHeaders: ["authorization", "content-type"] });
    }
    cb(null, { origin: (o: string | undefined, c: (e: Error | null, ok: boolean) => void) => c(null, !o || allowed.has(o) || !!pattern?.test(o)), methods: ["POST"] });
  });
  app.register(websocket);

  const flags = deps.flags ?? new FlagService(deps.persistence);
  app.addHook("onReady", () => flags.load());
  const sockets = new Set<(m: ServerMsg) => void>();
  flags.subscribe((f) => { for (const s of sockets) s({ type: "flags", flags: f }); });

  // ── Admin API (ADR 0012) ───────────────────────────────────────────────────────────────────
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const failures = new Map<string, { n: number; since: number }>();
  const admin = async (req: { headers: Record<string, unknown>; ip: string }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!config.ADMIN_TOKEN) return reply.code(503).send({ error: "admin disabled: set ADMIN_TOKEN" });
    const f = failures.get(req.ip);
    if (f && Date.now() - f.since < 10 * 60_000 && f.n >= 10) return reply.code(429).send({ error: "too many attempts" });
    const got = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(digest(got), digest(config.ADMIN_TOKEN))) {
      failures.set(req.ip, f && Date.now() - f.since < 10 * 60_000 ? { n: f.n + 1, since: f.since } : { n: 1, since: Date.now() });
      return reply.code(401).send({ error: "unauthorized" });
    }
    return null;
  };
  app.get("/admin/flags", async (req, reply) => {
    const denied = await admin(req, reply); if (denied) return denied;
    const stats = await deps.persistence.flagStats(7);
    const on = flags.all();
    return { flags: Object.entries(FEATURES).map(([key, f]) => ({ key, description: f.description, default: f.default, enabled: on[key as FeatureKey], last7d: stats[key as FeatureKey] ?? { exposed: 0, used: 0, blocked: 0 } })) };
  });
  app.put<{ Params: { key: string }; Body: { enabled?: unknown } }>("/admin/flags/:key", async (req, reply) => {
    const denied = await admin(req, reply); if (denied) return denied;
    const key = FeatureKey.safeParse(req.params.key);
    if (!key.success || typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "need a known key and {enabled: boolean}" });
    await flags.set(key.data, req.body.enabled);
    app.log.info({ key: key.data, enabled: req.body.enabled, ip: req.ip }, "admin: flag flipped");
    return { key: key.data, enabled: req.body.enabled };
  });

  app.get("/healthz", async () => ({
    ok: true,
    stt: config.DEEPGRAM_API_KEY ? "deepgram" : "webspeech-fallback",
    model: config.ANTHROPIC_API_KEY ? "configured" : "missing-key",
    fused: config.FUSED_FAST_PATH,
    lexicon: config.LEXICON_TIER,
  }));

  // How this browser gets speech-to-text (ADR 0008). Never returns the API key itself.
  app.post("/stt/token", async () => deps.sttGrant());

  app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket) => {
      const send = (msg: ServerMsg) => { if (socket.readyState === 1) socket.send(JSON.stringify(msg)); };
      sockets.add(send);
      /** Gateway-side enforcement: the UI hides disabled features, but the gateway is what says no. */
      const permit = (key: FeatureKey) => {
        if (flags.on(key)) return true;
        if (doc) deps.persistence.featureEvent(doc.sessionId, key, "blocked");
        send({ type: "error", message: `${FEATURES[key].description.split(/[:(—]/)[0]!.trim()} is turned off` });
        return false;
      };
      const fail = (message: string, e?: unknown) => { if (e) app.log.error(e); send({ type: "error", message }); };
      let doc: DocSession | null = null;
      let relay: SttSession | null = null;
      // Frames that arrive while Flux is still connecting are queued, not dropped — dropping them
      // shifted Flux's clock and lost the first words (browser run, 2026-09-27). Cap: 10 s of audio.
      let relayQueue: Buffer[] | null = null;
      let relayStart = 0, framesIn = 0, transcriptsOut = 0;
      // Voice utterance numbers are gateway-owned: each listening session's client/relay seq maps to a fresh one.
      let seqMap = new Map<number, number>();
      let relaySeq = 0;
      const voiceSeq = (clientSeq: number) => {
        if (!seqMap.has(clientSeq)) seqMap.set(clientSeq, doc!.allocSeq());
        return seqMap.get(clientSeq)!;
      };
      const onTranscript = (t: { utteranceSeq: number; text: string; isFinal: boolean; tMs: number; lastWordEndMs?: number; eager?: boolean }) => {
        if (!doc || !t.text) return;
        const seq = voiceSeq(t.utteranceSeq);
        deps.persistence.record(doc.sessionId, { utteranceSeq: seq, text: t.text, isFinal: t.isFinal, tMs: t.tMs });
        doc.onTranscript(seq, t.text, t.isFinal, t.lastWordEndMs, t.eager); // M4: lexicon + speculative jobs + settle
      };
      const stopRelay = async () => {
        const r = relay; relay = null; // (the connect queue, if any, is left for the new relay)
        if (r) app.log.info({ sessionId: doc?.sessionId, framesIn, transcriptsOut }, "relay: closed");
        await r?.finish().catch(() => {});
      };

      socket.on("message", async (raw: Buffer, isBinary: boolean) => {
        if (isBinary) { // relay-mode audio (80 ms int16 PCM)
          framesIn++;
          if (relay) relay.send(raw);
          else if (relayQueue && relayQueue.length < 125) relayQueue.push(raw);
          return;
        }
        let json: unknown;
        try { json = JSON.parse(raw.toString()); } catch { return fail("invalid JSON"); }
        const parsed = ClientMsg.safeParse(json);
        if (!parsed.success) return fail(parsed.error.message);
        const msg = parsed.data;
        if (msg.type !== "hello" && !doc) return fail("say hello first");
        switch (msg.type) {
          case "hello": {
            try {
              const t0 = performance.now();
              const opened = (msg.sessionId && (await deps.persistence.resumeSession(msg.sessionId))) || (await deps.persistence.openSession());
              app.log.info({ sessionId: opened.sessionId, ms: Math.round(performance.now() - t0), resumed: opened.sessionId === msg.sessionId }, "session: opened");
              doc = new DocSession(opened, { persistence: deps.persistence, model: deps.model, engine: deps.engine, engines: deps.engines, flags: () => flags.all(), send, log: (m) => app.log.warn(m) });
              doc.terms = await deps.persistence.listVocab(opened.documentId).catch(() => []);
              send({ type: "welcome", sessionId: doc.sessionId, version: doc.versionInfo().version, resumed: opened.sessionId === msg.sessionId, flags: flags.all() });
              send(doc.snapshot());
              send({ type: "vocab", terms: doc.terms });
              for (const [k, on] of Object.entries(flags.all())) if (on) deps.persistence.featureEvent(doc.sessionId, k as FeatureKey, "exposed");
            } catch (e) { fail("could not open session", e); }
            return;
          }
          case "stt_start":
            deps.persistence.setProvider(doc!.sessionId, msg.mode === "webspeech" ? "webspeech" : "deepgram-flux");
            seqMap = new Map();
            if (msg.mode !== "relay") return;
            relayQueue = []; // before any await: frames may already be in flight behind this message
            framesIn = 0;
            await stopRelay();
            try {
              const opened = await deps.relayProvider.connect();
              relayStart = performance.now(); relaySeq = 0; transcriptsOut = 0;
              app.log.info({ sessionId: doc!.sessionId }, "relay: opened Deepgram Flux");
              opened.onText((text, isFinal, meta) => {
                if (!text) return;
                const t = { utteranceSeq: relaySeq, text, isFinal, tMs: performance.now() - relayStart, ...(meta?.lastWordEndMs != null ? { lastWordEndMs: meta.lastWordEndMs } : {}), ...(meta?.eager ? { eager: true } : {}) };
                transcriptsOut++;
                send({ type: "transcript", ...t });
                onTranscript(t);
                if (isFinal) relaySeq++;
              });
              // Handler first, then the queued audio, then live frames — in that order.
              relay = opened;
              for (const f of relayQueue!.splice(0)) opened.send(f);
              relayQueue = null;
            } catch (e) { relayQueue = null; fail("speech-to-text relay unavailable", e); }
            return;
          case "stt_stop":
            return stopRelay();
          case "partial": // direct / webspeech: the browser already has the text
            return onTranscript(msg);
          case "prompt":
            if (!permit("speak_to_create")) return;
            return void doc!.run(msg.text, "typed", doc!.allocSeq());
          case "undo":
            return doc!.undo();
          case "redo":
            return doc!.redo();
          case "new_doc":
            if (!permit(kindFeature(msg.kind))) return;
            return doc!.newDoc(msg.kind);
          case "vocab_define":
            if (!permit("custom_vocabulary")) return;
            return void doc!.defineTerm(msg.kind, msg.phrase, msg.node, msg.confirm ?? true);
          case "vocab_confirm":
            if (!permit("custom_vocabulary")) return;
            return doc!.confirmTerm(msg.id);
          case "vocab_delete":
            if (!permit("custom_vocabulary")) return;
            return doc!.deleteTerm(msg.id);
          case "tune":
            return doc!.tune({ ...(msg.minGapMs != null ? { minGapMs: msg.minGapMs } : {}), ...(msg.callsPerMin != null ? { callsPerMin: msg.callsPerMin } : {}) });
          case "metrics": {
            const uid = deps.persistence.utterance(doc!.sessionId, voiceSeq(msg.utteranceSeq), "voice");
            return deps.persistence.latency(doc!.sessionId, { utteranceId: uid, stage: "reflow", tMs: msg.maxReflowsPerElement });
          }
          case "first_render":
            return deps.persistence.latency(doc!.sessionId, { jobId: msg.jobId, stage: "first_render", tMs: msg.tMs });
          default:
            return send({ type: "status", pending: null });
        }
      });
      socket.on("close", () => {
        sockets.delete(send);
        void stopRelay();
        if (doc) { doc.abortActive("disconnected"); deps.persistence.endSession(doc.sessionId); }
      });
    });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const app = buildServer(config);
  app.listen({ port: config.PORT, host: config.HOST }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
