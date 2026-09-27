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
function fakeProvider(): SttProvider & { frames: number } {
  const p = {
    frames: 0, pricePerMin: 0, needs: "", ready: () => true,
    connect: async () => {
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

async function start(extra: Record<string, string> = {}, model: ModelClient = fakeModel(LOGIN)) {
  const persistence = memoryPersistence();
  const provider = fakeProvider();
  const config = loadConfig({ CORS_ORIGINS: "https://app.example", CORS_ORIGIN_PATTERN: "^https://pr-\\d+\\.example$", ...extra } as NodeJS.ProcessEnv);
  const engine = { model: "fake-haiku", system: "sys", render: (v: Record<string, string>) => `${v.doc_compact}\n---\n${v.partial_text}` };
  const app = buildServer(config, { persistence, sttGrant: async () => ({ mode: "relay", provider: "deepgram-flux" }), relayProvider: provider, model, engine });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, persistence, provider, port };
}

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
    const versions = await sql`select version, parent_version, job_id is not null as has_job, jsonb_array_length(doc->'root'->'children') as kids
                               from design_versions where document_id = ${opened.documentId} order by version`;
    expect(versions.map((v) => [v.version, v.parent_version, v.has_job, v.kids])).toEqual([[0, null, false, 0], [1, 0, true, 4]]);
    const [doc] = await sql`select current_version, jsonb_array_length(current_doc->'root'->'children') as kids from design_documents where id = ${opened.documentId}`;
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
    expect(c.replica.doc!.root.children!.map((n) => [n.id, n.type])).toEqual([["n_title", "Text"], ["n_email", "Input"], ["n_password", "Input"], ["n_signin", "Button"]]);
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
    expect(c.replica.doc!.root.children!.map((n) => n.id)).toEqual(["n_ok"]);
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
    expect(c.replica.doc!.root.children!.map((n) => n.id)).toEqual(["n_title", "n_email", "n_password", "n_signin"]);
    c.ws.close(); await app.close();
  });

  it("hello with a previous sessionId resumes the same doc and version", async () => {
    const { app, c, port, sessionId } = await session();
    c.ws.send(JSON.stringify({ type: "prompt", text: "add a login form" }));
    await c.next((m) => m.type === "version");
    const last = structuredClone(c.replica.doc);
    c.ws.close();
    const c2 = client(port); await c2.open;
    c2.ws.send(JSON.stringify({ type: "hello", sessionId }));
    expect(await c2.next((m) => m.type === "welcome")).toMatchObject({ sessionId, resumed: true, version: 1 });
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
