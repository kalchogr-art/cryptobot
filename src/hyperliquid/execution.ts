import { encode } from "@msgpack/msgpack";
import {
  bytesToHex,
  concat,
  keccak256,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ============================================================
// HYPERLIQUID SIGNAL EXECUTION V2.8.1.те
// V2.8.1: exact active SL OID tracking for progressive replacement
// V2.8: LIVE progressive protection — LONG=A, SHORT=C; initial SL 0.15% both sides
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

const CONFIG = {
  LIVE_TRADING: false,

  MIN_SIGNAL_SCORE: 65,

  MARGIN_USD: 1.04,
  LEVERAGE: 10,
  IS_CROSS: true,

  LONG_TAKE_PROFIT_PCT: 0.50,
  LONG_STOP_LOSS_PCT: 0.15,
  SHORT_TAKE_PROFIT_PCT: 0.50,
  SHORT_STOP_LOSS_PCT: 0.15,

  // V2.8 progressive protection. Values are directional gross-return percentages.
  // +0.07% gross is approximately fee-adjusted break-even before slippage.
  LONG_PROGRESSIVE_STEPS: [
    { trigger: 0.15, stop: 0.07 },
    { trigger: 0.25, stop: 0.10 },
    { trigger: 0.35, stop: 0.20 },
    { trigger: 0.45, stop: 0.30 },
  ],
  SHORT_PROGRESSIVE_STEPS: [
    { trigger: 0.25, stop: 0.07 },
    { trigger: 0.35, stop: 0.15 },
    { trigger: 0.45, stop: 0.25 },
  ],

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

async function getActiveAssetTradingAvailability(
  coin: string,
  side: "LONG" | "SHORT"
): Promise<any> {
  try {
    const data = await postInfo({
      type: "activeAssetData",
      user: MASTER_ACCOUNT,
      coin,
    });

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

    return {
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
  } catch (e: any) {
    return {
      success: false,
      error: e?.message ?? String(e),
      coin,
      side,
    };
  }
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
    `🟢 TP: ${escapeTelegramHtml(a.tpWire)} (${a.takeProfitPct.toFixed(2)}%)`,
    `🔴 SL: ${escapeTelegramHtml(a.slWire)} (${a.stopLossPct.toFixed(2)}%)`,
    `🛡 TP/SL: ${protection}`,
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
      progressive_stage INTEGER DEFAULT 0,
      progressive_stop_pct REAL,
      progressive_stop_price REAL,
      progressive_stop_oid INTEGER,
      progressive_updated_at INTEGER,
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
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_stage INTEGER DEFAULT 0",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_stop_pct REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_stop_price REAL",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_stop_oid INTEGER",
    "ALTER TABLE hyperliquid_execution_ledger ADD COLUMN progressive_updated_at INTEGER"
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

  let grossPnl = Number(exchangeClosedPnl);
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

function progressiveStepsForSide(side: string): ProgressiveStep[] {
  return side === "SHORT"
    ? CONFIG.SHORT_PROGRESSIVE_STEPS
    : CONFIG.LONG_PROGRESSIVE_STEPS;
}

function directionalReturnPct(side: string, entryPrice: number, marketPrice: number): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(marketPrice) || marketPrice <= 0) {
    return NaN;
  }
  return side === "SHORT"
    ? ((entryPrice - marketPrice) / entryPrice) * 100
    : ((marketPrice - entryPrice) / entryPrice) * 100;
}

function reachedProgressiveStep(side: string, directionalReturn: number): { stage: number; stop: number; trigger: number } | null {
  if (!Number.isFinite(directionalReturn)) return null;
  const steps = progressiveStepsForSide(side);
  let reached: { stage: number; stop: number; trigger: number } | null = null;
  for (let i = 0; i < steps.length; i++) {
    if (directionalReturn + 1e-12 >= steps[i].trigger) {
      reached = { stage: i + 1, stop: steps[i].stop, trigger: steps[i].trigger };
    }
  }
  return reached;
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

  const raw = await postInfo({ type: "metaAndAssetCtxs" });
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
  const target = reachedProgressiveStep(side, dirReturn);
  const currentStage = Math.max(0, Number(row.progressive_stage ?? 0) || 0);
  if (!target || target.stage <= currentStage) {
    return {
      advanced: false,
      stage: currentStage,
      directional_return_pct: Number.isFinite(dirReturn) ? roundTo(dirReturn, 4) : null,
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
  const addRes = await sendLifecycleSignedAction(
    { type: "order", orders: [newStopOrder], grouping: "na" },
    secret
  );
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
        progressive_stop_oid=?, progressive_updated_at=?, updated_at=?
    WHERE id=?
  `).bind(
    target.stage,
    target.stop,
    stopPx,
    newStopOid,
    Date.now(),
    Date.now(),
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

export async function monitorHyperliquidExecutionLifecycle(env?: HyperliquidExecutionEnv): Promise<any> {
  if (!env?.DB) return { success: false, reason: "D1_NOT_BOUND" };
  await ensureExecutionLedger(env.DB);
  const rows: any = await env.DB.prepare(`
    SELECT * FROM hyperliquid_execution_ledger
    WHERE status IN ('ENTRY_FILLED','PROTECTED','TPSL_FAILED_AFTER_RETRIES','MAX_HOLD_CLOSING')
    ORDER BY id ASC LIMIT 100
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
      const fills = await getRecentFillsForCoin(coin);
      const exit = fills.find((f:any) => Number(f?.time ?? 0) >= filledAt && Number(f?.closedPnl ?? 0) !== 0)
        ?? fills.find((f:any) => Number(f?.time ?? 0) >= filledAt);
      const exitPrice = Number(exit?.px);
      const realizedPnl = Number(exit?.closedPnl);
      const pnl = lifecyclePnlFromFills(
        fills, filledAt, entryPrice, exitPrice, entrySize, side,
        Number.isFinite(realizedPnl) ? realizedPnl : null
      );
      const tpPct = side === "LONG" ? CONFIG.LONG_TAKE_PROFIT_PCT : CONFIG.SHORT_TAKE_PROFIT_PCT;
      const slPct = side === "LONG" ? CONFIG.LONG_STOP_LOSS_PCT : CONFIG.SHORT_STOP_LOSS_PCT;
      const tp = side === "LONG" ? entryPrice*(1+tpPct/100) : entryPrice*(1-tpPct/100);
      const sl = side === "LONG" ? entryPrice*(1-slPct/100) : entryPrice*(1+slPct/100);
      const progressiveStop = Number(row.progressive_stop_price);
      const progressiveStage = Number(row.progressive_stage ?? 0);
      let reason = "CLOSED_OTHER", title = "POSITION CLOSED", emoji = "⚪";
      if (Number.isFinite(exitPrice)) {
        const tpHit = side === "LONG" ? exitPrice >= tp*0.9999 : exitPrice <= tp*1.0001;
        const progressiveHit =
          progressiveStage > 0 && Number.isFinite(progressiveStop) &&
          (side === "LONG" ? exitPrice <= progressiveStop*1.0005 : exitPrice >= progressiveStop*0.9995);
        const slHit = side === "LONG" ? exitPrice <= sl*1.0001 : exitPrice >= sl*0.9999;
        if (tpHit) { reason="TP_HIT"; title="TP HIT"; emoji="🟢"; }
        else if (progressiveHit) { reason="PROGRESSIVE_SL_HIT"; title="PROGRESSIVE SL HIT"; emoji="🟡"; }
        else if (slHit) { reason="SL_HIT"; title="SL HIT"; emoji="🔴"; }
      }
      await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET status=?,updated_at=?,closed_at=?,close_reason=?,exit_price=?,realized_pnl=? WHERE id=?`)
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
      out.push({coin,status:reason,exit_price:exitPrice});
      continue;
    }

    // V2.8: while the position is open, advance the live progressive SL.
    // LONG uses Progressive A; SHORT uses Progressive C. Initial SL is 0.15% for both.
    let progressive: any = null;
    if (secretOk && String(row.status) === "PROTECTED") {
      try {
        progressive = await advanceProgressiveProtection(
          env,
          row,
          position,
          secretRaw as `0x${string}`
        );
      } catch (e:any) {
        progressive = { advanced:false, reason:"PROGRESSIVE_EXCEPTION", error:e?.message ?? String(e) };
      }
    }

    if (heldMs < CONFIG.MAX_HOLD_MS) {
      out.push({coin,status:"OPEN",held_ms:heldMs,progressive});
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

    await env.DB.prepare(`UPDATE hyperliquid_execution_ledger SET status='MAX_HOLD_EXIT',updated_at=?,closed_at=?,close_reason='MAX_HOLD_30M',exit_price=?,realized_pnl=? WHERE id=?`)
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
      progressive_strategy: isLong ? "LONG_PROGRESSIVE_A" : "SHORT_PROGRESSIVE_C",
      progressive_steps: isLong ? CONFIG.LONG_PROGRESSIVE_STEPS : CONFIG.SHORT_PROGRESSIVE_STEPS,
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

  // V2.7.2 pre-entry guard:
  // Use Hyperliquid's per-asset/per-direction availableToTrade, not
  // clearinghouseState.withdrawable. The latter can be 0 while the account
  // still reports USDC and Hyperliquid itself exposes tradable availability.
  const [preEntryBalance, tradingAvailability] = await Promise.all([
    getAccountSnapshot(),
    getActiveAssetTradingAvailability(coin, side),
  ]);

  const availableMargin = Number(tradingAvailability?.available_to_trade);
  const maxTradeSz = Number(tradingAvailability?.max_trade_sz);
  const availabilityMarkPx = Number(tradingAvailability?.mark_px);

  // Compare like-for-like notionals. CONFIG.MARGIN_USD is collateral/margin,
  // while maxTradeSz is the maximum position size Hyperliquid currently allows.
  const targetNotionalUsd = CONFIG.MARGIN_USD * CONFIG.LEVERAGE;
  const maxTradableNotionalUsd =
    Number.isFinite(maxTradeSz) && Number.isFinite(availabilityMarkPx)
      ? maxTradeSz * availabilityMarkPx
      : NaN;

  // Small headroom prevents requesting the absolute exchange maximum and
  // reduces partial IOC fills caused by price movement between check and order.
  const requiredNotionalWithHeadroom =
    targetNotionalUsd + CONFIG.MIN_MARGIN_HEADROOM_USD * CONFIG.LEVERAGE;

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
        marginUsd: CONFIG.MARGIN_USD,
        leverage: CONFIG.LEVERAGE,
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

  const existingPosition = await getOpenPositionForCoin(coin);
  const existingOrders = await getOpenOrdersForCoin(coin);
  if (existingPosition || existingOrders.length > 0) {
    const reason = existingPosition ? "EXISTING_POSITION_FOR_COIN" : "EXISTING_OPEN_ORDERS_FOR_COIN";
    await updateExecutionLedger(env?.DB, signal.crossing_id, "ENTRY_BLOCKED_EXISTING_EXPOSURE", { last_error: reason });
    const tg = await sendTelegram(env, buildRejectedTelegramMessage({coin,side,score,crossingId:signal.crossing_id,episodeId:signal.episode_id,marginUsd:CONFIG.MARGIN_USD,leverage:CONFIG.LEVERAGE,reason,balance:preEntryBalance}));
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
  if (!leverageAlreadyCorrect) {
    try {
      leverageResponse = await sendSignedAction(leverageAction);
    } catch (e: any) {
      const levReason = e?.message ?? String(e);
      await updateExecutionLedger(env?.DB, signal.crossing_id, "LEVERAGE_ERROR", { last_error: levReason });
      const levBal = await getAccountSnapshot();
      const levTg = await sendTelegram(env, buildRejectedTelegramMessage({coin,side,score,crossingId:signal.crossing_id,episodeId:signal.episode_id,marginUsd:CONFIG.MARGIN_USD,leverage:CONFIG.LEVERAGE,reason:`LEVERAGE_ERROR: ${levReason}`,balance:levBal}));
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
      const levTg = await sendTelegram(env, buildRejectedTelegramMessage({coin,side,score,crossingId:signal.crossing_id,episodeId:signal.episode_id,marginUsd:CONFIG.MARGIN_USD,leverage:CONFIG.LEVERAGE,reason:"LEVERAGE_NOT_CONFIRMED_ENTRY_BLOCKED",balance:levBal}));
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
        marginUsd: CONFIG.MARGIN_USD,
        leverage: CONFIG.LEVERAGE,
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
        marginUsd: CONFIG.MARGIN_USD,
        leverage: CONFIG.LEVERAGE,
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
    await sendTelegram(env, buildRejectedTelegramMessage({coin,side,score,crossingId:signal.crossing_id,episodeId:signal.episode_id,marginUsd:CONFIG.MARGIN_USD,leverage:CONFIG.LEVERAGE,reason:"CRITICAL: ENTRY REPORTED FILLED BUT FILL DATA INVALID — CHECK POSITION NOW",balance:invalidBal}));
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
      const twoStatuses =
        Array.isArray(protectionStatuses) &&
        protectionStatuses.length >= 2;

      protectionOk =
        httpOk &&
        exchangeOk &&
        twoStatuses &&
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
    marginUsd: CONFIG.MARGIN_USD,
    leverage: CONFIG.LEVERAGE,
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
      progressive_strategy: isLong ? "LONG_PROGRESSIVE_A" : "SHORT_PROGRESSIVE_C",
      progressive_steps: isLong ? CONFIG.LONG_PROGRESSIVE_STEPS : CONFIG.SHORT_PROGRESSIVE_STEPS,
      grouping: "positionTpsl",
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
