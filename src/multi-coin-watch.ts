// MULTI-COIN TRADER WATCH V1 — VIRTUAL ONLY, NO EXCHANGE ORDERS.
// Single wallet; D1 event log; Durable Object state. Starts flat; old target positions ignored until flat.
export const MC_WALLET='0x34fb5ec7d4e939161946340ea2a1f29254b893de';
const INFO='https://api.hyperliquid.xyz/info';
const INITIAL=1000, LEVERAGE=10, OPEN_MARGIN=10, OPEN_NOTIONAL=OPEN_MARGIN*LEVERAGE;
const MAKER_FEE=.00015, TAKER_FEE=.00045, MIN_NOTIONAL=10, EPS=1e-10;
const asNum=(x:any)=>Number(x)||0;
const sign=(x:number)=>Math.abs(x)<EPS?0:Math.sign(x);
const round=(x:number)=>Math.round(x*1e10)/1e10;
const reply=(v:any,status=200)=>new Response(JSON.stringify(v,null,2),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
type Position={coin:string;qty:number;avg:number;opened:number;gross:number;fees:number;entryFees:number;last:number;targetQty:number;trades:number};
type Session={id:string;active:boolean;started:number;cursor:number;cash:number;initial:number;positions:Record<string,Position>;baseline:Record<string,number>;ignored:Record<string,boolean>;lastPrice:Record<string,number>;fills:number;skipped:number;turnover:number;fees:number;gross:number;closed:number;wins:number;losses:number;errors:string[];lastPoll:number;lastError:string|null};
function fresh():Session{return{id:'MC-'+Date.now(),active:false,started:Date.now(),cursor:Date.now(),cash:INITIAL,initial:INITIAL,positions:{},baseline:{},ignored:{},lastPrice:{},fills:0,skipped:0,turnover:0,fees:0,gross:0,closed:0,wins:0,losses:0,errors:[],lastPoll:0,lastError:null};}
async function info(body:any){const r=await fetch(INFO,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('HL_HTTP_'+r.status);return r.json() as Promise<any>;}
export class MultiCoinEngine {
  constructor(private storage:any,private db:any){}
  async get():Promise<Session|null>{return (await this.storage.get('multiCoinV1'))||null;}
  async put(s:Session){await this.storage.put('multiCoinV1',s);}
  async tables(){if(!this.db)throw Error('D1_BINDING_MISSING');
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_events (session_id TEXT NOT NULL, fill_id TEXT NOT NULL, at INTEGER NOT NULL, coin TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,fill_id))`).run();
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS mc_watch_events_at ON mc_watch_events(session_id,at DESC)`).run();
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_closed (session_id TEXT NOT NULL, trade_id TEXT NOT NULL, coin TEXT NOT NULL, direction TEXT NOT NULL, opened INTEGER NOT NULL, closed INTEGER NOT NULL, entry REAL NOT NULL, exit REAL NOT NULL, gross REAL NOT NULL, fees REAL NOT NULL, net REAL NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,trade_id))`).run();
  }
  async start(){await this.tables();let s=await this.get();if(s?.active)return this.status();if(!s)s=fresh();
    // First start, or resumption: snapshot existing target positions to prevent copying inherited exposure.
    const state:any=await info({type:'clearinghouseState',user:MC_WALLET});
    const existing:Record<string,number>={};for(const x of state.assetPositions||[]){const p=x.position||{};existing[p.coin]=asNum(p.szi);}
    if(s.fills===0&&Object.keys(s.positions).length===0){s.baseline=existing;s.ignored=Object.fromEntries(Object.entries(existing).filter(([,q])=>sign(q)!==0).map(([c])=>[c,true]));s.cursor=Date.now();}
    s.active=true;s.lastError=null;await this.put(s);return this.status();
  }
  async stop(){const s=await this.get();if(!s)return{ok:true,active:false};s.active=false;await this.put(s);return this.status();}
  async newSession(){await this.tables();const old=await this.get();if(old?.active)throw Error('STOP_BEFORE_NEW_SESSION');await this.put(fresh());return this.status();}
  private async log(s:Session,id:string,at:number,coin:string,action:string,details:any){await this.db.prepare(`INSERT OR IGNORE INTO mc_watch_events(session_id,fill_id,at,coin,action,payload) VALUES(?,?,?,?,?,?)`).bind(s.id,id,at,coin,action,JSON.stringify(details)).run();}
  private async close(s:Session,p:Position,at:number,price:number,id:string){const net=p.gross-p.fees;const row={...p,closed:at,exit:price,net,direction:sign(p.qty)>=0?'LONG':'SHORT'};
    await this.db.prepare(`INSERT OR IGNORE INTO mc_watch_closed(session_id,trade_id,coin,direction,opened,closed,entry,exit,gross,fees,net,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(s.id,id,p.coin,sign(p.qty)>=0?'LONG':'SHORT',p.opened,at,p.avg,price,p.gross,p.fees,net,JSON.stringify(row)).run();
    s.closed++;if(net>0)s.wins++;else s.losses++;
  }
  private async apply(s:Session,f:any){const coin=String(f.coin||'');const at=asNum(f.time),px=asNum(f.px),size=asNum(f.sz),start=asNum(f.startPosition);
    const id=coin+':'+String(f.tid??f.hash??'')+':'+String(f.hash||'');if(!coin||!at||!px||!size||!['A','B'].includes(f.side))return;
    const signed=f.side==='B'?size:-size,end=round(start+signed),pos=s.positions[coin];
    const exists:any=await this.db.prepare('SELECT 1 AS yes FROM mc_watch_events WHERE session_id=? AND fill_id=?').bind(s.id,id).first();if(exists)return;
    let action='SKIPPED',reason='',delta=0,realized=0,fee=0,notional=0;
    if(s.ignored[coin]){
      // Ignore pre-existing exposure, but start copying on a fresh increase or direction flip.
      // Reductions of inherited exposure are not our trades.
      const freshIncrease=sign(start)===sign(end)&&sign(end)!==0&&Math.abs(end)>Math.abs(start)+EPS;
      const freshDirection=sign(end)!==0&&(sign(start)===0||sign(start)!==sign(end));
      if(sign(end)===0){delete s.ignored[coin];reason='TARGET_BASELINE_FLATTENED';}
      else if(freshIncrease||freshDirection){
        if(this.free(s)<OPEN_MARGIN){reason='INSUFFICIENT_FREE_MARGIN';}
        else {action='OPEN';delta=sign(end)*OPEN_NOTIONAL/px;notional=OPEN_NOTIONAL;
          fee=notional*(f.crossed===true?TAKER_FEE:MAKER_FEE);
          s.positions[coin]={coin,qty:delta,avg:px,opened:at,gross:0,fees:fee,entryFees:fee,last:px,targetQty:end,trades:1};
          delete s.ignored[coin];reason=freshDirection?'INHERITED_DIRECTION_FLIP':'INHERITED_POSITION_INCREASE';}
      }else reason='INHERITED_TARGET_POSITION';
    }
    else if(!pos){if(sign(start)!==0){reason='UNTRACKED_POSITION_STARTED_BEFORE_SESSION';s.ignored[coin]=sign(end)!==0;}
      else if(sign(end)!==0){action='OPEN';delta=sign(end)*OPEN_NOTIONAL/px;notional=Math.abs(delta*px);
        if(notional<MIN_NOTIONAL){reason='MIN_NOTIONAL';action='SKIPPED';}
        else if(this.free(s)<OPEN_MARGIN){reason='INSUFFICIENT_FREE_MARGIN';action='SKIPPED';s.ignored[coin]=true;}
        else {fee=notional*(f.crossed===true?TAKER_FEE:MAKER_FEE);s.positions[coin]={coin,qty:delta,avg:px,opened:at,gross:0,fees:fee,entryFees:fee,last:px,targetQty:end,trades:1};}}
      else reason='FLAT_FILL';
    }else{
      const before=pos.qty,oldTarget=Math.abs(start),newTarget=Math.abs(end);
      if(sign(start)!==sign(pos.targetQty) || Math.abs(start-pos.targetQty)>Math.max(1e-7,oldTarget*.00001)){
        // The target sequence diverged. Never leave a stale virtual position open.
        // Reconcile against the live clearinghouse snapshot, then close at an explicitly
        // ESTIMATED mark (not an observed execution). Do not backfill missing fills.
        const live:any=await info({type:'clearinghouseState',user:MC_WALLET});
        const liveQty=asNum((live.assetPositions||[]).find((x:any)=>x.position?.coin===coin)?.position?.szi);
        const sameDirection=sign(liveQty)===sign(end) && Math.abs(liveQty-end)<=Math.max(1e-7,Math.abs(end)*0.00001);
        const mid:any=await info({type:'allMids'});
        const estimatedPx=asNum(mid?.[coin])||px;
        const closingQty=Math.abs(pos.qty);
        const closeNotional=closingQty*estimatedPx;
        const closeRealized=closingQty*(estimatedPx-pos.avg)*sign(pos.qty);
        const closeFee=closeNotional*TAKER_FEE;
        delta=-pos.qty;notional=closeNotional;realized=closeRealized;fee=closeFee;
        pos.gross+=closeRealized;pos.fees+=closeFee;
        await this.close(s,{...pos},at,estimatedPx,id);
        delete s.positions[coin];
        action='RESYNC_CLOSE';
        reason='TARGET_POSITION_GAP_ESTIMATED_CLOSE';
        s.ignored[coin]=sign(liveQty)!==0;
        // A reversal is confirmed only when both the fill and live position agree.
        // Otherwise wait for a clean subsequent fill; do not invent an entry.
        if(sign(start)!==0&&sign(end)===-sign(start)&&sameDirection&&sign(end)!==0&&this.free(s)>=OPEN_MARGIN){
          const newQty=sign(end)*OPEN_NOTIONAL/estimatedPx;
          const newFee=OPEN_NOTIONAL*TAKER_FEE;
          s.positions[coin]={coin,qty:newQty,avg:estimatedPx,opened:at,gross:0,fees:newFee,entryFees:newFee,last:estimatedPx,targetQty:liveQty,trades:1};
          delete s.ignored[coin];
          fee+=newFee;notional+=OPEN_NOTIONAL;
          action='RESYNC_REVERSAL';
          reason='TARGET_POSITION_GAP_CONFIRMED_REVERSAL_ESTIMATED_FILL';
        }
        // The target can have traded further since the fill: targetQty is
        // the confirmed snapshot, so subsequent historical fills may not be
        // continuous. Such fills must never be treated as new entries.
      }else if(sign(end)===sign(start)&&newTarget>oldTarget){
        action='ADD';delta=before*(newTarget/oldTarget-1);notional=Math.abs(delta*px);
        if(this.free(s)<notional/LEVERAGE){action='SKIPPED';reason='INSUFFICIENT_FREE_MARGIN';s.ignored[coin]=true;}
        else {fee=notional*(f.crossed===true?TAKER_FEE:MAKER_FEE);pos.avg=(Math.abs(before)*pos.avg+Math.abs(delta)*px)/Math.abs(before+delta);pos.qty=round(before+delta);pos.fees+=fee;pos.entryFees+=fee;pos.trades++;pos.targetQty=end;}}
      else {const fraction=oldTarget>EPS?Math.min(1,Math.abs(signed)/oldTarget):1;const closeQty=Math.abs(before)*fraction;delta=-sign(before)*closeQty;notional=closeQty*px;
        realized=closeQty*(px-pos.avg)*sign(before);fee=notional*(f.crossed===true?TAKER_FEE:MAKER_FEE);
        const allocatedEntry=pos.entryFees*fraction;pos.entryFees-=allocatedEntry;
        pos.gross+=realized;pos.fees+=fee;pos.qty=round(before+delta);pos.trades++;pos.targetQty=end;
        action=sign(end)!==sign(start)?'REVERSAL':sign(end)===0?'CLOSE':'PARTIAL_CLOSE';
        if(action==='REVERSAL'||action==='CLOSE'||Math.abs(pos.qty)<EPS){
          await this.close(s,{...pos,targetQty:start},at,px,id);delete s.positions[coin];
          if(action==='REVERSAL'){const newQty=sign(end)*OPEN_NOTIONAL/px;const margin=OPEN_MARGIN;
            if(this.free(s)>=margin){const entryFee=OPEN_NOTIONAL*(f.crossed===true?TAKER_FEE:MAKER_FEE);s.positions[coin]={coin,qty:newQty,avg:px,opened:at,gross:0,fees:entryFee,entryFees:entryFee,last:px,targetQty:end,trades:1};fee+=entryFee;notional+=OPEN_NOTIONAL;}
            else {reason='REVERSAL_OPEN_BLOCKED_MARGIN';s.ignored[coin]=true;}}
        }
      }
    }
    if(reason&&action==='SKIPPED')s.skipped++;
    if(action!=='SKIPPED'){s.fills++;s.gross+=realized;s.fees+=fee;s.cash+=realized-fee;s.turnover+=notional;}
    const record={id,at,coin,action,reason,price:px,source:'HYPERLIQUID_PUBLIC_FILL',target_before:start,target_after:end,virtual_delta:delta,notional,realized,fee,virtual_qty_after:s.positions[coin]?.qty||0,crossed:f.crossed??null};
    await this.log(s,id,at,coin,action,record);
  }
  private free(s:Session){let used=0,unreal=0;for(const p of Object.values(s.positions)){const mark=s.lastPrice[p.coin]||p.last||p.avg;used+=Math.abs(p.qty*mark)/LEVERAGE;unreal+=p.qty*(mark-p.avg);}return s.cash+unreal-used;}
  async poll(){const s=await this.get();if(!s?.active)return;await this.tables();try{
      const from=Math.max(s.started,s.cursor-2000);
      const fills:any=await info({type:'userFillsByTime',user:MC_WALLET,startTime:from,aggregateByTime:false});
      if(!Array.isArray(fills))throw Error('UNEXPECTED_FILLS_RESPONSE');
      if(fills.length>=1900)throw Error('FILL_PAGE_NEAR_LIMIT_MANUAL_AUDIT_REQUIRED');
      fills.sort((a:any,b:any)=>asNum(a.time)-asNum(b.time)||String(a.tid).localeCompare(String(b.tid)));
      for(const f of fills){await this.apply(s,f);s.cursor=Math.max(s.cursor,asNum(f.time));}
      const mids:any=await info({type:'allMids'});for(const [c,v] of Object.entries(mids||{}))s.lastPrice[c]=asNum(v);
      for(const p of Object.values(s.positions))p.last=s.lastPrice[p.coin]||p.last;
      s.lastPoll=Date.now();s.lastError=null;
    }catch(e){s.lastError=String(e);s.errors.push(new Date().toISOString()+' '+String(e));s.errors=s.errors.slice(-30);}
    await this.put(s);
  }
  async status(){const s=await this.get();if(!s)return{ok:true,configured:true,active:false,needs_start:true,wallet:MC_WALLET};
    let used=0,unreal=0;const positions=Object.values(s.positions).map(p=>{const mark=s.lastPrice[p.coin]||p.last||p.avg;const u=p.qty*(mark-p.avg);const margin=Math.abs(p.qty*mark)/LEVERAGE;used+=margin;unreal+=u;return{...p,direction:sign(p.qty)>0?'LONG':'SHORT',mark,unrealized:u,margin,notional:Math.abs(p.qty*mark),duration_ms:Date.now()-p.opened};});
    const equity=s.cash+unreal;return{ok:true,version:'MULTI-COIN TRADER WATCH V1',mode:'VIRTUAL_ONLY_NO_REAL_ORDERS',wallet:MC_WALLET,active:s.active,session_id:s.id,started_at:s.started,last_poll:s.lastPoll,last_error:s.lastError,initial_usd:s.initial,cash_usd:s.cash,equity_usd:equity,roi_pct:(equity/s.initial-1)*100,used_margin_usd:used,free_margin_usd:equity-used,unrealized_usd:unreal,realized_gross_usd:s.gross,fees_usd:s.fees,net_realized_usd:s.gross-s.fees,turnover_usd:s.turnover,open_positions:positions,open_count:positions.length,closed_count:s.closed,wins:s.wins,losses:s.losses,win_rate_pct:s.closed?s.wins/s.closed*100:0,processed_fills:s.fills,skipped_fills:s.skipped,ignored_inherited_coins:Object.keys(s.ignored),leverage:LEVERAGE,initial_margin_per_position:OPEN_MARGIN,initial_notional_per_position:OPEN_NOTIONAL,fee_assumptions:{maker:MAKER_FEE,taker:TAKER_FEE},limitations:['Virtual fill at target fill price; own order execution is not proven','Funding, liquidation, price slippage and exchange precision rules not modeled','On target position gaps, virtual exposure is closed using an estimated current mid; confirmed reversal may reopen at estimated mid; missing fills are not reconstructed','Perpetual market only; spot fills are not included']};}
  async events(limit:number){await this.tables();const s=await this.get();if(!s)return{ok:true,rows:[]};const r:any=await this.db.prepare('SELECT payload FROM mc_watch_events WHERE session_id=? ORDER BY at DESC LIMIT ?').bind(s.id,Math.max(1,Math.min(500,limit))).all();return{ok:true,rows:(r.results||[]).map((x:any)=>JSON.parse(x.payload))};}
  async closed(limit:number){await this.tables();const s=await this.get();if(!s)return{ok:true,rows:[]};const r:any=await this.db.prepare('SELECT coin,direction,opened,closed,entry,exit,gross,fees,net FROM mc_watch_closed WHERE session_id=? ORDER BY closed DESC LIMIT ?').bind(s.id,Math.max(1,Math.min(500,limit))).all();return{ok:true,rows:r.results||[]};}
  async route(path:string,method:string,url:URL){try{if(path==='/multi/start'&&method==='POST')return reply(await this.start());if(path==='/multi/stop'&&method==='POST')return reply(await this.stop());if(path==='/multi/new-session'&&method==='POST')return reply(await this.newSession());if(path==='/multi/status')return reply(await this.status());if(path==='/multi/events')return reply(await this.events(Number(url.searchParams.get('limit')||200)));if(path==='/multi/closed')return reply(await this.closed(Number(url.searchParams.get('limit')||200)));return reply({ok:false,error:'NOT_FOUND'},404);}catch(e){return reply({ok:false,error:String(e)},503);}}
}
