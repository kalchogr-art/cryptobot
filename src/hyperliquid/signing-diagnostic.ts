// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V3 — LOCAL L1 SIGNATURE
//
// SAFE:
// - Reads API-wallet private key only from Cloudflare Secret.
// - Builds a harmless LOCAL dummy action.
// - Reproduces Hyperliquid L1 action hashing:
//     msgpack(action) + nonce(8-byte BE) + vault marker
// - Builds the Mainnet phantom Agent EIP-712 payload.
// - Signs it LOCALLY with the authorized API wallet.
// - Recovers signer locally and compares with expected API wallet.
// - NEVER calls /exchange.
// - NEVER sends an order or any other action to Hyperliquid.
// ============================================================

import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  hexToBytes,
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

function maskHex(value: string): string {
  if (!value || value.length < 18) return value;
  return `${value.slice(0, 12)}...${value.slice(-8)}`;
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
      version: "V3 LOCAL L1 SIGNATURE",
      mode: "LOCAL_CRYPTO_DIAGNOSTIC_ONLY",
      success: false,
      reason: "PRIVATE_KEY_MISSING_OR_INVALID_FORMAT",
      secret: {
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
  const identityMatch = derivedAddress === expectedAddress;

  // Harmless local-only action. This object is NEVER transmitted.
  // Hyperliquid's official SDK signing tests also use a dummy action
  // to verify the L1 signing path.
  const action = {
    type: "dummy",
    num: 100000000000,
  };

  // Fixed nonce makes this diagnostic reproducible and prevents it from
  // accidentally resembling a current live request.
  const nonce = 0n;

  // Official Hyperliquid action_hash for vault_address=None:
  // msgpack(action) || nonce_u64_be || 0x00
  const packedAction = encode(action);
  const hashInput = concat([
    bytesToHex(packedAction),
    bytesToHex(u64be(nonce)),
    "0x00",
  ]);

  const actionHash = keccak256(hashInput);

  // Mainnet phantom agent: source="a".
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

  const recoveredAddress = (
    await recoverTypedDataAddress({
      domain,
      types,
      primaryType: "Agent",
      message,
      signature,
    })
  ).toLowerCase();

  const recoveredMatchesExpected =
    recoveredAddress === expectedAddress;

  const signatureValid =
    identityMatch && recoveredMatchesExpected;

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V3 LOCAL L1 SIGNATURE",
    mode: "LOCAL_CRYPTO_DIAGNOSTIC_ONLY",
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
      derived_api_wallet: derivedAddress,
      derived_api_wallet_masked: maskAddress(derivedAddress),
      api_wallet_match: identityMatch,
    },

    local_l1_test: {
      attempted: true,
      action_type: "dummy",
      action_transmitted: false,
      nonce: Number(nonce),
      vault_address: null,
      mainnet_source: "a",
      action_hash: actionHash,
      eip712_domain: {
        name: "Exchange",
        version: "1",
        chain_id: 1337,
        verifying_contract:
          "0x0000000000000000000000000000000000000000",
      },
      signature_created: true,
      signature_masked: maskHex(signature),
      signature_returned_in_full: false,
      recovered_signer: recoveredAddress,
      recovered_signer_masked: maskAddress(recoveredAddress),
      recovered_matches_expected_api_wallet: recoveredMatchesExpected,
      local_signature_valid: signatureValid,
    },

    signing: {
      attempted: true,
      l1_signature_created: true,
      eip712_signature_created: true,
      signer_verified_locally: signatureValid,
    },

    hyperliquid_exchange: {
      endpoint_called: false,
      request_sent: false,
      url: null,
    },

    orders: {
      created: false,
      sent: false,
      cancelled: false,
      modified: false,
    },

    ready_for_exchange_transport_diagnostic: signatureValid,

    safety: {
      private_key_exposed_in_response: false,
      private_key_logged: false,
      full_signature_exposed: false,
      action_transmitted: false,
      exchange_request_sent: false,
      real_trading_enabled: false,
      funds_can_move: false,
      trading: "REAL_TRADING_DISABLED",
    },

    timestamp: new Date().toISOString(),
  };
}
