/**
 * M5b live check (ADR 0012) against a running gateway, no model needed:
 * welcome carries flags · spoken "define ledger as a database" proposes and draws nothing ·
 * "confirm" locks it in · the next "ledger" draws in the Database lane · delete cleans up.
 *   pnpm tsx scripts/e2e/vocab-live.mts wss://gateway-production-1c11.up.railway.app/ws
 */
import { applyOp, ServerMsg, type DesignDoc } from "../../packages/dsl/src/index.js";
import WebSocket from "ws";

const ws = new WebSocket(process.argv[2] ?? "ws://localhost:8787/ws");
const inbox: ServerMsg[] = [];
let doc: DesignDoc | null = null;
ws.on("message", (d) => { const m = ServerMsg.parse(JSON.parse(d.toString())); if (m.type === "doc") doc = m.doc; if (m.type === "ops") for (const op of m.ops) doc = applyOp(doc!, op); inbox.push(m); });
const until = async (pred: (m: ServerMsg) => boolean, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { const h = inbox.find(pred); if (h) return h; await new Promise((r) => setTimeout(r, 30)); } throw new Error("timeout"); };
const send = (m: object) => ws.send(JSON.stringify(m));
const say = (seq: number, text: string, isFinal = false) => send({ type: "partial", utteranceSeq: seq, text, isFinal, tMs: 0 });
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

await new Promise((r) => ws.once("open", r));
send({ type: "hello" });
const welcome = await until((m) => m.type === "welcome") as Extract<ServerMsg, { type: "welcome" }>;
check("welcome carries 7 flags", Object.keys(welcome.flags ?? {}).length === 7);
await until((m) => m.type === "vocab");
send({ type: "new_doc", kind: "architecture" });
await until((m) => m.type === "version");
send({ type: "stt_start", mode: "direct" });
const words = "define ledger as a database".split(" ");
for (let n = 1; n <= words.length; n++) say(0, words.slice(0, n).join(" "), n === words.length);
const p = await until((m) => m.type === "vocab_proposed") as Extract<ServerMsg, { type: "vocab_proposed" }>;
check("spoken define → proposal Ledger · db · data", p.term.node.label === "Ledger" && p.term.node.kind === "db" && p.term.node.tier === "data");
check("the command drew nothing and ran no model job", !inbox.some((m) => (m.type === "ops" && m.origin === "lexicon") || m.type === "job"));
say(1, "confirm", true);
await until((m) => m.type === "vocab" && m.terms.some((t) => t.status === "confirmed"));
say(2, "the api writes to the ledger", true);
await new Promise((r) => setTimeout(r, 1500));
const lane = doc!.root.children!.find((c) => c.id === "n_data")!;
check("next 'ledger' draws in the Database lane", lane.children!.some((c) => c.props.label === "Ledger"));
send({ type: "vocab_delete", id: p.term.id });
await until((m) => m.type === "vocab" && m.terms.length === 0);
check("delete cleans up", true);
ws.close();
