"use client";
import { ServerMsg, type ClientMsg } from "@livecanvas/dsl";
import { useDoc } from "@/store/doc";

export const WS_URL = process.env.NEXT_PUBLIC_GATEWAY_WS ?? "ws://localhost:8787/ws";
export const HTTP_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");
const SESSION_KEY = "lc.sessionId";

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
        let sessionId: string | undefined;
        try { sessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined; } catch {}
        this.send({ type: "hello", sessionId });
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
          useDoc.getState().setConnected(true);
          resolve();
        }
        useDoc.getState().applyServer(m);
        this.listeners.forEach((l) => l(m));
      };
    });
    return this.ready;
  }

  send(m: ClientMsg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m)); }
  sendAudio(frame: ArrayBuffer) { if (this.ws?.readyState === 1) this.ws.send(frame); }
  on(l: Listener) { this.listeners.add(l); return () => void this.listeners.delete(l); }
}

export const gateway = new Gateway();
