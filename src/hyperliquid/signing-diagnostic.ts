// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V7 — READ-ONLY ORDER PREFLIGHT
//
// SAFE:
// - Reads MAINNET perp meta + asset contexts from /info.
// - Finds BTC dynamically (no hardcoded asset index assumption).
// - Reads BTC szDecimals + current mark/mid price.
// - Builds a small valid-size diagnostic GTC order locally.
// - Signs it locally and verifies the API-wallet signer.
// - NEVER calls /exchange.
// - NEVER places an order or moves funds.
// ============================================================

import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const INFO_URL = "https://api.hyperliquid.xyz/info";
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
  return a?.length >= 12 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a;
}

// Mirrors SDK float_to_wire behavior for positive diagnostic values.
function toWire(x: number, maxDecimals = 8): string {
  if (!Number.isFinite(x) || x <= 0) throw new Error("INVALID_POSITIVE_NUMBER");
  let s = x.toFixed(maxDecimals);
  s = s.replace(/\.?0+$/, "");
  return s || "0";
}

// Perp prices: SDK rounds to 5 significant figures and at most
// (6 - szDecimals) decimal places.
function roundPerpPrice(px: number, szDecimals: number): number {
  if (!Number.isFinite(px) || px <= 0) throw new Error("INVALID_PRICE");
  const significant = Number(px.toPrecision(5));
  const decimals = Math.max(0, 6 - szDecimals);
  return Number(significant.toFixed(decimals));
}

function ceilToSizeDecimals(size: number, szDecimals: number): number {
  const scale = 10 ** szDecimals;
  return Math.ceil(size * scale - 1e-12) / scale;
}

async function postInfo(body: Record<string, any>): Promise<any> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`INFO_HTTP_${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("INFO_INVALID_JSON");
  }
}

export async function getHyperliquidSigningDiagnostic(
  env: HyperliquidSigningEnv
): Promise<Record<string, any>> {
  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);
  if (!privateKeyFormatOk(secret)) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V7 READ-ONLY ORDER PREFLIGHT",
      success: false,
      error: "PRIVATE_KEY_MISSING_OR_INVALID_FORMAT",
      trading: "REAL_TRADING_DISABLED",
      timestamp: new Date().toISOString(),
    };
  }

  const account = privateKeyToAccount(secret);
  const derived = account.address.toLowerCase();
  const expected = EXPECTED_API_WALLET.toLowerCase();

  if (derived !== expected) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V7 READ-ONLY ORDER PREFLIGHT",
      success: false,
      error: "API_WALLET_IDENTITY_MISMATCH",
      derived_api_wallet_masked: maskAddress(derived),
      trading: "REAL_TRADING_DISABLED",
      timestamp: new Date().toISOString(),
    };
  }

  // Official /info request: metaAndAssetCtxs.
  const raw = await postInfo({ type: "metaAndAssetCtxs" });

  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error("UNEXPECTED_META_AND_ASSET_CTXS_SHAPE");
  }

  const meta = raw[0];
  const contexts = raw[1];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];

  const asset = universe.findIndex((x: any) => x?.name === "BTC");
  if (asset < 0) throw new Error("BTC_NOT_FOUND_IN_PERP_META");

  const btcMeta = universe[asset];
  const btcCtx = Array.isArray(contexts) ? contexts[asset] : null;
  if (!btcCtx) throw new Error("BTC_ASSET_CONTEXT_NOT_FOUND");

  const szDecimals = Number(btcMeta?.szDecimals);
  const markPx = Number(btcCtx?.markPx);
  const midPx =
    btcCtx?.midPx !== null && btcCtx?.midPx !== undefined
      ? Number(btcCtx.midPx)
      : null;

  const referencePx =
    midPx !== null && Number.isFinite(midPx) && midPx > 0
      ? midPx
      : markPx;

  if (!Number.isInteger(szDecimals) || szDecimals < 0)
    throw new Error("INVALID_BTC_SZ_DECIMALS");
  if (!Number.isFinite(referencePx) || referencePx <= 0)
    throw new Error("INVALID_BTC_REFERENCE_PRICE");

  // Conservative diagnostic notional target.
  // This is NOT claimed to be an exchange-wide minimum.
  // It simply gives us a small, precision-valid candidate for later testing.
  const targetNotionalUsd = 10;
  const sizeRaw = targetNotionalUsd / referencePx;
  const size = ceilToSizeDecimals(sizeRaw, szDecimals);

  // Resting BUY candidate ~5% below current reference price.
  // Still LOCAL ONLY in V7.
  const rawLimitPx = referencePx * 0.95;
  const limitPx = roundPerpPrice(rawLimitPx, szDecimals);

  const sizeWire = toWire(size, Math.min(8, szDecimals));
  const priceWire = toWire(limitPx, 8);
  const estimatedNotional = size * limitPx;

  const orderWire = {
    a: asset,
    b: true,
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

  const signature = await account.signTypedData({
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
      signature,
    })
  ).toLowerCase();

  const signerValid = recovered === expected;

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V7 READ-ONLY ORDER PREFLIGHT",
    mode: "LIVE_META_READ_LOCAL_ORDER_BUILD_ONLY",
    network: "MAINNET",

    master_account: MASTER_ACCOUNT,
    expected_api_wallet: EXPECTED_API_WALLET,

    live_market_data: {
      info_endpoint_called: true,
      exchange_endpoint_called: false,
      source: "metaAndAssetCtxs",
      coin: "BTC",
      asset,
      sz_decimals: szDecimals,
      mark_px: btcCtx?.markPx ?? null,
      mid_px: btcCtx?.midPx ?? null,
      oracle_px: btcCtx?.oraclePx ?? null,
      reference_price: referencePx,
    },

    preflight_order: {
      market: "BTC-PERP",
      side: "BUY_LONG",
      order_type: "LIMIT_GTC",
      target_notional_usd: targetNotionalUsd,
      note:
        "target_notional_usd is a conservative diagnostic target, not a claimed exchange minimum",
      limit_price: priceWire,
      size: sizeWire,
      estimated_notional_usd: Number(estimatedNotional.toFixed(6)),
      reduce_only: false,
      asset,
      order_wire: orderWire,
      action,
    },

    signing: {
      nonce,
      action_hash: actionHash,
      signature_created: true,
      signature_returned_in_full: false,
      derived_api_wallet_masked: maskAddress(derived),
      recovered_signer_masked: maskAddress(recovered),
      local_signature_valid: signerValid,
    },

    validation: {
      live_meta_loaded: true,
      btc_found_dynamically: true,
      size_precision_applied: true,
      price_precision_applied: true,
      order_wire_built: true,
      order_action_built: true,
      local_signature_valid: signerValid,
      ready_for_controlled_order_test: signerValid,
    },

    hyperliquid_exchange: {
      endpoint_called: false,
      request_sent: false,
      reason:
        "V7 reads /info only. The signed order action is intentionally not transmitted to /exchange.",
    },

    orders: {
      constructed_locally: true,
      sent: false,
      placed: false,
      filled: false,
      cancelled: false,
    },

    safety: {
      private_key_exposed_in_response: false,
      private_key_logged: false,
      full_signature_exposed: false,
      exchange_request_sent: false,
      funds_can_move: false,
      real_trading_enabled: false,
      trading: "REAL_TRADING_DISABLED",
    },

    timestamp: new Date().toISOString(),
  };
}
