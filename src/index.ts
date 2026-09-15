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

const VERSION = "V1.2 MICROSTRUCTURE ENGINE";
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
  async fetch(request: Request): Promise<Response> {
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
          news_x: false,
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
          debug: "/debug-hyperliquid",
        },

        next_version:
          "V1.3 NEWS/X ENGINE",
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
