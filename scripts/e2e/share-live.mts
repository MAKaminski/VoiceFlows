/**
 * M5d live check (ADR 0013): builds a diagram, shares it, checks the public read path, then proves
 * revoke on a second throwaway link. Prints the kept link.
 *   pnpm tsx scripts/e2e/share-live.mts wss://gateway-production-1c11.up.railway.app/ws https://live-canvas-three.vercel.app
 */
import { ServerMsg } from "../../packages/dsl/src/index.js";
import WebSocket from "ws";

const wsUrl = process.argv[2] ?? "ws://localhost:8787/ws";
const web = process.argv[3] ?? "http://localhost:3000";
const http = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); if (!ok) process.exitCode = 1; };

async function session() {
  const ws = new WebSocket(wsUrl);
  const inbox: ServerMsg[] = [];
  ws.on("message", (d) => inbox.push(ServerMsg.parse(JSON.parse(d.toString()))));
  const until = async (pred: (m: ServerMsg) => boolean, from = 0, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const h = inbox.slice(from).find(pred); if (h) return h; await new Promise((r) => setTimeout(r, 40)); }
    throw new Error("timeout");
  };
  await new Promise((r) => ws.once("open", r));
  const send = (m: object) => { const at = inbox.length; ws.send(JSON.stringify(m)); return at; };
  send({ type: "hello" });
  await until((m) => m.type === "shares");
  return { ws, inbox, until, send };
}

const a = await session();
let at = a.send({ type: "new_doc", kind: "architecture" });
await a.until((m) => m.type === "version", at);
at = a.send({ type: "prompt", text: "a Next.js web app calls a Fastify API gateway that writes to Postgres, caches in Redis, streams audio to Deepgram and calls Claude, deployed on Railway and Vercel" });
await a.until((m) => m.type === "job" && m.kind === "typed" && m.state !== "running", at, 60000);
at = a.send({ type: "share_create" });
const s = await a.until((m) => m.type === "shares" && m.links.length > 0, at) as Extract<ServerMsg, { type: "shares" }>;
const { token, version } = s.links.at(-1)!;
await new Promise((r) => setTimeout(r, 800)); // the exports row is queued behind the version row
const res = await fetch(`${http}/share/${token}`);
const body = await res.json() as { doc: { root: { props: { kind: string } } }; version: number };
check(`GET /share → 200, architecture, version ${version}`, res.status === 200 && body.doc.root.props.kind === "architecture" && body.version === version);
check("response is no-store", res.headers.get("cache-control") === "no-store");

const b = await session();
at = b.send({ type: "share_create" });
const t2 = ((await b.until((m) => m.type === "shares" && m.links.length > 0, at)) as Extract<ServerMsg, { type: "shares" }>).links[0]!.token;
at = a.send({ type: "share_revoke", token: t2 }); // another document's socket can't revoke it
await a.until((m) => m.type === "shares", at);
await new Promise((r) => setTimeout(r, 500));
check("another document cannot revoke it", (await fetch(`${http}/share/${t2}`)).status === 200);
at = b.send({ type: "share_revoke", token: t2 });
await b.until((m) => m.type === "shares" && m.links.length === 0, at);
check("revoked → 404 on the next view", (await fetch(`${http}/share/${t2}`)).status === 404);
a.ws.close(); b.ws.close();
console.log(`SHARE_URL ${web}/s/${token}`);
