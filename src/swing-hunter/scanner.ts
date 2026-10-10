import {COINS,fetchClosed,quality} from './ohlcv';
import {structure} from './market-structure';
import {detectBreakout} from './patterns';
import {decide} from './decision-engine';
import type {Candle,Direction,Structure} from './types';

const round=(x:number|null,d=4)=>x===null||!Number.isFinite(x)?null:Number(x.toFixed(d));
function setup(c:Candle[],s:Structure){
  const last=c[c.length-1],prior=c.slice(-21,-1);
  const high=Math.max(...prior.map(x=>x.h)),low=Math.min(...prior.map(x=>x.l));
  const avgVolume=prior.reduce((sum,x)=>sum+x.v,0)/prior.length;
  const volumeRatio=avgVolume>0?last.v/avgVolume:null;
  const longDistance=(high-last.c)/s.atr14;
  const shortDistance=(last.c-low)/s.atr14;
  const preferred:Direction=s.direction==='NEUTRAL'?(Math.abs(longDistance)<Math.abs(shortDistance)?'LONG':'SHORT'):s.direction;
  const distanceAtr=preferred==='LONG'?longDistance:shortDistance;
  const breakout=detectBreakout(c,s);
  const reasons:string[]=[];
  if(!breakout)reasons.push('NO_CLOSED_20_BAR_BREAKOUT');
  if(breakout&&!breakout.confirmed)reasons.push('BREAKOUT_NOT_CONFIRMED');
  if(volumeRatio===null||volumeRatio<1.2)reasons.push('VOLUME_RATIO_BELOW_1_20');
  if(s.direction==='NEUTRAL')reasons.push('TREND_NEUTRAL');
  const near=distanceAtr>=0&&distanceAtr<=0.5;
  if(near)reasons.push('NEAR_BREAKOUT_WITHIN_0_5_ATR');
  return {trend:s.direction,close:round(last.c,6),closeTime:new Date(last.t).toISOString(),atrPct:round(s.atrPct,3),support:round(s.support,6),resistance:round(s.resistance,6),volumeRatio:round(volumeRatio,3),preferredSide:preferred,distanceToBreakoutATR:round(distanceAtr,3),nearBreakout:near,pattern:breakout,reasons};
}
async function analyzeCoin(coin:string){
  try{
    const [h1,h4,d1]=await Promise.all([fetchClosed(coin,'1h'),fetchClosed(coin,'4h'),fetchClosed(coin,'1d')]);
    const sets=[h1,h4,d1],checks=sets.map(x=>{const {last3,...rest}=quality(x);return rest;});
    if(checks.some(x=>!x.ready))return {coin,status:'DATA_NOT_READY',quality:checks};
    const [s1,s4,sd]=sets.map(x=>structure(x.closed));
    const p1=setup(h1.closed,s1),p4=setup(h4.closed,s4);
    const candidate=decide(coin,h1,h4,d1);
    const align1=p1.preferredSide===s4.direction&&p1.preferredSide===sd.direction;
    const align4=p4.preferredSide===sd.direction;
    const near=p1.nearBreakout||p4.nearBreakout;
    const status=candidate.status==='CANDIDATE'?'CANDIDATE':near?'NEAR_SIGNAL':'NO_SIGNAL';
    const blockers:string[]=[];
    if(!align1&&!align4)blockers.push('HIGHER_TIMEFRAME_MISMATCH');
    if(!p1.pattern&&!p4.pattern)blockers.push('NO_CONFIRMED_RANGE_BREAKOUT');
    if(p1.volumeRatio!==null&&p1.volumeRatio<1.2&&p4.volumeRatio!==null&&p4.volumeRatio<1.2)blockers.push('LOW_VOLUME_ON_BOTH_FRAMES');
    return {coin,status,nearDiagnosticOnly:near&&candidate.status!=='CANDIDATE',mode:candidate.mode,side:candidate.side,quality:checks,trend:{'1h':s1.direction,'4h':s4.direction,'1d':sd.direction},setups:{'1h':p1,'4h':p4},blockers,candidate};
  }catch(e){return {coin,status:'ERROR',error:e instanceof Error?e.message:String(e)};}
}
export async function scanMarket(){
  const started=Date.now();const results:Awaited<ReturnType<typeof analyzeCoin>>[]=[];
  // Three coins concurrently (up to nine upstream candle requests). No D1 calls.
  for(let i=0;i<COINS.length;i+=3){
    const batch=await Promise.all(COINS.slice(i,i+3).map(coin=>analyzeCoin(coin)));
    results.push(...batch);
  }
  const counts:Record<string,number>={};for(const r of results)counts[r.status]=(counts[r.status]||0)+1;
  const blockerCounts:Record<string,number>={};for(const r of results){if('blockers' in r && Array.isArray(r.blockers))for(const b of r.blockers)blockerCounts[b]=(blockerCounts[b]||0)+1;}
  const priority=(s:string)=>s==='CANDIDATE'?0:s==='NEAR_SIGNAL'?1:s==='NO_SIGNAL'?2:s==='DATA_NOT_READY'?3:4;
  results.sort((a,b)=>priority(a.status)-priority(b.status)||(('setups' in a && a.setups)?Math.min(a.setups['1h'].distanceToBreakoutATR??999,a.setups['4h'].distanceToBreakoutATR??999):999)-(('setups' in b && b.setups)?Math.min(b.setups['1h'].distanceToBreakoutATR??999,b.setups['4h'].distanceToBreakoutATR??999):999)||a.coin.localeCompare(b.coin));
  return {success:true,module:'SWING_HUNTER_V1_2_MULTI_COIN_SCAN',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,scan_time:new Date().toISOString(),duration_ms:Date.now()-started,coins_requested:COINS.length,counts,blockerCounts,notes:['NEAR_SIGNAL is diagnostic only, not an executable trade','No historical persistence or automatic scheduling','Up to 60 Hyperliquid candle requests per full scan'],results};
}
