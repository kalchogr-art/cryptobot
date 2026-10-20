import { swingFilteredRead } from './swing-filter-cache';
import {scanAndLog,settleSignals,recentSignals} from './signal-logger';
import {swingMonitorDashboard} from './swing-monitor-dashboard';
import {handleSwingLiveMonitor} from './swing-live-monitor';
import {swingABDashboard} from './swing-ab-dashboard';
import {tpFirstTouchCoin} from './tp-first-touch';
import {tpSlFirstTouchCoin} from './tp-sl-first-touch';
import {entryResearchCoin} from './entry-research';
import {chartLearningCoin,chartLearningMarket} from './chart-pattern-learning';
import {fetchClosed,quality,COINS} from './ohlcv';
import type {Interval} from './types';
import {decide} from './decision-engine';
import {shadowProjection} from './shadow-trades';
import {dashboard} from './dashboard';
import {scanMarket} from './scanner';
import {replayCoin} from './replay';
import {researchCoin,compareCoin} from './research';
import {healthReport} from './stability';
import {outcomeCoin} from './outcomes';
import {auditCoin} from './accuracy-audit';
import {unifiedCoin,unifiedMarket} from './unified-backtest';
import {detectCatalog,CATALOG_IDS} from './pattern-catalog';
import {intelligenceCoin,intelligenceMarket,intelligenceDashboard} from './pattern-intelligence';

// Signal collection resumed; existinjg D1 records are retained.
const NEW_SIGNALS_ENABLED = true;

const json=(x:unknown,status=200)=>new Response(JSON.stringify(x,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});

async function resolvedCount(env:any){
 if(!env.SWING_DB?.prepare)throw new Error('MISSING_SWING_DB_BINDING');
 const row=await env.SWING_DB.prepare("SELECT COUNT(*) AS resolved FROM swing_context_signals WHERE status='RESOLVED'").first();
 return {success:true,module:'SWING_RESOLVED_COUNT',read_only:true,resolved:Number(row?.resolved||0)};
}

// Today is the current calendar day in Europe/Sofia; all-time retains the complete archive.
function swingTodayStartMs():number {
 const now=new Date();
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const [year,month,day]=date.split('-').map(Number);
 const localMidnight=Date.UTC(year,month-1,day);
 const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 let candidate=localMidnight-2*3600000;
 for(let i=0;i<3;i++){
  const parts=Object.fromEntries(fmt.formatToParts(new Date(candidate)).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
  const represented=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute);
  candidate+=localMidnight-represented;
 }
 return candidate;
}
function swingPeriod(u:URL):'today'|'total' {
 const period=u.searchParams.get('period')||'total';
 if(period!=='today'&&period!=='total')throw Error('INVALID_PERIOD');
 return period;
}

async function swingHistory(env:any,u:URL){
 if(!env.SWING_DB?.prepare)throw new Error('MISSING_SWING_DB_BINDING');
 const clamp=(v:string|null,d:number,min:number,max:number)=>{const n=Number(v);return v!==null&&Number.isFinite(n)?Math.max(min,Math.min(max,Math.floor(n))):d};
 const limit=clamp(u.searchParams.get('limit'),100,1,100);
 const page=clamp(u.searchParams.get('page'),1,1,100000);
 const period=swingPeriod(u);
 const side=u.searchParams.get('side')||'';
 const status=u.searchParams.get('status')||'';
 const interval=u.searchParams.get('interval')||'';
 const coin=(u.searchParams.get('coin')||'').trim().toUpperCase();
 if(side&&!['LONG','SHORT'].includes(side))throw new Error('INVALID_SIDE');
 if(status&&!['TRACKING','RESOLVED'].includes(status))throw new Error('INVALID_STATUS');
 if(interval&&!['1h','4h','1d'].includes(interval))throw new Error('INVALID_INTERVAL');
 if(coin&&!/^[A-Z0-9_-]{1,10}$/.test(coin))throw new Error('INVALID_COIN');
 const where:string[]=[],args:any[]=[];
 if(period==='today'){where.push('signal_bar_open>=?');args.push(swingTodayStartMs())}
 if(side){where.push('side=?');args.push(side)}
 if(status){where.push('status=?');args.push(status)}
 if(interval){where.push('interval=?');args.push(interval)}
 if(coin){where.push('coin LIKE ?');args.push('%'+coin+'%')}
 const w=where.length?' WHERE '+where.join(' AND '):'';
 const d=env.SWING_DB;
 const [totalRow,statsRow]=await Promise.all([
  d.prepare('SELECT COUNT(*) AS n FROM swing_context_signals'+w).bind(...args).first(),
  d.prepare(`SELECT COUNT(*) AS total,
   COALESCE(SUM(CASE WHEN status='TRACKING' THEN 1 ELSE 0 END),0) AS tracking,
   COALESCE(SUM(CASE WHEN status='RESOLVED' THEN 1 ELSE 0 END),0) AS resolved,
   COALESCE(SUM(CASE WHEN side='LONG' THEN 1 ELSE 0 END),0) AS longs,
   COALESCE(SUM(CASE WHEN side='SHORT' THEN 1 ELSE 0 END),0) AS shorts
   FROM swing_context_signals${period==='today'?' WHERE signal_bar_open>='+swingTodayStartMs():''}`).first()
 ]);
 const total=Number(totalRow?.n||0),pages=Math.max(1,Math.ceil(total/limit));
 const actualPage=Math.min(page,pages),offset=(actualPage-1)*limit;
 const result=await d.prepare('SELECT * FROM swing_context_signals'+w+' ORDER BY signal_bar_open DESC,id DESC LIMIT ? OFFSET ?').bind(...args,limit,offset).all();
 const parse=(v:any)=>{if(typeof v!=='string'||!v)return null;try{return JSON.parse(v)}catch{return null}};
 return {success:true,module:'SWING_HISTORY_V1_9_5',read_only:true,trading:false,
  stats:{total:Number(statsRow?.total||0),tracking:Number(statsRow?.tracking||0),resolved:Number(statsRow?.resolved||0),longs:Number(statsRow?.longs||0),shorts:Number(statsRow?.shorts||0)},
  period,filteredTotal:total,page:actualPage,pages,limit,
  rows:(result.results||[]).map((r:any)=>({...r,context:parse(r.context_json),outcome:parse(r.outcome_json),context_json:undefined,outcome_json:undefined}))};
}


// One SHORT opportunity per coin + interval + signal candle.
// The existing D1 table and LONG records are not modified.
async function filteredShortHistory(env:any,u:URL){
 if(!env.SWING_DB?.prepare)throw new Error('MISSING_SWING_DB_BINDING');
 const numberParam=(key:string,def:number,min:number,max:number)=>{
  const v=u.searchParams.get(key),n=Number(v);
  return v!==null&&Number.isInteger(n)?Math.max(min,Math.min(max,n)):def;
 };
 const page=numberParam('page',1,1,100000),limit=numberParam('limit',50,1,100);
 const period=swingPeriod(u);
 const interval=u.searchParams.get('interval')||'';
 const status=u.searchParams.get('status')||'';
 const confirmations=u.searchParams.get('confirmations')||'';
 const coin=(u.searchParams.get('coin')||'').trim().toUpperCase();
 if(interval&&!['1h','4h'].includes(interval))throw Error('INVALID_INTERVAL');
 if(status&&!['TRACKING','TP_FIRST','SL_FIRST','TIME_EXIT','AMBIGUOUS','PENDING','CONFLICT'].includes(status))throw Error('INVALID_STATUS');
 if(confirmations&&!['1','2','3'].includes(confirmations))throw Error('INVALID_CONFIRMATIONS');
 if(coin&&!/^[A-Z0-9_-]{1,10}$/.test(coin))throw Error('INVALID_COIN');
 const args:any[]=[];
 const wheres:string[]=[];
 if(interval){wheres.push('interval=?');args.push(interval)}
 if(coin){wheres.push('coin=?');args.push(coin)}
 const having:string[]=[];
 if(status){having.push('result=?');args.push(status)}
 if(confirmations){having.push(confirmations==='3'?'confirmations>=3':'confirmations=?');if(confirmations!=='3')args.push(Number(confirmations))}
 const base=`WITH base AS (
 SELECT s.coin,s.interval,s.signal_bar_open,s.pattern,s.status,
        s.reference_price,s.entry_price,
        json_extract(s.context_json,'$.indicators.rsi14') AS rsi,
        json_extract(s.context_json,'$.volume.relativeVolume') AS relative_volume,
        (SELECT json_extract(j.value,'$.status')
           FROM json_each(s.outcome_json,'$.scenarios') j
          WHERE CAST(json_extract(j.value,'$.tp') AS REAL)=2
            AND CAST(json_extract(j.value,'$.sl') AS REAL)=1 LIMIT 1) AS scenario_result,
        (SELECT CAST(json_extract(j.value,'$.hypotheticalNetPct') AS REAL)
           FROM json_each(s.outcome_json,'$.scenarios') j
          WHERE CAST(json_extract(j.value,'$.tp') AS REAL)=2
            AND CAST(json_extract(j.value,'$.sl') AS REAL)=1 LIMIT 1) AS scenario_net
 FROM swing_context_signals s
 WHERE s.side='SHORT' AND s.interval IN ('1h','4h')
   AND s.pattern IN ('DOUBLE_TOP','RANGE_BREAKDOWN','BEAR_ENGULF',
     'VOLUME_EXPANSION_SHORT','MOMENTUM_REVERSAL_SHORT','EMA_PULLBACK_SHORT')
   AND json_extract(s.context_json,'$.btcDirection.timeframes."1h".direction')='MIXED'
   ${period==='today'?'AND s.signal_bar_open>='+swingTodayStartMs():''}
), grouped AS (
 SELECT coin,interval,signal_bar_open,
        COUNT(DISTINCT pattern) AS confirmations,
        GROUP_CONCAT(DISTINCT pattern) AS patterns,
        ROUND(AVG(COALESCE(reference_price,entry_price)),8) AS entry_price,
        ROUND(AVG(CAST(rsi AS REAL)),2) AS rsi,
        ROUND(AVG(CAST(relative_volume AS REAL)),3) AS relative_volume,
        CASE WHEN SUM(CASE WHEN status='TRACKING' THEN 1 ELSE 0 END)>0 THEN 'TRACKING'
             WHEN COUNT(DISTINCT COALESCE(scenario_result,'PENDING'))>1 THEN 'CONFLICT'
             ELSE COALESCE(MAX(scenario_result),'PENDING') END AS result,
        ROUND(AVG(scenario_net),4) AS net
 FROM base GROUP BY coin,interval,signal_bar_open
), selected AS (
 SELECT * FROM grouped
 ${wheres.length?'WHERE '+wheres.join(' AND '):''}
), filtered AS (
 SELECT * FROM selected
 ${having.length?'WHERE '+having.join(' AND '):''}
)`;
 const d=env.SWING_DB;
 const [stats,rows]=await Promise.all([
  d.prepare(base+` SELECT COUNT(*) AS total,
   SUM(CASE WHEN result='TRACKING' THEN 1 ELSE 0 END) AS tracking,
   SUM(CASE WHEN result='TP_FIRST' THEN 1 ELSE 0 END) AS tp,
   SUM(CASE WHEN result='SL_FIRST' THEN 1 ELSE 0 END) AS sl
   FROM filtered`).bind(...args).first(),
  d.prepare(base+` SELECT * FROM filtered ORDER BY signal_bar_open DESC,coin,interval LIMIT ? OFFSET ?`)
   .bind(...args,limit,(page-1)*limit).all()
 ]);
 const total=Number(stats?.total||0);
 return {success:true,module:'SWING_FILTERED_SHORT_V1',read_only:true,trading:false,
  period,filters:{side:'SHORT',btc_1h:'MIXED',tp:2,sl:1},
  stats:{total,tracking:Number(stats?.tracking||0),tp:Number(stats?.tp||0),sl:Number(stats?.sl||0)},
  filteredTotal:total,page,pages:Math.max(1,Math.ceil(total/limit)),limit,rows:rows.results||[]};
}

/** SWING SHORT EXECUTABLE V2 — read-only portfolio replay.
 * One open SHORT per coin across 1h and 4h. Never places orders.
 * Historical OHLC first-touch time is known only to the end of its 1h bar.
 * Uncertain exits block re-entry; no invented closure timestamps.
 */
const PATTERNS = ['DOUBLE_TOP','RANGE_BREAKDOWN','BEAR_ENGULF','VOLUME_EXPANSION_SHORT','MOMENTUM_REVERSAL_SHORT','EMA_PULLBACK_SHORT'];
const HOUR = 3600000;
type Outcome = 'TP_FIRST'|'SL_FIRST'|'TIME_EXIT'|'AMBIGUOUS'|'TRACKING'|'PENDING'|'CONFLICT';
type Signal = {coin:string;interval:string;signal_bar_open:number;signal_available_at:number;patterns:string[];confirmations:number;entry_price:number|null;rsi:number|null;relative_volume:number|null;result:Outcome;net:number|null;exit_bar_open:number|null;exit_at:number|null;exit_precision:string;};
function number(x:any):number|null {const n=Number(x);return x===null||x===undefined||!Number.isFinite(n)?null:n;}
function parseReplayJson(x:any):any {try{return typeof x==='string'?JSON.parse(x):x||null;}catch{return null;}}
function toMs(x:any):number|null {if(typeof x==='number'&&Number.isFinite(x))return x;if(typeof x==='string'){const n=Date.parse(x);return Number.isFinite(n)?n:null;}return null;}
function todaySofia():number {
 const now=new Date(),parts=new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
 const p:any={};for(const x of parts)if(x.type!=='literal')p[x.type]=Number(x.value);
 const midnight=Date.UTC(p.year,p.month-1,p.day);
 let guess=midnight-2*HOUR;
 for(let i=0;i<3;i++){
  const q:any={};for(const x of new Intl.DateTimeFormat('en-US',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(guess)))if(x.type!=='literal')q[x.type]=Number(x.value);
  guess+=midnight-Date.UTC(q.year,q.month-1,q.day,q.hour,q.minute);
 }
 return guess;
}
function scenario(r:any){const o=parseReplayJson(r.outcome_json);return (o?.scenarios||[]).find((x:any)=>Number(x.tp)===2&&Number(x.sl)===1)||null;}
function group(rows:any[]):Signal[] {
 const groups=new Map<string,any[]>();
 for(const r of rows){const k=[r.coin,r.interval,r.signal_bar_open].join('|');const a=groups.get(k)||[];a.push(r);groups.set(k,a);}
 const result:Signal[]=[];
 for(const a of groups.values()){
  const first=a[0],states=a.map(r=>r.status==='TRACKING'?'TRACKING':scenario(r)?.status||'PENDING');
  const state:Outcome=states.includes('TRACKING')?'TRACKING':new Set(states).size>1?'CONFLICT':states[0] as Outcome;
  const touches=a.map(scenario).map(s=>toMs(s?.firstTouchBarOpen));
  const entryTimes=a.map(r=>number(r.signal_available_at)).filter((v):v is number=>v!==null);
  const prices=a.map(r=>number(r.reference_price??r.entry_price)).filter((v):v is number=>v!==null);
  const contexts=a.map(r=>parseReplayJson(r.context_json));
  const avg=(vals:(number|null)[])=>{const valid=vals.filter((v):v is number=>v!==null);return valid.length?valid.reduce((x,y)=>x+y,0)/valid.length:null;};
  const bar=states.every(s=>s===state)&&touches.every(t=>t!==null&&t===touches[0])?touches[0]:null;
  // TIME_EXIT: do not guess exit timestamp from resolved_at (settlement processing time).
  // First-touch: conservatively unlock only after the entire touched hourly candle.
  const completeTimeExit=state==='TIME_EXIT' && a.every(r=>{
    const o=parseReplayJson(r.outcome_json);
    const expected=r.interval==='1h'?48:r.interval==='4h'?72:0;
    return o?.windowComplete===true && Number(o.horizonHours)===expected &&
      scenario(r)?.status==='TIME_EXIT' && Number.isFinite(Number(scenario(r)?.hypotheticalNetPct));
  });
  const resolved=(state==='TP_FIRST'||state==='SL_FIRST')&&bar!==null;
  const timeoutAt=completeTimeExit ? Number(first.signal_bar_open)+(first.interval==='1h'?48:72)*HOUR : null;
  const net=avg(a.map(r=>number(scenario(r)?.hypotheticalNetPct)));
  result.push({coin:String(first.coin),interval:String(first.interval),signal_bar_open:Number(first.signal_bar_open),
   signal_available_at:entryTimes.length?Math.max(...entryTimes):Number(first.signal_bar_open)+(first.interval==='4h'?4:1)*HOUR,
   patterns:[...new Set(a.map(r=>String(r.pattern)))],confirmations:new Set(a.map(r=>r.pattern)).size,
   entry_price:avg(prices),rsi:avg(contexts.map(c=>number(c?.indicators?.rsi14))),
   relative_volume:avg(contexts.map(c=>number(c?.volume?.relativeVolume))),
   result:state,net,exit_bar_open:resolved?bar:null,
   exit_at:resolved?bar!+HOUR:(timeoutAt!==null&&timeoutAt>(entryTimes.length?Math.max(...entryTimes):0)?timeoutAt:null),
   exit_precision:resolved?'CONSERVATIVE_END_OF_1H_BAR':timeoutAt!==null?'VERIFIED_WINDOW_COMPLETE_TIME_EXIT':'UNKNOWN_BLOCKS_REENTRY'});
 }
 return result.sort((a,b)=>a.signal_available_at-b.signal_available_at||a.coin.localeCompare(b.coin)||a.interval.localeCompare(b.interval));
}
const swingReportCache=new Map<string,{expires:number,promise:Promise<any>}>();
function cachedSwingReport(env:any,u:URL):Promise<any>{
 const key=u.searchParams.toString();const now=Date.now();
 const existing=swingReportCache.get(key);
 if(existing&&existing.expires>now)return existing.promise;
 const promise=swingExecutableV2(env,u);
 swingReportCache.set(key,{expires:now+60000,promise});
 promise.catch(()=>{if(swingReportCache.get(key)?.promise===promise)swingReportCache.delete(key)});
 if(swingReportCache.size>32){for(const [k,v] of swingReportCache){if(v.expires<=now||swingReportCache.size>32)swingReportCache.delete(k)}}
 return promise;
}
async function swingExecutableV2(env:any,u:URL){
 const variant=u.searchParams.get('variant')||'A';
 if(!['A','B'].includes(variant))throw Error('INVALID_VARIANT');
 const mode=variant==='B'?'SHORT':u.searchParams.get('mode')||'ALL';
 if(!['SHORT','LONG','ALL'].includes(mode))throw Error('INVALID_MODE');
 if(!env.SWING_DB?.prepare)throw Error('MISSING_SWING_DB_BINDING');
 const allowed=['period','page','limit','coin','interval','status','breakdown','mode','variant'];
 for(const key of u.searchParams.keys())if(!allowed.includes(key))throw Error('UNSUPPORTED_FILTER_'+key);
 const period=u.searchParams.get('period')||'total';if(!['total','today'].includes(period))throw Error('INVALID_PERIOD');
 const coin=(u.searchParams.get('coin')||'').toUpperCase(),interval=u.searchParams.get('interval')||'',status=u.searchParams.get('status')||'';
 if(coin&&!/^[A-Z0-9_-]{1,10}$/.test(coin))throw Error('INVALID_COIN');
 if(interval&&!['1h','4h'].includes(interval))throw Error('INVALID_INTERVAL');
 if(status&&!['TRACKING','TP_FIRST','SL_FIRST','TIME_EXIT','AMBIGUOUS','PENDING','CONFLICT','SKIPPED_ALREADY_OPEN'].includes(status))throw Error('INVALID_STATUS');
 const bounded=(key:string,def:number,max:number)=>{const n=Number(u.searchParams.get(key));return Number.isInteger(n)&&n>0?Math.min(n,max):def;};
 const page=bounded('page',1,100000),limit=bounded('limit',50,100);
 // IMPORTANT: replay the FULL history first. Filtering by date/coin/TF before replay changes eligibility.
 // D1 all() can be truncated by row limits: use keyset paging with deterministic id ordering.
 const d=env.SWING_DB;const raw:any[]=[];let lastId=0;
 for(let batch=0;batch<200;batch++){
  const res=await d.prepare(`SELECT id,side,coin,interval,pattern,status,signal_bar_open,signal_available_at,reference_price,entry_price,context_json,outcome_json
   FROM swing_context_signals WHERE id>? AND interval IN ('1h','4h')
   AND ((side='SHORT' AND pattern IN (${PATTERNS.map(()=>'?').join(',')})
     AND json_extract(context_json,'$.btcDirection.timeframes."1h".direction')='MIXED' ${variant==='B'?`AND json_extract(context_json,'$.btcDirection.timeframes."4h".direction')='MIXED'`:''})
     OR (side='LONG' AND pattern='TRIANGLE_UP'
     AND json_extract(context_json,'$.btcDirection.timeframes."1h".direction')='MIXED'))
   ORDER BY id ASC LIMIT 500`).bind(lastId,...PATTERNS).all();
  const rows=res.results||[];raw.push(...rows);if(rows.length<500)break;
  lastId=Number(rows[rows.length-1].id);
  if(batch===199)throw Error('REPLAY_ROW_LIMIT_REACHED_REFUSING_PARTIAL_STATISTICS');
 }
 // Independent position locks for LONG and SHORT. No database changes.
 // Historical report: only completed TP/SL with a verified first-touch exit.
 // Exclude incomplete records BEFORE overlap replay so they never lock a coin.
 const isCompleted=(x:Signal)=> (x.result==='TP_FIRST'||x.result==='SL_FIRST'||x.result==='TIME_EXIT') && x.exit_at!==null && (x.result!=='TIME_EXIT'||x.net!==null);
 const shortSignals=group(raw.filter(r=>r.side==='SHORT')).filter(isCompleted);
 const longSignals=variant==='B'?[]:group(raw.filter(r=>r.side==='LONG')).filter(isCompleted);
 function replaySide(signals:Signal[]){
  const active=new Map<string,Signal>(),accepted:Signal[]=[],skipped:(Signal&{skip_reason:string;blocked_by:number})[]=[];
  for(const signal of signals){
   const old=active.get(signal.coin);
   if(old&&(old.exit_at===null||signal.signal_available_at<old.exit_at)){
    skipped.push({...signal,skip_reason:'SKIPPED_ALREADY_OPEN',blocked_by:old.signal_bar_open});continue;
   }
   accepted.push(signal);active.set(signal.coin,signal);
  }
  return {accepted,skipped};
 }
 const shortReplay=replaySide(shortSignals),longReplay=replaySide(longSignals);
 // D1 TRACKING means ALL scenario variants are pending, not necessarily TP2/SL1.
 // Inspect only the latest open research signal per coin and side. Read-only; never
 // convert a research signal into an exchange position or modify D1 status.
 const trackingShort=group(raw.filter(r=>r.side==='SHORT'&&r.status==='TRACKING')).filter(x=>x.result==='TRACKING');
 const trackingLong=group(raw.filter(r=>r.side==='LONG'&&r.status==='TRACKING')).filter(x=>x.result==='TRACKING');
 function newestByCoin(a:Signal[]):Signal[]{
  const m=new Map<string,Signal>();
  for(const x of a){const prev=m.get(x.coin);if(!prev||x.signal_available_at>prev.signal_available_at)m.set(x.coin,x);}
  return [...m.values()];
 }
 const latestShort=newestByCoin(trackingShort),latestLong=newestByCoin(trackingLong);
 const liveResearch=[...latestShort.map(x=>({...x,side:'SHORT'})),...latestLong.map(x=>({...x,side:'LONG'}))];
 const checkedResearch: (Signal & {side:string;verification:string})[]=[];
 const candleCache=new Map<string,any[]>();
 const now=Date.now();
 for(const x of liveResearch){
  let result:Outcome='TRACKING',exit_at:number|null=null,exit_bar_open:number|null=null;
  let verification='NOT_VERIFIED';
  try{
   // Avoid treating signals older than the available OHLC window as open.
   if(now-x.signal_available_at>220*HOUR){verification='OHLC_WINDOW_TOO_OLD';}
   else{
    if(!candleCache.has(x.coin)){
     const feed=await fetchClosed(x.coin,'1h',240);
     if(!quality(feed).ready)throw Error('OHLC_NOT_READY');
     candleCache.set(x.coin,feed.closed);
    }
    const all=candleCache.get(x.coin)!;
    const bars=all.filter((b:any)=>b.t>=x.signal_available_at&&b.t+HOUR<=now).sort((a:any,b:any)=>a.t-b.t);
    let expected=x.signal_available_at;
    let contiguous=true;
    for(const b of bars){if(b.t!==expected){contiguous=false;break;}expected+=HOUR;}
    if(!contiguous||(bars.length===0&&now>=x.signal_available_at+HOUR))verification='MISSING_OHLC_BARS';
    else if(x.entry_price===null||x.entry_price<=0)verification='INVALID_ENTRY';
    else{
     verification='OHLC_1H_TP2_SL1';
     for(const b of bars){
      const tp=x.side==='SHORT'?b.l<=x.entry_price*0.98:b.h>=x.entry_price*1.02;
      const sl=x.side==='SHORT'?b.h>=x.entry_price*1.01:b.l<=x.entry_price*0.99;
      if(tp||sl){
       result=tp&&sl?'AMBIGUOUS':tp?'TP_FIRST':'SL_FIRST';
       exit_bar_open=b.t;exit_at=b.t+HOUR;break;
      }
     }
    }
   }
  }catch(e){verification='OHLC_FETCH_ERROR:'+String(e);}
  checkedResearch.push({...x,side:x.side,result,
   net:result==='TP_FIRST'?1.82:result==='SL_FIRST'?-1.18:null,
   exit_bar_open,exit_at,exit_precision:verification,verification});
 }
 const trackingOnly=checkedResearch.filter(x=>x.result==='TRACKING');
 const recentlyResolved=checkedResearch.filter(x=>x.result==='TP_FIRST'||x.result==='SL_FIRST');

 // Data-source diagnostic: distinguish empty DB, missing regime, and empty replay.
 const sourceRow=await d.prepare(`SELECT COUNT(*) AS total,
  MIN(signal_bar_open) AS first_signal_ms, MAX(signal_bar_open) AS last_signal_ms,
  SUM(CASE WHEN side='SHORT' THEN 1 ELSE 0 END) AS shorts,
  SUM(CASE WHEN side='LONG' THEN 1 ELSE 0 END) AS longs,
  SUM(CASE WHEN json_extract(context_json,'$.btcDirection.timeframes."1h".direction')='MIXED' THEN 1 ELSE 0 END) AS mixed
  FROM swing_context_signals`).first();
 const source={total:Number(sourceRow?.total||0),first_signal_ms:sourceRow?.first_signal_ms??null,
  last_signal_ms:sourceRow?.last_signal_ms??null,shorts:Number(sourceRow?.shorts||0),
  longs:Number(sourceRow?.longs||0),mixed:Number(sourceRow?.mixed||0),
  matching_short:shortSignals.length,matching_long:longSignals.length};
 const signals=mode==='SHORT'?shortSignals:mode==='LONG'?longSignals:[...shortSignals,...longSignals];
 const accepted=mode==='SHORT'?shortReplay.accepted:mode==='LONG'?longReplay.accepted:[...shortReplay.accepted,...longReplay.accepted];
 const skipped=mode==='SHORT'?shortReplay.skipped:mode==='LONG'?longReplay.skipped:[...shortReplay.skipped,...longReplay.skipped];
 const breakdown=u.searchParams.get('breakdown')||'';
 if(breakdown&&breakdown!=='coins')throw Error('INVALID_BREAKDOWN');
 const start=period==='today'?todaySofia():-Infinity;
 // Coin leaderboard is calculated from the SAME accepted replay, not raw duplicated signals.
 // It intentionally ignores coin/status table filters; period and timeframe still apply.
 if(breakdown==='coins'){
  const tracked=['BTC','ETH','SOL','XRP','BNB','DOGE','AVAX','LINK','SUI','HYPE','ADA','LTC','BCH','AAVE','UNI','NEAR','OP','ARB','WIF','TRX'];
  const eligible=accepted.filter(s=>s.signal_available_at>=start&&(!interval||s.interval===interval));
  const trackingEligible=trackingOnly.filter(s=>s.signal_available_at>=start&&(!interval||s.interval===interval)&& (mode==='ALL'||s.side===mode));
  const names=[...new Set([...tracked,...eligible.map(s=>s.coin),...trackingEligible.map(s=>s.coin)])];
  const coins=names.map(name=>{
   const a=eligible.filter(s=>s.coin===name);
   const tp=a.filter(s=>s.result==='TP_FIRST').length;
   const sl=a.filter(s=>s.result==='SL_FIRST').length;
   const tracking=trackingEligible.filter(s=>s.coin===name).length;
   const timeExit=a.filter(s=>s.result==='TIME_EXIT'&&s.net!==null);
   const time_exit_win=timeExit.filter(s=>Number(s.net)>0).length;
   const time_exit_loss=timeExit.filter(s=>Number(s.net)<0).length;
   const time_exit_flat=timeExit.length-time_exit_win-time_exit_loss;
   const resolved=tp+sl+timeExit.length;
   return {coin:name,entries:a.length,tp,sl,time_exit_win,time_exit_loss,time_exit_flat,tracking,resolved,net_win_rate_pct:resolved?Number((100*(tp+time_exit_win)/resolved).toFixed(2)):null,
    win_rate_pct:resolved?Number((100*tp/resolved).toFixed(2)):null};
  }).sort((a,b)=>{
   if(a.win_rate_pct===null)return b.win_rate_pct===null?a.coin.localeCompare(b.coin):1;
   if(b.win_rate_pct===null)return -1;
   return b.win_rate_pct-a.win_rate_pct||b.resolved-a.resolved||a.coin.localeCompare(b.coin);
  });
  return {success:true,module:'SWING_DIRECTION_COIN_LEADERBOARD_V2',variant,mode,read_only:true,trading:false,
   period,interval,source,methodology:'INDEPENDENT_ONE_ACTIVE_PER_COIN_PER_DIRECTION',coins};
 }
 // One D1-backed report cohort: completed replay entries + latest D1 research
 // signals checked against 1H OHLC. The same cohort powers rows and counters.
 // De-duplicate identical coin/TF/bar signals; never count each pattern as an entry.
 const inScope=(s:Signal)=>s.signal_available_at>=start&&(!coin||s.coin===coin)&&(!interval||s.interval===interval);
 const key=(s:Signal)=>[s.coin,s.interval,s.signal_bar_open].join('|');
 const combined=new Map<string,Signal>();
 for(const s of accepted.filter(inScope))combined.set(key(s),s);
 for(const s of [...recentlyResolved,...trackingOnly]){
  if((mode!=='ALL'&&s.side!==mode)||!inScope(s))continue;
  const k=key(s),prior=combined.get(k);
  // Prefer verified TP/SL to a pending D1 TRACKING placeholder.
  if(!prior||prior.result==='TRACKING'&&s.result!=='TRACKING')combined.set(k,s);
 }
 const visibleAll=[...combined.values()];
 const skippedVisible=skipped.filter(inScope);
 const visible=status==='SKIPPED_ALREADY_OPEN'?skippedVisible:visibleAll.filter(s=>!status||s.result===status);
 // LIVE exchange overlay for Variant B display ONLY. Research cohorts, filters,
 // replay results and statistics remain unchanged. Match exact crossing_id.
 // A missing/unavailable LIVE DB must never be mistaken for a closed position.
 const pageRows=visible.slice().sort((a,b)=>b.signal_available_at-a.signal_available_at).slice((page-1)*limit,page*limit);
 let liveByCrossing=new Map<string,{status:string;close_reason:string|null}>();
 if(variant==='B' && env.DB?.prepare && pageRows.length){
  const ids=pageRows.map(s=>`SWING:SHORT:${s.coin}:${s.interval}:${s.signal_bar_open}`);
  try{
   const result=await env.DB.prepare(`SELECT crossing_id,status,close_reason
     FROM hyperliquid_execution_ledger WHERE crossing_id IN (${ids.map(()=>'?').join(',')})`)
    .bind(...ids).all();
   liveByCrossing=new Map((result.results||[]).map((r:any)=>[String(r.crossing_id),
    {status:String(r.status),close_reason:r.close_reason==null?null:String(r.close_reason)}]));
  }catch(e){console.warn('SWING_LIVE_OVERLAY_UNAVAILABLE',String(e));}
 }
 const selected=variant==='B'?pageRows.map(s=>{
  const live=liveByCrossing.get(`SWING:SHORT:${s.coin}:${s.interval}:${s.signal_bar_open}`);
  return {...s,live_status:live?.status??null,live_close_reason:live?.close_reason??null};
 }):pageRows;
 const tp=visibleAll.filter(s=>s.result==='TP_FIRST').length,sl=visibleAll.filter(s=>s.result==='SL_FIRST').length;
 const timed=visibleAll.filter(s=>s.result==='TIME_EXIT'&&s.net!==null);
 const timeWin=timed.filter(s=>Number(s.net)>0).length,timeLoss=timed.filter(s=>Number(s.net)<0).length,timeFlat=timed.length-timeWin-timeLoss;
 const netSum=visibleAll.reduce((n,s)=>n+(s.net===null?0:Number(s.net)),0);
 const netDone=tp+sl+timed.length;
 const tracking=visibleAll.filter(s=>s.result==='TRACKING').length;
 const uncertain=visibleAll.filter(s=>!['TP_FIRST','SL_FIRST','TRACKING','TIME_EXIT'].includes(s.result)).length;
 return {success:true,module:'SWING_DIRECTION_D1_UNIFIED_V4',variant,mode,read_only:true,trading:false,
  methodology:{position_limit:'HISTORICAL_REPLAY_AND_LATEST_RESEARCH_MERGED',entry:'SIGNAL_AVAILABLE_AT',exit:'FIRST_TOUCH_1H',scope:'HYPOTHETICAL_NOT_EXCHANGE_FILLS'},
  period,source,tracking_diagnostics:{active:tracking,first_touch_resolved_not_yet_settled:recentlyResolved.length,source:'D1_CONTEXT_SIGNALS_AND_VERIFIED_OHLC'},
  filters:{coin,interval,status,mode,btc_1h:'MIXED',btc_4h:variant==='B'?'MIXED':'ANY',tp:2,sl:1},
  stats:{total:visibleAll.length,completed:tp+sl+timed.length,tracking,tp,sl,time_exit:timed.length,time_exit_win:timeWin,time_exit_loss:timeLoss,time_exit_flat:timeFlat,net_pct_sum:Number(netSum.toFixed(5)),net_win_rate_pct:netDone?Number((100*(tp+timeWin)/netDone).toFixed(2)):null,uncertain,skipped:skippedVisible.length,win_rate_pct:tp+sl?Number((100*tp/(tp+sl)).toFixed(2)):null},
  all_history:{eligible_signals:signals.length,accepted:accepted.length,skipped:skipped.length},
  page,pages:Math.max(1,Math.ceil(selected.length/limit)),filteredTotal:selected.length,limit,
  rows:selected.sort((a,b)=>b.signal_available_at-a.signal_available_at).slice((page-1)*limit,page*limit)};
}


// SWING A/B dashboard counters: research eligibility and LIVE queue are distinct.
// READ ONLY. No changes to signal generation, execution, or settlement.
async function swingEntryCounters(env:any,u:URL){
 if(!env.SWING_DB?.prepare)throw Error('MISSING_SWING_DB_BINDING');
 const variant=u.searchParams.get('variant')==='B'?'B':'A';
 const mode=variant==='B'?'SHORT':(u.searchParams.get('mode')||'SHORT');
 if(!['SHORT','LONG','ALL'].includes(mode))throw Error('INVALID_MODE');
 const period='today' as const; // Eligible cards always show TODAY, regardless of replay period selector.
 const interval=u.searchParams.get('interval')||'';
 const coin=(u.searchParams.get('coin')||'').toUpperCase();
 if(interval&&!['1h','4h'].includes(interval))throw Error('INVALID_INTERVAL');
 if(coin&&!/^[A-Z0-9_-]{1,10}$/.test(coin))throw Error('INVALID_COIN');
 // IMPORTANT: the source population MUST be identical to /api/swing/v19/history.
 // History uses signal_bar_open and swingTodayStartMs(), NOT signal_available_at.
 const start=swingTodayStartMs();
 const end=Date.now(); // Exclude future-dated candles; same Sofia day as history.
 const baseWhere=['signal_bar_open>=?','signal_bar_open<=?'];const baseArgs:any[]=[start,end];
 if(interval){baseWhere.push('interval=?');baseArgs.push(interval);}
 if(coin){baseWhere.push('coin=?');baseArgs.push(coin);}
 if(mode!=='ALL'){baseWhere.push('side=?');baseArgs.push(mode);}
 const d=env.SWING_DB;
 const population:any=await d.prepare(`SELECT COUNT(*) AS total,
  COALESCE(SUM(CASE WHEN status='TRACKING' THEN 1 ELSE 0 END),0) AS tracking
  FROM swing_context_signals WHERE ${baseWhere.join(' AND ')}`).bind(...baseArgs).first();
 const rules=[...baseWhere,"interval IN ('1h','4h')"];
 rules.push(`((side='SHORT' AND pattern IN (${PATTERNS.map(()=>'?').join(',')})
  AND json_extract(context_json,'$.btcDirection.timeframes."1h".direction')='MIXED'
  ${variant==='B'?`AND json_extract(context_json,'$.btcDirection.timeframes."4h".direction')='MIXED'`:''})
  OR (side='LONG' AND pattern='TRIANGLE_UP'
  AND json_extract(context_json,'$.btcDirection.timeframes."1h".direction')='MIXED'))`);
 const args=[...baseArgs,...PATTERNS];
 // Match the replay's group key: coin + interval + signal_bar_open, separately per side.
 // A signal with multiple confirmed patterns is ONE entry candidate, not N entries.
 const sql=`WITH eligible AS (
  SELECT coin,side,interval,signal_bar_open,
    MAX(CASE WHEN status='TRACKING' THEN 1 ELSE 0 END) AS is_tracking,
    COUNT(DISTINCT pattern) AS confirmations
  FROM swing_context_signals WHERE ${rules.join(' AND ')}
  GROUP BY coin,side,interval,signal_bar_open
 ) SELECT COUNT(*) AS eligible,
  COALESCE(SUM(is_tracking),0) AS tracking,
  COALESCE(SUM(CASE WHEN interval='1h' THEN 1 ELSE 0 END),0) AS h1,
  COALESCE(SUM(CASE WHEN interval='4h' THEN 1 ELSE 0 END),0) AS h4,
  COALESCE(SUM(CASE WHEN side='SHORT' THEN 1 ELSE 0 END),0) AS shorts,
  COALESCE(SUM(CASE WHEN side='LONG' THEN 1 ELSE 0 END),0) AS longs
  FROM eligible`;
 const row:any=await d.prepare(sql).bind(...args).first();
 let live:any=null,liveError:string|null=null;
 // LIVE queue is a separate execution metric and never affects research eligibility.
 if(env.DB?.prepare){
  try{
   const filters=['signal_available_at>=?','signal_available_at<=?'];const params:any[]=[start,end];
   if(coin){filters.push('coin=?');params.push(coin);}
   if(mode!=='ALL'){filters.push('side=?');params.push(mode);}
   if(interval){filters.push('signal_key LIKE ?');params.push('%:'+interval+':%');}
   const lr:any=await env.DB.prepare(`SELECT COALESCE(SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END),0) AS opened,COALESCE(SUM(CASE WHEN status='EXPIRED' THEN 1 ELSE 0 END),0) AS expired FROM swing_live_queue WHERE ${filters.join(' AND ')}`).bind(...params).first();
   live={opened:Number(lr?.opened||0),expired:Number(lr?.expired||0),short_strategy:'B_DOUBLE_MIXED',meaning:'QUEUE_ROWS_NOT_EXCHANGE_POSITIONS'};
  }catch(e:any){liveError=String(e?.message||e);}
 }else liveError='MISSING_LIVE_DB_BINDING';
 return {success:true,read_only:true,variant,mode,period,coin,interval,
  source:{table:'swing_context_signals',time_field:'signal_bar_open',start_ms:start,end_ms:end,
   total:Number(population?.total||0),tracking:Number(population?.tracking||0)},
  eligible_signals:Number(row?.eligible||0),tracking:Number(row?.tracking||0),
  breakdown:{'1h':Number(row?.h1||0),'4h':Number(row?.h4||0),short:Number(row?.shorts||0),long:Number(row?.longs||0)},
  filter_rules:{patterns:mode==='LONG'?['TRIANGLE_UP']:PATTERNS,btc_1h:'MIXED',btc_4h:variant==='B'?'MIXED':'ANY',group_by:'coin,side,interval,signal_bar_open'},
  note:'RESEARCH_FILTER_MATCHES_NOT_CONFIRMED_EXECUTION_ENTRIES',live,live_error:liveError};
}


// Research-only V2; namespaced to avoid collisions with original V1.
namespace PatternCompareV2 {
 type Candle = import('./types').Candle;
 type Structure = import('./types').Structure;


/** Pattern Catalog V2: strict closed-bar, geometry-aware, research-only detectors.
 * Drop-in replacement for pattern-catalog.ts. Does not execute trades or write D1.
 * Each pattern is a deterministic definition, not a guarantee of future price movement.
 */
type PatternHit = {
  id: string; name: string; side: 'LONG' | 'SHORT'; frame: '1h' | '4h';
  strength: number; confirmed: boolean; details: string; signalBarOpen: number;
};
type Side = 'LONG' | 'SHORT';
type Frame = '1h' | '4h';
type Pivot = {i:number; px:number};
const mean=(a:number[])=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const hi=(a:Candle[])=>Math.max(...a.map(x=>x.h));
const lo=(a:Candle[])=>Math.min(...a.map(x=>x.l));
const clamp=(n:number)=>Math.max(1,Math.min(100,Math.round(n)));
const body=(x:Candle)=>Math.abs(x.c-x.o);
const span=(x:Candle)=>Math.max(x.h-x.l,1e-12);
const bull=(x:Candle)=>x.c>x.o;
const bear=(x:Candle)=>x.c<x.o;
const upper=(x:Candle)=>x.h-Math.max(x.o,x.c);
const lower=(x:Candle)=>Math.min(x.o,x.c)-x.l;
const avgVolume=(c:Candle[])=>mean(c.map(x=>x.v));
function ema(v:number[],period:number):number[]{
 const a=Array(v.length).fill(NaN);if(v.length<period)return a;
 let e=mean(v.slice(0,period));a[period-1]=e;
 const k=2/(period+1);for(let i=period;i<v.length;i++){e=v[i]*k+e*(1-k);a[i]=e;}return a;
}
function pivot(c:Candle[],i:number,kind:'H'|'L',r=2):boolean{
 if(i<r||i+r>=c.length)return false;
 const px=kind==='H'?c[i].h:c[i].l;
 for(let j=i-r;j<=i+r;j++)if(j!==i&&(kind==='H'?c[j].h>=px:c[j].l<=px))return false;
 return true;
}
function pivots(c:Candle[],from:number,to:number,kind:'H'|'L',r=2):Pivot[]{
 const a:Pivot[]=[];for(let i=Math.max(r,from);i<=Math.min(c.length-r-1,to);i++)
  if(pivot(c,i,kind,r))a.push({i,px:kind==='H'?c[i].h:c[i].l});return a;
}
function line(a:Pivot,b:Pivot,i:number){return a.px+(b.px-a.px)*(i-a.i)/(b.i-a.i);}
function slopeTrend(c:Candle[],side:Side,atr:number):boolean{
 // Require actual multi-bar price progression, not just two opposite-colored bars.
 const z=c.length-1, old=c.slice(z-12,z-6),recent=c.slice(z-6,z);
 return side==='LONG'?mean(old.map(x=>x.c))-mean(recent.map(x=>x.c))>=0.35*atr
  :mean(recent.map(x=>x.c))-mean(old.map(x=>x.c))>=0.35*atr;
}
function confirmedDouble(c:Candle[],atr:number,side:Side){
 const z=c.length-1,kind=side==='LONG'?'L':'H';
 const ps=pivots(c,z-45,z-3,kind);
 for(let j=ps.length-1;j>0;j--){const b=ps[j];if(z-b.i<3||z-b.i>14)continue;
  for(let k=j-1;k>=0;k--){const a=ps[k],gap=b.i-a.i;if(gap<5||gap>24)continue;
   if(Math.abs(a.px-b.px)>atr*0.45)continue;
   const between=c.slice(a.i+1,b.i),neck=side==='LONG'?hi(between):lo(between);
   const depth=side==='LONG'?neck-Math.max(a.px,b.px):Math.min(a.px,b.px)-neck;
   if(depth<1.5*atr||depth>10*atr)continue;
   // The two extrema must have been formed after a meaningful preceding move.
   const before=c.slice(Math.max(0,a.i-12),a.i);
   if(before.length<6)continue;
   const preceding=side==='LONG'?hi(before)-a.px:a.px-lo(before);
   if(preceding<1.2*atr)continue;
   const cur=c[z],prev=c[z-1],pad=0.08*atr;
   if(c.slice(b.i+1,z).some(x=>side==='LONG'?x.c>neck+pad:x.c<neck-pad))continue;
   const crossed=side==='LONG'?bull(cur)&&cur.c>neck+pad&&prev.c<=neck+pad
    :bear(cur)&&cur.c<neck-pad&&prev.c>=neck-pad;
   if(!crossed||body(cur)/span(cur)<0.4)continue;
   // Reject an oversized breakout candle where entry is already far beyond the neckline.
   if(Math.abs(cur.c-neck)>2.5*atr)continue;
   return {a:a.i,b:b.i,neck,depth};
  }
 }return null;
}
function triangle(c:Candle[],atr:number,side:Side){
 const z=c.length-1,hs=pivots(c,z-28,z-3,'H'),ls=pivots(c,z-28,z-3,'L');
 if(hs.length<2||ls.length<2)return null;
 // Try recent pairs, but require both trendlines to be supported by intervening candles.
 for(let h=hs.length-1;h>=1;h--)for(let l=ls.length-1;l>=1;l--){
  const h1=hs[h-1],h2=hs[h],l1=ls[l-1],l2=ls[l];
  const start=Math.max(h1.i,l1.i),end=Math.min(h2.i,l2.i);
  if(end-start<5||Math.abs(h2.i-l2.i)>10)continue;
  const upperSlope=(h2.px-h1.px)/(h2.i-h1.i),lowerSlope=(l2.px-l1.px)/(l2.i-l1.i);
  if(!(upperSlope<-0.015*atr&&lowerSlope>0.015*atr))continue;
  const widthStart=line(h1,h2,start)-line(l1,l2,start);
  const widthNow=line(h1,h2,z)-line(l1,l2,z);
  if(widthStart<1.3*atr||widthNow<=0.2*atr||widthNow>=0.85*widthStart)continue;
  const apex=(l1.px-h1.px+upperSlope*h1.i-lowerSlope*l1.i)/(upperSlope-lowerSlope);
  if(!Number.isFinite(apex)||apex<z-2||apex>z+35)continue;
  const first=Math.min(h1.i,l1.i),last=Math.max(h2.i,l2.i);
  let breaches=0;for(let i=first+2;i<last;i++){
   const top=line(h1,h2,i),bottom=line(l1,l2,i);
   if(c[i].c>top+0.2*atr||c[i].c<bottom-0.2*atr)breaches++;
  }if(breaches>1)continue;
  const current=c[z],previous=c[z-1];
  const boundary=line(side==='LONG'?h1:l1,side==='LONG'?h2:l2,z);
  const prevBoundary=line(side==='LONG'?h1:l1,side==='LONG'?h2:l2,z-1);
  const crossed=side==='LONG'?bull(current)&&current.c>boundary+0.1*atr&&previous.c<=prevBoundary+0.1*atr
   :bear(current)&&current.c<boundary-0.1*atr&&previous.c>=prevBoundary-0.1*atr;
  if(!crossed||body(current)/span(current)<0.5||Math.abs(current.c-boundary)>2.5*atr)continue;
  return {h1:h1.i,h2:h2.i,l1:l1.i,l2:l2.i,boundary,apex};
 }return null;
}
export function detectCatalog(c:Candle[],s:Structure,frame:Frame):PatternHit[]{
 if(c.length<65||!s||!Number.isFinite(s.atr14)||s.atr14<=0)return [];
 if(!c.every(x=>[x.t,x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)&&x.o>0&&x.c>0&&x.h>=Math.max(x.o,x.c,x.l)&&x.l<=Math.min(x.o,x.c)&&x.v>=0))return [];
 for(let i=1;i<c.length;i++)if(c[i].t<=c[i-1].t)return [];
 const z=c.length-1,b=c[z],p=c[z-1],q=c[z-2],atr=s.atr14;
 const prior=c.slice(z-20,z),previous=c.slice(z-21,z-1);
 const high=hi(prior),low=lo(prior),vr=avgVolume(prior)>0?b.v/avgVolume(prior):0;
 const goodBull=bull(b)&&body(b)/span(b)>=0.45,goodBear=bear(b)&&body(b)/span(b)>=0.45;
 const closeLocationBull=(b.c-b.l)/span(b),closeLocationBear=(b.h-b.c)/span(b);
 const out:PatternHit[]=[];
 const add=(ok:boolean,id:string,name:string,side:Side,strength:number,details:string)=>{
  if(ok)out.push({id,name,side,frame,strength:clamp(strength),confirmed:true,details,signalBarOpen:b.t});
 };
 // 1-2: Real break of a frozen 20-bar extreme, meaningful range, participation and follow-through close.
 add(goodBull&&b.c>high+0.1*atr&&p.c<=high&&vr>=1.35&&closeLocationBull>=0.75&&
     b.c-high<=2.5*atr,'RANGE_BREAKOUT','20-bar range breakout','LONG',60+8*vr,
     `Break above ${high}; buffer 0.10 ATR; volume ${vr.toFixed(2)}x`);
 add(goodBear&&b.c<low-0.1*atr&&p.c>=low&&vr>=1.35&&closeLocationBear>=0.75&&
     low-b.c<=2.5*atr,'RANGE_BREAKDOWN','20-bar range breakdown','SHORT',60+8*vr,
     `Break below ${low}; buffer 0.10 ATR; volume ${vr.toFixed(2)}x`);
 // 3-4: Genuine level sweep and rejection; close well back inside the old range.
 add(b.l<low-0.12*atr&&b.c>low+0.12*atr&&bull(b)&&lower(b)/span(b)>=0.5&&
     closeLocationBull>=0.7&&body(b)>=0.12*atr,'LIQUIDITY_SWEEP_LOW','Support liquidity sweep','LONG',67+20*lower(b)/span(b),
     `Pierced ${low}, rejected and closed back inside range`);
 add(b.h>high+0.12*atr&&b.c<high-0.12*atr&&bear(b)&&upper(b)/span(b)>=0.5&&
     closeLocationBear>=0.7&&body(b)>=0.12*atr,'LIQUIDITY_SWEEP_HIGH','Resistance liquidity sweep','SHORT',67+20*upper(b)/span(b),
     `Pierced ${high}, rejected and closed back inside range`);
 // 5-6: Strict engulfing + prior directional move + substantial candle + close location.
 add(goodBull&&bear(p)&&b.o<=p.c&&b.c>=p.o&&body(b)>=1.1*body(p)&&
     body(p)>=0.12*atr&&body(b)>=0.4*atr&&closeLocationBull>=0.75&&
     slopeTrend(c,'LONG',atr),'BULL_ENGULF','Bullish engulfing after decline','LONG',68,
     'Body engulfs prior bearish body after multi-bar decline');
 add(goodBear&&bull(p)&&b.o>=p.c&&b.c<=p.o&&body(b)>=1.1*body(p)&&
     body(p)>=0.12*atr&&body(b)>=0.4*atr&&closeLocationBear>=0.75&&
     slopeTrend(c,'SHORT',atr),'BEAR_ENGULF','Bearish engulfing after advance','SHORT',68,
     'Body engulfs prior bullish body after multi-bar advance');
 // 7-8: Wick rejection at a local extreme following a genuine move, not arbitrary small bars.
 const oldLow=lo(c.slice(z-10,z)),oldHigh=hi(c.slice(z-10,z));
 add(lower(b)/span(b)>=0.6&&upper(b)/span(b)<=0.12&&body(b)/span(b)<=0.3&&
     span(b)>=0.7*atr&&b.l<=oldLow+0.15*atr&&closeLocationBull>=0.72&&
     slopeTrend(c,'LONG',atr),'HAMMER','Hammer after decline','LONG',60,
     'Lower rejection at local low after measured decline');
 add(upper(b)/span(b)>=0.6&&lower(b)/span(b)<=0.12&&body(b)/span(b)<=0.3&&
     span(b)>=0.7*atr&&b.h>=oldHigh-0.15*atr&&closeLocationBear>=0.72&&
     slopeTrend(c,'SHORT',atr),'SHOOTING_STAR','Shooting star after advance','SHORT',60,
     'Upper rejection at local high after measured advance');
 // 9-10: Two prior directional bars, a meaningful reversal close and actual earlier trend.
 add(goodBull&&bear(p)&&bear(q)&&b.c>Math.max(p.h,q.h)+0.05*atr&&
     body(b)>=0.6*atr&&vr>=1.15&&slopeTrend(c,'LONG',atr),
     'MOMENTUM_REVERSAL_LONG','Momentum reversal after decline','LONG',67,
     'Bullish close above two prior highs after established decline');
 add(goodBear&&bull(p)&&bull(q)&&b.c<Math.min(p.l,q.l)-0.05*atr&&
     body(b)>=0.6*atr&&vr>=1.15&&slopeTrend(c,'SHORT',atr),
     'MOMENTUM_REVERSAL_SHORT','Momentum reversal after advance','SHORT',67,
     'Bearish close below two prior lows after established advance');
 // 11-12: Pullback into historical EMA20, confirmed trend slope and continuation.
 const e=ema(c.map(x=>x.c),20),ePrev=e[z-1],eOld=e[z-5];
 const emaReady=Number.isFinite(ePrev)&&Number.isFinite(eOld);
 add(emaReady&&s.direction==='LONG'&&ePrev>eOld+0.15*atr&&
     p.l<=ePrev+0.25*atr&&p.l>=ePrev-0.65*atr&&p.c>=ePrev-0.15*atr&&
     goodBull&&b.c>p.h+0.05*atr&&b.c>ePrev&&vr>=1.05,
     'EMA_PULLBACK_LONG','EMA20 trend pullback','LONG',67,
     `Prior EMA20 ${ePrev}; upward EMA slope and confirmed continuation`);
 add(emaReady&&s.direction==='SHORT'&&ePrev<eOld-0.15*atr&&
     p.h>=ePrev-0.25*atr&&p.h<=ePrev+0.65*atr&&p.c<=ePrev+0.15*atr&&
     goodBear&&b.c<p.l-0.05*atr&&b.c<ePrev&&vr>=1.05,
     'EMA_PULLBACK_SHORT','EMA20 trend pullback','SHORT',67,
     `Prior EMA20 ${ePrev}; downward EMA slope and confirmed continuation`);
 // 13-14: Breakout on z-2, controlled retest on z-1, follow-through on z.
 const breakout=c[z-2],frozenHigh=hi(c.slice(z-22,z-2)),frozenLow=lo(c.slice(z-22,z-2));
 add(bull(breakout)&&breakout.c>frozenHigh+0.1*atr&&body(breakout)>=0.45*atr&&
     p.l<=frozenHigh+0.15*atr&&p.l>=frozenHigh-0.35*atr&&p.c>=frozenHigh&&
     goodBull&&b.c>p.h+0.05*atr&&vr>=1.1,
     'BREAKOUT_RETEST_LONG','Breakout retest continuation','LONG',75,
     `Break ${frozenHigh}; hold retest; bullish follow-through`);
 add(bear(breakout)&&breakout.c<frozenLow-0.1*atr&&body(breakout)>=0.45*atr&&
     p.h>=frozenLow-0.15*atr&&p.h<=frozenLow+0.35*atr&&p.c<=frozenLow&&
     goodBear&&b.c<p.l-0.05*atr&&vr>=1.1,
     'BREAKOUT_RETEST_SHORT','Breakdown retest continuation','SHORT',75,
     `Break ${frozenLow}; hold retest; bearish follow-through`);
 // 15-16: Two distinct pivot extrema, intervening neckline and decisive neckline cross.
 const db=confirmedDouble(c,atr,'LONG'),dt=confirmedDouble(c,atr,'SHORT');
 add(!!db&&vr>=1.15,'DOUBLE_BOTTOM','Confirmed W-bottom neckline break','LONG',76,
     db?`Lows ${db.a}/${db.b}; neckline ${db.neck}; depth ${db.depth.toFixed(6)}`:'');
 add(!!dt&&vr>=1.15,'DOUBLE_TOP','Confirmed M-top neckline break','SHORT',76,
     dt?`Highs ${dt.a}/${dt.b}; neckline ${dt.neck}; depth ${dt.depth.toFixed(6)}`:'');
 // 17-18: Geometric symmetric triangle, projected boundary breakout and valid apex.
 const up=triangle(c,atr,'LONG'),down=triangle(c,atr,'SHORT');
 add(!!up&&vr>=1.3,'TRIANGLE_UP','Symmetric triangle upside breakout','LONG',76,
     up?`Upper trendline ${up.h1}/${up.h2}; lower ${up.l1}/${up.l2}; boundary ${up.boundary}`:'');
 add(!!down&&vr>=1.3,'TRIANGLE_DOWN','Symmetric triangle downside breakout','SHORT',76,
     down?`Upper trendline ${down.h1}/${down.h2}; lower ${down.l1}/${down.l2}; boundary ${down.boundary}`:'');
 // 19-20: A distinct high-participation, high-body breakout variant.
 add(s.direction==='LONG'&&goodBull&&b.c>high+0.12*atr&&p.c<=high&&
     vr>=2&&body(b)/span(b)>=0.65&&closeLocationBull>=0.85&&b.c-high<=2.5*atr,
     'VOLUME_EXPANSION_LONG','High-volume upside expansion','LONG',68+7*vr,
     `High-volume ${vr.toFixed(2)}x breakout above ${high}`);
 add(s.direction==='SHORT'&&goodBear&&b.c<low-0.12*atr&&p.c>=low&&
     vr>=2&&body(b)/span(b)>=0.65&&closeLocationBear>=0.85&&low-b.c<=2.5*atr,
     'VOLUME_EXPANSION_SHORT','High-volume downside expansion','SHORT',68+7*vr,
     `High-volume ${vr.toFixed(2)}x breakdown below ${low}`);
 return out;
}
const CATALOG_IDS=[
 'RANGE_BREAKOUT','RANGE_BREAKDOWN','LIQUIDITY_SWEEP_LOW','LIQUIDITY_SWEEP_HIGH',
 'BULL_ENGULF','BEAR_ENGULF','HAMMER','SHOOTING_STAR',
 'MOMENTUM_REVERSAL_LONG','MOMENTUM_REVERSAL_SHORT',
 'EMA_PULLBACK_LONG','EMA_PULLBACK_SHORT','BREAKOUT_RETEST_LONG','BREAKOUT_RETEST_SHORT',
 'DOUBLE_BOTTOM','DOUBLE_TOP','TRIANGLE_UP','TRIANGLE_DOWN',
 'VOLUME_EXPANSION_LONG','VOLUME_EXPANSION_SHORT'
] as const;

}


// Isolated V1 vs V2 research comparison: one OHLCV fetch, no database access.
async function swingPatternCompareData(u:URL){
 const coin=(u.searchParams.get('coin')||'BTC').toUpperCase();
 const frame=(u.searchParams.get('interval')||'1h') as '1h'|'4h';
 if(!(COINS as readonly string[]).includes(coin))throw Error('INVALID_COIN');
 if(frame!=='1h'&&frame!=='4h')throw Error('INVALID_INTERVAL');
 const {structure}=await import('./market-structure');
 const data=await fetchClosed(coin,frame,400);
 const q=quality(data);
 if(!q.ready)throw Error('OHLCV_NOT_READY');
 const bars=data.closed;
 const byId:Record<string,{v1:number;v2:number;both:number;v1Only:number;v2Only:number;events:{index:number;time:number;v1:boolean;v2:boolean;v1Details:string|null;v2Details:string|null}[]}>=Object.fromEntries(CATALOG_IDS.map(id=>[id,{v1:0,v2:0,both:0,v1Only:0,v2Only:0,events:[]}]));
 for(let i=64;i<bars.length;i++){
  const prefix=bars.slice(0,i+1),s=structure(prefix);
  const a=detectCatalog(prefix,s,frame),b=PatternCompareV2.detectCatalog(prefix,s,frame);
  const aa=new Map(a.map(x=>[x.id,x])),bb=new Map(b.map(x=>[x.id,x]));
  for(const id of CATALOG_IDS){
   const x=aa.get(id),y=bb.get(id),r=byId[id];
   if(x)r.v1++;if(y)r.v2++;if(x&&y)r.both++;
   if(x&&!y)r.v1Only++;if(y&&!x)r.v2Only++;
   if(x||y)r.events.push({index:i,time:bars[i].t,v1:!!x,v2:!!y,v1Details:x?.details||null,v2Details:y?.details||null});
  }
 }
 return {success:true,mode:'READ_ONLY',trading:false,d1_queries:0,coin,interval:frame,quality:q,patterns:byId,candles:bars.map(x=>({t:x.t,o:x.o,h:x.h,l:x.l,c:x.c,v:x.v})),note:'Detection agreement is not predictive accuracy.'};
}
function swingPatternComparePage():string{
 return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swing Hunter — V1 vs V2</title><style>
*{box-sizing:border-box}body{background:#0b1020;color:#e2e8f0;font:14px system-ui;margin:0;padding:16px}
h1{font-size:22px;margin:0 0 6px}p{color:#94a3b8}select,button{background:#17233b;color:#fff;border:1px solid #334155;border-radius:8px;padding:10px;font-size:14px}
.controls{display:flex;flex-wrap:wrap;gap:8px;margin:15px 0}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.panel{background:#111b30;border:1px solid #334155;border-radius:12px;padding:12px;min-width:0}.panel h2{font-size:17px}
svg{width:100%;height:auto;background:#0a1428;border-radius:6px}.summary{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0}
.tag{padding:8px 12px;background:#17233b;border-radius:8px}#status{min-height:20px;color:#a5b4fc}
@media(max-width:850px){.grid{grid-template-columns:1fr}}
</style></head><body><h1>SWING HUNTER · Pattern V1 vs V2</h1>
<p>Еднакви реални затворени OHLCV свещи · 20 патерна · само диагностика, без D1 или търговия.</p>
<div class="controls"><select id="coin"></select><select id="frame"><option value="1h">1H</option><option value="4h">4H</option></select><select id="pattern"></select><select id="case"></select><button id="load">Зареди</button></div>
<div id="status"></div><div class="summary" id="summary"></div>
<div class="grid"><section class="panel"><h2>V1 · оригинален</h2><div id="chart1"></div><div id="detail1"></div></section>
<section class="panel"><h2>V2 · подобрен</h2><div id="chart2"></div><div id="detail2"></div></section></div>
<p>Важно: графиките показват разпознаване на формации, а не доказана прогностична точност.</p>
<script>
const coins=${JSON.stringify(COINS)};
const ids=${JSON.stringify(CATALOG_IDS)};
const $=id=>document.getElementById(id);
$('coin').innerHTML=coins.map(x=>'<option>'+x+'</option>').join('');
$('pattern').innerHTML=ids.map(x=>'<option>'+x+'</option>').join('');
let result=null;
function esc(s){return String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function chart(target,ev,side){
 const arr=result.candles,start=Math.max(0,ev.index-48),end=Math.min(arr.length,ev.index+9),c=arr.slice(start,end);
 const min=Math.min(...c.map(x=>x.l)),max=Math.max(...c.map(x=>x.h)),range=Math.max(max-min,1e-9);
 const w=850,h=370,left=55,right=15,top=18,bottom=34,plotW=w-left-right,plotH=h-top-bottom;
 const px=i=>left+(i+.5)*plotW/c.length,py=p=>top+(max-p)/range*plotH;
 const step=plotW/c.length;
 let svg='<svg viewBox="0 0 '+w+' '+h+'" role="img" aria-label="OHLCV candlestick chart">';
 for(let k=0;k<=4;k++){const price=min+range*k/4,y=py(price);svg+='<line x1="'+left+'" y1="'+y+'" x2="'+(w-right)+'" y2="'+y+'" stroke="#24314b"/><text x="3" y="'+(y+4)+'" fill="#94a3b8" font-size="11">'+price.toFixed(price>100?1:4)+'</text>';}
 c.forEach((x,i)=>{const xPos=px(i),up=x.c>=x.o,color=up?'#22c55e':'#ef4444',a=py(Math.max(x.o,x.c)),b=py(Math.min(x.o,x.c));
 svg+='<line x1="'+xPos+'" y1="'+py(x.h)+'" x2="'+xPos+'" y2="'+py(x.l)+'" stroke="'+color+'" stroke-width="1.5"/>';
 svg+='<rect x="'+(xPos-step*.29)+'" y="'+a+'" width="'+Math.max(2,step*.58)+'" height="'+Math.max(1.5,b-a)+'" fill="'+color+'"/>';
 if(start+i===ev.index)svg+='<line x1="'+xPos+'" y1="'+top+'" x2="'+xPos+'" y2="'+(h-bottom)+'" stroke="#facc15" stroke-dasharray="4 4" stroke-width="2"/>';
 });
 svg+='<text x="'+left+'" y="'+(h-8)+'" fill="#94a3b8" font-size="12">'+new Date(c[0].t).toISOString().slice(0,16)+' UTC</text>';
 svg+='<text x="'+(w-175)+'" y="'+(h-8)+'" fill="#94a3b8" font-size="12">'+new Date(c[c.length-1].t).toISOString().slice(0,16)+' UTC</text></svg>';
 $(target).innerHTML=svg;
 const detected=side==='v1'?ev.v1:ev.v2;
 const desc=side==='v1'?ev.v1Details:ev.v2Details;
 $('detail'+(side==='v1'?1:2)).innerHTML='<p style="color:'+(detected?'#4ade80':'#fca5a5')+'">'+(detected?'РАЗПОЗНАТ':'НЕ Е РАЗПОЗНАТ')+'</p><p>'+esc(desc||'Няма сигнал по правилата на този детектор')+'</p>';
}
function render(){
 if(!result)return;
 const id=$('pattern').value,p=result.patterns[id];
 $('summary').innerHTML=['V1: '+p.v1,'V2: '+p.v2,'И двата: '+p.both,'Само V1: '+p.v1Only,'Само V2: '+p.v2Only].map(x=>'<div class="tag">'+esc(x)+'</div>').join('');
 const ev=p.events,prev=$('case').value;
 $('case').innerHTML=ev.map((x,i)=>'<option value="'+i+'">'+new Date(x.time).toISOString().slice(0,16)+' · '+(x.v1&&x.v2?'BOTH':x.v1?'V1 ONLY':'V2 ONLY')+'</option>').join('');
 if(!ev.length){$('chart1').textContent='Няма разпознавания за този патерн в избраните 400 свещи.';$('chart2').textContent='Няма разпознавания.';$('detail1').textContent='';$('detail2').textContent='';return;}
 $('case').value=prev&&Number(prev)<ev.length?prev:String(ev.length-1);
 draw();
}
function draw(){const p=result.patterns[$('pattern').value],ev=p.events[Number($('case').value)];if(!ev)return;chart('chart1',ev,'v1');chart('chart2',ev,'v2');}
async function load(){
 $('status').textContent='Извличане на 400 свещи и сравняване на V1/V2…';$('load').disabled=true;
 try{
 const u='/api/swing/pattern-compare-data?coin='+encodeURIComponent($('coin').value)+'&interval='+encodeURIComponent($('frame').value);
 const response=await fetch(u,{cache:'no-store'}),data=await response.json();
 if(!response.ok||!data.success)throw Error(data.error||'HTTP '+response.status);
 result=data;$('case').value='';$('status').textContent='Готово · '+data.coin+' '+data.interval+' · '+data.candles.length+' затворени свещи';render();
 }catch(e){$('status').textContent='Грешка: '+e.message;}finally{$('load').disabled=false;}
}
$('load').onclick=load;$('pattern').onchange=()=>{$('case').value='';render()};$('case').onchange=draw;load();
</script></body></html>`;
}

export async function handleSwingHunterRequest(req:Request,_env:unknown):Promise<Response>{
 const env=_env as any;
 const u=new URL(req.url);
 if(req.method==='GET'&&u.pathname==='/swing-hunter/pattern-compare')return new Response(swingPatternComparePage(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
 if(req.method==='GET'&&u.pathname==='/api/swing/pattern-compare-data'){try{return json(await swingPatternCompareData(u))}catch(e:any){return json({success:false,error:String(e?.message||e)},502)}}

 // LIVE monitor routes are read-only and independent from research.
 const liveMonitorResponse=await handleSwingLiveMonitor(req,env);
 if(liveMonitorResponse)return liveMonitorResponse;
 if(req.method==='GET'&&u.pathname==='/api/swing/v19/materialized'){
  if(!env.SWING_ADMIN_TOKEN)return json({success:false,error:'TOKEN_NOT_CONFIGURED'},503);
  if(req.headers.get('x-swing-token')!==env.SWING_ADMIN_TOKEN)return json({success:false,error:'UNAUTHORIZED'},401);
  try{return json(await swingFilteredRead(env,u));}catch(e:any){return json({success:false,error:String(e?.message||e)},502)}
 }
 if(req.method==='GET'&&u.pathname==='/api/swing/v19/entry-counters'){
  if(!env.SWING_ADMIN_TOKEN)return json({success:false,error:'SWING_ADMIN_TOKEN_NOT_CONFIGURED'},503);
  if(req.headers.get('x-swing-token')!==env.SWING_ADMIN_TOKEN)return json({success:false,error:'UNAUTHORIZED'},401);
  try{return json(await swingEntryCounters(env,u));}catch(e:any){return json({success:false,error:String(e?.message||e)},502);}
 }
 if(req.method==='GET'&&u.pathname==='/swing-hunter/monitor')return new Response(swingMonitorDashboard(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
 if(req.method==='GET'&&u.pathname==='/swing-hunter/ab')return new Response(swingABDashboard(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
 if(['/api/swing/v19/scan','/api/swing/v19/settle','/api/swing/v19/log','/api/swing/v19/resolved-count','/api/swing/v19/history','/api/swing/v19/filtered-short'].includes(u.pathname)){
  if(!env.SWING_ADMIN_TOKEN)return json({success:false,error:'SWING_ADMIN_TOKEN_NOT_CONFIGURED'},503);
  if(req.headers.get('x-swing-token')!==env.SWING_ADMIN_TOKEN)return json({success:false,error:'UNAUTHORIZED'},401);
  try{
   if(u.pathname==='/api/swing/v19/filtered-short'){
    if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
    return json(await cachedSwingReport(env,u));
   }
   if(u.pathname==='/api/swing/v19/history'){
    if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
    return json(await swingHistory(env,u));
   }
   if(u.pathname==='/api/swing/v19/resolved-count'){
    if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
    return json(await resolvedCount(env));
   }
   if(u.pathname==='/api/swing/v19/log'){
    if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
    return json(await recentSignals(env,Number(u.searchParams.get('limit')||20),u.searchParams.get('side')||undefined));
   }
   if(req.method!=='POST')return json({success:false,error:'POST_REQUIRED'},405);
   if(u.pathname==='/api/swing/v19/settle')return json(await settleSignals(env,Number(u.searchParams.get('limit')||12)));
   if(!NEW_SIGNALS_ENABLED)return json({success:true,module:'SWING_HUNTER_V1_9_5',status:'SIGNAL_COLLECTION_PAUSED',new_signals_enabled:false,existing_signals_settlement_enabled:true,trading:false,signals_created:0});
   return json(await scanAndLog(env,{interval:(u.searchParams.get('interval')||'1h') as Interval,offset:Number(u.searchParams.get('offset')||0),limit:Number(u.searchParams.get('limit')||3)}));
  }catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502)}
 }
 if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
 if(u.pathname==='/swing-hunter/intelligence')return new Response(intelligenceDashboard(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
 if(u.pathname==='/swing-hunter')return new Response(dashboard(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
 if(u.pathname==='/api/swing'||u.pathname==='/api/swing/status')return json({success:true,module:'SWING_HUNTER_V1_9_3',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,scheduled:false,coins:COINS.length,routes:['/swing-hunter','/swing-hunter/monitor','/api/swing/status','/api/swing/ohlcv','/api/swing/analyze','/api/swing/structure','/api/swing/patterns','/api/swing/decision','/api/swing/shadow','/api/swing/dashboard','/api/swing/scan','/api/swing/replay','/api/swing/research','/api/swing/compare','/api/swing/health','/api/swing/outcomes','/api/swing/audit','/api/swing/unified','/api/swing/unified-market','/api/swing/catalog','/api/swing/intelligence','/api/swing/intelligence-market','/api/swing/chart-learning','/api/swing/chart-learning-market','/api/swing/entry-research','/api/swing/integrity-audit','/api/swing/tp-first-touch','/api/swing/tp-sl-first-touch','/api/swing/v19/scan','/api/swing/v19/settle','/api/swing/v19/log','/api/swing/v19/resolved-count','/api/swing/v19/history','/swing-hunter/intelligence']});
 if(u.pathname==='/api/swing/dashboard')return json({success:true,module:'SWING_HUNTER_V1_8_5',mode:'READ_ONLY',dashboard:'/swing-hunter'});
 if(u.pathname==='/api/swing/health')return json(healthReport());
 if(u.pathname==='/api/swing/catalog')return json({success:true,module:'SWING_HUNTER_V1_6_PATTERN_CATALOG',patternIds:CATALOG_IDS,patternsCount:CATALOG_IDS.length,notes:['20 directional detectors, not every conceivable market pattern','Signals include triggerPatterns and supportingPatterns','Research-only']});
 if(u.pathname==='/api/swing/chart-learning-market'){try{return json(await chartLearningMarket(Number(u.searchParams.get('offset')||0),Number(u.searchParams.get('limit')||2),(u.searchParams.get('interval')||'4h') as Interval))}catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502)}}
 if(u.pathname==='/api/swing/intelligence-market'){try{return json(await intelligenceMarket(Number(u.searchParams.get('offset')||0),Number(u.searchParams.get('limit')||2)))}catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502)}}
 if(u.pathname==='/api/swing/unified-market'){try{return json(await unifiedMarket(Number(u.searchParams.get('offset')||0),Number(u.searchParams.get('limit')||2)))}catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502)}}
 if(u.pathname==='/api/swing/scan'){try{return json(await scanMarket())}catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502)}}
 const coin=(u.searchParams.get('coin')||'BTC').toUpperCase();
 if(!(COINS as readonly string[]).includes(coin))return json({success:false,error:'INVALID_COIN'},400);
 try{
  if(u.pathname==='/api/swing/tp-sl-first-touch')return json(await tpSlFirstTouchCoin(coin,(u.searchParams.get('interval')||'4h') as Interval,Number(u.searchParams.get('limit')??'10')));
  if(u.pathname==='/api/swing/tp-first-touch')return json(await tpFirstTouchCoin(coin,(u.searchParams.get('interval')||'4h') as Interval,Number(u.searchParams.get('limit')||15)));
  if(u.pathname==='/api/swing/entry-research'||u.pathname==='/api/swing/integrity-audit')return json(await entryResearchCoin(coin,(u.searchParams.get('interval')||'4h') as Interval,Number(u.searchParams.get('limit')||15)));
  if(u.pathname==='/api/swing/chart-learning')return json(await chartLearningCoin(coin,(u.searchParams.get('interval')||'4h') as Interval,Number(u.searchParams.get('limit')||30)));
  if(u.pathname==='/api/swing/intelligence')return json(await intelligenceCoin(coin));
  if(u.pathname==='/api/swing/unified')return json(await unifiedCoin(coin));
  if(u.pathname==='/api/swing/audit')return json(await auditCoin(coin));
  if(u.pathname==='/api/swing/outcomes')return json(await outcomeCoin(coin));
  if(u.pathname==='/api/swing/replay')return json(await replayCoin(coin));
  if(u.pathname==='/api/swing/research')return json(await researchCoin(coin));
  if(u.pathname==='/api/swing/compare')return json(await compareCoin(coin));
  if(u.pathname==='/api/swing/ohlcv'){
   const interval=(u.searchParams.get('interval')||'4h') as Interval;
   const count=Number(u.searchParams.get('count')||100);
   const x=await fetchClosed(coin,interval,count);
   return json({success:true,mode:'READ_ONLY',d1_queries:0,...quality(x)});
  }
  if(!['/api/swing/analyze','/api/swing/structure','/api/swing/patterns','/api/swing/decision','/api/swing/shadow'].includes(u.pathname))return json({success:false,error:'NOT_FOUND'},404);
  const [h1,h4,d1]=await Promise.all([fetchClosed(coin,'1h'),fetchClosed(coin,'4h'),fetchClosed(coin,'1d')]);
  const qualities=[quality(h1),quality(h4),quality(d1)].map(({last3,...q})=>q);
  if(u.pathname==='/api/swing/structure'){
   const {structure}=await import('./market-structure');
   return json({success:true,coin,quality:qualities,structure:{'1h':structure(h1.closed),'4h':structure(h4.closed),'1d':structure(d1.closed)}});
  }
  if(u.pathname==='/api/swing/patterns'){
   const {structure}=await import('./market-structure');
   return json({success:true,coin,quality:qualities,patterns:{'1h':detectCatalog(h1.closed,structure(h1.closed),'1h'),'4h':detectCatalog(h4.closed,structure(h4.closed),'4h')},catalogCount:CATALOG_IDS.length});
  }
  const candidate=decide(coin,h1,h4,d1);
  if(u.pathname==='/api/swing/decision')return json({success:true,coin,quality:qualities,candidate});
  if(u.pathname==='/api/swing/shadow')return json({success:true,coin,shadow:shadowProjection(candidate),note:'Projection only; no trade tracking or D1 writes'});
  return json({success:true,mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,quality:qualities,candidate,shadow:shadowProjection(candidate)});
 }catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502)}
}
export async function swingHunterScheduled(env:any,offset=0,interval:Interval='1h'){
 const scan=NEW_SIGNALS_ENABLED?await scanAndLog(env,{offset,limit:3,interval}):{success:true,status:'SIGNAL_COLLECTION_PAUSED',signals_created:0};
 const settlement=await settleSignals(env,8);
 return {scan,settlement};
}
