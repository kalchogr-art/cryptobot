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

const VERSION = "V1.5 PAPER TRADING ENGINE";
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

  // Cloudflare D1 binding. Recommended binding name: DB
  DB?: any;
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

  const marketSigned = Number(signal.market?.signed_score ?? 0);
  const finalSigned = Number(
    finalSignal?.final?.signed_score ?? marketSigned
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

  if (
    Math.abs(
      Number(signal.market?.difference ?? finalSigned)
    ) < PAPER_MIN_SCORE_GAP
  ) {
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
    signal.market?.weights?.mode ?? null,
    finalSignal?.news?.signed_score ?? null,
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
          paper_trades: "/paper-trades?status=ALL&limit=50",
          paper_summary: "/paper-summary",
          debug: "/debug-hyperliquid",
        },

        next_version:
          "V1.5.1 PAPER ANALYTICS + SIGNAL BUCKETS",
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
    if (!env.DB) {
      console.log(
        "V1.4 snapshot skipped: D1 binding DB is missing"
      );
      return;
    }

    await ensureSnapshotTable(env);

    const results = await Promise.allSettled(
      TRACKED_COINS.map(async (coin) => {
        const signal = await buildSignal(coin, env);
        await saveSnapshot(env, signal);

        // V1.5 PAPER ONLY:
        // update an existing simulated position or open a new
        // simulated position if the market score qualifies.
        const paper = await processPaperCoin(
          env,
          signal
        );

        return {
          coin,
          price: signal.price,
          oi: signal.derivatives?.open_interest ?? null,
          order_flow:
            signal.microstructure?.order_flow?.signed_score ?? 0,
          paper,
        };
      })
    );

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
