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
  diagram_metrics: { default: false, description: "Teaser: duration / throughput annotations on edges (not built yet)" },
} as const;

export const FeatureKey = z.enum(Object.keys(FEATURES) as [keyof typeof FEATURES, ...Array<keyof typeof FEATURES>]);
export type FeatureKey = z.infer<typeof FeatureKey>;
export const Flags = z.record(FeatureKey, z.boolean());
export type Flags = Record<FeatureKey, boolean>;

export const defaultFlags = (): Flags =>
  Object.fromEntries(Object.entries(FEATURES).map(([k, v]) => [k, v.default])) as Flags;

/** The flag that gates a doc kind (screens ride on the core loop). */
export const kindFeature = (kind: DocKind): FeatureKey => (kind === "screen" ? "speak_to_create" : `diagram_${kind}`);
