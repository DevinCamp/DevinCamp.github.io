// Desk decision log: every BTC checkpoint, bet, fill and settlement is logged with its reason. Offline, mocked Kalshi.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert"; import crypto from "crypto";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const f = path.join(os.tmpdir(), "relay_mod_desk.mjs"); fs.writeFileSync(f, src);
const M = await import(f);
const { Relay, paperEdge } = M;
M._setLiveRetryMs(0);

// paperEdge: best side and edge even below the betting threshold
const e = paperEdge(0.5, 0.49, 0.51); assert(e && e.edge < 0.03, JSON.stringify(e));
assert.equal(paperEdge(0.8, null, 0.5), null);

const pem = k => k.export({ type: "pkcs8", format: "pem" });
const env = { LIVE_TRADING: "on", KALSHI_TRADE_KEY_ID: "t", KALSHI_TRADE_PRIVATE_KEY: pem(crypto.generateKeyPairSync("ed25519").privateKey), RELAY_CODE: "code123" };
const cl = Math.ceil(Date.now() / 1000 / 900) * 900 + 900;
const series = level => { const pts = []; for (let t = cl - 900 - 200; t <= cl - 60; t++) pts.push([t, (t < cl - 900 ? 100000 : level) + Math.sin(t)]); return pts; };
const mk = (e2, level) => { const mem = new Map(), r = Object.create(Relay.prototype); r.env = e2; r.bootAt = Date.now() - 3600e3; r.hist = new Map([["BRTI", series(level)]]);
  r.ctx = { storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); }, getAlarm: async () => 1, setAlarm: async () => {} }, getWebSockets: () => [] };
  return [r, mem]; };
const kalshi = (o = {}) => async (url, opt = {}) => {
  const u = String(url), method = opt.method || "GET", J = (x, s = 200) => new Response(JSON.stringify(x), { status: s });
  if (u.includes("/portfolio/events/orders") && method === "POST") { const n = JSON.parse(opt.body).count; return J({ order_id: "o1", fill_count: n + ".00", remaining_count: "0.00", average_fill_price: "0.5800", average_fee_paid: "0.0171" }, 201); }
  if (u.includes("/portfolio/balance")) return J({ balance: 5000 });
  if (u.includes("/portfolio/fills")) return J({ fills: [{ outcome_side: "yes", count_fp: "4.00", yes_price_dollars: "0.5800", no_price_dollars: "0.4200", fee_cost: "0.0700" }] });
  if (u.includes("/orderbook")) return J({ orderbook_fp: { yes_dollars: [[o.bid || "0.5500", "60"]], no_dollars: [[o.noBid || "0.4300", "80"]] } });
  if (u.includes("/markets/trades")) return J({ trades: [] });
  if (u.includes("status=settled")) return J({ markets: [{ close_time: new Date((o.settledClose || cl) * 1000).toISOString(), result: "yes" }] });
  return J({ markets: [{ ticker: "KXBTC15M-T", exchange_index: 2, close_time: new Date(cl * 1000).toISOString(), yes_bid_dollars: "0.5500", yes_ask_dollars: "0.5700" }] });
};
const log = mem => mem.get("desklog") || [];

// far above the target vs a 56c market: paper bet + live bet logged with reasons
let [r, mem] = mk(env, 100060); globalThis.fetch = kalshi();
await r.checkpoints("BTC-USD", cl - 300);
let l = log(mem);
assert.deepEqual(l.map(x => x.kind), ["PAPER", "BET"], JSON.stringify(l));
assert.match(l[0].what, /^YES @ 58¢ · 5-min check$/); assert.match(l[0].why, /model \d+% vs market 58¢ · edge \+\d+\.\d pts/);
assert.match(l[1].what, /^YES ×4 @ 58¢$/); assert.match(l[1].why, /real money/);

// at the target vs a 50c market: no edge -> SKIP with the best edge and the threshold
[r, mem] = mk(env, 100000); globalThis.fetch = kalshi({ bid: "0.4900", noBid: "0.4900" });
await r.checkpoints("BTC-USD", cl - 300);
l = log(mem); assert.equal(l.length, 1); assert.equal(l[0].kind, "SKIP");
assert.match(l[0].what, /^5-min check · model \d+% UP$/); assert.match(l[0].why, /best edge -?\d+\.\d pts \((YES|NO) @ \d+¢\) after fee \+ slippage < 3\.0 pts/);

// warm-up after a restart
[r, mem] = mk(env, 100060); r.hist.set("BRTI", r.hist.get("BRTI").filter(p => p[0] < cl - 700 || p[0] >= cl - 640)); globalThis.fetch = kalshi();
await r.checkpoints("BTC-USD", cl - 300);
assert.deepEqual(log(mem).map(x => [x.kind, x.why]), [["SKIP", "index history has a 61 s gap this round (relay restart or feed drop)"]]);

// stopped from the app: the live side logs a HOLD with the reason
[r, mem] = mk(env, 100060); mem.set("live", { halted: true, haltReason: "stopped from the app", orders: [] }); globalThis.fetch = kalshi();
await r.checkpoints("BTC-USD", cl - 300);
assert.deepEqual(log(mem).map(x => x.kind), ["PAPER", "HOLD"]); assert.match(log(mem)[1].why, /stopped from the app/);

// settlement of the bot's order is logged with P&L
[r, mem] = mk(env, 100060); globalThis.fetch = kalshi(); await r.checkpoints("BTC-USD", cl - 300);
const past = Math.floor(Date.now() / 1000 / 900) * 900 - 900, st = mem.get("live"); st.orders[0].close = past; mem.set("live", st);
globalThis.fetch = kalshi({ settledClose: past }); await r.liveSettle();
const s = log(mem).at(-1); assert.equal(s.kind, "SETTLE"); assert.match(s.what, /^YES ×4 · closed UP$/); assert.match(s.why, /^won · Kalshi fee \$0\.07$/); assert.equal(s.pnl, +(4 * 0.42 - 0.07).toFixed(2));

// app buys are logged too; the route returns newest first and needs the access code
[r, mem] = mk(env, 100060); globalThis.fetch = kalshi();
const close = Math.ceil((Date.now() / 1000 + 1) / 900) * 900;
globalThis.fetch = async (url, opt) => String(url).includes("orders?") || !String(url).includes("status=open") ? kalshi()(url, opt)
  : new Response(JSON.stringify({ markets: [{ ticker: "KXBTC15M-T", exchange_index: 2, close_time: new Date(close * 1000).toISOString() }] }));
const t = await r.manualTrade({ coin: "BTC-USD", side: "yes", spend: 5, price: 0.57, close }); assert.equal(t.ok, true, t.error);
assert.equal(log(mem).at(-1).kind, "APP"); assert.match(log(mem).at(-1).what, /^BUY UP ×\d+ @ 58¢$/);
for (let i = 0; i < 3; i++) await r.deskLog({ kind: "SKIP", what: "n" + i, why: "x" });
const call = (code) => r.fetch(new Request("https://relay.test/desklog", { headers: { authorization: "Bearer " + code } }));
assert.equal((await call("nope")).status, 403);
const j = await (await call("code123")).json(); assert.equal(j.log[0].what, "n2", "newest first"); assert.equal(j.log.length, 4);
console.log("desk log tests passed");
