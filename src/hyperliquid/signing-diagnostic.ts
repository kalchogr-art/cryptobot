// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V6 — DRY-RUN ORDER BUILDER
//
// SAFE:
// - Builds a REAL Hyperliquid order-wire structure locally.
// - Signs the order action locally with the authorized API wallet.
// - Verifies the signer locally.
// - DOES NOT call /exchange.
// - DOES NOT place an order.
// - DOES NOT move funds.
//
// Diagnostic order:
//   BTC PERP, BUY/LONG, LIMIT GTC
//   asset = 0
//   price = "1"
//   size  = "0.00001"
// This payload is for STRUCTURE/SIGNING diagnostics only.
// ============================================================

import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

export async function getHyperliquidSigningDiagnostic(
  env: HyperliquidSigningEnv
): Promise<Record<string, any>> {
  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);
  const secretPresent = secret.length > 0;
  const formatOk = secretPresent && privateKeyFormatOk(secret);

  if (!formatOk) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V6 DRY-RUN ORDER BUILDER",
      success: false,
      error: "PRIVATE_KEY_MISSING_OR_INVALID_FORMAT",
      trading: "REAL_TRADING_DISABLED",
      timestamp: new Date().toISOString(),
    };
  }

  const account = privateKeyToAccount(secret as `0x${string}`);
  const derived = account.address.toLowerCase();
  const expected = EXPECTED_API_WALLET.toLowerCase();

  if (derived !== expected) {
    return {
      module: "hyperliquid-signing-diagnostic",
      version: "V6 DRY-RUN ORDER BUILDER",
      success: false,
      error: "API_WALLET_IDENTITY_MISMATCH",
      derived_api_wallet_masked: maskAddress(derived),
      trading: "REAL_TRADING_DISABLED",
      timestamp: new Date().toISOString(),
    };
  }

  // Official Hyperliquid order wire keys:
  // a = asset
  // b = isBuy
  // p = limit price as wire string
  // s = size as wire string
  // r = reduceOnly
  // t = order type
  //
  // BTC is asset 0 on the default perp dex.
  const orderWire = {
    a: 0,
    b: true,
    p: "1",
    s: "0.00001",
    r: false,
    t: {
      limit: {
        tif: "Gtc",
      },
    },
  };

  // Official order action shape.
  const action = {
    type: "order",
    orders: [orderWire],
    grouping: "na",
  };

  const nonce = Date.now();

  // Hyperliquid L1 action hash:
  // msgpack(action) || nonce_u64_be || vault marker.
  // vaultAddress = null => 0x00.
  const packedAction = encode(action);

  const hashInput = concat([
    bytesToHex(packedAction),
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
    version: "V6 DRY-RUN ORDER BUILDER",
    mode: "LOCAL_ORDER_BUILD_AND_SIGN_ONLY",
    network: "MAINNET",

    master_account: MASTER_ACCOUNT,
    expected_api_wallet: EXPECTED_API_WALLET,

    identity: {
      api_wallet_match: true,
      derived_api_wallet_masked: maskAddress(derived),
      recovered_signer_masked: maskAddress(recovered),
      signer_verified_locally: signerValid,
    },

    dry_run_order: {
      market: "BTC-PERP",
      asset: 0,
      side: "BUY_LONG",
      limit_price: "1",
      size: "0.00001",
      reduce_only: false,
      tif: "Gtc",
      grouping: "na",

      order_wire: orderWire,
      action,

      nonce,
      vault_address: null,
      action_hash: actionHash,

      signature_created: true,
      signature_returned_in_full: false,
      signer_verified_locally: signerValid,
    },

    hyperliquid_exchange: {
      endpoint_called: false,
      request_sent: false,
      reason:
        "V6 is local DRY RUN only. The signed order action is intentionally not transmitted.",
    },

    validation: {
      order_wire_built: true,
      order_action_built: true,
      action_hash_created: true,
      l1_signature_created: true,
      local_signature_valid: signerValid,
      ready_for_controlled_order_test: signerValid,
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
      real_order_payload_sent: false,
      funds_can_move: false,
      real_trading_enabled: false,
      trading: "REAL_TRADING_DISABLED",
    },

    timestamp: new Date().toISOString(),
  };
}
