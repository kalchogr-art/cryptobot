import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ============================================================
// HYPERLIQUID SIGNAL EXECUTION V2
// SIGNAL -> DRY RUN BRACKET BUILDER
//
// COMPLETE EXECUTION PATH:
// - LIVE_TRADING is FALSE by default.
// - When FALSE: builds the exact live action but never signs/sends it.
// - When TRUE: signs the same canonical normalTpsl action and sends /exchange.
// - Triggered only by a NEW >=65 crossing supplied by index.ts.
// - One grouped request: ENTRY + TP + SL.
// - Uses the proven V11.1 Hyperliquid L1 signing path.
// ============================================================

const INFO_URL = "https://api.hyperliquid.xyz/info";
const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";

const EXPECTED_API_WALLET =
  "0xe9a5a9fed6a1a6c856b27477c761b135097d50ae";
const MASTER_ACCOUNT =
  "0xf1CF243f05024AE78aE2dFa31c2Bec1e1F6c9196";

const CONFIG = {
  LIVE_TRADING: false,

  MIN_SIGNAL_SCORE: 65,

  MARGIN_USD: 1.04,
  LEVERAGE: 10,
  IS_CROSS: true,

  LONG_TAKE_PROFIT_PCT: 0.50,
  LONG_STOP_LOSS_PCT: 0.15,
  SHORT_TAKE_PROFIT_PCT: 0.50,
  SHORT_STOP_LOSS_PCT: 0.40,

  TIF: "Gtc" as const,
};

export type HyperliquidExecutionEnv = {
  HYPERLIQUID_API_PRIVATE_KEY?: string;
};

export type HyperliquidExecutionSignal = {
  coin: string;
  side: "LONG" | "SHORT";
  score: number;
  price: number;
  crossing_id?: number | string | null;
  episode_id?: number | string | null;
};

function roundTo(value: number, decimals: number): number {
  const p = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * p) / p;
}

function toWire(value: number, decimals = 8): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("INVALID_WIRE_NUMBER");
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

function bestValidSize(
  targetSize: number,
  price: number,
  szDecimals: number
): number {
  const scale = 10 ** szDecimals;
  const minSize = Math.ceil((10 / price) * scale - 1e-12) / scale;

  const floorSize = Math.floor(targetSize * scale + 1e-12) / scale;
  const ceilSize = Math.ceil(targetSize * scale - 1e-12) / scale;

  const candidates = [floorSize, ceilSize, minSize]
    .filter((v, i, a) => v > 0 && v * price >= 10 && a.indexOf(v) === i);

  if (!candidates.length) return minSize;

  return candidates.reduce((best, current) =>
    Math.abs(current * price - CONFIG.MARGIN_USD * CONFIG.LEVERAGE) <
    Math.abs(best * price - CONFIG.MARGIN_USD * CONFIG.LEVERAGE)
      ? current
      : best
  );
}

// Hyperliquid prices: max 5 significant figures and max (6 - szDecimals)
// decimal places for perp prices.
function priceToWire(price: number, szDecimals: number): string {
  if (!Number.isFinite(price) || price <= 0) throw new Error("INVALID_PRICE");

  const maxDecimals = Math.max(0, 6 - szDecimals);
  const magnitude = Math.floor(Math.log10(Math.abs(price)));
  const sigDecimals = Math.max(0, 5 - magnitude - 1);
  const decimals = Math.min(maxDecimals, sigDecimals);

  return toWire(roundTo(price, decimals), decimals);
}

function normalizePrivateKey(v: unknown): string {
  return String(v ?? "").trim();
}

function privateKeyFormatOk(v: string): v is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(v);
}

function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = value;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function signatureToRsv(signature: `0x${string}`) {
  const h = signature.slice(2);
  if (h.length !== 130) throw new Error("UNEXPECTED_SIGNATURE_LENGTH");
  const r = `0x${h.slice(0, 64)}`;
  const s = `0x${h.slice(64, 128)}`;
  const rawV = parseInt(h.slice(128, 130), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  return { r, s, v };
}

async function signHyperliquidAction(
  action: Record<string, any>,
  nonce: number,
  secret: `0x${string}`
) {
  const account = privateKeyToAccount(secret);
  const expected = EXPECTED_API_WALLET.toLowerCase();

  if (account.address.toLowerCase() !== expected) {
    throw new Error("API_WALLET_PRIVATE_KEY_DOES_NOT_MATCH_EXPECTED_ADDRESS");
  }

  const packed = encode(action);
  const hashInput = concat([
    bytesToHex(packed),
    bytesToHex(u64be(BigInt(nonce))),
    "0x00",
  ]);
  const actionHash = keccak256(hashInput);

  const domain = {
    chainId: 1337,
    name: "Exchange",
    verifyingContract:
      "0x0000000000000000000000000000000000000000" as const,
    version: "1",
  } as const;

  const types = {
    Agent: [
      { name: "source", type: "string" },
      { name: "connectionId", type: "bytes32" },
    ],
  } as const;

  const message = {
    source: "a",
    connectionId: actionHash,
  } as const;

  const serializedSignature = await account.signTypedData({
    domain,
    types,
    primaryType: "Agent",
    message,
  });

  const recovered = (
    await recoverTypedDataAddress({
      domain,
      types,
      primaryType: "Agent",
      message,
      signature: serializedSignature,
    })
  ).toLowerCase();

  if (recovered !== expected) {
    throw new Error("LOCAL_SIGNATURE_RECOVERY_MISMATCH");
  }

  return {
    actionHash,
    signature: signatureToRsv(serializedSignature),
  };
}

async function postInfo(body: Record<string, any>): Promise<any> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`INFO_HTTP_${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function buildHyperliquidExecutionCandidate(
  signal: HyperliquidExecutionSignal,
  env?: HyperliquidExecutionEnv
): Promise<Record<string, any>> {
  const coin = String(signal?.coin ?? "").toUpperCase();
  const side = signal?.side;
  const score = Number(signal?.score);
  const entryPrice = Number(signal?.price);

  if (!coin || (side !== "LONG" && side !== "SHORT")) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "INVALID_SIGNAL",
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  if (!Number.isFinite(score) || score < CONFIG.MIN_SIGNAL_SCORE) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "BELOW_MIN_SIGNAL_SCORE",
      score,
      required: CONFIG.MIN_SIGNAL_SCORE,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "INVALID_ENTRY_PRICE",
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const raw = await postInfo({ type: "metaAndAssetCtxs" });
  if (!Array.isArray(raw) || raw.length < 2) throw new Error("UNEXPECTED_META_SHAPE");

  const universe = Array.isArray(raw?.[0]?.universe) ? raw[0].universe : [];
  const contexts = Array.isArray(raw?.[1]) ? raw[1] : [];

  const asset = universe.findIndex((x: any) => x?.name === coin);
  if (asset < 0) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "COIN_NOT_FOUND_ON_HYPERLIQUID",
      coin,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const szDecimals = Number(universe[asset]?.szDecimals);
  if (!Number.isInteger(szDecimals) || szDecimals < 0) {
    throw new Error("INVALID_SZ_DECIMALS");
  }

  const positionUsdTarget = CONFIG.MARGIN_USD * CONFIG.LEVERAGE;
  const entryWire = priceToWire(entryPrice, szDecimals);
  const normalizedEntry = Number(entryWire);

  // Choose the closest exchange-valid size to the target notional,
  // while never allowing the position below Hyperliquid's $10 minimum.
  const size = bestValidSize(
    positionUsdTarget / normalizedEntry,
    normalizedEntry,
    szDecimals
  );
  const sizeWire = toWire(size, szDecimals);
  const actualNotionalUsd = normalizedEntry * size;

  if (actualNotionalUsd < 10) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "CALCULATED_NOTIONAL_BELOW_10",
      actual_notional_usd: actualNotionalUsd,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const isLong = side === "LONG";
  const takeProfitPct = isLong
    ? CONFIG.LONG_TAKE_PROFIT_PCT
    : CONFIG.SHORT_TAKE_PROFIT_PCT;
  const stopLossPct = isLong
    ? CONFIG.LONG_STOP_LOSS_PCT
    : CONFIG.SHORT_STOP_LOSS_PCT;

  const tpRaw = isLong
    ? normalizedEntry * (1 + takeProfitPct / 100)
    : normalizedEntry * (1 - takeProfitPct / 100);
  const slRaw = isLong
    ? normalizedEntry * (1 - stopLossPct / 100)
    : normalizedEntry * (1 + stopLossPct / 100);

  const tpWire = priceToWire(tpRaw, szDecimals);
  const slWire = priceToWire(slRaw, szDecimals);

  const entryOrder = {
    a: asset,
    b: isLong,
    p: entryWire,
    s: sizeWire,
    r: false,
    t: { limit: { tif: CONFIG.TIF } },
  };

  const closeIsBuy = !isLong;

  // IMPORTANT: canonical trigger insertion order:
  // isMarket -> triggerPx -> tpsl
  const tpOrder = {
    a: asset,
    b: closeIsBuy,
    p: tpWire,
    s: sizeWire,
    r: true,
    t: {
      trigger: {
        isMarket: true,
        triggerPx: tpWire,
        tpsl: "tp",
      },
    },
  };

  const slOrder = {
    a: asset,
    b: closeIsBuy,
    p: slWire,
    s: sizeWire,
    r: true,
    t: {
      trigger: {
        isMarket: true,
        triggerPx: slWire,
        tpsl: "sl",
      },
    },
  };

  const action = {
    type: "order",
    orders: [entryOrder, tpOrder, slOrder],
    grouping: "normalTpsl",
  };

  const result: Record<string, any> = {
    eligible: true,
    status: CONFIG.LIVE_TRADING ? "LIVE_READY" : "DRY_RUN_READY",
    reason: "NEW_65_CROSSING",
    live_trading: CONFIG.LIVE_TRADING,
    exchange_request_sent: false,

    signal: {
      crossing_id: signal.crossing_id ?? null,
      episode_id: signal.episode_id ?? null,
      coin,
      side,
      score,
      signal_price: entryPrice,
    },

    execution: {
      asset,
      sz_decimals: szDecimals,
      margin_usd: CONFIG.MARGIN_USD,
      leverage: CONFIG.LEVERAGE,
      leverage_type: CONFIG.IS_CROSS ? "cross" : "isolated",
      position_usd_target: positionUsdTarget,
      entry_price: entryWire,
      size: sizeWire,
      actual_notional_usd: Number(actualNotionalUsd.toFixed(8)),
      take_profit_pct: takeProfitPct,
      take_profit_trigger: tpWire,
      stop_loss_pct: stopLossPct,
      stop_loss_trigger: slWire,
      grouping: "normalTpsl",
      trade_policy: "ONE_TRADE_PER_COIN_PER_EPISODE",
      mark_px: contexts?.[asset]?.markPx ?? null,
      mid_px: contexts?.[asset]?.midPx ?? null,
    },

    action_preview: action,

    safety: {
      live_trading: CONFIG.LIVE_TRADING,
      signing_performed: false,
      exchange_endpoint_called: false,
      private_key_exposed: false,
    },

    timestamp: new Date().toISOString(),
  };

  // Normal operating mode: full payload is built, but no secret is read,
  // no signature is created and /exchange is never called.
  if (!CONFIG.LIVE_TRADING) return result;

  // LIVE path — kept complete now so we do not have to reconstruct the
  // proven V11.1 signing/exchange implementation later.
  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);
  if (!privateKeyFormatOk(secret)) {
    return {
      ...result,
      status: "BLOCKED",
      reason: "HYPERLIQUID_API_PRIVATE_KEY_MISSING_OR_INVALID",
    };
  }

  const nonce = Date.now();
  const signed = await signHyperliquidAction(action, nonce, secret);

  let httpStatus: number | null = null;
  let responseJson: any = null;
  let responseText = "";
  let fetchError: string | null = null;

  try {
    const res = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: signed.signature,
        vaultAddress: null,
      }),
    });

    httpStatus = res.status;
    responseText = await res.text();

    try {
      responseJson = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseJson = null;
    }
  } catch (e: any) {
    fetchError = e?.message ?? String(e);
  }

  const statuses = responseJson?.response?.data?.statuses ?? null;
  const firstStatus = Array.isArray(statuses) ? statuses[0] : null;
  const firstError = firstStatus?.error ?? null;
  const restingOid = firstStatus?.resting?.oid ?? null;
  const filledOid = firstStatus?.filled?.oid ?? null;

  return {
    ...result,
    status:
      responseJson?.status === "ok" && !firstError
        ? "LIVE_SUBMITTED"
        : "LIVE_REJECTED",
    exchange_request_sent: true,

    signing: {
      nonce,
      action_hash: signed.actionHash,
      signer_verified_locally: true,
      expected_api_wallet: EXPECTED_API_WALLET,
      private_key_exposed: false,
      full_signature_exposed: false,
    },

    hyperliquid_exchange: {
      endpoint_called: true,
      request_sent: true,
      http_status: httpStatus,
      response_json: responseJson,
      response_text:
        responseJson === null ? responseText.slice(0, 1500) : null,
      fetch_error: fetchError,
      returned_statuses: statuses,
    },

    order_result: {
      resting: restingOid !== null,
      filled: filledOid !== null,
      oid: restingOid ?? filledOid,
      error: firstError,
    },

    safety: {
      live_trading: true,
      signing_performed: true,
      exchange_endpoint_called: true,
      private_key_exposed: false,
    },

    timestamp: new Date().toISOString(),
  };
}
