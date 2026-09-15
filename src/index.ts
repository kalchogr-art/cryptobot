// ============================================================
// CRYPTOBOT V1.2 — MICROSTRUCTURE ENGINE
// READ ONLY / NO TRADING
//
// Coins: BTC / ETH / SOL / XRP / BNB
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

const VERSION = "V1.3.1 NEWS CLASSIFIER FIX";
const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";

const TRACKED_COINS = ["BTC", "ETH", "SOL", "XRP", "BNB"] as const;
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
  derivatives: any
) {
  const c = chartSigned(chart);
  const of = clampSigned(
    Number(book?.order_flow?.signed_score ?? 0)
  );

  // OI change is deliberately 0 until we store historical snapshots.
  const oi = 0;

  const fundingContext = clampSigned(
    Number(derivatives?.contextual_signed_score ?? 0)
  );

  // Current V1.2 effective weights:
  // Chart      65%
  // Order flow 30%
  // Funding/premium 5%
  //
  // When OI-change becomes available:
  // target is Chart 55 / OrderFlow 25 / OI 15 / Funding 5.
  const signed =
    c * 0.65 +
    of * 0.30 +
    fundingContext * 0.05;

  const signedClamped = clampSigned(signed);

  const longScore =
    signedClamped > 0
      ? clamp(signedClamped)
      : 0;

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
      chart: 0.65,
      order_flow: 0.30,
      oi_change: 0,
      funding_premium: 0.05,
      future_target_after_oi_history: {
        chart: 0.55,
        order_flow: 0.25,
        oi_change: 0.15,
        funding_premium: 0.05,
      },
    },

    components: {
      chart_signed: round(c),
      order_flow_signed: round(of),
      oi_change_signed: oi,
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

async function buildSignal(coin: string) {
  const started = Date.now();

  const [chart, book, asset] = await Promise.all([
    buildChart(coin),
    getBook(coin),
    getAssetContext(coin),
  ]);

  const derivatives = buildDerivatives(asset.context);
  const market = buildMarketScore(
    chart.chart,
    book,
    derivatives
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
  };

  if (textHas(t, direct[coin] ?? [])) return 100;

  // Macro / regulatory stories can affect the whole crypto complex.
  const broadCrypto = [
    "crypto",
    "cryptocurrency",
    "digital asset",
    "stablecoin",
    "spot etf",
    "exchange-traded fund",
    "blockchain",
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

  let marketWeight = 0.70;
  let newsWeight = 0.30;
  let mode = "NORMAL";

  if (news?.breaking_high_impact) {
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

  return {
    ...collected,
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
    buildSignal(coin),
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
          oi_change: false,
          news_x: true,
          x_optional_bearer_token: true,
          official_rss: true,
          paper_trading: false,
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
          debug: "/debug-hyperliquid",
        },

        next_version:
          "V1.3.2 X ACTIVATION + SOURCE EXPANSION",
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
          ...(await buildSignal(coin)),
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
          TRACKED_COINS.map((coin) => buildSignal(coin))
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
};
