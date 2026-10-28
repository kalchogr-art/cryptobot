/** SWING EARLY HUNTER — shadow-only, no orders, no execution imports.
 * Deploy as src/swing-hunter/swing-early-scanner.ts.
 * Call runSwingEarlyCycle(env, offset, limit) from a 5-minute cron.
 * D1 schema: swing-early-signals-schema.sql, on env.DB (same as LIVE monitor).
 */
import type { Candle } from './types';
import { COINS, STEP } from './ohlcv';
import { structure } from './market-structure';
import { detectCatalog, PatternCompareV2, detectClassicalCatalog } from './pattern-catalog';

type Env = { DB?: any; SWING_DB?: any };
type Frame = '1h' | '4h';
const HOUR = 3600000;
const MAX_TRACK = 12 * HOUR;
const LIMIT_CANDLES = 160;
const MAX_1M_BARS_PER_RUN = 180;
const nowMs = () => Date.now();
const numeric = (x: unknown) => Number(x);
function db(env: Env) { if (!env.DB?.prepare) throw Error('EARLY_DB_BINDING_MISSING'); return env.DB; }
function valid(c: Candle) { return [c.t,c.o,c.h,c.l,c.c,c.v].every(Number.isFinite) && c.o>0 && c.c>0 && c.l>0 && c.h>=Math.max(c.o,c.c,c.l) && c.l<=Math.min(c.o,c.c,c.h) && c.v>=0; }
async function candles(coin:string, interval:Frame|'1m',start:number,end:number):Promise<Candle[]> {
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
 try {
  const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin,interval,startTime:start,endTime:end}}),signal:ctrl.signal});
  if(!r.ok)throw Error('HYPERLIQUID_'+r.status);
  const raw=await r.json();if(!Array.isArray(raw))throw Error('INVALID_CANDLE_RESPONSE');
  return raw.map((x:any)=>({t:numeric(x.t),o:numeric(x.o),h:numeric(x.h),l:numeric(x.l),c:numeric(x.c),v:numeric(x.v),n:numeric(x.n)})).filter(valid).sort((a:Candle,b:Candle)=>a.t-b.t);
 } finally {clearTimeout(timer);}
}
function patternHits(bars:Candle[],interval:Frame){
 const market=structure(bars);
 return [
  ...detectCatalog(bars,market,interval),
  ...PatternCompareV2.detectCatalog(bars,market,interval).map(h=>({...h,id:'V2_'+h.id})),
  ...detectClassicalCatalog(bars,market,interval)
 ];
}
async function scanOne(env:Env,coin:string,interval:Frame,at:number){
 const step=STEP[interval],barOpen=Math.floor(at/step)*step;
 const series=await candles(coin,interval,barOpen-step*(LIMIT_CANDLES+5),at);
 const current=series.find(c=>c.t===barOpen);
 const completed=series.filter(c=>c.t<barOpen).slice(-LIMIT_CANDLES);
 if(!current || completed.length<60)return {coin,interval,status:'NOT_READY',count:0};
 if(completed.some((c,i)=>i>0&&c.t-completed[i-1].t!==step))return {coin,interval,status:'GAPPED_HISTORY',count:0};
 const hits=patternHits([...completed,current],interval);
 const d=db(env);let inserted=0,updated=0;
 for(const h of hits){
  if(h.signalBarOpen!==barOpen)continue;
  const key=['EARLY',coin,interval,h.side,h.id,barOpen].join(':');
  const first=await d.prepare(`INSERT OR IGNORE INTO swing_early_signals
   (signal_key,coin,side,interval,pattern,signal_bar_open,first_seen_at,last_seen_at,entry_price,tp_pct,sl_pct,status,observations,market_regime,observation_note)
   VALUES (?,?,?,?,?,?,?,?,?,0.5,1,'TRACKING',1,?,?)`)
   .bind(key,coin,h.side,interval,h.id,barOpen,at,at,current.c,null,'PROVISIONAL_FORMING_CANDLE').run();
  if(Number(first.meta?.changes||0)>0)inserted++;
  else {await d.prepare(`UPDATE swing_early_signals SET last_seen_at=?,observations=observations+1 WHERE signal_key=?`).bind(at,key).run();updated++;}
 }
 return {coin,interval,status:'OK',hits:hits.length,inserted,updated};
}
// First-touch resolution uses only fully CLOSED 1-minute candles strictly AFTER first detection.
// Gaps or both barriers touched within the same minute remain UNKNOWN, never guessed.
async function trackOne(env:Env,row:any,at:number){
 const d=db(env),entry=Number(row.entry_price),side=String(row.side),start=Number(row.first_seen_at);
 if(!Number.isFinite(entry)||entry<=0)return;
 const expiry=start+MAX_TRACK,until=Math.min(at,expiry);
 const first=Math.floor(start/60000)*60000+60000;
 const from=Math.max(first,Number(row.tracking_checked_until||first));
 const untilPage=Math.min(until,from+MAX_1M_BARS_PER_RUN*60000);
 if(untilPage<=from)return;
 const rows=await candles(String(row.coin),'1m',from-60000,untilPage);
 const full=rows.filter(c=>c.t>=from&&c.t+60000<=untilPage);
 const tp=side==='LONG'?entry*1.005:entry*0.995;
 const sl=side==='LONG'?entry*0.99:entry*1.01;
 let status:string|null=null,price:number|null=null,time:number|null=null;
 // If there are more bars than can be safely inspected, wait for a separate tracking cycle.
 // No outcome may be inferred from partial coverage of earlier time.
 let expected=from;
 for(const c of full){
  if(c.t!==expected){status='UNKNOWN';time=c.t;break;}
  expected+=60000;
  const hitTp=side==='LONG'?c.h>=tp:c.l<=tp;
  const hitSl=side==='LONG'?c.l<=sl:c.h>=sl;
  if(hitTp&&hitSl){status='UNKNOWN';time=c.t+60000;break;}
  if(hitTp||hitSl){status=hitTp?'WOULD_TP':'WOULD_SL';price=hitTp?tp:sl;time=c.t+60000;break;}
 }
 if(!status && expected<untilPage){status='UNKNOWN';time=expected;}
 if(!status && untilPage>=expiry){status='UNKNOWN';time=expiry;}
 if(!status)await d.prepare(`UPDATE swing_early_signals SET tracking_checked_until=? WHERE signal_key=? AND status='TRACKING'`).bind(expected,row.signal_key).run();
 if(status)await d.prepare(`UPDATE swing_early_signals SET status=?,outcome_at=?,exit_price=?,minutes_to_outcome=?,observation_note=? WHERE signal_key=? AND status='TRACKING'`)
  .bind(status,time,price,time!==null?(time-start)/60000:null,status==='UNKNOWN'?'UNKNOWN_NO_PROVABLE_FIRST_TOUCH':'FIRST_TOUCH_1M',row.signal_key).run();
}
async function track(env:Env,at:number,limit=30){
 const q=await db(env).prepare(`SELECT signal_key,coin,side,entry_price,first_seen_at,tracking_checked_until FROM swing_early_signals WHERE status='TRACKING' ORDER BY first_seen_at ASC LIMIT ?`).bind(limit).all();
 const errors:string[]=[];let processed=0;
 for(const row of q.results||[]){try{await trackOne(env,row,at);processed++;}catch(e:any){errors.push(String(row.signal_key)+':'+String(e?.message||e));}}
 return {processed,errors};
}
// Confirmation uses exact candle+coin+interval+side+pattern identity. Blocking is independent.
// An unmatched LIVE row is NOT a definitive NO until a grace window has passed.
async function reconcile(env:Env,at:number,limit=60){
 const d=db(env),signalsDb=env.SWING_DB?.prepare?env.SWING_DB:d;
 const q=await d.prepare(`SELECT signal_key,coin,side,interval,pattern,signal_bar_open FROM swing_early_signals
  WHERE live_checked_at IS NULL AND signal_bar_open + CASE interval WHEN '1h' THEN 3600000 ELSE 14400000 END + 300000 <= ?
  ORDER BY signal_bar_open ASC LIMIT ?`).bind(at,limit).all();
 let checked=0;const errors:string[]=[];
 for(const r of q.results||[]){
  try{
   const match=await signalsDb.prepare(`SELECT id,reference_price,signal_available_at FROM swing_context_signals WHERE coin=? AND side=? AND interval=? AND signal_bar_open=? AND pattern=? ORDER BY signal_available_at ASC LIMIT 1`)
    .bind(r.coin,r.side,r.interval,r.signal_bar_open,r.pattern).first();
   const rejected=await d.prepare(`SELECT reasons_json FROM swing_rejected_signals WHERE coin=? AND side=? AND interval=? AND pattern=? AND rejected_at>=? AND rejected_at<? ORDER BY rejected_at DESC LIMIT 1`)
    .bind(r.coin,r.side,r.interval,r.pattern,Number(r.signal_bar_open)+STEP[r.interval as Frame],Number(r.signal_bar_open)+STEP[r.interval as Frame]+3600000).first();
   const blocked=!!rejected;
   const reason=rejected?.reasons_json||null;
   await d.prepare(`UPDATE swing_early_signals SET live_confirmed=?,live_blocked=?,live_block_reason=?,live_checked_at=?,live_entry_price=? WHERE signal_key=? AND live_checked_at IS NULL`)
    .bind(match?1:0,blocked?1:0,reason,at,match?.reference_price??null,r.signal_key).run();
   checked++;
  }catch(e:any){errors.push(String(r.signal_key)+':'+String(e?.message||e));}
 }
 return {checked,errors};
}
/** Call every 5m. Partition 20 coins in 4 batches of 5; run both frames per coin. */
export async function runSwingEarlyCycle(env:Env,offset=0,limit=5){
 const at=nowMs(),coins=COINS.slice(Math.max(0,offset),Math.max(0,offset)+Math.max(1,Math.min(limit,20)));
 const scanned:any[]=[],errors:string[]=[];
 for(const coin of coins)for(const frame of ['1h','4h'] as Frame[]){
  try{scanned.push(await scanOne(env,coin,frame,at));}
  catch(e:any){errors.push(coin+'/'+frame+':'+String(e?.message||e));}
 }
 const tracking=await track(env,at).catch((e:any)=>({processed:0,errors:[String(e?.message||e)]}));
 const live=await reconcile(env,at).catch((e:any)=>({checked:0,errors:[String(e?.message||e)]}));
 return {success:errors.length===0,mode:'SHADOW_ONLY',trading:false,at,offset,coins,scanned,tracking,live,errors};
}
