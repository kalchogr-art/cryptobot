import type {Candle,Pattern,Structure} from './types';
/** Conservative, objective breakout detector. Other named chart patterns are not claimed without validated algorithms. */
export function detectBreakout(c:Candle[],s:Structure):Pattern|null{
  if(c.length<60)return null;
  const last=c[c.length-1],prev=c.slice(-21,-1);
  const high=Math.max(...prev.map(x=>x.h)),low=Math.min(...prev.map(x=>x.l));
  const vols=prev.map(x=>x.v),avgVolume=vols.reduce((a,b)=>a+b,0)/vols.length;
  const volumeRatio=avgVolume>0?last.v/avgVolume:0;
  const long=last.c>high&&last.c>last.o,short=last.c<low&&last.c<last.o;
  if(!long&&!short)return null;
  const direction=long?'LONG':'SHORT';
  const confirmed=volumeRatio>=1.2&&s.direction===direction;
  return {name:'20_BAR_RANGE_BREAKOUT',direction,confirmed,breakoutLevel:long?high:low,stopReference:long?low:high,confidence:Math.round(Math.min(100,40+Math.min(30,volumeRatio*15)+(s.direction===direction?25:0))),explanation:`Closed candle range breakout; volume ratio ${volumeRatio.toFixed(2)}; ${confirmed?'trend aligned':'not fully confirmed'}`};
}
