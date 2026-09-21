// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V4 — EXCHANGE TRANSPORT PROBE
//
// SAFE TRANSPORT TEST:
// - Uses the authorized API-wallet secret.
// - Signs an intentionally unsupported `dummy` L1 action.
// - Sends that unsupported action to Hyperliquid /exchange.
// - It is NOT an order/cancel/transfer/leverage/margin action.
// - Expected outcome: Hyperliquid rejects the unsupported action.
// - Purpose: prove Worker -> /exchange transport and capture response.
// ============================================================

import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

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
function signatureToRsv(signature: `0x${string}`) {
  const h = signature.slice(2);
  if (h.length !== 130) throw new Error("UNEXPECTED_SIGNATURE_LENGTH");
  const r = `0x${h.slice(0, 64)}`;
  const s = `0x${h.slice(64, 128)}`;
  const rawV = parseInt(h.slice(128, 130), 16);
  // viem normally returns 27/28 for serialized ECDSA signatures here.
  const v = rawV < 27 ? rawV + 27 : rawV;
  return { r, s, v };
}

export async function getHyperliquidSigningDiagnostic(
  env: HyperliquidSigningEnv
): Promise<Record<string, any>> {
  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);
  if (!privateKeyFormatOk(secret)) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V4 EXCHANGE TRANSPORT PROBE",
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
      version: "V4 EXCHANGE TRANSPORT PROBE",
      success: false,
      error: "API_WALLET_IDENTITY_MISMATCH",
      derived_api_wallet_masked: maskAddress(derived),
      trading: "REAL_TRADING_DISABLED",
      timestamp: new Date().toISOString(),
    };
  }

  // Intentionally unsupported action. This cannot represent an order,
  // transfer, cancel, leverage change, or margin change.
  const action = {
    type: "dummy",
    num: 100000000000,
  };

  // Hyperliquid recommends current timestamp milliseconds as nonce.
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

  if (recovered !== expected) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V4 EXCHANGE TRANSPORT PROBE",
      success: false,
      error: "LOCAL_SIGNATURE_RECOVERY_MISMATCH",
      trading: "REAL_TRADING_DISABLED",
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

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V4 EXCHANGE TRANSPORT PROBE",
    mode: "SIGNED_UNSUPPORTED_ACTION_TRANSPORT_TEST",
    network: "MAINNET",

    master_account: MASTER_ACCOUNT,
    expected_api_wallet: EXPECTED_API_WALLET,

    identity: {
      api_wallet_match: true,
      derived_api_wallet_masked: maskAddress(derived),
      recovered_signer_masked: maskAddress(recovered),
    },

    signed_probe: {
      action_type: "dummy",
      intentionally_unsupported: true,
      nonce,
      action_hash: actionHash,
      signature_created: true,
      signer_verified_locally: true,
      full_signature_returned: false,
      private_key_returned: false,
    },

    hyperliquid_exchange: {
      endpoint_called: true,
      request_sent: true,
      http_status: httpStatus,
      response_json: responseJson,
      response_text: responseJson === null ? responseText.slice(0, 1000) : null,
      fetch_error: fetchError,
      expected_behavior:
        "REJECTION: action type `dummy` is intentionally unsupported.",
    },

    orders: {
      created: false,
      sent: false,
      cancelled: false,
      modified: false,
    },

    funds_action: {
      transfer: false,
      withdrawal: false,
      leverage_change: false,
      margin_change: false,
    },

    safety: {
      private_key_exposed_in_response: false,
      real_order_payload_sent: false,
      supported_exchange_action_sent: false,
      real_trading_enabled: false,
      trading: "REAL_TRADING_DISABLED",
    },

    timestamp: new Date().toISOString(),
  };
}
