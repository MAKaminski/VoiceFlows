import websocket from "@fastify/websocket";
import { ClientMsg, type ServerMsg } from "@livecanvas/dsl";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { loadConfig, type Config } from "./config.js";

export function buildServer(config: Config = loadConfig()) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  app.register(websocket);

  app.get("/healthz", async () => ({
    ok: true,
    stt: config.DEEPGRAM_API_KEY ? "deepgram" : "webspeech-fallback",
    model: config.ANTHROPIC_API_KEY ? "configured" : "missing-key",
    fused: config.FUSED_FAST_PATH,
    lexicon: config.LEXICON_TIER,
  }));

  app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket) => {
      const send = (msg: ServerMsg) => socket.send(JSON.stringify(msg));
      socket.on("message", (raw: Buffer) => {
        let json: unknown;
        try { json = JSON.parse(raw.toString()); } catch { return send({ type: "error", message: "invalid JSON" }); }
        const parsed = ClientMsg.safeParse(json);
        if (!parsed.success) return send({ type: "error", message: parsed.error.message });
        const msg = parsed.data;
        switch (msg.type) {
          case "hello":
            return send({ type: "welcome", sessionId: msg.sessionId ?? randomUUID(), version: 0 });
          default:
            // M2+ (partials, provisional ops, undo/redo) wire in here.
            return send({ type: "status", pending: null });
        }
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
