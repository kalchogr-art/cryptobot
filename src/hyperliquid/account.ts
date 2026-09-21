// ============================================================
// HYPERLIQUID ACCOUNT V1 — READ ONLY
// Public account state only. NO private key, NO signing, NO orders.
// ============================================================

const HYPERLIQUID_INFO = "https://api.hyperliquid.xyz/info";
const DEFAULT_ACCOUNT_ADDRESS = "0xf1CF243f05024AE78aE2dFa31c2Bec1e1F6c9196";

type AnyObj = Record<string, any>;

export type HyperliquidAccountEnv = {
  // Optional override. This is a PUBLIC wallet address, not a secret.
  HYPERLIQUID_ACCOUNT_ADDRESS?: string;
};

function finiteNumber(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function infoRequest(body: AnyObj): Promise<any> {
  const response = await fetch(HYPERLIQUID_INFO, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  let data: any = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(
      `HYPERLIQUID_INFO_HTTP_${response.status}: ${
        typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)
      }`
    );
  }

  return data;
}

function normalizePositions(state: AnyObj): AnyObj[] {
  const positions = Array.isArray(state?.assetPositions)
    ? state.assetPositions
    : [];

  return positions.map((item: AnyObj) => {
    const p = item?.position ?? item ?? {};

    return {
      coin: p?.coin ?? null,
      side:
        Number(p?.szi) > 0
          ? "LONG"
          : Number(p?.szi) < 0
            ? "SHORT"
            : "FLAT",
      size: finiteNumber(p?.szi),
      entry_price: finiteNumber(p?.entryPx),
      position_value: finiteNumber(p?.positionValue),
      unrealized_pnl: finiteNumber(p?.unrealizedPnl),
      return_on_equity: finiteNumber(p?.returnOnEquity),
      leverage: p?.leverage ?? null,
      liquidation_price: finiteNumber(p?.liquidationPx),
      margin_used: finiteNumber(p?.marginUsed),
      max_leverage: finiteNumber(p?.maxLeverage),
      raw: p,
    };
  });
}

function normalizeOrders(orders: any): AnyObj[] {
  if (!Array.isArray(orders)) return [];

  return orders.map((o: AnyObj) => ({
    coin: o?.coin ?? null,
    side: o?.side ?? null,
    price: finiteNumber(o?.limitPx ?? o?.px),
    size: finiteNumber(o?.sz),
    order_id: o?.oid ?? null,
    timestamp: o?.timestamp ?? null,
    original_size: finiteNumber(o?.origSz),
    reduce_only: o?.reduceOnly ?? null,
    raw: o,
  }));
}

export async function getHyperliquidAccountReadOnly(
  env: HyperliquidAccountEnv
): Promise<AnyObj> {
  const address =
    String(env?.HYPERLIQUID_ACCOUNT_ADDRESS || DEFAULT_ACCOUNT_ADDRESS).trim();

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error("INVALID_HYPERLIQUID_ACCOUNT_ADDRESS");
  }

  // Both calls are public /info reads. No wallet signature is used.
  const [state, openOrders] = await Promise.all([
    infoRequest({
      type: "clearinghouseState",
      user: address,
    }),
    infoRequest({
      type: "openOrders",
      user: address,
    }),
  ]);

  const margin = state?.marginSummary ?? {};
  const crossMargin = state?.crossMarginSummary ?? {};

  return {
    module: "hyperliquid-account",
    mode: "READ_ONLY",
    network: "MAINNET",
    connected: true,
    address,

    account: {
      account_value: finiteNumber(margin?.accountValue),
      total_notional_position: finiteNumber(margin?.totalNtlPos),
      total_raw_usd: finiteNumber(margin?.totalRawUsd),
      total_margin_used: finiteNumber(margin?.totalMarginUsed),
      withdrawable: finiteNumber(state?.withdrawable),

      cross_margin: {
        account_value: finiteNumber(crossMargin?.accountValue),
        total_notional_position: finiteNumber(crossMargin?.totalNtlPos),
        total_raw_usd: finiteNumber(crossMargin?.totalRawUsd),
        total_margin_used: finiteNumber(crossMargin?.totalMarginUsed),
      },
    },

    positions: normalizePositions(state),
    open_orders: normalizeOrders(openOrders),

    summary: {
      positions: Array.isArray(state?.assetPositions)
        ? state.assetPositions.length
        : 0,
      open_orders: Array.isArray(openOrders) ? openOrders.length : 0,
    },

    safety: {
      private_key_present: false,
      signing_enabled: false,
      exchange_endpoint_used: false,
      order_submission_enabled: false,
      trading: "REAL_TRADING_DISABLED",
    },

    timestamp: new Date().toISOString(),
  };
}
