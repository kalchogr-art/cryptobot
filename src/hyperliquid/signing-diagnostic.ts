// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V10 — REAL BTC LIMIT ENTRY
//
// REAL TEST:
// BTC LONG, LIMIT 80000, Cross leverage already set separately.
// Builds size from ORDER_USD and exchange szDecimals.
// Sends the real GTC order and leaves it open if accepted.
//
// NO auto-cancel.
// NO leverage update.
// NO TP/SL yet.
// ============================================================

import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ============================================================
// EASY CONFIG
// ============================================================
const CONFIG = {
  LIVE_TRADING: true,

  COIN: "BTC",
  SIDE: "LONG" as "LONG" | "SHORT",

  ORDER_PRICE: 80000,
  ORDER_USD: 10.40,

  // Expected account setup; V10 verifies but does not change it.
  LEVERAGE: 10,
  IS_CROSS: true,

  // Saved for next stage only.
  TAKE_PROFIT_PCT: 0.50,
  STOP_LOSS_PCT: 0.25,
};

const INFO_URL = "https://api.hyperliquid.xyz/info";
const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";

const EXPECTED_API_WALLET =
  "0xe9a5a9fed6a1a6c856b27477c761b135097d50ae";
const MASTER_ACCOUNT =
  "0xf1CF243f05024AE78aE2dFa31c2Bec1e1F6c9196";

export type HyperliquidSigningEnv = {
  HYPERLIQUID_API_PRIVATE_KEY?: string;
};

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
function maskAddress(a: string): string {
  return a?.length >= 12 ? `${a.slice(0,8)}...${a.slice(-6)}` : a;
}
function toWire(x: number, decimals = 8): string {
  if (!Number.isFinite(x) || x <= 0) throw new Error("INVALID_WIRE_NUMBER");
  return x.toFixed(decimals).replace(/\.?0+$/, "");
}
function ceilSize(size: number, szDecimals: number): number {
  const scale = 10 ** szDecimals;
  return Math.ceil(size * scale - 1e-12) / scale;
}
function signatureToRsv(signature: `0x${string}`) {
  const h = signature.slice(2);
  if (h.length !== 130) throw new Error("UNEXPECTED_SIGNATURE_LENGTH");
  const r = `0x${h.slice(0,64)}`;
  const s = `0x${h.slice(64,128)}`;
  const rawV = parseInt(h.slice(128,130), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  return { r, s, v };
}
async function postInfo(body: Record<string, any>): Promise<any> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`INFO_HTTP_${res.status}: ${text.slice(0,500)}`);
  return JSON.parse(text);
}

export async function getHyperliquidSigningDiagnostic(
  env: HyperliquidSigningEnv
): Promise<Record<string, any>> {
  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);

  if (!privateKeyFormatOk(secret)) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V10 REAL BTC LIMIT ENTRY",
      success: false,
      error: "PRIVATE_KEY_MISSING_OR_INVALID_FORMAT",
      timestamp: new Date().toISOString(),
    };
  }

  const account = privateKeyToAccount(secret);
  const derived = account.address.toLowerCase();
  const expected = EXPECTED_API_WALLET.toLowerCase();

  if (derived !== expected) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V10 REAL BTC LIMIT ENTRY",
      success: false,
      error: "API_WALLET_IDENTITY_MISMATCH",
      timestamp: new Date().toISOString(),
    };
  }

  // Live meta / price.
  const raw = await postInfo({ type: "metaAndAssetCtxs" });
  if (!Array.isArray(raw) || raw.length < 2)
    throw new Error("UNEXPECTED_META_AND_ASSET_CTXS_SHAPE");

  const meta = raw[0];
  const contexts = raw[1];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];
  const asset = universe.findIndex((x: any) => x?.name === CONFIG.COIN);
  if (asset < 0) throw new Error(`${CONFIG.COIN}_NOT_FOUND`);

  const assetMeta = universe[asset];
  const ctx = contexts?.[asset] ?? null;
  const szDecimals = Number(assetMeta?.szDecimals);

  if (!Number.isInteger(szDecimals) || szDecimals < 0)
    throw new Error("INVALID_SZ_DECIMALS");

  // Verify leverage state before sending order.
  const activeBefore = await postInfo({
    type: "activeAssetData",
    user: MASTER_ACCOUNT,
    coin: CONFIG.COIN,
  });

  const currentLeverage = Number(activeBefore?.leverage?.value);
  const currentLeverageType = activeBefore?.leverage?.type ?? null;
  const expectedType = CONFIG.IS_CROSS ? "cross" : "isolated";

  const leverageOk =
    currentLeverage === CONFIG.LEVERAGE &&
    currentLeverageType === expectedType;

  if (!leverageOk) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V10 REAL BTC LIMIT ENTRY",
      success: false,
      error: "LEVERAGE_PREFLIGHT_FAILED",
      expected: {
        leverage: CONFIG.LEVERAGE,
        type: expectedType,
      },
      actual: {
        leverage: currentLeverage,
        type: currentLeverageType,
      },
      exchange_request_sent: false,
      timestamp: new Date().toISOString(),
    };
  }

  const price = CONFIG.ORDER_PRICE;
  const rawSize = CONFIG.ORDER_USD / price;

  // Round UP so the precision step does not drop us below $10.
  const size = ceilSize(rawSize, szDecimals);
  const priceWire = toWire(price, 8);
  const sizeWire = toWire(size, szDecimals);
  const actualNotional = price * size;

  if (actualNotional < 10) {
    throw new Error("CALCULATED_NOTIONAL_BELOW_10");
  }

  const orderWire = {
    a: asset,
    b: CONFIG.SIDE === "LONG",
    p: priceWire,
    s: sizeWire,
    r: false,
    t: { limit: { tif: "Gtc" } },
  };

  const action = {
    type: "order",
    orders: [orderWire],
    grouping: "na",
  };

  const nonce = Date.now();
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
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V10 REAL BTC LIMIT ENTRY",
      success: false,
      error: "LOCAL_SIGNATURE_RECOVERY_MISMATCH",
      exchange_request_sent: false,
      timestamp: new Date().toISOString(),
    };
  }

  const preview = {
    coin: CONFIG.COIN,
    side: CONFIG.SIDE,
    asset,
    sz_decimals: szDecimals,
    leverage: currentLeverage,
    leverage_type: currentLeverageType,
    requested_order_usd: CONFIG.ORDER_USD,
    limit_price: priceWire,
    submitted_size: sizeWire,
    actual_notional_usd: Number(actualNotional.toFixed(8)),
    mark_px: ctx?.markPx ?? null,
    mid_px: ctx?.midPx ?? null,
    available_to_trade: activeBefore?.availableToTrade ?? null,
    tif: "Gtc",
  };

  if (!CONFIG.LIVE_TRADING) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V10 REAL BTC LIMIT ENTRY",
      mode: "DRY_RUN",
      success: true,
      config: CONFIG,
      preview,
      hyperliquid_exchange: {
        endpoint_called: false,
        request_sent: false,
      },
      timestamp: new Date().toISOString(),
    };
  }

  const signature = signatureToRsv(serializedSignature);

  let httpStatus: number | null = null;
  let responseText = "";
  let responseJson: any = null;
  let fetchError: string | null = null;

  try {
    const res = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature,
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
  const resting = firstStatus?.resting ?? null;
  const filled = firstStatus?.filled ?? null;
  const error = firstStatus?.error ?? null;
  const oid = resting?.oid ?? filled?.oid ?? null;

  // Read open orders after the exchange response.
  let openOrders: any = null;
  let openOrdersError: string | null = null;

  try {
    openOrders = await postInfo({
      type: "openOrders",
      user: MASTER_ACCOUNT,
    });
  } catch (e: any) {
    openOrdersError = e?.message ?? String(e);
  }

  const matchingOpenOrders = Array.isArray(openOrders)
    ? openOrders.filter((o: any) =>
        o?.coin === CONFIG.COIN &&
        String(o?.limitPx ?? "") === priceWire
      )
    : [];

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V10 REAL BTC LIMIT ENTRY",
    mode: "LIVE_REAL_LIMIT_ORDER",
    network: "MAINNET",

    config: CONFIG,
    master_account: MASTER_ACCOUNT,
    expected_api_wallet: EXPECTED_API_WALLET,

    preview,

    signing: {
      nonce,
      action_hash: actionHash,
      signature_created: true,
      signer_verified_locally: true,
      recovered_signer_masked: maskAddress(recovered),
    },

    hyperliquid_exchange: {
      endpoint_called: true,
      request_sent: true,
      http_status: httpStatus,
      response_json: responseJson,
      response_text:
        responseJson === null ? responseText.slice(0,1500) : null,
      fetch_error: fetchError,
      returned_statuses: statuses,
    },

    order_result: {
      resting: resting !== null,
      filled: filled !== null,
      error,
      oid,
      auto_cancel: false,
    },

    open_orders_verification: {
      checked: true,
      error: openOrdersError,
      matching_count: matchingOpenOrders.length,
      matching_orders: matchingOpenOrders,
    },

    tp_sl: {
      sent: false,
      take_profit_pct: CONFIG.TAKE_PROFIT_PCT,
      stop_loss_pct: CONFIG.STOP_LOSS_PCT,
      note: "TP/SL intentionally deferred until entry-order path is confirmed.",
    },

    safety: {
      private_key_exposed_in_response: false,
      full_signature_exposed: false,
      leverage_changed_in_v10: false,
      auto_cancel: false,
      live_trading_switch: CONFIG.LIVE_TRADING,
    },

    timestamp: new Date().toISOString(),
  };
}
