import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ClientMsg, type ServerMsg } from "@livecanvas/dsl";
import Fastify from "fastify";
import { loadConfig, type Config } from "./config.js";
import { getSql } from "./db.js";
import { DocSession, type EngineConfig } from "./engine/docSession.js";
import { anthropicClient, type ModelClient } from "./engine/model.js";
import { loadPrompt } from "@livecanvas/prompts";
import { memoryPersistence, pgPersistence, type Persistence } from "./persist.js";
import { PROVIDERS, type SttProvider, type SttSession } from "./stt/providers.js";
import { createSttGrant } from "./sttGrant.js";

export interface Deps {
  persistence: Persistence;
  sttGrant: ReturnType<typeof createSttGrant>;
  relayProvider: SttProvider;
  model: ModelClient | null;
  engine: EngineConfig;
}

export function defaultDeps(config: Config): Deps {
  const sql = getSql(config.DATABASE_URL);
  return {
    persistence: sql ? pgPersistence(sql, console.error, (m) => console.log(m)) : memoryPersistence(),
    sttGrant: createSttGrant(config),
    relayProvider: PROVIDERS["deepgram-flux"]!,
    model: config.ANTHROPIC_API_KEY ? anthropicClient(config.ANTHROPIC_API_KEY) : null,
    engine: (() => { const p = loadPrompt("fused_system"); return { model: config.MODEL_PATCH_FAST, system: p.system, render: p.render }; })(),
  };
}

export function buildServer(config: Config = loadConfig(), deps: Deps = defaultDeps(config)) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const allowed = new Set(config.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean));
  const pattern = config.CORS_ORIGIN_PATTERN ? new RegExp(config.CORS_ORIGIN_PATTERN) : null;
  app.register(cors, { origin: (origin, cb) => cb(null, !origin || allowed.has(origin) || !!pattern?.test(origin)), methods: ["POST"] });
  app.register(websocket);

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
      const fail = (message: string, e?: unknown) => { if (e) app.log.error(e); send({ type: "error", message }); };
      let doc: DocSession | null = null;
      let relay: SttSession | null = null;
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
        const r = relay; relay = null;
        if (r) app.log.info({ sessionId: doc?.sessionId, framesIn, transcriptsOut }, "relay: closed");
        await r?.finish().catch(() => {});
      };

      socket.on("message", async (raw: Buffer, isBinary: boolean) => {
        if (isBinary) { framesIn++; relay?.send(raw); return; } // relay-mode audio (80 ms int16 PCM)
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
              doc = new DocSession(opened, { persistence: deps.persistence, model: deps.model, engine: deps.engine, send, log: (m) => app.log.warn(m) });
              send({ type: "welcome", sessionId: doc.sessionId, version: doc.versionInfo().version, resumed: opened.sessionId === msg.sessionId });
              send(doc.snapshot());
            } catch (e) { fail("could not open session", e); }
            return;
          }
          case "stt_start":
            deps.persistence.setProvider(doc!.sessionId, msg.mode === "webspeech" ? "webspeech" : "deepgram-flux");
            seqMap = new Map();
            if (msg.mode !== "relay") return;
            await stopRelay();
            try {
              relay = await deps.relayProvider.connect();
              relayStart = performance.now(); relaySeq = 0; framesIn = 0; transcriptsOut = 0;
              app.log.info({ sessionId: doc!.sessionId }, "relay: opened Deepgram Flux");
              relay.onText((text, isFinal, meta) => {
                if (!text) return;
                const t = { utteranceSeq: relaySeq, text, isFinal, tMs: performance.now() - relayStart, ...(meta?.lastWordEndMs != null ? { lastWordEndMs: meta.lastWordEndMs } : {}), ...(meta?.eager ? { eager: true } : {}) };
                transcriptsOut++;
                send({ type: "transcript", ...t });
                onTranscript(t);
                if (isFinal) relaySeq++;
              });
            } catch (e) { fail("speech-to-text relay unavailable", e); }
            return;
          case "stt_stop":
            return stopRelay();
          case "partial": // direct / webspeech: the browser already has the text
            return onTranscript(msg);
          case "prompt":
            return void doc!.run(msg.text, "typed", doc!.allocSeq());
          case "undo":
            return doc!.undo();
          case "redo":
            return doc!.redo();
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
