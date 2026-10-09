export type Interval = '1h'|'4h'|'1d';
export type Direction = 'LONG'|'SHORT'|'NEUTRAL';
export type Mode = 'INTRADAY'|'SWING'|'NONE';
export type Candle = {t:number; o:number; h:number; l:number; c:number; v:number; n:number};
export type CandleSet = {coin:string;interval:Interval;closed:Candle[];formingExcluded:number;received:number;invalid:number;gaps:number;duplicates:number;requested:number};
export type Structure = {direction:Direction;ema20:number;ema50:number;atr14:number;atrPct:number;support:number;resistance:number;close:number;trendStrengthPct:number;ready:boolean};
export type Pattern = {name:string;direction:Direction;confirmed:boolean;breakoutLevel:number;stopReference:number;confidence:number;explanation:string};
export type Candidate = {coin:string;mode:Mode;side:Direction;status:'NO_SIGNAL'|'WATCH'|'CANDIDATE';entry:number|null;stop:number|null;target:number|null;rr:number|null;pattern:Pattern|null;reason:string[];observedAt:string};
