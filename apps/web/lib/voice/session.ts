import { ServerMsg, SttGrant, type ClientMsg } from "@livecanvas/dsl";
import { startCapture, type Capture } from "./capture";

export interface Transcript { utteranceSeq: number; text: string; isFinal: boolean; tMs: number }
export interface VoiceEvents {
  onStatus(status: "connecting" | "listening" | "stopped" | "error", detail?: string): void;
  onMode(mode: SttGrant["mode"]): void;
  onTranscript(t: Transcript): void;
  onFrame?(level: number): void;
}

const WS_URL = process.env.NEXT_PUBLIC_GATEWAY_WS ?? "ws://localhost:8787/ws";
const HTTP_BASE = WS_URL.replace(/^ws/, "http").replace(/\/ws$/, "");

/**
 * One voice session (ADR 0008): gateway WS for control/persistence, and speech-to-text in one of
 * three modes chosen by the gateway — direct (browser → Deepgram Flux with a short-lived JWT),
 * relay (audio frames → gateway → Flux), or webspeech (browser API, no key configured).
 */
export async function startVoice(ev: VoiceEvents): Promise<{ stop(): void }> {
  ev.onStatus("connecting");
  const grant = SttGrant.parse(await (await fetch(`${HTTP_BASE}/stt/token`, { method: "POST" })).json());
  ev.onMode(grant.mode);

  const gw = new WebSocket(WS_URL);
  gw.binaryType = "arraybuffer";
  await new Promise<void>((res, rej) => { gw.onopen = () => res(); gw.onerror = () => rej(new Error("gateway unreachable")); });
  const sendGw = (m: ClientMsg) => gw.readyState === 1 && gw.send(JSON.stringify(m));
  sendGw({ type: "hello" });
  sendGw({ type: "stt_start", mode: grant.mode });

  let capture: Capture | null = null;
  let seq = 0;
  const since = () => (capture?.startedAt ? performance.now() - capture.startedAt : 0);
  const emit = (text: string, isFinal: boolean, forward: boolean) => {
    if (!text) return;
    const t = { utteranceSeq: seq, text, isFinal, tMs: since() };
    ev.onTranscript(t);
    if (forward) sendGw({ type: "partial", ...t });
    if (isFinal) seq++;
  };

  gw.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    const m = ServerMsg.safeParse(JSON.parse(e.data));
    if (!m.success) return;
    if (m.data.type === "transcript") { ev.onTranscript({ ...m.data, tMs: since() }); }
    if (m.data.type === "error") ev.onStatus("error", m.data.message);
  };

  let stt: { stop(): void };
  if (grant.mode === "webspeech") {
    stt = startWebSpeech((text, isFinal) => emit(text, isFinal, true), (err) => ev.onStatus("error", err));
  } else {
    let dg: WebSocket | null = null;
    if (grant.mode === "direct") {
      dg = new WebSocket(grant.url, ["bearer", grant.token]);
      await new Promise<void>((res, rej) => { dg!.onopen = () => res(); dg!.onerror = () => rej(new Error("Deepgram refused the browser token")); });
      dg.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.type === "TurnInfo") emit(m.transcript ?? "", m.event === "EndOfTurn", true);
      };
    }
    capture = await startCapture((frame) => {
      if (ev.onFrame) { const pcm = new Int16Array(frame); let peak = 0; for (let i = 0; i < pcm.length; i += 8) peak = Math.max(peak, Math.abs(pcm[i]!)); ev.onFrame(peak / 32768); }
      if (dg) { if (dg.readyState === 1) dg.send(frame); }
      else if (gw.readyState === 1) gw.send(frame);
    });
    stt = { stop: () => { capture?.stop(); if (dg?.readyState === 1) { dg.send(JSON.stringify({ type: "CloseStream" })); dg.close(); } } };
  }
  ev.onStatus("listening");

  return {
    stop() {
      stt.stop();
      sendGw({ type: "stt_stop" });
      gw.close();
      ev.onStatus("stopped");
    },
  };
}

function startWebSpeech(onText: (text: string, isFinal: boolean) => void, onError: (e: string) => void) {
  const W = window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any };
  const R = W.SpeechRecognition ?? W.webkitSpeechRecognition;
  if (!R) { onError("This browser has no speech recognition. Use Chrome or Edge, or configure Deepgram."); return { stop() {} }; }
  const r = new R();
  r.continuous = true; r.interimResults = true; r.lang = "en-US";
  let finalIdx = 0;
  r.onresult = (e: any) => {
    for (let i = finalIdx; i < e.results.length; i++) {
      const res = e.results[i];
      onText(res[0].transcript.trim(), res.isFinal);
      if (res.isFinal) finalIdx = i + 1;
    }
  };
  r.onerror = (e: any) => { if (e.error !== "no-speech") onError(`speech recognition: ${e.error}`); };
  let running = true;
  r.onend = () => { if (running) r.start(); }; // Chrome ends continuous sessions after silence
  r.start();
  return { stop() { running = false; r.stop(); } };
}
