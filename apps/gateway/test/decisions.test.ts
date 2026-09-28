import { architectureDoc, emptyDoc, erdDoc, sequenceDoc, type DesignDoc, type ServerMsg } from "@livecanvas/dsl";
import { describe, expect, it } from "vitest";
import { decisionsToLines, mentions, planDecisions } from "../src/engine/decisions.js";
import { DocSession } from "../src/engine/docSession.js";
import type { JevAnswer, JevClient } from "../src/engine/jev.js";
import type { ModelClient } from "../src/engine/model.js";
import { memoryPersistence } from "../src/persist.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const view = (d: DesignDoc) => d; // fixtures are single-view docs
const pick = (choice: string, confidence = 0.97): JevAnswer => ({ type: "choice", choice, confidence });

describe("decisions planner (ADR 0017)", () => {
  it("finds mentioned elements, longest label first, in transcript order", () => {
    const ms = mentions([{ id: "n_g", label: "Genesys" }, { id: "n_gb", label: "Genesys bot" }, { id: "n_li", label: "line_items" }], ["the", "genesys", "bot", "and", "line", "items"]);
    expect(ms.map((m) => m.id)).toEqual(["n_gb", "n_li"]);
  });

  it("asks one 3-way choice per adjacent pair — multi-clause sentences never pair the ends", () => {
    const p = planDecisions(view(architectureDoc), "architecture", "the studio calls the gateway which writes to postgres")!;
    expect(Object.keys(p.questions).filter((k) => k.startsWith("rel:"))).toHaveLength(2);
    expect(Object.keys((p.questions["rel:0"] as { criteria: Record<string, string> }).criteria)).toEqual(["studio->gateway", "gateway->studio", "none"]);
    expect(Object.keys((p.questions["rel:1"] as { criteria: Record<string, string> }).criteria)).toContain("gateway->postgres");
  });

  it("confident answers become edges with labels from the words between; unsure ones are left to the model", () => {
    const text = "the studio calls the gateway which writes to postgres";
    const p = planDecisions(view(architectureDoc), "architecture", text)!;
    const d = decisionsToLines(p, { "rel:0": pick("studio->gateway"), "style:0": pick("sync"), "rel:1": pick("gateway->postgres", 0.5), "style:1": pick("sync") });
    expect(d.lines).toEqual(['+Edge jev1 >root from=n_studio to=n_gateway "calls"']);
    expect(d).toMatchObject({ accepted: 1, unsure: 1 });
    expect(d.covered).toEqual(["calls#1"]);
  });

  it("passive voice: 'postgres is read by redis' becomes redis → postgres labelled 'read'", () => {
    const p = planDecisions(view(architectureDoc), "architecture", "postgres is read by redis")!;
    const d = decisionsToLines(p, { "rel:0": pick("redis->postgres"), "style:0": pick("sync") });
    expect(d.lines).toEqual(['+Edge jev1 >root from=n_redis to=n_pg "read"']);
  });

  it("ERD: a one-to-many adds the foreign key column to the many side, then the relationship", () => {
    const p = planDecisions(view(erdDoc), "erd", "each users row has many sessions")!;
    const d = decisionsToLines(p, { "rel:0": pick("users->sessions"), "card:0": pick("1:n") }, () => ["id:uuid:pk", "document_id:uuid:fk"]);
    expect(d.lines).toEqual(["~n_sessions cols=id:uuid:pk,document_id:uuid:fk,user_id:uuid:fk", '+Edge jev1 >root from=n_users to=n_sessions card=1:n "has many"']);
  });

  it("sequence: a reply becomes a dashed return message", () => {
    const p = planDecisions(view(sequenceDoc), "sequence", "haiku returns compact ops to the gateway")!;
    const d = decisionsToLines(p, { "rel:0": pick("haiku->gateway"), "kind:0": pick("return") });
    expect(d.lines).toEqual(['+Edge jev1 >root from=n_llm to=n_gw style=return "Returns compact ops"']);
  });

  it("screen: 'logo on top' moves the logo first; no position word → nothing to ask", () => {
    const screen: DesignDoc = { ...emptyDoc(), root: { ...emptyDoc().root, children: [
      { id: "n_p_email", type: "Input", props: { label: "Email", kind: "email" } },
      { id: "n_p_logo", type: "Image", props: { alt: "Logo" } },
    ] } };
    const p = planDecisions(screen, "screen", "logo on top")!;
    const d = decisionsToLines(p, { target: pick("logo") });
    expect(d.lines).toEqual(["^n_p_logo >root @0"]);
    expect(d.covered).toEqual(expect.arrayContaining(["top#1"]));
    expect(planDecisions(screen, "screen", "a logo and an email")).toBeNull();
  });
});

describe("DocSession with Jev (ADR 0017)", () => {
  function session(jev: JevClient | undefined, reply: (t: string) => string[] = () => ["none 0"]) {
    const calls: string[] = [];
    const sent: ServerMsg[] = [];
    const model: ModelClient = (req) => {
      calls.push(req.user);
      async function* gen() { for (const line of reply(req.user)) { await sleep(3); yield { line, atMs: 400 }; } }
      return { lines: gen(), usage: Promise.resolve({ inputTokens: 700, outputTokens: 30 }) };
    };
    return (async () => {
      const persistence = memoryPersistence();
      const d = new DocSession(await persistence.openSession(), {
        persistence, model, send: (m) => sent.push(m), ...(jev ? { jev } : {}),
        engine: { model: "fake-haiku", system: "s", render: (v) => `${v.doc_compact}\n---\n${v.partial_text}` },
      });
      return { d, calls, sent };
    })();
  }
  const speak = async (d: DocSession, text: string, seq = 0) => {
    const w = text.split(" ");
    for (let n = 1; n <= w.length; n++) { d.onTranscript(seq, w.slice(0, n).join(" "), n === w.length, n * 300); await sleep(15); }
    for (let i = 0; i < 100 && (d as unknown as { active: unknown }).active; i++) await sleep(5);
    await sleep(20);
  };
  const edges = (d: DocSession) => (d.doc.root.children ?? []).filter((c) => c.type === "Edge");

  it("the definition-of-done sentence needs no model call and no Jev call: 'logo on top' is decided by grammar", async () => {
    let jevCalls = 0;
    const jev: JevClient = async () => { jevCalls++; return { ms: 90, inputTokens: 300, answers: {} }; };
    const { d, calls, sent } = await session(jev);
    await speak(d, "a login screen with email and password big blue sign in button logo on top");
    expect(calls).toHaveLength(0);
    expect(jevCalls).toBe(0);
    expect(d.doc.root.children![0]!.id).toBe("n_p_logo");
    expect(sent.some((m) => m.type === "ops" && m.origin === "jev")).toBe(true);
    expect(sent.filter((m) => m.type === "version").at(-1)).toMatchObject({ version: 1 });
  });

  it("a looser phrasing asks Jev which element moves", async () => {
    const asked: string[][] = [];
    const jev: JevClient = async ({ questions }) => { asked.push(Object.keys(questions)); return { ms: 90, inputTokens: 300, answers: { target: pick("logo") } }; };
    const { d, calls } = await session(jev);
    await speak(d, "an email and a logo and put that logo up on top");
    expect(asked.at(-1)).toEqual(["target"]);
    // (A repeat mention — "that logo" — still triggers one model call mid-sentence; that predates Jev.)
    expect(calls.every((c) => !c.includes("on top"))).toBe(true); // the move itself never needed the model
    expect(d.doc.root.children![0]!.id).toBe("n_p_logo");
  });

  it("architecture: Jev draws the connection; the model is only called if Jev is unsure", async () => {
    let sure = true;
    const jev: JevClient = async () => ({ ms: 90, inputTokens: 400, answers: { "rel:0": pick("web_app->api", sure ? 0.96 : 0.4), "style:0": pick("sync") } });
    const a = await session(jev);
    a.d.setView("architecture");
    await speak(a.d, "the web app calls the api");
    expect(a.calls).toHaveLength(0);
    expect(edges(a.d).map((e) => [e.props.from, e.props.to, e.props.label])).toEqual([["n_p_web_app", "n_p_api", "calls"]]);
    sure = false;
    const b = await session(jev);
    b.d.setView("architecture");
    await speak(b.d, "the web app calls the api");
    expect(b.calls.length).toBeGreaterThan(0);
  });

  it("a Jev failure falls back to the model with nothing lost", async () => {
    const jev: JevClient = async () => { throw new Error("timeout"); };
    const { d, calls } = await session(jev, () => ["add .9", '+Edge e1 >root from=n_p_web_app to=n_p_api "HTTPS"']);
    d.setView("architecture");
    await speak(d, "the web app calls the api");
    expect(calls.length).toBeGreaterThan(0);
    expect(edges(d)).toHaveLength(1);
  });

  it("when Jev and the model both draw the same connection, it is one edge (the model's label wins)", async () => {
    const jev: JevClient = async () => ({ ms: 90, inputTokens: 400, answers: {
      "rel:0": pick("web_app->api"), "style:0": pick("sync"), "rel:1": pick("api->postgres", 0.3), "style:1": pick("sync") } });
    const { d, calls } = await session(jev, () => ["add .9", '+Edge a >root from=n_p_web_app to=n_p_api "HTTPS"', '+Edge b >root from=n_p_api to=n_p_postgres "SQL"']);
    d.setView("architecture");
    await speak(d, "the web app calls the api which writes to postgres");
    expect(calls.length).toBeGreaterThan(0); // "writes" was unsure → model
    const e = edges(d).map((x) => `${x.props.from}>${x.props.to}:${x.props.label}`).sort();
    expect(e).toEqual(["n_p_api>n_p_postgres:SQL", "n_p_web_app>n_p_api:HTTPS"]);
  });
});

describe("label refresh after STT revisions (ADR 0017)", () => {
  it("a revised word ('log button' → 'log in button') relabels the provisional button without the model", async () => {
    const persistence = memoryPersistence();
    let calls = 0;
    const model: ModelClient = () => { calls++; return { lines: (async function* () { yield { line: "none 0", atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) }; };
    const d = new DocSession(await persistence.openSession(), { persistence, model, send: () => {}, jev: async () => ({ ms: 1, inputTokens: 1, answers: {} }),
      engine: { model: "m", system: "s", render: () => "" } });
    d.onTranscript(0, "a big blue log button", false, 300);
    expect(d.doc.root.children!.find((c) => c.type === "Button")!.props.label).toBe("Button");
    d.onTranscript(0, "a big blue log in button", true, 600);
    await sleep(20);
    expect(d.doc.root.children!.find((c) => c.type === "Button")!.props.label).toBe("Log in");
    expect(calls).toBe(0);
  });
});

describe("settle on silence (ADR 0018)", () => {
  async function make() {
    const persistence = memoryPersistence();
    const sent: ServerMsg[] = [];
    const d = new DocSession(await persistence.openSession(), { persistence, model: null, send: (m) => sent.push(m), engine: { model: "m", system: "s", render: () => "" } });
    return { d, versions: () => sent.filter((m) => m.type === "version").length };
  }

  it("commits 400 ms of audio after the last word — not before — without waiting for Flux", async () => {
    const { d, versions } = await make();
    d.onTranscript(0, "an email and a password", false, 2000);
    d.onAudioClock(2399);
    expect(versions()).toBe(0);
    d.onAudioClock(2400);
    expect(versions()).toBe(1);
    d.onTranscript(0, "an email and a password", true, 2000); // Flux's own end of turn arrives later: no second version
    expect(versions()).toBe(1);
  });

  it("the speaker carries on after an early settle: the new words still draw (reopened as a new part)", async () => {
    const { d, versions } = await make();
    d.onTranscript(0, "an email", false, 1000);
    d.onAudioClock(1500);
    expect(versions()).toBe(1);
    d.onTranscript(0, "an email and a password", false, 2200);
    expect(d.doc.root.children!.map((c) => c.props.label)).toEqual(["Email", "Password"]);
    d.onAudioClock(2700);
    expect(versions()).toBe(2);
  });

  it("off when silenceSettleMs is 0", async () => {
    const { d, versions } = await make();
    d.tune({ silenceSettleMs: 0 });
    d.onTranscript(0, "an email", false, 1000);
    d.onAudioClock(9000);
    expect(versions()).toBe(0);
  });
});
