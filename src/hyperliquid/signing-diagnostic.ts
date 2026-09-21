// ============================================================
// HYPERLIQUID SIGNING DIAGNOSTIC V1 — SAFE / NO EXCHANGE ACTION
//
// PURPOSE:
// - Confirm Cloudflare can see the API-wallet secret.
// - Validate only the secret FORMAT.
// - Keep the public API-wallet address visible for comparison.
// - NEVER return/log the private key.
// - NEVER call Hyperliquid /exchange.
// - NEVER place/cancel/modify an order.
//
// This is intentionally a pre-signing safety stage.
// ============================================================

const EXPECTED_API_WALLET =
  "0xe9a5a9fed6a1a6c856b27477c761b135097d50ae";

export type HyperliquidSigningEnv = {
  HYPERLIQUID_API_PRIVATE_KEY?: string;
};

function normalizePrivateKey(value: unknown): string {
  return String(value ?? "").trim();
}

function privateKeyFormatOk(value: string): boolean {
  // Hyperliquid API wallet uses an EVM secp256k1 private key:
  // 0x + 64 hex chars.
  return /^0x[a-fA-F0-9]{64}$/.test(value);
}

export async function getHyperliquidSigningDiagnostic(
  env: HyperliquidSigningEnv
): Promise<Record<string, any>> {
  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);
  const secretPresent = secret.length > 0;
  const formatOk = secretPresent && privateKeyFormatOk(secret);

  return {
    module: "hyperliquid-signing-diagnostic",
    version: "V1 SAFE SECRET CHECK",
    mode: "DIAGNOSTIC_ONLY",
    network: "MAINNET",

    master_account: "0xf1CF243f05024AE78aE2dFa31c2Bec1e1F6c9196",
    expected_api_wallet: EXPECTED_API_WALLET,

    secret: {
      binding_name: "HYPERLIQUID_API_PRIVATE_KEY",
      present: secretPresent,
      format_ok: formatOk,
      expected_format: "0x + 64 hexadecimal characters",
      value_returned: false,
      value_logged: false,
    },

    signing: {
      attempted: false,
      reason:
        "V1 only verifies the encrypted secret is available and structurally valid. No cryptographic signing is performed yet.",
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

    ready_for_local_signature_test: secretPresent && formatOk,

    safety: {
      private_key_exposed_in_response: false,
      real_trading_enabled: false,
      funds_can_move: false,
      trading: "REAL_TRADING_DISABLED",
    },

    timestamp: new Date().toISOString(),
  };
}
