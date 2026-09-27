import { ServerMsg } from "@livecanvas/dsl";
import type { AddressInfo } from "node:net";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
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

async function start(extra: Record<string, string> = {}) {
  const persistence = memoryPersistence();
  const provider = fakeProvider();
  const config = loadConfig({ CORS_ORIGINS: "https://app.example", CORS_ORIGIN_PATTERN: "^https://pr-\\d+\\.example$", ...extra } as NodeJS.ProcessEnv);
  const app = buildServer(config, { persistence, sttGrant: async () => ({ mode: "relay", provider: "deepgram-flux" }), relayProvider: provider });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;
  return { app, persistence, provider, port };
}

function client(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: ServerMsg[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (d) => { inbox.push(ServerMsg.parse(JSON.parse(d.toString()))); waiters.splice(0).forEach((w) => w()); });
  const next = async (pred: (m: ServerMsg) => boolean) => {
    for (;;) { const hit = inbox.find(pred); if (hit) return hit; await new Promise<void>((r) => waiters.push(r)); }
  };
  return { ws, inbox, next, open: new Promise((r) => ws.once("open", r)) };
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
    const sid = await p.openSession();
    p.setProvider(sid, "deepgram-flux");
    p.record(sid, { utteranceSeq: 0, text: "a login", isFinal: false, tMs: 480 });
    p.record(sid, { utteranceSeq: 0, text: "a login screen", isFinal: true, tMs: 960 });
    p.record(sid, { utteranceSeq: 1, text: "big blue", isFinal: false, tMs: 3440 });
    p.endSession(sid);
    await p.flush();
    const [s] = await sql`select stt_provider, status, ended_at is not null as ended from sessions where id = ${sid}`;
    expect(s).toEqual({ stt_provider: "deepgram-flux", status: "ended", ended: true });
    const rows = await sql`select u.seq, u.final_text, t.text, t.is_final, t.t_ms from transcript_segments t
                           join utterances u on u.id = t.utterance_id where u.session_id = ${sid} order by t.t_ms`;
    expect(rows.map((r) => [r.seq, r.text, r.is_final, r.t_ms, r.final_text])).toEqual([
      [0, "a login", false, 480, "a login screen"],
      [0, "a login screen", true, 960, "a login screen"],
      [1, "big blue", false, 3440, null],
    ]);
  });
});
