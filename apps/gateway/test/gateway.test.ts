import { applyOp, DesignDocSchema, emptyDoc, ServerMsg, type DesignDoc } from "@livecanvas/dsl";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import type { ModelClient } from "../src/engine/model.js";
import { DocSession } from "../src/engine/docSession.js";
import { memoryPersistence, pgPersistence } from "../src/persist.js";
import { buildServer } from "../src/server.js";
import type { SttProvider } from "../src/stt/providers.js";
import { createSttGrant, FLUX_BROWSER_URL } from "../src/sttGrant.js";

const res = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

describe("POST /stt/token mode choice (ADR 0008)", () => {
  it("falls back to Web Speech with no key", async () => {
    expect(await createSttGrant({ DEEPGRAM_API_KEY: undefined, STT_DIRECT: true })()).toEqual({ mode: "webspeech" });
  });
  it("returns a direct JWT grant when the key may mint one", async () => {
    const g = createSttGrant({ DEEPGRAM_API_KEY: "k", STT_DIRECT: true }, async () => res(200, { access_token: "jwt", expires_in: 30 }));
    expect(await g()).toEqual({ mode: "direct", provider: "deepgram-flux", url: FLUX_BROWSER_URL, token: "jwt", expiresIn: 30 });
  });
  it("uses relay on 403 and stops asking Deepgram afterwards", async () => {
    let calls = 0;
    const g = createSttGrant({ DEEPGRAM_API_KEY: "k", STT_DIRECT: true }, async () => { calls++; return res(403); });
    expect(await g()).toEqual({ mode: "relay", provider: "deepgram-flux" });
    expect(await g()).toEqual({ mode: "relay", provider: "deepgram-flux" });
    expect(calls).toBe(1);
  });
});

/** Fake STT: echoes a growing transcript every 2 frames and finalizes on the 6th. */
function fakeProvider(connectDelayMs = 0): SttProvider & { frames: number } {
  const p = {
    frames: 0, pricePerMin: 0, needs: "", ready: () => true,
    connect: async () => {
      await new Promise((r) => setTimeout(r, connectDelayMs));
      let cb: (t: string, f: boolean) => void = () => {};
      const words = ["a", "login", "screen"];
      return {
        send: () => { p.frames++; if (p.frames % 2 === 0) cb(words.slice(0, p.frames / 2).join(" "), p.frames === 6); },
        onText: (f: typeof cb) => { cb = f; },
        finish: async () => {},
      };
    },
  };
  return p;
}

/** Fake model: yields `lines` for any request, one every `gapMs`, honouring abort like fetch does. */
function fakeModel(lines: string[], gapMs = 5): ModelClient & { requests: string[] } {
  const requests: string[] = [];
  const client = ((req: Parameters<ModelClient>[0]) => {
    requests.push(req.user);
    async function* gen() {
      let t = 0;
      for (const line of lines) {
        await new Promise((r) => setTimeout(r, gapMs));
        if (req.signal.aborted) throw new Error("aborted");
        yield { line, atMs: (t += gapMs) };
      }
    }
    return { lines: gen(), usage: Promise.resolve({ inputTokens: 700, outputTokens: 40 }) };
  }) as unknown as ModelClient & { requests: string[] };
  client.requests = requests;
  return client;
}

const LOGIN = ["add .9 login", '+Text title >root v=title "Log in"', '+Input email >root k=email "Email"', '+Input password >root k=password "Password"', '+Button signin >root v=primary s=lg "Sign in"'];

async function start(extra: Record<string, string> = {}, model: ModelClient = fakeModel(LOGIN), connectDelayMs = 0) {
  const persistence = memoryPersistence();
  const provider = fakeProvider(connectDelayMs);
  const config = loadConfig({ CORS_ORIGINS: "https://app.example", CORS_ORIGIN_PATTERN: "^https://pr-\\d+\\.example$", ...extra } as NodeJS.ProcessEnv);
  const engine = { model: "fake-haiku", system: "sys", render: (v: Record<string, string>) => `${v.doc_compact}\n---\n${v.partial_text}` };
  const app = buildServer(config, { persistence, sttGrant: async () => ({ mode: "relay", provider: "deepgram-flux" }), relayProvider: provider, model, engine });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, persistence, provider, port };
}

/** The screen view of a project doc (ADR 0016) — the M3 tests speak to the screen. */
const screenOf = (doc: DesignDoc | null) => (doc!.root.type === "Project" ? doc!.root.children![0]! : doc!.root);

/** Test client = the browser's replica: applies `doc` snapshots and `ops` batches in arrival order. */
function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: ServerMsg[] = [];
  const waiters: Array<() => void> = [];
  const replica: { doc: DesignDoc | null } = { doc: null };
  ws.on("message", (d) => {
    const m = ServerMsg.parse(JSON.parse(d.toString()));
    if (m.type === "doc") replica.doc = m.doc;
    if (m.type === "ops") for (const op of m.ops) replica.doc = applyOp(replica.doc!, op);
    inbox.push(m);
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (pred: (m: ServerMsg) => boolean) => {
    for (;;) { const hit = inbox.find(pred); if (hit) return hit; await new Promise<void>((r) => waiters.push(r)); }
  };
  const count = (pred: (m: ServerMsg) => boolean) => inbox.filter(pred).length;
  const nth = async (pred: (m: ServerMsg) => boolean, n: number) => {
    for (;;) { const hits = inbox.filter(pred); if (hits.length >= n) return hits[n - 1]!; await new Promise<void>((r) => waiters.push(r)); }
  };
  return { ws, inbox, next, nth, count, replica, open: new Promise((r) => ws.once("open", r)) };
}

describe("gateway WebSocket", () => {
  it("relays binary audio to STT, streams transcripts back, and persists them", async () => {
    const { app, persistence, provider, port } = await start();
    const c = client(port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello" }));
    const welcome = await c.next((m) => m.type === "welcome");
    c.ws.send(JSON.stringify({ type: "stt_start", mode: "relay" }));
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 6; i++) c.ws.send(Buffer.alloc(2560));
    const final = await c.next((m) => m.type === "transcript" && m.isFinal);
    expect(final).toMatchObject({ text: "a login screen", utteranceSeq: 0 });
    expect(provider.frames).toBe(6);
    expect(c.inbox.filter((m) => m.type === "transcript").map((m) => (m as any).text)).toEqual(["a", "a login", "a login screen"]);
    expect(persistence.rows.map((r) => [r.sessionId === (welcome as any).sessionId, r.text, r.isFinal])).toEqual([
      [true, "a", false], [true, "a login", false], [true, "a login screen", true],
    ]);
    c.ws.close(); await app.close();
  });

  it("queues audio that arrives while the STT relay is still connecting (none dropped)", async () => {
    const { app, provider, port } = await start({}, fakeModel(LOGIN), 100);
    const c = client(port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.next((m) => m.type === "welcome");
    c.ws.send(JSON.stringify({ type: "stt_start", mode: "relay" }));
    for (let i = 0; i < 6; i++) c.ws.send(Buffer.alloc(2560)); // immediately — relay not open yet
    await c.next((m) => m.type === "transcript" && m.isFinal);
    expect(provider.frames).toBe(6);
    c.ws.close(); await app.close();
  });

  it("persists direct-mode partials sent by the browser and rejects malformed messages", async () => {
    const { app, persistence, port } = await start();
    const c = client(port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.next((m) => m.type === "welcome");
    c.ws.send(JSON.stringify({ type: "partial", utteranceSeq: 0, text: "big blue", isFinal: false, tMs: 812 }));
    c.ws.send(JSON.stringify({ type: "partial", utteranceSeq: "x" }));
    await c.next((m) => m.type === "error");
    expect(persistence.rows).toEqual([expect.objectContaining({ text: "big blue", tMs: 812, isFinal: false })]);
    c.ws.close(); await app.close();
  });

  it("allows configured origins on /stt/token and blocks others", async () => {
    const { app, port } = await start();
    const call = (origin: string) => fetch(`http://127.0.0.1:${port}/stt/token`, { method: "POST", headers: { origin } });
    expect((await call("https://app.example")).headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect((await call("https://pr-42.example")).headers.get("access-control-allow-origin")).toBe("https://pr-42.example");
    expect((await call("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    expect(await (await call("https://app.example")).json()).toEqual({ mode: "relay", provider: "deepgram-flux" });
    await app.close();
  });
});

const DB = process.env.TEST_DATABASE_URL;
describe.skipIf(!DB)("pgPersistence (local compose Postgres)", () => {
  const sql = postgres(DB ?? "", { max: 2, onnotice: () => {} });
  afterAll(() => sql.end());
  it("writes session → utterances → segments in order and finalizes", async () => {
    const p = pgPersistence(sql, (e) => { throw e; });
    const { sessionId: sid } = await p.openSession();
    p.setProvider(sid, "deepgram-flux");
    p.record(sid, { utteranceSeq: 0, text: "a login", isFinal: false, tMs: 480 });
    p.record(sid, { utteranceSeq: 0, text: "a login screen", isFinal: true, tMs: 960 });
    p.record(sid, { utteranceSeq: 1, text: "big blue", isFinal: false, tMs: 3440 });
    p.endSession(sid);
    await p.flush();
    const [s] = await sql`select stt_provider, status, ended_at is not null as ended from sessions where id = ${sid as string}`;
    expect(s).toEqual({ stt_provider: "deepgram-flux", status: "ended", ended: true });
    const rows = await sql`select u.seq, u.final_text, t.text, t.is_final, t.t_ms from transcript_segments t
                           join utterances u on u.id = t.utterance_id where u.session_id = ${sid as string} order by t.t_ms`;
    expect(rows.map((r) => [r.seq, r.text, r.is_final, r.t_ms, r.final_text])).toEqual([
      [0, "a login", false, 480, "a login screen"],
      [0, "a login screen", true, 960, "a login screen"],
      [1, "big blue", false, 3440, null],
    ]);
  });
});

describe.skipIf(!DB)("engine → Postgres FK chain (M3)", () => {
  const sql = postgres(DB ?? "", { max: 2, onnotice: () => {} });
  afterAll(() => sql.end());
  it("typed prompt writes utterance(typed) → intent → job → patch_ops → version v1 (parent v0) → current_version", async () => {
    const p = pgPersistence(sql, (e) => { throw e; });
    const opened = await p.openSession();
    const sent: ServerMsg[] = [];
    const d = new DocSession(opened, { persistence: p, model: fakeModel(LOGIN, 1), engine: { model: "fake-haiku", system: "s", render: (v) => v.partial_text! }, send: (m) => sent.push(m) });
    await d.run("add a login form", "typed", d.allocSeq());
    d.undo();
    await p.flush();
    const [u] = await sql`select source, final_text from utterances where session_id = ${opened.sessionId}`;
    expect(u).toEqual({ source: "typed", final_text: "add a login form" });
    const [j] = await sql`select j.status, j.model, j.input_tokens, i.path, i.intent->>'a' as action, i.committed
                          from generation_jobs j join intents i on i.id = j.intent_id where j.session_id = ${opened.sessionId}`;
    expect(j).toEqual({ status: "done", model: "fake-haiku", input_tokens: 700, path: "haiku", action: "add", committed: true });
    const ops = await sql`select op, primitive from patch_ops po join generation_jobs j on j.id = po.job_id where j.session_id = ${opened.sessionId} order by seq`;
    expect(ops.map((o) => [o.op, o.primitive])).toEqual([["add", "Text"], ["add", "Input"], ["add", "Input"], ["add", "Button"]]);
    const versions = await sql`select version, parent_version, job_id is not null as has_job, jsonb_array_length(doc->'root'->'children'->0->'children') as kids
                               from design_versions where document_id = ${opened.documentId} order by version`;
    expect(versions.map((v) => [v.version, v.parent_version, v.has_job, v.kids])).toEqual([[0, null, false, 0], [1, 0, true, 4]]);
    const [doc] = await sql`select current_version, jsonb_array_length(current_doc->'root'->'children'->0->'children') as kids from design_documents where id = ${opened.documentId}`;
    expect(doc).toEqual({ current_version: 0, kids: 0 }); // after undo
    const resumed = await p.resumeSession(opened.sessionId);
    expect(resumed!.current).toBe(0);
    expect(resumed).toMatchObject({ current: 0, documentId: opened.documentId });
    expect(resumed!.versions.map((v) => [v.version, v.parent])).toEqual([[0, null], [1, 0]]);
  });
});

describe.skipIf(!DB)("resuming a pre-M3 session (no version rows) — regression", () => {
  const sql = postgres(DB ?? "", { max: 2, onnotice: () => {} });
  afterAll(() => sql.end());
  it("backfills v0 from current_doc, then the next job writes version 1 (not -Infinity)", async () => {
    const [legacy] = await sql`
      with d as (insert into design_documents (user_id, current_doc, token_set_id)
                 select u.id, ${sql.json(emptyDoc() as never)}, t.id from users u, token_sets t
                 where u.email = 'anonymous@livecanvas.local' and t.name = 'default' returning id, user_id)
      insert into sessions (user_id, document_id, stt_provider) select user_id, id, 'deepgram-flux' from d returning id, document_id`;
    const p = pgPersistence(sql, (e) => { throw e; });
    const resumed = await p.resumeSession(legacy!.id);
    expect(resumed!.versions.map((v) => [v.version, v.parent])).toEqual([[0, null]]);
    const sent: ServerMsg[] = [];
    const d = new DocSession(resumed!, { persistence: p, model: fakeModel(LOGIN, 1), engine: { model: "fake", system: "s", render: (v) => v.partial_text! }, send: (m) => sent.push(m) });
    await d.run("add a login form", "typed", d.allocSeq());
    await p.flush();
    const version = sent.find((m) => m.type === "version");
    expect(ServerMsg.safeParse(version).success).toBe(true);
    expect(version).toMatchObject({ version: 1, canUndo: true });
    const rows = await sql`select version, parent_version from design_versions where document_id = ${legacy!.document_id} order by version`;
    expect(rows.map((r) => [r.version, r.parent_version])).toEqual([[0, null], [1, 0]]);
  });
});

describe("patch engine, versions, undo (M3)", () => {
  async function session(model?: ModelClient) {
    const s = await start({}, model);
    const c = client(s.port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello" }));
    const welcome = await c.next((m) => m.type === "welcome");
    await c.next((m) => m.type === "doc");
    return { ...s, c, sessionId: (welcome as { sessionId: string }).sessionId };
  }
  const done = (m: ServerMsg) => m.type === "job" && m.state !== "running";

  it("'add a login form' streams valid ops that render before the job ends, then writes version 1", async () => {
    const { app, c, persistence } = await session();
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a login form" }));
    const end = await c.next(done);
    const firstOps = c.inbox.findIndex((m) => m.type === "ops");
    expect(firstOps).toBeGreaterThan(-1);
    expect(firstOps).toBeLessThan(c.inbox.indexOf(end)); // first op before the stream ended
    expect(end).toMatchObject({ state: "done", opCount: 4 });
    expect(DesignDocSchema.safeParse(c.replica.doc).success).toBe(true);
    expect(screenOf(c.replica.doc).children!.map((n) => [n.id, n.type])).toEqual([["n_title", "Text"], ["n_email", "Input"], ["n_password", "Input"], ["n_signin", "Button"]]);
    expect(await c.next((m) => m.type === "version")).toMatchObject({ version: 1, canUndo: true, canRedo: false });
    const methods = persistence.calls.map((x) => x.method);
    expect(methods.filter((m) => m === "op")).toHaveLength(4);
    expect(methods).toEqual(expect.arrayContaining(["utterance", "intent", "jobStart", "version", "setCurrent", "jobEnd"]));
    c.ws.close(); await app.close();
  });

  it("drops invalid lines (unknown type, unknown ref, raw hex) and keeps the rest", async () => {
    const { app, c } = await session(fakeModel(["add .8 btn", "+Widget w >root", "~ghost c=primary", "+Button b >root c=#ff0000 \"Bad\"", '+Button ok >root "Ok"']));
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a button" }));
    expect(await c.next(done)).toMatchObject({ state: "done", opCount: 1 });
    expect(screenOf(c.replica.doc).children!.map((n) => n.id)).toEqual(["n_ok"]);
    c.ws.close(); await app.close();
  });

  it("undo/redo restore the exact prior docs; a new job after undo branches from it", async () => {
    const { app, c } = await session();
    const v0 = structuredClone(c.replica.doc);
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a login form" }));
    await c.next(done);
    const v1 = structuredClone(c.replica.doc);
    c.ws.send(JSON.stringify({ type: "undo" }));
    expect(await c.nth((m) => m.type === "version", 2)).toMatchObject({ version: 0, canUndo: false, canRedo: true });
    expect(c.replica.doc).toEqual(v0);
    c.ws.send(JSON.stringify({ type: "redo" }));
    expect(await c.nth((m) => m.type === "version", 3)).toMatchObject({ version: 1, canRedo: false });
    expect(c.replica.doc).toEqual(v1);
    c.ws.send(JSON.stringify({ type: "undo" }));
    await c.nth((m) => m.type === "version", 4);
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a login form again" }));
    expect(await c.nth((m) => m.type === "version", 5)).toMatchObject({ version: 2, canUndo: true });
    c.ws.close(); await app.close();
  });

  it("undo mid-stream aborts the job, restores the pre-job doc, and no later op lands", async () => {
    const { app, c } = await session(fakeModel(LOGIN, 60));
    const before = structuredClone(c.replica.doc);
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a login form" }));
    await c.next((m) => m.type === "ops");
    c.ws.send(JSON.stringify({ type: "undo" }));
    expect(await c.next(done)).toMatchObject({ state: "aborted", detail: "undo" });
    const opsAtAbort = c.count((m) => m.type === "ops");
    await new Promise((r) => setTimeout(r, 400)); // longer than the rest of the fake stream
    expect(c.count((m) => m.type === "ops")).toBe(opsAtAbort);
    expect(c.replica.doc).toEqual(before);
    c.ws.close(); await app.close();
  });

  it("a new prompt aborts the running job, rolls it back, then completes", async () => {
    const { app, c } = await session(fakeModel(LOGIN, 40));
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a login form" }));
    await c.next((m) => m.type === "ops");
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a login form, please" }));
    const states = [await c.nth(done, 1), await c.nth(done, 2)].map((m) => (m as { state: string }).state);
    expect(states).toEqual(["aborted", "done"]);
    expect(screenOf(c.replica.doc).children!.map((n) => n.id)).toEqual(["n_title", "n_email", "n_password", "n_signin"]);
    c.ws.close(); await app.close();
  });

  it("hello with a previous sessionId resumes the same doc and version (as a fresh session row, ADR 0014)", async () => {
    const { app, c, port, sessionId } = await session();
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a login form" }));
    await c.next((m) => m.type === "version");
    const last = structuredClone(c.replica.doc);
    c.ws.close();
    const c2 = client(port); await c2.open;
    c2.ws.send(JSON.stringify({ type: "hello", sessionId }));
    const w2 = await c2.next((m) => m.type === "welcome") as Extract<ServerMsg, { type: "welcome" }>;
    expect(w2).toMatchObject({ resumed: true, version: 1 });
    // The session id is deliberately not asserted: if the reconnect races the old socket's close, the
    // tab takes the still-live session over (same row, seqs continue); otherwise it's a fresh row. Both
    // are correct — the Postgres reload-race test covers the fresh-row path deterministically.
    await c2.next((m) => m.type === "doc");
    expect(c2.replica.doc).toEqual(last);
    c2.ws.close(); await app.close();
  });

  it("a final voice utterance runs a job on the finished text", async () => {
    const model = fakeModel(LOGIN);
    const { app, c } = await session(model);
    c.ws.send(JSON.stringify({ type: "partial", utteranceSeq: 0, text: "a login", isFinal: false, tMs: 400 }));
    c.ws.send(JSON.stringify({ type: "partial", utteranceSeq: 0, text: "a login form", isFinal: true, tMs: 900 }));
    expect(await c.next(done)).toMatchObject({ state: "done" });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toContain("a login form");
    c.ws.close(); await app.close();
  });
});

describe("feature flags + admin + vocabulary (ADR 0012)", () => {
  const TOKEN = "t".repeat(32);
  const hello = async (port: number) => { const c = client(port); await c.open; c.ws.send(JSON.stringify({ type: "hello" })); await c.next((m) => m.type === "vocab"); return c; };

  it("admin API: 503 without ADMIN_TOKEN, 401 on a wrong token, flips a flag and broadcasts it", async () => {
    const off = await start();
    expect((await fetch(`http://127.0.0.1:${off.port}/admin/flags`)).status).toBe(503);
    await off.app.close();

    const { app, port } = await start({ ADMIN_TOKEN: TOKEN });
    const c = await hello(port);
    expect((c.inbox.find((m) => m.type === "welcome") as any).flags.diagram_erd).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/admin/flags`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const put = await fetch(`http://127.0.0.1:${port}/admin/flags/diagram_erd`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect(put.status).toBe(200);
    const pushed = await c.next((m) => m.type === "flags");
    expect((pushed as any).flags.diagram_erd).toBe(false);
    const list = await (await fetch(`http://127.0.0.1:${port}/admin/flags`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as any;
    expect(list.flags.find((f: any) => f.key === "diagram_erd")).toMatchObject({ enabled: false, default: true });
    expect(list.flags.find((f: any) => f.key === "speak_to_create").last7d.exposed).toBeGreaterThanOrEqual(1);
    c.ws.close(); await app.close();
  });

  it("a rejected admin request stops at the 401 — a wrong token never flips a flag (2026-09-28)", async () => {
    // The guard used to return the Fastify reply; replies are thenables, so `await` turned the denial into
    // `undefined` and the handler ran on after the 401 was sent.
    const { app, port } = await start({ ADMIN_TOKEN: TOKEN });
    const bad = await fetch(`http://127.0.0.1:${port}/admin/flags/diagram_erd`, { method: "PUT", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect(bad.status).toBe(401);
    await new Promise((r) => setTimeout(r, 50));
    const list = await (await fetch(`http://127.0.0.1:${port}/admin/flags`, { headers: { authorization: `Bearer ${TOKEN}` } })).json() as any;
    expect(list.flags.find((f: any) => f.key === "diagram_erd").enabled).toBe(true);
    await app.close();
  });

  it("admin CORS answers only the admin origins, never the preview pattern", async () => {
    const { app, port } = await start({ ADMIN_TOKEN: TOKEN, ADMIN_ORIGINS: "https://app.example" });
    const pre = (origin: string) => fetch(`http://127.0.0.1:${port}/admin/flags/diagram_erd`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": "authorization" } });
    const ok = await pre("https://app.example");
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(ok.headers.get("access-control-allow-methods")).toContain("PUT");
    expect((await pre("https://pr-12.example")).headers.get("access-control-allow-origin")).toBeNull();
    await app.close();
  });

  it("the gateway rejects a disabled diagram kind and records it as blocked", async () => {
    const { app, port, persistence } = await start({ ADMIN_TOKEN: TOKEN });
    await fetch(`http://127.0.0.1:${port}/admin/flags/diagram_sequence`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    const c = await hello(port);
    c.ws.send(JSON.stringify({ type: "new_doc", kind: "sequence" }));
    const err = await c.next((m) => m.type === "error");
    expect((err as any).message).toMatch(/turned off/);
    expect(c.count((m) => m.type === "view" && m.view === "sequence")).toBe(0);
    expect(persistence.events.some((e) => e.key === "diagram_sequence" && e.action === "blocked")).toBe(true);
    c.ws.send(JSON.stringify({ type: "set_view", view: "architecture" }));
    await c.next((m) => m.type === "view" && m.view === "architecture");
    expect(persistence.events.some((e) => e.key === "diagram_architecture" && e.action === "used")).toBe(true);
    c.ws.close(); await app.close();
  });

  it("voice: 'define kafka as a queue' proposes (draws nothing, no model call); 'confirm' locks it in; the next 'kafka' draws it", async () => {
    const model = fakeModel(["none 0"]);
    const { app, port } = await start({}, model);
    const c = await hello(port);
    c.ws.send(JSON.stringify({ type: "set_view", view: "architecture" }));
    await c.next((m) => m.type === "view" && m.view === "architecture");
    c.ws.send(JSON.stringify({ type: "stt_start", mode: "direct" }));
    const say = (seq: number, text: string, isFinal = false) => c.ws.send(JSON.stringify({ type: "partial", utteranceSeq: seq, text, isFinal, tMs: 0 }));
    const words = "define ledger as a queue".split(" ");
    for (let n = 1; n <= words.length; n++) say(0, words.slice(0, n).join(" "), n === words.length);
    const proposed = await c.next((m) => m.type === "vocab_proposed");
    expect((proposed as any).term).toMatchObject({ phrase: "ledger", status: "proposed", node: { label: "Ledger", kind: "queue", tier: "api" } });
    say(1, "confirm", true);
    await c.nth((m) => m.type === "vocab" && (m as any).terms.some((t: any) => t.status === "confirmed"), 1);
    for (const [i, t] of ["the api", "the api writes to the ledger"].entries()) say(2, t, i === 1);
    await new Promise((r) => setTimeout(r, 150));
    const labels = JSON.stringify(c.replica.doc);
    expect(labels).toContain('"Ledger"');
    expect(c.count((m) => m.type === "ops" && m.origin === "lexicon" && JSON.stringify(m.ops).includes('"Queue"'))).toBe(0); // "queue" in the command drew nothing
    expect(model.requests.some((r) => r.includes("define"))).toBe(false);
    c.ws.close(); await app.close();
  });

  it("vocabulary messages are rejected when custom_vocabulary is off", async () => {
    const { app, port } = await start({ ADMIN_TOKEN: TOKEN });
    await fetch(`http://127.0.0.1:${port}/admin/flags/custom_vocabulary`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    const c = await hello(port);
    c.ws.send(JSON.stringify({ type: "vocab_define", kind: "architecture", phrase: "kafka", node: { label: "Kafka", kind: "queue", tier: "api" } }));
    expect(((await c.next((m) => m.type === "error")) as any).message).toMatch(/turned off/);
    c.ws.close(); await app.close();
  });
});

describe.skipIf(!DB)("flags, usage and vocabulary in Postgres (ADR 0012)", () => {
  const sql = postgres(DB ?? "", { max: 2, onnotice: () => {} });
  afterAll(() => sql.end());
  it("round-trips flags, counts feature events, and upserts/deletes vocabulary per document", async () => {
    const p = pgPersistence(sql, (e) => { throw e; });
    const { sessionId: sid, documentId: did } = await p.openSession();
    const before = (await p.loadFlags()).diagram_metrics;
    await p.setFlag("diagram_metrics", true);
    expect((await p.loadFlags()).diagram_metrics).toBe(true);
    await p.setFlag("diagram_metrics", before ?? false);
    const n0 = (await p.flagStats(1)).custom_vocabulary?.used ?? 0;
    p.featureEvent(sid, "custom_vocabulary", "used");
    const term = { id: crypto.randomUUID(), kind: "architecture" as const, phrase: "ledger", node: { label: "Ledger", kind: "queue" as const, tier: "api" as const }, status: "proposed" as const };
    p.putVocab(sid, did, term);
    p.putVocab(sid, did, { ...term, id: crypto.randomUUID(), status: "confirmed" }); // same phrase: upsert, new id wins
    await p.flush();
    expect((await p.flagStats(1)).custom_vocabulary?.used).toBe(n0 + 1);
    const list = await p.listVocab(did);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ phrase: "ledger", status: "confirmed", node: { label: "Ledger" } });
    p.deleteVocab(sid, did, list[0]!.id);
    await p.flush();
    expect(await p.listVocab(did)).toEqual([]);
  });
});

describe("transcript highlighting (ADR 0012)", () => {
  it("marks drawn words with what they drew and the words sent to the model, keyed by the client's utterance", async () => {
    const { app, port, persistence } = await start({}, fakeModel(["add .9", '^n_p_logo >root @0']));
    const c = client(port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.next((m) => m.type === "vocab");
    c.ws.send(JSON.stringify({ type: "stt_start", mode: "direct" }));
    const text = "a login screen with email and password big blue sign in button logo on top";
    const w = text.split(" ");
    for (let n = 1; n <= w.length; n++) c.ws.send(JSON.stringify({ type: "partial", utteranceSeq: 7, text: w.slice(0, n).join(" "), isFinal: n === w.length, tMs: n * 300 }));
    await new Promise((r) => setTimeout(r, 200));
    const last = c.inbox.filter((m) => m.type === "words").at(-1) as Extract<ServerMsg, { type: "words" }>;
    expect(last.utteranceSeq).toBe(7);
    const by = Object.fromEntries(last.marks.map((m) => [m.key, m]));
    expect(by["email#1"]).toMatchObject({ as: "drawn", label: "Email" });
    expect(by["button#1"]).toMatchObject({ as: "drawn", label: "Sign in" });
    expect(by["blue#1"]).toMatchObject({ as: "drawn" }); // a modifier attached to the button
    expect(by["top#1"]).toMatchObject({ as: "model" });
    expect(by["with#1"]).toBeUndefined();
    expect(persistence.events.filter((e) => e.key === "transcript_highlight" && e.action === "used")).toHaveLength(1);
    c.ws.close(); await app.close();
  });
});

describe("share links (ADR 0013)", () => {
  const TOKEN = "t".repeat(32);
  it("pins a link to the version on screen, one per version; revoke → 404 on the next view; unknown tokens 404", async () => {
    const { app, port } = await start({}, fakeModel(LOGIN));
    const c = client(port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello" }));
    await c.next((m) => m.type === "shares");
    c.ws.send(JSON.stringify({ type: "prompt", text: "a login screen" }));
    await c.next((m) => m.type === "version" && m.version === 1);
    c.ws.send(JSON.stringify({ type: "share_create" }));
    const s1 = await c.nth((m) => m.type === "shares", 2) as Extract<ServerMsg, { type: "shares" }>;
    expect(s1.links).toHaveLength(1);
    const { token, version } = s1.links[0]!;
    expect(version).toBe(1);
    c.ws.send(JSON.stringify({ type: "share_create" })); // same version → same link
    const s2 = await c.nth((m) => m.type === "shares", 3) as Extract<ServerMsg, { type: "shares" }>;
    expect(s2.links.map((l) => l.token)).toEqual([token]);

    c.ws.send(JSON.stringify({ type: "set_title", title: "Moved on" })); // the author keeps editing …
    await c.next((m) => m.type === "version" && m.version === 2);
    const view = await fetch(`http://127.0.0.1:${port}/share/${token}`);
    expect(view.status).toBe(200);
    expect(view.headers.get("cache-control")).toBe("no-store");
    const body = await view.json() as any;
    expect(body.version).toBe(1); // … but the link still shows what was shared
    expect(body.doc.root.children[0].children.some((n: any) => n.type === "Button")).toBe(true);
    expect(body.doc.root.props.title).toBeUndefined(); // the title came later

    c.ws.send(JSON.stringify({ type: "share_revoke", token }));
    await c.nth((m) => m.type === "shares", 4);
    expect((await fetch(`http://127.0.0.1:${port}/share/${token}`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/share/AAAAAAAAAAAAAAAAAAAAAA`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/share/not-a-token`)).status).toBe(404);
    c.ws.close(); await app.close();
  });

  it("a socket can only revoke its own document's links", async () => {
    const { app, port } = await start();
    const a = client(port); await a.open; a.ws.send(JSON.stringify({ type: "hello" })); await a.next((m) => m.type === "shares");
    a.ws.send(JSON.stringify({ type: "share_create" }));
    const { token } = ((await a.nth((m) => m.type === "shares", 2)) as Extract<ServerMsg, { type: "shares" }>).links[0]!;
    const b = client(port); await b.open; b.ws.send(JSON.stringify({ type: "hello" })); await b.next((m) => m.type === "shares");
    b.ws.send(JSON.stringify({ type: "share_revoke", token }));
    await b.nth((m) => m.type === "shares", 2);
    expect((await fetch(`http://127.0.0.1:${port}/share/${token}`)).status).toBe(200);
    a.ws.close(); b.ws.close(); await app.close();
  });

  it("flag off: create is refused and existing links stop resolving", async () => {
    const { app, port } = await start({ ADMIN_TOKEN: TOKEN });
    const c = client(port); await c.open; c.ws.send(JSON.stringify({ type: "hello" })); await c.next((m) => m.type === "shares");
    c.ws.send(JSON.stringify({ type: "share_create" }));
    const { token } = ((await c.nth((m) => m.type === "shares", 2)) as Extract<ServerMsg, { type: "shares" }>).links[0]!;
    await fetch(`http://127.0.0.1:${port}/admin/flags/share_links`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect((await fetch(`http://127.0.0.1:${port}/share/${token}`)).status).toBe(404);
    c.ws.send(JSON.stringify({ type: "share_create" }));
    expect(((await c.next((m) => m.type === "error")) as any).message).toMatch(/turned off/);
    c.ws.close(); await app.close();
  });
});

describe.skipIf(!DB)("share links in Postgres (ADR 0013)", () => {
  const sql = postgres(DB ?? "", { max: 2, onnotice: () => {} });
  afterAll(() => sql.end());
  it("stores the link as an exports row pinned to the version; revoke hides it", async () => {
    const p = pgPersistence(sql, (e) => { throw e; });
    const { sessionId: sid, documentId: did } = await p.openSession();
    const token = "B".repeat(22);
    await sql`delete from exports where token = ${token}`;
    p.createShare(sid, { documentId: did, version: 0, token });
    await p.flush();
    expect(await p.listShares(did)).toEqual([{ token, version: 0 }]);
    expect((await p.readShare(token))?.version).toBe(0);
    const [row] = await sql`select format, uri from exports where token = ${token}`;
    expect(row).toEqual({ format: "url", uri: `/s/${token}` });
    await p.revokeShare(did, token);
    expect(await p.readShare(token)).toBeNull();
    expect(await p.listShares(did)).toEqual([]);
  });
});

describe("remember the document across tabs (ADR 0014)", () => {
  const hello = async (port: number, ids: { sessionId?: string; documentId?: string } = {}) => {
    const c = client(port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello", ...ids }));
    const w = await c.next((m) => m.type === "welcome") as Extract<ServerMsg, { type: "welcome" }>;
    await c.next((m) => m.type === "doc");
    return { c, w };
  };

  it("a new tab with the browser's documentId reopens the document — after the first tab closed", async () => {
    const { app, port } = await start();
    const a = await hello(port);
    a.c.ws.send(JSON.stringify({ type: "prompt", text: "a login screen" }));
    await a.c.next((m) => m.type === "version" && m.version === 1);
    a.c.ws.close();
    await new Promise((r) => setTimeout(r, 50));
    const b = await hello(port, { documentId: a.w.documentId });
    expect(b.w).toMatchObject({ documentId: a.w.documentId, version: 1, resumed: true });
    expect(b.w.sessionId).not.toBe(a.w.sessionId); // every open is a fresh session row
    expect(screenOf(b.c.replica.doc).children!.some((n) => n.type === "Button")).toBe(true);
    b.c.ws.close(); await app.close();
  });

  it("opening it in a second tab takes it over; the first tab is told and can no longer edit", async () => {
    const { app, port } = await start();
    const a = await hello(port);
    const b = await hello(port, { documentId: a.w.documentId });
    expect(b.w.version).toBe(0);
    await a.c.next((m) => m.type === "taken_over");
    a.c.ws.send(JSON.stringify({ type: "prompt", text: "a login screen" }));
    expect(((await a.c.next((m) => m.type === "error")) as any).message).toMatch(/another tab/);
    b.c.ws.send(JSON.stringify({ type: "prompt", text: "a login screen" }));
    await b.c.next((m) => m.type === "version" && m.version === 1);
    expect(a.c.count((m) => m.type === "ops")).toBe(0); // the old tab gets nothing after takeover
    a.c.ws.close(); // closing the old tab must not release the new owner's document
    await new Promise((r) => setTimeout(r, 50));
    b.c.ws.send(JSON.stringify({ type: "undo" }));
    await b.c.next((m) => m.type === "version" && m.version === 0);
    b.c.ws.close(); await app.close();
  });

  it("flag off: documentId is ignored — a new tab gets a new document", async () => {
    const TOKEN = "t".repeat(32);
    const { app, port, persistence } = await start({ ADMIN_TOKEN: TOKEN });
    await fetch(`http://127.0.0.1:${port}/admin/flags/remember_document`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    const a = await hello(port);
    const b = await hello(port, { documentId: a.w.documentId });
    expect(b.w.documentId).not.toBe(a.w.documentId);
    expect(persistence.events.some((e) => e.key === "remember_document" && e.action === "blocked")).toBe(true);
    a.c.ws.close(); b.c.ws.close(); await app.close();
  });

  it("an unknown documentId falls back to a new document (the client overwrites its stored id)", async () => {
    const { app, port } = await start();
    const a = await hello(port, { documentId: "00000000-0000-4000-8000-000000000000" });
    expect(a.w.resumed).toBe(false);
    expect(a.w.documentId).not.toBe("00000000-0000-4000-8000-000000000000");
    a.c.ws.close(); await app.close();
  });
});

describe.skipIf(!DB)("reload race against Postgres (ADR 0014)", () => {
  const sql = postgres(DB ?? "", { max: 4, onnotice: () => {} });
  afterAll(() => sql.end());
  it("close then reopen at once: the reopened tab sees v1 and its next version persists as v2", async () => {
    const persistence = pgPersistence(sql, (e) => { throw e; });
    const config = loadConfig({ CORS_ORIGINS: "https://app.example" } as NodeJS.ProcessEnv);
    const engine = { model: "fake-haiku", system: "sys", render: (v: Record<string, string>) => `${v.doc_compact}\n---\n${v.partial_text}` };
    const app = buildServer(config, { persistence, sttGrant: async () => ({ mode: "relay", provider: "deepgram-flux" }), relayProvider: fakeProvider(), model: fakeModel(LOGIN), engine });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const a = client(port); await a.open; a.ws.send(JSON.stringify({ type: "hello" }));
    const w = await a.next((m) => m.type === "welcome") as Extract<ServerMsg, { type: "welcome" }>;
    a.ws.send(JSON.stringify({ type: "prompt", text: "a login screen" }));
    await a.next((m) => m.type === "version" && m.version === 1);
    a.ws.close(); // no wait: the version rows may still be queued
    const b = client(port); await b.open; b.ws.send(JSON.stringify({ type: "hello", documentId: w.documentId }));
    const w2 = await b.next((m) => m.type === "welcome") as Extract<ServerMsg, { type: "welcome" }>;
    expect(w2.version).toBe(1);
    b.ws.send(JSON.stringify({ type: "set_title", title: "Reopened" }));
    await b.next((m) => m.type === "version" && m.version === 2);
    b.ws.close();
    await persistence.flush();
    const rows = await sql`select version from design_versions where document_id = ${w.documentId!} order by version`;
    expect(rows.map((r) => r.version)).toEqual([0, 1, 2]);
    await app.close();
  });
});

describe("version timeline over the socket (ADR 0015)", () => {
  it("welcome carries the timeline; goto_version is refused when the flag is off", async () => {
    const TOKEN = "t".repeat(32);
    const { app, port } = await start({ ADMIN_TOKEN: TOKEN });
    const c = client(port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello" }));
    const v = await c.next((m) => m.type === "versions") as Extract<ServerMsg, { type: "versions" }>;
    expect(v).toMatchObject({ current: 0, path: [0] });
    await fetch(`http://127.0.0.1:${port}/admin/flags/version_timeline`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    c.ws.send(JSON.stringify({ type: "goto_version", version: 0 }));
    expect(((await c.next((m) => m.type === "error")) as any).message).toMatch(/turned off/);
    c.ws.close(); await app.close();
  });
});

describe("project library + flag history (ADR 0020)", () => {
  const TOKEN = "t".repeat(32);
  const hello = async (port: number, extra: Record<string, unknown> = {}) => {
    const c = client(port); await c.open;
    c.ws.send(JSON.stringify({ type: "hello", ...extra }));
    await c.next((m) => m.type === "welcome" || m.type === "in_use");
    return c;
  };
  const docIdOf = (c: ReturnType<typeof client>) => (c.inbox.find((m) => m.type === "welcome") as any)?.documentId as string;

  it("save lists the project; archive hides it; restore brings it back; unsaved projects are never listed", async () => {
    const { app, port } = await start();
    const a = await hello(port);
    const b = await hello(port); // never saved
    a.ws.send(JSON.stringify({ type: "save_project", title: "Contact center" }));
    await a.next((m) => m.type === "project" && m.savedAt != null);
    const list = async (q = "") => ((await (await fetch(`http://127.0.0.1:${port}/projects${q}`)).json()) as any).projects as Array<{ id: string; title: string }>;
    expect((await list()).map((p) => p.title)).toEqual(["Contact center"]);
    expect((await list()).map((p) => p.id)).not.toContain(docIdOf(b));
    const id = docIdOf(a);
    expect((await fetch(`http://127.0.0.1:${port}/projects/${id}/archive`, { method: "POST" })).status).toBe(200);
    expect(await list()).toEqual([]);
    expect((await list("?archived=1")).map((p) => p.id)).toEqual([id]);
    await fetch(`http://127.0.0.1:${port}/projects/${id}/restore`, { method: "POST" });
    expect((await list()).map((p) => p.id)).toEqual([id]);
    expect((await fetch(`http://127.0.0.1:${port}/projects/${docIdOf(b)}/archive`, { method: "POST" })).status).toBe(404); // unsaved
    a.ws.close(); b.ws.close(); await app.close();
  });

  it("opening from the library lands on the picked project, not the tab's old one; an owned project is offered read-only", async () => {
    const { app, port } = await start();
    const a = await hello(port);
    a.ws.send(JSON.stringify({ type: "save_project", title: "A" }));
    await a.next((m) => m.type === "project" && m.savedAt != null);
    const b = await hello(port);
    const bSession = (b.inbox.find((m) => m.type === "welcome") as any).sessionId;
    b.ws.close();
    await new Promise((r) => setTimeout(r, 30));
    // Tab B (sessionId still in its storage) opens A from the library while A's owner is connected → in_use, no takeover.
    const c = await hello(port, { sessionId: bSession, documentId: docIdOf(a), open: true });
    expect(c.inbox.some((m) => m.type === "in_use")).toBe(true);
    expect(a.inbox.some((m) => m.type === "taken_over")).toBe(false);
    const ro = (await (await fetch(`http://127.0.0.1:${port}/projects/${docIdOf(a)}`)).json()) as any;
    expect(ro.title).toBe("A");
    // Once A's tab is gone, the same open lands on A (not on B's old document).
    a.ws.close();
    await new Promise((r) => setTimeout(r, 30));
    const d = await hello(port, { sessionId: bSession, documentId: docIdOf(a), open: true });
    expect(docIdOf(d)).toBe(docIdOf(a));
    c.ws.close(); d.ws.close(); await app.close();
  });

  it("the library is behind its flag", async () => {
    const { app, port } = await start({ ADMIN_TOKEN: TOKEN });
    await fetch(`http://127.0.0.1:${port}/admin/flags/project_library`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    expect((await fetch(`http://127.0.0.1:${port}/projects`)).status).toBe(404);
    await app.close();
  });

  it("flag history records admin flips (actor = short hash, never the IP) and never a rejected one", async () => {
    const { app, port } = await start({ ADMIN_TOKEN: TOKEN });
    const put = (auth: string, enabled: boolean) => fetch(`http://127.0.0.1:${port}/admin/flags/share_links`, { method: "PUT", headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
    expect((await put("nope", false)).status).toBe(401);
    await put(TOKEN, false);
    await put(TOKEN, true);
    const h = (await (await fetch(`http://127.0.0.1:${port}/admin/flags/history`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any;
    expect(h.changes.map((c: any) => [c.key, c.enabled, c.source])).toEqual([["share_links", true, "admin"], ["share_links", false, "admin"]]);
    expect(h.changes[0].actor).toMatch(/^[0-9a-f]{8}$/);
    const flagsList = (await (await fetch(`http://127.0.0.1:${port}/admin/flags`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()) as any;
    expect(flagsList.flags.find((f: any) => f.key === "share_links").lastChange.enabled).toBe(true);
    expect((await fetch(`http://127.0.0.1:${port}/admin/flags/history`)).status).toBe(401);
    await app.close();
  });

  it("pending suggestions are replayed to a tab that reloads (plan-critic M8 #5)", async () => {
    const { app, port } = await start();
    const a = await hello(port);
    const { sessionId } = a.inbox.find((m) => m.type === "welcome") as any;
    a.ws.send(JSON.stringify({ type: "set_view", view: "erd" }));
    await a.next((m) => m.type === "view" && m.view === "erd");
    a.ws.send(JSON.stringify({ type: "partial", utteranceSeq: 0, text: "customers and cases", isFinal: true, tMs: 900 }));
    await a.next((m) => m.type === "suggestions" && m.items.length > 0);
    a.ws.close();
    await new Promise((r) => setTimeout(r, 30));
    const b = await hello(port, { sessionId });
    const s = (await b.next((m) => m.type === "suggestions")) as any;
    expect(s.items.map((x: any) => x.target)).toContain("n_p_cases");
    b.ws.close(); await app.close();
  });
});
