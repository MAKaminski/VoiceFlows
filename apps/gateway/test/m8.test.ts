import { findNode, viewDoc, type ServerMsg, type Suggestion } from "@livecanvas/dsl";
import { describe, expect, it } from "vitest";
import { DocSession } from "../src/engine/docSession.js";
import type { ModelClient } from "../src/engine/model.js";
import { memoryPersistence } from "../src/persist.js";

/** M8 (ADR 0020): implied suggestions, voice/click approval, save — engine level, no network. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const none: ModelClient = () => ({ lines: (async function* () { yield { line: "none 0", atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) });

async function session(model: ModelClient = none) {
  const persistence = memoryPersistence();
  const sent: ServerMsg[] = [];
  const d = new DocSession(await persistence.openSession(), { persistence, model, send: (m) => sent.push(m),
    engine: { model: "m", system: "s", render: (v) => v.partial_text ?? "" } });
  let seq = 0;
  const say = async (text: string, o: { eagerAt?: number } = {}) => {
    const w = text.split(" ");
    const s = seq++;
    for (let n = 1; n <= w.length; n++) { d.onTranscript(s, w.slice(0, n).join(" "), n === w.length, n * 300, n === o.eagerAt); await sleep(3); }
    for (let i = 0; i < 100 && (d as unknown as { active: unknown }).active; i++) await sleep(3);
    await sleep(10);
  };
  const latest = () => (sent.filter((m) => m.type === "suggestions").at(-1) as Extract<ServerMsg, { type: "suggestions" }> | undefined)?.items ?? [];
  const versions = () => sent.filter((m) => m.type === "version").length;
  const cols = (id: string) => ((findNode(viewDoc(d.project, "erd").root, id)?.node.props.cols as string[] | undefined) ?? []).map((c) => c.split(":")[0]);
  return { d, sent, say, latest, versions, cols, persistence };
}

describe("implied suggestions (ADR 0020)", () => {
  it("'cases' arrives already offering subject, status, priority — in the same partial, before the sentence ends", async () => {
    const s = await session();
    s.d.setView("erd");
    s.d.onTranscript(0, "customers and cases", false, 900);
    const cases = s.latest().find((x: Suggestion) => x.target === "n_p_cases")!;
    expect(cases.cols!.map((c) => c.split(":")[0])).toEqual(["subject", "status", "priority", "created_at"]);
    expect(s.cols("n_p_cases")).toEqual(["id"]); // not in the doc until approved
  });

  it("'approve' applies every pending suggestion as ONE version; undo takes it back", async () => {
    const s = await session();
    s.d.setView("erd");
    await s.say("customers and cases");
    const before = s.versions();
    await s.say("approve");
    expect(s.versions()).toBe(before + 1);
    expect(s.cols("n_p_cases")).toEqual(expect.arrayContaining(["subject", "status", "priority"]));
    expect(s.cols("n_p_customers")).toContain("email");
    expect(s.latest().filter((x) => x.view === "erd")).toHaveLength(0);
    s.d.undo();
    expect(s.cols("n_p_cases")).toEqual(["id"]);
  });

  it("an eager 'approve all' does nothing until the final 'approve all but status' (plan-critic M8 #2)", async () => {
    const s = await session();
    s.d.setView("erd");
    await s.say("cases");
    await s.say("approve all but status", { eagerAt: 2 });
    expect(s.cols("n_p_cases")).toEqual(expect.arrayContaining(["subject", "priority"]));
    expect(s.cols("n_p_cases")).not.toContain("status");
    expect(s.latest().find((x) => x.target === "n_p_cases")!.cols).toEqual(["status:text"]); // still pending
  });

  it("'approve the case columns' is scoped; 'reject the auth one' rejects just that", async () => {
    const s = await session();
    s.d.setView("architecture");
    await s.say("a web app calls an api");
    expect(s.latest().map((x) => x.id)).toContain("arch:auth");
    s.d.setView("erd");
    await s.say("users and cases");
    await s.say("approve the case columns");
    expect(s.cols("n_p_cases")).toContain("subject");
    expect(s.cols("n_p_users")).toEqual(["id"]);
    await s.say("reject the auth one");
    expect(s.latest().map((x) => x.id)).not.toContain("arch:auth");
  });

  it("a rejected column never comes back, even after more sentences", async () => {
    const s = await session();
    s.d.setView("erd");
    await s.say("cases");
    s.d.resolveSuggestions("reject", [{ id: "cols:n_p_cases", cols: ["status:text"] }]);
    await s.say("and customers");
    expect(s.latest().find((x) => x.target === "n_p_cases")!.cols!.map((c) => c.split(":")[0])).not.toContain("status");
  });

  it("a click during an open sentence waits for it: one utterance version + one approve version (M8 #4)", async () => {
    const s = await session();
    s.d.setView("erd");
    await s.say("cases");
    const before = s.versions();
    s.d.onTranscript(9, "and customers", false, 300); // sentence still open
    s.d.resolveSuggestions("approve", [{ id: "cols:n_p_cases" }]);
    expect(s.cols("n_p_cases")).toEqual(["id"]); // queued, not applied mid-sentence
    s.d.onTranscript(9, "and customers too", true, 900);
    for (let i = 0; i < 100 && (s.d as unknown as { active: unknown }).active; i++) await sleep(3);
    await sleep(10);
    expect(s.versions()).toBe(before + 2);
    expect(s.cols("n_p_cases")).toContain("subject");
  });

  it("a suggestion whose table is gone is dropped", async () => {
    const s = await session();
    s.d.setView("erd");
    await s.say("cases");
    expect(s.latest().some((x) => x.target === "n_p_cases")).toBe(true);
    s.d.undo();
    expect(s.latest().some((x) => x.target === "n_p_cases")).toBe(false);
  });

  it("the model tier is off by default: no background call after a sentence", async () => {
    let calls = 0;
    const s = await session((req) => { calls++; return none(req); });
    s.d.setView("erd");
    await s.say("cases");
    expect(calls).toBe(0);
  });

  it("the model tier (when on) only offers suggestions that validate", async () => {
    const reply = ["# Status history table", '+Node hist >root k=entity cols=id:uuid:pk,status:text "case_history"', "# Broken", "+Nonsense x"];
    const model: ModelClient = () => ({ lines: (async function* () { for (const line of reply) yield { line, atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) });
    const persistence = memoryPersistence();
    const sent: ServerMsg[] = [];
    const flags = { suggestions: true, suggestions_model: true } as never;
    const d = new DocSession(await persistence.openSession(), { persistence, model, send: (m) => sent.push(m), flags: () => new Proxy(flags, { get: (t, k) => (k in t ? (t as Record<string, boolean>)[k as string] : true) }),
      suggestEngine: { model: "m", system: "s", render: () => "" }, engine: { model: "m", system: "s", render: () => "" } });
    d.setView("erd");
    d.onTranscript(0, "cases", true, 300);
    await sleep(30);
    const items = (sent.filter((m) => m.type === "suggestions").at(-1) as Extract<ServerMsg, { type: "suggestions" }>).items;
    expect(items.filter((x) => x.source === "model").map((x) => x.title)).toEqual(["Status history table"]);
  });
});

describe("save the project (ADR 0020)", () => {
  it("'save it as contact center' names and lists the project, and draws nothing", async () => {
    const s = await session();
    await s.say("save it as contact center");
    await sleep(20);
    expect(s.d.project.root.props.title).toBe("Contact Center");
    expect((s.sent.filter((m) => m.type === "project").at(-1) as { savedAt: string | null }).savedAt).toBeTruthy();
    expect(viewDoc(s.d.project, "screen").root.children ?? []).toHaveLength(0);
    expect((await s.persistence.listProjects(false, 10)).map((p) => p.title)).toEqual(["Contact Center"]);
  });

  it("'save button' still draws a button (only 'save it/the project' is a command)", async () => {
    const s = await session();
    await s.say("a big save button");
    expect(viewDoc(s.d.project, "screen").root.children!.some((c) => c.type === "Button")).toBe(true);
  });
});
