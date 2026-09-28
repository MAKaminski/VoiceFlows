import { z } from "zod";
import type { DocKind } from "./doc.js";

/**
 * Feature registry (ADR 0012): every user-facing feature sits behind a flag so usage is measured and
 * an admin can switch it off. Seeded into `feature_flags` by migrate (never overwriting `enabled`).
 */
export const FEATURES = {
  projects: { default: true, description: "Projects: Screen, Architecture, ERD and Sequence together — speak to any view" },
  project_notes: { default: true, description: "Project notes: a running summary of what you've said, kept as context for every view" },
  jev_decisions: { default: true, description: "Jev decisions: connections, direction and 'on top' moves decided in ~90 ms before (or instead of) the model" },
  open_vocabulary: { default: true, description: "Speak freely: at the end of a sentence, any word nothing handled yet goes to the model once (ADR 0019)" },
  speak_to_create: { default: true, description: "Speak or type to create and edit — the core loop" },
  diagram_architecture: { default: true, description: "Architecture diagrams (Frontend · APIs · Database · Infrastructure)" },
  diagram_erd: { default: true, description: "Entity-relationship diagrams" },
  diagram_sequence: { default: true, description: "Sequence diagrams" },
  vocabulary_rail: { default: true, description: "Keyword rail: the words each diagram kind draws instantly, with tooltips" },
  custom_vocabulary: { default: true, description: "Users define and confirm their own words" },
  transcript_highlight: { default: true, description: "Highlight words in the live transcript: drawn instantly, sent to the model, or your own" },
  remember_document: { default: true, description: "Remember the document: a new tab reopens this browser's last document" },
  version_timeline: { default: true, description: "Version timeline: see every version of the document and jump to any of them" },
  share_links: { default: true, description: "Share links: a public read-only link to the version on screen" },
  diagram_constraints: { default: true, description: "Constraints view: rates, capacity, latency and bottlenecks per component (ADR 0021)" },
  diagram_cva: { default: true, description: "Cost-value view: features on a cost × value matrix — quick wins, big bets, fill-ins, money pits (ADR 0021)" },
  cross_view_scaffold: { default: true, description: "Scaffolding: what you say in one view fills in the others, marked inferred, one undo (ADR 0021)" },
  prd_view: { default: true, description: "PRD: a product requirements doc compiled live from all six views (ADR 0021)" },
  project_intake: { default: true, description: "Quick start: three optional questions that seed a new project (ADR 0021)" },
  voice_demo: { default: true, description: "Voice demo: a narrated, live build of a product on the home page (ADR 0021)" },
  invite_gate: { default: true, description: "Invite gate: the product needs an invite code (enforced once ACCESS_SECRET is set, ADR 0021)" },
  all_views: { default: true, description: "All views at once: Screen, Architecture, ERD and Sequence side by side, updating live (ADR 0020)" },
  suggestions: { default: true, description: "Implied suggestions: typical columns and pieces pre-recommended instantly; approve by voice or click (ADR 0020)" },
  suggestions_model: { default: false, description: "Model suggestions: a background model pass proposes more after each sentence (+~$0.008/min, ADR 0020)" },
  project_library: { default: true, description: "Projects: save a project and open saved ones from a shared workspace list (ADR 0020)" },
} as const;

export const FeatureKey = z.enum(Object.keys(FEATURES) as [keyof typeof FEATURES, ...Array<keyof typeof FEATURES>]);
export type FeatureKey = z.infer<typeof FeatureKey>;
/**
 * Tolerant on purpose (plan-critic M8 #8): a strict record rejects both missing and unknown keys, so a web build
 * one flag behind (or ahead of) the gateway dropped the welcome and hung. Unknown keys are ignored, missing
 * ones take their default.
 */
export const Flags = z.record(z.string(), z.boolean()).transform((r): Record<FeatureKey, boolean> =>
  Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, typeof r[k] === "boolean" ? r[k] : v.default])) as Record<FeatureKey, boolean>);
export type Flags = Record<FeatureKey, boolean>;

export const defaultFlags = (): Flags =>
  Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, v.default])) as Flags;

/** The flag that gates a doc kind (screens ride on the core loop). */
export const kindFeature = (kind: DocKind): FeatureKey => (kind === "screen" ? "speak_to_create" : `diagram_${kind}`);
