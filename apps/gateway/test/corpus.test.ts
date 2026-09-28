import { fixSpeech, lexTokens, type ServerMsg } from "@livecanvas/dsl";
import { describe, expect, it } from "vitest";
import { CASES, type CorpusCase } from "../../../scripts/corpus/cases.js";
import { score } from "../../../scripts/corpus/score.js";
import { DocSession } from "../src/engine/docSession.js";
import type { ModelClient } from "../src/engine/model.js";
import { memoryPersistence } from "../src/persist.js";

/**
 * M7 fluency corpus, offline (ADR 0019). The model says "none 0" and Jev is unsure of everything, so this
 * checks the ENGINE, not the model: every word that needs the model reaches it (the M7 bug: "pink",
 * "rights to" and "priority" never started a call), instant cases draw everything with no call, view
 * switches land, and each sentence commits at most one version. The live runner scores the real result.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(c: CorpusCase) {
  const persistence = memoryPersistence();
  const sent: ServerMsg[] = [];
  const heard: string[] = [];
  let modelCalls = 0;
  const model: ModelClient = (req) => {
    modelCalls++;
    heard.push(req.user.split("\n---\n")[1] ?? "");
    return { lines: (async function* () { yield { line: "none 0", atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) };
  };
  const d = new DocSession(await persistence.openSession(), {
    persistence, model, send: (m) => sent.push(m),
    jev: async (req) => { heard.push(req.state); return { ms: 1, inputTokens: 1, answers: {} }; },
    engine: { model: "m", system: "s", render: (v) => `${v.doc_compact}\n---\n${v.partial_text}` },
  });
  d.setView(c.view);
  const speak = async (text: string, seq: number) => {
    const w = text.split(" ");
    for (let n = 1; n <= w.length; n++) { d.onTranscript(seq, w.slice(0, n).join(" "), n === w.length, n * 300); await sleep(2); }
    for (let i = 0; i < 200 && (d as unknown as { active: unknown }).active; i++) await sleep(2);
    await sleep(5);
  };
  let seq = 0;
  for (const s of c.setup ?? []) await speak(s, seq++);
  const [callsBefore, heardBefore, sentBefore] = [modelCalls, heard.length, sent.length];
  await speak(c.say, seq);
  return {
    d, modelCalls: modelCalls - callsBefore, heard: heard.slice(heardBefore).join("\n").toLowerCase(),
    versions: sent.slice(sentBefore).filter((m) => m.type === "version").length,
  };
}

describe("fluency corpus (M7, offline)", () => {
  it("has a broad corpus across all four views", () => {
    const by = (v: string) => CASES.filter((c) => c.view === v || c.expect.view === v).length;
    expect(CASES.length).toBeGreaterThanOrEqual(70);
    for (const v of ["screen", "architecture", "erd", "sequence"]) expect(by(v)).toBeGreaterThanOrEqual(8);
    for (const v of ["constraints", "cva"]) expect(by(v)).toBeGreaterThanOrEqual(6); // M9
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  for (const c of CASES) {
    it(`${c.id}: "${c.say}"`, async () => {
      const r = await run(c);
      // Words that need the model must reach it — as repaired speech ("rights" → "writes").
      const raw = lexTokens(c.say), fixed = lexTokens(fixSpeech(c.say));
      for (const w of c.hears ?? []) {
        const i = raw.indexOf(w);
        expect(i, `"${w}" is not in the sentence`).toBeGreaterThanOrEqual(0);
        expect(r.heard, `"${w}" never reached the model or Jev`).toContain(fixed[i]!);
      }
      if (c.instant) {
        expect(r.modelCalls, "an instant case called the model").toBe(0);
        const s = score(r.d.project, r.d.activeView, c);
        expect(s.failures).toEqual([]);
      }
      if (c.expect.view) expect(r.d.activeView).toBe(c.expect.view);
      expect(r.versions, "one sentence, one version").toBeLessThanOrEqual(1);
    });
  }
});

describe("open vocabulary (ADR 0019)", () => {
  it("the DoD sentence leaves nothing for the model — label words are handled (plan-critic M7 #1)", async () => {
    for (const say of ["a login screen with email and password, big blue sign-in button, logo on top",
      "a login screen with email and password big blue sign and button logo on top"]) {
      const r = await run({ id: "dod", view: "screen", say, expect: {} });
      expect(r.modelCalls).toBe(0);
      expect(r.versions).toBe(1);
    }
  });

  it("filler and chit-chat never start a call", async () => {
    const r = await run({ id: "chat", view: "screen", setup: [LOGIN_SETUP], say: "um okay so yeah I think that looks good", expect: {} });
    expect(r.modelCalls).toBe(0);
  });

  it("an unknown word at the end of a sentence gets exactly one call", async () => {
    const r = await run({ id: "unknown", view: "erd", setup: ["users"], say: "users have a nickname", expect: {} });
    expect(r.modelCalls).toBe(1);
    expect(r.heard).toContain("nickname");
  });

  it("speech resumed after Flux's eager end of turn stays ONE version (plan-critic M7 #2)", async () => {
    const persistence = memoryPersistence();
    const sent: ServerMsg[] = [];
    let release: () => void = () => {};
    const model: ModelClient = () => ({
      lines: (async function* () { await new Promise<void>((r) => { release = r; }); yield { line: "none 0", atMs: 1 }; })(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
    });
    const d = new DocSession(await persistence.openSession(), { persistence, model, send: (m) => sent.push(m),
      engine: { model: "m", system: "s", render: (v) => v.partial_text ?? "" } });
    d.setView("erd");
    d.onTranscript(0, "users have a nickname", false, 900, true);  // eager: forced settle call starts
    await sleep(5);
    d.onTranscript(0, "users have a nickname and orders", false, 1500); // TurnResumed: more words
    release();
    await sleep(20);
    expect(sent.filter((m) => m.type === "version")).toHaveLength(0); // not committed mid-sentence
    d.onTranscript(0, "users have a nickname and orders", true, 1500);
    for (let i = 0; i < 100 && (d as unknown as { active: unknown }).active; i++) { release(); await sleep(2); }
    await sleep(20);
    expect(sent.filter((m) => m.type === "version")).toHaveLength(1);
  });

  it("a relation word sent before its object ('reads from redis and…' → none) is retried once with the whole sentence", async () => {
    const persistence = memoryPersistence();
    const heard: string[] = [];
    const model: ModelClient = (req) => { heard.push(req.user); return { lines: (async function* () { yield { line: "none 0", atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) }; };
    const d = new DocSession(await persistence.openSession(), { persistence, model, send: () => {},
      engine: { model: "m", system: "s", render: (v) => v.partial_text ?? "" } });
    d.setView("architecture");
    const w = "the api reads from redis and the worker".split(" ");
    for (let n = 1; n <= w.length; n++) { d.onTranscript(0, w.slice(0, n).join(" "), n === w.length, n * 300); await sleep(20); }
    for (let i = 0; i < 100 && (d as unknown as { active: unknown }).active; i++) await sleep(5);
    expect(heard.length).toBe(2);
    expect(heard.at(-1)).toBe("the api reads from redis and the worker");
  });

  it("'rename users to customers': the model may remove the 'customers' table the word itself drew", async () => {
    const persistence = memoryPersistence();
    const model: ModelClient = () => ({ lines: (async function* () {
      for (const line of ["modify 1 x", '~n_p_users "customers"', "-n_p_customers"]) yield { line, atMs: 1 };
    })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) });
    const d = new DocSession(await persistence.openSession(), { persistence, model, send: () => {},
      engine: { model: "m", system: "s", render: (v) => v.partial_text ?? "" } });
    d.setView("erd");
    d.onTranscript(0, "users and orders", true, 900);
    await sleep(20);
    const w = "rename users to customers".split(" ");
    for (let n = 1; n <= w.length; n++) { d.onTranscript(1, w.slice(0, n).join(" "), n === w.length, 1200 + n * 300); await sleep(5); }
    for (let i = 0; i < 100 && (d as unknown as { active: unknown }).active; i++) await sleep(5);
    const labels = (d.doc.root.children ?? []).filter((c) => c.type === "Node").map((c) => c.props.label);
    expect(labels).toEqual(["customers", "orders"]);
  });

  it("with the flag off, only the allowlist starts calls (the pre-M7 behaviour)", async () => {
    const persistence = memoryPersistence();
    let calls = 0;
    const model: ModelClient = () => { calls++; return { lines: (async function* () { yield { line: "none 0", atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) }; };
    const flags = Object.fromEntries(["projects", "project_notes", "jev_decisions", "speak_to_create", "diagram_architecture", "diagram_erd",
      "diagram_sequence", "vocabulary_rail", "custom_vocabulary", "transcript_highlight", "remember_document", "version_timeline", "share_links"].map((k) => [k, true]));
    const d = new DocSession(await persistence.openSession(), { persistence, model, send: () => {}, flags: () => ({ ...flags, open_vocabulary: false, diagram_metrics: false }) as never,
      engine: { model: "m", system: "s", render: (v) => v.partial_text ?? "" } });
    d.setView("erd");
    d.onTranscript(0, "users with a nickname", true, 900);
    await sleep(20);
    expect(calls).toBe(0);
  });
});

const LOGIN_SETUP = "a login screen with email and password and a sign in button";
