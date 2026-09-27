// M2 acceptance: real browser, real mic path (AudioWorklet), fake mic = scripts/fixtures/dod.wav.
// Launches an isolated Chrome, opens <URL>/studio?autostart, waits, reads the transcript log via
// the DevTools protocol and scores first-appearance lag per word against dod.words.json.
//   node scripts/e2e/voice-latency.mjs http://localhost:3000 [runs]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "../../node_modules/.pnpm/node_modules/ws/index.js";

const BROWSER = process.env.E2E_BROWSER ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const root = resolve(import.meta.dirname, "../..");
const base = process.argv[2] ?? "http://localhost:3000";
const RUNS = Number(process.argv[3] ?? 3);
const ref = JSON.parse(readFileSync(join(root, "scripts/fixtures/dod.words.json"), "utf8")).words
  .flatMap((w) => w.word.split("-").map((t) => ({ word: t, end: w.end })));
const tokens = (t) => t.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter(Boolean);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTarget(port) {
  for (let i = 0; i < 50; i++) {
    try { const t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === "page"); if (t) return t; } catch {}
    await sleep(200);
  }
  throw new Error("Chrome DevTools not reachable");
}
async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
  const out = await new Promise((r) => { ws.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.id === 1) r(m.result?.result?.value); }); ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); });
  ws.close(); return out;
}

const lags = [], perRun = [];
let misses = 0;
for (let run = 0; run < RUNS; run++) {
  const port = 9300 + run;
  const chrome = spawn(BROWSER, [
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "lc-e2e-"))}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check",
    ...(process.env.HEADED ? [] : ["--headless=new"]), // headless by default: no windows on the owner's screen
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${join(root, "scripts/fixtures/dod.wav")}%noloop`,
    "--autoplay-policy=no-user-gesture-required",
    // macOS: the sandboxed audio service cannot read the fake-mic file and silently captures zeros.
    "--disable-features=AudioServiceOutOfProcess,AudioServiceSandbox",
    `${base}/studio?autostart`,
  ], { stdio: "ignore" });
  try {
    const t = await cdpTarget(port);
    await sleep(11_000); // connect + 6.2 s of speech + tail
    const state = await evaluate(t.webSocketDebuggerUrl, `(() => { const s = window.__lcVoice?.getState(); const m = window.__lcMetrics?.getState(); const d = window.__lcDoc?.getState();
      return s && { status: s.status, detail: s.detail, mode: s.mode, frames: s.framesSent, level: s.level, log: s.log, finals: Object.values(s.utterances).map((u) => u.text),
        m4: m && { ttfv0: m.ttfv0, ttfv1: m.ttfv1, settle: m.settle, reflows: Math.max(window.__lcReflowNow?.() ?? 0, ...m.reflowMaxPerElement), calls: m.modelCalls, dollars: m.dollars },
        msgs: window.__lcMsgLog,
        layout: d && d.doc.root.children.map((n) => n.type + (n.children?.length ? "[" + n.children.map((c) => c.type + (c.props.label ? "(" + c.props.label + ")" : "")).join(",") + "]" : "")) }; })()`);
    if (!state) throw new Error("studio page did not expose __lcVoice");
    const seen = ref.map(() => NaN);
    let committed = "";
    for (const e of state.log) {
      const running = `${committed} ${e.text}`; if (e.isFinal) committed = running;
      const toks = tokens(running); let from = 0;
      ref.forEach((w, j) => { const at = toks.indexOf(w.word, from); if (at >= 0) { from = at + 1; if (Number.isNaN(seen[j])) seen[j] = e.tMs; } });
    }
    seen.forEach((t, j) => (Number.isNaN(t) ? misses++ : lags.push(t - ref[j].end)));
    if (process.env.TIMELINE && state.msgs) {
      const t0 = state.msgs[0]?.t ?? 0;
      for (const x of state.msgs) {
        if (x.type === "transcript" && !x.isFinal && !x.eager) continue;
        console.log(`   ${String(x.t - t0).padStart(6)} ${x.type}${x.origin ? " " + x.origin : ""}${x.kind ? " " + x.kind : ""}${x.state ? " " + x.state : ""}${x.isFinal ? " FINAL" : ""}${x.eager ? " EAGER" : ""}${x.version != null ? " v" + x.version : ""}${x.text ? ' "' + x.text + '"' : ""}${x.ops ? " " + x.ops.join(" | ") : ""}`);
      }
    }
    if (state.m4) console.log(`        M4 in-browser: TTFV-0 [${state.m4.ttfv0.map(Math.round).join(", ")}] · TTFV-1 [${state.m4.ttfv1.map(Math.round).join(", ")}] · settle [${state.m4.settle.map(Math.round).join(", ")}] · reflows ${state.m4.reflows} · layout ${state.layout?.join(" · ")}`);
    perRun.push({ m4: state.m4, layout: state.layout, frames: state.frames, mode: state.mode, status: state.status, detail: state.detail, events: state.log.length, finals: state.finals });
    console.log(`run ${run + 1}: mode=${state.mode} status=${state.status}${state.detail ? " (" + state.detail + ")" : ""} frames=${state.frames} level=${Number(state.level).toFixed(3)} events=${state.log.length} text="${state.finals.join(" | ")}"`);
  } catch (e) {
    console.log(`run ${run + 1}: harness error (${e.message}) — run discarded`);
  } finally { chrome.kill(); await sleep(800); }
}
const result = { base, runs: RUNS, wordLagMs: { n: lags.length, p50: pct(lags, 50), p95: pct(lags, 95) }, wordRecall: lags.length / Math.max(1, lags.length + misses), perRun };
console.log(`E2E word lag p50 ${result.wordLagMs.p50} ms · p95 ${result.wordLagMs.p95} ms · recall ${(result.wordRecall * 100).toFixed(0)}% · M2 bar: partials < 500 ms p50 → ${result.wordLagMs.p50 < 500 ? "PASS" : "FAIL"}`);
console.log(`E2E_RESULT ${JSON.stringify(result)}`);
