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

/** V3/V4 classical geometry research. Existing V1 detectCatalog is unchanged.
 * V4 is a strict subset of V3 on the same signal bar. Closed candles only.
 * Call detectClassicalCatalog separately from detectCatalog; logging integration is separate.
 */
export const CLASSICAL_PATTERN_IDS = [
  'HEAD_SHOULDERS', 'INVERSE_HEAD_SHOULDERS', 'BULL_FLAG', 'BEAR_FLAG',
  'RISING_WEDGE', 'FALLING_WEDGE', 'CUP_HANDLE', 'INVERSE_CUP_HANDLE',
  'TRIPLE_TOP', 'TRIPLE_BOTTOM'
] as const;
export const CLASSICAL_VERSION_IDS = [
  ...CLASSICAL_PATTERN_IDS.map(id => `V3_${id}`),
  ...CLASSICAL_PATTERN_IDS.map(id => `V4_${id}`)
];

type ClassicCandidate = { id: typeof CLASSICAL_PATTERN_IDS[number]; name: string; side: Side;
  level: number; amplitude: number; span: number; symmetry: number; quality: number;
  context: boolean; volumeRatio: number; breakoutMargin: number; details: string };
const mean = (a: number[]) => avg(a);
const relDiff = (a: number, b: number, floor: number) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), floor);
function classicPivots(c: Candle[], kind: 'high' | 'low', from: number, to: number) {
  const out: number[] = [];
  for (let i = Math.max(2, from); i <= Math.min(c.length - 4, to); i++) {
    if (kind === 'high' ? pivotHigh(c, i) : pivotLow(c, i)) out.push(i);
  }
  return out;
}
function classicLine(a: number, b: number, at: number, start: number, end: number) {
  return a + (b - a) * (at - start) / Math.max(1, end - start);
}
/** The same ten setups are emitted as V3 and (when stricter tests pass) V4. */
export function detectClassicalCatalog(c: Candle[], s: Structure, frame: Frame): PatternHit[] {
  if (c.length < 65 || !c.every(x => [x.t,x.o,x.h,x.l,x.c,x.v].every(Number.isFinite) &&
    x.h >= Math.max(x.o,x.c,x.l) && x.l <= Math.min(x.o,x.c) && x.v >= 0)) return [];
  const z = c.length - 1, b = c[z], p = c[z - 1];
  const atr = Number(s.atr14);
  if (!(atr > 0) || !(b.c > 0)) return [];
  const prev = c.slice(z - 20,z), vol = mean(prev.map(x => x.v));
  const vr = vol > 0 ? b.v / vol : 0;
  const candidates: ClassicCandidate[] = [];
  const hi = classicPivots(c,'high',z-58,z-3), lo = classicPivots(c,'low',z-58,z-3);
  const body = Math.abs(b.c-b.o)/Math.max(1e-12,b.h-b.l);
  const add = (id: ClassicCandidate['id'], name: string, side: Side, level: number,
    amplitude: number, span: number, symmetry: number, context: boolean, details: string) => {
    const crossed = side === 'LONG' ? b.c > level && p.c <= level && b.c > b.o
      : b.c < level && p.c >= level && b.c < b.o;
    if (!crossed || !(amplitude >= atr * 0.8) || span < 7 || span > 58) return;
    const margin = Math.abs(b.c-level)/atr;
    const quality = Math.min(1,amplitude/(3*atr)) * 0.4 + Math.max(0,1-symmetry)*0.3 + Math.min(1,margin)*0.3;
    candidates.push({id,name,side,level,amplitude,span,symmetry,quality,context,
      volumeRatio:vr,breakoutMargin:margin,details});
  };
  // Head and shoulders: three alternating confirmed highs/lows; shoulders comparable, head dominant.
  for (const inverse of [false,true]) {
    const piv = inverse ? lo : hi;
    for (let j=piv.length-1;j>=2;j--) {
      const [a,h,d] = piv.slice(j-2,j+1);
      if (d-a < 10 || d-a > 50 || z-d > 12 || h-a < 3 || d-h < 3) continue;
      const va = inverse ? c[a].l : c[a].h, vh = inverse ? c[h].l : c[h].h, vd = inverse ? c[d].l : c[d].h;
      const shoulderDiff = Math.abs(va-vd);
      if (shoulderDiff > atr * 1.3 || (inverse ? Math.min(va,vd)-vh : vh-Math.max(va,vd)) < atr*1.2) continue;
      const neck1 = inverse ? highest(c.slice(a+1,h)) : lowest(c.slice(a+1,h));
      const neck2 = inverse ? highest(c.slice(h+1,d)) : lowest(c.slice(h+1,d));
      const level = classicLine(neck1,neck2,z,Math.floor((a+h)/2),Math.floor((h+d)/2));
      const amp = inverse ? Math.min(neck1,neck2)-vh : vh-Math.max(neck1,neck2);
      const sym = Math.max(shoulderDiff/Math.max(atr*3,Math.abs(vh-va)),Math.abs((h-a)-(d-h))/(d-a));
      add(inverse?'INVERSE_HEAD_SHOULDERS':'HEAD_SHOULDERS',
        inverse?'Inverse Head & Shoulders':'Head & Shoulders',inverse?'LONG':'SHORT',level,
        amp,d-a,sym, inverse ? c[a].c < c[Math.max(0,a-10)].c : c[a].c > c[Math.max(0,a-10)].c,
        `Confirmed shoulders ${a}/${d}, head ${h}, neckline ${level.toFixed(6)}`);
      break;
    }
  }
  // Triple tops/bottoms: three confirmed comparable extrema, separated by meaningful counter-swings.
  for (const bottom of [false,true]) {
    const piv = bottom ? lo : hi;
    for(let j=piv.length-1;j>=2;j--) {
      const [a,m,d]=piv.slice(j-2,j+1);
      if(m-a<4 || d-m<4 || d-a>48 || z-d>12) continue;
      const vals=[a,m,d].map(i=>bottom?c[i].l:c[i].h);
      const spread=Math.max(...vals)-Math.min(...vals);
      if(spread>atr*0.9) continue;
      const neck1=bottom?highest(c.slice(a+1,m)):lowest(c.slice(a+1,m));
      const neck2=bottom?highest(c.slice(m+1,d)):lowest(c.slice(m+1,d));
      const level=bottom?Math.max(neck1,neck2):Math.min(neck1,neck2);
      const amp=bottom?Math.min(neck1,neck2)-Math.max(...vals):Math.min(...vals)-Math.max(neck1,neck2);
      add(bottom?'TRIPLE_BOTTOM':'TRIPLE_TOP',bottom?'Triple Bottom':'Triple Top',bottom?'LONG':'SHORT',
        level,amp,d-a,spread/Math.max(atr*3,amp),true,
        `Three confirmed pivots ${a}/${m}/${d}, neckline ${level.toFixed(6)}`);
      break;
    }
  }
  // Flags: strong impulse followed by a compact counter-trend channel; signal breaks flag boundary.
  for(const bull of [true,false]) {
    for(let n=7;n<=16;n++) {
      const flag=c.slice(z-n,z), pole=c.slice(z-n-8,z-n);
      if(pole.length!==8) continue;
      const move=pole[7].c-pole[0].o;
      if((bull?move:-move)<atr*2.5) continue;
      const highs=flag.map(x=>x.h), lows=flag.map(x=>x.l);
      const firstH=mean(highs.slice(0,3)),lastH=mean(highs.slice(-3));
      const firstL=mean(lows.slice(0,3)),lastL=mean(lows.slice(-3));
      const slopeH=(lastH-firstH)/Math.max(1,n-3),slopeL=(lastL-firstL)/Math.max(1,n-3);
      if(bull ? !(slopeH<=atr*0.04 && slopeL<=atr*0.04) : !(slopeH>=-atr*0.04 && slopeL>=-atr*0.04)) continue;
      if(Math.abs(slopeH-slopeL)>atr*0.13) continue;
      const flagRange=highest(flag)-lowest(flag);
      if(flagRange>Math.abs(move)*0.65 || flagRange<atr*0.5) continue;
      const level=bull?highest(flag):lowest(flag);
      add(bull?'BULL_FLAG':'BEAR_FLAG',bull?'Bull Flag':'Bear Flag',bull?'LONG':'SHORT',
        level,Math.abs(move),n+8,Math.min(1,Math.abs(slopeH-slopeL)/atr),true,
        `Impulse ${move.toFixed(6)}, ${n}-bar counter-trend flag`);
      break;
    }
  }
  // Wedges: two confirmed upper and lower touch points, both boundaries slope in the
  // same direction and converge. A breakout is required on the final closed bar.
  for(const rising of [true,false]) {
    for(let ih=hi.length-1;ih>=1;ih--) {
      const h1=hi[ih-1],h2=hi[ih];
      if(h2-h1<5 || h2-h1>35 || z-h2>15) continue;
      for(let il=lo.length-1;il>=1;il--) {
        const l1=lo[il-1],l2=lo[il];
        if(l2-l1<5 || l2-l1>35 || z-l2>15) continue;
        const span=Math.max(h2,l2)-Math.min(h1,l1);
        if(span<9 || span>42) continue;
        const hs=(c[h2].h-c[h1].h)/(h2-h1),ls=(c[l2].l-c[l1].l)/(l2-l1);
        if(rising ? !(hs>0 && ls>hs+atr*0.015) : !(ls<0 && hs<ls-atr*0.015)) continue;
        const start=Math.max(h1,l1),end=Math.min(h2,l2);
        if(end<=start) continue;
        const oldWidth=classicLine(c[h1].h,c[h2].h,start,h1,h2)-classicLine(c[l1].l,c[l2].l,start,l1,l2);
        const newWidth=classicLine(c[h1].h,c[h2].h,z,h1,h2)-classicLine(c[l1].l,c[l2].l,z,l1,l2);
        if(oldWidth<=atr || newWidth<=atr*0.15 || newWidth>=oldWidth*0.85) continue;
        const level=rising?classicLine(c[l1].l,c[l2].l,z,l1,l2):classicLine(c[h1].h,c[h2].h,z,h1,h2);
        add(rising?'RISING_WEDGE':'FALLING_WEDGE',rising?'Rising Wedge':'Falling Wedge',
          rising?'SHORT':'LONG',level,oldWidth,span,Math.min(1,newWidth/oldWidth),true,
          `Converging slopes upper=${hs.toFixed(6)}, lower=${ls.toFixed(6)}`);
        break;
      }
      break;
    }
  }
  // Cup and handle: rounded multi-bar basin (or dome), rim near equal on both sides,
  // followed by a shallow handle. The last bar must cross the earlier rim.
  for(const inverted of [false,true]) {
    for(let len=24;len<=50;len+=2) {
      const handleLen=6, cup=c.slice(z-len-handleLen,z-handleLen), handle=c.slice(z-handleLen,z);
      if(cup.length!==len || handle.length!==handleLen) continue;
      const rimA=mean(cup.slice(0,4).map(x=>x.c));
      const rimB=mean(cup.slice(-4).map(x=>x.c));
      const center=cup.slice(Math.floor(len*0.3),Math.ceil(len*0.7));
      const bottom=inverted?highest(center):lowest(center);
      const depth=inverted?bottom-Math.max(rimA,rimB):Math.min(rimA,rimB)-bottom;
      if(depth<atr*1.5 || Math.abs(rimA-rimB)>depth*0.3) continue;
      const thirds=[cup.slice(0,Math.floor(len/3)),center,cup.slice(Math.ceil(len*2/3))];
      const edges=inverted ? [highest(thirds[0]),highest(thirds[2])] : [lowest(thirds[0]),lowest(thirds[2])];
      if(inverted ? !(bottom>=Math.max(...edges)-atr*0.25) : !(bottom<=Math.min(...edges)+atr*0.25)) continue;
      const handlePull=inverted?highest(handle)-rimB:rimB-lowest(handle);
      if(handlePull<0 || handlePull>depth*0.55) continue;
      const level=inverted?Math.min(rimA,rimB):Math.max(rimA,rimB);
      add(inverted?'INVERSE_CUP_HANDLE':'CUP_HANDLE',inverted?'Inverse Cup & Handle':'Cup & Handle',
        inverted?'SHORT':'LONG',level,depth,len+handleLen,
        Math.abs(rimA-rimB)/depth, true,`Rounded ${len}-bar cup, ${handleLen}-bar handle`);
      break;
    }
  }
  const out: PatternHit[]=[];
  const seen=new Set<string>();
  for(const x of candidates) {
    if(seen.has(x.id)) continue;
    seen.add(x.id);
    out.push({id:`V3_${x.id}`,name:`V3 ${x.name}`,side:x.side,frame,
      strength:clamp(55+x.quality*30),confirmed:true,details:x.details,signalBarOpen:b.t});
    // Strict V4: must first pass V3; additionally require geometry, prior trend,
    // breakout distance, strong candle body and increased signal-bar volume.
    if(x.symmetry<=0.25 && x.context && x.breakoutMargin>=0.20 &&
      x.volumeRatio>=1.25 && body>=0.55 && x.amplitude>=atr*1.5) {
      out.push({id:`V4_${x.id}`,name:`V4 ${x.name}`,side:x.side,frame,
        strength:clamp(70+x.quality*25),confirmed:true,
        details:`STRICT: ${x.details}; vol=${x.volumeRatio.toFixed(2)}x; margin=${x.breakoutMargin.toFixed(2)} ATR`,
        signalBarOpen:b.t});
    }
  }
  return out;
}

// Original V2 comparison implementation, relocated without changing its criteria.
export namespace PatternCompareV2 {
 type Candle = import('./types').Candle;
 type Structure = import('./types').Structure;


/** Pattern Catalog V2: strict closed-bar, geometry-aware, research-only detectors.
 * Drop-in replacement for pattern-catalog.ts. Does not execute trades or write D1.
 * Each pattern is a deterministic definition, not a guarantee of future price movement.
 */
type PatternHit = {
  id: string; name: string; side: 'LONG' | 'SHORT'; frame: '1h' | '4h';
  strength: number; confirmed: boolean; details: string; signalBarOpen: number;
};
type Side = 'LONG' | 'SHORT';
type Frame = '1h' | '4h';
type Pivot = {i:number; px:number};
const mean=(a:number[])=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const hi=(a:Candle[])=>Math.max(...a.map(x=>x.h));
const lo=(a:Candle[])=>Math.min(...a.map(x=>x.l));
const clamp=(n:number)=>Math.max(1,Math.min(100,Math.round(n)));
const body=(x:Candle)=>Math.abs(x.c-x.o);
const span=(x:Candle)=>Math.max(x.h-x.l,1e-12);
const bull=(x:Candle)=>x.c>x.o;
const bear=(x:Candle)=>x.c<x.o;
const upper=(x:Candle)=>x.h-Math.max(x.o,x.c);
const lower=(x:Candle)=>Math.min(x.o,x.c)-x.l;
const avgVolume=(c:Candle[])=>mean(c.map(x=>x.v));
function ema(v:number[],period:number):number[]{
 const a=Array(v.length).fill(NaN);if(v.length<period)return a;
 let e=mean(v.slice(0,period));a[period-1]=e;
 const k=2/(period+1);for(let i=period;i<v.length;i++){e=v[i]*k+e*(1-k);a[i]=e;}return a;
}
function pivot(c:Candle[],i:number,kind:'H'|'L',r=2):boolean{
 if(i<r||i+r>=c.length)return false;
 const px=kind==='H'?c[i].h:c[i].l;
 for(let j=i-r;j<=i+r;j++)if(j!==i&&(kind==='H'?c[j].h>=px:c[j].l<=px))return false;
 return true;
}
function pivots(c:Candle[],from:number,to:number,kind:'H'|'L',r=2):Pivot[]{
 const a:Pivot[]=[];for(let i=Math.max(r,from);i<=Math.min(c.length-r-1,to);i++)
  if(pivot(c,i,kind,r))a.push({i,px:kind==='H'?c[i].h:c[i].l});return a;
}
function line(a:Pivot,b:Pivot,i:number){return a.px+(b.px-a.px)*(i-a.i)/(b.i-a.i);}
function slopeTrend(c:Candle[],side:Side,atr:number):boolean{
 // Require actual multi-bar price progression, not just two opposite-colored bars.
 const z=c.length-1, old=c.slice(z-12,z-6),recent=c.slice(z-6,z);
 return side==='LONG'?mean(old.map(x=>x.c))-mean(recent.map(x=>x.c))>=0.35*atr
  :mean(recent.map(x=>x.c))-mean(old.map(x=>x.c))>=0.35*atr;
}
function confirmedDouble(c:Candle[],atr:number,side:Side){
 const z=c.length-1,kind=side==='LONG'?'L':'H';
 const ps=pivots(c,z-45,z-3,kind);
 for(let j=ps.length-1;j>0;j--){const b=ps[j];if(z-b.i<3||z-b.i>14)continue;
  for(let k=j-1;k>=0;k--){const a=ps[k],gap=b.i-a.i;if(gap<5||gap>24)continue;
   if(Math.abs(a.px-b.px)>atr*0.45)continue;
   const between=c.slice(a.i+1,b.i),neck=side==='LONG'?hi(between):lo(between);
   const depth=side==='LONG'?neck-Math.max(a.px,b.px):Math.min(a.px,b.px)-neck;
   if(depth<1.5*atr||depth>10*atr)continue;
   // The two extrema must have been formed after a meaningful preceding move.
   const before=c.slice(Math.max(0,a.i-12),a.i);
   if(before.length<6)continue;
   const preceding=side==='LONG'?hi(before)-a.px:a.px-lo(before);
   if(preceding<1.2*atr)continue;
   const cur=c[z],prev=c[z-1],pad=0.08*atr;
   if(c.slice(b.i+1,z).some(x=>side==='LONG'?x.c>neck+pad:x.c<neck-pad))continue;
   const crossed=side==='LONG'?bull(cur)&&cur.c>neck+pad&&prev.c<=neck+pad
    :bear(cur)&&cur.c<neck-pad&&prev.c>=neck-pad;
   if(!crossed||body(cur)/span(cur)<0.4)continue;
   // Reject an oversized breakout candle where entry is already far beyond the neckline.
   if(Math.abs(cur.c-neck)>2.5*atr)continue;
   return {a:a.i,b:b.i,neck,depth};
  }
 }return null;
}
function triangle(c:Candle[],atr:number,side:Side){
 const z=c.length-1,hs=pivots(c,z-28,z-3,'H'),ls=pivots(c,z-28,z-3,'L');
 if(hs.length<2||ls.length<2)return null;
 // Try recent pairs, but require both trendlines to be supported by intervening candles.
 for(let h=hs.length-1;h>=1;h--)for(let l=ls.length-1;l>=1;l--){
  const h1=hs[h-1],h2=hs[h],l1=ls[l-1],l2=ls[l];
  const start=Math.max(h1.i,l1.i),end=Math.min(h2.i,l2.i);
  if(end-start<5||Math.abs(h2.i-l2.i)>10)continue;
  const upperSlope=(h2.px-h1.px)/(h2.i-h1.i),lowerSlope=(l2.px-l1.px)/(l2.i-l1.i);
  if(!(upperSlope<-0.015*atr&&lowerSlope>0.015*atr))continue;
  const widthStart=line(h1,h2,start)-line(l1,l2,start);
  const widthNow=line(h1,h2,z)-line(l1,l2,z);
  if(widthStart<1.3*atr||widthNow<=0.2*atr||widthNow>=0.85*widthStart)continue;
  const apex=(l1.px-h1.px+upperSlope*h1.i-lowerSlope*l1.i)/(upperSlope-lowerSlope);
  if(!Number.isFinite(apex)||apex<z-2||apex>z+35)continue;
  const first=Math.min(h1.i,l1.i),last=Math.max(h2.i,l2.i);
  let breaches=0;for(let i=first+2;i<last;i++){
   const top=line(h1,h2,i),bottom=line(l1,l2,i);
   if(c[i].c>top+0.2*atr||c[i].c<bottom-0.2*atr)breaches++;
  }if(breaches>1)continue;
  const current=c[z],previous=c[z-1];
  const boundary=line(side==='LONG'?h1:l1,side==='LONG'?h2:l2,z);
  const prevBoundary=line(side==='LONG'?h1:l1,side==='LONG'?h2:l2,z-1);
  const crossed=side==='LONG'?bull(current)&&current.c>boundary+0.1*atr&&previous.c<=prevBoundary+0.1*atr
   :bear(current)&&current.c<boundary-0.1*atr&&previous.c>=prevBoundary-0.1*atr;
  if(!crossed||body(current)/span(current)<0.5||Math.abs(current.c-boundary)>2.5*atr)continue;
  return {h1:h1.i,h2:h2.i,l1:l1.i,l2:l2.i,boundary,apex};
 }return null;
}
export function detectCatalog(c:Candle[],s:Structure,frame:Frame):PatternHit[]{
 if(c.length<65||!s||!Number.isFinite(s.atr14)||s.atr14<=0)return [];
 if(!c.every(x=>[x.t,x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)&&x.o>0&&x.c>0&&x.h>=Math.max(x.o,x.c,x.l)&&x.l<=Math.min(x.o,x.c)&&x.v>=0))return [];
 for(let i=1;i<c.length;i++)if(c[i].t<=c[i-1].t)return [];
 const z=c.length-1,b=c[z],p=c[z-1],q=c[z-2],atr=s.atr14;
 const prior=c.slice(z-20,z),previous=c.slice(z-21,z-1);
 const high=hi(prior),low=lo(prior),vr=avgVolume(prior)>0?b.v/avgVolume(prior):0;
 const goodBull=bull(b)&&body(b)/span(b)>=0.45,goodBear=bear(b)&&body(b)/span(b)>=0.45;
 const closeLocationBull=(b.c-b.l)/span(b),closeLocationBear=(b.h-b.c)/span(b);
 const out:(PatternHit & {geometry?:any})[]=[];
 let geom:any=null;
 const pt=(i:number,price:number,label:string)=>({i,price,label});
 const seg=(a:any,b:any,label:string)=>({a,b,label});
 const add=(ok:boolean,id:string,name:string,side:Side,strength:number,details:string)=>{
  if(ok)out.push({id,name,side,frame,strength:clamp(strength),confirmed:true,details,signalBarOpen:b.t});
 };
 // 1-2: Real break of a frozen 20-bar extreme, meaningful range, participation and follow-through close.
 add(goodBull&&b.c>high+0.1*atr&&p.c<=high&&vr>=1.35&&closeLocationBull>=0.75&&
     b.c-high<=2.5*atr,'RANGE_BREAKOUT','20-bar range breakout','LONG',60+8*vr,
     `Break above ${high}; buffer 0.10 ATR; volume ${vr.toFixed(2)}x`);
 add(goodBear&&b.c<low-0.1*atr&&p.c>=low&&vr>=1.35&&closeLocationBear>=0.75&&
     low-b.c<=2.5*atr,'RANGE_BREAKDOWN','20-bar range breakdown','SHORT',60+8*vr,
     `Break below ${low}; buffer 0.10 ATR; volume ${vr.toFixed(2)}x`);
 // 3-4: Genuine level sweep and rejection; close well back inside the old range.
 add(b.l<low-0.12*atr&&b.c>low+0.12*atr&&bull(b)&&lower(b)/span(b)>=0.5&&
     closeLocationBull>=0.7&&body(b)>=0.12*atr,'LIQUIDITY_SWEEP_LOW','Support liquidity sweep','LONG',67+20*lower(b)/span(b),
     `Pierced ${low}, rejected and closed back inside range`);
 add(b.h>high+0.12*atr&&b.c<high-0.12*atr&&bear(b)&&upper(b)/span(b)>=0.5&&
     closeLocationBear>=0.7&&body(b)>=0.12*atr,'LIQUIDITY_SWEEP_HIGH','Resistance liquidity sweep','SHORT',67+20*upper(b)/span(b),
     `Pierced ${high}, rejected and closed back inside range`);
 // 5-6: Strict engulfing + prior directional move + substantial candle + close location.
 add(goodBull&&bear(p)&&b.o<=p.c&&b.c>=p.o&&body(b)>=1.1*body(p)&&
     body(p)>=0.12*atr&&body(b)>=0.4*atr&&closeLocationBull>=0.75&&
     slopeTrend(c,'LONG',atr),'BULL_ENGULF','Bullish engulfing after decline','LONG',68,
     'Body engulfs prior bearish body after multi-bar decline');
 add(goodBear&&bull(p)&&b.o>=p.c&&b.c<=p.o&&body(b)>=1.1*body(p)&&
     body(p)>=0.12*atr&&body(b)>=0.4*atr&&closeLocationBear>=0.75&&
     slopeTrend(c,'SHORT',atr),'BEAR_ENGULF','Bearish engulfing after advance','SHORT',68,
     'Body engulfs prior bullish body after multi-bar advance');
 // 7-8: Wick rejection at a local extreme following a genuine move, not arbitrary small bars.
 const oldLow=lo(c.slice(z-10,z)),oldHigh=hi(c.slice(z-10,z));
 add(lower(b)/span(b)>=0.6&&upper(b)/span(b)<=0.12&&body(b)/span(b)<=0.3&&
     span(b)>=0.7*atr&&b.l<=oldLow+0.15*atr&&closeLocationBull>=0.72&&
     slopeTrend(c,'LONG',atr),'HAMMER','Hammer after decline','LONG',60,
     'Lower rejection at local low after measured decline');
 add(upper(b)/span(b)>=0.6&&lower(b)/span(b)<=0.12&&body(b)/span(b)<=0.3&&
     span(b)>=0.7*atr&&b.h>=oldHigh-0.15*atr&&closeLocationBear>=0.72&&
     slopeTrend(c,'SHORT',atr),'SHOOTING_STAR','Shooting star after advance','SHORT',60,
     'Upper rejection at local high after measured advance');
 // 9-10: Two prior directional bars, a meaningful reversal close and actual earlier trend.
 add(goodBull&&bear(p)&&bear(q)&&b.c>Math.max(p.h,q.h)+0.05*atr&&
     body(b)>=0.6*atr&&vr>=1.15&&slopeTrend(c,'LONG',atr),
     'MOMENTUM_REVERSAL_LONG','Momentum reversal after decline','LONG',67,
     'Bullish close above two prior highs after established decline');
 add(goodBear&&bull(p)&&bull(q)&&b.c<Math.min(p.l,q.l)-0.05*atr&&
     body(b)>=0.6*atr&&vr>=1.15&&slopeTrend(c,'SHORT',atr),
     'MOMENTUM_REVERSAL_SHORT','Momentum reversal after advance','SHORT',67,
     'Bearish close below two prior lows after established advance');
 // 11-12: Pullback into historical EMA20, confirmed trend slope and continuation.
 const e=ema(c.map(x=>x.c),20),ePrev=e[z-1],eOld=e[z-5];
 const emaReady=Number.isFinite(ePrev)&&Number.isFinite(eOld);
 add(emaReady&&s.direction==='LONG'&&ePrev>eOld+0.15*atr&&
     p.l<=ePrev+0.25*atr&&p.l>=ePrev-0.65*atr&&p.c>=ePrev-0.15*atr&&
     goodBull&&b.c>p.h+0.05*atr&&b.c>ePrev&&vr>=1.05,
     'EMA_PULLBACK_LONG','EMA20 trend pullback','LONG',67,
     `Prior EMA20 ${ePrev}; upward EMA slope and confirmed continuation`);
 add(emaReady&&s.direction==='SHORT'&&ePrev<eOld-0.15*atr&&
     p.h>=ePrev-0.25*atr&&p.h<=ePrev+0.65*atr&&p.c<=ePrev+0.15*atr&&
     goodBear&&b.c<p.l-0.05*atr&&b.c<ePrev&&vr>=1.05,
     'EMA_PULLBACK_SHORT','EMA20 trend pullback','SHORT',67,
     `Prior EMA20 ${ePrev}; downward EMA slope and confirmed continuation`);
 // 13-14: Breakout on z-2, controlled retest on z-1, follow-through on z.
 const breakout=c[z-2],frozenHigh=hi(c.slice(z-22,z-2)),frozenLow=lo(c.slice(z-22,z-2));
 add(bull(breakout)&&breakout.c>frozenHigh+0.1*atr&&body(breakout)>=0.45*atr&&
     p.l<=frozenHigh+0.15*atr&&p.l>=frozenHigh-0.35*atr&&p.c>=frozenHigh&&
     goodBull&&b.c>p.h+0.05*atr&&vr>=1.1,
     'BREAKOUT_RETEST_LONG','Breakout retest continuation','LONG',75,
     `Break ${frozenHigh}; hold retest; bullish follow-through`);
 add(bear(breakout)&&breakout.c<frozenLow-0.1*atr&&body(breakout)>=0.45*atr&&
     p.h>=frozenLow-0.15*atr&&p.h<=frozenLow+0.35*atr&&p.c<=frozenLow&&
     goodBear&&b.c<p.l-0.05*atr&&vr>=1.1,
     'BREAKOUT_RETEST_SHORT','Breakdown retest continuation','SHORT',75,
     `Break ${frozenLow}; hold retest; bearish follow-through`);
 // 15-16: Two distinct pivot extrema, intervening neckline and decisive neckline cross.
 const db=confirmedDouble(c,atr,'LONG'),dt=confirmedDouble(c,atr,'SHORT');
 add(!!db&&vr>=1.15,'DOUBLE_BOTTOM','Confirmed W-bottom neckline break','LONG',76,
     db?`Lows ${db.a}/${db.b}; neckline ${db.neck}; depth ${db.depth.toFixed(6)}`:'');
 add(!!dt&&vr>=1.15,'DOUBLE_TOP','Confirmed M-top neckline break','SHORT',76,
     dt?`Highs ${dt.a}/${dt.b}; neckline ${dt.neck}; depth ${dt.depth.toFixed(6)}`:'');
 // 17-18: Geometric symmetric triangle, projected boundary breakout and valid apex.
 const up=triangle(c,atr,'LONG'),down=triangle(c,atr,'SHORT');
 add(!!up&&vr>=1.3,'TRIANGLE_UP','Symmetric triangle upside breakout','LONG',76,
     up?`Upper trendline ${up.h1}/${up.h2}; lower ${up.l1}/${up.l2}; boundary ${up.boundary}`:'');
 add(!!down&&vr>=1.3,'TRIANGLE_DOWN','Symmetric triangle downside breakout','SHORT',76,
     down?`Upper trendline ${down.h1}/${down.h2}; lower ${down.l1}/${down.l2}; boundary ${down.boundary}`:'');
 // 19-20: A distinct high-participation, high-body breakout variant.
 add(s.direction==='LONG'&&goodBull&&b.c>high+0.12*atr&&p.c<=high&&
     vr>=2&&body(b)/span(b)>=0.65&&closeLocationBull>=0.85&&b.c-high<=2.5*atr,
     'VOLUME_EXPANSION_LONG','High-volume upside expansion','LONG',68+7*vr,
     `High-volume ${vr.toFixed(2)}x breakout above ${high}`);
 add(s.direction==='SHORT'&&goodBear&&b.c<low-0.12*atr&&p.c>=low&&
     vr>=2&&body(b)/span(b)>=0.65&&closeLocationBear>=0.85&&low-b.c<=2.5*atr,
     'VOLUME_EXPANSION_SHORT','High-volume downside expansion','SHORT',68+7*vr,
     `High-volume ${vr.toFixed(2)}x breakdown below ${low}`);
 return out;
}

// Explanations are calculated from the SAME closed candle prefix as the detector.
// TRIANGLE_UP/DOWN replays V2's actual rejection gates in order.
export function explainDecision(c:Candle[],s:Structure,id:string,hit:PatternHit|null):{summary:string;checks:{ok:boolean;label:string;value?:string}[]} {
 const z=c.length-1,b=c[z],p=c[z-1],atr=s.atr14;
 const prior=c.slice(z-20,z),vr=avgVolume(prior)>0?b.v/avgVolume(prior):0;
 const checks:{ok:boolean;label:string;value?:string}[]=[];
 const check=(ok:boolean,label:string,value?:string)=>{checks.push({ok,label,value});return ok;};
 if(!Number.isFinite(atr)||atr<=0||c.length<65)return {summary:'Недостатъчно валидни данни за оценка.',checks:[]};
 if(id==='TRIANGLE_DOWN'||id==='TRIANGLE_UP'){
  const side:Side=id==='TRIANGLE_DOWN'?'SHORT':'LONG';
  const hs=pivots(c,z-28,z-3,'H'),ls=pivots(c,z-28,z-3,'L');
  if(!check(hs.length>=2&&ls.length>=2,'Поне два потвърдени локални върха и две дъна',`върхове ${hs.length}, дъна ${ls.length}`))
   return {summary:'V2 отхвърля: няма достатъчно потвърдени pivot върхове/дъна за две трендлинии.',checks};
  // V2 tests every eligible recent pair. Show the best-progressing pair and its exact first failing gate.
  let best:{passed:number;checks:typeof checks;reason:string}|null=null;
  for(let h=hs.length-1;h>=1;h--)for(let l=ls.length-1;l>=1;l--){
   const local:typeof checks=[];
   const gate=(ok:boolean,label:string,value?:string)=>{local.push({ok,label,value});return ok;};
   const h1=hs[h-1],h2=hs[h],l1=ls[l-1],l2=ls[l];
   const start=Math.max(h1.i,l1.i),end=Math.min(h2.i,l2.i);
   let reason='';
   if(!gate(end-start>=5&&Math.abs(h2.i-l2.i)<=10,'Достатъчно припокриване на линиите (≥5 свещи) и близки последни pivots',`overlap=${end-start}, gap=${Math.abs(h2.i-l2.i)}`))reason='Невалидна геометрия/разположение на pivot точките.';
   const us=(h2.px-h1.px)/(h2.i-h1.i),lslope=(l2.px-l1.px)/(l2.i-l1.i);
   if(!reason&&!gate(us<-0.015*atr&&lslope>0.015*atr,'Понижаващи се върхове И повишаващи се дъна',`upper=${(us/atr).toFixed(3)} ATR/bar, lower=${(lslope/atr).toFixed(3)} ATR/bar`))reason='Линиите не се свиват в симетричен триъгълник.';
   const wStart=line(h1,h2,start)-line(l1,l2,start),wNow=line(h1,h2,z)-line(l1,l2,z);
   if(!reason&&!gate(wStart>=1.3*atr&&wNow>0.2*atr&&wNow<0.85*wStart,'Валидно свиване на ширината',`start=${(wStart/atr).toFixed(2)} ATR, now=${(wNow/atr).toFixed(2)} ATR`))reason='Недостатъчно/прекомерно свиване или вече пресечени линии.';
   const apex=(l1.px-h1.px+us*h1.i-lslope*l1.i)/(us-lslope);
   if(!reason&&!gate(Number.isFinite(apex)&&apex>=z-2&&apex<=z+35,'Apex близо до пробива',`след ${(apex-z).toFixed(1)} свещи`))reason='Върхът на триъгълника е извън допустимия прозорец.';
   const first=Math.min(h1.i,l1.i),last=Math.max(h2.i,l2.i);
   let breaches=0;
   for(let i=first+2;i<last;i++){const top=line(h1,h2,i),bottom=line(l1,l2,i);if(c[i].c>top+0.2*atr||c[i].c<bottom-0.2*atr)breaches++;}
   if(!reason&&!gate(breaches<=1,'Максимум едно преждевременно нарушение на линиите',`нарушения ${breaches}`))reason='Има твърде много затваряния извън триъгълника преди пробива.';
   const bound=line(side==='LONG'?h1:l1,side==='LONG'?h2:l2,z),prevBound=line(side==='LONG'?h1:l1,side==='LONG'?h2:l2,z-1);
   const crossed=side==='LONG'?bull(b)&&b.c>bound+0.1*atr&&p.c<=prevBound+0.1*atr:bear(b)&&b.c<bound-0.1*atr&&p.c>=prevBound-0.1*atr;
   if(!reason&&!gate(crossed,'Нов пробив с 0.10 ATR отвъд линията, потвърден със затваряне',`close=${b.c.toFixed(5)}, boundary=${bound.toFixed(5)}`))reason='Няма нов потвърден пробив отвъд трендлинията.';
   if(!reason&&!gate(body(b)/span(b)>=0.5,'Тяло на пробивната свещ ≥50% от диапазона',`${(100*body(b)/span(b)).toFixed(1)}%`))reason='Пробивната свещ е твърде слаба.';
   if(!reason&&!gate(Math.abs(b.c-bound)<=2.5*atr,'Пробивът не е прекомерно отдалечен (>2.5 ATR)',`${(Math.abs(b.c-bound)/atr).toFixed(2)} ATR`))reason='Пробивът е прекалено разтегнат.';
   const passed=local.filter(x=>x.ok).length;
   if(!best||passed>best.passed)best={passed,checks:local,reason};
  }
  if(best)checks.push(...best.checks);
  check(vr>=1.3,'Обем при пробива ≥1.30× средния за предишните 20 свещи',`${vr.toFixed(2)}×`);
  const firstFail=checks.find(x=>!x.ok);
  return {summary:hit?'V2 приема: геометрията, пробивът и обемът покриват условията.':firstFail?'V2 отказва: '+firstFail.label+'.':'V2 отказва: няма комбинация от pivot линии, която изпълнява всички условия.',checks};
 }
 const trend=s.direction;
 check(vr>=1.15,'Обем поне 1.15× (общ диагностичен ориентир, НЕ универсално правило)',vr.toFixed(2)+'×');
 check(body(b)/span(b)>=0.45,'Тяло ≥45% от диапазона (ориентир, НЕ универсално правило)',(100*body(b)/span(b)).toFixed(1)+'%');
 check(trend!=='NEUTRAL','Определена посока на пазарната структура',trend);
 return {summary:hit?'Патернът е приет по точните правила на детектора: '+hit.details:'Не са изпълнени всички правила на V2. Показаните показатели са контекст, а НЕ пълен списък с причини за отказ.',checks};
}

const CATALOG_IDS=[
 'RANGE_BREAKOUT','RANGE_BREAKDOWN','LIQUIDITY_SWEEP_LOW','LIQUIDITY_SWEEP_HIGH',
 'BULL_ENGULF','BEAR_ENGULF','HAMMER','SHOOTING_STAR',
 'MOMENTUM_REVERSAL_LONG','MOMENTUM_REVERSAL_SHORT',
 'EMA_PULLBACK_LONG','EMA_PULLBACK_SHORT','BREAKOUT_RETEST_LONG','BREAKOUT_RETEST_SHORT',
 'DOUBLE_BOTTOM','DOUBLE_TOP','TRIANGLE_UP','TRIANGLE_DOWN',
 'VOLUME_EXPANSION_LONG','VOLUME_EXPANSION_SHORT'
] as const;


// V3 research-only: 10 classic geometric patterns. Strict closed-bar confirmation.
export const CLASSIC_IDS = [
 'HEAD_SHOULDERS','INVERSE_HEAD_SHOULDERS',
 'BULL_FLAG','BEAR_FLAG',
 'RISING_WEDGE','FALLING_WEDGE',
 'CUP_HANDLE','INVERSE_CUP_HANDLE',
 'TRIPLE_TOP','TRIPLE_BOTTOM'
] as const;
export function detectClassic(c:Candle[],s:Structure,frame:Frame):PatternHit[]{
 if(c.length<90||!s||!Number.isFinite(s.atr14)||s.atr14<=0)return [];
 const z=c.length-1,b=c[z],p=c[z-1],atr=s.atr14,prior=c.slice(z-20,z);
 const volumeRatio=avgVolume(prior)>0?b.v/avgVolume(prior):0;
 const out:(PatternHit & {geometry?:any})[]=[];
 let geom:any=null;
 const pt=(i:number,price:number,label:string)=>({i,price,label});
 const seg=(a:any,b:any,label:string)=>({a,b,label});
 const add=(id:string,name:string,side:Side,ok:boolean,detail:string)=>{
  if(ok)out.push({id,name,side,frame,strength:clamp(60+Math.min(20,volumeRatio*8)),confirmed:true,details:detail,signalBarOpen:b.t,geometry:geom});
  geom=null;
 };
 const highs=pivots(c,z-85,z-3,'H'),lows=pivots(c,z-85,z-3,'L');
 const crossDown=(level:number)=>bear(b)&&p.c>=level-0.06*atr&&b.c<level-0.10*atr&&body(b)/span(b)>=0.40;
 const crossUp=(level:number)=>bull(b)&&p.c<=level+0.06*atr&&b.c>level+0.10*atr&&body(b)/span(b)>=0.40;
 // Head and shoulders: three separated pivot peaks, middle highest, comparable shoulders, neckline breakout.
 for(const [id,side,ps,opposite] of [
  ['HEAD_SHOULDERS','SHORT',highs,lows],
  ['INVERSE_HEAD_SHOULDERS','LONG',lows,highs]
 ] as const){
  let found=false,desc='';
  for(let j=ps.length-1;j>=2&&!found;j--){
   const a=ps[j-2],h=ps[j-1],r=ps[j];
   if(r.i-a.i<14||r.i-a.i>72||h.i-a.i<5||r.i-h.i<5||z-r.i<2||z-r.i>18)continue;
   const isTop=side==='SHORT';
   if(isTop?!(h.px>a.px+0.7*atr&&h.px>r.px+0.7*atr):!(h.px<a.px-0.7*atr&&h.px<r.px-0.7*atr))continue;
   if(Math.abs(a.px-r.px)>1.25*atr)continue;
   const between1=opposite.filter(x=>x.i>a.i&&x.i<h.i),between2=opposite.filter(x=>x.i>h.i&&x.i<r.i);
   if(!between1.length||!between2.length)continue;
   const n1=between1[between1.length-1],n2=between2[0];
   const neckline=line(n1,n2,z);
   if(Math.abs(n2.px-n1.px)>2.5*atr||Math.abs(b.c-neckline)>2.7*atr)continue;
   if(!(isTop?crossDown(neckline):crossUp(neckline)))continue;
   geom={points:[pt(a.i,a.px,'Ляво рамо'),pt(h.i,h.px,'Глава'),pt(r.i,r.px,'Дясно рамо'),pt(n1.i,n1.px,'Neckline A'),pt(n2.i,n2.px,'Neckline B'),pt(z,b.c,'Пробив')],lines:[seg(pt(n1.i,n1.px,''),pt(z,neckline,''),'Neckline')],start:a.i,end:z};
   found=true;desc='3 потвърдени pivots: ляво рамо '+a.i+', глава '+h.i+', дясно рамо '+r.i+'; пробив на neckline '+neckline.toFixed(5);
  }
  add(id,side==='SHORT'?'Глава и рамене':'Обърната глава и рамене',side as Side,found,desc);
 }
 // Flags: strong 8-bar impulse, then 5-14 bars of narrow countertrend channel, breakout.
 for(const side of ['LONG','SHORT'] as const){
  let found=false,desc='';
  for(let len=5;len<=14&&!found;len++){
   const flag=c.slice(z-len,z),pole=c.slice(z-len-8,z-len);
   if(pole.length!==8||flag.length!==len)continue;
   const impulse=pole[pole.length-1].c-pole[0].o;
   if(side==='LONG'?impulse<3.5*atr:impulse>-3.5*atr)continue;
   const f0=flag[0],fl=flag[flag.length-1],drift=fl.c-f0.c;
   if(side==='LONG'?(drift>0.25*atr||drift<-2.3*atr):(drift<-0.25*atr||drift>2.3*atr))continue;
   if(hi(flag)-lo(flag)>3.2*atr)continue;
   const edge=side==='LONG'?hi(flag):lo(flag);
   if(!(side==='LONG'?crossUp(edge):crossDown(edge)))continue;
   if(volumeRatio<1.15)continue;
   geom={points:[pt(z-len-8,pole[0].o,'Начало импулс'),pt(z-len-1,pole[pole.length-1].c,'Край импулс'),pt(z,b.c,'Пробив')],lines:[seg(pt(z-len-8,pole[0].o,''),pt(z-len-1,pole[pole.length-1].c,''),'Импулс'),seg(pt(z-len,edge,''),pt(z,edge,''),'Граница на флага')],start:z-len-8,end:z};
   found=true;desc='Импулс '+(impulse/atr).toFixed(2)+' ATR; корекция '+len+' свещи; пробив '+edge.toFixed(5)+'; обем '+volumeRatio.toFixed(2)+'×';
  }
  add(side==='LONG'?'BULL_FLAG':'BEAR_FLAG',side==='LONG'?'Бичи флаг':'Мечи флаг',side,found,desc);
 }
 // Wedges: converging trendlines with both slopes pointing in same direction.
 for(const [id,side,sign] of [['RISING_WEDGE','SHORT',1],['FALLING_WEDGE','LONG',-1]] as const){
  let found=false,desc='';
  const hs=highs.filter(x=>x.i>=z-42),ls=lows.filter(x=>x.i>=z-42);
  for(let h=hs.length-1;h>=1&&!found;h--)for(let l=ls.length-1;l>=1&&!found;l--){
   const h1=hs[h-1],h2=hs[h],l1=ls[l-1],l2=ls[l];
   if(Math.abs(h2.i-l2.i)>12||Math.max(h1.i,l1.i)>Math.min(h2.i,l2.i)-4)continue;
   const up=(h2.px-h1.px)/(h2.i-h1.i),down=(l2.px-l1.px)/(l2.i-l1.i);
   if(sign===1?!(up>0.015*atr&&down>up+0.015*atr):!(down< -0.015*atr&&up<down-0.015*atr))continue;
   const start=Math.max(h1.i,l1.i),width0=line(h1,h2,start)-line(l1,l2,start);
   const width1=line(h1,h2,z)-line(l1,l2,z);
   if(width0<1.1*atr||width1<=0.15*atr||width1>0.8*width0)continue;
   const boundary=side==='SHORT'?line(l1,l2,z):line(h1,h2,z);
   if(!(side==='SHORT'?crossDown(boundary):crossUp(boundary)))continue;
   geom={points:[pt(h1.i,h1.px,'Връх 1'),pt(h2.i,h2.px,'Връх 2'),pt(l1.i,l1.px,'Дъно 1'),pt(l2.i,l2.px,'Дъно 2'),pt(z,b.c,'Пробив')],lines:[seg(pt(h1.i,h1.px,''),pt(z,line(h1,h2,z),''),'Горна линия'),seg(pt(l1.i,l1.px,''),pt(z,line(l1,l2,z),''),'Долна линия')],start:Math.min(h1.i,l1.i),end:z};
   found=true;desc='Сходящи наклонени линии; ширина '+(width0/atr).toFixed(2)+' → '+(width1/atr).toFixed(2)+' ATR; пробив '+boundary.toFixed(5);
  }
  add(id,side==='SHORT'?'Възходящ клин':'Низходящ клин',side,found,desc);
 }
 // Cup & handle: rounded base / dome over 24-65 bars, shallow 4-12 bar handle and rim break.
 for(const side of ['LONG','SHORT'] as const){
  let found=false,desc='';
  for(let handleLen=4;handleLen<=12&&!found;handleLen++){
   for(let cupLen=24;cupLen<=65&&!found;cupLen+=3){
    const cup=c.slice(z-handleLen-cupLen,z-handleLen),handle=c.slice(z-handleLen,z);
    if(cup.length!==cupLen||handle.length!==handleLen)continue;
    const third=Math.floor(cupLen/3),left=cup.slice(0,third),middle=cup.slice(third,2*third),right=cup.slice(2*third);
    const rimL=mean(left.map(x=>x.c)),rimR=mean(right.map(x=>x.c));
    if(Math.abs(rimL-rimR)>1.2*atr)continue;
    const depth=side==='LONG'?Math.min(rimL,rimR)-lo(middle):hi(middle)-Math.max(rimL,rimR);
    if(depth<2*atr||depth>12*atr)continue;
    const rim=side==='LONG'?Math.max(hi(left),hi(right)):Math.min(lo(left),lo(right));
    const handleDepth=side==='LONG'?rim-lo(handle):hi(handle)-rim;
    if(handleDepth>depth*.55||handleDepth<0.15*atr)continue;
    if(!(side==='LONG'?crossUp(rim):crossDown(rim)))continue;
    geom={points:[pt(z-handleLen-cupLen,rimL,'Ляв ръб'),pt(z-handleLen-cupLen+third+Math.floor(third/2),side==='LONG'?lo(middle):hi(middle),'Дъно/връх'),pt(z-handleLen-1,rimR,'Десен ръб'),pt(z-handleLen,handle[0].c,'Дръжка'),pt(z,b.c,'Пробив')],lines:[seg(pt(z-handleLen-cupLen,rim,''),pt(z,rim,''),'Ръб на чашата')],start:z-handleLen-cupLen,end:z};
    found=true;desc='Чаша '+cupLen+' свещи, дръжка '+handleLen+'; дълбочина '+(depth/atr).toFixed(2)+' ATR, пробив на ръба '+rim.toFixed(5);
   }
  }
  add(side==='LONG'?'CUP_HANDLE':'INVERSE_CUP_HANDLE',side==='LONG'?'Чаша с дръжка':'Обърната чаша с дръжка',side,found,desc);
 }
 // Triple top/bottom: three separated pivot levels within 0.65 ATR, neckline confirmation.
 for(const side of ['LONG','SHORT'] as const){
  const ps=side==='LONG'?lows:highs;let found=false,desc='';
  for(let j=ps.length-1;j>=2&&!found;j--){
   const a=ps[j-2],b0=ps[j-1],d=ps[j];
   if(b0.i-a.i<5||d.i-b0.i<5||d.i-a.i>62||z-d.i<2||z-d.i>18)continue;
   if(Math.max(a.px,b0.px,d.px)-Math.min(a.px,b0.px,d.px)>0.65*atr)continue;
   const between=c.slice(a.i+1,d.i),neck=side==='LONG'?hi(between):lo(between);
   const depth=side==='LONG'?neck-Math.max(a.px,b0.px,d.px):Math.min(a.px,b0.px,d.px)-neck;
   if(depth<1.2*atr||depth>10*atr)continue;
   if(!(side==='LONG'?crossUp(neck):crossDown(neck)))continue;
   geom={points:[pt(a.i,a.px,'Ниво 1'),pt(b0.i,b0.px,'Ниво 2'),pt(d.i,d.px,'Ниво 3'),pt(z,b.c,'Пробив')],lines:[seg(pt(a.i,neck,''),pt(z,neck,''),'Neckline')],start:a.i,end:z};
   found=true;desc='Три близки '+(side==='LONG'?'дъна':'върха')+' на барове '+[a.i,b0.i,d.i].join(', ')+'; neckline '+neck.toFixed(5);
  }
  add(side==='LONG'?'TRIPLE_BOTTOM':'TRIPLE_TOP',side==='LONG'?'Тройно дъно':'Троен връх',side,found,desc);
 }
 return out;
}

}


// V4 independent, conservative geometry audit of a V3 candidate. Research only.
// Uses ONLY candles available at the detection bar, never future candles.
export function strictClassicV4(id:string, geom:any, c:import('./types').Candle[], s:import('./types').Structure):{accepted:boolean;checks:{ok:boolean;label:string;value?:string}[];reason:string}{
 const checks:{ok:boolean;label:string;value?:string}[]=[];
 const check=(ok:boolean,label:string,value='')=>checks.push({ok,label,value});
 if(!geom||!Array.isArray(geom.points)){return {accepted:false,checks:[{ok:false,label:'V3 geometry unavailable'}],reason:'NO_V3_GEOMETRY'};}
 const z=c.length-1,atr=Math.max(s.atr14,1e-10),points=geom.points as {i:number;price:number;label:string}[];
 const P=(name:string)=>points.find(p=>p.label===name);
 const br=P('Пробив'),last=c[z],prev=c[z-1];
 const isLong=['INVERSE_HEAD_SHOULDERS','BULL_FLAG','FALLING_WEDGE','CUP_HANDLE','TRIPLE_BOTTOM'].includes(id);
 check(!!br&&br.i===z,'Пробивът е на текущата затворена свещ');
 check(!!br&&(isLong?last.c>last.o:last.c<last.o),'Свещта на пробива е в правилната посока');
 const lineAt=(a:any,b:any,i:number)=>a.price+(b.price-a.price)*(i-a.i)/(b.i-a.i||1);
 if(id==='HEAD_SHOULDERS'||id==='INVERSE_HEAD_SHOULDERS'){
  const a=P('Ляво рамо'),h=P('Глава'),r=P('Дясно рамо'),n1=P('Neckline A'),n2=P('Neckline B');
  if(a&&h&&r&&n1&&n2){
   check(a.i<h.i&&h.i<r.i,'Раменете и главата са хронологично подредени');
   check(isLong?h.price<Math.min(a.price,r.price)-0.8*atr:h.price>Math.max(a.price,r.price)+0.8*atr,'Главата се отличава ясно');
   check(Math.abs(a.price-r.price)<=0.9*atr,'Раменете са на близки нива');
   const neck=lineAt(n1,n2,z),prior=lineAt(n1,n2,z-1);
   check(Math.abs(n2.price-n1.price)<=1.2*atr,'Neckline не е прекалено наклонена');
   check(z-r.i<=10,'Пробивът не е закъснял след дясното рамо');
   check(isLong?(prev.c<=prior&&last.c>neck+0.1*atr):(prev.c>=prior&&last.c<neck-0.1*atr),'Реално пресичане на neckline при сигнала');
  }else check(false,'Липсват точки за рамене/глава/neckline');
 }else if(id==='BULL_FLAG'||id==='BEAR_FLAG'){
  const a=P('Начало импулс'),b=P('Край импулс');
  if(a&&b){
   const flag=c.slice(b.i+1,z),pole=Math.abs(b.price-a.price);
   const highs=flag.map(x=>x.h),lows=flag.map(x=>x.l);
   const half=Math.max(2,Math.floor(flag.length/2));
   const early=flag.slice(0,half),late=flag.slice(half);
   const upperSlope=late.length&&early.length?(Math.max(...late.map(x=>x.h))-Math.max(...early.map(x=>x.h)))/Math.max(1,flag.length-half):NaN;
   const lowerSlope=late.length&&early.length?(Math.min(...late.map(x=>x.l))-Math.min(...early.map(x=>x.l)))/Math.max(1,flag.length-half):NaN;
   const retrace=flag.length?(isLong?b.price-Math.min(...lows):Math.max(...highs)-b.price)/Math.max(pole,1e-10):Infinity;
   check(flag.length>=6,'Флагът съдържа поне 6 свещи');
   check(retrace>=0.08&&retrace<=0.5,'Корекцията е 8–50% от импулса',retrace.toFixed(2));
   check(isLong?(upperSlope<=0.12*atr&&lowerSlope<=0.12*atr):(upperSlope>=-0.12*atr&&lowerSlope>=-0.12*atr),'Каналът не се движи силно по посока на импулса');
   check(Number.isFinite(upperSlope)&&Math.abs(upperSlope-lowerSlope)<=0.20*atr,'Двете граници имат сходен наклон');
   const upper=Math.max(...highs),lower=Math.min(...lows);
   check(isLong?last.c>upper+0.10*atr:last.c<lower-0.10*atr,'Пробив отвъд реалната граница на флага');
  }else check(false,'Липсват точки за импулса');
 }else if(id==='RISING_WEDGE'||id==='FALLING_WEDGE'){
  const h1=P('Връх 1'),h2=P('Връх 2'),l1=P('Дъно 1'),l2=P('Дъно 2');
  if(h1&&h2&&l1&&l2){
   const sh=(h2.price-h1.price)/(h2.i-h1.i||1),sl=(l2.price-l1.price)/(l2.i-l1.i||1);
   const width0=lineAt(h1,h2,Math.max(h1.i,l1.i))-lineAt(l1,l2,Math.max(h1.i,l1.i));
   const widthZ=lineAt(h1,h2,z)-lineAt(l1,l2,z);
   check(isLong?(sh<0&&sl<0):(sh>0&&sl>0),'Двете линии имат правилен наклон');
   check(width0>0&&widthZ>0&&widthZ<width0*.7,'Клинът се стеснява с поне 30%');
   check(Math.min(h2.i,l2.i)-Math.min(h1.i,l1.i)>=10,'Формацията обхваща поне 10 свещи');
   const edge=isLong?lineAt(h1,h2,z):lineAt(l1,l2,z);
   const prevEdge=isLong?lineAt(h1,h2,z-1):lineAt(l1,l2,z-1);
   check(isLong?prev.c<=prevEdge&&last.c>edge+0.08*atr:prev.c>=prevEdge&&last.c<edge-0.08*atr,'Потвърден пробив на правилната линия');
  }else check(false,'Липсват четири pivot точки');
 }else if(id==='CUP_HANDLE'||id==='INVERSE_CUP_HANDLE'){
  const a=P('Ляв ръб'),m=P('Дъно/връх'),r=P('Десен ръб'),h=P('Дръжка');
  if(a&&m&&r&&h){
   const total=r.i-a.i,midRatio=(m.i-a.i)/Math.max(1,total);
   check(total>=24,'Чашата има достатъчна продължителност');
   check(midRatio>=0.3&&midRatio<=0.7,'Дъното/върхът е в средната част, а не V-образно в края');
   check(Math.abs(a.price-r.price)<=0.8*atr,'Двата ръба са на близки нива');
   check(z-h.i>=3&&z-h.i<=12,'Дръжката има разумна продължителност');
   const rim=isLong?Math.max(a.price,r.price):Math.min(a.price,r.price);
   check(isLong?last.c>rim+0.1*atr:last.c<rim-0.1*atr,'Пробив отвъд ръба на чашата');
  }else check(false,'Липсват точки за чашата и дръжката');
 }else if(id==='TRIPLE_TOP'||id==='TRIPLE_BOTTOM'){
  const levels=points.filter(p=>/^Ниво [123]$/.test(p.label)),line=geom.lines?.[0];
  check(levels.length===3,'Три ясно определени върха/дъна');
  if(levels.length===3){
   check(levels[0].i<levels[1].i&&levels[1].i<levels[2].i,'Трите точки са последователни');
   check(Math.max(...levels.map(x=>x.price))-Math.min(...levels.map(x=>x.price))<=0.5*atr,'Трите нива са достатъчно близки');
   check(levels[2].i-levels[0].i>=15,'Формацията не е прекалено кратка');
  }
  if(line){const neck=line.a.price;check(isLong?prev.c<=neck&&last.c>neck+0.1*atr:prev.c>=neck&&last.c<neck-0.1*atr,'Потвърден пробив на neckline');}
  else check(false,'Neckline липсва');
 }
 const failed=checks.filter(x=>!x.ok);
 return {accepted:failed.length===0,checks,reason:failed.length?failed.map(x=>x.label).join('; '):'Всички V4 геометрични проверки са изпълнени'};
}
