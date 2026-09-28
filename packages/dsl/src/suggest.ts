import type { DesignDoc, DesignNode, DocKind } from "./doc.js";
import { docKind } from "./doc.js";
import { lexTokens } from "./lexicon.js";
import type { Suggestion } from "./ws.js";

/**
 * Implied suggestions, tier 1 (ADR 0020): what usually belongs with what was said, from rules — no model call,
 * so a `cases` table arrives already offering subject / status / priority. Pure: the gateway filters out what
 * was approved or rejected before and holds the rest as session state (never in the doc until approved).
 */

const MAX_COLS = 6;

/** Typical columns per table (names only; types from `colType`). Keyed by the table's plural label. */
const TYPICAL_COLS: Record<string, string[]> = {
  users: ["email", "name", "created_at"], accounts: ["name", "plan", "status", "created_at"],
  orders: ["status", "total", "placed_at"], products: ["name", "price", "sku", "description"],
  payments: ["amount", "status", "method", "paid_at"], customers: ["name", "email", "phone", "created_at"],
  sessions: ["token", "expires_at", "created_at"], posts: ["title", "body", "published_at"],
  comments: ["body", "author", "created_at"], teams: ["name", "created_at"], organizations: ["name", "domain", "created_at"],
  invoices: ["number", "amount", "status", "due_date", "issued_at"], items: ["name", "quantity", "price"],
  subscriptions: ["plan", "status", "renews_at", "canceled_at"], messages: ["body", "sent_at", "read_at"],
  projects: ["name", "status", "created_at"], tasks: ["title", "status", "priority", "due_date"],
  documents: ["title", "body", "updated_at"], events: ["name", "starts_at", "ends_at", "location"],
  roles: ["name", "description"], permissions: ["name", "description"], tags: ["name"], categories: ["name", "slug"],
  carts: ["status", "updated_at"], reviews: ["rating", "body", "created_at"],
  addresses: ["line1", "city", "postal_code", "country"], transactions: ["amount", "type", "status", "occurred_at"],
  companies: ["name", "domain", "industry"], employees: ["name", "email", "title", "hired_at"],
  tickets: ["subject", "status", "priority", "created_at"], plans: ["name", "price", "interval"],
  workspaces: ["name", "created_at"], members: ["role", "joined_at"], files: ["name", "size", "mime_type", "url"],
  notifications: ["type", "body", "read_at"], bookings: ["starts_at", "ends_at", "status"],
  listings: ["title", "price", "status"], vendors: ["name", "email", "phone"], shipments: ["carrier", "tracking_number", "status", "shipped_at"],
  courses: ["title", "description", "starts_at"],
  // CRM / contact center — the user's domain (M7).
  contacts: ["name", "email", "phone"], leads: ["name", "email", "source", "status"],
  opportunities: ["name", "amount", "stage", "close_date"], cases: ["subject", "status", "priority", "created_at"],
  agents: ["name", "email", "status"], calls: ["direction", "duration", "started_at", "ended_at"],
  interactions: ["channel", "started_at", "ended_at"], queues: ["name", "priority"], skills: ["name", "level"],
  recordings: ["url", "duration", "created_at"], transcripts: ["body", "language", "created_at"],
  surveys: ["score", "comment", "submitted_at"], campaigns: ["name", "status", "starts_at", "ends_at"],
  conversations: ["channel", "status", "started_at"], channels: ["name", "type"], departments: ["name"],
  locations: ["name", "address", "timezone"], stores: ["name", "address"], suppliers: ["name", "email", "phone"],
  inventories: ["quantity", "updated_at"], warehouses: ["name", "address"], carriers: ["name", "code"],
  refunds: ["amount", "reason", "refunded_at"], coupons: ["code", "discount", "expires_at"],
  appointments: ["starts_at", "ends_at", "status"], patients: ["name", "date_of_birth", "phone"],
  doctors: ["name", "specialty"], providers: ["name", "type"], prescriptions: ["drug", "dosage", "issued_at"],
  students: ["name", "email", "enrolled_at"], teachers: ["name", "email", "subject"], enrollments: ["status", "enrolled_at"],
  grades: ["score", "letter", "graded_at"], assignments: ["title", "due_date", "points"], lessons: ["title", "starts_at"],
  schedules: ["starts_at", "ends_at"], shifts: ["starts_at", "ends_at"], devices: ["name", "type", "last_seen_at"],
  assets: ["name", "type", "value"], contracts: ["title", "status", "starts_at", "ends_at"], quotes: ["number", "amount", "status"],
  deals: ["name", "amount", "stage"], notes: ["body", "created_at"],
};

/** A column's type from its name — the same few types the ERD prompt uses. */
export function colType(name: string): string {
  if (/_at$/.test(name)) return "timestamptz";
  if (/(^|_)date$|date_of_birth|due_date|close_date/.test(name)) return "date";
  if (/^(total|amount|price|value|discount|score)$/.test(name)) return "numeric";
  if (/^(quantity|count|duration|size|points|rating|level|priority_rank)$/.test(name)) return "int";
  if (/^(is_|has_)|^active$/.test(name)) return "bool";
  return "text";
}

const singular = (w: string) => w.replace(/ies$/, "y").replace(/(ss|sh|ch|x)es$/, "$1").replace(/s$/, "");
const plural = (w: string) => (w.endsWith("y") && !/[aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : /(s|sh|ch|x)$/.test(w) ? `${w}es` : `${w}s`);
/** "support_cases" / "Case" → "cases": the last word of the label, pluralised. */
const tableKey = (label: string) => { const last = lexTokens(label.replace(/_/g, " ")).at(-1) ?? ""; return plural(singular(last)); };

function walk(n: DesignNode, out: DesignNode[] = []): DesignNode[] { out.push(n); n.children?.forEach((c) => walk(c, out)); return out; }
const text = (n: DesignNode) => { const p = n.props as Record<string, unknown>; return String(p.label ?? p.content ?? p.alt ?? p.name ?? "").toLowerCase(); };

/** Candidate suggestions for a whole view (the gateway drops resolved ones). */
export function ruleSuggestions(view: DesignDoc, kind: DocKind = docKind(view)): Suggestion[] {
  const nodes = walk(view.root);
  const out: Suggestion[] = [];
  if (kind === "erd") {
    for (const n of nodes) {
      if (n.type !== "Node") continue;
      const typical = TYPICAL_COLS[tableKey(String(n.props.label ?? ""))];
      if (!typical) continue;
      const have = new Set(((n.props.cols as string[] | undefined) ?? []).map((c) => c.split(":")[0]!));
      const cols = typical.filter((c) => !have.has(c)).slice(0, MAX_COLS).map((c) => `${c}:${colType(c)}`);
      if (cols.length) out.push({ id: `cols:${n.id}`, view: "erd", source: "rule", target: n.id, cols, title: `${n.props.label}: ${cols.map((c) => c.split(":")[0]).join(", ")}` });
    }
  } else if (kind === "screen") {
    const kids = view.root.children ?? [];
    const title = kids.find((c) => c.type === "Text" && (c.props.variant === "title" || c.props.variant === "display"));
    const t = title ? text(title) : "";
    const has = (re: RegExp) => nodes.some((n) => re.test(text(n)));
    const hasInput = (k: string) => nodes.some((n) => n.type === "Input" && n.props.kind === k);
    if (/log in|sign in/.test(t) && hasInput("password") && !has(/forgot/))
      out.push({ id: "screen:forgot", view: "screen", source: "rule", title: "“Forgot password?” link", lines: ['+Text forgot >root v=caption "Forgot password?"'] });
    if (/sign up|create account/.test(t) && !has(/terms/))
      out.push({ id: "screen:terms", view: "screen", source: "rule", title: "Terms agreement line", lines: ['+Text terms >root v=caption "I agree to the Terms and Privacy Policy"'] });
    if (/checkout|cart/.test(t) && !has(/total/))
      out.push({ id: "screen:total", view: "screen", source: "rule", title: "Order total", lines: ['+Card summary >root', '+Text summarytotal >summary "Order total"'] });
    const list = kids.findIndex((c) => c.type === "List");
    if (list >= 0 && !has(/search/))
      out.push({ id: "screen:search", view: "screen", source: "rule", title: "Search field above the list", lines: [`+Input search >root k=text "Search" @${list}`] });
  } else if (kind === "architecture") {
    const nodeKinds = new Set(nodes.filter((n) => n.type === "Node").map((n) => String(n.props.kind)));
    const apiLane = nodes.find((n) => n.type === "Layer" && n.props.tier === "api");
    const api = nodes.find((n) => n.type === "Node" && n.props.kind === "service");
    if (apiLane && api && nodeKinds.has("client") && !nodeKinds.has("auth"))
      out.push({ id: "arch:auth", view: "architecture", source: "rule", title: `Auth service for ${api.props.label}`, lines: [`+Node auth >${apiLane.id} k=auth "Auth"`, `+Edge sauth >root from=${api.id} to=auth "verifies tokens"`] });
  }
  return out;
}

// ── Voice commands (ADR 0020) ─────────────────────────────────────────────────────────────────────

/** "approve …" / "reject …" at the start of an utterance — never drawn, never sent to the model. */
export const isSuggestionCommand = (t: string) => /^(?:so\s+|ok\s+|okay\s+|yes\s+|yeah\s+)?(?:approve|accept|reject|decline|dismiss|skip)\b/i.test(t.trim());
/** "save the project" / "save it as Contact center" — start-anchored so "save button" still draws a button. */
export const isSaveCommand = (t: string) => /^(?:so\s+|ok\s+|okay\s+)?save\s+(?:it|this|the\s+project|project|my\s+work|everything)\b/i.test(t.trim());
export function parseSave(t: string): { title?: string } {
  const m = /\b(?:as|called|named)\s+(.{1,80}?)[.!]?\s*$/i.exec(t.trim());
  return m ? { title: m[1]!.replace(/\b[a-z]/g, (c) => c.toUpperCase()) } : {};
}

const FILLER = new Set(["the", "a", "an", "all", "them", "it", "everything", "suggestion", "suggestions", "one", "ones", "please",
  "those", "these", "that", "this", "and", "of", "for", "to", "on", "in", "column", "columns", "field", "fields", "table", "stuff", "yes", "ok", "okay", "so"]);
const EXCEPT = new Set(["but", "except", "besides", "without"]);

export interface Resolution { verb: "approve" | "reject"; picks: Array<{ id: string; cols?: string[] }>; unresolved: boolean }

/**
 * Deterministic scope for a spoken command (plan-critic M8: $0, ~0 ms): "approve" = everything pending;
 * "approve the case columns" = the cases table's columns; "approve all but status" = everything except the
 * status column; "reject the auth one" = the auth suggestion. `unresolved` = words that matched nothing — the
 * caller asks Jev instead of guessing.
 */
export function resolveCommand(text: string, items: Suggestion[]): Resolution {
  const words = lexTokens(text);
  const vi = words.findIndex((w) => /^(approve|accept|reject|decline|dismiss|skip)$/.test(w));
  const verb: Resolution["verb"] = /^(approve|accept)$/.test(words[vi] ?? "") ? "approve" : "reject";
  const rest = words.slice(vi + 1);
  const ex = rest.findIndex((w) => EXCEPT.has(w) || (w === "other" && rest[rest.indexOf(w) + 1] === "than"));
  const want = (ex >= 0 ? rest.slice(0, ex) : rest).filter((w) => !FILLER.has(w)).map(singular);
  const skip = (ex >= 0 ? rest.slice(ex + 1) : []).filter((w) => !FILLER.has(w) && w !== "than").map(singular);
  const colMatch = (col: string, ws: string[]) => ws.length > 0 && ws.some((w) => col.split(":")[0]!.split("_").map(singular).includes(w));
  const itemWords = (s: Suggestion) => lexTokens(`${s.title.split(":")[0]} ${s.id}`).map(singular);
  const picks: Resolution["picks"] = [];
  let matched = want.length === 0;
  for (const s of items) {
    let cols = s.cols;
    let take = want.length === 0 || want.some((w) => itemWords(s).includes(w));
    if (!take && s.cols && want.length) { // "approve status" — just those columns of the table
      const some = s.cols.filter((c) => colMatch(c, want));
      if (some.length) { take = true; cols = some; }
    }
    if (!take) continue;
    matched = true;
    if (skip.length) {
      if (skip.some((w) => itemWords(s).includes(w))) continue;
      if (cols) cols = cols.filter((c) => !colMatch(c, skip));
      if (cols && !cols.length) continue;
    }
    picks.push({ id: s.id, ...(cols && cols !== s.cols ? { cols } : {}) });
  }
  return { verb, picks, unresolved: !matched };
}
