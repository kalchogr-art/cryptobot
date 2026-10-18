/** SWING FILTER CACHE V1: materialized market-filter matches; NO execution / OHLC replay. */
const SHORT_PATTERNS=['DOUBLE_TOP','RANGE_BREAKDOWN','BEAR_ENGULF','VOLUME_EXPANSION_SHORT','MOMENTUM_REVERSAL_SHORT','EMA_PULLBACK_SHORT'];
const NOW_MS=()=>Date.now();
export async function swingFilterCron(env:any):Promise<any>{
 const db=env.SWING_DB;
 if(!db?.prepare)return {ok:false,error:'SWING_DB_MISSING'};
 // Migrations are idempotent. Prefer running the supplied SQL once before deploy.
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_filtered_signals (source_id INTEGER NOT NULL, variant TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL, interval TEXT NOT NULL, pattern TEXT NOT NULL, signal_bar_open INTEGER NOT NULL, signal_available_at INTEGER, status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(source_id,variant))`).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_filter_cursor (name TEXT PRIMARY KEY,last_id INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL)`).run();
 const cur:any=await db.prepare("SELECT last_id FROM swing_filter_cursor WHERE name='v1'").first();
 const cursor=Number(cur?.last_id||0);
 const chunk:any=await db.prepare('SELECT id FROM swing_context_signals WHERE id>? ORDER BY id LIMIT 200').bind(cursor).all();
 const ids=(chunk.results||[]).map((r:any)=>Number(r.id));
 const maxId=ids.length?ids[ids.length-1]:cursor;
 if(ids.length){
  // Only rows inside this ID range. A/B have separate records; never count variants together.
  const statements:any[]=[];
  for(const variant of ['A','B']){
   const b4=variant==='B'?`AND json_extract(s.context_json,'$.btcDirection.timeframes."4h".direction')='MIXED'`:'';
   const sql=`INSERT INTO swing_filtered_signals (source_id,variant,coin,side,interval,pattern,signal_bar_open,signal_available_at,status,updated_at)
   SELECT s.id,?,s.coin,s.side,s.interval,s.pattern,s.signal_bar_open,s.signal_available_at,s.status,?
   FROM swing_context_signals s WHERE s.id>? AND s.id<=? AND s.interval IN ('1h','4h')
   AND ((s.side='SHORT' AND s.pattern IN (${SHORT_PATTERNS.map(()=>'?').join(',')})
   AND json_extract(s.context_json,'$.btcDirection.timeframes."1h".direction')='MIXED' ${b4})
   OR (s.side='LONG' AND s.pattern='TRIANGLE_UP' AND json_extract(s.context_json,'$.btcDirection.timeframes."1h".direction')='MIXED'))
   ON CONFLICT(source_id,variant) DO UPDATE SET status=excluded.status,signal_available_at=excluded.signal_available_at,updated_at=excluded.updated_at`;
   statements.push(db.prepare(sql).bind(variant,NOW_MS(),cursor,maxId,...SHORT_PATTERNS));
  }
  // Cursor advances ONLY after both writes succeed. Retry is safe via UPSERT.
  await db.batch(statements);
  await db.prepare("INSERT INTO swing_filter_cursor(name,last_id,updated_at) VALUES('v1',?,?) ON CONFLICT(name) DO UPDATE SET last_id=excluded.last_id,updated_at=excluded.updated_at").bind(maxId,NOW_MS()).run();
 }
 // Sync status changes of materialized signals without re-filtering historical JSON.
 // One indexed update across existing matches; no OHLC / exchange requests.
 await db.prepare(`UPDATE swing_filtered_signals SET status=(SELECT s.status FROM swing_context_signals s WHERE s.id=swing_filtered_signals.source_id),updated_at=? WHERE EXISTS(SELECT 1 FROM swing_context_signals s WHERE s.id=swing_filtered_signals.source_id AND s.status<>swing_filtered_signals.status)`).bind(NOW_MS()).run();
 return {ok:true,processed:ids.length,last_id:maxId,more:ids.length===200};
}
export async function swingFilteredRead(env:any,u:URL):Promise<any>{
 const db=env.SWING_DB;if(!db?.prepare)throw Error('MISSING_SWING_DB');
 const variant=u.searchParams.get('variant')==='B'?'B':'A';
 const mode=variant==='B'?'SHORT':(u.searchParams.get('mode')||'SHORT');
 if(!['SHORT','LONG','ALL'].includes(mode))throw Error('INVALID_MODE');
 const period=u.searchParams.get('period')==='total'?'total':'today';
 const interval=u.searchParams.get('interval')||'';
 const coin=(u.searchParams.get('coin')||'').toUpperCase();
 if(interval&&!['1h','4h'].includes(interval))throw Error('INVALID_INTERVAL');
 if(coin&&!/^[A-Z0-9_-]{1,10}$/.test(coin))throw Error('INVALID_COIN');
 const page=Math.max(1,Math.min(100000,Number(u.searchParams.get('page'))||1));
 const limit=Math.max(1,Math.min(100,Number(u.searchParams.get('limit'))||20));
 const where=['variant=?'];const params:any[]=[variant];
 if(mode!=='ALL'){where.push('side=?');params.push(mode)}
 if(interval){where.push('interval=?');params.push(interval)}
 if(coin){where.push('coin=?');params.push(coin)}
 if(period==='today'){
  const now=new Date();const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit'}).format(now).split('-').map(Number);
  const midnight=Date.UTC(parts[0],parts[1]-1,parts[2]);
  // Calculate local midnight with timezone-safe Intl parts (DST aware).
  let start=midnight-2*3600000;
  const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Sofia',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  for(let i=0;i<3;i++){const p=Object.fromEntries(fmt.formatToParts(new Date(start)).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));start+=midnight-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute)}
  where.push('signal_bar_open>=?','signal_bar_open<=?');params.push(start,Date.now());
 }
 const w=where.join(' AND ');
 // Deduplicate patterns on a single candle. Then select the most recent TRACKING
 // signal per coin and direction ACROSS 1h/4h, as in swingExecutableV2.
 // Historical completed replay entries cannot be inferred from this table.
 const cte=`WITH grouped AS (
   SELECT coin,side,interval,signal_bar_open,
     MAX(COALESCE(signal_available_at,signal_bar_open)) signal_available_at,
     MAX(CASE WHEN status='TRACKING' THEN 1 ELSE 0 END) tracking,
     COUNT(DISTINCT pattern) confirmations,GROUP_CONCAT(DISTINCT pattern) patterns
   FROM swing_filtered_signals WHERE ${w}
   GROUP BY coin,side,interval,signal_bar_open
 ), ranked AS (
   SELECT *,ROW_NUMBER() OVER (PARTITION BY coin,side
     ORDER BY signal_available_at DESC,signal_bar_open DESC,interval DESC) rn
   FROM grouped WHERE tracking=1
 )`;
 // 'eligible_signals' represents the current latest TRACKING candidate per coin/side,
 // NOT all market-filter matches and NOT verified OHLC replay entries.
 const row:any=await db.prepare(cte+` SELECT
   (SELECT COUNT(*) FROM grouped) AS market_matches,
   (SELECT COUNT(*) FROM ranked WHERE rn=1) AS eligible,
   (SELECT COUNT(*) FROM ranked WHERE rn=1 AND interval='1h') AS h1,
   (SELECT COUNT(*) FROM ranked WHERE rn=1 AND interval='4h') AS h4,
   (SELECT COUNT(*) FROM grouped WHERE tracking=1) AS raw_tracking`).bind(...params).first();
 const res:any=await db.prepare(cte+` SELECT coin,side,interval,signal_bar_open,signal_available_at,
   tracking,confirmations,patterns FROM ranked WHERE rn=1
   ORDER BY signal_available_at DESC LIMIT ? OFFSET ?`).bind(...params,limit,(page-1)*limit).all();
 const cursor:any=await db.prepare("SELECT last_id,updated_at FROM swing_filter_cursor WHERE name='v1'").first();
 const max:any=await db.prepare('SELECT MAX(id) latest FROM swing_context_signals').first();
 return {success:true,variant,mode,period,eligible_signals:Number(row?.eligible||0),tracking:Number(row?.eligible||0),market_matches:Number(row?.market_matches||0),raw_tracking:Number(row?.raw_tracking||0),methodology:"LATEST_TRACKING_PER_COIN_AND_SIDE_NO_OHLC_VERIFICATION",breakdown:{'1h':Number(row?.h1||0),'4h':Number(row?.h4||0)},rows:res.results||[],page,limit,pages:Math.max(1,Math.ceil(Number(row?.eligible||0)/limit)),sync:{last_id:Number(cursor?.last_id||0),latest_id:Number(max?.latest||0),complete:Number(cursor?.last_id||0)>=Number(max?.latest||0),updated_at:cursor?.updated_at||null},source:{table:'swing_filtered_signals'}};
}
