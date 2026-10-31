import {swingEarlyExitData} from './swing-early-exit';
/** SWING LIVE MONITOR — read only; independent from RESEARCH. */
type Env = { DB?: any; SWING_ADMIN_TOKEN?: string; HYPERLIQUID_MASTER_ACCOUNT?: string };
const SWING_SIGNAL_FILTERS = [{"strategy":"1H LONG","regime":"LONG_REGIME","pattern":"V3_CUP_HANDLE","tp":2,"sl":1.5},{"strategy":"1H LONG","regime":"LONG_REGIME","pattern":"V3_BULL_FLAG","tp":2,"sl":1},{"strategy":"1H LONG","regime":"LONG_REGIME","pattern":"MOMENTUM_REVERSAL_LONG","tp":2,"sl":0.75},{"strategy":"1H LONG","regime":"LONG_REGIME","pattern":"V3_TRIPLE_BOTTOM","tp":0.5,"sl":0.5},{"strategy":"1H LONG","regime":"LONG_REGIME","pattern":"HAMMER","tp":2,"sl":0.3},{"strategy":"1H LONG","regime":"SHORT_REGIME","pattern":"TRIANGLE_UP","tp":2,"sl":0.75},{"strategy":"1H LONG","regime":"SHORT_REGIME","pattern":"V3_FALLING_WEDGE","tp":1.5,"sl":1.5},{"strategy":"1H LONG","regime":"SHORT_REGIME","pattern":"V2_BULL_ENGULF","tp":0.75,"sl":1.5},{"strategy":"1H LONG","regime":"SHORT_REGIME","pattern":"RANGE_BREAKOUT","tp":2,"sl":1.5},{"strategy":"1H LONG","regime":"SHORT_REGIME","pattern":"LIQUIDITY_SWEEP_LOW","tp":2,"sl":0.3},{"strategy":"1H LONG","regime":"NEUTRAL","pattern":"EMA_PULLBACK_LONG","tp":1,"sl":1},{"strategy":"4H LONG","regime":"LONG_REGIME","pattern":"MOMENTUM_REVERSAL_LONG","tp":2,"sl":1},{"strategy":"4H LONG","regime":"SHORT_REGIME","pattern":"MOMENTUM_REVERSAL_LONG","tp":1.5,"sl":1.5},{"strategy":"1H SHORT","regime":"LONG_REGIME","pattern":"RANGE_BREAKDOWN","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"LONG_REGIME","pattern":"BREAKOUT_RETEST_SHORT","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"LONG_REGIME","pattern":"DOUBLE_TOP","tp":2,"sl":1},{"strategy":"1H SHORT","regime":"LONG_REGIME","pattern":"V2_BEAR_ENGULF","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"LONG_REGIME","pattern":"V2_SHOOTING_STAR","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"SHORT_REGIME","pattern":"SHOOTING_STAR","tp":1.5,"sl":1.5},{"strategy":"1H SHORT","regime":"SHORT_REGIME","pattern":"BREAKOUT_RETEST_SHORT","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"SHORT_REGIME","pattern":"LIQUIDITY_SWEEP_HIGH","tp":1.5,"sl":1},{"strategy":"1H SHORT","regime":"SHORT_REGIME","pattern":"TRIANGLE_DOWN","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"SHORT_REGIME","pattern":"EMA_PULLBACK_SHORT","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"NEUTRAL","pattern":"V2_DOUBLE_TOP","tp":2,"sl":0.75},{"strategy":"1H SHORT","regime":"NEUTRAL","pattern":"DOUBLE_TOP","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"NEUTRAL","pattern":"V3_INVERSE_CUP_HANDLE","tp":2,"sl":0.5},{"strategy":"1H SHORT","regime":"NEUTRAL","pattern":"VOLUME_EXPANSION_SHORT","tp":2,"sl":1.5},{"strategy":"1H SHORT","regime":"NEUTRAL","pattern":"RANGE_BREAKDOWN","tp":2,"sl":1.5},{"strategy":"4H SHORT","regime":"LONG_REGIME","pattern":"MOMENTUM_REVERSAL_SHORT","tp":2,"sl":0.3},{"strategy":"4H SHORT","regime":"LONG_REGIME","pattern":"BEAR_ENGULF","tp":2,"sl":1},{"strategy":"4H SHORT","regime":"LONG_REGIME","pattern":"LIQUIDITY_SWEEP_HIGH","tp":2,"sl":1.5},{"strategy":"4H SHORT","regime":"NEUTRAL","pattern":"EMA_PULLBACK_SHORT","tp":2,"sl":1.5},{"strategy":"4H SHORT","regime":"NEUTRAL","pattern":"TRIANGLE_DOWN","tp":2,"sl":1.5},{"strategy":"4H SHORT","regime":"NEUTRAL","pattern":"MOMENTUM_REVERSAL_SHORT","tp":2,"sl":1.5},{"strategy":"4H SHORT","regime":"NEUTRAL","pattern":"BEAR_ENGULF","tp":0.5,"sl":1}];
const MASTER = '0xf1CF243f05024AE78aE2dFa31c2Bec1e1F6c9196';
const STRATEGIES = ['SWING_SHORT_FILTERED_V1','SWING_SHORT_DOUBLE_MIXED_B_V1','SWING_LONG_FILTERED_V1'];
const num = (v:any):number|null => v==null||v===''||!Number.isFinite(Number(v))?null:Number(v);
const json = (v:any,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const day = (v:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(v);
function formula(r:any){const s=String(r.strategy_version||'');return s.includes('LONG_FILTERED')?'SWING LONG · BTC 1H MIXED':s.includes('DOUBLE_MIXED')?'SWING SHORT · VARIANT B · DOUBLE MIXED':s.includes('SHORT_FILTERED')?'SWING SHORT · FILTERED':s||'UNKNOWN';}
function outcome(r:any){const status=String(r.status||'').toUpperCase(),reason=String(r.close_reason||'').toUpperCase();if(status==='MANUALLY_CLOSED'||reason==='MANUAL')return 'MANUAL_CLOSE';if(status!=='CLOSED')return 'OPEN';return reason==='TP'?'TP':reason==='SL'?'SL':reason.includes('TIME')||reason.includes('MAX_HOLD')?'TIME_EXIT':'OTHER';}
function normalize(r:any){const price=num(r.entry_fill_price),size=num(r.entry_fill_size),pnl=num(r.realized_pnl);const nominal=price!==null&&size!==null?price*size:null;return {id:r.crossing_id,coin:r.coin,side:r.side,formula:formula(r),patterns:r.setup_name,result:outcome(r),status:r.status,close_reason:r.close_reason,entry_price:price,exit_price:num(r.exit_price),size,net_pnl_usd:pnl,roi_pct:pnl!==null&&nominal!==null&&nominal>0?100*pnl/nominal:null,nominal,entry_at:num(r.entry_filled_at),closed_at:num(r.closed_at),day:r.closed_at?day(Number(r.closed_at)):null};}
async function rejectedData(env:Env){
 const q:any=await env.DB.prepare(`SELECT signal_key,coin,side,interval,pattern,market_regime,rejected_at,entry_price,
 reasons_json,indicators_json,tp_pct,sl_pct,status,outcome_at,exit_price,minutes_to_outcome,observation_note
 FROM swing_rejected_signals ORDER BY rejected_at DESC LIMIT 2000`).all();
 const rows=(q.results||[]).map((r:any)=>{
  let reasons:any=[],indicators:any={};try{reasons=JSON.parse(r.reasons_json)}catch{};
  try{indicators=JSON.parse(r.indicators_json)}catch{};
  return {...r,reasons,indicators,reasons_json:undefined,indicators_json:undefined};
 });
 const completed=rows.filter((r:any)=>['WOULD_TP','WOULD_SL'].includes(r.status));
 const groups:any={};
 for(const r of rows){for(const reason of r.reasons){const g=groups[reason]||(groups[reason]={reason,total:0,tp:0,sl:0,unknown:0,tracking:0});g.total++;
  if(r.status==='WOULD_TP')g.tp++;else if(r.status==='WOULD_SL')g.sl++;else if(r.status==='UNKNOWN')g.unknown++;else g.tracking++;}}
 return {rows,stats:{total:rows.length,tracking:rows.filter((r:any)=>r.status==='TRACKING').length,
  would_tp:completed.filter((r:any)=>r.status==='WOULD_TP').length,
  would_sl:completed.filter((r:any)=>r.status==='WOULD_SL').length,
  unknown:rows.filter((r:any)=>r.status==='UNKNOWN').length,
  estimated_gross_pct:completed.reduce((v:number,r:any)=>v+(r.status==='WOULD_TP'?0.5:-1),0),
  by_reason:Object.values(groups)},limited:rows.length===2000};
}

// EARLY research is read-only here. The scanner writes to a separate D1 table.
async function earlyData(env:Env){
 // V4.1 writes watches into its own D1 binding (DB on the dedicated EARLY worker).
 // This dashboard reads the same DB binding; never silently substitute legacy records.
 const database=env.DB;
 if(!database?.prepare)throw Error('EARLY_V4_DB_BINDING_MISSING');
 const exists:any=await database.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='swing_early_v4_watch'`).first();
 if(!exists)return {version:'V4.1',source:'swing_early_v4_watch',rows:[],stats:{total:0},error:'EARLY_V4_TABLE_NOT_FOUND_IN_MONITOR_DB — check EARLY Worker DB binding; legacy table is different',limited:false};
 const q:any=await database.prepare(`SELECT watch_key,coin,side,interval,pattern,signal_bar_open,first_seen_at,last_seen_at,last_checked_at,first_eligible_at,observations,eligible_observations,phase,regime,reference_price,live_source_confirmed,live_selected,live_queue_status,finalized_at,note FROM swing_early_v4_watch ORDER BY first_seen_at DESC LIMIT 2000`).all();
 const rows=(q.results||[]).map((r:any)=>({...r,
  status:String(r.phase||'UNKNOWN'),entry_price:r.reference_price,
  live_confirmed:r.live_source_confirmed==null?null:Boolean(r.live_source_confirmed),
  live_blocked:null,
  live_entry_price:null,
  live_block_reason:r.note,
  minutes_to_outcome:r.first_eligible_at!=null?Math.round((Number(r.first_eligible_at)-Number(r.first_seen_at))/60000*10)/10:null,
  lead_minutes:r.first_eligible_at!=null?Math.round((Number(r.first_eligible_at)-Number(r.first_seen_at))/60000*10)/10:null
 }));
 // Link EARLY watches to authoritative LIVE candidate rows without writing to either table.
 let candidateLinkError:string|null=null;
 let candidates:any[]=[];
 try{
  const cq:any=await database.prepare(`SELECT candidate_key,coin,side,interval,signal_bar_open,first_seen_at,last_seen_at,stage,selected_pattern,reference_price,checks FROM swing_live_candidates ORDER BY last_seen_at DESC LIMIT 3000`).all();
  candidates=cq.results||[];
 }catch(e:any){candidateLinkError=String(e?.message||e);}
 const candidateIndex=new Map<string,any>();
 for(const c of candidates){const key=[c.coin,c.side,c.interval,Number(c.signal_bar_open)].join('|');if(!candidateIndex.has(key))candidateIndex.set(key,c);}
 for(const r of rows){
  const c=candidateIndex.get([r.coin,r.side,r.interval,Number(r.signal_bar_open)].join('|'));
  r.candidate_key=c?.candidate_key??null;
  r.candidate_stage=c?.stage??null;
  r.candidate_checks=c?.checks??null;
  r.candidate_selected=c?.selected_pattern===r.pattern && c?.stage==='LIVE_SELECTED';
  r.candidate_first_seen_at=c?.first_seen_at??null;
  r.candidate_reference_price=c?.reference_price??null;
  // A missing candidate must not be interpreted as a negative LIVE outcome.
 }
 const confirmed=rows.filter((r:any)=>r.live_confirmed===true).length;
 const denied=rows.filter((r:any)=>r.live_confirmed===false).length;
 const phases:any={};for(const r of rows)phases[r.status]=(phases[r.status]||0)+1;
 return {version:'V4.1',source:'swing_early_v4_watch',rows,stats:{total:rows.length,tracking:rows.filter((r:any)=>r.finalized_at==null).length,
  confirmed,not_confirmed:denied,pending:rows.filter((r:any)=>r.live_confirmed===null).length,
  selected:rows.filter((r:any)=>r.live_selected===1).length,linked:rows.filter((r:any)=>r.candidate_key!=null).length,unlinked:rows.filter((r:any)=>r.candidate_key==null).length,phases,eligible:rows.filter((r:any)=>r.first_eligible_at!=null).length,
  confirmation_pct:confirmed+denied>0?100*confirmed/(confirmed+denied):null},candidate_link_error:candidateLinkError,limited:rows.length===2000};
}
// LIVE candidate audit — read-only. The execution Worker owns these rows.
async function liveCandidateData(env:Env){
 const d=env.DB;
 if(!d?.prepare)return {available:false,error:'MONITOR_DB_BINDING_MISSING',rows:[],stats:{}};
 try{
  const table:any=await d.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='swing_live_candidates'`).first();
  if(!table)return {available:false,error:'SWING_LIVE_CANDIDATES_TABLE_MISSING_IN_MONITOR_DB',rows:[],stats:{}};
  const q:any=await d.prepare(`SELECT candidate_key,coin,side,interval,signal_bar_open,signal_available_at,first_seen_at,last_seen_at,reference_price,patterns_json,market_regime,selected_pattern,stage,reason,live_signal_key,checks FROM swing_live_candidates ORDER BY last_seen_at DESC LIMIT 1000`).all();
  const rows=(q.results||[]).map((r:any)=>{let patterns:any=[];try{patterns=JSON.parse(r.patterns_json||'[]')}catch{};return {...r,patterns};});
  const stages:any={};for(const r of rows)stages[r.stage||'UNKNOWN']=(stages[r.stage||'UNKNOWN']||0)+1;
  return {available:true,source:'swing_live_candidates',rows,stats:{total:rows.length,stages},limited:rows.length===1000};
 }catch(e:any){return {available:false,error:String(e?.message||e),rows:[],stats:{}};}
}

// Read-only EARLY vs actual SWING fill audit. Only exact signal_key and selected pattern.
async function earlyLiveComparisonData(env:Env){
 try{
  const q:any=await env.DB.prepare(`SELECT e.coin,e.side,e.interval,e.pattern,
    e.first_seen_at AS early_at,e.reference_price AS early_price,
    c.signal_available_at AS live_signal_at,a.captured_at AS audit_at,
    a.fill_price AS live_fill_price,a.snapshot_status AS audit_status,
    c.live_signal_key AS signal_key
   FROM swing_early_v4_watch e
   JOIN swing_live_candidates c ON c.coin=e.coin AND c.side=e.side
    AND c.interval=e.interval AND c.signal_bar_open=e.signal_bar_open
    AND c.selected_pattern=e.pattern AND c.stage='LIVE_SELECTED'
   JOIN swing_pre_entry_audit a ON a.signal_key=c.live_signal_key
   WHERE a.fill_price IS NOT NULL AND a.fill_price>0 AND e.reference_price>0
   ORDER BY e.first_seen_at DESC LIMIT 500`).all();
  const rows=(q.results||[]).map((r:any)=>{
   const early=Number(r.early_price),fill=Number(r.live_fill_price);
   const advantage=100*(r.side==='LONG'?fill-early:early-fill)/early;
   return {...r,advantage_pct:advantage,minutes_to_audit:(Number(r.audit_at)-Number(r.early_at))/60000};
  });
  const avg=(a:any[],key:string)=>a.length?a.reduce((sum:number,r:any)=>sum+Number(r[key]),0)/a.length:null;
  const groups=new Map<string,any[]>();
  for(const r of rows){const k=[r.side,r.interval,r.pattern].join(' / ');if(!groups.has(k))groups.set(k,[]);groups.get(k)!.push(r);}
  const by_pattern=[...groups].map(([pattern,a])=>({pattern,count:a.length,early_better:a.filter(r=>r.advantage_pct>0).length,live_better:a.filter(r=>r.advantage_pct<0).length,avg_advantage_pct:avg(a,'advantage_pct')})).sort((a,b)=>b.count-a.count);
  return {rows,by_pattern,stats:{total:rows.length,early_better:rows.filter(r=>r.advantage_pct>0).length,live_better:rows.filter(r=>r.advantage_pct<0).length,equal:rows.filter(r=>r.advantage_pct===0).length,avg_advantage_pct:avg(rows,'advantage_pct'),avg_minutes_to_audit:avg(rows,'minutes_to_audit')},limited:rows.length===500};
 }catch(e:any){return {rows:[],by_pattern:[],stats:{},error:String(e?.message||e)};}
}
async function account(address:string){
 const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),9000);
 const get=async(type:string)=>{const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,user:address}),signal:abort.signal});if(!r.ok)throw Error(type+'_HTTP_'+r.status);return r.json() as Promise<any>};
 try{
  const [perp,spot,portfolio,abstraction]=await Promise.allSettled([get('clearinghouseState'),get('spotClearinghouseState'),get('portfolio'),get('userAbstraction')]);
  // Keep the dashboard working even when the optional Spot endpoint is unavailable.
  const spotData=spot.status==='fulfilled'?spot.value:null;
  const mode=abstraction.status==='fulfilled'?String(abstraction.value):'UNKNOWN';
  const balances=Array.isArray(spotData?.balances)?spotData.balances:[];
  const usdc=balances.find((x:any)=>String(x.coin).toUpperCase()==='USDC');
  const spotUsdc=num(usdc?.total);
  const perpData=perp.status==='fulfilled'?perp.value:null;
  const perpValue=num(perpData?.marginSummary?.accountValue);
  const exchangeWithdrawable=num(perpData?.withdrawable);
  // Estimated margin locked in open positions, not the position notional.
  const marginParts=(perpData?.assetPositions||[]).filter((x:any)=>Math.abs(Number(x.position?.szi||0))>0).map((x:any)=>{
   const p=x.position||{}, direct=num(p.marginUsed);
   if(direct!==null&&direct>=0)return direct;
   const value=num(p.positionValue),lev=num(p.leverage?.value);
   return value!==null&&lev!==null&&lev>0?Math.abs(value)/lev:null;
  });
  const usedMargin=marginParts.every((x:number|null)=>x!==null)?marginParts.reduce((s:number,x:number|null)=>s+(x||0),0):null;
  const positions=(perpData?.assetPositions||[]).filter((x:any)=>Math.abs(Number(x.position?.szi||0))>0);
  const unrealized=positions.reduce((s:number,x:any)=>s+Number(x.position?.unrealizedPnl||0),0);
  let historicalValue:number|null=null,historyTimestamp:number|null=null;
  if(portfolio.status==='fulfilled'&&Array.isArray(portfolio.value)){
   const item=portfolio.value.find((x:any)=>Array.isArray(x)&&x[0]==='day');
   const hist=item?.[1]?.accountValueHistory;
   if(Array.isArray(hist)&&hist.length){const last=hist[hist.length-1];historicalValue=num(last?.[1]);historyTimestamp=num(last?.[0]);}
  }
  const unified=mode==='unifiedAccount'||mode==='portfolioMargin';
  // In unified mode spot USDC already represents the shared collateral balance.
  // Never add perps accountValue to spot USDC: it double counts used margin.
  // Portfolio history is provided separately because it can be delayed.
  const total=unified?spotUsdc:(mode==='UNKNOWN'?spotUsdc:(spotUsdc!==null&&perpValue!==null?spotUsdc+perpValue:null));
  const free=total!==null&&usedMargin!==null?Math.max(0,total-usedMargin):null;
  return {ok:true,mode,balance:total,total_portfolio:total,total_source:unified?'UNIFIED_SPOT_USDC_COLLATERAL_APPROX':'STANDARD_SPOT_PLUS_PERP',spot_usdc:spotUsdc,perp_account_value:perpValue,free,used_margin_estimate:usedMargin,exchange_withdrawable:exchangeWithdrawable,free_calculation:"TOTAL_MINUS_OPEN_POSITION_MARGIN_ESTIMATE",open_positions:positions.length,unrealized_pnl:unrealized,portfolio_history_value:historicalValue,portfolio_history_at:historyTimestamp,warning:spot.status!=='fulfilled'?'Spot endpoint unavailable; balance cannot be verified.':unified?'USDC estimate only; no double-counting.':mode==='UNKNOWN'?'Account mode unverified; no spot/perp summation.':'Separate spot/perp balances.'};
 }catch(e:any){return {ok:false,error:String(e?.message||e),balance:null,free:null,open_positions:null};}finally{clearTimeout(timer);}
}
async function marketStatus(env:Env){
 const q=await env.DB.prepare(`SELECT
 SUM(CASE WHEN side='LONG' THEN 1 ELSE 0 END) AS longs,
 SUM(CASE WHEN side='SHORT' THEN 1 ELSE 0 END) AS shorts
 FROM swing_context_signals
 WHERE interval='1h' AND signal_available_at IS NOT NULL
 AND signal_available_at >= (CAST(unixepoch('now')/3600 AS INTEGER)-24)*3600000
 AND signal_available_at < CAST(unixepoch('now')/3600 AS INTEGER)*3600000`).first();
 const longs=Number(q?.longs||0),shorts=Number(q?.shorts||0),total=longs+shorts;
 const regime=total<10?'INSUFFICIENT':longs/total>=0.6?'LONG_REGIME':shorts/total>=0.6?'SHORT_REGIME':'NEUTRAL';
 return {regime,label:regime==='LONG_REGIME'?'Bullish':regime==='SHORT_REGIME'?'Bearish':regime==='NEUTRAL'?'NEUTRAL':'INSUFFICIENT',long_signals:longs,short_signals:shorts,total_signals:total,long_pct:total?Math.round(longs/total*10000)/100:null,short_pct:total?Math.round(shorts/total*10000)/100:null,window:'PREVIOUS_24_COMPLETED_HOURS',definition:'1H LONG/SHORT signal balance, not BTC price trend'};
}
async function data(env:Env){if(!env.DB?.prepare)throw Error('LIVE_DB_MISSING');const rows:any=await env.DB.prepare(`SELECT crossing_id,coin,side,status,close_reason,entry_fill_price,entry_fill_size,entry_filled_at,closed_at,exit_price,realized_pnl,strategy_version,setup_name FROM hyperliquid_execution_ledger WHERE strategy_version IN (?,?,?) AND entry_filled_at IS NOT NULL ORDER BY COALESCE(closed_at,entry_filled_at) DESC LIMIT 3000`).bind(...STRATEGIES).all();const all=(rows.results||[]).map(normalize),closed=all.filter((r:any)=>r.result!=='OPEN'),open=all.filter((r:any)=>r.result==='OPEN');const summary=(side:string)=>{const a=closed.filter((r:any)=>r.side===side),financial=a.filter((r:any)=>r.net_pnl_usd!==null),pnl=financial.reduce((s:number,r:any)=>s+(r.net_pnl_usd||0),0),nominal=financial.reduce((s:number,r:any)=>s+(r.nominal||0),0);return {tp:a.filter((r:any)=>r.result==='TP').length,sl:a.filter((r:any)=>r.result==='SL').length,time_exit:a.filter((r:any)=>r.result==='TIME_EXIT').length,other:a.filter((r:any)=>r.result==='OTHER').length,manual_close:a.filter((r:any)=>r.result==='MANUAL_CLOSE').length,open:open.filter((r:any)=>r.side===side).length,pnl,roi:nominal>0?100*pnl/nominal:null};};const archive=new Map<string,any>();for(const r of closed){if(!archive.has(r.day))archive.set(r.day,{day:r.day,rows:[],pnl:0,nominal:0});const a=archive.get(r.day);a.rows.push(r);if(r.net_pnl_usd!==null){a.pnl+=r.net_pnl_usd;a.nominal+=r.nominal||0;}}return {success:true,rejected:await rejectedData(env).catch((e:any)=>({rows:[],stats:null,error:String(e?.message||e)})),earlyExit:await swingEarlyExitData(env).catch((e:any)=>({rows:[],stats:null,error:String(e?.message||e)})),earlyLiveComparison:await earlyLiveComparisonData(env),early:await earlyData(env).catch((e:any)=>({rows:[],stats:null,error:String(e?.message||e)})),liveCandidates:await liveCandidateData(env),source:'LIVE_LEDGER',market:await marketStatus(env).catch((e:any)=>({label:'UNAVAILABLE',regime:'UNKNOWN',long_signals:0,short_signals:0,total_signals:0,error:String(e?.message||e)})),signal_filters:SWING_SIGNAL_FILTERS,account:await account(env.HYPERLIQUID_MASTER_ACCOUNT||MASTER),swing_open:open.length,long:summary('LONG'),short:summary('SHORT'),long_rows:all.filter((r:any)=>r.side==='LONG').slice(0,100),short_rows:all.filter((r:any)=>r.side==='SHORT').slice(0,100),archive:[...archive.values()].sort((a,b)=>b.day.localeCompare(a.day)).map(a=>({...a,roi:a.nominal>0?100*a.pnl/a.nominal:null})),archive_limited:all.length===3000,updated_at:Date.now(),roi_definition:'NET PNL / ENTRY NOTIONAL (not margin ROI)'};}
function html(){return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Swing LIVE Monitor</title><style>*{box-sizing:border-box}body{font:14px system-ui;background:#0b1120;color:#e7edfa;margin:0 auto;padding:20px;max-width:1500px}header{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}h1{margin:0}small{color:#9baecc}.cards,.cols{display:grid;gap:14px;margin:18px 0}.cards{grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.cols{grid-template-columns:repeat(2,minmax(0,1fr))}.card,.panel{padding:16px;border-radius:13px;border:1px solid #2c3c5c;background:#131f34;min-width:0}.card strong{display:block;font-size:25px;margin-top:7px}.stats{display:flex;gap:9px;flex-wrap:wrap;margin:12px 0}.stat{padding:9px;background:#20304b;border-radius:8px}input,button,select{padding:10px;background:#1c2b46;border:1px solid #405579;color:white;border-radius:8px}button{cursor:pointer}.pager{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0}.pager button:disabled{opacity:.4;cursor:default}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}td,th{text-align:left;padding:9px;border-bottom:1px solid #30415c;white-space:nowrap}th{color:#9baecc}.good{color:#59d9a4}.bad{color:#ff8495}.marketline{margin:14px 0;padding:13px 16px;border:1px solid #405579;border-radius:12px;background:#16263d;font-weight:700;font-size:17px}.marketline small{font-weight:400}.filter-panel{margin:0 0 16px}.filter-panel>summary{font-weight:700;font-size:16px;padding:3px 0}.filter-group{margin:12px 0}.filter-group h3{margin:10px 0}.filter-regime{margin:9px 0}.filter-regime summary{color:#b9cbee}.filter-table{margin-top:8px}details{border-top:1px solid #30415c;padding:12px 0}summary{cursor:pointer}#error{color:#ff8c9b}@media(max-width:900px){.cols{grid-template-columns:1fr}}</style></head><body><header><div><h1>SWING · LIVE MONITOR</h1><small>Реални Hyperliquid сделки · независимо от RESEARCH</small></div><div><input id="token" type="password" placeholder="SWING_ADMIN_TOKEN"><button id="connect">Свържи</button><button id="refresh">Обнови</button></div></header><div id="market-status" class="marketline">Market Status: —</div><details class="panel filter-panel" id="signal-filter"><summary>Signal filter · 35 входа · TP / SL</summary><div id="filter-content"></div></details><p id="error"></p><div class="cards"><div class="card"><small>TOTAL · Hyperliquid (USD)</small><strong id="balance">—</strong></div><div class="card"><small>Свободни средства</small><strong id="free">—</strong></div><div class="card"><small>Общо отворени позиции в Hyperliquid</small><strong id="exchange">—</strong></div><div class="card"><small>Отворени Swing LIVE сделки</small><strong id="open">—</strong></div></div><div class="cols"><section class="panel"><h2>🟢 LONG</h2><div class="stats" id="long-stats"></div><div class="scroll" id="long-rows"></div></section><section class="panel"><h2>🔴 SHORT</h2><div class="stats" id="short-stats"></div><div class="scroll" id="short-rows"></div></section></div><section class="panel"><h2>Архив по дни · София</h2><small>ROI % = реален NET P/L / входен номинал. Не е ROI върху маржина.</small><div id="archive"></div></section><section class="panel" id="rejected-panel"><h2>🛡 SWING REJECTED SIGNALS · TP 0.50% / SL 1.00%</h2><small>Хипотетичен първи допир по Hyperliquid 1m OHLC; не са реални сделки. UNKNOWN при неясна последователност.</small><div class="stats" id="rejected-stats"></div><div style="margin:12px 0"><input id="rejected-search" placeholder="Монета / патерн / причина" aria-label="Филтър отхвърлени"><select id="rejected-side"><option value="">LONG + SHORT</option><option>LONG</option><option>SHORT</option></select><select id="rejected-status"><option value="">Всички резултати</option><option>TRACKING</option><option>WOULD_TP</option><option>WOULD_SL</option><option>UNKNOWN</option></select></div><div class="scroll" id="rejected-rows"></div><h3>Защити по причина</h3><div class="scroll" id="rejected-reasons"></div></section><section class="panel" id="early-panel" style="margin-top:16px"><h2>🔎 SWING EARLY SIGNALS · LIVE CANDIDATE LINKED</h2><small>Сравнение с действителната отчетена LIVE fill цена. По подразбиране само съвпаднали и изпълнени сигнали; 10 на страница. Часът на диагностиката не е борсовият fill час.</small><div class="stats" id="early-stats"></div><div style="margin:12px 0;display:flex;flex-wrap:wrap;gap:8px"><input id="early-search" placeholder="Монета / модел / причина"><select id="early-scope"><option value="FILLED">Само сравними входове</option><option value="ALL">Всички EARLY наблюдения</option></select><select id="early-side"><option value="">LONG + SHORT</option><option>LONG</option><option>SHORT</option></select><select id="early-status"><option value="">Всички резултати</option><option>TRACKING</option><option>FORMING</option><option>LIVE_ELIGIBLE</option><option>FINALIZED</option><option>UNKNOWN</option></select><select id="early-confirmed"><option value="">LIVE: всички</option><option value="YES">Потвърден</option><option value="NO">Непотвърден</option><option value="PENDING">Изчакване</option></select><select id="early-blocked"><option value="">Блокиране: всички</option><option value="YES">Блокиран</option><option value="NO">Неблокиран</option><option value="PENDING">Изчакване</option></select></div><div class="scroll" id="early-rows"></div></section><section class="panel" id="live-candidates-panel" style="margin-top:16px"><h2>🎯 SWING LIVE CANDIDATES · AUDIT</h2><small>Избраните LIVE кандидати със същата EARLY формация и отчетена fill цена. Часът на LIVE сигнала не е час на изпълнение.</small><div class="stats" id="candidate-stats"></div><div style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap"><input id="candidate-search" placeholder="Монета / модел / причина"><select id="candidate-scope"><option value="FILLED">Само сравними входове</option><option value="ALL">Всички кандидати</option></select><select id="candidate-side"><option value="">LONG + SHORT</option><option>LONG</option><option>SHORT</option></select><select id="candidate-stage"><option value="">Всички статуси</option><option>FORMING</option><option>DETECTOR_HIT</option><option>WAITING</option><option>REJECTED</option><option>ELIGIBLE</option><option>LIVE_SELECTED</option><option>ERROR</option></select></div><div class="scroll" id="candidate-rows"></div></section><section class="panel" id="early-diagnostics-panel" style="margin-top:16px"><h2>🔍 SWING EARLY SCANNER · DIAGNOSTICS</h2><small>Ръчно сканиране на 5 монети на 1H и 4H. Използва въведения административен токен. Не променя LIVE позиции. Проверката може да запише нови SHADOW сигнали.</small><div style="margin:12px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center"><button id="early-check" type="button">🔄 ПРОВЕРИ СКЕНЕРА · 5 МОНЕТИ</button><select id="early-offset" aria-label="Група монети"><option value="0">Монети 1–5</option><option value="5">Монети 6–10</option><option value="10">Монети 11–15</option><option value="15">Монети 16–20</option></select><span id="early-check-status">Няма ръчна проверка</span></div><div class="stats" id="early-check-stats"></div><div class="scroll" id="early-check-details"></div><details><summary>Пълен JSON от диагностиката</summary><pre id="early-check-json" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details></section><section class="panel" id="early-exit-panel" style="margin-top:16px"><h2>🚨 SWING EARLY EXIT · V1 vs V2 · SHADOW</h2><small>V2 FAST / TREND срещу V1 и реалното затваряне. Само наблюдение, без поръчки. Брутно, без такси и приплъзване. V2 събира данни от момента на активиране.</small><h3>V2 · ADAPTIVE</h3><div class="stats" id="early-exit-v2-stats"></div><div class="scroll" id="early-exit-v2-rows"></div><details><summary>V1 · Исторически резултати</summary><div class="stats" id="early-exit-stats"></div><div class="scroll" id="early-exit-rows"></div></details></section><small id="updated"></small><script>
const e=id=>document.getElementById(id),money=x=>x==null?'—':'$'+Number(x).toFixed(4),pct=x=>x==null?'—':Number(x).toFixed(3)+'%',esc=x=>String(x??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),dt=x=>x?new Date(x).toLocaleString('bg-BG',{timeZone:'Europe/Sofia'}):'—',cls=x=>Number(x)>0?'good':Number(x)<0?'bad':'';
// Storage may be unavailable in embedded/private mobile browsers.
let token='';
try { token=sessionStorage.getItem('swing_live_token')||''; } catch (_) {}
e('token').value=token;
const connectButton=e('connect'),refreshButton=e('refresh');
function uiMessage(message){e('error').textContent=message;}
function rememberToken(value){try{sessionStorage.setItem('swing_live_token',value);}catch(_){/* optional */}}
connectButton.addEventListener('click',()=>{
 token=e('token').value.trim();rememberToken(token);
 uiMessage(token?'Свързване…':'Въведи SWING_ADMIN_TOKEN.');
 if(token)void load();
});
refreshButton.addEventListener('click',()=>{
 token=e('token').value.trim()||token;
 uiMessage(token?'Обновяване…':'Въведи SWING_ADMIN_TOKEN.');
 if(token)void load();
});

// UI-only pagination: preserves the complete API response and all statistics.
const uiPageSize=10;
const uiPages=Object.create(null);
function paginateTable(container,key){
 if(!container)return;
 const table=container.querySelector('table');
 if(!table)return;
 const body=table.tBodies[0];
 if(!body)return;
 const rows=Array.from(body.rows);
 const total=Math.max(1,Math.ceil(rows.length/uiPageSize));
 const page=Math.min(Math.max(0,uiPages[key]||0),total-1);
 uiPages[key]=page;
 rows.forEach((row,i)=>{row.hidden=i<page*uiPageSize||i>=(page+1)*uiPageSize;});
 let nav=container.querySelector('[data-pager-key="'+key+'"]');
 if(!nav){nav=document.createElement('div');nav.className='pager';nav.dataset.pagerKey=key;table.insertAdjacentElement('afterend',nav);}
 nav.innerHTML='<button type="button" data-page-key="'+key+'" data-page-dir="-1" '+(page===0?'disabled':'')+'>◀ Назад</button>'+
 '<span>Страница '+(page+1)+' / '+total+' · '+rows.length+' записа</span>'+
 '<button type="button" data-page-key="'+key+'" data-page-dir="1" '+(page>=total-1?'disabled':'')+'>Напред ▶</button>';
 if(rows.length<=uiPageSize)nav.style.display='none';else nav.style.display='flex';
}
function paginateSection(id){paginateTable(e(id),id);}
function paginateArchive(){
 e('archive').querySelectorAll('details').forEach((item,i)=>paginateTable(item,'archive-'+i));
}
function paginateAll(){
 ['rejected-rows','rejected-reasons','early-rows','candidate-rows','early-exit-v2-rows','early-exit-rows','early-check-details'].forEach(paginateSection);
 paginateArchive();
}
function renderFilters(rows,regime){
 const groups=['1H LONG','4H LONG','1H SHORT','4H SHORT'];
 e('filter-content').innerHTML=groups.map(g=>{
 const subset=rows.filter(x=>x.strategy===g);
 return '<div class="filter-group"><h3>'+esc(g)+' · '+subset.length+'</h3>'+['LONG_REGIME','SHORT_REGIME','NEUTRAL'].map(r=>{
 const items=subset.filter(x=>x.regime===r);
 return '<details class="filter-regime"><summary>'+esc(r)+' · '+items.length+(regime===r?' · АКТИВЕН РЕЖИМ':'')+'</summary>'+(items.length?'<div class="scroll filter-table"><table><thead><tr><th>Патерн</th><th>TP</th><th>SL</th></tr></thead><tbody>'+items.map(x=>'<tr><td>'+esc(x.pattern)+'</td><td>'+esc(x.tp)+'%</td><td>'+esc(x.sl)+'%</td></tr>').join('')+'</tbody></table></div>':'<small>Няма разрешени входове.</small>')+'</details>';
 }).join('')+'</div>';
 }).join('');
}
function renderRejected(d){
 const x=d.rejected||{},a=x.stats||{},rows=x.rows||[];
 e('rejected-stats').innerHTML=x.error?'<span class="bad">D1: '+esc(x.error)+'</span>':Object.entries({REJECTED:a.total,TRACKING:a.tracking,'WOULD TP':a.would_tp,'WOULD SL':a.would_sl,UNKNOWN:a.unknown,'GROSS % SUM':a.estimated_gross_pct}).map(([k,v])=>'<div class="stat"><small>'+esc(k)+'</small><br><b>'+esc(v)+'</b></div>').join('');
 e('rejected-reasons').innerHTML='<table><thead><tr><th>Причина</th><th>Общо</th><th>TP</th><th>SL</th><th>UNKNOWN</th><th>TRACKING</th></tr></thead><tbody>'+(a.by_reason||[]).map(g=>'<tr><td>'+esc(g.reason)+'</td><td>'+g.total+'</td><td>'+g.tp+'</td><td>'+g.sl+'</td><td>'+g.unknown+'</td><td>'+g.tracking+'</td></tr>').join('')+'</tbody></table>';
 const term=e('rejected-search').value.trim().toUpperCase(),side=e('rejected-side').value,status=e('rejected-status').value;
 const selected=rows.filter(r=>(!side||r.side===side)&&(!status||r.status===status)&&(!term||[r.coin,r.pattern,(r.reasons||[]).join(' ')].join(' ').toUpperCase().includes(term)));
 e('rejected-rows').innerHTML='<table><thead><tr><th>Отказ</th><th>Монета</th><th>Посока</th><th>TF</th><th>Модел</th><th>Цена</th><th>RSI5m</th><th>Причини</th><th>Резултат</th><th>Минути</th></tr></thead><tbody>'+pageRows(selected,'rejected').map(r=>'<tr><td>'+dt(r.rejected_at)+'</td><td>'+esc(r.coin)+'</td><td>'+esc(r.side)+'</td><td>'+esc(r.interval)+'</td><td>'+esc(r.pattern)+'</td><td>'+esc(r.entry_price)+'</td><td>'+esc(r.indicators?.rsi14_5m_wilder)+'</td><td>'+esc((r.reasons||[]).join(', '))+'</td><td class="'+(r.status==='WOULD_TP'?'good':r.status==='WOULD_SL'?'bad':'')+'">'+esc(r.status)+'</td><td>'+esc(r.minutes_to_outcome)+'</td></tr>').join('')+'</tbody></table>'+pageNav('rejected',selected.length)+(x.limited?'<small>Последните 2000 отказа</small>':'');
}
['rejected-search','rejected-side','rejected-status'].forEach(k=>e(k).addEventListener('input',()=>{if(latestData){uiPages['rejected-rows']=0;renderRejected(latestData);paginateSection('rejected-rows')}}));

function compareStatsHtml(d){
 const x=d.earlyLiveComparison||{},a=x.stats||{};
 if(x.error)return '<span class="bad">D1 сравнение: '+esc(x.error)+'</span>';
 return Object.entries({'СРАВНИМИ ВХОДОВЕ':a.total??0,'EARLY ПО-ДОБРА':a.early_better??0,'LIVE ПО-ДОБРА':a.live_better??0,'СРЕДНО EARLY %':a.avg_advantage_pct==null?'—':Number(a.avg_advantage_pct).toFixed(3)+'%','МИН ДО ДИАГНОСТИКА':a.avg_minutes_to_audit==null?'—':Number(a.avg_minutes_to_audit).toFixed(1)}).map(([k,v])=>'<div class="stat"><small>'+esc(k)+'</small><br><b>'+esc(v)+'</b></div>').join('');
}
function comparisonTableRows(rows){return rows.map(r=>'<tr><td>'+dt(r.early_at)+'</td><td>'+esc(r.coin)+'</td><td>'+esc(r.side)+'</td><td>'+esc(r.interval)+'</td><td>'+esc(r.pattern)+'</td><td>'+esc(r.early_price)+'</td><td>'+dt(r.live_signal_at)+'</td><td>'+esc(r.live_fill_price)+'</td><td>'+dt(r.audit_at)+'</td><td class="'+(r.advantage_pct>0?'good':r.advantage_pct<0?'bad':'')+'">'+Number(r.advantage_pct).toFixed(3)+'%</td></tr>').join('');}
const compareHead='<table><thead><tr><th>EARLY открит</th><th>Монета</th><th>Посока</th><th>TF</th><th>Избрана формация</th><th>EARLY цена</th><th>LIVE сигнал</th><th>LIVE fill цена</th><th>Час диагностика</th><th>EARLY предимство</th></tr></thead><tbody>';
function renderEarly(d){
 const x=d.early||{},rows=x.rows||[],cmp=d.earlyLiveComparison||{};
 const all=e('early-scope').value==='ALL';
 e('early-stats').innerHTML=compareStatsHtml(d)+(all?'<div class="stat">Всички EARLY наблюдения: '+esc(rows.length)+'</div>':'');
 const term=e('early-search').value.trim().toUpperCase(),side=e('early-side').value,status=e('early-status').value,confirmed=e('early-confirmed').value;
 const blocked=e('early-blocked').value;
 const flag=v=>v==null?'PENDING':v?'YES':'NO';
 if(!all){
  const selected=(cmp.rows||[]).filter(r=>(!side||r.side===side)&&(!term||[r.coin,r.pattern,r.interval].join(' ').toUpperCase().includes(term)));
  e('early-rows').innerHTML=compareHead+comparisonTableRows(pageRows(selected,'early'))+'</tbody></table>'+pageNav('early',selected.length);
  return;
 }
 const selected=rows.filter(r=>(!side||r.side===side)&&(!status||r.status===status)&&(!confirmed||flag(r.live_confirmed)===confirmed)&&(!blocked||flag(r.live_blocked)===blocked)&&(!term||[r.coin,r.pattern,r.note,r.regime].join(' ').toUpperCase().includes(term)));
 e('early-rows').innerHTML='<table><thead><tr><th>Открит</th><th>Монета</th><th>Посока</th><th>TF</th><th>Модел</th><th>EARLY цена</th><th>EARLY фаза</th><th>LIVE кандидат</th><th>Избран модел</th><th>Queue</th></tr></thead><tbody>'+pageRows(selected,'early').map(r=>'<tr><td>'+dt(r.first_seen_at)+'</td><td>'+esc(r.coin)+'</td><td>'+esc(r.side)+'</td><td>'+esc(r.interval)+'</td><td>'+esc(r.pattern)+'</td><td>'+esc(r.entry_price)+'</td><td>'+esc(r.status)+'</td><td>'+esc(r.candidate_stage)+'</td><td>'+esc(r.candidate_selected?'ДА':'НЕ')+'</td><td>'+esc(r.live_queue_status)+'</td></tr>').join('')+'</tbody></table>'+pageNav('early',selected.length);
}
['early-scope','early-search','early-side','early-status','early-confirmed','early-blocked'].forEach(k=>e(k).addEventListener('input',()=>{if(latestData){uiPages['early-rows']=0;renderEarly(latestData);paginateSection('early-rows')}}));
function renderLiveCandidates(d){
 const x=d.liveCandidates||{},rows=x.rows||[],cmp=d.earlyLiveComparison||{};
 const all=e('candidate-scope').value==='ALL';
 e('candidate-stats').innerHTML=compareStatsHtml(d)+(all?'<div class="stat">Всички кандидати: '+esc(rows.length)+'</div>':'');
 const term=e('candidate-search').value.trim().toUpperCase(),side=e('candidate-side').value,stage=e('candidate-stage').value;
 if(!all){
  const selected=(cmp.rows||[]).filter(r=>(!side||r.side===side)&&(!term||[r.coin,r.pattern,r.interval].join(' ').toUpperCase().includes(term)));
  e('candidate-rows').innerHTML=compareHead+comparisonTableRows(pageRows(selected,'candidates'))+'</tbody></table>'+pageNav('candidates',selected.length);
  return;
 }
 const selected=rows.filter(r=>(!side||r.side===side)&&(!stage||r.stage===stage)&&(!term||[r.coin,r.selected_pattern,r.patterns_json,r.reason].join(' ').toUpperCase().includes(term)));
 e('candidate-rows').innerHTML='<table><thead><tr><th>Първо видян</th><th>LIVE сигнал</th><th>Монета</th><th>Посока</th><th>TF</th><th>Избран модел</th><th>Кандидат цена</th><th>Статус</th><th>Проверки</th><th>Причина</th></tr></thead><tbody>'+pageRows(selected,'candidates').map(r=>'<tr><td>'+dt(r.first_seen_at)+'</td><td>'+dt(r.signal_available_at)+'</td><td>'+esc(r.coin)+'</td><td>'+esc(r.side)+'</td><td>'+esc(r.interval)+'</td><td>'+esc(r.selected_pattern)+'</td><td>'+esc(r.reference_price)+'</td><td>'+esc(r.stage)+'</td><td>'+esc(r.checks)+'</td><td>'+esc(r.reason)+'</td></tr>').join('')+'</tbody></table>'+pageNav('candidates',selected.length);
}
['candidate-scope','candidate-search','candidate-side','candidate-stage'].forEach(k=>e(k).addEventListener('input',()=>{if(latestData){uiPages['candidate-rows']=0;renderLiveCandidates(latestData);paginateSection('candidate-rows')}}));

async function checkEarlyScanner(){
 const btn=e('early-check'),status=e('early-check-status');
 if(!token){status.textContent='Въведи SWING_ADMIN_TOKEN и натисни Свържи.';return;}
 btn.disabled=true;status.textContent='Проверявам скенера…';
 e('early-check-stats').innerHTML='';e('early-check-details').textContent='';e('early-check-json').textContent='';
 try{
  const offset=Number(e('early-offset').value)||0;
  const res=await fetch('/api/swing/early/run?offset='+offset+'&limit=5',{method:'POST',headers:{'x-swing-token':token},cache:'no-store'});
  const raw=await res.text();let d;
  try{d=JSON.parse(raw)}catch{throw Error('NON_JSON_RESPONSE HTTP '+res.status+': '+raw.slice(0,500))}
  e('early-check-json').textContent=JSON.stringify({...d,scanned:Array.isArray(d.scanned)?d.scanned.slice(0,10):d.scanned,candidateAudit:d.candidateAudit?{...d.candidateAudit,rows:(d.candidateAudit.rows||[]).slice(0,10)}:undefined},null,2)+'\n[Диагностичният JSON е съкратен до 10 записа за визуализация.]';
  if(!res.ok||d.success===false){status.textContent='❌ Грешка HTTP '+res.status+' · '+String(d.error||d.message||'UNKNOWN');return;}
  status.textContent='✅ Заявката завърши · '+new Date().toLocaleString('bg-BG',{timeZone:'Europe/Sofia'});
  const scans=Array.isArray(d.scanned)?d.scanned:Array.isArray(d.results)?d.results:Array.isArray(d.coins)?d.coins:[];
  const errors=Array.isArray(d.errors)?d.errors:[];
  const total=(k)=>scans.reduce((sum,r)=>sum+(Number(r[k])||0),0);
  const items=[['Проверени записи',scans.length||d.scanned_count||'—'],['Формации',d.hits??d.hits_found??total('hits')],['Нови сигнали',d.inserted??d.signals_created??total('inserted')],['Грешки',errors.length||d.error_count||0]];
  e('early-check-stats').innerHTML=items.map(x=>'<div class="stat"><small>'+esc(x[0])+'</small><br><b>'+esc(x[1])+'</b></div>').join('');
  if(scans.length){e('early-check-details').innerHTML='<table><thead><tr><th>Монета</th><th>Интервал</th><th>Статус</th><th>Формации</th><th>Нови</th><th>Грешка</th></tr></thead><tbody>'+scans.slice(0,10).map(r=>'<tr><td>'+esc(r.coin)+'</td><td>'+esc(r.interval)+'</td><td>'+esc(r.status||'—')+'</td><td>'+esc(r.hits??'—')+'</td><td>'+esc(r.inserted??'—')+'</td><td>'+esc(r.error||'—')+'</td></tr>').join('')+'</tbody></table>'}
  else e('early-check-details').textContent='API не върна списък по монети; виж пълния JSON.';
  uiPages['early-check-details']=0;paginateSection('early-check-details');
 }catch(err){status.textContent='❌ '+String(err?.message||err)}finally{btn.disabled=false;}
}
e('early-check').addEventListener('click',checkEarlyScanner);

function renderEarlyExit(d){
 const x=d.earlyExit||{}, v2=x.v2||{}, a=x.stats||{}, rows=x.rows||[];
 const summary=(stats,extra)=>Object.entries({...stats,...extra}).map(([k,v])=>'<div class="stat"><small>'+esc(k)+'</small><br><b>'+esc(v)+'</b></div>').join('');
 if(x.error){e('early-exit-v2-stats').innerHTML='<span class="bad">D1: '+esc(x.error)+'</span>';e('early-exit-v2-rows').innerHTML='';return;}
 const a2=v2.stats||{};
 e('early-exit-v2-stats').innerHTML=summary({'ПОЗИЦИИ':a2.total??0,'НАБЛЮДЕНИЕ':a2.monitoring??0,'ПРЕДУПРЕЖДЕНИЯ':(v2.rows||[]).filter(r=>r.first_warning_at!=null).length,'FAST':v2.fast??0,'TREND':v2.trend??0,'ПРЕДЛОЖЕНИЯ':a2.proposed??0,'СРАВНЕНИ':a2.compared??0,'БЕЗ ПРЕДЛОЖЕНИЕ':a2.closed_without_proposal??0,'ПРОПУСНАТИ TP':a2.missed_tp??0,'РАЗЛИКА БРУТНО (п.п.)':a2.estimated_gross_difference_pp??0},{});
 const v2rows=v2.rows||[];
 e('early-exit-v2-rows').innerHTML=v2rows.length?'<table><thead><tr><th>Монета</th><th>Посока</th><th>Вход</th><th>Статус</th><th>Режим</th><th>Риск</th><th>Market</th><th>Position</th><th>Предупреждение</th><th>Предложен изход</th><th>Предложен %</th><th>Реален %</th><th>Разлика (п.п.)</th><th>Причини</th><th>Наблюдения</th></tr></thead><tbody>'+pageRows(v2rows,'exit-v2').map(r=>'<tr><td>'+esc(r.coin)+'</td><td>'+esc(r.side)+'</td><td>'+esc(r.entry_price)+'</td><td>'+esc(r.status)+'</td><td>'+esc(r.proposal_mode||'—')+'</td><td>'+esc(r.risk_score)+'</td><td>'+esc(r.market_danger)+'</td><td>'+esc(r.position_danger)+'</td><td>'+dt(r.first_warning_at)+'</td><td>'+esc(r.proposal_price)+'</td><td>'+pct(r.proposal_gross_pct)+'</td><td>'+pct(r.actual_gross_pct)+'</td><td class="'+cls(r.comparison_gross_pp)+'">'+pct(r.comparison_gross_pp)+'</td><td>'+esc(r.proposal_reasons_json)+'</td><td>'+esc(r.observations)+'</td></tr>').join('')+'</tbody></table>'+pageNav('exit-v2',v2rows.length):'<p>V2 все още няма записи. Провери дали V2 worker изпълнява runSwingEarlyExitCycle и има достъп до същата D1 база.</p>';
 e('early-exit-stats').innerHTML=summary({'ПОЗИЦИИ':a.total??0,'НАБЛЮДЕНИЕ':a.monitoring??0,'ПРЕДЛОЖЕН ИЗХОД':a.proposed??0,'СРАВНЕНИ':a.compared??0,'ПРОПУСНАТИ TP':a.missed_tp??0,'РАЗЛИКА БРУТНО (п.п.)':a.estimated_gross_difference_pp??0},{});
 e('early-exit-rows').innerHTML='<table><thead><tr><th>Монета</th><th>Посока</th><th>Вход</th><th>Статус</th><th>Текущ %</th><th>Market danger</th><th>Position danger</th><th>Предложен изход</th><th>Предложен %</th><th>Реален изход</th><th>Реален %</th><th>Разлика (п.п.)</th><th>Причини</th></tr></thead><tbody>'+pageRows(rows,'exit').map(r=>'<tr><td>'+esc(r.coin)+'</td><td>'+esc(r.side)+'</td><td>'+esc(r.entry_price)+'</td><td>'+esc(r.status)+'</td><td>'+pct(r.last_gross_pct)+'</td><td>'+esc(r.market_danger)+'</td><td>'+esc(r.position_danger)+'</td><td>'+esc(r.proposal_price)+'</td><td>'+pct(r.proposal_gross_pct)+'</td><td>'+esc(r.actual_exit_price)+'</td><td>'+pct(r.actual_gross_pct)+'</td><td class="'+cls(r.comparison_gross_pp)+'">'+pct(r.comparison_gross_pp)+'</td><td>'+esc(r.proposal_reasons_json)+'</td></tr>').join('')+'</tbody></table>'+pageNav('exit',rows.length);
}

function table(rows){return !rows.length?'<p>Няма сделки</p>':'<table><thead><tr><th>Монета</th><th>Формула</th><th>Резултат</th><th>ROI</th><th>NET P/L</th><th>Вход</th><th>Изход</th><th>Дата</th></tr></thead><tbody>'+rows.map(r=>'<tr><td>'+esc(r.coin)+'</td><td>'+esc(r.formula)+(r.patterns?'<br><small>'+esc(r.patterns)+'</small>':'')+'</td><td>'+esc(r.result)+'</td><td class="'+cls(r.roi_pct)+'">'+pct(r.roi_pct)+'</td><td class="'+cls(r.net_pnl_usd)+'">'+money(r.net_pnl_usd)+'</td><td>'+esc(r.entry_price)+'</td><td>'+esc(r.exit_price)+'</td><td>'+dt(r.closed_at||r.entry_at)+'</td></tr>').join('')+'</tbody></table>'}
const pageSize=10;const pages={long:0,short:0};let latestData=null;
function pageRows(rows,key){const max=Math.max(1,Math.ceil(rows.length/pageSize));pages[key]=Math.min(Math.max(0,pages[key]||0),max-1);return rows.slice(pages[key]*pageSize,(pages[key]+1)*pageSize)}
function pageNav(key,total){const max=Math.max(1,Math.ceil(total/pageSize)),cur=(pages[key]||0)+1;return '<div class="pagination"><button data-page-key="'+esc(key)+'" data-page-dir="-1" '+(cur<=1?'disabled':'')+'>◀ Назад</button> Страница '+cur+' / '+max+' · '+total+' записа <button data-page-key="'+esc(key)+'" data-page-dir="1" '+(cur>=max?'disabled':'')+'>Напред ▶</button></div>'}
function renderArchive(d){e('archive').innerHTML=(d.archive||[]).map(a=>{const key='archive:'+a.day;return '<details data-archive-day="'+esc(a.day)+'"><summary>'+esc(a.day)+' · '+a.rows.length+' сделки · NET <span class="'+cls(a.pnl)+'">'+money(a.pnl)+'</span> · ROI '+pct(a.roi)+'</summary><div class="scroll">'+table(pageRows(a.rows,key))+pageNav(key,a.rows.length)+'</div></details>'}).join('')||'<p>Няма архив</p>'}
function rerenderPage(key){if(!latestData)return;if(key==='rejected')renderRejected(latestData);else if(key==='early')renderEarly(latestData);else if(key==='candidates')renderLiveCandidates(latestData);else if(key==='exit-v2'||key==='exit')renderEarlyExit(latestData);else if(key.startsWith('archive:')){const open=[...document.querySelectorAll('[data-archive-day]')].filter(x=>x.open).map(x=>x.dataset.archiveDay);renderArchive(latestData);document.querySelectorAll('[data-archive-day]').forEach(x=>{x.open=open.includes(x.dataset.archiveDay)})}}
document.addEventListener('click',ev=>{const t=ev.target?.closest?.('[data-page-key]');if(!t)return;const key=t.dataset.pageKey;pages[key]=Math.max(0,(pages[key]||0)+Number(t.dataset.pageDir));rerenderPage(key)});

function paged(rows,key){const max=Math.max(1,Math.ceil(rows.length/pageSize));pages[key]=Math.min(Math.max(0,pages[key]),max-1);const prev='<button data-side="'+key+'" data-dir="-1">◀</button>';const next='<button data-side="'+key+'" data-dir="1">▶</button>';return table(rows.slice(pages[key]*pageSize,(pages[key]+1)*pageSize))+'<p>'+prev+' Страница '+(pages[key]+1)+' / '+max+' '+next+'</p>'}
function turnPage(key,dir){pages[key]+=dir;if(latestData)renderSide(key,latestData[key],latestData[key+'_rows'])}
document.addEventListener('click',ev=>{const t=ev.target;if(t&&t.dataset&&t.dataset.side)turnPage(t.dataset.side,Number(t.dataset.dir))});
function renderSide(side,s,rows){e(side+'-stats').innerHTML=Object.entries({TP:s.tp,SL:s.sl,'TIME EXIT':s.time_exit,'MANUAL CLOSE':s.manual_close,OTHER:s.other,OPEN:s.open,'NET P/L':money(s.pnl),'ROI %':pct(s.roi)}).map(([k,v])=>'<div class="stat"><small>'+esc(k)+'</small><br><b>'+esc(v)+'</b></div>').join('');e(side+'-rows').innerHTML=paged(rows,side)}
let loading=false;
async function load(){
 if(!token){uiMessage('Въведи токен.');return;}
 if(loading)return;
 loading=true;connectButton.disabled=true;refreshButton.disabled=true;
 uiMessage('Зареждане от SWING LIVE API…');
 try{
 const controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),20000);
 let r,raw;
 try{
  r=await fetch('/api/swing/live-monitor',{headers:{'x-swing-token':token},cache:'no-store',signal:controller.signal});
  raw=await r.text();
 }finally{clearTimeout(timeout);}
 let d;
 try{d=JSON.parse(raw);}catch(_){throw Error('API върна невалиден JSON (HTTP '+r.status+'): '+raw.slice(0,200));}
 if(!r.ok||!d.success)throw Error('HTTP '+r.status+': '+(d.error||'API_ERROR'));
e('error').textContent=d.account?.ok?'':('Hyperliquid: '+(d.account?.error||'няма данни'));const m=d.market||{label:'—',regime:'—',long_signals:0,short_signals:0,total_signals:0};e('market-status').textContent='Market Status: '+m.label+' · '+m.regime+' · LONG '+m.long_signals+' / SHORT '+m.short_signals+' ('+m.total_signals+' за 24ч)';renderFilters(d.signal_filters||[],m.regime);e('balance').textContent=money(d.account?.balance);e('balance').title=d.account?.warning||'';e('free').textContent=money(d.account?.free);e('free').title='Ориентировъчно: TOTAL − използван маржин '+money(d.account?.used_margin_estimate)+'; Exchange withdrawable: '+money(d.account?.exchange_withdrawable);e('exchange').textContent=d.account?.open_positions??'—';e('open').textContent=d.swing_open;latestData=d;renderSide('long',d.long,d.long_rows);renderSide('short',d.short,d.short_rows);renderRejected(d);renderEarly(d);renderLiveCandidates(d);renderEarlyExit(d);renderArchive(d);e('updated').textContent='Обновено: '+dt(d.updated_at)+(d.archive_limited?' · Архивът е ограничен до 3000 записа':'');}catch(err){uiMessage('Грешка при зареждане: '+String(err?.message||err));}
 finally{loading=false;connectButton.disabled=false;refreshButton.disabled=false;}
}
if(token)void load();
setInterval(()=>{if(token&&document.visibilityState==='visible')void load()},30000);
</script></body></html>`}
export async function handleSwingLiveMonitor(req:Request,env:Env):Promise<Response|null>{const path=new URL(req.url).pathname;if(path!=='/swing-hunter/live-monitor'&&path!=='/api/swing/live-monitor')return null;if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);if(path==='/swing-hunter/live-monitor')return new Response(html(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store, no-cache, must-revalidate','x-content-type-options':'nosniff'}});if(!env.SWING_ADMIN_TOKEN)return json({success:false,error:'TOKEN_NOT_CONFIGURED'},503);if(req.headers.get('x-swing-token')!==env.SWING_ADMIN_TOKEN)return json({success:false,error:'UNAUTHORIZED'},401);try{return json(await data(env))}catch(err:any){return json({success:false,error:String(err?.message||err)},502)}}
