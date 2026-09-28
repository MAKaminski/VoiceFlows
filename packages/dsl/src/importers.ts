import { viewDoc, type DesignDoc, type DesignNode } from "./doc.js";
import { LANE_OF, type ScaffoldStep } from "./scaffold.js";

/**
 * Bring your systems (ADR 0022): what a customer already has — a SQL schema or pg_dump, a Prisma schema, an
 * OpenAPI 3 document (JSON), a package.json — parsed into one neutral shape and then into compact lines for the
 * ERD and the Architecture (scaffolding fills the other views). Pure, $0, no eval.
 *
 * The input is untrusted: every table and column name is normalised to `[a-z_][a-z0-9_]{0,62}` and every label
 * to a short safe charset HERE, at the boundary, so nothing hostile reaches the compact grammar, generated code
 * or a model prompt (plan-critic M10 #6).
 */
export type ImportKind = "sql" | "prisma" | "openapi" | "package";
export interface ImportedTable { name: string; cols: string[] } // cols: ColumnSpec strings (name:type[:pk|:fk])
export interface ImportedComponent { label: string; kind: string }
export interface Imported {
  kind: ImportKind;
  tables: ImportedTable[];
  relations: Array<{ one: string; many: string }>; // one-side table → many-side table (the FK lives on `many`)
  components: ImportedComponent[];
  flows: Array<{ from: string; to: string; label: string }>; // architecture edges, by component label
  dropped: number; // items over the caps
}
export const IMPORT_MAX_BYTES = 524_288;
export const IMPORT_CAPS = { tables: 60, cols: 40, components: 40, flows: 20 } as const;

// ── Sanitising (the only way a name gets in) ─────────────────────────────────────────────────────────────
export const ident = (s: string): string | null => {
  const x = s.trim().replace(/^["'`\[]|["'`\]]$/g, "").replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^[^a-z]+/, "").replace(/_$/, "").slice(0, 63);
  return x || null;
};
export const safeLabel = (s: string): string | null => {
  const x = s.replace(/[^\p{L}\p{N} .&+/-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return x || null;
};
const TYPE_MAP: Record<string, string> = {
  uuid: "uuid", text: "text", varchar: "text", character: "text", char: "text", string: "text", citext: "text",
  int: "int", integer: "int", int4: "int", smallint: "int", int2: "int", serial: "int", bigint: "bigint", int8: "bigint", bigserial: "bigint",
  numeric: "numeric", decimal: "numeric", real: "float", float: "float", float4: "float", float8: "float", double: "float", money: "numeric", number: "numeric",
  bool: "bool", boolean: "bool", timestamptz: "timestamptz", timestamp: "timestamptz", datetime: "timestamptz", date: "date", time: "time",
  json: "jsonb", jsonb: "jsonb", bytea: "bytea", inet: "text", interval: "text", object: "jsonb", array: "jsonb",
};
export const normalizeType = (raw: string): string => {
  const t = raw.toLowerCase().replace(/\(.*$/, "").replace(/\[\]$/, "").trim().split(/\s+/)[0] ?? "text";
  return TYPE_MAP[t] ?? (/^enum|^user-defined/.test(t) ? "text" : "text");
};

function finish(kind: ImportKind, tables: ImportedTable[], relations: Imported["relations"], components: ImportedComponent[] = [], flows: Imported["flows"] = []): Imported {
  let dropped = 0;
  const byName = new Map<string, ImportedTable>();
  for (const t of tables) {
    const prev = byName.get(t.name);
    if (prev) { for (const c of t.cols) if (!prev.cols.some((p) => p.split(":")[0] === c.split(":")[0])) prev.cols.push(c); continue; }
    if (byName.size >= IMPORT_CAPS.tables) { dropped++; continue; }
    byName.set(t.name, t);
  }
  for (const t of byName.values()) if (t.cols.length > IMPORT_CAPS.cols) { dropped += t.cols.length - IMPORT_CAPS.cols; t.cols = t.cols.slice(0, IMPORT_CAPS.cols); }
  const seen = new Set<string>();
  const rels = relations.filter((r) => {
    const k = [r.one, r.many].sort().join("|");
    if (r.one === r.many || seen.has(k) || !byName.has(r.one) || !byName.has(r.many)) return false;
    seen.add(k); return true;
  });
  const comps: ImportedComponent[] = [];
  for (const c of components) {
    if (comps.some((x) => x.label.toLowerCase() === c.label.toLowerCase())) continue;
    if (comps.length >= IMPORT_CAPS.components) { dropped++; continue; }
    comps.push(c);
  }
  const fl = flows.filter((f) => comps.some((c) => c.label === f.from) && comps.some((c) => c.label === f.to));
  dropped += Math.max(0, fl.length - IMPORT_CAPS.flows);
  return { kind, tables: [...byName.values()], relations: rels, components: comps, flows: fl.slice(0, IMPORT_CAPS.flows), dropped };
}

// ── SQL DDL / pg_dump ────────────────────────────────────────────────────────────────────────────────────
/** Split on commas at paren depth 0. */
function topLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "", quote: string | null = null;
  for (const ch of body) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === "`") { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const NAME = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[\w$]+)`;
const QNAME = String.raw`(?:${NAME}\.)?(${NAME})`;
const names = (list: string) => list.split(",").map((x) => ident(x)).filter((x): x is string => !!x);

export function parseSql(text: string): Imported {
  const src = text.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const tables: ImportedTable[] = [];
  const relations: Imported["relations"] = [];
  const fkCols: Array<[string, string]> = [];
  const createRe = new RegExp(String.raw`create\s+(?:(?:global\s+|local\s+)?(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?${QNAME}\s*\(`, "gi");
  for (const m of src.matchAll(createRe)) {
    const name = ident(m[1]!);
    if (!name) continue;
    // Body: from the "(" to its matching ")".
    let i = m.index! + m[0].length, depth = 1, body = "";
    for (; i < src.length && depth; i++) { const ch = src[i]!; if (ch === "(") depth++; if (ch === ")") depth--; if (depth) body += ch; }
    const cols: string[] = [];
    const pks = new Set<string>();
    for (const item of topLevel(body)) {
      const head = item.toLowerCase();
      if (/^(constraint\s+\S+\s+)?primary\s+key/.test(head)) { for (const c of names(item.replace(/^.*?key\s*\(/is, "").replace(/\).*$/s, ""))) pks.add(c); continue; }
      if (/^(constraint\s+\S+\s+)?foreign\s+key/.test(head)) {
        const fm = item.match(new RegExp(String.raw`foreign\s+key\s*\(([^)]*)\)\s*references\s+${QNAME}`, "i"));
        const ref = fm && ident(fm[2]!);
        if (fm && ref) { relations.push({ one: ref, many: name }); for (const c of names(fm[1]!)) fkCols.push([name, c]); }
        continue;
      }
      if (/^(constraint|unique|check|index|key|exclude|like)\b/.test(head)) continue;
      const cm = item.match(new RegExp(String.raw`^(${NAME})\s+(.+)$`, "s"));
      if (!cm) continue;
      const col = ident(cm[1]!);
      if (!col) continue;
      const rest = cm[2]!;
      const type = normalizeType(rest.replace(/\s+(not\s+null|null|default|primary|references|unique|check|constraint|generated|collate)\b.*$/is, ""));
      const refm = rest.match(new RegExp(String.raw`references\s+${QNAME}`, "i"));
      if (/primary\s+key/i.test(rest)) pks.add(col);
      if (refm) { const ref = ident(refm[1]!); if (ref) { relations.push({ one: ref, many: name }); fkCols.push([name, col]); } }
      cols.push(`${col}:${type}`);
    }
    tables.push({ name, cols: cols.map((c) => (pks.has(c.split(":")[0]!) ? `${c}:pk` : c)) });
  }
  const alterRe = new RegExp(String.raw`alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?${QNAME}\s+add\s+(?:constraint\s+${NAME}\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+${QNAME}`, "gi");
  for (const m of src.matchAll(alterRe)) {
    const many = ident(m[1]!), one = ident(m[3]!);
    if (many && one) { relations.push({ one, many }); for (const c of names(m[2]!)) fkCols.push([many, c]); }
  }
  const pkAlter = new RegExp(String.raw`alter\s+table\s+(?:only\s+)?${QNAME}\s+add\s+(?:constraint\s+${NAME}\s+)?primary\s+key\s*\(([^)]*)\)`, "gi");
  for (const m of src.matchAll(pkAlter)) {
    const t = tables.find((x) => x.name === ident(m[1]!));
    if (t) { const pk = new Set(names(m[2]!)); t.cols = t.cols.map((c) => (pk.has(c.split(":")[0]!) && !c.endsWith(":pk") ? `${c}:pk` : c)); }
  }
  for (const [t, c] of fkCols) {
    const tb = tables.find((x) => x.name === t);
    if (tb) tb.cols = tb.cols.map((x) => (x.split(":")[0] === c && !/:(pk|fk)$/.test(x) ? `${x}:fk` : x));
  }
  return finish("sql", tables, relations);
}

// ── Prisma ───────────────────────────────────────────────────────────────────────────────────────────────
const PRISMA_TYPES: Record<string, string> = { String: "text", Int: "int", BigInt: "bigint", Float: "float", Decimal: "numeric", Boolean: "bool", DateTime: "timestamptz", Json: "jsonb", Bytes: "bytea" };
export function parsePrisma(text: string): Imported {
  const src = text.replace(/\/\/[^\n]*/g, "");
  const models = [...src.matchAll(/model\s+(\w+)\s*\{([^}]*)\}/g)];
  const modelNames = new Map(models.map((m) => [m[1]!, ident(m[1]!)!]));
  const tables: ImportedTable[] = [];
  const relations: Imported["relations"] = [];
  for (const [, rawName, body] of models) {
    const name = modelNames.get(rawName!)!;
    const cols: string[] = [];
    const fks = new Set<string>();
    for (const line of body!.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("@@"))) {
      const [field, typeRaw = ""] = line.split(/\s+/);
      const type = typeRaw.replace(/[?[\]]/g, "");
      const col = ident(field ?? "");
      if (!col) continue;
      if (modelNames.has(type)) {
        const rel = line.match(/@relation\([^)]*fields:\s*\[([^\]]*)\]/);
        if (rel) { relations.push({ one: modelNames.get(type)!, many: name }); for (const f of names(rel[1]!)) fks.add(f); }
        continue; // relation fields are edges, not columns
      }
      cols.push(`${col}:${PRISMA_TYPES[type] ?? "text"}${/@id\b/.test(line) ? ":pk" : ""}`);
    }
    tables.push({ name, cols: cols.map((c) => (fks.has(c.split(":")[0]!) && !c.endsWith(":pk") ? `${c}:fk` : c)) });
  }
  return finish("prisma", tables, relations);
}

// ── OpenAPI 3 (JSON) ────────────────────────────────────────────────────────────────────────────────────
interface Schema { type?: string; format?: string; properties?: Record<string, Schema>; items?: Schema; $ref?: string; allOf?: Schema[] }
export function parseOpenApi(doc: unknown): Imported {
  const d = (doc ?? {}) as { info?: { title?: string }; paths?: Record<string, Record<string, unknown>>; components?: { schemas?: Record<string, Schema> } };
  const refName = (ref?: string) => (ref ? ident(ref.split("/").pop() ?? "") : null);
  const tables: ImportedTable[] = [];
  const relations: Imported["relations"] = [];
  for (const [raw, s] of Object.entries(d.components?.schemas ?? {})) {
    const name = ident(raw);
    if (!name) continue;
    const props = { ...(s.properties ?? {}), ...Object.assign({}, ...(s.allOf ?? []).map((x) => x.properties ?? {})) } as Record<string, Schema>;
    const cols: string[] = [];
    for (const [pRaw, p] of Object.entries(props)) {
      const col = ident(pRaw);
      if (!col) continue;
      const ref = refName(p.$ref) ?? refName(p.items?.$ref);
      if (ref) {
        if (p.type === "array") relations.push({ one: name, many: ref });
        else { relations.push({ one: ref, many: name }); cols.push(`${col.replace(/_id$/, "")}_id:uuid:fk`); }
        continue;
      }
      const t = p.format === "uuid" ? "uuid" : p.format === "date-time" ? "timestamptz" : p.format === "date" ? "date" : p.type === "integer" ? "int" : normalizeType(p.type ?? "text");
      cols.push(`${col}:${t}${col === "id" ? ":pk" : ""}`);
    }
    tables.push({ name, cols });
  }
  const api = safeLabel(d.info?.title ?? "") ?? "API";
  const components: ImportedComponent[] = [{ label: "Client", kind: "client" }, { label: api, kind: "service" }];
  if (tables.length) components.push({ label: "Database", kind: "db" });
  const flows: Imported["flows"] = [{ from: "Client", to: api, label: "calls" }];
  if (tables.length) flows.push({ from: api, to: "Database", label: "reads and writes" });
  return finish("openapi", tables, relations, components, flows);
}

// ── package.json ─────────────────────────────────────────────────────────────────────────────────────────
const DEPS: Array<[RegExp, string, string]> = [
  [/^(next|react|react-dom|vue|nuxt|svelte|@sveltejs\/kit|@angular\/core|solid-js|astro)$/, "Web app", "client"],
  [/^(react-native|expo)$/, "Mobile app", "client"],
  [/^(express|fastify|koa|hono|@nestjs\/core|@hapi\/hapi|restify)$/, "API", "service"],
  [/^(pg|postgres|@neondatabase\/serverless|@vercel\/postgres)$/, "Postgres", "db"],
  [/^(prisma|@prisma\/client|drizzle-orm|typeorm|sequelize|knex|kysely)$/, "Postgres", "db"],
  [/^(mysql|mysql2)$/, "MySQL", "db"], [/^(mongodb|mongoose)$/, "MongoDB", "db"], [/^(@supabase\/supabase-js)$/, "Supabase", "db"],
  [/^(redis|ioredis|@upstash\/redis)$/, "Redis", "cache"],
  [/^(bullmq|bull|bee-queue)$/, "Job queue", "queue"], [/^(kafkajs)$/, "Kafka", "queue"], [/^(amqplib)$/, "RabbitMQ", "queue"],
  [/^(stripe)$/, "Stripe", "external"], [/^(@sendgrid\/mail)$/, "SendGrid", "external"], [/^(twilio)$/, "Twilio", "external"],
  [/^(resend)$/, "Resend", "external"], [/^(postmark)$/, "Postmark", "external"], [/^(@slack\/web-api|@slack\/bolt)$/, "Slack", "external"],
  [/^(@anthropic-ai\/sdk)$/, "Anthropic", "external"], [/^(openai)$/, "OpenAI", "external"], [/^(algoliasearch)$/, "Algolia", "external"],
  [/^(@aws-sdk\/client-s3|aws-sdk)$/, "S3", "storage"], [/^(@google-cloud\/storage)$/, "Cloud Storage", "storage"],
  [/^(next-auth|@auth\/core|@auth0\/.*|@clerk\/.*|passport)$/, "Auth", "auth"],
  [/^(@sentry\/.*)$/, "Sentry", "external"], [/^(posthog-js|posthog-node|@segment\/.*)$/, "Analytics", "external"],
];
export function parsePackage(doc: unknown): Imported {
  const d = (doc ?? {}) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = Object.keys({ ...(d.dependencies ?? {}) });
  const components: ImportedComponent[] = [];
  for (const dep of deps) for (const [re, label, kind] of DEPS) if (re.test(dep)) components.push({ label, kind });
  const has = (k: string) => components.filter((c) => c.kind === k);
  const flows: Imported["flows"] = [];
  const client = has("client")[0], server = has("service")[0];
  if (client && server) flows.push({ from: client.label, to: server.label, label: "calls" });
  const hub = server ?? client;
  if (hub) for (const c of components) if (c !== hub && c !== client && c !== server) flows.push({ from: hub.label, to: c.label, label: c.kind === "db" ? "writes to" : c.kind === "cache" ? "caches in" : c.kind === "queue" ? "enqueues to" : "calls" });
  return finish("package", [], [], components, flows);
}

// ── Detect + parse ───────────────────────────────────────────────────────────────────────────────────────
export function detectImport(text: string): ImportKind | null {
  const t = text.trimStart();
  if (t.startsWith("{")) {
    try { const j = JSON.parse(t); return j && typeof j === "object" ? ("openapi" in j || "swagger" in j ? "openapi" : "dependencies" in j || "devDependencies" in j || "name" in j ? "package" : null) : null; } catch { return null; }
  }
  if (/\bmodel\s+\w+\s*\{/.test(t) && /\b(datasource|generator)\b|@id\b|@relation\b/.test(t)) return "prisma";
  if (/\bcreate\s+table\b/i.test(t)) return "sql";
  return null;
}
export function parseImport(text: string, kind: ImportKind | null = detectImport(text)): Imported | null {
  if (!kind || text.length > IMPORT_MAX_BYTES) return null;
  if (kind === "sql") return parseSql(text);
  if (kind === "prisma") return parsePrisma(text);
  try { const j = JSON.parse(text); return kind === "openapi" ? parseOpenApi(j) : parsePackage(j); } catch { return null; }
}
export const importSummary = (i: Imported) => [
  i.tables.length && `${i.tables.length} table${i.tables.length === 1 ? "" : "s"}${i.relations.length ? `, ${i.relations.length} relation${i.relations.length === 1 ? "" : "s"}` : ""} → ERD`,
  i.components.length && `${i.components.length} component${i.components.length === 1 ? "" : "s"} → Architecture`,
  i.dropped && `${i.dropped} over the limits skipped`,
].filter(Boolean).join(" · ") || "nothing recognisable";

// ── Imported → compact lines (existing names are merged, never duplicated) ───────────────────────────────
type N = DesignNode;
const all = (n: N, out: N[] = []): N[] => { out.push(n); n.children?.forEach((c) => all(c, out)); return out; };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const q = (s: string) => `"${s.replace(/"/g, "'")}"`;
export function importSteps(project: DesignDoc, imp: Imported): ScaffoldStep[] {
  const steps: ScaffoldStep[] = [];
  // ERD: new tables are added; existing ones get the columns they lack.
  const erd = all(viewDoc(project, "erd").root).filter((n) => n.type === "Node");
  const erdLines: string[] = [];
  const idOf = new Map<string, string>();
  for (const t of imp.tables) {
    const hit = erd.find((n) => norm(String(n.props.label)) === norm(t.name));
    if (hit) {
      idOf.set(t.name, hit.id);
      const current = (hit.props.cols as string[] | undefined) ?? [];
      const have = new Set(current.map((c) => c.split(":")[0]));
      const add = t.cols.filter((c) => !have.has(c.split(":")[0]));
      if (add.length) erdLines.push(`~${hit.id} cols=${[...current, ...add].join(",")}`);
    } else {
      const alias = `t_${t.name}`.slice(0, 40);
      idOf.set(t.name, alias);
      const cols = t.cols.length ? t.cols : ["id:uuid:pk"];
      erdLines.push(`+Node ${alias} >root k=entity cols=${cols.join(",")} ${q(t.name)}`);
    }
  }
  const erdEdges = all(viewDoc(project, "erd").root).filter((n) => n.type === "Edge");
  imp.relations.forEach((r, i) => {
    const a = idOf.get(r.one), b = idOf.get(r.many);
    if (!a || !b || erdEdges.some((e) => (e.props.from === a && e.props.to === b) || (e.props.from === b && e.props.to === a))) return;
    erdLines.push(`+Edge r${i} >root from=${a} to=${b} card=1:n "has many"`);
  });
  if (erdLines.length) steps.push({ view: "erd", lines: erdLines });
  // Architecture: components into their lanes; flows between them.
  const arch = viewDoc(project, "architecture").root;
  const archNodes = all(arch).filter((n) => n.type === "Node");
  const lane = (tier: string) => (arch.children ?? []).find((c) => c.type === "Layer" && c.props.tier === tier)?.id;
  const archLines: string[] = [];
  const cid = new Map<string, string>();
  imp.components.forEach((c, i) => {
    const hit = archNodes.find((n) => norm(String(n.props.label)) === norm(c.label));
    if (hit) { cid.set(c.label, hit.id); return; }
    const l = lane(LANE_OF[c.kind] ?? "api");
    if (!l) return;
    cid.set(c.label, `c${i}`);
    archLines.push(`+Node c${i} >${l} k=${c.kind} ${q(c.label)}`);
  });
  const archEdges = all(arch).filter((n) => n.type === "Edge");
  imp.flows.forEach((f, i) => {
    const a = cid.get(f.from), b = cid.get(f.to);
    if (!a || !b || archEdges.some((e) => e.props.from === a && e.props.to === b)) return;
    archLines.push(`+Edge f${i} >root from=${a} to=${b} ${q(f.label)}`);
  });
  if (archLines.length) steps.push({ view: "architecture", lines: archLines });
  return steps;
}
