// Manual update============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V2 — LOCAL IDENTITY CHECK
//
// SAFE:
// - Reads encrypted Cloudflare Secret.
// - Derives the EVM address locally from the API-wallet private key.
// - Compares it with the authorized CryptoBot API-wallet address.
// - NEVER returns/logs the private key.
// - NEVER calls Hyperliquid /exchange.
// - NEVER places/cancels/modifies an order.
// ============================================================

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

  let derivedAddress: string | null = null;
  let derivationError: string | null = null;

  if (formatOk) {
    try {
      // LOCAL ONLY. No RPC/API/network request is made by privateKeyToAccount.
      const account = privateKeyToAccount(secret as `0x${string}`);
      derivedAddress = account.address.toLowerCase();
    } catch (error: any) {
      derivationError = error?.message ?? String(error);
    }
  }

  const expected = EXPECTED_API_WALLET.toLowerCase();
  const walletMatch =
    derivedAddress !== null && derivedAddress.toLowerCase() === expected;

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V2 LOCAL API WALLET IDENTITY CHECK",
    mode: "LOCAL_CRYPTO_DIAGNOSTIC_ONLY",
    network: "MAINNET",

    master_account: MASTER_ACCOUNT,
    expected_api_wallet: EXPECTED_API_WALLET,

    secret: {
      binding_name: "HYPERLIQUID_API_PRIVATE_KEY",
      present: secretPresent,
      format_ok: formatOk,
      expected_format: "0x + 64 hexadecimal characters",
      value_returned: false,
      value_logged: false,
    },

    local_identity_check: {
      attempted: formatOk,
      success: derivedAddress !== null,
      derived_api_wallet: derivedAddress,
      derived_api_wallet_masked:
        derivedAddress ? maskAddress(derivedAddress) : null,
      expected_api_wallet: EXPECTED_API_WALLET,
      api_wallet_match: walletMatch,
      error: derivationError,
      note:
        "Address derivation is local only. No Hyperliquid exchange request is sent.",
    },

    signing: {
      attempted: false,
      l1_signature_created: false,
      eip712_signature_created: false,
      reason:
        "V2 proves API-wallet key identity only. Hyperliquid action signing is intentionally not performed yet.",
    },

    hyperliquid_exchange: {
      endpoint_called: false,
      request_sent: false,
    },

    orders: {
      created: false,
      sent: false,
      cancelled: false,
      modified: false,
    },

    ready_for_hyperliquid_signature_test:
      secretPresent && formatOk && walletMatch,

    safety: {
      private_key_exposed_in_response: false,
      private_key_logged: false,
      network_request_for_derivation: false,
      real_trading_enabled: false,
      funds_can_move: false,
      trading: "REAL_TRADING_DISABLED",
    },

    timestamp: new Date().toISOString(),
  };
}
