// Debug one corpus case in-process with the real model/Jev, printing every job and model line (M7):
//   railway run --service gateway -- env -u DATABASE_URL -u REDIS_URL tsx scripts/corpus/trace.mts <case-id>
import { loadConfig } from "../../apps/gateway/src/config.js";
import { defaultDeps } from "../../apps/gateway/src/server.js";
import { DocSession } from "../../apps/gateway/src/engine/docSession.js";
import { CASES } from "./cases.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const c = CASES.find((x) => x.id === process.argv[2])!;
const cfg = { ...loadConfig(), DATABASE_URL: undefined };
const deps = defaultDeps(cfg as never);
const model = deps.model!;
const traced: typeof model = (req) => {
  const t0 = performance.now();
  console.log(`MODEL → ${req.user.split("Transcript so far:")[1]?.trim()}`);
  const s = model(req);
  return { usage: s.usage, lines: (async function* () { for await (const l of s.lines) { console.log(`  line +${Math.round(performance.now() - t0)}ms: ${l.line}`); yield l; } console.log(`  end +${Math.round(performance.now() - t0)}ms`); })() };
};
const d = new DocSession(await deps.persistence.openSession(), { ...deps, flags: undefined, model: traced, send: (m) => { if (m.type === "job") console.log(`job ${m.kind} ${m.state} ${m.detail ?? ""}`); if (m.type === "version") console.log("VERSION", m.version); }, log: (m) => console.log("LOG", m) } as never);
d.setView(c.view);
let seq = 0;
for (const s of [...(c.setup ?? []), c.say]) {
  const w = s.split(" ");
  for (let n = 1; n <= w.length; n++) { d.onTranscript(seq, w.slice(0, n).join(" "), n === w.length, n * 350, n === w.length); await sleep(350); }
  for (let i = 0; i < 100 && (d as any).active; i++) await sleep(100);
  console.log(`-- after "${s}": active=${!!(d as any).active}`);
  seq++;
}
process.exit(0);
