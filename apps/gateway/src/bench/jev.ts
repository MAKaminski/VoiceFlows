/**
 * Jev bake-off (2026-09-27). Can TypeSafe Jev (a typed-decision "System One" model) make the structural
 * decisions our Haiku call makes today — connections, direction, style, lane, kind, owner, position,
 * size/colour, which view, actionable-or-not — fast enough and accurately enough to replace it for them?
 *
 * Each case = a diagram state + a transcript + named questions with hand-labelled truth. Both engines get
 * the SAME questions: Jev natively (one /v1/systemone request per case), Haiku as a multiple-choice JSON
 * answer (its best case: a real op stream is longer). Warm connections, RUNS repeats, run from Railway sfo.
 * Pass bar (from the recommendation): Jev p50 ≤ 300 ms and ≥ 90 % correct on these decisions.
 *   JEV_RUNS=10 node dist/bench/jev.js       (needs TYPESAFE_API_KEY, ANTHROPIC_API_KEY)
 * Prints a table and one `JEV_RESULT {json}` line.
 */
import { Agent, fetch as ufetch } from "undici";

const RUNS = Number(process.env.JEV_RUNS ?? 10);
const WHERE = process.env.RAILWAY_REPLICA_REGION ? `railway-${process.env.RAILWAY_REPLICA_REGION}` : process.env.JEV_WHERE ?? "local";
const HAIKU = process.env.MODEL_PATCH_FAST ?? "claude-haiku-4-5-20251001";
const pool = new Agent({ keepAliveTimeout: 60_000, connections: 8 });

type Q = { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "noul"; instructions: string };
interface Case { id: string; view: string; state: string; questions: Record<string, Q>; truth: Record<string, string | boolean> }

const pairs = (nodes: string[], desc: (a: string, b: string) => string) => {
  const c: Record<string, string> = { none: "No connection is described" };
  for (const a of nodes) for (const b of nodes) if (a !== b) c[`${a}->${b}`] = desc(a, b);
  return c;
};
const ARCH = ["web_app", "api", "postgres", "redis", "stripe", "queue", "shaw", "genesys", "observe_ai"];
const ARCH_STATE = "Architecture diagram. Lanes: Frontend, APIs, Database, Infrastructure. Components: web_app (Web app, client), api (API, service), postgres (Postgres, db), redis (Redis, cache), stripe (Stripe, external), queue (Queue, queue), shaw (Shaw, backend service), genesys (Genesys, contact-center SaaS), observe_ai (Observe.AI, SaaS).";
const archEdge = (t: string): Q => ({ type: "choice", instructions: `Which directed connection (from -> to) does the transcript describe? Transcript: "${t}"`, criteria: pairs(ARCH, (a, b) => `${a} sends to / calls / writes to ${b}`) });
const style = (t: string): Q => ({ type: "choice", instructions: `How does the described connection communicate? Transcript: "${t}"`, criteria: { sync: "Request/response: calls, queries, reads, writes", async: "Fire-and-forget: queues, events, publishes, webhooks" } });
const ERD = ["users", "orders", "products", "line_items", "profiles"];
const ERD_STATE = "Entity-relationship diagram (Postgres). Tables: users, orders, products, line_items, profiles.";
const erdPair = (t: string): Q => ({ type: "choice", instructions: `Which relationship does the transcript describe? The first table is the "one" side. Transcript: "${t}"`, criteria: pairs(ERD, (a, b) => `${a} is the one side, ${b} the other`) });
const card = (t: string): Q => ({ type: "choice", instructions: `What is the cardinality from the first table to the second? Transcript: "${t}"`, criteria: { "1:n": "one to many", "1:1": "one to one", "n:n": "many to many" } });
const SEQ = ["user", "web_app", "api", "postgres"];
const SEQ_STATE = "Sequence diagram. Participants: user (User), web_app (Web app), api (API), postgres (Postgres).";
const seqMsg = (t: string): Q => ({ type: "choice", instructions: `Which participant sends the next message to which? Transcript: "${t}"`, criteria: pairs(SEQ, (a, b) => `${a} sends a message to ${b}`) });
const seqStyle = (t: string): Q => ({ type: "choice", instructions: `What kind of message is it? Transcript: "${t}"`, criteria: { sync: "A request or call", return: "A reply that returns something to the caller", async: "Fire-and-forget (enqueue, notify)" } });
const SCREEN_STATE = "Phone screen, top to bottom: logo (Image), email (Input), password (Input), signin (Button 'Sign in', size md, color muted).";
const VIEW: Q = { type: "choice", instructions: "Which view of the project is the user talking about?", criteria: {
  screen: "The UI screen/wireframe: buttons, inputs, titles, layout of a page",
  architecture: "Software architecture: systems, services, databases, integrations, hosting",
  erd: "Data model: tables, columns, one-to-many relationships",
  sequence: "A step-by-step flow of messages between participants over time",
} };
const actionable = (t: string): Q => ({ type: "noul", instructions: `The user is describing something to draw or change in the design (not filler, not small talk). Transcript: "${t}"` });

/** The build's question: for mentions a, b (adjacent in the sentence) — a→b, b→a, or no connection. */
function adjacent(id: string, view: string, state: string, text: string, pairsTruth: Array<[string, string, string]>): Case[] {
  const questions: Record<string, Q> = {}, truth: Record<string, string> = {};
  pairsTruth.forEach(([a, b, t], i) => {
    questions[`rel${i}`] = { type: "choice", instructions: `Does the transcript connect ${a} and ${b}, and in which direction? Transcript: "${text}"`,
      criteria: { [`${a}->${b}`]: `${a} sends to / calls / writes to / has many ${b}`, [`${b}->${a}`]: `${b} sends to / calls / writes to / has many ${a}`, none: `No connection between ${a} and ${b} is described` } };
    truth[`rel${i}`] = t;
  });
  return [{ id, view: `adjacent-${view}`, state: `${state} Transcript: "${text}"`, questions, truth }];
}

const CASES: Case[] = [
  { id: "arch-calls", view: "architecture", state: ARCH_STATE, questions: { edge: archEdge("the web app calls the api"), style: style("the web app calls the api") }, truth: { edge: "web_app->api", style: "sync" } },
  { id: "arch-publish", view: "architecture", state: ARCH_STATE, questions: { edge: archEdge("the api publishes jobs to the queue"), style: style("the api publishes jobs to the queue") }, truth: { edge: "api->queue", style: "async" } },
  { id: "arch-cache", view: "architecture", state: ARCH_STATE, questions: { edge: archEdge("the api caches sessions in redis"), style: style("the api caches sessions in redis") }, truth: { edge: "api->redis", style: "sync" } },
  { id: "arch-webhook", view: "architecture", state: ARCH_STATE, questions: { edge: archEdge("stripe sends webhooks to the api"), style: style("stripe sends webhooks to the api") }, truth: { edge: "stripe->api", style: "async" } },
  { id: "arch-reverse", view: "architecture", state: ARCH_STATE, questions: { edge: archEdge("postgres is read by shaw") }, truth: { edge: "shaw->postgres" } },
  { id: "arch-integrate", view: "architecture", state: ARCH_STATE, questions: { edge: archEdge("observe ai listens to genesys calls"), style: style("observe ai listens to genesys calls") }, truth: { edge: "genesys->observe_ai", style: "async" } },
  { id: "arch-lane", view: "architecture", state: ARCH_STATE, questions: {
      lane: { type: "choice", instructions: 'Which lane does the new system belong in? Transcript: "a backend called shaw"', criteria: { frontend: "Apps, browsers, UI", api: "Services, APIs, integrations, SaaS, workers, queues", data: "Databases, caches, storage", infra: "Hosting, containers, CDN, CI, monitoring" } },
      kind: { type: "choice", instructions: 'What kind of component is it? Transcript: "a backend called shaw"', criteria: { service: "An in-house service or backend", external: "A third-party SaaS/API", db: "A database", client: "A client app", worker: "A background worker" } } },
    truth: { lane: "api", kind: "service" } },
  { id: "arch-owner", view: "architecture", state: ARCH_STATE, questions: { owner: { type: "choice", instructions: 'Which component does the team own? Transcript: "the full stack team owns shaw"', criteria: Object.fromEntries(ARCH.map((n) => [n, `the ${n} component`])) } }, truth: { owner: "shaw" } },
  { id: "erd-many", view: "erd", state: ERD_STATE, questions: { rel: erdPair("each user has many orders"), card: card("each user has many orders") }, truth: { rel: "users->orders", card: "1:n" } },
  { id: "erd-lines", view: "erd", state: ERD_STATE, questions: { rel: erdPair("an order has many line items"), card: card("an order has many line items") }, truth: { rel: "orders->line_items", card: "1:n" } },
  { id: "erd-belongs", view: "erd", state: ERD_STATE, questions: { rel: erdPair("every line item belongs to a product"), card: card("every line item belongs to a product") }, truth: { rel: "products->line_items", card: "1:n" } },
  { id: "erd-one", view: "erd", state: ERD_STATE, questions: { rel: erdPair("each user has exactly one profile"), card: card("each user has exactly one profile") }, truth: { rel: "users->profiles", card: "1:1" } },
  { id: "seq-query", view: "sequence", state: SEQ_STATE, questions: { msg: seqMsg("the api queries postgres"), kind: seqStyle("the api queries postgres") }, truth: { msg: "api->postgres", kind: "sync" } },
  { id: "seq-return", view: "sequence", state: SEQ_STATE, questions: { msg: seqMsg("postgres returns the user row to the api"), kind: seqStyle("postgres returns the user row to the api") }, truth: { msg: "postgres->api", kind: "return" } },
  { id: "seq-login", view: "sequence", state: SEQ_STATE, questions: { msg: seqMsg("the user logs in on the web app"), kind: seqStyle("the user logs in on the web app") }, truth: { msg: "user->web_app", kind: "sync" } },
  { id: "screen-top", view: "screen", state: SCREEN_STATE, questions: {
      target: { type: "choice", instructions: 'Which element is being moved? Transcript: "put the logo on top"', criteria: { logo: "The logo image", email: "The email input", password: "The password input", signin: "The sign in button" } },
      position: { type: "choice", instructions: 'Where should it go? Transcript: "put the logo on top"', criteria: { first: "To the top / first", last: "To the bottom / last", unchanged: "No move" } } },
    truth: { target: "logo", position: "first" } },
  { id: "screen-style", view: "screen", state: SCREEN_STATE, questions: {
      size: { type: "choice", instructions: 'What size should the sign in button be? Transcript: "make the button big and blue"', criteria: { sm: "small", md: "medium / unchanged", lg: "big / large" } },
      color: { type: "choice", instructions: 'What colour should the sign in button be? Transcript: "make the button big and blue"', criteria: { primary: "blue", danger: "red", muted: "grey / unchanged", secondary: "purple" } } },
    truth: { size: "lg", color: "primary" } },
  { id: "route-erd", view: "route", state: "Transcript: and in the ERD customers have many cases", questions: { view: VIEW }, truth: { view: "erd" } },
  { id: "route-seq", view: "route", state: "Transcript: first the user taps sign in, then the app calls the api, then the api returns a token", questions: { view: VIEW }, truth: { view: "sequence" } },
  { id: "route-arch", view: "route", state: "Transcript: a next js web app talks to a fastify api deployed on railway", questions: { view: VIEW }, truth: { view: "architecture" } },
  { id: "route-screen", view: "route", state: "Transcript: a login screen with email and password and a big blue button", questions: { view: VIEW }, truth: { view: "screen" } },
  // ── Build format (plan-critic M6 #2): one 3-way Choice per ADJACENT pair of mentions — multi-clause,
  //    passive and negative sentences, which the first round never measured.
  ...adjacent("adj-arch-chain", "architecture", ARCH_STATE, "the web app calls the api which writes to postgres", [["web_app", "api", "web_app->api"], ["api", "postgres", "api->postgres"]]),
  ...adjacent("adj-arch-passive", "architecture", ARCH_STATE, "postgres is read by shaw", [["postgres", "shaw", "shaw->postgres"]]),
  ...adjacent("adj-arch-two", "architecture", ARCH_STATE, "stripe sends webhooks to the api and the api publishes jobs to the queue", [["stripe", "api", "stripe->api"], ["api", "queue", "api->queue"]]),
  ...adjacent("adj-arch-none", "architecture", ARCH_STATE, "the web app and the api are both new this quarter", [["web_app", "api", "none"]]),
  ...adjacent("adj-arch-listen", "architecture", ARCH_STATE, "observe ai listens to genesys calls", [["observe_ai", "genesys", "genesys->observe_ai"]]),
  ...adjacent("adj-erd-chain", "erd", ERD_STATE, "each user has many orders and each order has many line items", [["users", "orders", "users->orders"], ["orders", "line_items", "orders->line_items"]]),
  ...adjacent("adj-erd-belongs", "erd", ERD_STATE, "every line item belongs to a product", [["line_items", "products", "products->line_items"]]),
  ...adjacent("adj-seq-chain", "sequence", SEQ_STATE, "the user logs in on the web app and the web app posts the form to the api", [["user", "web_app", "user->web_app"], ["web_app", "api", "web_app->api"]]),
  ...adjacent("adj-seq-return", "sequence", SEQ_STATE, "the api returns a token to the web app", [["api", "web_app", "api->web_app"]]),
  { id: "act-filler", view: "gate", state: "Design session transcript", questions: { act: actionable("um so yeah okay let me think") }, truth: { act: false } },
  { id: "act-real", view: "gate", state: "Design session transcript", questions: { act: actionable("the web app calls the api") }, truth: { act: true } },
  { id: "act-real2", view: "gate", state: "Design session transcript", questions: { act: actionable("add redis as a cache") }, truth: { act: true } },
];

type Answers = Record<string, string | boolean>;
interface Sample { ms: number; answers: Answers; conf: Record<string, number>; inTok: number; outTok: number }

async function jev(c: Case): Promise<Sample> {
  const t0 = performance.now();
  const r = await ufetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", dispatcher: pool,
    headers: { authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state: c.state, questions: c.questions }),
  });
  const body = (await r.json()) as { answers: Record<string, { type: string; choice?: string; noul?: number; confidence?: number }>; usage?: { input_tokens: number; output_tokens: number } };
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`jev ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  const answers: Answers = {}, conf: Record<string, number> = {};
  for (const [k, a] of Object.entries(body.answers)) {
    if (a.type === "noul") { answers[k] = (a.noul ?? 0) >= 0.5; conf[k] = Math.max(a.noul ?? 0, 1 - (a.noul ?? 0)); }
    else { answers[k] = a.choice ?? ""; conf[k] = a.confidence ?? 0; }
  }
  return { ms, answers, conf, inTok: body.usage?.input_tokens ?? 0, outTok: body.usage?.output_tokens ?? 0 };
}

async function haiku(c: Case): Promise<Sample> {
  const spec = Object.entries(c.questions).map(([k, q]) => q.type === "noul"
    ? `${k}: ${q.instructions} — answer true or false`
    : `${k}: ${q.instructions}\n  options: ${Object.entries(q.criteria).map(([o, d]) => `${o} (${d})`).join("; ")}`).join("\n");
  const t0 = performance.now();
  const r = await ufetch("https://api.anthropic.com/v1/messages", {
    method: "POST", dispatcher: pool,
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: HAIKU, max_tokens: 120, system: "Answer each question with exactly one option key (or true/false). Reply with one compact JSON object mapping question name to answer, nothing else.",
      messages: [{ role: "user", content: `${c.state}\n\n${spec}` }] }),
  });
  const body = (await r.json()) as { content: Array<{ text: string }>; usage: { input_tokens: number; output_tokens: number } };
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`haiku ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  let answers: Answers = {};
  try { answers = JSON.parse(body.content[0]!.text.replace(/^[^{]*/, "").replace(/[^}]*$/, "")); } catch { /* unparsable = all wrong */ }
  return { ms, answers, conf: {}, inTok: body.usage.input_tokens, outTok: body.usage.output_tokens };
}

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!; };
/** Option key only: Haiku sometimes echoes the description ("users->profiles (users is the one side…)"). */
const key = (a: unknown) => String(a).toLowerCase().split(" (")[0]!.trim();
const same = (a: unknown, b: unknown) => key(a) === key(b);

async function main() {
  if (!process.env.TYPESAFE_API_KEY || !process.env.ANTHROPIC_API_KEY) throw new Error("TYPESAFE_API_KEY and ANTHROPIC_API_KEY are required");
  await jev(CASES[0]!); await haiku(CASES[0]!); // warm both connections
  const rows: Array<{ id: string; engine: "jev" | "haiku"; s: Sample }> = [];
  for (let run = 0; run < RUNS; run++) {
    for (const c of CASES) {
      // Alternate order each run so neither engine always goes first.
      const order = run % 2 ? [haiku, jev] as const : [jev, haiku] as const;
      for (const f of order) {
        try { rows.push({ id: c.id, engine: f === jev ? "jev" : "haiku", s: await f(c) }); }
        catch (e) { console.error(`${c.id} ${f === jev ? "jev" : "haiku"}: ${(e as Error).message}`); }
      }
    }
  }
  const summary: Record<string, unknown> = { where: WHERE, runs: RUNS, cases: CASES.length, haikuModel: HAIKU, at: new Date().toISOString() };
  for (const engine of ["jev", "haiku"] as const) {
    const rs = rows.filter((r) => r.engine === engine);
    let right = 0, total = 0;
    const wrong: Record<string, number> = {};
    for (const r of rs) {
      const c = CASES.find((x) => x.id === r.id)!;
      for (const [k, t] of Object.entries(c.truth)) { total++; if (same(r.s.answers[k], t)) right++; else wrong[`${r.id}.${k}=${String(r.s.answers[k])}`] = (wrong[`${r.id}.${k}=${String(r.s.answers[k])}`] ?? 0) + 1; }
    }
    const ms = rs.map((r) => r.s.ms);
    const inTok = rs.reduce((a, r) => a + r.s.inTok, 0) / rs.length, outTok = rs.reduce((a, r) => a + r.s.outTok, 0) / rs.length;
    const cost = engine === "jev" ? inTok * 0.042e-6 : inTok * 1e-6 + outTok * 5e-6;
    summary[engine] = { p50: Math.round(pct(ms, 50)), p95: Math.round(pct(ms, 95)), accuracy: +(right / total).toFixed(3), decisions: total, avgIn: Math.round(inTok), avgOut: Math.round(outTok), dollarsPerCall: +cost.toFixed(6), wrong };
  }
  // Jev's calibrated confidence: accuracy when confident vs not (the fallback rule we'd use).
  const jr = rows.filter((r) => r.engine === "jev");
  for (const th of [0.8, 0.9]) {
    let hi = 0, hiRight = 0;
    for (const r of jr) {
      const c = CASES.find((x) => x.id === r.id)!;
      for (const [k, t] of Object.entries(c.truth)) if ((r.s.conf[k] ?? 0) >= th) { hi++; if (same(r.s.answers[k], t)) hiRight++; }
    }
    const all = jr.reduce((a, r) => a + Object.keys(CASES.find((x) => x.id === r.id)!.truth).length, 0);
    summary[`jevConfident${th * 100}`] = { share: +(hi / all).toFixed(3), accuracy: hi ? +(hiRight / hi).toFixed(3) : null };
  }
  // Per-view accuracy for Jev.
  summary.jevByView = Object.fromEntries([...new Set(CASES.map((c) => c.view))].map((v) => {
    let right = 0, total = 0;
    for (const r of jr) { const c = CASES.find((x) => x.id === r.id)!; if (c.view !== v) continue; for (const [k, t] of Object.entries(c.truth)) { total++; if (same(r.s.answers[k], t)) right++; } }
    return [v, +(right / total).toFixed(3)];
  }));
  console.log(JSON.stringify(summary, null, 1));
  console.log(`JEV_RESULT ${JSON.stringify(summary)}`);
}

main().then(() => setTimeout(() => process.exit(0), 200), (e) => { console.error(e); process.exit(1); });
