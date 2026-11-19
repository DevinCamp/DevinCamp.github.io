// Paper trading: decision, fills (slippage + depth), flat and compounding replay, breakdown, and relay plumbing. Offline.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const f = path.join(os.tmpdir(), "relay_mod_paper.mjs"); fs.writeFileSync(f, src);
const { paperDecide, paperSim, paperBreakdown, yesFromMarket, Relay } = await import(f);

// ---- decision
assert.equal(paperDecide(0.5, 0.49, 0.51), null, "no edge, no bet");
assert.equal(paperDecide(0.95, 0.94, 0.96), null, "market already prices it: fee + slippage eat the edge");
const y = paperDecide(0.80, 0.55, 0.57, 40, 90); assert.equal(y.side, "yes"); assert.equal(y.price, 0.58, "fills at ask + 1 cent"); assert.equal(y.depth, 40);
const n = paperDecide(0.20, 0.55, 0.57, 40, 90); assert.equal(n.side, "no"); assert.equal(n.price, 0.46); assert.equal(n.depth, 90, "No side is limited by the Yes bid size");
assert.equal(paperDecide(0.8, null, 0.5), null, "needs a two-sided quote");

// ---- replay
const bet = (close, out, o = {}) => ({ close, t: 180, side: "yes", price: 0.5, fee: 0.0175, q: 0.7, edge: 0.18, kelly: 0.5, depth: 1000, out, ...o });
const cost = 0.5175;
const flatWin = paperSim([bet(1e9, "up"), bet(1e9 + 900, null)], { flat: 25 });          // unsettled ignored
assert.equal(flatWin.bets, 1); assert(Math.abs(flatWin.pnl - 25 / cost * (1 - cost)) < 0.01);
const flatLoss = paperSim([bet(1e9, "down")], { flat: 25 }); assert(Math.abs(flatLoss.pnl + 25) < 0.01);
const thin = paperSim([bet(1e9, "up", { depth: 5 })], { flat: 25 });                       // only 5 contracts on offer
assert(Math.abs(thin.pnl - 5 * (1 - cost)) < 0.01, "displayed depth caps the fill");
const unk = paperSim([bet(1e9, "up", { depth: null })], { flat: 1000 }); assert(Math.abs(unk.pnl - 20 * (1 - cost)) < 0.01, "unknown depth assumes 20 contracts");
const big = paperSim([bet(1e9, "up", { depth: 30 })], { cap: 0.2 }, 100000); assert(big.pnl < 30 * (1 - cost) + 0.01, "a huge account can't buy more than is displayed");
const l = paperSim([bet(1e9, "down")], { cap: 0.20 }); assert(Math.abs(l.equity - 800) < 1e-6 && Math.abs(l.maxDD - 0.2) < 1e-6);
const stop = paperSim([bet(1e9, "down"), bet(1e9 + 900, "down"), bet(1e9 + 1800, "down")], { cap: 0.20 });
assert.equal(stop.bets, 2, "daily 20% loss stop");

// ---- breakdown
const bd = paperBreakdown([bet(1e9, "up", { t: 300, price: 0.2 }), bet(1e9 + 900, "down", { t: 60, price: 0.9 })]);
assert.deepEqual(bd.map(r => r.key).sort(), ["p<30", "p>70", "t300", "t60"]);
assert.equal(bd.find(r => r.key === "p<30").wins, 1);
assert.equal(yesFromMarket({ yes_bid: 40, yes_ask: 44 }), 0.42);

// ---- relay plumbing with fake storage and mocked Kalshi
const mem = new Map();
const relay = Object.create(Relay.prototype);
relay.ctx = { storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); } } };
const close = Math.floor(Date.now() / 1000 / 900) * 900 - 900;               // a window that closed ~10-25 min ago
const quote = { yes: 0.56, bid: 0.55, ask: 0.57, askSize: 80, bidSize: 60 };
await relay.paperBet(close, 180, 0.85, quote);
await relay.paperBet(close, 120, 0.85, quote);                                // same window: ignored
await relay.paperBet(close + 900, 180, 0.50, { yes: 0.50, bid: 0.49, ask: 0.51 });   // no edge: no bet
assert.equal(mem.get("paper2:BTC-USD").length, 1);
globalThis.fetch = async () => new Response(JSON.stringify({ markets: [{ close_time: new Date(close * 1000).toISOString(), result: "yes" }] }));
const rep = await relay.paperReport();
assert.equal(rep.open, 0); assert.equal(rep.settled, 1);
const flat = rep.sims.find(x => x.flat); assert.equal(flat.bets, 1); assert(flat.pnl > 0 && flat.pnl <= 80 * 0.42 + 0.01);

// checkpoint: records a cp row, counts quotes/sizes, and places a paper bet
const mem2 = new Map(), r2 = Object.create(Relay.prototype);
r2.ctx = { storage: { get: async k => mem2.get(k), put: async (k, v) => { mem2.set(k, JSON.parse(JSON.stringify(v))); } } };
const cl = Math.floor(Date.now() / 1000 / 900) * 900, now = cl - 180, pts = [];
for (let t = cl - 900 - 200; t <= now; t++) pts.push([t, (t < cl - 900 ? 100000 : 100060) + Math.sin(t)]);
r2.hist = new Map([["BRTI", pts]]);
globalThis.fetch = async () => new Response(JSON.stringify({ markets: [{ close_time: new Date(cl * 1000).toISOString(), yes_bid_dollars: "0.5500", yes_ask_dollars: "0.5700", yes_bid_size_fp: "60", yes_ask_size_fp: "80" }] }));
await r2.checkpoints("BTC-USD", now);
const cp = mem2.get("cp:BTC-USD"); assert(cp && cp.length === 1 && cp[0].t === 180 && cp[0].yes === 0.56, "checkpoint row saved");
const st = mem2.get("paperstat2"); assert.deepEqual([st.cps, st.quotes, st.twoSided, st.sized], [1, 1, 1, 1]);
const pb = mem2.get("paper2:BTC-USD"); assert(pb && pb.length === 1 && pb[0].side === "yes" && pb[0].depth === 80, "model far above target vs a 56c Yes price: buys Yes");
console.log("paper tests passed");
