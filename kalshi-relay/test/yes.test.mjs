// yesFromMarket: Kalshi Yes price from dollar or cent fields. Offline.
import fs from "fs"; import os from "os"; import path from "path"; import assert from "assert";
const src = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8").replace(/^import .*$/m, "class DurableObject {}");
const f = path.join(os.tmpdir(), "relay_mod_yes.mjs"); fs.writeFileSync(f, src);
const { yesFromMarket } = await import(f);
assert.equal(yesFromMarket({ yes_bid_dollars: "0.9000", yes_ask_dollars: "0.9400" }), 0.92);
assert.equal(yesFromMarket({ yes_bid: 40, yes_ask: 44 }), 0.42);
assert.equal(yesFromMarket({ yes_bid: 1, yes_ask: 2 }), 0.015);       // 1-2 cents must not read as 100%
assert.equal(yesFromMarket({ yes_bid: 0, yes_ask: 0, last_price: 55 }), 0.55);
assert.equal(yesFromMarket({}), null);
console.log("yes tests passed");
