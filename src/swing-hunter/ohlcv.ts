import type {Candle,CandleSet,Interval} from './types';
export const COINS = ['BTC','ETH','SOL','XRP','BNB','DOGE','AVAX','LINK','SUI','HYPE','ADA','LTC','BCH','AAVE','UNI','NEAR','OP','ARB','WIF','TRX'] as const;
export const STEP:Record<Interval,number>={'1h':3600000,'4h':14400000,'1d':86400000};
const number=(v:unknown)=>Number(v);
export async function fetchClosed(coin:string,interval:Interval,count=160):Promise<CandleSet>{
  coin=coin.toUpperCase();
  if(!(COINS as readonly string[]).includes(coin)) throw new Error('INVALID_COIN');
  if(!(interval in STEP)) throw new Error('INVALID_INTERVAL');
  if(!Number.isInteger(count)||count<60||count>400) throw new Error('COUNT_MUST_BE_60_TO_400');
  const now=Date.now(),step=STEP[interval];
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),12000);
  let response:Response;
  try{response=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin,interval,startTime:now-step*(count+5),endTime:now}}),signal:ctrl.signal});}finally{clearTimeout(timer);}
  if(!response.ok)throw new Error(`HYPERLIQUID_HTTP_${response.status}`);
  const raw:unknown=await response.json();if(!Array.isArray(raw))throw new Error('INVALID_HYPERLIQUID_RESPONSE');
  const mapped:Candle[]=raw.map((x:any)=>({t:number(x?.t),o:number(x?.o),h:number(x?.h),l:number(x?.l),c:number(x?.c),v:number(x?.v),n:number(x?.n)})).sort((a,b)=>a.t-b.t);
  const closed=mapped.filter(c=>Number.isFinite(c.t)&&c.t+step<=now).slice(-count);
  let invalid=0,gaps=0,duplicates=0;
  for(let i=0;i<closed.length;i++){
    const x=closed[i];if(![x.t,x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)||x.o<=0||x.c<=0||x.l<=0||x.h<Math.max(x.o,x.c,x.l)||x.l>Math.min(x.o,x.c,x.h)||x.v<0)invalid++;
    if(i){const delta=x.t-closed[i-1].t;if(delta===0)duplicates++;else if(delta>step)gaps+=Math.max(1,Math.round(delta/step)-1);else if(delta!==step)invalid++;}
  }
  return {coin,interval,closed,formingExcluded:mapped.length-mapped.filter(c=>Number.isFinite(c.t)&&c.t+step<=now).length,received:mapped.length,invalid,gaps,duplicates,requested:count};
}
export function quality(x:CandleSet){return {coin:x.coin,interval:x.interval,requested:x.requested,closed:x.closed.length,received:x.received,formingExcluded:x.formingExcluded,invalid:x.invalid,gaps:x.gaps,duplicates:x.duplicates,ready:x.closed.length>=60&&x.invalid===0&&x.gaps===0&&x.duplicates===0,earliest:x.closed.length?new Date(x.closed[0].t).toISOString():null,latest:x.closed.length?new Date(x.closed[x.closed.length-1].t).toISOString():null,last3:x.closed.slice(-3)};}
