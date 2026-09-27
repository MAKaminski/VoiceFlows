import type { DesignDoc } from "./doc.js";

/** M1 playground doc: every one of the 12 primitives, default tokens. */
export const kitchenSinkDoc: DesignDoc = {
  id: "playground",
  tokens: "default",
  root: {
    id: "n_root", type: "Frame",
    props: { width: 390, height: 1400, direction: "column", gap: "md", padding: "lg", fill: "surface" },
    children: [
      { id: "n_nav", type: "Nav", props: { items: ["Home", "Designs", "Settings"], position: "top" } },
      { id: "n_logo", type: "Image", props: { alt: "Logo", aspect: "3:1", radius: "md" } },
      { id: "n_title", type: "Text", props: { content: "Welcome back", variant: "display" } },
      { id: "n_sub", type: "Text", props: { content: "Sign in to continue", variant: "body", color: "text" } },
      {
        id: "n_form", type: "Card", props: { padding: "lg", elevation: 1 },
        children: [
          {
            id: "n_fields", type: "Stack", props: { direction: "column", gap: "sm" },
            children: [
              { id: "n_email", type: "Input", props: { label: "Email", placeholder: "you@example.com", kind: "email" } },
              { id: "n_pw", type: "Input", props: { label: "Password", placeholder: "••••••••", kind: "password" } },
              { id: "n_signin", type: "Button", props: { label: "Sign in", variant: "primary", size: "lg" } },
              {
                id: "n_row", type: "Stack", props: { direction: "row", gap: "sm", justify: "between", align: "center" },
                children: [
                  { id: "n_ghost", type: "Button", props: { label: "Forgot password?", variant: "ghost", size: "sm" } },
                  { id: "n_icon", type: "Icon", props: { name: "shield-check", size: "md", color: "primary" } },
                ],
              },
            ],
          },
        ],
      },
      { id: "n_list", type: "List", props: { items: [{ title: "Q3 dashboard", subtitle: "Edited 2h ago" }, { title: "Onboarding flow", subtitle: "Edited yesterday" }] } },
      { id: "n_table", type: "Table", props: { columns: ["Screen", "Nodes", "Version"], rows: [["Login", "9", "4"], ["Home", "23", "11"]] } },
      { id: "n_chart", type: "Chart", props: { kind: "bar", series: [4, 7, 3, 9, 6] } },
    ],
  },
};

// ── Diagram fixtures (ADR 0011): LiveCanvas describing itself. Used by tests, /playground and golden images.
const N = (id: string, label: string, kind: string, extra: Record<string, unknown> = {}): DesignDoc["root"] =>
  ({ id, type: "Node", props: { label, kind, ...extra } });
const E = (id: string, from: string, to: string, label?: string, extra: Record<string, unknown> = {}): DesignDoc["root"] =>
  ({ id, type: "Edge", props: { from, to, ...(label ? { label } : {}), ...extra } });

export const architectureDoc: DesignDoc = {
  id: "fixture-architecture", tokens: "default",
  root: {
    id: "n_root", type: "Diagram", props: { kind: "architecture", title: "LiveCanvas" },
    children: [
      { id: "n_frontend", type: "Layer", props: { tier: "frontend", label: "Frontend" }, children: [
        N("n_studio", "Studio", "client", { tech: "Next.js 15" }), N("n_mic", "Mic worklet", "client", { tech: "AudioWorklet" }) ] },
      { id: "n_api", type: "Layer", props: { tier: "api", label: "APIs" }, children: [
        N("n_gateway", "Gateway", "service", { tech: "Fastify + ws" }), N("n_flux", "Deepgram Flux", "external"), N("n_haiku", "Claude Haiku", "external") ] },
      { id: "n_data", type: "Layer", props: { tier: "data", label: "Database" }, children: [
        N("n_pg", "Postgres", "db", { tech: "Postgres 16" }), N("n_redis", "Redis", "cache", { tech: "Redis 7" }) ] },
      { id: "n_infra", type: "Layer", props: { tier: "infra", label: "Infrastructure" }, children: [
        N("n_vercel", "Vercel", "cdn"), N("n_railway", "Railway", "service") ] },
      E("n_e1", "n_mic", "n_gateway", "PCM frames"), E("n_e2", "n_studio", "n_gateway", "WebSocket"),
      E("n_e3", "n_gateway", "n_flux", "stream", { style: "async" }), E("n_e4", "n_gateway", "n_haiku", "SSE"),
      E("n_e5", "n_gateway", "n_pg", "versions", { style: "async" }), E("n_e6", "n_gateway", "n_redis"),
    ],
  },
};

export const erdDoc: DesignDoc = {
  id: "fixture-erd", tokens: "default",
  root: {
    id: "n_root", type: "Diagram", props: { kind: "erd", title: "Sessions and versions" },
    children: [
      N("n_users", "users", "entity", { cols: ["id:uuid:pk", "email:text", "created_at:timestamptz"] }),
      N("n_documents", "documents", "entity", { cols: ["id:uuid:pk", "user_id:uuid:fk", "current_version:int"] }),
      N("n_versions", "design_versions", "entity", { cols: ["id:uuid:pk", "document_id:uuid:fk", "version:int", "doc:jsonb"] }),
      N("n_sessions", "sessions", "entity", { cols: ["id:uuid:pk", "user_id:uuid:fk", "document_id:uuid:fk"] }),
      E("n_r1", "n_users", "n_documents", "owns", { card: "1:n" }),
      E("n_r2", "n_documents", "n_versions", "has", { card: "1:n" }),
      E("n_r3", "n_users", "n_sessions", "opens", { card: "1:n" }),
    ],
  },
};

export const sequenceDoc: DesignDoc = {
  id: "fixture-sequence", tokens: "default",
  root: {
    id: "n_root", type: "Diagram", props: { kind: "sequence", title: "One spoken word" },
    children: [
      N("n_user", "User", "user"), N("n_web", "Studio", "client"), N("n_gw", "Gateway", "service"),
      N("n_stt", "Deepgram", "external"), N("n_llm", "Haiku", "external"),
      E("n_m1", "n_user", "n_web", "speaks"), E("n_m2", "n_web", "n_gw", "PCM frames", { style: "async" }),
      E("n_m3", "n_gw", "n_stt", "audio", { style: "async" }), E("n_m4", "n_stt", "n_gw", "partial", { style: "return" }),
      E("n_m5", "n_gw", "n_gw", "lexicon draws"), E("n_m6", "n_gw", "n_web", "ops (TTFV-0)", { style: "return" }),
      E("n_m7", "n_gw", "n_llm", "fused call"), E("n_m8", "n_llm", "n_gw", "compact ops", { style: "return" }),
      E("n_m9", "n_gw", "n_web", "ops (TTFV-1)", { style: "return" }),
    ],
  },
};
