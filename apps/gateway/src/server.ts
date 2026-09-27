import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ClientMsg, type ServerMsg } from "@livecanvas/dsl";
import Fastify from "fastify";
import { loadConfig, type Config } from "./config.js";
import { getSql } from "./db.js";
import { memoryPersistence, pgPersistence, type Persistence } from "./persist.js";
import { PROVIDERS, type SttProvider, type SttSession } from "./stt/providers.js";
import { createSttGrant } from "./sttGrant.js";

export interface Deps {
  persistence: Persistence;
  sttGrant: ReturnType<typeof createSttGrant>;
  relayProvider: SttProvider;
}

export function defaultDeps(config: Config): Deps {
  const sql = getSql(config.DATABASE_URL);
  return {
    persistence: sql ? pgPersistence(sql, console.error, (m) => console.log(m)) : memoryPersistence(),
    sttGrant: createSttGrant(config),
    relayProvider: PROVIDERS["deepgram-flux"]!,
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
      let sessionId: string | null = null;
      let relay: SttSession | null = null;
      let relayStart = 0;
      let relaySeq = 0;
      let framesIn = 0, transcriptsOut = 0;
      const record = (seg: { utteranceSeq: number; text: string; isFinal: boolean; tMs: number }) => {
        if (sessionId && seg.text) deps.persistence.record(sessionId, seg);
      };
      const stopRelay = async () => {
        const r = relay; relay = null;
        if (r) app.log.info({ sessionId, framesIn, transcriptsOut }, "relay: closed");
        await r?.finish().catch(() => {});
      };

      socket.on("message", async (raw: Buffer, isBinary: boolean) => {
        if (isBinary) { framesIn++; relay?.send(raw); return; } // relay-mode audio (80 ms int16 PCM)
        let json: unknown;
        try { json = JSON.parse(raw.toString()); } catch { return send({ type: "error", message: "invalid JSON" }); }
        const parsed = ClientMsg.safeParse(json);
        if (!parsed.success) return send({ type: "error", message: parsed.error.message });
        const msg = parsed.data;
        switch (msg.type) {
          case "hello":
            try { sessionId = await deps.persistence.openSession(); }
            catch (e) { app.log.error(e); return send({ type: "error", message: "could not open session" }); }
            return send({ type: "welcome", sessionId, version: 0 });
          case "stt_start":
            if (sessionId) deps.persistence.setProvider(sessionId, msg.mode === "webspeech" ? "webspeech" : "deepgram-flux");
            if (msg.mode !== "relay") return;
            await stopRelay();
            try {
              relay = await deps.relayProvider.connect();
              relayStart = performance.now();
              relaySeq = 0; framesIn = 0; transcriptsOut = 0;
              app.log.info({ sessionId }, "relay: opened Deepgram Flux");
              relay.onText((text, isFinal) => {
                if (!text) return;
                const seg = { utteranceSeq: relaySeq, text, isFinal, tMs: performance.now() - relayStart };
                transcriptsOut++;
                send({ type: "transcript", ...seg });
                record(seg);
                if (isFinal) relaySeq++;
              });
            } catch (e) {
              app.log.error(e);
              send({ type: "error", message: "speech-to-text relay unavailable" });
            }
            return;
          case "stt_stop":
            return stopRelay();
          case "partial": // direct / webspeech modes: the browser already has the text; persist it
            return record(msg);
          default:
            return send({ type: "status", pending: null }); // M3+: provisional ops, undo/redo
        }
      });
      socket.on("close", () => {
        void stopRelay();
        if (sessionId) deps.persistence.endSession(sessionId);
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
