import {safeFetchClosed} from './stability';
import {quality,STEP,COINS} from './ohlcv';
import {structure} from './market-structure';
import {detectBreakout} from './patterns';
import {decide} from './decision-engine';
import type {Candle,CandleSet} from './types';

// Historical accuracy audit. No execution, no D1 writes, no change to the decision engine.
const trim=(x:CandleSet,cutoff:number):CandleSet=>({...x,closed:x.closed.filter(c=>c.t+STEP[x.interval]<=cutoff)});
const iso=(n:number)=>new Date(n).toISOString();
const sum=(x:Record<string,number>,k:string)=>{x[k]=(x[k]||0)+1;};
export async function auditCoin(coin:string){
 if(!(COINS as readonly string[]).includes(coin))throw new Error('INVALID_COIN');
 const [h1,h4,d1]=await Promise.all([safeFetchClosed(coin,'1h',400),safeFetchClosed(coin,'4h',400),safeFetchClosed(coin,'1d',400)]);
 const qs=[h1,h4,d1].map(x=>{const {last3,...q}=quality(x);return q;});
 if(qs.some(q=>!q.ready))return {success:false,module:'SWING_HUNTER_V1_5_ACCURACY_AUDIT',coin,error:'DATA_NOT_READY',quality:qs};
 const start=Math.max(0,h1.closed.length-224),end=h1.closed.length-24,mid=Math.floor((start+end)/2);
 const counts:Record<string,number>={};const differences:any[]=[];const examples:any[]=[];
 const productionCandidates:any[]=[];const researchCandidates:any[]=[];
 let evaluated=0,lookaheadViolations=0,entryMismatches=0,productionIntraday=0,productionSwing=0;
 for(let i=start;i<end;i++){
  const bar=h1.closed[i],cutoff=bar.t+STEP['1h'];
  const a=trim(h1,cutoff),b=trim(h4,cutoff),d=trim(d1,cutoff);
  if([a,b,d].some(x=>x.closed.length<60)){sum(counts,'INSUFFICIENT_HISTORY');continue;}
  evaluated++;
  // Check each timeframe's most recent bar is fully closed by this historical cutoff.
  const latest=[a,b,d].map(x=>({interval:x.interval,open:iso(x.closed[x.closed.length-1].t),close:iso(x.closed[x.closed.length-1].t+STEP[x.interval])}));
  if([a,b,d].some(x=>x.closed.some(c=>c.t+STEP[x.interval]>cutoff)))lookaheadViolations++;
  const next=h1.closed[i+1];if(!next||next.t!==cutoff)entryMismatches++;
  const prod=decide(coin,a,b,d);
  if(prod.status==='CANDIDATE'){
   sum(counts,'PRODUCTION_CANDIDATE');
   if(prod.mode==='INTRADAY')productionIntraday++;else if(prod.mode==='SWING')productionSwing++;
   if(productionCandidates.length<40)productionCandidates.push({signalCloseTime:iso(cutoff),mode:prod.mode,side:prod.side,referenceEntry:prod.entry,actualNextOpen:next?.o??null});
  }
  // V1.4 independent 1H research predicate, deliberately WITHOUT candle-body requirement.
  const x=a.closed,last=x[x.length-1],prior=x.slice(-21,-1);
  const hi=Math.max(...prior.map(c=>c.h)),lo=Math.min(...prior.map(c=>c.l));
  const avg=prior.reduce((v,c)=>v+c.v,0)/20;
  const side=last.c>hi?'LONG':last.c<lo?'SHORT':null;
  const ratio=avg>0?last.v/avg:0;
  const t1=structure(a.closed).direction,t4=structure(b.closed).direction,td=structure(d.closed).direction;
  const researchOriginal=!!side&&ratio>=1.2&&side===t1&&side===t4&&side===td;
  const researchRelaxed=!!side&&ratio>=1.2&&side===t1&&(side===t4||side===td);
  const bodyConfirmed=!!side&&(side==='LONG'?last.c>last.o:last.c<last.o);
  const pattern=detectBreakout(a.closed,structure(a.closed));
  const prodIntraday=prod.status==='CANDIDATE'&&prod.mode==='INTRADAY';
  if(researchOriginal)sum(counts,'RESEARCH_ORIGINAL_RAW_CHECKPOINT');
  if(researchRelaxed)sum(counts,'RESEARCH_RELAXED_RAW_CHECKPOINT');
  if(researchOriginal&&!bodyConfirmed)sum(counts,'RESEARCH_ORIGINAL_MISSING_CANDLE_BODY');
  if(researchOriginal&&!prodIntraday){sum(counts,'RESEARCH_ORIGINAL_NOT_PRODUCTION_INTRADAY');
   if(differences.length<30)differences.push({cutoff:iso(cutoff),side,volumeRatio:Number(ratio.toFixed(3)),bodyConfirmed,patternConfirmed:pattern?.confirmed??false,productionStatus:prod.status,productionMode:prod.mode,productionReason:prod.reason});
  }
  if(prodIntraday&&!researchOriginal)sum(counts,'PRODUCTION_INTRADAY_NOT_RESEARCH_ORIGINAL');
  if(researchOriginal&&researchCandidates.length<40)researchCandidates.push({signalCloseTime:iso(cutoff),nextOpenTime:next?iso(next.t):null,side,split:i<mid?'TRAIN':'TEST',bodyConfirmed,productionIntraday:prodIntraday});
  if(examples.length<5&&(researchOriginal||prod.status==='CANDIDATE'))examples.push({signalBarOpen:iso(bar.t),signalBarClose:iso(cutoff),nextBarOpen:next?iso(next.t):null,allFramesLatest:latest,entryAtNextOpen:next?.o??null});
 }
 return {success:true,module:'SWING_HUNTER_V1_5_ACCURACY_AUDIT',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,coin,quality:qs,
  auditWindow:{startSignalBarOpen:iso(h1.closed[start].t),endSignalBarOpen:iso(h1.closed[end-1].t),checkpoints:end-start,evaluated,trainTestBoundarySignalBarOpen:iso(h1.closed[mid].t),outcomeReserveHours:24},
  timestampSemantics:{candleTime:'OPEN_TIMESTAMP',signalTime:'SIGNAL_BAR_CLOSE_TIMESTAMP',entryTime:'NEXT_BAR_OPEN_TIMESTAMP',equalSignalAndEntryTimeIsExpected:true,entryPrice:'NEXT_BAR_OPEN',lookaheadViolations,entryMismatches,examples},
  counts:{...counts,productionIntraday,productionSwing},
  discrepancySamples:differences,productionCandidateSamples:productionCandidates,researchOriginalSamples:researchCandidates,
  comparability:{sameCheckpointWindow:true,decisionEngine:'src/swing-hunter/decision-engine.ts',researchFilter:'V1.4 independent 1H predicate',note:'Raw checkpoint counts are NOT deduplicated trades. V1.4 deduplicates by 24 hours; production may emit SWING 4H candidates that the V1.4 1H-only simulator does not model.'},
  notes:['No trading or database operations','No TP/SL parameter changes','Checks candle CLOSE times rather than OPEN timestamps to prevent historical higher-timeframe lookahead','Production pattern additionally requires bullish/bearish candle body; independent V1.4 predicate does not']};
}
