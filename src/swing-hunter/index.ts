import {scanAndLog,settleSignals,recentSignals} from './signal-logger';
import {swingMonitorDashboard} from './swing-monitor-dashboard';
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

// Signal collection resumed; existing D1 records are retained.
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
 const visibleAll=accepted.filter(s=>s.signal_available_at>=start&&(!coin||s.coin===coin)&&(!interval||s.interval===interval));
 const activeResearch=trackingOnly.filter(s=>(mode==='ALL'||s.side===mode)&&s.signal_available_at>=start&&(!coin||s.coin===coin)&&(!interval||s.interval===interval));
 const closedResearch=recentlyResolved.filter(s=>(mode==='ALL'||s.side===mode)&&s.signal_available_at>=start&&(!coin||s.coin===coin)&&(!interval||s.interval===interval));
 // Completed research signals are reported separately; do not double-count them
 // against historical accepted TP/SL, which uses a separate portfolio replay.
 const visible=status==='TRACKING'?activeResearch:visibleAll.filter(s=>!status||s.result===status);
 const skippedVisible=skipped.filter(s=>s.signal_available_at>=start&&(!coin||s.coin===coin)&&(!interval||s.interval===interval));
 const selected=status==='SKIPPED_ALREADY_OPEN'?skippedVisible:status==='TRACKING'?activeResearch:status?visible:[...visibleAll,...activeResearch];
 const tp=visibleAll.filter(s=>s.result==='TP_FIRST').length,sl=visibleAll.filter(s=>s.result==='SL_FIRST').length;
 const timed=visibleAll.filter(s=>s.result==='TIME_EXIT'&&s.net!==null);
 const timeWin=timed.filter(s=>Number(s.net)>0).length,timeLoss=timed.filter(s=>Number(s.net)<0).length,timeFlat=timed.length-timeWin-timeLoss;
 const netSum=visibleAll.reduce((n,s)=>n+(s.net===null?0:Number(s.net)),0);
 const netDone=tp+sl+timed.length;
 const tracking=activeResearch.length,uncertain=visibleAll.filter(s=>!['TP_FIRST','SL_FIRST','TRACKING'].includes(s.result)).length;
 return {success:true,module:'SWING_DIRECTION_EXECUTABLE_V3',variant,mode,read_only:true,trading:false,
  methodology:{position_limit:'ONE_PER_COIN_PER_DIRECTION_ACROSS_1H_4H',entry:'SIGNAL_AVAILABLE_AT',exit:'END_OF_FIRST_TOUCH_1H_BAR_CONSERVATIVE',unknown_exit:'EXCLUDED_BEFORE_REPLAY',time_exit:'VERIFIED_48H_1H_OR_72H_4H_INCLUDED',cost_pct:0.18,scope:'HISTORICAL_HYPOTHETICAL_NOT_EXCHANGE_FILLS'},
  period,source,tracking_diagnostics:{active:activeResearch.length,first_touch_resolved_not_yet_settled:closedResearch.length,unverified:activeResearch.filter(s=>s.verification!=='OHLC_1H_TP2_SL1').length,source:'D1_RESEARCH_SIGNALS_OHLC_NOT_EXCHANGE_POSITIONS'},filters:{coin,interval,status,mode,btc_1h:'MIXED',btc_4h:variant==='B'?'MIXED':'ANY',tp:2,sl:1},
  stats:{total:visibleAll.length,tracking,tp,sl,time_exit:timed.length,time_exit_win:timeWin,time_exit_loss:timeLoss,time_exit_flat:timeFlat,net_pct_sum:Number(netSum.toFixed(5)),net_win_rate_pct:netDone?Number((100*(tp+timeWin)/netDone).toFixed(2)):null,uncertain,skipped:skippedVisible.length,win_rate_pct:tp+sl?Number((100*tp/(tp+sl)).toFixed(2)):null},
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

export async function handleSwingHunterRequest(req:Request,_env:unknown):Promise<Response>{
 const env=_env as any;
 const u=new URL(req.url);
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
