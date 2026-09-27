/**
 * STT provider adapters for the bake-off — and the seed of the production STT adapter (D6).
 * Each adapter opens a streaming session, accepts 20 ms 16 kHz int16 frames, and reports the
 * provider's current hypothesis text (interim or final). Nothing provider-specific leaks out.
 */
import WebSocketNode from "ws";

export interface SttSession {
  send(frame: Buffer): void;
  onText(cb: (text: string, isFinal: boolean) => void): void;
  finish(): Promise<void>;
}
export interface SttProvider {
  pricePerMin: number; // list price per audio minute, 2026-09-26
  needs: string; // what is missing when not ready
  ready(): boolean;
  connect(): Promise<SttSession>;
}

const env = (k: string) => process.env[k];

/** Shared WebSocket plumbing: open, route JSON messages, close on finish. */
export async function wsSession(
  url: string,
  opts: {
    protocols?: string[];
    headers?: Record<string, string>;
    onOpen?: (send: (data: string | Buffer) => void) => void;
    encode?: (frame: Buffer) => string | Buffer;
    parse: (msg: any, emit: (text: string, isFinal: boolean) => void) => void;
    close: (send: (data: string | Buffer) => void) => void;
  },
): Promise<SttSession> {
  const ws = new WebSocketNode(url, opts.protocols, { headers: opts.headers });
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", (e) => rej(e));
    ws.once("unexpected-response", (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
  });
  const send = (d: string | Buffer) => { if (ws.readyState === WebSocketNode.OPEN) ws.send(d); };
  opts.onOpen?.(send);
  let cb: (text: string, isFinal: boolean) => void = () => {};
  const closed = new Promise<void>((res) => ws.once("close", () => res()));
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    opts.parse(msg, (t, f) => cb(t, f));
  });
  return {
    send: (frame) => { const d = opts.encode ? opts.encode(frame) : frame; if (typeof d === "string" || d.length) send(d); },
    onText: (f) => { cb = f; },
    finish: async () => {
      opts.close(send);
      await Promise.race([closed, new Promise((r) => setTimeout(r, 4000))]);
      ws.terminate();
    },
  };
}

export const PROVIDERS: Record<string, SttProvider> = {
  // Baseline (M0): interim results roughly once per second.
  "deepgram-nova3": {
    pricePerMin: 0.0077,
    needs: "DEEPGRAM_API_KEY",
    ready: () => !!env("DEEPGRAM_API_KEY"),
    connect: () =>
      wsSession(
        "wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&punctuate=false&smart_format=false",
        {
          headers: { authorization: `Token ${env("DEEPGRAM_API_KEY")}` },
          parse: (m, emit) => { if (m.type === "Results") emit(m.channel?.alternatives?.[0]?.transcript ?? "", !!m.is_final); },
          close: (send) => send(JSON.stringify({ type: "CloseStream" })),
        },
      ),
  },

  // Deepgram Flux (/v2): TurnInfo Update events during a turn; EndOfTurn is final. 80 ms chunks recommended.
  "deepgram-flux": {
    pricePerMin: 0.0077,
    needs: "DEEPGRAM_API_KEY",
    ready: () => !!env("DEEPGRAM_API_KEY"),
    connect: async () => {
      let pending: Buffer[] = [];
      return wsSession("wss://api.deepgram.com/v2/listen?model=flux-general-en&encoding=linear16&sample_rate=16000", {
        headers: { authorization: `Token ${env("DEEPGRAM_API_KEY")}` },
        encode: (frame) => {
          pending.push(frame);
          if (pending.length < 4) return Buffer.alloc(0);
          const out = Buffer.concat(pending); pending = []; return out;
        },
        parse: (m, emit) => { if (m.type === "TurnInfo") emit(m.transcript ?? "", m.event === "EndOfTurn"); },
        close: (send) => send(JSON.stringify({ type: "CloseStream" })),
      });
    },
  },

  // Soniox real-time: tokens are sub-word pieces; finals accumulate, non-finals are replaced each message.
  "soniox-rt": {
    pricePerMin: 0.002,
    needs: "SONIOX_API_KEY",
    ready: () => !!env("SONIOX_API_KEY"),
    connect: async () => {
      let finals = "";
      return wsSession("wss://stt-rt.soniox.com/transcribe-websocket", {
        onOpen: (send) => send(JSON.stringify({ api_key: env("SONIOX_API_KEY"), model: env("SONIOX_MODEL") ?? "stt-rt-v5", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1, language_hints: ["en"] })),
        parse: (m, emit) => {
          if (m.error_code) throw new Error(`soniox ${m.error_code}: ${m.error_message}`);
          let nonFinal = "";
          for (const t of m.tokens ?? []) { if (t.is_final) finals += t.text; else nonFinal += t.text; }
          emit(finals + nonFinal, false);
        },
        close: (send) => send(Buffer.alloc(0)),
      });
    },
  },

  // AssemblyAI Universal-Streaming v3: Turn messages carry the running transcript; end_of_turn is final.
  // Billed on open-socket time, so Terminate is always sent.
  "assemblyai-universal": {
    pricePerMin: 0.0025,
    needs: "ASSEMBLYAI_API_KEY",
    ready: () => !!env("ASSEMBLYAI_API_KEY"),
    connect: () =>
      wsSession(`wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&encoding=pcm_s16le${env("ASSEMBLYAI_MODEL") ? `&speech_model=${env("ASSEMBLYAI_MODEL")}` : ""}`, {
        headers: { authorization: env("ASSEMBLYAI_API_KEY")! },
        parse: (m, emit) => { if (m.type === "Turn") emit(m.transcript ?? "", !!m.end_of_turn); },
        close: (send) => send(JSON.stringify({ type: "Terminate" })),
      }),
  },

  // ElevenLabs Scribe v2 realtime: base64 JSON audio; partials have text only (scored on ground truth anyway).
  "elevenlabs-scribe": {
    pricePerMin: 0.0065,
    needs: "ELEVENLABS_API_KEY",
    ready: () => !!env("ELEVENLABS_API_KEY"),
    connect: () =>
      wsSession("wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&language_code=en", {
        headers: { "xi-api-key": env("ELEVENLABS_API_KEY")! },
        encode: (frame) => JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: frame.toString("base64"), sample_rate: 16000 }),
        parse: (m, emit) => {
          if (m.message_type === "partial_transcript") emit(m.text ?? "", false);
          else if (String(m.message_type ?? "").startsWith("committed_transcript")) emit(m.text ?? "", true);
        },
        close: () => {},
      }),
  },
};
