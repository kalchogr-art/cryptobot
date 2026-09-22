import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ============================================================
// HYPERLIQUID SIGNAL EXECUTION V2.4
// SIGNAL -> AUTO LEVERAGE -> MARKETABLE IOC ENTRY -> FILL -> TP/SL
//
// COMPLETE EXECUTION PATH:
// - LIVE_TRADING is FALSE by default.
// - When FALSE: builds the exact live action but never signs/sends it.
// - When TRUE: signs/sends IOC ENTRY first, then fill-based positionTpsl protection.
// - Triggered only by a NEW >=65 crossing supplied by index.ts.
// - DRY RUN previews current-market IOC entry and post-fill TP/SL.
// - LIVE path: guarantees configured leverage first, then IOC entry; only after confirmed fill are TP/SL sent.
// - If leverage update fails, ENTRY is blocked.
// - Uses the proven Hyperliquid L1 signing path.
// ============================================================

const INFO_URL = "https://api.hyperliquid.xyz/info";
const EXCHANGE_URL = "https://api.hyperliquid.xyz/exchange";

const EXPECTED_API_WALLET =
  "0xe9a5a9fed6a1a6c856b27477c761b135097d50ae";
const MASTER_ACCOUNT =
  "0xf1CF243f05024AE78aE2dFa31c2Bec1e1F6c9196";

const CONFIG = {
  LIVE_TRADING: false,

  MIN_SIGNAL_SCORE: 65,

  MARGIN_USD: 1.04,
  LEVERAGE: 10,
  IS_CROSS: true,

  LONG_TAKE_PROFIT_PCT: 0.50,
  LONG_STOP_LOSS_PCT: 0.15,
  SHORT_TAKE_PROFIT_PCT: 0.50,
  SHORT_STOP_LOSS_PCT: 0.40,

  MAX_ENTRY_SLIPPAGE_PCT: 0.30,
  TIF: "Ioc" as const,

  // A real entry is allowed only immediately after a newly-created crossing.
  // Old crossings may still be previewed by the read-only endpoint, but can
  // never reach /exchange.
  MAX_SIGNAL_AGE_MS: 120_000,
};

export type HyperliquidExecutionEnv = {
  HYPERLIQUID_API_PRIVATE_KEY?: string;
  DB?: any;
};

export type HyperliquidExecutionSignal = {
  coin: string;
  side: "LONG" | "SHORT";
  score: number;
  price: number;
  crossing_id?: number | string | null;
  episode_id?: number | string | null;
  crossing_ts?: number | null;

  // READ_ONLY_STATUS is used by /hyperliquid-execution and is permanently
  // forbidden from sending live exchange actions even if LIVE_TRADING=true.
  execution_context?: "SIGNAL_PIPELINE" | "READ_ONLY_STATUS";
};

function roundTo(value: number, decimals: number): number {
  const p = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * p) / p;
}

function toWire(value: number, decimals = 8): string {
  if (!Number.isFinite(value) || value <= 0) throw new Error("INVALID_WIRE_NUMBER");
  return value.toFixed(decimals).replace(/\.?0+$/, "");
}

function bestValidSize(
  targetSize: number,
  price: number,
  szDecimals: number
): number {
  const scale = 10 ** szDecimals;
  const minSize = Math.ceil((10 / price) * scale - 1e-12) / scale;

  const floorSize = Math.floor(targetSize * scale + 1e-12) / scale;
  const ceilSize = Math.ceil(targetSize * scale - 1e-12) / scale;

  const candidates = [floorSize, ceilSize, minSize]
    .filter((v, i, a) => v > 0 && v * price >= 10 && a.indexOf(v) === i);

  if (!candidates.length) return minSize;

  return candidates.reduce((best, current) =>
    Math.abs(current * price - CONFIG.MARGIN_USD * CONFIG.LEVERAGE) <
    Math.abs(best * price - CONFIG.MARGIN_USD * CONFIG.LEVERAGE)
      ? current
      : best
  );
}

// Hyperliquid prices: max 5 significant figures and max (6 - szDecimals)
// decimal places for perp prices.
function priceToWire(price: number, szDecimals: number): string {
  if (!Number.isFinite(price) || price <= 0) throw new Error("INVALID_PRICE");

  const maxDecimals = Math.max(0, 6 - szDecimals);
  const magnitude = Math.floor(Math.log10(Math.abs(price)));
  const sigDecimals = Math.max(0, 5 - magnitude - 1);
  const decimals = Math.min(maxDecimals, sigDecimals);

  return toWire(roundTo(price, decimals), decimals);
}

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

function signatureToRsv(signature: `0x${string}`) {
  const h = signature.slice(2);
  if (h.length !== 130) throw new Error("UNEXPECTED_SIGNATURE_LENGTH");
  const r = `0x${h.slice(0, 64)}`;
  const s = `0x${h.slice(64, 128)}`;
  const rawV = parseInt(h.slice(128, 130), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  return { r, s, v };
}

async function signHyperliquidAction(
  action: Record<string, any>,
  nonce: number,
  secret: `0x${string}`
) {
  const account = privateKeyToAccount(secret);
  const expected = EXPECTED_API_WALLET.toLowerCase();

  if (account.address.toLowerCase() !== expected) {
    throw new Error("API_WALLET_PRIVATE_KEY_DOES_NOT_MATCH_EXPECTED_ADDRESS");
  }

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
    throw new Error("LOCAL_SIGNATURE_RECOVERY_MISMATCH");
  }

  return {
    actionHash,
    signature: signatureToRsv(serializedSignature),
  };
}

async function postInfo(body: Record<string, any>): Promise<any> {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`INFO_HTTP_${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}


async function ensureExecutionLedger(db: any): Promise<void> {
  if (!db) throw new Error("D1_NOT_BOUND_FOR_LIVE_EXECUTION");

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS hyperliquid_execution_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      crossing_id TEXT NOT NULL UNIQUE,
      episode_id TEXT NOT NULL UNIQUE,
      coin TEXT NOT NULL,
      side TEXT NOT NULL,
      crossing_ts INTEGER NOT NULL,
      status TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      entry_fill_price REAL,
      entry_fill_size REAL,
      entry_oid TEXT,
      last_error TEXT
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_hl_execution_ledger_coin_status
    ON hyperliquid_execution_ledger (coin, status)
  `).run();
}

async function claimExecutionOnce(
  db: any,
  signal: HyperliquidExecutionSignal,
  coin: string,
  side: string
): Promise<{ claimed: boolean; existing?: any }> {
  await ensureExecutionLedger(db);

  const crossingId = String(signal.crossing_id ?? "");
  const episodeId = String(signal.episode_id ?? "");
  const crossingTs = Number(signal.crossing_ts);

  if (!crossingId || !episodeId || !Number.isFinite(crossingTs)) {
    return { claimed: false, existing: { status: "MISSING_EXECUTION_IDENTITY" } };
  }

  const now = Date.now();
  const insert: any = await db.prepare(`
    INSERT OR IGNORE INTO hyperliquid_execution_ledger (
      crossing_id, episode_id, coin, side, crossing_ts,
      status, claimed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, ?)
  `).bind(
    crossingId,
    episodeId,
    coin,
    side,
    crossingTs,
    now,
    now
  ).run();

  const changes = Number(insert?.meta?.changes ?? 0);
  if (changes > 0) return { claimed: true };

  const existing: any = await db.prepare(`
    SELECT *
    FROM hyperliquid_execution_ledger
    WHERE crossing_id = ? OR episode_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).bind(crossingId, episodeId).first();

  return { claimed: false, existing };
}

async function updateExecutionLedger(
  db: any,
  crossingId: number | string | null | undefined,
  status: string,
  fields: {
    entry_fill_price?: number | null;
    entry_fill_size?: number | null;
    entry_oid?: string | number | null;
    last_error?: string | null;
  } = {}
): Promise<void> {
  if (!db || crossingId === null || crossingId === undefined) return;

  await db.prepare(`
    UPDATE hyperliquid_execution_ledger
    SET
      status = ?,
      updated_at = ?,
      entry_fill_price = COALESCE(?, entry_fill_price),
      entry_fill_size = COALESCE(?, entry_fill_size),
      entry_oid = COALESCE(?, entry_oid),
      last_error = ?
    WHERE crossing_id = ?
  `).bind(
    status,
    Date.now(),
    fields.entry_fill_price ?? null,
    fields.entry_fill_size ?? null,
    fields.entry_oid == null ? null : String(fields.entry_oid),
    fields.last_error ?? null,
    String(crossingId)
  ).run();
}

export async function buildHyperliquidExecutionCandidate(
  signal: HyperliquidExecutionSignal,
  env?: HyperliquidExecutionEnv
): Promise<Record<string, any>> {
  const coin = String(signal?.coin ?? "").toUpperCase();
  const side = signal?.side;
  const score = Number(signal?.score);
  const entryPrice = Number(signal?.price);
  const crossingTs = Number(signal?.crossing_ts);
  const executionContext = signal?.execution_context ?? "SIGNAL_PIPELINE";
  const signalAgeMs = Number.isFinite(crossingTs) ? Date.now() - crossingTs : null;
  const signalFresh =
    signalAgeMs !== null &&
    signalAgeMs >= 0 &&
    signalAgeMs <= CONFIG.MAX_SIGNAL_AGE_MS;

  if (!coin || (side !== "LONG" && side !== "SHORT")) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "INVALID_SIGNAL",
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  if (!Number.isFinite(score) || score < CONFIG.MIN_SIGNAL_SCORE) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "BELOW_MIN_SIGNAL_SCORE",
      score,
      required: CONFIG.MIN_SIGNAL_SCORE,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "INVALID_ENTRY_PRICE",
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const raw = await postInfo({ type: "metaAndAssetCtxs" });
  if (!Array.isArray(raw) || raw.length < 2) throw new Error("UNEXPECTED_META_SHAPE");

  const universe = Array.isArray(raw?.[0]?.universe) ? raw[0].universe : [];
  const contexts = Array.isArray(raw?.[1]) ? raw[1] : [];

  const asset = universe.findIndex((x: any) => x?.name === coin);
  if (asset < 0) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "COIN_NOT_FOUND_ON_HYPERLIQUID",
      coin,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const szDecimals = Number(universe[asset]?.szDecimals);
  if (!Number.isInteger(szDecimals) || szDecimals < 0) {
    throw new Error("INVALID_SZ_DECIMALS");
  }

  const positionUsdTarget = CONFIG.MARGIN_USD * CONFIG.LEVERAGE;
  const isLong = side === "LONG";

  // Market entry policy: use the current Hyperliquid market, not the old
  // crossing price. A market order is represented as a marketable IOC limit.
  const markPx = Number(contexts?.[asset]?.markPx);
  const midPx = Number(contexts?.[asset]?.midPx);
  const currentMarketPrice =
    Number.isFinite(midPx) && midPx > 0
      ? midPx
      : Number.isFinite(markPx) && markPx > 0
        ? markPx
        : NaN;

  if (!Number.isFinite(currentMarketPrice) || currentMarketPrice <= 0) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "CURRENT_MARKET_PRICE_UNAVAILABLE",
      coin,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const marketReferenceWire = priceToWire(currentMarketPrice, szDecimals);
  const marketReference = Number(marketReferenceWire);

  // LONG pays up to +slippage; SHORT sells down to -slippage.
  // IOC means fill immediately inside this protection band or cancel.
  const iocLimitRaw = isLong
    ? currentMarketPrice * (1 + CONFIG.MAX_ENTRY_SLIPPAGE_PCT / 100)
    : currentMarketPrice * (1 - CONFIG.MAX_ENTRY_SLIPPAGE_PCT / 100);
  const iocLimitWire = priceToWire(iocLimitRaw, szDecimals);
  const iocLimitPrice = Number(iocLimitWire);

  // Size from the current market reference, not the stale signal price.
  const size = bestValidSize(
    positionUsdTarget / marketReference,
    marketReference,
    szDecimals
  );
  const sizeWire = toWire(size, szDecimals);
  const estimatedNotionalUsd = marketReference * size;

  if (estimatedNotionalUsd < 10) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "CALCULATED_NOTIONAL_BELOW_10",
      actual_notional_usd: estimatedNotionalUsd,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const takeProfitPct = isLong
    ? CONFIG.LONG_TAKE_PROFIT_PCT
    : CONFIG.SHORT_TAKE_PROFIT_PCT;
  const stopLossPct = isLong
    ? CONFIG.LONG_STOP_LOSS_PCT
    : CONFIG.SHORT_STOP_LOSS_PCT;

  const entryOrder = {
    a: asset,
    b: isLong,
    p: iocLimitWire,
    s: sizeWire,
    r: false,
    t: { limit: { tif: CONFIG.TIF } },
  };

  const entryAction = {
    type: "order",
    orders: [entryOrder],
    grouping: "na",
  };

  // Read current per-asset leverage. Hyperliquid leverage is configured per coin.
  // This call is read-only and is safe in DRY RUN.
  let activeAssetData: any = null;
  try {
    activeAssetData = await postInfo({
      type: "activeAssetData",
      user: MASTER_ACCOUNT,
      coin,
    });
  } catch (e: any) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "ACTIVE_ASSET_DATA_UNAVAILABLE",
      detail: e?.message ?? String(e),
      coin,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const currentLeverageType = String(activeAssetData?.leverage?.type ?? "").toLowerCase();
  const currentLeverageValue = Number(activeAssetData?.leverage?.value);
  const desiredLeverageType = CONFIG.IS_CROSS ? "cross" : "isolated";
  const leverageAlreadyCorrect =
    currentLeverageType === desiredLeverageType &&
    currentLeverageValue === CONFIG.LEVERAGE;

  const leverageAction = {
    type: "updateLeverage",
    asset,
    isCross: CONFIG.IS_CROSS,
    leverage: CONFIG.LEVERAGE,
  };

  // In DRY RUN there is no real fill. For preview only, use the current
  // market reference as the estimated fill. LIVE TP/SL are recalculated from
  // the actual Hyperliquid fill price returned by /exchange.
  const previewFillPrice = marketReference;
  const previewTpRaw = isLong
    ? previewFillPrice * (1 + takeProfitPct / 100)
    : previewFillPrice * (1 - takeProfitPct / 100);
  const previewSlRaw = isLong
    ? previewFillPrice * (1 - stopLossPct / 100)
    : previewFillPrice * (1 + stopLossPct / 100);
  const previewTpWire = priceToWire(previewTpRaw, szDecimals);
  const previewSlWire = priceToWire(previewSlRaw, szDecimals);

  const closeIsBuy = !isLong;
  const previewTpOrder = {
    a: asset,
    b: closeIsBuy,
    p: previewTpWire,
    s: sizeWire,
    r: true,
    t: {
      trigger: {
        isMarket: true,
        triggerPx: previewTpWire,
        tpsl: "tp",
      },
    },
  };
  const previewSlOrder = {
    a: asset,
    b: closeIsBuy,
    p: previewSlWire,
    s: sizeWire,
    r: true,
    t: {
      trigger: {
        isMarket: true,
        triggerPx: previewSlWire,
        tpsl: "sl",
      },
    },
  };

  const previewProtectionAction = {
    type: "order",
    orders: [previewTpOrder, previewSlOrder],
    grouping: "positionTpsl",
  };

  const result: Record<string, any> = {
    eligible: true,
    status: CONFIG.LIVE_TRADING ? "LIVE_READY" : "DRY_RUN_READY",
    reason: "NEW_65_CROSSING",
    live_trading: CONFIG.LIVE_TRADING,
    exchange_request_sent: false,

    signal: {
      crossing_id: signal.crossing_id ?? null,
      episode_id: signal.episode_id ?? null,
      crossing_ts: Number.isFinite(crossingTs) ? crossingTs : null,
      execution_context: executionContext,
      coin,
      side,
      score,
      signal_price: entryPrice,
    },

    execution: {
      asset,
      sz_decimals: szDecimals,
      margin_usd: CONFIG.MARGIN_USD,
      leverage: CONFIG.LEVERAGE,
      leverage_type: desiredLeverageType,
      leverage_policy: "AUTO_ENSURE_BEFORE_ENTRY",
      current_exchange_leverage: {
        type: currentLeverageType || null,
        value: Number.isFinite(currentLeverageValue) ? currentLeverageValue : null,
      },
      leverage_already_correct: leverageAlreadyCorrect,
      leverage_update_required: !leverageAlreadyCorrect,
      position_usd_target: positionUsdTarget,
      entry_mode: "MARKETABLE_IOC",
      entry_price_source: "CURRENT_HYPERLIQUID_MID_FALLBACK_MARK",
      market_reference_price: marketReferenceWire,
      max_entry_slippage_pct: CONFIG.MAX_ENTRY_SLIPPAGE_PCT,
      ioc_limit_price: iocLimitWire,
      size: sizeWire,
      estimated_notional_usd: Number(estimatedNotionalUsd.toFixed(8)),
      take_profit_pct: takeProfitPct,
      stop_loss_pct: stopLossPct,
      tpsl_price_source_live: "ACTUAL_FILL_PRICE",
      preview_fill_price: marketReferenceWire,
      preview_take_profit_trigger: previewTpWire,
      preview_stop_loss_trigger: previewSlWire,
      trade_policy: "ONE_TRADE_PER_COIN_PER_EPISODE",
      idempotency_policy: "D1_CROSSING_AND_EPISODE_UNIQUE",
      freshness_policy: {
        max_signal_age_ms: CONFIG.MAX_SIGNAL_AGE_MS,
        signal_age_ms: signalAgeMs,
        fresh_for_live_entry: signalFresh,
      },
      mark_px: contexts?.[asset]?.markPx ?? null,
      mid_px: contexts?.[asset]?.midPx ?? null,
    },

    action_preview: {
      step_0_leverage: leverageAlreadyCorrect
        ? { action: "NONE", reason: "ALREADY_CONFIGURED" }
        : leverageAction,
      step_1_entry: entryAction,
      step_2_after_confirmed_fill: previewProtectionAction,
      note: "LIVE guarantees configured leverage before ENTRY. DRY RUN does not change leverage. TP/SL are recalculated from actual fill price in LIVE mode.",
    },

    safety: {
      live_trading: CONFIG.LIVE_TRADING,
      signing_performed: false,
      exchange_endpoint_called: false,
      private_key_exposed: false,
    },

    timestamp: new Date().toISOString(),
  };
  // Normal operating mode: full payload is built, but no secret is read,
  // no signature is created and /exchange is never called.
  if (!CONFIG.LIVE_TRADING) return result;

  // The status endpoint is permanently read-only. This prevents a browser
  // refresh of /hyperliquid-execution from ever becoming an order trigger.
  if (executionContext !== "SIGNAL_PIPELINE") {
    return {
      ...result,
      eligible: false,
      status: "BLOCKED",
      reason: "READ_ONLY_CONTEXT_LIVE_EXECUTION_FORBIDDEN",
    };
  }

  // A live entry must come from a fresh crossing created by the current
  // signal-processing run. Old database rows can never be executed.
  if (!signalFresh) {
    return {
      ...result,
      eligible: false,
      status: "BLOCKED",
      reason: "STALE_OR_MISSING_CROSSING_TIMESTAMP",
      freshness: {
        crossing_ts: Number.isFinite(crossingTs) ? crossingTs : null,
        signal_age_ms: signalAgeMs,
        max_signal_age_ms: CONFIG.MAX_SIGNAL_AGE_MS,
      },
    };
  }

  const secret = normalizePrivateKey(env?.HYPERLIQUID_API_PRIVATE_KEY);
  if (!privateKeyFormatOk(secret)) {
    return {
      ...result,
      status: "BLOCKED",
      reason: "HYPERLIQUID_API_PRIVATE_KEY_MISSING_OR_INVALID",
    };
  }

  const claim = await claimExecutionOnce(env?.DB, signal, coin, side);
  if (!claim.claimed) {
    return {
      ...result,
      eligible: false,
      status: "BLOCKED",
      reason:
        claim?.existing?.status === "MISSING_EXECUTION_IDENTITY"
          ? "MISSING_EXECUTION_IDENTITY"
          : "EXECUTION_ALREADY_CLAIMED",
      execution_ledger: claim.existing ?? null,
    };
  }

  async function sendSignedAction(action: Record<string, any>) {
    const nonce = Date.now();
    const signed = await signHyperliquidAction(action, nonce, secret as `0x${string}`);
    const res = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action,
        nonce,
        signature: signed.signature,
        vaultAddress: null,
      }),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { nonce, actionHash: signed.actionHash, httpStatus: res.status, text, json };
  }

  // Guarantee the configured leverage for THIS coin before any order is sent.
  // If the exchange does not confirm the update, do not send ENTRY.
  let leverageResponse: any = null;
  if (!leverageAlreadyCorrect) {
    try {
      leverageResponse = await sendSignedAction(leverageAction);
    } catch (e: any) {
      await updateExecutionLedger(env?.DB, signal.crossing_id, "LEVERAGE_ERROR", {
        last_error: e?.message ?? String(e),
      });
      return {
        ...result,
        status: "LIVE_LEVERAGE_UPDATE_TRANSPORT_ERROR",
        reason: e?.message ?? String(e),
        exchange_request_sent: true,
        live_leverage: { updated: false, required: true },
        safety: {
          live_trading: true,
          signing_performed: true,
          exchange_endpoint_called: true,
          private_key_exposed: false,
        },
        timestamp: new Date().toISOString(),
      };
    }

    const leverageAccepted =
      leverageResponse?.httpStatus >= 200 &&
      leverageResponse?.httpStatus < 300 &&
      leverageResponse?.json?.status === "ok";

    if (!leverageAccepted) {
      return {
        ...result,
        status: "LIVE_LEVERAGE_UPDATE_REJECTED",
        reason: "LEVERAGE_NOT_CONFIRMED_ENTRY_BLOCKED",
        exchange_request_sent: true,
        live_leverage: {
          updated: false,
          required: true,
          http_status: leverageResponse?.httpStatus ?? null,
          response_json: leverageResponse?.json ?? null,
        },
        safety: {
          live_trading: true,
          signing_performed: true,
          exchange_endpoint_called: true,
          private_key_exposed: false,
        },
        timestamp: new Date().toISOString(),
      };
    }
  }

  let entryResponse: any;
  try {
    entryResponse = await sendSignedAction(entryAction);
  } catch (e: any) {
    await updateExecutionLedger(env?.DB, signal.crossing_id, "ENTRY_ERROR", {
      last_error: e?.message ?? String(e),
    });
    return {
      ...result,
      status: "LIVE_ENTRY_TRANSPORT_ERROR",
      reason: e?.message ?? String(e),
      exchange_request_sent: true,
      safety: {
        live_trading: true,
        signing_performed: true,
        exchange_endpoint_called: true,
        private_key_exposed: false,
      },
    };
  }

  const entryStatuses = entryResponse?.json?.response?.data?.statuses ?? null;
  const entryStatus = Array.isArray(entryStatuses) ? entryStatuses[0] : null;
  const fill = entryStatus?.filled ?? null;
  const entryError = entryStatus?.error ?? null;

  if (!fill || entryError) {
    await updateExecutionLedger(
      env?.DB,
      signal.crossing_id,
      entryError ? "ENTRY_REJECTED" : "ENTRY_NOT_FILLED",
      { last_error: entryError ?? "IOC_NOT_FILLED" }
    );
    return {
      ...result,
      status: entryError ? "LIVE_ENTRY_REJECTED" : "LIVE_ENTRY_NOT_FILLED",
      reason: entryError ?? "IOC_NOT_FILLED",
      exchange_request_sent: true,
      live_entry: {
        http_status: entryResponse.httpStatus,
        response_json: entryResponse.json,
        returned_statuses: entryStatuses,
        filled: false,
        error: entryError,
      },
      safety: {
        live_trading: true,
        signing_performed: true,
        exchange_endpoint_called: true,
        private_key_exposed: false,
      },
      timestamp: new Date().toISOString(),
    };
  }

  const fillPrice = Number(fill.avgPx ?? fill.px ?? fill.price);
  const fillSize = Number(fill.totalSz ?? fill.sz ?? sizeWire);
  if (!Number.isFinite(fillPrice) || fillPrice <= 0 || !Number.isFinite(fillSize) || fillSize <= 0) {
    await updateExecutionLedger(env?.DB, signal.crossing_id, "ENTRY_FILL_INVALID", {
      last_error: "INVALID_FILL_DATA",
    });
    return {
      ...result,
      status: "LIVE_ENTRY_FILLED_BUT_FILL_DATA_INVALID",
      exchange_request_sent: true,
      live_entry: { response_json: entryResponse.json, fill },
      safety: {
        live_trading: true,
        signing_performed: true,
        exchange_endpoint_called: true,
        private_key_exposed: false,
      },
    };
  }

  await updateExecutionLedger(env?.DB, signal.crossing_id, "ENTRY_FILLED", {
    entry_fill_price: fillPrice,
    entry_fill_size: fillSize,
    entry_oid: fill?.oid ?? null,
    last_error: null,
  });

  const actualSizeWire = toWire(fillSize, szDecimals);
  const tpRaw = isLong
    ? fillPrice * (1 + takeProfitPct / 100)
    : fillPrice * (1 - takeProfitPct / 100);
  const slRaw = isLong
    ? fillPrice * (1 - stopLossPct / 100)
    : fillPrice * (1 + stopLossPct / 100);
  const tpWire = priceToWire(tpRaw, szDecimals);
  const slWire = priceToWire(slRaw, szDecimals);

  const tpOrder = {
    a: asset,
    b: closeIsBuy,
    p: tpWire,
    s: actualSizeWire,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: tpWire, tpsl: "tp" } },
  };
  const slOrder = {
    a: asset,
    b: closeIsBuy,
    p: slWire,
    s: actualSizeWire,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: slWire, tpsl: "sl" } },
  };
  const protectionAction = {
    type: "order",
    orders: [tpOrder, slOrder],
    grouping: "positionTpsl",
  };

  let protectionResponse: any;
  try {
    protectionResponse = await sendSignedAction(protectionAction);
  } catch (e: any) {
    await updateExecutionLedger(env?.DB, signal.crossing_id, "TPSL_ERROR", {
      last_error: e?.message ?? String(e),
    });
    return {
      ...result,
      status: "LIVE_ENTRY_FILLED_TPSL_TRANSPORT_ERROR",
      reason: e?.message ?? String(e),
      exchange_request_sent: true,
      live_entry: { filled: true, fill_price: fillPrice, fill_size: actualSizeWire, fill },
      safety: {
        live_trading: true,
        signing_performed: true,
        exchange_endpoint_called: true,
        private_key_exposed: false,
      },
      timestamp: new Date().toISOString(),
    };
  }

  const protectionStatuses = protectionResponse?.json?.response?.data?.statuses ?? null;
  const protectionErrors = Array.isArray(protectionStatuses)
    ? protectionStatuses.map((x: any) => x?.error ?? null).filter(Boolean)
    : [];

  await updateExecutionLedger(
    env?.DB,
    signal.crossing_id,
    protectionErrors.length ? "TPSL_REJECTED" : "PROTECTED",
    { last_error: protectionErrors.length ? protectionErrors.join(" | ") : null }
  );

  return {
    ...result,
    status: protectionErrors.length ? "LIVE_ENTRY_FILLED_TPSL_REJECTED" : "LIVE_ENTRY_FILLED_TPSL_SUBMITTED",
    exchange_request_sent: true,
    live_leverage: {
      required: !leverageAlreadyCorrect,
      updated: leverageAlreadyCorrect ? false : true,
      already_correct: leverageAlreadyCorrect,
      target: { type: desiredLeverageType, value: CONFIG.LEVERAGE },
    },
    live_entry: {
      filled: true,
      fill_price: fillPrice,
      fill_size: actualSizeWire,
      fill_notional_usd: Number((fillPrice * fillSize).toFixed(8)),
      oid: fill?.oid ?? null,
      http_status: entryResponse.httpStatus,
      returned_statuses: entryStatuses,
    },
    live_tpsl: {
      price_source: "ACTUAL_FILL_PRICE",
      take_profit_pct: takeProfitPct,
      take_profit_trigger: tpWire,
      stop_loss_pct: stopLossPct,
      stop_loss_trigger: slWire,
      grouping: "positionTpsl",
      http_status: protectionResponse.httpStatus,
      returned_statuses: protectionStatuses,
      errors: protectionErrors,
    },
    safety: {
      live_trading: true,
      signing_performed: true,
      exchange_endpoint_called: true,
      private_key_exposed: false,
    },
    timestamp: new Date().toISOString(),
  };
}
