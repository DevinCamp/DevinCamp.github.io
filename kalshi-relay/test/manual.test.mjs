// App quote + manual buys (real money in production): caps, price guard, shard balance, signing, settlement.
// Offline: Kalshi is mocked and the keys are generated here.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert"; import crypto from "crypto";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const f = path.join(os.tmpdir(), "relay_mod_manual.mjs"); fs.writeFileSync(f, src);
const M = await import(f);
const { Relay, manualSpentToday } = M;
M._setLiveRetryMs(0);

const pem = k => k.export({ type: "pkcs8", format: "pem" });
const env = { KALSHI_TRADE_KEY_ID: "trade-key-id", KALSHI_TRADE_PRIVATE_KEY: pem(crypto.generateKeyPairSync("ed25519").privateKey), RELAY_CODE: "code123" };
const close = Math.ceil((Date.now() / 1000 + 1) / 900) * 900;       // the round that's open right now
const mk = e => { const mem = new Map(), r = Object.create(Relay.prototype); r.env = e;
  r.ctx = { storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); }, getAlarm: async () => 1, setAlarm: async () => {} }, getWebSockets: () => [] };
  return [r, mem]; };
let calls = [];
const kalshi = (o = {}) => async (url, opt = {}) => {
  const u = String(url), method = opt.method || "GET"; calls.push({ u, method, headers: opt.headers || {}, body: opt.body ? JSON.parse(opt.body) : null });
  const J = (x, s = 200) => new Response(JSON.stringify(x), { status: s });
  if (u.includes("/portfolio/events/orders") && method === "POST") { const n = JSON.parse(opt.body).count;
    return o.order || J({ order_id: "o1", fill_count: n + ".00", remaining_count: "0.00", average_fill_price: "0.4600", average_fee_paid: "0.0174", ts_ms: 1 }, 201); }
  if (u.includes("/portfolio/balance")) return J(o.balanceJson || { balance: 4926, balance_dollars: "49.26", balance_breakdown: [{ exchange_index: 0, balance: "9.26" }, { exchange_index: 2, balance: "40.00" }] });
  if (u.includes("/portfolio/fills")) return J({ fills: [{ outcome_side: "yes", book_side: "bid", count_fp: "8.00", yes_price_dollars: "0.4600", no_price_dollars: "0.5400", fee_cost: "0.1400" }] });
  if (u.includes("/orderbook")) return J({ orderbook_fp: { yes_dollars: [["0.4400", "500.00"]], no_dollars: [["0.5400", (o.askSize || "300.00")]] } });   // Up 46c, Down 56c
  if (u.includes("status=settled")) return J({ markets: [{ close_time: new Date((o.settledClose || close) * 1000).toISOString(), result: "yes" }] });
  return J({ markets: [{ ticker: "KXBTC15M-T", exchange_index: 2, close_time: new Date(close * 1000).toISOString(), yes_bid_dollars: "0.4400", yes_ask_dollars: "0.4600" }] });
};
const posts = () => calls.filter(c => c.method === "POST" && c.u.includes("/orders"));

// ---- quote: Up = YES ask, Down = 1 - YES bid, from the live book
let [r, mem] = mk(env); globalThis.fetch = kalshi();
const q = await r.appQuote("BTC-USD");
assert.deepEqual([q.close, q.ticker, q.up, q.down, q.upSize, q.downSize, q.canTrade, q.maxSpend], [close, "KXBTC15M-T", 0.46, 0.56, 300, 500, true, 10]);
calls = []; await r.appQuote("BTC-USD"); assert.equal(calls.length, 0, "quote cached for 1.5 s");
assert.equal((await mk({})[0].appQuote("BTC-USD")).canTrade, false, "no trading key: view only");

// ---- a $5 UP buy at the 46c the user saw
[r, mem] = mk(env); calls = []; globalThis.fetch = kalshi();
let res = await r.manualTrade({ coin: "BTC-USD", side: "yes", spend: 5, price: 0.46, close });
assert.equal(res.ok, true, res.error); assert.equal(posts().length, 1);
const b = posts()[0].body;
assert.deepEqual([b.ticker, b.side, b.price, b.time_in_force, b.self_trade_prevention_type], ["KXBTC15M-T", "bid", "0.4800", "immediate_or_cancel", "taker_at_cross"], "limit = seen + 2c");
assert.equal(b.count, String(Math.floor(5 / (0.48 + 0.07 * 0.48 * 0.52))), "spend / (limit + fee), whole contracts");
assert.equal(posts()[0].headers["KALSHI-ACCESS-KEY"], "trade-key-id");
assert.match(b.client_order_id, /^app-\d+-\d+$/);
let st = mem.get("manual"); assert.equal(st.orders[0].status, "filled"); assert.equal(st.orders[0].filled, +b.count); assert.equal(st.orders[0].avg, 0.46);

// DOWN: sell YES at 1 - (seen + 2c)
calls = []; res = await r.manualTrade({ coin: "BTC-USD", side: "no", spend: 5, price: 0.56, close });
assert.equal(res.ok, true); assert.deepEqual([posts()[0].body.side, posts()[0].body.price], ["ask", "0.4200"]);

// ---- guards
const bad = async (body, re, e = env, o = {}) => { const [rr] = mk(e); calls = []; globalThis.fetch = kalshi(o); const x = await rr.manualTrade(body); assert.equal(x.ok, false); assert.match(x.error, re); assert.equal(posts().length, 0, "no order sent"); };
const ok = { coin: "BTC-USD", side: "yes", spend: 5, price: 0.46, close };
await bad(ok, /No trading key/, { RELAY_CODE: "x" });
await bad(ok, /turned off/, { ...env, MANUAL_TRADING: "off" });
await bad({ ...ok, spend: 11 }, /most per tap is \$10/);
await bad({ ...ok, side: "maybe" }, /Bad request/);
await bad({ ...ok, price: 0.40 }, /price moved to 46¢/, env);                                   // saw 40c, now 46c (> 40 + 2)
await bad({ ...ok, close: close - 900 }, /about to close/);                                       // an old round
await bad(ok, /Only \$0\.50 on Kalshi's crypto shard/, env, { balanceJson: { balance: 4926, balance_breakdown: [{ exchange_index: 2, balance: "0.50" }] } });
await bad({ ...ok, spend: 0.3 }, /less than one contract/);

// daily cap: $50 by default, counting what actually filled
{
  const [rd, md] = mk(env); globalThis.fetch = kalshi();
  for (let i = 0; i < 5; i++) { const x = await rd.manualTrade({ ...ok, spend: 10 }); assert.equal(x.ok, true, x.error); }
  const spent = manualSpentToday(md.get("manual"), Date.now() / 1000); assert(spent > 45 && spent <= 50, String(spent));
  calls = []; const x = await rd.manualTrade({ ...ok, spend: 10 }); assert.equal(x.ok, false); assert.match(x.error, /Daily limit/); assert.equal(posts().length, 0);
}

// rejected by Kalshi: recorded as an error, doesn't count toward the daily cap
{
  const [re, me] = mk(env); globalThis.fetch = kalshi({ order: new Response('{"error":{"code":"insufficient_balance"}}', { status: 400 }) });
  const x = await re.manualTrade(ok); assert.equal(x.ok, false); assert.match(x.error, /insufficient_balance/);
  assert.equal(me.get("manual").orders[0].status, "error"); assert.equal(manualSpentToday(me.get("manual"), Date.now() / 1000), 0);
}

// ---- settlement + report
{
  const [rs, ms] = mk(env); globalThis.fetch = kalshi(); await rs.manualTrade(ok);
  const past = Math.floor(Date.now() / 1000 / 900) * 900 - 900, s0 = ms.get("manual"); s0.orders[0].close = past; ms.set("manual", s0);
  globalThis.fetch = kalshi({ settledClose: past });
  const rep = await rs.manualReport();
  assert.equal(rep.orders[0].out, "up"); assert.equal(rep.orders[0].won, true);
  assert.equal(rep.realized, +(8 * 0.54 - 0.14).toFixed(2), "8 contracts at 46c win 54c each, minus Kalshi's 14c fee");
  assert.equal(rep.canTrade, true); assert.equal(rep.dailyMax, 50);
}

// ---- through the real request handler: access code, POST only
{
  const [rh] = mk(env); globalThis.fetch = kalshi();
  const call = (p, method = "GET", body, code = "code123") => rh.fetch(new Request("https://relay.test" + p, { method, headers: { authorization: "Bearer " + code, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }));
  assert.equal((await call("/quote?coin=BTC-USD", "GET", null, "wrong")).status, 403);
  assert.equal((await call("/trade", "POST", ok, "wrong")).status, 403, "buying needs the access code");
  assert.equal((await call("/trade", "GET")).status, 405);
  assert.equal((await (await call("/quote?coin=BTC-USD")).json()).up, 0.46);
  calls = []; const t = await (await call("/trade", "POST", ok)).json(); assert.equal(t.ok, true); assert.equal(posts().length, 1);
  assert.equal((await (await call("/manual")).json()).orders.length, 1);
}
console.log("manual trading tests passed");
