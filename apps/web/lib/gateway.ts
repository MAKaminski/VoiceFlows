"use client";
import { PROTOCOL, ServerMsg, type ClientMsg } from "@livecanvas/dsl";
import { getAccess } from "@/lib/access";
import { useDoc } from "@/store/doc";
import { useFeatures } from "@/store/features";
import { useVoice } from "@/store/voice";

export const WS_URL = process.env.NEXT_PUBLIC_GATEWAY_WS ?? "ws://localhost:8787/ws";
export const HTTP_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
const SESSION_KEY = "lc.sessionId";
/** Per browser, not per tab: a new tab reopens the last document (ADR 0014). */
const DOCUMENT_KEY = "lc.documentId";
/** One-shot marker: the next hello opens this project from the library (ADR 0020). */
const OPEN_KEY = "lc.openDocumentId";

type Listener = (m: ServerMsg) => void;

/** Reload at most once a minute per tab, so a real contract mismatch can't loop. */
function reloadOnce() {
  const KEY = "lc.protocolReloadAt";
  try {
    const at = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - at < 60_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch { return; }
  location.reload();
}

/**
 * The one gateway connection per tab. The gateway is the only writer of the doc (ADR 0009); this
 * applies its snapshots and op batches to the doc store in arrival order, and fans every message
 * out to listeners (voice transcripts, HUD). Reconnects resume the same session and document.
 */
class Gateway {
  /** "demo": the home-page demo (ADR 0021) — demo token, never reads or writes this browser's project keys. */
  constructor(private readonly mode: "app" | "demo" = "app") {}
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private listeners = new Set<Listener>();

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      ws.onopen = async () => {
        // Access token first (ADR 0021); undefined when the gate is off. Fetched per connect, so reconnects refresh it.
        const access = await getAccess(this.mode === "demo" ? "demo" : "full").catch(() => undefined);
        if (this.mode === "demo") { this.send({ type: "hello", ...(access ? { access } : {}) }); return; }
        let sessionId: string | undefined, documentId: string | undefined;
        try { sessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined; } catch {}
        try { documentId = localStorage.getItem(DOCUMENT_KEY) ?? undefined; } catch {}
        // Opened from the library (ADR 0020): the picked project wins over this tab's previous session.
        let open = false;
        try { open = sessionStorage.getItem(OPEN_KEY) === documentId && !!documentId; sessionStorage.removeItem(OPEN_KEY); } catch {}
        this.send({ type: "hello", sessionId, documentId, ...(open ? { open: true } : {}), ...(access ? { access } : {}) });
      };
      ws.onerror = () => reject(new Error("gateway unreachable"));
      ws.onclose = () => { this.ready = null; this.ws = null; useDoc.getState().setConnected(false); };
      ws.onmessage = (e) => {
        if (typeof e.data !== "string") return;
        const raw = JSON.parse(e.data) as { type?: string; protocol?: number };
        const parsed = ServerMsg.safeParse(raw);
        // The gateway speaks a newer contract than this bundle (new colours, props, flags): reload once to get
        // the matching web build, instead of silently dropping the welcome and hanging (plan-critic M7).
        if (raw.type === "welcome" && (!parsed.success || (raw.protocol ?? 0) > PROTOCOL)) { reloadOnce(); return; }
        if (!parsed.success) return;
        const m = parsed.data;
        if (m.type === "welcome") {
          if (this.mode === "app") {
            try { sessionStorage.setItem(SESSION_KEY, m.sessionId); } catch {}
            try { if (m.documentId) localStorage.setItem(DOCUMENT_KEY, m.documentId); } catch {}
          }
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

  /** Open a saved project from the library: forget this tab's session so the picked one wins (plan-critic M8 #6). */
  openDocument(documentId: string) {
    try { sessionStorage.removeItem(SESSION_KEY); sessionStorage.setItem(OPEN_KEY, documentId); localStorage.setItem(DOCUMENT_KEY, documentId); } catch {}
    if (location.pathname.startsWith("/studio")) location.reload(); else location.assign("/studio");
  }

  send(m: ClientMsg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  sendAudio(frame: ArrayBuffer) { if (this.ws?.readyState === 1) this.ws.send(frame); }
  on(l: Listener) { this.listeners.add(l); return () => void this.listeners.delete(l); }
}

export const gateway = new Gateway();
/** The home-page demo's own connection (ADR 0021). */
export const demoGateway = new Gateway("demo");
