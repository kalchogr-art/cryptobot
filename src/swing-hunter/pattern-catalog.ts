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
