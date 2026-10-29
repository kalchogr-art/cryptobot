/** SWING EARLY V4 — predictive mirror of confirmed Swing signal selection.
 * Shadow only. Does not import execution, place orders, or change LIVE.
 * Replaces src/swing-hunter/swing-early-scanner.ts.
 * Existing swing_early_signals table is reused; legacy rows are untouched.
 */
import type {Candle} from './types';
import {STEP} from './ohlcv';
import {structure} from './market-structure';
import {detectCatalog,PatternCompareV2,detectClassicalCatalog} from './pattern-catalog';

type Frame='1h'|'4h';type Side='LONG'|'SHORT';
type Rule={tp:number;sl:number};type Rules=Record<string,Record<string,Rule>>;
type Env={DB?:any;SWING_DB?:any};
const HOUR=3600000;
// Exact ranked eligibility tables from execution.ts (29 October 2026 snapshot).
// IMPORTANT: synchronize on every LIVE rule change. No LIVE code is modified here.
const SHORT_1H:Rules={
 LONG_REGIME:{RANGE_BREAKDOWN:{tp:2,sl:1.5},BREAKOUT_RETEST_SHORT:{tp:2,sl:1.5},DOUBLE_TOP:{tp:2,sl:1},V2_BEAR_ENGULF:{tp:2,sl:1.5},V2_SHOOTING_STAR:{tp:2,sl:1.5}},
 SHORT_REGIME:{SHOOTING_STAR:{tp:1.5,sl:1.5},BREAKOUT_RETEST_SHORT:{tp:2,sl:1.5},LIQUIDITY_SWEEP_HIGH:{tp:1.5,sl:1},TRIANGLE_DOWN:{tp:2,sl:1.5},EMA_PULLBACK_SHORT:{tp:2,sl:1.5}},
 NEUTRAL:{V2_DOUBLE_TOP:{tp:2,sl:0.75},DOUBLE_TOP:{tp:2,sl:1.5},V3_INVERSE_CUP_HANDLE:{tp:2,sl:0.5},VOLUME_EXPANSION_SHORT:{tp:2,sl:1.5},RANGE_BREAKDOWN:{tp:2,sl:1.5}}
};
const SHORT_4H:Rules={
 LONG_REGIME:{MOMENTUM_REVERSAL_SHORT:{tp:2,sl:0.3},BEAR_ENGULF:{tp:2,sl:1},LIQUIDITY_SWEEP_HIGH:{tp:2,sl:1.5}},
 NEUTRAL:{EMA_PULLBACK_SHORT:{tp:2,sl:1.5},TRIANGLE_DOWN:{tp:2,sl:1.5},MOMENTUM_REVERSAL_SHORT:{tp:2,sl:1.5},BEAR_ENGULF:{tp:0.5,sl:1}}
};
const LONG_1H:Rules={
 LONG_REGIME:{V3_CUP_HANDLE:{tp:2,sl:1.5},V3_BULL_FLAG:{tp:2,sl:1},MOMENTUM_REVERSAL_LONG:{tp:2,sl:0.75},V3_TRIPLE_BOTTOM:{tp:0.5,sl:0.5},HAMMER:{tp:2,sl:0.3}},
 SHORT_REGIME:{TRIANGLE_UP:{tp:2,sl:0.75},V3_FALLING_WEDGE:{tp:1.5,sl:1.5},V2_BULL_ENGULF:{tp:0.75,sl:1.5},RANGE_BREAKOUT:{tp:2,sl:1.5},LIQUIDITY_SWEEP_LOW:{tp:2,sl:0.3}},
 NEUTRAL:{EMA_PULLBACK_LONG:{tp:1,sl:1}}
};
const LONG_4H:Rules={LONG_REGIME:{MOMENTUM_REVERSAL_LONG:{tp:2,sl:1}},SHORT_REGIME:{MOMENTUM_REVERSAL_LONG:{tp:1.5,sl:1.5}}};
function choose(regime:string,side:Side,frame:Frame,patterns:string[]){
 const rules=(side==='LONG'?(frame==='1h'?LONG_1H:LONG_4H):(frame==='1h'?SHORT_1H:SHORT_4H))[regime];
 if(!rules)return null;
 for(const [pattern,params] of Object.entries(rules))if(patterns.includes(pattern))return {pattern,...params};
 return null;
}
function db(env:Env){if(!env.DB?.prepare)throw Error('EARLY_DB_MISSING');return env.DB;}
function signalsDb(env:Env){if(!env.SWING_DB?.prepare)throw Error('SWING_DB_MISSING');return env.SWING_DB;}
function valid(c:Candle){return [c.t,c.o,c.h,c.l,c.c,c.v].every(Number.isFinite)&&c.o>0&&c.c>0&&c.l>0&&c.h>=Math.max(c.o,c.c,c.l)&&c.l<=Math.min(c.o,c.c,c.h)&&c.v>=0;}
async function fetchBars(coin:string,frame:Frame,at:number){
 const step=STEP[frame],start=Math.floor(at/step)*step-step*165;
 const ctrl=new AbortController(),timer=setTimeout(()=>ctrl.abort(),12000);
 try{
  const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin,interval:frame,startTime:start,endTime:at}}),signal:ctrl.signal});
  if(!r.ok)throw Error('HYPERLIQUID_'+r.status);
  const raw=await r.json();if(!Array.isArray(raw))throw Error('INVALID_OHLCV');
  const bars:Candle[]=raw.map((x:any)=>({t:Number(x.t),o:Number(x.o),h:Number(x.h),l:Number(x.l),c:Number(x.c),v:Number(x.v),n:Number(x.n)})).filter(valid).sort((a:Candle,b:Candle)=>a.t-b.t);
  if(bars.some((c,i)=>i>0&&c.t===bars[i-1].t))throw Error('DUPLICATE_BARS');
  return bars;
 }finally{clearTimeout(timer);}
}
// Byte-for-byte equivalent query criteria to execution.ts/swingLongRegimeAt.
async function liveRegime(env:Env,at:number){
 const hour=Math.floor(at/HOUR)*HOUR;
 const r:any=await signalsDb(env).prepare(`SELECT
 SUM(CASE WHEN side='LONG' THEN 1 ELSE 0 END) AS longs,
 SUM(CASE WHEN side='SHORT' THEN 1 ELSE 0 END) AS shorts
 FROM swing_context_signals WHERE interval='1h' AND side IN ('LONG','SHORT')
 AND signal_available_at>=? AND signal_available_at<?
 AND created_at IS NOT NULL AND unixepoch(created_at) IS NOT NULL
 AND unixepoch(created_at)*1000<=?`).bind(hour-24*HOUR,hour,at).first();
 const longs=Number(r?.longs??0),shorts=Number(r?.shorts??0),total=longs+shorts;
 if(total<10)return null;
 return longs/total>=.6?'LONG_REGIME':shorts/total>=.6?'SHORT_REGIME':'NEUTRAL';
}
function detect(bars:Candle[],frame:Frame){const market=structure(bars);return [
 ...detectCatalog(bars,market,frame),
 ...PatternCompareV2.detectCatalog(bars,market,frame).map(h=>({...h,id:'V2_'+h.id})),
 ...detectClassicalCatalog(bars,market,frame)
 ];}
// V4: potential-pattern watch begins BEFORE the LIVE detector becomes true.
// A watch is NOT a LIVE signal. Only a detector hit + LIVE rule is LIVE_ELIGIBLE.
// Existing D1 rows are retained; a dedicated table keeps full observation history.
const WATCH_PREFIX='EARLY_POTENTIAL_V4';
const VERSION='SWING_EARLY_CANDIDATE_CONSUMER_V5.3_ALL_ACTIVE';
const WATCH_WINDOW_MIN=20;
const FINALIZE_GRACE_MIN=35;
async function ensureSchema(env:Env){
 const d=db(env);
 await d.prepare(`CREATE TABLE IF NOT EXISTS swing_early_v4_watch (
  watch_key TEXT PRIMARY KEY, coin TEXT NOT NULL, interval TEXT NOT NULL,
  side TEXT NOT NULL, pattern TEXT NOT NULL, signal_bar_open INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL, first_eligible_at INTEGER,
  observations INTEGER NOT NULL DEFAULT 0, eligible_observations INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL, regime TEXT, reference_price REAL,
  live_source_confirmed INTEGER, live_selected INTEGER,
  live_queue_status TEXT, finalized_at INTEGER, note TEXT
 )`).run();
 await d.prepare(`CREATE INDEX IF NOT EXISTS idx_swing_early_v4_watch_pending
  ON swing_early_v4_watch(phase,signal_bar_open)`).run();
 await d.prepare(`CREATE TABLE IF NOT EXISTS swing_early_v4_observations (
  watch_key TEXT NOT NULL, observed_at INTEGER NOT NULL, phase TEXT NOT NULL,
  remaining_minutes REAL NOT NULL, reference_price REAL, regime TEXT,
  detector_hit INTEGER NOT NULL, note TEXT,
  PRIMARY KEY(watch_key,observed_at)
 )`).run();
}
function ruleTable(side:Side,frame:Frame):Rules{
 return side==='LONG'?(frame==='1h'?LONG_1H:LONG_4H):(frame==='1h'?SHORT_1H:SHORT_4H);
}
// "Potential" is explicitly a pre-detector heuristic, not a claim that the
// real LIVE detector would accept the candle. The detector is always the authority.
// We use only the current forming bar + preceding CLOSED bars, with no future data.
function formingCandidates(closed:Candle[],cur:Candle[],frame:Frame,regime:string){
 const c=cur[0],p=closed.at(-1)!;const prior=closed.slice(-20);
 const hi=Math.max(...prior.map(x=>x.h)),lo=Math.min(...prior.map(x=>x.l));
 const meanVolume=prior.reduce((sum,x)=>sum+x.v,0)/prior.length;
 const span=Math.max(c.h-c.l,c.c*0.000001),body=Math.abs(c.c-c.o);
 const upper=c.h-Math.max(c.c,c.o),lower=Math.min(c.c,c.o)-c.l;
 const patterns:Record<string,boolean>={
  RANGE_BREAKOUT:c.c>hi*0.998 && c.c>=c.o && body/span>=0.25,
  RANGE_BREAKDOWN:c.c<lo*1.002 && c.c<=c.o && body/span>=0.25,
  LIQUIDITY_SWEEP_LOW:c.l<lo && c.c>=lo*0.997 && lower/span>=0.25,
  LIQUIDITY_SWEEP_HIGH:c.h>hi && c.c<=hi*1.003 && upper/span>=0.25,
  MOMENTUM_REVERSAL_LONG:p.c<p.o && closed.at(-2)!.c<closed.at(-2)!.o && c.c>=p.h*0.997 && c.c>=c.o,
  MOMENTUM_REVERSAL_SHORT:p.c>p.o && closed.at(-2)!.c>closed.at(-2)!.o && c.c<=p.l*1.003 && c.c<=c.o,
  HAMMER:lower/span>=0.4 && c.c>=c.o,
  SHOOTING_STAR:upper/span>=0.4 && c.c<=c.o,
  BULL_ENGULF:p.c<p.o && c.c>=p.o*0.998 && c.c>c.o,
  BEAR_ENGULF:p.c>p.o && c.c<=p.o*1.002 && c.c<c.o,
  VOLUME_EXPANSION_SHORT:c.c<c.o && meanVolume>0 && c.v>=meanVolume*0.65,
  DOUBLE_TOP:c.c<p.c && c.h>=hi*0.997,
  DOUBLE_BOTTOM:c.c>p.c && c.l<=lo*1.003,
  V2_DOUBLE_TOP:c.c<p.c && c.h>=hi*0.997,
  V2_BEAR_ENGULF:p.c>p.o && c.c<=p.o*1.002 && c.c<c.o,
  V2_BULL_ENGULF:p.c<p.o && c.c>=p.o*0.998 && c.c>c.o,
  V2_SHOOTING_STAR:upper/span>=0.4 && c.c<=c.o
 };
 const result:{side:Side;pattern:string;phase:string;reason:string}[]=[];
 for(const side of ['LONG','SHORT'] as Side[]){
  const allowed=ruleTable(side,frame)[regime]||{};
  for(const pattern of Object.keys(allowed)){
   if(patterns[pattern])result.push({side,pattern,phase:'FORMING',reason:'EARLY_HEURISTIC_NOT_LIVE_DETECTOR'});
  }
 }
 return result;
}
async function record(env:Env,item:{coin:string;frame:Frame;side:Side;pattern:string;barOpen:number;at:number;phase:string;regime:string;price:number;remaining:number;reason:string}){
 const d=db(env),key=[WATCH_PREFIX,item.coin,item.frame,item.side,item.pattern,item.barOpen].join(':');
 await d.prepare(`INSERT OR IGNORE INTO swing_early_v4_watch
 (watch_key,coin,interval,side,pattern,signal_bar_open,first_seen_at,last_seen_at,last_checked_at,
  first_eligible_at,observations,eligible_observations,phase,regime,reference_price,note)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(key,item.coin,item.frame,item.side,item.pattern,item.barOpen,
 item.at,item.at,item.at,item.phase==='LIVE_ELIGIBLE'?item.at:null,0,0,item.phase,item.regime,item.price,item.reason).run();
 await d.prepare(`UPDATE swing_early_v4_watch SET last_seen_at=?,last_checked_at=?,phase=?,regime=?,reference_price=?,note=?,
 first_eligible_at=CASE WHEN ?='LIVE_ELIGIBLE' THEN COALESCE(first_eligible_at,?) ELSE first_eligible_at END,
 observations=observations+1,eligible_observations=eligible_observations+CASE WHEN ?='LIVE_ELIGIBLE' THEN 1 ELSE 0 END
 WHERE watch_key=? AND finalized_at IS NULL`).bind(item.at,item.at,item.phase,item.regime,item.price,item.reason,
 item.phase,item.at,item.phase,key).run();
 await d.prepare(`INSERT OR IGNORE INTO swing_early_v4_observations
 (watch_key,observed_at,phase,remaining_minutes,reference_price,regime,detector_hit,note)
 VALUES (?,?,?,?,?,?,?,?)`).bind(key,item.at,item.phase,item.remaining,item.price,item.regime,
 item.phase==='LIVE_ELIGIBLE'?1:0,item.reason).run();
 return key;
}

// EARLY is a read-only consumer of LIVE candidates. The LIVE execution
// worker owns swing_live_candidates and its check history.
function candidatePatterns(raw:unknown):string[]{
 try { const x=typeof raw==='string'?JSON.parse(raw):raw;
  return Array.isArray(x)?x.filter((p):p is string=>typeof p==='string'):[];
 } catch {return [];}
}
async function scanOne(env:Env,coin:string,frame:Frame,at:number){
 const d=db(env),step=STEP[frame],barOpen=Math.floor(at/step)*step;
 const remaining=(barOpen+step-at)/60000;
 const query=await d.prepare(`SELECT candidate_key,coin,side,interval,signal_bar_open,
  first_seen_at,last_seen_at,reference_price,patterns_json,market_regime,
  selected_pattern,stage,reason FROM swing_live_candidates
  WHERE coin=? AND interval=? AND signal_bar_open=?
  AND stage IN ('FORMING','DETECTOR_HIT','WAITING','ELIGIBLE','LIVE_SELECTED')
  ORDER BY first_seen_at ASC`).bind(coin,frame,barOpen).all();
 const candidates:any[]=query.results||[];
 const currentKeys=new Set<string>();let recorded=0,skipped=0;
 for(const candidate of candidates){
  const side=String(candidate.side).toUpperCase() as Side;
  const regime=String(candidate.market_regime||'');
  if(!['LONG','SHORT'].includes(side)||!regime){skipped++;continue;}
  const allowed=ruleTable(side,frame)[regime]||{};
  const patterns=candidatePatterns(candidate.patterns_json);
  const selected=String(candidate.selected_pattern||'');
  if(selected&&!patterns.includes(selected))patterns.push(selected);
  for(const pattern of patterns){
   if(!Object.prototype.hasOwnProperty.call(allowed,pattern)){skipped++;continue;}
   const stage=String(candidate.stage||'');
   const selectedHere=stage==='LIVE_SELECTED'&&selected===pattern;
   const phase=selectedHere?'LIVE_ELIGIBLE':stage==='ELIGIBLE'&&selected===pattern?'LIVE_ELIGIBLE':
    stage==='DETECTOR_HIT'?'DETECTOR_HIT':'FORMING';
   const price=Number(candidate.reference_price);
   if(!Number.isFinite(price)||price<=0){skipped++;continue;}
   const key=await record(env,{coin,frame,side,pattern,barOpen,at,regime,price,
    remaining,phase,reason:'SOURCE_LIVE_CANDIDATE:'+stage+':'+String(candidate.reason||'')});
   currentKeys.add(key);recorded++;
  }
 }
 // Preserve disappearance history when a candidate is no longer present.
 const previous:any=await d.prepare(`SELECT watch_key FROM swing_early_v4_watch
  WHERE coin=? AND interval=? AND signal_bar_open=? AND finalized_at IS NULL AND last_checked_at<?`)
  .bind(coin,frame,barOpen,at).all();
 let disappeared=0;
 for(const row of previous.results||[]){
  if(currentKeys.has(String(row.watch_key)))continue;
  await d.prepare(`UPDATE swing_early_v4_watch SET phase='DISAPPEARED',last_checked_at=?,note='LIVE_CANDIDATE_NOT_ACTIVE'
   WHERE watch_key=? AND finalized_at IS NULL`).bind(at,row.watch_key).run();
  await d.prepare(`INSERT OR IGNORE INTO swing_early_v4_observations
   (watch_key,observed_at,phase,remaining_minutes,reference_price,regime,detector_hit,note)
   VALUES (?,?,'DISAPPEARED',?,NULL,NULL,0,'LIVE_CANDIDATE_NOT_ACTIVE')`)
   .bind(row.watch_key,at,remaining).run();disappeared++;
 }
 return {coin,frame,status:'OK',source:'swing_live_candidates',candidates:candidates.length,
  watching:recorded,skipped,disappeared};
}
async function reconcile(env:Env,at:number,limit=100){
 const d=db(env),sourceDb=signalsDb(env);
 // The LIVE execution Worker writes candidates into its DB binding.
 // EARLY DB must point to the SAME D1 database (or a replicated copy).
 const candidateTable:any=await d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='swing_live_candidates'`).first();
 const candidateAuditAvailable=Number(candidateTable?.n??0)>0;
 const rows:any=await d.prepare(`SELECT * FROM swing_early_v4_watch
 WHERE finalized_at IS NULL AND signal_bar_open+CASE interval WHEN '1h' THEN 3600000 ELSE 14400000 END<=?
 ORDER BY signal_bar_open ASC LIMIT ?`).bind(at-FINALIZE_GRACE_MIN*60000,limit).all();
 let predictedCount=0,sourceOnly=0,notConfirmed=0;const errors:string[]=[];
 for(const row of rows.results??[]){try{
  const source:any=await sourceDb.prepare(`SELECT id FROM swing_context_signals
   WHERE coin=? AND interval=? AND side=? AND pattern=? AND signal_bar_open=? LIMIT 1`)
   .bind(row.coin,row.interval,row.side,row.pattern,row.signal_bar_open).first();
  const queue:any=await d.prepare(`SELECT selected_pattern,status FROM swing_live_queue
   WHERE coin=? AND side=? AND signal_bar_open=? LIMIT 1`)
   .bind(row.coin,row.side,row.signal_bar_open).first();
  const candidate:any=candidateAuditAvailable?await d.prepare(`SELECT candidate_key,stage,reason,selected_pattern,patterns_json,market_regime,
   first_seen_at,last_seen_at,reference_price,checks,live_signal_key
   FROM swing_live_candidates WHERE coin=? AND side=? AND interval=? AND signal_bar_open=? LIMIT 1`)
   .bind(row.coin,row.side,row.interval,row.signal_bar_open).first():null;
  // Candidate rows group several detected patterns. The selected pattern is the
  // authoritative per-pattern selection; a generic ELIGIBLE does not imply selection.
  const candidateSelected=!!candidate && String(candidate.selected_pattern??'')===String(row.pattern)
   && String(candidate.stage)==='LIVE_SELECTED';
  const selected=String(queue?.selected_pattern??'')===String(row.pattern)||candidateSelected;
  const timelyEligible=Number(row.first_eligible_at)>0 && Number(row.first_eligible_at)<Number(row.signal_bar_open)+(row.interval==='1h'?HOUR:4*HOUR);
  const predicted=selected && timelyEligible;
  const phase=predicted?'LIVE_SELECTED':selected?'LIVE_SELECTED_WITHOUT_EARLY_ELIGIBILITY':source?'SOURCE_CONFIRMED':'NOT_CONFIRMED';
  const candidateNote=candidate?{
   live_candidate_key:candidate.candidate_key,live_candidate_stage:candidate.stage,
   live_candidate_reason:candidate.reason,live_candidate_selected_pattern:candidate.selected_pattern,
   live_candidate_regime:candidate.market_regime,live_candidate_checks:candidate.checks,
   live_candidate_first_seen_at:candidate.first_seen_at,
   live_candidate_last_seen_at:candidate.last_seen_at,
   live_candidate_reference_price:candidate.reference_price,
   live_candidate_signal_key:candidate.live_signal_key
  }:null;
  await d.prepare(`UPDATE swing_early_v4_watch SET phase=?,live_source_confirmed=?,live_selected=?,
   live_queue_status=?,finalized_at=?,note=? WHERE watch_key=? AND finalized_at IS NULL`)
   .bind(phase,source?1:0,selected?1:0,queue?.status??null,at,
    JSON.stringify({reason:selected?'LIVE_QUEUE_SELECTED_NOT_PROOF_OF_FILL':source?'LOGGER_PATTERN_FOUND_NOT_LIVE_SELECTED':'NO_SOURCE_OR_LIVE_QUEUE_MATCH',candidate_audit_available:candidateAuditAvailable,candidate:candidateNote}),row.watch_key).run();
  if(predicted)predictedCount++;else if(source)sourceOnly++;else notConfirmed++;
 }catch(e:any){errors.push(String(row.watch_key)+':'+String(e?.message||e));}}
 // Count LIVE selections with no EARLY watch (denominator for prediction recall).
 const unmatched:any=await d.prepare(`SELECT COUNT(*) AS n FROM swing_live_queue q
 WHERE q.signal_available_at>=? AND q.signal_available_at<? AND q.selected_pattern IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM swing_early_v4_watch w
 WHERE w.coin=q.coin AND w.side=q.side AND w.signal_bar_open=q.signal_bar_open
 AND w.pattern=q.selected_pattern AND w.first_eligible_at IS NOT NULL
 AND w.first_eligible_at<q.signal_available_at)`)
 .bind(at-24*HOUR,at-FINALIZE_GRACE_MIN*60000).first();
 return {finalized:(rows.results??[]).length,predicted:predictedCount,sourceOnly,notConfirmed,
  missedLiveSelectionsLast24h:Number(unmatched?.n??0),candidateAuditAvailable,errors,
  note:'LIVE_SELECTED is a selected queue signal, NOT a verified executed trade.'};
}
/** Every scheduler tick consumes ALL active LIVE candidates, not a rotating coin batch.
 * offset/limit remain accepted for compatibility with existing CRON and manual endpoint.
 * This routine never writes swing_live_candidates or places orders.
 */
export async function runSwingEarlyCycle(env:Env,offset=0,limit=5){
 const at=Date.now(),scanned:any[]=[],errors:string[]=[];
 try{await ensureSchema(env);}catch(e:any){return {success:false,version:VERSION,mode:'SHADOW_ONLY',trading:false,error:'SCHEMA:'+String(e?.message||e)};}
 const d=db(env);
 let active:any[]=[];
 try{
  const q:any=await d.prepare(`SELECT DISTINCT coin,interval,signal_bar_open FROM swing_live_candidates
   WHERE stage IN ('FORMING','DETECTOR_HIT','WAITING','ELIGIBLE','LIVE_SELECTED')
   AND signal_bar_open>=? AND signal_bar_open<=?
   ORDER BY signal_bar_open DESC,coin,interval LIMIT 300`).bind(at-4*HOUR-5*60000,at).all();
  active=q.results||[];
 }catch(e:any){errors.push('ACTIVE_CANDIDATES:'+String(e?.message||e));}
 // Process each candidate's own candle only while that candle is still forming.
 // Closed bars are reconciled below; they are not incorrectly marked DISAPPEARED.
 const unique=new Set<string>();
 for(const row of active){
  const frame=String(row.interval) as Frame;
  if(frame!=='1h'&&frame!=='4h')continue;
  const coin=String(row.coin),barOpen=Number(row.signal_bar_open);
  if(!Number.isFinite(barOpen)||at>=barOpen+STEP[frame]||at<barOpen)continue;
  const key=coin+':'+frame+':'+barOpen;
  if(unique.has(key))continue;
  unique.add(key);
  try{scanned.push(await scanOne(env,coin,frame,at));}
  catch(e:any){errors.push(key+':'+String(e?.message||e));}
 }
 const live=await reconcile(env,at).catch((e:any)=>({errors:[String(e?.message||e)]}));
 const candidateAudit=await (async()=>{
  const d=db(env);
  const table:any=await d.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='swing_live_candidates'`).first();
  if(!Number(table?.n??0))return {available:false,error:'SWING_LIVE_CANDIDATES_TABLE_MISSING_IN_EARLY_DB',rows:[],stages:[]};
  const rows:any=await d.prepare(`SELECT candidate_key,coin,side,interval,signal_bar_open,signal_available_at,
   first_seen_at,last_seen_at,reference_price,patterns_json,market_regime,selected_pattern,
   stage,reason,live_signal_key,checks FROM swing_live_candidates ORDER BY last_seen_at DESC LIMIT 250`).all();
  const stages:any=await d.prepare(`SELECT stage,COUNT(*) AS total FROM swing_live_candidates GROUP BY stage`).all();
  return {available:true,rows:rows.results??[],stages:stages.results??[]};
 })().catch((e:any)=>({available:false,error:String(e?.message||e),rows:[],stages:[]}));
 return {success:errors.length===0&&live.errors.length===0,version:VERSION,mode:'SHADOW_ONLY',trading:false,
  at,offset,limit,active_candidate_groups:active.length,scanned,live,candidateAudit,errors,
  notice:'EARLY only reads LIVE candidates and writes EARLY observation tables. LIVE_SELECTED is not a fill. No orders.'};
}
