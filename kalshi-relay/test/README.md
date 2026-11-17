# Relay tests (offline)

    npm i --no-save http_ece@1
    node test/sign.test.mjs   # Kalshi request signing: RSA PKCS#1/PKCS#8, 4096-bit, Ed25519
    node test/push.test.mjs   # Web Push: payload decrypts with a standard library, VAPID JWT verifies
    node test/book.test.mjs   # fetchBook: Coinbase 429 backoff + Kraken fallback
    node test/settle.test.mjs # settle-aware read: sanity checks + relay/app copies identical
    node test/yes.test.mjs    # Kalshi Yes price parsing
