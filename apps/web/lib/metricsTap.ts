"use client";
import type { ServerMsg } from "@livecanvas/dsl";
import { gateway } from "@/lib/gateway";
import { dollarsFor, useMetrics } from "@/store/metrics";
import { useDoc } from "@/store/doc";

/**
 * Taps gateway messages for the HUD: TTFV per rendered batch (next animation frame, audio clock),
 * settle time, model calls and $, and per-utterance reflows (a node's box moving > 4 px counts once
 * per move). Everything here is measurement — it never changes the doc.
 */
let boxes = new Map<string, DOMRect>();
let reflows = new Map<string, number>();
let utteranceSeq: number | null = null;

let warned = false;
/** Box positions are taken relative to the active view's surface, so page chrome or scrolling never counts. */
function measureReflows() {
  // The active view only: the all-views grid mounts four roots (ADR 0020), and a change in one cell must not
  // count as a reflow in another. Positions are divided by the cell's scale, so the 4 px rule stays in layout px.
  const view = useDoc.getState().view;
  const rootWrap = document.querySelector<HTMLElement>(`[data-view-root][data-view="${view}"]`) ?? document.querySelector<HTMLElement>("[data-view-root]");
  const scale = Number(rootWrap?.closest<HTMLElement>("[data-scale]")?.dataset.scale ?? 1) || 1;
  const frame = (rootWrap?.firstElementChild as HTMLElement | null)?.getBoundingClientRect();
  if (!frame) {
    // ADR 0016 (plan-critic #2): a missing view root would silently zero TTFV/reflow — say so.
    if (!warned) { warned = true; console.error("metricsTap: no [data-view-root] on the page — reflow and TTFV are not being measured"); }
    return;
  }
  rootWrap!.querySelectorAll<HTMLElement>("[data-node-id]").forEach((wrap) => {
    const el = wrap.firstElementChild as HTMLElement | null;
    const id = wrap.dataset.nodeId!;
    if (!el || wrap === rootWrap) return;
    const b = el.getBoundingClientRect();
    const r = new DOMRect((b.left - frame.left) / scale, (b.top - frame.top) / scale, b.width / scale, b.height / scale);
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
    if (m.type === "ops" && (m.origin === "lexicon" || m.origin === "model" || m.origin === "jev")) {
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
