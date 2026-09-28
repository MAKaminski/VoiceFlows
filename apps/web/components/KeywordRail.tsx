"use client";
import { diagramVocabulary, parseDefine, type DiagramKind, type VocabTerm } from "@livecanvas/dsl";
import { gateway } from "@/lib/gateway";
import { useFeatures } from "@/store/features";
import { useState, type CSSProperties, type FormEvent } from "react";

/**
 * Keyword rail (ADR 0012): the words this diagram kind draws instantly, each with a tooltip saying
 * exactly what it draws — the rule itself, not a hint. User words sit first; a spoken proposal waits
 * here for ✓. "+ Add word" defines one by typing (one phrase, one "draws as" choice).
 */
const LANE: Record<string, string> = { frontend: "Frontend lane", api: "APIs lane", data: "Database lane", infra: "Infrastructure lane" };
const TARGETS: Record<DiagramKind, string[]> = {
  architecture: ["service", "database", "cache", "queue", "storage", "external", "auth", "worker", "client", "cdn", "hosting"],
  erd: ["table"],
  sequence: ["user", "client", "service", "database", "queue", "external"],
  constraints: ["service", "database", "cache", "queue", "external", "worker"],
  cva: ["feature"],
};

const chip = (bg: string, fg: string, extra: CSSProperties = {}): CSSProperties => ({
  padding: "2px 8px", borderRadius: 999, background: bg, color: fg, display: "inline-flex", alignItems: "center", gap: 4, flex: "none", cursor: "default", ...extra,
});
const btn: CSSProperties = { font: "inherit", fontSize: 12, border: "none", background: "transparent", cursor: "pointer", padding: 0, color: "inherit" };

const draws = (t: { label: string; kind: string; tier?: string }) => `draws “${t.label}” · ${t.tier ? LANE[t.tier] : t.kind}`;

export function KeywordRail({ kind }: { kind: DiagramKind }) {
  const { flags, terms } = useFeatures();
  const [adding, setAdding] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [target, setTarget] = useState(TARGETS[kind][0]!);
  if (!flags.vocabulary_rail) return null;
  const vocab = diagramVocabulary(kind);
  const mine = terms.filter((t) => t.kind === kind);
  const canEdit = flags.custom_vocabulary;

  const add = (e: FormEvent) => {
    e.preventDefault();
    const d = parseDefine(`define ${phrase} as ${target}`, kind); // same rule as the spoken form
    if (!d) return;
    gateway.send({ type: "vocab_define", kind, phrase: d.phrase, node: d.node, confirm: true });
    setPhrase(""); setAdding(false);
  };

  return (
    <div data-testid="vocab" style={{ padding: "0 24px", minHeight: 34, display: "flex", alignItems: "center", gap: 6, fontSize: 12, whiteSpace: "nowrap", overflowX: "auto", borderBottom: "1px solid var(--lc-chrome-border)" }}>
      <span title="Say words from this rail: they draw instantly, with no model call" style={{ opacity: 0.6, marginRight: 4 }}>Try “{vocab.example}”</span>
      {mine.map((t: VocabTerm) => t.status === "proposed" ? (
        <span key={t.id} data-testid="vocab-proposed" title={`${draws(t.node)} — confirm to lock it in`} style={chip("#fef3c7", "#92400e", { fontWeight: 600, outline: "1px dashed #d97706" })}>
          {t.phrase} → {t.node.label}?
          {canEdit && <button type="button" style={btn} aria-label={`Confirm ${t.phrase}`} onClick={() => gateway.send({ type: "vocab_confirm", id: t.id })}>✓</button>}
          {canEdit && <button type="button" style={btn} aria-label={`Discard ${t.phrase}`} onClick={() => gateway.send({ type: "vocab_delete", id: t.id })}>✕</button>}
        </span>
      ) : (
        <span key={t.id} data-testid="vocab-mine" title={`Your word · ${draws(t.node)}`} style={chip("#dcfce7", "#166534", { fontWeight: 600 })}>
          {t.phrase}
          {canEdit && <button type="button" style={{ ...btn, opacity: 0.6 }} aria-label={`Remove ${t.phrase}`} onClick={() => gateway.send({ type: "vocab_delete", id: t.id })}>✕</button>}
        </span>
      ))}
      {canEdit && (adding ? (
        <form onSubmit={add} style={{ display: "inline-flex", gap: 4, alignItems: "center", flex: "none" }}>
          <input autoFocus value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder="word, e.g. kafka" aria-label="New word"
            style={{ font: "inherit", fontSize: 12, width: 120, padding: "2px 8px", borderRadius: 999, border: "1px solid #cbd5e1" }} />
          <span style={{ opacity: 0.6 }}>draws as</span>
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Draws as"
            style={{ font: "inherit", fontSize: 12, padding: "1px 4px", borderRadius: 8, border: "1px solid #cbd5e1" }}>
            {TARGETS[kind].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="submit" disabled={!phrase.trim()} style={chip("#0f172a", "#fff", { border: "none", cursor: "pointer", font: "inherit", fontSize: 12 })}>Add</button>
          <button type="button" style={btn} onClick={() => setAdding(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" data-testid="vocab-add" title="Add a word you say often — it will draw instantly" onClick={() => setAdding(true)}
          style={chip("transparent", "#0f172a", { border: "1px dashed #94a3b8", cursor: "pointer", font: "inherit", fontSize: 12 })}>+ Add word</button>
      ))}
      {vocab.relations.map((w) => <span key={w} title="A relationship: the model draws the connection" style={chip("#f5f3ff", "#6d28d9", { fontWeight: 600 })}>{w}</span>)}
      {vocab.terms.map((t) => <span key={t.phrase} title={draws(t)} style={chip("#eff6ff", "#1d4ed8")}>{t.phrase}</span>)}
    </div>
  );
}
