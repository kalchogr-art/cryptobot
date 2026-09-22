# CryptoBot

CryptoBot is a Cloudflare Worker for Hyperliquid market research, signal
tracking, paper/shadow testing, and controlled execution testing.

> **Current status (2026-09-22):** execution code is under live-path
> testing. Check the deployed `src/hyperliquid/execution.ts`
> configuration before any test.

## Important links

-   Repository: https://github.com/kalchogr-art/cryptobot
-   Cloudflare Worker: https://cryptobot.kalchogr.workers.dev/
-   Hyperliquid: https://app.hyperliquid.xyz/
-   Hyperliquid API docs:
    https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
-   Hyperliquid signing docs:
    https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing
-   Hyperliquid Python SDK:
    https://github.com/hyperliquid-dex/hyperliquid-python-sdk

## Project map

``` text
src/
├── index.ts
├── ml/
│   ├── Create.txt
│   ├── model.ts
│   ├── raw-learning.ts
│   └── shadow-learning.ts
└── hyperliquid/
    ├── account.ts
    ├── signing-diagnostic.ts
    └── execution.ts
```

## Main files

-   `src/index.ts` --- Worker, CRON signal pipeline, D1 snapshots,
    signal episodes/crossings, dashboards and HTTP routes.
-   `src/hyperliquid/execution.ts` --- execution engine: freshness, D1
    idempotency, leverage, IOC entry, actual-fill TP/SL and Telegram.
-   `src/hyperliquid/account.ts` --- read-only account information.
-   `src/hyperliquid/signing-diagnostic.ts` --- signing diagnostics; not
    a normal monitoring endpoint.
-   `src/ml/shadow-learning.ts` --- isolated shadow ML research.
-   `src/ml/raw-learning.ts` --- raw-state ML research; not a live
    trading decision engine.

## Useful Worker endpoints

-   `/` --- main Worker status/dashboard.
-   `/forward-dashboard` --- forward LONG/SHORT strategy dashboard.
-   `/forward-long-shadow-dashboard` --- LONG shadow dashboard.
-   `/hyperliquid-account` --- read-only Hyperliquid account status.
-   `/hyperliquid-execution` --- read-only latest \>=65
    crossing/execution preview (`READ_ONLY_STATUS`).
-   `/telegram-test` --- Telegram connectivity test; no signing/orders.
-   `/snapshot-status?coin=BTC` --- snapshot/history/OI diagnostic.
-   `/debug-hyperliquid` --- Hyperliquid market-data diagnostic.
-   `/hyperliquid-signing-diagnostic` --- signing diagnostic; **do not
    open casually during live testing**.

## Signal -\> execution flow

``` text
CRON
  -> market snapshot + news
  -> final signal
  -> signal episode
  -> first |score| >= 65 crossing
  -> D1 crossing record
  -> execution.ts
  -> freshness check (max 120 s)
  -> D1 execution claim
  -> ensure per-coin leverage
  -> marketable IOC ENTRY
  -> actual fill price/size
  -> reduce-only TP + SL
  -> Telegram + D1 status
```

Policy: one execution attempt per coin per signal episode. Different
coins may be processed concurrently. Refreshing the read-only execution
endpoint must never create an order.

## Normal intended strategy settings

``` text
MIN SIGNAL SCORE: 65
MARGIN: $1.04
LEVERAGE: 10x cross
TARGET POSITION NOTIONAL: about $10.40
ENTRY: marketable IOC
MAX ENTRY SLIPPAGE: 0.30%

LONG:  TP +0.50% / SL -0.15%
SHORT: TP +0.50% / SL -0.40%

SIGNAL FRESHNESS: 120 seconds
TP/SL ATTEMPTS: 4
```

**Important:** diagnostic deployments may deliberately use different
values. Always inspect the deployed `CONFIG` in `execution.ts` before
enabling live trading.

## D1

-   Binding: `DB`
-   Database: `cryptobot-db`
-   `market_snapshots` --- market history.
-   `signal_episodes` --- signal episodes.
-   `signal_65_crossings` --- first \>=65 crossing per episode.
-   `hyperliquid_execution_ledger` --- live execution idempotency/status
    ledger.

The execution ledger uses unique `crossing_id` and `episode_id` claims
to prevent duplicate execution of the same episode.

## Cloudflare secrets / bindings

Secrets:

``` text
HYPERLIQUID_API_PRIVATE_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Variables/bindings:

``` text
HYPERLIQUID_ACCOUNT_ADDRESS
DB
```

**Never commit private keys, seed phrases, Telegram tokens or other
secrets.** The API-wallet private key belongs in a Cloudflare encrypted
Secret. The master MetaMask private key/seed must never be stored in the
Worker.

## Hyperliquid account architecture

-   Master account = funded Hyperliquid account.
-   API wallet = authorized agent used by Worker signing.
-   Positions/orders belong to the master account.
-   Worker uses only the authorized API-wallet private key.
-   Browser/MetaMask Connect is not required for API-wallet order
    placement.

## Execution safety already implemented

-   `LIVE_TRADING` switch.
-   Live execution only from `SIGNAL_PIPELINE`.
-   Signal freshness guard.
-   D1 atomic claim / duplicate protection.
-   Per-coin leverage verification/update before ENTRY.
-   Marketable IOC with bounded slippage.
-   TP/SL from actual fill price and actual fill size.
-   Reduce-only TP/SL.
-   TP/SL retry without retrying ENTRY.
-   Telegram on successful ENTRY/protection.
-   Telegram on ENTRY rejection/transport error.
-   Account snapshot in execution notifications.

## Known work before normal live trading

1.  Add **open-position + open-order guard per coin** before ENTRY.
2.  Add **MAX HOLD = 30 minutes**: if still open, reduce-only market
    close and clean remaining TP/SL.
3.  Add critical recovery/alert when ENTRY is filled but fill data
    cannot be parsed.
4.  Add Telegram notification for leverage update failure/rejection.
5.  Add safe recovery for a fresh D1 crossing recorded before execution
    if Worker stops between the two steps.
6.  Make Worker status reflect the actual execution `LIVE_TRADING` state
    instead of hard-coded text.
7.  Fix `/telegram-test` newline formatting.
8.  Make historical live signing diagnostics read-only before production
    use.

## Deployment checklist

``` text
[ ] Correct API wallet authorization
[ ] DB binding
[ ] Telegram working
[ ] Correct MARGIN_USD
[ ] Correct LEVERAGE
[ ] Correct LIVE_TRADING
[ ] No existing position/order conflict
[ ] Open-position/open-order guard deployed
[ ] MAX HOLD 30m deployed
[ ] TP/SL recovery path confirmed
[ ] Small controlled test first
```

## Notes

Paper/shadow/ML results are research data and do not guarantee future
profitability. Execution safety should remain independent from strategy
performance.

Last documentation update: **2026-09-22**
