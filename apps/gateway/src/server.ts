import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ClientMsg, FEATURES, FeatureKey, kindFeature, ShareToken, type DocKind, type ServerMsg } from "@livecanvas/dsl";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info", serializers: {
    // Share tokens are credentials: never write them to logs (plan-critic M5d #4).
    req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: req.url.replace(/\/share\/[^/?#]+/, "/share/[token]"), remoteAddress: req.ip }),
  } } });
  const allowed = new Set(config.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean));
  const pattern = config.CORS_ORIGIN_PATTERN ? new RegExp(config.CORS_ORIGIN_PATTERN) : null;
  const adminOrigins = new Set(config.ADMIN_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean));
  // Route-aware CORS: /admin answers only the production web origin (never preview deploys), with
  // GET/PUT + Authorization; everything else keeps the app policy (plan-critic M5b #2).
  app.register(cors, () => (req: { url?: string }, cb: (e: Error | null, o: object) => void) => {
    if (req.url?.startsWith("/admin")) {
      return cb(null, { origin: (o: string | undefined, c: (e: Error | null, ok: boolean) => void) => c(null, !o || adminOrigins.has(o)), methods: ["GET", "PUT"], allowedHeaders: ["authorization", "content-type"] });
    }
    cb(null, { origin: (o: string | undefined, c: (e: Error | null, ok: boolean) => void) => c(null, !o || allowed.has(o) || !!pattern?.test(o)), methods: ["GET", "POST"] });
  });
  app.register(websocket);

  const flags = deps.flags ?? new FlagService(deps.persistence);
  app.addHook("onReady", () => flags.load());
  const sockets = new Set<(m: ServerMsg) => void>();
  flags.subscribe((f) => { for (const s of sockets) s({ type: "flags", flags: f }); });

  // ── Share links (ADR 0013): public, read-only, the token is the only credential ──────────────
  const misses = new Map<string, { n: number; since: number }>(); // 404s per IP — token guessing
  const viewed = new Set<string>(); // token:ip seen this hour — one "exposed" event each, not one per load
  setInterval(() => viewed.clear(), 60 * 60_000).unref();
  app.get<{ Params: { token: string } }>("/share/:token", async (req, reply) => {
    reply.header("cache-control", "no-store"); // revoking must take effect on the next load
    reply.header("x-robots-tag", "noindex");
    const m = misses.get(req.ip);
    if (m && Date.now() - m.since < 10 * 60_000 && m.n >= 30) return reply.code(429).send({ error: "too many requests" });
    if (!flags.on("share_links")) { deps.persistence.featureEvent(null, "share_links", "blocked"); return reply.code(404).send({ error: "not found" }); }
    const token = ShareToken.safeParse(req.params.token);
    const shared = token.success ? await deps.persistence.readShare(token.data) : null;
    if (!shared) { // unknown and revoked look the same
      misses.set(req.ip, m && Date.now() - m.since < 10 * 60_000 ? { n: m.n + 1, since: m.since } : { n: 1, since: Date.now() });
      return reply.code(404).send({ error: "not found" });
    }
    const seen = `${token.data}:${req.ip}`;
    if (!viewed.has(seen) && viewed.size < 50_000) { viewed.add(seen); deps.persistence.featureEvent(null, "share_links", "exposed"); }
    return shared;
  });

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

  /**
   * Live documents (ADR 0014): exactly one DocSession per document, owned by exactly one tab — the single
   * writer (ADR 0009) holds per document. Opening the document in another tab takes it over; the old tab
   * is told and goes idle. One gateway replica is assumed (ADR 0012).
   */
  interface LiveDoc { doc: DocSession; owner: ((m: ServerMsg) => void) | null; release: (() => void) | null; shareLinks: Array<{ token: string; version: number }> }
  const live = new Map<string, LiveDoc>();
  const toOwner = (e: LiveDoc) => (m: ServerMsg) => e.owner?.(m);

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
      let entry: LiveDoc | null = null;
      let closed = false;
      let closedByTakeover = false; // another tab took this document over (ADR 0014)
      let relay: SttSession | null = null;
      // Frames that arrive while Flux is still connecting are queued, not dropped — dropping them
      // shifted Flux's clock and lost the first words (browser run, 2026-09-27). Cap: 10 s of audio.
      let relayQueue: Buffer[] | null = null;
      let relayStart = 0, framesIn = 0, transcriptsOut = 0;
      // Voice utterance numbers are gateway-owned: each listening session's client/relay seq maps to a fresh one.
      let seqMap = new Map<number, number>();
      let relaySeq = 0;
      let lastMarks = ""; // only send word marks when they change
      let highlightUsed = false; // one "used" event per session
      const voiceSeq = (clientSeq: number) => {
        if (!seqMap.has(clientSeq)) seqMap.set(clientSeq, doc!.allocSeq());
        return seqMap.get(clientSeq)!;
      };
      const onTranscript = (t: { utteranceSeq: number; text: string; isFinal: boolean; tMs: number; lastWordEndMs?: number; eager?: boolean }) => {
        if (!doc || !t.text) return;
        const seq = voiceSeq(t.utteranceSeq);
        deps.persistence.record(doc.sessionId, { utteranceSeq: seq, text: t.text, isFinal: t.isFinal, tMs: t.tMs });
        doc.onTranscript(seq, t.text, t.isFinal, t.lastWordEndMs, t.eager); // M4: lexicon + speculative jobs + settle
        if (flags.on("transcript_highlight")) {
          const marks = doc.wordMarks();
          const sig = `${t.utteranceSeq}:${JSON.stringify(marks)}`;
          if (sig !== lastMarks) {
            lastMarks = sig;
            send({ type: "words", utteranceSeq: t.utteranceSeq, marks });
            if (marks.length && !highlightUsed) { highlightUsed = true; deps.persistence.featureEvent(doc.sessionId, "transcript_highlight", "used"); }
          }
        }
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
        if (msg.type !== "hello" && !doc) return fail(entry === null && closedByTakeover ? "This document is open in another tab" : "say hello first");
        switch (msg.type) {
          case "hello": {
            try {
              if (entry) return; // one hello per socket
              const t0 = performance.now();
              const remember = flags.on("remember_document");
              if (!remember && msg.documentId) deps.persistence.featureEvent(null, "remember_document", "blocked");
              // Which document: this tab's own (reload) or, with the flag, this browser's last one.
              const prior = msg.sessionId ? await deps.persistence.resumeSession(msg.sessionId) : null;
              const target = prior?.documentId ?? (remember ? msg.documentId : undefined);
              let e = target ? live.get(target) : undefined;
              let resumed = !!e;
              if (!e) {
                // Queued writes of a tab that just closed must land before we read the document back.
                await deps.persistence.flush();
                const opened = (target ? await deps.persistence.openOnDocument(target) : null) ?? (await deps.persistence.openSession());
                resumed = opened.documentId === target;
                const created: LiveDoc = { doc: null as unknown as DocSession, owner: null, release: null, shareLinks: [] };
                created.doc = new DocSession(opened, { persistence: deps.persistence, model: deps.model, engine: deps.engine, engines: deps.engines, flags: () => flags.all(), send: toOwner(created), log: (m) => app.log.warn(m) });
                created.doc.terms = await deps.persistence.listVocab(opened.documentId).catch(() => []);
                created.shareLinks = await deps.persistence.listShares(opened.documentId).catch(() => []);
                e = live.get(opened.documentId); // another tab may have opened it while we awaited
                if (e) deps.persistence.endSession(opened.sessionId); // keep the one that won
                else live.set(opened.documentId, (e = created));
                if (resumed && !prior) deps.persistence.featureEvent(opened.sessionId, "remember_document", "used");
              }
              if (closed) { // the tab went away while we were loading: don't pin the document
                if (!e.owner && live.get(e.doc.documentId) === e) { live.delete(e.doc.documentId); deps.persistence.endSession(e.doc.sessionId); }
                return;
              }
              // Take over: the previous owner is told and released (its mic and messages stop).
              if (e.owner) { e.owner({ type: "taken_over" }); e.release?.(); }
              e.owner = send;
              e.release = () => { entry = null; doc = null; closedByTakeover = true; void stopRelay(); };
              entry = e;
              doc = e.doc;
              app.log.info({ sessionId: doc.sessionId, ms: Math.round(performance.now() - t0), resumed }, "session: opened");
              send({ type: "welcome", sessionId: doc.sessionId, documentId: doc.documentId, version: doc.versionInfo().version, resumed, flags: flags.all() });
              send(doc.snapshot());
              send({ type: "vocab", terms: doc.terms });
              if (flags.on("share_links")) send({ type: "shares", links: e.shareLinks });
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
          case "share_create": {
            if (!permit("share_links")) return;
            // One live link per version: sharing the same version again returns its link (ADR 0013).
            const version = doc!.versionInfo().version;
            const e = entry!;
            if (!e.shareLinks.some((l) => l.version === version)) {
              const token = randomBytes(16).toString("base64url");
              deps.persistence.createShare(doc!.sessionId, { documentId: doc!.documentId, version, token });
              e.shareLinks = [...e.shareLinks, { token, version }];
              deps.persistence.featureEvent(doc!.sessionId, "share_links", "used");
            }
            return send({ type: "shares", links: e.shareLinks });
          }
          case "share_revoke":
            if (!permit("share_links")) return;
            try {
              await deps.persistence.flush(); // a just-created link must exist before it can be revoked
              await deps.persistence.revokeShare(doc!.documentId, msg.token);
              entry!.shareLinks = entry!.shareLinks.filter((l) => l.token !== msg.token);
              return send({ type: "shares", links: entry!.shareLinks });
            } catch (e) { return fail("could not revoke the link", e); }
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
        closed = true;
        sockets.delete(send);
        void stopRelay();
        if (entry && doc && entry.owner === send) { // the owning tab closed: settle and release the document
          doc.abortActive("disconnected");
          deps.persistence.endSession(doc.sessionId);
          entry.owner = null;
          if (live.get(doc.documentId) === entry) live.delete(doc.documentId);
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
