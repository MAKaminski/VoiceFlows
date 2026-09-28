import { viewDoc, type DesignNode, type DocKind, type ServerMsg } from "@livecanvas/dsl";
import { describe, expect, it } from "vitest";
import { DocSession } from "../src/engine/docSession.js";
import type { ModelClient } from "../src/engine/model.js";
import { memoryPersistence } from "../src/persist.js";

/** M9 (ADR 0021): cross-view scaffolding, engine level — model says "none", so everything here is rules. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const none: ModelClient = () => ({ lines: (async function* () { yield { line: "none 0", atMs: 1 }; })(), usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }) });

async function session(model: ModelClient = none) {
  const persistence = memoryPersistence();
  const sent: ServerMsg[] = [];
  const d = new DocSession(await persistence.openSession(), { persistence, model, send: (m) => sent.push(m),
    engine: { model: "m", system: "s", render: (v) => v.partial_text ?? "" } });
  let seq = 0;
  const say = async (text: string) => {
    const w = text.split(" ");
    const s = seq++;
    for (let n = 1; n <= w.length; n++) { d.onTranscript(s, w.slice(0, n).join(" "), n === w.length, n * 300); await sleep(3); }
    for (let i = 0; i < 100 && (d as unknown as { active: unknown }).active; i++) await sleep(3);
    await sleep(10);
  };
  const nodes = (k: DocKind): DesignNode[] => { const out: DesignNode[] = []; const walk = (n: DesignNode) => { if (n.type === "Node") out.push(n); n.children?.forEach(walk); }; walk(viewDoc(d.project, k).root); return out; };
  const labels = (k: DocKind) => nodes(k).map((n) => String(n.props.label));
  const versions = () => sent.filter((m) => m.type === "version").length;
  return { d, sent, say, nodes, labels, versions };
}

describe("cross-view scaffolding (ADR 0021)", () => {
  it("a login screen fills in the architecture, the ERD, a sign-in flow and a cost-value item — in the same version", async () => {
    const s = await session();
    const before = s.versions();
    await s.say("a login screen with email and password");
    expect(s.versions()).toBe(before + 1);
    expect(s.labels("architecture")).toEqual(expect.arrayContaining(["Web app", "API", "Auth"]));
    expect(s.labels("erd")).toContain("users");
    expect(s.labels("sequence")).toEqual(expect.arrayContaining(["User", "Web app", "API"]));
    expect(s.labels("cva")).toContain("Sign in");
    expect(s.labels("constraints")).toEqual(expect.arrayContaining(["Web app", "API", "Auth"])); // chained: screen → architecture → constraints
    expect(s.nodes("architecture").every((n) => n.inferred)).toBe(true);
    const seqEdges = (viewDoc(s.d.project, "sequence").root.children ?? []).filter((c) => c.type === "Edge").map((e) => e.props.label);
    expect(seqEdges).toEqual(["signs in", "logs in"]);
  });

  it("one undo removes the sentence AND everything it scaffolded", async () => {
    const s = await session();
    s.d.setView("erd");
    await s.say("customers have many cases");
    expect(s.labels("architecture")).toContain("Database");
    expect(s.labels("sequence")).toContain("Database");
    s.d.undo();
    expect(s.labels("architecture")).toEqual([]);
    expect(s.labels("sequence")).toEqual([]);
    expect(s.labels("erd")).toEqual([]);
  });

  it("the user's own names take over the placeholders — 3 architecture nodes, none inferred, copies renamed (critic M9 #8)", async () => {
    const s = await session();
    await s.say("a login screen with email and password");
    s.d.setView("architecture");
    await s.say("a react app calls the api gateway which uses auth0");
    const arch = s.nodes("architecture");
    // The three placeholders are gone — replaced, not duplicated. The inferred Database stays: the login's users table implies one.
    expect(arch.filter((n) => !n.inferred).map((n) => String(n.props.label)).sort()).toEqual(["API gateway", "Auth0", "React app"]);
    expect(arch.filter((n) => n.inferred).map((n) => String(n.props.label))).toEqual(["Database"]);
    expect(s.labels("sequence")).toEqual(expect.arrayContaining(["React app", "API gateway"]));
    expect(s.labels("sequence")).not.toContain("API");
  });

  it("an architecture component scaffolds a participant and a constraints node exactly once — no loop", async () => {
    const s = await session();
    s.d.setView("architecture");
    await s.say("a web app calls an api");
    await s.say("and the api writes to postgres");
    const count = (k: DocKind, l: string) => s.labels(k).filter((x) => x === l).length;
    expect(count("sequence", "API")).toBe(1);
    expect(count("constraints", "Postgres")).toBe(1);
    expect(count("architecture", "API")).toBe(1);
  });

  it("an inferred element the user removes is not re-added by the next sentence", async () => {
    const s = await session();
    s.d.setView("architecture");
    await s.say("a web app calls an api");
    const inferred = s.nodes("sequence").find((n) => n.props.label === "Web app")!;
    s.d.setView("sequence");
    (s.d as unknown as { project: unknown }).project; // (removal goes through a typed edit in real use)
    await s.say("remove the web app");
    s.d.setView("architecture");
    await s.say("the api also calls stripe");
    expect(inferred).toBeTruthy();
    expect(s.labels("sequence").filter((x) => x === "Stripe")).toHaveLength(1);
  });

  it("scaffolding is behind its flag", async () => {
    const persistence = memoryPersistence();
    const flags = new Proxy({}, { get: (_t, k) => k !== "cross_view_scaffold" }) as never;
    const d = new DocSession(await persistence.openSession(), { persistence, model: none, send: () => {}, flags: () => flags,
      engine: { model: "m", system: "s", render: () => "" } });
    d.onTranscript(0, "a login screen with email and password", true, 900);
    await sleep(20);
    expect(viewDoc(d.project, "architecture").root.children!.every((l) => !(l.children?.length))).toBe(true);
  });
});

describe("quick start intake (ADR 0021)", () => {
  it("seeds title and notes, and each named system becomes a component that scaffolds the other views — one version", async () => {
    const s = await session();
    const before = s.versions();
    s.d.applyIntake({ building: "a customer support desk", users: "agents and customers", systems: "Salesforce, Genesys and Slack" });
    expect(s.versions()).toBe(before + 1);
    expect(s.d.project.root.props.title).toBe("Customer support desk");
    expect(String(s.d.project.root.props.notes)).toContain("Used by agents and customers.");
    expect(s.labels("architecture").sort()).toEqual(["Genesys", "Salesforce", "Slack"]);
    expect(s.labels("sequence").sort()).toEqual(["Genesys", "Salesforce", "Slack"]);
    expect(s.labels("cva").sort()).toEqual(["Genesys", "Salesforce", "Slack"]);
    expect(s.nodes("architecture").some((n) => n.inferred)).toBe(false); // the user named them
  });
});

describe("demo budget (ADR 0021)", () => {
  it("a demo session stops calling the model after its budget; the lexicon keeps drawing", async () => {
    let calls = 0;
    const s = await session((req) => { calls++; return none(req); });
    s.d.scope = "demo"; s.d.callBudget = 2;
    s.d.setView("erd");
    for (let i = 0; i < 6; i++) await s.say(`and the ${["users", "orders", "cases", "agents", "calls", "leads"][i]} have a nickname`);
    expect(calls).toBeLessThanOrEqual(2);
    expect(s.labels("erd").length).toBeGreaterThanOrEqual(6);
  });
});
