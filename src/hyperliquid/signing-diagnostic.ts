// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V8 — REAL $1 BTC LIMIT TEST
//
// WARNING: LIVE_TRADING=true sends ONE REAL order each time this endpoint runs.
// No auto-cancel. No leverage update yet. No TP/SL yet.
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
// EASY CONFIG — EDIT HERE
// ============================================================
const CONFIG = {
  LIVE_TRADING: true,

  COIN: "BTC",
  SIDE: "LONG" as "LONG" | "SHORT",

  ORDER_PRICE: 80000,
  ORDER_USD: 1.00,

  // Stored for the next stages. V8 does NOT send updateLeverage/TP/SL.
  LEVERAGE: 10,
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
  return a?.length >= 12 ? `${a.slice(0, 8)}...${a.slice(-6)}` : a;
}

function toWire(x: number, decimals = 8): string {
  if (!Number.isFinite(x) || x <= 0) throw new Error("INVALID_WIRE_NUMBER");
  return x.toFixed(decimals).replace(/\.?0+$/, "");
}

function roundPerpPrice(px: number, szDecimals: number): number {
  const significant = Number(px.toPrecision(5));
  const maxDecimals = Math.max(0, 6 - szDecimals);
  return Number(significant.toFixed(maxDecimals));
}

function roundSizeToNearest(size: number, szDecimals: number): number {
  const scale = 10 ** szDecimals;
  return Math.round(size * scale) / scale;
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

async function postInfo(body: Record<string, any>): Promise<any> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`INFO_HTTP_${res.status}: ${text.slice(0, 500)}`);
  }

  return JSON.parse(text);
}

export async function getHyperliquidSigningDiagnostic(
  env: HyperliquidSigningEnv
): Promise<Record<string, any>> {
  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);

  if (!privateKeyFormatOk(secret)) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V8 REAL $1 BTC LIMIT TEST",
      success: false,
      error: "PRIVATE_KEY_MISSING_OR_INVALID_FORMAT",
      trading: CONFIG.LIVE_TRADING ? "LIVE_TEST_ENABLED" : "REAL_TRADING_DISABLED",
      timestamp: new Date().toISOString(),
    };
  }

  const account = privateKeyToAccount(secret);
  const derived = account.address.toLowerCase();
  const expected = EXPECTED_API_WALLET.toLowerCase();

  if (derived !== expected) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V8 REAL $1 BTC LIMIT TEST",
      success: false,
      error: "API_WALLET_IDENTITY_MISMATCH",
      derived_api_wallet_masked: maskAddress(derived),
      timestamp: new Date().toISOString(),
    };
  }

  // Read live metadata only to obtain the current BTC asset index and szDecimals.
  const raw = await postInfo({ type: "metaAndAssetCtxs" });

  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error("UNEXPECTED_META_AND_ASSET_CTXS_SHAPE");
  }

  const meta = raw[0];
  const contexts = raw[1];
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];

  const asset = universe.findIndex((x: any) => x?.name === CONFIG.COIN);
  if (asset < 0) throw new Error(`${CONFIG.COIN}_NOT_FOUND`);

  const assetMeta = universe[asset];
  const ctx = Array.isArray(contexts) ? contexts[asset] : null;

  const szDecimals = Number(assetMeta?.szDecimals);
  if (!Number.isInteger(szDecimals) || szDecimals < 0) {
    throw new Error("INVALID_SZ_DECIMALS");
  }

  const price = roundPerpPrice(CONFIG.ORDER_PRICE, szDecimals);

  // User requested $1 notional.
  // BTC has discrete size precision, so the actual notional can differ from $1.
  const rawSize = CONFIG.ORDER_USD / price;
  const size = roundSizeToNearest(rawSize, szDecimals);

  if (size <= 0) {
    throw new Error(
      `ORDER_USD_TOO_SMALL_FOR_${CONFIG.COIN}_SIZE_PRECISION`
    );
  }

  const sizeWire = toWire(size, szDecimals);
  const priceWire = toWire(price, 8);
  const actualNotional = size * price;

  const isBuy = CONFIG.SIDE === "LONG";

  const orderWire = {
    a: asset,
    b: isBuy,
    p: priceWire,
    s: sizeWire,
    r: false,
    t: {
      limit: {
        tif: "Gtc",
      },
    },
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
    "0x00", // vaultAddress = null
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

  const signerValid = recovered === expected;

  if (!signerValid) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V8 REAL $1 BTC LIMIT TEST",
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
    requested_order_usd: CONFIG.ORDER_USD,
    limit_price: priceWire,
    raw_size: rawSize,
    submitted_size: sizeWire,
    actual_notional_usd: Number(actualNotional.toFixed(8)),
    tif: "Gtc",
    reduce_only: false,
    current_mark_px: ctx?.markPx ?? null,
    current_mid_px: ctx?.midPx ?? null,
  };

  // Hard switch at the top of the file.
  if (!CONFIG.LIVE_TRADING) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V8 REAL $1 BTC LIMIT TEST",
      mode: "DRY_RUN",
      success: true,
      config: CONFIG,
      preview,
      signing: {
        action_hash: actionHash,
        signature_created: true,
        signer_verified_locally: true,
      },
      hyperliquid_exchange: {
        endpoint_called: false,
        request_sent: false,
      },
      orders: {
        sent: false,
        placed: false,
      },
      timestamp: new Date().toISOString(),
    };
  }

  const signature = signatureToRsv(serializedSignature);

  const requestBody = {
    action,
    nonce,
    signature,
    vaultAddress: null,
  };

  let httpStatus: number | null = null;
  let responseText = "";
  let responseJson: any = null;
  let fetchError: string | null = null;

  try {
    const res = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
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

  const exchangeOk =
    httpStatus === 200 &&
    responseJson?.status === "ok";

  // Do not claim "placed" from status=ok alone: inspect returned order status.
  const statuses =
    responseJson?.response?.data?.statuses ??
    null;

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V8 REAL $1 BTC LIMIT TEST",
    mode: "LIVE_SINGLE_LIMIT_ORDER_TEST",
    network: "MAINNET",

    config: CONFIG,

    master_account: MASTER_ACCOUNT,
    expected_api_wallet: EXPECTED_API_WALLET,

    preview,

    signing: {
      nonce,
      action_hash: actionHash,
      signature_created: true,
      full_signature_returned: false,
      signer_verified_locally: true,
      recovered_signer_masked: maskAddress(recovered),
    },

    hyperliquid_exchange: {
      endpoint_called: true,
      request_sent: true,
      http_status: httpStatus,
      response_json: responseJson,
      response_text:
        responseJson === null ? responseText.slice(0, 1500) : null,
      fetch_error: fetchError,
      status_ok: exchangeOk,
      returned_statuses: statuses,
    },

    orders: {
      real_order_payload_sent: true,
      auto_cancel: false,
      check_open_orders_after_test: true,
    },

    next_stage_not_sent: {
      leverage_update: CONFIG.LEVERAGE,
      take_profit_pct: CONFIG.TAKE_PROFIT_PCT,
      stop_loss_pct: CONFIG.STOP_LOSS_PCT,
      note:
        "V8 does not send leverage, TP or SL. They are isolated for later tests.",
    },

    safety: {
      private_key_exposed_in_response: false,
      private_key_logged: false,
      full_signature_exposed: false,
      live_trading_switch: CONFIG.LIVE_TRADING,
    },

    timestamp: new Date().toISOString(),
  };
}
