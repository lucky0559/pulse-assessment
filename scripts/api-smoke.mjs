// End-to-end API smoke test: node scripts/api-smoke.mjs [baseUrl]
// Exercises presence expiry, the connect/accept/end lifecycle, and the
// authorization rules, against a running server + database.
import { randomUUID } from "node:crypto";

const BASE = process.argv[2] ?? "http://localhost:3000";
let failures = 0;

function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  ${extra}`}`);
  if (!cond) failures++;
}

const join = (token, lat = 14.6, lng = 121.0) =>
  fetch(`${BASE}/api/join`, {
    method: "POST",
    body: JSON.stringify({ token, lat, lng }),
  }).then((r) => r.json());
const poll = (token) =>
  fetch(`${BASE}/api/poll`, { headers: { "x-pulse-token": token } }).then(
    async (r) => ({ status: r.status, ...(await r.json()) }),
  );
const signal = (token, toId, type, payload) =>
  fetch(`${BASE}/api/signal`, {
    method: "POST",
    body: JSON.stringify({ token, toId, type, payload }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const leave = (token) =>
  fetch(`${BASE}/api/leave`, { method: "POST", body: JSON.stringify({ token }) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const offer = JSON.stringify({ type: "offer", sdp: "v=0..." });

const a = await join(A);
const b = await join(B, 35.6, 139.7);
const c = await join(C, 51.5, -0.1);

// Real clients heartbeat every 1.5s. Keep B alive while the scripted steps run
// (slower deployed latency can otherwise push it past the 15s stale limit);
// it's stopped before the stale-expiry check below.
const keepAlive = setInterval(() => void poll(B).catch(() => {}), 4000);

// --- Presence & privacy ----------------------------------------------------
let pa = await poll(A);
check("poll lists the other users", pa.peers.length >= 2);
check("poll never exposes secret tokens", !JSON.stringify(pa).includes(B));
check("peer ids are public handles", pa.peers.some((p) => p.id === b.id));
const km = (la1, ln1, la2, ln2) =>
  Math.hypot((la1 - la2) * 111.32, (ln1 - ln2) * 111.32 * Math.cos((la1 * Math.PI) / 180));
const off = km(14.6, 121.0, a.lat, a.lng);
check("dot offset is 1-3 km", off >= 0.99 && off <= 3.01, `got ${off.toFixed(2)}km`);
const again = await join(A, 14.6, 121.0);
check("re-join keeps the same dot (no offset re-roll)", again.lat === a.lat && again.id === a.id);

// --- Authorization ---------------------------------------------------------
let r = await signal(A, b.id, "accept");
check("accept without a request is rejected", r.status === 409, r.status);
r = await signal(A, b.id, "offer", offer);
check("offer to an unpaired user is rejected", r.status === 403, r.status);
r = await signal(randomUUID(), b.id, "request");
check("unknown token cannot send signals", r.status === 401, r.status);
r = await signal(C, a.id, "request");
check("request delivers", r.status === 200);
r = await signal(B, c.id, "accept");
check("cannot accept a request someone else got", r.status === 409, r.status);

// --- Lifecycle: request -> accept -> signaling -> end ----------------------
r = await signal(A, b.id, "request");
check("A requests B", r.status === 200);
let pb = await poll(B);
check("B receives the request from A's public id", pb.signals.some((s) => s.type === "request" && s.fromId === a.id));
r = await signal(B, a.id, "accept");
check("B accepts", r.status === 200);
r = await signal(A, b.id, "offer", offer);
check("paired users can exchange an offer", r.status === 200);
r = await signal(A, b.id, "offer", "not json");
check("malformed SDP payload rejected", r.status === 400, r.status);
r = await signal(C, a.id, "request");
check("busy target auto-declines", r.body.autoDeclined === true, JSON.stringify(r.body));
pa = await poll(A);
check("A sees B as busy on the map", pa.peers.find((p) => p.id === b.id)?.busy === true);
await signal(C, b.id, "end");
check(
  "a stranger cannot end someone else's call",
  (await poll(A)).peers.find((p) => p.id === b.id)?.busy === true,
);
r = await signal(A, b.id, "end");
check("A ends the call", r.status === 200);
pa = await poll(A);
check("busy is released after end", pa.peers.find((p) => p.id === b.id)?.busy === false);

// --- Leave frees the partner -----------------------------------------------
await signal(A, b.id, "request");
await signal(B, a.id, "accept");
await leave(A);
pb = await poll(B);
check("leave removes the dot immediately", !pb.peers.some((p) => p.id === a.id));
check("leave releases the partner's busy flag", pb.online === true && (await poll(B)).online === true);
const pc = await poll(C);
check("B is no longer busy after A left", pc.peers.find((p) => p.id === b.id)?.busy === false);
const gone = await poll(A);
check("poll after leave reports offline", gone.online === false);

// --- Block (Phase 4) -------------------------------------------------------
const D = randomUUID();
const E = randomUUID();
const d = await join(D, 40.7, -74.0);
const e = await join(E, 40.8, -73.9);
await signal(D, e.id, "request");
await signal(E, d.id, "accept");
const arcs = (await poll(C)).peers;
check(
  "paired dots expose who they're talking to (for map arcs)",
  arcs.find((p) => p.id === d.id)?.talkingTo === e.id,
);
await fetch(`${BASE}/api/block`, {
  method: "POST",
  body: JSON.stringify({ token: E, targetId: d.id }),
});
const pd = await poll(D);
check("blocked user is told the chat ended", pd.signals.some((s) => s.type === "end" && s.fromId === e.id));
check("block hides the blocker from the blocked", !pd.peers.some((p) => p.id === e.id));
check("block hides the blocked from the blocker", !(await poll(E)).peers.some((p) => p.id === d.id));
r = await signal(D, e.id, "request");
check("blocked user's requests auto-decline", r.body.autoDeclined === true, JSON.stringify(r.body));
await leave(D);
await leave(E);

clearInterval(keepAlive);

// --- Stale expiry (the original bug) ---------------------------------------
console.log("...waiting 17s for stale expiry (C keeps polling, B does not)");
for (let i = 0; i < 11; i++) {
  await sleep(1600);
  await poll(C);
}
const pc2 = await poll(C);
check("silent user's dot expires (not refreshed by others' polls)", !pc2.peers.some((p) => p.id === b.id));

await leave(B);
await leave(C);
console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
