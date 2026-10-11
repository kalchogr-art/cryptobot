/** V1.8.5: shadow-only TP/SL first-touch 24h; no real orders or D1 writes. */
import type {Candle,Interval} from './types';
import {COINS,fetchClosed,quality,STEP} from './ohlcv';
import {structure} from './market-structure';
import {detectCatalog} from './pattern-catalog';
type Side='LONG'|'SHORT';
type Result='TP_FIRST'|'SL_FIRST'|'AMBIGUOUS'|'TIME_EXIT'|'PENDING';
const TPS=[0.3,0.5,0.75,1,1.5,2],SLS=[0.3,0.5,0.75,1,1.5];
const COST=0.18,HORIZON=24*3600000;
const r=(n:number)=>Number(n.toFixed(6));
const iso=(t:number)=>new Date(t).toISOString();
const move=(s:Side,e:number,p:number)=>(s==='LONG'?p-e:e-p)/e*100;
const price=(s:Side,e:number,p:number,tp:boolean)=>r(e*(1+(s==='LONG'?1:-1)*(tp?1:-1)*p/100));
const hit=(s:Side,b:Candle,p:number,tp:boolean)=>s==='LONG'?(tp?b.h>=p:b.l<=p):(tp?b.l<=p:b.h>=p);
function compute(coin:string,interval:Interval,c:Candle[],limit:number){
 const step=STEP[interval],n=HORIZON/step;
 if(!Number.isInteger(n)||n<1)throw Error('UNSUPPORTED_INTERVAL');
 const events:any[]=[],seen=new Set<string>();
 let duplicates=0,missingNextBar=0,timestampMismatch=0;
 for(let i=Math.max(65,c.length-120);i<c.length;i++){
  const b=c[i],next=c[i+1],history=c.slice(0,i+1);
  const detected=detectCatalog(history,structure(history),interval==='1h'?'1h':'4h');
  for(const h of detected){
   const id=`${coin}:${interval}:${h.id}:${b.t}`;
   if(seen.has(id)){duplicates++;continue;}seen.add(id);
   if(h.signalBarOpen!==b.t){timestampMismatch++;continue;}
   if(!next||next.t!==b.t+step){missingNextBar++;continue;}
   const side=h.side as Side,e=next.o;
   if(!Number.isFinite(e)||e<=0)continue;
   const bars=c.slice(i+1,i+1+n);
   if(!bars.every((v,j)=>v.t===next.t+j*step))continue;
   const complete=bars.length===n;
   const scenarios=TPS.flatMap(tpPct=>SLS.map(slPct=>{
    const tpPrice=price(side,e,tpPct,true),slPrice=price(side,e,slPct,false);
    let result:Result=complete?'TIME_EXIT':'PENDING',first:Candle|undefined;
    for(const bar of bars){
     const tp=hit(side,bar,tpPrice,true),sl=hit(side,bar,slPrice,false);
     if(tp||sl){result=tp&&sl?'AMBIGUOUS':tp?'TP_FIRST':'SL_FIRST';first=bar;break;}
    }
    const net=result==='TP_FIRST'?r(tpPct-COST):result==='SL_FIRST'?r(-slPct-COST):
      result==='TIME_EXIT'&&bars.length?r(move(side,e,bars[bars.length-1].c)-COST):null;
    return {tpPct,slPct,tpPrice,slPrice,result,
     firstTouchBarOpen:first?iso(first.t):null,firstTouchBy:first?iso(first.t+step):null,
     earliestPossibleHours:first?r((first.t-next.t)/3600000):null,
     latestPossibleHours:first?r((first.t+step-next.t)/3600000):null,
     hypotheticalNetPct:net};
   }));
   events.push({id,marketEventId:`${coin}:${interval}:${b.t}:${side}`,
    pattern:h.id,side,strength:h.strength,signalBarOpen:iso(b.t),
    signalAvailableAt:iso(b.t+step),entryBarOpen:iso(next.t),marketEntry:e,
    horizonEnd:iso(next.t+HORIZON),windowComplete:complete,observedBars:bars.length,expectedBars:n,
    maxFavorablePct:bars.length?r(Math.max(0,...bars.map(x=>move(side,e,side==='LONG'?x.h:x.l)))):null,
    maxAdversePct:bars.length?r(Math.max(0,...bars.map(x=>-move(side,e,side==='LONG'?x.l:x.h)))):null,
    scenarios});
  }
 }
 function aggregate(items:any[]){
  return TPS.flatMap(tpPct=>SLS.map(slPct=>{
   const rows=items.map(x=>x.scenarios.find((s:any)=>s.tpPct===tpPct&&s.slPct===slPct));
   const count=(status:Result)=>rows.filter((s:any)=>s.result===status).length;
   const tpFirst=count('TP_FIRST'),slFirst=count('SL_FIRST'),ambiguous=count('AMBIGUOUS'),
    timeExit=count('TIME_EXIT'),pending=count('PENDING'),decided=tpFirst+slFirst+timeExit;
   const netRows=rows.filter((s:any)=>s.hypotheticalNetPct!==null);
   return {tpPct,slPct,signals:rows.length,tpFirst,slFirst,ambiguous,timeExit,pending,
    tpFirstRateDecidedPct:decided?r(tpFirst/decided*100):null,
    avgHypotheticalNetDecidedPct:netRows.length?r(netRows.reduce((a:number,s:any)=>a+s.hypotheticalNetPct,0)/netRows.length):null};
  }));
 }
 const groups=new Map<string,any[]>();
 for(const e of events){const k=e.pattern+':'+e.side;if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(e);}
 const byPattern=[...groups.values()].map(items=>({pattern:items[0].pattern,side:items[0].side,
  signals:items.length,uniqueMarketEvents:new Set(items.map(e=>e.marketEventId)).size,summary:aggregate(items)}));
 return {audit:{duplicatePatternKeys:duplicates,missingNextBar,detectorTimestampMismatch:timestampMismatch,
   pass:duplicates===0&&timestampMismatch===0},totalEvents:events.length,
  uniqueMarketEvents:new Set(events.map(e=>e.marketEventId)).size,
  summary:aggregate(events),byPattern,events:limit===0?[]:events.slice(-limit)};
}
export async function tpSlFirstTouchCoin(coin:string,interval:Interval='4h',limit=10){
 if(!(COINS as readonly string[]).includes(coin))throw Error('INVALID_COIN');
 if(!['1h','4h','1d'].includes(interval))throw Error('INVALID_INTERVAL');
 limit=Math.max(0,Math.min(30,Number.isFinite(limit)?Math.floor(limit):10));
 const data=await fetchClosed(coin,interval,400),q=quality(data);
 const {last3,...cleanQuality}=q;
 if(!q.ready||data.closed.length<100)return {success:false,error:'DATA_NOT_READY',quality:cleanQuality};
 return {success:true,module:'SWING_HUNTER_V1_8_5_TPSL_FIRST_TOUCH_24H',
  mode:'SHADOW_READ_ONLY',trading:false,d1_writes:0,coin,interval,quality:cleanQuality,
  method:{signal:'CLOSED_BAR_ONLY',entry:'NEXT_BAR_OPEN_MARKET_REFERENCE',
   horizonHours:24,tpTargetsPct:TPS,slTargetsPct:SLS,roundTripCostScenarioPct:COST,
   resultDefinition:'First TP vs SL touch in OHLC bars; NOT verified executable trade results',
   notes:['Same-bar TP and SL is AMBIGUOUS, never guessed',
    'TIME_EXIT uses 24h closing price minus hypothetical costs',
    'Level touch does not guarantee fill; no slippage or funding',
    'Overlapping pattern signals are correlated',
    'Detector internals not fully audited for look-ahead',
    'No LIVE trading, main Worker entry, D1 or strategy changes']},
  ...compute(coin,interval,data.closed,limit)};
}
