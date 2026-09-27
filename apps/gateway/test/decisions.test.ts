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
    expect(Object.keys((p.questions["rel:0"] as { criteria: Record<string, string> }).criteria)).toEqual(["n_studio->n_gateway", "n_gateway->n_studio", "none"]);
    expect(Object.keys((p.questions["rel:1"] as { criteria: Record<string, string> }).criteria)).toContain("n_gateway->n_pg");
  });

  it("confident answers become edges with labels from the words between; unsure ones are left to the model", () => {
    const text = "the studio calls the gateway which writes to postgres";
    const p = planDecisions(view(architectureDoc), "architecture", text)!;
    const d = decisionsToLines(p, { "rel:0": pick("n_studio->n_gateway"), "style:0": pick("sync"), "rel:1": pick("n_gateway->n_pg", 0.5), "style:1": pick("sync") });
    expect(d.lines).toEqual(['+Edge jev1 >root from=n_studio to=n_gateway "calls"']);
    expect(d).toMatchObject({ accepted: 1, unsure: 1 });
    expect(d.covered).toEqual(["calls#1"]);
  });

  it("passive voice: 'postgres is read by redis' becomes redis → postgres labelled 'read'", () => {
    const p = planDecisions(view(architectureDoc), "architecture", "postgres is read by redis")!;
    const d = decisionsToLines(p, { "rel:0": pick("n_redis->n_pg"), "style:0": pick("sync") });
    expect(d.lines).toEqual(['+Edge jev1 >root from=n_redis to=n_pg "read"']);
  });

  it("ERD: a one-to-many adds the foreign key column to the many side, then the relationship", () => {
    const p = planDecisions(view(erdDoc), "erd", "each users row has many sessions")!;
    const d = decisionsToLines(p, { "rel:0": pick("n_users->n_sessions"), "card:0": pick("1:n") }, () => ["id:uuid:pk", "document_id:uuid:fk"]);
    expect(d.lines).toEqual(["~n_sessions cols=id:uuid:pk,document_id:uuid:fk,user_id:uuid:fk", '+Edge jev1 >root from=n_users to=n_sessions card=1:n "has many"']);
  });

  it("sequence: a reply becomes a dashed return message", () => {
    const p = planDecisions(view(sequenceDoc), "sequence", "haiku returns compact ops to the gateway")!;
    const d = decisionsToLines(p, { "rel:0": pick("n_llm->n_gw"), "kind:0": pick("return") });
    expect(d.lines).toEqual(['+Edge jev1 >root from=n_llm to=n_gw style=return "Returns compact ops"']);
  });

  it("screen: 'logo on top' moves the logo first; no position word → nothing to ask", () => {
    const screen: DesignDoc = { ...emptyDoc(), root: { ...emptyDoc().root, children: [
      { id: "n_p_email", type: "Input", props: { label: "Email", kind: "email" } },
      { id: "n_p_logo", type: "Image", props: { alt: "Logo" } },
    ] } };
    const p = planDecisions(screen, "screen", "logo on top")!;
    const d = decisionsToLines(p, { target: pick("n_p_logo"), position: pick("first") });
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

  it("the definition-of-done sentence needs no model call: Jev moves the logo on top", async () => {
    const jev: JevClient = async ({ questions }) => {
      expect(Object.keys(questions)).toEqual(["target", "position"]);
      return { ms: 90, inputTokens: 300, answers: { target: pick("n_p_logo"), position: pick("first") } };
    };
    const { d, calls, sent } = await session(jev);
    await speak(d, "a login screen with email and password big blue sign in button logo on top");
    expect(calls).toHaveLength(0);
    expect(d.doc.root.children![0]!.id).toBe("n_p_logo");
    expect(sent.some((m) => m.type === "ops" && m.origin === "jev")).toBe(true);
    expect(sent.filter((m) => m.type === "version").at(-1)).toMatchObject({ version: 1 });
  });

  it("architecture: Jev draws the connection; the model is only called if Jev is unsure", async () => {
    let sure = true;
    const jev: JevClient = async () => ({ ms: 90, inputTokens: 400, answers: { "rel:0": pick("n_p_web_app->n_p_api", sure ? 0.96 : 0.4), "style:0": pick("sync") } });
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
      "rel:0": pick("n_p_web_app->n_p_api"), "style:0": pick("sync"), "rel:1": pick("n_p_api->n_p_postgres", 0.3), "style:1": pick("sync") } });
    const { d, calls } = await session(jev, () => ["add .9", '+Edge a >root from=n_p_web_app to=n_p_api "HTTPS"', '+Edge b >root from=n_p_api to=n_p_postgres "SQL"']);
    d.setView("architecture");
    await speak(d, "the web app calls the api which writes to postgres");
    expect(calls.length).toBeGreaterThan(0); // "writes" was unsure → model
    const e = edges(d).map((x) => `${x.props.from}>${x.props.to}:${x.props.label}`).sort();
    expect(e).toEqual(["n_p_api>n_p_postgres:SQL", "n_p_web_app>n_p_api:HTTPS"]);
  });
});
