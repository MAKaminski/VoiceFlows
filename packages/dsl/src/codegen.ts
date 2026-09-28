import { viewDoc, type DesignDoc, type DesignNode, type DocKind } from "./doc.js";
import { ident, normalizeType } from "./importers.js";
import { utilization } from "./layout.js";
import { compilePrd } from "./prd.js";
import { defaultTokens } from "./tokens.js";

/**
 * Build it (ADR 0022): the six views → a starter codebase. One pure generator per worker — each reads the views
 * it owns and writes its files; nothing here calls a model. The output compiles by construction (checked by
 * `pnpm test:codegen`): SQL that applies to Postgres, TypeScript that typechecks. "AI fill" (gateway) may then
 * rewrite individual files' bodies; the skeleton is always the fallback.
 */
export type Worker = "db" | "contracts" | "api" | "web" | "infra" | "load" | "plan" | "readme";
export interface CodeFile { path: string; content: string; worker: Worker }
export const WORKERS: ReadonlyArray<{ id: Worker; label: string; reads: DocKind[] }> = [
  { id: "db", label: "Database", reads: ["erd"] },
  { id: "contracts", label: "Contracts", reads: ["erd"] },
  { id: "api", label: "API", reads: ["architecture", "sequence", "erd"] },
  { id: "web", label: "Web", reads: ["screen"] },
  { id: "infra", label: "Infrastructure", reads: ["architecture"] },
  { id: "load", label: "Load test", reads: ["constraints"] },
  { id: "plan", label: "PRD & backlog", reads: ["cva"] },
  { id: "readme", label: "README", reads: [] },
];

type N = DesignNode;
const all = (n: N, out: N[] = []): N[] => { out.push(n); n.children?.forEach((c) => all(c, out)); return out; };
const nodes = (p: DesignDoc, k: DocKind) => all(viewDoc(p, k).root).filter((n) => n.type === "Node");
const edges = (p: DesignDoc, k: DocKind) => all(viewDoc(p, k).root).filter((n) => n.type === "Edge");
const label = (n: N) => String(n.props.label ?? "");
const pascal = (s: string) => s.split("_").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join("") || "Item";
const camel = (s: string) => { const p = pascal(s); return p[0]!.toLowerCase() + p.slice(1); };
/** Row type per table, singular: cases → Case, order_items → OrderItem. */
const typeName = (table: string) => pascal(table.split("_").map((w, i, a) => (i === a.length - 1 ? singular(w) : w)).join("_"));
const singular = (s: string) => (/(us|is|ss)$/.test(s) ? s : s.endsWith("ies") ? `${s.slice(0, -3)}y` : s.endsWith("sses") ? s.slice(0, -2) : s.endsWith("s") && !s.endsWith("ss") ? s.slice(0, -1) : s);
/** A brand name as one word ("SendGrid" → sendgrid, not send_grid — ident() splits camelCase for columns). */
const brand = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^[^a-z]+|_+$/g, "") || null;
const envName = (s: string) => `${(brand(s) ?? "service").toUpperCase()}_API_KEY`;
/** Text for a comment line: no newlines, no comment terminators. */
const cmt = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\*\//g, "* /").slice(0, 200);

// ── The data model every code worker shares ────────────────────────────────────────────────────────────
export interface Column { name: string; type: string; pk: boolean; fk?: { table: string; unique?: boolean } }
export interface Table { name: string; cols: Column[]; pk: Column }
export function dataModel(p: DesignDoc): Table[] {
  const byId = new Map<string, Table>();
  const tables: Table[] = [];
  for (const n of nodes(p, "erd")) {
    const name = ident(label(n));
    if (!name || tables.some((t) => t.name === name)) continue;
    const cols: Column[] = [];
    for (const spec of (n.props.cols as string[] | undefined) ?? []) {
      const [c, t = "text", flag] = spec.split(":");
      const col = ident(c ?? "");
      if (col && !cols.some((x) => x.name === col)) cols.push({ name: col, type: normalizeType(t), pk: flag === "pk" });
    }
    if (!cols.some((c) => c.pk)) {
      const id = cols.find((c) => c.name === "id");
      if (id) id.pk = true; else cols.unshift({ name: "id", type: "uuid", pk: true });
    }
    const t = { name, cols, pk: cols.find((c) => c.pk)! };
    tables.push(t);
    byId.set(n.id, t);
  }
  for (const e of edges(p, "erd")) {
    const a = byId.get(String(e.props.from)), b = byId.get(String(e.props.to));
    if (!a || !b || a === b) continue;
    const card = String(e.props.card ?? "1:n");
    if (card === "n:n") {
      const name = `${a.name}_${b.name}`.slice(0, 63);
      if (tables.some((t) => t.name === name)) continue;
      const ca: Column = { name: `${singular(a.name)}_id`, type: a.pk.type, pk: true, fk: { table: a.name } };
      const cb: Column = { name: `${singular(b.name)}_id`, type: b.pk.type, pk: true, fk: { table: b.name } };
      tables.push({ name, cols: [ca, cb], pk: ca });
      continue;
    }
    const [one, many] = card === "n:1" ? [b, a] : [a, b];
    const fkName = `${singular(one.name)}_id`;
    const existing = many.cols.find((c) => c.name === fkName);
    if (existing) { if (!existing.pk) { existing.fk = { table: one.name, unique: card === "1:1" }; existing.type = one.pk.type; } }
    else many.cols.push({ name: fkName, type: one.pk.type, pk: false, fk: { table: one.name, unique: card === "1:1" } });
  }
  return tables;
}

// ── db ────────────────────────────────────────────────────────────────────────────────────────────────
const PG: Record<string, string> = { uuid: "uuid", text: "text", int: "integer", bigint: "bigint", numeric: "numeric", float: "double precision", bool: "boolean", timestamptz: "timestamptz", date: "date", time: "time", jsonb: "jsonb", bytea: "bytea" };
const qi = (s: string) => `"${s}"`; // identifiers are already [a-z_][a-z0-9_]*; quoting keeps reserved words ("user", "order") legal
function dbWorker(tables: Table[]): CodeFile[] {
  const out: string[] = ["-- Generated by LiveCanvas from the ERD view. Apply to Postgres 16: psql -f db/schema.sql", ""];
  for (const t of tables) {
    const pks = t.cols.filter((c) => c.pk);
    const lines = t.cols.map((c) => {
      const def = c.pk && pks.length === 1 && !c.fk ? (c.type === "uuid" ? " DEFAULT gen_random_uuid()" : c.type === "int" || c.type === "bigint" ? " GENERATED BY DEFAULT AS IDENTITY" : "") : "";
      return `  ${qi(c.name)} ${PG[c.type] ?? "text"}${c.pk ? " NOT NULL" : ""}${def}${c.fk?.unique ? " UNIQUE" : ""}`;
    });
    lines.push(`  PRIMARY KEY (${pks.map((c) => qi(c.name)).join(", ")})`);
    out.push(`CREATE TABLE ${qi(t.name)} (`, lines.join(",\n"), ");", "");
  }
  for (const t of tables) for (const c of t.cols) if (c.fk) {
    out.push(`ALTER TABLE ${qi(t.name)} ADD FOREIGN KEY (${qi(c.name)}) REFERENCES ${qi(c.fk.table)};`);
    if (!c.pk) out.push(`CREATE INDEX ON ${qi(t.name)} (${qi(c.name)});`);
  }
  return [{ path: "db/schema.sql", content: out.join("\n").trimEnd() + "\n", worker: "db" }];
}

// ── contracts ────────────────────────────────────────────────────────────────────────────────────────
const ZOD: Record<string, string> = { uuid: "z.string().uuid()", text: "z.string()", int: "z.number().int()", bigint: "z.number().int()", numeric: "z.number()", float: "z.number()", bool: "z.boolean()", timestamptz: "z.string()", date: "z.string()", time: "z.string()", jsonb: "z.unknown()", bytea: "z.string()" };
function contractsWorker(tables: Table[]): CodeFile[] {
  const out = ['import { z } from "zod";', "", "// Generated by LiveCanvas from the ERD view: one schema per table, and its create-shape without the key.", ""];
  for (const t of tables) {
    const T = typeName(t.name);
    out.push(`export const ${T} = z.object({`, ...t.cols.map((c) => `  ${c.name}: ${ZOD[c.type] ?? "z.string()"}${c.pk || c.fk ? "" : ".optional()"},`), "});");
    out.push(`export type ${T} = z.infer<typeof ${T}>;`);
    out.push(`export const New${T} = ${T}.omit({ ${t.pk.name}: true });`, "");
  }
  return [{ path: "packages/contracts/src/index.ts", content: out.join("\n"), worker: "contracts" }];
}

// ── api ──────────────────────────────────────────────────────────────────────────────────────────────
const CONTRACTS = "../../../../packages/contracts/src/index.js";
function apiWorker(p: DesignDoc, tables: Table[]): CodeFile[] {
  const files: CodeFile[] = [];
  const reg: string[] = [];
  for (const t of tables) {
    const T = typeName(t.name), fn = `${camel(t.name)}Routes`, path = `/${t.name.replace(/_/g, "-")}`, pk = t.pk.name;
    const newId = t.pk.type === "uuid" || t.pk.type === "text" ? "randomUUID()" : "rows.size + 1";
    files.push({ worker: "api", path: `apps/api/src/routes/${t.name}.ts`, content: [
      'import { randomUUID } from "node:crypto";',
      'import type { FastifyInstance } from "fastify";',
      `import { ${T}, New${T} } from "${CONTRACTS}";`,
      "",
      `/** ${cmt(t.name)} — CRUD from the ERD. TODO: replace the in-memory map with Postgres (db/schema.sql). */`,
      `const rows = new Map<string, ${T}>();`,
      "void randomUUID;",
      "",
      `export async function ${fn}(app: FastifyInstance) {`,
      `  app.get("${path}", async () => [...rows.values()]);`,
      `  app.get<{ Params: { id: string } }>("${path}/:id", async (req, reply) => rows.get(req.params.id) ?? reply.code(404).send({ error: "not found" }));`,
      `  app.post("${path}", async (req, reply) => {`,
      `    const row = ${T}.parse({ ...New${T}.parse(req.body), ${pk}: ${newId} });`,
      `    rows.set(String(row.${pk}), row);`,
      "    return reply.code(201).send(row);",
      "  });",
      `  app.patch<{ Params: { id: string } }>("${path}/:id", async (req, reply) => {`,
      "    const current = rows.get(req.params.id);",
      '    if (!current) return reply.code(404).send({ error: "not found" });',
      `    const next = ${T}.parse({ ...current, ...New${T}.partial().parse(req.body) });`,
      "    rows.set(req.params.id, next);",
      "    return next;",
      "  });",
      `  app.delete<{ Params: { id: string } }>("${path}/:id", async (req, reply) => (rows.delete(req.params.id) ? reply.code(204).send() : reply.code(404).send({ error: "not found" })));`,
      "}",
      "",
    ].join("\n") });
    reg.push(`import { ${fn} } from "./routes/${t.name}.js";`);
  }
  // Sequence messages into the API that aren't CRUD on a table → action stubs.
  const seq = viewDoc(p, "sequence").root;
  const byId = new Map(all(seq).map((n) => [n.id, n]));
  const isApi = (n?: N) => !!n && (String(n.props.kind) === "service" || /\bapi\b/i.test(label(n)));
  const actions: Array<{ slug: string; text: string }> = [];
  for (const e of edges(p, "sequence")) {
    if (!isApi(byId.get(String(e.props.to)))) continue;
    const text = String(e.props.label ?? "");
    const slug = ident(text)?.replace(/_/g, "-");
    if (!slug || actions.some((a) => a.slug === slug)) continue;
    if (tables.some((t) => text.toLowerCase().includes(singular(t.name).replace(/_/g, " ")))) continue; // covered by that table's routes
    actions.push({ slug: slug.slice(0, 40), text });
  }
  if (actions.length) {
    files.push({ worker: "api", path: "apps/api/src/routes/actions.ts", content: [
      'import type { FastifyInstance } from "fastify";',
      "",
      "/** Steps from the sequence view that aren't plain reads or writes of a table. */",
      "export async function actionRoutes(app: FastifyInstance) {",
      ...actions.map((a) => `  // ${cmt(a.text)}\n  app.post("/actions/${a.slug}", async (_req, reply) => reply.code(501).send({ error: "not implemented" }));`),
      "}",
      "",
    ].join("\n") });
    reg.push('import { actionRoutes } from "./routes/actions.js";');
  }
  const externals = nodes(p, "architecture").filter((n) => n.props.kind === "external");
  for (const x of externals) {
    const id = brand(label(x));
    if (!id) continue;
    files.push({ worker: "api", path: `apps/api/src/clients/${id}.ts`, content: [
      `/** ${cmt(label(x))} — an external system from the architecture view. */`,
      `const KEY = process.env.${envName(label(x))};`,
      "",
      `export async function ${camel(id)}(payload: Record<string, unknown>): Promise<void> {`,
      `  if (!KEY) throw new Error("${envName(label(x))} is not set");`,
      `  // TODO: call ${cmt(label(x))} with the payload.`,
      "  void payload;",
      "}",
      "",
    ].join("\n") });
  }
  files.push({ worker: "api", path: "apps/api/src/server.ts", content: [
    'import Fastify from "fastify";',
    ...reg,
    "",
    "const app = Fastify({ logger: true });",
    'app.get("/health", async () => ({ ok: true }));',
    ...tables.map((t) => `await app.register(${camel(t.name)}Routes);`),
    ...(actions.length ? ["await app.register(actionRoutes);"] : []),
    "await app.listen({ port: Number(process.env.PORT ?? 8080), host: \"0.0.0.0\" });",
    "",
  ].join("\n") });
  files.push({ worker: "api", path: "apps/api/package.json", content: JSON.stringify({ name: "api", private: true, type: "module", scripts: { dev: "tsx watch src/server.ts", typecheck: "tsc --noEmit" }, dependencies: { fastify: "^5.0.0", zod: "^3.23.0" }, devDependencies: { tsx: "^4.19.0", typescript: "^5.6.0", "@types/node": "^22.0.0" } }, null, 2) + "\n" });
  files.push({ worker: "api", path: "apps/api/tsconfig.json", content: JSON.stringify({ extends: "../../tsconfig.base.json", include: ["src", "../../packages/contracts/src"] }, null, 2) + "\n" });
  const env = ["DATABASE_URL=postgres://app:app@localhost:5432/app", "PORT=8080", ...externals.map((x) => `${envName(label(x))}=`)];
  files.push({ worker: "api", path: ".env.example", content: env.join("\n") + "\n" });
  return files;
}

// ── web ──────────────────────────────────────────────────────────────────────────────────────────────
const C = defaultTokens.color, S = defaultTokens.space, R = defaultTokens.radius;
const str = (v: unknown) => JSON.stringify(String(v ?? ""));
function jsx(n: N, depth: number): string {
  const pad = "  ".repeat(depth);
  const p = n.props as Record<string, unknown>;
  const style = (o: Record<string, unknown>) => ` style={${JSON.stringify(o)}}`;
  const kids = () => (n.children ?? []).map((c) => jsx(c, depth + 1)).join("\n");
  const color = (k: unknown, d: string) => C[k as keyof typeof C] ?? d;
  switch (n.type) {
    case "Frame": return `${pad}<main${style({ display: "flex", flexDirection: p.direction === "row" ? "row" : "column", gap: S[p.gap as keyof typeof S] ?? 16, padding: S[p.padding as keyof typeof S] ?? 24, background: color(p.fill, "#ffffff"), maxWidth: p.width ?? 420, margin: "0 auto", fontFamily: "system-ui, sans-serif" })}>\n${kids()}\n${pad}</main>`;
    case "Stack": return `${pad}<div${style({ display: "flex", flexDirection: p.direction === "row" ? "row" : "column", gap: S[p.gap as keyof typeof S] ?? 8, justifyContent: p.justify === "between" ? "space-between" : p.justify ?? "start" })}>\n${kids()}\n${pad}</div>`;
    case "Card": return `${pad}<section${style({ display: "flex", flexDirection: "column", gap: 8, padding: S[p.padding as keyof typeof S] ?? 16, borderRadius: 12, background: color(p.fill, "#ffffff"), boxShadow: "0 1px 3px rgba(0,0,0,.12)" })}>\n${kids()}\n${pad}</section>`;
    case "Text": {
      const tag = p.variant === "display" ? "h1" : p.variant === "title" ? "h2" : p.variant === "caption" ? "small" : "p";
      return `${pad}<${tag}${style({ margin: 0, color: color(p.color, C.text) })}>{${str(p.content)}}</${tag}>`;
    }
    case "Button": return `${pad}<button type="button"${style({ padding: p.size === "lg" ? "14px 20px" : p.size === "sm" ? "6px 10px" : "10px 16px", borderRadius: R[p.radius as keyof typeof R] ?? 10, border: p.variant === "secondary" ? `1px solid ${color(p.color, C.primary)}` : "none", background: p.variant === "secondary" || p.variant === "ghost" ? "transparent" : color(p.color, C.primary), color: p.variant === "secondary" || p.variant === "ghost" ? color(p.color, C.primary) : "#ffffff", fontWeight: 600, fontSize: p.size === "lg" ? 18 : 15 })}>{${str(p.label)}}</button>`;
    case "Input": return `${pad}<label${style({ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 })}>\n${pad}  <span>{${str(p.label ?? p.placeholder ?? "Field")}}</span>\n${pad}  <input type=${str(p.kind ?? "text")} placeholder=${str(p.placeholder ?? "")}${style({ padding: "10px 12px", borderRadius: 8, border: "1px solid #cbd5e1" })} />\n${pad}</label>`;
    case "Image": return `${pad}<div role="img" aria-label=${str(p.alt)}${style({ aspectRatio: String(p.aspect ?? "16:9").replace(":", " / "), background: C.muted, borderRadius: R[p.radius as keyof typeof R] ?? 10, display: "grid", placeItems: "center", color: "#64748b" })}>{${str(p.alt)}}</div>`;
    case "Icon": return `${pad}<span aria-hidden="true">{${str(p.name)}}</span>`;
    case "List": return `${pad}<ul${style({ margin: 0, paddingLeft: 18 })}>\n${((p.items as Array<{ title: string; subtitle?: string }>) ?? []).map((it) => `${pad}  <li>{${str(it.title)}}${it.subtitle ? ` <small>{${str(it.subtitle)}}</small>` : ""}</li>`).join("\n")}\n${pad}</ul>`;
    case "Nav": return `${pad}<nav${style({ display: "flex", gap: 16 })}>\n${((p.items as string[]) ?? []).map((it) => `${pad}  <a href="#">{${str(it)}}</a>`).join("\n")}\n${pad}</nav>`;
    case "Table": return `${pad}<table>\n${pad}  <thead><tr>${((p.columns as string[]) ?? []).map((c) => `<th>{${str(c)}}</th>`).join("")}</tr></thead>\n${pad}  <tbody>${((p.rows as string[][]) ?? []).map((r) => `<tr>${r.map((c) => `<td>{${str(c)}}</td>`).join("")}</tr>`).join("")}</tbody>\n${pad}</table>`;
    case "Chart": { const s = (p.series as number[]) ?? []; const max = Math.max(1, ...s); return `${pad}<div${style({ display: "flex", alignItems: "end", gap: 4, height: 120 })}>\n${s.map((v) => `${pad}  <div${style({ flex: 1, height: `${Math.round((v / max) * 100)}%`, background: C.primary })} />`).join("\n")}\n${pad}</div>`; }
    default: return `${pad}{/* ${cmt(n.type)} */}`;
  }
}
function webWorker(p: DesignDoc): CodeFile[] {
  const root = viewDoc(p, "screen").root;
  const body = root.children?.length ? jsx(root, 2) : `    <main><p>{"Describe a screen in LiveCanvas and rebuild."}</p></main>`;
  return [
    { worker: "web", path: "apps/web/app/page.tsx", content: `// Generated by LiveCanvas from the Screen view (the 12 primitives, default theme tokens).\nexport default function Page() {\n  return (\n${body}\n  );\n}\n` },
    { worker: "web", path: "apps/web/app/layout.tsx", content: 'import type { ReactNode } from "react";\n\nexport default function RootLayout({ children }: { children: ReactNode }) {\n  return (\n    <html lang="en">\n      <body style={{ margin: 0 }}>{children}</body>\n    </html>\n  );\n}\n' },
    { worker: "web", path: "apps/web/package.json", content: JSON.stringify({ name: "web", private: true, scripts: { dev: "next dev", build: "next build" }, dependencies: { next: "^15.0.0", react: "^19.0.0", "react-dom": "^19.0.0" }, devDependencies: { typescript: "^5.6.0", "@types/react": "^19.0.0" } }, null, 2) + "\n" },
  ];
}

// ── infra ────────────────────────────────────────────────────────────────────────────────────────────
function infraWorker(p: DesignDoc, tables: Table[]): CodeFile[] {
  const arch = nodes(p, "architecture");
  const hasDb = tables.length > 0 || arch.some((n) => n.props.kind === "db");
  const hasCache = arch.some((n) => n.props.kind === "cache");
  const svc: string[] = ["services:"];
  if (hasDb) svc.push("  postgres:", "    image: postgres:16", "    environment:", "      POSTGRES_USER: app", "      POSTGRES_PASSWORD: app", "      POSTGRES_DB: app", "    ports: [\"5432:5432\"]", "    volumes:", "      - ./db/schema.sql:/docker-entrypoint-initdb.d/001-schema.sql:ro");
  if (hasCache) svc.push("  redis:", "    image: redis:7", "    ports: [\"6379:6379\"]");
  svc.push("  api:", "    image: node:22", "    working_dir: /app/apps/api", "    command: sh -c \"npm install && npm run dev\"", "    volumes: [\".:/app\"]", "    env_file: .env", "    ports: [\"8080:8080\"]");
  if (hasDb) svc.push("    depends_on: [postgres]");
  svc.push("  web:", "    image: node:22", "    working_dir: /app/apps/web", "    command: sh -c \"npm install && npm run dev\"", "    volumes: [\".:/app\"]", "    ports: [\"3000:3000\"]");
  return [{ worker: "infra", path: "docker-compose.yml", content: `# Generated by LiveCanvas from the Architecture view.\n${svc.join("\n")}\n` }];
}

// ── load ─────────────────────────────────────────────────────────────────────────────────────────────
function loadWorker(p: DesignDoc): CodeFile[] {
  const con = nodes(p, "constraints");
  const peak = Math.max(0, ...con.map((n) => Number(n.props.demand ?? 0)));
  const rate = Math.max(1, Math.ceil(peak));
  const rows = con.filter((n) => n.props.demand != null || n.props.capacity != null || n.props.latency != null).map((n) => {
    const u = utilization(n);
    return `| ${cmt(label(n))} | ${n.props.demand ?? "—"} | ${n.props.capacity ?? "—"} | ${n.props.latency ?? "—"} | ${u == null ? "—" : `${Math.round(u * 100)}%${u >= 0.8 ? " ⚠ bottleneck" : ""}`} |`;
  });
  return [
    { worker: "load", path: "load/k6.js", content: `// Generated by LiveCanvas from the Constraints view: peak ${peak}/s → ${rate} req/s for one minute.\nimport http from "k6/http";\n\nexport const options = {\n  scenarios: { peak: { executor: "constant-arrival-rate", rate: ${rate}, timeUnit: "1s", duration: "1m", preAllocatedVUs: ${Math.min(200, rate * 2)} } },\n  thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<500"] },\n};\n\nconst BASE = __ENV.BASE_URL || "http://localhost:8080";\nexport default function () {\n  http.get(\`\${BASE}/health\`);\n}\n` },
    { worker: "load", path: "docs/capacity.md", content: `# Capacity\n\nFrom the Constraints view (req/s unless noted). Utilisation = demand ÷ capacity; ≥ 80% is a bottleneck.\n\n| Component | Demand | Capacity | p50 ms | Utilisation |\n|---|---|---|---|---|\n${rows.join("\n") || "| _nothing measured yet_ | | | | |"}\n` },
  ];
}

// ── plan ─────────────────────────────────────────────────────────────────────────────────────────────
function planWorker(p: DesignDoc): CodeFile[] {
  const items = nodes(p, "cva");
  const scored = items.filter((n) => typeof n.props.cost === "number" && typeof n.props.value === "number");
  const quad = (n: N) => { const c = Number(n.props.cost), v = Number(n.props.value); return v >= 3 ? (c <= 2 ? 0 : 1) : (c <= 2 ? 2 : 3); };
  const names = ["Now — quick wins", "Next — big bets", "Later — fill-ins", "Don't — money pits"];
  const out = ["# Backlog", "", "Ordered from the Cost-Value view: value first, then cost.", ""];
  names.forEach((title, q) => {
    const inQ = scored.filter((n) => quad(n) === q).sort((a, b) => Number(b.props.value) - Number(a.props.value) || Number(a.props.cost) - Number(b.props.cost));
    if (inQ.length) out.push(`## ${title}`, ...inQ.map((n) => `- [ ] ${cmt(label(n))} (cost ${n.props.cost}, value ${n.props.value})`), "");
  });
  const unscored = items.filter((n) => !scored.includes(n));
  if (unscored.length) out.push("## To score", ...unscored.map((n) => `- [ ] ${cmt(label(n))}`), "");
  return [
    { worker: "plan", path: "PRD.md", content: compilePrd(p) },
    { worker: "plan", path: "BACKLOG.md", content: out.join("\n") },
  ];
}

// ── readme + root ────────────────────────────────────────────────────────────────────────────────────
function readmeWorker(p: DesignDoc, files: CodeFile[]): CodeFile[] {
  const title = String(p.root.props.title ?? "").trim() || "Untitled product";
  const inferred = (["architecture", "erd", "sequence", "constraints", "cva"] as DocKind[]).flatMap((k) => nodes(p, k).filter((n) => n.inferred).map((n) => `${label(n)} (${k})`));
  return [
    { worker: "readme", path: "README.md", content: [
      `# ${cmt(title)}`, "",
      "Generated by LiveCanvas from six views: Screen, Architecture, ERD, Sequence, Constraints and Cost-Value. See PRD.md.", "",
      "## Run it", "", "```sh", "cp .env.example .env", "docker compose up", "```", "",
      "- Web: http://localhost:3000 (`apps/web`) · API: http://localhost:8080 (`apps/api`) · Postgres from `db/schema.sql`",
      "- Load test: `k6 run load/k6.js` (rate from the Constraints view)", "",
      "## What's here", "", ...files.map((f) => `- \`${f.path}\``), "",
      ...(inferred.length ? ["## Inferred, not said", "", "LiveCanvas filled these in; confirm or change them:", "", ...inferred.map((x) => `- ${cmt(x)}`), ""] : []),
    ].join("\n") },
    { worker: "readme", path: "package.json", content: JSON.stringify({ name: ident(title)?.replace(/_/g, "-") ?? "app", private: true, workspaces: ["apps/*", "packages/*"] }, null, 2) + "\n" },
    { worker: "readme", path: "tsconfig.base.json", content: JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, jsx: "react-jsx", noEmit: true } }, null, 2) + "\n" },
  ];
}

/** Run every worker (pure; ~ms). `only` limits the run to some workers. */
export function generateProject(p: DesignDoc, only?: Worker[]): CodeFile[] {
  const run = (w: Worker) => !only || only.includes(w);
  const tables = dataModel(p);
  const files: CodeFile[] = [
    ...(run("db") ? dbWorker(tables) : []),
    ...(run("contracts") ? contractsWorker(tables) : []),
    ...(run("api") ? apiWorker(p, tables) : []),
    ...(run("web") ? webWorker(p) : []),
    ...(run("infra") ? infraWorker(p, tables) : []),
    ...(run("load") ? loadWorker(p) : []),
    ...(run("plan") ? planWorker(p) : []),
  ];
  return run("readme") ? [...files, ...readmeWorker(p, files)] : files;
}
