"use client";
import type { ServerMsg } from "@livecanvas/dsl";
import { gateway } from "@/lib/gateway";
import { dollarsFor, useMetrics } from "@/store/metrics";

/**
 * Taps gateway messages for the HUD: TTFV per rendered batch (next animation frame, audio clock),
 * settle time, model calls and $, and per-utterance reflows (a node's box moving > 4 px counts once
 * per move). Everything here is measurement — it never changes the doc.
 */
let boxes = new Map<string, DOMRect>();
let reflows = new Map<string, number>();
let utteranceSeq: number | null = null;

/** Box positions are taken relative to the phone frame, so page chrome or scrolling never counts. */
function measureReflows() {
  const frame = (document.querySelector('[data-node-id="n_root"]')?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
  if (!frame) return;
  document.querySelectorAll<HTMLElement>("[data-node-id]").forEach((wrap) => {
    const el = wrap.firstElementChild as HTMLElement | null;
    const id = wrap.dataset.nodeId!;
    if (!el || id === "n_root") return;
    const b = el.getBoundingClientRect();
    const r = new DOMRect(b.left - frame.left, b.top - frame.top, b.width, b.height);
    const prev = boxes.get(id);
    if (prev && (Math.abs(prev.top - r.top) > 4 || Math.abs(prev.left - r.left) > 4)) reflows.set(id, (reflows.get(id) ?? 0) + 1);
    boxes.set(id, r);
  });
}

function closeUtterance() {
  if (utteranceSeq == null) return;
  const max = Math.max(0, ...reflows.values());
  const total = [...reflows.values()].reduce((a, b) => a + b, 0);
  useMetrics.getState().add("reflowMaxPerElement", max);
  gateway.send({ type: "metrics", utteranceSeq, reflows: total, maxReflowsPerElement: max });
  reflows = new Map();
}

/** Max reflows of any element in the utterance still in progress (E2E harness reads it). */
export const currentMaxReflows = () => Math.max(0, ...reflows.values());

export function installMetricsTap() {
  return gateway.on((m: ServerMsg) => {
    const M = useMetrics.getState();
    const clock = () => M.audioClock?.() ?? null;
    if (m.type === "transcript") tapLocalTranscript(m);
    if (m.type === "ops" && (m.origin === "lexicon" || m.origin === "model")) {
      const firstForJob = !M.seenJobs.has(m.jobId);
      M.seenJobs.add(m.jobId);
      requestAnimationFrame(() => {
        measureReflows();
        const now = clock();
        if (now == null || m.trigMs == null || !firstForJob) return;
        M.add(m.origin === "lexicon" ? "ttfv0" : "ttfv1", now - m.trigMs);
        gateway.send({ type: "first_render", jobId: m.jobId, tMs: Math.round(now) });
      });
    }
    if (m.type === "version" && utteranceSeq != null) {
      const end = useMetrics.getState().pendingFinalEndMs;
      if (end != null) requestAnimationFrame(() => {
        const now = clock();
        if (now != null) M.add("settle", now - end);
        useMetrics.setState({ pendingFinalEndMs: null });
      });
    }
    if (m.type === "job" && m.state === "running" && m.kind !== "typed") useMetrics.setState((s) => ({ modelCalls: s.modelCalls + 1 }));
    if (m.type === "job" && m.inputTokens != null) useMetrics.setState((s) => ({ dollars: s.dollars + dollarsFor(m.inputTokens!, m.outputTokens ?? 0) }));
  });
}

/** Called by the voice client for local (direct/webspeech) transcripts, which never come from the gateway. */
export function tapLocalTranscript(t: { utteranceSeq: number; isFinal: boolean; lastWordEndMs?: number }) {
  if (utteranceSeq !== t.utteranceSeq) { closeUtterance(); utteranceSeq = t.utteranceSeq; boxes = new Map(); }
  // Settle is measured from the newest word end; a version can land before the final (eager commit).
  if (t.lastWordEndMs != null) useMetrics.setState({ pendingFinalEndMs: t.lastWordEndMs });
}
