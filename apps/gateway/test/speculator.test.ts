import { DesignDocSchema, viewDoc, type DesignNode, type ServerMsg } from "@livecanvas/dsl";
import { describe, expect, it } from "vitest";
import { DocSession } from "../src/engine/docSession.js";
import { hedgedClient } from "../src/engine/model.js";
import type { ModelClient } from "../src/engine/model.js";
import { memoryPersistence } from "../src/persist.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Scripted model: `reply(text)` decides the lines; tracks concurrency and every request. */
function scripted(reply: (text: string) => string[], gapMs = 5) {
  const stats = { calls: [] as string[], prompts: [] as string[], inFlight: 0, maxInFlight: 0 };
  const client: ModelClient = (req) => {
    const text = req.user.split("\n---\n")[1] ?? req.user;
    stats.calls.push(text);
    stats.prompts.push(req.user);
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
    engine: { model: "fake-haiku", system: "s", render: (v) => `${v.project_brief}\n${v.doc_compact}\n---\n${v.partial_text}` },
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

  it("switching views is not a version; 'start over' clears only the view you're in", async () => {
    const { d, sent } = await session((t) => t.includes("start over") ? ["reset 1 x"] : ["add .9", '+Text t >root v=title "Hi"']);
    await d.run("a title", "typed", d.allocSeq());          // v1: the screen has a title
    d.setView("erd");
    expect(sent.filter((m) => m.type === "version").at(-1)).toMatchObject({ version: 1 });
    expect(sent.at(-1)).toMatchObject({ type: "view", view: "erd" });
    d.onTranscript(0, "users and orders", true, 300);
    expect(d.doc.root.children!.length).toBe(2);
    await d.run("start over", "typed", d.allocSeq());
    expect(d.doc.root).toMatchObject({ id: "n_view_erd", type: "Diagram", children: [] });
    expect(JSON.stringify(viewDoc(d.project, "screen"))).toContain('"Hi"'); // the screen is untouched
  });

  it("speak in architecture, name the ERD: both views kept, one timeline, undo across the switch", async () => {
    const { d, sent } = await session(() => ["none 0"]);
    await speak(d, "an architecture where the api writes to postgres", 0);
    await speak(d, "and in the erd users have many orders", 1);
    expect(d.activeView).toBe("erd");
    expect(labels(viewDoc(d.project, "architecture").root).sort()).toEqual(["API", "Postgres"]);
    expect(labels(viewDoc(d.project, "erd").root)).toEqual(["users", "orders"]);
    const tl = sent.filter((m) => m.type === "versions").at(-1) as Extract<ServerMsg, { type: "versions" }>;
    expect(tl.items.map((v) => v.kind)).toEqual(["screen", "architecture", "erd"]);
    d.undo();
    expect(labels(viewDoc(d.project, "erd").root)).toEqual([]);
    expect(labels(viewDoc(d.project, "architecture").root).sort()).toEqual(["API", "Postgres"]);
  });

  it("the model call for the ERD carries the architecture's names (project brief)", async () => {
    const { d, stats } = await session(() => ["none 0"]);
    await speak(d, "architecture with salesforce and mulesoft and a backend called shaw", 0);
    d.setView("erd");
    await d.run("customers have many cases", "typed", d.allocSeq());
    expect(stats.prompts.at(-1)).toContain("Architecture: Salesforce, MuleSoft");
    expect(stats.calls.at(-1)).toContain("customers have many cases");
  });

  it("a fact said early survives into later calls through the project notes", async () => {
    const persistence = memoryPersistence();
    const opened = await persistence.openSession();
    const prompts: string[] = [];
    const model: ModelClient = (req) => {
      prompts.push(req.user);
      const lines = req.system === "NOTES" ? ["**Contact center:** Genesys bot hands off to agents; Shaw is the backend."] : ["none 0"];
      async function* gen() { for (const line of lines) { await sleep(2); yield { line, atMs: 0 }; } }
      return { lines: gen(), usage: Promise.resolve({ inputTokens: 600, outputTokens: 20 }) };
    };
    const d = new DocSession(opened, {
      persistence, model, send: () => {},
      engine: { model: "fake-haiku", system: "s", render: (v) => `${v.project_brief}\n---\n${v.partial_text}` },
      notesEngine: { model: "fake-haiku", system: "NOTES", render: (v) => v.recent ?? "" },
    });
    await d.run("the genesys bot hands off to agents and shaw is our backend", "typed", d.allocSeq());
    d.setView("architecture"); // a view switch rewrites the notes (background)
    await sleep(40);
    expect(d.project.root.props.notes).toContain("Shaw is the backend");
    expect(d.project.root.props.notes).not.toContain("**"); // markdown stripped
    for (let i = 0; i < 18; i++) await d.run(`tweak ${i}`, "typed", d.allocSeq());
    expect(prompts.at(-1)).toContain("Shaw is the backend"); // utterance 20 still sees utterance 1
  });

  it("filler speech in a diagram does not call the model", async () => {
    const { d, stats } = await session(() => ["none 0"]);
    d.newDoc("sequence");
    await speak(d, "so um the user and the api");
    expect(stats.calls).toHaveLength(0);
    expect(labels(d.doc.root)).toEqual(["User", "API"]);
  });
});

describe("version timeline (ADR 0015)", () => {
  const last = (sent: ServerMsg[]) => sent.filter((m) => m.type === "versions").at(-1) as Extract<ServerMsg, { type: "versions" }>;

  it("summarises every version, jumps anywhere, branches on edit, and redo retraces the jump", async () => {
    const { d, sent } = await session((t) => t.includes("button") ? ["add .9", '+Button b >root "Go"'] : ["add .9", '+Text t >root v=title "Hi"']);
    await d.run("a title", "typed", d.allocSeq());          // v1: +Text
    await d.run("a button", "typed", d.allocSeq());         // v2: +Button
    d.setView("architecture");
    d.onTranscript(9, "and stripe", true, 300);             // v3: a node in the architecture view (lexicon only)
    let tl = last(sent);
    expect(tl.items.map((v) => [v.version, v.parent, v.kind])).toEqual([[0, null, "screen"], [1, 0, "screen"], [2, 1, "screen"], [3, 2, "architecture"]]);
    expect(tl.items[2]).toMatchObject({ added: 1, removed: 0, nodes: 2 });
    expect(tl.items[3]).toMatchObject({ added: 1, removed: 0, nodes: 3 }); // lanes and view roots don't count

    d.gotoVersion(1);
    tl = last(sent);
    expect(tl.current).toBe(1);
    expect(tl.path).toEqual([0, 1, 2, 3]); // ancestors + the redo chain back to v3
    expect(JSON.stringify(viewDoc(d.project, "architecture").root)).not.toContain("Stripe");

    d.setView("screen");
    await d.run("a button", "typed", d.allocSeq());         // v4 branches from v1
    tl = last(sent);
    expect(tl.items.at(-1)).toMatchObject({ version: 4, parent: 1 });
    expect(tl.path).toEqual([0, 1, 4]);                     // v2, v3 are now another branch (faded)

    d.gotoVersion(3);
    d.gotoVersion(1);
    d.redo();
    expect(last(sent).current).toBe(2);                     // toward v3 (where we jumped from), not the newer v4
    d.redo();
    expect(last(sent).current).toBe(3);
  });

  it("a jump discards an uncommitted utterance, like undo", async () => {
    const { d } = await session(() => ["none 0"]);
    d.setView("architecture");
    d.onTranscript(0, "the api writes to postgres", false, 300);
    expect(JSON.stringify(d.doc)).toContain("Postgres");
    d.gotoVersion(0);
    expect(JSON.stringify(d.project)).not.toContain("Postgres");
  });
});
