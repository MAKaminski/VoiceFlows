import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { ClientMsg, compilePrd, FEATURES, FeatureKey, kindFeature, PROTOCOL, ShareToken, toProject, type DocKind, type ServerMsg } from "@livecanvas/dsl";
import { z } from "zod";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { FlagService } from "./flags.js";
import { verifyAccess } from "./access.js";
import { DEMO_VOICES, demoAudio, type DemoVoice } from "./demo.js";
import Fastify from "fastify";
import { loadConfig, type Config } from "./config.js";
import { getSql } from "./db.js";
import { DEFAULT_TUNABLES, DocSession, type EngineConfig } from "./engine/docSession.js";
import { runFill } from "./engine/fill.js";
import { anthropicClient, hedgedClient, type ModelClient } from "./engine/model.js";
import { typesafeJev, type JevClient } from "./engine/jev.js";
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
  notesEngine?: EngineConfig; // ADR 0016
  suggestEngine?: EngineConfig; // ADR 0020: model suggestions (flag suggestions_model, off by default)
  fillEngine?: EngineConfig; // ADR 0022: Build it — AI fill workers
  jev?: JevClient; // ADR 0017
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
      constraints: engineFor("diagram_constraints", config),
      cva: engineFor("diagram_cva", config),
    },
    notesEngine: engineFor("project_notes", config),
    suggestEngine: engineFor("suggest", config),
    fillEngine: engineFor("code_fill", config),
    ...(config.TYPESAFE_API_KEY ? { jev: typesafeJev(config.TYPESAFE_API_KEY, config.JEV_TIMEOUT_MS) } : {}),
  };
}

/** RMS of a little-endian int16 PCM frame, 0–1. */
function rms16(buf: Buffer): number {
  const n = Math.floor(buf.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = buf.readInt16LE(i * 2) / 32768; sum += v * v; }
  return Math.sqrt(sum / n);
}

function engineFor(name: PromptName, config: Config): EngineConfig {
  const p = loadPrompt(name);
  return { model: config.MODEL_PATCH_FAST, system: p.system, render: p.render };
}

export function buildServer(config: Config = loadConfig(), deps: Deps = defaultDeps(config)) {
  // trustProxy: 1 — Railway's edge is the one proxy hop, so req.ip is the visitor (per-IP caps, M9 #4).
  const app = Fastify({ trustProxy: (_addr: string, hop: number) => hop === 0, logger: { level: process.env.LOG_LEVEL ?? "info", serializers: {
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

  // ── Invite gate (ADR 0021) ────────────────────────────────────────────────────────────────
  const gated = () => !!config.ACCESS_SECRET && flags.on("invite_gate");
  /** HTTP routes behind the gate need a `full` token (never demo): true = refused, reply already sent. */
  const needsAccess = (req: { headers: Record<string, unknown> }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!gated()) return false;
    const t = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (verifyAccess(config.ACCESS_SECRET!, t, ["full"])) return false;
    reply.code(401).send({ error: "access required" });
    return true;
  };
  /** Demo caps: ≤ 3 sessions per visitor per hour, ≤ 150 per day overall (in memory; one replica). */
  const demoByIp = new Map<string, number[]>();
  const demoDay: number[] = [];
  // AI fill (ADR 0022): ≤ 50 builds a day across everyone ($7.20/day at the $0.144 worst case), 1 per 5 min per session.
  const fillDay: number[] = [];
  const fillAllowed = () => { const now = Date.now(); while (fillDay.length && now - fillDay[0]! > 86_400_000) fillDay.shift(); if (fillDay.length >= 50) return false; fillDay.push(now); return true; };
  const demoAllowed = (ip: string) => {
    const now = Date.now();
    const mine = (demoByIp.get(ip) ?? []).filter((t) => now - t < 3600_000);
    while (demoDay.length && now - demoDay[0]! > 86_400_000) demoDay.shift();
    if (mine.length >= 3 || demoDay.length >= 150) return false;
    demoByIp.set(ip, [...mine, now]); demoDay.push(now);
    return true;
  };
  const demoDocs = new Set<string>(); // never opened by a full-scope hello

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
    return { ...shared, doc: toProject(shared.doc) }; // links made before projects (ADR 0016)
  });

  // ── Admin API (ADR 0012) ───────────────────────────────────────────────────────────────────
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const failures = new Map<string, { n: number; since: number }>();
  /**
   * true = the request was refused (the error reply is already sent; the handler must `return reply`).
   * Returns a plain boolean on purpose: a Fastify reply is a thenable, so returning it from this async
   * guard made `await` resolve to undefined and the handler ran on after the 401 — a wrong token could
   * flip a flag (fixed 2026-09-28).
   */
  const denied = (req: { headers: Record<string, unknown>; ip: string }, reply: { code(n: number): { send(b: unknown): unknown } }): boolean => {
    if (!config.ADMIN_TOKEN) { reply.code(503).send({ error: "admin disabled: set ADMIN_TOKEN" }); return true; }
    const f = failures.get(req.ip);
    if (f && Date.now() - f.since < 10 * 60_000 && f.n >= 10) { reply.code(429).send({ error: "too many attempts" }); return true; }
    const got = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(digest(got), digest(config.ADMIN_TOKEN))) {
      failures.set(req.ip, f && Date.now() - f.since < 10 * 60_000 ? { n: f.n + 1, since: f.since } : { n: 1, since: Date.now() });
      reply.code(401).send({ error: "unauthorized" });
      return true;
    }
    return false;
  };
  app.get("/admin/flags", async (req, reply) => {
    if (denied(req, reply)) return reply;
    const [stats, history] = await Promise.all([deps.persistence.flagStats(7), deps.persistence.flagHistory(500)]);
    const on = flags.all();
    return { flags: Object.entries(FEATURES).map(([key, f]) => ({ key, description: f.description, default: f.default, enabled: on[key as FeatureKey],
      last7d: stats[key as FeatureKey] ?? { exposed: 0, used: 0, blocked: 0 }, lastChange: history.find((h) => h.key === key) ?? null })) };
  });
  // Flag history (ADR 0020): who turned what on or off, and when. actor = a short hash of the admin's IP.
  app.get<{ Querystring: { limit?: string } }>("/admin/flags/history", async (req, reply) => {
    if (denied(req, reply)) return reply;
    return { changes: await deps.persistence.flagHistory(Math.min(200, Math.max(1, Number(req.query.limit) || 50))) };
  });
  app.put<{ Params: { key: string }; Body: { enabled?: unknown } }>("/admin/flags/:key", async (req, reply) => {
    if (denied(req, reply)) return reply;
    const key = FeatureKey.safeParse(req.params.key);
    if (!key.success || typeof req.body?.enabled !== "boolean") return reply.code(400).send({ error: "need a known key and {enabled: boolean}" });
    await flags.set(key.data, req.body.enabled, { source: "admin", actor: createHash("sha256").update(req.ip).digest("hex").slice(0, 8) });
    app.log.info({ key: key.data, enabled: req.body.enabled, ip: req.ip }, "admin: flag flipped");
    return { key: key.data, enabled: req.body.enabled };
  });

  // ── Project library (ADR 0020): one shared workspace list of SAVED projects (no accounts yet — anyone with
  // the site can see and open them; the user's choice). Rate-limited per IP; the flag switches it off at once.
  const hits = new Map<string, { n: number; since: number }>();
  const limited = (ip: string, max: number) => {
    const h = hits.get(ip);
    if (!h || Date.now() - h.since > 10 * 60_000) { hits.set(ip, { n: 1, since: Date.now() }); return false; }
    return ++h.n > max;
  };
  const libraryOff = (reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (flags.on("project_library")) return false;
    deps.persistence.featureEvent(null, "project_library", "blocked");
    reply.code(404).send({ error: "not found" });
    return true;
  };
  const DocumentId = z.string().uuid();
  app.get<{ Querystring: { archived?: string } }>("/projects", async (req, reply) => {
    reply.header("cache-control", "no-store").header("x-robots-tag", "noindex");
    if (needsAccess(req, reply) || libraryOff(reply)) return reply;
    if (limited(req.ip, 300)) return reply.code(429).send({ error: "too many requests" });
    return { projects: await deps.persistence.listProjects(req.query.archived === "1", 200) };
  });
  app.get<{ Params: { id: string } }>("/projects/:id", async (req, reply) => {
    reply.header("cache-control", "no-store").header("x-robots-tag", "noindex");
    if (needsAccess(req, reply) || libraryOff(reply)) return reply;
    if (limited(req.ip, 300)) return reply.code(429).send({ error: "too many requests" });
    const id = DocumentId.safeParse(req.params.id);
    const p = id.success ? await deps.persistence.readProject(id.data) : null;
    if (!p) return reply.code(404).send({ error: "not found" });
    const liveDoc = live.get(req.params.id)?.doc; // the owner's unsaved-but-applied edits are newer than the row
    return { ...p, doc: toProject(liveDoc ? liveDoc.project : p.doc), ...(liveDoc ? { version: liveDoc.versionInfo().version } : {}) };
  });
  for (const [path, archived] of [["archive", true], ["restore", false]] as const) {
    app.post<{ Params: { id: string } }>(`/projects/:id/${path}`, async (req, reply) => {
      reply.header("cache-control", "no-store");
      if (needsAccess(req, reply) || libraryOff(reply)) return reply;
      if (limited(req.ip, 60)) return reply.code(429).send({ error: "too many requests" });
      const id = DocumentId.safeParse(req.params.id);
      if (!id.success || !(await deps.persistence.setArchived(id.data, archived))) return reply.code(404).send({ error: "not found" });
      app.log.info({ id: id.data, archived }, "library: project archived/restored");
      return { id: id.data, archived };
    });
  }

  // ── Voice demo audio (ADR 0021): public, generated once per voice, cached in memory ───────────────
  const demo = demoAudio(config.DEEPGRAM_API_KEY, (m) => app.log.info(m));
  // Warm the default voice (~4 s of Aura + transcription) so the first visitor doesn't wait for it.
  if (config.DEEPGRAM_API_KEY && flags.on("voice_demo") && !process.env.VITEST) void demo.manifest("thalia").catch(() => {});
  const voiceOf = (v: unknown): DemoVoice | null => (DEMO_VOICES.some((x) => x.id === v) ? (v as DemoVoice) : null);
  app.get<{ Querystring: { voice?: string } }>("/demo/manifest", async (req, reply) => {
    if (!flags.on("voice_demo")) return reply.code(404).send({ error: "not found" });
    const voice = voiceOf(req.query.voice ?? "thalia");
    if (!voice) return reply.code(400).send({ error: "unknown voice" });
    try { return { voices: DEMO_VOICES.map(({ id, label }) => ({ id, label })), ...(await demo.manifest(voice)) }; }
    catch (e) { app.log.warn({ err: (e as Error).message }, "demo: generation failed"); return reply.code(503).send({ error: "demo audio unavailable" }); }
  });
  app.get<{ Params: { voice: string; n: string } }>("/demo/audio/:voice/:n", async (req, reply) => {
    const voice = voiceOf(req.params.voice);
    const clip = voice ? demo.clip(voice, Number(req.params.n)) : null;
    if (!clip) return reply.code(404).send({ error: "not found" });
    return reply.header("content-type", "audio/mpeg").header("cache-control", "public, max-age=86400").send(clip);
  });

  app.get("/healthz", async () => ({
    ok: true,
    stt: config.DEEPGRAM_API_KEY ? "deepgram" : "webspeech-fallback",
    model: config.ANTHROPIC_API_KEY ? "configured" : "missing-key",
    fused: config.FUSED_FAST_PATH,
    lexicon: config.LEXICON_TIER,
  }));

  // How this browser gets speech-to-text (ADR 0008). Never returns the API key itself.
  app.post("/stt/token", async (req, reply) => {
    if (needsAccess(req, reply)) return reply; // mints Deepgram tokens: never for anonymous or demo callers
    return deps.sttGrant();
  });

  /**
   * Live documents (ADR 0014): exactly one DocSession per document, owned by exactly one tab — the single
   * writer (ADR 0009) holds per document. Opening the document in another tab takes it over; the old tab
   * is told and goes idle. One gateway replica is assumed (ADR 0012).
   */
  interface LiveDoc { doc: DocSession; owner: ((m: ServerMsg) => void) | null; release: (() => void) | null; shareLinks: Array<{ token: string; version: number }> }
  const live = new Map<string, LiveDoc>();
  const toOwner = (e: LiveDoc) => (m: ServerMsg) => e.owner?.(m);

  app.register(async (scoped) => {
    scoped.get("/ws", { websocket: true }, (socket, req) => {
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
      let lastFill = 0;
      let entry: LiveDoc | null = null;
      let closed = false;
      let closedByTakeover = false; // another tab took this document over (ADR 0014)
      let relay: SttSession | null = null;
      // Frames that arrive while Flux is still connecting are queued, not dropped — dropping them
      // shifted Flux's clock and lost the first words (browser run, 2026-09-27). Cap: 10 s of audio.
      let relayQueue: Buffer[] | null = null;
      let relayStart = 0, framesIn = 0, transcriptsOut = 0, lastVoiceMs = 0;
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
          // Speech energy per 80 ms frame (int16 PCM): silence = RMS below ~−34 dBFS (ADR 0018).
          if (rms16(raw) >= 0.02) lastVoiceMs = framesIn * 80;
          doc?.onAudioClock(framesIn * 80, lastVoiceMs);
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
              // Invite gate (ADR 0021): a signed token from the web; "demo" tokens get the demo scope.
              let scope: "full" | "demo" = "full";
              if (gated()) {
                const p = verifyAccess(config.ACCESS_SECRET!, msg.access, ["full", "demo"]);
                if (!p) { fail("Access required — get an invite code on the home page"); socket.close(); return; }
                scope = p === "demo" ? "demo" : "full";
              }
              if (scope === "demo" && (!flags.on("voice_demo") || !demoAllowed(req.ip))) { fail("Demo busy — try again in a minute"); socket.close(); return; }
              // A demo is a throwaway project in memory: never saved, listed, reopened or cleaned up (plan-critic M9 #3, #19).
              const store: Persistence = scope === "demo" ? memoryPersistence() : deps.persistence;
              const remember = flags.on("remember_document");
              if (!remember && msg.documentId) deps.persistence.featureEvent(null, "remember_document", "blocked");
              // Which document: this tab's own (reload) or, with the flag, this browser's last one. Never a demo one.
              const prior = scope === "full" && msg.sessionId ? await deps.persistence.resumeSession(msg.sessionId) : null;
              // Opened from the library: the picked project wins over this tab's previous session (plan-critic M8 #6).
              const opening = scope === "full" && !!msg.open && !!msg.documentId && flags.on("project_library");
              const asked = scope === "demo" ? undefined : opening ? msg.documentId : prior?.documentId ?? (remember ? msg.documentId : undefined);
              const target = asked && !demoDocs.has(asked) ? asked : undefined;
              let e = target ? live.get(target) : undefined;
              // …but a library open never kicks out someone editing it: offered read-only instead (M8 #7).
              if (opening && e?.owner) { send({ type: "in_use", documentId: target! }); return; }
              let resumed = !!e;
              if (!e) {
                // Queued writes of a tab that just closed must land before we read the document back.
                await deps.persistence.flush();
                const opened = (target ? await store.openOnDocument(target) : null) ?? (await store.openSession());
                resumed = opened.documentId === target;
                const created: LiveDoc = { doc: null as unknown as DocSession, owner: null, release: null, shareLinks: [] };
                created.doc = new DocSession(opened, { persistence: store, model: deps.model, engine: deps.engine, engines: deps.engines, notesEngine: deps.notesEngine, suggestEngine: deps.suggestEngine, jev: deps.jev, flags: () => flags.all(), send: toOwner(created), log: (m) => app.log.warn(m) });
                created.doc.tune({ silenceSettleMs: config.SILENCE_SETTLE_MS });
                if (scope === "demo") { // ADR 0021: ≤ 40 model calls and ≤ 5 minutes, then the demo ends
                  created.doc.scope = "demo";
                  created.doc.callBudget = 40;
                  demoDocs.add(opened.documentId);
                  deps.persistence.featureEvent(null, "voice_demo", "used");
                  setTimeout(() => socket.close(), 5 * 60_000).unref();
                }
                created.doc.terms = await store.listVocab(opened.documentId).catch(() => []);
                created.doc.recent = await store.recentUtterances(opened.documentId, 8).catch(() => []);
                created.shareLinks = await store.listShares(opened.documentId).catch(() => []);
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
              send({ type: "welcome", sessionId: doc.sessionId, documentId: doc.documentId, version: doc.versionInfo().version, resumed, flags: flags.all(), protocol: PROTOCOL });
              send(doc.snapshot());
              send(doc.viewMsg());
              send({ type: "vocab", terms: doc.terms });
              if (flags.on("version_timeline")) send(doc.timelineMsg());
              if (flags.on("share_links")) send({ type: "shares", links: e.shareLinks });
              if (flags.on("project_library")) send(doc.projectMsg());
              if (flags.on("suggestions")) send(doc.suggestionsMsg()); // replayed on reload/takeover (plan-critic M8 #5)
              if (opening) deps.persistence.featureEvent(doc.sessionId, "project_library", "used");
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
            if (doc!.scope === "demo") return fail("The demo speaks for itself — get an invite to type your own");
            if (!permit("speak_to_create")) return;
            return void doc!.run(msg.text, "typed", doc!.allocSeq());
          case "undo":
            return doc!.undo();
          case "redo":
            return doc!.redo();
          case "new_doc": // old clients: now a view switch (ADR 0016)
          case "set_view": {
            const view = msg.type === "set_view" ? msg.view : msg.kind;
            if (view !== doc!.activeView && !permit("projects")) return;
            if (!permit(kindFeature(view))) return;
            return doc!.setView(view);
          }
          case "set_title":
            if (!permit("projects")) return;
            return doc!.setTitle(msg.title);
          case "vocab_define":
            if (!permit("custom_vocabulary")) return;
            return void doc!.defineTerm(msg.kind, msg.phrase, msg.node, msg.confirm ?? true);
          case "vocab_confirm":
            if (!permit("custom_vocabulary")) return;
            return doc!.confirmTerm(msg.id);
          case "goto_version":
            if (!permit("version_timeline")) return;
            return doc!.gotoVersion(msg.version);
          case "share_create": {
            if (doc!.scope === "demo") return fail("Sharing is off in the demo");
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
          case "suggestion_approve":
            if (!permit("suggestions")) return;
            return doc!.resolveSuggestions("approve", msg.ids.map((id) => ({ id, ...(msg.cols?.[id] ? { cols: msg.cols[id] } : {}) })));
          case "suggestion_reject":
            if (!permit("suggestions")) return;
            return doc!.resolveSuggestions("reject", msg.ids.map((id) => ({ id, ...(msg.cols?.[id] ? { cols: msg.cols[id] } : {}) })));
          case "import": {
            if (doc!.scope === "demo") return fail("Import is off in the demo — get an invite to bring your own systems");
            if (!permit("context_import")) return;
            const r = doc!.applyImport(msg.text, msg.name ?? "", msg.kind);
            return send({ type: "import_result", ...r });
          }
          case "fill": {
            if (doc!.scope === "demo") return fail("AI fill is off in the demo");
            if (!permit("code_scaffold_model")) return;
            if (!deps.model || !deps.fillEngine) return fail("AI fill is unavailable");
            if (Date.now() - lastFill < 300_000) return fail("One AI fill every 5 minutes — the skeleton is ready to download meanwhile");
            if (!fillAllowed()) return fail("AI fill is at today's limit — the skeleton is ready to download");
            lastFill = Date.now();
            const e = deps.fillEngine;
            void runFill({ files: msg.files, prd: compilePrd(doc!.project), model: deps.model, modelName: e.model, system: e.system, render: e.render, send })
              .then((r) => { doc?.uiEvent("code_scaffold_model", "used"); app.log.info({ ...r }, "fill: done"); })
              .catch((err) => app.log.warn({ err: (err as Error).message }, "fill: failed"));
            return;
          }
          case "intake":
            if (!permit("project_intake")) return;
            return doc!.applyIntake(msg);
          case "ui_event":
            return doc!.uiEvent(msg.feature, msg.action);
          case "save_project":
            if (!permit("project_library")) return;
            return void doc!.saveProject(msg.title);
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
          case "tune": // clamped: a client can slow the model down, never speed it up past the cost cap (plan-critic M9)
            if (doc!.scope === "demo") return;
            return doc!.tune({ ...(msg.minGapMs != null ? { minGapMs: Math.max(DEFAULT_TUNABLES.minGapMs, msg.minGapMs) } : {}), ...(msg.callsPerMin != null ? { callsPerMin: Math.min(DEFAULT_TUNABLES.callsPerMin, msg.callsPerMin) } : {}) });
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
