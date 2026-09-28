import { docKind, isBlank, type DesignDoc, type DesignNode, type DocKind } from "./doc.js";
import type { PatchOp } from "./ops.js";
import type { NodeKind, PrimitiveType, Tier } from "./primitives.js";
import { isVocabCommand, type VocabTerm } from "./vocabulary.js";

/**
 * Lexicon tier (ADR 0001, runs in the gateway per ADR 0009): turns the running transcript of an
 * utterance into provisional nodes with no model call, so the first visible change lands ~5 ms
 * after the STT partial. Pure and stateless — recomputed from the full running text each time:
 *  - nouns create a node only if no node of the same *kind key* exists anywhere in the doc, so
 *    repeated partials, second mentions and "make the email field bigger" never duplicate;
 *  - "the/this/that/its <noun>" refers to an existing element: never creates when that type exists;
 *  - modifiers (big / blue / …) are held until the next noun;
 *  - nodes are inserted into root by type rank (Nav < Image < Text < Input < containers < Icon <
 *    Button), so "logo on top" said last still lands above the form once, not append-then-move;
 *  - ids are `n_p_<alias>`, flagged `provisional: true` until the model touches them.
 */

export interface LexiconResult {
  ops: PatchOp[];
  /** `key` = the noun's occurrence key (`button#1`); `mine` = drawn from the user's own word (ADR 0012). */
  created: Array<{ id: string; word: string; kind: string; key: string; mine?: boolean }>;
  /** Occurrence keys (`button#1` = first "button" in the utterance) this call turned into nodes —
   *  nouns plus the modifiers attached to them. Stable under Flux revisions ("sign and" → "sign in"). */
  consumed: string[];
  /** The utterance names another view (ADR 0016): the caller switches to it and runs the lexicon there. */
  view?: DocKind;
}

/** `word#k` for each token: the k-th occurrence of that word in the text (1-based). */
export function occurrenceKeys(words: string[]): string[] {
  const seen = new Map<string, number>();
  return words.map((w) => { const k = (seen.get(w) ?? 0) + 1; seen.set(w, k); return `${w}#${k}`; });
}

const RANK: Partial<Record<PrimitiveType, number>> = { Nav: 0, Image: 1, Text: 2, Input: 3, Card: 4, List: 4, Table: 4, Chart: 4, Stack: 4, Icon: 5, Button: 6 };
const rank = (t: PrimitiveType) => RANK[t] ?? 4;

const SIZE: Record<string, string> = { big: "lg", large: "lg", huge: "lg", small: "sm", tiny: "sm" };
/** Spoken colour → token (ADR 0019: named hues are tokens too, so "pink" is drawable). */
export const COLOR: Record<string, string> = {
  blue: "primary", navy: "primary", purple: "secondary", violet: "secondary", lavender: "secondary", red: "danger", crimson: "danger",
  gray: "muted", grey: "muted", silver: "muted", white: "surface", black: "text", dark: "text",
  pink: "pink", magenta: "pink", rose: "pink", fuchsia: "pink", orange: "orange", amber: "orange", coral: "orange",
  yellow: "yellow", gold: "yellow", golden: "yellow", green: "green", lime: "green", emerald: "green", teal: "teal", turquoise: "teal", cyan: "teal", aqua: "teal",
};
const SCREEN_TITLES: Array<[string[], string]> = [
  [["log", "in"], "Log in"], [["login"], "Log in"], [["sign", "in"], "Sign in"], [["sign", "up"], "Sign up"], [["signup"], "Sign up"],
  [["register"], "Create account"], [["registration"], "Create account"], [["settings"], "Settings"], [["profile"], "Profile"],
  [["checkout"], "Checkout"], [["home"], "Home"], [["dashboard"], "Dashboard"], [["welcome"], "Welcome"], [["onboarding"], "Welcome"],
  [["search"], "Search"], [["cart"], "Your cart"],
];
const BUTTON_LABELS: Array<[string[], string]> = [
  // Known STT mishearings (Flux, M2 ground truth and the 2026-09-27 run: "sign and button" never revised).
  [["sign", "and"], "Sign in"], [["log", "and"], "Log in"],
  [["sign", "in"], "Sign in"], [["log", "in"], "Log in"], [["login"], "Log in"], [["sign", "up"], "Sign up"],
  [["signup"], "Sign up"], [["get", "started"], "Get started"], [["submit"], "Submit"], [["continue"], "Continue"],
  [["next"], "Next"], [["save"], "Save"], [["send"], "Send"], [["buy"], "Buy"], [["checkout"], "Checkout"],
];

type Mods = { size?: string; color?: string };
const phraseBefore = (words: string[], i: number, table: Array<[string[], string]>) => {
  for (const [phrase, text] of table) {
    const start = i - phrase.length;
    if (start >= 0 && phrase.every((w, k) => words[start + k] === w)) return text;
  }
  return null;
};
interface NounSpec { alias: string; type: PrimitiveType; props: (mods: Mods, words: string[], i: number) => Record<string, unknown>; children?: boolean; phrases?: Array<[string[], string]> }
/** Positions of the label phrase the noun read ("sign in" before "button") — consumed with the noun, so
 *  an end-of-turn open-vocabulary check never sends them to the model (plan-critic M7 #1). */
const phraseSpan = (words: string[], i: number, table: Array<[string[], string]> = []): number[] => {
  for (const [phrase] of table) {
    const start = i - phrase.length;
    if (start >= 0 && phrase.every((w, k) => words[start + k] === w)) return phrase.map((_, k) => start + k);
  }
  return [];
};

const NOUNS: Record<string, NounSpec> = {
  email: { alias: "email", type: "Input", props: () => ({ label: "Email", kind: "email", placeholder: "you@example.com" }) },
  password: { alias: "password", type: "Input", props: () => ({ label: "Password", kind: "password" }) },
  username: { alias: "username", type: "Input", props: () => ({ label: "Username", kind: "text" }) },
  logo: { alias: "logo", type: "Image", props: () => ({ alt: "Logo", aspect: "3:1" }) },
  image: { alias: "image", type: "Image", props: () => ({ alt: "Image", aspect: "16:9" }) },
  photo: { alias: "photo", type: "Image", props: () => ({ alt: "Photo", aspect: "16:9" }) },
  picture: { alias: "picture", type: "Image", props: () => ({ alt: "Picture", aspect: "16:9" }) },
  avatar: { alias: "avatar", type: "Image", props: () => ({ alt: "Avatar", aspect: "1:1", radius: "full" }) },
  title: { alias: "title", type: "Text", props: () => ({ content: "Title", variant: "title" }) },
  heading: { alias: "title", type: "Text", props: () => ({ content: "Title", variant: "title" }) },
  headline: { alias: "title", type: "Text", props: () => ({ content: "Title", variant: "title" }) },
  icon: { alias: "icon", type: "Icon", props: (m) => ({ name: "star", ...(m.size ? { size: m.size } : {}), ...(m.color ? { color: m.color } : {}) }) },
  card: { alias: "card", type: "Card", props: (m) => ({ padding: "md", elevation: 1, ...(m.color ? { fill: m.color } : {}) }), children: true },
  list: { alias: "list", type: "List", props: () => ({ items: [{ title: "Item one" }, { title: "Item two" }, { title: "Item three" }] }) },
  nav: { alias: "nav", type: "Nav", props: () => ({ items: ["Home", "Search", "Profile"], position: "bottom" }) },
  navigation: { alias: "nav", type: "Nav", props: () => ({ items: ["Home", "Search", "Profile"], position: "bottom" }) },
  menu: { alias: "nav", type: "Nav", props: () => ({ items: ["Home", "Search", "Profile"], position: "top" }) },
  table: { alias: "table", type: "Table", props: () => ({ columns: ["Name", "Value"], rows: [["—", "—"]] }) },
  chart: { alias: "chart", type: "Chart", props: () => ({ kind: "bar", series: [3, 5, 2, 6] }) },
  graph: { alias: "chart", type: "Chart", props: () => ({ kind: "line", series: [3, 5, 2, 6] }) },
  // A screen named by itself ("a dashboard with a chart…") → its title (M7).
  dashboard: { alias: "title", type: "Text", props: () => ({ content: "Dashboard", variant: "title" }) },
  // "a login screen" / "the settings page" → the screen's title (drawn first, so the model's title folds into it).
  screen: { alias: "title", type: "Text", phrases: SCREEN_TITLES, props: (_m, words, i) => ({ content: phraseBefore(words, i, SCREEN_TITLES) ?? "", variant: "title" }) },
  page: { alias: "title", type: "Text", phrases: SCREEN_TITLES, props: (_m, words, i) => ({ content: phraseBefore(words, i, SCREEN_TITLES) ?? "", variant: "title" }) },
  button: {
    alias: "button", type: "Button", phrases: BUTTON_LABELS,
    props: (m, words, i) => {
      let label = "Button";
      for (const [phrase, text] of BUTTON_LABELS) {
        const start = i - phrase.length;
        if (start >= 0 && phrase.every((w, k) => words[start + k] === w)) { label = text; break; }
      }
      return { label, variant: "primary", ...(m.size ? { size: m.size } : {}), ...(m.color ? { color: m.color } : {}) };
    },
  },
};

/** Size/colour words the lexicon holds until the next noun ("big blue … button"). */
export const isModifier = (w: string) => w in SIZE || w in COLOR;

export const lexTokens = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);

/** Kind key used for dedupe (lexicon vs doc, and model adds vs provisional nodes). */
export function kindKey(n: Pick<DesignNode, "type" | "props">): string {
  const p = n.props as Record<string, unknown>;
  switch (n.type) {
    case "Input": return `Input:${p.kind ?? "text"}`;
    case "Image": return `Image:${String(p.alt ?? "").toLowerCase()}`;
    case "Button": return `Button:${String(p.label ?? "").toLowerCase()}`;
    case "Text": return `Text:${p.variant === "title" || p.variant === "display" ? "title" : String(p.content ?? "").toLowerCase()}`;
    case "Node": return `Node:${String(p.label ?? "").toLowerCase()}`;
    case "Layer": return `Layer:${p.tier}`;
    case "Edge": return `Edge:${p.from}>${p.to}:${String(p.label ?? "").toLowerCase()}`;
    default: return n.type;
  }
}

function collectKinds(n: DesignNode, out = new Set<string>()): Set<string> {
  out.add(kindKey(n));
  out.add(`type:${n.type}`);
  n.children?.forEach((c) => collectKinds(c, out));
  return out;
}

const DEFINITE = new Set(["the", "this", "that", "its", "your", "my"]);
/** A definite article within the 3 words before the noun ("the sign in button") marks a reference. */
const isReference = (words: string[], i: number) => words.slice(Math.max(0, i - 3), i).some((w) => DEFINITE.has(w));

/**
 * `drawn`: occurrence keys already turned into nodes earlier in this utterance — never drawn again,
 * even if the transcript was revised so the label or kind now reads differently.
 */
export function lexicon(
  runningText: string, doc: DesignDoc, drawn: ReadonlySet<string> = new Set(), terms: readonly VocabTerm[] = [],
  kindAllowed: (k: DocKind) => boolean = () => true, // feature flags (ADR 0012): a disabled kind is never switched to
  reservedIds: ReadonlySet<string> = new Set(), // ids used in the project's other views (ADR 0016)
): LexiconResult {
  // Naming a view switches to it — never by replacing anything (ADR 0016). Strong phrases always switch;
  // loose ones ("schema", "a login screen") only while the current view is still blank.
  const want = requestedKind(lexTokens(runningText), isBlank(doc));
  if (want && want !== docKind(doc) && kindAllowed(want)) return { ops: [], created: [], consumed: [], view: want };
  if (doc.root.type === "Diagram") return diagramLexicon(runningText, doc, drawn, terms, reservedIds);
  return screenLexicon(runningText, doc, drawn, reservedIds);
}

function screenLexicon(runningText: string, doc: DesignDoc, drawn: ReadonlySet<string>, reservedIds: ReadonlySet<string>): LexiconResult {
  const words = lexTokens(runningText);
  const occ = occurrenceKeys(words);
  const kinds = collectKinds(doc.root);
  const ids = new Set<string>(reservedIds);
  const walk = (n: DesignNode) => { ids.add(n.id); n.children?.forEach(walk); };
  walk(doc.root);

  const ops: PatchOp[] = [];
  const created: LexiconResult["created"] = [];
  let rootKids = [...(doc.root.children ?? [])];
  const consumed: string[] = [];
  let mods: Mods = {};
  let modIdx: number[] = [];
  words.forEach((w, i) => {
    if (SIZE[w]) { mods.size = SIZE[w]; modIdx.push(i); return; }
    if (COLOR[w]) { mods.color = COLOR[w]; modIdx.push(i); return; }
    const spec = NOUNS[w];
    if (!spec) return;
    if (drawn.has(occ[i]!)) { mods = {}; modIdx = []; return; }
    const props = spec.props(mods, words, i);
    if (spec.type === "Text" && !props.content) return; // "a screen" with no recognisable name → no title
    // Only a noun that takes a colour/size uses up the modifiers; otherwise they stay unhandled, so the
    // model still hears "pink" in "make the button pink and add a logo" (M7).
    const usedMods = ["Button", "Icon", "Card"].includes(spec.type) ? modIdx : [];
    mods = {}; modIdx = [];
    const node: DesignNode = { id: "", type: spec.type, props, provisional: true, ...(spec.children ? { children: [] } : {}) };
    const key = kindKey(node);
    if (kinds.has(key) || (isReference(words, i) && kinds.has(`type:${spec.type}`))) return;
    let id = `n_p_${spec.alias}`, k = 2;
    while (ids.has(id)) id = `n_p_${spec.alias}_${k++}`;
    node.id = id;
    const index = rootKids.filter((c) => rank(c.type) <= rank(spec.type)).length;
    ops.push({ op: "add", path: `/root/children/${index}`, value: node });
    rootKids.splice(index, 0, node);
    kinds.add(key); kinds.add(`type:${spec.type}`); ids.add(id);
    created.push({ id, word: w, kind: key, key: occ[i]! });
    consumed.push(occ[i]!, ...usedMods.map((j) => occ[j]!), ...phraseSpan(words, i, spec.phrases).map((j) => occ[j]!));
  });
  return { ops, created, consumed };
}

// ── Diagrams (ADR 0011) ──────────────────────────────────────────────────────────────────────────

/**
 * Phrases that name a view. Strong ones switch any time; loose ones only while the current view is
 * blank ("database schema" said while describing an architecture must not jump to the ERD).
 * The LATEST phrase wins: partials arrive word by word, so words before it already went to the
 * view that was active when they were spoken (ADR 0016).
 */
const STRONG_TRIGGERS: Array<[string[], DocKind]> = [
  [["architecture"], "architecture"], [["system", "diagram"], "architecture"], [["infrastructure", "diagram"], "architecture"],
  [["erd"], "erd"], [["e", "r", "d"], "erd"], [["entity", "relationship"], "erd"], [["data", "model"], "erd"],
  [["er", "diagram"], "erd"], [["database", "diagram"], "erd"], [["entity", "diagram"], "erd"], [["table", "diagram"], "erd"],
  [["sequence", "diagram"], "sequence"], [["sequence", "flow"], "sequence"], [["flow", "diagram"], "sequence"],
  [["wireframe"], "screen"], [["the", "ui"], "screen"],
];
const LOOSE_TRIGGERS: Array<[string[], DocKind]> = [
  [["system", "design"], "architecture"], [["database", "schema"], "erd"], [["schema"], "erd"], [["the", "tables"], "erd"],
  [["sequence"], "sequence"], [["screen"], "screen"], [["page"], "screen"],
];

export function requestedKind(words: string[], loose = true): DocKind | null {
  let best: { at: number; kind: DocKind } | null = null;
  for (const [phrase, kind] of loose ? [...STRONG_TRIGGERS, ...LOOSE_TRIGGERS] : STRONG_TRIGGERS) {
    for (let i = words.length - phrase.length; i >= 0; i--) {
      if (phrase.every((w, k) => words[i + k] === w)) { if (!best || i > best.at) best = { at: i, kind }; break; }
    }
  }
  return best?.kind ?? null;
}

interface DiagramNoun { label: string; kind: NodeKind; tier?: Tier; tech?: string }
type NounTable = Array<[string[], DiagramNoun]>;

const svc = (label: string, tech?: string): DiagramNoun => ({ label, kind: "service", tier: "api", ...(tech ? { tech } : {}) });
const ext = (label: string): DiagramNoun => ({ label, kind: "external", tier: "api" });
const db = (label: string, tech?: string): DiagramNoun => ({ label, kind: "db", tier: "data", ...(tech ? { tech } : {}) });
const infra = (label: string, kind: NodeKind = "service"): DiagramNoun => ({ label, kind, tier: "infra" });
const fe = (label: string, tech?: string): DiagramNoun => ({ label, kind: "client", tier: "frontend", ...(tech ? { tech } : {}) });

/** Longer phrases first: "web app" must win over "app". */
const ARCH_NOUNS: NounTable = [
  [["load", "balancer"], infra("Load balancer", "cdn")], [["github", "actions"], infra("GitHub Actions")],
  // Enterprise systems (ADR 0016) — SaaS platforms are external systems in the APIs lane; iPaaS is a service.
  [["genesys", "bot"], ext("Genesys bot")], [["genesis", "bot"], ext("Genesys bot")], [["observe", "ai"], ext("Observe.AI")],
  [["service", "now"], ext("ServiceNow")], [["google", "cloud"], infra("Google Cloud")],
  [["salesforce"], ext("Salesforce")], [["mulesoft"], svc("MuleSoft", "MuleSoft")], [["genesys"], ext("Genesys")], [["genesis"], ext("Genesys")],
  [["servicenow"], ext("ServiceNow")], [["zendesk"], ext("Zendesk")], [["workday"], ext("Workday")], [["sap"], ext("SAP")],
  [["hubspot"], ext("HubSpot")], [["segment"], ext("Segment")], [["slack"], ext("Slack")], [["jira"], ext("Jira")],
  [["okta"], { label: "Okta", kind: "auth", tier: "api" }], [["auth0"], { label: "Auth0", kind: "auth", tier: "api" }],
  [["snowflake"], db("Snowflake", "Snowflake")], [["databricks"], db("Databricks", "Databricks")], [["bigquery"], db("BigQuery", "BigQuery")],
  [["elasticsearch"], db("Elasticsearch", "Elasticsearch")], [["dynamo"], db("DynamoDB", "DynamoDB")],
  [["web", "app"], fe("Web app")], [["mobile", "app"], fe("Mobile app")], [["front", "end"], fe("Web app")],
  [["back", "end"], svc("Backend")], [["api", "gateway"], svc("API gateway")], [["message", "queue"], { label: "Queue", kind: "queue", tier: "api" }],
  [["object", "storage"], { label: "Object storage", kind: "storage", tier: "data" }],
  [["frontend"], fe("Web app")], [["webapp"], fe("Web app")], [["browser"], fe("Browser")], [["ios"], fe("iOS app")],
  [["android"], fe("Android app")], [["react"], fe("React app", "React")], [["nextjs"], fe("Next.js app", "Next.js")],
  [["client"], fe("Client")],
  [["api"], svc("API")], [["gateway"], svc("Gateway")], [["backend"], svc("Backend")], [["server"], svc("Server")],
  [["graphql"], svc("GraphQL API", "GraphQL")], [["websocket"], svc("WebSocket server")], [["websockets"], svc("WebSocket server")],
  [["fastify"], svc("API", "Fastify")], [["express"], svc("API", "Express")], [["fastapi"], svc("API", "FastAPI")],
  [["auth"], { label: "Auth", kind: "auth", tier: "api" }], [["worker"], { label: "Worker", kind: "worker", tier: "api" }],
  [["workers"], { label: "Worker", kind: "worker", tier: "api" }], [["queue"], { label: "Queue", kind: "queue", tier: "api" }],
  [["kafka"], { label: "Kafka", kind: "queue", tier: "api" }], [["sqs"], { label: "SQS", kind: "queue", tier: "api" }],
  [["stripe"], ext("Stripe")], [["twilio"], ext("Twilio")], [["openai"], ext("OpenAI")], [["anthropic"], ext("Anthropic")],
  [["claude"], ext("Claude API")], [["deepgram"], ext("Deepgram")], [["sendgrid"], ext("SendGrid")], [["resend"], ext("Resend")],
  [["postgres"], db("Postgres", "Postgres")], [["postgresql"], db("Postgres", "Postgres")], [["mysql"], db("MySQL", "MySQL")],
  [["mongodb"], db("MongoDB", "MongoDB")], [["mongo"], db("MongoDB", "MongoDB")], [["supabase"], db("Supabase", "Postgres")],
  [["dynamodb"], db("DynamoDB", "DynamoDB")], [["database"], db("Database")], [["db"], db("Database")],
  [["redis"], { label: "Redis", kind: "cache", tier: "data", tech: "Redis" }], [["cache"], { label: "Cache", kind: "cache", tier: "data" }],
  [["s3"], { label: "S3", kind: "storage", tier: "data" }], [["storage"], { label: "Object storage", kind: "storage", tier: "data" }],
  [["docker"], infra("Docker")], [["kubernetes"], infra("Kubernetes")], [["k8s"], infra("Kubernetes")],
  [["vercel"], infra("Vercel")], [["railway"], infra("Railway")], [["aws"], infra("AWS")], [["gcp"], infra("Google Cloud")],
  [["azure"], infra("Azure")], [["cloudflare"], infra("Cloudflare", "cdn")], [["cdn"], infra("CDN", "cdn")],
  [["nginx"], infra("Nginx", "cdn")], [["terraform"], infra("Terraform")], [["datadog"], infra("Datadog")], [["sentry"], infra("Sentry")],
];

const ENTITY_WORDS = ["users", "accounts", "orders", "products", "payments", "customers", "sessions", "posts", "comments", "teams",
  "organizations", "invoices", "items", "subscriptions", "messages", "projects", "tasks", "documents", "events", "roles",
  "permissions", "tags", "categories", "carts", "reviews", "addresses", "transactions", "companies", "employees", "tickets",
  "plans", "workspaces", "members", "files", "notifications", "bookings", "listings", "vendors", "shipments", "courses",
  // M7: the domains people actually describe — CRM / contact center, commerce, health, education, ops.
  "contacts", "leads", "opportunities", "cases", "agents", "calls", "interactions", "queues", "skills", "recordings", "transcripts",
  "surveys", "campaigns", "conversations", "channels", "departments", "locations", "stores", "suppliers", "inventories", "warehouses",
  "carriers", "refunds", "coupons", "appointments", "patients", "doctors", "providers", "prescriptions", "students", "teachers",
  "enrollments", "grades", "assignments", "lessons", "schedules", "shifts", "devices", "assets", "contracts", "quotes", "deals", "notes"];
const SINGULAR: Record<string, string> = Object.fromEntries(ENTITY_WORDS.map((w) => [w.replace(/ies$/, "y").replace(/(ss|sh|ch|x)es$/, "$1").replace(/s$/, ""), w]));
const ERD_NOUNS: NounTable = [
  ...ENTITY_WORDS.map((w): [string[], DiagramNoun] => [[w], { label: w, kind: "entity" }]),
  ...Object.entries(SINGULAR).filter(([s, p]) => s !== p).map(([s, p]): [string[], DiagramNoun] => [[s], { label: p, kind: "entity" }]),
];

const actor = (label: string, kind: NodeKind): DiagramNoun => ({ label, kind });
const SEQ_NOUNS: NounTable = [
  [["web", "app"], actor("Web app", "client")], [["mobile", "app"], actor("Mobile app", "client")], [["front", "end"], actor("Web app", "client")],
  [["back", "end"], actor("API", "service")], [["api", "gateway"], actor("API gateway", "service")],
  [["user"], actor("User", "user")], [["customer"], actor("User", "user")], [["browser"], actor("Browser", "client")],
  [["client"], actor("Client", "client")], [["frontend"], actor("Web app", "client")], [["app"], actor("App", "client")],
  [["api"], actor("API", "service")], [["gateway"], actor("Gateway", "service")], [["server"], actor("Server", "service")],
  [["backend"], actor("API", "service")], [["auth"], actor("Auth", "auth")], [["database"], actor("Database", "db")],
  [["db"], actor("Database", "db")], [["postgres"], actor("Postgres", "db")], [["redis"], actor("Redis", "cache")],
  [["cache"], actor("Cache", "cache")], [["queue"], actor("Queue", "queue")], [["worker"], actor("Worker", "worker")],
  [["stripe"], actor("Stripe", "external")], [["deepgram"], actor("Deepgram", "external")], [["claude"], actor("Claude", "external")],
  [["model"], actor("LLM", "external")], [["llm"], actor("LLM", "external")], [["email"], actor("Email service", "external")],
];

const NOUN_TABLES: Record<Exclude<DocKind, "screen">, NounTable> = { architecture: ARCH_NOUNS, erd: ERD_NOUNS, sequence: SEQ_NOUNS };

/** Category nouns that a definite article can point back with ("the app", "the database"). */
const GENERIC = new Set(["App", "API", "Database", "Server", "Client", "Backend", "Gateway", "Web app", "Mobile app", "Browser", "Queue",
  "Cache", "Worker", "Auth", "Object storage", "CDN", "Load balancer", "API gateway", "User", "LLM", "Email service"]);

/** `<word> table` in an ERD names an entity even when it isn't a common noun ("a leads table"). */
const TABLE_WORD = new Set(["table", "tables", "entity"]);
const STOP = new Set(["a", "an", "the", "and", "with", "of", "for", "to", "that", "this", "each", "one", "many", "has", "have", "join", "new"]);

/**
 * Diagram tier 0: nouns become provisional Nodes — architecture components go into their lane,
 * entities and actors append to the diagram in the order spoken (append-stable, so nothing drawn
 * earlier moves). Edges, columns and labels are the model's job.
 */
function diagramLexicon(runningText: string, doc: DesignDoc, drawn: ReadonlySet<string>, terms: readonly VocabTerm[], reservedIds: ReadonlySet<string>): LexiconResult {
  const kind = docKind(doc) as Exclude<DocKind, "screen">;
  // Confirmed user words come first, longest first, so a user's definition wins over a built-in (ADR 0012).
  const mine: NounTable = terms.filter((t) => t.kind === kind && t.status === "confirmed")
    .map((t): [string[], DiagramNoun] => [t.phrase.split(" "), { label: t.node.label, kind: t.node.kind, ...(t.node.tier ? { tier: t.node.tier } : {}) }])
    .sort((a, b) => b[0].length - a[0].length);
  const table = [...mine, ...NOUN_TABLES[kind]];
  const words = lexTokens(runningText);
  if (isVocabCommand(runningText)) return { ops: [], created: [], consumed: [] }; // a vocabulary command, not a drawing
  const occ = occurrenceKeys(words);
  const labels = new Set<string>();
  const kinds = new Set<string>();
  const kindWords = new Map<string, Set<string>>(); // kind → every word of every label of that kind
  const ids = new Set<string>(reservedIds);
  const walk = (n: DesignNode) => {
    ids.add(n.id);
    if (n.type === "Node") {
      labels.add(String(n.props.label).toLowerCase()); kinds.add(String(n.props.kind));
      const ws = kindWords.get(String(n.props.kind)) ?? new Set<string>();
      lexTokens(String(n.props.label)).forEach((w) => ws.add(w));
      kindWords.set(String(n.props.kind), ws);
    }
    n.children?.forEach(walk);
  };
  walk(doc.root);
  const remember = (noun: DiagramNoun) => { const ws = kindWords.get(noun.kind) ?? new Set<string>(); lexTokens(noun.label).forEach((w) => ws.add(w)); kindWords.set(noun.kind, ws); };
  const counts = new Map<string, number>(); // children per lane path, updated as we add
  const kidsOf = (path: string, n: DesignNode) => counts.get(path) ?? n.children?.length ?? 0;
  let nodeAt = (doc.root.children ?? []).map((c) => c.type).lastIndexOf("Node") + 1;
  let prevNounEnd = 0;

  const ops: PatchOp[] = [];
  const created: LexiconResult["created"] = [];
  const consumed: string[] = [];
  for (let i = 0; i < words.length; i++) {
    let hit: { len: number; noun: DiagramNoun; mine?: boolean } | null = null;
    for (const [ti, [phrase, noun]] of table.entries()) {
      if (i + phrase.length <= words.length && phrase.every((w, k) => words[i + k] === w)) { hit = { len: phrase.length, noun, mine: ti < mine.length }; break; }
    }
    if (!hit && kind === "erd" && TABLE_WORD.has(words[i + 1] ?? "") && !STOP.has(words[i]!) && !TABLE_WORD.has(words[i]!) && /^[a-z][a-z_]{2,}$/.test(words[i]!)) {
      hit = { len: 1, noun: { label: SINGULAR[words[i]!] ?? words[i]!, kind: "entity" } };
    }
    if (!hit) continue;
    const keys = occ.slice(i, i + hit.len);
    const definite = words.slice(Math.max(i - 3, prevNounEnd), i).some((w) => DEFINITE.has(w));
    i += hit.len - 1;
    prevNounEnd = i + 1;
    if (keys.some((k) => drawn.has(k))) continue;
    const { noun } = hit;
    if (labels.has(noun.label.toLowerCase())) continue;
    // "the app" after "web app": a definite reference to something of that kind already drawn. Only
    // the words since the previous noun count — in "the ledger and postgres" the "the" is the ledger's.
    // Only a generic noun can refer back ("the app" = the web app); a named system is itself ("the genesys
    // bot" next to Genesys is a new component, M7).
    // …and only to an element that shares a word with it: "the app" is the Web app, but "the api" is not a
    // "Service" the model drew earlier (M7 live trace: API was never drawn).
    if (definite && GENERIC.has(noun.label) && lexTokens(noun.label).some((w) => kindWords.get(noun.kind)?.has(w))) continue;
    const alias = noun.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "node";
    let id = `n_p_${alias}`, n = 2;
    while (ids.has(id)) id = `n_p_${alias}_${n++}`;
    const props: Record<string, unknown> = { label: noun.label, kind: noun.kind, ...(noun.tech ? { tech: noun.tech } : {}), ...(kind === "erd" ? { cols: ["id:uuid:pk"] } : {}) };
    const node: DesignNode = { id, type: "Node", props, provisional: true };
    let parentPath = "/root", parent = doc.root;
    if (kind === "architecture") {
      const idx = (doc.root.children ?? []).findIndex((c) => c.type === "Layer" && c.props.tier === noun.tier);
      if (idx < 0) continue;
      parentPath = `/root/children/${idx}`; parent = doc.root.children![idx]!;
    } else {
      // Nodes before Edges: a new entity/actor goes right after the last Node, so edge order is untouched.
      ops.push({ op: "add", path: `/root/children/${nodeAt}`, value: node });
      nodeAt++;
      ids.add(id); labels.add(noun.label.toLowerCase()); kinds.add(noun.kind); remember(noun); created.push({ id, word: words[i]!, kind: kindKey(node), key: keys[0]!, ...(hit.mine ? { mine: true } : {}) }); consumed.push(...keys);
      continue;
    }
    const at = kidsOf(parentPath, parent);
    ops.push({ op: "add", path: `${parentPath}/children/${at}`, value: node });
    counts.set(parentPath, at + 1);
    ids.add(id); labels.add(noun.label.toLowerCase()); kinds.add(noun.kind); remember(noun); created.push({ id, word: words[i]!, kind: kindKey(node), key: keys[0]!, ...(hit.mine ? { mine: true } : {}) }); consumed.push(...keys);
  }
  return { ops, created, consumed };
}

/**
 * The words each diagram kind understands, for the UI's vocabulary rail — steering speech toward
 * terms the lexicon draws instantly (0 ms, no model call) keeps diagrams fast and predictable.
 */
export interface VocabEntry { phrase: string; label: string; kind: NodeKind; tier?: Tier }

/**
 * The words each diagram kind understands, for the keyword rail — steering speech toward terms the
 * lexicon draws instantly (0 ms, no model call) keeps diagrams fast and predictable (ADR 0012).
 * Each entry says exactly what it draws, so the tooltip is the rule itself.
 */
export function diagramVocabulary(kind: Exclude<DocKind, "screen">): { terms: VocabEntry[]; relations: string[]; example: string } {
  const seen = new Set<string>();
  const terms = NOUN_TABLES[kind]
    .map(([p, n]): VocabEntry => ({ phrase: p.join(" "), label: n.label, kind: n.kind, ...(n.tier ? { tier: n.tier } : {}) }))
    .filter((t) => t.phrase.length > 2 && !seen.has(t.label) && (seen.add(t.label), true));
  return {
    architecture: { terms, relations: ["calls", "writes to", "reads from", "publishes to", "deployed on", "behind"],
      example: "a Next.js web app calls a Fastify API that writes to Postgres and Redis, deployed on Railway" },
    erd: { terms, relations: ["has many", "belongs to", "with a … column", "one-to-one", "join table"],
      example: "users with an email, each user has many orders, orders have a total and a status" },
    sequence: { terms, relations: ["sends", "calls", "returns", "validates", "saves", "then"],
      example: "the user logs in on the web app, the app posts credentials to the API, the API checks Postgres and returns a token" },
  }[kind];
}

/**
 * Re-reads the main text of screen elements the lexicon drew this utterance while they're still
 * provisional: STT revises words ("sign and button" → "sign in button"), and before the Jev tier the
 * model quietly fixed the label. `drawnAt` maps the noun's occurrence key → the node it drew.
 */
export function refreshProvisional(runningText: string, doc: DesignDoc, drawnAt: ReadonlyMap<string, string>): PatchOp[] {
  if (doc.root.type === "Diagram") return refreshDiagram(runningText, doc, drawnAt);
  if (doc.root.type !== "Frame") return [];
  const words = lexTokens(runningText);
  const occ = occurrenceKeys(words);
  const ops: PatchOp[] = [];
  for (const [key, id] of drawnAt) {
    const i = occ.indexOf(key);
    const spec = i >= 0 ? NOUNS[words[i]!] : undefined;
    if (!spec) continue;
    const at = (doc.root.children ?? []).findIndex((c) => c.id === id);
    const node = doc.root.children?.[at];
    if (!node?.provisional) continue; // the model (or the user) owns it now
    const prop = spec.type === "Button" ? "label" : spec.type === "Text" ? "content" : null;
    if (!prop) continue;
    const value = spec.props({}, words, i)[prop];
    if (typeof value === "string" && value && value !== node.props[prop]) ops.push({ op: "replace", path: `/root/children/${at}/props/${prop}`, value });
  }
  return ops;
}

// ── Speech repair (M7, ADR 0019) ──────────────────────────────────────────────────────────────────

/**
 * Known speech-to-text mishearings that change meaning, as [heard, meant, only-before]. Small and explicit:
 * Flux writes "rights to" for "writes to" (live, 2026-09-28). Applied to what Jev and the model READ;
 * the raw transcript (and its word keys, used for highlighting) is never rewritten.
 */
const SPOKEN_FIXES: Array<[string, string, ReadonlySet<string> | null]> = [
  ["rights", "writes", new Set(["to", "into", "in", "data", "events", "records", "the", "a"])],
  ["right", "writes", new Set(["to", "into"])],
  ["rites", "writes", null], ["reeds", "reads", null], ["reids", "reads", null],
];
export function fixSpeech(text: string): string {
  const words = text.split(/(\s+)/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase().replace(/[^a-z]/g, "");
    const fix = SPOKEN_FIXES.find(([heard]) => heard === w);
    if (!fix) continue;
    const next = (words.slice(i + 1).find((x) => x.trim()) ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (!fix[2] || fix[2].has(next)) words[i] = words[i]!.toLowerCase().replace(fix[0], fix[1]);
  }
  return words.join("");
}

/** Every word the lexicon itself understands in a view (nouns, view names) — never "unknown" to open vocabulary. */
export function lexiconWords(kind: DocKind): Set<string> {
  const out = new Set<string>(Object.keys(COLOR));
  for (const [p] of [...STRONG_TRIGGERS, ...LOOSE_TRIGGERS]) p.forEach((w) => out.add(w));
  if (kind === "screen") { Object.keys(NOUNS).forEach((w) => out.add(w)); Object.keys(SIZE).forEach((w) => out.add(w)); }
  else NOUN_TABLES[kind].forEach(([p]) => p.forEach((w) => out.add(w)));
  return out;
}

/**
 * Diagrams: a noun drawn from the first word of a longer name is renamed when the name completes — "the api"
 * is drawn at "api", then "gateway" arrives: the still-provisional node becomes "API gateway" (M7). Same lane
 * only (a move would be a reflow); never onto a label that already exists.
 */
function refreshDiagram(runningText: string, doc: DesignDoc, drawnAt: ReadonlyMap<string, string>): PatchOp[] {
  const kind = docKind(doc) as Exclude<DocKind, "screen">;
  const words = lexTokens(runningText);
  const occ = occurrenceKeys(words);
  const nodes = new Map<string, { node: DesignNode; path: string; tier?: string }>();
  const labels = new Set<string>();
  const walk = (n: DesignNode, path: string, tier?: string) => {
    if (n.type === "Node") { nodes.set(n.id, { node: n, path, ...(tier ? { tier } : {}) }); labels.add(String(n.props.label).toLowerCase()); }
    n.children?.forEach((c, i) => walk(c, `${path}/children/${i}`, n.type === "Layer" ? String(n.props.tier) : tier));
  };
  walk(doc.root, "/root");
  const ops: PatchOp[] = [];
  for (const [key, id] of drawnAt) {
    const i = occ.indexOf(key);
    const hit = nodes.get(id);
    if (i < 0 || !hit?.node.provisional) continue;
    const longer = NOUN_TABLES[kind].find(([p]) => p.length > 1 && i + p.length <= words.length && p.every((w, k) => words[i + k] === w));
    if (!longer) continue;
    const [, noun] = longer;
    if (noun.label === hit.node.props.label || labels.has(noun.label.toLowerCase())) continue;
    if (kind === "architecture" && noun.tier !== hit.tier) continue;
    ops.push({ op: "replace", path: `${hit.path}/props/label`, value: noun.label });
    if (noun.tech) ops.push({ op: "add", path: `${hit.path}/props/tech`, value: noun.tech });
    ops.push({ op: "replace", path: `${hit.path}/props/kind`, value: noun.kind });
    labels.add(noun.label.toLowerCase());
  }
  return ops;
}
