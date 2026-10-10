import {safeFetchClosed} from './stability';
import {quality,STEP} from './ohlcv';
import {structure} from './market-structure';
import {decide} from './decision-engine';
import type {Candle,CandleSet} from './types';
type Side='LONG'|'SHORT';
type Config={name:string;volume:number;alignment:'STRICT'|'RELAXED';range:number};
const configs:Config[]=[
 {name:'ORIGINAL',volume:1.2,alignment:'STRICT',range:20},
 {name:'A_VOLUME_1_0',volume:1.0,alignment:'STRICT',range:20},
 {name:'B_RELAXED_4H',volume:1.2,alignment:'RELAXED',range:20},
 {name:'C_RANGE_10',volume:1.2,alignment:'STRICT',range:10},
];
const trim=(x:CandleSet,cutoff:number):CandleSet=>({...x,closed:x.closed.filter(c=>c.t+STEP[x.interval]<=cutoff)});
function breakout(c:Candle[],range:number,volume:number){
 const last=c[c.length-1],prior=c.slice(-range-1,-1);
 const high=Math.max(...prior.map(x=>x.h)),low=Math.min(...prior.map(x=>x.l));
 const avg=prior.reduce((s,x)=>s+x.v,0)/prior.length;
 const ratio=avg>0?last.v/avg:0;
 const side:Side|null=last.c>high?'LONG':last.c<low?'SHORT':null;
 return {side,volumeRatio:ratio,volumePass:ratio>=volume,high,low};
}
async function dataset(coin:string){
 const [a,b,d]=await Promise.all([safeFetchClosed(coin,'1h',320),safeFetchClosed(coin,'4h',320),safeFetchClosed(coin,'1d',320)]);
 const checks=[a,b,d].map(x=>{const {last3,...q}=quality(x);return q;});
 if(checks.some(x=>!x.ready))throw new Error('DATA_NOT_READY');
 return {a,b,d,checks};
}
function analyze(coin:string,a:CandleSet,b:CandleSet,d:CandleSet,config:Config){
 const counts={checkpoints:0,rawBreakout1h:0,rawBreakout4h:0,volumePassed:0,trendPassed:0,alignmentPassed:0,finalSignals:0,originalDecisionCandidates:0};
 const samples:{time:string;frame:string;side:Side;volumeRatio:number}[]=[];
 const checkpoints=a.closed.slice(-101,-1);
 for(const bar of checkpoints){
  const cutoff=bar.t+STEP['1h'];
  const x=trim(a,cutoff),y=trim(b,cutoff),z=trim(d,cutoff);
  if([x,y,z].some(q=>q.closed.length<60))continue;
  counts.checkpoints++;
  const s1=structure(x.closed),s4=structure(y.closed),sd=structure(z.closed);
  const p1=breakout(x.closed,config.range,config.volume),p4=breakout(y.closed,config.range,config.volume);
  if(p1.side)counts.rawBreakout1h++;
  if(p4.side)counts.rawBreakout4h++;
  const eligible=[{frame:'1h',p:p1,trend:s1.direction,align:config.alignment==='STRICT'?(p1.side===s4.direction&&p1.side===sd.direction):(p1.side===s4.direction||p1.side===sd.direction)},
                  {frame:'4h',p:p4,trend:s4.direction,align:p4.side===sd.direction}];
  if(eligible.some(e=>e.p.side&&e.p.volumePass))counts.volumePassed++;
  if(eligible.some(e=>e.p.side&&e.p.volumePass&&e.p.side===e.trend))counts.trendPassed++;
  if(eligible.some(e=>e.p.side&&e.p.volumePass&&e.p.side===e.trend&&e.align))counts.alignmentPassed++;
  const chosen=eligible.find(e=>e.p.side&&e.p.volumePass&&e.p.side===e.trend&&e.align);
  if(chosen){counts.finalSignals++;if(samples.length<15)samples.push({time:new Date(cutoff).toISOString(),frame:chosen.frame,side:chosen.p.side as Side,volumeRatio:Number(chosen.p.volumeRatio.toFixed(3))});}
  if(config.name==='ORIGINAL'&&decide(coin,x,y,z).status==='CANDIDATE')counts.originalDecisionCandidates++;
 }
 return {config,counts,samples,note:'Independent simplified research filter; compare originalDecisionCandidates against finalSignals to detect logic divergence. Not a P/L backtest.'};
}
export async function researchCoin(coin:string){
 const {a,b,d,checks}=await dataset(coin);
 const result=analyze(coin,a,b,d,configs[0]);
 const latest={h1:{time:new Date(a.closed[a.closed.length-1].t).toISOString(),close:a.closed[a.closed.length-1].c},h4:{time:new Date(b.closed[b.closed.length-1].t).toISOString(),close:b.closed[b.closed.length-1].c},d1:{time:new Date(d.closed[d.closed.length-1].t).toISOString(),close:d.closed[d.closed.length-1].c}};
 return {success:true,module:'SWING_HUNTER_V1_3_RESEARCH',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,coin,quality:checks,latestClosedCandles:latest,diagnostics:result,notes:['Uses closed candles at each historical cutoff','Independent simplified filter may differ from production decision engine','No trade outcome or profit calculation']};
}
export async function compareCoin(coin:string){
 const {a,b,d,checks}=await dataset(coin);
 return {success:true,module:'SWING_HUNTER_V1_3_COMPARE',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,coin,quality:checks,variants:configs.map(c=>analyze(coin,a,b,d,c)),notes:['All variants are research-only and do not change live or Swing Hunter decision rules','Counts are checkpoint occurrences, not unique trades','No TP/SL/P&L calculation']};
}
