import type { Candle, Structure } from './types';

/** Research-only pattern catalog. No trading/execution dependencies. */
export type PatternHit = {
  id: string; name: string; side: 'LONG' | 'SHORT'; frame: '1h' | '4h';
  strength: number; confirmed: boolean; details: string; signalBarOpen: number;
};
type Side = 'LONG' | 'SHORT';
type Frame = '1h' | '4h';
const avg = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const highest = (a: Candle[]) => Math.max(...a.map(x => x.h));
const lowest = (a: Candle[]) => Math.min(...a.map(x => x.l));
const clamp = (n: number) => Math.round(Math.max(1, Math.min(100, n)));
const ema = (values: number[], period: number): number[] => {
  if (values.length < period) return [];
  const out: number[] = Array(values.length).fill(NaN);
  let e = avg(values.slice(0, period));
  out[period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) { e = values[i] * k + e * (1 - k); out[i] = e; }
  return out;
};
function pivotLow(c: Candle[], i: number, radius = 2): boolean {
  if (i < radius || i + radius >= c.length) return false;
  for (let j = i - radius; j <= i + radius; j++) if (j !== i && c[j].l <= c[i].l) return false;
  return true;
}
function pivotHigh(c: Candle[], i: number, radius = 2): boolean {
  if (i < radius || i + radius >= c.length) return false;
  for (let j = i - radius; j <= i + radius; j++) if (j !== i && c[j].h >= c[i].h) return false;
  return true;
}
function confirmedDouble(c: Candle[], atr: number, side: Side): { level: number; a: number; b: number } | null {
  // Both pivots must be fully confirmed before the signal candle; no future bars.
  const last = c.length - 1;
  const start = Math.max(3, last - 42);
  const pivots: number[] = [];
  for (let i = start; i <= last - 3; i++) {
    if (side === 'LONG' ? pivotLow(c, i) : pivotHigh(c, i)) pivots.push(i);
  }
  // Prefer most recent qualifying pair; cap age to avoid stale formations.
  for (let bIdx = pivots.length - 1; bIdx >= 1; bIdx--) {
    const b = pivots[bIdx];
    if (last - b > 14 || last - b < 3) continue;
    for (let aIdx = bIdx - 1; aIdx >= 0; aIdx--) {
      const a = pivots[aIdx], gap = b - a;
      if (gap < 5 || gap > 24) continue;
      const va = side === 'LONG' ? c[a].l : c[a].h;
      const vb = side === 'LONG' ? c[b].l : c[b].h;
      if (Math.abs(va - vb) > atr * 0.65) continue;
      const between = c.slice(a + 1, b);
      if (between.length < 3) continue;
      const neckline = side === 'LONG' ? highest(between) : lowest(between);
      const rebound = side === 'LONG' ? neckline - Math.max(va, vb) : Math.min(va, vb) - neckline;
      if (rebound < atr * 1.1) continue;
      // No neckline confirmation before current bar: this is the breakout bar.
      if (c.slice(b + 1, last).some(x => side === 'LONG' ? x.c > neckline : x.c < neckline)) continue;
      const cur = c[last], prev = c[last - 1];
      const crossed = side === 'LONG'
        ? cur.c > neckline && prev.c <= neckline && cur.c > cur.o
        : cur.c < neckline && prev.c >= neckline && cur.c < cur.o;
      if (crossed) return { level: neckline, a, b };
    }
  }
  return null;
}
function compression(c: Candle[], atr: number, side: Side): boolean {
  // Two confirmed swing highs and lows in the PREVIOUS bars, with contraction.
  const last = c.length - 1, from = last - 19, to = last - 3;
  const hs: number[] = [], ls: number[] = [];
  for (let i = from; i <= to; i++) {
    if (pivotHigh(c, i, 2)) hs.push(i);
    if (pivotLow(c, i, 2)) ls.push(i);
  }
  if (hs.length < 2 || ls.length < 2) return false;
  const h1 = c[hs[hs.length - 2]].h, h2 = c[hs[hs.length - 1]].h;
  const l1 = c[ls[ls.length - 2]].l, l2 = c[ls[ls.length - 1]].l;
  const earlierWidth = h1 - l1, laterWidth = h2 - l2;
  if (earlierWidth <= atr || laterWidth <= 0 || laterWidth >= earlierWidth * 0.9) return false;
  if (!(h2 < h1 - atr * 0.1 && l2 > l1 + atr * 0.1)) return false;
  const b = c[last], p = c[last - 1];
  return side === 'LONG'
    ? b.c > h2 && p.c <= h2 && b.c > b.o
    : b.c < l2 && p.c >= l2 && b.c < b.o;
}

/** 20 setup IDs. Uses closed OHLCV bars only, with signal on last bar. */
export function detectCatalog(c: Candle[], s: Structure, frame: Frame): PatternHit[] {
  if (c.length < 65) return [];
  if (!c.every(x => [x.t, x.o, x.h, x.l, x.c, x.v].every(Number.isFinite) &&
      x.h >= Math.max(x.o, x.c, x.l) && x.l <= Math.min(x.o, x.c) && x.v >= 0)) return [];
  const z = c.length - 1, b = c[z], p = c[z - 1], q = c[z - 2];
  const prior = c.slice(z - 20, z), prevPrior = c.slice(z - 21, z - 1);
  const atr = Number(s.atr14);
  if (!Number.isFinite(atr) || atr <= 0 || b.c <= 0) return [];
  const volAvg = avg(prior.map(x => x.v)), vr = volAvg > 0 ? b.v / volAvg : 0;
  const hi = highest(prior), lo = lowest(prior);
  const body = Math.abs(b.c - b.o), height = Math.max(b.h - b.l, 1e-10);
  const upper = b.h - Math.max(b.c, b.o), lower = Math.min(b.c, b.o) - b.l;
  const bull = b.c > b.o, bear = b.c < b.o;
  const out: PatternHit[] = [];
  const add = (ok: boolean, id: string, name: string, side: Side, strength: number, details: string) => {
    if (ok) out.push({ id, name, side, frame, strength: clamp(strength), confirmed: true, details, signalBarOpen: b.t });
  };

  // Breakout: previous 20 bars only, fresh close beyond the level, meaningful body/volume.
  add(bull && b.c > hi && p.c <= hi && body / height >= 0.45 && vr >= 1.2,
    'RANGE_BREAKOUT', '20-bar high breakout', 'LONG', 60 + vr * 10,
    `Closed above prior 20-bar high ${hi}; relative volume ${vr.toFixed(2)}x`);
  add(bear && b.c < lo && p.c >= lo && body / height >= 0.45 && vr >= 1.2,
    'RANGE_BREAKDOWN', '20-bar low breakdown', 'SHORT', 60 + vr * 10,
    `Closed below prior 20-bar low ${lo}; relative volume ${vr.toFixed(2)}x`);

  // Liquidity sweep: prior level pierced and reclaimed on the same closed bar.
  add(b.l < lo - atr * 0.05 && b.c > lo && bull && lower / height >= 0.4,
    'LIQUIDITY_SWEEP_LOW', 'Liquidity sweep below support', 'LONG', 65 + lower / height * 25,
    `Wick below ${lo}, bullish close back above`);
  add(b.h > hi + atr * 0.05 && b.c < hi && bear && upper / height >= 0.4,
    'LIQUIDITY_SWEEP_HIGH', 'Liquidity sweep above resistance', 'SHORT', 65 + upper / height * 25,
    `Wick above ${hi}, bearish close back below`);

  // Strict real-body engulfing; ignore wick-only engulfing and tiny candles.
  add(bull && p.c < p.o && b.o <= p.c && b.c >= p.o && body / height >= 0.55 && body >= Math.abs(p.c - p.o) * 1.05,
    'BULL_ENGULF', 'Bullish engulfing', 'LONG', 67, 'Current bullish body engulfs prior bearish body');
  add(bear && p.c > p.o && b.o >= p.c && b.c <= p.o && body / height >= 0.55 && body >= Math.abs(p.c - p.o) * 1.05,
    'BEAR_ENGULF', 'Bearish engulfing', 'SHORT', 67, 'Current bearish body engulfs prior bullish body');

  // Hammer/star: body location and wick asymmetry; do not require candle color alone.
  add(bull && lower / height >= 0.6 && upper / height <= 0.15 && body / height <= 0.35 &&
      p.c < c[z - 4].c,
    'HAMMER', 'Bullish hammer after pullback', 'LONG', 58, 'Long lower rejection wick after short-term decline');
  add(bear && upper / height >= 0.6 && lower / height <= 0.15 && body / height <= 0.35 &&
      p.c > c[z - 4].c,
    'SHOOTING_STAR', 'Shooting star after advance', 'SHORT', 58, 'Long upper rejection wick after short-term rise');

  // Three-bar reversal: two opposite candles and strong close beyond prior extreme.
  add(bull && p.c < p.o && q.c < q.o && b.c > p.h && body / height >= 0.5 && vr >= 1,
    'MOMENTUM_REVERSAL_LONG', 'Three-bar momentum reversal', 'LONG', 65,
    'Two bearish bars then bullish close above prior high');
  add(bear && p.c > p.o && q.c > q.o && b.c < p.l && body / height >= 0.5 && vr >= 1,
    'MOMENTUM_REVERSAL_SHORT', 'Three-bar momentum reversal', 'SHORT', 65,
    'Two bullish bars then bearish close below prior low');

  // EMA20 at the PREVIOUS bar, not EMA after the current signal bar.
  const e = ema(c.map(x => x.c), 20), emaPrev = e[z - 1], emaPrev2 = e[z - 2];
  const emaValid = Number.isFinite(emaPrev) && Number.isFinite(emaPrev2);
  const prevNear = emaValid && p.l <= emaPrev + atr * 0.35 && p.l >= emaPrev - atr * 0.65;
  const prevNearShort = emaValid && p.h >= emaPrev - atr * 0.35 && p.h <= emaPrev + atr * 0.65;
  add(s.direction === 'LONG' && emaValid && emaPrev >= emaPrev2 &&
      c[z - 3].c > emaPrev2 && prevNear && p.c >= emaPrev - atr * 0.2 &&
      bull && b.c > p.h && b.c > emaPrev && body / height >= 0.4,
    'EMA_PULLBACK_LONG', 'EMA20 pullback continuation', 'LONG', 64,
    `Previous candle retested historical EMA20 ${emaPrev.toFixed(6)}, then bullish continuation`);
  add(s.direction === 'SHORT' && emaValid && emaPrev <= emaPrev2 &&
      c[z - 3].c < emaPrev2 && prevNearShort && p.c <= emaPrev + atr * 0.2 &&
      bear && b.c < p.l && b.c < emaPrev && body / height >= 0.4,
    'EMA_PULLBACK_SHORT', 'EMA20 pullback continuation', 'SHORT', 64,
    `Previous candle retested historical EMA20 ${emaPrev.toFixed(6)}, then bearish continuation`);

  // Retest: prior breakout occurred at least two bars ago. Freeze old level BEFORE breakout.
  const oldHigh = highest(c.slice(z - 22, z - 2));
  const oldLow = lowest(c.slice(z - 22, z - 2));
  const breakoutBar = c[z - 2];
  add(breakoutBar.c > oldHigh && breakoutBar.c > breakoutBar.o &&
      p.l <= oldHigh + atr * 0.2 && p.l >= oldHigh - atr * 0.5 && p.c >= oldHigh &&
      bull && b.c > Math.max(p.h, oldHigh) && vr >= 1,
    'BREAKOUT_RETEST_LONG', 'Breakout and retest', 'LONG', 72,
    `Breakout above frozen ${oldHigh}, retest, then bullish continuation`);
  add(breakoutBar.c < oldLow && breakoutBar.c < breakoutBar.o &&
      p.h >= oldLow - atr * 0.2 && p.h <= oldLow + atr * 0.5 && p.c <= oldLow &&
      bear && b.c < Math.min(p.l, oldLow) && vr >= 1,
    'BREAKOUT_RETEST_SHORT', 'Breakdown and retest', 'SHORT', 72,
    `Breakdown below frozen ${oldLow}, retest, then bearish continuation`);

  // Confirmed W/M with two confirmed pivots and intervening neckline.
  const db = confirmedDouble(c, atr, 'LONG'), dt = confirmedDouble(c, atr, 'SHORT');
  add(!!db && vr >= 1.1, 'DOUBLE_BOTTOM', 'Confirmed double bottom breakout', 'LONG', 70,
    db ? `Pivot lows at bars ${db.a}/${db.b}; neckline ${db.level}` : '');
  add(!!dt && vr >= 1.1, 'DOUBLE_TOP', 'Confirmed double top breakdown', 'SHORT', 70,
    dt ? `Pivot highs at bars ${dt.a}/${dt.b}; neckline ${dt.level}` : '');

  // Symmetric contraction with two confirmed high pivots and two low pivots.
  add(compression(c, atr, 'LONG') && vr >= 1.2,
    'TRIANGLE_UP', 'Compression breakout up', 'LONG', 70,
    'Contracting confirmed swing highs/lows and upside breakout');
  add(compression(c, atr, 'SHORT') && vr >= 1.2,
    'TRIANGLE_DOWN', 'Compression breakout down', 'SHORT', 70,
    'Contracting confirmed swing highs/lows and downside breakout');

  // Distinct volume-led breakout tag; overlap with RANGE_BREAKOUT is intentional.
  const atrPct = atr / b.c;
  add(s.direction === 'LONG' && bull && b.c > hi && p.c <= hi &&
      vr >= 1.8 && body / height >= 0.55 && atrPct < 0.08,
    'VOLUME_EXPANSION_LONG', 'Volume expansion breakout', 'LONG', 65 + vr * 8,
    `Breakout with ${vr.toFixed(2)}x volume and strong bullish body`);
  add(s.direction === 'SHORT' && bear && b.c < lo && p.c >= lo &&
      vr >= 1.8 && body / height >= 0.55 && atrPct < 0.08,
    'VOLUME_EXPANSION_SHORT', 'Volume expansion breakdown', 'SHORT', 65 + vr * 8,
    `Breakdown with ${vr.toFixed(2)}x volume and strong bearish body`);
  return out;
}
export const CATALOG_IDS = [
  'RANGE_BREAKOUT', 'RANGE_BREAKDOWN', 'LIQUIDITY_SWEEP_LOW', 'LIQUIDITY_SWEEP_HIGH',
  'BULL_ENGULF', 'BEAR_ENGULF', 'HAMMER', 'SHOOTING_STAR',
  'MOMENTUM_REVERSAL_LONG', 'MOMENTUM_REVERSAL_SHORT',
  'EMA_PULLBACK_LONG', 'EMA_PULLBACK_SHORT', 'BREAKOUT_RETEST_LONG', 'BREAKOUT_RETEST_SHORT',
  'DOUBLE_BOTTOM', 'DOUBLE_TOP', 'TRIANGLE_UP', 'TRIANGLE_DOWN',
  'VOLUME_EXPANSION_LONG', 'VOLUME_EXPANSION_SHORT'
];
