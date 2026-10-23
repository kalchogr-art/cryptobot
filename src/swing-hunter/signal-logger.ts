/** Swing Hunter V1.9.1 — D1 schema-compatible, research-only signal logger.
 * No trade execution, n.o changes to live strategies.
 * Required D1 columns: id INTEGER PRIMARY KEY, coin, interval, pattern, side,
 * signal_bar_open, entry_price, context_json, status, created_at,
 * signal_available_at, reference_price, strength, outcome_json, resolved_at.
 */
import type { Interval, Candle } from './types';
import { COINS, fetchClosed, quality, STEP } from './ohlcv';
import { structure } from './market-structure';
import { detectCatalog, detectClassicalCatalog, PatternCompareV2 } from './pattern-catalog';
import { collectContext } from './context';

const NEW_SIGNALS_ENABLED = false; // Resume collection, retain historical D1 rows.
const TPS = [0.3, 0.5, 0.75, 1, 1.5, 2];
const SLS = [0.3, 0.5, 0.75, 1, 1.5];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// New signals: 1H = 48 hours, 4H = 72 hours. Historical RESOLVED rows stay untouched.
const HORIZON_BY_INTERVAL: Record<'1h' | '4h', number> = { '1h': 48 * HOUR, '4h': 72 * HOUR };
const RESEARCH_VERSION = 'SWING_HUNTER_V1_9_6_EXTENDED_HORIZON';
const round = (n: number) => Number(n.toFixed(6));
const pct = (side: string, entry: number, exit: number) =>
  (side === 'LONG' ? exit - entry : entry - exit) / entry * 100;

function db(env: any) {
  if (!env.SWING_DB?.prepare) throw new Error('MISSING_SWING_DB_BINDING');
  return env.SWING_DB;
}
function safeInt(v: unknown, fallback: number, min: number, max: number) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}
function parsed(v: unknown) {
  if (typeof v !== 'string' || !v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

export async function scanAndLog(
  env: any,
  opts: { offset?: number; limit?: number; interval?: Interval } = {}
) {
  if (!NEW_SIGNALS_ENABLED) {
    return {
      success: true,
      module: 'SWING_HUNTER_V1_9_2_SIGNAL_LOGGER',
      mode: 'FROZEN_SETTLEMENT_ONLY',
      status: 'COLLECTION_FROZEN',
      new_signals_enabled: false,
      settlement_enabled: true,
      trading: false,
      processed: 0,
      inserted: 0,
      duplicates: 0,
      errors: 0,
      results: []
    };
  }
  const d = db(env);
  const interval = opts.interval || '1h';
  if (!['1h', '4h', '1d'].includes(interval)) throw new Error('INVALID_INTERVAL');
  if (interval === '1d') return {
    success: false, module: 'SWING_HUNTER_V1_9_1_SIGNAL_LOGGER',
    mode: 'RESEARCH_ONLY', trading: false,
    error: 'DAILY_PATTERN_DETECTOR_NOT_VERIFIED', inserted: 0
  };
  const offset = safeInt(opts.offset, 0, 0, COINS.length - 1);
  const limit = safeInt(opts.limit, 3, 1, 5);
  const coins = COINS.slice(offset, offset + limit);
  const results: any[] = [];
  let inserted = 0, duplicates = 0, errors = 0;
  for (const coin of coins) {
    try {
      const data = await fetchClosed(coin, interval, 160);
      const candles = data.closed;
      if (!quality(data).ready || candles.length < 65) {
        results.push({ coin, status: 'DATA_NOT_READY' });
        continue;
      }
      const signal = candles.at(-1)!;
      // One closed-bar snapshot for all four research versions.
      // Preserve historical V1 IDs; namespace V2 IDs to avoid D1 collisions.
      const market = structure(candles);
      const hits = [
        ...detectCatalog(candles, market, interval),
        ...PatternCompareV2.detectCatalog(candles, market, interval).map(h => ({
          ...h, id: `V2_${h.id}`, name: `V2 ${h.name}`
        })),
        ...detectClassicalCatalog(candles, market, interval)
      ].filter(h => h.signalBarOpen === signal.t && (h.side === 'LONG' || h.side === 'SHORT'));
      if (!hits.length) {
        results.push({ coin, status: 'NO_PATTERN', bar: new Date(signal.t).toISOString() });
        continue;
      }
      const pending: typeof hits = [];
      for (const h of hits) {
        const exists = await d.prepare(`SELECT id FROM swing_context_signals
          WHERE coin=? AND interval=? AND pattern=? AND side=? AND signal_bar_open=? LIMIT 1`)
          .bind(coin, interval, h.id, h.side, signal.t).first();
        if (exists) duplicates++;
        else pending.push(h);
      }
      if (!pending.length) {
        results.push({ coin, status: 'ALREADY_LOGGED', patterns: hits.length });
        continue;
      }
      const context = await collectContext(coin, interval, signal, env, { [interval]: candles });
      const logged: any[] = [];
      for (const h of pending) {
        const out = await d.prepare(`INSERT OR IGNORE INTO swing_context_signals
          (coin,interval,pattern,side,signal_bar_open,signal_available_at,
           entry_price,reference_price,strength,context_json,status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(coin, interval, h.id, h.side, signal.t, signal.t + STEP[interval],
            signal.c, signal.c, Number(h.strength) || 0, JSON.stringify(context), 'TRACKING').run();
        if ((out.meta?.changes || 0) > 0) {
          inserted++;
          logged.push({ pattern: h.id, side: h.side });
        } else duplicates++;
      }
      const filterKeys = ['btcDirection', 'fearGreed', 'macroEvents', 'multiTimeframe',
        'supportResistance', 'volume', 'indicators', 'liquiditySpread'];
      const filterStatus = Object.fromEntries(filterKeys.map(k => [k, (context as any)[k]?.status || 'UNAVAILABLE']));
      results.push({ coin, status: logged.length ? 'LOGGED' : 'ALREADY_LOGGED',
        patterns: logged, filterStatus });
    } catch (e) {
      errors++;
      results.push({ coin, status: 'ERROR', error: String(e) });
    }
  }
  return { success: errors === 0, module: 'SWING_HUNTER_V1_9_1_SIGNAL_LOGGER',
    mode: 'RESEARCH_ONLY', trading: false, interval, offset,
    processed: coins.length, inserted, duplicates, errors, results };
}

export async function settleSignals(env: any, limit = 12) {
  const d = db(env), now = Date.now(), n = safeInt(limit, 12, 1, 30);
  const rows = await d.prepare(`SELECT id,coin,interval,side,signal_available_at,reference_price
    FROM swing_context_signals
    WHERE status='TRACKING' AND signal_available_at IS NOT NULL
      AND reference_price IS NOT NULL AND signal_available_at<=?
    ORDER BY signal_available_at ASC LIMIT ?`).bind(now, n).all();
  const results: any[] = [];
  let marketRequests = 0, updated = 0;
  // 7 days = 168 closed 1h bars; 240 covers that window with room for delay.
  const cache = new Map<string, Candle[]>();
  for (const x of rows.results || []) {
    try {
      const since = Number(x.signal_available_at), entry = Number(x.reference_price);
      const side = String(x.side), coin = String(x.coin), interval = String(x.interval);
      if (!(entry > 0) || !Number.isFinite(since) || !['LONG','SHORT'].includes(side))
        throw new Error('INVALID_SIGNAL');
      if (interval !== '1h' && interval !== '4h') throw new Error('UNSUPPORTED_INTERVAL');
      const horizon = HORIZON_BY_INTERVAL[interval];
      const horizonHours = horizon / HOUR;
      if (!cache.has(coin)) {
        const fetched = await fetchClosed(coin, '1h', 240);
        marketRequests++;
        cache.set(coin, fetched.closed);
      }
      const all = cache.get(coin)!;
      const cutoff = Math.min(now, since + horizon);
      const bars = all.filter(b => b.t >= since && b.t + HOUR <= cutoff)
        .sort((a,b) => a.t - b.t);
      // Do not assign first-touch results if any earlier hourly candle is missing.
      const contiguous = bars.every((b,i) => b.t === since + i * HOUR);
      const horizonComplete = now >= since + horizon;
      const expectedBars = horizonHours;
      const fullCoverage = horizonComplete && contiguous && bars.length === expectedBars;

      const evaluate = (source: Candle[], complete: boolean) => TPS.flatMap(tp => SLS.map(sl => {
        let status = 'PENDING', touch: number | null = null;
        for (const b of source) {
          const hitTp = side === 'LONG' ? b.h >= entry * (1 + tp / 100) : b.l <= entry * (1 - tp / 100);
          const hitSl = side === 'LONG' ? b.l <= entry * (1 - sl / 100) : b.h >= entry * (1 + sl / 100);
          if (hitTp || hitSl) {
            status = hitTp && hitSl ? 'AMBIGUOUS' : hitTp ? 'TP_FIRST' : 'SL_FIRST';
            touch = b.t;
            break;
          }
        }
        if (status === 'PENDING' && complete) status = 'TIME_EXIT';
        const net = status === 'TP_FIRST' ? tp - 0.18 :
          status === 'SL_FIRST' ? -sl - 0.18 :
          status === 'TIME_EXIT' ? pct(side, entry, source.at(-1)!.c) - 0.18 : null;
        return { tp, sl, status,
          firstTouchBarOpen: touch === null ? null : new Date(touch).toISOString(),
          hypotheticalNetPct: net === null ? null : round(net) };
      }));

      // Snapshot of the original 24-hour research method, for fair comparisons.
      const first24 = bars.filter(b => b.t < since + DAY);
      const snapshot24Complete = now >= since + DAY && contiguous && first24.length === 24;
      const snapshot24 = contiguous ? evaluate(first24, snapshot24Complete) : [];
      const scenarios = contiguous ? evaluate(bars, fullCoverage) : [];
      const done = contiguous && scenarios.length > 0 && scenarios.every(s => s.status !== 'PENDING') &&
        (fullCoverage || scenarios.every(s => s.status !== 'TIME_EXIT'));
      if (done) {
        const outcome = {
          entryBasis: 'SIGNAL_CLOSE_REFERENCE_NOT_EXECUTABLE_ENTRY',
          costPct: 0.18, methodologyVersion: RESEARCH_VERSION,
          horizonHours, windowComplete: fullCoverage,
          legacy24h: { horizonHours: 24, windowComplete: snapshot24Complete, scenarios: snapshot24 },
          scenarios
        };
        const out = await d.prepare(`UPDATE swing_context_signals
          SET status='RESOLVED',outcome_json=?,resolved_at=?
          WHERE id=? AND status='TRACKING'`)
          .bind(JSON.stringify(outcome), now, x.id).run();
        updated += out.meta?.changes || 0;
      }
      results.push({ id: x.id, interval, horizonHours,
        status: done ? 'RESOLVED' : 'TRACKING', observedBars: bars.length,
        expectedBars, contiguous, windowComplete: fullCoverage,
        legacy24hComplete: snapshot24Complete });
    } catch (e) {
      results.push({ id: x.id, status: 'ERROR', error: String(e) });
    }
  }
  return { success: results.every(x => x.status !== 'ERROR'),
    module: RESEARCH_VERSION, trading: false, d1ReadRowsBound: n,
    marketRequests, updated, results };
}

export async function recentSignals(env: any, limit = 20, side?: string) {
  const d = db(env), n = safeInt(limit, 20, 1, 100);
  const rows = side === 'LONG' || side === 'SHORT'
    ? await d.prepare(`SELECT * FROM swing_context_signals
        WHERE side=? ORDER BY signal_bar_open DESC LIMIT ?`).bind(side, n).all()
    : await d.prepare(`SELECT * FROM swing_context_signals
        ORDER BY signal_bar_open DESC LIMIT ?`).bind(n).all();
  return { success: true, module: 'SWING_HUNTER_V1_9_1_LOG', limit: n,
    rows: (rows.results || []).map((r: any) => ({ ...r,
      context: parsed(r.context_json), outcome: parsed(r.outcome_json),
      context_json: undefined, outcome_json: undefined })) };
}
