import { DesignDocSchema, type DesignNode, type ServerMsg } from "@livecanvas/dsl";
import { describe, expect, it } from "vitest";
import { DocSession } from "../src/engine/docSession.js";
import { hedgedClient } from "../src/engine/model.js";
import type { ModelClient } from "../src/engine/model.js";
import { memoryPersistence } from "../src/persist.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scripted model: `reply(text)` decides the lines; tracks concurrency and every request. */
function scripted(reply: (text: string) => string[], gapMs = 5) {
  const stats = { calls: [] as string[], inFlight: 0, maxInFlight: 0 };
  const client: ModelClient = (req) => {
    const text = req.user.split("\n---\n")[1] ?? req.user;
    stats.calls.push(text);
    stats.inFlight++; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
    async function* gen() {
      try {
        for (const line of reply(text)) {
          await sleep(gapMs);
          if (req.signal.aborted) throw new Error("aborted");
          yield { line, atMs: 0 };
        }
      } finally { stats.inFlight--; }
    }
    return { lines: gen(), usage: Promise.resolve({ inputTokens: 750, outputTokens: 30 }) };
  };
  return { client, stats };
}

async function session(reply: (t: string) => string[], gapMs = 5) {
  const persistence = memoryPersistence();
  const opened = await persistence.openSession();
  const sent: ServerMsg[] = [];
  const m = scripted(reply, gapMs);
  const d = new DocSession(opened, {
    persistence, model: m.client, send: (x) => sent.push(x),
    engine: { model: "fake-haiku", system: "s", render: (v) => `${v.doc_compact}\n---\n${v.partial_text}` },
  });
  return { d, sent, stats: m.stats, persistence };
}

const WORDS = "a login screen with email and password big blue sign in button logo on top".split(" ");
const idle = async (d: DocSession) => { for (let i = 0; i < 200 && (d as any).active; i++) await sleep(5); };

describe("speculative scheduling (M4)", () => {
  it("DoD sentence: lexicon first, model only for uncovered words, one version, no provisional left", async () => {
    // Model settles the screen: title + edits provisional nodes in place (adds fold into them).
    const { d, sent, stats } = await session((t) => t.includes("top")
      ? ["add .9 title", '+Text title >root v=title "Welcome back" @1', '+Button signin >root v=primary s=lg c=primary "Sign in"']
      : ["add .8 email", '+Input email >root k=email "Email"']);
    for (let n = 1; n <= WORDS.length; n++) { d.onTranscript(0, WORDS.slice(0, n).join(" "), false, n * 400); await sleep(40); }
    d.onTranscript(0, WORDS.join(" "), true, WORDS.length * 400);
    await idle(d); await sleep(50);

    const firstLex = sent.findIndex((m) => m.type === "ops" && m.origin === "lexicon");
    const firstModel = sent.findIndex((m) => m.type === "ops" && m.origin === "model");
    expect(firstLex).toBeGreaterThan(-1);
    expect(firstLex).toBeLessThan(firstModel);
    expect(stats.maxInFlight).toBe(1);
    // email / password / big blue sign-in button / logo are drawn by the lexicon; only "top" needs the model.
    expect(stats.calls.length).toBeGreaterThanOrEqual(1);
    expect(stats.calls.length).toBeLessThanOrEqual(2);
    expect(stats.calls.every((c) => c.includes("top"))).toBe(true);
    const versions = sent.filter((m) => m.type === "version");
    expect(versions.at(-1)).toMatchObject({ version: 1, canUndo: true });
    const kids = d.doc.root.children!;
    expect(kids.filter((k) => k.type === "Button")).toHaveLength(1); // folded, not duplicated
    expect(kids.filter((k) => k.type === "Input" && k.props.kind === "email")).toHaveLength(1);
    const anyProvisional = (n: DesignNode): boolean => !!n.provisional || (n.children ?? []).some(anyProvisional);
    expect(anyProvisional(d.doc.root)).toBe(false);
    expect(DesignDocSchema.safeParse(d.doc).success).toBe(true);
  });

  it("caps model calls with the token bucket (burst 2), counting every started call", async () => {
    const { d, stats } = await session(() => ["none 0"], 1);
    d.tune({ minGapMs: 0 }); // isolate the bucket from the gap rule
    // Words the lexicon cannot handle (positions, edits) — each one is worth a model call.
    const content = ["move", "remove", "bigger", "smaller", "top", "bottom", "left", "right", "center", "row"];
    for (let n = 1; n <= content.length; n++) { d.onTranscript(0, content.slice(0, n).join(" "), false); await sleep(30); }
    await idle(d);
    expect(stats.calls.length).toBe(2); // burst 2
  });

  it("words the lexicon handled never trigger a model call; an uncovered edit does", async () => {
    const { d, stats } = await session(() => ["modify .9 x", "~n_p_email c=danger"]);
    d.onTranscript(0, "an email and a password and a big blue sign in button", false, 2000);
    await idle(d);
    expect(stats.calls).toHaveLength(0);
    d.onTranscript(0, "an email and a password and a big blue sign in button and make the email red", false, 3500);
    await idle(d);
    expect(stats.calls).toHaveLength(1);
  });

  it("undo mid-utterance discards only the uncommitted utterance", async () => {
    const { d, sent } = await session((t) => t.includes("login form") ? ["add .9 form", '+Text t >root v=title "Log in"'] : ["none 0"]);
    await d.run("add a login form", "typed", d.allocSeq());
    const v1 = structuredClone(d.doc);
    d.onTranscript(1, "and an email", false, 500);
    await idle(d);
    expect(d.doc.root.children!.some((k) => k.id === "n_p_email")).toBe(true);
    d.undo();
    expect(d.doc).toEqual(v1);
    expect(sent.filter((m) => m.type === "version").at(-1)).toMatchObject({ version: 1 });
  });

  it("rollback keeps lexicon ops that landed while the aborted job ran", async () => {
    const { d } = await session(() => ["add .9 x", '+Text a >root "A"', '+Text b >root "B"', '+Text c >root "C"'], 40);
    const job = d.run("add three texts", "typed", d.allocSeq());
    await sleep(60); // first model op applied
    d.onTranscript(1, "a password", false, 300); // lexicon draws while the job runs
    d.abortActive("test");
    await job;
    const ids = d.doc.root.children!.map((k) => k.id);
    expect(ids).toEqual(["n_p_password"]);
  });

  it("EagerEndOfTurn makes the pending call immediately; the punctuated final adds no call", async () => {
    const { d, sent, stats } = await session(() => ["layout .9 x", "^n_p_logo >root @0"], 5);
    d.tune({ callsPerMin: 1, minGapMs: 10_000 });
    d.onTranscript(0, "an email and a password", false, 900);
    await idle(d);
    d.tune({ callsPerMin: 1 }); (d as any).bucket.tokens = 0; // budget exhausted
    d.onTranscript(0, "an email and a password and a logo on top", false, 2400, true); // eager, "top" uncovered
    await idle(d);
    expect(stats.calls).toHaveLength(1); // forced despite empty budget and gap
    d.onTranscript(0, "An email and a password, and a logo on top.", true, 2400);
    await idle(d); await sleep(20);
    expect(stats.calls).toHaveLength(1);
    expect(sent.filter((m) => m.type === "version").at(-1)).toMatchObject({ version: 1 });
  });

  it("Haiku's destructive rebuild (live sample) folds into the user's elements: wrap kept, nothing deleted or duplicated", async () => {
    const REBUILD = ["add .9 x", '+Image n_logo >root "Logo" @0', "+Card form >root",
      '+Input n_email >form k=email placeholder="you@example.com" "Email"', '+Input n_password >form k=password "Password"',
      '+Button n_signin >form v=primary s=lg "Sign in"', "-n_p_logo", "-n_p_email", "-n_p_password", "-n_p_button"];
    const { d } = await session((t) => (t.includes("top") ? REBUILD : ["none 0"]));
    const text = "a login screen with email and password big blue sign and button logo on top";
    const W = text.split(" ");
    const moves = new Map<string, number>();
    const pos = () => { const m = new Map<string, string>(); const w = (n: DesignNode, p: string) => n.children?.forEach((c, i) => { m.set(c.id, `${p}:${i}`); w(c, c.id); }); w(d.doc.root, "root"); return m; };
    let before = pos();
    const track = () => { const after = pos(); for (const [id, p] of after) { const b = before.get(id); if (b && (b.split(":")[0] !== p.split(":")[0] || Number(p.split(":")[1]) > Number(b.split(":")[1]))) moves.set(id, (moves.get(id) ?? 0) + 1); } before = after; };
    for (let n = 1; n <= W.length; n++) { d.onTranscript(0, W.slice(0, n).join(" "), false, n * 400); track(); await sleep(15); track(); }
    d.onTranscript(0, text, true, W.length * 400);
    await idle(d); track();
    const kids = d.doc.root.children!;
    expect(kids.map((k) => k.type)).toEqual(["Image", "Text", "Card"]); // "login screen" → title drawn by the lexicon
    expect(kids[0]!.id).toBe("n_p_logo");
    expect(kids[2]!.children!.map((c) => [c.id, c.type, c.props.label])).toEqual([
      ["n_p_email", "Input", "Email"], ["n_p_password", "Input", "Password"], ["n_p_button", "Button", "Sign in"],
    ]);
    expect(Math.max(0, ...moves.values())).toBeLessThan(3);
    expect(DesignDocSchema.safeParse(d.doc).success).toBe(true);
  });

  it("folds the model's button into the lexicon's placeholder even when Flux split the sentence into two turns", async () => {
    const { d } = await session((t) => (t.includes("top") ? ["add .9 x", '+Button signin >root v=primary s=lg "Sign in"'] : ["none 0"]));
    d.onTranscript(0, "email and password big blue sign and button", false, 4800);
    d.onTranscript(0, "email and password big blue sign and button.", true, 4800); // Flux EndOfTurn after "button."
    await idle(d);
    d.onTranscript(1, "Logo on top.", false, 6200);
    d.onTranscript(1, "Logo on top.", true, 6200);
    await idle(d);
    const buttons = d.doc.root.children!.filter((k) => k.type === "Button");
    expect(buttons.map((b) => [b.id, b.props.label])).toEqual([["n_p_button", "Sign in"]]);
  });

  it("hedged client: a slow primary is beaten by the hedge, the loser is aborted, usage is summed", async () => {
    let n = 0; const aborted: boolean[] = [];
    const inner: ModelClient = (req) => {
      const delay = n++ === 0 ? 400 : 20; // primary slow, hedge fast
      const idx = n - 1;
      async function* gen() {
        await sleep(delay);
        if (req.signal.aborted) { aborted[idx] = true; throw new Error("aborted"); }
        yield { line: `from-${idx}`, atMs: delay };
        yield { line: `more-${idx}`, atMs: delay + 1 };
      }
      return { lines: gen(), usage: Promise.resolve({ inputTokens: 700, outputTokens: idx === 1 ? 30 : 0 }) };
    };
    let hedged: boolean | null = null;
    const c = hedgedClient(inner, 50, (won) => { hedged = won; });
    const s = c({ model: "m", system: "", user: "", signal: new AbortController().signal });
    const got: string[] = [];
    for await (const l of s.lines) got.push(l.line);
    expect(got).toEqual(["from-1", "more-1"]);
    expect(hedged).toBe(true);
    expect(await s.usage).toEqual({ inputTokens: 1400, outputTokens: 30 });
    await sleep(450);
    expect(aborted[0]).toBe(true);
  });

  it("hedged client: a fast primary never starts a second call", async () => {
    let calls = 0;
    const inner: ModelClient = () => { calls++; async function* g() { await sleep(5); yield { line: "x", atMs: 5 }; } return { lines: g(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) }; };
    const s = hedgedClient(inner, 100)({ model: "m", system: "", user: "", signal: new AbortController().signal });
    for await (const _ of s.lines) { /* drain */ }
    expect(calls).toBe(1);
  });
});

describe("diagrams (ADR 0011)", () => {
  const speak = async (d: DocSession, sentence: string, seq = 0) => {
    const w = sentence.split(" ");
    for (let n = 1; n <= w.length; n++) { d.onTranscript(seq, w.slice(0, n).join(" "), false, n * 300); await sleep(20); }
    d.onTranscript(seq, sentence, true, w.length * 300);
    await idle(d); await sleep(40);
  };
  const labels = (n: DesignNode): string[] => [...(n.type === "Node" ? [String(n.props.label)] : []), ...(n.children ?? []).flatMap(labels)];

  it("voice switches a blank screen to architecture; the model's Redis never folds into the lexicon's Postgres", async () => {
    const { d, stats } = await session((t) => t.includes("calls")
      ? ["add .9", '+Node cache >n_data k=cache "Redis"', "+Edge e1 >root from=n_p_api to=n_p_postgres \"SQL\"", "+Edge e2 >root from=n_p_api to=cache"]
      : ["none 0"]);
    await speak(d, "architecture diagram the api calls postgres");
    expect(d.doc.root.type).toBe("Diagram");
    expect(labels(d.doc.root).sort()).toEqual(["API", "Postgres", "Redis"]);
    expect(d.doc.root.children!.filter((c) => c.type === "Edge")).toHaveLength(2);
    expect(stats.calls.length).toBeGreaterThanOrEqual(1);
    expect(DesignDocSchema.safeParse(d.doc).success).toBe(true);
  });

  it("removing a node prunes its edges; undo brings both back", async () => {
    const { d } = await session((t) => t.includes("remove") ? ["remove .9", "-n_p_postgres"] : ["add .9", "+Edge e1 >root from=n_p_api to=n_p_postgres \"SQL\""]);
    d.newDoc("architecture");
    await speak(d, "the api writes to postgres", 0);
    expect(d.doc.root.children!.filter((c) => c.type === "Edge")).toHaveLength(1);
    await d.run("remove postgres", "typed", d.allocSeq());
    expect(labels(d.doc.root)).toEqual(["API"]);
    expect(d.doc.root.children!.filter((c) => c.type === "Edge")).toHaveLength(0);
    expect(DesignDocSchema.safeParse(d.doc).success).toBe(true);
    d.undo();
    expect(labels(d.doc.root).sort()).toEqual(["API", "Postgres"]);
    expect(d.doc.root.children!.filter((c) => c.type === "Edge")).toHaveLength(1);
  });

  it("new_doc is an undoable version; 'start over' keeps the diagram kind", async () => {
    const { d, sent } = await session(() => ["reset 1 x"]);
    d.newDoc("erd");
    expect(d.doc.root.props.kind).toBe("erd");
    expect(sent.filter((m) => m.type === "version").at(-1)).toMatchObject({ version: 1, canUndo: true });
    await d.run("start over", "typed", d.allocSeq());
    expect(d.doc.root).toMatchObject({ type: "Diagram", props: { kind: "erd" } });
    d.undo(); d.undo();
    expect(d.doc.root.type).toBe("Frame");
  });

  it("filler speech in a diagram does not call the model", async () => {
    const { d, stats } = await session(() => ["none 0"]);
    d.newDoc("sequence");
    await speak(d, "so um the user and the api");
    expect(stats.calls).toHaveLength(0);
    expect(labels(d.doc.root)).toEqual(["User", "API"]);
  });
});
