/** Swing Hunter V1.8.4 — TP FIRST TOUCH WITHIN 24 HOURS.
 * Research only. Does NOT simulate SL, order execution or real profit.
 * Each chart pattern is evaluated independently. Only closed OHLC candles.
 */
import type {Candle,Interval} from './types';
import {COINS,fetchClosed,quality,STEP} from './ohlcv';
import {structure} from './market-structure';
import {detectCatalog} from './pattern-catalog';

type Side='LONG'|'SHORT';
const TARGETS=[0.3,0.5,0.75,1,1.5,2] as const;
const COST_PCT=0.18;
const MAX_CANDLES=400;
const CHECKPOINTS=120;
const HORIZON_MS=24*60*60*1000;
const round=(n:number)=>Number(n.toFixed(6));
const iso=(t:number)=>new Date(t).toISOString();
const validIntervals=['1h','4h','1d'];
function directional(side:Side,entry:number,price:number){return round((side==='LONG'?price-entry:entry-price)/entry*100);}
function evaluate(coin:string,interval:Interval,c:Candle[],limit:number){
 const step=STEP[interval];
 const bars=HORIZON_MS/step;
 if(!Number.isInteger(bars)||bars<1)throw Error('INTERVAL_NOT_SUPPORTED_FOR_24H');
 const events:any[]=[];const keys=new Set<string>();
 let skippedNoEntry=0,duplicates=0,detectorTimestampMismatch=0;
 const start=Math.max(65,c.length-CHECKPOINTS);
 for(let i=start;i<c.length;i++){
  const signal=c[i],entryBar=c[i+1];
  const prefix=c.slice(0,i+1);
  const hits=detectCatalog(prefix,structure(prefix),interval==='1h'?'1h':'4h');
  for(const hit of hits){
   const id=`${coin}:${interval}:${hit.id}:${signal.t}`;
   if(keys.has(id)){duplicates++;continue;}keys.add(id);
   if(hit.signalBarOpen!==signal.t){detectorTimestampMismatch++;continue;}
   if(!entryBar||entryBar.t!==signal.t+step){skippedNoEntry++;continue;}
   const side=hit.side as Side;
   const entry=entryBar.o;
   if(!Number.isFinite(entry)||entry<=0)continue;
   // 24h starts at the next candle's open, after the signal candle closes.
   // Only bars that close within this 24h window may establish a hit.
   const windowEnd=entryBar.t+HORIZON_MS;
   const available=c.slice(i+1,i+1+bars).filter(b=>b.t>=entryBar.t&&b.t+step<=windowEnd);
   const complete=available.length===bars&&available.every((b,k)=>b.t===entryBar.t+k*step);
   const maxFavorablePct=available.length?round(Math.max(0,...available.map(b=>directional(side,entry,side==='LONG'?b.h:b.l)))):null;
   const maxAdversePct=available.length?round(Math.max(0,...available.map(b=>-directional(side,entry,side==='LONG'?b.l:b.h)))):null;
   const targets=TARGETS.map(tp=>{
    const price=round(entry*(side==='LONG'?1+tp/100:1-tp/100));
    const idx=available.findIndex(b=>side==='LONG'?b.h>=price:b.l<=price);
    const hitTp=idx>=0;
    const b=hitTp?available[idx]:null;
    return {tpPct:tp,targetPrice:price,status:hitTp?'TP_TOUCHED':complete?'NOT_TOUCHED_24H':'PENDING_24H',touched:hitTp,
      firstTouchBarOpen:b?iso(b.t):null,firstTouchBy:b?iso(b.t+step):null,
      earliestPossibleHours:hitTp?round(idx*step/3600000):null,
      latestPossibleHours:hitTp?round((idx+1)*step/3600000):null,
      tpNetIfFilledAndExecutedPct:hitTp?round(tp-COST_PCT):null};
   });
   events.push({id,pattern:hit.id,side,strength:hit.strength,
    signalBarOpen:iso(signal.t),signalAvailableAt:iso(signal.t+step),
    entryBarOpen:iso(entryBar.t),marketEntry:entry,
    horizonEnd:iso(windowEnd),windowComplete:complete,observedBars:available.length,expectedBars:bars,
    maxFavorablePct,maxAdversePct,targets});
  }
 }
 const summary=TARGETS.map(tp=>{
  const t=events.map(e=>e.targets.find((x:any)=>x.tpPct===tp));
  const touched=t.filter((x:any)=>x.touched).length;
  const missed=t.filter((x:any)=>x.status==='NOT_TOUCHED_24H').length;
  const pending=t.length-touched-missed;
  const decided=touched+missed;
  return {tpPct:tp,signals:t.length,touched,notTouched24h:missed,pending,
   touchRateResolvedPct:decided?round(touched/decided*100):null,
   touchRateAllSignalsPct:t.length?round(touched/t.length*100):null,
   hypotheticalNetAtTpPct:round(tp-COST_PCT)};
 });
 const perPattern=new Map<string,{pattern:string,side:Side,signals:number,complete:number,touches:Record<string,number>}>();
 for(const e of events){
  const key=e.pattern+':'+e.side;
  if(!perPattern.has(key))perPattern.set(key,{pattern:e.pattern,side:e.side,signals:0,complete:0,touches:{}});
  const p=perPattern.get(key)!;p.signals++;if(e.windowComplete)p.complete++;
  for(const t of e.targets)if(t.touched)p.touches[String(t.tpPct)]=(p.touches[String(t.tpPct)]||0)+1;
 }
 return {audit:{duplicatePatternKeys:duplicates,missingNextBar:skippedNoEntry,detectorTimestampMismatch,
  pass:duplicates===0&&detectorTimestampMismatch===0},totalEvents:events.length,summary,
  byPattern:[...perPattern.values()],events:limit===0?[]:events.slice(-limit)};
}
export async function tpFirstTouchCoin(coin:string,interval:Interval='4h',limit=15){
 if(!(COINS as readonly string[]).includes(coin))throw Error('INVALID_COIN');
 if(!validIntervals.includes(interval))throw Error('INVALID_INTERVAL');
 limit=Math.max(0,Math.min(50,Number.isFinite(limit)?Math.floor(limit):15));
 const data=await fetchClosed(coin,interval,MAX_CANDLES);
 const q=quality(data);const {last3,...cleanQuality}=q;
 if(!q.ready||data.closed.length<100)return {success:false,error:'DATA_NOT_READY',quality:cleanQuality};
 return {success:true,module:'SWING_HUNTER_V1_8_4_TP_FIRST_TOUCH_24H',mode:'SHADOW_READ_ONLY',trading:false,d1_writes:0,
  coin,interval,quality:cleanQuality,method:{signal:'CLOSED_BAR_ONLY',entry:'NEXT_BAR_OPEN_MARKET_REFERENCE',
   horizonHours:24,tpTargetsPct:TARGETS,roundTripCostScenarioPct:COST_PCT,
   resultDefinition:'TP touched by candle high/low within 24 hours; NOT a realized trade P/L',
   notes:['TP only: no SL, liquidation, position management or exit simulation',
    'A TP touch does not prove the trade would survive adverse movement before TP',
    'Within-candle first-touch time is unknown: return a bar time range',
    'OHLC high/low touch is not a guaranteed executable fill',
    'Last incomplete 24h windows are PENDING unless TP already touched',
    'Pattern events on same candle are correlated, not independent market events',
    'No changes to LIVE trading, D1 or existing strategies',
    'Pattern detectors are heuristic and have not been fully audited for look-ahead']},
  ...evaluate(coin,interval,data.closed,limit)};
}
