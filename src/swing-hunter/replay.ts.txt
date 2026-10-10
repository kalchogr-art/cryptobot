import {fetchClosed,quality,STEP} from './ohlcv';
import {decide} from './decision-engine';
import type {Candle,CandleSet,Interval} from './types';

/** Historical signal-frequency replay. Never looks at candles closing after the replay cutoff. */
export async function replayCoin(coin:string){
  const [h1,h4,d1]=await Promise.all([fetchClosed(coin,'1h',320),fetchClosed(coin,'4h',320),fetchClosed(coin,'1d',320)]);
  const checks=[h1,h4,d1].map(x=>{const {last3,...q}=quality(x);return q;});
  if(checks.some(x=>!x.ready))return {success:false,coin,error:'DATA_NOT_READY',quality:checks};
  const trim=(x:CandleSet,cutoff:number):CandleSet=>({...x,closed:x.closed.filter(c=>c.t+STEP[x.interval]<=cutoff)});
  const observations:{time:string;status:string;mode:string;side:string;entry:number|null;stop:number|null;target:number|null}[]=[];
  const counts:Record<string,number>={};
  // Last 100 historical closed hourly bars, excluding the latest to keep a forward-only replay.
  const checkpoints=h1.closed.slice(-101,-1);
  for(const bar of checkpoints){
    const cutoff=bar.t+STEP['1h'];
    const a=trim(h1,cutoff),b=trim(h4,cutoff),d=trim(d1,cutoff);
    if([a,b,d].some(x=>x.closed.length<60))continue;
    const c=decide(coin,a,b,d);
    counts[c.status]=(counts[c.status]||0)+1;
    if(c.status==='CANDIDATE')observations.push({time:new Date(cutoff).toISOString(),status:c.status,mode:c.mode,side:c.side,entry:c.entry,stop:c.stop,target:c.target});
  }
  return {success:true,module:'SWING_HUNTER_V1_2_HISTORICAL_REPLAY',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,coin,quality:checks,checkpoints_tested:Object.values(counts).reduce((a,b)=>a+b,0),counts,signals:observations,notes:['Historical signal-frequency diagnostic, NOT a backtest of P/L','Each checkpoint uses only candles already closed at that time','Signals on adjacent checkpoints may represent the same setup','No orders, no database writes']};
}
