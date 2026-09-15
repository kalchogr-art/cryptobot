// ============================================================
// CRYPTOBOT V1.1 — HYPERLIQUID CHART ENGINE
// READ ONLY / NO TRADING
//
// Coins:
// BTC / ETH / SOL / XRP / BNB
//
// V1.1:
// - Hyperliquid market data
// - 1m + 5m candles
// - Momentum
// - Trend
// - Volume expansion
// - Volatility
// - LONG / SHORT chart score
// - Bias + status
//
// IMPORTANT:
// LONG/SHORT scores measure chart alignment/strength.
// They are NOT probabilities of profit.
//
// Endpoints:
// /
// /health
// /market
// /candles?coin=BTC&interval=1m&limit=60
// /book?coin=BTC
// /chart?coin=BTC
// /charts
// /debug-hyperliquid
//
// NO WALLET
// NO PRIVATE KEY
// NO ORDERS
// ============================================================

const VERSION =
  "V1.1 HYPERLIQUID CHART ENGINE";

const HYPERLIQUID_INFO =
  "https://api.hyperliquid.xyz/info";

const TRACKED_COINS = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
] as const;

const ALLOWED_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
] as const;

type JsonObject =
  Record<string, any>;


// ============================================================
// RESPONSE
// ============================================================

function json(
  data: any,
  status = 200
): Response {

  return new Response(
    JSON.stringify(
      data,
      null,
      2
    ),
    {
      status,
      headers: {
        "content-type":
          "application/json; charset=UTF-8",

        "access-control-allow-origin":
          "*",

        "cache-control":
          "no-store",
      },
    }
  );
}


// ============================================================
// HELPERS
// ============================================================

function num(
  value: any
): number | null {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function clamp(
  value: number,
  min = 0,
  max = 100
): number {

  return Math.max(
    min,
    Math.min(
      max,
      value
    )
  );
}


function round(
  value: number,
  decimals = 2
): number {

  const p =
    10 ** decimals;

  return (
    Math.round(
      value * p
    ) / p
  );
}


function average(
  values: number[]
): number {

  if (
    values.length === 0
  ) {
    return 0;
  }

  return (
    values.reduce(
      (a, b) =>
        a + b,
      0
    ) /
    values.length
  );
}


function validCoin(
  coin: string
): boolean {

  return (
    TRACKED_COINS as
    readonly string[]
  ).includes(
    coin.toUpperCase()
  );
}


// ============================================================
// HYPERLIQUID
// ============================================================

async function hyperliquid(
  payload: JsonObject
): Promise<any> {

  const response =
    await fetch(
      HYPERLIQUID_INFO,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json",
        },

        body:
          JSON.stringify(
            payload
          ),
      }
    );

  const text =
    await response.text();

  let data: any;

  try {

    data =
      JSON.parse(text);

  } catch {

    throw new Error(
      "HYPERLIQUID_INVALID_JSON: " +
      text.slice(
        0,
        500
      )
    );
  }

  if (
    !response.ok
  ) {

    throw new Error(
      `HYPERLIQUID_HTTP_${response.status}: ` +
      text.slice(
        0,
        500
      )
    );
  }

  return data;
}


// ============================================================
// MARKET DATA
// ============================================================

async function getAllMids() {

  return hyperliquid({
    type:
      "allMids",
  });
}


async function getMetaAndContexts() {

  return hyperliquid({
    type:
      "metaAndAssetCtxs",
  });
}


async function getMarket() {

  const [
    mids,
    metaCtx,
  ] =
    await Promise.all([
      getAllMids(),
      getMetaAndContexts(),
    ]);

  const meta =
    Array.isArray(
      metaCtx
    )
      ? metaCtx[0]
      : null;

  const contexts =
    Array.isArray(
      metaCtx
    )
      ? metaCtx[1]
      : null;

  const universe =
    Array.isArray(
      meta?.universe
    )
      ? meta.universe
      : [];

  const rows =
    TRACKED_COINS.map(
      coin => {

        const index =
          universe.findIndex(
            (x: any) =>
              String(
                x?.name ??
                ""
              ).toUpperCase() ===
              coin
          );

        const ctx =
          index >= 0 &&
          Array.isArray(
            contexts
          )
            ? contexts[index]
            : null;

        const mid =
          num(
            mids?.[coin]
          );

        const previous =
          num(
            ctx?.prevDayPx
          );

        let change24h:
          number | null =
          null;

        if (
          mid !== null &&
          previous !== null &&
          previous !== 0
        ) {

          change24h =
            (
              (
                mid -
                previous
              ) /
              previous
            ) *
            100;
        }

        return {
          coin,

          found:
            index >= 0,

          mid,

          mark_price:
            num(
              ctx?.markPx
            ),

          oracle_price:
            num(
              ctx?.oraclePx
            ),

          funding:
            num(
              ctx?.funding
            ),

          open_interest:
            num(
              ctx?.openInterest
            ),

          day_volume:
            num(
              ctx?.dayNtlVlm
            ),

          previous_day_price:
            previous,

          change_24h_pct:
            change24h === null
              ? null
              : round(
                  change24h,
                  3
                ),

          premium:
            num(
              ctx?.premium
            ),
        };
      }
    );

  return {
    source:
      "HYPERLIQUID",

    market:
      "PERPETUALS",

    timestamp:
      Date.now(),

    datetime:
      new Date()
        .toISOString(),

    coins:
      rows,
  };
}


// ============================================================
// CANDLES
// ============================================================

const INTERVAL_MS:
  Record<string, number> = {

    "1m":
      60_000,

    "3m":
      180_000,

    "5m":
      300_000,

    "15m":
      900_000,

    "30m":
      1_800_000,

    "1h":
      3_600_000,
  };


async function getCandles(
  coin: string,
  interval: string,
  limit: number
) {

  const now =
    Date.now();

  const step =
    INTERVAL_MS[
      interval
    ];

  if (
    !step
  ) {
    throw new Error(
      "INVALID_INTERVAL"
    );
  }

  const startTime =
    now -
    step *
    Math.max(
      limit + 5,
      20
    );

  const raw =
    await hyperliquid({
      type:
        "candleSnapshot",

      req: {
        coin,
        interval,
        startTime,
        endTime:
          now,
      },
    });

  const candles =
    Array.isArray(raw)
      ? raw
          .slice(
            -limit
          )
          .map(
            (c: any) => ({
              coin:
                c?.s ??
                coin,

              interval:
                c?.i ??
                interval,

              open_time:
                c?.t ??
                null,

              close_time:
                c?.T ??
                null,

              open:
                num(c?.o),

              high:
                num(c?.h),

              low:
                num(c?.l),

              close:
                num(c?.c),

              volume:
                num(c?.v),

              trades:
                num(c?.n),
            })
          )
      : [];

  return {
    source:
      "HYPERLIQUID",

    coin,

    interval,

    requested_limit:
      limit,

    returned:
      candles.length,

    timestamp:
      now,

    candles,
  };
}


// ============================================================
// ORDER BOOK
// Kept from V1.0.
// Not included in Chart Score yet.
// ============================================================

async function getBook(
  coin: string
) {

  const data =
    await hyperliquid({
      type:
        "l2Book",

      coin,
    });

  const bids =
    Array.isArray(
      data?.levels?.[0]
    )
      ? data.levels[0]
      : [];

  const asks =
    Array.isArray(
      data?.levels?.[1]
    )
      ? data.levels[1]
      : [];

  const normalizedBids =
    bids.map(
      (x: any) => ({
        price:
          num(x?.px),

        size:
          num(x?.sz),

        orders:
          num(x?.n),
      })
    );

  const normalizedAsks =
    asks.map(
      (x: any) => ({
        price:
          num(x?.px),

        size:
          num(x?.sz),

        orders:
          num(x?.n),
      })
    );

  const bestBid =
    normalizedBids[0]
      ?.price ??
    null;

  const bestAsk =
    normalizedAsks[0]
      ?.price ??
    null;

  const spread =
    bestBid !== null &&
    bestAsk !== null
      ? bestAsk -
        bestBid
      : null;

  const mid =
    bestBid !== null &&
    bestAsk !== null
      ? (
          bestBid +
          bestAsk
        ) /
        2
      : null;

  const spreadPct =
    spread !== null &&
    mid !== null &&
    mid !== 0
      ? (
          spread /
          mid
        ) *
        100
      : null;

  return {
    source:
      "HYPERLIQUID",

    coin,

    timestamp:
      data?.time ??
      Date.now(),

    best_bid:
      bestBid,

    best_ask:
      bestAsk,

    spread:
      spread === null
        ? null
        : round(
            spread,
            8
          ),

    spread_pct:
      spreadPct === null
        ? null
        : round(
            spreadPct,
            6
          ),

    bids:
      normalizedBids,

    asks:
      normalizedAsks,
  };
}


// ============================================================
// CHART ENGINE
// ============================================================

type Candle = {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  [key: string]: any;
};


function usableCandles(
  candles: Candle[]
) {

  return candles.filter(
    c =>
      c.open !== null &&
      c.high !== null &&
      c.low !== null &&
      c.close !== null
  );
}


// ============================================================
// MOMENTUM
//
// Measures short-term price movement.
// Output:
// direction = -1 .. +1
// strength  = 0 .. 100
// ============================================================

function calculateMomentum(
  candles: Candle[]
) {

  const usable =
    usableCandles(
      candles
    );

  if (
    usable.length < 6
  ) {

    return {
      pct:
        0,

      direction:
        0,

      strength:
        0,
    };
  }

  const recent =
    usable.slice(
      -6
    );

  const first =
    recent[0]
      .close as number;

  const last =
    recent[
      recent.length - 1
    ].close as number;

  if (
    first === 0
  ) {

    return {
      pct:
        0,

      direction:
        0,

      strength:
        0,
    };
  }

  const pct =
    (
      (
        last -
        first
      ) /
      first
    ) *
    100;

  // Adaptive normalization based on recent candle ranges.

  const ranges =
    recent.map(
      c => {

        const close =
          c.close as number;

        if (
          close === 0
        ) {
          return 0;
        }

        return (
          (
            (
              c.high as number
            ) -
            (
              c.low as number
            )
          ) /
          close
        ) *
        100;
      }
    );

  const normalRange =
    Math.max(
      average(
        ranges
      ),
      0.01
    );

  const normalized =
    Math.abs(
      pct
    ) /
    (
      normalRange *
      3
    );

  const strength =
    clamp(
      normalized *
      100
    );

  const direction =
    pct > 0
      ? 1
      : pct < 0
        ? -1
        : 0;

  return {
    pct:
      round(
        pct,
        4
      ),

    direction,

    strength:
      round(
        strength
      ),
  };
}


// ============================================================
// TREND
//
// Fast average vs slow average.
// Also checks candle structure.
// ============================================================

function calculateTrend(
  candles: Candle[]
) {

  const usable =
    usableCandles(
      candles
    );

  if (
    usable.length < 20
  ) {

    return {
      direction:
        0,

      strength:
        0,

      fast_avg:
        null,

      slow_avg:
        null,
    };
  }

  const closes =
    usable.map(
      c =>
        c.close as number
    );

  const fast =
    average(
      closes.slice(
        -5
      )
    );

  const slow =
    average(
      closes.slice(
        -20
      )
    );

  if (
    slow === 0
  ) {

    return {
      direction:
        0,

      strength:
        0,

      fast_avg:
        round(fast),

      slow_avg:
        round(slow),
    };
  }

  const distancePct =
    (
      (
        fast -
        slow
      ) /
      slow
    ) *
    100;

  const last20 =
    usable.slice(
      -20
    );

  const ranges =
    last20.map(
      c => {

        const close =
          c.close as number;

        if (
          close === 0
        ) {
          return 0;
        }

        return (
          (
            (
              c.high as number
            ) -
            (
              c.low as number
            )
          ) /
          close
        ) *
        100;
      }
    );

  const normalRange =
    Math.max(
      average(
        ranges
      ),
      0.01
    );

  const strength =
    clamp(
      (
        Math.abs(
          distancePct
        ) /
        (
          normalRange *
          1.5
        )
      ) *
      100
    );

  const direction =
    distancePct > 0
      ? 1
      : distancePct < 0
        ? -1
        : 0;

  return {
    direction,

    strength:
      round(
        strength
      ),

    fast_avg:
      round(
        fast,
        6
      ),

    slow_avg:
      round(
        slow,
        6
      ),

    distance_pct:
      round(
        distancePct,
        4
      ),
  };
}


// ============================================================
// VOLUME
//
// Current volume compared with previous candles.
//
// Volume has NO direction by itself.
// ============================================================

function calculateVolume(
  candles: Candle[]
) {

  const usable =
    candles.filter(
      c =>
        c.volume !== null
    );

  if (
    usable.length < 11
  ) {

    return {
      ratio:
        1,

      strength:
        0,

      current:
        null,

      average:
        null,
    };
  }

  const latest =
    usable[
      usable.length - 1
    ].volume as number;

  const previous =
    usable
      .slice(
        -11,
        -1
      )
      .map(
        c =>
          c.volume as number
      );

  const avg =
    average(
      previous
    );

  if (
    avg <= 0
  ) {

    return {
      ratio:
        1,

      strength:
        0,

      current:
        latest,

      average:
        avg,
    };
  }

  const ratio =
    latest /
    avg;

  // 1x = normal
  // 2x = strong
  // 3x+ = extreme

  const strength =
    clamp(
      (
        ratio -
        1
      ) *
      50
    );

  return {
    ratio:
      round(
        ratio,
        3
      ),

    strength:
      round(
        strength
      ),

    current:
      latest,

    average:
      round(
        avg,
        6
      ),
  };
}


// ============================================================
// VOLATILITY
//
// Latest candle range vs recent average.
// No direction by itself.
// ============================================================

function calculateVolatility(
  candles: Candle[]
) {

  const usable =
    usableCandles(
      candles
    );

  if (
    usable.length < 11
  ) {

    return {
      ratio:
        1,

      strength:
        0,

      latest_range_pct:
        0,

      normal_range_pct:
        0,
    };
  }

  const ranges =
    usable.map(
      c => {

        const close =
          c.close as number;

        if (
          close === 0
        ) {
          return 0;
        }

        return (
          (
            (
              c.high as number
            ) -
            (
              c.low as number
            )
          ) /
          close
        ) *
        100;
      }
    );

  const latest =
    ranges[
      ranges.length - 1
    ];

  const baseline =
    average(
      ranges.slice(
        -11,
        -1
      )
    );

  if (
    baseline <= 0
  ) {

    return {
      ratio:
        1,

      strength:
        0,

      latest_range_pct:
        round(
          latest,
          4
        ),

      normal_range_pct:
        0,
    };
  }

  const ratio =
    latest /
    baseline;

  const strength =
    clamp(
      (
        ratio -
        1
      ) *
      50
    );

  return {
    ratio:
      round(
        ratio,
        3
      ),

    strength:
      round(
        strength
      ),

    latest_range_pct:
      round(
        latest,
        4
      ),

    normal_range_pct:
      round(
        baseline,
        4
      ),
  };
}


// ============================================================
// TIMEFRAME SCORE
// ============================================================

function calculateTimeframe(
  candles: Candle[],
  interval: string
) {

  const momentum =
    calculateMomentum(
      candles
    );

  const trend =
    calculateTrend(
      candles
    );

  const volume =
    calculateVolume(
      candles
    );

  const volatility =
    calculateVolatility(
      candles
    );


  // Direction comes only from directional indicators.

  const directionalRaw =
    (
      momentum.direction *
      momentum.strength *
      0.55
    ) +
    (
      trend.direction *
      trend.strength *
      0.45
    );


  const direction =
    directionalRaw > 5
      ? 1
      : directionalRaw < -5
        ? -1
        : 0;


  const directionalStrength =
    Math.abs(
      directionalRaw
    );


  // Volume and volatility amplify an existing direction.
  // They never create LONG/SHORT by themselves.

  const confirmation =
    (
      volume.strength *
      0.60
    ) +
    (
      volatility.strength *
      0.40
    );


  let totalStrength =
    directionalStrength;

  if (
    direction !== 0
  ) {

    totalStrength =
      clamp(
        directionalStrength *
        0.75 +
        confirmation *
        0.25
      );
  }


  const longScore =
    direction > 0
      ? totalStrength
      : direction === 0
        ? 0
        : 0;


  const shortScore =
    direction < 0
      ? totalStrength
      : direction === 0
        ? 0
        : 0;


  return {
    interval,

    momentum,

    trend,

    volume,

    volatility,

    direction:
      direction > 0
        ? "BULLISH"
        : direction < 0
          ? "BEARISH"
          : "NEUTRAL",

    directional_raw:
      round(
        directionalRaw
      ),

    confirmation:
      round(
        confirmation
      ),

    long_score:
      round(
        longScore
      ),

    short_score:
      round(
        shortScore
      ),
  };
}


// ============================================================
// FINAL CHART SCORE
//
// 1m = 60%
// 5m = 40%
//
// Important:
// disagreement is intentionally penalized.
// ============================================================

function combineTimeframes(
  oneMinute: any,
  fiveMinute: any
) {

  const oneDirection =
    oneMinute.direction;

  const fiveDirection =
    fiveMinute.direction;


  let longScore =
    (
      oneMinute.long_score *
      0.60
    ) +
    (
      fiveMinute.long_score *
      0.40
    );


  let shortScore =
    (
      oneMinute.short_score *
      0.60
    ) +
    (
      fiveMinute.short_score *
      0.40
    );


  let agreement =
    "MIXED";


  if (
    oneDirection ===
      "BULLISH" &&
    fiveDirection ===
      "BULLISH"
  ) {

    agreement =
      "BULLISH_CONFIRMATION";

    longScore =
      clamp(
        longScore *
        1.10
      );
  }


  if (
    oneDirection ===
      "BEARISH" &&
    fiveDirection ===
      "BEARISH"
  ) {

    agreement =
      "BEARISH_CONFIRMATION";

    shortScore =
      clamp(
        shortScore *
        1.10
      );
  }


  if (
    oneDirection ===
      "NEUTRAL" &&
    fiveDirection ===
      "NEUTRAL"
  ) {

    agreement =
      "NEUTRAL";
  }


  if (
    oneDirection !==
      "NEUTRAL" &&
    fiveDirection !==
      "NEUTRAL" &&
    oneDirection !==
      fiveDirection
  ) {

    agreement =
      "TIMEFRAME_CONFLICT";

    longScore *=
      0.70;

    shortScore *=
      0.70;
  }


  longScore =
    clamp(
      longScore
    );

  shortScore =
    clamp(
      shortScore
    );


  const difference =
    longScore -
    shortScore;


  let bias =
    "NEUTRAL";


  if (
    difference >= 10
  ) {

    bias =
      "LONG";

  } else if (
    difference <= -10
  ) {

    bias =
      "SHORT";
  }


  const strongest =
    Math.max(
      longScore,
      shortScore
    );


  let status =
    "NO_TRADE";


  if (
    strongest >= 80 &&
    Math.abs(
      difference
    ) >= 20
  ) {

    status =
      "STRONG";

  } else if (
    strongest >= 65 &&
    Math.abs(
      difference
    ) >= 15
  ) {

    status =
      "WATCH";

  } else if (
    strongest >= 50
  ) {

    status =
      "WEAK";
  }


  return {
    long_score:
      round(
        longScore
      ),

    short_score:
      round(
        shortScore
      ),

    difference:
      round(
        difference
      ),

    bias,

    status,

    timeframe_agreement:
      agreement,
  };
}


// ============================================================
// BUILD CHART
// ============================================================

async function buildChart(
  coin: string
) {

  const started =
    Date.now();


  const [
    candles1m,
    candles5m,
    mids,
  ] =
    await Promise.all([

      getCandles(
        coin,
        "1m",
        40
      ),

      getCandles(
        coin,
        "5m",
        40
      ),

      getAllMids(),
    ]);


  const oneMinute =
    calculateTimeframe(
      candles1m.candles,
      "1m"
    );


  const fiveMinute =
    calculateTimeframe(
      candles5m.candles,
      "5m"
    );


  const final =
    combineTimeframes(
      oneMinute,
      fiveMinute
    );


  return {
    source:
      "HYPERLIQUID",

    coin,

    price:
      num(
        mids?.[coin]
      ),

    timestamp:
      Date.now(),

    datetime:
      new Date()
        .toISOString(),

    processing_ms:
      Date.now() -
      started,

    candles: {
      "1m":
        candles1m.returned,

      "5m":
        candles5m.returned,
    },

    timeframe_1m:
      oneMinute,

    timeframe_5m:
      fiveMinute,

    chart: {
      ...final,

      meaning:
        "Chart strength/alignment score, not probability of profit",
    },
  };
}


// ============================================================
// DEBUG
// ============================================================

async function debugHyperliquid() {

  const started =
    Date.now();

  try {

    const [
      mids,
      meta,
    ] =
      await Promise.all([
        getAllMids(),
        getMetaAndContexts(),
      ]);

    return {
      success:
        true,

      source:
        "HYPERLIQUID",

      endpoint:
        HYPERLIQUID_INFO,

      latency_ms:
        Date.now() -
        started,

      tracked_coins:
        TRACKED_COINS,

      mids_found:
        Object.fromEntries(
          TRACKED_COINS.map(
            coin => [
              coin,
              mids?.[coin] ??
              null,
            ]
          )
        ),

      meta_response:
        Array.isArray(
          meta
        ),

      meta_parts:
        Array.isArray(
          meta
        )
          ? meta.length
          : 0,
    };

  } catch (
    error: any
  ) {

    return {
      success:
        false,

      source:
        "HYPERLIQUID",

      latency_ms:
        Date.now() -
        started,

      error:
        error?.message ??
        String(error),
    };
  }
}


// ============================================================
// WORKER
// ============================================================

export default {

  async fetch(
    request: Request
  ): Promise<Response> {

    const url =
      new URL(
        request.url
      );


    // ========================================================
    // CORS
    // ========================================================

    if (
      request.method ===
      "OPTIONS"
    ) {

      return new Response(
        null,
        {
          headers: {
            "access-control-allow-origin":
              "*",

            "access-control-allow-methods":
              "GET, OPTIONS",

            "access-control-allow-headers":
              "content-type",
          },
        }
      );
    }


    if (
      request.method !==
      "GET"
    ) {

      return json(
        {
          success:
            false,

          error:
            "METHOD_NOT_ALLOWED",
        },
        405
      );
    }


    // ========================================================
    // ROOT
    // ========================================================

    if (
      url.pathname === "/"
    ) {

      return json({
        success:
          true,

        worker:
          "cryptobot",

        version:
          VERSION,

        mode:
          "READ_ONLY",

        trading:
          "DISABLED",

        source:
          "HYPERLIQUID",

        tracked_coins:
          TRACKED_COINS,

        chart_engine: {
          enabled:
            true,

          timeframes: [
            "1m",
            "5m",
          ],

          execution:
            "NONE",

          paper_trading:
            false,
        },

        endpoints: {
          health:
            "/health",

          market:
            "/market",

          candles:
            "/candles?coin=BTC&interval=1m&limit=60",

          book:
            "/book?coin=BTC",

          chart:
            "/chart?coin=BTC",

          charts:
            "/charts",

          debug:
            "/debug-hyperliquid",
        },
      });
    }


    // ========================================================
    // HEALTH
    // ========================================================

    if (
      url.pathname ===
      "/health"
    ) {

      return json({
        success:
          true,

        worker:
          "cryptobot",

        version:
          VERSION,

        status:
          "ONLINE",

        mode:
          "READ_ONLY",

        trading:
          false,

        chart_engine:
          true,

        timestamp:
          Date.now(),
      });
    }


    // ========================================================
    // MARKET
    // ========================================================

    if (
      url.pathname ===
      "/market"
    ) {

      try {

        return json({
          success:
            true,

          ...await getMarket(),
        });

      } catch (
        error: any
      ) {

        return json(
          {
            success:
              false,

            error:
              "MARKET_FETCH_FAILED",

            message:
              error?.message ??
              String(error),
          },
          500
        );
      }
    }


    // ========================================================
    // CANDLES
    // ========================================================

    if (
      url.pathname ===
      "/candles"
    ) {

      const coin =
        (
          url.searchParams.get(
            "coin"
          ) ??
          "BTC"
        ).toUpperCase();


      const interval =
        url.searchParams.get(
          "interval"
        ) ??
        "1m";


      let limit =
        Number(
          url.searchParams.get(
            "limit"
          ) ??
          "60"
        );


      if (
        !validCoin(
          coin
        )
      ) {

        return json(
          {
            success:
              false,

            error:
              "INVALID_COIN",

            allowed:
              TRACKED_COINS,
          },
          400
        );
      }


      if (
        !(
          ALLOWED_INTERVALS as
          readonly string[]
        ).includes(
          interval
        )
      ) {

        return json(
          {
            success:
              false,

            error:
              "INVALID_INTERVAL",

            allowed:
              ALLOWED_INTERVALS,
          },
          400
        );
      }


      if (
        !Number.isFinite(
          limit
        )
      ) {
        limit =
          60;
      }


      limit =
        Math.max(
          1,
          Math.min(
            500,
            Math.floor(
              limit
            )
          )
        );


      try {

        return json({
          success:
            true,

          ...await getCandles(
            coin,
            interval,
            limit
          ),
        });

      } catch (
        error: any
      ) {

        return json(
          {
            success:
              false,

            error:
              "CANDLE_FETCH_FAILED",

            message:
              error?.message ??
              String(error),
          },
          500
        );
      }
    }


    // ========================================================
    // BOOK
    // ========================================================

    if (
      url.pathname ===
      "/book"
    ) {

      const coin =
        (
          url.searchParams.get(
            "coin"
          ) ??
          "BTC"
        ).toUpperCase();


      if (
        !validCoin(
          coin
        )
      ) {

        return json(
          {
            success:
              false,

            error:
              "INVALID_COIN",

            allowed:
              TRACKED_COINS,
          },
          400
        );
      }


      try {

        return json({
          success:
            true,

          ...await getBook(
            coin
          ),
        });

      } catch (
        error: any
      ) {

        return json(
          {
            success:
              false,

            error:
              "BOOK_FETCH_FAILED",

            message:
              error?.message ??
              String(error),
          },
          500
        );
      }
    }


    // ========================================================
    // SINGLE CHART
    // ========================================================

    if (
      url.pathname ===
      "/chart"
    ) {

      const coin =
        (
          url.searchParams.get(
            "coin"
          ) ??
          "BTC"
        ).toUpperCase();


      if (
        !validCoin(
          coin
        )
      ) {

        return json(
          {
            success:
              false,

            error:
              "INVALID_COIN",

            allowed:
              TRACKED_COINS,
          },
          400
        );
      }


      try {

        return json({
          success:
            true,

          worker:
            "cryptobot",

          version:
            VERSION,

          mode:
            "READ_ONLY",

          ...(await buildChart(
            coin
          )),
        });

      } catch (
        error: any
      ) {

        return json(
          {
            success:
              false,

            error:
              "CHART_ENGINE_FAILED",

            coin,

            message:
              error?.message ??
              String(error),
          },
          500
        );
      }
    }


    // ========================================================
    // ALL CHARTS
    // ========================================================

    if (
      url.pathname ===
      "/charts"
    ) {

      const started =
        Date.now();


      try {

        const results =
          await Promise.all(
            TRACKED_COINS.map(
              coin =>
                buildChart(
                  coin
                )
            )
          );


        return json({
          success:
            true,

          worker:
            "cryptobot",

          version:
            VERSION,

          mode:
            "READ_ONLY",

          source:
            "HYPERLIQUID",

          trading:
            "DISABLED",

          timestamp:
            Date.now(),

          processing_ms:
            Date.now() -
            started,

          total:
            results.length,

          charts:
            results,
        });

      } catch (
        error: any
      ) {

        return json(
          {
            success:
              false,

            error:
              "ALL_CHARTS_FAILED",

            message:
              error?.message ??
              String(error),
          },
          500
        );
      }
    }


    // ========================================================
    // DEBUG
    // ========================================================

    if (
      url.pathname ===
      "/debug-hyperliquid"
    ) {

      return json({
        worker:
          "cryptobot",

        version:
          VERSION,

        mode:
          "READ_ONLY",

        ...(await debugHyperliquid()),
      });
    }


    // ========================================================
    // 404
    // ========================================================

    return json(
      {
        success:
          false,

        error:
          "NOT_FOUND",

        path:
          url.pathname,
      },
      404
    );
  },
};
