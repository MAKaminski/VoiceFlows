/** Mic → 80 ms int16 PCM frames at 16 kHz (public/worklets/pcm16.js). */
export interface Capture { stop(): void; startedAt: number }

export async function startCapture(onFrame: (frame: ArrayBuffer) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  let ctx: AudioContext;
  try { ctx = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" }); }
  catch { ctx = new AudioContext({ latencyHint: "interactive" }); } // worklet resamples
  await ctx.audioWorklet.addModule("/worklets/pcm16.js");
  const node = new AudioWorkletNode(ctx, "pcm16");
  const cap: Capture = {
    startedAt: 0,
    stop: () => { node.disconnect(); stream.getTracks().forEach((t) => t.stop()); void ctx.close(); },
  };
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    // Audio clock zero = arrival of the first frame minus its 80 ms duration.
    if (!cap.startedAt) cap.startedAt = performance.now() - 80;
    onFrame(e.data);
  };
  ctx.createMediaStreamSource(stream).connect(node);
  if (ctx.state === "suspended") await ctx.resume();
  return cap;
}
