/** Swing Hunter V1.9: bounded event-driven D1 logging. No trading endpoints. */
import type {Interval,Candle} from './types';
import {COINS,fetchClosed,quality,STEP} from './ohlcv';
import {structure} from './market-structure';
import {detectCatalog} from './pattern-catalog';
import {collectContext} from './context';
const TPS=[0.3,0.5,0.75,1,1.5,2],SLS=[0.3,0.5,0.75,1,1.5];
const pct=(side:string,e:number,p:number)=>(side==='LONG'?p-e:e-p)/e*100;
const round=(v:number)=>Number(v.toFixed(6));
function db(env:any){const d=env.SWING_DB;if(!d?.prepare)throw Error('MISSING_SWING_DB_BINDING');return d;}
export async function scanAndLog(env:any,opts:{offset?:number;limit?:number;interval?:Interval}={}){
 const d=db(env),interval=opts.interval||'1h';if(!['1h','4h','1d'].includes(interval))throw Error('INVALID_INTERVAL');
 const offset=Math.max(0,Math.min(19,Math.floor(opts.offset||0))),limit=Math.max(1,Math.min(5,Math.floor(opts.limit||3)));
 const coins=COINS.slice(offset,offset+limit),result:any[]=[];let inserts=0,duplicates=0,errors=0;
 for(const coin of coins){
  try{
   const x=await fetchClosed(coin,interval,160),q=quality(x),c=x.closed;
   if(!q.ready||c.length<65){result.push({coin,status:'DATA_NOT_READY'});continue;}
   const signal=c.at(-1)!;const found=detectCatalog(c,structure(c),interval==='1h'?'1h':'4h').filter(h=>h.signalBarOpen===signal.t);
   if(!found.length){result.push({coin,status:'NO_PATTERN',bar:new Date(signal.t).toISOString()});continue;}
   const newHits:any[]=[];
   for(const h of found){const id=`${coin}:${interval}:${h.id}:${signal.t}`;
    const existing=await d.prepare('SELECT id FROM swing_context_signals WHERE id=? LIMIT 1').bind(id).first();
    if(existing){duplicates++;continue;}newHits.push({h,id});
   }
   if(!newHits.length){result.push({coin,status:'ALREADY_LOGGED',patterns:found.length});continue;}
   // Fetch context ONCE per coin/candle, not once per pattern.
   const context=await collectContext(coin,interval,signal,env,{[interval]:c});
   for(const {h,id} of newHits){
    const out=await d.prepare(`INSERT OR IGNORE INTO swing_context_signals
      (id,coin,interval,pattern,side,signal_bar_open,signal_available_at,reference_price,strength,context_json,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,coin,interval,h.id,h.side,signal.t,signal.t+STEP[interval],signal.c,Number(h.strength)||0,JSON.stringify(context),'TRACKING',Date.now()).run();
    if((out.meta?.changes||0)>0)inserts++;else duplicates++;
   }
   result.push({coin,status:'LOGGED',patterns:newHits.map(x=>({pattern:x.h.id,side:x.h.side,id:x.id})),filterStatus:Object.fromEntries(Object.entries(context).filter(([k])=>['btcDirection','fearGreed','macroEvents','multiTimeframe','supportResistance','volume','indicators','liquiditySpread'].includes(k)).map(([k,v]:any)=>[k,v.status||'OK']))});
  }catch(e){errors++;result.push({coin,status:'ERROR',error:String(e)});}
 }
 return {success:errors===0,module:'SWING_HUNTER_V1_9_SIGNAL_LOGGER',mode:'RESEARCH_ONLY',trading:false,interval,offset,processed:coins.length,inserted:inserts,duplicates,errors,results:result};
}
export async function settleSignals(env:any,limit=12){
 const d=db(env),now=Date.now(),rows=await d.prepare(`SELECT id,coin,interval,side,signal_available_at,reference_price
  FROM swing_context_signals WHERE status='TRACKING' AND signal_available_at<=? ORDER BY signal_available_at ASC LIMIT ?`).bind(now,Math.max(1,Math.min(30,Math.floor(limit)))).all();
 const results:any[]=[];let reads=0,updates=0;
 for(const x of rows.results||[]){
  try{
   const interval=x.interval as Interval,step=STEP[interval];if(!step)throw Error('BAD_INTERVAL');
   const since=Number(x.signal_available_at),entry=Number(x.reference_price),side=String(x.side);
   if(!(entry>0))throw Error('BAD_ENTRY');
   const data=await fetchClosed(String(x.coin),interval,160);reads++;
   const bars=data.closed.filter((b:Candle)=>b.t>=since&&b.t<since+86400000).sort((a:Candle,b:Candle)=>a.t-b.t);
   const complete=now>=since+86400000&&bars.length===86400000/step&&bars.every((b:Candle,i:number)=>b.t===since+i*step);
   const scenarios=TPS.flatMap(tp=>SLS.map(sl=>{
    let status='PENDING',first:number|null=null;for(const b of bars){const hitTp=side==='LONG'?b.h>=entry*(1+tp/100):b.l<=entry*(1-tp/100);const hitSl=side==='LONG'?b.l<=entry*(1-sl/100):b.h>=entry*(1+sl/100);if(hitTp||hitSl){status=hitTp&&hitSl?'AMBIGUOUS':hitTp?'TP_FIRST':'SL_FIRST';first=b.t;break;}}
    if(status==='PENDING'&&complete)status='TIME_EXIT';
    const net=status==='TP_FIRST'?tp-0.18:status==='SL_FIRST'?-sl-0.18:status==='TIME_EXIT'?pct(side,entry,bars.at(-1)!.c)-0.18:null;
    return {tp,sl,status,firstTouchBarOpen:first===null?null:new Date(first).toISOString(),hypotheticalNetPct:net===null?null:round(net)};
   }));
   // All scenarios must be resolved or the 24h horizon completed.
   const done=scenarios.every(s=>s.status!=='PENDING');
   if(done){await d.prepare(`UPDATE swing_context_signals SET status='RESOLVED',outcome_json=?,resolved_at=? WHERE id=? AND status='TRACKING'`).bind(JSON.stringify({entryBasis:'SIGNAL_CLOSE_REFERENCE_NOT_EXECUTABLE_ENTRY',costPct:0.18,windowComplete:complete,scenarios}),now,x.id).run();updates++;}
   results.push({id:x.id,status:done?'RESOLVED':'TRACKING',observedBars:bars.length,windowComplete:complete});
  }catch(e){results.push({id:x.id,status:'ERROR',error:String(e)});}
 }
 return {success:true,module:'SWING_HUNTER_V1_9_OUTCOMES',trading:false,d1ReadRowsBound:limit,marketRequests:reads,updated:updates,results};
}
export async function recentSignals(env:any,limit=20,side?:string){const d=db(env),n=Math.max(1,Math.min(100,Math.floor(limit)));
 const rows=side==='LONG'||side==='SHORT'?await d.prepare('SELECT * FROM swing_context_signals WHERE side=? ORDER BY signal_bar_open DESC LIMIT ?').bind(side,n).all():await d.prepare('SELECT * FROM swing_context_signals ORDER BY signal_bar_open DESC LIMIT ?').bind(n).all();
 return {success:true,module:'SWING_HUNTER_V1_9_LOG',rows:(rows.results||[]).map((r:any)=>({...r,context:JSON.parse(r.context_json),outcome:r.outcome_json?JSON.parse(r.outcome_json):null,context_json:undefined,outcome_json:undefined})),limit:n};
}
