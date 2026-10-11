/** V1.8 — independent chart-pattern observations, research only. No DB writes or orders. */
import type {Candle,Interval} from './types';
import {COINS,fetchClosed,quality,STEP} from './ohlcv';
import {structure} from './market-structure';
import {detectCatalog} from './pattern-catalog';

const round=(n:number)=>Number(n.toFixed(6));
const iso=(n:number)=>new Date(n).toISOString();
const HORIZONS:Record<Interval,number[]>={'1h':[4,12,24,48,72],'4h':[1,3,6,12,18],'1d':[1,2,3,5,7]};
const WINDOW=120;
type Observation={id:string;coin:string;interval:Interval;pattern:string;side:'LONG'|'SHORT';strength:number;signalTime:string;signalBarOpen:number;signalClose:number;entryTime:string|null;entry:number|null;status:'CONFIRMED';outcomes:Record<string,unknown>};
function observations(coin:string,interval:Interval,c:Candle[],maxEvents:number){
 const events:Observation[]=[];let scanned=0;
 const start=Math.max(65,c.length-WINDOW);
 for(let i=start;i<c.length;i++){
  const prefix=c.slice(0,i+1);const s=structure(prefix);
  // The V1.6 catalog has identical candle-based detection logic on either frame.
  // Its frame tag is remapped for daily; do not infer a 4h holding period from this.
  const hits=detectCatalog(prefix,s,interval==='1h'?'1h':'4h');scanned++;
  for(const p of hits){
   const entryBar=c[i+1],entry=entryBar?.o??null;
   const outcomes:Record<string,unknown>={};
   for(const h of HORIZONS[interval]){
    const last=c[i+h];
    if(!entryBar||!last||last.t!==c[i].t+h*STEP[interval]){outcomes[String(h)]={status:'PENDING'};continue;}
    const change=(last.c-entry)/entry*100,sideMove=p.side==='LONG'?change:-change;
    const path=c.slice(i+1,i+h+1);
    const maxUp=(Math.max(...path.map(x=>x.h))-entry)/entry*100;
    const maxDown=(Math.min(...path.map(x=>x.l))-entry)/entry*100;
    outcomes[String(h)]={status:'RESOLVED',endTime:iso(last.t+STEP[interval]),returnPct:round(change),directionalReturnPct:round(sideMove),favorableExcursionPct:round(p.side==='LONG'?maxUp:-maxDown),adverseExcursionPct:round(p.side==='LONG'?-maxDown:maxUp),directionCorrect:sideMove>0};
   }
   events.push({id:`${coin}:${interval}:${p.id}:${p.signalBarOpen}`,coin,interval,pattern:p.id,side:p.side,strength:p.strength,signalTime:iso(c[i].t+STEP[interval]),signalBarOpen:p.signalBarOpen,signalClose:c[i].c,entryTime:entryBar?iso(entryBar.t):null,entry,status:'CONFIRMED',outcomes});
  }
 }
 const totals=new Map<string,{pattern:string;side:string;events:number;resolved:number;correct:number;sumDirectionalPct:number}>();
 const mainHorizon=interval==='1h'?24:interval==='4h'?6:1;
 for(const e of events){const key=e.pattern+':'+e.side;let x=totals.get(key);if(!x){x={pattern:e.pattern,side:e.side,events:0,resolved:0,correct:0,sumDirectionalPct:0};totals.set(key,x);}x.events++;const o=e.outcomes[String(mainHorizon)] as {status:string;directionCorrect?:boolean;directionalReturnPct?:number};if(o.status==='RESOLVED'){x.resolved++;x.correct+=Number(o.directionCorrect);x.sumDirectionalPct+=o.directionalReturnPct??0;}}
 const summary=[...totals.values()].map(x=>({pattern:x.pattern,side:x.side,events:x.events,resolved:x.resolved,pending:x.events-x.resolved,accuracyPct:x.resolved?round(x.correct/x.resolved*100):null,avgDirectionalReturnPct:x.resolved?round(x.sumDirectionalPct/x.resolved):null})).sort((a,b)=>b.events-a.events);
 return {scannedCheckpoints:scanned,totalEvents:events.length,mainHorizonBars:mainHorizon,summary,events:events.slice(-maxEvents)};
}
export async function chartLearningCoin(coin:string,interval:Interval='4h',maxEvents=30){
 if(!(COINS as readonly string[]).includes(coin))throw new Error('INVALID_COIN');
 if(!['1h','4h','1d'].includes(interval))throw new Error('INVALID_INTERVAL');
 maxEvents=Math.max(0,Math.min(100,Math.floor(maxEvents)||0));
 const data=await fetchClosed(coin,interval,400),q=quality(data);const {last3,...cleanQuality}=q;
 if(!q.ready||data.closed.length<100)return {success:false,error:'DATA_NOT_READY',quality:cleanQuality};
 const result=observations(coin,interval,data.closed,maxEvents);
 return {success:true,module:'SWING_HUNTER_V1_8_CHART_PATTERN_LEARNING',mode:'SHADOW_READ_ONLY',trading:false,d1_writes:0,trained_model:false,coin,interval,quality:cleanQuality,method:{independentPatterns:true,patternCatalog:'V1.6',signal:'CLOSED_BAR_ONLY',entry:'NEXT_BAR_OPEN',horizonsBars:HORIZONS[interval],mainHorizonBars:result.mainHorizonBars,selection:'EVERY_DETECTED_PATTERN_NO_ONE_POSITION_FILTER',dedup:'COIN_INTERVAL_PATTERN_SIGNAL_BAR',forwardLabel:'CLOSE_AT_HORIZON',costs:'NOT_INCLUDED',caveats:['Pattern recognition uses predefined deterministic detectors, not an ML model','Daily frame reuses the same detector formulas, not independently validated for daily','Patterns can overlap; observations are correlated','Pending outcomes are not treated as losses','Only 400 candles; no persisted historical learning','This is a labeled research dataset, not a probability forecast']},...result};
}
export async function chartLearningMarket(offset=0,limit=2,interval:Interval='4h'){
 offset=Math.max(0,Math.min(COINS.length,Math.floor(offset)||0));limit=Math.max(1,Math.min(2,Math.floor(limit)||1));
 const results:unknown[]=[];
 for(const coin of COINS.slice(offset,offset+limit)){
  try{const x=await chartLearningCoin(coin,interval,0);results.push({coin,success:x.success,quality:x.quality,summary:'summary' in x?x.summary:[],totalEvents:'totalEvents' in x?x.totalEvents:0,error:'error' in x?x.error:null});}
  catch(e){results.push({coin,success:false,error:e instanceof Error?e.message:String(e)});}
 }
 return {success:true,module:'SWING_HUNTER_V1_8_CHART_LEARNING_MARKET',mode:'SHADOW_READ_ONLY',d1_writes:0,interval,offset,nextOffset:offset+limit<COINS.length?offset+limit:null,totalCoins:COINS.length,results};
}
