import {safeFetchClosed} from './stability';
import {COINS,quality,STEP} from './ohlcv';
import {decide} from './decision-engine';
import type {Candle,CandleSet} from './types';
const iso=(x:number)=>new Date(x).toISOString(),round=(x:number)=>Number(x.toFixed(5));
type Trade={coin:string;mode:string;side:string;signalTime:string;entryTime:string;exitTime:string;entry:number;exit:number;stop:number;target:number;outcome:string;netR:number;grossR:number;split:'TRAIN'|'TEST';patterns:string[];signalKey:string;ambiguous:boolean};
const stats=(a:Trade[])=>{let eq=0,peak=0,dd=0;for(const x of a){eq+=x.netR;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);}return {trades:a.length,tp:a.filter(x=>x.outcome==='TP').length,sl:a.filter(x=>x.outcome==='SL').length,time:a.filter(x=>x.outcome==='TIME').length,winRatePct:a.length?round(100*a.filter(x=>x.netR>0).length/a.length):null,netR:round(eq),avgNetR:a.length?round(eq/a.length):null,maxDrawdownR:round(dd),ambiguousBars:a.filter(x=>x.ambiguous).length};};
const trim=(x:CandleSet,t:number):CandleSet=>({...x,closed:x.closed.filter(c=>c.t+STEP[x.interval]<=t)});
export async function unifiedCoin(coin:string,opts:{maxTrades?:number}={}){
 if(!(COINS as readonly string[]).includes(coin))throw new Error('INVALID_COIN');
 const [h1,h4,d1]=await Promise.all([safeFetchClosed(coin,'1h',400),safeFetchClosed(coin,'4h',400),safeFetchClosed(coin,'1d',400)]);
 const checks=[h1,h4,d1].map(x=>{const {last3,...rest}=quality(x);return rest;});
 if(checks.some(x=>!x.ready))return {success:false,coin,error:'DATA_NOT_READY',quality:checks};
 const start=Math.max(60,h1.closed.length-224),end=h1.closed.length-24,mid=Math.floor((start+end)/2);
 const trades:Trade[]=[],seen=new Set<string>(),rejected={noSignal:0,duplicate:0,missingEntry:0,invalidRisk:0,overlap:0};
 // One open position per coin, conservative OHLC execution. No intrabar ordering knowledge.
 let lastExit=-1;
 for(let i=start;i<end;i++){
  const bar=h1.closed[i],cutoff=bar.t+STEP['1h'];
  const a=trim(h1,cutoff),b=trim(h4,cutoff),d=trim(d1,cutoff);
  if([a,b,d].some(x=>x.closed.length<65))continue;
  const c=decide(coin,a,b,d);
  if(c.status!=='CANDIDATE'||!c.signalKey){rejected.noSignal++;continue;}
  if(seen.has(c.signalKey)){rejected.duplicate++;continue;}seen.add(c.signalKey);
  if(i<=lastExit){rejected.overlap++;continue;}
  const entryBar=h1.closed[i+1];if(!entryBar||entryBar.t!==cutoff){rejected.missingEntry++;continue;}
  const atr=c.mode==='SWING'?Math.abs((c.stop??0)-(c.entry??0))/1.5:Math.abs((c.stop??0)-(c.entry??0))/1.5;
  const entry=entryBar.o,risk=1.5*atr,rr=c.mode==='SWING'?2.5:2;
  if(!(entry>0&&risk>0&&Number.isFinite(risk))){rejected.invalidRisk++;continue;}
  const long=c.side==='LONG',stop=long?entry-risk:entry+risk,target=long?entry+rr*risk:entry-rr*risk;
  const maxBars=c.mode==='SWING'?24:24;
  let exitBar=entryBar,exit=entryBar.c,outcome='TIME',ambiguous=false,exitIndex=i+1;
  for(let j=i+1;j<=Math.min(i+maxBars,h1.closed.length-1);j++){
   const x=h1.closed[j],sl=long?x.l<=stop:x.h>=stop,tp=long?x.h>=target:x.l<=target;
   exitBar=x;exitIndex=j;
   if(sl||tp){ambiguous=sl&&tp;outcome=sl?'SL':'TP';exit=sl?(long?Math.min(stop,x.o):Math.max(stop,x.o)):target;break;}
   exit=x.c;
  }
  const grossR=(long?exit-entry:entry-exit)/risk,netR=grossR-entry*.0018/risk;
  trades.push({coin,mode:c.mode,side:c.side,signalTime:iso(cutoff),entryTime:iso(entryBar.t),exitTime:iso(exitBar.t+STEP['1h']),entry:round(entry),exit:round(exit),stop:round(stop),target:round(target),outcome,netR:round(netR),grossR:round(grossR),split:i<mid?'TRAIN':'TEST',patterns:c.triggerPatterns.map(p=>p.id),signalKey:c.signalKey,ambiguous});
  lastExit=exitIndex;
 }
 const byMode=(mode:string)=>{const x=trades.filter(t=>t.mode===mode);return {all:stats(x),train:stats(x.filter(t=>t.split==='TRAIN')),test:stats(x.filter(t=>t.split==='TEST'))};};
 return {success:true,module:'SWING_HUNTER_V1_6_UNIFIED_BACKTEST',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,coin,quality:checks,window:{start:iso(h1.closed[start].t),end:iso(h1.closed[end-1].t),checkpoints:end-start,trainTestBoundary:iso(h1.closed[mid].t)},assumptions:{signal:'SAME_CATALOG_DECISION_ENGINE_AS_LIVE_SWING_HUNTER_READ_ONLY',entry:'NEXT_1H_OPEN',dedup:'COIN_MODE_SIDE_SIGNAL_BAR_OPEN',position:'ONE_AT_A_TIME_PER_COIN',stop:'1.5_ATR_OF_SIGNAL_FRAME',target:'2R_INTRADAY_2.5R_SWING',maxHoldHours:24,feesRoundTripPct:.14,slippageRoundTripPct:.04,ambiguous:'SL_FIRST',notes:'OHLC approximation; no funding/spread/partial fills; max 400 candles; short sample'},rejected,summary:{all:stats(trades),intraday:byMode('INTRADAY'),swing:byMode('SWING')},trades:opts.maxTrades===0?[]:trades.slice(0,Math.max(0,Math.min(200,opts.maxTrades??200)))};
}
export async function unifiedMarket(offset=0,limit=2){
 offset=Math.max(0,Math.min(COINS.length,Math.floor(offset)));limit=Math.max(1,Math.min(3,Math.floor(limit)));
 const results:any[]=[];
 // Sequential and bounded to avoid 429 bursts and worker CPU exhaustion; failures stay explicit.
 for(const coin of COINS.slice(offset,offset+limit)){try{const x=await unifiedCoin(coin,{maxTrades:0});results.push({coin,success:x.success,summary:x.summary?.all??null,error:x.error??null});}catch(e){results.push({coin,success:false,error:e instanceof Error?e.message:String(e)});}}
 return {success:true,module:'SWING_HUNTER_V1_6_MARKET_RESEARCH',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,coins:results.length,offset,nextOffset:offset+limit<COINS.length?offset+limit:null,totalCoins:COINS.length,results,note:'Paged 2 coins by default to reduce 429 and Worker timeout; request offset=0,2,...18. No results are silently skipped.'};
}
