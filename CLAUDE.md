# CLAUDE.md

This repo is Devin's GitHub Pages site. Most active work is the **Live Walls Chart** trading app and its
Cloudflare relay. The rest of the site (`index.html`, `portfolio.html`, `studies.html`, `projects/`) is an
older personal site; leave it alone unless asked.

## What's here

| Path | What it is | How it ships |
|---|---|---|
| `walls/` | The app: one self-contained `index.html` (HTML/CSS/JS, canvas chart), `sw.js` (service worker: app-shell cache + push handler), `manifest.webmanifest`, icons | GitHub Pages → https://devincamp.github.io/walls/ (installed on iPhone/Mac as a Home Screen / Dock web app) |
| `kalshi-relay/` | Cloudflare Worker + Durable Object (`src/index.js`, `wrangler.toml`) | Cloudflare Workers Builds auto-deploys on every push to `master` → https://kalshi-relay.refernocarnage13.workers.dev |
| `walls-desktop/` | Electron wrapper for the Windows app (`main.js`, `package.json`, `build.sh`) | `./build.sh` → `out/LiveWallsChart-Windows.zip`, sent to the user by hand |
| `tools/walls-test/` | Headless mock test of the app (fake Coinbase data, no network) | dev only |
| `kalshi-relay/test/` | Offline tests for Kalshi request signing and Web Push encryption | dev only |

## The app (`walls/index.html`)

- Live candles (10s, 1m, 5m, 15m, 1h) with order-book **buy/sell walls**: dashed wall lines, an order-book depth panel, and a heatmap of resting orders over time. Coins: BTC, ETH, SOL, XRP, DOGE.
- **Price source switch: Coinbase | Kalshi.**
  - Coinbase: Advanced Trade public WebSocket (`level2`, `market_trades`) plus Exchange REST candles. 10s candles are built from recent `/trades` pages, then kept live.
  - Kalshi: Kalshi's crypto markets settle on CF Benchmarks RTIs (BRTI for BTC). Without the relay, the app *estimates* the index from 7 constituent exchanges' public books (Coinbase, Kraken, Bitstamp, Gemini, Crypto.com, Bullish, LMAX), following the published RTI methodology (`computeRTI`). This was checked against the official BRTI at about ±$1–2. With the relay, it shows the **official** values (green OFFICIAL badge).
  - Kalshi mode shows the 15-min target (average of the 60 s before the window opened), the last-60 s average, countdowns, a gold target line, and the **past 15-min results** panel.
- **Up/down alerts**: buyers vs sellers within ±0.25% of mid on the Coinbase book, EMA-smoothed, with thresholds by sensitivity (low 70/30, med 64/36, high 58/42). Fires once, re-arms when the reading crosses back toward 50%, 5-min cooldown. Draws ▲/▼ markers, notifies in-app, and sends closed-app push via the relay. The relay uses the **same rules**; keep the two in sync.
- Settings persist in `localStorage` (`walls.prefs`, `walls.relay`, `walls.sigprefs`, `walls.push`, `walls.sig.<product>`).
- Debug handle: `window.__walls` = `{ S, IX, EX, SIG, RES }`.
- **When you change `walls/index.html`, bump `CACHE` in `walls/sw.js`** (`walls-vN`) so installed apps pick up the update. The in-app ⟳ button also forces it.

## The relay (`kalshi-relay/src/index.js`)

One Durable Object ("main"):
- Holds a signed WebSocket to Kalshi (`cfbenchmarks_value`, index ids in `INDICES`) and re-broadcasts official values to apps on `/ws`. Apps send `{auth: RELAY_CODE, ids:[...]}` first. The relay keeps 2 h of per-second history and sends 20 min on connect.
- Alarm every 15 s: keeps the Kalshi feed alive, reads the Coinbase public product book for `PRED_COINS` plus subscribed coins, runs the alert rules, and sends Web Push (VAPID key generated and stored in DO storage; aes128gcm encryption implemented with WebCrypto). It also records the app's "read" one minute before each 15-min close.
- Routes: `/status` (public, no secrets), `/vapid`, and with `Authorization: Bearer <RELAY_CODE>`: `/subscribe`, `/unsubscribe`, `/test-push`, `/signals`, `/results` (Kalshi settled KXBTC15M-style markets merged with recorded reads), `/paper` (paper-trading report), `/live` (live-trading report), and POST `/live/stop`, `/live/resume`.
- Secrets live only in Cloudflare (Settings → Variables and Secrets): `KALSHI_KEY_ID`, `KALSHI_PRIVATE_KEY`, `RELAY_CODE`. **Never commit keys or put them in the app.** The repo is public.
- **Settle model + checkpoints**: `settleModel` (identical copies in the relay and the app; `test/settle.test.mjs` checks) gives the odds the final-60 s average ends above the target. The relay records it at 5/3/2/1 min before each close with Kalshi's price (`cp:<coin>`).
- **Paper trading** (BTC, no money): `paper3:BTC-USD` uses Kalshi's live order book (`/markets/<ticker>/orderbook`), fills at ask + 1¢ limited to displayed size, skips stale quotes and the 20 min after a relay restart. `paper2` (market-list prices) is retired but kept for comparison.
- **Kalshi API**: orders use the V2 endpoint `POST /portfolio/events/orders` (single YES book: `side` bid = buy YES, ask = buy NO at 1 − price; `price`/`count` are strings; prices must sit on the market's `price_ranges` grid). The old `/portfolio/orders` returns 410. Fills use `outcome_side`, `count_fp`, `*_price_dollars`, `fee_cost`. Docs: https://docs.kalshi.com/llms.txt. The market list's bid/ask lags the order book; use the book. `/status` shows `version` (bump `RELAY_VERSION` on relay changes).
- **Exchange shards**: Kalshi splits each account's money across exchange shards; crypto markets (KXBTC15M) are on shard 2 (`exchange_index` on the market). API orders only draw on their market's shard and never move money; the Kalshi app moves it automatically for its own orders. The bot sizes from the shard-2 balance (`balance_breakdown`); funding it is the user's job (kalshi.com/account/exchange-indexes). The trading key deliberately has no transfer permission.
- **App buys (real money)**: Kalshi mode has a round panel (distance to target, countdown, live Up/Down from `GET /quote`) and a trade bar (Spend chips, BUY UP / BUY DOWN, second tap confirms) that calls `POST /trade` with the trading key. Guards: `MANUAL_MAX_SPEND` per tap ($10), `MANUAL_DAILY_MAX` ($50), IOC at most the shown price + 2¢, round must have >10 s left, crypto-shard balance check; `MANUAL_TRADING=off` disables. Orders in DO storage `manual`, report `GET /manual`. Anyone with `RELAY_CODE` can buy within those caps.
- **Desk** (app, Kalshi mode → "Desk" button): full-screen trading desk: bot pot, current round + model edge, signal-engine stages, decision log, scoreboard, Stop button. The decision log comes from `GET /desklog` (DO storage `desklog`, last 300): the relay logs every BTC checkpoint outcome with its reason (SKIP / PAPER / HOLD / BET / MISS / ERROR), settlements (SETTLE with P&L) and app buys (APP).
- **Candle strategies** (`CANDLE_STRATS`: momentum, engulfing, hammer, breakout, fade): 1-minute candles built from the relay's per-second BRTI (`candles1m`, closed minutes only). A signal tilts the model's odds 8 pts its way (`CANDLE_TILT`) and bets only if that side then has the usual 3-pt edge (`candleDecide`). Each paper-trades in `cpaper:<name>` (one bet per round), shown in `/paper` `strategies`, the results panel and the Desk; logged as CANDLE. Secret `LIVE_STRATEGY=<name>` makes the live bot trade that strategy instead of the model (unknown/unset = model).
- **Luck check + daily standings**: `luckCheck` adds `breakEven` (average price + fee of settled bets), `z` and a `verdict` (edge / losing only at |z| ≥ 2 with 30+ bets, else luck / too few) to each `/paper` `strategies` row; the Desk table shows them, with the model row as the baseline. `dailySummary` pushes yesterday's flat-stake standings to every push device once per UTC day (10 min past `DAILY_SUMMARY_UTC_HOUR`, default 0; `DAILY_SUMMARY=off` stops it), logs DAILY on the Desk, and keeps the last one in `/paper` `dailySummary`.
- **Live trading (real money, BTC)**: OFF unless the Secrets `LIVE_TRADING=on` and a separate trading key `KALSHI_TRADE_KEY_ID` / `KALSHI_TRADE_PRIVATE_KEY` are set; the feed key stays read-only. Same signal and guards as paper, 5-min checkpoint only by default, IOC limit orders, one per window, `$LIVE_BUDGET` pot (default $25), ≤10% per bet, daily loss stop, floor, order cap, Stop button in the app. Set these as Secrets, not plain vars: a deploy from `wrangler.toml` can wipe dashboard vars. Never enable or change live-trading limits without the user asking.
- Kalshi signing: `timestamp_ms + METHOD + path`, RSA-PSS SHA-256 (salt 32) or Ed25519. PKCS#1 keys are wrapped to PKCS#8.
- Local dev: `npx wrangler dev` with a `.dev.vars` file (never commit it). Kalshi's API and Coinbase can't be reached from some sandboxes; tests in `kalshi-relay/test/` run offline.
- After a deploy, the old Durable Object instance can keep serving for a minute or two.

## Gotchas learned the hard way

- Browsers can't send Kalshi's auth headers on a WebSocket, and Kalshi's REST API is CORS-blocked for browsers. Anything Kalshi-related goes through the relay.
- iPhone: push only works for the Home Screen web app (iOS 16.4+), and permission has to be requested from a tap.
- Electron (`file://`) has no service worker or push; in-app notifications there use `new Notification()`.
- Coinbase Exchange `/trades` paging: the `CB-AFTER` header isn't exposed to browsers, so page with `after=<oldest trade_id>`.
- Coinbase rate-limits the relay's book reads (HTTP 429; Cloudflare IPs are shared). `fetchBook` backs off 2 min and falls back to Kraken's public depth. BTC is read every tick; other coins only near 15-min closes or when someone is subscribed to them. Keep the per-tick request count low.
- Windows `.exe` icon: set with `resedit` (pure JS), since `--icon` would need wine.

## Testing before you push

    python tools/walls-test/run_mock.py 1400 800 0 /tmp/desk.png      # expect ~60 fps and no console errors
    python tools/walls-test/run_mock.py 393 852 1 /tmp/phone.png k
    node kalshi-relay/test/sign.test.mjs && node kalshi-relay/test/push.test.mjs

Pushing to `master` publishes the app (GitHub Pages, about 1 min) **and** redeploys the relay (Cloudflare). Test first.

## Commits

Commit as `DevinCamp <DevinCamp@users.noreply.github.com>`.
