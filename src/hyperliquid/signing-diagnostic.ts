// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V9 — REAL LEVERAGE TEST
//
// PURPOSE:
// - Set BTC perp leverage using Hyperliquid's official updateLeverage action.
// - Read BTC metadata first and reject config above maxLeverage.
// - Sign with the authorized API wallet.
// - POST the leverage action to /exchange.
// - Read activeAssetData afterwards to verify current BTC leverage.
//
// IMPORTANT:
// - This version sends NO order.
// - It sends NO TP/SL.
// - It moves NO funds.
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
  LEVERAGE: 10,
  IS_CROSS: true,

  // Saved for later order/TP/SL stages — NOT sent in V9.
  ORDER_PRICE: 80000,
  ORDER_USD: 10.40,
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
      version: "V9 REAL LEVERAGE TEST",
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
      version: "V9 REAL LEVERAGE TEST",
      success: false,
      error: "API_WALLET_IDENTITY_MISMATCH",
      derived_api_wallet_masked: maskAddress(derived),
      timestamp: new Date().toISOString(),
    };
  }

  // Read current perp metadata to dynamically find BTC asset index
  // and its maximum allowed leverage.
  const meta = await postInfo({ type: "meta" });
  const universe = Array.isArray(meta?.universe) ? meta.universe : [];

  const asset = universe.findIndex((x: any) => x?.name === CONFIG.COIN);
  if (asset < 0) throw new Error(`${CONFIG.COIN}_NOT_FOUND`);

  const assetMeta = universe[asset];
  const maxLeverage = Number(assetMeta?.maxLeverage);

  if (
    !Number.isInteger(CONFIG.LEVERAGE) ||
    CONFIG.LEVERAGE <= 0
  ) {
    throw new Error("LEVERAGE_MUST_BE_POSITIVE_INTEGER");
  }

  if (
    Number.isFinite(maxLeverage) &&
    CONFIG.LEVERAGE > maxLeverage
  ) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V9 REAL LEVERAGE TEST",
      success: false,
      error: "CONFIG_LEVERAGE_ABOVE_ASSET_MAX",
      requested_leverage: CONFIG.LEVERAGE,
      max_leverage: maxLeverage,
      exchange_request_sent: false,
      timestamp: new Date().toISOString(),
    };
  }

  // Official Hyperliquid action shape.
  const action = {
    type: "updateLeverage",
    asset,
    isCross: CONFIG.IS_CROSS,
    leverage: CONFIG.LEVERAGE,
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
      version: "V9 REAL LEVERAGE TEST",
      success: false,
      error: "LOCAL_SIGNATURE_RECOVERY_MISMATCH",
      exchange_request_sent: false,
      timestamp: new Date().toISOString(),
    };
  }

  if (!CONFIG.LIVE_TRADING) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V9 REAL LEVERAGE TEST",
      mode: "DRY_RUN",
      success: true,
      config: CONFIG,
      action,
      asset_meta: {
        asset,
        coin: CONFIG.COIN,
        max_leverage: maxLeverage,
      },
      signing: {
        action_hash: actionHash,
        signature_created: true,
        signer_verified_locally: true,
      },
      hyperliquid_exchange: {
        endpoint_called: false,
        request_sent: false,
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
      headers: { "content-type": "application/json" },
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

  const accepted =
    httpStatus === 200 &&
    responseJson?.status === "ok" &&
    responseJson?.response?.type === "default";

  // Verify current BTC leverage from the read-only info API.
  let activeAssetData: any = null;
  let verificationError: string | null = null;

  try {
    activeAssetData = await postInfo({
      type: "activeAssetData",
      user: MASTER_ACCOUNT,
      coin: CONFIG.COIN,
    });
  } catch (e: any) {
    verificationError = e?.message ?? String(e);
  }

  const currentLeverage =
    activeAssetData?.leverage?.value ?? null;

  const currentLeverageType =
    activeAssetData?.leverage?.type ?? null;

  const leverageVerified =
    accepted &&
    Number(currentLeverage) === CONFIG.LEVERAGE &&
    (
      (CONFIG.IS_CROSS && currentLeverageType === "cross") ||
      (!CONFIG.IS_CROSS && currentLeverageType === "isolated")
    );

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V9 REAL LEVERAGE TEST",
    mode: "LIVE_UPDATE_LEVERAGE_TEST",
    network: "MAINNET",

    config: CONFIG,

    master_account: MASTER_ACCOUNT,
    expected_api_wallet: EXPECTED_API_WALLET,

    asset_meta: {
      coin: CONFIG.COIN,
      asset,
      max_leverage: maxLeverage,
    },

    leverage_action: {
      requested_leverage: CONFIG.LEVERAGE,
      requested_mode: CONFIG.IS_CROSS ? "cross" : "isolated",
      action,
    },

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
      accepted,
    },

    verification: {
      info_checked_after_exchange: true,
      error: verificationError,
      current_leverage: currentLeverage,
      current_leverage_type: currentLeverageType,
      leverage_verified: leverageVerified,
      active_asset_data: activeAssetData,
    },

    orders: {
      sent: false,
      placed: false,
    },

    tp_sl: {
      sent: false,
    },

    next_stage: {
      order_price: CONFIG.ORDER_PRICE,
      order_usd: CONFIG.ORDER_USD,
      take_profit_pct: CONFIG.TAKE_PROFIT_PCT,
      stop_loss_pct: CONFIG.STOP_LOSS_PCT,
      note: "V9 only updates leverage. Entry order and TP/SL remain isolated.",
    },

    safety: {
      private_key_exposed_in_response: false,
      private_key_logged: false,
      full_signature_exposed: false,
      order_sent: false,
      funds_transfer_sent: false,
      live_trading_switch: CONFIG.LIVE_TRADING,
    },

    timestamp: new Date().toISOString(),
  };
}
