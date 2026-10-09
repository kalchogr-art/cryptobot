import type {Candle,Structure} from './types';
const ema=(v:number[],p:number)=>{let x=v[0];const k=2/(p+1);for(let i=1;i<v.length;i++)x=v[i]*k+x*(1-k);return x;};
export function structure(c:Candle[]):Structure{
  if(c.length<60)throw new Error('INSUFFICIENT_CANDLES');
  const closes=c.map(x=>x.c),close=closes[closes.length-1],ema20=ema(closes,20),ema50=ema(closes,50);
  const tr=c.map((x,i)=>i===0?x.h-x.l:Math.max(x.h-x.l,Math.abs(x.h-c[i-1].c),Math.abs(x.l-c[i-1].c)));
  const atr14=tr.slice(-14).reduce((a,b)=>a+b,0)/14;
  const prev=c.slice(-21,-1),support=Math.min(...prev.map(x=>x.l)),resistance=Math.max(...prev.map(x=>x.h));
  const strength=Math.abs(ema20-ema50)/close*100;
  const direction=ema20>ema50&&close>ema20?'LONG':ema20<ema50&&close<ema20?'SHORT':'NEUTRAL';
  return {direction,ema20,ema50,atr14,atrPct:atr14/close*100,support,resistance,close,trendStrengthPct:strength,ready:true};
}
