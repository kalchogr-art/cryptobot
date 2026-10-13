import {scanAndLog,settleSignals,recentSignals} from './signal-logger';
import {swingMonitorDashboard} from './swing-monitor-dashboard';
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

export async function handleSwingHunterRequest(req:Request,_env:unknown):Promise<Response>{
 const env=_env as any;
 const u=new URL(req.url);
 if(req.method==='GET'&&u.pathname==='/swing-hunter/monitor')return new Response(swingMonitorDashboard(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}});
 if(['/api/swing/v19/scan','/api/swing/v19/settle','/api/swing/v19/log','/api/swing/v19/resolved-count','/api/swing/v19/history','/api/swing/v19/filtered-short'].includes(u.pathname)){
  if(!env.SWING_ADMIN_TOKEN)return json({success:false,error:'SWING_ADMIN_TOKEN_NOT_CONFIGURED'},503);
  if(req.headers.get('x-swing-token')!==env.SWING_ADMIN_TOKEN)return json({success:false,error:'UNAUTHORIZED'},401);
  try{
   if(u.pathname==='/api/swing/v19/filtered-short'){
    if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
    return json(await filteredShortHistory(env,u));
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
