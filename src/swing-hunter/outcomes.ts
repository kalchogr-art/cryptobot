import {safeFetchClosed} from './stability';
import {quality,STEP,COINS} from './ohlcv';
import {structure} from './market-structure';
import type {Candle,CandleSet} from './types';

type Side='LONG'|'SHORT';
type Variant='ORIGINAL'|'B_RELAXED_4H';
type Trade={coin:string;variant:Variant;signalTime:string;entryTime:string;side:Side;entry:number;stop:number;target:number;exitTime:string|null;exitPrice:number|null;outcome:'TP'|'SL'|'TIME';grossR:number;netR:number;feesUsdPer100:number;split:'TRAIN'|'TEST';ambiguousBar:boolean};
const round=(v:number)=>Number(v.toFixed(6));
const trim=(x:CandleSet,t:number):Candle[]=>x.closed.filter(c=>c.t+STEP[x.interval]<=t);
function probe(c:Candle[],length=20){
 const last=c[c.length-1],prior=c.slice(-length-1,-1);if(!last||prior.length!==length)return null;
 const high=Math.max(...prior.map(x=>x.h)),low=Math.min(...prior.map(x=>x.l)),avg=prior.reduce((s,x)=>s+x.v,0)/length;
 const side:Side|null=last.c>high?'LONG':last.c<low?'SHORT':null;
 return {side,ratio:avg>0?last.v/avg:0};
}
function atr(c:Candle[]){const n=14;if(c.length<n+1)return NaN;let sum=0;for(let i=c.length-n;i<c.length;i++){const x=c[i],p=c[i-1];sum+=Math.max(x.h-x.l,Math.abs(x.h-p.c),Math.abs(x.l-p.c));}return sum/n;}
function simulate(coin:string,variant:Variant,side:Side,signal:Candle,entryBar:Candle,following:Candle[],atrValue:number,split:'TRAIN'|'TEST'):Trade|null{
 // Conservative OHLC model: next candle open, 1.5 ATR SL, 2R target, SL wins same-bar ties.
 const entry=entryBar.o,risk=1.5*atrValue;if(!Number.isFinite(risk)||risk<=0||entry<=0)return null;
 const stop=side==='LONG'?entry-risk:entry+risk,target=side==='LONG'?entry+2*risk:entry-2*risk;
 let exit=following[following.length-1],exitPrice=exit.c,outcome:'TP'|'SL'|'TIME'='TIME',ambiguousBar=false;
 for(const bar of following){const sl=side==='LONG'?bar.l<=stop:bar.h>=stop,tp=side==='LONG'?bar.h>=target:bar.l<=target;
   if(sl||tp){ambiguousBar=sl&&tp;outcome=sl?'SL':'TP';
     // If price gaps through a level at open, use the worse open for SL; favorable TP capped at target.
     exitPrice=outcome==='SL'?(side==='LONG'?Math.min(stop,bar.o):Math.max(stop,bar.o)):target;exit=bar;break;
   }
 }
 const grossR=(side==='LONG'?exitPrice-entry:entry-exitPrice)/risk;
 // Hypothetical 0.07% each side + 0.02% each side slippage, expressed in risk units.
 const fees=entry*0.0014,slippage=entry*0.0004,netR=grossR-(fees+slippage)/risk;
 return {coin,variant,signalTime:new Date(signal.t+STEP['1h']).toISOString(),entryTime:new Date(entryBar.t).toISOString(),side,entry:round(entry),stop:round(stop),target:round(target),exitTime:new Date(exit.t+STEP['1h']).toISOString(),exitPrice:round(exitPrice),outcome,grossR:round(grossR),netR:round(netR),feesUsdPer100:round(0.14),split,ambiguousBar};
}
function summary(trades:Trade[]){let equity=0,peak=0,maxDrawdownR=0;for(const t of trades){equity+=t.netR;peak=Math.max(peak,equity);maxDrawdownR=Math.max(maxDrawdownR,peak-equity);}return {trades:trades.length,tp:trades.filter(x=>x.outcome==='TP').length,sl:trades.filter(x=>x.outcome==='SL').length,time:trades.filter(x=>x.outcome==='TIME').length,winRatePct:trades.length?round(100*trades.filter(x=>x.netR>0).length/trades.length):null,netR:round(equity),avgNetR:trades.length?round(equity/trades.length):null,maxDrawdownR:round(maxDrawdownR),ambiguousBars:trades.filter(x=>x.ambiguousBar).length};}
export async function outcomeCoin(coin:string){
 if(!(COINS as readonly string[]).includes(coin))throw new Error('INVALID_COIN');
 const [a,b,d]=await Promise.all([safeFetchClosed(coin,'1h',400),safeFetchClosed(coin,'4h',400),safeFetchClosed(coin,'1d',400)]);
 const checks=[a,b,d].map(x=>{const {last3,...q}=quality(x);return q;});if(checks.some(x=>!x.ready))throw new Error('DATA_NOT_READY');
 const trades:Trade[]=[];const rejected={noBreakout:0,lowVolume:0,trendMismatch:0,alignmentMismatch:0,insufficientHistory:0};
 // Use last 200 1H candles as decision checkpoints, reserving up to 24 following bars for outcomes.
 const start=Math.max(0,a.closed.length-224),end=a.closed.length-24;
 const midpoint=Math.floor((start+end)/2);
 const lastEntry:Record<Variant,number>={ORIGINAL:-9999,B_RELAXED_4H:-9999};
 for(let i=start;i<end;i++){
  const signal=a.closed[i],cutoff=signal.t+STEP['1h'],x=trim(a,cutoff),y=trim(b,cutoff),z=trim(d,cutoff);
  if(x.length<60||y.length<60||z.length<60){rejected.insufficientHistory++;continue;}
  const p=probe(x);if(!p?.side){rejected.noBreakout++;continue;}
  if(p.ratio<1.2){rejected.lowVolume++;continue;}
  const trend=structure(x).direction,t4=structure(y).direction,td=structure(z).direction;
  if(p.side!==trend){rejected.trendMismatch++;continue;}
  const aligned={ORIGINAL:p.side===t4&&p.side===td,B_RELAXED_4H:p.side===t4||p.side===td};
  if(!aligned.ORIGINAL&&!aligned.B_RELAXED_4H)rejected.alignmentMismatch++;
  for(const variant of ['ORIGINAL','B_RELAXED_4H'] as const){
   if(!aligned[variant]||i-lastEntry[variant]<24)continue;
   const next=a.closed[i+1];if(!next||next.t!==cutoff)continue;
   const following=a.closed.slice(i+1,i+25);if(following.length!==24)continue;
   const t=simulate(coin,variant,p.side,signal,next,following,atr(x),i<midpoint?'TRAIN':'TEST');
   if(t){trades.push(t);lastEntry[variant]=i;}
  }
 }
 const variants=(['ORIGINAL','B_RELAXED_4H'] as const).map(name=>{const t=trades.filter(x=>x.variant===name);return {name,all:summary(t),train:summary(t.filter(x=>x.split==='TRAIN')),test:summary(t.filter(x=>x.split==='TEST')),trades:t};});
 return {success:true,module:'SWING_HUNTER_V1_4_OUTCOME_RESEARCH',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,coin,quality:checks,assumptions:{signal:'1H close breakout above/below prior 20-bar range; volume >= 1.2; 1H trend aligned; 4H/1D strict or relaxed',entry:'NEXT_1H_OPEN',stop:'1.5x_1H_ATR14',target:'2R',maxHoldHours:24,dedupHours:24,feesRoundTripPct:0.14,slippageRoundTripPct:0.04,ambiguous:'SL_FIRST',split:'FIRST_HALF_TRAIN_SECOND_HALF_TEST',limitations:'OHLC bars cannot resolve intrabar execution; historical sample is short; no funding, spread, partial fills or market impact; 4H breakout swing entries are not modeled'},rejected,variants,notes:['Research-only, no orders or D1 writes','Historical P/L is in R units, not real dollars','Do not infer profitability from a handful of trades']};
}
