// ============================================================
// CRYPTOBOT V1.0
// HYPERLIQUID MARKET COLLECTOR
// READ ONLY
//
// Coins:
// - BTC
// - ETH
// - SOL
// - XRP
//
// Endpoints:
// /
// /health
// /market
// /candles?coin=BTC&interval=1m&limit=60
// /book?coin=BTC
// /debug-hyperliquid
//
// NO WALLET
// NO PRIVATE KEY
// NO TRADING
// ============================================================

const VERSION = "V1.0 HYPERLIQUID READ ONLY";

const HYPERLIQUID_INFO =
  "https://api.hyperliquid.xyz/info";

const TRACKED_COINS = [
  "BTC",
  "ETH",
  "SOL",
  "XRP",
] as const;

const ALLOWED_INTERVALS = [
  "1m",
  "3m",
  "5m",
  "15m",
  "30m",
  "1h",
] as const;


// ============================================================
// TYPES
// ============================================================

type JsonObject = Record<string, any>;


// ============================================================
// JSON RESPONSE
// ============================================================

function json(
  data: any,
  status = 200
): Response {

  return new Response(
    JSON.stringify(data, null, 2),
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
// HYPERLIQUID POST
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
          JSON.stringify(payload),
      }
    );

  const text =
    await response.text();

  let data: any = null;

  try {

    data =
      JSON.parse(text);

  } catch {

    throw new Error(
      `HYPERLIQUID_INVALID_JSON: ${text.slice(0, 500)}`
    );
  }

  if (!response.ok) {

    throw new Error(
      `HYPERLIQUID_HTTP_${response.status}: ${text.slice(0, 500)}`
    );
  }

  return data;
}


// ============================================================
// NUMBER
// ============================================================

function numberOrNull(
  value: any
): number | null {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


// ============================================================
// CHECK COIN
// ============================================================

function validCoin(
  coin: string
): boolean {

  return (
    TRACKED_COINS as readonly string[]
  ).includes(
    coin.toUpperCase()
  );
}


// ============================================================
// ALL MIDS
// ============================================================

async function getAllMids() {

  return hyperliquid({
    type: "allMids",
  });
}


// ============================================================
// META + ASSET CONTEXT
// ============================================================

async function getMetaAndContexts() {

  return hyperliquid({
    type: "metaAndAssetCtxs",
  });
}


// ============================================================
// MARKET
// ============================================================

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
    Array.isArray(metaCtx)
      ? metaCtx[0]
      : null;

  const contexts =
    Array.isArray(metaCtx)
      ? metaCtx[1]
      : null;


  const universe =
    Array.isArray(meta?.universe)
      ? meta.universe
      : [];


  const rows =
    TRACKED_COINS.map(
      (coin) => {

        const index =
          universe.findIndex(
            (x: any) =>
              String(
                x?.name ?? ""
              ).toUpperCase() ===
              coin
          );


        const ctx =
          index >= 0 &&
          Array.isArray(contexts)
            ? contexts[index]
            : null;


        return {

          coin,

          found:
            index >= 0,

          mid:
            numberOrNull(
              mids?.[coin]
            ),

          mark_price:
            numberOrNull(
              ctx?.markPx
            ),

          oracle_price:
            numberOrNull(
              ctx?.oraclePx
            ),

          funding:
            numberOrNull(
              ctx?.funding
            ),

          open_interest:
            numberOrNull(
              ctx?.openInterest
            ),

          day_volume:
            numberOrNull(
              ctx?.dayNtlVlm
            ),

          previous_day_price:
            numberOrNull(
              ctx?.prevDayPx
            ),

          premium:
            numberOrNull(
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
      new Date().toISOString(),

    coins:
      rows,
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

  const now =
    Date.now();


  const intervalMs:
    Record<string, number> = {

      "1m": 60_000,
      "3m": 180_000,
      "5m": 300_000,
      "15m": 900_000,
      "30m": 1_800_000,
      "1h": 3_600_000,
    };


  const step =
    intervalMs[interval];


  const startTime =
    now -
    step *
    Math.max(
      1,
      limit + 2
    );


  const candles =
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


  const normalized =
    Array.isArray(candles)
      ? candles
          .slice(-limit)
          .map(
            (c: any) => ({

              coin:
                c?.s ?? coin,

              interval:
                c?.i ?? interval,

              open_time:
                c?.t ?? null,

              close_time:
                c?.T ?? null,

              open:
                numberOrNull(c?.o),

              high:
                numberOrNull(c?.h),

              low:
                numberOrNull(c?.l),

              close:
                numberOrNull(c?.c),

              volume:
                numberOrNull(c?.v),

              trades:
                numberOrNull(c?.n),
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
      normalized.length,

    timestamp:
      now,

    candles:
      normalized,
  };
}


// ============================================================
// ORDER BOOK
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
          numberOrNull(x?.px),

        size:
          numberOrNull(x?.sz),

        orders:
          numberOrNull(x?.n),
      })
    );


  const normalizedAsks =
    asks.map(
      (x: any) => ({

        price:
          numberOrNull(x?.px),

        size:
          numberOrNull(x?.sz),

        orders:
          numberOrNull(x?.n),
      })
    );


  const bestBid =
    normalizedBids[0]
      ?.price ?? null;


  const bestAsk =
    normalizedAsks[0]
      ?.price ?? null;


  const spread =
    bestBid !== null &&
    bestAsk !== null
      ? bestAsk - bestBid
      : null;


  const mid =
    bestBid !== null &&
    bestAsk !== null
      ? (
          bestBid +
          bestAsk
        ) / 2
      : null;


  const spreadPct =
    spread !== null &&
    mid !== null &&
    mid !== 0
      ? (
          spread /
          mid
        ) * 100
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

    spread,

    spread_pct:
      spreadPct,

    bids:
      normalizedBids,

    asks:
      normalizedAsks,
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
        Array.isArray(meta),

      meta_parts:
        Array.isArray(meta)
          ? meta.length
          : 0,
    };

  } catch (error: any) {

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
// MAIN WORKER
// ============================================================

export default {

  async fetch(
    request: Request
  ): Promise<Response> {

    const url =
      new URL(
        request.url
      );


    // --------------------------------------------------------
    // OPTIONS
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // ONLY GET
    // --------------------------------------------------------

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


    // --------------------------------------------------------
    // /
    // --------------------------------------------------------

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

        endpoints: {

          health:
            "/health",

          market:
            "/market",

          candles:
            "/candles?coin=BTC&interval=1m&limit=60",

          book:
            "/book?coin=BTC",

          debug:
            "/debug-hyperliquid",
        },
      });
    }


    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

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

        timestamp:
          Date.now(),
      });
    }


    // --------------------------------------------------------
    // MARKET
    // --------------------------------------------------------

    if (
      url.pathname ===
      "/market"
    ) {

      try {

        const data =
          await getMarket();

        return json({

          success:
            true,

          ...data,
        });

      } catch (error: any) {

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


    // --------------------------------------------------------
    // CANDLES
    // --------------------------------------------------------

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
        !validCoin(coin)
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
        !Number.isFinite(limit)
      ) {

        limit =
          60;
      }


      limit =
        Math.max(
          1,
          Math.min(
            500,
            Math.floor(limit)
          )
        );


      try {

        const data =
          await getCandles(
            coin,
            interval,
            limit
          );


        return json({

          success:
            true,

          ...data,
        });

      } catch (error: any) {

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


    // --------------------------------------------------------
    // ORDER BOOK
    // --------------------------------------------------------

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
        !validCoin(coin)
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

        const data =
          await getBook(
            coin
          );


        return json({

          success:
            true,

          ...data,
        });

      } catch (error: any) {

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


    // --------------------------------------------------------
    // DEBUG
    // --------------------------------------------------------

    if (
      url.pathname ===
      "/debug-hyperliquid"
    ) {

      const data =
        await debugHyperliquid();


      return json({

        worker:
          "cryptobot",

        version:
          VERSION,

        mode:
          "READ_ONLY",

        ...data,
      });
    }


    // --------------------------------------------------------
    // 404
    // --------------------------------------------------------

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
