/** SWING EARLY EXIT — SHADOW ONLY. Never places/cancels orders. */
type Env={DB?:any;SWING_ADMIN_TOKEN?:string};
const STRATEGIES=['SWING_SHORT_FILTERED_V1','SWING_SHORT_DOUBLE_MIXED_B_V1','SWING_LONG_FILTERED_V1'];
const COINS=['BTC','ETH','SOL','XRP','BNB','DOGE','AVAX','LINK','SUI','HYPE','ADA','LTC','BCH','AAVE','UNI','NEAR','OP','ARB','WIF','TRX'];
const n=(v:any)=>Number(v);
const valid=(v:any)=>Number.isFinite(n(v))&&n(v)>0;
type Bar={t:number;o:number;h:number;l:number;c:number;v:number};
async function candles(coin:string,interval:'1m'|'5m',count=35):Promise<Bar[]>{
 const step=interval==='1m'?60000:300000,now=Date.now();const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),8500);
 try{const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin,interval,startTime:now-step*(count+3),endTime:now}}),signal:ctrl.signal});
 if(!r.ok)throw Error('HYPERLIQUID_'+r.status);const raw:any=await r.json();if(!Array.isArray(raw))throw Error('INVALID_CANDLES');
 return raw.map((x:any)=>({t:n(x.t),o:n(x.o),h:n(x.h),l:n(x.l),c:n(x.c),v:n(x.v)})).filter((x:Bar)=>[x.t,x.o,x.h,x.l,x.c,x.v].every(Number.isFinite)&&x.c>0&&x.t+step<=now).sort((a:Bar,b:Bar)=>a.t-b.t).slice(-count);
 }finally{clearTimeout(timer)}}
function change(b:Bar[],back:number){return b.length>back&&b[b.length-1-back].c>0?100*(b[b.length-1].c/b[b.length-1-back].c-1):0}
function assess(side:string,one:Bar[],five:Bar[],btc:Bar[],breadth:number){
 const direction=side==='LONG'?-1:1;
 const move1=change(one,3)*direction,move5=change(five,2)*direction,btcMove=change(btc,5)*direction;
 const last=one.at(-1)!,prev=one.slice(-7,-1);
 const broken=side==='LONG'?last.c<Math.min(...prev.map(x=>x.l)):last.c>Math.max(...prev.map(x=>x.h));
 const volAvg=prev.reduce((s,x)=>s+x.v,0)/Math.max(prev.length,1);
 const adverseCandle=side==='LONG'?last.c<last.o:last.c>last.o;
 const volSpike=adverseCandle&&volAvg>0&&last.v>volAvg*1.5;
 const market=Math.min(100,Math.round((btcMove>0.18?35:btcMove>0.08?18:0)+(breadth>=0.75?40:breadth>=0.6?25:0)+(btcMove>0.35?25:0)));
 const position=Math.min(100,Math.round((move1>0.15?30:move1>0.06?15:0)+(move5>0.2?25:move5>0.08?12:0)+(broken?30:0)+(volSpike?15:0)));
 const reasons=[btcMove>0.08?'BTC_AGAINST_POSITION':null,breadth>=0.6?'MARKET_BREADTH_AGAINST':null,move1>0.06?'1M_ADVERSE_MOMENTUM':null,move5>0.08?'5M_ADVERSE_MOMENTUM':null,broken?'LOCAL_STRUCTURE_BREAK':null,volSpike?'ADVERSE_VOLUME_SPIKE':null].filter(Boolean);
 return {market,position,move1,move5,btcMove,breadth,reasons,propose:market>=70&&position>=70};
}
async function snapshot(env:Env,coin:string,side:string,btc:Bar[],breadth:number){
 const [one,five]=await Promise.all([candles(coin,'1m'),candles(coin,'5m')]);
 if(one.length<10||five.length<10||btc.length<10)throw Error('INSUFFICIENT_CLOSED_CANDLES');
 const price=one.at(-1)!.c;return {price,bar_at:one.at(-1)!.t,...assess(side,one,five,btc,breadth)};
}
async function marketBreadth(btc:Bar[]){
 const sample=['ETH','SOL','XRP','BNB','DOGE','AVAX','LINK','SUI'];
 const results=await Promise.allSettled(sample.map(c=>candles(c,'1m',10)));
 const moves=results.filter((x):x is PromiseFulfilledResult<Bar[]>=>x.status==='fulfilled'&&x.value.length>=6).map(x=>change(x.value,5));
 if(moves.length<5)throw Error('MARKET_BREADTH_DATA_INSUFFICIENT');
 return {long:moves.filter(x=>x<-.12).length/moves.length,short:moves.filter(x=>x>.12).length/moves.length,coverage:moves.length};
}
export async function runSwingEarlyExitCycle(env:Env){
 if(!env.DB?.prepare)throw Error('LIVE_DB_BINDING_MISSING');
 const db=env.DB,now=Date.now();
 // Only actually filled LIVE positions, not research or rejected signals.
 const query=await db.prepare(`SELECT crossing_id,coin,side,status,entry_fill_price,entry_fill_size,entry_filled_at,closed_at,exit_price,realized_pnl,close_reason,strategy_version FROM hyperliquid_execution_ledger WHERE strategy_version IN (?,?,?) AND entry_filled_at IS NOT NULL AND (status='CLOSED' AND closed_at>=? OR status!='CLOSED') ORDER BY entry_filled_at DESC LIMIT 150`).bind(...STRATEGIES,now-7*86400000).all();
 const rows:any[]=query.results||[],opened=rows.filter(r=>r.status!=='CLOSED'),closed=rows.filter(r=>r.status==='CLOSED');
 const btc=await candles('BTC','1m',18),breadth=await marketBreadth(btc);
 let observed=0,proposed=0,compared=0;const errors:any[]=[];
 for(const r of opened){
  try{
   const coin=String(r.coin||'').toUpperCase(),side=String(r.side||'').toUpperCase();
   if(!COINS.includes(coin)||!['LONG','SHORT'].includes(side)||!valid(r.entry_fill_price)||!valid(r.entry_filled_at))continue;
   const s=await snapshot(env,coin,side,btc,side==='LONG'?breadth.long:breadth.short);
   // The most recent closed 1m bar must be after the actual fill. No retroactive warning.
   if(s.bar_at<n(r.entry_filled_at))continue;
   const gross=100*(s.price/n(r.entry_fill_price)-1)*(side==='LONG'?1:-1);
   const key=String(r.crossing_id);
   await db.prepare(`INSERT INTO swing_early_exit (crossing_id,coin,side,entry_at,entry_price,entry_size,first_observed_at,last_observed_at,last_price,last_gross_pct,market_danger,position_danger,observations,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,'MONITORING') ON CONFLICT(crossing_id) DO UPDATE SET last_observed_at=excluded.last_observed_at,last_price=excluded.last_price,last_gross_pct=excluded.last_gross_pct,market_danger=excluded.market_danger,position_danger=excluded.position_danger,observations=observations+1`).bind(key,coin,side,n(r.entry_filled_at),n(r.entry_fill_price),valid(r.entry_fill_size)?n(r.entry_fill_size):null,now,now,s.price,gross,s.market,s.position).run();
   observed++;
   if(s.propose){
    // Exactly one immutable FIRST proposal per trade; do not overwrite later.
    const res=await db.prepare(`UPDATE swing_early_exit SET proposed_at=?,proposal_price=?,proposal_gross_pct=?,proposal_market_danger=?,proposal_position_danger=?,proposal_reasons_json=?,proposal_bar_at=?,status='EXIT_PROPOSED' WHERE crossing_id=? AND proposed_at IS NULL`).bind(now,s.price,gross,s.market,s.position,JSON.stringify(s.reasons),s.bar_at,key).run();
    if(res.meta?.changes)proposed++;
   }
  }catch(e:any){errors.push({coin:r.coin,id:r.crossing_id,error:String(e?.message||e)})}
 }
 // Reconcile only actual ledger closes; never invent hypothetical TP/SL outcomes.
 for(const r of closed){
  try{if(!valid(r.exit_price)||!valid(r.entry_fill_price)||!valid(r.closed_at))continue;
   const side=String(r.side).toUpperCase(),realGross=100*(n(r.exit_price)/n(r.entry_fill_price)-1)*(side==='LONG'?1:-1);
   const res=await db.prepare(`UPDATE swing_early_exit SET status='CLOSED',actual_closed_at=?,actual_exit_price=?,actual_gross_pct=?,actual_net_pnl_usd=?,actual_close_reason=?,comparison_gross_pp=CASE WHEN proposal_gross_pct IS NOT NULL THEN proposal_gross_pct-? ELSE NULL END WHERE crossing_id=? AND actual_closed_at IS NULL`).bind(n(r.closed_at),n(r.exit_price),realGross,r.realized_pnl==null?null:n(r.realized_pnl),String(r.close_reason||''),realGross,String(r.crossing_id)).run();
   if(res.meta?.changes)compared++;
  }catch(e:any){errors.push({coin:r.coin,id:r.crossing_id,error:String(e?.message||e)})}
 }
 return {success:errors.length===0,module:'SWING_EARLY_EXIT',mode:'SHADOW_ONLY',trading:false,opened:opened.length,observed,proposed,compared,market_coverage:breadth.coverage,errors:errors.slice(0,12),timestamp:now};
}
export async function swingEarlyExitData(env:Env){
 if(!env.DB?.prepare)throw Error('LIVE_DB_BINDING_MISSING');
 const r=await env.DB.prepare(`SELECT * FROM swing_early_exit ORDER BY COALESCE(proposed_at,last_observed_at) DESC LIMIT 1000`).all();
 const rows=r.results||[];return {rows,stats:{total:rows.length,monitoring:rows.filter((x:any)=>x.status==='MONITORING').length,proposed:rows.filter((x:any)=>x.proposed_at!=null).length,compared:rows.filter((x:any)=>x.actual_closed_at!=null&&x.proposed_at!=null).length,missed_tp:rows.filter((x:any)=>x.proposed_at!=null&&x.actual_close_reason==='TP').length,estimated_gross_difference_pp:rows.filter((x:any)=>x.comparison_gross_pp!=null).reduce((s:number,x:any)=>s+n(x.comparison_gross_pp),0)},limited:rows.length===1000,note:'Gross price comparison; proposed exit is not an executed fill and excludes fees/slippage.'};
}
