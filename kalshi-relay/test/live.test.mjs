// Live trading: sizing, safety gates, order placement and settlement, all offline with a mocked Kalshi.
// No real orders: fetch is replaced and the keys are generated here.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert"; import crypto from "crypto";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const f = path.join(os.tmpdir(), "relay_mod_live.mjs"); fs.writeFileSync(f, src);
const M = await import(f);
const { liveSize, liveGate, liveResult, liveAccount, parseBalance, parseFilled, parseFills, Relay } = M;

// ---- sizing: min(max stake, half Kelly) of the pot, whole contracts, never more than is free or on offer
const fee = p => 0.07 * p * (1 - p);
const d = { price: 0.58, kelly: 0.2, depth: 80 };
assert.equal(liveSize(25, 25, d, 0.10), Math.floor(2.5 / (0.58 + fee(0.58))));          // $2.50 stake -> 4 contracts
assert.equal(liveSize(25, 1, d, 0.10), 1, "only $1 free");
assert.equal(liveSize(25, 25, { ...d, depth: 2 }, 0.10), 2, "only 2 on offer");
assert.equal(liveSize(25, 25, { ...d, kelly: 0.02 }, 0.10), 0, "tiny edge: stake below one contract");
assert.equal(liveSize(25, 25, { ...d, price: 0.2, kelly: 0.5 }, 0.20), Math.floor(5 / (0.2 + fee(0.2))), "max stake caps a big Kelly");

// ---- results and the pot
const w = liveResult({ side: "yes", out: "up", filled: 4, limit: 0.58 });
assert.equal(w.won, true); assert.equal(w.pnl, +(4 * 0.42 - Math.ceil(fee(0.58) * 4 * 100) / 100).toFixed(2));
const l = liveResult({ side: "no", out: "up", filled: 4, limit: 0.4, avg: 0.39 });
assert.equal(l.won, false); assert(l.pnl < -1.56 && l.pnl > -1.7);
assert.equal(liveResult({ side: "yes", out: "up", filled: 0, limit: 0.5 }).pnl, 0, "unfilled order: no P&L");
const cfg = { on: true, hasKey: true, budget: 25, maxStake: 0.1, dailyLoss: 0.2, floor: 10, maxOrdersDay: 30, horizons: [300] };
const nowS = Math.floor(Date.now() / 1000);
const acct = liveAccount({ orders: [{ close: nowS, out: "up", pnl: 3, filled: 2, won: true }, { close: nowS, out: null, filled: 2, limit: 0.5, status: "executed" }] }, cfg);
assert.equal(acct.equity, 28); assert(acct.available < 28 && acct.available > 26.9, "open order ties up its cost");

// ---- gates
assert.match(liveGate({ orders: [] }, { ...cfg, on: false }, Date.now()), /not on/);
assert.match(liveGate({ orders: [] }, { ...cfg, hasKey: false }, Date.now()), /trading key/);
assert.match(liveGate({ halted: true, haltReason: "stopped from the app", orders: [] }, cfg, Date.now()), /stopped/);
assert.match(liveGate({ orders: [{ close: nowS, out: "down", pnl: -16, filled: 9 }] }, cfg, Date.now()), /floor/);
assert.match(liveGate({ orders: [{ close: nowS, out: "down", pnl: -5, filled: 9 }] }, cfg, Date.now()), /daily loss/);
assert.match(liveGate({ orders: Array.from({ length: 30 }, (_, i) => ({ close: nowS - i, at: nowS, status: "canceled", filled: 0 })) }, cfg, Date.now()), /order limit/);
assert.equal(liveGate({ orders: [] }, cfg, Date.now()), null);

// ---- parsers
assert.equal(parseBalance({ balance: 2512 }), 25.12); assert.equal(parseBalance({ balance_dollars: "25.12" }), 25.12);
assert.equal(parseFilled({ fill_count: 3 }, 4), 3); assert.equal(parseFilled({ remaining_count: 1, initial_count: 4 }, 4), 3);
assert.equal(parseFilled({ status: "executed" }, 4), 4); assert.equal(parseFilled({ status: "canceled" }, 4), 0);
assert.deepEqual(parseFills({ fills: [{ side: "yes", action: "buy", count: 2, yes_price: 57 }, { side: "yes", action: "buy", count: 2, yes_price: 59 }, { side: "no", action: "buy", count: 9, no_price: 40 }] }, "yes"), { count: 4, avg: 0.58 });
assert.equal(parseFills({ fills: [] }, "yes"), null);

// ---- full flow with a mocked Kalshi
const pem = k => k.export({ type: "pkcs8", format: "pem" });
const feedKey = pem(crypto.generateKeyPairSync("ed25519").privateKey), tradeKey = pem(crypto.generateKeyPairSync("ed25519").privateKey);
const liveEnv = { LIVE_TRADING: "on", KALSHI_TRADE_KEY_ID: "trade-key-id", KALSHI_TRADE_PRIVATE_KEY: tradeKey, KALSHI_KEY_ID: "feed-key-id", KALSHI_PRIVATE_KEY: feedKey };
const cl = Math.ceil(Date.now() / 1000 / 900) * 900 + 900, pts = [];
for (let t = cl - 900 - 200; t <= cl - 60; t++) pts.push([t, (t < cl - 900 ? 100000 : 100060) + Math.sin(t)]);
const mk = env => { const mem = new Map(), r = Object.create(Relay.prototype); r.env = env; r.bootAt = Date.now() - 3600e3;
  r.hist = new Map([["BRTI", pts]]); r.ctx = { storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); } } }; return [r, mem]; };
let calls = [];
const kalshi = (over = {}) => async (url, opt = {}) => {
  const u = String(url), method = opt.method || "GET"; calls.push({ u, method, headers: opt.headers || {}, body: opt.body ? JSON.parse(opt.body) : null });
  const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (u.includes("/portfolio/orders") && method === "POST") return over.order || J({ order: { order_id: "o1", status: "executed", fill_count: 4 } });
  if (u.includes("/portfolio/balance")) return J({ balance: over.balance ?? 5000 });
  if (u.includes("/portfolio/fills")) return J({ fills: [{ side: "yes", action: "buy", count: 4, yes_price: 58 }] });
  if (u.includes("/orderbook")) return J({ orderbook: { yes: [[55, 60]], no: [[43, 80]] } });
  if (u.includes("status=settled")) return J({ markets: [{ close_time: new Date((over.settledClose || cl) * 1000).toISOString(), result: over.result || "yes" }] });
  return J({ markets: [{ ticker: "KXBTC15M-T", close_time: new Date(cl * 1000).toISOString(), yes_bid_dollars: "0.5500", yes_ask_dollars: "0.5700" }] });
};
const posts = () => calls.filter(c => c.method === "POST");

// on: places one signed IOC buy at the 5-minute checkpoint
let [r, mem] = mk(liveEnv); calls = []; globalThis.fetch = kalshi();
await r.checkpoints("BTC-USD", cl - 300);
assert.equal(posts().length, 1, "one order");
const p0 = posts()[0];
assert.deepEqual([p0.body.ticker, p0.body.side, p0.body.action, p0.body.type, p0.body.yes_price, p0.body.time_in_force, p0.body.client_order_id],
  ["KXBTC15M-T", "yes", "buy", "limit", 58, "immediate_or_cancel", `walls-${cl}-300`]);
assert.equal(p0.body.count, Math.floor(2.5 / (0.58 + fee(0.58))), "10% of the $25 pot");
assert.equal(p0.headers["KALSHI-ACCESS-KEY"], "trade-key-id", "signed with the trading key, not the feed key");
let st = mem.get("live"); assert.equal(st.orders.length, 1); assert.equal(st.orders[0].filled, 4);

await r.checkpoints("BTC-USD", cl - 180);
assert.equal(posts().length, 1, "no second order in the same window");

// settles from Kalshi's result and our fills; the report shows the pot
const past = Math.floor(Date.now() / 1000 / 900) * 900 - 900;
st = mem.get("live"); st.orders[0].close = past; mem.set("live", st); globalThis.fetch = kalshi({ settledClose: past });
const rep = await r.liveReport();
assert.equal(rep.orders[0].out, "up"); assert.equal(rep.orders[0].won, true); assert.equal(rep.orders[0].avg, 0.58);
assert(rep.realized > 1.5 && rep.realized < 1.7); assert.equal(rep.balance, 50); assert.equal(rep.on, true);

// off by default: no orders, no trading-key calls
[r, mem] = mk({ ...liveEnv, LIVE_TRADING: undefined }); calls = []; globalThis.fetch = kalshi();
await r.checkpoints("BTC-USD", cl - 300);
assert.equal(posts().length, 0); assert(!calls.some(c => c.u.includes("/portfolio/")), "never touches the account when off");

// no trading key: nothing, even with LIVE_TRADING on
[r, mem] = mk({ ...liveEnv, KALSHI_TRADE_KEY_ID: undefined }); calls = []; globalThis.fetch = kalshi();
await r.checkpoints("BTC-USD", cl - 300); assert.equal(posts().length, 0);

// only the configured horizons (default 5 min)
[r, mem] = mk(liveEnv); calls = []; globalThis.fetch = kalshi();
await r.checkpoints("BTC-USD", cl - 180); assert.equal(posts().length, 0, "3-min checkpoint doesn't trade by default");

// stopped from the app
[r, mem] = mk(liveEnv); mem.set("live", { halted: true, haltReason: "stopped from the app", orders: [] }); calls = []; globalThis.fetch = kalshi();
await r.checkpoints("BTC-USD", cl - 300); assert.equal(posts().length, 0); assert.match(mem.get("live").lastSkip, /stopped/);

// Kalshi balance below the stake: sizes down to what the account holds
[r, mem] = mk(liveEnv); calls = []; globalThis.fetch = kalshi({ balance: 70 });
await r.checkpoints("BTC-USD", cl - 300); assert.equal(posts()[0].body.count, 1, "$0.70 in the account buys one contract");

// rejected order: recorded as an error, no exposure, no retry in that window
[r, mem] = mk(liveEnv); calls = []; globalThis.fetch = kalshi({ order: new Response('{"error":"bad"}', { status: 400 }) });
await r.checkpoints("BTC-USD", cl - 300); st = mem.get("live");
assert.equal(st.orders[0].status, "error"); assert.match(st.lastErr, /400/); assert.equal(liveAccount(st, cfg).openCost, 0);
await r.checkpoints("BTC-USD", cl - 180); assert.equal(posts().length, 1);

console.log("live tests passed");

// ---- Stop / Resume through the real request handler (access code required, POST only)
{
  const [rr, mm] = mk({ ...liveEnv, RELAY_CODE: "code123", KALSHI_KEY_ID: undefined });   // no feed key: skips the upstream socket
  rr.ctx.storage.getAlarm = async () => 1; rr.ctx.storage.setAlarm = async () => {}; rr.ctx.getWebSockets = () => [];
  globalThis.fetch = kalshi();
  const call = (p, method = "POST", code = "code123") => rr.fetch(new Request("https://relay.test" + p, { method, headers: { authorization: "Bearer " + code } }));
  assert.equal((await call("/live/stop", "POST", "wrong")).status, 403, "needs the access code");
  assert.equal((await call("/live/stop", "GET")).status, 405, "GET can't stop or resume");
  let j = await (await call("/live/stop")).json(); assert.equal(j.halted, true); assert.match(j.gate, /stopped/);
  assert.equal(mm.get("live").halted, true);
  calls = []; await rr.checkpoints("BTC-USD", cl - 300); assert.equal(posts().length, 0, "no orders while stopped");
  j = await (await call("/live/resume")).json(); assert.equal(j.halted, false); assert.equal(j.gate, null);
  j = await (await call("/live", "GET")).json(); assert.equal(j.on, true); assert.equal(j.budget, 25);
}
console.log("live stop/resume tests passed");
