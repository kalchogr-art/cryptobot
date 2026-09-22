import { updateMLShadowLearning, getMLShadowStatus } from "./ml/shadow-learning";
import { updateRawML, getRawMLStatus } from "./ml/raw-learning";
import { getHyperliquidAccountReadOnly } from "./hyperliquid/account";
import { getHyperliquidSigningDiagnostic } from "./hyperliquid/signing-diagnostic";
import { buildHyperliquidExecutionCandidate, monitorHyperliquidExecutionLifecycle } from "./hyperliquid/execution";

// ============================================================
// CRYPTOBOT V1.2 — MICROSTRUCTURE ENGINE
// READ ONLY / NO TRADING
//
// Coins: BTC / ETH / SOL / XRP / BNB / DOGE / AVAX / LINK / SUI / HYPE
//
// FIXES / FEATURES:
// - Closed candles used for historical volume/volatility/trend
// - Live candle kept separately for live momentum
// - 1m + 5m chart engine
// - L2 top-5 / top-10 / distance-weighted order-book imbalance
// - Spread / bid / ask liquidity
// - Current Open Interest / Funding / Premium
// - Combined MARKET LONG / SHORT score
//
// IMPORTANT:
// - OI level is exposed, but OI CHANGE is not scored yet.
//   We need stored historical snapshots for that.
// - Funding is used only as a small contextual factor.
// - Scores are strength/alignment scores, NOT profit probabilities.
// - NO WALLET / NO PRIVATE KEY / NO ORDERS.
//
// Endpoints:
// /
// /health
// /market
// /candles?coin=BTC&interval=1m&limit=60
// /book?coin=BTC
// /chart?coin=BTC
// /charts
// /signal?coin=BTC
// /signals
// /debug-hyperliquid
// ============================================================

const VERSION = "V1.9.11 HYPERLIQUID RAW BALANCE DIAGNOSTIC";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

const TRACKED_COINS = ["BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "AVAX", "LINK", "SUI", "HYPE", "ADA", "LTC", "BCH", "AAVE", "UNI", "NEAR", "OP", "ARB", "WIF", "TRX"] as const;
const ALLOWED_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h"] as const;

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
};

type AnyObj = Record<string, any>;

type Env = {
  // Optional. Add with:
  // npx wrangler secret put X_API_BEARER_TOKEN
  X_API_BEARER_TOKEN?: string;

  // Cloudflare D1 binding. Recommended binding name: DB
  DB?: any;

  // Public Hyperliquid account address used by READ ONLY account module.
  HYPERLIQUID_ACCOUNT_ADDRESS?: string;

  // Encrypted Cloudflare Secret. NEVER put its value in source code.
  HYPERLIQUID_API_PRIVATE_KEY?: string;

  // Telegram notifications. Keep both as encrypted Cloudflare Secrets.
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
};

type Candle = {
  coin?: string;
  interval?: string;
  open_time: number | null;
  close_time: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  trades?: number | null;
};

// ============================================================
// RESPONSE / HELPERS
// ============================================================

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}

function num(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function clampSigned(value: number, min = -100, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, decimals = 2): number {
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function average(values: number[]): number {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

function validCoin(coin: string): boolean {
  return (TRACKED_COINS as readonly string[]).includes(coin.toUpperCase());
}

function sideLabel(signed: number, neutralBand = 5): string {
  if (signed > neutralBand) return "LONG";
  if (signed < -neutralBand) return "SHORT";
  return "NEUTRAL";
}

// ============================================================
// HYPERLIQUID
// ============================================================

async function hyperliquid(payload: AnyObj): Promise<any> {
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: any;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("HYPERLIQUID_INVALID_JSON: " + text.slice(0, 500));
  }

  if (!response.ok) {
    throw new Error(
      `HYPERLIQUID_HTTP_${response.status}: ${text.slice(0, 500)}`
    );
  }

  return data;
}

async function getAllMids() {
  return hyperliquid({ type: "allMids" });
}

async function getMetaAndContexts() {
  return hyperliquid({ type: "metaAndAssetCtxs" });
}

async function getAssetContext(coin: string) {
  const metaCtx = await getMetaAndContexts();

  const meta = Array.isArray(metaCtx) ? metaCtx[0] : null;
  const contexts = Array.isArray(metaCtx) ? metaCtx[1] : null;
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];

  const index = universe.findIndex(
    (x: any) => String(x?.name ?? "").toUpperCase() === coin
  );

  const ctx =
    index >= 0 && Array.isArray(contexts)
      ? contexts[index]
      : null;

  return {
    found: index >= 0,
    context: ctx,
    index,
  };
}

// ============================================================
// MARKET
// ============================================================

async function getMarket() {
  const [mids, metaCtx] = await Promise.all([
    getAllMids(),
    getMetaAndContexts(),
  ]);

  const meta = Array.isArray(metaCtx) ? metaCtx[0] : null;
  const contexts = Array.isArray(metaCtx) ? metaCtx[1] : null;
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];

  const coins = TRACKED_COINS.map((coin) => {
    const index = universe.findIndex(
      (x: any) => String(x?.name ?? "").toUpperCase() === coin
    );

    const ctx =
      index >= 0 && Array.isArray(contexts)
        ? contexts[index]
        : null;

    const mid = num(mids?.[coin]);
    const previous = num(ctx?.prevDayPx);

    let change24h: number | null = null;

    if (mid !== null && previous !== null && previous !== 0) {
      change24h = ((mid - previous) / previous) * 100;
    }

    return {
      coin,
      found: index >= 0,
      mid,
      mark_price: num(ctx?.markPx),
      oracle_price: num(ctx?.oraclePx),
      funding: num(ctx?.funding),
      open_interest: num(ctx?.openInterest),
      day_volume: num(ctx?.dayNtlVlm),
      previous_day_price: previous,
      change_24h_pct:
        change24h === null ? null : round(change24h, 3),
      premium: num(ctx?.premium),
    };
  });

  return {
    source: "HYPERLIQUID",
    market: "PERPETUALS",
    timestamp: Date.now(),
    datetime: new Date().toISOString(),
    coins,
  };
}

// ============================================================
// CANDLES
// ============================================================

async function getCandles(
  coin: string,
  interval: string,
  limit: number
) {
  const now = Date.now();
  const step = INTERVAL_MS[interval];

  if (!step) throw new Error("INVALID_INTERVAL");

  const startTime = now - step * Math.max(limit + 8, 25);

  const raw = await hyperliquid({
    type: "candleSnapshot",
    req: {
      coin,
      interval,
      startTime,
      endTime: now,
    },
  });

  const candles: Candle[] = Array.isArray(raw)
    ? raw.slice(-limit).map((c: any) => ({
        coin: c?.s ?? coin,
        interval: c?.i ?? interval,
        open_time: num(c?.t),
        close_time: num(c?.T),
        open: num(c?.o),
        high: num(c?.h),
        low: num(c?.l),
        close: num(c?.c),
        volume: num(c?.v),
        trades: num(c?.n),
      }))
    : [];

  return {
    source: "HYPERLIQUID",
    coin,
    interval,
    requested_limit: limit,
    returned: candles.length,
    timestamp: now,
    candles,
  };
}

function splitCandles(candles: Candle[], interval: string) {
  const now = Date.now();
  const step = INTERVAL_MS[interval];

  const sorted = [...candles].sort(
    (a, b) => (a.open_time ?? 0) - (b.open_time ?? 0)
  );

  if (!sorted.length) {
    return {
      closed: [] as Candle[],
      live: null as Candle | null,
    };
  }

  const last = sorted[sorted.length - 1];
  const openTime = last.open_time ?? 0;

  // Hyperliquid's latest candle is normally the current in-progress candle.
  // Use interval boundary as the robust test instead of trusting close_time.
  const isLive = step > 0 && openTime + step > now;

  return {
    closed: isLive ? sorted.slice(0, -1) : sorted,
    live: isLive ? last : null,
  };
}

function usableCandles(candles: Candle[]) {
  return candles.filter(
    (c) =>
      c.open !== null &&
      c.high !== null &&
      c.low !== null &&
      c.close !== null
  );
}

// ============================================================
// CHART COMPONENTS
// ============================================================

function calculateMomentum(candles: Candle[]) {
  const usable = usableCandles(candles);

  if (usable.length < 6) {
    return { pct: 0, direction: 0, strength: 0 };
  }

  const recent = usable.slice(-6);
  const first = recent[0].close as number;
  const last = recent[recent.length - 1].close as number;

  if (first === 0) {
    return { pct: 0, direction: 0, strength: 0 };
  }

  const pct = ((last - first) / first) * 100;

  const ranges = recent.map((c) => {
    const close = c.close as number;
    if (!close) return 0;
    return (((c.high as number) - (c.low as number)) / close) * 100;
  });

  const normalRange = Math.max(average(ranges), 0.01);
  const strength = clamp((Math.abs(pct) / (normalRange * 3)) * 100);

  return {
    pct: round(pct, 4),
    direction: pct > 0 ? 1 : pct < 0 ? -1 : 0,
    strength: round(strength),
  };
}

function calculateLiveMomentum(
  live: Candle | null,
  closed: Candle[]
) {
  if (
    !live ||
    live.close === null ||
    live.open === null ||
    !closed.length
  ) {
    return {
      available: false,
      pct_from_open: 0,
      pct_from_prev_close: 0,
      direction: 0,
      strength: 0,
    };
  }

  const prevClose = closed[closed.length - 1]?.close;

  if (prevClose === null || prevClose === undefined || prevClose === 0) {
    return {
      available: false,
      pct_from_open: 0,
      pct_from_prev_close: 0,
      direction: 0,
      strength: 0,
    };
  }

  const fromOpen =
    live.open !== 0
      ? (((live.close as number) - (live.open as number)) /
          (live.open as number)) *
        100
      : 0;

  const fromPrev =
    (((live.close as number) - prevClose) / prevClose) * 100;

  const recentRanges = usableCandles(closed)
    .slice(-10)
    .map((c) => {
      const close = c.close as number;
      return close
        ? (((c.high as number) - (c.low as number)) / close) * 100
        : 0;
    });

  const baseline = Math.max(average(recentRanges), 0.01);
  const strength = clamp((Math.abs(fromPrev) / baseline) * 50);

  return {
    available: true,
    pct_from_open: round(fromOpen, 4),
    pct_from_prev_close: round(fromPrev, 4),
    direction: fromPrev > 0 ? 1 : fromPrev < 0 ? -1 : 0,
    strength: round(strength),
  };
}

function calculateTrend(candles: Candle[]) {
  const usable = usableCandles(candles);

  if (usable.length < 20) {
    return {
      direction: 0,
      strength: 0,
      fast_avg: null,
      slow_avg: null,
      distance_pct: 0,
    };
  }

  const closes = usable.map((c) => c.close as number);
  const fast = average(closes.slice(-5));
  const slow = average(closes.slice(-20));

  if (!slow) {
    return {
      direction: 0,
      strength: 0,
      fast_avg: round(fast, 6),
      slow_avg: round(slow, 6),
      distance_pct: 0,
    };
  }

  const distancePct = ((fast - slow) / slow) * 100;

  const ranges = usable.slice(-20).map((c) => {
    const close = c.close as number;
    return close
      ? (((c.high as number) - (c.low as number)) / close) * 100
      : 0;
  });

  const normalRange = Math.max(average(ranges), 0.01);

  const strength = clamp(
    (Math.abs(distancePct) / (normalRange * 1.5)) * 100
  );

  return {
    direction: distancePct > 0 ? 1 : distancePct < 0 ? -1 : 0,
    strength: round(strength),
    fast_avg: round(fast, 6),
    slow_avg: round(slow, 6),
    distance_pct: round(distancePct, 4),
  };
}

function calculateVolumeClosed(candles: Candle[]) {
  const usable = candles.filter((c) => c.volume !== null);

  if (usable.length < 11) {
    return {
      ratio: 1,
      strength: 0,
      latest_closed: null,
      average_previous_10: null,
    };
  }

  const latest = usable[usable.length - 1].volume as number;
  const previous = usable
    .slice(-11, -1)
    .map((c) => c.volume as number);

  const avg = average(previous);

  if (avg <= 0) {
    return {
      ratio: 1,
      strength: 0,
      latest_closed: latest,
      average_previous_10: avg,
    };
  }

  const ratio = latest / avg;

  return {
    ratio: round(ratio, 3),
    strength: round(clamp((ratio - 1) * 50)),
    latest_closed: latest,
    average_previous_10: round(avg, 6),
  };
}

function calculateVolatilityClosed(candles: Candle[]) {
  const usable = usableCandles(candles);

  if (usable.length < 11) {
    return {
      ratio: 1,
      strength: 0,
      latest_closed_range_pct: 0,
      normal_range_pct: 0,
    };
  }

  const ranges = usable.map((c) => {
    const close = c.close as number;
    return close
      ? (((c.high as number) - (c.low as number)) / close) * 100
      : 0;
  });

  const latest = ranges[ranges.length - 1];
  const baseline = average(ranges.slice(-11, -1));

  if (baseline <= 0) {
    return {
      ratio: 1,
      strength: 0,
      latest_closed_range_pct: round(latest, 4),
      normal_range_pct: 0,
    };
  }

  const ratio = latest / baseline;

  return {
    ratio: round(ratio, 3),
    strength: round(clamp((ratio - 1) * 50)),
    latest_closed_range_pct: round(latest, 4),
    normal_range_pct: round(baseline, 4),
  };
}

function calculateTimeframe(
  candles: Candle[],
  interval: string
) {
  const { closed, live } = splitCandles(candles, interval);

  const momentum = calculateMomentum(closed);
  const liveMomentum = calculateLiveMomentum(live, closed);
  const trend = calculateTrend(closed);
  const volume = calculateVolumeClosed(closed);
  const volatility = calculateVolatilityClosed(closed);

  const historicalDirectional =
    momentum.direction * momentum.strength * 0.50 +
    trend.direction * trend.strength * 0.40;

  const liveDirectional =
    liveMomentum.direction * liveMomentum.strength * 0.10;

  const directionalRaw = historicalDirectional + liveDirectional;

  const direction =
    directionalRaw > 5 ? 1 : directionalRaw < -5 ? -1 : 0;

  const directionalStrength = Math.abs(directionalRaw);

  const confirmation =
    volume.strength * 0.60 +
    volatility.strength * 0.40;

  let totalStrength = directionalStrength;

  if (direction !== 0) {
    totalStrength = clamp(
      directionalStrength * 0.80 +
      confirmation * 0.20
    );
  }

  return {
    interval,
    candle_handling: {
      closed_candles: closed.length,
      live_candle_present: !!live,
      historical_metrics_use_closed_only: true,
    },
    momentum,
    live_momentum: liveMomentum,
    trend,
    volume,
    volatility,
    direction:
      direction > 0
        ? "BULLISH"
        : direction < 0
        ? "BEARISH"
        : "NEUTRAL",
    directional_raw: round(directionalRaw),
    confirmation: round(confirmation),
    long_score: direction > 0 ? round(totalStrength) : 0,
    short_score: direction < 0 ? round(totalStrength) : 0,
  };
}

function combineTimeframes(oneMinute: any, fiveMinute: any) {
  let longScore =
    oneMinute.long_score * 0.60 +
    fiveMinute.long_score * 0.40;

  let shortScore =
    oneMinute.short_score * 0.60 +
    fiveMinute.short_score * 0.40;

  let agreement = "MIXED";

  if (
    oneMinute.direction === "BULLISH" &&
    fiveMinute.direction === "BULLISH"
  ) {
    agreement = "BULLISH_CONFIRMATION";
    longScore = clamp(longScore * 1.10);
  } else if (
    oneMinute.direction === "BEARISH" &&
    fiveMinute.direction === "BEARISH"
  ) {
    agreement = "BEARISH_CONFIRMATION";
    shortScore = clamp(shortScore * 1.10);
  } else if (
    oneMinute.direction === "NEUTRAL" &&
    fiveMinute.direction === "NEUTRAL"
  ) {
    agreement = "NEUTRAL";
  } else if (
    oneMinute.direction !== "NEUTRAL" &&
    fiveMinute.direction !== "NEUTRAL" &&
    oneMinute.direction !== fiveMinute.direction
  ) {
    agreement = "TIMEFRAME_CONFLICT";
    longScore *= 0.70;
    shortScore *= 0.70;
  }

  longScore = clamp(longScore);
  shortScore = clamp(shortScore);

  const difference = longScore - shortScore;
  const strongest = Math.max(longScore, shortScore);

  let status = "NO_TRADE";

  if (strongest >= 80 && Math.abs(difference) >= 20) {
    status = "STRONG";
  } else if (strongest >= 65 && Math.abs(difference) >= 15) {
    status = "WATCH";
  } else if (strongest >= 50) {
    status = "WEAK";
  }

  return {
    long_score: round(longScore),
    short_score: round(shortScore),
    difference: round(difference),
    bias:
      difference >= 10
        ? "LONG"
        : difference <= -10
        ? "SHORT"
        : "NEUTRAL",
    status,
    timeframe_agreement: agreement,
  };
}

async function buildChart(coin: string) {
  const started = Date.now();

  const [candles1m, candles5m, mids] = await Promise.all([
    getCandles(coin, "1m", 45),
    getCandles(coin, "5m", 45),
    getAllMids(),
  ]);

  const oneMinute = calculateTimeframe(candles1m.candles, "1m");
  const fiveMinute = calculateTimeframe(candles5m.candles, "5m");

  return {
    source: "HYPERLIQUID",
    coin,
    price: num(mids?.[coin]),
    timestamp: Date.now(),
    datetime: new Date().toISOString(),
    processing_ms: Date.now() - started,
    candles: {
      "1m": candles1m.returned,
      "5m": candles5m.returned,
    },
    timeframe_1m: oneMinute,
    timeframe_5m: fiveMinute,
    chart: {
      ...combineTimeframes(oneMinute, fiveMinute),
      meaning:
        "Chart strength/alignment score, not probability of profit",
    },
  };
}

// ============================================================
// L2 ORDER BOOK / MICROSTRUCTURE
// ============================================================

function normalizeBookLevel(x: any) {
  const price = num(x?.px);
  const size = num(x?.sz);

  return {
    price,
    size,
    orders: num(x?.n),
    notional:
      price !== null && size !== null
        ? price * size
        : 0,
  };
}

function sumNotional(levels: any[], count: number): number {
  return levels
    .slice(0, count)
    .reduce(
      (sum, x) =>
        sum +
        (Number.isFinite(x.notional) ? x.notional : 0),
      0
    );
}

function imbalance(bid: number, ask: number): number {
  const total = bid + ask;
  if (total <= 0) return 0;
  return (bid - ask) / total;
}

function weightedLiquidity(
  levels: any[],
  mid: number,
  count: number
): number {
  if (!mid) return 0;

  return levels.slice(0, count).reduce((sum, x) => {
    if (
      x.price === null ||
      x.size === null ||
      x.price <= 0 ||
      x.size <= 0
    ) {
      return sum;
    }

    const distancePct = Math.abs(x.price - mid) / mid;

    // Strongly favor liquidity closest to the current mid.
    // Small floor avoids division explosion.
    const weight = 1 / Math.max(distancePct, 0.00001);

    return sum + x.notional * weight;
  }, 0);
}

async function getBook(coin: string) {
  const data = await hyperliquid({
    type: "l2Book",
    coin,
  });

  const rawBids = Array.isArray(data?.levels?.[0])
    ? data.levels[0]
    : [];

  const rawAsks = Array.isArray(data?.levels?.[1])
    ? data.levels[1]
    : [];

  const bids = rawBids.map(normalizeBookLevel);
  const asks = rawAsks.map(normalizeBookLevel);

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;

  const mid =
    bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2
      : null;

  const spread =
    bestBid !== null && bestAsk !== null
      ? bestAsk - bestBid
      : null;

  const spreadPct =
    spread !== null && mid !== null && mid !== 0
      ? (spread / mid) * 100
      : null;

  const bid5 = sumNotional(bids, 5);
  const ask5 = sumNotional(asks, 5);

  const bid10 = sumNotional(bids, 10);
  const ask10 = sumNotional(asks, 10);

  const top5Imbalance = imbalance(bid5, ask5);
  const top10Imbalance = imbalance(bid10, ask10);

  let weightedBid = 0;
  let weightedAsk = 0;

  if (mid !== null) {
    weightedBid = weightedLiquidity(bids, mid, 10);
    weightedAsk = weightedLiquidity(asks, mid, 10);
  }

  const weightedImbalance = imbalance(weightedBid, weightedAsk);

  // Final order-flow imbalance:
  // closest 5 levels matter most.
  const finalImbalance = clampSigned(
    (
      top5Imbalance * 0.45 +
      top10Imbalance * 0.25 +
      weightedImbalance * 0.30
    ) * 100
  );

  const strength = clamp(Math.abs(finalImbalance));

  return {
    source: "HYPERLIQUID",
    coin,
    timestamp: data?.time ?? Date.now(),
    best_bid: bestBid,
    best_ask: bestAsk,
    mid,
    spread:
      spread === null ? null : round(spread, 8),
    spread_pct:
      spreadPct === null ? null : round(spreadPct, 6),

    liquidity: {
      top5: {
        bid_notional: round(bid5, 2),
        ask_notional: round(ask5, 2),
        imbalance: round(top5Imbalance * 100),
      },
      top10: {
        bid_notional: round(bid10, 2),
        ask_notional: round(ask10, 2),
        imbalance: round(top10Imbalance * 100),
      },
      weighted_top10: {
        bid: round(weightedBid, 2),
        ask: round(weightedAsk, 2),
        imbalance: round(weightedImbalance * 100),
      },
    },

    order_flow: {
      signed_score: round(finalImbalance),
      direction: sideLabel(finalImbalance),
      strength: round(strength),
      long_score: finalImbalance > 0 ? round(strength) : 0,
      short_score: finalImbalance < 0 ? round(strength) : 0,
    },

    levels: {
      bids,
      asks,
    },
  };
}

// ============================================================
// DERIVATIVES CONTEXT
// ============================================================

function buildDerivatives(ctx: any) {
  const funding = num(ctx?.funding);
  const openInterest = num(ctx?.openInterest);
  const premium = num(ctx?.premium);
  const mark = num(ctx?.markPx);
  const oracle = num(ctx?.oraclePx);

  // Funding is intentionally low-weight context.
  // Positive funding = longs pay shorts -> slight contrarian SHORT pressure.
  // Negative funding = shorts pay longs -> slight contrarian LONG pressure.
  let fundingSigned = 0;

  if (funding !== null) {
    // 0.01% funding (0.0001) -> contextual score ~25.
    fundingSigned = clampSigned((-funding / 0.0001) * 25);
  }

  let premiumSigned = 0;

  if (premium !== null) {
    // Positive premium = futures trading above reference -> modest LONG pressure.
    premiumSigned = clampSigned((premium / 0.001) * 20);
  }

  const contextualSigned =
    fundingSigned * 0.60 +
    premiumSigned * 0.40;

  return {
    open_interest: openInterest,
    open_interest_change: null,
    open_interest_change_status:
      "WAITING_FOR_HISTORICAL_SNAPSHOTS",

    funding,
    funding_context: {
      signed_score: round(fundingSigned),
      interpretation:
        fundingSigned > 5
          ? "LONG_CONTRARIAN_SUPPORT"
          : fundingSigned < -5
          ? "SHORT_CONTRARIAN_SUPPORT"
          : "NEUTRAL",
    },

    premium,
    premium_context: {
      signed_score: round(premiumSigned),
    },

    mark_price: mark,
    oracle_price: oracle,

    contextual_signed_score: round(contextualSigned),
    direction: sideLabel(contextualSigned),
    strength: round(clamp(Math.abs(contextualSigned))),
  };
}


// ============================================================
// V1.4 SNAPSHOT HISTORY + OI CHANGE
// D1 READ/WRITE ONLY FOR MARKET SNAPSHOTS — NO TRADING
// ============================================================

type SnapshotRow = {
  coin: string;
  ts: number;
  price: number;
  order_flow_signed: number;
  open_interest: number | null;
  funding: number | null;
  premium: number | null;
  chart_signed: number;
};

function dbReady(env?: Env): boolean {
  return !!env?.DB;
}

async function ensureSnapshotTable(env: Env): Promise<void> {
  if (!env.DB) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT NOT NULL,
      ts INTEGER NOT NULL,
      datetime TEXT NOT NULL,
      price REAL NOT NULL,
      chart_signed REAL NOT NULL,
      order_flow_signed REAL NOT NULL,
      open_interest REAL,
      funding REAL,
      premium REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_coin_ts
    ON market_snapshots (coin, ts DESC)
  `).run();
}

async function saveSnapshot(
  env: Env,
  signal: any
): Promise<boolean> {
  if (!env.DB) return false;

  await ensureSnapshotTable(env);

  await env.DB.prepare(`
    INSERT INTO market_snapshots (
      coin, ts, datetime, price,
      chart_signed, order_flow_signed,
      open_interest, funding, premium
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    signal.coin,
    signal.timestamp,
    signal.datetime,
    Number(signal.price ?? 0),
    Number(
      signal.chart?.final?.long_score ?? 0
    ) - Number(
      signal.chart?.final?.short_score ?? 0
    ),
    Number(
      signal.microstructure?.order_flow?.signed_score ?? 0
    ),
    signal.derivatives?.open_interest ?? null,
    signal.derivatives?.funding ?? null,
    signal.derivatives?.premium ?? null
  ).run();

  return true;
}

async function getRecentSnapshots(
  env: Env,
  coin: string,
  minutes = 20,
  limit = 120
): Promise<SnapshotRow[]> {
  if (!env.DB) return [];

  await ensureSnapshotTable(env);

  const since = Date.now() - minutes * 60_000;

  const result = await env.DB.prepare(`
    SELECT
      coin, ts, price, chart_signed,
      order_flow_signed, open_interest,
      funding, premium
    FROM market_snapshots
    WHERE coin = ? AND ts >= ?
    ORDER BY ts ASC
    LIMIT ?
  `).bind(
    coin,
    since,
    Math.max(1, Math.min(limit, 500))
  ).all();

  return (result?.results ?? []) as SnapshotRow[];
}

function nearestSnapshot(
  rows: SnapshotRow[],
  targetTs: number,
  toleranceMs: number
): SnapshotRow | null {
  let best: SnapshotRow | null = null;
  let bestDistance = Infinity;

  for (const row of rows) {
    const d = Math.abs(Number(row.ts) - targetTs);
    if (d <= toleranceMs && d < bestDistance) {
      best = row;
      bestDistance = d;
    }
  }

  return best;
}

function pctChange(
  current: number | null,
  previous: number | null
): number | null {
  if (
    current === null ||
    previous === null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }

  return ((current - previous) / Math.abs(previous)) * 100;
}

function buildOiChangeWindow(
  current: {
    ts: number;
    price: number;
    oi: number | null;
  },
  rows: SnapshotRow[],
  minutes: number
) {
  const previous = nearestSnapshot(
    rows,
    current.ts - minutes * 60_000,
    90_000
  );

  if (!previous) {
    return {
      available: false,
      minutes,
      reason: "NO_SNAPSHOT_NEAR_TARGET",
    };
  }

  const oiPct = pctChange(
    current.oi,
    previous.open_interest
  );

  const pricePct = pctChange(
    current.price,
    previous.price
  );

  if (oiPct === null || pricePct === null) {
    return {
      available: false,
      minutes,
      reason: "MISSING_OI_OR_PRICE",
    };
  }

  // OI is context, not direction by itself.
  // Rising OI + rising price => LONG confirmation.
  // Rising OI + falling price => SHORT confirmation.
  // Falling OI => deleveraging; deliberately lower score.
  const oiMagnitude = clamp(
    Math.abs(oiPct) / 0.20 * 100
  );

  const priceMagnitude = clamp(
    Math.abs(pricePct) / 0.20 * 100
  );

  let signed = 0;
  let interpretation = "NEUTRAL";

  if (oiPct > 0.01 && pricePct > 0.01) {
    signed =
      Math.min(oiMagnitude, priceMagnitude) * 0.85;
    interpretation = "RISING_OI_RISING_PRICE";
  } else if (oiPct > 0.01 && pricePct < -0.01) {
    signed =
      -Math.min(oiMagnitude, priceMagnitude) * 0.85;
    interpretation = "RISING_OI_FALLING_PRICE";
  } else if (oiPct < -0.01 && pricePct > 0.01) {
    signed = priceMagnitude * 0.25;
    interpretation = "FALLING_OI_RISING_PRICE_DELEVERAGING";
  } else if (oiPct < -0.01 && pricePct < -0.01) {
    signed = -priceMagnitude * 0.25;
    interpretation = "FALLING_OI_FALLING_PRICE_DELEVERAGING";
  }

  return {
    available: true,
    minutes,
    previous_ts: previous.ts,
    previous_price: round(previous.price),
    previous_open_interest:
      previous.open_interest === null
        ? null
        : round(previous.open_interest, 6),
    price_change_pct: round(pricePct, 4),
    open_interest_change_pct: round(oiPct, 4),
    signed_score: round(clampSigned(signed)),
    interpretation,
  };
}

function buildOrderFlowPersistence(
  rows: SnapshotRow[],
  currentSigned: number
) {
  const values = [
    ...rows.slice(-9).map(
      (x) => Number(x.order_flow_signed ?? 0)
    ),
    currentSigned,
  ].filter(Number.isFinite);

  if (values.length < 3) {
    return {
      available: false,
      samples: values.length,
      signed_score: round(currentSigned),
      reason: "NEED_AT_LEAST_3_SNAPSHOTS",
    };
  }

  const avg =
    values.reduce((a, b) => a + b, 0) /
    values.length;

  const sameDirection = values.filter(
    (x) =>
      Math.sign(x) === Math.sign(avg) &&
      Math.abs(x) >= 10
  ).length;

  const persistence = sameDirection / values.length;

  // Persistence prevents a single L2 wall from dominating.
  const signed =
    avg * (0.50 + persistence * 0.50);

  return {
    available: true,
    samples: values.length,
    average_signed: round(avg),
    persistence_ratio: round(persistence, 4),
    current_signed: round(currentSigned),
    signed_score: round(clampSigned(signed)),
    direction: sideLabel(signed, 10),
  };
}

async function buildHistoryContext(
  env: Env | undefined,
  coin: string,
  current: {
    ts: number;
    price: number;
    oi: number | null;
    orderFlowSigned: number;
  }
) {
  if (!env?.DB) {
    return {
      storage: "D1_NOT_BOUND",
      snapshots: 0,
      order_flow_persistence: {
        available: false,
        signed_score: round(current.orderFlowSigned),
      },
      oi_change: {
        available: false,
        signed_score: 0,
        status: "WAITING_FOR_D1_BINDING",
      },
    };
  }

  const rows = await getRecentSnapshots(
    env,
    coin,
    20,
    120
  );

  const flow = buildOrderFlowPersistence(
    rows,
    current.orderFlowSigned
  );

  const w1 = buildOiChangeWindow(
    { ts: current.ts, price: current.price, oi: current.oi },
    rows,
    1
  );
  const w5 = buildOiChangeWindow(
    { ts: current.ts, price: current.price, oi: current.oi },
    rows,
    5
  );
  const w15 = buildOiChangeWindow(
    { ts: current.ts, price: current.price, oi: current.oi },
    rows,
    15
  );

  const available = [w1, w5, w15].filter(
    (x: any) => x.available
  );

  let oiSigned = 0;

  if (available.length) {
    const weighted = [
      { value: w1, weight: 0.25 },
      { value: w5, weight: 0.45 },
      { value: w15, weight: 0.30 },
    ].filter((x: any) => x.value.available);

    const weightSum = weighted.reduce(
      (sum: number, x: any) => sum + x.weight,
      0
    );

    oiSigned =
      weighted.reduce(
        (sum: number, x: any) =>
          sum +
          Number(x.value.signed_score ?? 0) *
            x.weight,
        0
      ) / weightSum;
  }

  return {
    storage: "D1",
    snapshots: rows.length,
    order_flow_persistence: flow,
    oi_change: {
      available: available.length > 0,
      signed_score: round(clampSigned(oiSigned)),
      windows: {
        "1m": w1,
        "5m": w5,
        "15m": w15,
      },
      status:
        available.length > 0
          ? "ACTIVE"
          : "COLLECTING_HISTORY",
    },
  };
}



// ============================================================
// V1.5 PAPER TRADING ENGINE
// SIMULATION ONLY — NO ORDERS / NO WALLET / NO REAL MONEY
// ============================================================

const PAPER_ENTRY_SCORE = 65;
const PAPER_OBSERVATION_MIN_SCORE = 50;
const PAPER_MIN_SCORE_GAP = 20;
const PAPER_TP_PCT = 0.35;
const PAPER_SL_PCT = 0.25;
const PAPER_MAX_HOLD_MINUTES = 30;
const PAPER_FEE_RATE_PER_SIDE = 0.00035;
const PAPER_NOTIONAL_USD = 100;

async function ensurePaperTables(env: Env): Promise<void> {
  if (!env.DB) return;

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS paper_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      entry_ts INTEGER NOT NULL,
      entry_datetime TEXT NOT NULL,
      entry_price REAL NOT NULL,
      entry_score REAL NOT NULL,
      entry_market_status TEXT,
      chart_signed REAL,
      order_flow_raw_signed REAL,
      order_flow_persistent_signed REAL,
      oi_change_signed REAL,
      funding_premium_signed REAL,
      history_mode TEXT,
      news_signed REAL,
      final_signed REAL,
      tp_price REAL NOT NULL,
      sl_price REAL NOT NULL,
      max_hold_minutes INTEGER NOT NULL,
      exit_ts INTEGER,
      exit_datetime TEXT,
      exit_price REAL,
      exit_reason TEXT,
      gross_return_pct REAL,
      fee_pct REAL,
      net_return_pct REAL,
      pnl_usd REAL,
      mfe_pct REAL NOT NULL DEFAULT 0,
      mae_pct REAL NOT NULL DEFAULT 0,
      max_price REAL,
      min_price REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_paper_trades_status_coin
    ON paper_trades (status, coin, entry_ts DESC)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_paper_trades_entry_ts
    ON paper_trades (entry_ts DESC)
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS paper_signal_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT NOT NULL,
      ts INTEGER NOT NULL,
      datetime TEXT NOT NULL,
      price REAL NOT NULL,
      side TEXT NOT NULL,
      score REAL NOT NULL,
      score_bucket TEXT NOT NULL,
      qualifies_entry INTEGER NOT NULL DEFAULT 0,
      market_signed REAL,
      news_signed REAL,
      final_signed REAL,
      chart_signed REAL,
      order_flow_persistent_signed REAL,
      oi_change_signed REAL,
      funding_premium_signed REAL,
      history_mode TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(coin, ts)
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_paper_obs_coin_ts
    ON paper_signal_observations (coin, ts DESC)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_paper_obs_bucket
    ON paper_signal_observations (score_bucket, side, ts DESC)
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS signal_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      start_ts INTEGER NOT NULL,
      start_datetime TEXT NOT NULL,
      start_price REAL NOT NULL,
      start_score REAL NOT NULL,
      start_bucket TEXT NOT NULL,
      peak_score REAL NOT NULL,
      peak_ts INTEGER NOT NULL,
      peak_price REAL NOT NULL,
      qualifies_entry INTEGER NOT NULL DEFAULT 0,
      market_signed REAL,
      news_signed REAL,
      final_signed REAL,
      chart_signed REAL,
      order_flow_persistent_signed REAL,
      oi_change_signed REAL,
      funding_premium_signed REAL,
      history_mode TEXT,
      end_ts INTEGER,
      end_datetime TEXT,
      end_price REAL,
      end_reason TEXT,
      signal_lifetime_minutes REAL,
      lifetime_return_pct REAL,
      lifetime_mfe_pct REAL,
      lifetime_mae_pct REAL,
      lifetime_tp_hit INTEGER NOT NULL DEFAULT 0,
      lifetime_sl_hit INTEGER NOT NULL DEFAULT 0,
      lifetime_first_barrier TEXT,
      lifetime_first_barrier_ts INTEGER,
      return_1m_pct REAL,
      return_5m_pct REAL,
      return_15m_pct REAL,
      return_30m_pct REAL,
      mfe_pct REAL,
      mae_pct REAL,
      tp_hit INTEGER NOT NULL DEFAULT 0,
      sl_hit INTEGER NOT NULL DEFAULT 0,
      first_barrier TEXT,
      first_barrier_ts INTEGER,
      outcome_complete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_signal_episodes_coin_status
    ON signal_episodes (coin, status, start_ts DESC)
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_signal_episodes_start
    ON signal_episodes (start_ts DESC)
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS signal_65_crossings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL UNIQUE,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      crossing_ts INTEGER NOT NULL,
      crossing_datetime TEXT NOT NULL,
      crossing_price REAL NOT NULL,
      crossing_score REAL NOT NULL,
      market_signed REAL, news_signed REAL, final_signed REAL,
      chart_signed REAL, order_flow_persistent_signed REAL,
      oi_change_signed REAL, funding_premium_signed REAL, history_mode TEXT,
      return_1m_pct REAL, return_5m_pct REAL, return_15m_pct REAL, return_30m_pct REAL,
      mfe_pct REAL, mae_pct REAL,
      tp_hit INTEGER NOT NULL DEFAULT 0, sl_hit INTEGER NOT NULL DEFAULT 0,
      first_barrier TEXT, first_barrier_ts INTEGER,
      outcome_complete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_cross65_coin_ts
    ON signal_65_crossings (coin, crossing_ts DESC)
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS signal_60_64_crossings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL UNIQUE,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      crossing_ts INTEGER NOT NULL,
      crossing_datetime TEXT NOT NULL,
      crossing_price REAL NOT NULL,
      crossing_score REAL NOT NULL,
      return_1m_pct REAL, return_5m_pct REAL, return_15m_pct REAL, return_30m_pct REAL,
      mfe_pct REAL, mae_pct REAL,
      outcome_complete INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_cross60_64_coin_ts
    ON signal_60_64_crossings (coin, crossing_ts DESC)
  `).run();
}

function scoreBucket(score: number): string {
  if (score >= 80) return "80+";
  if (score >= 75) return "75-79";
  if (score >= 70) return "70-74";
  if (score >= 65) return "65-69";
  if (score >= 60) return "60-64";
  if (score >= 55) return "55-59";
  if (score >= 50) return "50-54";
  return "<50";
}

async function recordPaperObservation(
  env: Env,
  signal: any,
  finalSignal: any
): Promise<any> {
  await ensurePaperTables(env);

  const finalSigned = Number(
    finalSignal?.final?.signed_score ??
    signal.market?.signed_score ??
    0
  );
  const score = Math.abs(finalSigned);

  if (score < PAPER_OBSERVATION_MIN_SCORE) {
    return {
      recorded: false,
      reason: "BELOW_OBSERVATION_THRESHOLD",
      score: round(score),
    };
  }

  const side = finalSigned >= 0 ? "LONG" : "SHORT";
  const ts = Date.now();

  await env.DB.prepare(`
    INSERT OR IGNORE INTO paper_signal_observations (
      coin, ts, datetime, price,
      side, score, score_bucket, qualifies_entry,
      market_signed, news_signed, final_signed,
      chart_signed, order_flow_persistent_signed,
      oi_change_signed, funding_premium_signed,
      history_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    signal.coin,
    ts,
    new Date(ts).toISOString(),
    Number(signal.price),
    side,
    score,
    scoreBucket(score),
    score >= PAPER_ENTRY_SCORE ? 1 : 0,
    signal.market?.signed_score ?? null,
    finalSignal?.news_x?.signed_score ?? null,
    finalSigned,
    signal.market?.components?.chart_signed ?? null,
    signal.market?.components?.order_flow_persistent_signed ?? null,
    signal.market?.components?.oi_change_signed ?? null,
    signal.market?.components?.funding_premium_signed ?? null,
    signal.market?.weights?.mode ?? null
  ).run();

  return {
    recorded: true,
    side,
    score: round(score),
    score_bucket: scoreBucket(score),
    qualifies_entry: score >= PAPER_ENTRY_SCORE,
  };
}

function directionalReturnPct(
  side: string,
  entry: number,
  current: number
): number {
  if (!entry) return 0;
  const raw = ((current - entry) / entry) * 100;
  return side === "SHORT" ? -raw : raw;
}

async function nearestSnapshotPrice(
  env: Env,
  coin: string,
  targetTs: number,
  toleranceMs = 90000
): Promise<{ ts: number; price: number } | null> {
  const row: any = await env.DB!.prepare(`
    SELECT ts, price
    FROM market_snapshots
    WHERE coin = ?
      AND ts BETWEEN ? AND ?
    ORDER BY ABS(ts - ?) ASC
    LIMIT 1
  `).bind(
    coin,
    targetTs - toleranceMs,
    targetTs + toleranceMs,
    targetTs
  ).first();

  if (!row) return null;
  return {
    ts: Number(row.ts),
    price: Number(row.price),
  };
}

async function computeSignalLifetimeOutcome(
  env: Env,
  episode: any
): Promise<any | null> {
  if (!env.DB || !episode?.end_ts || episode?.end_price == null) {
    return null;
  }

  const startTs = Number(episode.start_ts);
  const endTs = Number(episode.end_ts);
  const entry = Number(episode.start_price);
  const endPrice = Number(episode.end_price);
  const side = String(episode.side);

  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) ||
      !Number.isFinite(entry) || !Number.isFinite(endPrice) || entry <= 0) {
    return null;
  }

  const rows: any = await env.DB.prepare(`
    SELECT ts, price
    FROM market_snapshots
    WHERE coin = ?
      AND ts >= ?
      AND ts <= ?
    ORDER BY ts ASC
  `).bind(
    episode.coin,
    startTs,
    endTs
  ).all();

  // Include the exact episode end price even if the cron snapshot timestamp
  // differs by a few milliseconds from end_ts.
  const points = (rows?.results ?? []).map((r: any) => ({
    ts: Number(r.ts),
    price: Number(r.price),
  })).filter((r: any) => Number.isFinite(r.price));

  points.push({ ts: endTs, price: endPrice });
  points.sort((a: any, b: any) => a.ts - b.ts);

  let minP = entry;
  let maxP = entry;
  let tpHit = 0;
  let slHit = 0;
  let firstBarrier: string | null = null;
  let firstBarrierTs: number | null = null;
  const levels = paperLevels(side, entry);

  for (const point of points) {
    const p = point.price;
    minP = Math.min(minP, p);
    maxP = Math.max(maxP, p);

    const tp = side === "SHORT" ? p <= levels.tp : p >= levels.tp;
    const sl = side === "SHORT" ? p >= levels.sl : p <= levels.sl;

    if (tp) tpHit = 1;
    if (sl) slHit = 1;
    if (!firstBarrier && (tp || sl)) {
      firstBarrier = tp ? "TP" : "SL";
      firstBarrierTs = point.ts;
    }
  }

  const mfe = side === "SHORT"
    ? directionalReturnPct(side, entry, minP)
    : directionalReturnPct(side, entry, maxP);
  const mae = side === "SHORT"
    ? directionalReturnPct(side, entry, maxP)
    : directionalReturnPct(side, entry, minP);

  return {
    signal_lifetime_minutes: round((endTs - startTs) / 60000),
    lifetime_return_pct: round(directionalReturnPct(side, entry, endPrice)),
    lifetime_mfe_pct: round(mfe),
    lifetime_mae_pct: round(mae),
    lifetime_tp_hit: tpHit,
    lifetime_sl_hit: slHit,
    lifetime_first_barrier: firstBarrier,
    lifetime_first_barrier_ts: firstBarrierTs,
  };
}

async function updateEpisodeOutcomes(
  env: Env,
  coin: string
): Promise<void> {
  if (!env.DB) return;

  const now = Date.now();
  const activeOrRecent: any = await env.DB.prepare(`
    SELECT *
    FROM signal_episodes
    WHERE coin = ?
      AND (
        outcome_complete = 0
        OR (status = 'CLOSED' AND lifetime_return_pct IS NULL)
      )
      AND start_ts <= ?
    ORDER BY start_ts ASC
    LIMIT 100
  `).bind(coin, now).all();

  for (const ep of activeOrRecent?.results ?? []) {
    const startTs = Number(ep.start_ts);
    const entry = Number(ep.start_price);
    const side = String(ep.side);

    // V1.6.1: once the episode is CLOSED, separately measure what
    // happened only while the signal itself remained alive.
    let lifetime: any = null;
    if (String(ep.status) === "CLOSED" && ep.lifetime_return_pct == null) {
      lifetime = await computeSignalLifetimeOutcome(env, ep);
    }

    const values: Record<string, number | null> = {
      return_1m_pct: ep.return_1m_pct ?? null,
      return_5m_pct: ep.return_5m_pct ?? null,
      return_15m_pct: ep.return_15m_pct ?? null,
      return_30m_pct: ep.return_30m_pct ?? null,
    };

    for (const [minutes, field] of [
      [1, "return_1m_pct"],
      [5, "return_5m_pct"],
      [15, "return_15m_pct"],
      [30, "return_30m_pct"],
    ] as const) {
      if (values[field] !== null) continue;
      const target = startTs + minutes * 60000;
      if (now < target) continue;

      const snap = await nearestSnapshotPrice(
        env,
        coin,
        target
      );
      if (snap) {
        values[field] = round(
          directionalReturnPct(
            side,
            entry,
            snap.price
          )
        );
      }
    }

    const range: any = await env.DB.prepare(`
      SELECT
        MIN(price) AS min_price,
        MAX(price) AS max_price
      FROM market_snapshots
      WHERE coin = ?
        AND ts >= ?
        AND ts <= ?
    `).bind(
      coin,
      startTs,
      Math.min(now, startTs + 30 * 60000)
    ).first();

    let mfe: number | null = null;
    let mae: number | null = null;

    if (
      range &&
      range.min_price !== null &&
      range.max_price !== null
    ) {
      const minP = Number(range.min_price);
      const maxP = Number(range.max_price);

      if (side === "SHORT") {
        mfe = round(
          directionalReturnPct(side, entry, minP)
        );
        mae = round(
          directionalReturnPct(side, entry, maxP)
        );
      } else {
        mfe = round(
          directionalReturnPct(side, entry, maxP)
        );
        mae = round(
          directionalReturnPct(side, entry, minP)
        );
      }
    }

    const barrierRows: any = await env.DB.prepare(`
      SELECT ts, price
      FROM market_snapshots
      WHERE coin = ?
        AND ts >= ?
        AND ts <= ?
      ORDER BY ts ASC
    `).bind(
      coin,
      startTs,
      Math.min(now, startTs + 30 * 60000)
    ).all();

    let tpHit = 0;
    let slHit = 0;
    let firstBarrier: string | null =
      ep.first_barrier ?? null;
    let firstBarrierTs: number | null =
      ep.first_barrier_ts ?? null;

    const levels = paperLevels(side, entry);

    for (const row of barrierRows?.results ?? []) {
      const p = Number(row.price);
      const ts = Number(row.ts);

      const tp =
        side === "SHORT"
          ? p <= levels.tp
          : p >= levels.tp;
      const sl =
        side === "SHORT"
          ? p >= levels.sl
          : p <= levels.sl;

      if (tp) tpHit = 1;
      if (sl) slHit = 1;

      if (!firstBarrier && (tp || sl)) {
        firstBarrier = tp ? "TP" : "SL";
        firstBarrierTs = ts;
      }
    }

    const complete =
      now >= startTs + 30 * 60000 &&
      values.return_30m_pct !== null;

    await env.DB.prepare(`
      UPDATE signal_episodes
      SET
        signal_lifetime_minutes = COALESCE(?, signal_lifetime_minutes),
        lifetime_return_pct = COALESCE(?, lifetime_return_pct),
        lifetime_mfe_pct = COALESCE(?, lifetime_mfe_pct),
        lifetime_mae_pct = COALESCE(?, lifetime_mae_pct),
        lifetime_tp_hit = CASE WHEN ? IS NULL THEN lifetime_tp_hit ELSE ? END,
        lifetime_sl_hit = CASE WHEN ? IS NULL THEN lifetime_sl_hit ELSE ? END,
        lifetime_first_barrier = COALESCE(?, lifetime_first_barrier),
        lifetime_first_barrier_ts = COALESCE(?, lifetime_first_barrier_ts),
        return_1m_pct = ?,
        return_5m_pct = ?,
        return_15m_pct = ?,
        return_30m_pct = ?,
        mfe_pct = ?,
        mae_pct = ?,
        tp_hit = ?,
        sl_hit = ?,
        first_barrier = ?,
        first_barrier_ts = ?,
        outcome_complete = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(
      lifetime?.signal_lifetime_minutes ?? null,
      lifetime?.lifetime_return_pct ?? null,
      lifetime?.lifetime_mfe_pct ?? null,
      lifetime?.lifetime_mae_pct ?? null,
      lifetime ? lifetime.lifetime_tp_hit : null,
      lifetime?.lifetime_tp_hit ?? 0,
      lifetime ? lifetime.lifetime_sl_hit : null,
      lifetime?.lifetime_sl_hit ?? 0,
      lifetime?.lifetime_first_barrier ?? null,
      lifetime?.lifetime_first_barrier_ts ?? null,
      values.return_1m_pct,
      values.return_5m_pct,
      values.return_15m_pct,
      values.return_30m_pct,
      mfe,
      mae,
      tpHit,
      slHit,
      firstBarrier,
      firstBarrierTs,
      complete ? 1 : 0,
      ep.id
    ).run();
  }
}

async function processSignalEpisode(
  env: Env,
  signal: any,
  finalSignal: any
): Promise<any> {
  await ensurePaperTables(env);

  const now = Date.now();
  const price = Number(signal.price);
  const finalSigned = Number(
    finalSignal?.final?.signed_score ??
    signal.market?.signed_score ??
    0
  );
  const score = Math.abs(finalSigned);
  const side = finalSigned >= 0 ? "LONG" : "SHORT";

  const active: any = await env.DB!.prepare(`
    SELECT *
    FROM signal_episodes
    WHERE coin = ? AND status = 'ACTIVE'
    ORDER BY start_ts DESC
    LIMIT 1
  `).bind(signal.coin).first();

  // An episode ends when strength drops below 50,
  // direction flips, or 30 minutes have elapsed.
  if (active) {
    const ageMin =
      (now - Number(active.start_ts)) / 60000;

    let endReason: string | null = null;
    if (score < PAPER_OBSERVATION_MIN_SCORE) {
      endReason = "SCORE_BELOW_50";
    } else if (String(active.side) !== side) {
      endReason = "DIRECTION_FLIP";
    } else if (ageMin >= 30) {
      endReason = "MAX_30M";
    }

    if (endReason) {
      // V1.6.7 HARD CAP FIX:
      // If an episode is discovered after its 30-minute deadline, close it
      // at the stored market snapshot nearest start_ts + 30m instead of
      // incorrectly using the much later current price/time.
      let closeTs = now;
      let closePrice = price;

      if (ageMin >= 30) {
        endReason = "MAX_30M";
        const targetTs = Number(active.start_ts) + 30 * 60000;
        const capSnapshot: any = await env.DB!.prepare(`
          SELECT ts, price
          FROM market_snapshots
          WHERE coin = ?
          ORDER BY ABS(ts - ?) ASC
          LIMIT 1
        `).bind(signal.coin, targetTs).first();

        if (capSnapshot && Number.isFinite(Number(capSnapshot.ts)) && Number.isFinite(Number(capSnapshot.price))) {
          closeTs = Number(capSnapshot.ts);
          closePrice = Number(capSnapshot.price);
        } else {
          // Never record a lifetime beyond 30m even if historical snapshots
          // are unavailable. Price falls back to current, timestamp stays capped.
          closeTs = targetTs;
        }
      }

      await env.DB!.prepare(`
        UPDATE signal_episodes
        SET
          status = 'CLOSED',
          end_ts = ?,
          end_datetime = ?,
          end_price = ?,
          end_reason = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(
        closeTs,
        new Date(closeTs).toISOString(),
        closePrice,
        endReason,
        active.id
      ).run();
    } else {
      // Same continuous signal: do not create another episode.
      if (score > Number(active.peak_score)) {
        await env.DB!.prepare(`
          UPDATE signal_episodes
          SET
            peak_score = ?,
            peak_ts = ?,
            peak_price = ?,
            qualifies_entry =
              CASE WHEN ? >= ? THEN 1
                   ELSE qualifies_entry END,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(
          score,
          now,
          price,
          score,
          PAPER_ENTRY_SCORE,
          active.id
        ).run();
      }

      return {
        action: "EPISODE_CONTINUES",
        episode_id: active.id,
        side,
        current_score: round(score),
        peak_score: round(
          Math.max(score, Number(active.peak_score))
        ),
      };
    }
  }

  if (score < PAPER_OBSERVATION_MIN_SCORE) {
    return {
      action: "NO_EPISODE",
      reason: "BELOW_50",
      score: round(score),
    };
  }

  const insert: any = await env.DB!.prepare(`
    INSERT INTO signal_episodes (
      coin, side, status,
      start_ts, start_datetime,
      start_price, start_score, start_bucket,
      peak_score, peak_ts, peak_price,
      qualifies_entry,
      market_signed, news_signed, final_signed,
      chart_signed, order_flow_persistent_signed,
      oi_change_signed, funding_premium_signed,
      history_mode
    ) VALUES (
      ?, ?, 'ACTIVE',
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).bind(
    signal.coin,
    side,
    now,
    new Date(now).toISOString(),
    price,
    score,
    scoreBucket(score),
    score,
    now,
    price,
    score >= PAPER_ENTRY_SCORE ? 1 : 0,
    signal.market?.signed_score ?? null,
    finalSignal?.news_x?.signed_score ?? null,
    finalSigned,
    signal.market?.components?.chart_signed ?? null,
    signal.market?.components
      ?.order_flow_persistent_signed ?? null,
    signal.market?.components?.oi_change_signed ?? null,
    signal.market?.components?.funding_premium_signed ?? null,
    signal.market?.weights?.mode ?? null
  ).run();

  return {
    action: "EPISODE_OPENED",
    episode_id:
      insert?.meta?.last_row_id ?? null,
    side,
    start_score: round(score),
    start_bucket: scoreBucket(score),
    qualifies_entry: score >= PAPER_ENTRY_SCORE,
  };
}

// ============================================================
// V1.8.5 — 60-64 CONTROL CROSSINGS
// Separate research cohort. Does NOT qualify for paper entry.
// ============================================================
async function record6064Crossing(env: Env, signal: any, finalSignal: any): Promise<any> {
  if (!env.DB) return {recorded:false,reason:"D1_NOT_BOUND"};
  const signed=Number(finalSignal?.final?.signed_score??signal.market?.signed_score??0);
  const score=Math.abs(signed);
  if(score<60||score>=65) return {recorded:false,reason:"OUTSIDE_60_64",score:round(score)};
  const side=signed>=0?"LONG":"SHORT";
  const ep:any=await env.DB.prepare(`SELECT * FROM signal_episodes WHERE coin=? AND status='ACTIVE' AND side=? ORDER BY start_ts DESC LIMIT 1`).bind(signal.coin,side).first();
  if(!ep) return {recorded:false,reason:"NO_ACTIVE_EPISODE"};
  const old:any=await env.DB.prepare(`SELECT id FROM signal_60_64_crossings WHERE episode_id=? LIMIT 1`).bind(ep.id).first();
  if(old) return {recorded:false,reason:"ALREADY_RECORDED",crossing_id:old.id};
  const now=Date.now(),price=Number(signal.price);
  const r:any=await env.DB.prepare(`INSERT OR IGNORE INTO signal_60_64_crossings
    (episode_id,coin,side,crossing_ts,crossing_datetime,crossing_price,crossing_score)
    VALUES (?,?,?,?,?,?,?)`).bind(ep.id,signal.coin,side,now,new Date(now).toISOString(),price,score).run();
  return {recorded:true,crossing_id:r?.meta?.last_row_id??null,episode_id:ep.id,coin:signal.coin,side,crossing_score:round(score),crossing_price:price};
}

async function update6064CrossingOutcomes(env: Env, coin: string): Promise<void> {
  if(!env.DB)return;
  const now=Date.now();
  const q:any=await env.DB.prepare(`SELECT * FROM signal_60_64_crossings WHERE coin=? AND outcome_complete=0 ORDER BY crossing_ts ASC LIMIT 100`).bind(coin).all();
  for(const row of q?.results??[]){
    const start=Number(row.crossing_ts),entry=Number(row.crossing_price),side=String(row.side);
    const v:any={return_1m_pct:row.return_1m_pct??null,return_5m_pct:row.return_5m_pct??null,return_15m_pct:row.return_15m_pct??null,return_30m_pct:row.return_30m_pct??null};
    for(const [m,f] of [[1,"return_1m_pct"],[5,"return_5m_pct"],[15,"return_15m_pct"],[30,"return_30m_pct"]] as const){
      if(v[f]!==null||now<start+m*60000)continue;
      const snap=await nearestSnapshotPrice(env,coin,start+m*60000);
      if(snap)v[f]=round(directionalReturnPct(side,entry,snap.price));
    }
    const pts:any=await env.DB.prepare(`SELECT price FROM market_snapshots WHERE coin=? AND ts>=? AND ts<=? ORDER BY ts ASC`).bind(coin,start,Math.min(now,start+30*60000)).all();
    let minP=entry,maxP=entry;
    for(const x of pts?.results??[]){const px=Number(x.price);if(Number.isFinite(px)){minP=Math.min(minP,px);maxP=Math.max(maxP,px)}}
    const mfe=side==="SHORT"?directionalReturnPct(side,entry,minP):directionalReturnPct(side,entry,maxP);
    const mae=side==="SHORT"?directionalReturnPct(side,entry,maxP):directionalReturnPct(side,entry,minP);
    await env.DB.prepare(`UPDATE signal_60_64_crossings SET return_1m_pct=?,return_5m_pct=?,return_15m_pct=?,return_30m_pct=?,mfe_pct=?,mae_pct=?,outcome_complete=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(v.return_1m_pct,v.return_5m_pct,v.return_15m_pct,v.return_30m_pct,round(mfe),round(mae),v.return_30m_pct!==null?1:0,row.id).run();
  }
}

// ============================================================
// V1.7 — FIRST 65 CROSSING ANALYTICS
// ============================================================
async function record65Crossing(env: Env, signal: any, finalSignal: any): Promise<any> {
  if (!env.DB) return { recorded: false, reason: "D1_NOT_BOUND" };
  const finalSigned = Number(finalSignal?.final?.signed_score ?? signal.market?.signed_score ?? 0);
  const score = Math.abs(finalSigned);
  if (score < PAPER_ENTRY_SCORE) return { recorded: false, reason: "BELOW_65", score: round(score) };
  const side = finalSigned >= 0 ? "LONG" : "SHORT";
  const episode: any = await env.DB.prepare(`
    SELECT * FROM signal_episodes
    WHERE coin=? AND status='ACTIVE' AND side=?
    ORDER BY start_ts DESC LIMIT 1
  `).bind(signal.coin, side).first();
  if (!episode) return { recorded: false, reason: "NO_ACTIVE_EPISODE" };
  const existing: any = await env.DB.prepare(`SELECT id FROM signal_65_crossings WHERE episode_id=? LIMIT 1`).bind(episode.id).first();
  if (existing) return { recorded: false, reason: "ALREADY_RECORDED", crossing_id: existing.id, episode_id: episode.id };
  const now=Date.now(), price=Number(signal.price);
  const r:any=await env.DB.prepare(`
    INSERT OR IGNORE INTO signal_65_crossings (
      episode_id,coin,side,crossing_ts,crossing_datetime,crossing_price,crossing_score,
      market_signed,news_signed,final_signed,chart_signed,order_flow_persistent_signed,
      oi_change_signed,funding_premium_signed,history_mode
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(episode.id,signal.coin,side,now,new Date(now).toISOString(),price,score,
    signal.market?.signed_score??null,finalSignal?.news_x?.signed_score??null,finalSigned,
    signal.market?.components?.chart_signed??null,signal.market?.components?.order_flow_persistent_signed??null,
    signal.market?.components?.oi_change_signed??null,signal.market?.components?.funding_premium_signed??null,
    signal.market?.weights?.mode??null).run();
  return { recorded:true, crossing_id:r?.meta?.last_row_id??null, episode_id:episode.id, coin:signal.coin, side, crossing_score:round(score), crossing_price:price, crossing_ts:now };
}

async function update65CrossingOutcomes(env: Env, coin: string): Promise<void> {
  if (!env.DB) return;
  const now=Date.now();
  const pending:any=await env.DB.prepare(`SELECT * FROM signal_65_crossings WHERE coin=? AND outcome_complete=0 ORDER BY crossing_ts ASC LIMIT 100`).bind(coin).all();
  for (const row of pending?.results??[]) {
    const startTs=Number(row.crossing_ts), entry=Number(row.crossing_price), side=String(row.side);
    const values:any={return_1m_pct:row.return_1m_pct??null,return_5m_pct:row.return_5m_pct??null,return_15m_pct:row.return_15m_pct??null,return_30m_pct:row.return_30m_pct??null};
    for (const [m,f] of [[1,"return_1m_pct"],[5,"return_5m_pct"],[15,"return_15m_pct"],[30,"return_30m_pct"]] as const) {
      if(values[f]!==null) continue; const target=startTs+m*60000; if(now<target) continue;
      const snap=await nearestSnapshotPrice(env,coin,target); if(snap) values[f]=round(directionalReturnPct(side,entry,snap.price));
    }
    const points:any=await env.DB.prepare(`SELECT ts,price FROM market_snapshots WHERE coin=? AND ts>=? AND ts<=? ORDER BY ts ASC`).bind(coin,startTs,Math.min(now,startTs+30*60000)).all();
    let minP=entry,maxP=entry,tpHit=0,slHit=0,firstBarrier:string|null=null,firstBarrierTs:number|null=null;
    const levels=paperLevels(side,entry);
    for(const p of points?.results??[]){const px=Number(p.price);if(!Number.isFinite(px))continue;minP=Math.min(minP,px);maxP=Math.max(maxP,px);const tp=side==="SHORT"?px<=levels.tp:px>=levels.tp;const sl=side==="SHORT"?px>=levels.sl:px<=levels.sl;if(tp)tpHit=1;if(sl)slHit=1;if(!firstBarrier&&(tp||sl)){firstBarrier=tp?"TP":"SL";firstBarrierTs=Number(p.ts);}}
    const mfe=side==="SHORT"?directionalReturnPct(side,entry,minP):directionalReturnPct(side,entry,maxP);
    const mae=side==="SHORT"?directionalReturnPct(side,entry,maxP):directionalReturnPct(side,entry,minP);
    await env.DB.prepare(`UPDATE signal_65_crossings SET return_1m_pct=?,return_5m_pct=?,return_15m_pct=?,return_30m_pct=?,mfe_pct=?,mae_pct=?,tp_hit=?,sl_hit=?,first_barrier=?,first_barrier_ts=?,outcome_complete=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(values.return_1m_pct,values.return_5m_pct,values.return_15m_pct,values.return_30m_pct,round(mfe),round(mae),tpHit,slHit,firstBarrier,firstBarrierTs,values.return_30m_pct!==null?1:0,row.id).run();
  }
}

function paperReturnPct(
  side: string,
  entry: number,
  current: number
): number {
  if (!entry) return 0;
  const raw = ((current - entry) / entry) * 100;
  return side === "SHORT" ? -raw : raw;
}

function paperLevels(side: string, price: number) {
  if (side === "SHORT") {
    return {
      tp: price * (1 - PAPER_TP_PCT / 100),
      sl: price * (1 + PAPER_SL_PCT / 100),
    };
  }
  return {
    tp: price * (1 + PAPER_TP_PCT / 100),
    sl: price * (1 - PAPER_SL_PCT / 100),
  };
}

async function getOpenPaperTrade(
  env: Env,
  coin: string
): Promise<any | null> {
  if (!env.DB) return null;
  await ensurePaperTables(env);

  const row = await env.DB.prepare(`
    SELECT *
    FROM paper_trades
    WHERE coin = ? AND status = 'OPEN'
    ORDER BY entry_ts DESC
    LIMIT 1
  `).bind(coin).first();

  return row ?? null;
}

async function openPaperTrade(
  env: Env,
  signal: any,
  finalSignal?: any
): Promise<any> {
  await ensurePaperTables(env);

  const existing = await getOpenPaperTrade(env, signal.coin);
  if (existing) {
    return {
      opened: false,
      reason: "OPEN_TRADE_ALREADY_EXISTS",
      trade_id: existing.id,
    };
  }

  const marketSigned = Number(
    signal.market?.signed_score ?? 0
  );

  const finalSigned = Number(
    finalSignal?.final?.signed_score ??
    marketSigned
  );

  const score = Math.abs(finalSigned);
  const side = finalSigned >= 0 ? "LONG" : "SHORT";

  if (score < PAPER_ENTRY_SCORE) {
    return {
      opened: false,
      reason: "SCORE_BELOW_ENTRY_THRESHOLD",
      score: round(score),
      required: PAPER_ENTRY_SCORE,
    };
  }

  const finalGap = Math.abs(finalSigned);

  if (finalGap < PAPER_MIN_SCORE_GAP) {
    return {
      opened: false,
      reason: "SCORE_GAP_TOO_SMALL",
      required_gap: PAPER_MIN_SCORE_GAP,
    };
  }

  const price = Number(signal.price ?? 0);
  if (!Number.isFinite(price) || price <= 0) {
    return {
      opened: false,
      reason: "INVALID_ENTRY_PRICE",
    };
  }

  const levels = paperLevels(side, price);
  const now = Date.now();

  const result = await env.DB.prepare(`
    INSERT INTO paper_trades (
      coin, side, status,
      entry_ts, entry_datetime, entry_price,
      entry_score, entry_market_status,
      chart_signed,
      order_flow_raw_signed,
      order_flow_persistent_signed,
      oi_change_signed,
      funding_premium_signed,
      history_mode,
      news_signed,
      final_signed,
      tp_price, sl_price,
      max_hold_minutes,
      max_price, min_price
    ) VALUES (
      ?, ?, 'OPEN',
      ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?
    )
  `).bind(
    signal.coin,
    side,
    now,
    new Date(now).toISOString(),
    price,
    score,
    signal.market?.status ?? null,
    signal.market?.components?.chart_signed ?? null,
    signal.market?.components?.order_flow_raw_signed ?? null,
    signal.market?.components?.order_flow_persistent_signed ?? null,
    signal.market?.components?.oi_change_signed ?? null,
    signal.market?.components?.funding_premium_signed ?? null,
    finalSignal?.final?.mode
      ? `${signal.market?.weights?.mode ?? "UNKNOWN"}|FINAL:${finalSignal.final.mode}`
      : signal.market?.weights?.mode ?? null,
    finalSignal?.news_x?.signed_score ?? null,
    finalSigned,
    levels.tp,
    levels.sl,
    PAPER_MAX_HOLD_MINUTES,
    price,
    price
  ).run();

  return {
    opened: true,
    trade_id:
      result?.meta?.last_row_id ??
      result?.meta?.lastRowId ??
      null,
    coin: signal.coin,
    side,
    entry_price: round(price),
    score: round(score),
    tp_price: round(levels.tp),
    sl_price: round(levels.sl),
    max_hold_minutes: PAPER_MAX_HOLD_MINUTES,
  };
}

async function updatePaperTrade(
  env: Env,
  trade: any,
  currentPrice: number
): Promise<any> {
  const now = Date.now();
  const side = String(trade.side);
  const entry = Number(trade.entry_price);
  const currentReturn = paperReturnPct(
    side,
    entry,
    currentPrice
  );

  const oldMfe = Number(trade.mfe_pct ?? 0);
  const oldMae = Number(trade.mae_pct ?? 0);

  const mfe = Math.max(oldMfe, currentReturn);
  const mae = Math.min(oldMae, currentReturn);

  const maxPrice = Math.max(
    Number(trade.max_price ?? entry),
    currentPrice
  );
  const minPrice = Math.min(
    Number(trade.min_price ?? entry),
    currentPrice
  );

  const ageMinutes =
    (now - Number(trade.entry_ts)) / 60_000;

  let exitReason: string | null = null;

  if (side === "LONG") {
    if (currentPrice >= Number(trade.tp_price)) {
      exitReason = "TAKE_PROFIT";
    } else if (currentPrice <= Number(trade.sl_price)) {
      exitReason = "STOP_LOSS";
    }
  } else {
    if (currentPrice <= Number(trade.tp_price)) {
      exitReason = "TAKE_PROFIT";
    } else if (currentPrice >= Number(trade.sl_price)) {
      exitReason = "STOP_LOSS";
    }
  }

  if (
    !exitReason &&
    ageMinutes >= Number(trade.max_hold_minutes)
  ) {
    exitReason = "TIME_EXIT";
  }

  if (!exitReason) {
    await env.DB.prepare(`
      UPDATE paper_trades
      SET
        mfe_pct = ?,
        mae_pct = ?,
        max_price = ?,
        min_price = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'OPEN'
    `).bind(
      mfe,
      mae,
      maxPrice,
      minPrice,
      trade.id
    ).run();

    return {
      updated: true,
      closed: false,
      trade_id: trade.id,
      current_return_pct: round(currentReturn, 4),
      mfe_pct: round(mfe, 4),
      mae_pct: round(mae, 4),
      age_minutes: round(ageMinutes, 2),
    };
  }

  const gross = currentReturn;
  const feePct = PAPER_FEE_RATE_PER_SIDE * 2 * 100;
  const net = gross - feePct;
  const pnlUsd = PAPER_NOTIONAL_USD * (net / 100);

  await env.DB.prepare(`
    UPDATE paper_trades
    SET
      status = 'CLOSED',
      exit_ts = ?,
      exit_datetime = ?,
      exit_price = ?,
      exit_reason = ?,
      gross_return_pct = ?,
      fee_pct = ?,
      net_return_pct = ?,
      pnl_usd = ?,
      mfe_pct = ?,
      mae_pct = ?,
      max_price = ?,
      min_price = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'OPEN'
  `).bind(
    now,
    new Date(now).toISOString(),
    currentPrice,
    exitReason,
    gross,
    feePct,
    net,
    pnlUsd,
    mfe,
    mae,
    maxPrice,
    minPrice,
    trade.id
  ).run();

  return {
    updated: true,
    closed: true,
    trade_id: trade.id,
    exit_reason: exitReason,
    exit_price: round(currentPrice),
    gross_return_pct: round(gross, 4),
    fee_pct: round(feePct, 4),
    net_return_pct: round(net, 4),
    pnl_usd: round(pnlUsd, 4),
    mfe_pct: round(mfe, 4),
    mae_pct: round(mae, 4),
  };
}

async function processPaperCoin(
  env: Env,
  signal: any,
  finalSignal?: any
): Promise<any> {
  if (!env.DB) {
    return {
      success: false,
      reason: "D1_NOT_BOUND",
    };
  }

  await ensurePaperTables(env);

  const open = await getOpenPaperTrade(env, signal.coin);

  if (open) {
    return {
      action: "UPDATE_OPEN",
      result: await updatePaperTrade(
        env,
        open,
        Number(signal.price)
      ),
    };
  }

  return {
    action: "CHECK_ENTRY",
    result: await openPaperTrade(
      env,
      signal,
      finalSignal
    ),
  };
}

async function paperSummary(env: Env) {
  await ensurePaperTables(env);

  const totals = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) AS closed,
      SUM(CASE WHEN status = 'CLOSED' AND net_return_pct > 0 THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN status = 'CLOSED' AND net_return_pct <= 0 THEN 1 ELSE 0 END) AS losses,
      AVG(CASE WHEN status = 'CLOSED' THEN net_return_pct END) AS avg_net_return_pct,
      SUM(CASE WHEN status = 'CLOSED' THEN pnl_usd ELSE 0 END) AS pnl_usd,
      AVG(CASE WHEN status = 'CLOSED' THEN mfe_pct END) AS avg_mfe_pct,
      AVG(CASE WHEN status = 'CLOSED' THEN mae_pct END) AS avg_mae_pct
    FROM paper_trades
  `).first();

  const closed = Number(totals?.closed ?? 0);
  const wins = Number(totals?.wins ?? 0);

  return {
    total: Number(totals?.total ?? 0),
    open: Number(totals?.open ?? 0),
    closed,
    wins,
    losses: Number(totals?.losses ?? 0),
    win_rate:
      closed > 0 ? round((wins / closed) * 100, 2) : null,
    avg_net_return_pct:
      totals?.avg_net_return_pct == null
        ? null
        : round(Number(totals.avg_net_return_pct), 4),
    pnl_usd: round(Number(totals?.pnl_usd ?? 0), 4),
    avg_mfe_pct:
      totals?.avg_mfe_pct == null
        ? null
        : round(Number(totals.avg_mfe_pct), 4),
    avg_mae_pct:
      totals?.avg_mae_pct == null
        ? null
        : round(Number(totals.avg_mae_pct), 4),
    assumptions: {
      paper_notional_usd: PAPER_NOTIONAL_USD,
      entry_score: PAPER_ENTRY_SCORE,
      min_score_gap: PAPER_MIN_SCORE_GAP,
      take_profit_pct: PAPER_TP_PCT,
      stop_loss_pct: PAPER_SL_PCT,
      max_hold_minutes: PAPER_MAX_HOLD_MINUTES,
      fee_rate_per_side: PAPER_FEE_RATE_PER_SIDE,
      fee_pct_round_trip:
        round(PAPER_FEE_RATE_PER_SIDE * 2 * 100, 4),
    },
  };
}


// ============================================================
// MARKET SIGNAL
// ============================================================

function chartSigned(chart: any): number {
  return clampSigned(
    Number(chart?.long_score ?? 0) -
      Number(chart?.short_score ?? 0)
  );
}

function buildMarketScore(
  chart: any,
  book: any,
  derivatives: any,
  history?: any
) {
  const c = chartSigned(chart);

  const rawOf = clampSigned(
    Number(book?.order_flow?.signed_score ?? 0)
  );

  const persistentOf =
    history?.order_flow_persistence?.available
      ? clampSigned(
          Number(
            history.order_flow_persistence.signed_score ?? rawOf
          )
        )
      : rawOf;

  const oiAvailable =
    history?.oi_change?.available === true;

  const oi = oiAvailable
    ? clampSigned(
        Number(history?.oi_change?.signed_score ?? 0)
      )
    : 0;

  const fundingContext = clampSigned(
    Number(derivatives?.contextual_signed_score ?? 0)
  );

  // Until enough OI history exists, preserve V1.3 weights.
  // Once ΔOI becomes available, switch automatically to:
  // Chart 55 / persistent Order Flow 25 / ΔOI 15 / Funding 5.
  // V1.4.1: Do not give ΔOI the full 15% weight as soon as
  // only the 1m window becomes available.
  //
  // History maturity:
  //   no OI windows      -> OI 0%
  //   1m only            -> OI 5%
  //   1m + 5m            -> OI 10%
  //   1m + 5m + 15m      -> OI 15%
  //
  // The unused OI weight stays with Chart / persistent L2.
  const oiWindows = history?.oi_change?.windows ?? {};

  const oi1m =
    oiWindows?.["1m"]?.available === true;
  const oi5m =
    oiWindows?.["5m"]?.available === true;
  const oi15m =
    oiWindows?.["15m"]?.available === true;

  let oiMaturity = 0;

  if (oi1m) oiMaturity = 1;
  if (oi1m && oi5m) oiMaturity = 2;
  if (oi1m && oi5m && oi15m) oiMaturity = 3;

  const weights =
    oiMaturity === 3
      ? {
          chart: 0.55,
          order_flow: 0.25,
          oi_change: 0.15,
          funding_premium: 0.05,
        }
      : oiMaturity === 2
      ? {
          chart: 0.58,
          order_flow: 0.27,
          oi_change: 0.10,
          funding_premium: 0.05,
        }
      : oiMaturity === 1
      ? {
          chart: 0.61,
          order_flow: 0.29,
          oi_change: 0.05,
          funding_premium: 0.05,
        }
      : {
          chart: 0.65,
          order_flow: 0.30,
          oi_change: 0,
          funding_premium: 0.05,
        };

  const signed =
    c * weights.chart +
    persistentOf * weights.order_flow +
    oi * weights.oi_change +
    fundingContext * weights.funding_premium;

  const signedClamped = clampSigned(signed);

  const longScore =
    signedClamped > 0 ? clamp(signedClamped) : 0;

  const shortScore =
    signedClamped < 0
      ? clamp(Math.abs(signedClamped))
      : 0;

  const strength = Math.max(longScore, shortScore);
  const difference = longScore - shortScore;

  let status = "NO_TRADE";

  if (strength >= 80 && Math.abs(difference) >= 25) {
    status = "STRONG";
  } else if (strength >= 65 && Math.abs(difference) >= 20) {
    status = "WATCH";
  } else if (strength >= 50) {
    status = "WEAK";
  }

  return {
    weights: {
      ...weights,
      mode:
        oiMaturity === 3
          ? "HISTORY_FULL"
          : oiMaturity === 2
          ? "HISTORY_1M_5M"
          : oiMaturity === 1
          ? "HISTORY_1M"
          : "HISTORY_COLLECTING",
      oi_maturity: {
        level: oiMaturity,
        available_windows: {
          "1m": oi1m,
          "5m": oi5m,
          "15m": oi15m,
        },
      },
    },

    components: {
      chart_signed: round(c),
      order_flow_raw_signed: round(rawOf),
      order_flow_persistent_signed: round(persistentOf),
      oi_change_signed: round(oi),
      funding_premium_signed: round(fundingContext),
    },

    signed_score: round(signedClamped),
    long_score: round(longScore),
    short_score: round(shortScore),
    difference: round(difference),
    bias: sideLabel(signedClamped, 10),
    status,
    meaning:
      "Market alignment/strength score, not probability of profit",
  };
}

async function buildSignal(coin: string, env?: Env) {
  const started = Date.now();

  const [chart, book, asset] = await Promise.all([
    buildChart(coin),
    getBook(coin),
    getAssetContext(coin),
  ]);

  const derivatives = buildDerivatives(asset.context);

  const currentTs = Date.now();

  const history = await buildHistoryContext(
    env,
    coin,
    {
      ts: currentTs,
      price: Number(chart.price ?? 0),
      oi:
        derivatives?.open_interest === null ||
        derivatives?.open_interest === undefined
          ? null
          : Number(derivatives.open_interest),
      orderFlowSigned: Number(
        book?.order_flow?.signed_score ?? 0
      ),
    }
  );

  derivatives.open_interest_change =
    history?.oi_change?.available
      ? history.oi_change
      : null;

  derivatives.open_interest_change_status =
    history?.oi_change?.status ??
    "WAITING_FOR_HISTORICAL_SNAPSHOTS";

  const market = buildMarketScore(
    chart.chart,
    book,
    derivatives,
    history
  );

  return {
    source: "HYPERLIQUID",
    coin,
    timestamp: Date.now(),
    datetime: new Date().toISOString(),
    processing_ms: Date.now() - started,

    price: chart.price,

    chart: {
      timeframe_1m: chart.timeframe_1m,
      timeframe_5m: chart.timeframe_5m,
      final: chart.chart,
    },

    microstructure: {
      best_bid: book.best_bid,
      best_ask: book.best_ask,
      spread: book.spread,
      spread_pct: book.spread_pct,
      liquidity: book.liquidity,
      order_flow: book.order_flow,
    },

    derivatives,

    history,

    market,

    execution: {
      enabled: false,
      paper_trade: false,
      real_trade: false,
    },
  };
}


// ============================================================
// V1.3 NEWS + X ENGINE
//
// Official feeds:
// - SEC Press Releases RSS
// - Federal Reserve All Press Releases RSS
// - Federal Reserve Monetary Policy RSS
//
// Optional X:
// - X API v2 recent search
// - Requires X_API_BEARER_TOKEN Cloudflare secret
//
// This first News Engine is deterministic/rule-based.
// It does NOT pretend to be an LLM. We first validate ingestion,
// timestamps, source weighting, relevance, direction and decay.
// A later version can replace/enhance classification with an AI API.
// ============================================================

const NEWS_FEEDS = [
  {
    id: "SEC_PRESS",
    name: "SEC Press Releases",
    url: "https://www.sec.gov/news/pressreleases.rss",
    trust: 100,
    type: "OFFICIAL",
  },
  {
    id: "FED_ALL",
    name: "Federal Reserve Press Releases",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    trust: 100,
    type: "OFFICIAL",
  },
  {
    id: "FED_MONETARY",
    name: "Federal Reserve Monetary Policy",
    url: "https://www.federalreserve.gov/feeds/press_monetary.xml",
    trust: 100,
    type: "OFFICIAL",
  },
  {
    id: "CFTC_GENERAL",
    name: "CFTC General Press Releases",
    url: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml",
    trust: 100,
    type: "OFFICIAL",
  },
  {
    id: "CFTC_ENFORCEMENT",
    name: "CFTC Enforcement Press Releases",
    url: "https://www.cftc.gov/RSS/RSSENF/rssenf.xml",
    trust: 100,
    type: "OFFICIAL",
  },
] as const;

// Keep X queries narrow to control noise and API usage.
// We search crypto/macro terms plus selected primary accounts.
const X_QUERY =
  '((bitcoin OR BTC OR ethereum OR ETH OR solana OR SOL OR XRP OR BNB OR crypto OR cryptocurrency OR stablecoin OR ETF OR "interest rates" OR FOMC) ' +
  '(from:SECGov OR from:federalreserve OR from:CFTC OR from:WhiteHouse OR from:Ripple OR from:solana OR from:ethereum)) -is:retweet';

type NewsItem = {
  id: string;
  source_id: string;
  source_name: string;
  source_type: string;
  source_trust: number;
  title: string;
  text: string;
  url: string | null;
  published_at: string | null;
  published_ms: number | null;
  age_minutes: number | null;
  origin: "RSS" | "X";
  author?: string | null;
  metrics?: AnyObj | null;
};

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstXml(block: string, tag: string): string {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
    "i"
  );
  const m = block.match(re);
  return m ? decodeXml(m[1]) : "";
}

function parseDateMs(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function ageMinutes(ms: number | null): number | null {
  if (ms === null) return null;
  return Math.max(0, (Date.now() - ms) / 60_000);
}

function parseRssItems(
  xml: string,
  source: (typeof NEWS_FEEDS)[number],
  limit = 20
): NewsItem[] {
  const blocks =
    xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ??
    xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ??
    [];

  return blocks.slice(0, limit).map((block, i) => {
    const title = firstXml(block, "title");
    const description =
      firstXml(block, "description") ||
      firstXml(block, "summary") ||
      firstXml(block, "content");

    let link = firstXml(block, "link");

    if (!link) {
      const href = block.match(
        /<link[^>]+href=["']([^"']+)["'][^>]*>/i
      );
      link = href?.[1] ?? "";
    }

    const date =
      firstXml(block, "pubDate") ||
      firstXml(block, "updated") ||
      firstXml(block, "published");

    const publishedMs = parseDateMs(date);

    const guid =
      firstXml(block, "guid") ||
      link ||
      `${source.id}:${title}:${i}`;

    return {
      id: guid,
      source_id: source.id,
      source_name: source.name,
      source_type: source.type,
      source_trust: source.trust,
      title,
      text: `${title} ${description}`.trim(),
      url: link || null,
      published_at:
        publishedMs !== null
          ? new Date(publishedMs).toISOString()
          : date || null,
      published_ms: publishedMs,
      age_minutes: ageMinutes(publishedMs),
      origin: "RSS" as const,
    };
  });
}

async function fetchOfficialFeed(
  source: (typeof NEWS_FEEDS)[number]
): Promise<{
  ok: boolean;
  source: string;
  status: number;
  items: NewsItem[];
  error?: string;
}> {
  try {
    const response = await fetch(source.url, {
      headers: {
        "user-agent":
          "cryptobot-readonly/1.3 contact=market-research",
        accept:
          "application/rss+xml, application/xml, text/xml, */*",
      },
    });

    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        source: source.id,
        status: response.status,
        items: [],
        error: text.slice(0, 250),
      };
    }

    return {
      ok: true,
      source: source.id,
      status: response.status,
      items: parseRssItems(text, source),
    };
  } catch (error: any) {
    return {
      ok: false,
      source: source.id,
      status: 0,
      items: [],
      error: error?.message ?? String(error),
    };
  }
}

function xTrust(username: string): number {
  const u = username.toLowerCase();

  const primary = new Set([
    "secgov",
    "federalreserve",
    "cftc",
    "whitehouse",
    "ripple",
    "solana",
    "ethereum",
  ]);

  return primary.has(u) ? 100 : 70;
}

async function fetchXRecent(env: Env): Promise<{
  enabled: boolean;
  ok: boolean;
  status: number | null;
  query: string;
  items: NewsItem[];
  error?: string;
}> {
  const token = env?.X_API_BEARER_TOKEN;

  if (!token) {
    return {
      enabled: false,
      ok: false,
      status: null,
      query: X_QUERY,
      items: [],
      error: "X_API_BEARER_TOKEN_NOT_CONFIGURED",
    };
  }

  const params = new URLSearchParams({
    query: X_QUERY,
    "tweet.fields":
      "created_at,author_id,public_metrics",
    expansions: "author_id",
    "user.fields": "username,verified,name",
    max_results: "20",
  });

  try {
    const response = await fetch(
      `https://api.x.com/2/tweets/search/recent?${params.toString()}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      }
    );

    const body = await response.json<any>().catch(() => null);

    if (!response.ok) {
      return {
        enabled: true,
        ok: false,
        status: response.status,
        query: X_QUERY,
        items: [],
        error:
          body?.detail ??
          body?.title ??
          JSON.stringify(body)?.slice(0, 300) ??
          "X_API_ERROR",
      };
    }

    const users = new Map<string, any>();

    for (const user of body?.includes?.users ?? []) {
      users.set(String(user?.id ?? ""), user);
    }

    const items: NewsItem[] = (body?.data ?? []).map(
      (post: any) => {
        const user = users.get(String(post?.author_id ?? ""));
        const username = String(user?.username ?? "unknown");
        const publishedMs = parseDateMs(post?.created_at ?? "");

        return {
          id: `x:${post?.id}`,
          source_id: `X_${username}`,
          source_name: `@${username}`,
          source_type: "X_PRIMARY",
          source_trust: xTrust(username),
          title: String(post?.text ?? "").slice(0, 180),
          text: String(post?.text ?? ""),
          url:
            username !== "unknown" && post?.id
              ? `https://x.com/${username}/status/${post.id}`
              : null,
          published_at:
            publishedMs !== null
              ? new Date(publishedMs).toISOString()
              : post?.created_at ?? null,
          published_ms: publishedMs,
          age_minutes: ageMinutes(publishedMs),
          origin: "X" as const,
          author: username,
          metrics: post?.public_metrics ?? null,
        };
      }
    );

    return {
      enabled: true,
      ok: true,
      status: response.status,
      query: X_QUERY,
      items,
    };
  } catch (error: any) {
    return {
      enabled: true,
      ok: false,
      status: 0,
      query: X_QUERY,
      items: [],
      error: error?.message ?? String(error),
    };
  }
}

function dedupeNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];

  for (const item of items) {
    const key = (
      item.id ||
      `${item.source_id}:${item.title}`
    ).toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }

  return out.sort(
    (a, b) => (b.published_ms ?? 0) - (a.published_ms ?? 0)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phraseMatch(text: string, phrase: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedPhrase = phrase.toLowerCase().trim();

  // $TOKEN forms are handled literally.
  if (normalizedPhrase.startsWith("$")) {
    return normalizedText.includes(normalizedPhrase);
  }

  // Use alphanumeric boundaries so "sues" does NOT match "issues".
  const escaped = escapeRegExp(normalizedPhrase).replace(/\s+/g, "\\s+");
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
  return re.test(normalizedText);
}

function textHas(text: string, words: string[]): boolean {
  return words.some((w) => phraseMatch(text, w));
}

function coinRelevance(
  coin: string,
  text: string,
  sourceId: string
): number {
  const t = text.toLowerCase();

  const direct: Record<string, string[]> = {
    BTC: ["bitcoin", " btc", "btc ", "$btc"],
    ETH: ["ethereum", " ether", " eth", "$eth", "staking"],
    SOL: ["solana", " sol", "$sol"],
    XRP: ["xrp", "ripple", "$xrp"],
    BNB: ["bnb", "binance", "$bnb"],
    DOGE: ["dogecoin", " doge", "doge ", "$doge"],
    AVAX: ["avalanche", " avax", "avax ", "$avax"],
    LINK: ["chainlink", " link", "link ", "$link"],
    SUI: ["sui network", " sui", "sui ", "$sui"],
    HYPE: ["hyperliquid", " hype", "hype ", "$hype"],
  };

  if (textHas(t, direct[coin] ?? [])) return 100;

  // Macro / regulatory stories can affect the whole crypto complex.
  const broadCrypto = [
    "crypto",
    "crypto asset",
    "crypto assets",
    "cryptocurrency",
    "digital asset",
    "digital assets",
    "digital commodity",
    "digital commodities",
    "stablecoin",
    "stablecoins",
    "spot etf",
    "exchange-traded fund",
    "blockchain",
    "perpetual contract",
    "perpetual contracts",
    "self-custodial",
    "self custody",
  ];

  if (textHas(t, broadCrypto)) {
    return coin === "BTC" || coin === "ETH" ? 80 : 65;
  }

  const macro = [
    "fomc",
    "federal funds",
    "interest rate",
    "rate cut",
    "rate hike",
    "monetary policy",
    "inflation",
    "liquidity",
  ];

  if (
    sourceId.startsWith("CFTC") &&
    textHas(t, broadCrypto)
  ) {
    if (coin === "BTC" || coin === "ETH") return 85;
    return 70;
  }

  if (
    sourceId.startsWith("FED") &&
    textHas(t, macro)
  ) {
    if (coin === "BTC") return 75;
    if (coin === "ETH") return 65;
    return 50;
  }

  return 0;
}

function classifyDirection(text: string): {
  signed: number;
  direction: string;
  matched_positive: string[];
  matched_negative: string[];
} {
  const positive = [
    "approve",
    "approved",
    "approval",
    "launch",
    "adoption",
    "partnership",
    "rate cut",
    "cuts rates",
    "easing",
    "legal clarity",
    "dismiss",
    "dismissed",
    "settlement",
    "wins",
    "victory",
    "inflows",
    "record inflow",
  ];

  const negative = [
    "charges",
    "charged",
    "lawsuit",
    "sues",
    "fraud",
    "hack",
    "hacked",
    "exploit",
    "ban",
    "banned",
    "reject",
    "rejected",
    "rate hike",
    "raises rates",
    "enforcement",
    "investigation",
    "outflows",
    "liquidation",
    "sanction",
  ];

  const p = positive.filter((x) => phraseMatch(text, x));
  const n = negative.filter((x) => phraseMatch(text, x));

  const raw = clampSigned((p.length - n.length) * 25);

  const policyUnchanged = textHas(text, [
    "maintain the target range",
    "kept rates unchanged",
    "rates unchanged",
    "unchanged target range",
  ]);

  return {
    signed: raw,
    direction:
      raw === 0 && policyUnchanged
        ? "NEUTRAL_POLICY_UNCHANGED"
        : sideLabel(raw, 5),
    matched_positive: p,
    matched_negative: n,
    policy_unchanged: policyUnchanged,
  };
}

function estimateImpact(
  item: NewsItem,
  relevance: number,
  directionStrength: number
): number {
  const t = item.text.toLowerCase();

  let impact = 25;

  if (
    textHas(t, [
      "bitcoin",
      "ethereum",
      "xrp",
      "ripple",
      "solana",
      "bnb",
      "binance",
      "crypto",
      "digital asset",
    ])
  ) {
    impact += 20;
  }

  if (
    textHas(t, [
      "sec",
      "federal reserve",
      "fomc",
      "interest rate",
      "etf",
      "enforcement",
      "lawsuit",
      "approve",
      "approved",
      "hack",
      "exploit",
      "ban",
    ])
  ) {
    impact += 25;
  }

  if (item.source_trust >= 95) impact += 10;
  if (relevance >= 90) impact += 10;
  if (directionStrength >= 50) impact += 10;

  return clamp(impact);
}

function newsDecay(
  ageMin: number | null,
  highImpactContext = false
): number {
  if (ageMin === null) return 0;

  // Scalping engine: stale news must not influence a live entry.
  // Normal stories expire after 6h. Major macro/regulatory context
  // may retain a decaying tail for up to 24h.
  const hardExpiryMin = highImpactContext ? 24 * 60 : 6 * 60;

  if (ageMin > hardExpiryMin) return 0;

  const tau = highImpactContext ? 90 : 14;
  return Math.exp(-ageMin / tau);
}

function classifyNewsForCoin(item: NewsItem, coin: string) {
  const relevance = coinRelevance(
    coin,
    item.text,
    item.source_id
  );

  const dir = classifyDirection(item.text);
  const impact = estimateImpact(
    item,
    relevance,
    Math.abs(dir.signed)
  );

  // Deterministic confidence: primary-source + explicit directional terms.
  let confidence = 45;
  if (item.source_trust >= 95) confidence += 25;
  if (relevance >= 80) confidence += 15;
  if (Math.abs(dir.signed) >= 25) confidence += 15;
  confidence = clamp(confidence);

  const highImpactContext =
    item.source_trust >= 95 &&
    relevance >= 75 &&
    impact >= 75;

  const freshness =
    item.age_minutes === null
      ? "UNKNOWN"
      : item.age_minutes <= 5
      ? "BREAKING_0_5M"
      : item.age_minutes <= 30
      ? "FRESH_5_30M"
      : item.age_minutes <= 120
      ? "RECENT_30_120M"
      : item.age_minutes <= 360
      ? "AGING_2_6H"
      : "STALE";

  const decay = newsDecay(
    item.age_minutes,
    highImpactContext
  );

  const base =
    (item.source_trust / 100) *
    (relevance / 100) *
    (impact / 100) *
    (confidence / 100) *
    decay *
    100;

  const signed =
    dir.signed === 0
      ? 0
      : Math.sign(dir.signed) * base;

  return {
    id: item.id,
    origin: item.origin,
    source: item.source_name,
    source_trust: item.source_trust,
    title: item.title,
    url: item.url,
    published_at: item.published_at,
    age_minutes:
      item.age_minutes === null
        ? null
        : round(item.age_minutes, 2),

    coin,
    relevance,
    impact,
    confidence,
    decay: round(decay, 4),
    freshness,
    active_for_live_signal: decay > 0,
    expired: decay === 0,

    direction: sideLabel(signed, 1),
    raw_direction_score: dir.signed,
    score_signed: round(signed),
    score_long: signed > 0 ? round(signed) : 0,
    score_short: signed < 0 ? round(Math.abs(signed)) : 0,

    matched_positive: dir.matched_positive,
    matched_negative: dir.matched_negative,
    policy_unchanged: dir.policy_unchanged,
  };
}

function aggregateNewsForCoin(
  coin: string,
  items: NewsItem[]
) {
  const classified = items
    .map((x) => classifyNewsForCoin(x, coin))
    .filter((x) => x.relevance > 0)
    .sort(
      (a, b) =>
        Math.abs(b.score_signed) -
        Math.abs(a.score_signed)
    );

  // Prevent many similar low-value stories from simply summing to 100.
  // Strongest item dominates, next items provide confirmation.
  const active = classified.filter(
    (x) => x.active_for_live_signal
  );

  const top = active.slice(0, 5);

  let signed = 0;

  const weights = [1.0, 0.45, 0.25, 0.15, 0.10];

  for (let i = 0; i < top.length; i++) {
    signed += top[i].score_signed * weights[i];
  }

  signed = clampSigned(signed);

  const strongest = top[0] ?? null;

  const breaking =
    strongest !== null &&
    strongest.source_trust >= 95 &&
    strongest.relevance >= 80 &&
    strongest.impact >= 75 &&
    strongest.confidence >= 80 &&
    (strongest.age_minutes ?? 9999) <= 15;

  return {
    coin,
    items_considered: classified.length,
    active_items: active.length,
    expired_items: classified.length - active.length,
    top_items: top,
    signed_score: round(signed),
    long_score: signed > 0 ? round(signed) : 0,
    short_score: signed < 0 ? round(Math.abs(signed)) : 0,
    bias: sideLabel(signed, 5),
    breaking_high_impact: breaking,
  };
}

async function collectNews(env: Env) {
  const [feedResults, x] = await Promise.all([
    Promise.all(NEWS_FEEDS.map((feed) => fetchOfficialFeed(feed))),
    fetchXRecent(env),
  ]);

  const official = feedResults.flatMap((x) => x.items);

  const all = dedupeNews([
    ...official,
    ...x.items,
  ]);

  return {
    timestamp: Date.now(),
    datetime: new Date().toISOString(),
    official_feeds: feedResults.map((x) => ({
      source: x.source,
      ok: x.ok,
      status: x.status,
      items: x.items.length,
      error: x.error ?? null,
    })),
    x: {
      enabled: x.enabled,
      ok: x.ok,
      status: x.status,
      items: x.items.length,
      error: x.error ?? null,
      query: x.query,
    },
    total_items: all.length,
    items: all,
  };
}

function combineMarketAndNews(
  market: any,
  news: any
) {
  const marketSigned = clampSigned(
    Number(market?.signed_score ?? 0)
  );

  const newsSigned = clampSigned(
    Number(news?.signed_score ?? 0)
  );

  // V1.5.1:
  // No active news = do not dilute a valid market signal with zero.
  // Active normal news = 70/30.
  // Breaking high-impact news = 40/60.
  const activeNewsItems = Number(
    news?.active_items ?? 0
  );

  let marketWeight = 1.00;
  let newsWeight = 0.00;
  let mode = "MARKET_ONLY_NO_ACTIVE_NEWS";

  if (activeNewsItems > 0) {
    marketWeight = 0.70;
    newsWeight = 0.30;
    mode = "NORMAL_NEWS_ACTIVE";
  }

  if (
    activeNewsItems > 0 &&
    news?.breaking_high_impact
  ) {
    marketWeight = 0.40;
    newsWeight = 0.60;
    mode = "BREAKING_NEWS";
  }

  const signed = clampSigned(
    marketSigned * marketWeight +
    newsSigned * newsWeight
  );

  const longScore = signed > 0 ? clamp(signed) : 0;
  const shortScore = signed < 0 ? clamp(Math.abs(signed)) : 0;
  const strength = Math.max(longScore, shortScore);

  let status = "NO_TRADE";

  if (strength >= 80) status = "STRONG";
  else if (strength >= 65) status = "WATCH";
  else if (strength >= 50) status = "WEAK";

  return {
    mode,
    weights: {
      market: marketWeight,
      news_x: newsWeight,
    },
    components: {
      market_signed: round(marketSigned),
      news_x_signed: round(newsSigned),
    },
    signed_score: round(signed),
    long_score: round(longScore),
    short_score: round(shortScore),
    bias: sideLabel(signed, 10),
    status,
    execution_allowed: false,
    meaning:
      "Combined market/news alignment score, not probability of profit",
  };
}

async function buildNewsOnly(env: Env) {
  const collected = await collectNews(env);

  const sourceHealth = {
    configured_official_feeds: NEWS_FEEDS.length,
    working_official_feeds: collected.official_feeds.filter(
      (x: any) => x.ok
    ).length,
    failed_official_feeds: collected.official_feeds.filter(
      (x: any) => !x.ok
    ).length,
    x_enabled: collected.x.enabled,
    x_ok: collected.x.ok,
  };

  return {
    ...collected,
    source_health: sourceHealth,
    scores: Object.fromEntries(
      TRACKED_COINS.map((coin) => [
        coin,
        aggregateNewsForCoin(coin, collected.items),
      ])
    ),
  };
}

async function buildFinalSignal(
  coin: string,
  env: Env,
  preloadedNews?: any
) {
  const started = Date.now();

  const [marketSignal, newsData] = await Promise.all([
    buildSignal(coin, env),
    preloadedNews
      ? Promise.resolve(preloadedNews)
      : buildNewsOnly(env),
  ]);

  const news =
    newsData?.scores?.[coin] ??
    aggregateNewsForCoin(coin, newsData?.items ?? []);

  const final = combineMarketAndNews(
    marketSignal.market,
    news
  );

  return {
    source: {
      market: "HYPERLIQUID",
      news: "OFFICIAL_RSS",
      x:
        newsData?.x?.enabled
          ? "X_API_V2"
          : "DISABLED_NO_TOKEN",
    },
    coin,
    timestamp: Date.now(),
    datetime: new Date().toISOString(),
    processing_ms: Date.now() - started,

    price: marketSignal.price,

    market: marketSignal.market,
    chart: marketSignal.chart,
    microstructure: marketSignal.microstructure,
    derivatives: marketSignal.derivatives,

    news_x: news,

    final,

    execution: {
      enabled: false,
      paper_trade: false,
      real_trade: false,
    },
  };
}


// ============================================================
// DEBUG
// ============================================================

async function debugHyperliquid() {
  const started = Date.now();

  try {
    const [mids, meta] = await Promise.all([
      getAllMids(),
      getMetaAndContexts(),
    ]);

    return {
      success: true,
      source: "HYPERLIQUID",
      endpoint: HYPERLIQUID_INFO,
      latency_ms: Date.now() - started,
      tracked_coins: TRACKED_COINS,
      mids_found: Object.fromEntries(
        TRACKED_COINS.map((coin) => [
          coin,
          mids?.[coin] ?? null,
        ])
      ),
      meta_response: Array.isArray(meta),
      meta_parts: Array.isArray(meta) ? meta.length : 0,
    };
  } catch (error: any) {
    return {
      success: false,
      source: "HYPERLIQUID",
      latency_ms: Date.now() - started,
      error: error?.message ?? String(error),
    };
  }
}

// ============================================================
// WORKER
// ============================================================


// ============================================================
// V1.6.9 SAFE LEGACY REPAIR
// Repairs historical CLOSED episodes whose stored signal lifetime
// exceeded the hard 30-minute episode cap. This is research/data
// cleanup only; it does not change scoring or trading thresholds.
// ============================================================
async function repairLegacyOver30mEpisodes(
  env: Env,
  requestedCoin: string | null = null,
  limit = 100
): Promise<any> {
  if (!env.DB) return { success:false, error:"D1_NOT_BOUND", legacy_found:0, repaired:0, unrecoverable:0, failed:0, diagnostics:[] };

  await ensurePaperTables(env);
  const where = requestedCoin
    ? `status='CLOSED' AND coin=? AND (signal_lifetime_minutes > 30 OR (end_ts IS NOT NULL AND end_ts-start_ts > 1800000) OR (end_reason='MAX_30M' AND (end_ts IS NULL OR end_ts < start_ts OR signal_lifetime_minutes < 0)))`
    : `status='CLOSED' AND (signal_lifetime_minutes > 30 OR (end_ts IS NOT NULL AND end_ts-start_ts > 1800000) OR (end_reason='MAX_30M' AND (end_ts IS NULL OR end_ts < start_ts OR signal_lifetime_minutes < 0)))`;
  const sql = `SELECT * FROM signal_episodes WHERE ${where} ORDER BY start_ts ASC LIMIT ?`;
  const rows:any = requestedCoin
    ? await env.DB.prepare(sql).bind(requestedCoin, limit).all()
    : await env.DB.prepare(sql).bind(limit).all();
  const legacy:any[] = rows?.results ?? [];
  const diagnostics:any[] = [];
  let repaired=0, unrecoverable=0, failed=0;
  const MAX_DISTANCE_MS = 90 * 1000; // must be genuinely near +30m

  for (const ep of legacy) {
    try {
      const startTs=Number(ep.start_ts);
      const targetTs=startTs + 30*60000;
      const snap:any = await env.DB.prepare(`
        SELECT ts, price FROM market_snapshots
        WHERE coin=? AND ts>=? AND ts<=?
        ORDER BY ABS(ts-?) ASC LIMIT 1
      `).bind(ep.coin, targetTs-MAX_DISTANCE_MS, targetTs+MAX_DISTANCE_MS, targetTs).first();

      const snapTs = snap ? Number(snap.ts) : NaN;
      const snapPrice = snap ? Number(snap.price) : NaN;
      const valid = Number.isFinite(snapTs) && Number.isFinite(snapPrice) && snapTs >= startTs && Math.abs(snapTs-targetTs) <= MAX_DISTANCE_MS;

      if (!valid) {
        // Do not invent a 30m close. Quarantine corrupted/overlong legacy row
        // from lifetime research while preserving its start and fixed-horizon fields.
        await env.DB.prepare(`UPDATE signal_episodes SET
          end_ts=NULL, end_datetime=NULL, end_price=NULL,
          end_reason='LEGACY_30M_UNRECOVERABLE',
          signal_lifetime_minutes=NULL, lifetime_return_pct=NULL,
          lifetime_mfe_pct=NULL, lifetime_mae_pct=NULL,
          lifetime_tp_hit=0, lifetime_sl_hit=0,
          lifetime_first_barrier=NULL, lifetime_first_barrier_ts=NULL,
          updated_at=CURRENT_TIMESTAMP
          WHERE id=? AND status='CLOSED'`).bind(ep.id).run();
        unrecoverable++;
        diagnostics.push({id:ep.id,coin:ep.coin,success:false,quarantined:true,reason:'NO_SNAPSHOT_WITHIN_90S_OF_30M',target_ts:targetTs,target_datetime:new Date(targetTs).toISOString()});
        continue;
      }

      const synthetic={...ep,end_ts:snapTs,end_datetime:new Date(snapTs).toISOString(),end_price:snapPrice,end_reason:'MAX_30M'};
      const lifetime=await computeSignalLifetimeOutcome(env, synthetic);
      if (!lifetime || Number(lifetime.signal_lifetime_minutes) < 0 || Number(lifetime.signal_lifetime_minutes) > 31.5) {
        failed++;
        diagnostics.push({id:ep.id,coin:ep.coin,success:false,reason:'SAFE_LIFETIME_VALIDATION_FAILED'});
        continue;
      }
      await env.DB.prepare(`UPDATE signal_episodes SET
        end_ts=?, end_datetime=?, end_price=?, end_reason='MAX_30M',
        signal_lifetime_minutes=?, lifetime_return_pct=?, lifetime_mfe_pct=?, lifetime_mae_pct=?,
        lifetime_tp_hit=?, lifetime_sl_hit=?, lifetime_first_barrier=?, lifetime_first_barrier_ts=?,
        updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='CLOSED'`).bind(
          snapTs,new Date(snapTs).toISOString(),snapPrice,
          lifetime.signal_lifetime_minutes,lifetime.lifetime_return_pct,lifetime.lifetime_mfe_pct,lifetime.lifetime_mae_pct,
          lifetime.lifetime_tp_hit,lifetime.lifetime_sl_hit,lifetime.lifetime_first_barrier,lifetime.lifetime_first_barrier_ts,ep.id
        ).run();
      repaired++;
      diagnostics.push({id:ep.id,coin:ep.coin,success:true,target_30m_ts:targetTs,snapshot_ts:snapTs,snapshot_distance_seconds:round(Math.abs(snapTs-targetTs)/1000),signal_lifetime_minutes:lifetime.signal_lifetime_minutes});
    } catch(error:any) {
      failed++;
      diagnostics.push({id:ep.id,coin:ep.coin,success:false,error:error?.message ?? String(error)});
    }
  }
  return {success:failed===0,legacy_found:legacy.length,repaired,unrecoverable,failed,diagnostics};
}


async function updateForwardLongShadow(env:any):Promise<void>{
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS forward_long_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crossing_id INTEGER UNIQUE,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      crossing_ts INTEGER NOT NULL,
      crossing_datetime TEXT,
      entry_price REAL NOT NULL,
      score REAL,
      tp_pct REAL NOT NULL DEFAULT 0.50,
      sl_pct REAL NOT NULL DEFAULT 0.15,
      tp_price REAL,
      sl_price REAL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      exit_type TEXT,
      exit_ts INTEGER,
      exit_datetime TEXT,
      exit_price REAL,
      gross_return_pct REAL,
      fee_pct REAL NOT NULL DEFAULT 0.07,
      net_return_pct REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // A crossing is eligible only while still incomplete, so deployment does not backfill historical completed rows.
  const fresh:any=await env.DB.prepare(`
    SELECT id, coin, side, crossing_ts, crossing_datetime, crossing_price, crossing_score
    FROM signal_65_crossings
    WHERE side='LONG' AND outcome_complete=0
    ORDER BY crossing_ts ASC
  `).all();

  for(const c of (fresh?.results??[])){
    const entry=Number(c.crossing_price);
    if(!Number.isFinite(entry)||entry<=0) continue;
    await env.DB.prepare(`
      INSERT OR IGNORE INTO forward_long_shadow
      (crossing_id,coin,side,crossing_ts,crossing_datetime,entry_price,score,tp_pct,sl_pct,tp_price,sl_price,status,fee_pct)
      VALUES(?,?,?,?,?,?,?,0.50,0.15,?,?,'OPEN',0.07)
    `).bind(
      c.id,c.coin,"LONG",c.crossing_ts,c.crossing_datetime,entry,Number(c.crossing_score??0),
      entry*1.005,entry*0.9985
    ).run();
  }

  const open:any=await env.DB.prepare(`
    SELECT * FROM forward_long_shadow WHERE status='OPEN' ORDER BY crossing_ts ASC
  `).all();

  for(const t of (open?.results??[])){
    const snaps:any=await env.DB.prepare(`
      SELECT ts, datetime, price
      FROM market_snapshots
      WHERE coin=? AND ts>? AND ts<=?
      ORDER BY ts ASC
    `).bind(t.coin,t.crossing_ts,t.crossing_ts+30*60*1000).all();

    const arr:any[]=snaps?.results??[];
    let exitType:string|null=null, exitPrice:number|null=null, exitTs:number|null=null, exitDt:string|null=null;
    for(const s of arr){
      const px=Number(s.price);
      if(px>=Number(t.tp_price)){ exitType="TP"; exitPrice=Number(t.tp_price); exitTs=s.ts; exitDt=s.datetime; break; }
      if(px<=Number(t.sl_price)){ exitType="SL"; exitPrice=Number(t.sl_price); exitTs=s.ts; exitDt=s.datetime; break; }
    }

    const now=Date.now();
    if(!exitType && now>=Number(t.crossing_ts)+30*60*1000){
      const last=arr.length?arr[arr.length-1]:null;
      if(last){
        exitType="TIME_30M"; exitPrice=Number(last.price); exitTs=last.ts; exitDt=last.datetime;
      }
    }
    if(!exitType||exitPrice===null) continue;

    const gross=(exitPrice/Number(t.entry_price)-1)*100;
    const net=gross-0.07;
    await env.DB.prepare(`
      UPDATE forward_long_shadow
      SET status='CLOSED',exit_type=?,exit_ts=?,exit_datetime=?,exit_price=?,
          gross_return_pct=?,net_return_pct=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(exitType,exitTs,exitDt,exitPrice,gross,net,t.id).run();
  }
}

async function updateForwardShortShadow(env:any):Promise<void>{
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS forward_short_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crossing_id INTEGER UNIQUE,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      crossing_ts INTEGER NOT NULL,
      crossing_datetime TEXT,
      entry_price REAL NOT NULL,
      score REAL,
      tp_pct REAL NOT NULL DEFAULT 0.50,
      sl_pct REAL NOT NULL DEFAULT 0.40,
      tp_price REAL,
      sl_price REAL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      exit_type TEXT,
      exit_ts INTEGER,
      exit_datetime TEXT,
      exit_price REAL,
      gross_return_pct REAL,
      fee_pct REAL NOT NULL DEFAULT 0.07,
      net_return_pct REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // A crossing is eligible only while still incomplete, so deployment does not backfill historical completed rows.
  const fresh:any=await env.DB.prepare(`
    SELECT id, coin, side, crossing_ts, crossing_datetime, crossing_price, crossing_score
    FROM signal_65_crossings
    WHERE side='SHORT' AND outcome_complete=0
    ORDER BY crossing_ts ASC
  `).all();

  for(const c of (fresh?.results??[])){
    const entry=Number(c.crossing_price);
    if(!Number.isFinite(entry)||entry<=0) continue;
    await env.DB.prepare(`
      INSERT OR IGNORE INTO forward_short_shadow
      (crossing_id,coin,side,crossing_ts,crossing_datetime,entry_price,score,tp_pct,sl_pct,tp_price,sl_price,status,fee_pct)
      VALUES(?,?,?,?,?,?,?,0.50,0.40,?,?,'OPEN',0.07)
    `).bind(
      c.id,c.coin,"SHORT",c.crossing_ts,c.crossing_datetime,entry,Number(c.crossing_score??0),
      entry*0.995,entry*1.004
    ).run();
  }

  const open:any=await env.DB.prepare(`
    SELECT * FROM forward_short_shadow WHERE status='OPEN' ORDER BY crossing_ts ASC
  `).all();

  for(const t of (open?.results??[])){
    const snaps:any=await env.DB.prepare(`
      SELECT ts, datetime, price
      FROM market_snapshots
      WHERE coin=? AND ts>? AND ts<=?
      ORDER BY ts ASC
    `).bind(t.coin,t.crossing_ts,t.crossing_ts+30*60*1000).all();

    const arr:any[]=snaps?.results??[];
    let exitType:string|null=null, exitPrice:number|null=null, exitTs:number|null=null, exitDt:string|null=null;
    for(const s of arr){
      const px=Number(s.price);
      if(px<=Number(t.tp_price)){ exitType="TP"; exitPrice=Number(t.tp_price); exitTs=s.ts; exitDt=s.datetime; break; }
      if(px>=Number(t.sl_price)){ exitType="SL"; exitPrice=Number(t.sl_price); exitTs=s.ts; exitDt=s.datetime; break; }
    }

    const now=Date.now();
    if(!exitType && now>=Number(t.crossing_ts)+30*60*1000){
      const last=arr.length?arr[arr.length-1]:null;
      if(last){
        exitType="TIME_30M"; exitPrice=Number(last.price); exitTs=last.ts; exitDt=last.datetime;
      }
    }
    if(!exitType||exitPrice===null) continue;

    const gross=(Number(t.entry_price)/exitPrice-1)*100;
    const net=gross-0.07;
    await env.DB.prepare(`
      UPDATE forward_short_shadow
      SET status='CLOSED',exit_type=?,exit_ts=?,exit_datetime=?,exit_price=?,
          gross_return_pct=?,net_return_pct=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(exitType,exitTs,exitDt,exitPrice,gross,net,t.id).run();
  }
}


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (request.method !== "GET") {
      return json(
        {
          success: false,
          error: "METHOD_NOT_ALLOWED",
        },
        405
      );
    }

    // ROOT
    if (url.pathname === "/") {
      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "READ_ONLY",
        trading: "DISABLED",
        source: "HYPERLIQUID",
        tracked_coins: TRACKED_COINS,

        engines: {
          chart: true,
          closed_candle_fix: true,
          order_book: true,
          derivatives_context: true,
          oi_change: true,
          d1_snapshot_history: true,
          l2_persistence: true,
          news_x: true,
          x_optional_bearer_token: true,
          official_rss: true,
          fast_news_engine: true,
          cftc_rss: true,
          stale_news_hard_expiry: true,
          paper_trading: true,
          real_trading: false,
        },

        endpoints: {
          health: "/health",
          market: "/market",
          candles:
            "/candles?coin=BTC&interval=1m&limit=60",
          book: "/book?coin=BTC",
          chart: "/chart?coin=BTC",
          charts: "/charts",
          signal: "/signal?coin=BTC",
          signals: "/signals",
          news: "/news",
          news_score: "/news-score?coin=BTC",
          final_signal: "/final-signal?coin=BTC",
          final_signals: "/final-signals",
          history: "/history?coin=BTC&minutes=20",
          snapshot_status: "/snapshot-status?coin=BTC",
          paper_status: "/paper-status",
          paper_candidate: "/paper-candidate?coin=BTC",
          paper_trades: "/paper-trades?status=ALL&limit=50",
          paper_summary: "/paper-summary",
          paper_analytics: "/paper-analytics",
          paper_observations: "/paper-observations?limit=100",
          episodes: "/episodes?limit=50",
          episode_analytics: "/episode-analytics",
          episode_candidates: "/episode-candidates",
          crossings_65: "/crossings-65?limit=100",
          control_crossings_60_64: "/crossings-60-64?limit=100",
          control_60_64_analytics: "/crossing-60-64-analytics",
          control_60_64_tp_sl_matrix: "/tp-sl-matrix-60-64",
          crossing_65_analytics: "/crossing-65-analytics",
          tp_sl_matrix: "/tp-sl-matrix",
          tp_sl_matrix_by_side: "/tp-sl-matrix-by-side",
          forward_long_shadow: "/forward-long-shadow",
          forward_long_shadow_dashboard: "/forward-long-shadow-dashboard",
          debug: "/debug-hyperliquid",
        },

        next_version:
          "V1.9.11 — RAW HYPERLIQUID BALANCE DIAGNOSTIC",
      });
    }

    // HEALTH
    if (url.pathname === "/health") {
      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        status: "ONLINE",
        mode: "READ_ONLY",
        trading: false,
        timestamp: Date.now(),
      });
    }

    // MARKET
    if (url.pathname === "/market") {
      try {
        return json({
          success: true,
          ...(await getMarket()),
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "MARKET_FETCH_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // CANDLES
    if (url.pathname === "/candles") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      const interval =
        url.searchParams.get("interval") ?? "1m";

      let limit = Number(
        url.searchParams.get("limit") ?? "60"
      );

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      if (
        !(ALLOWED_INTERVALS as readonly string[]).includes(
          interval
        )
      ) {
        return json(
          {
            success: false,
            error: "INVALID_INTERVAL",
            allowed: ALLOWED_INTERVALS,
          },
          400
        );
      }

      if (!Number.isFinite(limit)) limit = 60;

      limit = Math.max(
        1,
        Math.min(500, Math.floor(limit))
      );

      try {
        return json({
          success: true,
          ...(await getCandles(coin, interval, limit)),
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "CANDLE_FETCH_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // BOOK
    if (url.pathname === "/book") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      try {
        return json({
          success: true,
          ...(await getBook(coin)),
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "BOOK_FETCH_FAILED",
            coin,
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // CHART
    if (url.pathname === "/chart") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      try {
        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "READ_ONLY",
          ...(await buildChart(coin)),
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "CHART_ENGINE_FAILED",
            coin,
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // CHARTS
    if (url.pathname === "/charts") {
      const started = Date.now();

      try {
        const results = await Promise.all(
          TRACKED_COINS.map((coin) => buildChart(coin))
        );

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "READ_ONLY",
          source: "HYPERLIQUID",
          trading: "DISABLED",
          timestamp: Date.now(),
          processing_ms: Date.now() - started,
          total: results.length,
          charts: results,
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "ALL_CHARTS_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // SIGNAL
    if (url.pathname === "/signal") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      try {
        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "READ_ONLY",
          trading: "DISABLED",
          ...(await buildSignal(coin, env)),
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "SIGNAL_ENGINE_FAILED",
            coin,
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // SIGNALS
    if (url.pathname === "/signals") {
      const started = Date.now();

      try {
        const results = await Promise.all(
          TRACKED_COINS.map((coin) => buildSignal(coin, env))
        );

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "READ_ONLY",
          source: "HYPERLIQUID",
          trading: "DISABLED",
          timestamp: Date.now(),
          processing_ms: Date.now() - started,
          total: results.length,
          signals: results,
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "ALL_SIGNALS_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // NEWS RAW + SCORES
    if (url.pathname === "/news") {
      try {
        const data = await buildNewsOnly(env);

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "READ_ONLY",
          ...data,
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "NEWS_ENGINE_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // NEWS SCORE FOR ONE COIN
    if (url.pathname === "/news-score") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      try {
        const data = await buildNewsOnly(env);

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "READ_ONLY",
          coin,
          x: data.x,
          official_feeds: data.official_feeds,
          news_x: data.scores[coin],
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "NEWS_SCORE_FAILED",
            coin,
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // FINAL MARKET + NEWS SIGNAL
    if (url.pathname === "/final-signal") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      try {
        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "READ_ONLY",
          trading: "DISABLED",
          ...(await buildFinalSignal(coin, env)),
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "FINAL_SIGNAL_FAILED",
            coin,
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // ALL FINAL SIGNALS
    if (url.pathname === "/final-signals") {
      const started = Date.now();

      try {
        // Load news once and reuse it for all five coins.
        const newsData = await buildNewsOnly(env);

        const results = await Promise.all(
          TRACKED_COINS.map((coin) =>
            buildFinalSignal(coin, env, newsData)
          )
        );

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "READ_ONLY",
          trading: "DISABLED",
          timestamp: Date.now(),
          processing_ms: Date.now() - started,
          total: results.length,
          x: newsData.x,
          official_feeds: newsData.official_feeds,
          signals: results,
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "ALL_FINAL_SIGNALS_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // V1.6.6 EPISODE CANDIDATES DIAGNOSTIC
    // Shows why each tracked coin is or is not creating an episode.
    // READ ONLY: does not create/close episodes or paper trades.
    if (url.pathname === "/episode-candidates") {
      if (!env.DB) {
        return json(
          { success: false, error: "D1_NOT_BOUND" },
          503
        );
      }

      await ensurePaperTables(env);
      const started = Date.now();

      try {
        // One news load reused across all five coins, matching /final-signals.
        const newsData = await buildNewsOnly(env);
        const finalSignals = await Promise.all(
          TRACKED_COINS.map((coin) =>
            buildFinalSignal(coin, env, newsData)
          )
        );

        const candidates: any[] = [];

        for (let i = 0; i < TRACKED_COINS.length; i++) {
          const coin = TRACKED_COINS[i];
          const fs: any = finalSignals[i];
          const signed = Number(fs?.final?.signed_score ?? 0);
          const absScore = Math.abs(signed);
          const side = signed >= 0 ? "LONG" : "SHORT";

          const activeEpisode: any = await env.DB.prepare(`
            SELECT *
            FROM signal_episodes
            WHERE coin = ? AND status = 'ACTIVE'
            ORDER BY start_ts DESC
            LIMIT 1
          `).bind(coin).first();

          const lastEpisode: any = await env.DB.prepare(`
            SELECT *
            FROM signal_episodes
            WHERE coin = ?
            ORDER BY start_ts DESC
            LIMIT 1
          `).bind(coin).first();

          const lastObservation: any = await env.DB.prepare(`
            SELECT *
            FROM paper_signal_observations
            WHERE coin = ?
            ORDER BY ts DESC
            LIMIT 1
          `).bind(coin).first();

          const lastSnapshot: any = await env.DB.prepare(`
            SELECT *
            FROM market_snapshots
            WHERE coin = ?
            ORDER BY ts DESC
            LIMIT 1
          `).bind(coin).first();

          let episodeAction = "NO_EPISODE";
          let reason = "BELOW_50";

          if (activeEpisode) {
            const ageMin =
              (Date.now() - Number(activeEpisode.start_ts)) / 60000;

            if (absScore < PAPER_OBSERVATION_MIN_SCORE) {
              episodeAction = "WOULD_CLOSE_ACTIVE";
              reason = "SCORE_BELOW_50";
            } else if (String(activeEpisode.side) !== side) {
              episodeAction = "WOULD_CLOSE_AND_FLIP";
              reason = "DIRECTION_FLIP";
            } else if (ageMin >= 30) {
              episodeAction = "WOULD_CLOSE_ACTIVE";
              reason = "MAX_30M";
            } else {
              episodeAction = "EPISODE_CONTINUES";
              reason = "ACTIVE_SAME_DIRECTION";
            }
          } else if (absScore >= PAPER_OBSERVATION_MIN_SCORE) {
            episodeAction = "WOULD_START_EPISODE";
            reason = "SCORE_AT_OR_ABOVE_50";
          }

          candidates.push({
            coin,
            price: fs?.price ?? null,
            current_final_score: round(signed),
            side,
            abs_score: round(absScore),
            episode_threshold: PAPER_OBSERVATION_MIN_SCORE,
            episode_eligible: absScore >= PAPER_OBSERVATION_MIN_SCORE,
            paper_entry_threshold: PAPER_ENTRY_SCORE,
            paper_entry_eligible: absScore >= PAPER_ENTRY_SCORE,
            episode_action_now: episodeAction,
            reason,
            history_mode:
              fs?.market?.weights?.mode ?? null,
            market_signed:
              fs?.market?.signed_score ?? null,
            news_signed:
              fs?.news_x?.signed_score ?? null,
            components: {
              chart_signed:
                fs?.market?.components?.chart_signed ?? null,
              order_flow_persistent_signed:
                fs?.market?.components?.order_flow_persistent_signed ?? null,
              oi_change_signed:
                fs?.market?.components?.oi_change_signed ?? null,
              funding_premium_signed:
                fs?.market?.components?.funding_premium_signed ?? null,
            },
            current_episode: activeEpisode ?? null,
            last_episode: lastEpisode ?? null,
            last_raw_observation: lastObservation ?? null,
            last_snapshot: lastSnapshot ?? null,
          });
        }

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "EPISODE_CANDIDATES_DIAGNOSTIC",
          trading: "REAL_TRADING_DISABLED",
          read_only: true,
          timestamp: Date.now(),
          processing_ms: Date.now() - started,
          thresholds: {
            episode_abs_score: PAPER_OBSERVATION_MIN_SCORE,
            paper_entry_abs_score: PAPER_ENTRY_SCORE,
          },
          summary: {
            tracked: candidates.length,
            episode_eligible_now: candidates.filter(
              (x) => x.episode_eligible
            ).length,
            active_episodes: candidates.filter(
              (x) => x.current_episode !== null
            ).length,
            coins_with_any_episode: candidates.filter(
              (x) => x.last_episode !== null
            ).length,
          },
          candidates,
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            worker: "cryptobot",
            version: VERSION,
            error: "EPISODE_CANDIDATES_DIAGNOSTIC_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // V1.6.5 FORCE CLOSED EPISODE BACKFILL
    // READ/RESEARCH endpoint: recalculates lifetime fields for CLOSED episodes
    // whose lifetime outcome has not yet been measured, and returns each step.
    if (url.pathname === "/episode-backfill") {
      if (!env.DB) {
        return json(
          { success: false, error: "D1_NOT_BOUND" },
          503
        );
      }

      await ensurePaperTables(env);

      const requestedCoin = String(
        url.searchParams.get("coin") ?? ""
      ).trim().toUpperCase();

      if (requestedCoin && !validCoin(requestedCoin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      const limit = Math.max(
        1,
        Math.min(
          Number(url.searchParams.get("limit") ?? 20),
          100
        )
      );

      // V1.6.5 FIX: fetch CLOSED episodes without filtering on any
      // lifetime column. Some D1 rows created before the lifetime migration
      // were not being selected reliably by the previous SQL predicate.
      // Missing lifetime fields are filtered in JavaScript instead.
      const query = requestedCoin
        ? `
          SELECT *
          FROM signal_episodes
          WHERE coin = ?
            AND status = 'CLOSED'
          ORDER BY start_ts ASC
          LIMIT ?
        `
        : `
          SELECT *
          FROM signal_episodes
          WHERE status = 'CLOSED'
          ORDER BY start_ts ASC
          LIMIT ?
        `;

      const closed: any = requestedCoin
        ? await env.DB.prepare(query).bind(requestedCoin, limit).all()
        : await env.DB.prepare(query).bind(limit).all();

      const closedRows: any[] = closed?.results ?? [];

      // V1.6.5 FIX: force every CLOSED episode through the lifetime
      // calculation. Do not depend on migrated lifetime column values here.
      // The calculation is deterministic, so rerunning this endpoint is safe.
      const pendingRows: any[] = closedRows;

      const diagnostics: any[] = [];
      let updated = 0;
      let failed = 0;

      for (const ep of pendingRows) {
        try {
          const snapshots: any = await env.DB.prepare(`
            SELECT COUNT(*) AS count
            FROM market_snapshots
            WHERE coin = ?
              AND ts >= ?
              AND ts <= ?
          `).bind(
            ep.coin,
            Number(ep.start_ts),
            Number(ep.end_ts)
          ).first();

          const lifetime = await computeSignalLifetimeOutcome(
            env,
            ep
          );

          if (!lifetime) {
            failed += 1;
            diagnostics.push({
              id: ep.id,
              coin: ep.coin,
              side: ep.side,
              status: ep.status,
              snapshots_found: Number(snapshots?.count ?? 0),
              calculation_success: false,
              update_success: false,
              reason: "LIFETIME_CALCULATION_RETURNED_NULL",
              inputs: {
                start_ts: ep.start_ts,
                end_ts: ep.end_ts,
                start_price: ep.start_price,
                end_price: ep.end_price,
              },
            });
            continue;
          }

          const write: any = await env.DB.prepare(`
            UPDATE signal_episodes
            SET
              signal_lifetime_minutes = ?,
              lifetime_return_pct = ?,
              lifetime_mfe_pct = ?,
              lifetime_mae_pct = ?,
              lifetime_tp_hit = ?,
              lifetime_sl_hit = ?,
              lifetime_first_barrier = ?,
              lifetime_first_barrier_ts = ?,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
              AND status = 'CLOSED'
          `).bind(
            lifetime.signal_lifetime_minutes,
            lifetime.lifetime_return_pct,
            lifetime.lifetime_mfe_pct,
            lifetime.lifetime_mae_pct,
            lifetime.lifetime_tp_hit,
            lifetime.lifetime_sl_hit,
            lifetime.lifetime_first_barrier,
            lifetime.lifetime_first_barrier_ts,
            ep.id
          ).run();

          const verify: any = await env.DB.prepare(`
            SELECT
              signal_lifetime_minutes,
              lifetime_return_pct,
              lifetime_mfe_pct,
              lifetime_mae_pct,
              lifetime_tp_hit,
              lifetime_sl_hit,
              lifetime_first_barrier,
              lifetime_first_barrier_ts
            FROM signal_episodes
            WHERE id = ?
          `).bind(ep.id).first();

          const updateSuccess =
            verify?.lifetime_return_pct !== null &&
            verify?.lifetime_return_pct !== undefined;

          if (updateSuccess) updated += 1;
          else failed += 1;

          diagnostics.push({
            id: ep.id,
            coin: ep.coin,
            side: ep.side,
            snapshots_found: Number(snapshots?.count ?? 0),
            calculation_success: true,
            calculated: lifetime,
            d1_write: {
              success: write?.success ?? null,
              changes: write?.meta?.changes ?? null,
            },
            update_success: updateSuccess,
            stored: verify ?? null,
          });
        } catch (error: any) {
          failed += 1;
          diagnostics.push({
            id: ep.id,
            coin: ep.coin,
            side: ep.side,
            calculation_success: false,
            update_success: false,
            error: error?.message ?? String(error),
          });
        }
      }

      return json({
        success: failed === 0,
        worker: "cryptobot",
        version: VERSION,
        mode: "LIFETIME_BACKFILL_DIAGNOSTIC",
        trading: "REAL_TRADING_DISABLED",
        requested_coin: requestedCoin || "ALL",
        closed_episodes_found: closedRows.length,
        episodes_found: pendingRows.length,
        episodes_updated: updated,
        episodes_failed: failed,
        diagnostics,
      });
    }

    // V1.6.10 REPAIR DIAGNOSTIC — read-only inspection of legacy rows #4/#5.
    // No database mutations are performed by this endpoint.
    if (url.pathname === "/episode-repair-diagnostic") {
      if (!env.DB) {
        return json({ success: false, error: "D1_NOT_BOUND" }, 503);
      }

      await ensurePaperTables(env);

      const result: any = await env.DB.prepare(`
        SELECT * FROM signal_episodes
        WHERE id IN (4,5)
        ORDER BY id ASC
      `).all();

      const rows: any[] = result?.results ?? [];
      const diagnostics = rows.map((ep: any) => {
        const startTs = Number(ep.start_ts);
        const endTs = ep.end_ts == null ? null : Number(ep.end_ts);
        const lifetime = ep.signal_lifetime_minutes == null
          ? null
          : Number(ep.signal_lifetime_minutes);
        const endReason = ep.end_reason == null ? null : String(ep.end_reason);

        const checks = {
          status_closed: String(ep.status) === "CLOSED",
          lifetime_over_30: Number.isFinite(lifetime as number) && (lifetime as number) > 30,
          stored_duration_over_30: Number.isFinite(startTs) && Number.isFinite(endTs as number) && ((endTs as number) - startTs) > 1800000,
          end_before_start: Number.isFinite(startTs) && Number.isFinite(endTs as number) && (endTs as number) < startTs,
          lifetime_negative: Number.isFinite(lifetime as number) && (lifetime as number) < 0,
          end_reason_max_30m: endReason === "MAX_30M",
          end_reason_unrecoverable: endReason === "LEGACY_30M_UNRECOVERABLE",
        };

        const matches_v169_selector =
          checks.status_closed && (
            checks.lifetime_over_30 ||
            checks.stored_duration_over_30 ||
            (checks.end_reason_max_30m && (
              ep.end_ts == null ||
              checks.end_before_start ||
              checks.lifetime_negative
            ))
          );

        return {
          id: ep.id,
          coin: ep.coin,
          side: ep.side,
          status: ep.status,
          start_ts: ep.start_ts,
          start_datetime: ep.start_datetime,
          end_ts: ep.end_ts,
          end_datetime: ep.end_datetime,
          end_reason: ep.end_reason,
          signal_lifetime_minutes: ep.signal_lifetime_minutes,
          computed_duration_minutes: Number.isFinite(startTs) && Number.isFinite(endTs as number)
            ? round(((endTs as number) - startTs) / 60000)
            : null,
          checks,
          matches_v169_selector,
        };
      });

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "REPAIR_DIAGNOSTIC_READ_ONLY",
        trading: "REAL_TRADING_DISABLED",
        read_only: true,
        requested_ids: [4,5],
        rows_found: rows.length,
        diagnostics,
      });
    }

    // V1.6.9 LEGACY REPAIR — manually repair historical episodes >30m/corrupt.
    if (url.pathname === "/episode-legacy-repair") {
      if (!env.DB) {
        return json({ success: false, error: "D1_NOT_BOUND" }, 503);
      }

      const requestedCoinRaw = String(
        url.searchParams.get("coin") ?? ""
      ).trim().toUpperCase();
      const requestedCoin = requestedCoinRaw || null;

      if (requestedCoin && !validCoin(requestedCoin)) {
        return json(
          { success: false, error: "INVALID_COIN", allowed: TRACKED_COINS },
          400
        );
      }

      const limit = Math.max(
        1,
        Math.min(Number(url.searchParams.get("limit") ?? 100), 500)
      );

      const result = await repairLegacyOver30mEpisodes(
        env,
        requestedCoin,
        limit
      );

      return json({
        worker: "cryptobot",
        version: VERSION,
        mode: "LEGACY_30M_REPAIR",
        trading: "REAL_TRADING_DISABLED",
        requested_coin: requestedCoin ?? "ALL",
        ...result,
      });
    }

    // V1.6 DEDUPLICATED SIGNAL EPISODES
    if (url.pathname === "/crossings-60-64") {
      if(!env.DB)return json({success:false,error:"D1_NOT_BOUND"},503);
      await ensurePaperTables(env);
      const limit=Math.max(1,Math.min(Number(url.searchParams.get("limit")??100),500));
      const r:any=await env.DB.prepare(`SELECT * FROM signal_60_64_crossings ORDER BY crossing_ts DESC LIMIT ?`).bind(limit).all();
      return json({success:true,worker:"cryptobot",version:VERSION,mode:"60_64_CONTROL_CROSSINGS",trading:"REAL_TRADING_DISABLED",range:"60 <= score < 65",total:r?.results?.length??0,crossings:r?.results??[]});
    }

    if (url.pathname === "/crossing-60-64-analytics") {
      if(!env.DB)return json({success:false,error:"D1_NOT_BOUND"},503);
      await ensurePaperTables(env);
      const r:any=await env.DB.prepare(`SELECT * FROM signal_60_64_crossings WHERE outcome_complete=1 ORDER BY crossing_ts ASC`).all();
      const rows:any[]=r?.results??[];
      const avg=(key:string)=>rows.length?round(rows.reduce((s:any,x:any)=>s+Number(x[key]??0),0)/rows.length,4):null;
      return json({success:true,worker:"cryptobot",version:VERSION,mode:"60_64_CONTROL_ANALYTICS",trading:"REAL_TRADING_DISABLED",
        methodology:{cohort:"first observed score from 60 inclusive to 65 exclusive inside an active episode",paper_entry:false,purpose:"control group against >=65 crossings"},
        completed:rows.length,
        averages:{return_1m_pct:avg("return_1m_pct"),return_5m_pct:avg("return_5m_pct"),return_15m_pct:avg("return_15m_pct"),return_30m_pct:avg("return_30m_pct"),mfe_pct:avg("mfe_pct"),mae_pct:avg("mae_pct")},
        by_side:["LONG","SHORT"].map(side=>{const a=rows.filter(x=>x.side===side);const av=(k:string)=>a.length?round(a.reduce((s,x)=>s+Number(x[k]??0),0)/a.length,4):null;return {side,count:a.length,avg_30m_pct:av("return_30m_pct"),avg_mfe_pct:av("mfe_pct"),avg_mae_pct:av("mae_pct")}})
      });
    }

    if (url.pathname === "/crossings-65") {
      if (!env.DB) return json({success:false,error:"D1_NOT_BOUND"},503);
      await ensurePaperTables(env);
      const limit=Math.max(1,Math.min(Number(url.searchParams.get("limit")??100),500));
      const r:any=await env.DB.prepare(`SELECT * FROM signal_65_crossings ORDER BY crossing_ts DESC LIMIT ?`).bind(limit).all();
      return json({success:true,worker:"cryptobot",version:VERSION,mode:"65_CROSSING_RESEARCH",trading:"REAL_TRADING_DISABLED",threshold:PAPER_ENTRY_SCORE,total:r?.results?.length??0,crossings:r?.results??[]});
    }

    if (url.pathname === "/tp-sl-matrix-60-64") {
      if (!env.DB) return json({success:false,error:"D1_NOT_BOUND"},503);
      await ensurePaperTables(env);

      const q:any=await env.DB.prepare(`
        SELECT id,coin,side,crossing_ts,crossing_price,crossing_score,
               return_30m_pct,outcome_complete
        FROM signal_60_64_crossings
        WHERE outcome_complete=1
        ORDER BY crossing_ts ASC
      `).all();
      const crossings:any[]=q?.results??[];

      if(!crossings.length){
        return json({success:true,worker:"cryptobot",version:VERSION,
          mode:"TP_SL_MATRIX_60_64_CONTROL_RESEARCH",trading:"REAL_TRADING_DISABLED",
          crossings_used:0,combinations:0,top_by_net_return:[],matrix:[]});
      }

      // V1.8.4 DATA WINDOW FIX:
      // Merge only the actual +30m crossing windows per coin.
      // This avoids loading the entire time span between the oldest/newest crossing.
      const byCoin=new Map<string,{start:number,end:number}[]>();
      for(const c of crossings){
        const t=Number(c.crossing_ts);
        if(!Number.isFinite(t)) continue;
        const coin=String(c.coin);
        if(!byCoin.has(coin)) byCoin.set(coin,[]);
        byCoin.get(coin)!.push({start:t,end:t+30*60*1000});
      }

      const mergedWindows:{coin:string,start:number,end:number}[]=[];
      for(const [coin,windows] of byCoin){
        windows.sort((a,b)=>a.start-b.start);
        let cur:any=null;
        for(const w of windows){
          if(!cur) cur={coin,start:w.start,end:w.end};
          else if(w.start<=cur.end){
            cur.end=Math.max(cur.end,w.end);
          }else{
            mergedWindows.push(cur);
            cur={coin,start:w.start,end:w.end};
          }
        }
        if(cur) mergedWindows.push(cur);
      }

      const snapshotsByCoin=new Map<string,any[]>();
      let snapshotsLoaded=0;
      let snapshotQueries=0;

      // One query per merged real window, not per TP/SL combination.
      for(const w of mergedWindows){
        const r:any=await env.DB.prepare(`
          SELECT coin,ts,price
          FROM market_snapshots
          WHERE coin=? AND ts>=? AND ts<=?
          ORDER BY ts ASC
        `).bind(w.coin,w.start,w.end).all();
        snapshotQueries++;
        const rows:any[]=r?.results??[];
        snapshotsLoaded+=rows.length;
        if(!snapshotsByCoin.has(w.coin)) snapshotsByCoin.set(w.coin,[]);
        snapshotsByCoin.get(w.coin)!.push(...rows);
      }

      for(const rows of snapshotsByCoin.values())
        rows.sort((a:any,b:any)=>Number(a.ts)-Number(b.ts));

      const prepared=crossings.map((c:any)=>{
        const t=Number(c.crossing_ts),end=t+30*60*1000;
        const all=snapshotsByCoin.get(String(c.coin))??[];
        const snaps=all.filter((s:any)=>Number(s.ts)>=t&&Number(s.ts)<=end);
        return {...c,_snaps:snaps};
      });

      const tpValues=[0.20,0.25,0.30,0.35,0.40,0.50];
      const slValues=[0.15,0.20,0.25,0.30,0.35,0.40];
      const feePct=PAPER_FEE_RATE_PER_SIDE*2*100;
      const matrix:any[]=[];

      for(const tp of tpValues) for(const sl of slValues){
        let tpFirst=0,slFirst=0,timeExit=0,grossSum=0;
        const netReturns:number[]=[];
        for(const c of prepared){
          const entryPrice=Number(c.crossing_price);
          if(!Number.isFinite(entryPrice)||entryPrice<=0) continue;
          let gross:number|null=null,hit:string|null=null;
          for(const x of c._snaps){
            const px=Number(x.price);
            if(!Number.isFinite(px)||px<=0) continue;
            const r=c.side==="SHORT"
              ?((entryPrice-px)/entryPrice)*100
              :((px-entryPrice)/entryPrice)*100;
            if(r>=tp){gross=tp;hit="TP";break}
            if(r<=-sl){gross=-sl;hit="SL";break}
          }
          if(hit==="TP")tpFirst++;
          else if(hit==="SL")slFirst++;
          else{
            timeExit++;
            const r=Number(c.return_30m_pct);
            gross=Number.isFinite(r)?r:0;
          }
          grossSum+=Number(gross??0);
          netReturns.push(Number(gross??0)-feePct);
        }
        const netSum=netReturns.reduce((a,b)=>a+b,0);
        const a=[...netReturns].sort((x,y)=>x-y);
        const med=!a.length?null:(a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2);
        matrix.push({
          tp_pct:tp,sl_pct:sl,completed:netReturns.length,
          tp_first:tpFirst,sl_first:slFirst,time_exit_30m:timeExit,
          gross_return_sum_pct:round(grossSum,4),
          net_return_sum_pct:round(netSum,4),
          avg_net_return_pct:netReturns.length?round(netSum/netReturns.length,4):null,
          median_net_return_pct:med===null?null:round(med,4),
          pnl_usd_at_100_notional_each:round(netSum,4),
          profitable_after_fees:netSum>0
        });
      }

      const ranked=[...matrix].sort((a:any,b:any)=>Number(b.net_return_sum_pct)-Number(a.net_return_sum_pct));

      return json({
        success:true,worker:"cryptobot",version:VERSION,
        mode:"TP_SL_MATRIX_60_64_CONTROL_RESEARCH",trading:"REAL_TRADING_DISABLED",
        performance:{
          crossing_query:1,
          snapshot_queries:snapshotQueries,
          total_d1_queries:1+snapshotQueries,
          merged_data_windows:mergedWindows.length,
          raw_crossing_windows:crossings.length,
          snapshots_loaded:snapshotsLoaded,
          calculation:"IN_MEMORY",
          optimization:"ONLY_ACTUAL_MERGED_30M_CROSSING_WINDOWS"
        },
        methodology:{
          trigger:"completed 60-64 control crossings only",
          replay:"minute market_snapshots only inside each crossing +30m window",
          tp_values_pct:tpValues,sl_values_pct:slValues,
          round_trip_fee_pct:round(feePct,4),
          time_exit:"directional return_30m_pct if neither sampled barrier is reached",
          limitation:"minute sampled prices can miss intraminute TP/SL touches; research only"
        },
        crossings_used:crossings.length,combinations:matrix.length,
        current_config:{tp_pct:PAPER_TP_PCT,sl_pct:PAPER_SL_PCT},
        top_by_net_return:ranked.slice(0,10),matrix
      });
    }



    if (url.pathname === "/forward-dashboard") {
      await env.DB.prepare(`CREATE TABLE IF NOT EXISTS forward_short_shadow (
        id INTEGER PRIMARY KEY AUTOINCREMENT, crossing_id INTEGER UNIQUE, coin TEXT NOT NULL, side TEXT NOT NULL,
        crossing_ts INTEGER NOT NULL, crossing_datetime TEXT, entry_price REAL NOT NULL, score REAL,
        tp_pct REAL NOT NULL DEFAULT 0.50, sl_pct REAL NOT NULL DEFAULT 0.40, tp_price REAL, sl_price REAL,
        status TEXT NOT NULL DEFAULT 'OPEN', exit_type TEXT, exit_ts INTEGER, exit_datetime TEXT, exit_price REAL,
        gross_return_pct REAL, fee_pct REAL NOT NULL DEFAULT 0.07, net_return_pct REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      )`).run();

      const lq:any=await env.DB.prepare(`SELECT * FROM forward_long_shadow ORDER BY crossing_ts DESC LIMIT 3000`).all();
      const sq:any=await env.DB.prepare(`SELECT * FROM forward_short_shadow ORDER BY crossing_ts DESC LIMIT 3000`).all();
      const all:any[]=[...(lq?.results??[]),...(sq?.results??[])].sort((a:any,b:any)=>Number(b.crossing_ts)-Number(a.crossing_ts));

      const dayKey=(ts:any)=>{
        const d=new Date(Number(ts));
        const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Sofia",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(d);
        const o:any={}; for(const p of parts) o[p.type]=p.value;
        return `${o.year}-${o.month}-${o.day}`;
      };
      const now=Date.now(), today=dayKey(now), yesterday=dayKey(now-86400000);
      const period=(url.searchParams.get("period")||"today").toLowerCase();
      const selected=all.filter((x:any)=>{
        const k=dayKey(x.crossing_ts);
        if(period==="all") return true;
        if(period==="7d") return Number(x.crossing_ts)>=now-7*86400000;
        if(period==="yesterday") return k===yesterday;
        return k===today;
      });

      const stats=(rows:any[],side?:string)=>{
        const r=side?rows.filter(x=>x.side===side):rows;
        const c=r.filter(x=>x.status==="CLOSED"),tp=c.filter(x=>x.exit_type==="TP").length,sl=c.filter(x=>x.exit_type==="SL").length;
        const net=c.reduce((s:number,x:any)=>s+Number(x.net_return_pct??0),0);
        return {total:r.length,open:r.filter(x=>x.status==="OPEN").length,closed:c.length,tp,sl,time:c.filter(x=>x.exit_type==="TIME_30M").length,
          wr:c.length?tp/c.length*100:0,net,avg:c.length?net/c.length:0};
      };
      const LS=stats(selected,"LONG"), SS=stats(selected,"SHORT"), AS=stats(selected);

      const groups:any={};
      for(const x of selected){const k=dayKey(x.crossing_ts);(groups[k]??=[]).push(x);}
      const days=Object.keys(groups).sort().reverse();

      const fmt=(v:any)=>{const n=Number(v);if(!Number.isFinite(n))return"—";return (Math.abs(n)>=100?n.toFixed(2):Math.abs(n)>=1?n.toFixed(4):n.toFixed(6)).replace(/0+$/,"").replace(/\.$/,"")};
      const pct=(v:any)=>{const n=Number(v);return Number.isFinite(n)?`${n>0?"+":""}${n.toFixed(2)}%`:"—"};
      const dt=(v:any)=>{try{return new Intl.DateTimeFormat("bg-BG",{timeZone:"Europe/Sofia",hour:"2-digit",minute:"2-digit"}).format(new Date(v))}catch{return"—"}};
      const badge=(x:any)=>x.status==="OPEN"?'<span class="badge open">● OPEN</span>':x.exit_type==="TP"?'<span class="badge win">✓ TP</span>':x.exit_type==="SL"?'<span class="badge loss">✕ SL</span>':'<span class="badge time">◷ TIME</span>';
      const side=(x:any)=>x.side==="LONG"?'<span class="side long">↑ LONG</span>':'<span class="side short">↓ SHORT</span>';
      const duration=(x:any)=>x.exit_ts?`${Math.max(0,Math.round((Number(x.exit_ts)-Number(x.crossing_ts))/60000))}m`:"OPEN";

      const panel=(name:string,s:any,cls:string,rule:string)=>`<section class="panel ${cls}">
        <div class="ph"><div><h2>${name}</h2><small>${rule}</small></div><b class="${s.net>=0?"pos":"neg"}">${pct(s.net)}</b></div>
        <div class="metrics"><div><small>Сделки</small><b>${s.total}</b></div><div><small>TP / SL</small><b>${s.tp} / ${s.sl}</b></div><div><small>Win rate</small><b>${s.wr.toFixed(1)}%</b></div><div><small>Avg net</small><b class="${s.avg>=0?"pos":"neg"}">${pct(s.avg)}</b></div><div><small>P/L $1000</small><b class="${s.net>=0?"pos":"neg"}">$${(s.net*10).toFixed(2)}</b></div></div>
      </section>`;

      const dayBlocks=days.map((d:string,di:number)=>{
        const rows=groups[d], ds=stats(rows);
        const cards=rows.map((x:any)=>`<div class="trade">
          <div class="top"><div><b>${x.coin}</b> ${side(x)}</div>${badge(x)}</div>
          <div class="meta">${dt(x.crossing_datetime)} · Score ${Number(x.score??0).toFixed(2)} · ${duration(x)}</div>
          <div class="prices"><div><small>ENTRY</small><b>${fmt(x.entry_price)}</b></div><div><small>TP</small><b class="pos">${fmt(x.tp_price)}</b></div><div><small>SL</small><b class="neg">${fmt(x.sl_price)}</b></div><div><small>NET</small><b class="${Number(x.net_return_pct??0)>=0?"pos":"neg"}">${x.status==="OPEN"?"—":pct(x.net_return_pct)}</b></div></div>
        </div>`).join("");
        const pretty=d.split("-").reverse().join(".");
        return `<details class="day" ${di===0?"open":""}><summary><div><b>📅 ${pretty}</b><span>${rows.length} сделки · ${ds.tp} TP / ${ds.sl} SL</span></div><strong class="${ds.net>=0?"pos":"neg"}">${pct(ds.net)}</strong></summary><div class="daybody">${cards}</div></details>`;
      }).join("");

      const history=Object.keys(all.reduce((g:any,x:any)=>{const k=dayKey(x.crossing_ts);(g[k]??=[]).push(x);return g;},{})).sort().reverse().slice(0,14).map((d:string)=>{
        const rows=all.filter(x=>dayKey(x.crossing_ts)===d), l=stats(rows,"LONG"), s=stats(rows,"SHORT"), a=stats(rows);
        return `<tr><td>${d.split("-").reverse().join(".")}</td><td>${rows.length}</td><td class="${l.net>=0?"pos":"neg"}">${pct(l.net)}</td><td class="${s.net>=0?"pos":"neg"}">${pct(s.net)}</td><td class="${a.net>=0?"pos":"neg"}"><b>${pct(a.net)}</b></td></tr>`;
      }).join("");

      const tab=(key:string,label:string)=>`<a class="${period===key?"active":""}" href="/forward-dashboard?period=${key}">${label}</a>`;
      const html=`<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>CryptoBot Forward</title>
      <style>*{box-sizing:border-box}body{margin:0;background:#09101e;color:#eef3fb;font-family:system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:1050px;margin:auto;padding:16px}h1{margin:0;font-size:24px}.sub,.meta,small{color:#8292aa}.head{display:flex;justify-content:space-between;align-items:end;gap:10px}.live{color:#64dda0;font-size:12px}.tabs{display:flex;gap:7px;overflow:auto;margin:17px 0}.tabs a{white-space:nowrap;text-decoration:none;color:#a8b5ca;background:#121b2e;border:1px solid #27344e;padding:9px 13px;border-radius:999px;font-size:13px}.tabs a.active{background:#263d69;color:white;border-color:#5578ba}.compare{display:grid;grid-template-columns:1fr 1fr;gap:11px}.panel{background:#111a2d;border:1px solid #26334d;border-radius:15px;padding:14px}.lp{border-top:3px solid #62dc9d}.sp{border-top:3px solid #ff8490}.ph{display:flex;justify-content:space-between}.ph h2{margin:0;font-size:18px}.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:12px}.metrics div,.prices div{background:#0a1323;border-radius:9px;padding:8px}.metrics small,.prices small{display:block;font-size:9px}.metrics b{font-size:14px}.pos{color:#62dc9d}.neg{color:#ff7f8d}.sectiontitle{margin:21px 0 9px}.day{background:#10192b;border:1px solid #25324b;border-radius:14px;margin-bottom:9px;overflow:hidden}.day summary{cursor:pointer;display:flex;justify-content:space-between;align-items:center;padding:13px;list-style:none}.day summary span{display:block;color:#7f90aa;font-size:11px;margin-top:3px}.daybody{padding:0 10px 10px}.trade{background:#0b1425;border-radius:11px;padding:11px;margin-top:7px}.top{display:flex;justify-content:space-between}.side,.badge{font-size:9px;font-weight:800;border-radius:999px;padding:4px 6px}.long,.win{background:#14382b;color:#6ce2a3}.short,.loss{background:#40202a;color:#ff8c98}.open{background:#413716;color:#ffdb72}.time{background:#25314a;color:#b7c5dc}.prices{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:9px}.prices b{font-size:11px}.history{overflow:auto;background:#10192b;border:1px solid #25324b;border-radius:14px}table{width:100%;border-collapse:collapse;min-width:520px}th,td{padding:10px;text-align:left;border-bottom:1px solid #202c43;font-size:12px}th{color:#8292aa}.foot{color:#65758e;font-size:11px;margin-top:12px}@media(max-width:720px){.wrap{padding:11px}.head{display:block}.live{margin-top:4px}.compare{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(3,1fr)}.prices{grid-template-columns:repeat(2,1fr)}}</style></head>
      <body><main class="wrap"><div class="head"><div><h1>📊 Forward LONG vs SHORT</h1><div class="sub">≥65 · Sofia time · fee 0.07%</div></div><div class="live">● PAPER · refresh 30s</div></div>
      <nav class="tabs">${tab("today","Днес")}${tab("yesterday","Вчера")}${tab("7d","7 дни")}${tab("all","Всички")}</nav>
      <div class="compare">${panel("↑ LONG",LS,"lp","TP +0.50% · SL −0.15%")}${panel("↓ SHORT",SS,"sp","TP +0.50% · SL −0.40%")}</div>
      <h3 class="sectiontitle">Сделки по дни</h3>${dayBlocks||'<div class="day"><summary>Няма сделки за периода.</summary></div>'}
      <h3 class="sectiontitle">Последни 14 дни</h3><div class="history"><table><thead><tr><th>Дата</th><th>Сделки</th><th>LONG</th><th>SHORT</th><th>Общо net</th></tr></thead><tbody>${history||'<tr><td colspan="5">Няма данни</td></tr>'}</tbody></table></div>
      <div class="foot">V1.9.1 · Дните са по Europe/Sofia. При 7 дни/Всички всеки ден се разгъва отделно.</div></main></body></html>`;
      return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    }

    if (url.pathname === "/forward-long-shadow-dashboard") {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS forward_long_shadow (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crossing_id INTEGER UNIQUE,
          coin TEXT NOT NULL,
          side TEXT NOT NULL,
          crossing_ts INTEGER NOT NULL,
          crossing_datetime TEXT,
          entry_price REAL NOT NULL,
          score REAL,
          tp_pct REAL NOT NULL DEFAULT 0.50,
          sl_pct REAL NOT NULL DEFAULT 0.15,
          tp_price REAL,
          sl_price REAL,
          status TEXT NOT NULL DEFAULT 'OPEN',
          exit_type TEXT,
          exit_ts INTEGER,
          exit_datetime TEXT,
          exit_price REAL,
          gross_return_pct REAL,
          fee_pct REAL NOT NULL DEFAULT 0.07,
          net_return_pct REAL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      const q:any=await env.DB.prepare(`
        SELECT * FROM forward_long_shadow ORDER BY crossing_ts DESC LIMIT 200
      `).all();
      const trades:any[]=q?.results??[];
      const closed=trades.filter((x:any)=>x.status==="CLOSED");
      const tp=closed.filter((x:any)=>x.exit_type==="TP").length;
      const sl=closed.filter((x:any)=>x.exit_type==="SL").length;
      const time=closed.filter((x:any)=>x.exit_type==="TIME_30M").length;
      const open=trades.filter((x:any)=>x.status==="OPEN").length;
      const net=closed.reduce((s:number,x:any)=>s+Number(x.net_return_pct??0),0);
      const avg=closed.length?net/closed.length:0;
      const wr=closed.length?tp/closed.length*100:0;

      const esc=(v:any)=>String(v??"").replace(/[&<>"']/g,(c:string)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"} as any)[c]);
      const fmt=(v:any)=>{
        const n=Number(v); if(!Number.isFinite(n)) return "—";
        if(Math.abs(n)>=100) return n.toFixed(2);
        if(Math.abs(n)>=1) return n.toFixed(4).replace(/0+$/,"").replace(/\.$/,"");
        return n.toFixed(6).replace(/0+$/,"").replace(/\.$/,"");
      };
      const pct=(v:any)=>{
        const n=Number(v); if(!Number.isFinite(n)) return "—";
        return `${n>0?"+":""}${n.toFixed(2)}%`;
      };
      const dur=(x:any)=>{
        if(!x.exit_ts) return "OPEN";
        const m=Math.max(0,Math.round((Number(x.exit_ts)-Number(x.crossing_ts))/60000));
        return `${m}m`;
      };
      const localDate=(v:any)=>{
        if(!v) return "—";
        try{return new Intl.DateTimeFormat("bg-BG",{timeZone:"Europe/Sofia",day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(new Date(v));}
        catch{return String(v);}
      };
      const badge=(x:any)=>{
        if(x.status==="OPEN") return `<span class="badge open">● OPEN</span>`;
        if(x.exit_type==="TP") return `<span class="badge win">✓ TP</span>`;
        if(x.exit_type==="SL") return `<span class="badge loss">✕ SL</span>`;
        return `<span class="badge time">◷ TIME</span>`;
      };

      const rows=trades.map((x:any,i:number)=>`
        <tr>
          <td class="num">#${trades.length-i}</td>
          <td><strong>${esc(x.coin)}</strong><div class="muted">${localDate(x.crossing_datetime)}</div></td>
          <td>${Number(x.score??0).toFixed(2)}</td>
          <td>${fmt(x.entry_price)}</td>
          <td class="tp">${fmt(x.tp_price)}</td>
          <td class="sl">${fmt(x.sl_price)}</td>
          <td>${badge(x)}</td>
          <td>${fmt(x.exit_price)}</td>
          <td>${dur(x)}</td>
          <td class="${Number(x.net_return_pct??0)>0?"positive":Number(x.net_return_pct??0)<0?"negative":""}"><strong>${x.status==="OPEN"?"—":pct(x.net_return_pct)}</strong></td>
        </tr>`).join("");

      const cards=trades.map((x:any,i:number)=>`
        <article class="trade-card">
          <div class="trade-top"><div><span class="trade-no">#${trades.length-i}</span> <strong>${esc(x.coin)}</strong></div>${badge(x)}</div>
          <div class="muted">${localDate(x.crossing_datetime)} · Score ${Number(x.score??0).toFixed(2)} · ${dur(x)}</div>
          <div class="prices">
            <div><span>ENTRY</span><b>${fmt(x.entry_price)}</b></div>
            <div><span>TP +0.50%</span><b class="tp">${fmt(x.tp_price)}</b></div>
            <div><span>SL −0.15%</span><b class="sl">${fmt(x.sl_price)}</b></div>
          </div>
          <div class="trade-bottom"><span>Exit ${fmt(x.exit_price)}</span><strong class="${Number(x.net_return_pct??0)>0?"positive":Number(x.net_return_pct??0)<0?"negative":""}">${x.status==="OPEN"?"OPEN":pct(x.net_return_pct)+" NET"}</strong></div>
        </article>`).join("");

      const html=`<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="refresh" content="30">
      <title>CryptoBot Forward Shadow</title>
      <style>
      *{box-sizing:border-box}body{margin:0;background:#0b1020;color:#edf2f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
      .wrap{max-width:1180px;margin:auto;padding:22px}.head{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:18px}
      h1{font-size:24px;margin:0 0 5px}.sub,.muted{color:#8fa0bb;font-size:13px}.live{font-size:12px;color:#7ee2a8}
      .stats{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:18px 0}
      .stat{background:#131b2f;border:1px solid #24304a;border-radius:14px;padding:14px}.stat span{display:block;color:#8fa0bb;font-size:12px;margin-bottom:5px}.stat b{font-size:21px}
      .strategy{background:#10182a;border:1px solid #253451;border-radius:14px;padding:13px 15px;margin-bottom:16px;font-size:14px}
      .positive,.tp{color:#62d995}.negative,.sl{color:#ff7b88}.badge{display:inline-block;padding:5px 9px;border-radius:999px;font-size:12px;font-weight:800}
      .win{background:#153b2c;color:#72e7a6}.loss{background:#431e28;color:#ff8c98}.open{background:#423816;color:#ffd86b}.time{background:#25314c;color:#b9c8e5}
      .tablebox{overflow:auto;background:#11192b;border:1px solid #24304a;border-radius:15px}table{width:100%;border-collapse:collapse;min-width:900px}
      th,td{padding:12px 13px;text-align:left;border-bottom:1px solid #202b42;font-size:14px}th{color:#91a3bf;font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:#151f34}
      tr:last-child td{border-bottom:0}.num{color:#71809a}.cards{display:none}.foot{color:#71809a;font-size:12px;margin-top:13px}
      @media(max-width:720px){.wrap{padding:14px}.head{align-items:flex-start;flex-direction:column}.stats{grid-template-columns:repeat(2,1fr)}.tablebox{display:none}.cards{display:grid;gap:10px}
      .trade-card{background:#121b2e;border:1px solid #25314b;border-radius:15px;padding:14px}.trade-top,.trade-bottom{display:flex;justify-content:space-between;align-items:center}.trade-no{color:#71809a;font-size:12px}
      .prices{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin:13px 0}.prices div{background:#0c1425;border-radius:10px;padding:9px}.prices span{display:block;color:#71809a;font-size:9px;margin-bottom:4px}.prices b{font-size:12px}.trade-bottom{border-top:1px solid #25314b;padding-top:10px;font-size:13px}}
      </style></head><body><main class="wrap">
      <div class="head"><div><h1>📈 Forward LONG Shadow</h1><div class="sub">≥65 LONG · TP +0.50% · SL −0.15% · max 30 min</div></div><div class="live">● PAPER / RESEARCH · refresh 30s</div></div>
      <section class="stats">
        <div class="stat"><span>Сделки</span><b>${trades.length}</b></div>
        <div class="stat"><span>TP / SL</span><b>${tp} / ${sl}</b></div>
        <div class="stat"><span>Win rate</span><b>${wr.toFixed(1)}%</b></div>
        <div class="stat"><span>Avg net</span><b class="${avg>=0?"positive":"negative"}">${pct(avg)}</b></div>
        <div class="stat"><span>Total net</span><b class="${net>=0?"positive":"negative"}">${pct(net)}</b></div>
        <div class="stat"><span>P/L @ $1000</span><b class="${net>=0?"positive":"negative"}">$${(net*10).toFixed(2)}</b></div>
      </section>
      <div class="strategy">OPEN: <b>${open}</b> &nbsp; · &nbsp; TP: <b class="positive">${tp}</b> &nbsp; · &nbsp; SL: <b class="negative">${sl}</b> &nbsp; · &nbsp; TIME: <b>${time}</b> &nbsp; · &nbsp; Fee: 0.07% round trip</div>
      <div class="tablebox"><table><thead><tr><th>#</th><th>Coin / време</th><th>Score</th><th>Entry</th><th>TP</th><th>SL</th><th>Резултат</th><th>Exit</th><th>Време</th><th>Net</th></tr></thead><tbody>${rows||'<tr><td colspan="10">Още няма forward сделки.</td></tr>'}</tbody></table></div>
      <section class="cards">${cards||'<div class="trade-card">Още няма forward сделки.</div>'}</section>
      <div class="foot">V1.8.9 · Само сделки след старта на forward теста · Цените са форматирани само визуално, изчисленията пазят пълната точност.</div>
      </main></body></html>`;
      return new Response(html,{headers:{"content-type":"text/html; charset=utf-8","cache-control":"no-store"}});
    }

    if (url.pathname === "/forward-long-shadow") {
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS forward_long_shadow (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          crossing_id INTEGER UNIQUE,
          coin TEXT NOT NULL,
          side TEXT NOT NULL,
          crossing_ts INTEGER NOT NULL,
          crossing_datetime TEXT,
          entry_price REAL NOT NULL,
          score REAL,
          tp_pct REAL NOT NULL DEFAULT 0.50,
          sl_pct REAL NOT NULL DEFAULT 0.15,
          tp_price REAL,
          sl_price REAL,
          status TEXT NOT NULL DEFAULT 'OPEN',
          exit_type TEXT,
          exit_ts INTEGER,
          exit_datetime TEXT,
          exit_price REAL,
          gross_return_pct REAL,
          fee_pct REAL NOT NULL DEFAULT 0.07,
          net_return_pct REAL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      const rows:any = await env.DB.prepare(`
        SELECT id, crossing_id, coin, side, crossing_ts, crossing_datetime,
               entry_price, score, tp_pct, sl_pct, tp_price, sl_price,
               status, exit_type, exit_ts, exit_datetime, exit_price,
               gross_return_pct, fee_pct, net_return_pct
        FROM forward_long_shadow
        ORDER BY crossing_ts DESC
        LIMIT 200
      `).all();

      const trades:any[] = rows?.results ?? [];
      const closed = trades.filter((x:any)=>x.status==="CLOSED");
      const wins = closed.filter((x:any)=>x.exit_type==="TP").length;
      const losses = closed.filter((x:any)=>x.exit_type==="SL").length;
      const time = closed.filter((x:any)=>x.exit_type==="TIME_30M").length;
      const net = closed.reduce((s:number,x:any)=>s+Number(x.net_return_pct??0),0);

      return json({
        success:true,
        worker:"cryptobot",
        version:VERSION,
        mode:"FORWARD_LONG_SHADOW_READABLE",
        trading:"REAL_TRADING_DISABLED",
        strategy:{
          threshold:">=65",
          side:"LONG",
          tp_pct:0.50,
          sl_pct:0.15,
          fee_round_trip_pct:0.07,
          max_hold_minutes:30,
          start_rule:"ONLY crossings first seen after V1.8.8 deploy; old crossings are not backfilled"
        },
        summary:{
          total:trades.length,
          open:trades.filter((x:any)=>x.status==="OPEN").length,
          closed:closed.length,
          tp:wins,
          sl:losses,
          time_exit:time,
          net_return_sum_pct:Number(net.toFixed(4)),
          pnl_usd_at_100_notional:Number(net.toFixed(2)),
          pnl_usd_at_1000_notional:Number((net*10).toFixed(2))
        },
        columns_explained:{
          entry:"price when >=65 LONG crossing was first captured",
          tp:"target +0.50%",
          sl:"stop -0.15%",
          result:"OPEN / TP / SL / TIME_30M",
          net:"result after 0.07% assumed round-trip fee"
        },
        trades:trades.map((x:any)=>({
          id:x.id,
          coin:x.coin,
          date:x.crossing_datetime,
          score:x.score,
          entry:x.entry_price,
          tp:x.tp_price,
          sl:x.sl_price,
          result:x.status==="OPEN" ? "OPEN" : x.exit_type,
          exit:x.exit_price,
          gross_pct:x.gross_return_pct,
          fee_pct:x.fee_pct,
          net_pct:x.net_return_pct
        }))
      });
    }

    if (url.pathname === "/tp-sl-matrix-by-side") {
      if (!env.DB) return json({success:false,error:"D1_NOT_BOUND"},503);
      await ensurePaperTables(env);

      const side=(url.searchParams.get("side")??"LONG").toUpperCase();
      if(side!=="LONG"&&side!=="SHORT"){
        return json({success:false,error:"INVALID_SIDE",allowed:["LONG","SHORT"]},400);
      }

      const q:any=await env.DB.prepare(`
        SELECT id,coin,side,crossing_ts,crossing_price,crossing_score,
               return_30m_pct,outcome_complete
        FROM signal_65_crossings
        WHERE outcome_complete=1 AND side=?
        ORDER BY crossing_ts ASC
      `).bind(side).all();
      const crossings:any[]=q?.results??[];

      if(!crossings.length){
        return json({success:true,worker:"cryptobot",version:VERSION,
          mode:"TP_SL_MATRIX_BY_SIDE_RESEARCH",trading:"REAL_TRADING_DISABLED",side,
          crossings_used:0,combinations:0,top_by_net_return:[],matrix:[]});
      }

      // V1.8.4 DATA WINDOW FIX:
      // Merge only the actual +30m crossing windows per coin.
      // This avoids loading the entire time span between the oldest/newest crossing.
      const byCoin=new Map<string,{start:number,end:number}[]>();
      for(const c of crossings){
        const t=Number(c.crossing_ts);
        if(!Number.isFinite(t)) continue;
        const coin=String(c.coin);
        if(!byCoin.has(coin)) byCoin.set(coin,[]);
        byCoin.get(coin)!.push({start:t,end:t+30*60*1000});
      }

      const mergedWindows:{coin:string,start:number,end:number}[]=[];
      for(const [coin,windows] of byCoin){
        windows.sort((a,b)=>a.start-b.start);
        let cur:any=null;
        for(const w of windows){
          if(!cur) cur={coin,start:w.start,end:w.end};
          else if(w.start<=cur.end){
            cur.end=Math.max(cur.end,w.end);
          }else{
            mergedWindows.push(cur);
            cur={coin,start:w.start,end:w.end};
          }
        }
        if(cur) mergedWindows.push(cur);
      }

      const snapshotsByCoin=new Map<string,any[]>();
      let snapshotsLoaded=0;
      let snapshotQueries=0;

      // One query per merged real window, not per TP/SL combination.
      for(const w of mergedWindows){
        const r:any=await env.DB.prepare(`
          SELECT coin,ts,price
          FROM market_snapshots
          WHERE coin=? AND ts>=? AND ts<=?
          ORDER BY ts ASC
        `).bind(w.coin,w.start,w.end).all();
        snapshotQueries++;
        const rows:any[]=r?.results??[];
        snapshotsLoaded+=rows.length;
        if(!snapshotsByCoin.has(w.coin)) snapshotsByCoin.set(w.coin,[]);
        snapshotsByCoin.get(w.coin)!.push(...rows);
      }

      for(const rows of snapshotsByCoin.values())
        rows.sort((a:any,b:any)=>Number(a.ts)-Number(b.ts));

      const prepared=crossings.map((c:any)=>{
        const t=Number(c.crossing_ts),end=t+30*60*1000;
        const all=snapshotsByCoin.get(String(c.coin))??[];
        const snaps=all.filter((s:any)=>Number(s.ts)>=t&&Number(s.ts)<=end);
        return {...c,_snaps:snaps};
      });

      const tpValues=[0.20,0.25,0.30,0.35,0.40,0.50];
      const slValues=[0.15,0.20,0.25,0.30,0.35,0.40];
      const feePct=PAPER_FEE_RATE_PER_SIDE*2*100;
      const matrix:any[]=[];

      for(const tp of tpValues) for(const sl of slValues){
        let tpFirst=0,slFirst=0,timeExit=0,grossSum=0;
        const netReturns:number[]=[];
        for(const c of prepared){
          const entryPrice=Number(c.crossing_price);
          if(!Number.isFinite(entryPrice)||entryPrice<=0) continue;
          let gross:number|null=null,hit:string|null=null;
          for(const x of c._snaps){
            const px=Number(x.price);
            if(!Number.isFinite(px)||px<=0) continue;
            const r=c.side==="SHORT"
              ?((entryPrice-px)/entryPrice)*100
              :((px-entryPrice)/entryPrice)*100;
            if(r>=tp){gross=tp;hit="TP";break}
            if(r<=-sl){gross=-sl;hit="SL";break}
          }
          if(hit==="TP")tpFirst++;
          else if(hit==="SL")slFirst++;
          else{
            timeExit++;
            const r=Number(c.return_30m_pct);
            gross=Number.isFinite(r)?r:0;
          }
          grossSum+=Number(gross??0);
          netReturns.push(Number(gross??0)-feePct);
        }
        const netSum=netReturns.reduce((a,b)=>a+b,0);
        const a=[...netReturns].sort((x,y)=>x-y);
        const med=!a.length?null:(a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2);
        matrix.push({
          tp_pct:tp,sl_pct:sl,completed:netReturns.length,
          tp_first:tpFirst,sl_first:slFirst,time_exit_30m:timeExit,
          gross_return_sum_pct:round(grossSum,4),
          net_return_sum_pct:round(netSum,4),
          avg_net_return_pct:netReturns.length?round(netSum/netReturns.length,4):null,
          median_net_return_pct:med===null?null:round(med,4),
          pnl_usd_at_100_notional_each:round(netSum,4),
          profitable_after_fees:netSum>0
        });
      }

      const ranked=[...matrix].sort((a:any,b:any)=>Number(b.net_return_sum_pct)-Number(a.net_return_sum_pct));

      return json({
        success:true,worker:"cryptobot",version:VERSION,
        mode:"TP_SL_MATRIX_BY_SIDE_RESEARCH",trading:"REAL_TRADING_DISABLED",side,
        performance:{
          crossing_query:1,
          snapshot_queries:snapshotQueries,
          total_d1_queries:1+snapshotQueries,
          merged_data_windows:mergedWindows.length,
          raw_crossing_windows:crossings.length,
          snapshots_loaded:snapshotsLoaded,
          calculation:"IN_MEMORY",
          optimization:"ONLY_ACTUAL_MERGED_30M_CROSSING_WINDOWS"
        },
        methodology:{
          trigger:"completed >=65 crossings only",
          replay:"minute market_snapshots only inside each crossing +30m window",
          tp_values_pct:tpValues,sl_values_pct:slValues,
          round_trip_fee_pct:round(feePct,4),
          time_exit:"directional return_30m_pct if neither sampled barrier is reached",
          limitation:"minute sampled prices can miss intraminute TP/SL touches; research only"
        },
        crossings_used:crossings.length,combinations:matrix.length,
        current_config:{tp_pct:PAPER_TP_PCT,sl_pct:PAPER_SL_PCT},
        top_by_net_return:ranked.slice(0,10),matrix
      });
    }

    if (url.pathname === "/tp-sl-matrix") {
      if (!env.DB) return json({success:false,error:"D1_NOT_BOUND"},503);
      await ensurePaperTables(env);

      const q:any=await env.DB.prepare(`
        SELECT id,coin,side,crossing_ts,crossing_price,crossing_score,
               return_30m_pct,outcome_complete
        FROM signal_65_crossings
        WHERE outcome_complete=1
        ORDER BY crossing_ts ASC
      `).all();
      const crossings:any[]=q?.results??[];

      if(!crossings.length){
        return json({success:true,worker:"cryptobot",version:VERSION,
          mode:"TP_SL_MATRIX_RESEARCH",trading:"REAL_TRADING_DISABLED",
          crossings_used:0,combinations:0,top_by_net_return:[],matrix:[]});
      }

      // V1.8.4 DATA WINDOW FIX:
      // Merge only the actual +30m crossing windows per coin.
      // This avoids loading the entire time span between the oldest/newest crossing.
      const byCoin=new Map<string,{start:number,end:number}[]>();
      for(const c of crossings){
        const t=Number(c.crossing_ts);
        if(!Number.isFinite(t)) continue;
        const coin=String(c.coin);
        if(!byCoin.has(coin)) byCoin.set(coin,[]);
        byCoin.get(coin)!.push({start:t,end:t+30*60*1000});
      }

      const mergedWindows:{coin:string,start:number,end:number}[]=[];
      for(const [coin,windows] of byCoin){
        windows.sort((a,b)=>a.start-b.start);
        let cur:any=null;
        for(const w of windows){
          if(!cur) cur={coin,start:w.start,end:w.end};
          else if(w.start<=cur.end){
            cur.end=Math.max(cur.end,w.end);
          }else{
            mergedWindows.push(cur);
            cur={coin,start:w.start,end:w.end};
          }
        }
        if(cur) mergedWindows.push(cur);
      }

      const snapshotsByCoin=new Map<string,any[]>();
      let snapshotsLoaded=0;
      let snapshotQueries=0;

      // One query per merged real window, not per TP/SL combination.
      for(const w of mergedWindows){
        const r:any=await env.DB.prepare(`
          SELECT coin,ts,price
          FROM market_snapshots
          WHERE coin=? AND ts>=? AND ts<=?
          ORDER BY ts ASC
        `).bind(w.coin,w.start,w.end).all();
        snapshotQueries++;
        const rows:any[]=r?.results??[];
        snapshotsLoaded+=rows.length;
        if(!snapshotsByCoin.has(w.coin)) snapshotsByCoin.set(w.coin,[]);
        snapshotsByCoin.get(w.coin)!.push(...rows);
      }

      for(const rows of snapshotsByCoin.values())
        rows.sort((a:any,b:any)=>Number(a.ts)-Number(b.ts));

      const prepared=crossings.map((c:any)=>{
        const t=Number(c.crossing_ts),end=t+30*60*1000;
        const all=snapshotsByCoin.get(String(c.coin))??[];
        const snaps=all.filter((s:any)=>Number(s.ts)>=t&&Number(s.ts)<=end);
        return {...c,_snaps:snaps};
      });

      const tpValues=[0.20,0.25,0.30,0.35,0.40,0.50];
      const slValues=[0.15,0.20,0.25,0.30,0.35,0.40];
      const feePct=PAPER_FEE_RATE_PER_SIDE*2*100;
      const matrix:any[]=[];

      for(const tp of tpValues) for(const sl of slValues){
        let tpFirst=0,slFirst=0,timeExit=0,grossSum=0;
        const netReturns:number[]=[];
        for(const c of prepared){
          const entryPrice=Number(c.crossing_price);
          if(!Number.isFinite(entryPrice)||entryPrice<=0) continue;
          let gross:number|null=null,hit:string|null=null;
          for(const x of c._snaps){
            const px=Number(x.price);
            if(!Number.isFinite(px)||px<=0) continue;
            const r=c.side==="SHORT"
              ?((entryPrice-px)/entryPrice)*100
              :((px-entryPrice)/entryPrice)*100;
            if(r>=tp){gross=tp;hit="TP";break}
            if(r<=-sl){gross=-sl;hit="SL";break}
          }
          if(hit==="TP")tpFirst++;
          else if(hit==="SL")slFirst++;
          else{
            timeExit++;
            const r=Number(c.return_30m_pct);
            gross=Number.isFinite(r)?r:0;
          }
          grossSum+=Number(gross??0);
          netReturns.push(Number(gross??0)-feePct);
        }
        const netSum=netReturns.reduce((a,b)=>a+b,0);
        const a=[...netReturns].sort((x,y)=>x-y);
        const med=!a.length?null:(a.length%2?a[Math.floor(a.length/2)]:(a[a.length/2-1]+a[a.length/2])/2);
        matrix.push({
          tp_pct:tp,sl_pct:sl,completed:netReturns.length,
          tp_first:tpFirst,sl_first:slFirst,time_exit_30m:timeExit,
          gross_return_sum_pct:round(grossSum,4),
          net_return_sum_pct:round(netSum,4),
          avg_net_return_pct:netReturns.length?round(netSum/netReturns.length,4):null,
          median_net_return_pct:med===null?null:round(med,4),
          pnl_usd_at_100_notional_each:round(netSum,4),
          profitable_after_fees:netSum>0
        });
      }

      const ranked=[...matrix].sort((a:any,b:any)=>Number(b.net_return_sum_pct)-Number(a.net_return_sum_pct));

      return json({
        success:true,worker:"cryptobot",version:VERSION,
        mode:"TP_SL_MATRIX_RESEARCH",trading:"REAL_TRADING_DISABLED",
        performance:{
          crossing_query:1,
          snapshot_queries:snapshotQueries,
          total_d1_queries:1+snapshotQueries,
          merged_data_windows:mergedWindows.length,
          raw_crossing_windows:crossings.length,
          snapshots_loaded:snapshotsLoaded,
          calculation:"IN_MEMORY",
          optimization:"ONLY_ACTUAL_MERGED_30M_CROSSING_WINDOWS"
        },
        methodology:{
          trigger:"completed >=65 crossings only",
          replay:"minute market_snapshots only inside each crossing +30m window",
          tp_values_pct:tpValues,sl_values_pct:slValues,
          round_trip_fee_pct:round(feePct,4),
          time_exit:"directional return_30m_pct if neither sampled barrier is reached",
          limitation:"minute sampled prices can miss intraminute TP/SL touches; research only"
        },
        crossings_used:crossings.length,combinations:matrix.length,
        current_config:{tp_pct:PAPER_TP_PCT,sl_pct:PAPER_SL_PCT},
        top_by_net_return:ranked.slice(0,10),matrix
      });
    }

    if (url.pathname === "/crossing-65-analytics") {
      if (!env.DB) return json({success:false,error:"D1_NOT_BOUND"},503);
      await ensurePaperTables(env);

      const totals:any=await env.DB.prepare(`SELECT COUNT(*) crossings,SUM(outcome_complete) completed_30m,AVG(return_1m_pct) avg_1m_pct,AVG(return_5m_pct) avg_5m_pct,AVG(return_15m_pct) avg_15m_pct,AVG(return_30m_pct) avg_30m_pct,AVG(mfe_pct) avg_mfe_pct,AVG(mae_pct) avg_mae_pct,SUM(CASE WHEN first_barrier='TP' THEN 1 ELSE 0 END) tp_first,SUM(CASE WHEN first_barrier='SL' THEN 1 ELSE 0 END) sl_first FROM signal_65_crossings`).first();

      const byCoinSide:any=await env.DB.prepare(`SELECT coin,side,COUNT(*) crossings,SUM(outcome_complete) completed_30m,AVG(crossing_score) avg_crossing_score,AVG(return_1m_pct) avg_1m_pct,AVG(return_5m_pct) avg_5m_pct,AVG(return_15m_pct) avg_15m_pct,AVG(return_30m_pct) avg_30m_pct,AVG(mfe_pct) avg_mfe_pct,AVG(mae_pct) avg_mae_pct,SUM(CASE WHEN first_barrier='TP' THEN 1 ELSE 0 END) tp_first,SUM(CASE WHEN first_barrier='SL' THEN 1 ELSE 0 END) sl_first FROM signal_65_crossings GROUP BY coin,side ORDER BY coin,side`).all();

      // V1.8.1: richer research analytics. No signal/trading logic is changed.
      const raw:any=await env.DB.prepare(`
        SELECT id,coin,side,crossing_score,return_1m_pct,return_5m_pct,
               return_15m_pct,return_30m_pct,mfe_pct,mae_pct,
               first_barrier,outcome_complete
        FROM signal_65_crossings
        ORDER BY crossing_ts ASC
      `).all();
      const rows:any[] = raw?.results ?? [];

      const nums=(items:any[], field:string):number[] =>
        items.map((r:any)=>Number(r?.[field])).filter((v:number)=>Number.isFinite(v));

      const median=(values:number[]):number|null => {
        if (!values.length) return null;
        const a=[...values].sort((x,y)=>x-y);
        const m=Math.floor(a.length/2);
        return round(a.length%2 ? a[m] : (a[m-1]+a[m])/2,4);
      };

      const avg=(values:number[]):number|null =>
        values.length ? round(values.reduce((s,v)=>s+v,0)/values.length,4) : null;

      const bucket65=(score:number):string => {
        if (score >= 80) return "80+";
        if (score >= 75) return "75-79";
        if (score >= 70) return "70-74";
        return "65-69";
      };

      const completed=rows.filter((r:any)=>Number(r.outcome_complete)===1 && Number.isFinite(Number(r.return_30m_pct)));
      const feePct=PAPER_FEE_RATE_PER_SIDE*2*100;

      const strategyFor=(items:any[]) => {
        const done=items.filter((r:any)=>Number(r.outcome_complete)===1 && Number.isFinite(Number(r.return_30m_pct)));
        let tp=0,sl=0,timeExit=0;
        const grossReturns:number[]=[];
        const netReturns:number[]=[];
        for (const r of done) {
          let gross:number;
          if (r.first_barrier==="TP") { gross=PAPER_TP_PCT; tp++; }
          else if (r.first_barrier==="SL") { gross=-PAPER_SL_PCT; sl++; }
          else { gross=Number(r.return_30m_pct); timeExit++; }
          grossReturns.push(gross);
          netReturns.push(gross-feePct);
        }
        const totalNet=netReturns.reduce((s,v)=>s+v,0);
        return {
          completed: done.length,
          tp_first: tp,
          sl_first: sl,
          time_exit_30m: timeExit,
          fee_pct_per_trade: round(feePct,4),
          gross_return_sum_pct: round(grossReturns.reduce((s,v)=>s+v,0),4),
          net_return_sum_pct: round(totalNet,4),
          avg_net_return_pct: avg(netReturns),
          median_net_return_pct: median(netReturns),
          pnl_usd_at_100_notional_each: round(totalNet,4),
          profitable_after_fees: totalNet > 0
        };
      };

      const medianReturns={
        return_1m_pct: median(nums(rows,"return_1m_pct")),
        return_5m_pct: median(nums(rows,"return_5m_pct")),
        return_15m_pct: median(nums(rows,"return_15m_pct")),
        return_30m_pct: median(nums(rows,"return_30m_pct")),
        mfe_pct: median(nums(rows,"mfe_pct")),
        mae_pct: median(nums(rows,"mae_pct"))
      };

      const sides=["LONG","SHORT"].map(side=>{
        const x=rows.filter((r:any)=>r.side===side);
        return {
          side,
          crossings:x.length,
          completed_30m:x.filter((r:any)=>Number(r.outcome_complete)===1).length,
          avg_crossing_score:avg(nums(x,"crossing_score")),
          avg_1m_pct:avg(nums(x,"return_1m_pct")),
          avg_5m_pct:avg(nums(x,"return_5m_pct")),
          avg_15m_pct:avg(nums(x,"return_15m_pct")),
          avg_30m_pct:avg(nums(x,"return_30m_pct")),
          median_30m_pct:median(nums(x,"return_30m_pct")),
          avg_mfe_pct:avg(nums(x,"mfe_pct")),
          avg_mae_pct:avg(nums(x,"mae_pct")),
          strategy:strategyFor(x)
        };
      }).filter(x=>x.crossings>0);

      const bucketNames=["65-69","70-74","75-79","80+"];
      const byScoreBucket=bucketNames.map(bucket=>{
        const x=rows.filter((r:any)=>bucket65(Number(r.crossing_score))===bucket);
        return {
          score_bucket:bucket,
          crossings:x.length,
          completed_30m:x.filter((r:any)=>Number(r.outcome_complete)===1).length,
          avg_crossing_score:avg(nums(x,"crossing_score")),
          avg_1m_pct:avg(nums(x,"return_1m_pct")),
          avg_5m_pct:avg(nums(x,"return_5m_pct")),
          avg_15m_pct:avg(nums(x,"return_15m_pct")),
          avg_30m_pct:avg(nums(x,"return_30m_pct")),
          median_30m_pct:median(nums(x,"return_30m_pct")),
          avg_mfe_pct:avg(nums(x,"mfe_pct")),
          avg_mae_pct:avg(nums(x,"mae_pct")),
          strategy:strategyFor(x)
        };
      }).filter(x=>x.crossings>0);

      return json({
        success:true,
        worker:"cryptobot",
        version:VERSION,
        mode:"65_CROSSING_ANALYTICS_V2",
        trading:"REAL_TRADING_DISABLED",
        methodology:{
          trigger:"first observed FINAL_SCORE_ABS >= 65 inside each active episode",
          dedup:"one crossing per episode",
          horizons_minutes:[1,5,15,30],
          tp_pct:PAPER_TP_PCT,
          sl_pct:PAPER_SL_PCT,
          fee_rate_per_side:PAPER_FEE_RATE_PER_SIDE,
          round_trip_fee_pct:round(feePct,4),
          strategy_exit:"TP first => +TP%; SL first => -SL%; otherwise directional 30m return; then subtract round-trip fee",
          barrier_method:"minute snapshot approximation; not tick-level ordering",
          historical_note:"Collection starts with V1.7; old episodes are not assigned fabricated crossing timestamps."
        },
        totals,
        median_returns:medianReturns,
        strategy_simulation:strategyFor(rows),
        by_side:sides,
        by_score_bucket:byScoreBucket,
        by_coin_side:byCoinSide?.results??[]
      });
    }

    if (url.pathname === "/episodes") {
      if (!env.DB) {
        return json(
          { success: false, error: "D1_NOT_BOUND" },
          503
        );
      }

      await ensurePaperTables(env);

      const limit = Math.max(
        1,
        Math.min(
          Number(url.searchParams.get("limit") ?? 50),
          500
        )
      );

      const result: any = await env.DB.prepare(`
        SELECT *
        FROM signal_episodes
        ORDER BY start_ts DESC
        LIMIT ?
      `).bind(limit).all();

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "OUTCOME_RESEARCH",
        total: result?.results?.length ?? 0,
        episodes: result?.results ?? [],
      });
    }

    if (url.pathname === "/episode-analytics") {
      if (!env.DB) {
        return json(
          { success: false, error: "D1_NOT_BOUND" },
          503
        );
      }

      await ensurePaperTables(env);

      const byBucket: any = await env.DB.prepare(`
        SELECT
          start_bucket AS score_bucket,
          side,
          COUNT(*) AS episodes,
          SUM(outcome_complete) AS completed_30m,
          AVG(signal_lifetime_minutes) AS avg_signal_lifetime_minutes,
          AVG(lifetime_return_pct) AS avg_lifetime_return_pct,
          AVG(lifetime_mfe_pct) AS avg_lifetime_mfe_pct,
          AVG(lifetime_mae_pct) AS avg_lifetime_mae_pct,
          SUM(CASE WHEN lifetime_first_barrier='TP' THEN 1 ELSE 0 END) AS lifetime_tp_first,
          SUM(CASE WHEN lifetime_first_barrier='SL' THEN 1 ELSE 0 END) AS lifetime_sl_first,
          AVG(return_1m_pct) AS avg_1m_pct,
          AVG(return_5m_pct) AS avg_5m_pct,
          AVG(return_15m_pct) AS avg_15m_pct,
          AVG(return_30m_pct) AS avg_30m_pct,
          AVG(mfe_pct) AS avg_mfe_pct,
          AVG(mae_pct) AS avg_mae_pct,
          SUM(CASE WHEN first_barrier='TP' THEN 1 ELSE 0 END) AS tp_first,
          SUM(CASE WHEN first_barrier='SL' THEN 1 ELSE 0 END) AS sl_first,
          AVG(peak_score) AS avg_peak_score
        FROM signal_episodes
        GROUP BY start_bucket, side
        ORDER BY
          CASE start_bucket
            WHEN '80+' THEN 1
            WHEN '75-79' THEN 2
            WHEN '70-74' THEN 3
            WHEN '65-69' THEN 4
            WHEN '60-64' THEN 5
            WHEN '55-59' THEN 6
            WHEN '50-54' THEN 7
            ELSE 8
          END,
          side
      `).all();

      const byCoin: any = await env.DB.prepare(`
        SELECT
          coin,
          side,
          COUNT(*) AS episodes,
          SUM(outcome_complete) AS completed_30m,
          AVG(signal_lifetime_minutes) AS avg_signal_lifetime_minutes,
          AVG(lifetime_return_pct) AS avg_lifetime_return_pct,
          AVG(lifetime_mfe_pct) AS avg_lifetime_mfe_pct,
          AVG(lifetime_mae_pct) AS avg_lifetime_mae_pct,
          SUM(CASE WHEN lifetime_first_barrier='TP' THEN 1 ELSE 0 END) AS lifetime_tp_first,
          SUM(CASE WHEN lifetime_first_barrier='SL' THEN 1 ELSE 0 END) AS lifetime_sl_first,
          AVG(return_5m_pct) AS avg_5m_pct,
          AVG(return_15m_pct) AS avg_15m_pct,
          AVG(return_30m_pct) AS avg_30m_pct,
          AVG(mfe_pct) AS avg_mfe_pct,
          AVG(mae_pct) AS avg_mae_pct,
          SUM(CASE WHEN first_barrier='TP' THEN 1 ELSE 0 END) AS tp_first,
          SUM(CASE WHEN first_barrier='SL' THEN 1 ELSE 0 END) AS sl_first
        FROM signal_episodes
        GROUP BY coin, side
        ORDER BY coin, side
      `).all();

      const totals: any = await env.DB.prepare(`
        SELECT
          COUNT(*) AS total_episodes,
          SUM(CASE WHEN status='ACTIVE' THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed,
          SUM(outcome_complete) AS completed_30m,
          SUM(CASE WHEN qualifies_entry=1 THEN 1 ELSE 0 END) AS reached_65,
          SUM(CASE WHEN lifetime_return_pct IS NOT NULL THEN 1 ELSE 0 END) AS lifetime_measured,
          SUM(CASE WHEN lifetime_first_barrier='TP' THEN 1 ELSE 0 END) AS lifetime_tp_first,
          SUM(CASE WHEN lifetime_first_barrier='SL' THEN 1 ELSE 0 END) AS lifetime_sl_first,
          SUM(CASE WHEN first_barrier='TP' THEN 1 ELSE 0 END) AS tp_first,
          SUM(CASE WHEN first_barrier='SL' THEN 1 ELSE 0 END) AS sl_first
        FROM signal_episodes
      `).first();

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "OUTCOME_RESEARCH",
        trading: "REAL_TRADING_DISABLED",
        methodology: {
          episode_start: "FINAL_SCORE_ABS >= 50",
          dedup:
            "same coin + same direction remains one episode",
          episode_end:
            "score below 50, direction flip, or 30 minutes",
          signal_lifetime_outcome:
            "entry -> episode end; measures only while FINAL_SCORE_ABS stays >=50 in same direction",
          fixed_horizon_outcome:
            "entry -> 1/5/15/30m regardless of whether the episode has already closed",
          horizons_minutes: [1, 5, 15, 30],
          tp_pct: PAPER_TP_PCT,
          sl_pct: PAPER_SL_PCT,
          barrier_method:
            "minute snapshot approximation; not tick-level ordering",
        },
        totals,
        by_score_bucket: byBucket?.results ?? [],
        by_coin_side: byCoin?.results ?? [],
      });
    }

    // V1.5.2 PAPER ANALYTICS
    if (url.pathname === "/paper-analytics") {
      if (!env.DB) {
        return json(
          { success: false, error: "D1_NOT_BOUND" },
          503
        );
      }

      await ensurePaperTables(env);

      const buckets = await env.DB.prepare(`
        SELECT
          CASE
            WHEN entry_score >= 80 THEN '80+'
            WHEN entry_score >= 75 THEN '75-79'
            WHEN entry_score >= 70 THEN '70-74'
            WHEN entry_score >= 65 THEN '65-69'
            ELSE '<65'
          END AS score_bucket,
          side,
          COUNT(*) AS trades,
          SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed,
          SUM(CASE WHEN status='CLOSED' AND net_return_pct > 0 THEN 1 ELSE 0 END) AS wins,
          AVG(CASE WHEN status='CLOSED' THEN net_return_pct END) AS avg_net_return_pct,
          SUM(CASE WHEN status='CLOSED' THEN pnl_usd ELSE 0 END) AS pnl_usd,
          AVG(CASE WHEN status='CLOSED' THEN mfe_pct END) AS avg_mfe_pct,
          AVG(CASE WHEN status='CLOSED' THEN mae_pct END) AS avg_mae_pct
        FROM paper_trades
        GROUP BY score_bucket, side
        ORDER BY
          CASE score_bucket
            WHEN '80+' THEN 1
            WHEN '75-79' THEN 2
            WHEN '70-74' THEN 3
            WHEN '65-69' THEN 4
            ELSE 5
          END,
          side
      `).all();

      const coins = await env.DB.prepare(`
        SELECT
          coin,
          side,
          COUNT(*) AS trades,
          SUM(CASE WHEN status='CLOSED' THEN 1 ELSE 0 END) AS closed,
          SUM(CASE WHEN status='CLOSED' AND net_return_pct > 0 THEN 1 ELSE 0 END) AS wins,
          AVG(CASE WHEN status='CLOSED' THEN net_return_pct END) AS avg_net_return_pct,
          SUM(CASE WHEN status='CLOSED' THEN pnl_usd ELSE 0 END) AS pnl_usd,
          AVG(CASE WHEN status='CLOSED' THEN mfe_pct END) AS avg_mfe_pct,
          AVG(CASE WHEN status='CLOSED' THEN mae_pct END) AS avg_mae_pct
        FROM paper_trades
        GROUP BY coin, side
        ORDER BY coin, side
      `).all();

      const exits = await env.DB.prepare(`
        SELECT
          exit_reason,
          COUNT(*) AS trades,
          AVG(net_return_pct) AS avg_net_return_pct,
          SUM(pnl_usd) AS pnl_usd
        FROM paper_trades
        WHERE status='CLOSED'
        GROUP BY exit_reason
        ORDER BY trades DESC
      `).all();

      const observations = await env.DB.prepare(`
        SELECT
          score_bucket,
          side,
          COUNT(*) AS observations,
          SUM(qualifies_entry) AS qualified
        FROM paper_signal_observations
        GROUP BY score_bucket, side
        ORDER BY
          CASE score_bucket
            WHEN '80+' THEN 1
            WHEN '75-79' THEN 2
            WHEN '70-74' THEN 3
            WHEN '65-69' THEN 4
            WHEN '60-64' THEN 5
            WHEN '55-59' THEN 6
            WHEN '50-54' THEN 7
            ELSE 8
          END,
          side
      `).all();

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "PAPER_ONLY",
        trading: "REAL_TRADING_DISABLED",
        summary: await paperSummary(env),
        by_score_bucket: buckets?.results ?? [],
        by_coin_side: coins?.results ?? [],
        by_exit_reason: exits?.results ?? [],
        shadow_observations_50_plus:
          observations?.results ?? [],
        note:
          "50-64 observations are research samples only and do not change the paper-entry threshold.",
      });
    }

    if (url.pathname === "/paper-observations") {
      if (!env.DB) {
        return json(
          { success: false, error: "D1_NOT_BOUND" },
          503
        );
      }

      await ensurePaperTables(env);

      const limit = Math.max(
        1,
        Math.min(
          Number(url.searchParams.get("limit") ?? 100),
          500
        )
      );

      const result = await env.DB.prepare(`
        SELECT *
        FROM paper_signal_observations
        ORDER BY ts DESC
        LIMIT ?
      `).bind(limit).all();

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "RESEARCH_OBSERVATIONS",
        observation_min_score:
          PAPER_OBSERVATION_MIN_SCORE,
        paper_entry_score:
          PAPER_ENTRY_SCORE,
        total: result?.results?.length ?? 0,
        observations: result?.results ?? [],
      });
    }

    // FINAL SIGNAL -> PAPER ENTRY DIAGNOSTIC
    if (url.pathname === "/paper-candidate") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      try {
        const finalSignal = await buildFinalSignal(
          coin,
          env
        );

        const score = Math.abs(
          Number(finalSignal.final?.signed_score ?? 0)
        );

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          mode: "PAPER_ONLY",
          trading: "REAL_TRADING_DISABLED",
          coin,
          price: finalSignal.price,
          market: finalSignal.market,
          news_x: finalSignal.news_x,
          final: finalSignal.final,
          paper_entry_check: {
            qualifies:
              score >= PAPER_ENTRY_SCORE &&
              score >= PAPER_MIN_SCORE_GAP,
            side:
              Number(finalSignal.final?.signed_score ?? 0) >= 0
                ? "LONG"
                : "SHORT",
            score: round(score),
            required_score: PAPER_ENTRY_SCORE,
            required_gap: PAPER_MIN_SCORE_GAP,
            note:
              "Diagnostic only. This HTTP endpoint never opens a paper trade.",
          },
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "PAPER_CANDIDATE_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }

    // PAPER TRADING — READ ONLY REPORTING
    if (url.pathname === "/paper-trades") {
      if (!env.DB) {
        return json(
          {
            success: false,
            error: "D1_NOT_BOUND",
            required_binding: "DB",
          },
          503
        );
      }

      await ensurePaperTables(env);

      const status = (
        url.searchParams.get("status") ?? "ALL"
      ).toUpperCase();

      const coin = (
        url.searchParams.get("coin") ?? ""
      ).toUpperCase();

      const limit = Math.max(
        1,
        Math.min(
          Number(url.searchParams.get("limit") ?? 50),
          200
        )
      );

      let sql = `
        SELECT *
        FROM paper_trades
        WHERE 1 = 1
      `;
      const binds: any[] = [];

      if (status === "OPEN" || status === "CLOSED") {
        sql += ` AND status = ?`;
        binds.push(status);
      }

      if (coin && validCoin(coin)) {
        sql += ` AND coin = ?`;
        binds.push(coin);
      }

      sql += ` ORDER BY entry_ts DESC LIMIT ?`;
      binds.push(limit);

      const result = await env.DB.prepare(sql)
        .bind(...binds)
        .all();

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "PAPER_ONLY",
        filters: {
          status,
          coin: coin || null,
          limit,
        },
        total: result?.results?.length ?? 0,
        trades: result?.results ?? [],
      });
    }

    if (url.pathname === "/paper-summary") {
      if (!env.DB) {
        return json(
          {
            success: false,
            error: "D1_NOT_BOUND",
            required_binding: "DB",
          },
          503
        );
      }

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "PAPER_ONLY",
        summary: await paperSummary(env),
      });
    }

    if (url.pathname === "/paper-status") {
      if (!env.DB) {
        return json(
          {
            success: false,
            error: "D1_NOT_BOUND",
            required_binding: "DB",
          },
          503
        );
      }

      await ensurePaperTables(env);

      const open = await env.DB.prepare(`
        SELECT *
        FROM paper_trades
        WHERE status = 'OPEN'
        ORDER BY entry_ts DESC
      `).all();

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        mode: "PAPER_ONLY",
        trading: "REAL_TRADING_DISABLED",
        open_trades: open?.results ?? [],
        summary: await paperSummary(env),
      });
    }

    // SNAPSHOT HISTORY
    if (url.pathname === "/history") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      const minutes = Math.max(
        1,
        Math.min(
          Number(url.searchParams.get("minutes") ?? 20),
          1440
        )
      );

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      if (!env.DB) {
        return json(
          {
            success: false,
            error: "D1_NOT_BOUND",
            required_binding: "DB",
          },
          503
        );
      }

      const rows = await getRecentSnapshots(
        env,
        coin,
        minutes,
        500
      );

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        coin,
        minutes,
        total: rows.length,
        snapshots: rows,
      });
    }

    // CURRENT HISTORY / ΔOI DIAGNOSTIC
    if (url.pathname === "/snapshot-status") {
      const coin = (
        url.searchParams.get("coin") ?? "BTC"
      ).toUpperCase();

      if (!validCoin(coin)) {
        return json(
          {
            success: false,
            error: "INVALID_COIN",
            allowed: TRACKED_COINS,
          },
          400
        );
      }

      try {
        const signal = await buildSignal(coin, env);

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          coin,
          d1_bound: dbReady(env),
          history: signal.history,
          derivatives: {
            open_interest:
              signal.derivatives.open_interest,
            open_interest_change:
              signal.derivatives.open_interest_change,
            open_interest_change_status:
              signal.derivatives.open_interest_change_status,
          },
          market: signal.market,
        });
      } catch (error: any) {
        return json(
          {
            success: false,
            error: "SNAPSHOT_STATUS_FAILED",
            message: error?.message ?? String(error),
          },
          500
        );
      }
    }


    // TELEGRAM TEST — SAFE / NO HYPERLIQUID SIGNING / NO ORDERS
    // Verifies TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID and sends one test message.
    if (url.pathname === "/telegram-test") {
      const token = String(env.TELEGRAM_BOT_TOKEN ?? "").trim();
      const chatId = String(env.TELEGRAM_CHAT_ID ?? "").trim();

      if (!token || !chatId) {
        return json({
          success: false,
          worker: "cryptobot",
          version: VERSION,
          trading: "REAL_TRADING_DISABLED",
          telegram: {
            configured: false,
            sent: false,
            token_present: Boolean(token),
            chat_id_present: Boolean(chatId),
            reason: "TELEGRAM_SECRETS_NOT_CONFIGURED",
          },
          safety: {
            hyperliquid_signing_performed: false,
            exchange_endpoint_called: false,
            order_sent: false,
          },
        }, 400);
      }

      try {
        const message = [
          "🧪 <b>CRYPTOBOT TELEGRAM TEST</b>",
          "",
          "✅ Bot connection: OK",
          "🔒 Live trading: DISABLED",
          "🤖 Worker: cryptobot",
          `📦 Version: ${VERSION}`,
          "",
          `🕐 ${new Date().toISOString()}`,
        ].join("\\n");

        const response = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              parse_mode: "HTML",
              disable_web_page_preview: true,
            }),
          }
        );

        const raw = await response.text();
        let telegramResponse: any = null;
        try {
          telegramResponse = raw ? JSON.parse(raw) : null;
        } catch {}

        const sent = response.ok && telegramResponse?.ok === true;

        return json({
          success: sent,
          worker: "cryptobot",
          version: VERSION,
          trading: "REAL_TRADING_DISABLED",
          telegram: {
            configured: true,
            sent,
            http_status: response.status,
            reason: sent ? null : "TELEGRAM_SEND_FAILED",
            // Deliberately expose only harmless Telegram response metadata.
            message_id: telegramResponse?.result?.message_id ?? null,
            chat_type: telegramResponse?.result?.chat?.type ?? null,
          },
          safety: {
            hyperliquid_signing_performed: false,
            exchange_endpoint_called: false,
            order_sent: false,
            telegram_token_exposed: false,
          },
        }, sent ? 200 : 502);
      } catch (error: any) {
        return json({
          success: false,
          worker: "cryptobot",
          version: VERSION,
          trading: "REAL_TRADING_DISABLED",
          telegram: {
            configured: true,
            sent: false,
            reason: "TELEGRAM_TRANSPORT_ERROR",
            message: error?.message ?? String(error),
          },
          safety: {
            hyperliquid_signing_performed: false,
            exchange_endpoint_called: false,
            order_sent: false,
            telegram_token_exposed: false,
          },
        }, 500);
      }
    }


    // HYPERLIQUID EXECUTION V1 — READ ONLY
    // Shows the latest >=65 crossing as the exact DRY-RUN bracket that the
    // execution module would build. Never signs and never calls /exchange
    // because execution.ts currently has LIVE_TRADING=false.
    if (url.pathname === "/hyperliquid-execution") {
      try {
        if (!env.DB) {
          return json({
            success: false,
            worker: "cryptobot",
            version: VERSION,
            error: "D1_NOT_BOUND",
            trading: "REAL_TRADING_DISABLED",
          }, 500);
        }

        const latest: any = await env.DB.prepare(`
          SELECT
            id,
            episode_id,
            coin,
            side,
            crossing_ts,
            crossing_datetime,
            crossing_price,
            crossing_score
          FROM signal_65_crossings
          ORDER BY crossing_ts DESC
          LIMIT 1
        `).first();

        if (!latest) {
          return json({
            success: true,
            worker: "cryptobot",
            version: VERSION,
            trading: "REAL_TRADING_DISABLED",
            status: {
              module: "hyperliquid-execution",
              live_trading: false,
              exchange_request_sent: false,
              latest_crossing: null,
              execution: null,
              message: "NO_65_CROSSING_FOUND",
            },
          });
        }

        const execution = await buildHyperliquidExecutionCandidate({
          coin: String(latest.coin),
          side: String(latest.side) as "LONG" | "SHORT",
          score: Number(latest.crossing_score),
          price: Number(latest.crossing_price),
          crossing_id: latest.id,
          episode_id: latest.episode_id,
          crossing_ts: Number(latest.crossing_ts),
          execution_context: "READ_ONLY_STATUS",
        }, env);

        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          trading: "REAL_TRADING_DISABLED",
          status: {
            module: "hyperliquid-execution",
            source: "LATEST_SIGNAL_65_CROSSING",
            read_only_endpoint: true,
            trade_policy: "ONE_TRADE_PER_COIN_PER_EPISODE",
            same_episode_reentry: false,
            concurrent_different_coins: true,
            latest_crossing: latest,
            execution,
          },
        });
      } catch (error: any) {
        return json({
          success: false,
          worker: "cryptobot",
          version: VERSION,
          error: "HYPERLIQUID_EXECUTION_READ_ONLY_FAILED",
          message: error?.message ?? String(error),
          trading: "REAL_TRADING_DISABLED",
        }, 500);
      }
    }


    // HYPERLIQUID ACCOUNT V1 — READ ONLY
    // Public /info reads only. NO private key, signing, /exchange, or orders.
    if (url.pathname === "/hyperliquid-balance-diagnostic") {
      const address = env.HYPERLIQUID_ACCOUNT_ADDRESS?.trim();
      if (!address) {
        return json({
          success: false,
          worker: "cryptobot",
          version: VERSION,
          module: "hyperliquid-balance-diagnostic",
          error: "HYPERLIQUID_ACCOUNT_ADDRESS_NOT_CONFIGURED",
          safe_read_only: true,
        }, 500);
      }

      const info = async (body: Record<string, any>) => {
        try {
          const r = await fetch("https://api.hyperliquid.xyz/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const text = await r.text();
          let data: any = null;
          try { data = JSON.parse(text); } catch { data = text; }
          return { ok: r.ok, http_status: r.status, data };
        } catch (err: any) {
          return {
            ok: false,
            http_status: null,
            error: String(err?.message ?? err),
            data: null,
          };
        }
      };

      const [perps, spot, metaCtxs] = await Promise.all([
        info({ type: "clearinghouseState", user: address }),
        info({ type: "spotClearinghouseState", user: address }),
        info({ type: "metaAndAssetCtxs" }),
      ]);

      const perpsData: any = perps?.data ?? {};
      const margin = perpsData?.marginSummary ?? {};
      const cross = perpsData?.crossMarginSummary ?? {};
      const spotData: any = spot?.data ?? {};
      const spotBalances = Array.isArray(spotData?.balances) ? spotData.balances : [];

      const usdc = spotBalances.find((b: any) =>
        String(b?.coin ?? b?.token ?? "").toUpperCase() === "USDC"
      ) ?? null;

      const positions = Array.isArray(perpsData?.assetPositions)
        ? perpsData.assetPositions
        : [];

      const nonZeroPositions = positions.filter((p: any) => {
        const pos = p?.position ?? p ?? {};
        return Math.abs(Number(pos?.szi ?? 0)) > 0;
      });

      const accountValue = Number(margin?.accountValue);
      const totalMarginUsed = Number(margin?.totalMarginUsed);
      const withdrawable = Number(perpsData?.withdrawable);
      const availableBySummary =
        Number.isFinite(accountValue) && Number.isFinite(totalMarginUsed)
          ? Math.max(0, accountValue - totalMarginUsed)
          : null;

      return json({
        success: true,
        worker: "cryptobot",
        version: VERSION,
        module: "hyperliquid-balance-diagnostic",
        network: "MAINNET",
        safe_read_only: true,
        signing_performed: false,
        exchange_endpoint_called: false,
        address,
        interpretation: {
          perps_account_value: Number.isFinite(accountValue) ? accountValue : null,
          perps_total_margin_used: Number.isFinite(totalMarginUsed) ? totalMarginUsed : null,
          perps_withdrawable: Number.isFinite(withdrawable) ? withdrawable : null,
          perps_available_by_summary: availableBySummary,
          cross_account_value: Number.isFinite(Number(cross?.accountValue)) ? Number(cross.accountValue) : null,
          cross_total_margin_used: Number.isFinite(Number(cross?.totalMarginUsed)) ? Number(cross.totalMarginUsed) : null,
          open_perps_positions: nonZeroPositions.length,
          spot_usdc: usdc,
        },
        raw: {
          clearinghouseState: perps,
          spotClearinghouseState: spot,
          metaAndAssetCtxs: metaCtxs,
        },
        note: "READ ONLY. Raw Hyperliquid /info responses are returned so balance parsing can be verified before changing the ENTRY guard.",
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/hyperliquid-account") {
      try {
        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          trading: "REAL_TRADING_DISABLED",
          status: await getHyperliquidAccountReadOnly(env),
        });
      } catch (error: any) {
        return json({
          success: false,
          worker: "cryptobot",
          version: VERSION,
          error: "HYPERLIQUID_ACCOUNT_READ_ONLY_FAILED",
          message: error?.message ?? String(error),
          trading: "REAL_TRADING_DISABLED",
        }, 500);
      }
    }


    // HYPERLIQUID SIGNING DIAGNOSTIC V2 — LOCAL API WALLET IDENTITY CHECK
    // Derives API-wallet address locally. Does NOT sign/call /exchange/place orders.
    if (url.pathname === "/hyperliquid-signing-diagnostic") {
      try {
        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          trading: "REAL_TRADING_DISABLED",
          status: await getHyperliquidSigningDiagnostic(env),
        });
      } catch (error: any) {
        return json({
          success: false,
          worker: "cryptobot",
          version: VERSION,
          error: "HYPERLIQUID_SIGNING_DIAGNOSTIC_FAILED",
          message: error?.message ?? String(error),
          trading: "REAL_TRADING_DISABLED",
        }, 500);
      }
    }

    // V1.9.2 — ML MODULE BASE TEST
    // Safe health endpoints only. They do not change signals or place trades.
    if (url.pathname === "/ml-shadow") {
      if (!env.DB) {
        return json({ success: false, error: "D1_NOT_BOUND", required_binding: "DB" }, 503);
      }
      try {
        await updateMLShadowLearning(env as any);
        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          module: "shadow-learning",
          mode: "BASE_TEST",
          trading: "REAL_TRADING_DISABLED",
          status: await getMLShadowStatus(env as any),
        });
      } catch (error: any) {
        return json({
          success: false,
          error: "ML_SHADOW_BASE_TEST_FAILED",
          message: error?.message ?? String(error),
        }, 500);
      }
    }

    if (url.pathname === "/ml-raw") {
      if (!env.DB) {
        return json({ success: false, error: "D1_NOT_BOUND", required_binding: "DB" }, 503);
      }
      try {
        await updateRawML(env as any);
        return json({
          success: true,
          worker: "cryptobot",
          version: VERSION,
          module: "raw-learning",
          mode: "BASE_TEST",
          trading: "REAL_TRADING_DISABLED",
          status: await getRawMLStatus(env as any),
        });
      } catch (error: any) {
        return json({
          success: false,
          error: "ML_RAW_BASE_TEST_FAILED",
          message: error?.message ?? String(error),
        }, 500);
      }
    }

    // DEBUG
    if (url.pathname === "/debug-hyperliquid") {
      return json({
        worker: "cryptobot",
        version: VERSION,
        mode: "READ_ONLY",
        ...(await debugHyperliquid()),
      });
    }

    return json(
      {
        success: false,
        error: "NOT_FOUND",
        path: url.pathname,
      },
      404
    );
  },

  async scheduled(
    _controller: any,
    env: Env,
    _ctx: any
  ): Promise<void> {
      await updateForwardLongShadow(env);
      await updateForwardShortShadow(env);

    if (!env.DB) {
      console.log(
        "V1.4 snapshot skipped: D1 binding DB is missing"
      );
      return;
    }

    await ensureSnapshotTable(env);

    // V1.9.9: reconcile real Hyperliquid positions before processing new signals.
    // Sends TP/SL close notifications and enforces MAX HOLD 30m.
    try {
      await monitorHyperliquidExecutionLifecycle(env);
    } catch (error: any) {
      console.log("Hyperliquid lifecycle monitor failed:", error?.message ?? String(error));
    }

    // V1.6.9: safe idempotent legacy cleanup. Once repaired to <=30m, a row
    // no longer matches and will not be touched again.
    try {
      await repairLegacyOver30mEpisodes(env, null, 100);
    } catch (error: any) {
      console.log(
        "V1.6.9 safe legacy repair failed:",
        error?.message ?? String(error)
      );
    }

    // Fetch news once per cron run, not once per coin.
    // A feed failure must not stop market snapshots/paper tracking.
    let newsData: any = null;

    try {
      newsData = await buildNewsOnly(env);
    } catch (error: any) {
      console.log(
        "V1.5.1 news preload failed:",
        error?.message ?? String(error)
      );
    }

    const results = await Promise.allSettled(
      TRACKED_COINS.map(async (coin) => {
        const signal = await buildSignal(coin, env);
        await saveSnapshot(env, signal);

        const news =
          newsData?.scores?.[coin] ??
          {
            coin,
            items_considered: 0,
            active_items: 0,
            expired_items: 0,
            top_items: [],
            signed_score: 0,
            long_score: 0,
            short_score: 0,
            bias: "NEUTRAL",
            breaking_high_impact: false,
          };

        const final = combineMarketAndNews(
          signal.market,
          news
        );

        const finalSignal = {
          coin,
          price: signal.price,
          market: signal.market,
          news_x: news,
          final,
        };

        // V1.6: update 1m/5m/15m/30m outcomes for
        // previously opened independent signal episodes.
        await updateEpisodeOutcomes(
          env,
          coin
        );

        // Keep raw minute observations for backward comparison.
        const observation =
          await recordPaperObservation(
            env,
            signal,
            finalSignal
          );

        // Deduplicated signal episode engine.
        const episode =
          await processSignalEpisode(
            env,
            signal,
            finalSignal
          );

        // >=65 primary research + separate 60-64 control cohort.
        await update65CrossingOutcomes(env, coin);
        await update6064CrossingOutcomes(env, coin);
        const crossing65 = await record65Crossing(env, signal, finalSignal);
        const crossing6064 = await record6064Crossing(env, signal, finalSignal);

        // HYPERLIQUID EXECUTION POLICY:
        // - ONE TRADE PER COIN PER SIGNAL EPISODE.
        // - record65Crossing() is the episode-level idempotency guard:
        //   only the first >=65 crossing in that episode can create a candidate.
        // - Different coins remain independent and may trade concurrently.
        // - No same-episode re-entry after TP/SL.
        // - D1 execution ledger additionally claims crossing_id + episode_id exactly once.
        // - Live execution accepts only a fresh crossing from SIGNAL_PIPELINE.
        // - /hyperliquid-execution is permanently READ_ONLY_STATUS.
        // - HARD SAFETY: execution.ts currently has LIVE_TRADING=false.
        let hyperliquidExecution: any = {
          eligible: false,
          status: "SKIPPED",
          reason: "NO_NEW_65_CROSSING_OR_EPISODE_ALREADY_TRADED",
          trade_policy: "ONE_TRADE_PER_COIN_PER_EPISODE",
          live_trading: false,
          exchange_request_sent: false,
        };

        if (crossing65?.recorded === true) {
          try {
            hyperliquidExecution = await buildHyperliquidExecutionCandidate({
              coin,
              side: crossing65.side,
              score: Number(crossing65.crossing_score),
              price: Number(crossing65.crossing_price),
              crossing_id: crossing65.crossing_id ?? null,
              episode_id: crossing65.episode_id ?? null,
              crossing_ts: Number(crossing65.crossing_ts),
              execution_context: "SIGNAL_PIPELINE",
            }, env);
          } catch (error: any) {
            hyperliquidExecution = {
              eligible: false,
              status: "ERROR",
              reason: error?.message ?? String(error),
              live_trading: false,
              exchange_request_sent: false,
            };
          }
        }

        // Existing PAPER engine remains unchanged.
        const paper = await processPaperCoin(
          env,
          signal,
          finalSignal
        );

        return {
          coin,
          price: signal.price,
          market_score: signal.market?.signed_score ?? 0,
          news_score: news?.signed_score ?? 0,
          active_news_items: news?.active_items ?? 0,
          final_score: final?.signed_score ?? 0,
          final_mode: final?.mode ?? null,
          observation,
          episode,
          crossing65,
          crossing6064,
          hyperliquid_execution: hyperliquidExecution,
          oi: signal.derivatives?.open_interest ?? null,
          order_flow:
            signal.microstructure?.order_flow?.signed_score ?? 0,
          paper,
        };
      })
    );

    // V1.9.2 — isolated ML module health runs.
    // A module failure must never break the existing CryptoBot cron.
    try {
      await updateMLShadowLearning(env as any);
    } catch (error: any) {
      console.log("ML shadow module failed:", error?.message ?? String(error));
    }

    try {
      await updateRawML(env as any);
    } catch (error: any) {
      console.log("ML raw module failed:", error?.message ?? String(error));
    }

    console.log(
      JSON.stringify({
        worker: "cryptobot",
        version: VERSION,
        action: "SNAPSHOT_CRON",
        timestamp: Date.now(),
        results,
      })
    );
  },
};
