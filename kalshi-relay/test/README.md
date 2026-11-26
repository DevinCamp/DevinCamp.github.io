# Relay tests (offline)

    npm i --no-save http_ece@1
    node test/sign.test.mjs   # Kalshi request signing: RSA PKCS#1/PKCS#8, 4096-bit, Ed25519
    node test/push.test.mjs   # Web Push: payload decrypts with a standard library, VAPID JWT verifies
    node test/book.test.mjs   # fetchBook: Coinbase 429 backoff + Kraken fallback
    node test/settle.test.mjs # settle-aware read: sanity checks + relay/app copies identical
    node test/yes.test.mjs    # Kalshi Yes price parsing
    node test/paper.test.mjs  # paper trading: bet decision, sizing, replay
    node test/live.test.mjs   # live trading: sizing, safety gates, signed orders, settlement, stop/resume (mocked Kalshi)
    node test/manual.test.mjs # app quote + BUY UP/DOWN: caps, price guard, shard balance, settlement (mocked Kalshi)
    node test/desk.test.mjs   # Desk decision log: skips with reasons, paper/live bets, holds, settlements, app buys, /desklog route
    node test/candles.test.mjs # candle strategies: 1-min candles, each pattern, betting rule, paper records, LIVE_STRATEGY
