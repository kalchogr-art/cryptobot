import type {Candle as CandidateCandle} from '../swing-hunter/types';
import {structure as candidateStructure} from '../swing-hunter/market-structure';
import {detectCatalog as candidateDetectCatalog,PatternCompareV2 as CandidatePatternCompareV2,detectClassicalCatalog as candidateDetectClassicalCatalog} from '../swing-hunter/pattern-catalog';
import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ============================================================
// HYPERLIQUID SIGNAL EXECUTION V2.13.1 — LONG SCALE-OUT LIFECYCLE FILL FIX
// SWING VARIANT A: New queued Swing trades TP +0.5% / SL -1.0%; existing positions unchanged; atomic exit notification claim.
// V2.17.2: FIX BTC5M/BTC10M progressive + 3m lifecycle allowlists, diagnostic and batch priority.
// V2.17.1: BTC5M/BTC10M strategy metadata support; BTC1M/BTC3M/BTC5M/BTC10M share the proven Progressive + 3M fallback lifecycle.
// V2.17.0: BTC3M LIVE strategy metadata support; BTC1M + BTC3M share the proven Progressive + 3M fallback lifecycle.
// V2.16.9: LIFECYCLE HEALTH WATCHDOG — alerts/persists Progressive failures without changing strategy.
// V2.16.3: BTC1M DIRECTIONAL SYNC — strategy metadata/lifecycle synced to Index V1.11.44; FAST D1 + latency audit preserved.
// V2.16.2: FAST D1 CLAIM — duplicate guard remains atomic; schema migration removed from hot entry path.
// V2.16.1: EXECUTION LATENCY AUDIT — timing only; LIVE strategy/order logic unchanged.
// V2.16.0: LIVE 3-minute scalp protection + existing 100% Progressive Profit Lock.
// First 180s: Initial SL -0.20%. At >=180s once: ROI<0 MARKET; 0..0.20 BE; 0.20..<0.25 lock +0.20; >=0.25 existing Progressive.
// No fixed TP. Progressive remains +0.25% => lock +0.20%; every next +0.10% => lock +0.10% higher, no ceiling.
// Tracks virtual +0.20%, MFE, TP20->NO_TP25 control cohort, real lock stages and live stop replacement.
// V2.13.1: lifecycle final-close classification uses the LAST real close fill, not the first.
// V2.13.1: TP stages are reconstructed from real Hyperliquid close fills + position size.
// V2.13.1: repairs missing partial_tp_* bookkeeping when progressive_stage already proves TP1 rearm.
// V2.16.3: activeAssetData INFO 429 retry/backoff + cache retained; BTC1M LIVE supports both LONG and SHORT.
// FRESH+D1 -> AUTO LEVERAGE -> IOC FILL -> TP/SL RETRY -> BALANCE -> TELEGRAM
//
// COMPLETE EXECUTION PATH:
// - LIVE_TRADING is FALSE by default.
// V2.7.2:
 // - ENTRY balance guard now uses Hyperliquid activeAssetData.availableToTrade for the exact coin/side.
 // - clearinghouseState.withdrawable is no longer used as the live ENTRY availability source.
 // - Account snapshots also expose USDC token state for diagnostics/Telegram.
 // - Guard fails closed if activeAssetData is unavailable or malformed.
 //
 // V2.7.1:
// - Lifecycle Telegram reports Gross P/L, fees and NET P/L when fills are available.
// - MAX HOLD derives P/L from the confirmed close fill when exchange response omits closedPnl.
// - MAX HOLD persists realized P/L in D1.
// - Lifecycle signed actions use a monotonic nonce.
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

// REAL TRADING CONTROL — change these two values, then deploy.
// false = no NEW live entries; true = allow NEW live entries.
// Existing positions/orders are NOT cancelled by these switches.
const FAST_TRADING_ENABLED = false;  // FAST / SCALP
const SWING_TRADING_ENABLED = true; // SWING LONG + SHORT; enable only after validation

const CONFIG = {
  LIVE_TRADING: FAST_TRADING_ENABLED,

  MIN_SIGNAL_SCORE: 0,

  // Strategy reference: $1.04 × 10x = $10.40 target notional.
  // V2.10.2 keeps this notional fixed when an asset supports <10x.
  BASE_MARGIN_USD: 1.04,
  TARGET_LEVERAGE: 10,
  IS_CROSS: true,

  LONG_TAKE_PROFIT_PCT: 0.20,
  LONG_TP2_PCT: 0.30,
  LONG_TP3_PCT: 0.40,
  PARTIAL_TP_FRACTION: 0.50,
  LONG_STOP_LOSS_PCT: 0.20,
  SHORT_TAKE_PROFIT_PCT: 0.20,
  SHORT_STOP_LOSS_PCT: 0.20,

  // V2.10.5 symmetric LONG/SHORT protection:
  // 1) Initial SL = -0.20%.
  // 2) +0.25% -> SL at ENTRY (break-even).
  // 3) +0.50% is the existing 50% final TP. Only AFTER that fill is confirmed
  //    may Stage 2 replace the runner SL with +0.25%.
  // 4) +0.75% -> runner SL +0.50%, then continue the wider runner ladder.
  // V2.15.0: stage 1 = +0.25 trigger / +0.20 locked.
  // Every additional +0.10% of favorable movement raises the locked floor by +0.10%.
  // The ladder is generated mathematically, so there is no fixed upper ceiling.
  PROGRESSIVE_FIRST_TRIGGER_PCT: 0.25,
  PROGRESSIVE_FIRST_STOP_PCT: 0.20,
  PROGRESSIVE_STEP_PCT: 0.10,
  VIRTUAL_TP20_PCT: 0.20,

  // V2.16.0 one-shot scalp protection. Decision is taken on the first LIVE lifecycle tick at/after 180s.
  THREE_MIN_PROTECTION_MS: 180_000,
  THREE_MIN_BE_MAX_PCT: 0.20,
  THREE_MIN_LOCK20_MAX_PCT: 0.25,
  THREE_MIN_LOCK20_STOP_PCT: 0.20,


  MAX_ENTRY_SLIPPAGE_PCT: 0.30,
  TIF: "Ioc" as const,

  // A real entry is allowed only immediately after a newly-created crossing.
  // Old crossings may still be previewed by the read-only endpoint, but can
  // never reach /exchange.
  MAX_SIGNAL_AGE_MS: 120_000,

  // Protection: initial TP/SL request + 3 retries = max 4 attempts.
  TPSL_MAX_ATTEMPTS: 4,
  TPSL_RETRY_DELAY_MS: 500,

  // Position lifecycle safety.
  MAX_HOLD_MS: 30 * 60 * 1000,
  MIN_MARGIN_HEADROOM_USD: 0.01,
};

export type HyperliquidExecutionEnv = {
  HYPERLIQUID_API_PRIVATE_KEY?: string;
  DB?: any;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
};

export type HyperliquidExecutionSignal = {
  coin: string;
  side: "LONG" | "SHORT";
  score: number;
  price: number;
  crossing_id?: number | string | null;
  episode_id?: number | string | null;
  crossing_ts?: number | null;
  setup_name?: "A" | "B1" | "B2" | "B3" | string | null;
  strategy_version?: string | null;

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

  // V2.10.3 CRITICAL PRICE-WIRE FIX:
  // Trim zeroes only from the fractional part. Integer trailing zeroes are
  // significant and MUST survive (84620 must remain "84620", never "8462").
  const fixed = value.toFixed(decimals);
  const dot = fixed.indexOf(".");
  if (dot < 0) return fixed;

  const integerPart = fixed.slice(0, dot);
  const fractionalPart = fixed.slice(dot + 1).replace(/0+$/, "");
  return fractionalPart ? `${integerPart}.${fractionalPart}` : integerPart;
}

function bestValidSize(
  targetSize: number,
  price: number,
  szDecimals: number,
  targetNotionalUsd: number
): number {
  const scale = 10 ** szDecimals;
  const minSize = Math.ceil((10 / price) * scale - 1e-12) / scale;

  const floorSize = Math.floor(targetSize * scale + 1e-12) / scale;
  const ceilSize = Math.ceil(targetSize * scale - 1e-12) / scale;

  const candidates = [floorSize, ceilSize, minSize]
    .filter((v, i, a) => v > 0 && v * price >= 10 && a.indexOf(v) === i);

  if (!candidates.length) return minSize;

  return candidates.reduce((best, current) =>
    Math.abs(current * price - targetNotionalUsd) <
    Math.abs(best * price - targetNotionalUsd)
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

// Read-only Hyperliquid /info guard. Never retries signed exchange writes.
let infoRateLimitUntil = 0;
const INFO_429_WAIT_MS = 2500;
// Deduplicate only concurrent non-order /info reads. Never cache open orders,
// order status, fills or protection checks: they must see fresh exchange state.
const swingSharedInfoReads = new Map<string, Promise<any>>();
async function postInfo(body: Record<string, any>): Promise<any> {
  const type = String(body.type ?? '');
  const shareable = type === 'allMids' || type === 'metaAndAssetCtxs' || type === 'clearinghouseState';
  const key = shareable ? JSON.stringify(body) : '';
  if (shareable) {
    const existing = swingSharedInfoReads.get(key);
    if (existing) return existing;
    const pending = postInfoDirect(body).finally(() => { swingSharedInfoReads.delete(key); });
    swingSharedInfoReads.set(key, pending);
    return pending;
  }
  return postInfoDirect(body);
}
async function postInfoDirect(body: Record<string, any>): Promise<any> {
  // One bounded retry only; subsequent calls respect a shared in-isolate cooldown.
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = infoRateLimitUntil - Date.now();
    if (wait > 0) await new Promise<void>(resolve => setTimeout(resolve, Math.min(wait, 8000)));
    const res = await fetch(INFO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseText = await res.text();
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8000) : INFO_429_WAIT_MS * (attempt + 1);
      infoRateLimitUntil = Math.max(infoRateLimitUntil, Date.now() + backoff);
      if (attempt === 0) continue;
      throw new Error(`INFO_HTTP_429: RATE_LIMITED_READ_ONLY (${String(body.type || 'unknown')})`);
    }
    if (!res.ok) throw new Error(`INFO_HTTP_${res.status}: ${responseText.slice(0, 300)}`);
    return JSON.parse(responseText);
  }
  throw new Error('INFO_HTTP_429: RATE_LIMITED_READ_ONLY');
}

export async function getHyperliquidOrderWireAudit(limit = 500): Promise<any> {
  const safeLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 500)));

  const settled = await Promise.allSettled([
    postInfo({ type: "frontendOpenOrders", user: MASTER_ACCOUNT }),
    postInfo({ type: "historicalOrders", user: MASTER_ACCOUNT }),
  ]);

  const openOrders =
    settled[0].status === "fulfilled" && Array.isArray(settled[0].value)
      ? settled[0].value
      : [];
  const historicalAll =
    settled[1].status === "fulfilled" && Array.isArray(settled[1].value)
      ? settled[1].value
      : [];
  const historicalOrders = historicalAll.slice(-safeLimit);

  type AuditRow = {
    source: string;
    coin: string | null;
    oid: string | number | null;
    status: string | null;
    timestamp: number | null;
    order_type: string | null;
    trigger_px: number | null;
    limit_px: number | null;
    suspicious: boolean;
    reason: string | null;
    raw: any;
  };

  const normalize = (row: any, source: string): AuditRow => {
    const order = row?.order ?? row ?? {};
    const trigger = Number(order?.triggerPx ?? order?.trigger_px);
    const limit = Number(order?.limitPx ?? order?.limit_px);
    const orderType =
      order?.orderType ?? order?.order_type ?? order?.tpsl ?? order?.type ?? null;

    return {
      source,
      coin: order?.coin != null ? String(order.coin) : null,
      oid: order?.oid ?? null,
      status: row?.status != null
        ? String(row.status)
        : (order?.status != null ? String(order.status) : null),
      timestamp: Number.isFinite(Number(row?.statusTimestamp ?? order?.timestamp))
        ? Number(row?.statusTimestamp ?? order?.timestamp)
        : null,
      order_type: orderType != null ? String(orderType) : null,
      trigger_px: Number.isFinite(trigger) && trigger > 0 ? trigger : null,
      limit_px: Number.isFinite(limit) && limit > 0 ? limit : null,
      suspicious: false,
      reason: null,
      raw: row,
    };
  };

  const rows: AuditRow[] = [
    ...openOrders.map((x: any) => normalize(x, "OPEN")),
    ...historicalOrders.map((x: any) => normalize(x, "HISTORICAL")),
  ];

  // Detect decade-scale outliers per coin. This is the signature produced by
  // the old integer-zero stripping bug (e.g. BTC ~84620 accidentally sent as 8462).
  const pricesByCoin = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.coin) continue;
    const p = r.trigger_px ?? r.limit_px;
    if (!Number.isFinite(p) || Number(p) <= 0) continue;
    const arr = pricesByCoin.get(r.coin) ?? [];
    arr.push(Number(p));
    pricesByCoin.set(r.coin, arr);
  }

  for (const r of rows) {
    if (!r.coin) continue;
    const p = r.trigger_px ?? r.limit_px;
    if (!Number.isFinite(p) || Number(p) <= 0) continue;
    const vals = (pricesByCoin.get(r.coin) ?? [])
      .filter(v => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    if (vals.length < 2) continue;
    const median = vals[Math.floor(vals.length / 2)];
    const ratio = Number(p) / median;
    if (ratio < 0.2 || ratio > 5) {
      r.suspicious = true;
      r.reason = `DECADE_PRICE_OUTLIER ratio=${ratio.toFixed(6)}`;
    }
  }

  const suspicious = rows.filter(r => r.suspicious);

  return {
    success: true,
    read_only: true,
    version: "V2.16.5 PROGRESSIVE SELF-HEALING + 3M FALLBACK",
    account: MASTER_ACCOUNT,
    wire_fix: {
      fixed: true,
      example_before: '84620 -> "8462"',
      example_after: '84620 -> "84620"',
    },
    sources: {
      frontend_open_orders: settled[0].status === "fulfilled" ? "OK" : "ERROR",
      historical_orders: settled[1].status === "fulfilled" ? "OK" : "ERROR",
    },
    counts: {
      open: openOrders.length,
      historical_scanned: historicalOrders.length,
      total: rows.length,
      suspicious: suspicious.length,
    },
    suspicious,
    orders: rows,
  };
}



function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeTelegramHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegram(
  env: HyperliquidExecutionEnv | undefined,
  text: string
): Promise<{ sent: boolean; reason?: string; http_status?: number; response?: any }> {
  const token = String(env?.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = String(env?.TELEGRAM_CHAT_ID ?? "").trim();

  if (!token || !chatId) {
    return { sent: false, reason: "TELEGRAM_SECRETS_NOT_CONFIGURED" };
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });

    const raw = await res.text();
    let json: any = null;
    try { json = raw ? JSON.parse(raw) : null; } catch {}

    return {
      sent: res.ok && json?.ok === true,
      http_status: res.status,
      response: json,
      reason: res.ok && json?.ok === true ? undefined : "TELEGRAM_SEND_FAILED",
    };
  } catch (e: any) {
    return { sent: false, reason: e?.message ?? String(e) };
  }
}

async function getAccountSnapshot(): Promise<any> {
  try {
    const [state, tokenState] = await Promise.all([
      postInfo({
        type: "clearinghouseState",
        user: MASTER_ACCOUNT,
      }),
      postInfo({
        type: "spotClearinghouseState",
        user: MASTER_ACCOUNT,
      }).catch(() => null),
    ]);

    const accountValue = Number(state?.marginSummary?.accountValue);
    const totalMarginUsed = Number(state?.marginSummary?.totalMarginUsed);
    const withdrawable = Number(state?.withdrawable);

    const balances = Array.isArray(tokenState?.balances) ? tokenState.balances : [];
    const usdc = balances.find(
      (x: any) => String(x?.coin ?? "").toUpperCase() === "USDC"
    );
    const usdcTotal = Number(usdc?.total);
    const usdcHold = Number(usdc?.hold);

    return {
      success: true,
      account_value_usd: Number.isFinite(accountValue) ? accountValue : null,
      margin_used_usd: Number.isFinite(totalMarginUsed) ? totalMarginUsed : null,
      withdrawable_usd: Number.isFinite(withdrawable) ? withdrawable : null,
      usdc_total: Number.isFinite(usdcTotal) ? usdcTotal : null,
      usdc_hold: Number.isFinite(usdcHold) ? usdcHold : null,
    };
  } catch (e: any) {
    return {
      success: false,
      error: e?.message ?? String(e),
      account_value_usd: null,
      margin_used_usd: null,
      withdrawable_usd: null,
      usdc_total: null,
      usdc_hold: null,
    };
  }
}

const ACTIVE_ASSET_CACHE_TTL_MS = 15_000;
const activeAssetAvailabilityCache = new Map<string, { ts: number; value: any }>();

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postActiveAssetDataWith429Retry(coin: string): Promise<any> {
  // Keep this retry local to the entry-critical endpoint. We intentionally do not
  // retry every /info request globally because that could amplify rate limiting.
  const delays = [0, 1000, 3000, 7000];
  let lastError: any = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await sleepMs(delays[attempt]);
    try {
      return await postInfo({ type: "activeAssetData", user: MASTER_ACCOUNT, coin });
    } catch (e: any) {
      lastError = e;
      const msg = String(e?.message ?? e);
      if (!msg.includes("INFO_HTTP_429") || attempt === delays.length - 1) throw e;
    }
  }
  throw lastError ?? new Error("ACTIVE_ASSET_DATA_RETRY_FAILED");
}

async function getActiveAssetTradingAvailability(
  coin: string,
  side: "LONG" | "SHORT"
): Promise<any> {
  const cacheKey = `${coin}:${side}`;
  const cached = activeAssetAvailabilityCache.get(cacheKey);
  if (cached && Date.now() - cached.ts <= ACTIVE_ASSET_CACHE_TTL_MS) {
    return { ...cached.value, source: "HYPERLIQUID_ACTIVE_ASSET_DATA_CACHE", cache_age_ms: Date.now() - cached.ts };
  }
  try {
    const data = await postActiveAssetDataWith429Retry(coin);

    const available = Array.isArray(data?.availableToTrade)
      ? data.availableToTrade
      : [];
    const maxTrade = Array.isArray(data?.maxTradeSzs)
      ? data.maxTradeSzs
      : [];

    // Hyperliquid returns two directional values. LONG uses the buy-side
    // availability (index 0), SHORT uses the sell-side availability (index 1).
    const sideIndex = side === "LONG" ? 0 : 1;
    const availableToTrade = Number(available[sideIndex]);
    const maxTradeSz = Number(maxTrade[sideIndex]);
    const markPx = Number(data?.markPx);

    if (!Number.isFinite(availableToTrade)) {
      return {
        success: false,
        error: "ACTIVE_ASSET_AVAILABLE_TO_TRADE_INVALID",
        coin,
        side,
        raw: data,
      };
    }

    const value = {
      success: true,
      source: "HYPERLIQUID_ACTIVE_ASSET_DATA",
      coin,
      side,
      side_index: sideIndex,
      available_to_trade: availableToTrade,
      available_to_trade_raw: available[sideIndex] ?? null,
      max_trade_sz: Number.isFinite(maxTradeSz) ? maxTradeSz : null,
      mark_px: Number.isFinite(markPx) ? markPx : null,
      leverage: data?.leverage ?? null,
      raw_available_to_trade: available,
      raw_max_trade_szs: maxTrade,
    };
    activeAssetAvailabilityCache.set(cacheKey, { ts: Date.now(), value });
    return value;
  } catch (e: any) {
    return {
      success: false,
      error: e?.message ?? String(e),
      coin,
      side,
    };
  }
}

function buildExecutionLatencyTelegramLines(a: any): string[] {
  const l = a?.latencyAudit ?? {};
  const signalTs = Number(a?.signalTs);
  const executionStartedAt = Number(l?.execution_started_at);
  const fillReceivedAt = Number(l?.fill_received_at);
  const signalPrice = Number(a?.signalPrice);
  const fillPrice = Number(a?.fillPrice);
  const side = String(a?.side ?? "").toUpperCase();

  const signalToExecutionMs =
    Number.isFinite(signalTs) && Number.isFinite(executionStartedAt)
      ? Math.max(0, executionStartedAt - signalTs)
      : NaN;
  const signalToFillMs =
    Number.isFinite(signalTs) && Number.isFinite(fillReceivedAt)
      ? Math.max(0, fillReceivedAt - signalTs)
      : NaN;
  const executionToFillMs =
    Number.isFinite(executionStartedAt) && Number.isFinite(fillReceivedAt)
      ? Math.max(0, fillReceivedAt - executionStartedAt)
      : NaN;

  let directionalMoveBeforeFillPct = NaN;
  if (Number.isFinite(signalPrice) && signalPrice > 0 && Number.isFinite(fillPrice) && fillPrice > 0) {
    directionalMoveBeforeFillPct =
      side === "SHORT"
        ? ((signalPrice - fillPrice) / signalPrice) * 100
        : ((fillPrice - signalPrice) / signalPrice) * 100;
  }

  const ms = (v: any) => Number.isFinite(Number(v)) ? `${Number(v)} ms` : "n/a";
  const sec = (v: any) => Number.isFinite(Number(v)) ? `${(Number(v) / 1000).toFixed(2)} s` : "n/a";

  return [
    `⏱ <b>EXECUTION LATENCY AUDIT</b>`,
    `Signal → execution: ${sec(signalToExecutionMs)}`,
    `META: ${ms(l?.meta_ms)}`,
    `ActiveAsset preview: ${ms(l?.active_asset_preview_ms)}`,
    `D1 claim: ${ms(l?.claim_ms)}`,
    `Availability: ${ms(l?.availability_ms)}`,
    `Account snapshot: ${ms(l?.account_snapshot_ms)}`,
    `Exposure check: ${ms(l?.exposure_check_ms)}`,
    `Leverage: ${ms(l?.leverage_ms)}`,
    `IOC → fill: ${ms(l?.ioc_ms)}`,
    `Execution → fill: ${sec(executionToFillMs)}`,
    `Signal → fill: ${sec(signalToFillMs)}`,
    `Signal px: ${Number.isFinite(signalPrice) ? signalPrice : "n/a"} → Fill: ${Number.isFinite(fillPrice) ? fillPrice : "n/a"}`,
    `Move before fill: ${Number.isFinite(directionalMoveBeforeFillPct) ? `${directionalMoveBeforeFillPct >= 0 ? "+" : ""}${directionalMoveBeforeFillPct.toFixed(4)}%` : "n/a"} (${side || "n/a"})`,
  ];
}

function buildEntryTelegramMessage(args: {
  coin: string;
  side: string;
  score: number;
  crossingId: any;
  episodeId: any;
  marginUsd: number;
  leverage: number;
  leverageType: string;
  fillPrice: number;
  fillSize: string;
  fillNotional: number;
  tpWire: string;
  slWire: string;
  takeProfitPct: number;
  stopLossPct: number;
  protectionOk: boolean;
  protectionAttempts: number;
  balance: any;
  latencyAudit?: any;
  signalTs?: number | null;
  signalPrice?: number | null;
}): string {
  const a = args;
  const protection = a.protectionOk
    ? `✅ CONFIRMED (${a.protectionAttempts}/${CONFIG.TPSL_MAX_ATTEMPTS})`
    : `🚨 FAILED (${a.protectionAttempts}/${CONFIG.TPSL_MAX_ATTEMPTS})`;
  const requestedNotional = a.marginUsd * a.leverage;
  const fillRatio = requestedNotional > 0 ? a.fillNotional / requestedNotional : 1;
  const partialLine = fillRatio < 0.98
    ? `⚠️ PARTIAL FILL: ${(fillRatio * 100).toFixed(1)}% of requested notional`
    : `✅ FULL FILL`;

  const bal = a.balance?.success
    ? [
        `💵 <b>ACCOUNT</b>`,
        `Equity: $${Number(a.balance.account_value_usd ?? 0).toFixed(4)}`,
        `Margin used: $${Number(a.balance.margin_used_usd ?? 0).toFixed(4)}`,
        `Withdrawable: $${Number(a.balance.withdrawable_usd ?? 0).toFixed(4)}`,
        `USDC state: $${Number(a.balance.usdc_total ?? 0).toFixed(6)}`,
      ].join("\n")
    : `💵 <b>ACCOUNT</b>\nBalance unavailable`;

  return [
    `🚀 <b>HYPERLIQUID ENTRY</b>`,
    ``,
    `🪙 <b>${escapeTelegramHtml(a.coin)}</b>`,
    `${a.side === "LONG" ? "📈" : "📉"} ${escapeTelegramHtml(a.side)}`,
    `🔥 Signal: ${a.score.toFixed(2)}/100`,
    `🆔 Crossing: ${escapeTelegramHtml(a.crossingId)}`,
    `🔄 Episode: ${escapeTelegramHtml(a.episodeId)}`,
    ``,
    `💰 Margin: $${a.marginUsd.toFixed(2)}`,
    `⚙️ Leverage: ${escapeTelegramHtml(a.leverageType)} ${a.leverage}x`,
    `📊 Requested notional: $${requestedNotional.toFixed(4)}`,
    `📊 Filled notional: $${a.fillNotional.toFixed(4)}`,
    partialLine,
    ``,
    `🎯 <b>ENTRY</b>`,
    `Fill: ${a.fillPrice}`,
    `Size: ${escapeTelegramHtml(a.fillSize)} ${escapeTelegramHtml(a.coin)}`,
    ``,
    `🔭 Virtual TP control: +0.20% (NO close order)`,
    `🔴 SL 100%: ${escapeTelegramHtml(a.slWire)} (${a.stopLossPct.toFixed(2)}%)`,
    `🔒 Progressive: +0.25→lock +0.20; then every +0.10→lock +0.10 higher`,
    `🛡 TP/SL: ${protection}`,
    ``,
    ...buildExecutionLatencyTelegramLines({
      latencyAudit: a.latencyAudit,
      signalTs: a.signalTs,
      signalPrice: a.signalPrice,
      fillPrice: a.fillPrice,
      side: a.side,
    }),
    ``,
    bal,
    ``,
    `🕐 ${new Date().toISOString()}`,
  ].join("\n");
}


function buildRejectedTelegramMessage(args: {
  coin: string;
  side: string;
  score: number;
  crossingId: any;
  episodeId: any;
  marginUsd: number;
  leverage: number;
  reason: string;
  balance: any;
}): string {
  const a = args;
  const bal = a.balance?.success
    ? [
        `💵 <b>ACCOUNT</b>`,
        `Equity: $${Number(a.balance.account_value_usd ?? 0).toFixed(4)}`,
        `Margin used: $${Number(a.balance.margin_used_usd ?? 0).toFixed(4)}`,
        `Withdrawable: $${Number(a.balance.withdrawable_usd ?? 0).toFixed(4)}`,
      ].join("\n")
    : `💵 <b>ACCOUNT</b>\nBalance unavailable`;

  return [
    `❌ <b>HYPERLIQUID ORDER REJECTED</b>`,
    ``,
    `🪙 <b>${escapeTelegramHtml(a.coin)}</b>`,
    `${a.side === "LONG" ? "📈" : "📉"} ${escapeTelegramHtml(a.side)}`,
    `🔥 Signal: ${a.score.toFixed(2)}/100`,
    `🆔 Crossing: ${escapeTelegramHtml(a.crossingId)}`,
    `🔄 Episode: ${escapeTelegramHtml(a.episodeId)}`,
    ``,
    `💰 Configured margin: $${a.marginUsd.toFixed(2)}`,
    `⚙️ Leverage: ${a.leverage}x`,
    `🚫 Reason: <b>${escapeTelegramHtml(a.reason)}</b>`,
    ``,
    bal,
    ``,
    `🕐 ${new Date().toISOString()}`,
  ].join("\n");
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
      entry_filled_at INTEGER,
      closed_at INTEGER,
      close_reason TEXT,
      exit_price REAL,
      realized_pnl REAL,
      three_min_decision_at INTEGER,
      three_min_action TEXT,
      three_min_roi_pct REAL,
      three_min_market_price REAL,
      three_min_stop_pct REAL,
      three_min_stop_price REAL,
      three_min_exit_at INTEGER,
      three_min_last_error TEXT,
      progressive_stage INTEGER DEFAULT 0,
      progressive_stop_pct REAL,
      progressive_stop_price REAL,
      progressive_stop_oid INTEGER,
      progressive_updated_at INTEGER,
      partial_tp_filled_at INTEGER,
      partial_tp_price REAL,
      partial_tp_size REAL,
      partial_tp_realized_pnl REAL,
      runner_active INTEGER DEFAULT 0,
      runner_size REAL,
      runner_max_return_pct REAL,
      strategy_version TEXT,
      setup_name TEXT,
      last_error TEXT
    )
  `).run();

  await db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_hl_execution_ledger_coin_status
    ON hyperliquid_execution_ledger (coin, status)
  `).run();

  // Safe schema upgrades for databases created by V2.5/V2.6.
  for (const sql of [
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN entry_filled_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN closed_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN close_reason TEXT",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN exit_price REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN realized_pnl REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN three_min_decision_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN three_min_action TEXT",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN three_min_roi_pct REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN three_min_market_price REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN three_min_stop_pct REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN three_min_stop_price REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN three_min_exit_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN three_min_last_error TEXT",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_stage INTEGER DEFAULT 0",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_stop_pct REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_stop_price REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_stop_oid INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_updated_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN partial_tp_filled_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN partial_tp_price REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN partial_tp_size REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN partial_tp_realized_pnl REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN runner_active INTEGER DEFAULT 0",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN runner_size REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN runner_max_return_pct REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN strategy_version TEXT",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN setup_name TEXT",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN virtual_tp20_hit_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN virtual_tp20_hit_price REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN max_favorable_return_pct REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN max_favorable_price REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN tp25_triggered_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN lock_trigger_pct REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN lock_requested_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN lock_confirmed_at INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN lock_latency_ms INTEGER"
  ]) {
    try { await db.prepare(sql).run(); } catch {}
  }
}

async function claimExecutionOnce(
  db: any,
  signal: HyperliquidExecutionSignal,
  coin: string,
  side: string
): Promise<{ claimed: boolean; existing?: any }> {
  // V2.16.2 FAST HOT PATH:
  // DO NOT run ensureExecutionLedger() here. It performs CREATE/ALTER schema
  // maintenance and was measured at ~12–14s inside every live entry.
  //
  // Safety is unchanged: INSERT OR IGNORE remains the atomic D1 duplicate
  // claim. The ledger schema is initialized by the normal non-hot-path
  // initialization/maintenance calls already present in this worker.
  //
  // Fail closed: if the table/schema is unexpectedly missing, this INSERT
  // throws and execution does NOT proceed to an exchange order.

  const crossingId = String(signal.crossing_id ?? "");
  const episodeId = String(signal.episode_id ?? "");
  const crossingTs = Number(signal.crossing_ts);

  if (!crossingId || !episodeId || !Number.isFinite(crossingTs)) {
    return { claimed: false, existing: { status: "MISSING_EXECUTION_IDENTITY" } };
  }

  const now = Date.now();
  let insert: any;
  try {
    insert = await db.prepare(`
      INSERT OR IGNORE INTO hyperliquid_execution_ledger (
        crossing_id, episode_id, coin, side, crossing_ts,
        status, claimed_at, updated_at, strategy_version, setup_name
      ) VALUES (?, ?, ?, ?, ?, 'CLAIMED', ?, ?, ?, ?)
    `).bind(
      crossingId,
      episodeId,
      coin,
      side,
      crossingTs,
      now,
      now,
      String(signal.strategy_version ?? 'BTC1M_DIRECTIONAL_V1'),
      String(signal.setup_name ?? '') || null
    ).run();
  } catch (e: any) {
    // Never bypass the duplicate guard. A D1/schema failure blocks entry.
    throw new Error(`FAST_D1_CLAIM_FAILED: ${e?.message ?? String(e)}`);
  }

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


async function getOpenPositionForCoin(coin: string): Promise<any | null> {
  const state = await postInfo({ type: "clearinghouseState", user: MASTER_ACCOUNT });
  const positions = Array.isArray(state?.assetPositions) ? state.assetPositions : [];
  for (const row of positions) {
    const p = row?.position ?? row;
    if (String(p?.coin ?? "").toUpperCase() !== coin) continue;
    const szi = Number(p?.szi);
    if (Number.isFinite(szi) && Math.abs(szi) > 0) return p;
  }
  return null;
}

async function getOpenOrdersForCoin(coin: string): Promise<any[]> {
  const rows = await postInfo({ type: "openOrders", user: MASTER_ACCOUNT });
  return Array.isArray(rows)
    ? rows.filter((x: any) => String(x?.coin ?? "").toUpperCase() === coin)
    : [];
}

async function getRecentFillsForCoin(coin: string): Promise<any[]> {
  try {
    const rows = await postInfo({ type: "userFills", user: MASTER_ACCOUNT });
    return Array.isArray(rows)
      ? rows.filter((x: any) => String(x?.coin ?? "").toUpperCase() === coin)
      : [];
  } catch { return []; }
}

function lifecycleTelegram(a: any): string {
  const gross = Number(a.grossPnl);
  const fees = Number(a.fees);
  const net = Number(a.netPnl);
  const legacy = Number(a.realizedPnl);

  const pnlLines =
    Number.isFinite(gross) || Number.isFinite(fees) || Number.isFinite(net)
      ? [
          `💵 Gross P/L: ${Number.isFinite(gross) ? `$${gross.toFixed(4)}` : "n/a"}`,
          `💸 Fees: ${Number.isFinite(fees) ? `$${fees.toFixed(4)}` : "n/a"}`,
          `💰 NET P/L: ${Number.isFinite(net) ? `$${net.toFixed(4)}` : "n/a"}`,
        ]
      : [`💵 Realized P/L: ${Number.isFinite(legacy) ? `$${legacy.toFixed(4)}` : "n/a"}`];

  return [
    `${a.emoji} <b>${escapeTelegramHtml(a.title)}</b>`, "",
    `🪙 <b>${escapeTelegramHtml(a.coin)}</b>`,
    `${a.side === "LONG" ? "📈" : "📉"} ${escapeTelegramHtml(a.side)}`,
    `🎯 Entry: ${escapeTelegramHtml(a.entryPrice)}`,
    `🏁 Exit: ${escapeTelegramHtml(a.exitPrice ?? "n/a")}`,
    `📦 Size: ${escapeTelegramHtml(a.size ?? "n/a")}`,
    ...pnlLines,
    `⏱ Held: ${Math.max(0, Math.round(Number(a.heldMs ?? 0) / 60000))} min`,
    `🆔 Crossing: ${escapeTelegramHtml(a.crossingId)}`,
    "", `🕐 ${new Date().toISOString()}`
  ].join("\n");
}

function lifecyclePnlFromFills(
  fills: any[],
  filledAt: number,
  entryPrice: number,
  exitPrice: number,
  size: number,
  side: string,
  exchangeClosedPnl?: number | null
) {
  const relevant = (Array.isArray(fills) ? fills : []).filter((f: any) => {
    const t = Number(f?.time ?? 0);
    return t >= filledAt - 5000;
  });

  const fees = relevant.reduce((sum: number, f: any) => {
    const fee = Number(f?.fee);
    return sum + (Number.isFinite(fee) ? Math.abs(fee) : 0);
  }, 0);

  const closedPnlValues = relevant.map((f:any) => Number(f?.closedPnl)).filter((v:number) => Number.isFinite(v) && Math.abs(v) > 1e-15);
  let grossPnl = closedPnlValues.length ? closedPnlValues.reduce((s:number,v:number)=>s+v,0) : Number(exchangeClosedPnl);
  if (!Number.isFinite(grossPnl) && Number.isFinite(entryPrice) && Number.isFinite(exitPrice) && Number.isFinite(size)) {
    grossPnl =
      side === "SHORT"
        ? (entryPrice - exitPrice) * Math.abs(size)
        : (exitPrice - entryPrice) * Math.abs(size);
  }

  const netPnl = Number.isFinite(grossPnl)
    ? grossPnl - (Number.isFinite(fees) ? fees : 0)
    : NaN;

  return {
    grossPnl: Number.isFinite(grossPnl) ? grossPnl : null,
    fees: Number.isFinite(fees) ? fees : null,
    netPnl: Number.isFinite(netPnl) ? netPnl : null,
  };
}


type ProgressiveStep = { trigger: number; stop: number };

function progressiveStepsForSide(_side: string): ProgressiveStep[] {
  // Compatibility helper for diagnostics. Runtime stage selection is unbounded.
  return Array.from({ length: 100 }, (_, i) => ({
    trigger: roundTo(CONFIG.PROGRESSIVE_FIRST_TRIGGER_PCT + i * CONFIG.PROGRESSIVE_STEP_PCT, 8),
    stop: roundTo(CONFIG.PROGRESSIVE_FIRST_STOP_PCT + i * CONFIG.PROGRESSIVE_STEP_PCT, 8),
  }));
}

function directionalReturnPct(side: string, entryPrice: number, marketPrice: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(marketPrice) || marketPrice <= 0) {
    return NaN;
  }
  return side === "SHORT"
    ? ((entryPrice - marketPrice) / entryPrice) * 100
    : ((marketPrice - entryPrice) / entryPrice) * 100;
}

function reachedProgressiveStep(_side: string, directionalReturn: number): { stage: number; stop: number; trigger: number } | null {
  if (!Number.isFinite(directionalReturn) || directionalReturn + 1e-12 < CONFIG.PROGRESSIVE_FIRST_TRIGGER_PCT) return null;
  const extra = Math.floor((directionalReturn - CONFIG.PROGRESSIVE_FIRST_TRIGGER_PCT + 1e-10) / CONFIG.PROGRESSIVE_STEP_PCT);
  const stage = Math.max(1, extra + 1);
  return {
    stage,
    trigger: roundTo(CONFIG.PROGRESSIVE_FIRST_TRIGGER_PCT + (stage - 1) * CONFIG.PROGRESSIVE_STEP_PCT, 8),
    stop: roundTo(CONFIG.PROGRESSIVE_FIRST_STOP_PCT + (stage - 1) * CONFIG.PROGRESSIVE_STEP_PCT, 8),
  };
}

function progressiveStopPrice(side: string, entryPrice: number, stopPct: number): number {
  return side === "SHORT"
    ? entryPrice * (1 - stopPct / 100)
    : entryPrice * (1 + stopPct / 100);
}

function openOrderPx(o: any): number {
  const candidates = [o?.triggerPx, o?.trigger_px, o?.limitPx, o?.limit_px, o?.px];
  for (const x of candidates) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return NaN;
}

function responseOrderOid(status: any): number | null {
  const candidates = [
    status?.resting?.oid,
    status?.filled?.oid,
    status?.oid,
  ];
  for (const x of candidates) {
    const n = Number(x);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  return null;
}

function isStopSidePrice(side: string, entryPrice: number, px: number): boolean {
  if (!Number.isFinite(px) || !Number.isFinite(entryPrice)) return false;
  // TP is favorable from entry; SL/progressive protection is on the opposite side
  // of TP. Progressive profit-lock SL can cross entry, so when stage > 0 we
  // identify the old SL by closeness to the ledger's last protected stop first.
  return side === "SHORT" ? px >= entryPrice : px <= entryPrice;
}

async function advanceProgressiveProtection(
  env: HyperliquidExecutionEnv,
  row: any,
  position: any,
  secret: `0x${string}`
): Promise<any> {
  const coin = String(row.coin ?? "").toUpperCase();
  const side = String(row.side ?? "").toUpperCase();
  const entryPrice = Number(row.entry_fill_price);
  if (!coin || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { advanced: false, reason: "INVALID_ENTRY" };
  }

  // V2.16.8 CRITICAL FIX: advanceProgressiveProtection() runs from the lifecycle
  // monitor, outside the entry function where latencyAudit is declared.
  // Referencing latencyAudit here threw ReferenceError on every Progressive attempt,
  // before MFE/stage/SL updates could execute. Keep timing local to this function.
  const latencyMetaStartedAt = Date.now();
  const raw = await postInfo({ type: "metaAndAssetCtxs" });
  const progressiveMetaMs = Date.now() - latencyMetaStartedAt;
  const universe = Array.isArray(raw?.[0]?.universe) ? raw[0].universe : [];
  const contexts = Array.isArray(raw?.[1]) ? raw[1] : [];
  const asset = universe.findIndex((x:any) => String(x?.name ?? "").toUpperCase() === coin);
  if (asset < 0) return { advanced: false, reason: "ASSET_NOT_FOUND" };

  const szDecimals = Number(universe[asset]?.szDecimals);
  const marketPrice = Number(contexts?.[asset]?.midPx ?? contexts?.[asset]?.markPx);
  const szi = Number(position?.szi);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0 || !Number.isFinite(szi) || szi === 0) {
    return { advanced: false, reason: "MARKET_OR_POSITION_INVALID" };
  }

  const dirReturn = directionalReturnPct(side, entryPrice, marketPrice);
  const nowObserved = Date.now();
  if (Number.isFinite(dirReturn)) {
    const oldMfe = Number(row.max_favorable_return_pct);
    if (!Number.isFinite(oldMfe) || dirReturn > oldMfe) {
      try {
        await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger
          SET max_favorable_return_pct=?, max_favorable_price=?, updated_at=? WHERE id=?`)
          .bind(roundTo(dirReturn,6), marketPrice, nowObserved, row.id).run();
        row.max_favorable_return_pct = dirReturn;
        row.max_favorable_price = marketPrice;
      } catch {}
    }
    if (dirReturn + 1e-12 >= CONFIG.VIRTUAL_TP20_PCT && !Number(row.virtual_tp20_hit_at)) {
      try {
        await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger
          SET virtual_tp20_hit_at=?, virtual_tp20_hit_price=?, updated_at=? WHERE id=? AND virtual_tp20_hit_at IS NULL`)
          .bind(nowObserved, marketPrice, nowObserved, row.id).run();
        row.virtual_tp20_hit_at = nowObserved;
        row.virtual_tp20_hit_price = marketPrice;
      } catch {}
    }
  }
  // V2.16.6 SELF-HEALING + READ-ONLY DIAGNOSTIC: never derive the deserved Progressive stage only
  // from the current tick.  A position may already have reached a higher ROI
  // before a missed lifecycle run.  Preserve the highest evidence we have:
  // D1 MFE, the 3-minute observed ROI, and the current live ROI.
  const oldMfe = Number(row.max_favorable_return_pct);
  const threeMinObserved = Number(row.three_min_roi_pct);
  const peakCandidates = [dirReturn];
  if (Number.isFinite(oldMfe)) peakCandidates.push(oldMfe);
  if (Number.isFinite(threeMinObserved)) peakCandidates.push(threeMinObserved);
  const effectivePeak = Math.max(...peakCandidates.filter(Number.isFinite));

  if (!Number.isFinite(oldMfe) || effectivePeak > oldMfe) {
    try {
      await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger
        SET max_favorable_return_pct=?, max_favorable_price=COALESCE(max_favorable_price, ?), updated_at=? WHERE id=?`)
        .bind(roundTo(effectivePeak,6), marketPrice, nowObserved, row.id).run();
      row.max_favorable_return_pct = effectivePeak;
    } catch {}
  }

  let target = reachedProgressiveStep(side, effectivePeak);
  const currentStage = Math.max(0, Number(row.progressive_stage ?? 0) || 0);

  if (!target || target.stage <= currentStage) {
    return {
      advanced: false,
      stage: currentStage,
      directional_return_pct: Number.isFinite(dirReturn) ? roundTo(dirReturn, 4) : null,
      effective_peak_pct: Number.isFinite(effectivePeak) ? roundTo(effectivePeak, 4) : null,
      market_price: marketPrice,
    };
  }

  const stopRaw = progressiveStopPrice(side, entryPrice, target.stop);
  const stopWire = priceToWire(stopRaw, szDecimals);
  const stopPx = Number(stopWire);
  const sizeWire = toWire(Math.abs(szi), szDecimals);
  const closeIsBuy = side === "SHORT";

  // Install the tighter stop FIRST. Only after Hyperliquid confirms it do we
  // cancel the previous stop. This avoids an unprotected gap during replacement.
  const newStopOrder = {
    a: asset,
    b: closeIsBuy,
    p: stopWire,
    s: sizeWire,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: stopWire, tpsl: "sl" } },
  };
  const lockRequestedAt = Date.now();
  const addRes = await sendLifecycleSignedAction(
    { type: "order", orders: [newStopOrder], grouping: "na" },
    secret
  );
  const lockConfirmedAt = Date.now();
  const addStatus = addRes?.json?.response?.data?.statuses?.[0];
  const addOk =
    addRes?.httpStatus >= 200 &&
    addRes?.httpStatus < 300 &&
    addRes?.json?.status === "ok" &&
    !addStatus?.error;

  if (!addOk) {
    return {
      advanced: false,
      reason: "PROGRESSIVE_STOP_ADD_FAILED",
      target_stage: target.stage,
      target_stop_pct: target.stop,
      target_stop_price: stopWire,
      response: addRes?.json ?? null,
    };
  }

  // V2.8.1: cancel the exact previously tracked SL OID.
  // The new tighter SL is already confirmed at this point, so there is no
  // unprotected gap. A price-based fallback is used only for legacy rows that
  // predate exact OID tracking.
  const newStopOid = responseOrderOid(addStatus);

  // V2.16.5 SELF-HEALING VERIFY: an exchange "ok" response is not enough.
  // Before cancelling the previous protection, confirm that the newly-created
  // reduce-only SL is actually visible among Hyperliquid open orders.
  // If it is not visible, KEEP the old SL and retry on the next lifecycle tick.
  if (newStopOid == null) {
    try {
      await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger SET last_error=?,updated_at=? WHERE id=?`)
        .bind(`PROGRESSIVE_NEW_STOP_OID_MISSING stage=${target.stage} stop=${target.stop}`,Date.now(),row.id).run();
    } catch {}
    return { advanced:false, reason:"PROGRESSIVE_NEW_STOP_OID_MISSING", target_stage:target.stage, target_stop_pct:target.stop, effective_peak_pct:roundTo(effectivePeak,4) };
  }

  let newStopVisible = false;
  try {
    const verifyOpen = await getOpenOrdersForCoin(coin);
    newStopVisible = verifyOpen.some((o:any) => Number(o?.oid) === Number(newStopOid));
  } catch {}
  if (!newStopVisible) {
    try {
      await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger SET last_error=?,updated_at=? WHERE id=?`)
        .bind(`PROGRESSIVE_NEW_STOP_NOT_VISIBLE oid=${newStopOid} stage=${target.stage} stop=${target.stop}`,Date.now(),row.id).run();
    } catch {}
    return { advanced:false, reason:"PROGRESSIVE_NEW_STOP_NOT_VISIBLE", new_stop_oid:newStopOid, target_stage:target.stage, target_stop_pct:target.stop, effective_peak_pct:roundTo(effectivePeak,4) };
  }

  let cancelledOids: number[] = [];
  let oldStopOid: number | null = null;
  let cancelMode = "NONE";

  const trackedOldOid = Number(row.progressive_stop_oid);
  if (Number.isInteger(trackedOldOid) && trackedOldOid >= 0 && trackedOldOid !== newStopOid) {
    oldStopOid = trackedOldOid;
    cancelMode = "EXACT_TRACKED_OID";
  } else if (currentStage === 0) {
    // Legacy/initial bracket: the initial SL was created before V2.8.1 and its
    // OID may not yet be in D1. Resolve it once by expected initial-SL price.
    try {
      const open = await getOpenOrdersForCoin(coin);
      const initialSlPct = side === "LONG"
        ? CONFIG.LONG_STOP_LOSS_PCT
        : CONFIG.SHORT_STOP_LOSS_PCT;
      const initialSl = side === "LONG"
        ? entryPrice * (1 - initialSlPct / 100)
        : entryPrice * (1 + initialSlPct / 100);
      const tpPct = side === "LONG"
        ? CONFIG.LONG_TAKE_PROFIT_PCT
        : CONFIG.SHORT_TAKE_PROFIT_PCT;
      const tp = side === "LONG"
        ? entryPrice * (1 + tpPct / 100)
        : entryPrice * (1 - tpPct / 100);

      const candidates = open
        .filter((o:any) => o?.oid != null && Number(o.oid) !== newStopOid)
        .map((o:any) => ({ o, px: openOrderPx(o) }))
        .filter((x:any) => Number.isFinite(x.px))
        .sort((a:any,b:any) => Math.abs(a.px-initialSl)-Math.abs(b.px-initialSl));

      const old = candidates[0];
      if (
        old &&
        Math.abs(old.px - initialSl) < Math.abs(old.px - tp)
      ) {
        oldStopOid = Number(old.o.oid);
        cancelMode = "LEGACY_INITIAL_SL_PRICE_RESOLUTION";
      }
    } catch {}
  }

  if (oldStopOid != null) {
    try {
      const cancelRes = await sendLifecycleSignedAction(
        { type: "cancel", cancels: [{ a: asset, o: oldStopOid }] },
        secret
      );
      if (
        cancelRes?.httpStatus >= 200 &&
        cancelRes?.httpStatus < 300 &&
        cancelRes?.json?.status === "ok"
      ) {
        cancelledOids.push(oldStopOid);
      } else {
        // Fail closed: if old SL could not be cancelled, keep both protective
        // reduce-only stops rather than risk deleting an unrelated order.
        cancelMode += "_CANCEL_NOT_CONFIRMED";
      }
    } catch {
      cancelMode += "_CANCEL_EXCEPTION";
    }
  }

  await env.DB?.prepare(`
    UPDATE hyperliquid_execution_ledger
    SET progressive_stage=?, progressive_stop_pct=?, progressive_stop_price=?,
        progressive_stop_oid=?, progressive_updated_at=?, lock_trigger_pct=?,
        lock_requested_at=?, lock_confirmed_at=?, lock_latency_ms=?,
        tp25_triggered_at=COALESCE(tp25_triggered_at, CASE WHEN ?=1 THEN ? ELSE NULL END),
        runner_active=1, runner_size=?, last_error=NULL, updated_at=?
    WHERE id=?
  `).bind(
    target.stage,
    target.stop,
    stopPx,
    newStopOid,
    lockConfirmedAt,
    target.trigger,
    lockRequestedAt,
    lockConfirmedAt,
    Math.max(0, lockConfirmedAt - lockRequestedAt),
    target.stage,
    lockConfirmedAt,
    Math.abs(szi),
    lockConfirmedAt,
    row.id
  ).run();

  return {
    advanced: true,
    stage: target.stage,
    trigger_pct: target.trigger,
    protected_gross_pct: target.stop,
    stop_price: stopWire,
    active_stop_oid: newStopOid,
    directional_return_pct: roundTo(dirReturn, 4),
    effective_peak_pct: roundTo(effectivePeak, 4),
    verified_on_exchange: true,
    meta_ms: progressiveMetaMs,
    market_price: marketPrice,
    old_stop_cancel_mode: cancelMode,
    cancelled_old_stop_oids: cancelledOids,
  };
}

let lifecycleLastNonce = 0;
function nextLifecycleNonce(): number {
  const now = Date.now();
  lifecycleLastNonce = Math.max(now, lifecycleLastNonce + 1);
  return lifecycleLastNonce;
}

async function sendLifecycleSignedAction(action: Record<string, any>, secret: `0x${string}`) {
  const nonce = nextLifecycleNonce();
  const signed = await signHyperliquidAction(action, nonce, secret);
  const res = await fetch(EXCHANGE_URL, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, nonce, signature: signed.signature, vaultAddress: null }),
  });
  const text = await res.text();
  let json: any = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { httpStatus: res.status, json, text };
}

export async function executeProgressiveWsTrigger(
  env: HyperliquidExecutionEnv | undefined,
  ledgerId: number,
  targetStage: number
): Promise<any> {
  if (!env?.DB) return { success:false, executed:false, reason:"D1_NOT_BOUND" };
  await ensureExecutionLedger(env.DB);
  const swingWsRow:any=await env.DB.prepare(`SELECT strategy_version FROM hyperliquid_execution_ledger WHERE id=?`).bind(ledgerId).first();
  if (String(swingWsRow?.strategy_version??'').startsWith('SWING_'))
    return {success:false,executed:false,reason:'SWING_EXCLUDED_FROM_PROGRESSIVE'};
  if (!CONFIG.LIVE_TRADING) return { success:true, executed:false, reason:"LIVE_TRADING_DISABLED", ledger_id:ledgerId, target_stage:targetStage };
  const secretRaw=normalizePrivateKey(env.HYPERLIQUID_API_PRIVATE_KEY);
  if (!privateKeyFormatOk(secretRaw)) return { success:false, executed:false, reason:"PRIVATE_KEY_INVALID" };
  const row:any=await env.DB.prepare(`
    SELECT * FROM hyperliquid_execution_ledger
    WHERE id=? AND status IN ('ENTRY_FILLED','PROTECTED','TPSL_FAILED_AFTER_RETRIES','MAX_HOLD_CLOSING')
      AND entry_fill_price IS NOT NULL AND entry_fill_price > 0 LIMIT 1
  `).bind(ledgerId).first();
  if (!row) return { success:false, executed:false, reason:"OPEN_LEDGER_ROW_NOT_FOUND", ledger_id:ledgerId };
  const currentStage=Math.max(0,Number(row.progressive_stage??0)||0);
  if (!Number.isInteger(targetStage)||targetStage<=currentStage)
    return {success:true,executed:false,reason:"ALREADY_AT_OR_ABOVE_TARGET_STAGE",ledger_id:ledgerId,current_stage:currentStage,target_stage:targetStage};

  let position:any=null;
  try { position=await getOpenPositionForCoin(String(row.coin??"").toUpperCase()); }
  catch(err:any){ return {success:false,executed:false,reason:"POSITION_LOOKUP_FAILED",error:err?.message??String(err)}; }
  if(!position) return {success:false,executed:false,reason:"POSITION_NOT_OPEN",ledger_id:ledgerId};
  const result=await advanceProgressiveProtection(env,row,position,secretRaw as `0x${string}`);
  const reachedStage=Number(result?.stage??currentStage);
  return {success:result?.advanced===true||reachedStage>=targetStage,executed:result?.advanced===true,ledger_id:ledgerId,requested_target_stage:targetStage,result};
}


async function applyThreeMinuteScalpProtection(
  env: HyperliquidExecutionEnv,
  row: any,
  position: any,
  secret: `0x${string}`
): Promise<any> {
  const filledAt = Number(row.entry_filled_at ?? row.updated_at ?? row.claimed_at);
  const now = Date.now();
  if (!Number.isFinite(filledAt) || now - filledAt < CONFIG.THREE_MIN_PROTECTION_MS) {
    return { handled:false, reason:"BEFORE_3M" };
  }
  if (Number(row.three_min_decision_at) > 0) {
    return { handled:false, reason:"ALREADY_DECIDED", action:row.three_min_action ?? null };
  }

  const coin = String(row.coin ?? "").toUpperCase();
  const side = String(row.side ?? "").toUpperCase();
  const entryPrice = Number(row.entry_fill_price);
  const szi = Number(position?.szi);
  if (!coin || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(szi) || szi === 0) {
    return { handled:false, reason:"INVALID_3M_POSITION" };
  }

  // If Progressive has already triggered, 3m protection must never downgrade it.
  if (Number(row.tp25_triggered_at) > 0 || Number(row.progressive_stage ?? 0) >= 1) {
    await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger
      SET three_min_decision_at=?, three_min_action='PROGRESSIVE_ALREADY_ACTIVE', three_min_last_error=NULL, updated_at=?
      WHERE id=? AND three_min_decision_at IS NULL`)
      .bind(now,now,row.id).run();
    row.three_min_decision_at=now; row.three_min_action="PROGRESSIVE_ALREADY_ACTIVE";
    return { handled:true, action:"PROGRESSIVE_ALREADY_ACTIVE" };
  }

  const raw = await postInfo({ type:"metaAndAssetCtxs" });
  const universe = Array.isArray(raw?.[0]?.universe) ? raw[0].universe : [];
  const contexts = Array.isArray(raw?.[1]) ? raw[1] : [];
  const asset = universe.findIndex((x:any)=>String(x?.name??"").toUpperCase()===coin);
  if (asset < 0) return { handled:false, reason:"3M_ASSET_NOT_FOUND" };
  const szDecimals = Number(universe[asset]?.szDecimals);
  const marketPrice = Number(contexts?.[asset]?.midPx ?? contexts?.[asset]?.markPx);
  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return { handled:false, reason:"3M_MARKET_PRICE_INVALID" };

  const roi = directionalReturnPct(side, entryPrice, marketPrice);
  if (!Number.isFinite(roi)) return { handled:false, reason:"3M_ROI_INVALID" };

  // Safety fallback only: Progressive is called BEFORE this function. If ROI is
  // already >= +0.25% but the lock was not confirmed, never apply a weaker 3m
  // action; mark the state and let Progressive retry on subsequent lifecycle ticks.
  if (roi + 1e-12 >= CONFIG.THREE_MIN_LOCK20_MAX_PCT) {
    await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger
      SET three_min_decision_at=?, three_min_action='PROGRESSIVE_ZONE', three_min_roi_pct=?, three_min_market_price=?, three_min_last_error=NULL, updated_at=?
      WHERE id=? AND three_min_decision_at IS NULL`)
      .bind(now,roundTo(roi,6),marketPrice,now,row.id).run();
    row.three_min_decision_at=now; row.three_min_action="PROGRESSIVE_ZONE"; row.three_min_roi_pct=roi;
    return { handled:true, action:"PROGRESSIVE_ZONE", roi_pct:roundTo(roi,4), market_price:marketPrice };
  }

  // ROI < 0 at the 3m decision: close the whole live position immediately with
  // a marketable IOC. This is the only branch that force-closes at 3m.
  if (roi < 0) {
    const closeBuy = szi < 0;
    const limitRaw = closeBuy
      ? marketPrice * (1 + CONFIG.MAX_ENTRY_SLIPPAGE_PCT/100)
      : marketPrice * (1 - CONFIG.MAX_ENTRY_SLIPPAGE_PCT/100);
    const limitWire = priceToWire(limitRaw,szDecimals);
    const closeAction = {type:"order",orders:[{
      a:asset,b:closeBuy,p:limitWire,s:toWire(Math.abs(szi),szDecimals),r:true,t:{limit:{tif:"Ioc"}}
    }],grouping:"na"};
    const closeRes = await sendLifecycleSignedAction(closeAction,secret);
    const st = closeRes?.json?.response?.data?.statuses?.[0];
    if (!st?.filled) {
      const err=String(st?.error ?? "3M_FORCED_MARKET_NOT_FILLED");
      await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger SET three_min_last_error=?,updated_at=? WHERE id=?`)
        .bind(err,Date.now(),row.id).run();
      return { handled:false, reason:err, response:closeRes?.json ?? null };
    }

    try {
      const open=await getOpenOrdersForCoin(coin);
      const cancels=open.filter((o:any)=>o?.oid!=null).map((o:any)=>({a:asset,o:Number(o.oid)}));
      if(cancels.length) await sendLifecycleSignedAction({type:"cancel",cancels},secret);
    } catch {}

    const exitPrice=Number(st.filled?.avgPx ?? st.filled?.px ?? marketPrice);
    const fills=await getRecentFillsForCoin(coin);
    const pnl=lifecyclePnlFromFills(fills,filledAt,entryPrice,exitPrice,Math.abs(szi),side,Number(st.filled?.closedPnl));
    const closedAt=Date.now();
    await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger SET
      status='THREE_MIN_FORCED_SL',closed_at=?,close_reason='THREE_MIN_FORCED_SL',exit_price=?,realized_pnl=?,runner_active=0,runner_size=0,
      three_min_decision_at=?,three_min_action='FORCED_SL',three_min_roi_pct=?,three_min_market_price=?,three_min_exit_at=?,three_min_last_error=NULL,updated_at=?
      WHERE id=?`)
      .bind(closedAt,Number.isFinite(exitPrice)?exitPrice:null,pnl.netPnl,now,roundTo(roi,6),marketPrice,closedAt,closedAt,row.id).run();
    await sendTelegram(env,lifecycleTelegram({emoji:"🛡",title:"3M FORCED SL · MARKET EXIT",coin,side,entryPrice,exitPrice:Number.isFinite(exitPrice)?exitPrice:null,size:Math.abs(szi),grossPnl:pnl.grossPnl,fees:pnl.fees,netPnl:pnl.netPnl,heldMs:closedAt-filledAt,crossingId:row.crossing_id}));
    return { handled:true, closed:true, action:"FORCED_SL", roi_pct:roundTo(roi,4), exit_price:exitPrice, net_pnl:pnl.netPnl };
  }

  // Positive but not yet +0.25%: install a protective stop for 100% of the
  // position. 0..<0.20 => BE. +0.20..<+0.25 => +0.20% floor.
  const action = roi < CONFIG.THREE_MIN_BE_MAX_PCT ? "BEST_EXIT" : "TP020";
  const stopPct = action === "BEST_EXIT" ? 0 : CONFIG.THREE_MIN_LOCK20_STOP_PCT;
  const stopRaw = progressiveStopPrice(side,entryPrice,stopPct);
  const stopWire = priceToWire(stopRaw,szDecimals);
  const stopPx = Number(stopWire);
  const closeIsBuy = side === "SHORT";
  const addRes = await sendLifecycleSignedAction({type:"order",orders:[{
    a:asset,b:closeIsBuy,p:stopWire,s:toWire(Math.abs(szi),szDecimals),r:true,
    t:{trigger:{isMarket:true,triggerPx:stopWire,tpsl:"sl"}}
  }],grouping:"na"},secret);
  const addStatus=addRes?.json?.response?.data?.statuses?.[0];
  const newOid=responseOrderOid(addStatus);
  const addOk=addRes?.httpStatus>=200&&addRes?.httpStatus<300&&addRes?.json?.status==="ok"&&!addStatus?.error&&newOid!=null;
  if(!addOk){
    const err=String(addStatus?.error ?? "3M_PROTECTIVE_STOP_ADD_FAILED");
    await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger SET three_min_last_error=?,updated_at=? WHERE id=?`).bind(err,Date.now(),row.id).run();
    return {handled:false,reason:err,response:addRes?.json??null};
  }

  // New stop is live first; only then cancel the previous tracked initial stop.
  const oldOid=Number(row.progressive_stop_oid);
  if(Number.isInteger(oldOid)&&oldOid>=0&&oldOid!==newOid){
    try{await sendLifecycleSignedAction({type:"cancel",cancels:[{a:asset,o:oldOid}]},secret);}catch{}
  } else {
    // Legacy fallback if the initial OID was not persisted: cancel only the stop
    // nearest the expected -0.20% initial-SL price, never unrelated orders.
    try{
      const open=await getOpenOrdersForCoin(coin);
      const initialSl=side==="LONG"?entryPrice*(1-CONFIG.LONG_STOP_LOSS_PCT/100):entryPrice*(1+CONFIG.SHORT_STOP_LOSS_PCT/100);
      const cand=open.filter((o:any)=>o?.oid!=null&&Number(o.oid)!==newOid).map((o:any)=>({oid:Number(o.oid),px:openOrderPx(o)})).filter((o:any)=>Number.isFinite(o.px)).sort((a:any,b:any)=>Math.abs(a.px-initialSl)-Math.abs(b.px-initialSl))[0];
      if(cand&&Math.abs(cand.px-initialSl)/entryPrice<0.0015) await sendLifecycleSignedAction({type:"cancel",cancels:[{a:asset,o:cand.oid}]},secret);
    }catch{}
  }

  const decidedAt=Date.now();
  await env.DB?.prepare(`UPDATE hyperliquid_execution_ledger SET
    three_min_decision_at=?,three_min_action=?,three_min_roi_pct=?,three_min_market_price=?,three_min_stop_pct=?,three_min_stop_price=?,three_min_last_error=NULL,
    progressive_stop_oid=?,progressive_stop_price=?,progressive_updated_at=?,updated_at=? WHERE id=? AND three_min_decision_at IS NULL`)
    .bind(decidedAt,action,roundTo(roi,6),marketPrice,stopPct,stopPx,newOid,stopPx,decidedAt,decidedAt,row.id).run();
  row.three_min_decision_at=decidedAt; row.three_min_action=action; row.three_min_roi_pct=roi; row.three_min_stop_pct=stopPct; row.three_min_stop_price=stopPx; row.progressive_stop_oid=newOid; row.progressive_stop_price=stopPx;
  await sendTelegram(env,[`🛡 <b>3M SCALP PROTECTION</b>`,``,`🪙 <b>${escapeTelegramHtml(coin)}</b> · ${side}`,`⏱ ${Math.round((decidedAt-filledAt)/1000)}s from fill`,`📊 ROI: ${roi>=0?"+":""}${roi.toFixed(3)}%`,`🎯 Action: ${action==="BEST_EXIT"?"BEST EXIT · BE":"0.20% TP · LOCK +0.20%"}`,`🛡 Stop: ${stopWire}`,`🆔 Crossing: ${escapeTelegramHtml(row.crossing_id)}`].join("\n"));
  return {handled:true,closed:false,action,roi_pct:roundTo(roi,4),stop_pct:stopPct,stop_price:stopPx};
}



// V2.16.6 READ-ONLY lifecycle diagnostic.
// Does NOT place/cancel orders. It shows whether BTC1M PROTECTED rows are
// selected, whether the private key gate is valid, whether Hyperliquid still
// has the position, and which Progressive stage is deserved from live/D1 peak.
export async function getHyperliquidLifecycleDiagnostic(env?: HyperliquidExecutionEnv): Promise<any> {
  if (!env?.DB) return { success:false, reason:"D1_NOT_BOUND" };
  await ensureExecutionLedger(env.DB);
  const secretRaw=normalizePrivateKey(env.HYPERLIQUID_API_PRIVATE_KEY);
  const secretOk=privateKeyFormatOk(secretRaw);
  const q:any=await env.DB.prepare(`
    SELECT * FROM hyperliquid_execution_ledger
    WHERE status='PROTECTED' AND strategy_version IN ('BTC1M_DIRECTIONAL_V1','BTC3M_DIRECTIONAL_V1','BTC5M_DIRECTIONAL_V1','BTC10M_DIRECTIONAL_V1')
    ORDER BY id DESC LIMIT 30
  `).all();
  const rows=Array.isArray(q?.results)?q.results:[];
  let raw:any=null;
  try { raw=await postInfo({type:"metaAndAssetCtxs"}); } catch {}
  const universe=Array.isArray(raw?.[0]?.universe)?raw[0].universe:[];
  const contexts=Array.isArray(raw?.[1])?raw[1]:[];
  const items:any[]=[];
  for(const row of rows){
    const coin=String(row.coin??"").toUpperCase();
    const side=String(row.side??"").toUpperCase();
    const entry=Number(row.entry_fill_price);
    let position:any=null, positionError:string|null=null;
    try { position=await getOpenPositionForCoin(coin); } catch(e:any){ positionError=e?.message??String(e); }
    const ai=universe.findIndex((x:any)=>String(x?.name??"").toUpperCase()===coin);
    const market=ai>=0?Number(contexts?.[ai]?.midPx??contexts?.[ai]?.markPx):NaN;
    const liveRoi=Number.isFinite(entry)&&entry>0&&Number.isFinite(market)?directionalReturnPct(side,entry,market):NaN;
    const mfe=Number(row.max_favorable_return_pct);
    const r3=Number(row.three_min_roi_pct);
    const peaks=[liveRoi,mfe,r3].filter(Number.isFinite);
    const effectivePeak=peaks.length?Math.max(...peaks):NaN;
    const target=Number.isFinite(effectivePeak)?reachedProgressiveStep(side,effectivePeak):null;
    items.push({
      id:row.id,crossing_id:row.crossing_id,coin,side,status:row.status,
      strategy_version:row.strategy_version,setup_name:row.setup_name,
      selected_by_lifecycle:true,secret_ok:secretOk,
      position_found:Boolean(position),position_error:positionError,
      entry_price:Number.isFinite(entry)?entry:null,market_price:Number.isFinite(market)?market:null,
      live_roi_pct:Number.isFinite(liveRoi)?roundTo(liveRoi,6):null,
      stored_mfe_pct:Number.isFinite(mfe)?mfe:null,
      three_min_roi_pct:Number.isFinite(r3)?r3:null,
      effective_peak_pct:Number.isFinite(effectivePeak)?roundTo(effectivePeak,6):null,
      current_stage:Number(row.progressive_stage??0),current_stop_pct:row.progressive_stop_pct??null,
      expected_stage:target?.stage??0,expected_stop_pct:target?.stop??null,
      needs_progressive_advance:Boolean(target&&target.stage>Number(row.progressive_stage??0)),
      progressive_updated_at:row.progressive_updated_at??null,updated_at:row.updated_at??null,last_error:row.last_error??null
    });
  }
  return {success:true,module:"HYPERLIQUID_LIFECYCLE_DIAGNOSTIC_READ_ONLY",exchange_request_sent:false,secret_ok:secretOk,selected_rows:items.length,items};
}

// V2.16.7: prioritize current BTC1M protected positions in the lifecycle batch.
// The previous ORDER BY id ASC LIMIT 100 could permanently starve newer BTC1M rows
// when more than 100 legacy active-status ledger rows existed.
export async function monitorHyperliquidExecutionLifecycle(env?: HyperliquidExecutionEnv): Promise<any> {
  if (!env?.DB) return { success: false, reason: "D1_NOT_BOUND" };
  await ensureExecutionLedger(env.DB);
  const rows: any = await env.DB.prepare(`
    SELECT * FROM hyperliquid_execution_ledger
    WHERE COALESCE(strategy_version,'') NOT LIKE 'SWING_%' AND status IN ('ENTRY_FILLED','PROTECTED','TPSL_FAILED_AFTER_RETRIES','MAX_HOLD_CLOSING')
    ORDER BY
      CASE
        WHEN strategy_version IN ('BTC1M_DIRECTIONAL_V1','BTC3M_DIRECTIONAL_V1','BTC5M_DIRECTIONAL_V1','BTC10M_DIRECTIONAL_V1') AND status='PROTECTED' THEN 0
        WHEN strategy_version IN ('BTC1M_DIRECTIONAL_V1','BTC3M_DIRECTIONAL_V1','BTC5M_DIRECTIONAL_V1','BTC10M_DIRECTIONAL_V1') THEN 1
        ELSE 2
      END ASC,
      id DESC
    LIMIT 100
  `).all();
  const items = Array.isArray(rows?.results) ? rows.results : [];
  const secretRaw = normalizePrivateKey(env.HYPERLIQUID_API_PRIVATE_KEY);
  const secretOk = privateKeyFormatOk(secretRaw);
  const out: any[] = [];

  for (const row of items) {
    const coin = String(row.coin ?? "").toUpperCase();
    const side = String(row.side ?? "").toUpperCase();
    const entryPrice = Number(row.entry_fill_price);
    const entrySize = Number(row.entry_fill_size);
    const filledAt = Number(row.entry_filled_at ?? row.updated_at ?? row.claimed_at);
    const heldMs = Date.now() - filledAt;
    let position: any = null;
    try { position = await getOpenPositionForCoin(coin); } catch (e:any) { out.push({coin,error:e?.message??String(e)}); continue; }

    if (!position) {
      // V2.13.1: a scale-out trade can have several close fills.  The old code
      // selected the FIRST non-zero closedPnl fill, which is normally TP1, and
      // then used that price as the final exit.  That produced CLOSED_OTHER and
      // TP1_FULL_CLOSE_UNEXPECTED even when a later BE/SL/TP2/TP3 fill actually
      // closed the position.  Reconstruct the lifecycle from ALL real close fills.
      const fills = await getRecentFillsForCoin(coin);
      const afterEntry = fills
        .filter((f:any) => Number(f?.time ?? 0) >= filledAt - 5000)
        .sort((a:any,b:any) => Number(a?.time ?? 0) - Number(b?.time ?? 0));
      const closeFills = afterEntry.filter((f:any) => {
        const cp = Number(f?.closedPnl);
        const dir = String(f?.dir ?? "").toLowerCase();
        return (Number.isFinite(cp) && Math.abs(cp) > 1e-15) || dir.includes("close");
      });
      const finalFill = closeFills.length ? closeFills[closeFills.length - 1] : (afterEntry.length ? afterEntry[afterEntry.length - 1] : null);
      const exitPrice = Number(finalFill?.px);
      const realizedPnl = Number(finalFill?.closedPnl);
      const pnl = lifecyclePnlFromFills(
        fills, filledAt, entryPrice, exitPrice, entrySize, side,
        Number.isFinite(realizedPnl) ? realizedPnl : null
      );
      const tp1Pct = side === "LONG" ? CONFIG.LONG_TAKE_PROFIT_PCT : CONFIG.SHORT_TAKE_PROFIT_PCT;
      const slPct = side === "LONG" ? CONFIG.LONG_STOP_LOSS_PCT : CONFIG.SHORT_STOP_LOSS_PCT;
      const tp1 = side === "LONG" ? entryPrice*(1+tp1Pct/100) : entryPrice*(1-tp1Pct/100);
      const tp2 = side === "LONG" ? entryPrice*(1+CONFIG.LONG_TP2_PCT/100) : entryPrice*(1-CONFIG.LONG_TP2_PCT/100);
      const tp3 = side === "LONG" ? entryPrice*(1+CONFIG.LONG_TP3_PCT/100) : entryPrice*(1-CONFIG.LONG_TP3_PCT/100);
      const sl = side === "LONG" ? entryPrice*(1-slPct/100) : entryPrice*(1+slPct/100);
      const progressiveStage = Number(row.progressive_stage ?? 0);

      const pxs = closeFills.map((f:any)=>Number(f?.px)).filter((x:number)=>Number.isFinite(x));
      const hitAt = (target:number, tolerance:number) => side === "LONG"
        ? pxs.some((px:number)=>px >= target*(1-tolerance))
        : pxs.some((px:number)=>px <= target*(1+tolerance));
      const tp1Seen = hitAt(tp1,0.00015) || progressiveStage >= 1 || Number(row.partial_tp_filled_at) > 0;
      const tp2Seen = hitAt(tp2,0.00015);
      const tp3Seen = hitAt(tp3,0.00015);

      // Backfill TP1 bookkeeping from the first TP1-like close fill.  This fixes
      // rows where the rearm succeeded (progressive_stage=1) but partial_tp_* was
      // lost/missed before the next lifecycle tick.
      if (!Number(row.partial_tp_filled_at) && tp1Seen && closeFills.length) {
        const tp1Fill = closeFills.find((f:any)=>{
          const px=Number(f?.px); if(!Number.isFinite(px)) return false;
          return side === "LONG" ? px >= tp1*0.99985 : px <= tp1*1.00015;
        }) ?? closeFills[0];
        const pAt=Number(tp1Fill?.time), pPx=Number(tp1Fill?.px), pSz=Math.abs(Number(tp1Fill?.sz)), pPnl=Number(tp1Fill?.closedPnl);
        try {
          await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET partial_tp_filled_at=?,partial_tp_price=?,partial_tp_size=?,partial_tp_realized_pnl=?,updated_at=? WHERE id=? AND partial_tp_filled_at IS NULL`)
            .bind(Number.isFinite(pAt)?pAt:Date.now(),Number.isFinite(pPx)?pPx:null,Number.isFinite(pSz)?pSz:null,Number.isFinite(pPnl)?pPnl:null,Date.now(),row.id).run();
        } catch {}
      }

      let reason = "CLOSED_OTHER", title = "POSITION CLOSED", emoji = "⚪";
      const threeMinAction=String(row.three_min_action??"").toUpperCase();
      if (progressiveStage >= 1) {
        reason="PROGRESSIVE_LOCK_HIT";
        title=`PROGRESSIVE LOCK HIT · +${Number(row.progressive_stop_pct ?? 0).toFixed(2)}% FLOOR`;
        emoji="🟢";
      }
      else if (tp3Seen) { reason="TP3_HIT"; title="TP3 HIT · SCALEOUT COMPLETE"; emoji="🟢"; }
      else if (tp2Seen && tp1Seen) { reason="TP2_THEN_BE_OR_CLOSE"; title="TP2 HIT · POSITION CLOSED"; emoji="🟢"; }
      else if (tp1Seen) {
        // After TP1, a later close around entry is the intended BE outcome.
        // If there is only one close fill and it consumed the whole position,
        // preserve the explicit unexpected-full-close diagnostic.
        const onlyOneClose = closeFills.length === 1;
        const finalNearEntry = Number.isFinite(exitPrice) && Math.abs((exitPrice-entryPrice)/entryPrice) <= 0.0012;
        if (onlyOneClose && Number.isFinite(exitPrice) && (side === "LONG" ? exitPrice >= tp1*0.99985 : exitPrice <= tp1*1.00015)) {
          reason="TP_HIT"; title="TP +0.20% HIT"; emoji="🟢";
        } else if (finalNearEntry || progressiveStage >= 1) {
          reason="BE_AFTER_TP1"; title="BE AFTER TP1"; emoji="🟡";
        }
      } else if (threeMinAction === "BEST_EXIT") {
        reason="THREE_MIN_BEST_EXIT"; title="3M BEST EXIT · BE PROTECTION"; emoji="🛡";
      } else if (threeMinAction === "TP020") {
        reason="THREE_MIN_TP020"; title="3M 0.20% TP · PROTECTED EXIT"; emoji="🟢";
      } else if (Number.isFinite(exitPrice)) {
        const slHit = side === "LONG" ? exitPrice <= sl*1.00015 : exitPrice >= sl*0.99985;
        if (slHit) { reason="SL_HIT"; title="INITIAL SL HIT"; emoji="🔴"; }
      }

      await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET status=?,updated_at=?,closed_at=?,close_reason=?,exit_price=?,realized_pnl=?,runner_active=0,runner_size=0 WHERE id=?`)
        .bind(reason,Date.now(),Date.now(),reason,Number.isFinite(exitPrice)?exitPrice:null,pnl.netPnl,row.id).run();
      await sendTelegram(env,lifecycleTelegram({
        emoji,title,coin,side,entryPrice,
        exitPrice:Number.isFinite(exitPrice)?exitPrice:null,
        size:entrySize,
        grossPnl:pnl.grossPnl,
        fees:pnl.fees,
        netPnl:pnl.netPnl,
        heldMs,crossingId:row.crossing_id
      }));
      out.push({coin,status:reason,exit_price:exitPrice,close_fills:closeFills.length,tp1_seen:tp1Seen,tp2_seen:tp2Seen,tp3_seen:tp3Seen});
      continue;
    }

    // V2.16.4 — BTC1M protection priority:
    // 1) Progressive Profit Lock ALWAYS gets first chance on every lifecycle tick.
    //    The instant live ROI reaches +0.25%, it installs the highest floor already
    //    earned (+0.20%, +0.30%, +0.40% ...), with no 3-minute dependency.
    // 2) The 3-minute module is only a fallback for positions that have NOT reached
    //    +0.25%. If Progressive is active, applyThreeMinuteScalpProtection() records
    //    PROGRESSIVE_ALREADY_ACTIVE and never downgrades/replaces the profit lock.
    let progressive: any = null;
    if (secretOk && String(row.status) === "PROTECTED" && ["BTC1M_DIRECTIONAL_V1","BTC3M_DIRECTIONAL_V1","BTC5M_DIRECTIONAL_V1","BTC10M_DIRECTIONAL_V1"].includes(String(row.strategy_version ?? ""))) {
      try {
        progressive = await advanceProgressiveProtection(
          env,
          row,
          position,
          secretRaw as `0x${string}`
        );
        if (progressive?.advanced) {
          row.progressive_stage = progressive.stage;
          row.progressive_stop_pct = progressive.protected_gross_pct;
          row.progressive_stop_price = Number(progressive.stop_price);
          row.tp25_triggered_at = row.tp25_triggered_at || Date.now();
        }
      } catch (e:any) {
        const watchdogError = `LIFECYCLE_WATCHDOG: PROGRESSIVE_EXCEPTION: ${e?.message ?? String(e)}`;
        progressive = { advanced:false, reason:"PROGRESSIVE_EXCEPTION", error:e?.message ?? String(e) };
        // V2.16.9: never allow a Progressive lifecycle exception to stay silent.
        // Persist the exact failure and send Telegram only when the error changes,
        // so a recurring cron failure cannot spam every minute.
        const previousError = String(row.last_error ?? "");
        try {
          await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET last_error=?,updated_at=? WHERE id=?`)
            .bind(watchdogError,Date.now(),row.id).run();
          row.last_error = watchdogError;
        } catch {}
        if (previousError !== watchdogError) {
          await sendTelegram(env,[
            `🚨 <b>LIFECYCLE WATCHDOG</b>`,
            ``,
            `🪙 <b>${escapeTelegramHtml(coin)}</b> · ${escapeTelegramHtml(side)}`,
            `🆔 Crossing: ${escapeTelegramHtml(row.crossing_id)}`,
            `📌 Status: ${escapeTelegramHtml(row.status)}`,
            `🔒 Stage: ${Number(row.progressive_stage ?? 0)}`,
            `🚫 ${escapeTelegramHtml(watchdogError)}`,
            ``,
            `🕐 ${new Date().toISOString()}`
          ].join("\n"));
        }
      }

      // V2.16.9: order-placement/verification failures are returned rather than thrown.
      // Surface those too; successful advancement clears last_error inside
      // advanceProgressiveProtection(). This is monitoring only — no entry/signal
      // formula, Progressive percentage, or 3-minute rule is changed.
      if (progressive && !progressive.advanced && progressive.target_stage && String(progressive.reason ?? "").startsWith("PROGRESSIVE_")) {
        const watchdogError = `LIFECYCLE_WATCHDOG: ${String(progressive.reason)} target_stage=${Number(progressive.target_stage)} current_stage=${Number(row.progressive_stage ?? 0)}`;
        const previousError = String(row.last_error ?? "");
        try {
          await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET last_error=?,updated_at=? WHERE id=?`)
            .bind(watchdogError,Date.now(),row.id).run();
          row.last_error = watchdogError;
        } catch {}
        if (previousError !== watchdogError) {
          await sendTelegram(env,[
            `🚨 <b>LIFECYCLE STUCK</b>`,
            ``,
            `🪙 <b>${escapeTelegramHtml(coin)}</b> · ${escapeTelegramHtml(side)}`,
            `🆔 Crossing: ${escapeTelegramHtml(row.crossing_id)}`,
            `🔒 Current stage: ${Number(row.progressive_stage ?? 0)}`,
            `🎯 Expected stage: ${Number(progressive.target_stage)}`,
            `🚫 Reason: ${escapeTelegramHtml(progressive.reason)}`,
            ``,
            `🕐 ${new Date().toISOString()}`
          ].join("\n"));
        }
      }
    }

    // One-shot LIVE 3-minute fallback protection. It runs AFTER Progressive.
    // Uses current Hyperliquid mid/mark; historical market_snapshots are not used.
    if (secretOk && ["BTC1M_DIRECTIONAL_V1","BTC3M_DIRECTIONAL_V1","BTC5M_DIRECTIONAL_V1","BTC10M_DIRECTIONAL_V1"].includes(String(row.strategy_version ?? ""))) {
      try {
        const threeMin = await applyThreeMinuteScalpProtection(env,row,position,secretRaw as `0x${string}`);
        if (threeMin?.closed) { out.push({coin,status:"THREE_MIN_FORCED_SL",three_min:threeMin,progressive}); continue; }
      } catch (e:any) {
        try { await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET three_min_last_error=?,updated_at=? WHERE id=?`).bind(e?.message??String(e),Date.now(),row.id).run(); } catch {}
      }
    }

    // V2.13 — detect TP1 50%, then replace initial SL with BE + TP2/TP3.
    const liveSzi = Math.abs(Number(position?.szi));
    const reducedSize = entrySize - liveSzi;

    // V2.12.1 — partial-TP detection must respect Hyperliquid size granularity.
    // Example: UNI entry 1.1 with szDecimals=1 cannot close exactly 0.55; the
    // bracket floors the 50% TP to 0.5 and the real runner is therefore 0.6.
    // The old expectedRunnerSize*1.08 check capped the runner at 0.594 and missed
    // this perfectly valid fill. Detect the actual position reduction instead;
    // the fill lookup below confirms the close and supplies its exact size/price.
    if (
      !["BTC1M_DIRECTIONAL_V1","BTC3M_DIRECTIONAL_V1","BTC5M_DIRECTIONAL_V1","BTC10M_DIRECTIONAL_V1"].includes(String(row.strategy_version ?? "")) &&
      !Number(row.partial_tp_filled_at) &&
      Number.isFinite(liveSzi) && liveSzi > 0 &&
      Number.isFinite(reducedSize) && reducedSize > 0 &&
      liveSzi < entrySize * 0.80
    ) {
      const fills = await getRecentFillsForCoin(coin);
      const closes = fills.filter((f:any)=>Number(f?.time??0)>=filledAt && Number.isFinite(Number(f?.closedPnl)) && Math.abs(Number(f?.closedPnl))>1e-15).sort((a:any,b:any)=>Number(a?.time??0)-Number(b?.time??0));
      const partial = closes[0] ?? null;
      if (!partial) {
        out.push({coin,status:"PARTIAL_SIZE_REDUCTION_WAITING_FOR_FILL_CONFIRMATION",live_size:liveSzi,reduced_size:reducedSize});
        continue;
      }
      const partialPx=Number(partial?.px), partialSz=Number(partial?.sz), partialPnl=Number(partial?.closedPnl), partialAt=Number(partial?.time??Date.now());
      await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET partial_tp_filled_at=?,partial_tp_price=?,partial_tp_size=?,partial_tp_realized_pnl=?,runner_active=1,runner_size=?,updated_at=? WHERE id=? AND partial_tp_filled_at IS NULL`)
        .bind(partialAt,Number.isFinite(partialPx)?partialPx:null,Number.isFinite(partialSz)?Math.abs(partialSz):(entrySize-liveSzi),Number.isFinite(partialPnl)?partialPnl:null,liveSzi,Date.now(),row.id).run();
      row.partial_tp_filled_at=partialAt; row.partial_tp_price=Number.isFinite(partialPx)?partialPx:null; row.partial_tp_size=Number.isFinite(partialSz)?Math.abs(partialSz):(entrySize-liveSzi); row.partial_tp_realized_pnl=Number.isFinite(partialPnl)?partialPnl:null; row.runner_active=1; row.runner_size=liveSzi;
      // V2.13.1: progressive_stage=1 means TP1 rearm was already confirmed on a
      // previous tick.  Backfill missing partial_tp_* above, but NEVER cancel and
      // recreate BE/TP2/TP3 a second time.
      if (Number(row.progressive_stage ?? 0) >= 1) {
        out.push({coin,status:"TP1_BOOKKEEPING_BACKFILLED",live_size:liveSzi});
        continue;
      }
      // TP1 confirmed. Cancel the old full-size SL, then arm TP2 +0.30%, TP3 +0.40% and BE SL for the remainder.
      if (!secretOk) {
        out.push({coin,status:"TP1_CONFIRMED_BUT_BE_REARM_BLOCKED",reason:"PRIVATE_KEY_INVALID"});
        continue;
      }
      try {
        const rawMeta=await postInfo({type:"metaAndAssetCtxs"});
        const universe=Array.isArray(rawMeta?.[0]?.universe)?rawMeta[0].universe:[];
        const asset=universe.findIndex((x:any)=>String(x?.name??"").toUpperCase()===coin);
        if(asset<0) throw new Error("ASSET_NOT_FOUND_AFTER_TP1");
        const szDecimals=Number(universe[asset]?.szDecimals);
        const open=await getOpenOrdersForCoin(coin);
        const cancels=open.filter((o:any)=>o?.oid!=null).map((o:any)=>({a:asset,o:Number(o.oid)}));
        if(cancels.length) await sendLifecycleSignedAction({type:"cancel",cancels},secretRaw as `0x${string}`);

        const scale=10**szDecimals;
        const remUnits=Math.round(liveSzi*scale);
        if(remUnits<2) throw new Error("REMAINING_SIZE_TOO_SMALL_FOR_TP2_TP3");
        const tp2Units=Math.max(1,Math.floor(remUnits/2));
        const tp3Units=remUnits-tp2Units;
        if(tp3Units<1) throw new Error("TP3_SIZE_ZERO");
        const tp2Size=tp2Units/scale, tp3Size=tp3Units/scale;
        const tp2Px=priceToWire(entryPrice*(1+CONFIG.LONG_TP2_PCT/100),szDecimals);
        const tp3Px=priceToWire(entryPrice*(1+CONFIG.LONG_TP3_PCT/100),szDecimals);
        const bePx=priceToWire(entryPrice,szDecimals);
        const closeBuy=false; // LONG-only live strategy: exits sell.
        const orders=[
          {a:asset,b:closeBuy,p:tp2Px,s:toWire(tp2Size,szDecimals),r:true,t:{trigger:{isMarket:true,triggerPx:tp2Px,tpsl:"tp"}}},
          {a:asset,b:closeBuy,p:tp3Px,s:toWire(tp3Size,szDecimals),r:true,t:{trigger:{isMarket:true,triggerPx:tp3Px,tpsl:"tp"}}},
          {a:asset,b:closeBuy,p:bePx,s:toWire(liveSzi,szDecimals),r:true,t:{trigger:{isMarket:true,triggerPx:bePx,tpsl:"sl"}}},
        ];
        const rearm=await sendLifecycleSignedAction({type:"order",orders,grouping:"na"},secretRaw as `0x${string}`);
        const sts=rearm?.json?.response?.data?.statuses??[];
        const errs=Array.isArray(sts)?sts.map((x:any)=>x?.error).filter(Boolean):["NO_STATUSES"];
        if(rearm?.json?.status!=="ok" || errs.length){
          await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET last_error=?,updated_at=? WHERE id=?`).bind(`TP1_REARM_FAILED: ${errs.join(" | ")}`,Date.now(),row.id).run();
          await sendTelegram(env,`🚨 <b>TP1 HIT — REARM FAILED</b>\n\n🪙 <b>${escapeTelegramHtml(coin)}</b>\nTP1 filled, but TP2/TP3/BE protection was not confirmed. CHECK POSITION.\n🆔 Crossing: ${escapeTelegramHtml(row.crossing_id)}`);
          out.push({coin,status:"TP1_REARM_FAILED",errors:errs});
          continue;
        }
        await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET progressive_stage=1,progressive_stop_pct=0,progressive_stop_price=?,progressive_updated_at=?,runner_active=1,runner_size=?,updated_at=? WHERE id=?`)
          .bind(Number(bePx),Date.now(),liveSzi,Date.now(),row.id).run();
        row.progressive_stage=1; row.progressive_stop_price=Number(bePx);
        await sendTelegram(env,[`🟢 <b>TP1 HIT · 50%</b>`,``,`🪙 <b>${escapeTelegramHtml(coin)}</b>`,`📈 LONG`,`🎯 Entry: ${entryPrice}`,`🏁 TP1 +0.20%: ${Number.isFinite(partialPx)?partialPx:"confirmed"}`,`📦 Remaining: ${liveSzi}`,`🛡 SL moved to ENTRY: ${bePx}`,`🎯 TP2 +0.30%: ${tp2Px} · 25% initial`,`🎯 TP3 +0.40%: ${tp3Px} · 25% initial`,`🆔 Crossing: ${escapeTelegramHtml(row.crossing_id)}`,``,`🕐 ${new Date().toISOString()}`].join("\n"));
      } catch(e:any) {
        await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET last_error=?,updated_at=? WHERE id=?`).bind(`TP1_REARM_EXCEPTION: ${e?.message??String(e)}`,Date.now(),row.id).run();
        out.push({coin,status:"TP1_REARM_EXCEPTION",error:e?.message??String(e)});
        continue;
      }
    }
    if (false && Number(row.partial_tp_filled_at)) {
      try {
        const rawCtx=await postInfo({type:"metaAndAssetCtxs"}); const uni=Array.isArray(rawCtx?.[0]?.universe)?rawCtx[0].universe:[]; const ctxs=Array.isArray(rawCtx?.[1])?rawCtx[1]:[]; const ai=uni.findIndex((x:any)=>String(x?.name??"").toUpperCase()===coin); const mp=Number(ctxs?.[ai]?.midPx??ctxs?.[ai]?.markPx); const rr=directionalReturnPct(side,entryPrice,mp);
        if(Number.isFinite(rr)) await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET runner_max_return_pct=MAX(COALESCE(runner_max_return_pct,0),?),runner_size=?,runner_active=1 WHERE id=?`).bind(rr,liveSzi,row.id).run();
      } catch {}
    }

    if (true) {
      // V2.16.3 BTC1M DIRECTIONAL: full position stays open; no fixed TP and no scale-out.
      // Progressive lock is advanced above whenever the live price reaches the next trigger.
      out.push({
        coin,status:"OPEN",held_ms:heldMs,progressive,
        virtual_tp20_hit:Boolean(row.virtual_tp20_hit_at),
        max_favorable_return_pct:Number.isFinite(Number(row.max_favorable_return_pct))?Number(row.max_favorable_return_pct):null
      });
      continue;
    }
    if (!secretOk) { out.push({coin,status:"MAX_HOLD_BLOCKED",reason:"PRIVATE_KEY_INVALID"}); continue; }

    // MAX HOLD: close the actual remaining position, not the original requested size.
    const raw = await postInfo({ type: "metaAndAssetCtxs" });
    const universe = Array.isArray(raw?.[0]?.universe) ? raw[0].universe : [];
    const contexts = Array.isArray(raw?.[1]) ? raw[1] : [];
    const asset = universe.findIndex((x:any)=>x?.name===coin);
    if (asset < 0) { out.push({coin,status:"MAX_HOLD_BLOCKED",reason:"ASSET_NOT_FOUND"}); continue; }
    const szDecimals = Number(universe[asset]?.szDecimals);
    const szi = Number(position?.szi);
    const mark = Number(contexts?.[asset]?.midPx ?? contexts?.[asset]?.markPx);
    if (!Number.isFinite(szi)||szi===0||!Number.isFinite(mark)||mark<=0) continue;
    const closeBuy = szi < 0;
    const limit = closeBuy ? mark*(1+CONFIG.MAX_ENTRY_SLIPPAGE_PCT/100) : mark*(1-CONFIG.MAX_ENTRY_SLIPPAGE_PCT/100);
    const closeAction = { type:"order", orders:[{a:asset,b:closeBuy,p:priceToWire(limit,szDecimals),s:toWire(Math.abs(szi),szDecimals),r:true,t:{limit:{tif:"Ioc"}}}], grouping:"na" };
    await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET status='MAX_HOLD_CLOSING',updated_at=? WHERE id=?`).bind(Date.now(),row.id).run();
    const closeRes = await sendLifecycleSignedAction(closeAction, secretRaw as `0x${string}`);
    const st = closeRes?.json?.response?.data?.statuses?.[0];
    if (!st?.filled) { out.push({coin,status:"MAX_HOLD_CLOSE_FAILED",response:closeRes.json}); continue; }

    // Cancel any stale TP/SL orders left after the forced close.
    try {
      const open = await getOpenOrdersForCoin(coin);
      const cancels = open.filter((o:any)=>o?.oid!=null).map((o:any)=>({a:asset,o:Number(o.oid)}));
      if (cancels.length) await sendLifecycleSignedAction({type:"cancel",cancels}, secretRaw as `0x${string}`);
    } catch {}
    const exitPrice = Number(st.filled?.avgPx ?? st.filled?.px);
    const postCloseFills = await getRecentFillsForCoin(coin);
    const closeFill = postCloseFills.find((f:any) =>
      Number(f?.time ?? 0) >= Date.now() - 60_000 &&
      Number.isFinite(Number(f?.px))
    );
    const exchangeClosedPnl = Number(closeFill?.closedPnl ?? st.filled?.closedPnl);
    const pnl = lifecyclePnlFromFills(
      postCloseFills,
      filledAt,
      entryPrice,
      exitPrice,
      Math.abs(szi),
      side,
      Number.isFinite(exchangeClosedPnl) ? exchangeClosedPnl : null
    );

    await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET status='MAX_HOLD_EXIT',updated_at=?,closed_at=?,close_reason='MAX_HOLD_30M',exit_price=?,realized_pnl=?,runner_active=0 WHERE id=?`)
      .bind(Date.now(),Date.now(),Number.isFinite(exitPrice)?exitPrice:null,pnl.netPnl,row.id).run();

    await sendTelegram(env,lifecycleTelegram({
      emoji:"⏱",title:"MAX HOLD 30M EXIT",coin,side,entryPrice,exitPrice,
      size:Math.abs(szi),
      grossPnl:pnl.grossPnl,
      fees:pnl.fees,
      netPnl:pnl.netPnl,
      heldMs,crossingId:row.crossing_id
    }));
    out.push({coin,status:"MAX_HOLD_EXIT",exit_price:exitPrice,net_pnl:pnl.netPnl});
  }
  return { success:true, checked:items.length, results:out };
}

export async function buildHyperliquidExecutionCandidate(
  signal: HyperliquidExecutionSignal,
  env?: HyperliquidExecutionEnv
): Promise<Record<string, any>> {
  // V2.16.1 READ-ONLY TIMING INSTRUMENTATION.
  // These timestamps do not gate, delay or alter execution.
  const latencyExecutionStartedAt = Date.now();
  const latencyAudit: Record<string, number | null> = {
    execution_started_at: latencyExecutionStartedAt,
    meta_ms: null,
    active_asset_preview_ms: null,
    claim_ms: null,
    availability_ms: null,
    account_snapshot_ms: null,
    exposure_check_ms: null,
    leverage_ms: null,
    ioc_ms: null,
    fill_received_at: null,
  };

  if (String(signal?.strategy_version??'').startsWith('SWING_'))
    return {eligible:false,status:'BLOCKED',reason:'SWING_OWN_EXECUTOR_ONLY'};
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

  // V2.10.1 — dynamic per-asset leverage.
  // Hyperliquid meta.universe exposes maxLeverage for each perp.
  const rawAssetMaxLeverage = Number(universe[asset]?.maxLeverage);
  if (!Number.isFinite(rawAssetMaxLeverage) || rawAssetMaxLeverage < 1) {
    return {
      eligible: false,
      status: "SKIPPED",
      reason: "ASSET_MAX_LEVERAGE_UNAVAILABLE",
      coin,
      raw_max_leverage: universe[asset]?.maxLeverage ?? null,
      live_trading: CONFIG.LIVE_TRADING,
    };
  }

  const assetMaxLeverage = Math.max(1, Math.floor(rawAssetMaxLeverage));
  const effectiveLeverage = Math.min(CONFIG.TARGET_LEVERAGE, assetMaxLeverage);
  const leverageWasCapped = effectiveLeverage < CONFIG.TARGET_LEVERAGE;

  // V2.10.2 — FIXED NOTIONAL / DYNAMIC MARGIN.
  // Preserve the strategy's original exposure: $1.04 × 10x = $10.40.
  // If an asset supports less leverage, increase collateral only enough to
  // keep the same ~$10.40 position notional. We do NOT increase notional/risk.
  const positionUsdTarget =
    CONFIG.BASE_MARGIN_USD * CONFIG.TARGET_LEVERAGE;
  const effectiveMarginUsd =
    positionUsdTarget / effectiveLeverage;
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
    szDecimals,
    positionUsdTarget
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
  const latencyActiveAssetPreviewStartedAt = Date.now();
  try {
    activeAssetData = await postInfo({
      type: "activeAssetData",
      user: MASTER_ACCOUNT,
      coin,
    });
    latencyAudit.active_asset_preview_ms = Date.now() - latencyActiveAssetPreviewStartedAt;
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
    currentLeverageValue === effectiveLeverage;

  const leverageAction = {
    type: "updateLeverage",
    asset,
    isCross: CONFIG.IS_CROSS,
    leverage: effectiveLeverage,
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
    reason: "NEW_MOVE_BTC_LOOKBACK_SIGNAL",
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
      margin_usd: effectiveMarginUsd,
      base_margin_usd: CONFIG.BASE_MARGIN_USD,
      effective_margin_usd: effectiveMarginUsd,
      leverage: effectiveLeverage,
      leverage_type: desiredLeverageType,
      strategy_target_leverage: CONFIG.TARGET_LEVERAGE,
      asset_max_leverage: assetMaxLeverage,
      leverage_capped_by_asset: leverageWasCapped,
      leverage_policy: "DYNAMIC_MIN_STRATEGY_TARGET_ASSET_MAX",
      notional_policy: "FIXED_STRATEGY_NOTIONAL_DYNAMIC_MARGIN",
      strategy_target_notional_usd: positionUsdTarget,
      current_exchange_leverage: {
        type: currentLeverageType || null,
        value: Number.isFinite(currentLeverageValue) ? currentLeverageValue : null,
      },
      leverage_already_correct: leverageAlreadyCorrect,
      leverage_update_required: !leverageAlreadyCorrect,
      position_usd_target: positionUsdTarget,
      entry_mode: "MARKETABLE_IOC_MOVE_BTC_LOOKBACK",
      strategy_version: String(signal.strategy_version ?? "BTC1M_DIRECTIONAL_V1"),
      setup_name: signal.setup_name ?? null,
      entry_price_source: "CURRENT_HYPERLIQUID_MID_FALLBACK_MARK",
      market_reference_price: marketReferenceWire,
      max_entry_slippage_pct: CONFIG.MAX_ENTRY_SLIPPAGE_PCT,
      ioc_limit_price: iocLimitWire,
      size: sizeWire,
      estimated_notional_usd: Number(estimatedNotionalUsd.toFixed(8)),
      take_profit_pct: takeProfitPct,
      stop_loss_pct: stopLossPct,
      progressive_strategy: "DISABLED",
      progressive_steps: [],
      tpsl_price_source_live: "ACTUAL_FILL_PRICE",
      preview_fill_price: marketReferenceWire,
      preview_take_profit_trigger: previewTpWire,
      preview_stop_loss_trigger: previewSlWire,
      trade_policy: "MOVE_DETECTOR_PLUS_BTC_DIRECTION",
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
      note: "LIVE applies min(strategy target, Hyperliquid asset maxLeverage). Target notional stays fixed at the original ~$10.40; margin increases automatically when asset max leverage is lower. TP/SL are recalculated from actual fill price.",
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

  // Cross-strategy exclusion before sending any SCALP order.
  if (!env?.DB) return {...result,eligible:false,status:'BLOCKED',reason:'D1_REQUIRED_FOR_COIN_OWNERSHIP'};
  try {
    const swingOwner:any = await env.DB.prepare(`SELECT coin FROM swing_coin_owners
      WHERE coin=? AND status IN ('RESERVED','OPEN','CLOSING','UNKNOWN') LIMIT 1`)
      .bind(coin).first();
    if (swingOwner) return {...result,eligible:false,status:'BLOCKED',reason:'SWING_OWNS_COIN'};
  } catch(e:any) {
    return {...result,eligible:false,status:'BLOCKED',reason:'COIN_OWNER_CHECK_FAILED',detail:String(e?.message??e)};
  }
  const latencyClaimStartedAt = Date.now();
  const claim = await claimExecutionOnce(env?.DB, signal, coin, side);
  latencyAudit.claim_ms = Date.now() - latencyClaimStartedAt;
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

  // V2.7.2 pre-entry guard:
  // Use Hyperliquid's per-asset/per-direction availableToTrade, not
  // clearinghouseState.withdrawable. The latter can be 0 while the account
  // still reports USDC and Hyperliquid itself exposes tradable availability.
  // Entry-critical availability is intentionally requested alone. The old code
  // launched activeAssetData + clearinghouseState + spotClearinghouseState at
  // the same time, creating a burst of three /info calls exactly when a signal
  // arrived. That made INFO_HTTP_429 much more likely.
  const latencyAvailabilityStartedAt = Date.now();
  const tradingAvailability = await getActiveAssetTradingAvailability(coin, side);
  latencyAudit.availability_ms = Date.now() - latencyAvailabilityStartedAt;

  const latencyAccountSnapshotStartedAt = Date.now();
  const preEntryBalance = tradingAvailability?.success
    ? await getAccountSnapshot()
    : { success:false, error:"SKIPPED_AFTER_ACTIVE_ASSET_FAILURE", account_value_usd:null, margin_used_usd:null, withdrawable_usd:null, usdc_total:null, usdc_hold:null };
  latencyAudit.account_snapshot_ms = tradingAvailability?.success
    ? Date.now() - latencyAccountSnapshotStartedAt
    : 0;

  const availableMargin = Number(tradingAvailability?.available_to_trade);
  const maxTradeSz = Number(tradingAvailability?.max_trade_sz);
  const availabilityMarkPx = Number(tradingAvailability?.mark_px);

  // Compare like-for-like notionals. effectiveMarginUsd is the dynamically
  // required collateral, while targetNotionalUsd remains fixed at ~$10.40.
  const targetNotionalUsd = positionUsdTarget;
  const maxTradableNotionalUsd =
    Number.isFinite(maxTradeSz) && Number.isFinite(availabilityMarkPx)
      ? maxTradeSz * availabilityMarkPx
      : NaN;

  // Small headroom prevents requesting the absolute exchange maximum and
  // reduces partial IOC fills caused by price movement between check and order.
  const requiredNotionalWithHeadroom =
    targetNotionalUsd + CONFIG.MIN_MARGIN_HEADROOM_USD * effectiveLeverage;

  if (
    !tradingAvailability?.success ||
    !Number.isFinite(maxTradableNotionalUsd) ||
    maxTradableNotionalUsd < requiredNotionalWithHeadroom
  ) {
    const reason = tradingAvailability?.success
      ? `INSUFFICIENT_MAX_TRADABLE_NOTIONAL: target=$${targetNotionalUsd.toFixed(4)} max=$${Number.isFinite(maxTradableNotionalUsd) ? maxTradableNotionalUsd.toFixed(4) : "unknown"} available=${Number.isFinite(availableMargin) ? availableMargin.toFixed(6) : "unknown"} coin=${coin} side=${side}`
      : `ACTIVE_ASSET_AVAILABILITY_UNAVAILABLE: ${String(tradingAvailability?.error ?? "unknown")}`;

    await updateExecutionLedger(
      env?.DB,
      signal.crossing_id,
      "ENTRY_BLOCKED_BALANCE",
      { last_error: reason }
    );

    const tg = await sendTelegram(
      env,
      buildRejectedTelegramMessage({
        coin,
        side,
        score,
        crossingId: signal.crossing_id,
        episodeId: signal.episode_id,
        marginUsd: effectiveMarginUsd,
        leverage: effectiveLeverage,
        reason,
        balance: {
          ...preEntryBalance,
          active_asset_available_to_trade:
            Number.isFinite(availableMargin) ? availableMargin : null,
          active_asset_source: tradingAvailability?.source ?? null,
        },
      })
    );

    return {
      ...result,
      eligible: false,
      status: "LIVE_ENTRY_BLOCKED_INSUFFICIENT_MARGIN",
      reason,
      account_balance: preEntryBalance,
      trading_availability: tradingAvailability,
      notional_guard: {
        target_notional_usd: targetNotionalUsd,
        max_tradable_notional_usd: Number.isFinite(maxTradableNotionalUsd)
          ? maxTradableNotionalUsd
          : null,
        required_with_headroom_usd: requiredNotionalWithHeadroom,
      },
      telegram: { sent: tg.sent, reason: tg.reason ?? null },
      exchange_request_sent: false,
    };
  }

  const latencyExposureStartedAt = Date.now();
  const existingPosition = await getOpenPositionForCoin(coin);
  const existingOrders = await getOpenOrdersForCoin(coin);
  latencyAudit.exposure_check_ms = Date.now() - latencyExposureStartedAt;
  if (existingPosition || existingOrders.length > 0) {
    const reason = existingPosition ? "EXISTING_POSITION_FOR_COIN" : "EXISTING_OPEN_ORDERS_FOR_COIN";
    await updateExecutionLedger(env?.DB, signal.crossing_id, "ENTRY_BLOCKED_EXISTING_EXPOSURE", { last_error: reason });
    const tg = await sendTelegram(env, buildRejectedTelegramMessage({coin,side,score,crossingId:signal.crossing_id,episodeId:signal.episode_id,marginUsd:effectiveMarginUsd,leverage:effectiveLeverage,reason,balance:preEntryBalance}));
    return {...result,eligible:false,status:"LIVE_ENTRY_BLOCKED_EXISTING_EXPOSURE",reason,existing_position:existingPosition??null,existing_open_orders:existingOrders.length,telegram:{sent:tg.sent,reason:tg.reason??null},exchange_request_sent:false};
  }

  let lastNonce = 0;
  function nextNonce(): number {
    const now = Date.now();
    lastNonce = Math.max(now, lastNonce + 1);
    return lastNonce;
  }

  async function sendSignedAction(action: Record<string, any>) {
    const nonce = nextNonce();
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
  const latencyLeverageStartedAt = Date.now();
  if (!leverageAlreadyCorrect) {
    try {
      leverageResponse = await sendSignedAction(leverageAction);
    } catch (e: any) {
      const levReason = e?.message ?? String(e);
      await updateExecutionLedger(env?.DB, signal.crossing_id, "LEVERAGE_ERROR", { last_error: levReason });
      const levBal = await getAccountSnapshot();
      const levTg = await sendTelegram(env, buildRejectedTelegramMessage({coin,side,score,crossingId:signal.crossing_id,episodeId:signal.episode_id,marginUsd:effectiveMarginUsd,leverage:effectiveLeverage,reason:`LEVERAGE_ERROR: ${levReason}`,balance:levBal}));
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
      await updateExecutionLedger(env?.DB, signal.crossing_id, "LEVERAGE_REJECTED", { last_error: "LEVERAGE_NOT_CONFIRMED_ENTRY_BLOCKED" });
      const levBal = await getAccountSnapshot();
      const levTg = await sendTelegram(env, buildRejectedTelegramMessage({coin,side,score,crossingId:signal.crossing_id,episodeId:signal.episode_id,marginUsd:effectiveMarginUsd,leverage:effectiveLeverage,reason:"LEVERAGE_NOT_CONFIRMED_ENTRY_BLOCKED",balance:levBal}));
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
  latencyAudit.leverage_ms = leverageAlreadyCorrect ? 0 : Date.now() - latencyLeverageStartedAt;

  let entryResponse: any;
  const latencyIocStartedAt = Date.now();
  try {
    entryResponse = await sendSignedAction(entryAction);
    latencyAudit.ioc_ms = Date.now() - latencyIocStartedAt;
    latencyAudit.fill_received_at = Date.now();
  } catch (e: any) {
    const rejectReason = e?.message ?? String(e);
    await updateExecutionLedger(env?.DB, signal.crossing_id, "ENTRY_ERROR", {
      last_error: rejectReason,
    });
    const rejectBalance = await getAccountSnapshot();
    const rejectTelegram = await sendTelegram(
      env,
      buildRejectedTelegramMessage({
        coin, side, score,
        crossingId: signal.crossing_id ?? null,
        episodeId: signal.episode_id ?? null,
        marginUsd: effectiveMarginUsd,
        leverage: effectiveLeverage,
        reason: rejectReason,
        balance: rejectBalance,
      })
    );
    return {
      ...result,
      status: "LIVE_ENTRY_TRANSPORT_ERROR",
      account_balance: rejectBalance,
      telegram: { sent: rejectTelegram.sent, reason: rejectTelegram.reason ?? null },
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
    const rejectReason = entryError ?? "IOC_NOT_FILLED";
    await updateExecutionLedger(
      env?.DB,
      signal.crossing_id,
      entryError ? "ENTRY_REJECTED" : "ENTRY_NOT_FILLED",
      { last_error: rejectReason }
    );

    const rejectBalance = await getAccountSnapshot();
    const rejectTelegram = await sendTelegram(
      env,
      buildRejectedTelegramMessage({
        coin, side, score,
        crossingId: signal.crossing_id ?? null,
        episodeId: signal.episode_id ?? null,
        marginUsd: effectiveMarginUsd,
        leverage: effectiveLeverage,
        reason: rejectReason,
        balance: rejectBalance,
      })
    );

    return {
      ...result,
      account_balance: rejectBalance,
      telegram: {
        configured: Boolean(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID),
        sent: rejectTelegram.sent,
        reason: rejectTelegram.reason ?? null,
        http_status: rejectTelegram.http_status ?? null,
      },
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
    await updateExecutionLedger(env?.DB, signal.crossing_id, "ENTRY_FILL_INVALID", { last_error: "INVALID_FILL_DATA_CRITICAL_POSITION_MAY_BE_OPEN" });
    const invalidBal = await getAccountSnapshot();
    await sendTelegram(env, buildRejectedTelegramMessage({coin,side,score,crossingId:signal.crossing_id,episodeId:signal.episode_id,marginUsd:effectiveMarginUsd,leverage:effectiveLeverage,reason:"CRITICAL: ENTRY REPORTED FILLED BUT FILL DATA INVALID — CHECK POSITION NOW",balance:invalidBal}));
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
  try {
    await env?.DB?.prepare(`UPDATE hyperliquid_execution_ledger SET entry_filled_at=? WHERE crossing_id=?`)
      .bind(Date.now(), String(signal.crossing_id)).run();
  } catch {}

  const actualSizeWire = toWire(fillSize, szDecimals);
  // V2.14.1: TP closes 100% of the filled position. 0.30/0.40/0.50 are dashboard-only research targets.
  const partialTpSizeWire = actualSizeWire;
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
    s: partialTpSizeWire,
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
  // V2.15.0: NO fixed TP order. Keep 100% of the position open.
  // The initial exchange protection is SL only; profit is protected by the live progressive ladder.
  const protectionAction = {
    type: "order",
    orders: [slOrder],
    grouping: "na",
  };

  let protectionResponse: any = null;
  let protectionStatuses: any = null;
  let protectionErrors: any[] = [];
  let protectionAttempts = 0;
  let protectionOk = false;
  let protectionLastError: string | null = null;

  // The position already exists here, so protection is retried independently.
  // Retry only the TP/SL action; NEVER resend ENTRY.
  for (let attempt = 1; attempt <= CONFIG.TPSL_MAX_ATTEMPTS; attempt++) {
    protectionAttempts = attempt;

    try {
      protectionResponse = await sendSignedAction(protectionAction);
      protectionStatuses =
        protectionResponse?.json?.response?.data?.statuses ?? null;

      protectionErrors = Array.isArray(protectionStatuses)
        ? protectionStatuses
            .map((x: any) => x?.error ?? null)
            .filter(Boolean)
        : [];

      const httpOk =
        protectionResponse?.httpStatus >= 200 &&
        protectionResponse?.httpStatus < 300;
      const exchangeOk = protectionResponse?.json?.status === "ok";
      const protectionStatusPresent =
        Array.isArray(protectionStatuses) &&
        protectionStatuses.length >= 1;

      protectionOk =
        httpOk &&
        exchangeOk &&
        protectionStatusPresent &&
        protectionErrors.length === 0;

      if (protectionOk) break;

      protectionLastError =
        protectionErrors.length
          ? protectionErrors.join(" | ")
          : `TPSL_NOT_CONFIRMED_ATTEMPT_${attempt}`;
    } catch (e: any) {
      protectionLastError = e?.message ?? String(e);
    }

    if (attempt < CONFIG.TPSL_MAX_ATTEMPTS) {
      await sleep(CONFIG.TPSL_RETRY_DELAY_MS);
    }
  }

  await updateExecutionLedger(
    env?.DB,
    signal.crossing_id,
    protectionOk ? "PROTECTED" : "TPSL_FAILED_AFTER_RETRIES",
    { last_error: protectionOk ? null : protectionLastError }
  );

  // V2.10.5: persist the exact INITIAL SL OID as soon as the bracket is
  // confirmed. Stage 1 can then cancel that exact order after the replacement
  // stop is live, instead of relying on legacy price matching. This prevents
  // the stale Initial-SL + Progressive-SL pair observed in live trading.
  if (protectionOk && env?.DB && signal.crossing_id != null && Array.isArray(protectionStatuses)) {
    const initialSlOid = responseOrderOid(protectionStatuses[0]);
    if (initialSlOid != null) {
      try {
        await env.DB.prepare(`
          UPDATE hyperliquid_execution_ledger
          SET progressive_stop_oid=?, progressive_stop_price=?, progressive_updated_at=?, updated_at=?
          WHERE crossing_id=? AND COALESCE(progressive_stage,0)=0
        `).bind(
          initialSlOid, Number(slWire), Date.now(), Date.now(), String(signal.crossing_id)
        ).run();
      } catch {}
    }
  }

  // Read account state AFTER the filled entry and TP/SL attempts.
  const accountBalance = await getAccountSnapshot();

  // Telegram is best-effort only. A Telegram failure must never change
  // exchange execution or cause an ENTRY retry.
  const telegramMessage = buildEntryTelegramMessage({
    coin,
    side,
    score,
    crossingId: signal.crossing_id ?? null,
    episodeId: signal.episode_id ?? null,
    marginUsd: effectiveMarginUsd,
    leverage: effectiveLeverage,
    leverageType: desiredLeverageType.toUpperCase(),
    fillPrice,
    fillSize: actualSizeWire,
    fillNotional: Number((fillPrice * fillSize).toFixed(8)),
    tpWire,
    slWire,
    takeProfitPct,
    stopLossPct,
    protectionOk,
    protectionAttempts,
    balance: accountBalance,
    latencyAudit,
    signalTs: Number.isFinite(crossingTs) ? crossingTs : null,
    signalPrice: entryPrice,
  });
  const telegram = await sendTelegram(env, telegramMessage);


  return {
    ...result,
    status: protectionOk
      ? "LIVE_ENTRY_FILLED_TPSL_CONFIRMED"
      : "LIVE_ENTRY_FILLED_TPSL_FAILED_AFTER_RETRIES",
    exchange_request_sent: true,
    live_leverage: {
      required: !leverageAlreadyCorrect,
      updated: leverageAlreadyCorrect ? false : true,
      already_correct: leverageAlreadyCorrect,
      target: { type: desiredLeverageType, value: effectiveLeverage },
      strategy_target: CONFIG.TARGET_LEVERAGE,
      asset_max: assetMaxLeverage,
      capped_by_asset: leverageWasCapped,
    },
    execution_latency_audit: {
      ...latencyAudit,
      signal_to_execution_ms:
        Number.isFinite(crossingTs) ? Math.max(0, latencyExecutionStartedAt - crossingTs) : null,
      execution_to_fill_ms:
        Number.isFinite(Number(latencyAudit.fill_received_at))
          ? Math.max(0, Number(latencyAudit.fill_received_at) - latencyExecutionStartedAt)
          : null,
      signal_to_fill_ms:
        Number.isFinite(crossingTs) && Number.isFinite(Number(latencyAudit.fill_received_at))
          ? Math.max(0, Number(latencyAudit.fill_received_at) - crossingTs)
          : null,
      signal_price: entryPrice,
      fill_price: fillPrice,
      directional_move_before_fill_pct:
        Number.isFinite(entryPrice) && entryPrice > 0
          ? roundTo(
              side === "SHORT"
                ? ((entryPrice - fillPrice) / entryPrice) * 100
                : ((fillPrice - entryPrice) / entryPrice) * 100,
              6
            )
          : null,
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
      progressive_strategy: "FULL_POSITION_UNBOUNDED_PROFIT_LOCK",
      progressive_first_trigger_pct: CONFIG.PROGRESSIVE_FIRST_TRIGGER_PCT,
      progressive_first_stop_pct: CONFIG.PROGRESSIVE_FIRST_STOP_PCT,
      progressive_step_pct: CONFIG.PROGRESSIVE_STEP_PCT,
      virtual_tp20_pct: CONFIG.VIRTUAL_TP20_PCT,
      fixed_take_profit_order: false,
      position_fraction_kept_open: 1.0,
      runner_mode: "100_PERCENT_PROGRESSIVE_PROFIT_LOCK",
      grouping: "na",
      http_status: protectionResponse?.httpStatus ?? null,
      returned_statuses: protectionStatuses,
      errors: protectionErrors,
      confirmed: protectionOk,
      attempts: protectionAttempts,
      max_attempts: CONFIG.TPSL_MAX_ATTEMPTS,
      last_error: protectionLastError,
    },
    account_balance: accountBalance,
    telegram: {
      configured: Boolean(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID),
      sent: telegram.sent,
      reason: telegram.reason ?? null,
      http_status: telegram.http_status ?? null,
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


// ===== SWING SHORT FILTERED V1 — dedicated fixed TP/SL execution =====
const SWING_SHORT_STRATEGY='SWING_SHORT_FILTERED_V1';
const SWING_LONG_STRATEGY='SWING_LONG_FILTERED_V1';
const SWING_SHORT_B_STRATEGY='SWING_SHORT_DOUBLE_MIXED_B_V1';
// Preserve the legacy SHORT strategy for monitoring/closing existing positions.
const SWING_STRATEGIES=[SWING_SHORT_STRATEGY,SWING_SHORT_B_STRATEGY,SWING_LONG_STRATEGY];
// SHORT legacy pattern allowlist removed: only the researched 1H regime rules apply.
const SWING_SHORT_1H_RULES:Record<string,Record<string,{tp:number;sl:number}>>={
 LONG_REGIME:{
  RANGE_BREAKDOWN:{tp:2,sl:1.5},BREAKOUT_RETEST_SHORT:{tp:2,sl:1.5},
  DOUBLE_TOP:{tp:2,sl:1},V2_BEAR_ENGULF:{tp:2,sl:1.5},
  V2_SHOOTING_STAR:{tp:2,sl:1.5}
 },
 SHORT_REGIME:{
  SHOOTING_STAR:{tp:1.5,sl:1.5},BREAKOUT_RETEST_SHORT:{tp:2,sl:1.5},
  LIQUIDITY_SWEEP_HIGH:{tp:1.5,sl:1},TRIANGLE_DOWN:{tp:2,sl:1.5},
  EMA_PULLBACK_SHORT:{tp:2,sl:1.5}
 },
 NEUTRAL:{
  V2_DOUBLE_TOP:{tp:2,sl:0.75},DOUBLE_TOP:{tp:2,sl:1.5},
  V3_INVERSE_CUP_HANDLE:{tp:2,sl:0.5},VOLUME_EXPANSION_SHORT:{tp:2,sl:1.5},
  RANGE_BREAKDOWN:{tp:2,sl:1.5}
 }
};
// Selected 4H SHORT rules from resolved hypothetical scenarios.
// SHORT_REGIME intentionally has no 4H SHORT entries (all ranked averages negative).
const SWING_SHORT_4H_RULES:Record<string,Record<string,{tp:number;sl:number}>>={
 LONG_REGIME:{
  MOMENTUM_REVERSAL_SHORT:{tp:2,sl:0.3},
  BEAR_ENGULF:{tp:2,sl:1},
  LIQUIDITY_SWEEP_HIGH:{tp:2,sl:1.5}
 },
 NEUTRAL:{
  EMA_PULLBACK_SHORT:{tp:2,sl:1.5},
  TRIANGLE_DOWN:{tp:2,sl:1.5},
  MOMENTUM_REVERSAL_SHORT:{tp:2,sl:1.5},
  BEAR_ENGULF:{tp:0.5,sl:1}
 }
};
// Historical 1H LONG selections: market regime -> pattern -> TP/SL (percent).
// No change to SHORT or 4H. These are research-derived, not guaranteed returns.
const SWING_LONG_1H_RULES:Record<string,Record<string,{tp:number;sl:number}>>={
 LONG_REGIME:{
  V3_CUP_HANDLE:{tp:2,sl:1.5},V3_BULL_FLAG:{tp:2,sl:1},
  MOMENTUM_REVERSAL_LONG:{tp:2,sl:0.75},V3_TRIPLE_BOTTOM:{tp:0.5,sl:0.5},
  HAMMER:{tp:2,sl:0.3}
 },
 SHORT_REGIME:{
  TRIANGLE_UP:{tp:2,sl:0.75},V3_FALLING_WEDGE:{tp:1.5,sl:1.5},
  V2_BULL_ENGULF:{tp:0.75,sl:1.5},RANGE_BREAKOUT:{tp:2,sl:1.5},
  LIQUIDITY_SWEEP_LOW:{tp:2,sl:0.3}
 },
 NEUTRAL:{EMA_PULLBACK_LONG:{tp:1,sl:1}}
};
// Selected 4H LONG reversal only. Other 4H LONG patterns remain disabled.
// Historical hypothetical outcomes: LONG 5/6 TP, SHORT 15/18 TP; each cohort spans one day.
const SWING_LONG_4H_RULES:Record<string,Record<string,{tp:number;sl:number}>>={
 LONG_REGIME:{MOMENTUM_REVERSAL_LONG:{tp:2,sl:1}},
 SHORT_REGIME:{MOMENTUM_REVERSAL_LONG:{tp:1.5,sl:1.5}}
};
// Derive regime using only 1H signals in the 24 *completed* preceding hours
// that had actually been created by the signal's availability timestamp.
// Fail closed if timestamps are unavailable or ambiguous.
async function swingLongRegimeAt(db:any,at:number):Promise<string|null>{
 if(!Number.isFinite(at)||at<=0)return null;
 const hour=Math.floor(at/3600000)*3600000;
 const result:any=await db.prepare(`SELECT
 SUM(CASE WHEN side='LONG' THEN 1 ELSE 0 END) AS longs,
 SUM(CASE WHEN side='SHORT' THEN 1 ELSE 0 END) AS shorts
 FROM swing_context_signals
 WHERE interval='1h' AND side IN ('LONG','SHORT')
 AND signal_available_at>=? AND signal_available_at<?
 AND created_at IS NOT NULL AND unixepoch(created_at) IS NOT NULL
 AND unixepoch(created_at)*1000<=?`)
 .bind(hour-24*3600000,hour,at).first();
 const l=Number(result?.longs??0),sh=Number(result?.shorts??0),total=l+sh;
 if(total<10)return null;
 if(l/total>=0.60)return 'LONG_REGIME';
 if(sh/total>=0.60)return 'SHORT_REGIME';
 return 'NEUTRAL';
}
function swingLongPick(regime:string,patterns:string[],interval:'1h'|'4h'):{pattern:string;tp:number;sl:number}|null{
 const rules=(interval==='4h'?SWING_LONG_4H_RULES:SWING_LONG_1H_RULES)[regime];if(!rules)return null;
 // Stable selection for simultaneous patterns: first in explicit ranked rule order.
 for(const [pattern,params] of Object.entries(rules))
  if(patterns.includes(pattern))return {pattern,...params};
 return null;
}
async function swingLongQueueRule(db:any,row:any):Promise<{pattern:string;tp:number;sl:number;regime:string}|null>{
 if(String(row.side)!=='LONG')return null;
 const interval=String(row.signal_key).split(':')[3];
 if(interval!=='1h'&&interval!=='4h')return null;
 const at=Number(row.signal_available_at);
 const regime=await swingLongRegimeAt(db,at);
 if(!regime)return null;
 let patterns:string[]=[];
 try{const v=JSON.parse(String(row.patterns_json));if(Array.isArray(v))patterns=v.map(String);}catch{}
 const picked=swingLongPick(regime,patterns,interval as '1h'|'4h');
 if(!picked)return null;
 return {...picked,regime};
}
function swingShortPick(regime:string,patterns:string[],interval:'1h'|'4h'):{pattern:string;tp:number;sl:number}|null{
 const rules=(interval==='4h'?SWING_SHORT_4H_RULES:SWING_SHORT_1H_RULES)[regime];if(!rules)return null;
 for(const [pattern,params] of Object.entries(rules))
  if(patterns.includes(pattern))return {pattern,...params};
 return null;
}
async function swingShortQueueRule(db:any,row:any):Promise<{pattern:string;tp:number;sl:number;regime:string}|null>{
 if(String(row.side)!=='SHORT')return null;
 const interval=String(row.signal_key).split(':')[3];
 if(interval!=='1h'&&interval!=='4h')return null;
 const regime=await swingLongRegimeAt(db,Number(row.signal_available_at));if(!regime)return null;
 let patterns:string[]=[];
 try{const v=JSON.parse(String(row.patterns_json));if(Array.isArray(v))patterns=v.map(String);}catch{}
 const picked=swingShortPick(regime,patterns,interval as '1h'|'4h');return picked?{...picked,regime}:null;
}
const SWING_MAX_WAIT=20*60_000, SWING_RETRY=2*60_000;
// New Swing entries only. Legacy positions keep their exchange-native TP/SL.
const SWING_PROGRESSIVE_MODE='PROGRESSIVE_V1';
const SWING_PROGRESSIVE_TRIGGER=0.50;
const SWING_PROGRESSIVE_GAP=0.10;
const SWING_PROGRESSIVE_STEP=0.10;
const SWING_PROGRESSIVE_INITIAL_SL=1.0;
function swingIsProgressive(row:any){return String(row?.exit_mode??'')===SWING_PROGRESSIVE_MODE;}
function swingProgressiveTarget(peak:number):number|null{
 if(!Number.isFinite(peak)||peak+1e-9<SWING_PROGRESSIVE_TRIGGER)return null;
 const steps=Math.max(0,Math.floor((peak-SWING_PROGRESSIVE_TRIGGER+1e-9)/SWING_PROGRESSIVE_STEP));
 return roundTo(SWING_PROGRESSIVE_TRIGGER+steps*SWING_PROGRESSIVE_STEP-SWING_PROGRESSIVE_GAP,6);
}
function swingReturnPct(side:string,entry:number,price:number){
 return (side==='LONG'?(price/entry-1):(1-price/entry))*100;
}

// Swing holding periods are measured from the confirmed LIVE entry fill, not signal time.
const SWING_HOLD_1H_MS=48*60*60_000;
const SWING_HOLD_4H_MS=72*60*60_000;
function swingMaxHoldMs(signalKey:string):number|null {
 const tf=/^SWING:(?:LONG|SHORT):[^:]+:(1h|4h):/.exec(signalKey)?.[1];
 return tf==='1h'?SWING_HOLD_1H_MS:tf==='4h'?SWING_HOLD_4H_MS:null;
}
// Telegram lifecycle for filtered SWING positions only (does not affect SCALP messages).
function swingTelegramMeta(key:string,side:string,meta:{regime?:any;pattern?:any;tpPct?:any;slPct?:any}){
 const tf=/^SWING:(?:LONG|SHORT):[^:]+:(1h|4h):/.exec(key)?.[1]??'n/a';
 const pct=(v:any)=>v!=null&&v!==''&&Number.isFinite(Number(v))&&Number(v)>0?`${Number(v)}%`:'n/a';
 return [
  `📊 Strategy: <b>SWING ${escapeTelegramHtml(side)} ${escapeTelegramHtml(tf.toUpperCase())}</b>`,
  `🌍 Market regime: ${escapeTelegramHtml(meta.regime??'n/a')}`,
  `🔎 Selected pattern: ${escapeTelegramHtml(meta.pattern??'n/a')}`,
  `🎯 TP target: ${escapeTelegramHtml(pct(meta.tpPct))}`,
  `🛑 SL limit: ${escapeTelegramHtml(pct(meta.slPct))}`,
  `🆔 Signal: ${escapeTelegramHtml(key)}`
 ];
}
function swingEntryTelegram(a:{coin:string;side:string;key:string;regime:any;pattern:any;tpPct:any;slPct:any;px:number;sz:number;leverage:number;tp:string;sl:string;protectedOk:boolean;reason:string;}){
 return [a.protectedOk?'🟢 <b>SWING LIVE ENTRY · PROTECTED</b>':'🚨 <b>SWING LIVE ENTRY · PROTECTION NOT CONFIRMED</b>',
  '',`🪙 <b>${escapeTelegramHtml(a.coin)}</b> · ${a.side==='LONG'?'📈 LONG':'📉 SHORT'}`,
  ...swingTelegramMeta(a.key,a.side,{regime:a.regime,pattern:a.pattern,tpPct:a.tpPct,slPct:a.slPct}),
  `🎯 Fill: ${escapeTelegramHtml(a.px)}`,
  `📦 Size: ${escapeTelegramHtml(a.sz)}`,
  `💰 Margin target: $${CONFIG.BASE_MARGIN_USD.toFixed(2)}`,
  `⚙️ ${CONFIG.IS_CROSS?'CROSS':'ISOLATED'} ${a.leverage}x (asset cap applied)`,
  `📊 Filled notional: $${(a.px*a.sz).toFixed(4)}`,
  `🟢 TP price: ${escapeTelegramHtml(a.tp)}`,
  `🔴 SL price: ${escapeTelegramHtml(a.sl)}`,
  `🛡 Protection: ${a.protectedOk?'CONFIRMED':'UNCONFIRMED — CHECK EXCHANGE'}`,
  ...(!a.protectedOk?[`⚠️ ${escapeTelegramHtml(a.reason)}`]:[]),
  `🕐 ${new Date().toISOString()}`].join('\n');
}
function swingExitTelegram(a:{coin:string;side:string;key:string;regime:any;pattern:any;tpPct:any;slPct:any;entry:number;exit:number;sz:number;reason:string;gross:any;fees:any;net:any;heldMs:number;mode?:string;peak?:number|null;locked?:number|null}){
 const fmt=(v:any)=>v==null||!Number.isFinite(Number(v))?'n/a':'$'+Number(v).toFixed(4);
 const realized=swingReturnPct(a.side,a.entry,a.exit);
 const margin=Number(a.entry)*Number(a.sz)/CONFIG.TARGET_LEVERAGE;
 const netRoi=margin>0&&Number.isFinite(Number(a.net))?Number(a.net)/margin*100:null;
 return [`🏁 <b>SWING LIVE EXIT · ${escapeTelegramHtml(a.reason)}</b>`,'',
  `🪙 <b>${escapeTelegramHtml(a.coin)}</b> · ${a.side==='LONG'?'📈 LONG':'📉 SHORT'}`,
  ...swingTelegramMeta(a.key,a.side,{regime:a.regime,pattern:a.pattern,tpPct:a.tpPct,slPct:a.slPct}),
  `🎯 Entry: ${escapeTelegramHtml(a.entry)}`,
  `🏁 Exit: ${escapeTelegramHtml(a.exit)}`,
  `📦 Size: ${escapeTelegramHtml(a.sz)}`,
  `📈 Реален изход (цена): ${Number.isFinite(realized)?realized.toFixed(4)+'%':'n/a'}`,
  `💹 NET % върху номинала: ${a.net!=null&&a.entry*a.sz>0?(Number(a.net)/(a.entry*a.sz)*100).toFixed(4)+'%':'n/a'}`,
  `📊 NET ROI върху ориентировъчен маржин: ${netRoi!==null?netRoi.toFixed(3)+'%':'n/a'}`,
  ...(a.mode===SWING_PROGRESSIVE_MODE?[
   `🔒 Progressive: trigger +0.50%, gap 0.10%`,
   `🚀 Най-висока наблюдавана печалба: ${a.peak!=null?Number(a.peak).toFixed(3)+'%':'n/a'}`,
   `🛡 Последно потвърден SL: ${a.locked!=null?Number(a.locked).toFixed(3)+'%':'n/a'}`
  ]:[]),
  `💵 Gross P/L: ${fmt(a.gross)}`,
  `💸 Fees: ${fmt(a.fees)}`,
  `💰 NET P/L: ${fmt(a.net)}`,
  `⏱ Held: ${Math.max(0,Math.round(a.heldMs/60000))} min`,
  `🕐 ${new Date().toISOString()}`].join('\n');
}

async function swingSchema(db:any){
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_coin_owners(
 coin TEXT PRIMARY KEY, owner TEXT NOT NULL, strategy TEXT NOT NULL,
 status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_live_queue(
 signal_key TEXT PRIMARY KEY, coin TEXT NOT NULL, signal_available_at INTEGER NOT NULL,
 signal_bar_open INTEGER NOT NULL, reference_price REAL NOT NULL,
 side TEXT NOT NULL DEFAULT 'SHORT',
 patterns_json TEXT NOT NULL, status TEXT NOT NULL, next_retry_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reason TEXT)`).run();
 const columns:any=await db.prepare('PRAGMA table_info(swing_live_queue)').all();
 if(!(columns.results??[]).some((c:any)=>c.name==='side'))
  await db.prepare("ALTER TABLE swing_live_queue ADD COLUMN side TEXT NOT NULL DEFAULT 'SHORT'").run();
 for(const [name,type] of [['market_regime','TEXT'],['selected_pattern','TEXT'],['tp_pct','REAL'],['sl_pct','REAL'],['exit_mode',"TEXT NOT NULL DEFAULT 'FIXED_TPSL'"]]){
  if(!(columns.results??[]).some((c:any)=>c.name===name))
   await db.prepare(`ALTER TABLE swing_live_queue ADD COLUMN ${name} ${type}`).run();
 }
}
// Persist confirmed protection order identifiers; no blind TP/SL resubmission.
// Swing Progressive audit is observational only. Logging failures never block live protection.
async function swingProgressiveAuditSchema(db:any){
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_progressive_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_key TEXT NOT NULL,coin TEXT NOT NULL,side TEXT NOT NULL,
  detected_at INTEGER NOT NULL,confirmed_at INTEGER,
  entry_price REAL NOT NULL,market_price REAL NOT NULL,
  observed_pct REAL NOT NULL,peak_pct REAL NOT NULL,
  old_locked_pct REAL,target_locked_pct REAL,
  old_sl_price REAL,new_sl_price REAL,
  old_sl_oid TEXT,new_sl_oid TEXT,
  event TEXT NOT NULL,error TEXT
 )`).run();
 await db.prepare('CREATE INDEX IF NOT EXISTS idx_swing_progressive_history_key ON swing_progressive_history(signal_key,detected_at)').run();
}
async function swingProgressiveAudit(db:any,data:any):Promise<number|null>{
 try{
  const result:any=await db.prepare(`INSERT INTO swing_progressive_history
   (signal_key,coin,side,detected_at,confirmed_at,entry_price,market_price,
    observed_pct,peak_pct,old_locked_pct,target_locked_pct,old_sl_price,new_sl_price,
    old_sl_oid,new_sl_oid,event,error)
   VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
   .bind(data.key,data.coin,data.side,data.at, data.confirmedAt??null,
    data.entry,data.market,data.observed,data.peak,data.oldLocked??null,
    data.target??null,data.oldSl??null,data.newSl??null,
    data.oldOid??null,data.newOid??null,data.event,data.error??null).run();
  return Number(result?.meta?.last_row_id??0)||null;
 }catch{return null;}
}
async function swingProgressiveAuditUpdate(db:any,id:number|null,event:string,extras:any={}){
 if(id===null)return;
 try{await db.prepare(`UPDATE swing_progressive_history SET event=?,confirmed_at=?,new_sl_oid=?,error=? WHERE id=?`)
  .bind(event,extras.confirmedAt??null,extras.newOid??null,extras.error??null,id).run();}catch{}
}
async function swingProtectionSchema(db:any){
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_protection_orders(
  signal_key TEXT PRIMARY KEY,coin TEXT NOT NULL,tp_oid TEXT NOT NULL,sl_oid TEXT NOT NULL,
  tp_px TEXT NOT NULL,sl_px TEXT NOT NULL,confirmed_at INTEGER NOT NULL)`).run();
 const cols:any=await db.prepare('PRAGMA table_info(swing_protection_orders)').all();
 for(const [name,type] of [['mode',"TEXT NOT NULL DEFAULT 'FIXED_TPSL'"],['peak_pct','REAL'],['locked_pct','REAL'],['progressive_claimed_at','INTEGER']]){
  if(!(cols.results??[]).some((c:any)=>c.name===name))await db.prepare(`ALTER TABLE swing_protection_orders ADD COLUMN ${name} ${type}`).run();
 }
}
function swingProtectionOid(o:any):string|null {
 const id=o?.oid??o?.orderId;
 return id==null?null:String(id);
}
function swingProtectionKind(o:any):'tp'|'sl'|null {
 const fields=[o?.orderType,o?.orderTypeName,o?.tpsl,o?.trigger?.tpsl,o?.order?.t?.trigger?.tpsl]
  .filter(v=>v!=null).map(v=>String(v).toLowerCase());
 if(fields.some(v=>v==='tp'||v.includes('take profit')||v.includes('takeprofit')))return 'tp';
 if(fields.some(v=>v==='sl'||v==='stop market'||v==='stop limit'||v.includes('stop loss')||v.includes('stoploss')))return 'sl';
 return null;
}
async function swingProtectionInventory(coin:string){
 const all=await postInfo({type:'frontendOpenOrders',user:MASTER_ACCOUNT});
 if(!Array.isArray(all))throw Error('SWING_ORDER_INVENTORY_UNAVAILABLE');
 const same=all.filter((o:any)=>String(o.coin??'').toUpperCase()===coin);
 const tp=same.filter((o:any)=>swingProtectionKind(o)==='tp');
 const sl=same.filter((o:any)=>swingProtectionKind(o)==='sl');
 const unknown=same.filter((o:any)=>swingProtectionKind(o)===null);
 return {same,tp,sl,unknown};
}
// Reconcile exchange-native protection for an already filled Swing position.
// READ ONLY on Hyperliquid: never creates, replaces or cancels orders.
async function swingReconcileFailedProtection(db:any,row:any):Promise<{ok:boolean;reason:string}>{
 const coin=String(row.coin??'').toUpperCase(),key=String(row.crossing_id??'');
 const mode:any=await db.prepare('SELECT exit_mode FROM swing_live_queue WHERE signal_key=?').bind(key).first();
 const progressive=swingIsProgressive(mode);
 const side=String(row.side??'').toUpperCase();
 if(side!=='SHORT'&&side!=='LONG')return {ok:false,reason:'INVALID_LEDGER_SIDE'};
 const position=await getOpenPositionForCoin(coin);
 if(!position)return {ok:false,reason:'POSITION_NOT_OPEN_MANUAL_RECONCILIATION'};
 const actual=Number(position.szi),expected=Number(row.entry_fill_size),entry=Number(row.entry_fill_price);
 const qtyNear=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0&&
   Math.abs(a-b)<=Math.max(b*0.001,1e-9);
 if(!Number.isFinite(entry)||entry<=0||!qtyNear(Math.abs(actual),expected)||
    (side==='SHORT'&&actual>=0)||(side==='LONG'&&actual<=0))
  return {ok:false,reason:'POSITION_SIDE_SIZE_OR_ENTRY_MISMATCH'};
 const inventory=await swingProtectionInventory(coin);
 // A progressive position has exactly ONE exchange-native SL and NO TP.
 // Never submit a replacement here: this reconciliation is exchange READ ONLY.
 if(inventory.same.length!==(progressive?1:2)||inventory.tp.length!==(progressive?0:1)||
    inventory.sl.length!==1||inventory.unknown.length!==0)
  return {ok:false,reason:'PROTECTION_COUNT_OR_KIND_MISMATCH'};
 const tp=progressive?null:inventory.tp[0],sl=inventory.sl[0];
 const tpOid=progressive?'NONE':swingProtectionOid(tp),slOid=swingProtectionOid(sl);
 const trigger=(o:any)=>Number(o.triggerPx??o.trigger?.triggerPx??o.triggerPrice);
 const size=(o:any)=>Number(o.sz??o.size??o.origSz);
 const priceNear=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0&&
   Math.abs(a-b)<=Math.max(b*0.0001,1e-10);
 const q:any=await db.prepare('SELECT tp_pct,sl_pct,market_regime,selected_pattern FROM swing_live_queue WHERE signal_key=?').bind(key).first();
 const tpPct=Number(q?.tp_pct);
 const slPct=Number(q?.sl_pct);
 if(!(slPct>0)||(!progressive&&!(tpPct>0)))return {ok:false,reason:'INVALID_SAVED_TPSL'};
 const targetTp=entry*(side==='SHORT'?1-tpPct/100:1+tpPct/100);
 const targetSl=entry*(side==='SHORT'?1+slPct/100:1-slPct/100);
 const saved:any=await db.prepare('SELECT * FROM swing_protection_orders WHERE signal_key=?').bind(key).first();
 if(saved&&String(saved.mode)!==(progressive?SWING_PROGRESSIVE_MODE:'FIXED_TPSL'))
  return {ok:false,reason:'SAVED_PROTECTION_MODE_CONFLICT'};
 // For an existing progressive record the last confirmed SL is the reference.
 // For an unconfirmed initial SL the entry's -1% price is the reference.
 const expectedSl=progressive&&saved?Number(saved.sl_px):targetSl;
 if(!slOid||!priceNear(trigger(sl),expectedSl)||!qtyNear(size(sl),expected)||
    (!progressive&&(!tpOid||tpOid===slOid||!priceNear(trigger(tp),targetTp)||!qtyNear(size(tp),expected))))
  return {ok:false,reason:'PROTECTION_OID_TRIGGER_OR_SIZE_MISMATCH'};
 const closeSide=side==='SHORT'?'B':'A';
 for(const order of (progressive?[sl]:[tp,sl])){
  // Fail closed if the exchange response does not prove these orders close the position.
  if(String(order.side??'').toUpperCase()!==closeSide||order.reduceOnly!==true||order.isTrigger!==true)
   return {ok:false,reason:'PROTECTION_CLOSE_SIDE_REDUCE_ONLY_OR_TRIGGER_UNCONFIRMED'};
 }
 // A failed progressive replace may leave a claim although the ORIGINAL SL
 // remains the sole live protection. Recover only after exchange verification.
 // Never clear a claim when a different/new order is present.
 if(saved&&(String(saved.tp_oid)!==tpOid||String(saved.sl_oid)!==slOid))
  return {ok:false,reason:'SAVED_OID_CONFLICT_MANUAL_RECONCILIATION'};
 if(saved?.progressive_claimed_at!=null){
  if(!progressive)return {ok:false,reason:'NON_PROGRESSIVE_CLAIM_CONFLICT'};
  const claimClear:any=await db.prepare(`UPDATE swing_protection_orders
   SET progressive_claimed_at=NULL WHERE signal_key=? AND sl_oid=?
   AND progressive_claimed_at=? AND mode=?`)
   .bind(key,slOid,saved.progressive_claimed_at,SWING_PROGRESSIVE_MODE).run();
  if(Number(claimClear?.meta?.changes??0)!==1)
   return {ok:false,reason:'PROGRESSIVE_CLAIM_CHANGED_DURING_RECONCILIATION'};
 }

 // The current ledger status is checked before and during the guarded status update.
 const current:any=await db.prepare('SELECT status FROM hyperliquid_execution_ledger WHERE crossing_id=?').bind(key).first();
 if(String(current?.status)!=='TPSL_FAILED_AFTER_RETRIES')return {ok:false,reason:'LEDGER_STATUS_CHANGED'};
 await db.prepare(`INSERT OR IGNORE INTO swing_protection_orders
  (signal_key,coin,tp_oid,sl_oid,tp_px,sl_px,confirmed_at,mode) VALUES (?,?,?,?,?,?,?,?)`)
  .bind(key,coin,tpOid,slOid,progressive?'NONE':String(trigger(tp)),String(trigger(sl)),
        Date.now(),progressive?SWING_PROGRESSIVE_MODE:'FIXED_TPSL').run();
 const updated:any=await db.prepare(`UPDATE hyperliquid_execution_ledger
  SET status='PROTECTED',last_error=NULL,updated_at=?
  WHERE crossing_id=? AND status='TPSL_FAILED_AFTER_RETRIES'`).bind(Date.now(),key).run();
 if(Number(updated.meta?.changes??0)!==1)return {ok:false,reason:'LEDGER_STATUS_UPDATE_NOT_APPLIED'};
 await db.prepare(`UPDATE swing_live_queue SET status='OPEN',reason=NULL,updated_at=?
  WHERE signal_key=? AND status='UNKNOWN'`).bind(Date.now(),key).run();
 return {ok:true,reason:'EXCHANGE_PROTECTION_RECONCILED'};
}
// V2.16.6 — SWING PRE-ENTRY REVERSAL AUDIT (READ-ONLY, NEVER BLOCKS AN ENTRY).
// Capture 1m CLOSED candle momentum after a confirmed live fill. This is an
// observational snapshot, not a historical backtest or a trading filter.
async function swingPreEntryAudit(env:HyperliquidExecutionEnv, row:any, fillPx:number){
 const db=env.DB!;
 const key=String(row.signal_key), coin=String(row.coin).toUpperCase();
 const side=String(row.side), now=Date.now();
 try{
  await db.prepare(`CREATE TABLE IF NOT EXISTS swing_pre_entry_audit (
    signal_key TEXT PRIMARY KEY, coin TEXT NOT NULL, side TEXT NOT NULL,
    pattern TEXT, regime TEXT, signal_at INTEGER, captured_at INTEGER NOT NULL,
    reference_price REAL, fill_price REAL, signal_to_fill_pct REAL,
    close_1m REAL, return_5m_pct REAL, return_15m_pct REAL,
    return_60m_pct REAL, last_3_candles_direction TEXT,
    against_signal_5m_pct REAL, against_signal_15m_pct REAL,
    snapshot_status TEXT NOT NULL, snapshot_error TEXT
  )`).run();
  // Hyperliquid candleSnapshot: request last 75 minutes; use only CLOSED 1m candles.
  const candles:any=await postInfo({type:'candleSnapshot',req:{coin,interval:'1m',
    startTime:now-75*60_000,endTime:now}});
  if(!Array.isArray(candles))throw Error('CANDLE_RESPONSE_NOT_ARRAY');
  const closed=candles.filter((c:any)=>Number(c?.t)>=0 &&
    Number(c?.T??(Number(c.t)+60_000))<=now && Number(c?.c)>0)
    .sort((a:any,b:any)=>Number(a.t)-Number(b.t));
  if(closed.length<61)throw Error('INSUFFICIENT_CLOSED_1M_CANDLES:'+closed.length);
  const latest=closed[closed.length-1], lastT=Number(latest.t);
  if(now-lastT>180_000)throw Error('STALE_CANDLE_DATA');
  const close=Number(latest.c);
  // Select last closed candle at/before the target timestamp; reject large gaps.
  const back=(minutes:number)=>{
    const target=lastT-minutes*60_000;
    const c=[...closed].reverse().find((x:any)=>Number(x.t)<=target);
    if(!c||target-Number(c.t)>90_000)throw Error('MISSING_'+minutes+'M_BASELINE');
    return Number(c.c);
  };
  const r5=(close/back(5)-1)*100, r15=(close/back(15)-1)*100,
    r60=(close/back(60)-1)*100;
  const dirs=closed.slice(-3).map((c:any)=>Number(c.c)>Number(c.o)?'UP':
    Number(c.c)<Number(c.o)?'DOWN':'FLAT').join(',');
  const against=(v:number)=>side==='LONG'?-v:v;
  await db.prepare(`INSERT OR IGNORE INTO swing_pre_entry_audit
    (signal_key,coin,side,pattern,regime,signal_at,captured_at,
     reference_price,fill_price,signal_to_fill_pct,close_1m,
     return_5m_pct,return_15m_pct,return_60m_pct,last_3_candles_direction,
     against_signal_5m_pct,against_signal_15m_pct,snapshot_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OK')`)
   .bind(key,coin,side,String(row.selected_pattern??''),String(row.market_regime??''),
    Number(row.signal_available_at)||null,now,Number(row.reference_price)||null,fillPx,
    Number(row.reference_price)>0?(fillPx/Number(row.reference_price)-1)*100:null,
    close,r5,r15,r60,dirs,against(r5),against(r15)).run();
 }catch(e:any){
  // Fail open: audit errors must never affect an already-filled live trade.
  try{await db.prepare(`INSERT OR IGNORE INTO swing_pre_entry_audit
   (signal_key,coin,side,pattern,regime,signal_at,captured_at,reference_price,
    fill_price,snapshot_status,snapshot_error)
   VALUES (?,?,?,?,?,?,?,?,?,'ERROR',?)`)
   .bind(key,coin,side,String(row.selected_pattern??''),String(row.market_regime??''),
    Number(row.signal_available_at)||null,now,Number(row.reference_price)||null,
    fillPx,String(e?.message??e).slice(0,300)).run();}catch{}
 }
}

async function swingOwned(db:any,coin:string,key:string,status:string){
 await db.prepare(`UPDATE swing_coin_owners SET status=?,updated_at=? WHERE coin=? AND owner=?`)
  .bind(status,Date.now(),coin,key).run();
}
async function swingExchangeClear(coin:string){
 const pos=await getOpenPositionForCoin(coin);
 const orders=await getOpenOrdersForCoin(coin);
 return {clear:!pos&&orders.length===0,position:pos,orders};
}
async function swingExpire(db:any,key:string,reason:string){
 await db.prepare(`UPDATE swing_live_queue SET status='EXPIRED',reason=?,updated_at=? WHERE signal_key=?`)
  .bind(reason,Date.now(),key).run();
}
function swingOrderAccepted(res:any,n:number){
 const statuses=res?.json?.response?.data?.statuses;
 return res?.httpStatus>=200&&res.httpStatus<300&&res?.json?.status==='ok'&&
 Array.isArray(statuses)&&statuses.length===n&&statuses.every((s:any)=>!s?.error&&
 (s?.resting?.oid!=null||s?.filled?.oid!=null||s?.success===true));
}
async function swingCloseMarket(coin:string,sz:number,secret:`0x${string}`){
 const raw=await postInfo({type:'metaAndAssetCtxs'});
 const u=raw?.[0]?.universe??[],ctx=raw?.[1]??[];
 const a=u.findIndex((x:any)=>String(x?.name).toUpperCase()===coin);
 if(a<0)throw Error('ASSET_NOT_FOUND');
 const decimals=Number(u[a].szDecimals),price=Number(ctx[a]?.markPx??ctx[a]?.midPx);
 if(!Number.isFinite(price)||price<=0)throw Error('MARK_PRICE_MISSING');
 const buyToClose=sz<0;
 const limit=price*(buyToClose?1.01:0.99);
 const action={type:'order',orders:[{a,b:buyToClose,p:priceToWire(limit,decimals),
   s:toWire(Math.abs(sz),decimals),r:true,t:{limit:{tif:'Ioc'}}}],grouping:'na'};
 return sendLifecycleSignedAction(action,secret);
}
// SWING ENTRY GUARD V1: only affects fresh Swing orders. All rejected candidates are durable.
const SWING_GUARD_TP=0.5, SWING_GUARD_SL=1.0, SWING_GUARD_MAX_MS=12*3600000;
async function swingGuardSchema(db:any){
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_rejected_signals(
 signal_key TEXT PRIMARY KEY,coin TEXT NOT NULL,side TEXT NOT NULL,interval TEXT,
 pattern TEXT,market_regime TEXT,rejected_at INTEGER NOT NULL,entry_price REAL NOT NULL,
 reasons_json TEXT NOT NULL,indicators_json TEXT NOT NULL,tp_pct REAL NOT NULL DEFAULT 0.5,
 sl_pct REAL NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'TRACKING',
 outcome_at INTEGER,exit_price REAL,minutes_to_outcome REAL,updated_at INTEGER NOT NULL,
 last_checked_at INTEGER,observation_note TEXT)`).run();
 await db.prepare(`CREATE INDEX IF NOT EXISTS idx_swing_rejected_tracking ON swing_rejected_signals(status,rejected_at)`).run();
}
type SwingCandle={t:number;T:number;o:number;h:number;l:number;c:number};
async function swingGuardCandles(coin:string,interval:string,start:number,end:number):Promise<SwingCandle[]>{
 const r=await postInfo({type:'candleSnapshot',req:{coin,interval,startTime:start,endTime:end}});
 if(!Array.isArray(r))throw Error('CANDLES_NOT_ARRAY');
 return r.map((x:any)=>({t:Number(x.t),T:Number(x.T),o:Number(x.o),h:Number(x.h),l:Number(x.l),c:Number(x.c)}))
 .filter((x:SwingCandle)=>[x.t,x.T,x.o,x.h,x.l,x.c].every(Number.isFinite)&&x.h>=x.l&&x.c>0)
 .sort((a:SwingCandle,b:SwingCandle)=>a.t-b.t);
}
function swingGuardEma(prices:number[],period:number){
 if(prices.length<period)return null;
 let v=prices.slice(0,period).reduce((a,b)=>a+b,0)/period;
 for(let i=period;i<prices.length;i++)v+=2/(period+1)*(prices[i]-v);
 return v;
}
function swingGuardRsi(prices:number[],period=14){
 if(prices.length<period+1)return null;
 let up=0,down=0;
 for(let i=1;i<=period;i++){const d=prices[i]-prices[i-1];up+=Math.max(d,0);down+=Math.max(-d,0);}
 up/=period;down/=period;
 for(let i=period+1;i<prices.length;i++){const d=prices[i]-prices[i-1];up=(up*(period-1)+Math.max(d,0))/period;down=(down*(period-1)+Math.max(-d,0))/period;}
 return down===0?(up===0?50:100):100-100/(1+up/down);
}
async function swingGuardCheck(row:any,price:number,now:number){
 const coin=String(row.coin).toUpperCase(),side=String(row.side),reasons:string[]=[],notes:string[]=[];
 const candles=await swingGuardCandles(coin,'5m',now-3*3600000,now);
 // Strictly completed 5-minute candles. No look-ahead and no stale indicators.
 const closed=candles.filter(x=>x.T<=now&&x.T>now-3*3600000);
 const last=closed[closed.length-1];
 if(!last||now-last.T>7*60000||closed.length<25)reasons.push('INDICATORS_MISSING_OR_STALE');
 const prices=closed.map(x=>x.c),rsi=swingGuardRsi(prices);
 const prev=swingGuardRsi(prices.slice(0,-6));
 // EMA50 requires >=50 completed bars: fetch separate history, do not estimate from 90m.
 const history=await swingGuardCandles(coin,'5m',now-7*3600000,now);
 const full=history.filter(x=>x.T<=now),hprices=full.map(x=>x.c);
 const ema20=swingGuardEma(hprices,20),ema50=swingGuardEma(hprices,50);
 const lastFull=full[full.length-1];
 if(!lastFull||now-lastFull.T>7*60000||hprices.length<55||rsi===null||prev===null||ema20===null||ema50===null)
  if(!reasons.includes('INDICATORS_MISSING_OR_STALE'))reasons.push('INDICATORS_MISSING_OR_STALE');
 if(side==='SHORT'){
  if(rsi!==null&&rsi<=30)reasons.push('SHORT_RSI_OVERSOLD');
  if(rsi!==null&&prev!==null&&prev-rsi>=15)reasons.push('SHORT_RSI_DROP_15_IN_30M');
  if(ema20!==null&&ema50!==null&&ema20>=ema50)reasons.push('SHORT_EMA20_GTE_EMA50');
 }else if(side==='LONG'){
  if(ema50!==null&&price<ema50)reasons.push('LONG_PRICE_BELOW_EMA50');
 }
 return {reasons,indicators:{rsi14_5m_wilder:rsi,rsi14_30m_ago:prev,rsi_drop_30m:rsi!==null&&prev!==null?prev-rsi:null,
  ema20_5m:ema20,ema50_5m:ema50,price,latest_closed_5m:lastFull?.T??null,
  source:'HYPERLIQUID_5M_COMPLETED_CANDLES',notes}};
}
async function swingGuardReject(db:any,row:any,price:number,check:any){
 const now=Date.now(),key=String(row.signal_key);
 await db.prepare(`INSERT OR IGNORE INTO swing_rejected_signals
 (signal_key,coin,side,interval,pattern,market_regime,rejected_at,entry_price,reasons_json,indicators_json,tp_pct,sl_pct,status,updated_at)
 VALUES (?,?,?,?,?,?,?,?,?,?,0.5,1,'TRACKING',?)`).bind(key,String(row.coin),String(row.side),
 String(key.split(':')[3]||''),String(row.selected_pattern||''),String(row.market_regime||''),now,price,
 JSON.stringify(check.reasons),JSON.stringify(check.indicators),now).run();
 await db.prepare(`UPDATE swing_live_queue SET status='REJECTED',reason=?,updated_at=? WHERE signal_key=? AND status='WAITING_POSITION'`)
 .bind(check.reasons.join('|'),now,key).run();
}
async function swingGuardTrack(env:HyperliquidExecutionEnv){
 const db=env.DB!;const now=Date.now();
 const q:any=await db.prepare(`SELECT * FROM swing_rejected_signals WHERE status='TRACKING'
 ORDER BY COALESCE(last_checked_at,0) ASC LIMIT 12`).all();
 let tracked=0,resolved=0;
 for(const row of q.results??[]){
  let start=Number(row.last_checked_at||row.rejected_at),expiry=Number(row.rejected_at)+SWING_GUARD_MAX_MS;
  const end=Math.min(now,expiry);
  try{
   // Fetch from original rejected moment if no prior checkpoint; cap to 12h/720 candles.
   const candles=await swingGuardCandles(String(row.coin),'1m',Math.max(Number(row.rejected_at)-60000,start-60000),end);
   if(end<=start)continue;
   if(!candles.length)throw Error('NO_CLOSED_TRACKING_CANDLES');
   const entry=Number(row.entry_price),long=row.side==='LONG';
   const tp=entry*(long?1.005:0.995),sl=entry*(long?0.99:1.01);
   let outcome:string|null=null,at:number|null=null,exit:number|null=null,note:string|null=null;
   const firstMinute=Math.floor(Number(row.rejected_at)/60000)*60000;
   // A candle containing rejection includes pre-rejection movement: cannot infer ordering.
   for(const c of candles){
    if(c.T>end)continue;
    if(c.t<firstMinute+60000){if((long?c.h>=tp:c.l<=tp)||(long?c.l<=sl:c.h>=sl)){
      outcome='UNKNOWN';at=c.T;note='ENTRY_MINUTE_INTRABAR_ORDER_UNKNOWN';break;}continue;}
    if(c.t>start+60000){outcome='UNKNOWN';at=c.t;note='MISSING_ONE_MINUTE_CANDLES';break;}
    const hitTp=long?c.h>=tp:c.l<=tp,hitSl=long?c.l<=sl:c.h>=sl;
    if(hitTp&&hitSl){outcome='UNKNOWN';at=c.T;note='TP_AND_SL_IN_SAME_1M_CANDLE';break;}
    if(hitTp||hitSl){outcome=hitTp?'WOULD_TP':'WOULD_SL';at=c.T;exit=hitTp?tp:sl;break;}
    start=c.T;
   }
   if(!outcome&&end>=expiry){outcome='UNKNOWN';at=end;note='12H_HORIZON_WITHOUT_FIRST_TOUCH';}
   if(outcome){await db.prepare(`UPDATE swing_rejected_signals SET status=?,outcome_at=?,exit_price=?,minutes_to_outcome=?,observation_note=?,last_checked_at=?,updated_at=? WHERE signal_key=? AND status='TRACKING'`)
    .bind(outcome,at,exit,at===null?null:(at-Number(row.rejected_at))/60000,note,end,now,row.signal_key).run();resolved++;}
   else {await db.prepare(`UPDATE swing_rejected_signals SET last_checked_at=?,updated_at=? WHERE signal_key=? AND status='TRACKING'`)
    .bind(end,now,row.signal_key).run();tracked++;}
  }catch(e:any){await db.prepare(`UPDATE swing_rejected_signals SET observation_note=?,updated_at=? WHERE signal_key=?`)
   .bind('TRACKER_ERROR:'+String(e?.message||e).slice(0,180),now,row.signal_key).run();}
 }
 return {tracked,resolved};
}

async function swingEnter(env:HyperliquidExecutionEnv,row:any){
 const db=env.DB!,coin=String(row.coin).toUpperCase(),key=String(row.signal_key),now=Date.now();
 const side=String(row.side??'SHORT');
 if(side!=='LONG'&&side!=='SHORT')throw Error('INVALID_SWING_SIDE');
 const strategy=side==='LONG'?SWING_LONG_STRATEGY:SWING_SHORT_B_STRATEGY;
 if(!(Number(row.tp_pct)>0&&Number(row.sl_pct)>0))throw Error('MISSING_SWING_REGIME_TPSL');
 if(now>Number(row.expires_at)){await swingExpire(db,key,'EXPIRED_20M');return 'EXPIRED';}
 // Atomic per-coin reservation; no execution if SCALP ledger is unresolved.
 const claim=await db.prepare(`INSERT OR IGNORE INTO swing_coin_owners
 (coin,owner,strategy,status,created_at,updated_at) VALUES (?,?,?,'RESERVED',?,?)`)
  .bind(coin,key,strategy,now,now).run();
 if(Number(claim.meta?.changes??0)!==1)return 'WAITING_POSITION';
 let entryAttempted=false;
 try{
  // Reconcile abandoned legacy CLAIMED intents only. Never clear a filled or ambiguous record.
  // Fail closed unless the exchange confirms NO position and NO open orders for this coin.
  const legacy:any=await db.prepare(`SELECT id,status,claimed_at,entry_oid,entry_fill_size,entry_filled_at
    FROM hyperliquid_execution_ledger
    WHERE coin=? AND COALESCE(strategy_version,'') NOT LIKE 'SWING_%' AND status IN
    ('CLAIMED','ENTRY_FILLED','PROTECTED','TPSL_FAILED_AFTER_RETRIES','MAX_HOLD_CLOSING')`)
    .bind(coin).all();
  const blockers:any[]=legacy.results??[];
  const stale=blockers.filter((r:any)=>String(r.status)==='CLAIMED' &&
    Number(r.claimed_at)>0 && Number(r.claimed_at)<Date.now()-24*60*60_000 &&
    !r.entry_oid && !r.entry_fill_size && !r.entry_filled_at);
  if(stale.length){
    const exchange=await swingExchangeClear(coin);
    if(!exchange.clear)throw Error('EXCHANGE_COIN_OCCUPIED');
    for(const old of stale){
      await db.prepare(`UPDATE hyperliquid_execution_ledger
        SET status='STALE_CLAIM_CLEARED',last_error='LEGACY_CLAIM_24H_EXCHANGE_EMPTY',updated_at=?
        WHERE id=? AND coin=? AND status='CLAIMED' AND claimed_at<?
          AND entry_oid IS NULL AND entry_fill_size IS NULL AND entry_filled_at IS NULL`)
        .bind(Date.now(),old.id,coin,Date.now()-24*60*60_000).run();
    }
  }
  const active:any=await db.prepare(`SELECT id FROM hyperliquid_execution_ledger
    WHERE coin=? AND COALESCE(strategy_version,'') NOT LIKE 'SWING_%' AND status IN
    ('CLAIMED','ENTRY_FILLED','PROTECTED','TPSL_FAILED_AFTER_RETRIES','MAX_HOLD_CLOSING') LIMIT 1`)
    .bind(coin).first();
  if(active)throw Error('SCALP_LEDGER_ACTIVE');
  const clear=await swingExchangeClear(coin);
  if(!clear.clear)throw Error('EXCHANGE_COIN_OCCUPIED');
  const raw=await postInfo({type:'metaAndAssetCtxs'});
  const u=raw?.[0]?.universe??[],ctx=raw?.[1]??[];
  const a=u.findIndex((x:any)=>String(x?.name).toUpperCase()===coin);
  if(a<0)throw Error('ASSET_NOT_FOUND');
  const decimals=Number(u[a].szDecimals),price=Number(ctx[a]?.midPx??ctx[a]?.markPx);
  if(!Number.isFinite(price)||price<=0)throw Error('MARKET_PRICE_MISSING');
  if(Math.abs(price/Number(row.reference_price)-1)>0.005)throw Error('PRICE_DEVIATION_OVER_0_5PCT');
  // Entry protection is checked against live exchange price BEFORE leverage/order/ledger.
  // Fail closed on missing/stale candles or exchange errors; never silently bypass.
  let guard:any;
  try{guard=await swingGuardCheck(row,price,Date.now());}
  catch(e:any){guard={reasons:['INDICATORS_FETCH_FAILED'],indicators:{error:String(e?.message||e).slice(0,180),price}};}
  if(guard.reasons.length){
   await swingGuardReject(db,row,price,guard);
   await db.prepare(`DELETE FROM swing_coin_owners WHERE coin=? AND owner=? AND status='RESERVED'`).bind(coin,key).run();
   return 'REJECTED:'+guard.reasons.join('|');
  }

  const secret=normalizePrivateKey(env.HYPERLIQUID_API_PRIVATE_KEY);
  if(!privateKeyFormatOk(secret))throw Error('PRIVATE_KEY_INVALID');
  const targetNotional=CONFIG.BASE_MARGIN_USD*CONFIG.TARGET_LEVERAGE;
  const size=bestValidSize(targetNotional/price,price,decimals,targetNotional);
  if(!Number.isFinite(size)||size*price<10)throw Error('MIN_NOTIONAL');
  const leverage=Math.min(CONFIG.TARGET_LEVERAGE,Number(u[a]?.maxLeverage??CONFIG.TARGET_LEVERAGE));
  if(!Number.isFinite(leverage)||leverage<1)throw Error('INVALID_LEVERAGE');
  const lev=await sendLifecycleSignedAction({type:'updateLeverage',asset:a,isCross:CONFIG.IS_CROSS,leverage},secret);
  if(lev.httpStatus<200||lev.httpStatus>=300||lev.json?.status!=='ok')throw Error('LEVERAGE_FAILED');
  // Write durable intent before any non-idempotent network request.
  await db.prepare(`INSERT INTO hyperliquid_execution_ledger
   (crossing_id,episode_id,coin,side,crossing_ts,status,claimed_at,updated_at,strategy_version,setup_name)
   VALUES (?,?,?,?,?,'CLAIMED',?,?,?,?)`)
   .bind(key,key,coin,side,Number(row.signal_available_at),now,now,strategy,
      String(row.patterns_json)).run();
  await db.prepare(`UPDATE swing_live_queue SET status='ENTERING',reason=NULL,updated_at=? WHERE signal_key=?`)
   .bind(now,key).run();
  const action={type:'order',orders:[{a,b:side==='LONG',p:priceToWire(price*(side==='LONG'?1.003:0.997),decimals),
   s:toWire(size,decimals),r:false,t:{limit:{tif:'Ioc'}}}],grouping:'na'};
  entryAttempted=true;
  const entry=await sendLifecycleSignedAction(action,secret);
  const fill=entry?.json?.response?.data?.statuses?.[0]?.filled;
  if(!fill){
   // A transport ambiguity must not release ownership without checking exchange.
   const state=await swingExchangeClear(coin);
   if(!state.clear)throw Error('ENTRY_UNCERTAIN_POSITION_OR_ORDERS');
   await db.prepare(`UPDATE hyperliquid_execution_ledger SET status='ENTRY_NOT_FILLED',updated_at=? WHERE crossing_id=?`).bind(Date.now(),key).run();
   await db.prepare(`UPDATE swing_live_queue SET status='EXPIRED',reason='IOC_NOT_FILLED',updated_at=? WHERE signal_key=?`).bind(Date.now(),key).run();
   await db.prepare(`DELETE FROM swing_coin_owners WHERE coin=? AND owner=?`).bind(coin,key).run();
   return 'ENTRY_NOT_FILLED';
  }
  const px=Number(fill.avgPx??fill.px),sz=Number(fill.totalSz??fill.sz);
  if(!(px>0&&sz>0))throw Error('FILLED_BUT_INVALID_FILL_DATA');
  await db.prepare(`UPDATE hyperliquid_execution_ledger SET status='ENTRY_FILLED',
   entry_fill_price=?,entry_fill_size=?,entry_oid=?,entry_filled_at=?,updated_at=? WHERE crossing_id=?`)
   .bind(px,sz,String(fill.oid??''),Date.now(),Date.now(),key).run();
  await swingOwned(db,coin,key,'OPEN');
  const tpPct=Number(row.tp_pct);
  const slPct=Number(row.sl_pct);
  const tp=priceToWire(px*(side==='LONG'?1+tpPct/100:1-tpPct/100),decimals),
   sl=priceToWire(px*(side==='LONG'?1-slPct/100:1+slPct/100),decimals),wire=toWire(sz,decimals);
  const progressive=swingIsProgressive(row);
  const protection={type:'order',orders:[
   ...(!progressive?[{a,b:side==='SHORT',p:tp,s:wire,r:true,t:{trigger:{isMarket:true,triggerPx:tp,tpsl:'tp'}}}]:[]),
   {a,b:side==='SHORT',p:sl,s:wire,r:true,t:{trigger:{isMarket:true,triggerPx:sl,tpsl:'sl'}}}
  ],grouping:'na'};
  // Never trust only the intended price: detect ALL existing TP/SL orders for the coin.
  // Any partial, duplicate or unknown order requires manual reconciliation.
  let protectedOk=false;
  let protectionReason='SWING_PROTECTION_UNCONFIRMED';
  const existing=await swingProtectionInventory(coin);
  if(existing.same.length!==0){
    protectionReason='EXISTING_COIN_ORDERS_MANUAL_RECONCILIATION';
  }else{
    // Durable marker before the non-idempotent request. Never retry automatically.
    await db.prepare(`UPDATE hyperliquid_execution_ledger SET status='PROTECTION_SUBMITTING',
      last_error='PROTECTION_REQUEST_MAY_HAVE_BEEN_SENT',updated_at=? WHERE crossing_id=?`)
      .bind(Date.now(),key).run();
    try {await sendLifecycleSignedAction(protection,secret);}
    catch(e:any){protectionReason='PROTECTION_SUBMISSION_AMBIGUOUS:'+String(e?.message??e);}
    try{
      const verified=await swingProtectionInventory(coin);
      const tpOrder=verified.tp[0],slOrder=verified.sl[0];
      const px=(o:any)=>Number(o.triggerPx??o.trigger?.triggerPx??o.triggerPrice);
      const qty=(o:any)=>Number(o.sz??o.size??o.origSz);
      const near=(a:number,b:number)=>Number.isFinite(a)&&Math.abs(a-b)<=Math.max(b*0.0001,1e-10);
      const sizesOk=(progressive?[slOrder]:[tpOrder,slOrder]).every(o=>o&&Number.isFinite(qty(o))&&Math.abs(qty(o)-sz)<=Math.max(sz*0.001,1e-9));
      if(verified.same.length===(progressive?1:2)&&verified.tp.length===(progressive?0:1)&&verified.sl.length===1&&
         verified.unknown.length===0&&(progressive||near(px(tpOrder),Number(tp)))&&near(px(slOrder),Number(sl))&&
         sizesOk&&(progressive||swingProtectionOid(tpOrder))&&swingProtectionOid(slOrder)){
        await db.prepare(`INSERT INTO swing_protection_orders
          (signal_key,coin,tp_oid,sl_oid,tp_px,sl_px,confirmed_at,mode) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(key,coin,progressive?'NONE':swingProtectionOid(tpOrder),swingProtectionOid(slOrder),progressive?'NONE':tp,sl,Date.now(),progressive?SWING_PROGRESSIVE_MODE:'FIXED_TPSL').run();
        protectedOk=true;
        protectionReason=progressive?'CONFIRMED_ONE_INITIAL_SL':'CONFIRMED_ONE_TP_ONE_SL';
      }else protectionReason='PROTECTION_COUNT_PRICE_SIZE_OR_OID_MISMATCH_MANUAL_RECONCILIATION';
    }catch(e:any){protectionReason='PROTECTION_RECONCILIATION_FAILED:'+String(e?.message??e);}
  }
  await db.prepare(`UPDATE hyperliquid_execution_ledger SET status=?,updated_at=?,last_error=? WHERE crossing_id=?`)
   .bind(protectedOk?'PROTECTED':'TPSL_FAILED_AFTER_RETRIES',Date.now(),protectedOk?null:protectionReason,key).run();
  await db.prepare(`UPDATE swing_live_queue SET status=?,updated_at=?,reason=? WHERE signal_key=?`)
   .bind(protectedOk?'OPEN':'UNKNOWN',Date.now(),protectedOk?null:protectionReason,key).run();
  // Send only after the actual fill and protection reconciliation are persisted.
  await sendTelegram(env,swingEntryTelegram({coin,side,key,regime:row.market_regime,pattern:row.selected_pattern,
   tpPct:progressive?'PROGRESSIVE':row.tp_pct,slPct:row.sl_pct,px,sz,leverage,tp:progressive?'NO FIXED TP · Progressive from +0.50%':tp,sl,protectedOk,reason:protectionReason})).catch(()=>{});
  // Audit only after protection and notification; never changes order decisions.
  await swingPreEntryAudit(env,row,px).catch(()=>{});
  return protectedOk?'PROTECTED':'TPSL_UNCONFIRMED';
 }catch(err:any){
  const reason=String(err?.message??err);
  if(entryAttempted){
   await swingOwned(db,coin,key,'UNKNOWN');
   await db.prepare(`UPDATE swing_live_queue SET status='UNKNOWN',reason=?,updated_at=? WHERE signal_key=?`).bind(reason,Date.now(),key).run();
   return 'UNKNOWN:'+reason;
  }
  await db.prepare(`DELETE FROM swing_coin_owners WHERE coin=? AND owner=? AND status='RESERVED'`).bind(coin,key).run();
  await db.prepare(`UPDATE swing_live_queue SET next_retry_at=?,reason=?,updated_at=? WHERE signal_key=?`)
   .bind(Date.now()+SWING_RETRY,reason,Date.now(),key).run();
  return 'WAITING:'+reason;
 }
}
// SWING LIVE CANDIDATE AUDIT V1 — observation only, no order/selection changes.
// Records every sourced candidate and its decision at the live eligibility gate.
async function swingCandidateAuditSchema(db:any){
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_live_candidates (
  candidate_key TEXT PRIMARY KEY, coin TEXT NOT NULL, side TEXT NOT NULL,
  interval TEXT NOT NULL, signal_bar_open INTEGER NOT NULL,
  signal_available_at INTEGER NOT NULL, first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, reference_price REAL, patterns_json TEXT NOT NULL,
  market_regime TEXT, selected_pattern TEXT, stage TEXT NOT NULL,
  reason TEXT, live_signal_key TEXT, checks INTEGER NOT NULL DEFAULT 1
 )`).run();
 await db.prepare(`CREATE INDEX IF NOT EXISTS idx_swing_live_candidates_time
 ON swing_live_candidates(signal_available_at,stage)`).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_live_candidate_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, candidate_key TEXT NOT NULL,
  checked_at INTEGER NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL,
  interval TEXT NOT NULL, stage TEXT NOT NULL, reason TEXT,
  market_regime TEXT, selected_pattern TEXT, reference_price REAL,
  patterns_json TEXT NOT NULL
 )`).run();
 await db.prepare(`CREATE INDEX IF NOT EXISTS idx_swing_candidate_checks_key_time
 ON swing_live_candidate_checks(candidate_key,checked_at)`).run();
}
// V2 audit history: immutable checks, independent from the current snapshot row.
// Source remains confirmed swing_context_signals; a future pre-confirm detector
// must call this same writer to provide genuine forming candidates.
async function swingCandidateAuditWrite(db:any,row:{key:string;coin:string;side:string;interval:string;bar:number;available:number;price:number;patterns:string[];regime:string|null;selected:string|null;stage:string;reason:string;signalKey?:string},now:number){
 await db.prepare(`INSERT INTO swing_live_candidates
 (candidate_key,coin,side,interval,signal_bar_open,signal_available_at,first_seen_at,last_seen_at,reference_price,patterns_json,market_regime,selected_pattern,stage,reason,live_signal_key,checks)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
 ON CONFLICT(candidate_key) DO UPDATE SET
 last_seen_at=excluded.last_seen_at,reference_price=excluded.reference_price,
 patterns_json=excluded.patterns_json,market_regime=excluded.market_regime,
 selected_pattern=excluded.selected_pattern,stage=excluded.stage,
 reason=excluded.reason,live_signal_key=excluded.live_signal_key,checks=swing_live_candidates.checks+1`)
 .bind(row.key,row.coin,row.side,row.interval,row.bar,row.available,now,now,row.price,JSON.stringify(row.patterns),row.regime,row.selected,row.stage,row.reason,row.signalKey??null).run();
 // One check per candidate per run, preserving each intermediate decision.
 await db.prepare(`INSERT INTO swing_live_candidate_checks
 (candidate_key,checked_at,coin,side,interval,stage,reason,market_regime,selected_pattern,reference_price,patterns_json)
 VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
 .bind(row.key,now,row.coin,row.side,row.interval,row.stage,row.reason,row.regime,row.selected,row.price,JSON.stringify(row.patterns)).run();
}
export async function runSwingShortLive(env:HyperliquidExecutionEnv & {SWING_DB?:any}){
 const db=env.DB;if(!db)return {ok:false,reason:'DB_MISSING'};
 // Collect eligible signals even when real SWING trading is disabled.
 // The execution switch is checked only AFTER the D1 queue is populated.
 await swingSchema(db);await swingProtectionSchema(db);await swingGuardSchema(db);
 const rejectedTracking=await swingGuardTrack(env).catch((e:any)=>({error:String(e?.message||e)}));
 const now=Date.now();
 // Keep only newly available signals. Never backfill old research as live trades.
 const signals:any=await (env.SWING_DB??db).prepare(`SELECT coin,interval,side,signal_bar_open,
  signal_available_at,reference_price,pattern,context_json FROM swing_context_signals
  WHERE interval IN ('1h','4h') AND side IN ('LONG','SHORT')
  AND signal_available_at BETWEEN ? AND ?
  ORDER BY signal_available_at DESC LIMIT 500`).bind(now-SWING_MAX_WAIT,now).all();
 // Audit is best-effort. A failed diagnostic write must never block LIVE orders.
 let candidateAuditReady=false;
 try{await swingCandidateAuditSchema(db);candidateAuditReady=true;}catch(e:any){console.error('SWING_CANDIDATE_AUDIT_SCHEMA',String(e?.message||e));}
 const audit=async(row:any)=>{if(!candidateAuditReady)return;try{await swingCandidateAuditWrite(db,row,now);}catch(e:any){console.error('SWING_CANDIDATE_AUDIT_WRITE',String(e?.message||e));}};
 const groups=new Map<string,any>();
 for(const item of signals.results??[]){
  const side=String(item.side),pattern=String(item.pattern);
  if(!['LONG','SHORT'].includes(side)||!['1h','4h'].includes(String(item.interval)))continue;
  const key=`SWING:${side}:${item.coin}:${item.interval}:${item.signal_bar_open}`;
  if(!groups.has(key))groups.set(key,{...item,patterns:new Set<string>(),eligiblePatterns:new Set<string>()});
  const group=groups.get(key);
  group.patterns.add(pattern);
  const eligibleRules=side==='LONG'
   ?(item.interval==='4h'?SWING_LONG_4H_RULES:SWING_LONG_1H_RULES)
   :(item.interval==='4h'?SWING_SHORT_4H_RULES:SWING_SHORT_1H_RULES);
  if(Object.values(eligibleRules).some((r:any)=>pattern in r)){if(group.eligiblePatterns.size===0){group.reference_price=item.reference_price;group.signal_available_at=item.signal_available_at;}group.eligiblePatterns.add(pattern);}
 }
 for(const [key,item] of groups){
  const eligiblePatterns=[...item.eligiblePatterns] as string[];
  // Audit only patterns present in the existing LIVE rule maps (all regimes).
  // The LIVE selection algorithm below remains unchanged.
  const base={key,coin:String(item.coin),side:String(item.side),interval:String(item.interval),bar:Number(item.signal_bar_open),available:Number(item.signal_available_at),price:Number(item.reference_price),patterns:eligiblePatterns};
  if(!eligiblePatterns.length)continue;
  if(!Number.isFinite(base.price)||base.price<=0){await audit({...base,regime:null,selected:null,stage:'REJECTED',reason:'INVALID_REFERENCE_PRICE'});continue;}
  let regime:string|null=null;
  try{regime=await swingLongRegimeAt(env.SWING_DB??db,base.available);}catch(e:any){
   await audit({...base,regime:null,selected:null,stage:'ERROR',reason:'REGIME_QUERY_FAILED:'+String(e?.message||e)});throw e;
  }
  if(!regime){await audit({...base,regime:null,selected:null,stage:'WAITING',reason:'REGIME_UNAVAILABLE'});continue;}
  const selected=item.side==='LONG'
   ?swingLongPick(regime,eligiblePatterns,String(item.interval) as '1h'|'4h')
   :swingShortPick(regime,eligiblePatterns,String(item.interval) as '1h'|'4h');
  if(!selected){await audit({...base,regime,selected:null,stage:'WAITING',reason:'NO_RANKED_RULE_FOR_REGIME'});continue;}
  await audit({...base,regime,selected:selected.pattern,stage:'ELIGIBLE',reason:'RANKED_RULE_MATCH',signalKey:key});
  await db.prepare(`INSERT OR IGNORE INTO swing_live_queue
   (signal_key,coin,side,signal_available_at,signal_bar_open,reference_price,patterns_json,status,next_retry_at,expires_at,updated_at,exit_mode)
   VALUES (?,?,?,?,?,?,?,'WAITING_POSITION',?,?,?,?)`)
   .bind(key,item.coin,item.side,item.signal_available_at,item.signal_bar_open,item.reference_price,
    JSON.stringify(eligiblePatterns),now,Number(item.signal_available_at)+SWING_MAX_WAIT,now,SWING_PROGRESSIVE_MODE).run();
  await db.prepare(`UPDATE swing_live_queue SET market_regime=?,selected_pattern=?,tp_pct=?,sl_pct=?
   WHERE signal_key=? AND status='WAITING_POSITION' AND market_regime IS NULL`)
   .bind(regime,selected.pattern,0.5,1.0,key).run();
  const queueRow:any=await db.prepare(`SELECT status,selected_pattern FROM swing_live_queue WHERE signal_key=?`).bind(key).first();
  await audit({...base,regime,selected:selected.pattern,
   stage:queueRow?'LIVE_SELECTED':'ELIGIBLE',
   reason:queueRow?'LIVE_QUEUE_EXISTS:'+String(queueRow.status):'QUEUE_NOT_FOUND',signalKey:key});
 }
 await db.prepare(`UPDATE swing_live_queue SET status='EXPIRED',
  reason=CASE WHEN reason IS NULL OR reason='' THEN '20M_TIMEOUT'
    ELSE '20M_TIMEOUT | LAST_BLOCKER: ' || reason END,updated_at=?
  WHERE status='WAITING_POSITION' AND expires_at<=?`).bind(now,now).run();
 const due:any=await db.prepare(`SELECT * FROM swing_live_queue WHERE status='WAITING_POSITION'
  AND next_retry_at<=? AND expires_at>? ORDER BY signal_available_at DESC, next_retry_at ASC LIMIT 20`).bind(now,now).all();
 const liveEnabled=SWING_TRADING_ENABLED;
 if(!liveEnabled) return {ok:true,live:false,reason:'SWING_LIVE_DISABLED_COLLECTION_ACTIVE',eligible_groups:groups.size, due_count:(due.results??[]).length,orders_sent:0};
 const unsafe:any=await db.prepare(`SELECT COUNT(*) AS n FROM hyperliquid_execution_ledger
  WHERE strategy_version IN (?,?,?) AND status IN ('TPSL_FAILED_AFTER_RETRIES','PROTECTION_SUBMITTING','ENTRY_FILLED')`)
  .bind(...SWING_STRATEGIES).first();
 if(Number(unsafe?.n??0)>0)return {ok:false,live:false,reason:'UNRESOLVED_SWING_PROTECTION_BLOCKS_NEW_ENTRIES',unresolved:Number(unsafe.n),orders_sent:0};
 const entered=[];
 for(const row of due.results??[]){
  if(String(row.side)==='LONG'){
   const rule=await swingLongQueueRule(env.SWING_DB??db,row);
   if(!rule||String(row.market_regime)!==rule.regime||
      String(row.selected_pattern)!==rule.pattern||
      (swingIsProgressive(row)?Number(row.sl_pct)!==1:Number(row.tp_pct)!==0.5||Number(row.sl_pct)!==1.0)){
    await swingExpire(db,String(row.signal_key),'REJECTED_LONG_REGIME_RULE_MISMATCH');
    entered.push({coin:row.coin,result:'REJECTED_LONG_REGIME_RULE_MISMATCH'});
    continue;
   }
  }
  if(String(row.side)==='SHORT'){
   const rule=await swingShortQueueRule(env.SWING_DB??db,row);
   if(!rule||String(row.market_regime)!==rule.regime||
      String(row.selected_pattern)!==rule.pattern||
      (swingIsProgressive(row)?Number(row.sl_pct)!==1:Number(row.tp_pct)!==0.5||Number(row.sl_pct)!==1.0)){
    await swingExpire(db,String(row.signal_key),'REJECTED_SHORT_REGIME_RULE_MISMATCH');
    entered.push({coin:row.coin,result:'REJECTED_SHORT_REGIME_RULE_MISMATCH'});
    continue;
   }
  }
  entered.push({coin:row.coin,result:await swingEnter(env,row)});
 }
 return {ok:true,live:true,entered,eligible_groups:groups.size,due_count:(due.results??[]).length,rejected_tracking:rejectedTracking,candidate_audit_v2:true};
}
// Swing progressive: use FAST's add -> exchange visibility -> cancel old sequence.
// Only new PROGRESSIVE_V1 rows. Never modify legacy bracket positions.
async function swingAdvanceProgressive(env:HyperliquidExecutionEnv,row:any,position:any,saved:any){
 const db=env.DB!,coin=String(row.coin).toUpperCase(),side=String(row.side),key=String(row.crossing_id);
 const entry=Number(row.entry_fill_price),szi=Number(position.szi);
 if(!(entry>0&&Number.isFinite(szi)&&Math.abs(szi)>0))throw Error('SWING_PROGRESSIVE_POSITION_INVALID');
 const raw=await postInfo({type:'metaAndAssetCtxs'});
 const universe=raw?.[0]?.universe??[],ctx=raw?.[1]??[];
 const asset=universe.findIndex((x:any)=>String(x.name).toUpperCase()===coin);
 if(asset<0)throw Error('SWING_PROGRESSIVE_ASSET_NOT_FOUND');
 const decimals=Number(universe[asset].szDecimals),market=Number(ctx[asset]?.midPx??ctx[asset]?.markPx);
 if(!(market>0))throw Error('SWING_PROGRESSIVE_MARKET_MISSING');
 const observed=swingReturnPct(side,entry,market);
 const peak=Math.max(Number.isFinite(Number(saved.peak_pct))?Number(saved.peak_pct):observed,observed);
 // Record observed maximum even if no protective change is needed.
 await db.prepare(`UPDATE swing_protection_orders SET peak_pct=MAX(COALESCE(peak_pct,-999),?) WHERE signal_key=? AND mode=?`)
  .bind(peak,key,SWING_PROGRESSIVE_MODE).run();
 const target=swingProgressiveTarget(peak);
 const auditBase={key,coin,side,at:Date.now(),entry,market,observed,peak,
  oldLocked:Number(saved.locked_pct??0),oldSl:Number(saved.sl_px),oldOid:String(saved.sl_oid),
  target,newSl:target===null?null:Number(priceToWire(entry*(side==='LONG'?1+target/100:1-target/100),decimals))};
 const auditId=await swingProgressiveAudit(db,{...auditBase,event:target===null||target<=Number(saved.locked_pct??-999)+1e-8?'OBSERVED_NO_STEP':'STEP_DETECTED'});
 if(target===null||target<=Number(saved.locked_pct??-999)+1e-8)return {status:'TRACKING',peak_pct:peak,locked_pct:saved.locked_pct};
 // Do not place a stop already crossed by the CURRENT market price.
 const stopWire=priceToWire(entry*(side==='LONG'?1+target/100:1-target/100),decimals);
 const stop=Number(stopWire);
 if((side==='LONG'&&market<=stop)||(side==='SHORT'&&market>=stop)){await swingProgressiveAuditUpdate(db,auditId,'PRICE_ALREADY_REVERSED');return {status:'PRICE_ALREADY_REVERSED',peak_pct:peak,target_pct:target};}
 // Atomic single-writer claim across overlapping cron runs; stale claims require manual review.
 const claim:any=await db.prepare(`UPDATE swing_protection_orders SET progressive_claimed_at=?
  WHERE signal_key=? AND mode=? AND progressive_claimed_at IS NULL AND sl_oid=?`)
  .bind(Date.now(),key,SWING_PROGRESSIVE_MODE,String(saved.sl_oid)).run();
 if(Number(claim?.meta?.changes??0)!==1){await swingProgressiveAuditUpdate(db,auditId,'PROGRESSIVE_BUSY');return {status:'PROGRESSIVE_BUSY'};}
 let mayHaveSent=false;
 try{
  const current=await swingProtectionInventory(coin);
  if(current.same.length!==1||current.sl.length!==1||current.tp.length!==0||
     swingProtectionOid(current.sl[0])!==String(saved.sl_oid))throw Error('SWING_PROGRESSIVE_OLD_STOP_NOT_UNIQUE');
  const secret=normalizePrivateKey(env.HYPERLIQUID_API_PRIVATE_KEY);
  if(!privateKeyFormatOk(secret))throw Error('SWING_PROGRESSIVE_KEY_INVALID');
  const order={a:asset,b:side==='SHORT',p:stopWire,s:toWire(Math.abs(szi),decimals),r:true,
   t:{trigger:{isMarket:true,triggerPx:stopWire,tpsl:'sl'}}};
  mayHaveSent=true;
  const add=await sendLifecycleSignedAction({type:'order',orders:[order],grouping:'na'},secret);
  const status=add?.json?.response?.data?.statuses?.[0];
  const newOid=responseOrderOid(status);
  if(!(add.httpStatus>=200&&add.httpStatus<300&&add.json?.status==='ok'&&!status?.error&&newOid!==null))
   throw Error('SWING_PROGRESSIVE_ADD_NOT_CONFIRMED');
  // Exchange order visibility may lag the signed placement acknowledgement.
  // Retry READ-ONLY inventory, without resubmitting or cancelling either SL.
  let visible=false;
  for(let attempt=0;attempt<5;attempt++){
   if(attempt>0)await new Promise(resolve=>setTimeout(resolve,350*attempt));
   const after=await swingProtectionInventory(coin);
   if(after.sl.length===2&&after.tp.length===0&&after.unknown.length===0&&
      after.sl.some((o:any)=>swingProtectionOid(o)===String(newOid))&&
      after.sl.some((o:any)=>swingProtectionOid(o)===String(saved.sl_oid))){visible=true;break;}
  }
  if(!visible)throw Error('SWING_PROGRESSIVE_NEW_STOP_NOT_VISIBLE');
  const cancel=await sendLifecycleSignedAction({type:'cancel',cancels:[{a:asset,o:Number(saved.sl_oid)}]},secret);
  if(!(cancel.httpStatus>=200&&cancel.httpStatus<300&&cancel.json?.status==='ok'))
   throw Error('SWING_PROGRESSIVE_OLD_STOP_CANCEL_NOT_CONFIRMED');
  const final=await swingProtectionInventory(coin);
  if(final.same.length!==1||final.sl.length!==1||swingProtectionOid(final.sl[0])!==String(newOid))
   throw Error('SWING_PROGRESSIVE_FINAL_ORDER_MISMATCH');
  await db.prepare(`UPDATE swing_protection_orders SET sl_oid=?,sl_px=?,locked_pct=?,confirmed_at=?,progressive_claimed_at=NULL
   WHERE signal_key=? AND mode=? AND sl_oid=?`)
   .bind(String(newOid),stopWire,target,Date.now(),key,SWING_PROGRESSIVE_MODE,String(saved.sl_oid)).run();
  await swingProgressiveAuditUpdate(db,auditId,'LOCK_CONFIRMED',{confirmedAt:Date.now(),newOid:String(newOid)});
  return {status:'LOCK_CONFIRMED',peak_pct:peak,locked_pct:target,stop_price:stopWire};
 }catch(err:any){
  // Once a request may have reached the exchange, never blindly retry it.
  // Leave the claim and block new Swing entries pending manual reconciliation.
  await swingProgressiveAuditUpdate(db,auditId,'LOCK_ERROR',{error:String(err?.message??err)});
  if(!mayHaveSent)await db.prepare(`UPDATE swing_protection_orders SET progressive_claimed_at=NULL WHERE signal_key=?`).bind(key).run();
  throw err;
 }
}

// SWING POST-ENTRY PATH AUDIT V1 — OBSERVATION ONLY.
// Records actual candle-path excursion at 3/5/10m and full path until exit.
// Does not change entries, protection, orders, or trading parameters.
async function swingPostEntryPathAudit(env:HyperliquidExecutionEnv):Promise<void>{
 const db=env.DB;if(!db)return;
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_post_entry_path_audit(
  signal_key TEXT PRIMARY KEY, coin TEXT, side TEXT, entry_px REAL,
  entry_at INTEGER, last_checked_at INTEGER, closed_at INTEGER,
  mfe_3m_pct REAL, mae_3m_pct REAL, end_3m_pct REAL,
  mfe_5m_pct REAL, mae_5m_pct REAL, end_5m_pct REAL,
  mfe_10m_pct REAL, mae_10m_pct REAL, end_10m_pct REAL,
  mfe_total_pct REAL, mae_total_pct REAL, end_total_pct REAL,
  first_positive_minute INTEGER, first_negative_minute INTEGER,
  sampled_candles INTEGER, result TEXT, net_pnl REAL,
  status TEXT, error TEXT
 )`).run();
 const res:any=await db.prepare(`SELECT l.crossing_id AS signal_key,l.coin,l.side,
 l.entry_fill_price AS entry_px,l.entry_filled_at AS entry_at,
 l.closed_at,l.close_reason,l.realized_pnl,
 a.mfe_3m_pct,a.mfe_5m_pct,a.mfe_10m_pct,a.closed_at AS audit_closed_at
 FROM hyperliquid_execution_ledger l
 LEFT JOIN swing_post_entry_path_audit a ON a.signal_key=l.crossing_id
 WHERE l.crossing_id LIKE 'SWING:%' AND l.entry_fill_price>0
 AND l.entry_filled_at IS NOT NULL
 AND (a.signal_key IS NULL OR (l.closed_at IS NULL AND (a.mfe_3m_pct IS NULL OR a.mfe_5m_pct IS NULL OR a.mfe_10m_pct IS NULL))
 OR (l.closed_at IS NOT NULL AND a.closed_at IS NULL))
 AND l.entry_filled_at > ?
 ORDER BY l.entry_filled_at DESC LIMIT 12`).bind(Date.now()-36*3600_000).all();
 for(const row of (res.results??[])){
  const key=String(row.signal_key),coin=String(row.coin).toUpperCase();
  const side=String(row.side).toUpperCase(),entry=Number(row.entry_px);
  const entryAt=Number(row.entry_at);
  if(!Number.isFinite(entryAt)||entryAt<=0||!Number.isFinite(entry)||entry<=0)continue;
  const now=Date.now(), closedAt=Number(row.closed_at)||null;
  const end=Math.min(now,closedAt??now,entryAt+75*60_000);
  if(end<entryAt+3*60_000)continue;
  try{
   const raw:any=await postInfo({type:'candleSnapshot',req:{
    coin,interval:'1m',startTime:entryAt-60_000,endTime:end+60_000}});
   if(!Array.isArray(raw))throw Error('INVALID_CANDLE_RESPONSE');
   // Use candles fully closed by the requested horizon; never use future prices.
   const candles=raw.filter((c:any)=>Number.isFinite(Number(c.t))&&
    Number.isFinite(Number(c.T))&&Number(c.T)<=end&&Number(c.T)>entryAt&&
    Number(c.h)>0&&Number(c.l)>0&&Number(c.c)>0)
    .sort((a:any,b:any)=>Number(a.T)-Number(b.T));
   if(!candles.length)throw Error('NO_POST_ENTRY_CANDLES');
   const favorable=(px:number)=>side==='LONG'?(px/entry-1)*100:(entry/px-1)*100;
   const path=(minutes:number)=>{
    const limit=Math.min(end,entryAt+minutes*60_000);
    const arr=candles.filter((c:any)=>Number(c.T)<=limit);
    if(limit<entryAt+minutes*60_000||!arr.length)return null;
    const highs=arr.map((c:any)=>Number(c.h)),lows=arr.map((c:any)=>Number(c.l));
    const best=side==='LONG'?Math.max(...highs):Math.min(...lows);
    const worst=side==='LONG'?Math.min(...lows):Math.max(...highs);
    return {mfe:favorable(best),mae:favorable(worst),last:favorable(Number(arr[arr.length-1].c))};
   };
   const p3=path(3),p5=path(5),p10=path(10);
   const highs=candles.map((c:any)=>Number(c.h)),lows=candles.map((c:any)=>Number(c.l));
   const totalMfe=favorable(side==='LONG'?Math.max(...highs):Math.min(...lows));
   const totalMae=favorable(side==='LONG'?Math.min(...lows):Math.max(...highs));
   const firstPos=candles.find((c:any)=>favorable(side==='LONG'?Number(c.h):Number(c.l))>0);
   const firstNeg=candles.find((c:any)=>favorable(side==='LONG'?Number(c.l):Number(c.h))<0);
   const minute=(c:any)=>c?Math.max(1,Math.ceil((Number(c.T)-entryAt)/60_000)):null;
   await db.prepare(`INSERT INTO swing_post_entry_path_audit
    (signal_key,coin,side,entry_px,entry_at,last_checked_at,closed_at,
     mfe_3m_pct,mae_3m_pct,end_3m_pct,mfe_5m_pct,mae_5m_pct,end_5m_pct,
     mfe_10m_pct,mae_10m_pct,end_10m_pct,mfe_total_pct,mae_total_pct,
     end_total_pct,first_positive_minute,first_negative_minute,
     sampled_candles,result,net_pnl,status,error)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(signal_key) DO UPDATE SET
     last_checked_at=excluded.last_checked_at,closed_at=excluded.closed_at,
     mfe_3m_pct=COALESCE(excluded.mfe_3m_pct,mfe_3m_pct),
     mae_3m_pct=COALESCE(excluded.mae_3m_pct,mae_3m_pct),
     end_3m_pct=COALESCE(excluded.end_3m_pct,end_3m_pct),
     mfe_5m_pct=COALESCE(excluded.mfe_5m_pct,mfe_5m_pct),
     mae_5m_pct=COALESCE(excluded.mae_5m_pct,mae_5m_pct),
     end_5m_pct=COALESCE(excluded.end_5m_pct,end_5m_pct),
     mfe_10m_pct=COALESCE(excluded.mfe_10m_pct,mfe_10m_pct),
     mae_10m_pct=COALESCE(excluded.mae_10m_pct,mae_10m_pct),
     end_10m_pct=COALESCE(excluded.end_10m_pct,end_10m_pct),
     mfe_total_pct=excluded.mfe_total_pct,mae_total_pct=excluded.mae_total_pct,
     end_total_pct=excluded.end_total_pct,
     first_positive_minute=excluded.first_positive_minute,
     first_negative_minute=excluded.first_negative_minute,
     sampled_candles=excluded.sampled_candles,result=excluded.result,
     net_pnl=excluded.net_pnl,status=excluded.status,error=NULL`)
    .bind(key,coin,side,entry,entryAt,now,closedAt,
      p3?.mfe??null,p3?.mae??null,p3?.last??null,
      p5?.mfe??null,p5?.mae??null,p5?.last??null,
      p10?.mfe??null,p10?.mae??null,p10?.last??null,
      totalMfe,totalMae,favorable(Number(candles[candles.length-1].c)),
      minute(firstPos),minute(firstNeg),candles.length,
      row.close_reason??null,row.realized_pnl??null,
      closedAt?'CLOSED':'TRACKING').run();
  }catch(e:any){
   try{await db.prepare(`INSERT INTO swing_post_entry_path_audit
    (signal_key,coin,side,entry_px,entry_at,last_checked_at,status,error)
    VALUES (?,?,?,?,?,?,'ERROR',?)
    ON CONFLICT(signal_key) DO UPDATE SET last_checked_at=excluded.last_checked_at,
    status='ERROR',error=excluded.error`)
    .bind(key,coin,side,entry,entryAt,now,String(e?.message??e).slice(0,250)).run();}catch{}
  }
 }
}

// MANUAL CLOSE V1 — exchange-confirmed reconciliation for orphaned Swing ledger records.
// No order submission/cancellation. Ambiguous fills or open orders leave the safety lock intact.
async function swingReconcileManualCloses(env:HyperliquidExecutionEnv,db:any){
 const pending:any=await db.prepare(`SELECT * FROM hyperliquid_execution_ledger
  WHERE strategy_version IN (?,?,?) AND entry_filled_at IS NOT NULL
  AND (status='TPSL_FAILED_AFTER_RETRIES' OR
       (status='MANUALLY_CLOSED' AND (exit_price IS NULL OR realized_pnl IS NULL OR last_error!='SWING_MANUAL_CLOSE_TELEGRAM_SENT')))
  ORDER BY entry_filled_at DESC LIMIT 20`).bind(...SWING_STRATEGIES).all();
 const events:any[]=[];
 for(const row of pending.results??[]){
  const coin=String(row.coin??'').toUpperCase(),key=String(row.crossing_id??'');
  try{
   if(await getOpenPositionForCoin(coin)){events.push({coin,status:'STILL_OPEN_NO_MANUAL_RECONCILIATION'});continue;}
   if((await getOpenOrdersForCoin(coin)).length){events.push({coin,status:'OPEN_ORDERS_REQUIRE_MANUAL_CHECK'});continue;}
   const fills=await getRecentFillsForCoin(coin);
   const after=fills.filter((f:any)=>Number(f.time)>=Number(row.entry_filled_at)-5000);
   const exits=after.filter((f:any)=>String(f.dir??'').toLowerCase().includes('close'));
   const expected=Number(row.entry_fill_size),entry=Number(row.entry_fill_price);
   if(!(expected>0&&entry>0)||!exits.length){events.push({coin,status:'CLOSE_FILLS_NOT_VERIFIED'});continue;}
   const sorted=exits.slice().sort((a:any,b:any)=>Number(a.time)-Number(b.time));
   // Only one matching close fill is accepted; multiple/partial closes require manual audit.
   if(sorted.length!==1||Math.abs(Number(sorted[0].sz)-expected)>Math.max(expected*0.001,1e-9)){
    events.push({coin,status:'AMBIGUOUS_OR_PARTIAL_CLOSE_FILLS'});continue;
   }
   const exit=sorted[0],exitPx=Number(exit.px),exitAt=Number(exit.time);
   if(!(exitPx>0&&exitAt>0)){events.push({coin,status:'INVALID_CLOSE_FILL'});continue;}
   const side=String(row.side)==='LONG'?'LONG':'SHORT';
   const pnl=lifecyclePnlFromFills(after,Number(row.entry_filled_at),entry,exitPx,expected,side);
   if(pnl.netPnl===null){events.push({coin,status:'NET_PNL_UNAVAILABLE'});continue;}
   const now=Date.now();
   // Preserve already-recorded administrative close timestamp, but prefer exchange close time when unknown.
   if(String(row.status)==='TPSL_FAILED_AFTER_RETRIES'){
    const claim:any=await db.prepare(`UPDATE hyperliquid_execution_ledger SET
     status='MANUALLY_CLOSED',closed_at=?,close_reason='MANUAL',exit_price=?,realized_pnl=?,
     last_error='SWING_MANUAL_CLOSE_TELEGRAM_PENDING',updated_at=?
     WHERE id=? AND status='TPSL_FAILED_AFTER_RETRIES' AND closed_at IS NULL`)
     .bind(exitAt,exitPx,pnl.netPnl,now,row.id).run();
    if(Number(claim.meta?.changes??0)!==1)continue;
   }else{
    await db.prepare(`UPDATE hyperliquid_execution_ledger SET
     closed_at=COALESCE(closed_at,?),close_reason='MANUAL',exit_price=?,realized_pnl=?,updated_at=?
     WHERE id=? AND status='MANUALLY_CLOSED'`)
     .bind(exitAt,exitPx,pnl.netPnl,now,row.id).run();
   }
   await db.prepare(`UPDATE swing_live_queue SET status='CLOSED',reason='MANUALLY_CLOSED_EXCHANGE_FLAT',updated_at=? WHERE signal_key=?`).bind(now,key).run();
   await db.prepare(`DELETE FROM swing_coin_owners WHERE coin=? AND owner=?`).bind(coin,key).run();
   if(String(row.last_error)!=='SWING_MANUAL_CLOSE_TELEGRAM_SENT'){
    const msg=[`🔵 <b>SWING MANUAL CLOSE · EXCHANGE VERIFIED</b>`,
     `🪙 <b>${escapeTelegramHtml(coin)}</b> · ${escapeTelegramHtml(side)}`,
     `🎯 Entry: ${escapeTelegramHtml(entry)}`,
     `🏁 Exit: ${escapeTelegramHtml(exitPx)}`,
     `📦 Size: ${escapeTelegramHtml(expected)}`,
     `💰 NET P/L: $${Number(pnl.netPnl).toFixed(4)}`,
     `📊 NET ROI (notional): ${(100*Number(pnl.netPnl)/(entry*expected)).toFixed(3)}%`,
     `🆔 ${escapeTelegramHtml(key)}`].join('\n');
    const sent=await sendTelegram(env,msg);
    if(sent.sent){await db.prepare(`UPDATE hyperliquid_execution_ledger SET last_error='SWING_MANUAL_CLOSE_TELEGRAM_SENT',updated_at=? WHERE id=? AND status='MANUALLY_CLOSED'`).bind(Date.now(),row.id).run();}
    events.push({coin,status:'MANUALLY_CLOSED',telegram_sent:sent.sent,net_pnl:pnl.netPnl});
   }
  }catch(err:any){events.push({coin,status:'MANUAL_RECONCILIATION_ERROR',error:String(err?.message??err)});}
 }
 return events;
}

export async function monitorSwingShortLive(env:HyperliquidExecutionEnv){
 if(!env.DB)return {ok:false,reason:'DB_MISSING'};
 const db=env.DB;await swingSchema(db);await swingProtectionSchema(db);await swingProgressiveAuditSchema(db).catch(()=>{});
 const manualCloseEvents=await swingReconcileManualCloses(env,db).catch((err:any)=>[{status:'MANUAL_RECONCILIATION_ERROR',error:String(err?.message??err)}]);
 await swingPostEntryPathAudit(env).catch(()=>{});
 // Recover only previously failed Swing protection, after full live exchange verification.
 // A failed or ambiguous check keeps the global entry lock in place.
 const failed:any=await db.prepare(`SELECT * FROM hyperliquid_execution_ledger
  WHERE strategy_version IN (?,?,?) AND status='TPSL_FAILED_AFTER_RETRIES'
  ORDER BY updated_at LIMIT 20`).bind(...SWING_STRATEGIES).all();
 const reconciliation:any[]=[];
 for(const failedRow of failed.results??[]){
  try{
   const result=await swingReconcileFailedProtection(db,failedRow);
   reconciliation.push({coin:failedRow.coin,...result});
  }catch(err:any){
   reconciliation.push({coin:failedRow.coin,ok:false,reason:String(err?.message??err)});
  }
 }
 const rows:any=await db.prepare(`SELECT * FROM hyperliquid_execution_ledger
  WHERE strategy_version IN (?,?,?) AND status IN ('ENTRY_FILLED','PROTECTED','MAX_HOLD_CLOSING')
  ORDER BY entry_filled_at LIMIT 20`).bind(...SWING_STRATEGIES).all();
 const events:any[]=[];
 for(const row of rows.results??[]){
  const coin=String(row.coin),key=String(row.crossing_id);
  try{
   const position=await getOpenPositionForCoin(coin);
   if(position){
    // Keep exchange-native TP/SL intact until an exchange-confirmed timed close.
    // Missing/changed protection blocks new entries; never blindly resubmit.
    const inventory=await swingProtectionInventory(coin);
    const saved:any=await db.prepare(`SELECT * FROM swing_protection_orders WHERE signal_key=?`).bind(key).first();
    const progressive=String(saved?.mode??'')===SWING_PROGRESSIVE_MODE;
    const confirmed=!!saved&&(progressive
      ?inventory.same.length===1&&inventory.tp.length===0&&inventory.sl.length===1&&
       swingProtectionOid(inventory.sl[0])===String(saved.sl_oid)&&saved.progressive_claimed_at==null
      :inventory.same.length===2&&inventory.tp.length===1&&inventory.sl.length===1&&
       swingProtectionOid(inventory.tp[0])===String(saved.tp_oid)&&
       swingProtectionOid(inventory.sl[0])===String(saved.sl_oid));
    if(!confirmed){
      await db.prepare(`UPDATE hyperliquid_execution_ledger SET status='TPSL_FAILED_AFTER_RETRIES',
        last_error='SWING_PROTECTION_MISSING_OR_CHANGED_MANUAL_RECONCILIATION',updated_at=? WHERE id=?`)
        .bind(Date.now(),row.id).run();
      await sendTelegram(env,`🚨 SWING PROTECTION ALERT · ${escapeTelegramHtml(coin)} · ${escapeTelegramHtml(key)}\nTP/SL missing or changed. New SWING entries blocked. Check Hyperliquid manually.`).catch(()=>{});
      events.push({coin,status:'PROTECTION_ALERT_NO_AUTOMATIC_ORDER'});
      continue;
    }
    if(progressive){
     try{
      const result=await swingAdvanceProgressive(env,row,position,saved);
      events.push({coin,status:'PROGRESSIVE',...result});
     }catch(e:any){
      // /info 429 before any order change is a transient read failure, NOT missing SL.
      // Keep the protected ledger row and the exchange-native SL untouched.
      if(String(e?.message??e).includes('INFO_HTTP_429')){
       events.push({coin,status:'PROGRESSIVE_RATE_LIMIT_RETRY_NEXT_CYCLE',error:String(e?.message??e)});
       continue;
      }
      await db.prepare(`UPDATE hyperliquid_execution_ledger SET status='TPSL_FAILED_AFTER_RETRIES',last_error=?,updated_at=? WHERE id=?`)
       .bind('SWING_PROGRESSIVE_REQUIRES_RECONCILIATION:'+String(e?.message??e),Date.now(),row.id).run();
      await sendTelegram(env,`🚨 SWING PROGRESSIVE ALERT · ${escapeTelegramHtml(coin)}\n${escapeTelegramHtml(String(e?.message??e))}\nCheck live SL orders manually. New Swing entries blocked.`).catch(()=>{});
      events.push({coin,status:'PROGRESSIVE_ALERT_MANUAL_RECONCILIATION'});
      continue;
     }
    }
    // Only verified, protected positions are eligible for an automated timed exit.
    // An ambiguous/failed IOC is never recorded as a closed trade.
    const maxHold=swingMaxHoldMs(key);
    const filledAt=Number(row.entry_filled_at);
    if(maxHold!==null && Number.isFinite(filledAt) && filledAt>0 && Date.now()-filledAt>=maxHold){
      if(!SWING_TRADING_ENABLED){events.push({coin,status:'TIME_EXIT_DUE_BUT_SWING_DISABLED'});continue;}
      const secret=normalizePrivateKey(env.HYPERLIQUID_API_PRIVATE_KEY);
      if(!privateKeyFormatOk(secret))throw Error('SWING_TIME_EXIT_PRIVATE_KEY_INVALID');
      const szi=Number(position.szi);
      if(!Number.isFinite(szi)||szi===0)throw Error('SWING_TIME_EXIT_INVALID_POSITION_SIZE');
      if((row.side==='LONG'&&szi<=0)||(row.side==='SHORT'&&szi>=0))throw Error('SWING_TIME_EXIT_POSITION_SIDE_MISMATCH');
      // Mark intent before sending, for recovery after a worker interruption.
      await db.prepare(`UPDATE hyperliquid_execution_ledger SET status='MAX_HOLD_CLOSING',
        last_error=NULL,updated_at=? WHERE id=? AND status IN ('ENTRY_FILLED','PROTECTED','MAX_HOLD_CLOSING')`)
        .bind(Date.now(),row.id).run();
      const close=await swingCloseMarket(coin,szi,secret);
      const statuses=close?.json?.response?.data?.statuses;
      const filled=close?.httpStatus>=200&&close.httpStatus<300&&close?.json?.status==='ok'&&
        Array.isArray(statuses)&&statuses.some((x:any)=>x?.filled&&Number(x.filled.totalSz??x.filled.sz)>0);
      // A partial fill is NOT a closed position; the next tick reconciles it.
      const remaining=await getOpenPositionForCoin(coin);
      if(remaining){
        const reason=filled?'SWING_TIME_EXIT_PARTIAL_POSITION_REMAINS':'SWING_TIME_EXIT_IOC_NOT_FILLED';
        await db.prepare(`UPDATE hyperliquid_execution_ledger SET last_error=?,updated_at=? WHERE id=?`)
          .bind(reason,Date.now(),row.id).run();
        events.push({coin,status:reason});
        continue;
      }
      // A flat exchange position will be reconciled with its actual close fill below
      // on the next lifecycle run; do not fabricate an exit price or net P/L.
      events.push({coin,status:'TIME_EXIT_FLAT_PENDING_FILL_RECONCILIATION'});
    }
    continue;
   }
   // Confirm both position and all open orders before releasing the coin.
   const orders=await getOpenOrdersForCoin(coin);
   if(orders.length){
    const secret=normalizePrivateKey(env.HYPERLIQUID_API_PRIVATE_KEY);
    if(!privateKeyFormatOk(secret))throw Error('PRIVATE_KEY_INVALID');
    const raw=await postInfo({type:'metaAndAssetCtxs'});
    const a=(raw?.[0]?.universe??[]).findIndex((x:any)=>String(x.name).toUpperCase()===coin);
    if(a<0)throw Error('ASSET_NOT_FOUND');
    // Only cancel orders after confirmed flat; coin remains locked until confirmed clear.
    const cancels=orders.filter((x:any)=>x.oid!=null).map((x:any)=>({a,o:Number(x.oid)}));
    if(cancels.length)await sendLifecycleSignedAction({type:'cancel',cancels},secret);
    if((await getOpenOrdersForCoin(coin)).length)throw Error('RESIDUAL_OPEN_ORDERS');
   }
   const fills=await getRecentFillsForCoin(coin);
   const exits=fills.filter((f:any)=>Number(f.time)>=Number(row.entry_filled_at??0)&&
      String(f.dir??'').toLowerCase().includes('close'));
   if(!exits.length)throw Error('CLOSE_FILL_NOT_YET_VISIBLE');
   const exit=exits.sort((a:any,b:any)=>Number(b.time)-Number(a.time))[0];
   const side=String(row.side)==='LONG'?'LONG':'SHORT';
   const pnl=lifecyclePnlFromFills(fills,Number(row.entry_filled_at),Number(row.entry_fill_price),
     Number(exit.px),Number(row.entry_fill_size),side);
   if(pnl.netPnl==null)throw Error('NET_PNL_UNAVAILABLE');
   const savedRule:any=await db.prepare('SELECT tp_pct,sl_pct,market_regime,selected_pattern,exit_mode FROM swing_live_queue WHERE signal_key=?').bind(key).first();
   const savedProtection:any=await db.prepare('SELECT mode,peak_pct,locked_pct FROM swing_protection_orders WHERE signal_key=?').bind(key).first();
   const tpPct=Number(savedRule?.tp_pct);
   const slPct=Number(savedRule?.sl_pct);
   // Swing exit classification uses the actual NET result after fees.
   // Progressive stop orders are protective order mechanics, not an outcome class.
   // Every confirmed profitable exit is TP; every confirmed losing exit is SL.
   // A precisely flat result remains BE (neither a win nor a loss).
   const netResult = Number(pnl.netPnl);
   const closeReason = netResult > 0 ? 'TP' : netResult < 0 ? 'SL' : 'BE';
   // Atomic close claim: overlapping runs must not send duplicate exit Telegram messages.
   const closeClaim:any=await db.prepare(`UPDATE hyperliquid_execution_ledger SET status='CLOSED',closed_at=?,
    close_reason=?,exit_price=?,realized_pnl=?,updated_at=? WHERE id=? AND status!='CLOSED' AND closed_at IS NULL`)
    .bind(Number(exit.time),closeReason,Number(exit.px),pnl.netPnl,Date.now(),row.id).run();
   if(Number(closeClaim.meta?.changes??0)!==1)continue;
   await db.prepare(`UPDATE swing_live_queue SET status='CLOSED',updated_at=? WHERE signal_key=?`).bind(Date.now(),key).run();
   await db.prepare(`DELETE FROM swing_coin_owners WHERE coin=? AND owner=?`).bind(coin,key).run();
   // Exit notification only after confirmed flat, close fill, and durable CLOSED state.
   await sendTelegram(env,swingExitTelegram({coin,side,key,regime:savedRule?.market_regime,pattern:savedRule?.selected_pattern,
    tpPct:savedRule?.tp_pct,slPct:savedRule?.sl_pct,entry:Number(row.entry_fill_price),exit:Number(exit.px),sz:Number(row.entry_fill_size),
    reason:closeReason,gross:pnl.grossPnl,fees:pnl.fees,net:pnl.netPnl,
    heldMs:Number(exit.time)-Number(row.entry_filled_at),mode:savedProtection?.mode,peak:savedProtection?.peak_pct,locked:savedProtection?.locked_pct})).catch(()=>{});
   events.push({coin,status:'CLOSED',net_pnl:pnl.netPnl});
  }catch(err:any){
   await db.prepare(`UPDATE hyperliquid_execution_ledger SET last_error=?,updated_at=? WHERE id=?`)
    .bind(String(err?.message??err),Date.now(),row.id).run();
   events.push({coin,error:String(err?.message??err)});
  }
 }
 return {ok:true,reconciliation,manual_close_events:manualCloseEvents,events};
}

// PRECONFIRM AUDIT — observational, no order paths. LIVE rule maps are the only allowlist.
namespace SwingCandidatePreconfirm {
type Frame='1h'|'4h';type Side='LONG'|'SHORT';
type Rules=Record<string,Record<string,{tp:number;sl:number}>>;
type Env={DB?:any;SWING_DB?:any};
const HOUR=3600000;
const SHORT_1H=SWING_SHORT_1H_RULES,SHORT_4H=SWING_SHORT_4H_RULES;
const LONG_1H=SWING_LONG_1H_RULES,LONG_4H=SWING_LONG_4H_RULES;
const COINS=['BTC','ETH','SOL','XRP','BNB','DOGE','AVAX','LINK','SUI','HYPE','ADA','LTC','BCH','AAVE','UNI','NEAR','OP','ARB','WIF','TRX'];
const STEP:{[key:string]:number}={'1h':3600000,'4h':14400000};
function choose(regime:string,side:Side,frame:Frame,patterns:string[]){
 const rules=(side==='LONG'?(frame==='1h'?LONG_1H:LONG_4H):(frame==='1h'?SHORT_1H:SHORT_4H))[regime];
 if(!rules)return null;
 for(const [pattern,params] of Object.entries(rules))if(patterns.includes(pattern))return {pattern,...params};
 return null;
}
function db(env:Env){if(!env.DB?.prepare)throw Error('EARLY_DB_MISSING');return env.DB;}
function signalsDb(env:Env){if(!(env.SWING_DB??env.DB)?.prepare)throw Error('SWING_DB_MISSING');return env.SWING_DB??env.DB;}
function valid(c:CandidateCandle){return [c.t,c.o,c.h,c.l,c.c,c.v].every(Number.isFinite)&&c.o>0&&c.c>0&&c.l>0&&c.h>=Math.max(c.o,c.c,c.l)&&c.l<=Math.min(c.o,c.c,c.h)&&c.v>=0;}
async function fetchBars(coin:string,frame:Frame,at:number){
 const step=STEP[frame],start=Math.floor(at/step)*step-step*165;
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
 try{
  const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin,interval:frame,startTime:start,endTime:at}}),signal:ctrl.signal});
  if(!r.ok)throw Error('HYPERLIQUID_'+r.status);
  const raw=await r.json();if(!Array.isArray(raw))throw Error('INVALID_OHLCV');
  const bars:CandidateCandle[]=raw.map((x:any)=>({t:Number(x.t),o:Number(x.o),h:Number(x.h),l:Number(x.l),c:Number(x.c),v:Number(x.v),n:Number(x.n)})).filter(valid).sort((a:CandidateCandle,b:CandidateCandle)=>a.t-b.t);
  if(bars.some((c,i)=>i>0&&c.t===bars[i-1].t))throw Error('DUPLICATE_BARS');
  return bars;
 }finally{clearTimeout(timer);}
}
// Byte-for-byte equivalent query criteria to execution.ts/swingLongRegimeAt.
async function liveRegime(env:Env,at:number){return swingLongRegimeAt(env.SWING_DB??env.DB,at);}
function detect(bars:CandidateCandle[],frame:Frame){const market=candidateStructure(bars);return [
 ...candidateDetectCatalog(bars,market,frame),
 ...CandidatePatternCompareV2.detectCatalog(bars,market,frame).map(h=>({...h,id:'V2_'+h.id})),
 ...candidateDetectClassicalCatalog(bars,market,frame)
 ];}
function ruleTable(side:Side,frame:Frame):Rules{
 return side==='LONG'?(frame==='1h'?LONG_1H:LONG_4H):(frame==='1h'?SHORT_1H:SHORT_4H);
}
// "Potential" is explicitly a pre-detector heuristic, not a claim that the
// real LIVE detector would accept the candle. The detector is always the authority.
// We use only the current forming bar + preceding CLOSED bars, with no future data.
function formingCandidates(closed:CandidateCandle[],cur:CandidateCandle[],frame:Frame,regime:string){
 const c=cur[0],p=closed.at(-1)!;const prior=closed.slice(-20);
 const hi=Math.max(...prior.map(x=>x.h)),lo=Math.min(...prior.map(x=>x.l));
 const meanVolume=prior.reduce((sum,x)=>sum+x.v,0)/prior.length;
 const span=Math.max(c.h-c.l,c.c*0.000001),body=Math.abs(c.c-c.o);
 const upper=c.h-Math.max(c.c,c.o),lower=Math.min(c.c,c.o)-c.l;
 const patterns:Record<string,boolean>={
  RANGE_BREAKOUT:c.c>hi*0.998 && c.c>=c.o && body/span>=0.25,
  RANGE_BREAKDOWN:c.c<lo*1.002 && c.c<=c.o && body/span>=0.25,
  LIQUIDITY_SWEEP_LOW:c.l<lo && c.c>=lo*0.997 && lower/span>=0.25,
  LIQUIDITY_SWEEP_HIGH:c.h>hi && c.c<=hi*1.003 && upper/span>=0.25,
  MOMENTUM_REVERSAL_LONG:p.c<p.o && closed.at(-2)!.c<closed.at(-2)!.o && c.c>=p.h*0.997 && c.c>=c.o,
  MOMENTUM_REVERSAL_SHORT:p.c>p.o && closed.at(-2)!.c>closed.at(-2)!.o && c.c<=p.l*1.003 && c.c<=c.o,
  HAMMER:lower/span>=0.4 && c.c>=c.o,
  SHOOTING_STAR:upper/span>=0.4 && c.c<=c.o,
  BULL_ENGULF:p.c<p.o && c.c>=p.o*0.998 && c.c>c.o,
  BEAR_ENGULF:p.c>p.o && c.c<=p.o*1.002 && c.c<c.o,
  VOLUME_EXPANSION_SHORT:c.c<c.o && meanVolume>0 && c.v>=meanVolume*0.65,
  DOUBLE_TOP:c.c<p.c && c.h>=hi*0.997,
  DOUBLE_BOTTOM:c.c>p.c && c.l<=lo*1.003,
  V2_DOUBLE_TOP:c.c<p.c && c.h>=hi*0.997,
  V2_BEAR_ENGULF:p.c>p.o && c.c<=p.o*1.002 && c.c<c.o,
  V2_BULL_ENGULF:p.c<p.o && c.c>=p.o*0.998 && c.c>c.o,
  V2_SHOOTING_STAR:upper/span>=0.4 && c.c<=c.o
 };
 const result:{side:Side;pattern:string;phase:string;reason:string}[]=[];
 for(const side of ['LONG','SHORT'] as Side[]){
  const allowed=ruleTable(side,frame)[regime]||{};
  for(const pattern of Object.keys(allowed)){
   if(patterns[pattern])result.push({side,pattern,phase:'FORMING',reason:'EARLY_HEURISTIC_NOT_LIVE_DETECTOR'});
  }
 }
 return result;
}
async function candidateSchema(d:any){await swingCandidateAuditSchema(d);}
type CandidateHit={side:Side;pattern:string;phase:string;reason:string};
async function recordPotentialCandidates(env:Env,coin:string,frame:Frame,barOpen:number,
 at:number,price:number,regime:string,active:Map<string,CandidateHit>){
 const d=db(env),step=STEP[frame];let count=0;
 for(const side of ['LONG','SHORT'] as Side[]){
  const allowed=new Set(Object.keys(ruleTable(side,frame)[regime]??{}));
  const matches=[...active.values()].filter(x=>x.side===side&&allowed.has(x.pattern));
  if(!matches.length)continue;
  const patterns=[...new Set(matches.map(x=>x.pattern))];
  const detected=matches.some(x=>x.phase==='LIVE_ELIGIBLE'||x.phase==='DETECTOR_HIT');
  const stage=detected?'DETECTOR_HIT':'FORMING';
  const reason=detected?'FORMING_BAR_DETECTOR_NOT_CLOSED':'HEURISTIC_POTENTIAL_NOT_CONFIRMED';
  const key=`SWING:${side}:${coin}:${frame}:${barOpen}`;
  // IMPORTANT: never downgrade or overwrite the authoritative LIVE selection.
  await d.prepare(`INSERT INTO swing_live_candidates
   (candidate_key,coin,side,interval,signal_bar_open,signal_available_at,first_seen_at,
    last_seen_at,reference_price,patterns_json,market_regime,selected_pattern,stage,reason,checks)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,1)
   ON CONFLICT(candidate_key) DO UPDATE SET
    last_seen_at=excluded.last_seen_at,
    reference_price=CASE WHEN swing_live_candidates.stage IN ('LIVE_SELECTED','ELIGIBLE') THEN swing_live_candidates.reference_price ELSE excluded.reference_price END,
    patterns_json=CASE WHEN swing_live_candidates.stage IN ('LIVE_SELECTED','ELIGIBLE') THEN swing_live_candidates.patterns_json ELSE excluded.patterns_json END,
    market_regime=CASE WHEN swing_live_candidates.stage IN ('LIVE_SELECTED','ELIGIBLE') THEN swing_live_candidates.market_regime ELSE excluded.market_regime END,
    stage=CASE WHEN swing_live_candidates.stage IN ('LIVE_SELECTED','ELIGIBLE') THEN swing_live_candidates.stage ELSE excluded.stage END,
    reason=CASE WHEN swing_live_candidates.stage IN ('LIVE_SELECTED','ELIGIBLE') THEN swing_live_candidates.reason ELSE excluded.reason END,
    checks=swing_live_candidates.checks+1`)
   .bind(key,coin,side,frame,barOpen,barOpen+step,at,at,price,JSON.stringify(patterns),regime,stage,reason).run();
  await d.prepare(`INSERT INTO swing_live_candidate_checks
   (candidate_key,checked_at,coin,side,interval,stage,reason,market_regime,selected_pattern,reference_price,patterns_json)
   VALUES (?,?,?,?,?,?,?,?,NULL,?,?)`)
   .bind(key,at,coin,side,frame,stage,reason,regime,price,JSON.stringify(patterns)).run();
  count++;
 }
 return count;
}

/** Scans forming candles. FORMING is heuristic; DETECTOR_HIT is not closed-bar LIVE confirmation. */
async function scanCandidate(env:Env,coin:string,frame:Frame,at:number){
 const step=STEP[frame],barOpen=Math.floor(at/step)*step;
 const bars=await fetchBars(coin,frame,at);
 const closed=bars.filter(c=>c.t<barOpen).slice(-160),forming=bars.find(c=>c.t===barOpen);
 if(!forming||closed.length<65)return {coin,frame,status:'NOT_READY',candidates:0};
 if(closed.some((c,i)=>i>0&&c.t-closed[i-1].t!==step)||closed.at(-1)!.t+step!==barOpen)
  return {coin,frame,status:'GAPPED_HISTORY',candidates:0};
 const regime=await liveRegime(env,at);
 if(!regime)return {coin,frame,status:'REGIME_UNAVAILABLE',candidates:0};
 const hits=detect([...closed,forming],frame).filter(h=>h.signalBarOpen===barOpen);
 const active=new Map<string,CandidateHit>();
 for(const item of formingCandidates(closed,[forming],frame,regime))
  active.set(item.side+':'+item.pattern,item);
 for(const side of ['LONG','SHORT'] as Side[]){
  const selected=choose(regime,side,frame,hits.filter(h=>h.side===side).map(h=>h.id));
  if(selected)active.set(side+':'+selected.pattern,{side,pattern:selected.pattern,phase:'DETECTOR_HIT',reason:'FORMING_BAR_DETECTOR_RANKED_RULE'});
 }
 const candidates=await recordPotentialCandidates(env,coin,frame,barOpen,at,forming.c,regime,active);
 return {coin,frame,status:'OK',regime,candidates,detectorHits:hits.length};
}
export async function runCycle(env:Env,offset=0,limit=5){
 if(!env.DB?.prepare)return {success:false,error:'DB_BINDING_REQUIRED',trading:false};
 const at=Date.now(),start=Math.max(0,Math.floor(offset)),count=Math.max(1,Math.min(20,Math.floor(limit)));
 try{await candidateSchema(env.DB);}catch(e:any){return {success:false,error:'SCHEMA:'+String(e?.message||e),trading:false};}
 const results:any[]=[],errors:string[]=[];
 for(const coin of COINS.slice(start,start+count))for(const frame of ['1h','4h'] as Frame[]){
  try{results.push(await scanCandidate(env,coin,frame,at));}
  catch(e:any){errors.push(`${coin}/${frame}:${String(e?.message||e)}`);}
 }
 return {success:errors.length===0,module:'SWING_LIVE_CANDIDATES',version:'1.0.0',trading:false,
  offset,coins:COINS.slice(start,start+count),candidates:results.reduce((n,r)=>n+r.candidates,0),results,errors};
}

}
export const runSwingLiveCandidatesAudit=SwingCandidatePreconfirm.runCycle;
