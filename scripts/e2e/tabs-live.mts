/**
 * M5e live check (ADR 0014): a document survives its tab closing, a second tab takes it over, and the
 * old tab is refused.   pnpm tsx scripts/e2e/tabs-live.mts wss://gateway-production-1c11.up.railway.app/ws
 */
import { ServerMsg } from "../../packages/dsl/src/index.js";
import WebSocket from "ws";

const url = process.argv[2] ?? "ws://localhost:8787/ws";
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };
async function tab(ids: object = {}) {
  const ws = new WebSocket(url);
  const inbox: ServerMsg[] = [];
  ws.on("message", (d) => inbox.push(ServerMsg.parse(JSON.parse(d.toString()))));
  const until = async (pred: (m: ServerMsg) => boolean, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const h = inbox.find(pred); if (h) return h; await new Promise((r) => setTimeout(r, 40)); }
    throw new Error("timeout");
  };
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ type: "hello", ...(process.env.LC_ACCESS ? { access: process.env.LC_ACCESS } : {}), ...ids }));
  const welcome = await until((m) => m.type === "welcome") as Extract<ServerMsg, { type: "welcome" }>;
  return { ws, inbox, until, welcome, send: (m: object) => ws.send(JSON.stringify(m)) };
}

const a = await tab();
a.send({ type: "set_title", title: "Tabs check" });
await a.until((m) => m.type === "version" && m.version === 1);
a.ws.close();
const b = await tab({ documentId: a.welcome.documentId });
check("new tab reopens the closed tab's document at version 1", b.welcome.documentId === a.welcome.documentId && b.welcome.version === 1 && !!b.welcome.resumed);
const c = await tab({ documentId: a.welcome.documentId });
await b.until((m) => m.type === "taken_over", 5000).catch(() => null);
check("a third tab takes it over; the second is told", b.inbox.some((m) => m.type === "taken_over"));
b.send({ type: "undo" });
const err = await b.until((m) => m.type === "error", 5000).catch(() => null) as { message?: string } | null;
check("the old tab is refused", !!err?.message?.includes("another tab"));
check("the new owner has the document", c.welcome.version === 1);
b.ws.close(); c.ws.close();
