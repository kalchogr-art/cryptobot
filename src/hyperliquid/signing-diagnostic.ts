// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V5 — SIGNED NOOP
//
// PURPOSE:
// - Submit Hyperliquid's supported L1 `noop` action.
// - Prove that Hyperliquid accepts the API-wallet signature.
// - `noop` places NO order and moves NO funds.
// - Its protocol effect is only to mark this nonce as used.
//
// SAFETY:
// - REAL_TRADING_DISABLED remains true.
// - No order/cancel/transfer/withdraw/leverage/margin action.
// - Private key is read only from Cloudflare Secret and never returned/logged.
// - Full signature is not returned.
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

function normalizePrivateKey(value: unknown): string {
  return String(value ?? "").trim();
}

function privateKeyFormatOk(value: string): value is `0x${string}` {
  return /^0x[a-fA-F0-9]{64}$/.test(value);
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

function maskAddress(address: string): string {
  if (!address || address.length < 12) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function signatureToRsv(signature: `0x${string}`): {
  r: `0x${string}`;
  s: `0x${string}`;
  v: number;
} {
  const hex = signature.slice(2);

  if (hex.length !== 130) {
    throw new Error(`UNEXPECTED_SIGNATURE_LENGTH_${hex.length}`);
  }

  const r = `0x${hex.slice(0, 64)}` as `0x${string}`;
  const s = `0x${hex.slice(64, 128)}` as `0x${string}`;

  const rawV = parseInt(hex.slice(128, 130), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;

  return { r, s, v };
}

export async function getHyperliquidSigningDiagnostic(
  env: HyperliquidSigningEnv
): Promise<Record<string, any>> {
  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);

  const secretPresent = secret.length > 0;
  const formatOk = secretPresent && privateKeyFormatOk(secret);

  if (!formatOk) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V5 SIGNED NOOP",
      mode: "SUPPORTED_NOOP_SIGNATURE_TEST",
      network: "MAINNET",
      success: false,
      error: "PRIVATE_KEY_MISSING_OR_INVALID_FORMAT",
      secret: {
        binding_name: "HYPERLIQUID_API_PRIVATE_KEY",
        present: secretPresent,
        format_ok: formatOk,
        value_returned: false,
        value_logged: false,
      },
      hyperliquid_exchange: {
        endpoint_called: false,
        request_sent: false,
      },
      trading: "REAL_TRADING_DISABLED",
      timestamp: new Date().toISOString(),
    };
  }

  const account = privateKeyToAccount(secret as `0x${string}`);

  const derivedAddress = account.address.toLowerCase();
  const expectedAddress = EXPECTED_API_WALLET.toLowerCase();

  if (derivedAddress !== expectedAddress) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V5 SIGNED NOOP",
      mode: "SUPPORTED_NOOP_SIGNATURE_TEST",
      network: "MAINNET",
      success: false,
      error: "API_WALLET_IDENTITY_MISMATCH",
      identity: {
        derived_api_wallet_masked: maskAddress(derivedAddress),
        api_wallet_match: false,
      },
      hyperliquid_exchange: {
        endpoint_called: false,
        request_sent: false,
      },
      trading: "REAL_TRADING_DISABLED",
      timestamp: new Date().toISOString(),
    };
  }

  // Official supported Hyperliquid no-operation L1 action.
  // It does not place/cancel an order or move funds.
  const action = {
    type: "noop",
  };

  // Hyperliquid recommends current timestamp in milliseconds.
  const nonce = Date.now();

  // Hyperliquid L1 action hash:
  // msgpack(action) || nonce_u64_be || vault_marker
  //
  // vaultAddress = null => marker 0x00.
  const packedAction = encode(action);

  const hashInput = concat([
    bytesToHex(packedAction),
    bytesToHex(u64be(BigInt(nonce))),
    "0x00",
  ]);

  const actionHash = keccak256(hashInput);

  // Hyperliquid mainnet phantom agent.
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

  // Sign locally with the authorized API wallet.
  const serializedSignature = await account.signTypedData({
    domain,
    types,
    primaryType: "Agent",
    message,
  });

  // Local verification before any request is sent.
  const recoveredAddress = (
    await recoverTypedDataAddress({
      domain,
      types,
      primaryType: "Agent",
      message,
      signature: serializedSignature,
    })
  ).toLowerCase();

  const signerVerifiedLocally =
    recoveredAddress === expectedAddress;

  if (!signerVerifiedLocally) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V5 SIGNED NOOP",
      mode: "SUPPORTED_NOOP_SIGNATURE_TEST",
      network: "MAINNET",
      success: false,
      error: "LOCAL_SIGNATURE_RECOVERY_MISMATCH",
      identity: {
        api_wallet_match: true,
        recovered_signer_masked: maskAddress(recoveredAddress),
      },
      hyperliquid_exchange: {
        endpoint_called: false,
        request_sent: false,
      },
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
    const response = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    httpStatus = response.status;
    responseText = await response.text();

    try {
      responseJson =
        responseText.length > 0
          ? JSON.parse(responseText)
          : null;
    } catch {
      responseJson = null;
    }
  } catch (error: any) {
    fetchError = error?.message ?? String(error);
  }

  const exchangeAccepted =
    httpStatus === 200 &&
    responseJson?.status === "ok";

  const expectedDefaultResponse =
    exchangeAccepted &&
    responseJson?.response?.type === "default";

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V5 SIGNED NOOP",
    mode: "SUPPORTED_NOOP_SIGNATURE_TEST",
    network: "MAINNET",

    master_account: MASTER_ACCOUNT,
    expected_api_wallet: EXPECTED_API_WALLET,

    secret: {
      binding_name: "HYPERLIQUID_API_PRIVATE_KEY",
      present: true,
      format_ok: true,
      value_returned: false,
      value_logged: false,
    },

    identity: {
      api_wallet_match: true,
      derived_api_wallet_masked: maskAddress(derivedAddress),
      recovered_signer_masked: maskAddress(recoveredAddress),
      signer_verified_locally: true,
    },

    noop: {
      action_type: "noop",
      nonce,
      action_hash: actionHash,
      signature_created: true,
      vault_address: null,
      protocol_effect:
        "MARK_THIS_NONCE_AS_USED_ONLY",
      order_effect: false,
      funds_effect: false,
    },

    hyperliquid_exchange: {
      endpoint_called: true,
      request_sent: true,
      http_status: httpStatus,
      response_json: responseJson,
      response_text:
        responseJson === null
          ? responseText.slice(0, 1000)
          : null,
      fetch_error: fetchError,
      accepted: exchangeAccepted,
      expected_default_response: expectedDefaultResponse,
    },

    validation: {
      local_signature_valid: true,
      hyperliquid_accepted_signature: exchangeAccepted,
      noop_success:
        exchangeAccepted && expectedDefaultResponse,
      ready_for_dry_run_order_builder:
        exchangeAccepted && expectedDefaultResponse,
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
      private_key_logged: false,
      full_signature_exposed: false,
      real_order_payload_sent: false,
      noop_nonce_consumed_if_accepted: exchangeAccepted,
      real_trading_enabled: false,
      funds_can_move_from_this_action: false,
      trading: "REAL_TRADING_DISABLED",
    },

    timestamp: new Date().toISOString(),
  };
}
