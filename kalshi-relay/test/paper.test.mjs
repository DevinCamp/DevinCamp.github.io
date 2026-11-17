// Paper trading maths: bet decision, Kelly sizing, equity replay. Offline.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const f = path.join(os.tmpdir(), "relay_mod_paper.mjs"); fs.writeFileSync(f, src);
const { paperDecide, paperSim, yesFromMarket } = await import(f);
assert.equal(paperDecide(0.5, 0.49, 0.51), null, "no edge, no bet");
assert.equal(paperDecide(0.95, 0.94, 0.96), null, "market already prices it: the fee eats the edge");
const y = paperDecide(0.80, 0.55, 0.57); assert.equal(y.side, "yes"); assert(y.edge > 0.2 && y.kelly > 0 && y.price === 0.57);
const n = paperDecide(0.20, 0.55, 0.57); assert.equal(n.side, "no"); assert.equal(n.price, 0.45);
assert.equal(paperDecide(0.8, null, 0.5), null, "needs a two-sided quote");
// replay: cap limits the stake, wins and losses move equity, unsettled bets ignored
const bet = (close, out, side = "yes") => ({ close, side, price: 0.5, fee: 0.0175, q: 0.7, edge: 0.18, kelly: 0.5, out });
const w = paperSim([bet(1e9, "up"), bet(1e9 + 900, null)], 0.10);
assert.equal(w.bets, 1); assert(w.equity > 1000 && w.equity < 1000 * 1.11 * 1.01, "10% cap on a ~2x payout gains ~10%");
const l = paperSim([bet(1e9, "down")], 0.20); assert(Math.abs(l.equity - 800) < 1e-6 && Math.abs(l.maxDD - 0.2) < 1e-6);
const stop = paperSim([bet(1e9, "down"), bet(1e9 + 900, "down"), bet(1e9 + 1800, "down")], 0.20);
assert.equal(stop.bets, 2, "daily 20% loss stop: after 2 losses at 20% the day is over");   // 1000 -> 800 -> 640 (<= 800 floor)
assert.equal(yesFromMarket({ yes_bid: 40, yes_ask: 44 }), 0.42);
console.log("paper tests passed");

// Relay plumbing with fake storage and a mocked Kalshi: record a bet for both variants, settle it, report it.
const { Relay } = await import(f);
const mem = new Map();
const relay = Object.create(Relay.prototype);
relay.ctx = { storage: { get: async k => mem.get(k), put: async (k, v) => { mem.set(k, JSON.parse(JSON.stringify(v))); } } };
const close = Math.floor(Date.now() / 1000) - 600;                          // a window that closed 10 min ago
const quote = { yes: 0.56, bid: 0.55, ask: 0.57 };
await relay.paperBet("", close, 180, 0.85, quote);
await relay.paperBet("", close, 120, 0.85, quote);                           // same window: ignored
await relay.paperBet(":nb", close, 180, 0.50, { yes: 0.50, bid: 0.49, ask: 0.51 });   // no edge: no bet
assert.equal(mem.get("paper:BTC-USD").length, 1); assert.equal(mem.get("paper:BTC-USD:nb"), undefined);
globalThis.fetch = async () => new Response(JSON.stringify({ markets: [{ close_time: new Date(close * 1000).toISOString(), result: "yes" }] }));
let rep = await relay.paperReport();
assert.equal(rep.open, 0); const s10 = rep.sims.find(x => x.variant === "book" && x.cap === 0.1);
assert.equal(s10.bets, 1); assert.equal(s10.wins, 1); assert(s10.ret > 0.05 && s10.ret < 0.11);
assert.equal(rep.sims.find(x => x.variant === "nobook" && x.cap === 0.1).bets, 0);
assert.equal(rep.last[0].won, true);
console.log("paper plumbing tests passed");
