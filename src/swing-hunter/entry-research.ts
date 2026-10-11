/** Swing Hunter V1.8.3: candle-time integrity + independent pullback study.
 * Pure GET/read-only. No trades, D1, state mutation, or ML claims.
 */
import type {Candle,Interval} from './types';
import {COINS,fetchClosed,quality,STEP} from './ohlcv';
import {structure} from './market-structure';
import {detectCatalog} from './pattern-catalog';

type Side='LONG'|'SHORT';
const PULLBACKS=[0.1,0.2,0.3,0.5,0.75,1] as const;
const round=(x:number)=>Number(x.toFixed(6));
const iso=(t:number)=>new Date(t).toISOString();
const intervals=['1h','4h','1d'];
const holdingBars:Record<Interval,number>={'1h':24,'4h':6,'1d':1};
const waitBars:Record<Interval,number>={'1h':12,'4h':3,'1d':1};
const TEST_LIMIT=120;
const MAX_LOOKBACK=400;
const roundTripCostsPct=0.18; // scenario: fees .14% + slippage .04%; not actual execution costs
const isFinitePrice=(x:number)=>Number.isFinite(x)&&x>0;
const favorable=(side:Side,from:number,to:number)=>round((side==='LONG'?1:-1)*(to-from)/from*100);
const barClosedAt=(bar:Candle,step:number)=>bar.t+step;
function sumStats(xs:number[]){return {count:xs.length,avgPct:xs.length?round(xs.reduce((a,b)=>a+b,0)/xs.length):null,positivePct:xs.length?round(xs.filter(x=>x>0).length/xs.length*100):null};}
function candleAudit(c:Candle[],interval:Interval){
 const step=STEP[interval];const problems:string[]=[];
 for(let i=0;i<c.length;i++){
  const x=c[i];if(!isFinitePrice(x.o)||!isFinitePrice(x.c)||!isFinitePrice(x.h)||!isFinitePrice(x.l)||x.h<Math.max(x.o,x.c)||x.l>Math.min(x.o,x.c)||x.l>x.h){problems.push('INVALID_OHLC_AT_'+i);}
  if(i&&x.t-c[i-1].t!==step)problems.push('NONCONTIGUOUS_AT_'+i);
 }
 return {pass:problems.length===0,issues:problems.slice(0,20),issueCount:problems.length};
}
function run(coin:string,interval:Interval,c:Candle[],limit:number){
 const step=STEP[interval],h=holdingBars[interval],wait=waitBars[interval];
 const audit=candleAudit(c,interval);
 const events:any[]=[];
 let detections=0,missingEntry=0,duplicateKeys=0,lookaheadRisk=0,incorrectHorizon=0;
 const keys=new Set<string>();
 const start=Math.max(65,c.length-TEST_LIMIT);
 for(let i=start;i<c.length;i++){
  const signal=c[i],next=c[i+1];
  const hits=detectCatalog(c.slice(0,i+1),structure(c.slice(0,i+1)),interval==='1h'?'1h':'4h');
  for(const hit of hits){
   detections++;
   const key=`${coin}:${interval}:${hit.id}:${signal.t}`;
   if(keys.has(key)){duplicateKeys++;continue;}keys.add(key);
   const signalAvailableAt=barClosedAt(signal,step);
   if(hit.signalBarOpen!==signal.t)lookaheadRisk++; // detector timestamp must refer to last available closed candle
   if(!next){missingEntry++;continue;}
   if(next.t!==signalAvailableAt){incorrectHorizon++;continue;}
   const entry=next.o;
   if(!isFinitePrice(entry))continue;
   const exitBar=c[i+h];
   const marketResolved=!!exitBar&&exitBar.t===signal.t+h*step;
   const marketPct=marketResolved?favorable(hit.side,entry,exitBar.c):null;
   const variants:any[]=[];
   for(const pct of PULLBACKS){
    const target=round(entry*(hit.side==='LONG'?1-pct/100:1+pct/100));
    let fillIdx=-1,fillPrice=target,fillAmbiguity=false;
    // Limit is placed at the open of next bar; if open crosses the limit,
    // the order may execute immediately at the open (price improvement).
    for(let j=i+1;j<=Math.min(c.length-1,i+wait);j++){
     const bar=c[j];
     if(bar.t!==next.t+(j-i-1)*step){incorrectHorizon++;break;}
     const opensThrough=hit.side==='LONG'?bar.o<=target:bar.o>=target;
     const touches=hit.side==='LONG'?bar.l<=target:bar.h>=target;
     if(opensThrough||touches){fillIdx=j;fillPrice=opensThrough?bar.o:target;fillAmbiguity=(!opensThrough&&j===i+1);break;}
    }
    // Hold h bars from the fill bar's OPEN, exit at the close of bar fillIdx+h-1.
    // For a limit touched intrabar, the entry is later than bar open; same-bar
    // TP/SL ordering cannot be inferred from OHLC; we do not simulate stops here.
    const exitIdx=fillIdx>=0?fillIdx+h-1:-1;
    const exit=exitIdx>=0?c[exitIdx]:undefined;
    const filled=fillIdx>=0;
    const resolved=filled&&!!exit&&exit.t===c[fillIdx].t+(h-1)*step;
    const grossPct=resolved?favorable(hit.side,fillPrice,exit!.c):null;
    variants.push({pullbackPct:pct,limitPrice:target,status:!filled?'NOT_FILLED':resolved?'RESOLVED':'PENDING',filled,fillTime:filled?iso(c[fillIdx].t):null,fillPrice:filled?round(fillPrice):null,waitBarsToFill:filled?fillIdx-i: null,fillInFirstBar:filled&&fillIdx===i+1,intrabarFillOrderingUnknown:fillAmbiguity,exitTime:resolved?iso(exit!.t+step):null,grossDirectionalPct:grossPct,netDirectionalPct:grossPct===null?null:round(grossPct-roundTripCostsPct)});
   }
   events.push({id:key,pattern:hit.id,side:hit.side,strength:hit.strength,signalBarOpen:iso(signal.t),signalAvailableAt:iso(signalAvailableAt),entryBarOpen:iso(next.t),signalClose:signal.c,marketEntry:entry,marketExitTime:marketResolved?iso(exitBar.t+step):null,marketGrossDirectionalPct:marketPct,marketNetDirectionalPct:marketPct===null?null:round(marketPct-roundTripCostsPct),marketStatus:marketResolved?'RESOLVED':'PENDING',pullbacks:variants});
  }
 }
 const summary=PULLBACKS.map(pct=>{
  const vs=events.map(e=>e.pullbacks.find((x:any)=>x.pullbackPct===pct));
  const resolved=vs.filter((x:any)=>x.status==='RESOLVED');
  const filled=vs.filter((x:any)=>x.filled);
  const marketForSameEvents=events.filter((e,idx)=>vs[idx].status==='RESOLVED'&&e.marketStatus==='RESOLVED').map(e=>e.marketNetDirectionalPct as number);
  return {pullbackPct:pct,signals:events.length,filled:filled.length,notFilled:vs.filter((x:any)=>x.status==='NOT_FILLED').length,pending:vs.filter((x:any)=>x.status==='PENDING').length,fillRatePct:events.length?round(filled.length/events.length*100):null,filledTradeNet:sumStats(resolved.map((x:any)=>x.netDirectionalPct)),marketOnSameSignals:sumStats(marketForSameEvents),note:'Same-signal market comparison uses market entry at next open; fill outcomes use their own later exit, not same wall-clock exit.'};
 });
 return {audit:{...audit,detected: detections,unique:events.length,duplicateKeys,missingEntry,detectorTimestampMismatch:lookaheadRisk,nonContiguousForwardChecks:incorrectHorizon,pass:audit.pass&&duplicateKeys===0&&lookaheadRisk===0&&incorrectHorizon===0},summary,totalEvents:events.length,events:events.slice(-limit)};
}
export async function entryResearchCoin(coin:string,interval:Interval='4h',limit=15){
 if(!(COINS as readonly string[]).includes(coin))throw Error('INVALID_COIN');
 if(!intervals.includes(interval))throw Error('INVALID_INTERVAL');
 limit=Math.max(0,Math.min(50,Number.isFinite(limit)?Math.floor(limit):15));
 const data=await fetchClosed(coin,interval,MAX_LOOKBACK),q=quality(data);const {last3,...cleanQuality}=q;
 if(!q.ready||data.closed.length<100)return {success:false,error:'DATA_NOT_READY',quality:cleanQuality};
 const x=run(coin,interval,data.closed,limit);
 return {success:true,module:'SWING_HUNTER_V1_8_3_INTEGRITY_PULLBACK',mode:'SHADOW_READ_ONLY',trading:false,d1_writes:0,coin,interval,quality:cleanQuality,method:{closedBarsOnly:true,entry:'NEXT_BAR_OPEN',holdingBars:holdingBars[interval],waitBars:waitBars[interval],pullbacksPct:PULLBACKS,costAssumptionRoundTripPct:roundTripCostsPct,costs:'SCENARIO_ONLY',entryType:'LIMIT_TOUCH_WITH_OPEN_PRICE_IMPROVEMENT',exit:'CLOSE_AFTER_HOLD_BARS_FROM_FILL',limitations:['Historical OHLC cannot determine intrabar ordering; no TP/SL simulation','Entry limit is based on next bar open (available only at placement); do not use future highs/lows to set the order','Limit order fills are approximations, not guaranteed executions','Detectors are deterministic, not AI-trained','Signals can overlap and are correlated','No retest-of-structure-level variant yet; this tests fixed pullbacks only','Only last 120 checkpoints and 400 candles','No look-ahead proof for imported detectCatalog or structure internals; audit checks their timestamps and data boundaries','Market comparison uses distinct exit clocks and excludes unfilled opportunities from same-signal comparison']},...x};
}
