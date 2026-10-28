/** SWING EARLY HUNTER — shadow-only, no orders, no execution imports.
 * Deploy as src/swing-hunter/swing-early-scanner.ts.
 * Call runSwingEarlyCycle(env, offset, limit) from a 5-minute cron.
 * D1 schema: swing-early-signals-schema.sql, on env.DB (same as LIVE monitor).
 */
import type { Candle } from './types';
import { COINS, STEP } from './ohlcv';
import { structure } from './market-structure';
import { detectCatalog, PatternCompareV2, detectClassicalCatalog } from './pattern-catalog';


/** LIVE EARLY candidate rules. Historical snapshot: verify against deployed LIVE before use.
 * This module DOES NOT implement all LIVE execution gates. No trading imports.
 */
const SWING_SHORT_1H_RULES:Record<string,Record<string,{tp:number;sl:number}>>={
 LONG_REGIME:{
  RANGE_BREAKDOWN:{tp:2,sl:1.5},BREAKOUT_RETEST_SHORT:{tp:2,sl:1.5},
  DOUBLE_TOP:{tp:2,sl:1},V2_BEAR_ENGULF:{tp:2,sl:1.5},
  V2_SHOOTING_STAR:{tp:2,sl:1.5}
 },
 SHORT_REGIME:{
  SHOOTING_STAR:{tp:1.5,sl:1.5},BREAKOUT_RETEST_SHORT:{tp:2,sl:1.5},
  LIQUIDITY_SWEEP_HIGH:{tp:1.5,sl:1},TRIANGLE_DOWN:{tp:2,sl:1.5},
  EMA_PULLBACK_SHORT:{tp:2,sl:1.5}
 },
 NEUTRAL:{
  V2_DOUBLE_TOP:{tp:2,sl:0.75},DOUBLE_TOP:{tp:2,sl:1.5},
  V3_INVERSE_CUP_HANDLE:{tp:2,sl:0.5},VOLUME_EXPANSION_SHORT:{tp:2,sl:1.5},
  RANGE_BREAKDOWN:{tp:2,sl:1.5}
 }
};
// Selected 4H SHORT rules from resolved hypothetical scenarios.
// SHORT_REGIME intentionally has no 4H SHORT entries (all ranked averages negative).
const SWING_SHORT_4H_RULES:Record<string,Record<string,{tp:number;sl:number}>>={
 LONG_REGIME:{
  MOMENTUM_REVERSAL_SHORT:{tp:2,sl:0.3},
  BEAR_ENGULF:{tp:2,sl:1},
  LIQUIDITY_SWEEP_HIGH:{tp:2,sl:1.5}
 },
 NEUTRAL:{
  EMA_PULLBACK_SHORT:{tp:2,sl:1.5},
  TRIANGLE_DOWN:{tp:2,sl:1.5},
  MOMENTUM_REVERSAL_SHORT:{tp:2,sl:1.5},
  BEAR_ENGULF:{tp:0.5,sl:1}
 }
};
// Historical 1H LONG selections: market regime -> pattern -> TP/SL (percent).
// No change to SHORT or 4H. These are research-derived, not guaranteed returns.
const SWING_LONG_1H_RULES:Record<string,Record<string,{tp:number;sl:number}>>={
 LONG_REGIME:{
  V3_CUP_HANDLE:{tp:2,sl:1.5},V3_BULL_FLAG:{tp:2,sl:1},
  MOMENTUM_REVERSAL_LONG:{tp:2,sl:0.75},V3_TRIPLE_BOTTOM:{tp:0.5,sl:0.5},
  HAMMER:{tp:2,sl:0.3}
 },
 SHORT_REGIME:{
  TRIANGLE_UP:{tp:2,sl:0.75},V3_FALLING_WEDGE:{tp:1.5,sl:1.5},
  V2_BULL_ENGULF:{tp:0.75,sl:1.5},RANGE_BREAKOUT:{tp:2,sl:1.5},
  LIQUIDITY_SWEEP_LOW:{tp:2,sl:0.3}
 },
 NEUTRAL:{EMA_PULLBACK_LONG:{tp:1,sl:1}}
};
// Selected 4H LONG reversal only. Other 4H LONG patterns remain disabled.
// Historical hypothetical outcomes: LONG 5/6 TP, SHORT 15/18 TP; each cohort spans one day.
const SWING_LONG_4H_RULES:Record<string,Record<string,{tp:number;sl:number}>>={
 LONG_REGIME:{MOMENTUM_REVERSAL_LONG:{tp:2,sl:1}},
 SHORT_REGIME:{MOMENTUM_REVERSAL_LONG:{tp:1.5,sl:1.5}}
};

function pickLiveCandidate(regime:string,side:string,interval:'1h'|'4h',patterns:string[]){
 const rules=(side==='LONG'?(interval==='1h'?SWING_LONG_1H_RULES:SWING_LONG_4H_RULES):(interval==='1h'?SWING_SHORT_1H_RULES:SWING_SHORT_4H_RULES))[regime];
 if(!rules)return null;
 for(const [pattern,params] of Object.entries(rules)){if(patterns.includes(pattern))return {pattern,...params};}
 return null;
}

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
// Approximate LIVE market regime from information available NOW; no future data.
// This is a candidate filter, NOT proof all execution-side LIVE gates passed.
async function liveRegime(env:Env,at:number):Promise<string|null>{
 const d=env.SWING_DB?.prepare?env.SWING_DB:db(env);
 const hour=Math.floor(at/HOUR)*HOUR;
 const r=await d.prepare(`SELECT SUM(CASE WHEN side='LONG' THEN 1 ELSE 0 END) AS longs,
 SUM(CASE WHEN side='SHORT' THEN 1 ELSE 0 END) AS shorts FROM swing_context_signals
 WHERE interval='1h' AND side IN ('LONG','SHORT')
 AND signal_available_at>=? AND signal_available_at<?
 AND created_at IS NOT NULL AND unixepoch(created_at) IS NOT NULL
 AND unixepoch(created_at)*1000<=?`).bind(hour-24*HOUR,hour,at).first();
 const l=Number(r?.longs||0),s=Number(r?.shorts||0),total=l+s;
 if(total<10)return null;
 return l/total>=0.6?'LONG_REGIME':s/total>=0.6?'SHORT_REGIME':'NEUTRAL';
}
async function scanOne(env:Env,coin:string,interval:Frame,at:number){
 const step=STEP[interval],barOpen=Math.floor(at/step)*step;
 const series=await candles(coin,interval,barOpen-step*(LIMIT_CANDLES+5),at);
 const current=series.find(c=>c.t===barOpen);
 const completed=series.filter(c=>c.t<barOpen).slice(-LIMIT_CANDLES);
 if(!current || completed.length<60)return {coin,interval,status:'NOT_READY',count:0};
 if(completed.some((c,i)=>i>0&&c.t-completed[i-1].t!==step))return {coin,interval,status:'GAPPED_HISTORY',count:0};
 const hits=patternHits([...completed,current],interval).filter(h=>h.signalBarOpen===barOpen);
 // Fail closed when the LIVE regime is not available.
 const regime=await liveRegime(env,at);
 if(!regime)return {coin,interval,status:'LIVE_REGIME_UNAVAILABLE',hits:hits.length,inserted:0,updated:0};
 const d=db(env);let inserted=0,updated=0;
 // LIVE selects ONE ranked pattern per coin / side / candle, not every catalog hit.
 for(const side of ['LONG','SHORT']){
  const picked=pickLiveCandidate(regime,side,interval,hits.filter(h=>h.side===side).map(h=>h.id));
  if(!picked)continue;
  const key=['EARLY_LIVE_V2',coin,interval,side,picked.pattern,barOpen].join(':');
  const first=await d.prepare(`INSERT OR IGNORE INTO swing_early_signals
   (signal_key,coin,side,interval,pattern,signal_bar_open,first_seen_at,last_seen_at,entry_price,tp_pct,sl_pct,status,observations,market_regime,observation_note)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,'TRACKING',1,?,?)`)
   .bind(key,coin,side,interval,picked.pattern,barOpen,at,at,current.c,0.5,1,regime,'LIVE_RULE_CANDIDATE_FORMING_CANDLE;PROGRESSIVE_NOT_SIMULATED').run();
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
 const expiry=start+MAX_TRACK;
 // Never ask for the currently forming minute: only complete UTC 1m bars.
 const closedUntil=Math.floor(Math.min(at,expiry)/60000)*60000;
 const first=Math.floor(start/60000)*60000+60000;
 const saved=Number(row.tracking_checked_until);
 const from=Math.max(first,Number.isFinite(saved)&&saved>0?saved:first);
 const untilPage=Math.min(closedUntil,from+MAX_1M_BARS_PER_RUN*60000);
 if(untilPage<=from){
  if(at>=expiry)await d.prepare(`UPDATE swing_early_signals SET status='UNKNOWN',outcome_at=?,minutes_to_outcome=?,observation_note='EXPIRED_WITHOUT_PROVABLE_TOUCH' WHERE signal_key=? AND status='TRACKING'`).bind(expiry,(expiry-start)/60000,row.signal_key).run();
  return;
 }
 const rows=await candles(String(row.coin),'1m',from,untilPage);
 const full=rows.filter(c=>c.t>=from&&c.t+60000<=untilPage);
 const tpPct=Number(row.tp_pct),slPct=Number(row.sl_pct);
 if(!(tpPct>0&&slPct>0))return;
 const tp=side==='LONG'?entry*(1+tpPct/100):entry*(1-tpPct/100);
 const sl=side==='LONG'?entry*(1-slPct/100):entry*(1+slPct/100);
 let status:string|null=null,price:number|null=null,time:number|null=null;
 let expected=from,missing=false;
 for(const c of full){
  if(c.t<expected)continue;
  if(c.t!==expected){missing=true;break;}
  expected+=60000;
  const hitTp=side==='LONG'?c.h>=tp:c.l<=tp;
  const hitSl=side==='LONG'?c.l<=sl:c.h>=sl;
  if(hitTp&&hitSl){status='UNKNOWN';time=c.t+60000;break;}
  if(hitTp||hitSl){status=hitTp?'WOULD_TP':'WOULD_SL';price=hitTp?tp:sl;time=c.t+60000;break;}
 }
 // A missing candle can be a temporary API lag. Retry it on later cycles;
 // never skip the gap or falsely resolve a later touch as the first touch.
 if(!status && expected<untilPage)missing=true;
 if(!status && !missing && expected>from){
  await d.prepare(`UPDATE swing_early_signals SET tracking_checked_until=? WHERE signal_key=? AND status='TRACKING'`).bind(expected,row.signal_key).run();
 }
 if(!status && at>=expiry){status='UNKNOWN';time=expiry;}
 if(status)await d.prepare(`UPDATE swing_early_signals SET status=?,outcome_at=?,exit_price=?,minutes_to_outcome=?,observation_note=? WHERE signal_key=? AND status='TRACKING'`)
  .bind(status,time,price,time!==null?(time-start)/60000:null,status==='UNKNOWN'?'UNKNOWN_AMBIGUOUS_OR_EXPIRED':'FIRST_TOUCH_1M',row.signal_key).run();
}
async function track(env:Env,at:number,limit=30){
 const q=await db(env).prepare(`SELECT signal_key,coin,side,entry_price,tp_pct,sl_pct,first_seen_at,tracking_checked_until FROM swing_early_signals WHERE status='TRACKING' ORDER BY first_seen_at ASC LIMIT ?`).bind(limit).all();
 const errors:string[]=[];let processed=0;
 for(const row of q.results||[]){try{await trackOne(env,row,at);processed++;}catch(e:any){errors.push(String(row.signal_key)+':'+String(e?.message||e));}}
 return {processed,errors};
}
// Queue rows are only LIVE signal candidates, never evidence of a filled order.
// Reset old false positives created by the previous queue-based reconciliation.
// Do NOT alter actual execution, orders or ledger records.
async function reconcile(env:Env,at:number,limit=100){
 const d=db(env),liveDb=env.SWING_DB?.prepare?env.SWING_DB:d;
 const reset=await d.prepare(`UPDATE swing_early_signals SET live_confirmed=0,
  live_entry_price=NULL,live_blocked=NULL,live_checked_at=?,
  observation_note='QUEUE_ONLY_NOT_EXECUTED'
  WHERE signal_key LIKE 'EARLY_LIVE_V2:%' AND live_confirmed=1
  AND observation_note LIKE 'LIVE_QUEUE_MATCH:%'`).bind(at).run();
 const q=await d.prepare(`SELECT signal_key,coin,side,interval,pattern,signal_bar_open
 FROM swing_early_signals WHERE signal_key LIKE 'EARLY_LIVE_V2:%'
 AND (live_confirmed IS NULL OR live_confirmed=0)
 AND signal_bar_open + CASE interval WHEN '1h' THEN 3600000 ELSE 14400000 END <= ?
 ORDER BY signal_bar_open DESC LIMIT ?`).bind(at,limit).all();
 let queueCandidates=0,pending=0;const errors:string[]=[];
 for(const r of q.results||[]){
  try{
   const rows=await liveDb.prepare(`SELECT selected_pattern,status
    FROM swing_live_queue WHERE coin=? AND side=? AND signal_bar_open=?
    ORDER BY signal_available_at ASC LIMIT 20`)
    .bind(r.coin,r.side,r.signal_bar_open).all();
   const match=(rows.results||[]).find((x:any)=>String(x.selected_pattern)===String(r.pattern));
   if(!match){pending++;continue;}
   // A queue match is recorded for diagnostics only. No confirmed LIVE trade.
   await d.prepare(`UPDATE swing_early_signals SET live_confirmed=0,
    live_blocked=NULL,live_entry_price=NULL,live_checked_at=?,observation_note=?
    WHERE signal_key=? AND (live_confirmed IS NULL OR live_confirmed=0)`)
    .bind(at,'QUEUE_ONLY_NOT_EXECUTED:'+String(match.status),r.signal_key).run();
   queueCandidates++;
  }catch(e:any){errors.push(String(r.signal_key)+':'+String(e?.message||e));}
 }
 return {queueCandidates,pending,resetFalseConfirmations:Number(reset.meta?.changes||0),errors,
  notice:'Queue matches are NOT confirmed fills; live_confirmed stays false until a verified execution-ledger integration exists.'};
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
 return {success:errors.length===0&&tracking.errors.length===0&&live.errors.length===0,mode:'SHADOW_ONLY',trading:false,at,offset,coins,scanned,tracking,live,errors,notice:'LIVE FILTER CANDIDATES ONLY; queue match is NOT a filled trade; progressive simulation not implemented'};
}
