"use client";
import { ServerMsg, type ClientMsg } from "@livecanvas/dsl";
import { useDoc } from "@/store/doc";
import { useFeatures } from "@/store/features";
import { useVoice } from "@/store/voice";

export const WS_URL = process.env.NEXT_PUBLIC_GATEWAY_WS ?? "ws://localhost:8787/ws";
export const HTTP_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
const SESSION_KEY = "lc.sessionId";
/** Per browser, not per tab: a new tab reopens the last document (ADR 0014). */
const DOCUMENT_KEY = "lc.documentId";

type Listener = (m: ServerMsg) => void;

/**
 * The one gateway connection per tab. The gateway is the only writer of the doc (ADR 0009); this
 * applies its snapshots and op batches to the doc store in arrival order, and fans every message
 * out to listeners (voice transcripts, HUD). Reconnects resume the same session and document.
 */
class Gateway {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<Listener>();

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = () => {
        let sessionId: string | undefined, documentId: string | undefined;
        try { sessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined; } catch {}
        try { documentId = localStorage.getItem(DOCUMENT_KEY) ?? undefined; } catch {}
        this.send({ type: "hello", sessionId, documentId });
      };
      ws.onerror = () => reject(new Error("gateway unreachable"));
      ws.onclose = () => { this.ready = null; this.ws = null; useDoc.getState().setConnected(false); };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const parsed = ServerMsg.safeParse(JSON.parse(e.data));
        if (!parsed.success) return;
        const m = parsed.data;
        if (m.type === "welcome") {
          try { sessionStorage.setItem(SESSION_KEY, m.sessionId); } catch {}
          try { if (m.documentId) localStorage.setItem(DOCUMENT_KEY, m.documentId); } catch {}
          useDoc.getState().setConnected(true);
          resolve();
        }
        useDoc.getState().applyServer(m);
        useFeatures.getState().applyServer(m);
        if (m.type === "words") useVoice.getState().setMarks(m.utteranceSeq, m.marks);
        this.listeners.forEach((l) => l(m));
        // Dev/E2E ring buffer of what the gateway said (never shipped to any server).
        const w = window as unknown as { __lcMsgLog?: unknown[] };
        (w.__lcMsgLog ??= []).push({ t: Math.round(performance.now()), type: m.type, ...(m.type === "ops" ? { origin: m.origin, ops: m.ops.map((o) => `${o.op} ${o.path}${o.op === "add" ? ` ${(o.value as { type?: string; id?: string }).type}:${(o.value as { id?: string }).id}` : ""}`) } : m.type === "job" ? { kind: m.kind, state: m.state, text: m.text } : m.type === "transcript" ? { text: m.text, isFinal: m.isFinal, eager: m.eager } : m.type === "version" ? { version: m.version } : {}) });
        if (w.__lcMsgLog.length > 400) w.__lcMsgLog.shift();
      };
    });
    return this.ready;
  }

  /** Start a blank document: forget this browser's document and reconnect (ADR 0014). */
  newDocument() {
    try { sessionStorage.removeItem(SESSION_KEY); localStorage.removeItem(DOCUMENT_KEY); } catch {}
    location.reload();
  }

  send(m: ClientMsg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  sendAudio(frame: ArrayBuffer) { if (this.ws?.readyState === 1) this.ws.send(frame); }
  on(l: Listener) { this.listeners.add(l); return () => void this.listeners.delete(l); }
}

export const gateway = new Gateway();
