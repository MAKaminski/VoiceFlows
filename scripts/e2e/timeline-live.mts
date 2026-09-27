/**
 * M5f live check (ADR 0015): build three versions with the real model, jump back, branch, and check the
 * summaries.   pnpm tsx scripts/e2e/timeline-live.mts wss://gateway-production-1c11.up.railway.app/ws
 */
import { ServerMsg } from "../../packages/dsl/src/index.js";
import WebSocket from "ws";

const ws = new WebSocket(process.argv[2] ?? "ws://localhost:8787/ws");
const inbox: ServerMsg[] = [];
ws.on("message", (d) => inbox.push(ServerMsg.parse(JSON.parse(d.toString()))));
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };
const until = async (pred: (m: ServerMsg) => boolean, from: number, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const h = inbox.slice(from).find(pred); if (h) return h; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error("timeout");
};
const tl = () => inbox.filter((m) => m.type === "versions").at(-1) as Extract<ServerMsg, { type: "versions" }>;
const send = (m: object) => { const at = inbox.length; ws.send(JSON.stringify(m)); return at; };
const version = (v: number, at: number) => until((m) => m.type === "versions" && m.current === v, at);

await new Promise((r) => ws.once("open", r));
await version(0, send({ type: "hello" }));
await until((m) => m.type === "view", send({ type: "set_view", view: "architecture" }));
await version(1, send({ type: "set_title", title: "Timeline check" }));
await version(2, send({ type: "prompt", text: "a web app calls an API that writes to Postgres" }));
await version(3, send({ type: "prompt", text: "add Redis as a cache for the API" }));
const t3 = tl();
check("3 versions summarised with kinds and diffs", t3.items.length === 4 && t3.items[2]!.kind === "architecture" && t3.items[2]!.added >= 3 && t3.items[3]!.added >= 1);
await version(2, send({ type: "goto_version", version: 2 }));
check("jump back: path keeps the redo chain", JSON.stringify(tl().path) === "[0,1,2,3]");
await version(4, send({ type: "prompt", text: "add a Stripe payments service" }));
const t4 = tl();
check("editing after the jump branches from v2", t4.items.at(-1)!.parent === 2 && JSON.stringify(t4.path) === "[0,1,2,4]");
await version(3, send({ type: "goto_version", version: 3 }));
check("the other branch is still there", tl().current === 3);
ws.close();
