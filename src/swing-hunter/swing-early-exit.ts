/** SWING EARLY EXIT V2 — SHADOW ONLY. Never submits, cancels or modifies orders.
 * V1 history stays in swing_early_exit. V2 is a separate, prospective cohort.
 */
type Env={DB?:any};
type Bar={t:number;o:number;h:number;l:number;c:number;v:number};
const STRATEGIES=['SWING_SHORT_FILTERED_V1','SWING_SHORT_DOUBLE_MIXED_B_V1','SWING_LONG_FILTERED_V1'];
const COINS=new Set(['BTC','ETH','SOL','XRP','BNB','DOGE','AVAX','LINK','SUI','HYPE','ADA','LTC','BCH','AAVE','UNI','NEAR','OP','ARB','WIF','TRX']);
const num=(x:any)=>Number(x);
const finite=(x:any)=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(num(x));
const positive=(x:any)=>finite(x)&&num(x)>0;
const round=(x:number)=>Math.round(x*1e6)/1e6;
async function candles(coin:string,interval:'1m'|'5m',count=35):Promise<Bar[]>{
 const step=interval==='1m'?60000:300000,now=Date.now(),ctrl=new AbortController();
 const timer=setTimeout(()=>ctrl.abort(),8500);
 try{
  const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin,interval,startTime:now-step*(count+3),endTime:now}}),signal:ctrl.signal});
  if(!r.ok)throw Error('HYPERLIQUID_'+r.status);
  const raw:any=await r.json();if(!Array.isArray(raw))throw Error('INVALID_CANDLES');
  return raw.map((x:any)=>({t:num(x.t),o:num(x.o),h:num(x.h),l:num(x.l),c:num(x.c),v:num(x.v)}))
   .filter((b:Bar)=>[b.t,b.o,b.h,b.l,b.c,b.v].every(Number.isFinite)&&b.c>0&&b.t+step<=now)
   .sort((a:Bar,b:Bar)=>a.t-b.t).slice(-count);
 }finally{clearTimeout(timer)}
}
function change(b:Bar[],back:number){return b.length>back&&b[b.length-1-back].c>0?100*(b[b.length-1].c/b[b.length-1-back].c-1):0}
function assess(side:string,one:Bar[],five:Bar[],btc:Bar[],breadth:number){
 const direction=side==='LONG'?-1:1;
 const move1=change(one,3)*direction,move5=change(five,2)*direction,btcMove=change(btc,5)*direction;
 const last=one[one.length-1],prev=one.slice(-7,-1);
 const broken=side==='LONG'?last.c<Math.min(...prev.map(x=>x.l)):last.c>Math.max(...prev.map(x=>x.h));
 const volAvg=prev.reduce((s,x)=>s+x.v,0)/prev.length;
 const adverseCandle=side==='LONG'?last.c<last.o:last.c>last.o;
 const volSpike=adverseCandle&&volAvg>0&&last.v>volAvg*1.5;
 const market=Math.min(100,Math.round((btcMove>0.18?35:btcMove>0.08?18:0)+(breadth>=.75?40:breadth>=.6?25:0)+(btcMove>.35?25:0)));
 const position=Math.min(100,Math.round((move1>.15?30:move1>.06?15:0)+(move5>.2?25:move5>.08?12:0)+(broken?30:0)+(volSpike?15:0)));
 const reasons=[btcMove>.08?'BTC_AGAINST_POSITION':null,breadth>=.6?'MARKET_BREADTH_AGAINST':null,move1>.06?'1M_ADVERSE_MOMENTUM':null,move5>.08?'5M_ADVERSE_MOMENTUM':null,broken?'LOCAL_STRUCTURE_BREAK':null,volSpike?'ADVERSE_VOLUME_SPIKE':null].filter(Boolean);
 // V1 preserved exactly; only its evaluation cadence becomes shared with V2.
 const v1=market>=70&&position>=70;
 // V2 hypotheses: fast price/structure deterioration OR confirmed broader deterioration.
 const fast=(move1>=.18&&volSpike)||(move1>=.23&&broken)||(move1>=.32&&move5>=.12);
 const trend=(move1>=.09&&move5>=.16&&broken)||(position>=55&&market>=40);
 const score=Math.min(100,Math.round(position*.65+market*.35));
 const mode=fast?'FAST':trend?'TREND':null;
 const warning=score>=35||move1>=.09||move5>=.13;
 return {market,position,move1,move5,btcMove,breadth,broken,volSpike,reasons,v1,mode,warning,score};
}
async function marketBreadth(){
 const sample=['ETH','SOL','XRP','BNB','DOGE','AVAX','LINK','SUI'];
 const results=await Promise.allSettled(sample.map(c=>candles(c,'1m',10)));
 const moves=results.filter((x):x is PromiseFulfilledResult<Bar[]>=>x.status==='fulfilled'&&x.value.length>=6).map(x=>change(x.value,5));
 if(moves.length<5)throw Error('MARKET_BREADTH_DATA_INSUFFICIENT');
 return {long:moves.filter(x=>x<-.12).length/moves.length,short:moves.filter(x=>x>.12).length/moves.length,coverage:moves.length};
}
async function ensureV2(db:any){
 await db.prepare(`CREATE TABLE IF NOT EXISTS swing_early_exit_v2 (
 crossing_id TEXT PRIMARY KEY,coin TEXT NOT NULL,side TEXT NOT NULL,entry_at INTEGER NOT NULL,entry_price REAL NOT NULL,
 first_observed_at INTEGER NOT NULL,last_observed_at INTEGER NOT NULL,last_bar_at INTEGER NOT NULL,
 observations INTEGER NOT NULL DEFAULT 0,last_price REAL,last_gross_pct REAL,market_danger INTEGER,position_danger INTEGER,risk_score INTEGER,
 first_warning_at INTEGER,first_warning_bar_at INTEGER,first_warning_price REAL,
 proposed_at INTEGER,proposal_bar_at INTEGER,proposal_price REAL,proposal_gross_pct REAL,proposal_mode TEXT,proposal_reasons_json TEXT,
 status TEXT NOT NULL DEFAULT 'MONITORING',actual_closed_at INTEGER,actual_exit_price REAL,actual_gross_pct REAL,actual_net_pnl_usd REAL,
 actual_close_reason TEXT,comparison_gross_pp REAL,created_at INTEGER NOT NULL
 )`).run();
}
export async function runSwingEarlyExitCycle(env:Env){
 if(!env.DB?.prepare)throw Error('LIVE_DB_BINDING_MISSING');
 const db=env.DB,now=Date.now();await ensureV2(db);
 const q=await db.prepare(`SELECT crossing_id,coin,side,status,entry_fill_price,entry_fill_size,entry_filled_at,closed_at,exit_price,realized_pnl,close_reason,strategy_version
 FROM hyperliquid_execution_ledger WHERE strategy_version IN (?,?,?) AND entry_filled_at IS NOT NULL AND ((status='CLOSED' AND closed_at>=?) OR status!='CLOSED')
 ORDER BY entry_filled_at DESC LIMIT 150`).bind(...STRATEGIES,now-7*86400000).all();
 const rows:any[]=q.results||[],opened=rows.filter(r=>r.status!=='CLOSED'),closed=rows.filter(r=>r.status==='CLOSED');
 const errors:any[]=[];let observed=0,v1proposed=0,v2proposed=0,warnings=0,compared=0;
 let btc:Bar[],breadth:{long:number;short:number;coverage:number};
 try{[btc,breadth]=await Promise.all([candles('BTC','1m',18),marketBreadth()]);if(btc.length<10)throw Error('BTC_CANDLES_INSUFFICIENT')}
 catch(e:any){return {success:false,module:'SWING_EARLY_EXIT_V2',mode:'SHADOW_ONLY',trading:false,opened:opened.length,error:String(e?.message||e),timestamp:now}}
 const cache=new Map<string,Promise<[Bar[],Bar[]]>>();
 for(const r of opened){
  const coin=String(r.coin||'').toUpperCase(),side=String(r.side||'').toUpperCase(),key=String(r.crossing_id||'');
  if(!key||!COINS.has(coin)||!['LONG','SHORT'].includes(side)||!positive(r.entry_fill_price)||!positive(r.entry_filled_at))continue;
  try{
   if(!cache.has(coin))cache.set(coin,Promise.all([candles(coin,'1m'),candles(coin,'5m')]));
   const [one,five]=await cache.get(coin)!;
   if(one.length<10||five.length<10)throw Error('INSUFFICIENT_CLOSED_CANDLES');
   const bar=one[one.length-1],price=bar.c;
   // No retrospective proposal based on bars that closed before entry.
   if(bar.t+60000<=num(r.entry_filled_at))continue;
   const a=assess(side,one,five,btc,side==='LONG'?breadth.long:breadth.short);
   const gross=round(100*(price/num(r.entry_fill_price)-1)*(side==='LONG'?1:-1));
   // Keep original V1 table and first-proposal rule intact.
   await db.prepare(`INSERT INTO swing_early_exit (crossing_id,coin,side,entry_at,entry_price,entry_size,first_observed_at,last_observed_at,last_price,last_gross_pct,market_danger,position_danger,observations,status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'MONITORING') ON CONFLICT(crossing_id) DO UPDATE SET last_observed_at=excluded.last_observed_at,last_price=excluded.last_price,last_gross_pct=excluded.last_gross_pct,market_danger=excluded.market_danger,position_danger=excluded.position_danger,observations=observations+1`)
    .bind(key,coin,side,num(r.entry_filled_at),num(r.entry_fill_price),positive(r.entry_fill_size)?num(r.entry_fill_size):null,now,now,price,gross,a.market,a.position).run();
   if(a.v1){const x=await db.prepare(`UPDATE swing_early_exit SET proposed_at=?,proposal_price=?,proposal_gross_pct=?,proposal_market_danger=?,proposal_position_danger=?,proposal_reasons_json=?,proposal_bar_at=?,status='EXIT_PROPOSED' WHERE crossing_id=? AND proposed_at IS NULL`).bind(now,price,gross,a.market,a.position,JSON.stringify(a.reasons),bar.t,key).run();if(x.meta?.changes)v1proposed++}
   // Separate V2 shadow cohort. One observation per CLOSED 1m bar, not per cron invocation.
   await db.prepare(`INSERT OR IGNORE INTO swing_early_exit_v2 (crossing_id,coin,side,entry_at,entry_price,first_observed_at,last_observed_at,last_bar_at,observations,last_price,last_gross_pct,market_danger,position_danger,risk_score,created_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`).bind(key,coin,side,num(r.entry_filled_at),num(r.entry_fill_price),now,now,bar.t,price,gross,a.market,a.position,a.score,now).run();
   const updated=await db.prepare(`UPDATE swing_early_exit_v2 SET last_observed_at=?,last_bar_at=?,observations=observations+1,last_price=?,last_gross_pct=?,market_danger=?,position_danger=?,risk_score=? WHERE crossing_id=? AND last_bar_at<? AND actual_closed_at IS NULL`).bind(now,bar.t,price,gross,a.market,a.position,a.score,key,bar.t).run();
   // An existing row with the same bar was already assessed. Prevent repeated proposals on the same stale bar.
   const fresh=Boolean(updated.meta?.changes);
   const state=await db.prepare(`SELECT proposed_at,first_warning_at,last_bar_at,first_observed_at FROM swing_early_exit_v2 WHERE crossing_id=?`).bind(key).first();
   const firstBar=state?.first_observed_at===now; // inserted on this invocation
   if((fresh||firstBar)&&a.warning){const x=await db.prepare(`UPDATE swing_early_exit_v2 SET first_warning_at=?,first_warning_bar_at=?,first_warning_price=? WHERE crossing_id=? AND first_warning_at IS NULL AND actual_closed_at IS NULL`).bind(now,bar.t,price,key).run();if(x.meta?.changes)warnings++}
   if((fresh||firstBar)&&a.mode){const x=await db.prepare(`UPDATE swing_early_exit_v2 SET proposed_at=?,proposal_bar_at=?,proposal_price=?,proposal_gross_pct=?,proposal_mode=?,proposal_reasons_json=?,status='EXIT_PROPOSED' WHERE crossing_id=? AND proposed_at IS NULL AND actual_closed_at IS NULL`).bind(now,bar.t,price,gross,a.mode,JSON.stringify(a.reasons),key).run();if(x.meta?.changes)v2proposed++}
   observed++;
  }catch(e:any){errors.push({coin,id:key,error:String(e?.message||e)})}
 }
 for(const r of closed){
  try{
   if(!positive(r.exit_price)||!positive(r.entry_fill_price)||!positive(r.closed_at))continue;
   const side=String(r.side).toUpperCase(),realGross=round(100*(num(r.exit_price)/num(r.entry_fill_price)-1)*(side==='LONG'?1:-1));
   const bind=[num(r.closed_at),num(r.exit_price),realGross,finite(r.realized_pnl)?num(r.realized_pnl):null,String(r.close_reason||''),realGross,String(r.crossing_id)];
   await db.prepare(`UPDATE swing_early_exit SET status='CLOSED',actual_closed_at=?,actual_exit_price=?,actual_gross_pct=?,actual_net_pnl_usd=?,actual_close_reason=?,comparison_gross_pp=CASE WHEN proposal_gross_pct IS NOT NULL THEN proposal_gross_pct-? ELSE NULL END WHERE crossing_id=? AND actual_closed_at IS NULL`).bind(...bind).run();
   const x=await db.prepare(`UPDATE swing_early_exit_v2 SET status='CLOSED',actual_closed_at=?,actual_exit_price=?,actual_gross_pct=?,actual_net_pnl_usd=?,actual_close_reason=?,comparison_gross_pp=CASE WHEN proposal_gross_pct IS NOT NULL THEN proposal_gross_pct-? ELSE NULL END WHERE crossing_id=? AND actual_closed_at IS NULL`).bind(...bind).run();
   if(x.meta?.changes)compared++;
  }catch(e:any){errors.push({coin:r.coin,id:r.crossing_id,error:String(e?.message||e)})}
 }
 return {success:errors.length===0,module:'SWING_EARLY_EXIT_V2',mode:'SHADOW_ONLY',trading:false,opened:opened.length,observed,v1proposed,v2proposed,warnings,compared,market_coverage:breadth.coverage,errors:errors.slice(0,15),timestamp:now};
}
export async function swingEarlyExitData(env:Env){
 if(!env.DB?.prepare)throw Error('LIVE_DB_BINDING_MISSING');
 const db=env.DB;await ensureV2(db);
 const [v1,v2]=await Promise.all([db.prepare(`SELECT * FROM swing_early_exit ORDER BY COALESCE(proposed_at,last_observed_at) DESC LIMIT 1000`).all(),db.prepare(`SELECT * FROM swing_early_exit_v2 ORDER BY COALESCE(proposed_at,last_observed_at) DESC LIMIT 1000`).all()]);
 const rows:any[]=v1.results||[],v2rows:any[]=v2.results||[];
 const stats=(r:any[])=>({total:r.length,monitoring:r.filter(x=>x.status==='MONITORING').length,proposed:r.filter(x=>x.proposed_at!=null).length,compared:r.filter(x=>x.actual_closed_at!=null&&x.proposed_at!=null).length,missed_tp:r.filter(x=>x.proposed_at!=null&&x.actual_close_reason==='TP').length,estimated_gross_difference_pp:round(r.filter(x=>finite(x.comparison_gross_pp)).reduce((s,x)=>s+num(x.comparison_gross_pp),0)),closed_without_proposal:r.filter(x=>x.actual_closed_at!=null&&x.proposed_at==null).length});
 return {rows,stats:stats(rows),limited:rows.length===1000,v2:{rows:v2rows,stats:stats(v2rows),limited:v2rows.length===1000,fast:v2rows.filter(x=>x.proposal_mode==='FAST').length,trend:v2rows.filter(x=>x.proposal_mode==='TREND').length},note:'V1 and V2 are SHADOW. Proposal price is last CLOSED 1m candle close, not an executable fill. Gross comparison excludes fees/slippage. V2 begins tracking prospectively.'};
}
