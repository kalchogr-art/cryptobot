// LIVE COPY SOURCE · MULTI-COIN WATCH — WEBSOCKET SINGLE-FILE BUILD
// Hyperliquid userFills WS is primary; HTTP backfill is recovery.
// The independent LIVE COPY CONTROLLER is NOT modified by this file.
// Generated from current MultiCoin Watch + Trader Watch modules.
namespace MultiCoinWatchNS {
// MULT.I-COIN TRADER WATCH V2 PRE-LIVE TEST — VIRTUAL ONLY, NO EXCHANGE ORDERS.
// V2 PRE-LIVE: $50 initial, $1.04 initial margin, 10x, no fixed position-count cap.
// V1.3.16 GAP durability and existing copy execution logic retained. Start a NEW SESSION to apply capital.
export const MC_WALLET='0x34fb5ec7d4e939161946340ea2a1f29254b893de';
const INFO='https://api.hyperliquid.xyz/info';
const INITIAL=50, LEVERAGE=10, OPEN_MARGIN=1.04, OPEN_NOTIONAL=OPEN_MARGIN*LEVERAGE;
const MAKER_FEE=.00015, TAKER_FEE=.00045, MIN_NOTIONAL=10, EPS=1e-10;
const PRELIVE_ORDER_MIN=10.40, COMPARE_OPEN_NOTIONAL=20; // conservative simulation threshold; actual exchange minimum is separate
const asNum=(x:any)=>Number(x)||0;
const sign=(x:number)=>Math.abs(x)<EPS?0:Math.sign(x);
const round=(x:number)=>Math.round(x*1e10)/1e10;
const reply=(v:any,status=200)=>new Response(JSON.stringify(v,null,2),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
type Position={coin:string;qty:number;avg:number;opened:number;gross:number;fees:number;entryFees:number;last:number;targetQty:number;trades:number};
type WatchOrder={oid:string;coin:string;side:string;limitPx:number;size:number;remaining:number;reduceOnly:boolean;orderType:string;firstSeen:number;lastSeen:number};
type MirrorOrder={oid:string;coin:string;side:string;px:number;targetSize:number;virtualSize:number;filledTarget:number;filledVirtual:number;status:string;seenAt:number;lastAt:number;scale:number;};
type MirrorPosition={coin:string;qty:number;avg:number;realized:number;fees:number;};
type MirrorFill={oid:string;coin:string;at:number;targetSize:number;virtualSize:number;px:number;crossed:boolean|null;};
type PreLivePosition={coin:string;qty:number;avg:number;targetAnchor:number;targetDesired:number;scale:number;opened:number;gross:number;fees:number;pendingSince:number|null;fills:number};
type PreLiveState={cash:number;positions:Record<string,PreLivePosition>;ignored:Record<string,boolean>;gross:number;fees:number;turnover:number;executed:number;deferredAdds:number;deferredReductions:number;blockedMargin:number;closed:number;wins:number;losses:number;delayMsTotal:number;delaySamples:number;events:number;};
function newPreLive():PreLiveState{return{cash:INITIAL,positions:{},ignored:{},gross:0,fees:0,turnover:0,executed:0,deferredAdds:0,deferredReductions:0,blockedMargin:0,closed:0,wins:0,losses:0,delayMsTotal:0,delaySamples:0,events:0};}
// Quantity precision is sourced from Hyperliquid metadata when available.
// Missing precision blocks shadow execution rather than pretending an order is valid.
type Session={preLive?:PreLiveState;preLive2?:PreLiveState;szDecimals?:Record<string,number>;id:string;active:boolean;started:number;cursor:number;cash:number;initial:number;positions:Record<string,Position>;baseline:Record<string,number>;ignored:Record<string,boolean>;lastPrice:Record<string,number>;fills:number;skipped:number;turnover:number;fees:number;gross:number;closed:number;wins:number;losses:number;errors:string[];lastPoll:number;lastError:string|null;orders?:Record<string,WatchOrder>;ordersLastPoll?:number;ordersLastError?:string|null;orderChanges?:number;accuracyEligible?:number;accuracyMatched?:number;accuracyGaps?:number;makerFills?:number;takerFills?:number;unknownFills?:number;mirrorOrders?:Record<string,MirrorOrder>;mirrorMatches?:number;mirrorUnmatched?:number;mirrorFills?:MirrorFill[];mirrorScale?:Record<string,number>;mirrorPositions?:Record<string,MirrorPosition>;mirrorRealized?:number;mirrorFees?:number;gapPending?:Record<string,{tradeId:string;fillId:string;at:number;coin:string;price:number;position:Position;record:any}>;wsAnchors?:Record<string,number>;wsLastAt?:Record<string,number>;};
function fresh():Session{return{id:'MC-'+Date.now(),active:false,started:Date.now(),cursor:Date.now(),cash:INITIAL,initial:INITIAL,positions:{},baseline:{},ignored:{},lastPrice:{},fills:0,skipped:0,turnover:0,fees:0,gross:0,closed:0,wins:0,losses:0,errors:[],lastPoll:0,lastError:null,orders:{},ordersLastPoll:0,ordersLastError:null,orderChanges:0,accuracyEligible:0,accuracyMatched:0,accuracyGaps:0,makerFills:0,takerFills:0,unknownFills:0,mirrorOrders:{},mirrorMatches:0,mirrorUnmatched:0,mirrorFills:[],mirrorScale:{},mirrorPositions:{},mirrorRealized:0,mirrorFees:0,preLive:newPreLive(),preLive2:newPreLive(),szDecimals:{},wsAnchors:{},wsLastAt:{}};}
async function info(body:any){const r=await fetch(INFO,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('HL_HTTP_'+r.status);return r.json() as Promise<any>;}
const inFlightPolls=new WeakMap<object,Promise<void>>();
// Serialize realtime WS, recovery and scheduled polling for the same Durable Object.
// Never drop a WS batch because an API audit is already in flight.
function sequenceMulti<T>(storage:object, job:()=>Promise<T>):Promise<T>{
  const previous=inFlightPolls.get(storage)||Promise.resolve();
  const result=previous.catch(()=>{}).then(job);
  const tail=result.then(()=>{},()=>{});
  inFlightPolls.set(storage,tail);
  void tail.then(()=>{if(inFlightPolls.get(storage)===tail)inFlightPolls.delete(storage);});
  return result;
}
const wsFid=(f:any)=>String(f.coin||'')+':'+String(f.tid??f.hash??'')+':'+String(f.hash||'');
const sourceMatches=(a:number,b:number)=>Math.abs(a-b)<=Math.max(1e-7,Math.max(Math.abs(a),Math.abs(b))*0.00001);

export class MultiCoinEngine {
  constructor(private storage:any,private db:any){}
  async get():Promise<Session|null>{return (await this.storage.get('multiCoinV1'))||null;}
  async put(s:Session){
    // Bound only stale, unconfirmed mirror-order snapshots. These are audit observations,
    // NOT virtual positions or fills. Never evict pending/partially filled orders.
    const entries=Object.entries(s.mirrorOrders||{});
    if(entries.length>500){
      const removable=entries.filter(([,o])=>o.status==='DISAPPEARED_UNCONFIRMED')
        .sort((a,b)=>a[1].lastAt-b[1].lastAt);
      const count=Math.min(entries.length-500,removable.length);
      for(let i=0;i<count;i++)delete s.mirrorOrders![removable[i][0]];
    }
    if((s.mirrorFills?.length||0)>300)s.mirrorFills=s.mirrorFills!.slice(-300);
    await this.storage.put('multiCoinV1',s);
  }
  async tables(){if(!this.db)throw Error('D1_BINDING_MISSING');
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_events (session_id TEXT NOT NULL, fill_id TEXT NOT NULL, at INTEGER NOT NULL, coin TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,fill_id))`).run();
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS mc_watch_events_at ON mc_watch_events(session_id,at DESC)`).run();
    // Durable raw WebSocket inbox. An entry is removed only after the established
    // D1 event and Durable Object checkpoint succeed. No orders are created here.
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_ws_inbox (session_id TEXT NOT NULL, fill_id TEXT NOT NULL, at INTEGER NOT NULL, coin TEXT NOT NULL, payload TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(session_id,fill_id))`).run();
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS mc_watch_ws_inbox_at ON mc_watch_ws_inbox(session_id,at)`).run();
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_ws_quarantine (session_id TEXT NOT NULL, fill_id TEXT NOT NULL, at INTEGER NOT NULL, coin TEXT NOT NULL, reason TEXT NOT NULL, payload TEXT NOT NULL, quarantined_at INTEGER NOT NULL, PRIMARY KEY(session_id,fill_id))`).run();
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_closed (session_id TEXT NOT NULL, trade_id TEXT NOT NULL, coin TEXT NOT NULL, direction TEXT NOT NULL, opened INTEGER NOT NULL, closed INTEGER NOT NULL, entry REAL NOT NULL, exit REAL NOT NULL, gross REAL NOT NULL, fees REAL NOT NULL, net REAL NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,trade_id))`).run();
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_order_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER NOT NULL, oid TEXT NOT NULL, coin TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,event_id))`).run();
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS mc_watch_order_events_at ON mc_watch_order_events(session_id,at DESC)`).run();
    // Independent, durable stream for the SOURCE order lifecycle. The fill
    // table remains authoritative for filled positions and virtual statistics.
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_copy_order_updates (
      session_id TEXT NOT NULL, event_id TEXT NOT NULL, source_oid TEXT NOT NULL,
      at INTEGER NOT NULL, coin TEXT NOT NULL, status TEXT NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY(session_id,event_id))`).run();
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS mc_copy_order_updates_cursor
      ON mc_copy_order_updates(session_id,at)`).run();
    // Independent source fill evidence keyed by the exchange order OID.
    // Works even when the virtual fill-position chain is temporarily behind.
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_copy_source_order_fills (
      session_id TEXT NOT NULL, fill_id TEXT NOT NULL, source_oid TEXT NOT NULL,
      at INTEGER NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL,
      sz REAL NOT NULL, px REAL NOT NULL,
      PRIMARY KEY(session_id,fill_id))`).run();
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS mc_copy_source_order_fills_oid
      ON mc_copy_source_order_fills(session_id,source_oid)`).run();
  }
  // Persist original order status, including open, partial, filled and canceled.
  // The controller receives only immutable observations, NOT trading commands.
  async ingestOrderUpdates(message:any):Promise<number>{
    await this.tables();
    const s=await this.get();if(!s?.active)return 0;
    const rows=Array.isArray(message)?message:Array.isArray(message?.orders)?message.orders:[];
    let added=0;
    for(const item of rows){
      const o=item?.order||item;
      const oid=String(o?.oid??'');
      const coin=String(o?.coin||'').toUpperCase();
      const status=String(item?.status||'').toLowerCase();
      const at=Number(item?.statusTimestamp||o?.timestamp||0);
      // Skip reconnect history and malformed/unsupported objects. Do NOT turn
      // missing order data into a real order with guessed parameters.
      if(!/^\d+$/.test(oid)||!/^[A-Z0-9]{2,20}$/.test(coin)||
         !/^[a-z][a-z0-9_]*$/.test(status)||!Number.isFinite(at)||
         at<s.started||at>Date.now()+30000)continue;
      const side=String(o?.side||'');
      const price=Number(o?.limitPx),origSz=Number(o?.origSz),sz=Number(o?.sz);
      if(!['A','B'].includes(side)||!Number.isFinite(price)||price<=0||
         !Number.isFinite(origSz)||origSz<=0||!Number.isFinite(sz)||sz<0)continue;
      const tif=String(o?.tif||'');
      const kind=String(o?.orderType||'');
      // A missing TIF is preserved as missing; the executor must refuse to infer it.
      const eventId=[oid,at,status,sz,price,side].join(':');
      const payload={source_oid:oid,coin,at,status,side,price,orig_sz:origSz,
        remaining_sz:sz,tif,order_type:kind,reduce_only:o?.reduceOnly===true,
        is_trigger:o?.isTrigger===true,source_order_time:Number(o?.timestamp||0),
        source_cloid:typeof o?.cloid==='string'?o.cloid:null,
        observed_at:Date.now(),channel:'orderUpdates'};
      const r=await this.db.prepare(`INSERT OR IGNORE INTO mc_copy_order_updates
        (session_id,event_id,source_oid,at,coin,status,payload)
        VALUES (?,?,?,?,?,?,?)`).bind(s.id,eventId,oid,at,coin,status,JSON.stringify(payload)).run();
      added+=Number(r?.meta?.changes||0)>0?1:0;
    }
    return added;
  }

  private async recordSourceOrderFills(session:string,fills:any[]):Promise<number>{
    let added=0;
    for(const f of fills){
      const oid=String(f?.oid??''),coin=String(f?.coin||'').toUpperCase();
      const at=Number(f?.time),sz=Number(f?.sz),px=Number(f?.px),side=String(f?.side||'');
      if(!/^\d+$/.test(oid)||!/^[A-Z0-9]{2,20}$/.test(coin)||!['A','B'].includes(side)||
          !Number.isFinite(at)||!Number.isFinite(sz)||sz<=0||!Number.isFinite(px)||px<=0||
          f?.tid==null)continue;
      const id=wsFid(f);
      const r:any=await this.db.prepare(`INSERT OR IGNORE INTO mc_copy_source_order_fills
        (session_id,fill_id,source_oid,at,coin,side,sz,px) VALUES(?,?,?,?,?,?,?,?)`)
        .bind(session,id,oid,at,coin,side,sz,px).run();
      if(Number(r?.meta?.changes||0)>0)added++;
    }
    return added;
  }

  // Order-to-fill audit is deliberately separate from the existing virtual P/L engine.
  // A target fill proves the TARGET order executed, not that our hypothetical maker order did.
  private async mirrorObserve(s:Session, raw:any[], now:number){
    s.mirrorOrders ||= {}; s.mirrorScale ||= {};
    const active=new Set<string>();
    for(const o of raw){
      const oid=String(o.oid??''); const coin=String(o.coin??'');
      const px=asNum(o.limitPx),sz=asNum(o.sz);
      if(!oid||!coin||px<=0||sz<=0)continue;
      active.add(oid);
      const old=s.mirrorOrders[oid];
      // Derive a reference ratio from the first observed position, otherwise use $100/target notional.
      // This is an observation baseline, not a claim of exact trader account equity scaling.
      let scale=s.mirrorScale[coin];
      if(!scale){
        const target=asNum(s.baseline[coin])||asNum(s.positions[coin]?.targetQty);
        scale=Math.abs(target)>EPS?OPEN_NOTIONAL/(Math.abs(target)*px):OPEN_NOTIONAL/(sz*px);
        s.mirrorScale[coin]=scale;
      }
      const virtualSize=round(sz*scale);
      if(!old){s.mirrorOrders[oid]={oid,coin,side:String(o.side||''),px,targetSize:sz,virtualSize,filledTarget:0,filledVirtual:0,status:'PENDING',seenAt:now,lastAt:now,scale};}
      else {old.px=px;old.targetSize=sz;old.virtualSize=round(sz*old.scale);old.lastAt=now;if(old.status==='DISAPPEARED_UNCONFIRMED')old.status='PENDING';}
    }
    for(const o of Object.values(s.mirrorOrders))if(o.status==='PENDING'&&!active.has(o.oid))o.status='DISAPPEARED_UNCONFIRMED';
  }
  private async mirrorFill(s:Session,f:any){
    const oid=String(f.oid??'');if(!oid)return;
    const m=s.mirrorOrders?.[oid];
    if(!m){s.mirrorUnmatched=(s.mirrorUnmatched||0)+1;return;}
    const sz=asNum(f.sz),px=asNum(f.px),at=asNum(f.time);
    if(sz<=0||px<=0)return;
    const v=round(sz*m.scale);
    m.filledTarget+=sz;m.filledVirtual=round(m.filledVirtual+v);m.lastAt=at;
    m.status=m.filledTarget+1e-8>=m.targetSize?'TARGET_FILLED':'TARGET_PARTIAL_FILL';
    // Separate theoretical target-linked virtual ledger. Never modifies the original copy ledger.
    s.mirrorPositions ||= {};
    const signed=String(f.side)==='B'?v:-v;
    const old=s.mirrorPositions[m.coin]||{coin:m.coin,qty:0,avg:0,realized:0,fees:0};
    const prior=old.qty;
    const fee=Math.abs(v*px)*(f.crossed===true?TAKER_FEE:MAKER_FEE);
    old.fees+=fee;s.mirrorFees=(s.mirrorFees||0)+fee;
    if(sign(prior)===0||sign(prior)===sign(signed)){
      const next=prior+signed;
      old.avg=(Math.abs(prior)*old.avg+Math.abs(signed)*px)/Math.abs(next);
      old.qty=round(next);
    }else{
      const closing=Math.min(Math.abs(prior),Math.abs(signed));
      const pnl=closing*(px-old.avg)*sign(prior);
      old.realized+=pnl;s.mirrorRealized=(s.mirrorRealized||0)+pnl;
      old.qty=round(prior+signed);
      if(sign(old.qty)!==sign(prior))old.avg=sign(old.qty)===0?0:px;
    }
    s.mirrorPositions[m.coin]=old;
    s.mirrorMatches=(s.mirrorMatches||0)+1;
    (s.mirrorFills ||= []).push({oid,coin:m.coin,at,targetSize:sz,virtualSize:v,px,crossed:typeof f.crossed==='boolean'?f.crossed:null});
    s.mirrorFills=s.mirrorFills.slice(-300);
  }
  async mirrorStatus(limit=100){const s=await this.get();if(!s)return{ok:true,active:[],fills:[]};
    const all=Object.values(s.mirrorOrders||{});
    return{ok:true,mode:'TARGET_ORDER_MIRROR_AUDIT_ONLY',session_id:s.id,orders:all.slice(-Math.max(1,Math.min(limit,500))),theoretical_realized_gross:s.mirrorRealized||0,theoretical_fees:s.mirrorFees||0,theoretical_realized_net:(s.mirrorRealized||0)-(s.mirrorFees||0),theoretical_positions:Object.values(s.mirrorPositions||{}),matched_target_fills:s.mirrorMatches||0,unmatched_target_fills:s.mirrorUnmatched||0,linked_fills:(s.mirrorFills||[]).slice(-Math.max(1,Math.min(limit,300))),note:'Theoretical P/L uses matched TARGET fills, not proven virtual maker fills. Unobserved orders are excluded; latency, queue, funding and slippage are not modeled.'};
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
  // GAP-only write-ahead recovery. DO is checkpointed BEFORE D1; a pending
  // closure is replayed idempotently after a failure without changing cash twice.
  private async flushGapPending(s:Session){
    for(const [key,p] of Object.entries(s.gapPending||{})){
      const pos=p.position,net=pos.gross-pos.fees;
      const row={...pos,closed:p.at,exit:p.price,net,direction:sign(pos.qty)>=0?'LONG':'SHORT'};
      await this.db.prepare(`INSERT OR IGNORE INTO mc_watch_closed(session_id,trade_id,coin,direction,opened,closed,entry,exit,gross,fees,net,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(s.id,p.tradeId,p.coin,row.direction,pos.opened,p.at,pos.avg,p.price,pos.gross,pos.fees,net,JSON.stringify(row)).run();
      await this.log(s,p.fillId,p.at,p.coin,'GAP_CLOSE',p.record);
      delete s.gapPending![key];
      await this.put(s);
    }
  }
  // Legacy V1.3.14: a committed D1 GAP close may still be open in DO.
  // Remove only an EXACT matching trade generation; old totals are not
  // guessed or adjusted because their commit status cannot be established.
  private async reconcileLegacyGap(s:Session){
    let changed=false;
    for(const [coin,pos] of Object.entries(s.positions)){
      const key='GAP:'+coin+':'+String(pos.opened);
      const row:any=await this.db.prepare('SELECT trade_id FROM mc_watch_closed WHERE session_id=? AND trade_id=?').bind(s.id,key).first();
      if(!row)continue;
      delete s.positions[coin];changed=true;
      s.errors.push(new Date().toISOString()+' LEGACY_GAP_STATE_REPAIRED '+coin+' opened='+pos.opened+' accounting_not_replayed');
      s.errors=s.errors.slice(-30);
    }
    if(changed)await this.put(s);
  }
  private async watchOrders(s:Session){
    // Polling snapshots do not reveal every intermediate cancel/replace or prove a fill.
    const now=Date.now();
    try{
      const raw:any=await info({type:'openOrders',user:MC_WALLET});
      if(!Array.isArray(raw))throw Error('OPEN_ORDERS_UNEXPECTED_RESPONSE');
      const previous=s.orders||{};const next:Record<string,WatchOrder>={};
      for(const o of raw){
        const oid=String(o.oid??'');const coin=String(o.coin??'');
        if(!oid||!coin)continue;
        const old=previous[oid];
        const item:WatchOrder={oid,coin,side:String(o.side||''),limitPx:asNum(o.limitPx),size:asNum(o.sz),remaining:asNum(o.sz),reduceOnly:Boolean(o.reduceOnly),orderType:String(o.orderType||''),firstSeen:old?.firstSeen||now,lastSeen:now};
        next[oid]=item;
        let action='';
        if(!old)action='ORDER_SEEN';
        else if(old.limitPx!==item.limitPx||old.size!==item.size||old.side!==item.side||old.reduceOnly!==item.reduceOnly)action='ORDER_CHANGED';
        if(action)await this.orderLog(s,oid,coin,action,now,{...item,previous:old||null});
      }
      for(const [oid,old] of Object.entries(previous))if(!next[oid]){
        // Absence alone cannot distinguish cancellation from full fill.
        await this.orderLog(s,oid,old.coin,'ORDER_DISAPPEARED',now,{...old,reason:'UNKNOWN_CANCEL_OR_FILL'});
      }
      await this.mirrorObserve(s,raw,now);
      s.orders=next;s.ordersLastPoll=now;s.ordersLastError=null;
    }catch(e){s.ordersLastError=String(e);throw e;}
  }
  private async orderLog(s:Session,oid:string,coin:string,action:string,at:number,details:any){
    const eventId=oid+':'+action+':'+at;
    await this.db.prepare(`INSERT OR IGNORE INTO mc_watch_order_events(session_id,event_id,at,oid,coin,action,payload) VALUES(?,?,?,?,?,?,?)`).bind(s.id,eventId,at,oid,coin,action,JSON.stringify({at,oid,coin,action,...details})).run();
    s.orderChanges=(s.orderChanges||0)+1;
  }
  async orders(limit:number){await this.tables();const s=await this.get();if(!s)return{ok:true,active:[],history:[]};
    const r:any=await this.db.prepare('SELECT payload FROM mc_watch_order_events WHERE session_id=? ORDER BY at DESC LIMIT ?').bind(s.id,Math.max(1,Math.min(300,limit))).all();
    return{ok:true,as_of:s.ordersLastPoll||0,last_error:s.ordersLastError||null,active:Object.values(s.orders||{}),history:(r.results||[]).map((x:any)=>JSON.parse(x.payload)),note:'Snapshot-only: disappearance does not prove fill; no virtual orders are submitted.'};
  }
  // Independent, virtual-only executable-size shadow ledger.
  // Uses TARGET before/after snapshots; never sums stale raw ADD deltas.
  private preLiveFill(s:Session,coin:string,start:number,end:number,px:number,at:number,crossed:any,baselineAction:string,v:PreLiveState=s.preLive||(s.preLive=newPreLive()),openNotional:number=OPEN_NOTIONAL){
    v.events++;
    const decimals=s.szDecimals?.[coin];
    if(decimals===undefined)return; // metadata not yet verified; no fake execution
    const step=Math.pow(10,-decimals);
    const floorQty=(q:number)=>Math.floor(Math.max(0,q)/step+1e-8)*step;
    const feeRate=crossed===true?TAKER_FEE:MAKER_FEE;
    let p=v.positions[coin];
    if(!p){
      if(v.ignored[coin]){
        if(sign(end)===0){delete v.ignored[coin];return;}
        const increase=sign(start)===sign(end)&&sign(end)!==0&&Math.abs(end)>Math.abs(start)+EPS;
        const flip=sign(end)!==0&&sign(start)!==sign(end);
        if(!increase&&!flip)return;
      }else if(sign(start)!==0&&baselineAction!=='OPEN'){v.ignored[coin]=true;return;}
      if(sign(end)===0)return;
      const qty=Math.ceil(openNotional/px/step-1e-8)*step;
      const usd=qty*px;
      const free=this.preLiveFree(s,v);
      if(usd+EPS<MIN_NOTIONAL||usd+EPS<PRELIVE_ORDER_MIN||free+EPS<usd/LEVERAGE){v.blockedMargin++;v.ignored[coin]=true;return;}
      const signed=sign(end)*qty,fee=usd*feeRate;
      v.cash-=fee;v.fees+=fee;v.turnover+=usd;v.executed++;
      v.positions[coin]={coin,qty:signed,avg:px,targetAnchor:end,targetDesired:signed,scale:qty/Math.abs(end),opened:at,gross:0,fees:fee,pendingSince:null,fills:1};
      delete v.ignored[coin];return;
    }
    // Gaps cannot be interpreted as reliable increases; quarantine the coin.
    if(Math.abs(start-p.targetAnchor)>Math.max(1e-7,Math.abs(start)*.00001)){
      v.ignored[coin]=true;return;
    }
    // Full close or reversal always takes precedence over accumulated changes.
    if(sign(end)===0||sign(end)!==sign(start)){
      const usd=Math.abs(p.qty*px),gross=p.qty*(px-p.avg),fee=usd*feeRate;
      v.cash+=gross-fee;v.gross+=gross;v.fees+=fee;v.turnover+=usd;v.executed++;
      const net=p.gross+gross-p.fees-fee;v.closed++;if(net>0)v.wins++;else v.losses++;
      delete v.positions[coin];delete v.ignored[coin];
      if(sign(end)!==0)this.preLiveFill(s,coin,0,end,px,at,crossed,'OPEN',v,openNotional);
      return;
    }
    // Target desired exposure is anchored to initial copied position and target size.
    // The target can reduce before pending ADD is executable; pending cancels automatically.
    p.targetDesired=round(end*p.scale);
    p.targetAnchor=end;
    const wanted=p.targetDesired;
    const diff=wanted-p.qty;
    const increasing=sign(diff)===sign(p.qty)&&Math.abs(wanted)>Math.abs(p.qty);
    const qty=floorQty(Math.abs(diff));const usd=qty*px;
    if(qty<EPS||usd+EPS<PRELIVE_ORDER_MIN||usd+EPS<MIN_NOTIONAL){
      if(Math.abs(diff)>EPS){if(p.pendingSince===null)p.pendingSince=at;if(increasing)v.deferredAdds++;else v.deferredReductions++;}
      else p.pendingSince=null;
      return;
    }
    if(increasing){
      if(this.preLiveFree(s,v)+EPS<usd/LEVERAGE){v.blockedMargin++;return;}
      const signed=sign(p.qty)*qty,fee=usd*feeRate;
      p.avg=(Math.abs(p.qty)*p.avg+qty*px)/(Math.abs(p.qty)+qty);
      p.qty=round(p.qty+signed);p.fees+=fee;v.cash-=fee;v.fees+=fee;
    }else{
      const closeQty=Math.min(qty,Math.max(0,Math.abs(p.qty)-step));if(closeQty<EPS){v.deferredReductions++;return;}const realized=closeQty*(px-p.avg)*sign(p.qty),fee=closeQty*px*feeRate;
      p.qty=round(p.qty-sign(p.qty)*closeQty);p.gross+=realized;p.fees+=fee;
      v.cash+=realized-fee;v.gross+=realized;v.fees+=fee;
    }
    v.turnover+=increasing?usd:Math.min(qty,Math.max(0,Math.abs(p.qty)+qty))*px;v.executed++;p.fills++;
    if(p.pendingSince!==null){v.delayMsTotal+=Math.max(0,at-p.pendingSince);v.delaySamples++;}p.pendingSince=null;
  }
  private preLiveFree(s:Session,v:PreLiveState){let used=0,unreal=0;for(const p of Object.values(v.positions)){const mark=s.lastPrice[p.coin]||p.avg;used+=Math.abs(p.qty*mark)/LEVERAGE;unreal+=p.qty*(mark-p.avg);}return v.cash+unreal-used;}
  private async apply(s:Session,f:any,recovery=false){const coin=String(f.coin||'');const at=asNum(f.time),px=asNum(f.px),size=asNum(f.sz),start=asNum(f.startPosition);
    const id=coin+':'+String(f.tid??f.hash??'')+':'+String(f.hash||'')+(recovery?':VERIFIED_RECOVERY':'');if(!coin||!at||!px||!size||!['A','B'].includes(f.side))return;
    const signed=f.side==='B'?size:-size,end=round(start+signed),pos=s.positions[coin];
    const exists:any=await this.db.prepare('SELECT 1 AS yes FROM mc_watch_events WHERE session_id=? AND fill_id=?').bind(s.id,id).first();if(exists)return;
    if(!recovery)await this.mirrorFill(s,f);
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
        // GAP: close ONLY the current virtual position, at this observed fill price.
        // The stable trade key prevents a second close for the same position.
        const closeKey='GAP:'+coin+':'+String(pos.opened);
        const closedAlready:any=await this.db.prepare('SELECT 1 AS yes FROM mc_watch_closed WHERE session_id=? AND trade_id=?').bind(s.id,closeKey).first();
        if(closedAlready){
          // Recover from stale DO state after a previously committed D1 close.
          // No second accounting entry. Keep original OPEN logic untouched.
          delete s.positions[coin];
          action='SKIPPED';reason='GAP_ALREADY_CLOSED';
        }else{
          action='GAP_CLOSE';reason='TARGET_POSITION_GAP_VIRTUAL_EXIT';
          delta=-before;notional=Math.abs(before*px);
          realized=before*(px-pos.avg);
          fee=notional*(f.crossed===true?TAKER_FEE:MAKER_FEE);
          const closing={...pos,qty:before,gross:pos.gross+realized,fees:pos.fees+fee,trades:pos.trades+1};
          // Account once in memory, then checkpoint DO before any D1 write.
          // The pending closure is a durable replayable D1 outbox.
          const net=closing.gross-closing.fees;
          s.closed++;if(net>0)s.wins++;else s.losses++;
          delete s.positions[coin];
          (s.gapPending ||= {})[closeKey]={tradeId:closeKey,fillId:id,at,coin,price:px,position:closing,record:null};
          s.errors.push(new Date(at).toISOString()+' GAP_CLOSE '+coin+' expected='+pos.targetQty+' observed='+start+' price='+px);
          s.errors=s.errors.slice(-30);
        }
        // Persist the closure and its accounting before processing another fill.
        // OPEN / ADD / PARTIAL_CLOSE / REVERSAL branches are not modified.
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
          await this.close(s,{...pos,qty:before,targetQty:start},at,px,id);delete s.positions[coin];
          if(action==='REVERSAL'){const newQty=sign(end)*OPEN_NOTIONAL/px;const margin=OPEN_MARGIN;
            if(this.free(s)>=margin){const entryFee=OPEN_NOTIONAL*(f.crossed===true?TAKER_FEE:MAKER_FEE);s.positions[coin]={coin,qty:newQty,avg:px,opened:at,gross:0,fees:entryFee,entryFees:entryFee,last:px,targetQty:end,trades:1};fee+=entryFee;notional+=OPEN_NOTIONAL;}
            else {reason='REVERSAL_OPEN_BLOCKED_MARGIN';s.ignored[coin]=true;}}
        }
      }
    }
    if(reason&&action==='SKIPPED')s.skipped++;
    // Accuracy measures whether an actionable target fill was mirrored, not order execution realism.
    const eligible=!['INHERITED_TARGET_POSITION','TARGET_BASELINE_FLATTENED','UNTRACKED_POSITION_STARTED_BEFORE_SESSION','FLAT_FILL'].includes(reason);
    if(eligible){s.accuracyEligible=(s.accuracyEligible||0)+1;if(action!=='SKIPPED'&&action!=='RESYNC_CLOSE'&&action!=='RESYNC_REVERSAL')s.accuracyMatched=(s.accuracyMatched||0)+1;}
    if(reason.startsWith('TARGET_POSITION_GAP'))s.accuracyGaps=(s.accuracyGaps||0)+1;
    if(action!=='SKIPPED'){if(f.crossed===true)s.takerFills=(s.takerFills||0)+1;else if(f.crossed===false)s.makerFills=(s.makerFills||0)+1;else s.unknownFills=(s.unknownFills||0)+1;}
    if(action!=='SKIPPED'){s.fills++;s.gross+=realized;s.fees+=fee;s.cash+=realized-fee;s.turnover+=notional;}
    if(!recovery){
      this.preLiveFill(s,coin,start,end,px,at,f.crossed,action);
      // Second independent virtual ledger, same target fills, $20 initial notional.
      this.preLiveFill(s,coin,start,end,px,at,f.crossed,action,s.preLive2||(s.preLive2=newPreLive()),COMPARE_OPEN_NOTIONAL);
    }
    const record={id,at,coin,action,reason,price:px,recovered_from_verified_skipped_fill:recovery,source:'HYPERLIQUID_PUBLIC_FILL',target_before:start,target_after:end,virtual_delta:delta,notional,realized,fee,virtual_qty_after:s.positions[coin]?.qty||0,crossed:f.crossed??null};
    if(action==='GAP_CLOSE'){
      const key='GAP:'+coin+':'+String(pos!.opened);
      s.gapPending![key].record=record;
      await this.put(s); // atomic DO checkpoint: position gone AND P/L applied once
      await this.flushGapPending(s); // D1 writes are idempotent; replay on next poll
    }else await this.log(s,id,at,coin,action,record);
  }
  private free(s:Session){let used=0,unreal=0;for(const p of Object.values(s.positions)){const mark=s.lastPrice[p.coin]||p.last||p.avg;used+=Math.abs(p.qty*mark)/LEVERAGE;unreal+=p.qty*(mark-p.avg);}return s.cash+unreal-used;}
  // A GAP HOLD row is an actual recorded target fill, not an invented trade.
  // Recover ONLY the provably contiguous prefix from the current target anchor.
  // Keep the original SKIPPED audit rows intact; a recovered event gets its own ID.
  // Never force a resync across an unverified missing fill.
  private async recoverVerifiedSkipped(s:Session){
    const rows:any=await this.db.prepare(`SELECT fill_id,payload FROM mc_watch_events WHERE session_id=? AND action='SKIPPED' AND json_extract(payload,'$.reason')='TARGET_POSITION_GAP_HELD_FOR_AUDIT' ORDER BY at ASC LIMIT 1500`).bind(s.id).all();
    const byCoin=new Map<string,any[]>();
    for(const r of rows.results||[]){
      const e=JSON.parse(r.payload);const coin=String(e.coin||'');
      if(!s.positions[coin]||!Number.isFinite(Number(e.target_before))||!Number.isFinite(Number(e.target_after)))continue;
      if(!byCoin.has(coin))byCoin.set(coin,[]);
      byCoin.get(coin)!.push({row:r,event:e});
    }
    for(const [coin,items] of byCoin){
      let anchor=s.positions[coin]?.targetQty;
      if(anchor===undefined)continue;
      const remaining=[...items];
      while(remaining.length){
        const index=remaining.findIndex(({event:e})=>Math.abs(Number(e.target_before)-anchor!)<=Math.max(1e-7,Math.abs(anchor!)*.00001));
        if(index<0)break;
        const {row,event:e}=remaining.splice(index,1)[0];
        const recoveredId=row.fill_id+':VERIFIED_RECOVERY';
        const exists:any=await this.db.prepare('SELECT 1 AS yes FROM mc_watch_events WHERE session_id=? AND fill_id=?').bind(s.id,recoveredId).first();
        if(exists){anchor=Number(e.target_after);continue;}
        const signed=Number(e.target_after)-Number(e.target_before);
        if(Math.abs(signed)<EPS||!Number.isFinite(signed)||Number(e.price)<=0)break;
        const parts=String(row.fill_id).split(':');
        const fill={coin,time:Number(e.at),px:Number(e.price),sz:Math.abs(signed),startPosition:Number(e.target_before),side:signed>0?'B':'A',tid:parts[1],hash:parts.slice(2).join(':'),crossed:e.crossed};
        await this.apply(s,fill,true);
        anchor=s.positions[coin]?.targetQty;
        if(anchor===undefined)break;
      }
    }
  }
  async poll(){return sequenceMulti(this.storage,()=>this.pollCore());}
  // Receive the exact WebSocket userFills payload. Durable write first, then
  // consume provably connected target-position transitions. No extra /info
  // request is needed in the fast path. Idempotent with the HTTP backfill.
  async ingestRealtime(fills:any[]):Promise<{received:number;stored:number;applied:number;pending:number}>{
    return sequenceMulti(this.storage,async()=>{
      const s=await this.get();if(!s?.active)return{received:fills.length,stored:0,applied:0,pending:0};
      await this.tables();let stored=0;
      // Persist source fills independently of virtual target-position ordering.
      const newOrderFills=await this.recordSourceOrderFills(s.id,fills);
      for(const f of fills){
        if(!f||typeof f!=='object')continue;
        const coin=String(f.coin||''),at=Number(f.time),sz=Number(f.sz),px=Number(f.px),start=Number(f.startPosition);
        if(!coin||!Number.isFinite(at)||at<s.started||at>Date.now()+30000||!Number.isFinite(sz)||sz<=0||!Number.isFinite(px)||px<=0||!Number.isFinite(start)||!['A','B'].includes(f.side)||f.tid==null)continue;
        const id=wsFid(f);
        const result:any=await this.db.prepare(`INSERT OR IGNORE INTO mc_watch_ws_inbox(session_id,fill_id,at,coin,payload,received_at) VALUES(?,?,?,?,?,?)`).bind(s.id,id,at,coin,JSON.stringify(f),Date.now()).run();
        if(Number(result?.meta?.changes||0)>0)stored++;
      }
      const applied=await this.drainRealtimeInbox(s);
      const count:any=await this.db.prepare(`SELECT COUNT(*) AS n FROM mc_watch_ws_inbox WHERE session_id=?`).bind(s.id).first();
      return{received:fills.length,stored:Math.max(stored,newOrderFills),applied,pending:Number(count?.n||0)};
    });
  }
  async drainRealtime():Promise<number>{return sequenceMulti(this.storage,async()=>{
    const s=await this.get();if(!s?.active)return 0;await this.tables();return this.drainRealtimeInbox(s);
  });}
  private async drainRealtimeInbox(s:Session):Promise<number>{
    s.wsAnchors ||= {};s.wsLastAt ||= {};
    let applied=0;
    const rows:any=await this.db.prepare(`SELECT rowid,fill_id,coin,at,payload FROM mc_watch_ws_inbox WHERE session_id=? ORDER BY at,rowid LIMIT 600`).bind(s.id).all();
    const grouped=new Map<string,any[]>();
    for(const r of rows.results||[]){if(!grouped.has(r.coin))grouped.set(r.coin,[]);grouped.get(r.coin)!.push({...r,fill:JSON.parse(r.payload)});}
    // Coins are independent. A missing predecessor in ZEC never stops ETH.
    for(const [coin,items] of grouped){
      if(s.wsAnchors[coin]===undefined){
        const last:any=await this.db.prepare(`SELECT payload FROM mc_watch_events WHERE session_id=? AND coin=? ORDER BY at DESC,rowid DESC LIMIT 1`).bind(s.id,coin).first();
        const prev=last?.payload?JSON.parse(last.payload):null;
        const persisted=Number(prev?.target_after);
        s.wsAnchors[coin]=prev&&Number.isFinite(persisted)?persisted:(s.positions[coin]?.targetQty??s.baseline[coin]??0);
        s.wsLastAt[coin]=Number(prev?.at)||0;
      }
      let anchor=s.wsAnchors[coin];
      const rest=[...items];
      while(rest.length){
        // Idempotence against fills already handled by the HTTP catch-up.
        for(let i=rest.length-1;i>=0;i--){
          const r=rest[i];const exists:any=await this.db.prepare(`SELECT 1 AS yes FROM mc_watch_events WHERE session_id=? AND fill_id=?`).bind(s.id,r.fill_id).first();
          if(exists){await this.db.prepare(`DELETE FROM mc_watch_ws_inbox WHERE session_id=? AND fill_id=?`).bind(s.id,r.fill_id).run();rest.splice(i,1);continue;}
          // A reconnect snapshot may contain previously unseen OLD fills.
          // They must never execute late or grow the active inbox forever.
          if(Number(r.at)<Number(s.wsLastAt[coin]||0)-1000){
            await this.db.prepare(`INSERT OR IGNORE INTO mc_watch_ws_quarantine(session_id,fill_id,at,coin,reason,payload,quarantined_at) VALUES(?,?,?,?,?,?,?)`).bind(s.id,r.fill_id,r.at,coin,'HISTORICAL_AFTER_NEWER_POSITION',r.payload,Date.now()).run();
            await this.db.prepare(`DELETE FROM mc_watch_ws_inbox WHERE session_id=? AND fill_id=?`).bind(s.id,r.fill_id).run();rest.splice(i,1);
          }
        }
        if(!rest.length)break;
        const eligible=rest.filter(r=>sourceMatches(Number(r.fill.startPosition),anchor));
        if(!eligible.length)break; // Keep raw data for audit/backfill, never guess.
        eligible.sort((a,b)=>Number(a.at)-Number(b.at)||Number(a.rowid)-Number(b.rowid));
        // Equal-time competing first links cannot safely be ordered solely by tid.
        // Wait for another WS batch or the HTTP recovery rather than invent an order.
        if(eligible.length>1&&Number(eligible[0].at)===Number(eligible[1].at))break;
        const r=eligible[0],f=r.fill;
        // A delayed older fill must never open a historical live trade.
        if(Number(r.at)<Number(s.wsLastAt[coin]||0)-1000)break;
        await this.apply(s,f);
        anchor=round(Number(f.startPosition)+(f.side==='B'?1:-1)*Number(f.sz));
        s.wsAnchors[coin]=anchor;s.wsLastAt[coin]=Math.max(Number(s.wsLastAt[coin]||0),Number(f.time));
        s.cursor=Math.max(s.cursor,Number(f.time));
        await this.put(s); // D1 result + DO checkpoint before removing inbox item.
        await this.db.prepare(`DELETE FROM mc_watch_ws_inbox WHERE session_id=? AND fill_id=?`).bind(s.id,r.fill_id).run();
        rest.splice(rest.indexOf(r),1);applied++;
        if(applied>=300)break;
      }
      if(applied>=300)break;
    }
    return applied;
  }
  private async pollCore(){const s=await this.get();if(!s?.active)return;await this.tables();try{
      await this.flushGapPending(s);
      await this.reconcileLegacyGap(s);
      if(!Object.keys(s.szDecimals||{}).length){
        const meta:any=await info({type:'meta'});
        s.szDecimals=Object.fromEntries((meta.universe||[]).filter((x:any)=>Number.isInteger(x.szDecimals)).map((x:any)=>[x.name,x.szDecimals]));
      }
      // Observe orders first so fills in the same polling cycle can match by oid.
      try{await this.watchOrders(s);}catch(e){s.errors.push(new Date().toISOString()+' ORDERS '+String(e));s.errors=s.errors.slice(-30);}
      // V1.3.6: fetch a deeper bounded history so rapid partial fills missed by
      // earlier polls can be reconstructed before advancing the virtual ledger.
      // Existing SKIPPED records remain immutable audit records: do not silently
      // replay them or invent historical P/L.
      const from=Math.max(s.started,s.cursor-30*60*1000);
      const fills:any=await info({type:'userFillsByTime',user:MC_WALLET,startTime:from,aggregateByTime:false});
      if(!Array.isArray(fills))throw Error('UNEXPECTED_FILLS_RESPONSE');
      if(fills.length>=1900)throw Error('FILL_PAGE_NEAR_LIMIT_MANUAL_AUDIT_REQUIRED');
      fills.sort((a:any,b:any)=>asNum(a.time)-asNum(b.time)||String(a.tid).localeCompare(String(b.tid)));
      await this.recordSourceOrderFills(s.id,fills);
      const seen=new Set<string>();
      const freshFills:any[]=[];
      for(const f of fills){
        const id=String(f.coin)+':'+String(f.tid??f.hash??'')+':'+String(f.hash||'');
        if(seen.has(id))continue;
        seen.add(id);
        const exists:any=await this.db.prepare('SELECT 1 AS yes FROM mc_watch_events WHERE session_id=? AND fill_id=?').bind(s.id,id).first();
        if(!exists)freshFills.push(f);
      }
      // Repair previously logged GAP HOLD rows when the original real fills
      // form an exact chain from the currently accounted target position.
      // This does not synthesize missing fills or reset virtual P/L.
      // Do not replay historical GAP rows in virtual-close mode: they can
      // resurrect an already closed position and distort the ledger.
      // await this.recoverVerifiedSkipped(s);
      // Resolve continuity PER COIN across the entire fetched batch, not only
      // among fills with an identical timestamp. Hyperliquid tid ordering is
      // not a reliable position-chain order for multi-fill executions.
      const byCoin=new Map<string,any[]>();
      for(const f of freshFills){const coin=String(f.coin||'');if(!byCoin.has(coin))byCoin.set(coin,[]);byCoin.get(coin)!.push(f);}
      const ordered:any[]=[];
      for(const [coin,group] of byCoin){
        let anchor=s.positions[coin]?.targetQty;
        // For an untracked coin use the earliest event's start as the anchor;
        // inherited-position handling remains unchanged in apply().
        if(anchor===undefined)anchor=asNum(group[0]?.startPosition);
        const remaining=[...group];
        while(remaining.length){
          let choice=remaining.findIndex(f=>Math.abs(asNum(f.startPosition)-anchor!)<=Math.max(1e-7,Math.abs(anchor!)*.00001));
          if(choice<0){
            // No provable bridge: retain GAP HOLD, never fake a close/reversal.
            // Keep the remaining fills in chronological order for audit.
            ordered.push(...remaining);
            break;
          }
          const f=remaining.splice(choice,1)[0];
          ordered.push(f);
          anchor=round(asNum(f.startPosition)+(f.side==='B'?1:-1)*asNum(f.sz));
        }
      }
      // Across coins the exact interleaving is irrelevant to position
      // continuity, but processing chronologically preserves cash ordering.
      // Within each coin, the chain order constructed above must be retained.
      const coinCursor=new Map<string,number>();
      const chains=new Map<string,any[]>();
      for(const f of ordered){const c=String(f.coin);if(!chains.has(c))chains.set(c,[]);chains.get(c)!.push(f);}
      const allCoins=[...chains.keys()];
      while(true){
        let coin:string|null=null,earliest=Infinity;
        for(const c of allCoins){const idx=coinCursor.get(c)||0;const f=chains.get(c)![idx];if(f&&asNum(f.time)<earliest){coin=c;earliest=asNum(f.time);}}
        if(coin===null)break;
        const idx=coinCursor.get(coin)||0;
        const f=chains.get(coin)![idx];coinCursor.set(coin,idx+1);
        await this.apply(s,f);
        s.wsAnchors ||= {};s.wsLastAt ||= {};
        const at=asNum(f.time),last=Number(s.wsLastAt[String(f.coin)]||0);
        if(at>=last){
          s.wsAnchors[String(f.coin)]=round(asNum(f.startPosition)+(f.side==='B'?1:-1)*asNum(f.sz));
          s.wsLastAt[String(f.coin)]=at;
        }
        s.cursor=Math.max(s.cursor,at);
        await this.put(s); // Per-fill checkpoint prevents D1 getting ahead of DO.
      }
      const mids:any=await info({type:'allMids'});for(const [c,v] of Object.entries(mids||{}))s.lastPrice[c]=asNum(v);
      for(const p of Object.values(s.positions))p.last=s.lastPrice[p.coin]||p.last;
      // Open orders were observed before processing fills.
      s.lastPoll=Date.now();s.lastError=null;
    }catch(e){s.lastError=String(e);s.errors.push(new Date().toISOString()+' '+String(e));s.errors=s.errors.slice(-30);}
    await this.put(s);
  }
  async status(){const s=await this.get();if(s){await this.tables();await this.flushGapPending(s);await this.reconcileLegacyGap(s);}if(!s)return{ok:true,configured:true,active:false,needs_start:true,wallet:MC_WALLET};
    const orderSummary=await this.db.prepare('SELECT COUNT(*) AS n, MAX(at) AS last_at FROM mc_copy_order_updates WHERE session_id=?').bind(s.id).first().catch(()=>null);
    const lastSourceOrder=await this.db.prepare('SELECT coin,status,source_oid,at FROM mc_copy_order_updates WHERE session_id=? ORDER BY rowid DESC LIMIT 1').bind(s.id).first().catch(()=>null);
    let used=0,unreal=0;const positions=Object.values(s.positions).map(p=>{const mark=s.lastPrice[p.coin]||p.last||p.avg;const u=p.qty*(mark-p.avg);const margin=Math.abs(p.qty*mark)/LEVERAGE;used+=margin;unreal+=u;return{...p,direction:sign(p.qty)>0?'LONG':'SHORT',mark,unrealized:u,margin,notional:Math.abs(p.qty*mark),duration_ms:Date.now()-p.opened};});
    const equity=s.cash+unreal;return{ok:true,version:'MULTI-COIN TRADER WATCH V2 PRE-LIVE ACCUMULATION V2.2 DUAL $1.04/$2 + V1.3.16 GAP COMMIT',mode:'VIRTUAL_ONLY_NO_REAL_ORDERS',wallet:MC_WALLET,active:s.active,session_id:s.id,started_at:s.started,source_order_updates:Number(orderSummary?.n||0),source_order_last_at:Number(orderSummary?.last_at||0)||null,source_order_latest:lastSourceOrder,last_poll:s.lastPoll,last_error:s.lastError,initial_usd:s.initial,cash_usd:s.cash,equity_usd:equity,roi_pct:(equity/s.initial-1)*100,used_margin_usd:used,free_margin_usd:equity-used,unrealized_usd:unreal,realized_gross_usd:s.gross,fees_usd:s.fees,net_realized_usd:s.gross-s.fees,turnover_usd:s.turnover,open_positions:positions,open_count:positions.length,closed_count:s.closed,wins:s.wins,losses:s.losses,win_rate_pct:s.closed?s.wins/s.closed*100:0,processed_fills:s.fills,skipped_fills:s.skipped,open_orders_count:Object.keys(s.orders||{}).length,open_orders_last_poll:s.ordersLastPoll||0,open_orders_error:s.ordersLastError||null,order_changes:s.orderChanges||0,mirror_pending_orders:Object.values(s.mirrorOrders||{}).filter(o=>o.status==='PENDING').length,mirror_theoretical_realized_gross:s.mirrorRealized||0,theoretical_fees:s.mirrorFees||0,theoretical_realized_net:(s.mirrorRealized||0)-(s.mirrorFees||0),theoretical_positions:Object.values(s.mirrorPositions||{}),matched_target_fills:s.mirrorMatches||0,mirror_unmatched_target_fills:s.mirrorUnmatched||0,copy_accuracy_pct:(s.accuracyEligible||0)>0?100*(s.accuracyMatched||0)/(s.accuracyEligible||1):null,copy_accuracy_sample:s.accuracyEligible||0,copy_accuracy_matched:s.accuracyMatched||0,copy_accuracy_gaps:s.accuracyGaps||0,copy_accuracy_since_upgrade:true,maker_target_fills:s.makerFills||0,taker_target_fills:s.takerFills||0,unknown_target_fills:s.unknownFills||0,ignored_inherited_coins:Object.keys(s.ignored),leverage:LEVERAGE,initial_margin_per_position:OPEN_MARGIN,initial_notional_per_position:OPEN_NOTIONAL,pre_live_comparison_2usd:(()=>{const v=s.preLive2; if(!v)return null;let unreal=0,used=0;const open=Object.values(v.positions).map(p=>{const mark=s.lastPrice[p.coin]||p.avg;unreal+=p.qty*(mark-p.avg);used+=Math.abs(p.qty*mark)/LEVERAGE;return{...p,mark,unrealized:p.qty*(mark-p.avg),pending_delta_usd:Math.abs(p.targetDesired-p.qty)*mark};});return{mode:'SHADOW_VIRTUAL_ONLY',initial_usd:INITIAL,initial_margin_per_position:2,initial_notional_per_position:COMPARE_OPEN_NOTIONAL,equity_usd:v.cash+unreal,roi_pct:(v.cash+unreal)/INITIAL*100-100,realized_gross_usd:v.gross,fees_usd:v.fees,realized_net_usd:v.gross-v.fees,unrealized_usd:unreal,used_margin_usd:used,free_margin_usd:v.cash+unreal-used,turnover_usd:v.turnover,executed_orders:v.executed,deferred_add_events:v.deferredAdds,deferred_reduction_events:v.deferredReductions,blocked_margin_events:v.blockedMargin,closed:v.closed,win_rate_pct:v.closed?v.wins/v.closed*100:0,average_pending_delay_ms:v.delaySamples?v.delayMsTotal/v.delaySamples:null,positions:open,minimum_notional_usd:PRELIVE_ORDER_MIN,metadata_loaded:Object.keys(s.szDecimals||{}).length>0,events_processed:v.events,limitations:['Starts tracking from deployment if current session already exists; not a historical replay','Virtual-only, no slippage/funding, exchange acceptance unverified']};})(),pre_live_accumulation:(()=>{const v=s.preLive||newPreLive();let unreal=0,used=0;const open=Object.values(v.positions).map(p=>{const mark=s.lastPrice[p.coin]||p.avg;unreal+=p.qty*(mark-p.avg);used+=Math.abs(p.qty*mark)/LEVERAGE;return{...p,mark,unrealized:p.qty*(mark-p.avg),pending_delta_usd:Math.abs(p.targetDesired-p.qty)*mark};});return{mode:'SHADOW_VIRTUAL_ONLY',initial_usd:INITIAL,equity_usd:v.cash+unreal,roi_pct:(v.cash+unreal)/INITIAL*100-100,realized_gross_usd:v.gross,fees_usd:v.fees,realized_net_usd:v.gross-v.fees,unrealized_usd:unreal,used_margin_usd:used,free_margin_usd:v.cash+unreal-used,turnover_usd:v.turnover,executed_orders:v.executed,deferred_add_events:v.deferredAdds,deferred_reduction_events:v.deferredReductions,blocked_margin_events:v.blockedMargin,closed:v.closed,win_rate_pct:v.closed?v.wins/v.closed*100:0,average_pending_delay_ms:v.delaySamples?v.delayMsTotal/v.delaySamples:null,positions:open,minimum_notional_usd:PRELIVE_ORDER_MIN,metadata_loaded:Object.keys(s.szDecimals||{}).length>0,limitations:['Shadow execution uses target fill prices; slippage and funding are not modeled','Exchange size precision loaded from metadata; order acceptance not verified','Small residual full-close uses virtual reduce-only close assumption']};})(),pre_live_test:{virtual_only:true,starting_capital_usdc:INITIAL,leverage:LEVERAGE,maximum_theoretical_initial_exposure_usd:INITIAL*LEVERAGE,fixed_position_count_limit:null,exchange_minimum_order_notional_usd:MIN_NOTIONAL,exchange_order_execution_verified:false,existing_session_unchanged_until_new_session:true},fee_assumptions:{maker:MAKER_FEE,taker:TAKER_FEE},limitations:['Virtual fill at target fill price; own order execution is not proven','Original 1:1 ledger remains unrestricted; compare with pre_live_accumulation shadow for order-size restrictions','Funding, liquidation, price slippage and exchange precision rules not modeled','Only contiguous previously audited target fills can be recovered; unknown gaps remain on hold and are never fabricated','Perpetual market only; spot fills are not included']};}

  // Read-only target position observer. Separate key: never mutates the virtual session.
  async targetPositions(){
    const state:any=await info({type:'clearinghouseState',user:MC_WALLET});
    const now=Date.now();
    const prior:Record<string,any>=(await this.storage.get('mcTargetPositionObserverV1'))||{};
    const next:Record<string,any>={};
    const rows:any[]=[];
    for(const entry of state.assetPositions||[]){
      const p=entry.position||{};const coin=String(p.coin||'');const qty=asNum(p.szi);
      if(!coin||Math.abs(qty)<EPS)continue;
      const avg=asNum(p.entryPx),mark=asNum(p.markPx)||asNum(p.positionValue)/Math.abs(qty)||avg;
      const value=Math.abs(asNum(p.positionValue))||Math.abs(qty*mark);
      const old=prior[coin];
      const changed=!!old&&(Math.abs(asNum(old.qty)-qty)>1e-9||Math.abs(asNum(old.avg)-avg)>1e-8);
      const firstSeen=old?.firstSeen||now;
      const lastChange=changed?now:(old?.lastChange||null);
      const changeCount=(old?.changeCount||0)+(changed?1:0);
      next[coin]={qty,avg,firstSeen,lastChange,changeCount};
      const lev=p.leverage||{};
      const recent=lastChange!=null&&now-lastChange<=5*60*1000;
      const active=lastChange!=null&&now-lastChange<=60*60*1000;
      rows.push({coin,direction:qty>0?'LONG':'SHORT',qty,entry:avg,mark,notional:value,leverage:asNum(lev.value),leverage_type:lev.type||null,margin:asNum(p.marginUsed),unrealized:asNum(p.unrealizedPnl),roe:asNum(p.returnOnEquity)*100,liquidation:p.liquidationPx==null?null:asNum(p.liquidationPx),first_seen:firstSeen,last_observed_change:lastChange,observed_change_count:changeCount,activity:recent&&changeCount>=3?'SCALPING CANDIDATE':active?'ACTIVE TRADING':'HELD / NO RECENT OBSERVED CHANGE'});
    }
    // Observer snapshots are independent from the trading session and do not create orders/fills.
    await this.storage.put('mcTargetPositionObserverV1',next);
    rows.sort((a,b)=>b.notional-a.notional);
    return {ok:true,mode:'TARGET_POSITIONS_READ_ONLY',wallet:MC_WALLET,observed_at:now,count:rows.length,positions:rows,note:'First seen is the first observer snapshot, NOT actual opening time. Activity is based only on changes observed by this endpoint; no historical trades are inferred. HELD means no recently observed change, not proof of long-term holding.'};
  }
  async events(limit:number){await this.tables();const s=await this.get();if(!s)return{ok:true,rows:[]};const r:any=await this.db.prepare('SELECT payload FROM mc_watch_events WHERE session_id=? ORDER BY at DESC LIMIT ?').bind(s.id,Math.max(1,Math.min(500,limit))).all();return{ok:true,rows:(r.results||[]).map((x:any)=>JSON.parse(x.payload))};}
  async closed(limit:number){await this.tables();const s=await this.get();if(!s)return{ok:true,rows:[]};const r:any=await this.db.prepare('SELECT coin,direction,opened,closed,entry,exit,gross,fees,net FROM mc_watch_closed WHERE session_id=? ORDER BY closed DESC LIMIT ?').bind(s.id,Math.max(1,Math.min(500,limit))).all();return{ok:true,rows:r.results||[]};}
  async route(path:string,method:string,url:URL){try{if(path==='/multi/start'&&method==='POST')return reply(await this.start());if(path==='/multi/stop'&&method==='POST')return reply(await this.stop());if(path==='/multi/new-session'&&method==='POST')return reply(await this.newSession());if(path==='/multi/status')return reply(await this.status());if(path==='/multi/target-positions')return reply(await this.targetPositions());if(path==='/multi/events')return reply(await this.events(Number(url.searchParams.get('limit')||200)));if(path==='/multi/mirror')return reply(await this.mirrorStatus(Number(url.searchParams.get('limit')||100)));if(path==='/multi/orders')return reply(await this.orders(Number(url.searchParams.get('limit')||100)));if(path==='/multi/closed')return reply(await this.closed(Number(url.searchParams.get('limit')||200)));return reply({ok:false,error:'NOT_FOUND'},404);}catch(e){return reply({ok:false,error:String(e)},503);}}
}

}
const MultiCoinEngine=MultiCoinWatchNS.MultiCoinEngine;
const MC_WALLET=MultiCoinWatchNS.MC_WALLET;

// BTC TRADER WATCmH V4.2 .— CLEAN FILL LEDGER + DETERMINISTIC REPLAY
// Cloudflare Durable Object: export class TraderWatch
// READ ONLY: this file neve.r submits an exchange order.
// Only BTC fills from the configured public wallet are tracked.

const TARGET = '0xbb160cb61e694570f9d570f9fcde7c61dd2143ad';
const INFO_URL = 'https://api.hyperliquid.xyz/info';
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const VERSION = 'BTC TRADER WATCH V4.7.6 AUTHORITATIVE OPEN ORDERS';
const EPS = 0.00000001;
const START_NOTIONAL_USD = 100;
const AUDIT_INTERVAL_MS = 60000;
const SNAPSHOT_INTERVAL_MS = 30000;
const ALARM_INTERVAL_MS = 10000;
const MAX_API_WINDOW_MS = 4 * 60 * 1000;
const MAX_RECENT = 100;

type Action = 'OPEN' | 'ADD' | 'PARTIAL_CLOSE' | 'CLOSE' | 'REVERSAL';
type Source = 'WS_LIVE' | 'API_BACKFILL';
type RawFill = {
  coin: string;
  tid: number | string;
  hash?: string;
  time: number;
  side: 'A' | 'B';
  startPosition: number | string;
  sz: number | string;
  px: number | string;
  oid?: number | string; crossed?: boolean; fee?: number | string;
};
type NormalFill = {
  id: string; at: number; receivedAt: number; source: Source;
  start: number; end: number; size: number; price: number;
  side: 'A' | 'B'; oid?: string; crossed?: boolean;
};
type Row = {
  id: string; at: number; receivedAt: number; source: Source;
  action: Action; start: number; end: number; size: number; price: number;
  targetSide: string; copyBefore: number; copyAfter: number;
  copied: boolean; reason: string;
};
type VirtualTrade = {id:string; at:number; action:Action; price:number; targetStart:number; targetEnd:number;
  beforeQty:number; afterQty:number; deltaQty:number; realizedUsd:number; feeUsd:number;
  equityUsd:number; cashUsd:number; usedMarginUsd:number; status:string};
type VirtualState = {startedAt:number; balanceUsd:number; initialBalanceUsd:number;
  qty:number; avgPrice:number; ratio:number; realizedUsd:number; feesUsd:number;
  closedTrades:number; wins:number; losses:number; positionRealizedUsd:number;
  positionFeesUsd:number; peakEquityUsd:number; maxDrawdownPct:number;
  lastMarkPrice:number; lastFillId:string|null; events:number; skipped:number;
  blockedAdds:number; rejectedOpens:number; recent:VirtualTrade[]};
const VIRTUAL_INITIAL_BALANCE = 50;
const VIRTUAL_MARGIN_PER_OPEN = 10;
const VIRTUAL_LEVERAGE = 5;
const VIRTUAL_OPEN_NOTIONAL = VIRTUAL_MARGIN_PER_OPEN * VIRTUAL_LEVERAGE;
// Assumed taker fee; this is a configurable simulation assumption, not a quoted live fee.
const VIRTUAL_TAKER_FEE_RATE = 0.00045;
const VIRTUAL_SLIPPAGE_BPS = 0; // 0 until live executable price evidence is available.
const VIRTUAL_MARGIN_BUFFER = 0.001;
function freshVirtual(): VirtualState { return {startedAt:Date.now(),balanceUsd:50,initialBalanceUsd:50,
 qty:0,avgPrice:0,ratio:0,realizedUsd:0,feesUsd:0,closedTrades:0,wins:0,losses:0,
 positionRealizedUsd:0,positionFeesUsd:0,peakEquityUsd:50,maxDrawdownPct:0,
 lastMarkPrice:0,lastFillId:null,events:0,skipped:0,blockedAdds:0,rejectedOpens:0,recent:[]}; }
// Independent V4.6.3 session. V4.6 ledger is preserved, never overwritten.
// The trader equity is an observed APPROXIMATION, not a verified live equity feed.
const V463_BALANCE = 5000;
const V463_TARGET_EQUITY_REFERENCE = 4450;
const V463_SCALE = V463_BALANCE / V463_TARGET_EQUITY_REFERENCE;
const V463_LEVERAGE = 5;
const V463_MIN_ORDER_USD = 10; // Conservative assumption: confirm current BTC venue rules before live use.
const V463_FEE = 0.00045;
type V463Phase = 'WAITING_FOR_NEW_POSITION' | 'TRACKING' | 'PAUSED_GAP';
type V463State = {
  sessionId: string; startedAt: number; phase: V463Phase; balance: number;
  qty: number; avg: number; targetQty: number; lastPrice: number;
  gross: number; fees: number; tradedNotional: number; peak: number; drawdown: number;
  positionGross: number; positionFees: number; positionId: number; positionStartedAt: number;
  completed: number; wins: number; losses: number; applied: number; skippedBackfill: number;
  duplicates: number; belowMinimum: number; marginRejected: number;
  reversalCount: number; opens: number; adds: number; partials: number; closes: number;
  gapCount: number; lastFillId: string | null; lastFillAt: number;
  pauseReason?: string; pausedAt?: number;
  recent: any[];
  positionEntryPrice?: number; positionInitialQty?: number; positionExitQty?: number;
  positionTurnover?: number; positionFeesOpen?: number; positionCloseCount?: number;
  closedPositions?: any[];
};
function freshV463(): V463State {
  const now=Date.now();
  return {sessionId:'V463-'+now,startedAt:now,phase:'WAITING_FOR_NEW_POSITION',
    balance:V463_BALANCE,qty:0,avg:0,targetQty:0,lastPrice:0,gross:0,fees:0,
    tradedNotional:0,peak:V463_BALANCE,drawdown:0,positionGross:0,positionFees:0,
    positionId:0,positionStartedAt:0,completed:0,wins:0,losses:0,applied:0,
    skippedBackfill:0,duplicates:0,belowMinimum:0,marginRejected:0,
    reversalCount:0,opens:0,adds:0,partials:0,closes:0,gapCount:0,
    lastFillId:null,lastFillAt:0,recent:[],closedPositions:[],positionEntryPrice:0,
    positionInitialQty:0,positionExitQty:0,positionTurnover:0,positionFeesOpen:0,positionCloseCount:0};
}
type Stats = {
  fills: number; copyActions: number; opens: number; adds: number;
  partials: number; closes: number; reversals: number;
  duplicates: number; gaps: number; apiRecovered: number; writeFailures: number;
};
type WatchState = {
  schema: 41; epoch: number; active: boolean; connected: boolean;
  baselineAt: number; baselineSigned: number | null;
  targetSigned: number | null; copySigned: number; ratio: number;
  copyEnabled: boolean; needsAudit: boolean;
  snapshotSigned: number | null; snapshotMismatch: number | null;
  lastFillAt: number; lastAuditAt: number; lastSnapshotAt: number;
  nextApiAt: number; nextSnapshotAt: number;
  lastError: string | null; stats: Stats; recent: Row[];
  auditCursor: number; ledgerCount: number; replayGap: boolean;
  snapshotRequestAt?: number; snapshotResponseAt?: number;
  snapshotAlignedTarget?: number | null; snapshotSyncStatus?: string;
  snapshotConfirmedMismatch?: boolean;
  pipelineSamples?: any[];
  pendingSnapshots?: {requestAt:number;responseAt:number;signed:number}[];
  lastVerifiedSnapshot?: {requestAt:number;responseAt:number;verifiedAt:number;
    exchangeSigned:number;ledgerSigned:number;delta:number;status:string} | null;
  lastSnapshotCheck?: {requestAt:number;responseAt:number;checkedAt:number;
    exchangeSigned:number;ledgerSigned:number|null;delta:number|null;status:string} | null;
  snapshotChecks?: {matched:number;mismatched:number;raced:number;pendingExpired:number};
  virtualV46?: VirtualState;
};

function fresh(): WatchState {
  return {
    schema: 41, epoch: Date.now(), active: false, connected: false,
    baselineAt: 0, baselineSigned: null, targetSigned: null,
    copySigned: 0, ratio: 0, copyEnabled: false, needsAudit: false,
    snapshotSigned: null, snapshotMismatch: null,
    lastFillAt: 0, lastAuditAt: 0, lastSnapshotAt: 0,
    nextApiAt: 0, nextSnapshotAt: 0, lastError: null,
    stats: { fills: 0, copyActions: 0, opens: 0, adds: 0,
      partials: 0, closes: 0, reversals: 0, duplicates: 0,
      gaps: 0, apiRecovered: 0, writeFailures: 0 },
    recent: [], auditCursor: 0, ledgerCount: 0, replayGap: false,
    snapshotRequestAt: 0, snapshotResponseAt: 0,
    snapshotAlignedTarget: null, snapshotSyncStatus: 'NOT_CHECKED',
    snapshotConfirmedMismatch: false,
    pendingSnapshots: [], lastVerifiedSnapshot: null, lastSnapshotCheck: null,
    snapshotChecks: {matched:0,mismatched:0,raced:0,pendingExpired:0},
  };
}
const same = (a: number, b: number) => Math.abs(a - b) <= EPS;
const direction = (n: number) => same(n, 0) ? 0 : n > 0 ? 1 : -1;
const sideName = (n: number) => n > EPS ? 'LONG' : n < -EPS ? 'SHORT' : 'FLAT';
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status, headers: { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store' },
  });

function normalize(raw: RawFill, source: Source): NormalFill | null {
  if (raw?.coin !== 'BTC' || !['A', 'B'].includes(raw.side)) return null;
  const start = Number(raw.startPosition);
  const size = Number(raw.sz);
  const price = Number(raw.px);
  const at = Number(raw.time);
  if (![start, size, price, at].every(Number.isFinite) || size <= 0 || price <= 0 || at <= 0) return null;
  if (raw.tid === null || raw.tid === undefined) return null;
  const end = start + (raw.side === 'B' ? size : -size);
  return {
    id: 'BTC:' + String(raw.tid) + ':' + String(raw.hash || ''),
    at, receivedAt: Date.now(), source, start, end, size, price, side: raw.side,
    oid:raw.oid===undefined?undefined:String(raw.oid), crossed:raw.crossed,
  };
}
function actionOf(f: NormalFill): Action {
  const a = direction(f.start), b = direction(f.end);
  if (a === 0 && b !== 0) return 'OPEN';
  if (a !== 0 && b === 0) return 'CLOSE';
  if (a !== b) return 'REVERSAL';
  return Math.abs(f.end) > Math.abs(f.start) ? 'ADD' : 'PARTIAL_CLOSE';
}

export class TraderWatch {
  private s: WatchState = fresh();
  private ws: WebSocket | null = null;
  // Dedicated websocket for the MULTI-Coin wallet. BTC test WS remains separate.
  private multiWs: WebSocket | null = null;
  private multiWsConnected = false;
  private multiWsLastRx = 0;
  private multiWsLastFill = 0;
  private multiWsLastPing = 0;
  private multiWsNextConnect = 0;
  private multiWsFrames: any[] = [];
  private multiWsTimer: ReturnType<typeof setTimeout> | null = null;
  private multiJobs: Promise<unknown> = Promise.resolve();
  private multiWsMessages = 0;
  private multiWsLastError: string | null = null;
  private multiNextBackfill = 0;
  private multiWsPending = 0;

  private processing: Promise<void> = Promise.resolve();
  private auditBusy = false;
  private databaseReady = false;
  private resetBusy = false;
  private readonly pipelineCap = 1200;
  private virtualReady = false;
  private makerReady = false;
  private maker: any = null;
  private observedOrders = new Map<string,any>();
  private v463Ready = false;
  private v463: V463State | null = null;
  private incrementalActions = 0;
  private recoveryReplays = 0;
  private recoveryReason: string | null = null;
  private appendReady = false;
  private queuedJobs = 0;
  private readonly diagnosticSince = Date.now();
  private recoveryRowsWritten = 0;
  private lastRecoveryMs: number | null = null;
  private recoveryPending = false;
  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queuedJobs++;
    const next = this.processing.catch(() => {}).then(job);
    this.processing = next.catch(e => {
      this.s.lastError = 'INGEST_QUEUE: ' + String(e);
      this.s.needsAudit = true;
    }).finally(() => { this.queuedJobs--; });
    return next;
  }

  // Validate persisted projection once after a DO restart; do not rebuild history.
  private async verifyProjection(): Promise<void> {
    if (this.appendReady) return;
    await this.ensureDb();
    const counts: any = await this.env.DB.prepare(`SELECT
      (SELECT count(*) FROM trader_watch_v4_fills WHERE wallet=? AND epoch=?) AS fills,
      (SELECT count(*) FROM trader_watch_v4_actions WHERE wallet=? AND epoch=?) AS actions`)
      .bind(TARGET, this.s.epoch, TARGET, this.s.epoch).first();
    const fills = Number(counts?.fills || 0);
    const actions = Number(counts?.actions || 0);
    if (fills !== this.s.ledgerCount || actions !== fills || this.s.replayGap) {
      this.recoveryReason = `PERSISTED_PROJECTION_NOT_ALIGNED:fills=${fills},actions=${actions},checkpoint=${this.s.ledgerCount},gap=${this.s.replayGap}`;
      this.recoveryReplays++;
      await this.replay();
      if (this.s.replayGap) throw new Error('FILL_CHAIN_GAP_REQUIRES_AUDIT');
    }
    this.appendReady = true;
  }

  private async writeAction(row: Row): Promise<void> {
    await this.env.DB.prepare(`INSERT INTO trader_watch_v4_actions
      (wallet,epoch,fill_id,event_at,payload_json) VALUES (?,?,?,?,?)
      ON CONFLICT(wallet,epoch,fill_id) DO UPDATE SET payload_json=excluded.payload_json`)
      .bind(TARGET, this.s.epoch, row.id, row.at, JSON.stringify(row)).run();
  }

  private virtualEquity(v: VirtualState, mark:number): number {
    const unrealized = v.qty * (mark - v.avgPrice);
    return v.balanceUsd + unrealized;
  }
  private virtualUsedMargin(v: VirtualState, mark:number): number {
    return Math.abs(v.qty) * mark / VIRTUAL_LEVERAGE;
  }
  private virtualMark(v:VirtualState, px:number):void {
    if (!(px > 0)) return;
    v.lastMarkPrice=px;
    const eq=this.virtualEquity(v,px);
    v.peakEquityUsd=Math.max(v.peakEquityUsd,eq);
    if(v.peakEquityUsd>0) v.maxDrawdownPct=Math.max(v.maxDrawdownPct,100*(v.peakEquityUsd-eq)/v.peakEquityUsd);
  }
  private async ensureVirtual():Promise<void> {
    if(this.virtualReady) return;
    await this.ensureDb();
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_v46_virtual (
      wallet TEXT NOT NULL, epoch INTEGER NOT NULL, fill_id TEXT NOT NULL,
      event_at INTEGER NOT NULL, payload_json TEXT NOT NULL, state_json TEXT NOT NULL,
      PRIMARY KEY(wallet,epoch,fill_id))`).run();
    await this.env.DB.prepare(`CREATE INDEX IF NOT EXISTS trader_watch_v46_virtual_order
      ON trader_watch_v46_virtual(wallet,epoch,event_at)`).run();
    const last:any=await this.env.DB.prepare(`SELECT state_json FROM trader_watch_v46_virtual
      WHERE wallet=? AND epoch=? ORDER BY rowid DESC LIMIT 1`).bind(TARGET,this.s.epoch).first();
    if(last?.state_json) this.s.virtualV46=JSON.parse(last.state_json);
    else if(!this.s.virtualV46) this.s.virtualV46=freshVirtual();
    this.virtualReady=true;
  }
  private async virtualApply(f:NormalFill, action:Action):Promise<void> {
    await this.ensureVirtual();
    const v=this.s.virtualV46!;
    // The simulation starts with the NEXT new opening boundary, not with an
    // already-open position. API backfills older than activation cannot be executed.
    if(f.at < v.startedAt || f.source !== 'WS_LIVE') { v.skipped++; return; }
    if(v.lastFillId===f.id) return;
    const existing:any=await this.env.DB.prepare(`SELECT state_json FROM trader_watch_v46_virtual
      WHERE wallet=? AND epoch=? AND fill_id=?`).bind(TARGET,this.s.epoch,f.id).first();
    if(existing?.state_json) { this.s.virtualV46=JSON.parse(existing.state_json); return; }
    const before=v.qty;
    const executionPx=f.price*(1+(f.side==='B'?1:-1)*VIRTUAL_SLIPPAGE_BPS/10000);
    let status='APPLIED', delta=0, realized=0, fee=0;
    const close=(amount:number)=>{
      const q=Math.min(Math.abs(v.qty),amount);
      if(q<=EPS)return;
      const old=v.qty;
      const sign=Math.sign(old);
      const change=-sign*q;
      const profit=q*sign*(executionPx-v.avgPrice);
      const cost=q*executionPx*VIRTUAL_TAKER_FEE_RATE;
      v.balanceUsd+=profit-cost; v.realizedUsd+=profit;v.feesUsd+=cost;
      v.positionRealizedUsd+=profit;v.positionFeesUsd+=cost;
      realized+=profit;fee+=cost;delta+=change;
      v.qty+=change;
      if(Math.abs(v.qty)<EPS){
        const net=v.positionRealizedUsd-v.positionFeesUsd;
        v.closedTrades++;if(net>0)v.wins++;else if(net<0)v.losses++;
        v.qty=0;v.avgPrice=0;v.ratio=0;
        v.positionRealizedUsd=0;v.positionFeesUsd=0;
      }
    };
    const open=(signedQty:number, ratio:number)=>{
      const needed=Math.abs(signedQty)*executionPx/VIRTUAL_LEVERAGE;
      const openingFee=Math.abs(signedQty)*executionPx*VIRTUAL_TAKER_FEE_RATE;
      const free=v.balanceUsd+v.qty*(executionPx-v.avgPrice)-this.virtualUsedMargin(v,executionPx);
      if(needed+openingFee+VIRTUAL_MARGIN_BUFFER>free){
        if(Math.abs(v.qty)<EPS)v.rejectedOpens++;else v.blockedAdds++;
        status='INSUFFICIENT_VIRTUAL_MARGIN';return;
      }
      const oldAbs=Math.abs(v.qty),newAbs=Math.abs(signedQty);
      v.avgPrice=(oldAbs*v.avgPrice+newAbs*executionPx)/(oldAbs+newAbs);
      v.qty+=signedQty;delta+=signedQty;
      v.balanceUsd-=openingFee;v.feesUsd+=openingFee;v.positionFeesUsd+=openingFee;fee+=openingFee;
      v.ratio=ratio;
    };
    if(action==='OPEN'||action==='REVERSAL') {
      if(Math.abs(v.qty)>EPS)close(Math.abs(v.qty));
      if(Math.abs(v.qty)<EPS){
        const r=VIRTUAL_OPEN_NOTIONAL/(Math.abs(f.end)*executionPx);
        open(f.end*r,r);
      }
    } else if(Math.abs(v.qty)<EPS || Math.sign(v.qty)!==Math.sign(f.start)) {
      status='WAITING_FOR_FRESH_OPEN';
    } else if(action==='CLOSE')close(Math.abs(v.qty));
    else if(action==='PARTIAL_CLOSE') {
      const pct=Math.min(1,Math.abs(f.start-f.end)/Math.abs(f.start));
      close(Math.abs(v.qty)*pct);
    } else if(action==='ADD') {
      const pct=Math.abs(f.end-f.start)/Math.abs(f.start);
      open(v.qty*pct,v.ratio);
    }
    this.virtualMark(v,executionPx);
    v.lastFillId=f.id;v.events++;
    const ev:VirtualTrade={id:f.id,at:f.at,action,price:executionPx,targetStart:f.start,targetEnd:f.end,
      beforeQty:before,afterQty:v.qty,deltaQty:delta,realizedUsd:realized,feeUsd:fee,
      equityUsd:this.virtualEquity(v,executionPx),cashUsd:v.balanceUsd,
      usedMarginUsd:this.virtualUsedMargin(v,executionPx),status};
    v.recent.push(ev);v.recent=v.recent.slice(-100);
    await this.env.DB.prepare(`INSERT INTO trader_watch_v46_virtual
      (wallet,epoch,fill_id,event_at,payload_json,state_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(wallet,epoch,fill_id) DO NOTHING`)
      .bind(TARGET,this.s.epoch,f.id,f.at,JSON.stringify(ev),JSON.stringify(v)).run();
  }

  // V4.7.3: independent, persistent VIRTUAL limit-order mirror. No exchange orders.
  private readonly makerStrategy='VIRTUAL_RESTING_LIMIT_ORDER_MIRROR_V473';
  private async ensureMaker():Promise<void> {
    if(this.makerReady)return;
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_maker_sessions
      (wallet TEXT NOT NULL,session_id TEXT NOT NULL,started_at INTEGER NOT NULL,state_json TEXT NOT NULL,
      PRIMARY KEY(wallet,session_id))`).run();
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_maker_events
      (wallet TEXT NOT NULL,session_id TEXT NOT NULL,fill_id TEXT NOT NULL,event_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,PRIMARY KEY(wallet,session_id,fill_id))`).run();
    const row:any=await this.env.DB.prepare(`SELECT state_json FROM trader_watch_maker_sessions
      WHERE wallet=? ORDER BY started_at DESC LIMIT 1`).bind(TARGET).first();
    const previous=row?JSON.parse(row.state_json):null;
    // A new strategy must never mutate old proxy-session accounting.
    this.maker=previous?.strategy===this.makerStrategy?previous:this.freshMaker();
    this.observedOrders=new Map(Object.entries(this.maker.orders||{}));
    if(!previous||previous.strategy!==this.makerStrategy)await this.persistMaker();
    this.makerReady=true;
  }
  private freshMaker():any {const now=Date.now();return {
    session_id:'LIMIT-'+now,started_at:now,strategy:this.makerStrategy,
    phase:'WAITING_FOR_NEW_POSITION',balance:5000,qty:0,avg:0,gross:0,fees:0,
    turnover:0,last_price:0,events:0,eligible:0,position_id:0,
    closed_positions:0,wins:0,losses:0,position_gross:0,position_fees:0,
    target_last:0,last_event_at:0,orders:{},order_events:[],recent:[],
    order_created:0,order_changed:0,order_cancelled:0,order_filled:0,
    skipped_unknown_order:0,skipped_before_observed:0,skipped_limit:0,
    skipped_not_maker:0,skipped_min:0,skipped_margin:0,skipped_wait:0,
    skipped_backfill:0,duplicate:0,partial_fills:0,filled_qty:0,
    target_fill_qty:0,missed_qty:0,unfilled_order_qty:0,confidence:'TARGET_FILL_CONDITIONAL',
    warning:'Virtual limit fills use target execution as a liquidity proxy; our queue priority is unknown.'};}
  private async persistMaker():Promise<void> {const v=this.maker;
    v.orders=Object.fromEntries(this.observedOrders);
    await this.env.DB.prepare(`INSERT INTO trader_watch_maker_sessions
      (wallet,session_id,started_at,state_json) VALUES(?,?,?,?)
      ON CONFLICT(wallet,session_id) DO UPDATE SET state_json=excluded.state_json`)
      .bind(TARGET,v.session_id,v.started_at,JSON.stringify(v)).run();}
  private orderLifecycle:any[]=[];
  private orderStats={opened:0,updated:0,cancelled:0,filled:0,resting:0,unknown:0};
  private async recordOrder(o:any,status:string,source:string,at=Date.now()):Promise<void> {
    if(o?.coin!=='BTC'||o?.oid===undefined||o?.oid===null)return;
    await this.ensureMaker();
    const v=this.maker,oid=String(o.oid),old=this.observedOrders.get(oid);
    const normalized=String(status||'open').toLowerCase();
    const terminal=['canceled','cancelled','filled','rejected','margincanceled','selftradecanceled',
      'reduceonlycanceled','ioccancelrejected','ioccancel','postonlycanceled','postonlyrejected'].includes(normalized)
      || normalized.endsWith('rejected') || normalized.endsWith('canceled') || normalized.endsWith('cancelled');
    const side=o.side??old?.side;
    const price=Number(o.limitPx??old?.price);
    const sz=Number(o.sz??old?.size);
    if(side!=='A'&&side!=='B')return;
    if(!Number.isFinite(price)||price<=0||!Number.isFinite(sz)||sz<0)return;
    const exchangeTime=Number(o.timestamp)||at;
    // REST snapshots can arrive after a WS terminal update: never resurrect the same OID.
    // WS duplicate opens are harmless; a terminal OID is immutable for this session.
    if(old&&!old.active){
      if(!terminal){v.stale_order_updates=(v.stale_order_updates||0)+1;return;}
      if(old.status===normalized)return;
    }
    if(old&&source==='REST_OPEN_ORDERS'&&old.source==='WS_ORDER_UPDATES'&&
       old.lastSeen>at){v.stale_order_updates=(v.stale_order_updates||0)+1;return;}
    const firstSeen=old?.observedAt??at;
    const remaining=old?old.remaining:sz*V463_SCALE;
    const row={oid,side,price,size:sz,remaining,observedAt:firstSeen,
      exchangePlacedAt:old?.exchangePlacedAt??exchangeTime,
      status:normalized,active:!terminal,lastSeen:at,source,
      virtualPlacedAt:old?.virtualPlacedAt??at,filled:old?.filled??0};
    if(old&&(old.price!==price||old.size!==sz)){
      // Remaining size from the exchange is not the original parent order size.
      // Never recreate already-filled virtual quantity on a partial-fill update.
      row.remaining=Math.min(Math.max(0,old.remaining),Math.max(0,sz*V463_SCALE));
      if(old.price!==price)row.virtualPlacedAt=at;
      v.order_changed++;
    }
    if(!old){v.order_created++;this.orderStats.opened++;}
    else this.orderStats.updated++;
    if(terminal){row.active=false;
      if(normalized.includes('cancel')){v.order_cancelled++;this.orderStats.cancelled++;}
      if(normalized==='filled'){v.order_filled++;this.orderStats.filled++;}
    }
    this.observedOrders.set(oid,row);
    const event={oid,at,status:normalized,source,side,price,remaining:row.remaining,active:row.active};
    v.order_events.unshift(event);v.order_events=v.order_events.slice(0,80);
    this.orderLifecycle.unshift(event);this.orderLifecycle=this.orderLifecycle.slice(0,100);
    if(this.observedOrders.size>1200){for(const [key,val] of this.observedOrders){
      if(this.observedOrders.size<=1000)break;if(!val.active)this.observedOrders.delete(key);}}
    await this.persistMaker();
  }
  // V4.7.6: a successful, complete REST snapshot is the authority for which
  // OIDs are currently resting. Two consecutive misses protect against races.
  // Historical order rows, fills, session, and P/L remain untouched.
  private async seedMakerOrders():Promise<void> {
    const requestStartedAt=Date.now();
    const rows=await this.info({type:'frontendOpenOrders',user:TARGET});
    if(!Array.isArray(rows))throw Error('MAKER_OPEN_ORDERS_SNAPSHOT_INVALID');
    // Do not reconcile from an invalid/partial-looking payload.
    if(rows.some((o:any)=>!o||typeof o!=='object'||o.oid===undefined||
      typeof o.coin!=='string'))throw Error('MAKER_OPEN_ORDERS_SNAPSHOT_MALFORMED');
    await this.ensureMaker();
    const now=Date.now(),present=new Set<string>();
    for(const o of rows){if(o.coin!=='BTC')continue;
      present.add(String(o.oid));
      await this.recordOrder(o,'open','REST_OPEN_ORDERS',now);
      const row=this.observedOrders.get(String(o.oid));
      if(row){row.snapshotMissingCount=0;row.snapshotMissingSince=0;}
    }
    this.orderStats.resting=present.size;
    const v=this.maker;
    v.target_active_orders=present.size;
    v.last_open_orders_snapshot_at=now;
    v.open_orders_snapshot_successes=(v.open_orders_snapshot_successes||0)+1;
    let confirmed=0,pending=0;
    for(const [oid,o] of this.observedOrders){
      if(!o.active||present.has(oid))continue;
      // A newer WS event can legitimately outrun an in-flight REST snapshot.
      if(o.lastSeen>requestStartedAt)continue;
      o.snapshotMissingCount=(o.snapshotMissingCount||0)+1;
      o.snapshotMissingSince=o.snapshotMissingSince||now;
      if(o.snapshotMissingCount<2){pending++;continue;}
      o.active=false;o.status='not_in_target_open_orders';o.lastSeen=now;
      o.source='REST_OPEN_ORDERS_RECONCILIATION';
      v.snapshot_closed_orders=(v.snapshot_closed_orders||0)+1;
      confirmed++;
      const event={oid,at:now,status:o.status,source:o.source,
        side:o.side,price:o.price,remaining:o.remaining,active:false};
      v.order_events.unshift(event);v.order_events=v.order_events.slice(0,80);
      this.orderLifecycle.unshift(event);this.orderLifecycle=this.orderLifecycle.slice(0,100);
    }
    v.snapshot_last_closed=confirmed;
    v.snapshot_pending_missing=pending;
    v.virtual_active_after_snapshot=Array.from(this.observedOrders.values()).filter((o:any)=>o.active).length;
    await this.persistMaker();
  }
  private async ingestMakerOrderUpdates(payload:any):Promise<void> {
    const rows=Array.isArray(payload)?payload:Array.isArray(payload?.orders)?payload.orders:[];
    for(const item of rows){const o=item?.order||item;
      await this.recordOrder(o,String(item?.status||'open'),'WS_ORDER_UPDATES');}
  }
  private async applyMaker(f:NormalFill):Promise<void> {
    await this.ensureMaker();const v=this.maker;
    if(f.source!=='WS_LIVE'){v.skipped_backfill++;return;}
    const exists:any=await this.env.DB.prepare(`SELECT fill_id FROM trader_watch_maker_events
      WHERE wallet=? AND session_id=? AND fill_id=?`).bind(TARGET,v.session_id,f.id).first();
    if(exists){v.duplicate++;return;}
    const o=f.oid?this.observedOrders.get(f.oid):undefined;
    const price=f.price,fillSide=f.side==='B'?1:-1;
    const boundary=(direction(f.start)===0&&direction(f.end)!==0)||
      (direction(f.start)!==0&&direction(f.end)!==0&&direction(f.start)!==direction(f.end));
    let status='UNMATCHED',executed=0,fee=0,realized=0,filled=0;
    v.target_fill_qty+=f.size*V463_SCALE;
    if(!o){status='NO_VIRTUAL_LIMIT_ORDER';v.skipped_unknown_order++;}
    else if(!o.active&&!(o.status==='filled'&&f.at<=o.lastSeen&&o.remaining>EPS)){
      status='ORDER_TERMINAL_NOT_RESTING';v.skipped_before_observed++;}
    else if(o.virtualPlacedAt>f.receivedAt||o.exchangePlacedAt>f.at){
      status='ORDER_NOT_RESTING_AT_FILL';v.skipped_before_observed++;}
    else if(o.side!==f.side||(fillSide===1&&price>o.price+0.01)||
      (fillSide===-1&&price<o.price-0.01)){
      status='PRICE_OR_SIDE_MISMATCH';v.skipped_limit++;}
    else if(f.crossed!==false){status='TARGET_FILL_NOT_VERIFIED_MAKER';v.skipped_not_maker++;}
    else if(v.phase==='WAITING_FOR_NEW_POSITION'&&!boundary){
      status='WAIT_NEW_POSITION_BOUNDARY';v.skipped_wait++;}
    else {
      // Conditional virtual fill: target maker fill supplies evidence of traded liquidity.
      // This is NOT proof that our later-arriving order would have queue priority.
      const qty=Math.min(Math.max(0,o.remaining),f.size*V463_SCALE);
      if(qty<=EPS){status='ORDER_EXHAUSTED';v.skipped_exhausted=(v.skipped_exhausted||0)+1;}
      else if(qty*price<10){status='BELOW_MIN_ORDER_NOTIONAL';v.skipped_min++;}
      else {
        const delta=fillSide*qty,before=v.qty,oldSign=direction(before);
        const avgBefore=v.avg,balanceBefore=v.balance,positionBefore=v.position_id;
        const closing=oldSign!==0&&oldSign!==fillSide;
        const closeQty=closing?Math.min(Math.abs(before),qty):0;
        const openQty=qty-closeQty;
        const after=before+delta;
        const unrealized=before*(price-v.avg);
        const equity=v.balance+unrealized;
        const projectedMargin=Math.abs(after)*price/5;
        const proposedFee=qty*price*0.00015;
        const proposedGross=closeQty*oldSign*(price-v.avg);
        if(projectedMargin>equity+proposedGross-proposedFee+1e-8){
          status='INSUFFICIENT_VIRTUAL_MARGIN';v.skipped_margin++;}
        else {
          if(v.phase==='WAITING_FOR_NEW_POSITION')v.phase='TRACKING';
          realized=proposedGross;fee=proposedFee;executed=qty*price;filled=qty;
          v.balance+=realized-fee;v.gross+=realized;v.fees+=fee;
          v.position_gross+=realized;v.turnover+=executed;
          const remaining=before-oldSign*closeQty;
          if(openQty>EPS){v.avg=(Math.abs(remaining)>EPS&&direction(remaining)===fillSide)?
            (Math.abs(remaining)*v.avg+openQty*price)/(Math.abs(remaining)+openQty):price;}
          else if(Math.abs(remaining)<EPS)v.avg=0;
          v.qty=Math.abs(after)<EPS?0:after;
          if(oldSign!==0&&(direction(v.qty)===0||direction(v.qty)!==oldSign)){
            const closingFee=closeQty*price*0.00015;
            v.position_fees+=closingFee;
            const net=v.position_gross-v.position_fees;
            v.closed_positions++;if(net>0)v.wins++;else if(net<0)v.losses++;
            v.position_gross=0;v.position_fees=openQty*price*0.00015;
            if(direction(v.qty)!==0)v.position_id++;
          }else{
            if(oldSign===0&&direction(v.qty)!==0)v.position_id++;
            v.position_fees+=fee;
          }
          o.remaining=Math.max(0,o.remaining-qty);o.filled+=qty;
          v.eligible++;v.filled_qty+=qty;
          v.last_execution_audit={fill_id:f.id,oid:f.oid,at:f.at,position_id_before:positionBefore,
            position_id_after:v.position_id,qty_before:before,qty_after:v.qty,
            avg_entry_before:avgBefore,avg_entry_after:v.avg,close_qty:closeQty,open_qty:openQty,
            gross_realized:realized,fee,net_realized:realized-fee,balance_before:balanceBefore,
            balance_after:v.balance,check_delta:v.balance-(balanceBefore+realized-fee)};
          if(o.remaining>EPS)v.partial_fills++;
          status='VIRTUAL_LIMIT_FILL_CONDITIONAL';
        }
      }
    }
    v.missed_qty+=Math.max(0,f.size*V463_SCALE-filled);
    v.events++;v.last_event_at=f.at;v.last_price=price;v.target_last=f.end;
    const event={id:f.id,at:f.at,oid:f.oid,status,side:f.side,
      limit_price:o?.price??null,target_fill_price:price,target_fill_qty:f.size,
      virtual_order_remaining:o?.remaining??null,virtual_fill_qty:filled,
      target_crossed:f.crossed??null,executed_notional_usd:executed,
      maker_fee_usd:fee,gross_realized_usd:realized,net_realized_delta_usd:realized-fee,
      copy_qty_btc:v.qty,position_id:v.position_id,
      execution_audit:filled>0?v.last_execution_audit:null,
      caveat:'Target maker fill does not prove copy queue fill.'};
    v.recent.unshift(event);v.recent=v.recent.slice(0,70);
    await this.env.DB.prepare(`INSERT OR IGNORE INTO trader_watch_maker_events
      (wallet,session_id,fill_id,event_at,payload_json) VALUES(?,?,?,?,?)`)
      .bind(TARGET,v.session_id,f.id,f.at,JSON.stringify(event)).run();
    await this.persistMaker();
  }
  private async makerReport():Promise<any> {
    await this.ensureMaker();const v=this.maker;
    const mark=v.last_price||v.avg||0;
    const unrealized=v.qty*(mark-v.avg),equity=v.balance+unrealized;
    const usedMargin=Math.abs(v.qty)*mark/5,freeEquity=equity-usedMargin;
    const active=[...this.observedOrders.values()].filter((o:any)=>o.active&&o.remaining>EPS);
    const buyQty=active.filter((o:any)=>o.side==='B').reduce((a:number,o:any)=>a+o.remaining,0);
    const sellQty=active.filter((o:any)=>o.side==='A').reduce((a:number,o:any)=>a+o.remaining,0);
    const buyExposure=Math.abs(v.qty+buyQty)*mark/5;
    const sellExposure=Math.abs(v.qty-sellQty)*mark/5;
    // Stress estimate: both directions are alternative scenarios, not additive reservations.
    const stressedMargin=Math.max(usedMargin,buyExposure,sellExposure);
    const reserve=Math.max(0,stressedMargin-usedMargin);
    const afterReserve=equity-stressedMargin;
    // Recompute reconciliation from the immutable per-fill event ledger. Older
    // V4.7.4 counters can differ after restarts; never rewrite historical P/L.
    const ledger:any=await this.env.DB.prepare(`SELECT
      count(*) AS n,
      sum(CAST(json_extract(payload_json,'$.target_fill_qty') AS REAL)) AS target_qty,
      sum(CAST(json_extract(payload_json,'$.virtual_fill_qty') AS REAL)) AS virtual_qty
      FROM trader_watch_maker_events WHERE wallet=? AND session_id=?`)
      .bind(TARGET,v.session_id).first();
    const ledgerTarget=Number(ledger?.target_qty||0)*V463_SCALE;
    const ledgerVirtual=Number(ledger?.virtual_qty||0);
    const ledgerMissing=Math.max(0,ledgerTarget-ledgerVirtual);
    const targetMinusVirtual=v.target_fill_qty-v.filled_qty;
    const quantityDelta=ledgerTarget-ledgerVirtual-ledgerMissing;
    const ledgerMatchesCounters=Math.abs(ledgerTarget-v.target_fill_qty)<1e-7 &&
      Math.abs(ledgerVirtual-v.filled_qty)<1e-7;
    return {ok:true,version:VERSION,mode:'VIRTUAL_ONLY_NO_REAL_ORDERS',
      strategy:this.makerStrategy,session_id:v.session_id,phase:v.phase,
      initial_balance_usd:5000,leverage:5,copy_scale:V463_SCALE,
      maker_fee_assumption:0.00015,
      execution_basis:'TARGET_MAKER_FILL_CONDITIONAL_LIMIT_MIRROR_NOT_QUEUE_PROVEN',
      active_virtual_limit_orders:active.length,
      target_active_orders_last_rest_snapshot:v.target_active_orders??null,
      last_open_orders_snapshot_at:v.last_open_orders_snapshot_at??null,
      open_orders_snapshot_successes:v.open_orders_snapshot_successes||0,
      snapshot_closed_stale_orders_total:v.snapshot_closed_orders||0,
      snapshot_closed_stale_orders_last:v.snapshot_last_closed||0,
      snapshot_pending_missing_confirmation:v.snapshot_pending_missing||0,
      active_order_count_delta_to_snapshot:v.target_active_orders==null?null:active.length-v.target_active_orders,
      virtual_limit_orders:active.slice(0,30).map((o:any)=>({oid:o.oid,side:o.side,
        limit_price:o.price,remaining_btc:o.remaining,placed_at:o.virtualPlacedAt})),
      observed_order_count:this.observedOrders.size,
      order_lifecycle_counts:{created:v.order_created,changed:v.order_changed,
        cancelled:v.order_cancelled,filled:v.order_filled,partial_fills:v.partial_fills},
      order_lifecycle_recent:v.order_events.slice(0,30),
      balance_usd:v.balance,equity_usd:equity,roi_pct:(equity/5000-1)*100,
      used_margin_usd:usedMargin,free_equity_usd:freeEquity,
      available_balance_usd:freeEquity,
      reserved_limit_margin_usd:reserve,free_after_limit_reserve_usd:afterReserve,
      margin_if_all_buys_fill_usd:buyExposure,margin_if_all_sells_fill_usd:sellExposure,
      pending_buy_btc:buyQty,pending_sell_btc:sellQty,
      pending_order_margin_model:'WORST_DIRECTION_STRESS_ONLY_NOT_RESERVED_BALANCE',
      stress_margin_if_all_orders_fill_usd:stressedMargin,
      pending_order_capacity_warning:afterReserve<0?'ACTIVE_LIMIT_ORDERS_EXCEED_VIRTUAL_MARGIN_CAPACITY':null,
      capital_utilization_pct:equity>0?100*usedMargin/equity:null,
      realized_gross_usd:v.gross,fees_usd:v.fees,net_realized_usd:v.gross-v.fees,
      unrealized_usd:unrealized,position_btc:v.qty,average_entry_price:v.avg,
      last_fill_price_proxy:mark,turnover_usd:v.turnover,
      completed_positions:v.closed_positions,wins:v.wins,losses:v.losses,
      win_rate_pct:v.closed_positions?100*v.wins/v.closed_positions:null,
      counts:{processed:v.events,eligible_maker_fills:v.eligible,
        skipped_unobserved_order:v.skipped_unknown_order,
        skipped_taker_or_unknown:v.skipped_not_maker,
        skipped_before_order:v.skipped_before_observed,
        skipped_price:v.skipped_limit,skipped_minimum:v.skipped_min,
        skipped_margin:v.skipped_margin,waiting_for_boundary:v.skipped_wait,
        skipped_backfill:v.skipped_backfill,duplicate:v.duplicate},
      target_fill_qty_btc:v.target_fill_qty,virtual_filled_qty_btc:v.filled_qty,
      missing_fill_qty_btc:ledgerMissing,
      historical_missing_counter_btc:v.missed_qty,
      ledger_target_fill_qty_btc:ledgerTarget,ledger_virtual_filled_qty_btc:ledgerVirtual,
      ledger_events:Number(ledger?.n||0),
      ledger_matches_historical_counters:ledgerMatchesCounters,
      target_minus_virtual_fill_qty_btc:targetMinusVirtual,
      fill_quantity_reconciliation_delta_btc:quantityDelta,
      fill_quantity_reconciled:Math.abs(quantityDelta)<1e-7 && ledgerMatchesCounters,
      target_position_scaled_btc:v.target_last*V463_SCALE,
      position_divergence_btc:v.qty-v.target_last*V463_SCALE,
      skipped_exhausted_orders:v.skipped_exhausted||0,
      stale_order_updates_ignored:v.stale_order_updates||0,
      last_execution_audit:v.last_execution_audit||null,
      reconciliation_delta_usd:v.balance-(5000+v.gross-v.fees),
      recent_events:v.recent,
      limitations:['Available balance excludes only used position margin; pending LIMIT exposure is stress-only.',
        'Historical reconciliation counters may differ from immutable D1 event sums; no historical P/L is rewritten.',
        'Virtual LIMIT orders are created at first observed order update/snapshot.',
        'Fill requires matching target maker fill, price, side and virtual resting quantity.',
        'A target fill does NOT guarantee our copy order would fill: no queue-position or order-book replay.',
        'Late updates, disconnected periods and unknown order priority can materially bias ROI.',
        'Pending margin is a worst-direction stress estimate, not a proven exchange reserve.',
        'Previous maker-proxy and V4.6.5 sessions are preserved in D1.'],trading_enabled:false};
  }

  private v463Equity(v:V463State,price:number):number {
    return v.balance + v.qty*(price-v.avg);
  }
  private v463Margin(v:V463State,price:number):number {
    return Math.abs(v.qty)*price/V463_LEVERAGE;
  }
  private v463Mark(v:V463State,price:number):void {
    if(price<=0)return;
    v.lastPrice=price;
    const eq=this.v463Equity(v,price);
    v.peak=Math.max(eq,v.peak);
    if(v.peak>0)v.drawdown=Math.max(v.drawdown,100*(v.peak-eq)/v.peak);
  }
  private async ensureV463():Promise<void> {
    if(this.v463Ready)return;
    await this.ensureDb();
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_v463_sessions (
      wallet TEXT NOT NULL, session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      state_json TEXT NOT NULL, PRIMARY KEY(wallet,session_id))`).run();
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_v463_events (
      wallet TEXT NOT NULL, session_id TEXT NOT NULL, fill_id TEXT NOT NULL,
      event_at INTEGER NOT NULL, payload_json TEXT NOT NULL,
      PRIMARY KEY(wallet,session_id,fill_id))`).run();
    await this.env.DB.prepare(`CREATE INDEX IF NOT EXISTS trader_watch_v463_events_order
      ON trader_watch_v463_events(wallet,session_id,event_at)`).run();
    const last:any=await this.env.DB.prepare(`SELECT state_json FROM trader_watch_v463_sessions
      WHERE wallet=? ORDER BY created_at DESC LIMIT 1`).bind(TARGET).first();
    this.v463=last?.state_json?JSON.parse(last.state_json):freshV463();
    if(!last)await this.persistV463(this.v463!);
    this.v463Ready=true;
  }
  private async persistV463(v:V463State):Promise<void> {
    await this.env.DB.prepare(`INSERT INTO trader_watch_v463_sessions
      (wallet,session_id,created_at,state_json) VALUES(?,?,?,?)
      ON CONFLICT(wallet,session_id) DO UPDATE SET state_json=excluded.state_json`)
      .bind(TARGET,v.sessionId,v.startedAt,JSON.stringify(v)).run();
  }
  // Preserve all prior V4/V4.6 data. This endpoint creates only a new virtual session.
  private async newV463():Promise<any> {
    await this.ensureV463();
    const v=freshV463();
    await this.persistV463(v);
    this.v463=v;
    return this.v463Report();
  }
  private async applyV463(f:NormalFill,action:Action):Promise<void> {
    await this.ensureV463();
    const current=this.v463!;
    if(f.at<current.startedAt)return;
    // Only fresh live WS fills may change simulated money. Backfill is never
    // retrospectively executed; a recovered missing live fill pauses accuracy.
    if(f.source!=='WS_LIVE') {
      current.skippedBackfill++;
      if(current.phase==='TRACKING') {current.phase='PAUSED_GAP';current.gapCount++;
        current.pauseReason='MISSING_LIVE_FILL_RECOVERED_BY_API:'+f.id;current.pausedAt=Date.now();}
      await this.persistV463(current);
      return;
    }
    const already:any=await this.env.DB.prepare(`SELECT fill_id FROM trader_watch_v463_events
      WHERE wallet=? AND session_id=? AND fill_id=?`)
      .bind(TARGET,current.sessionId,f.id).first();
    if(already){current.duplicates++;return;}
    // A cloned state avoids updating in-memory equity before durable persistence.
    const v:V463State=JSON.parse(JSON.stringify(current));
    let status='APPLIED',gross=0,fee=0,executed=0;
    let closeAudit:any=null; let completedPosition:any=null;
    const price=f.price;
    const startSide=direction(f.start),endSide=direction(f.end);
    const boundary=(startSide===0&&endSide!==0)||(startSide!==0&&endSide!==0&&startSide!==endSide);
    if(v.phase==='WAITING_FOR_NEW_POSITION') {
      if(!boundary){status='WAITING_FOR_NEW_POSITION';}
      else {
        // First live boundary is an entirely new position. Do NOT copy the
        // closing leg of a reversal that predates the session.
        const desired=f.end*V463_SCALE;
        const notional=Math.abs(desired)*price;
        if(notional<V463_MIN_ORDER_USD)status='NEW_OPEN_BELOW_MINIMUM_WAIT';
        else if(notional/V463_LEVERAGE+notional*V463_FEE>v.balance)status='NEW_OPEN_MARGIN_WAIT';
        else {
          v.phase='TRACKING';v.positionId++;v.positionStartedAt=f.at;
          v.qty=desired;v.targetQty=desired;v.avg=price;
          executed=notional;fee=notional*V463_FEE;
          v.balance-=fee;v.fees+=fee;v.positionFees=fee;
          v.positionEntryPrice=price;v.positionInitialQty=desired;
          v.positionExitQty=0;v.positionTurnover=notional;v.positionFeesOpen=fee;v.positionCloseCount=0;
          v.tradedNotional+=notional;v.opens++;
          status='NEW_POSITION_STARTED';
        }
      }
    } else if(v.phase==='PAUSED_GAP')status='PAUSED_GAP_REQUIRES_NEW_SESSION';
    else {
      // A true boundary is detected from signed quantities, NOT UI labels.
      // Position sizing is anchored to target equity ratio, and tiny fills
      // accumulate until the difference becomes exchange-executable.
      const desired=f.end*V463_SCALE;
      const diff=desired-v.qty;
      const crossing=direction(v.qty)!==0&&direction(desired)!==0&&direction(v.qty)!==direction(desired);
      const fullClose=endSide===0;
      const sameSide=direction(v.qty)===direction(desired)&&direction(desired)!==0;
      if(Math.abs(diff)*price<V463_MIN_ORDER_USD && !fullClose && !crossing){
        status='DEFERRED_BELOW_MIN_NOTIONAL';v.belowMinimum++;
      } else {
        const oldQty=v.qty;
        const oldSign=direction(oldQty);
        const closing=oldSign!==0 && (fullClose||crossing||!sameSide||Math.abs(desired)<Math.abs(oldQty));
        // A full close must settle the ACTUAL simulated remainder, including
        // accumulated sub-minimum deviations; never silently zero residual BTC.
        const closeQty=closing?(fullClose||crossing?Math.abs(oldQty):Math.min(Math.abs(oldQty),Math.abs(diff))):0;
        const openQty=crossing?Math.abs(desired):closing?0:Math.abs(diff);
        const closeNotional=closeQty*price;
        const openNotional=openQty*price;
        const oldEq=this.v463Equity(v,price);
        const oldMargin=this.v463Margin(v,price);
        const released=closeNotional/V463_LEVERAGE;
        const required=openNotional/V463_LEVERAGE;
        const operationFee=(closeNotional+openNotional)*V463_FEE;
        if(required>oldEq-oldMargin+released-operationFee+1e-7){
          status='MARGIN_REJECTED';v.marginRejected++;
          // Stop claiming exact copying after an unfilled target ADD.
          v.phase='PAUSED_GAP';v.gapCount++;
          v.pauseReason='INSUFFICIENT_MARGIN_AT_FILL:'+f.id;v.pausedAt=Date.now();
        } else {
          if(closeQty>0){
            const avgBefore=v.avg;
            const profit=closeQty*oldSign*(price-avgBefore);
            closeAudit={side:sideName(oldQty),closed_btc:closeQty,average_entry_price:avgBefore,
              exit_price:price,price_difference_signed:oldSign*(price-avgBefore),
              realized_gross_usd:profit,close_fee_usd:closeNotional*V463_FEE,
              formula:'closed_btc * side_sign * (exit_price - average_entry_price)'};
            v.positionExitQty=(v.positionExitQty||0)+closeQty;
            v.positionCloseCount=(v.positionCloseCount||0)+1;
            gross+=profit;v.balance+=profit;v.gross+=profit;v.positionGross+=profit;
            v.qty-=oldSign*closeQty;
          }
          if(openQty>0){
            const newSign=direction(desired);
            const signedOpen=newSign*openQty;
            const oldAbs=Math.abs(v.qty);
            v.avg=oldAbs>EPS?(oldAbs*v.avg+openQty*price)/(oldAbs+openQty):price;
            v.qty+=signedOpen;
          }
          // Fee is charged on actual simulated executed BTC, once per fill.
          executed=closeNotional+openNotional;
          fee=operationFee;
          v.balance-=fee;v.fees+=fee;
          // On reversal, the opening fee belongs to the NEXT position.
          v.positionFees+=crossing?closeNotional*V463_FEE:fee;
          v.tradedNotional+=executed;
          v.positionTurnover=(v.positionTurnover||0)+closeNotional+(crossing?0:openNotional);
          v.targetQty=desired;
          if(crossing||fullClose||Math.abs(v.qty)<EPS){
            const net=v.positionGross-v.positionFees;
            completedPosition={position_id:v.positionId,started_at:v.positionStartedAt,
              ended_at:f.at,side:sideName(oldQty),initial_entry_price:v.positionEntryPrice||null,
              initial_qty_btc:v.positionInitialQty||null,final_average_entry_price:closeAudit?.average_entry_price??null,
              last_exit_price:price,closed_qty_btc:v.positionExitQty||0,
              close_operations:v.positionCloseCount||0,
              traded_notional_usd:v.positionTurnover||0,
              gross_realized_usd:v.positionGross,fees_usd:v.positionFees,net_realized_usd:net,
              gross_result:Math.abs(v.positionGross)<1e-9?'FLAT':v.positionGross>0?'WIN':'LOSS',
              net_result:Math.abs(net)<1e-9?'FLAT':net>0?'WIN':'LOSS',
              exit_reason:crossing?'REVERSAL':'CLOSE'};
            v.closedPositions=[...(v.closedPositions||[]),completedPosition].slice(-100);
            v.completed++;if(net>0)v.wins++;else if(net<0)v.losses++;
            if(crossing)v.reversalCount++;else v.closes++;
            v.positionGross=0;v.positionFees=0;
            v.positionTurnover=0;v.positionExitQty=0;v.positionCloseCount=0;
            if(crossing){v.positionId++;v.positionStartedAt=f.at;
              v.positionEntryPrice=price;v.positionInitialQty=v.qty;
              v.positionTurnover=openNotional;v.positionFeesOpen=openNotional*V463_FEE;
              // The opening leg of a reversal belongs to the NEW position.
              v.positionFees=openNotional*V463_FEE;
              // The opening fee is carried forward, not charged twice.
            }else {v.qty=0;v.avg=0;v.targetQty=0;v.positionEntryPrice=0;v.positionInitialQty=0;v.positionFeesOpen=0;}
          } else if(closeQty>0)v.partials++;
          else if(openQty>0)v.adds++;
        }
      }
    }
    // Record every new WS event, including deferred and waiting events, idempotently.
    this.v463Mark(v,price);
    v.lastFillId=f.id;v.lastFillAt=f.at;v.applied++;
    const ev={id:f.id,at:f.at,action,source:f.source,targetStart:f.start,targetEnd:f.end,
      price,beforeQty:current.qty,afterQty:v.qty,executedNotionalUsd:executed,
      realizedUsd:gross,feeUsd:fee,status,phase:v.phase,positionId:v.positionId,
      close_pnl_audit:closeAudit,completed_position:completedPosition,
      avg_entry_before:current.avg,avg_entry_after:v.avg,
      balance_before:current.balance,balance_after:v.balance,
      pnl_reconciliation_delta_usd:v.balance-(current.balance+gross-fee)};
    v.recent.push(ev);v.recent=v.recent.slice(-60);
    // D1 batch is transactional: event and balance checkpoint commit together.
    await this.env.DB.batch([
      this.env.DB.prepare(`INSERT OR IGNORE INTO trader_watch_v463_events
        (wallet,session_id,fill_id,event_at,payload_json) VALUES(?,?,?,?,?)`)
        .bind(TARGET,v.sessionId,f.id,f.at,JSON.stringify(ev)),
      this.env.DB.prepare(`INSERT INTO trader_watch_v463_sessions
        (wallet,session_id,created_at,state_json) VALUES(?,?,?,?)
        ON CONFLICT(wallet,session_id) DO UPDATE SET state_json=excluded.state_json`)
        .bind(TARGET,v.sessionId,v.startedAt,JSON.stringify(v))
    ]);
    this.v463=v;
  }
  private async v463Report():Promise<any> {
    await this.ensureV463();
    const v=this.v463!;
    const price=v.lastPrice||v.avg;
    const unrealized=v.qty*(price-v.avg);
    const equity=v.balance+unrealized;
    const margin=this.v463Margin(v,price);
    return {ok:true,version:VERSION,mode:'VIRTUAL_ONLY_NO_REAL_ORDERS',
      session_id:v.sessionId,started_at:v.startedAt,phase:v.phase,
      pause_reason:v.pauseReason||null,paused_at:v.pausedAt||null,
      assumptions:{initial_balance_usd:V463_BALANCE,leverage:V463_LEVERAGE,
        reference_trader_equity_usd:V463_TARGET_EQUITY_REFERENCE,
        reference_equity_is_estimate:true,copy_scale:V463_SCALE,
        taker_fee_rate:V463_FEE,minimum_order_notional_usd:V463_MIN_ORDER_USD,
        min_order_is_simulation_assumption:true,slippage_bps:0,
        execution_price:'TRADER_FILL_PROXY_NOT_GUARANTEED',
        session_start:'FIRST_NEW_VERIFIED_WS_OPEN_OR_REVERSAL_AFTER_SESSION_CREATION',
        no_liquidation_engine:true},
      equity_usd:equity,balance_usd:v.balance,roi_pct:100*(equity-V463_BALANCE)/V463_BALANCE,
      free_equity_usd:equity-margin,used_margin_usd:margin,
      position_btc:v.qty,target_scaled_position_btc:v.targetQty,
      average_entry_price:v.avg,latest_mark_price:price,
      realized_gross_usd:v.gross,unrealized_usd:unrealized,
      fees_usd:v.fees,net_realized_usd:v.gross-v.fees,
      traded_notional_usd:v.tradedNotional,
      closed_trades:v.completed,wins:v.wins,losses:v.losses,
      win_rate_pct:v.completed?100*v.wins/v.completed:null,
      max_drawdown_pct:v.drawdown,
      execution_counts:{events:v.applied,opens:v.opens,adds:v.adds,partials:v.partials,
        closes:v.closes,reversals:v.reversalCount,below_minimum_deferred:v.belowMinimum,
        margin_rejected:v.marginRejected,skipped_backfill:v.skippedBackfill,
        duplicates:v.duplicates,gaps:v.gapCount},
      fee_reconciliation_usd:v.tradedNotional*V463_FEE,
      fee_reconciliation_delta_usd:v.fees-v.tradedNotional*V463_FEE,
      balance_reconciliation_delta_usd:v.balance-(V463_BALANCE+v.gross-v.fees),
      equity_reconciliation_delta_usd:equity-(V463_BALANCE+v.gross-v.fees+unrealized),
      current_position_audit:{position_id:v.positionId,started_at:v.positionStartedAt,
        side:sideName(v.qty),initial_entry_price:v.positionEntryPrice||null,
        initial_qty_btc:v.positionInitialQty||0,average_entry_price:v.avg,
        current_qty_btc:v.qty,closed_qty_btc:v.positionExitQty||0,
        partial_close_operations:v.positionCloseCount||0,
        gross_realized_usd:v.positionGross,allocated_fees_usd:v.positionFees,
        net_realized_usd:v.positionGross-v.positionFees,
        turnover_usd:v.positionTurnover||0},
      completed_positions:(v.closedPositions||[]).slice(-30),
      pnl_audit_note:'Historical sessions keep their original accounting; new audit fields are populated only by future fills.',
      recent_events:v.recent.slice(-50),trading_enabled:false};
  }

  private async virtualReport():Promise<any> {
    await this.ensureVirtual();
    const v=this.s.virtualV46!;
    const mark=v.lastMarkPrice || v.avgPrice;
    const unrealized=v.qty*(mark-v.avgPrice);
    const equity=v.balanceUsd+unrealized;
    const margin=this.virtualUsedMargin(v,mark);
    return {ok:true,version:VERSION,mode:'VIRTUAL_ONLY_NO_REAL_ORDERS',
      assumptions:{initial_balance_usd:50,margin_per_fresh_open_usd:10,leverage:5,
        fresh_open_notional_usd:50,taker_fee_rate:VIRTUAL_TAKER_FEE_RATE,
        slippage_bps:VIRTUAL_SLIPPAGE_BPS,pricing:'TRADER_FILL_PRICE_PROXY_NOT_EXECUTABLE_COPY_PRICE',
        copy_rule:'PERCENTAGE_OF_BTC_QTY',
        history:'NEW_WS_FILLS_AFTER_V4_6_ACTIVATION_ONLY; NO_RETROACTIVE_TRADES',
        margin_rule:'REJECT_OPEN_OR_ADD_IF_INSUFFICIENT_FREE_EQUITY; NO_LIQUIDATION_ENGINE'},
      started_at:v.startedAt,latest_mark_price:mark,position_btc:v.qty,
      average_entry_price:v.avgPrice,used_margin_usd:margin,
      free_equity_usd:equity-margin,realized_gross_usd:v.realizedUsd,
      unrealized_usd:unrealized,fees_usd:v.feesUsd,net_realized_usd:v.realizedUsd-v.feesUsd,
      equity_usd:equity,roi_pct:100*(equity-v.initialBalanceUsd)/v.initialBalanceUsd,
      closed_trades:v.closedTrades,wins:v.wins,losses:v.losses,
      win_rate_pct:v.closedTrades?100*v.wins/v.closedTrades:null,
      max_drawdown_pct:v.maxDrawdownPct,events:v.events,skipped_historical_or_backfill:v.skipped,
      blocked_adds:v.blockedAdds,rejected_opens:v.rejectedOpens,
      recent_events:v.recent.slice(-50),trading_enabled:false};
  }

  // Apply one verified fill, keeping exactly the V4.4 ratio and reversal rules.
  private async appendFill(f: NormalFill): Promise<void> {
    const start = Number(this.s.targetSigned);
    if (!same(f.start, start)) throw new Error('APPEND_POSITION_DISCONTINUITY');
    const action = actionOf(f);
    const before = this.s.copySigned;
    let copy = before, ratio = this.s.ratio;
    let enabled = this.s.copyEnabled;
    let copied = false, reason = '';
    if (!enabled) {
      if (action === 'REVERSAL' && direction(f.end) !== 0) {
        ratio = START_NOTIONAL_USD / (Math.abs(f.end) * f.price);
        copy = f.end * ratio;
        enabled = true;
        copied = true;
        reason = 'FRESH_REVERSAL_BOUNDARY';
      } else if (direction(f.end) === 0) {
        copy = 0; ratio = 0; enabled = true;
        reason = 'PREEXISTING_POSITION_REACHED_FLAT';
      } else reason = 'PREEXISTING_POSITION_NOT_COPIED';
    } else {
      if (action === 'OPEN' || action === 'REVERSAL') {
        ratio = START_NOTIONAL_USD / (Math.abs(f.end) * f.price);
        copy = f.end * ratio;
      } else if (action === 'CLOSE') { copy = 0; ratio = 0; }
      else copy = f.end * ratio;
      copied = true; reason = 'CHAIN_VERIFIED';
    }
    const row: Row = {id:f.id,at:f.at,receivedAt:f.receivedAt,source:f.source,
      action,start:f.start,end:f.end,size:f.size,price:f.price,
      targetSide:sideName(f.end),copyBefore:before,copyAfter:copy,copied,reason};
    // Persist the action BEFORE advancing the checkpoint. Retry is idempotent.
    await this.writeAction(row);
    // V4.6 is archived; only the independent V4.6.3 session is advanced.
    await this.applyMaker(f);
    this.s.targetSigned = f.end;
    this.s.copySigned = copy;
    this.s.ratio = ratio;
    this.s.copyEnabled = enabled;
    this.s.ledgerCount++;
    this.s.lastFillAt = f.at;
    this.s.stats.fills++;
    if (f.source === 'API_BACKFILL') this.s.stats.apiRecovered++;
    if (copied) {
      this.s.stats.copyActions++;
      const key = {OPEN:'opens',ADD:'adds',PARTIAL_CLOSE:'partials',
        CLOSE:'closes',REVERSAL:'reversals'}[action] as keyof Stats;
      this.s.stats[key]++;
    }
    this.s.recent.push(row);
    this.s.recent = this.s.recent.slice(-MAX_RECENT);
    this.incrementalActions++;
  }

  constructor(private ctx: any, private env: any) {
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('traderWatchV41');
      if (saved && saved.schema === 41) this.s = saved;
      this.s.connected = false;
      if (this.s.active || (await ctx.storage.get("multiCoinV1"))?.active) await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put('traderWatchV41', this.s);
  }

  private async ensureDb(): Promise<void> {
    if (this.databaseReady) return;
    if (!this.env.DB) throw new Error('DB_BINDING_MISSING');
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_v4_fills (
      wallet TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      fill_id TEXT NOT NULL,
      event_at INTEGER NOT NULL,
      received_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      start_qty REAL NOT NULL,
      end_qty REAL NOT NULL,
      fill_qty REAL NOT NULL,
      price REAL NOT NULL,
      side TEXT NOT NULL,
      PRIMARY KEY (wallet, epoch, fill_id)
    )`).run();
    await this.env.DB.prepare(`CREATE TABLE IF NOT EXISTS trader_watch_v4_actions (
      wallet TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      fill_id TEXT NOT NULL,
      event_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (wallet, epoch, fill_id)
    )`).run();
    await this.env.DB.prepare(`CREATE INDEX IF NOT EXISTS trader_watch_v4_fills_order
      ON trader_watch_v4_fills(wallet, epoch, event_at)`).run();
    this.databaseReady = true;
  }

  private async info(body: unknown): Promise<any> {
    const r = await fetch(INFO_URL, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error('HYPERLIQUID_INFO_HTTP_' + r.status);
    return r.json();
  }

  // Retain snapshots across newer polls. A 30-second poll must not overwrite
  // the snapshot waiting for the 60-second API audit.
  // Only a completed API audit through responseAt can verify a snapshot.
  private async evaluateSnapshotAlignment(): Promise<void> {
    const pending = this.s.pendingSnapshots || [];
    if (!pending.length || this.s.baselineSigned === null) return;
    if (this.s.replayGap) {
      this.s.snapshotSyncStatus = 'FILL_CHAIN_GAP';
      this.s.needsAudit = true;
      return;
    }
    const ready = pending.filter(x => x.responseAt <= this.s.auditCursor);
    if (!ready.length) {
      this.s.snapshotSyncStatus = 'AWAITING_API_AUDIT';
      return;
    }
    const fills = await this.ledger();
    const {ordered,gap} = this.chain(fills);
    if (gap) {
      this.s.snapshotSyncStatus = 'FILL_CHAIN_GAP';
      this.s.needsAudit = true;
      return;
    }
    const counters = this.s.snapshotChecks || {matched:0,mismatched:0,raced:0,pendingExpired:0};
    for (const shot of ready) {
      let status = 'MATCHED_AT_SNAPSHOT_TIME';
      let aligned: number | null = Number(this.s.baselineSigned);
      let delta: number | null = null;
      // The exchange has no sequence number for the clearinghouse snapshot.
      // Reject snapshots whose request overlaps any fill, rather than guessing.
      if (ordered.some(f => f.at >= shot.requestAt && f.at <= shot.responseAt)) {
        status = 'SNAPSHOT_RACE_WITH_FILLS';
        aligned = null;
        counters.raced++;
      } else {
        for (const f of ordered) {
          if (f.at > shot.requestAt) break;
          aligned = f.end;
        }
        delta = shot.signed - Number(aligned);
        if (same(delta,0)) counters.matched++;
        else {status='CONFIRMED_MISMATCH_AFTER_AUDIT';counters.mismatched++;this.s.needsAudit=true;}
      }
      const check = {requestAt:shot.requestAt,responseAt:shot.responseAt,
        checkedAt:Date.now(),exchangeSigned:shot.signed,ledgerSigned:aligned,delta,status};
      this.s.lastSnapshotCheck = check;
      if (status === 'MATCHED_AT_SNAPSHOT_TIME') this.s.lastVerifiedSnapshot = {
        requestAt:shot.requestAt,responseAt:shot.responseAt,verifiedAt:check.checkedAt,
        exchangeSigned:shot.signed,ledgerSigned:Number(aligned),delta:0,status};
      // Current snapshot fields describe only the latest snapshot, not an old one.
      if (shot.responseAt === this.s.snapshotResponseAt) {
        this.s.snapshotSyncStatus = status;
        this.s.snapshotAlignedTarget = aligned;
        this.s.snapshotMismatch = status === 'CONFIRMED_MISMATCH_AFTER_AUDIT' ? delta : null;
        this.s.snapshotConfirmedMismatch = status === 'CONFIRMED_MISMATCH_AFTER_AUDIT';
      }
    }
    this.s.snapshotChecks = counters;
    this.s.pendingSnapshots = pending.filter(x => x.responseAt > this.s.auditCursor);
    if (this.s.pendingSnapshots.length) this.s.snapshotSyncStatus = 'AWAITING_API_AUDIT';
  }

  private async snapshot(force = false): Promise<void> {
    if (!force && Date.now() < this.s.nextSnapshotAt) return;
    this.s.nextSnapshotAt = Date.now() + SNAPSHOT_INTERVAL_MS;
    try {
      const started = Date.now();
      const data = await this.info({ type: 'clearinghouseState', user: TARGET });
      const completed = Date.now();
      const pos = data.assetPositions?.find((p: any) => p.position?.coin === 'BTC')?.position;
      const signed = pos ? Number(pos.szi) : 0;
      if (!Number.isFinite(signed)) throw new Error('INVALID_SNAPSHOT');
      this.s.snapshotSigned = signed;
      this.s.lastSnapshotAt = completed;
      this.s.snapshotRequestAt = started;
      this.s.snapshotResponseAt = completed;
      if (this.s.baselineSigned === null) {
        this.s.baselineSigned = signed;
        this.s.targetSigned = signed;
        this.s.baselineAt = completed;
        this.s.auditCursor = completed;
        this.s.copyEnabled = direction(signed) === 0;
        this.s.snapshotAlignedTarget = signed;
        this.s.snapshotSyncStatus = 'BASELINE_ESTABLISHED';
        this.s.snapshotMismatch = null;
      } else {
        this.s.snapshotSyncStatus = 'AWAITING_API_AUDIT';
        this.s.snapshotAlignedTarget = null;
        this.s.snapshotMismatch = null;
        this.s.snapshotConfirmedMismatch = false;
        const pending = this.s.pendingSnapshots || [];
        pending.push({requestAt:started,responseAt:completed,signed});
        // Bound persisted state without discarding the most recent samples.
        if (pending.length > 24) {
          const dropped = pending.length - 24;
          pending.splice(0,dropped);
          const c = this.s.snapshotChecks || {matched:0,mismatched:0,raced:0,pendingExpired:0};
          c.pendingExpired += dropped;
          this.s.snapshotChecks = c;
        }
        this.s.pendingSnapshots = pending;
        // Do not run a full-ledger comparison on every 30-second snapshot.
        // The completed API audit will verify all snapshots it covers.
      }
    } catch (e) {
      this.s.lastError = 'SNAPSHOT: ' + String(e);
      this.s.snapshotSyncStatus = 'SNAPSHOT_ERROR';
      if (String(e).includes('429')) this.s.nextSnapshotAt = Date.now() + 120000;
    }
    await this.save();
  }

  private async insertFill(f: NormalFill): Promise<boolean> {
    if (!this.s.baselineAt || f.at < this.s.baselineAt) return false;
    await this.ensureDb();
    const result = await this.env.DB.prepare(`INSERT OR IGNORE INTO trader_watch_v4_fills
      (wallet,epoch,fill_id,event_at,received_at,source,start_qty,end_qty,fill_qty,price,side)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).bind(
      TARGET, this.s.epoch, f.id, f.at, f.receivedAt, f.source,
      f.start, f.end, f.size, f.price, f.side,
    ).run();
    const changed = Number(result?.meta?.changes || 0) > 0;
    if (!changed) this.s.stats.duplicates++;
    return changed;
  }

  private async ledger(): Promise<NormalFill[]> {
    await this.ensureDb();
    // D1 results may be paginated. Walk the complete epoch, not only last 5 minutes.
    const result: NormalFill[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.env.DB.prepare(`SELECT fill_id,event_at,received_at,source,
        start_qty,end_qty,fill_qty,price,side FROM trader_watch_v4_fills
        WHERE wallet=? AND epoch=? ORDER BY event_at ASC, fill_id ASC LIMIT 500 OFFSET ?`)
        .bind(TARGET, this.s.epoch, offset).all();
      const rows: any[] = page.results || [];
      for (const r of rows) result.push({
        id: r.fill_id, at: Number(r.event_at), receivedAt: Number(r.received_at),
        source: r.source, start: Number(r.start_qty), end: Number(r.end_qty),
        size: Number(r.fill_qty), price: Number(r.price), side: r.side,
      });
      if (rows.length < 500) break;
      offset += rows.length;
      if (offset > 100000) throw new Error('LEDGER_TOO_LARGE_FOR_INLINE_REPLAY');
    }
    return result;
  }

  private chain(fills: NormalFill[]): { ordered: NormalFill[]; gap: boolean } {
    const remaining = fills.slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const ordered: NormalFill[] = [];
    let expected = Number(this.s.baselineSigned);
    let gap = false;
    while (remaining.length) {
      // Prefer a fill that starts exactly where the preceding fill ended.
      // This resolves same-millisecond executions without relying on fill ID order.
      let index = remaining.findIndex(f => same(f.start, expected));
      if (index < 0) {
        gap = true;
        break;
      }
      const f = remaining.splice(index, 1)[0];
      ordered.push(f);
      expected = f.end;
    }
    return { ordered, gap: gap || remaining.length > 0 };
  }

  private async replay(): Promise<void> {
    if (this.s.baselineSigned === null) return;
    const fills = await this.ledger();
    const { ordered, gap } = this.chain(fills);
    let target = Number(this.s.baselineSigned);
    let copy = 0;
    let ratio = 0;
    let enabled = direction(target) === 0;
    const stats: Stats = { fills: fills.length, copyActions: 0, opens: 0,
      adds: 0, partials: 0, closes: 0, reversals: 0,
      duplicates: this.s.stats.duplicates, gaps: gap ? 1 : 0,
      apiRecovered: fills.filter(f => f.source === 'API_BACKFILL').length,
      writeFailures: this.s.stats.writeFailures };
    const actions: Row[] = [];
    for (const f of ordered) {
      const action = actionOf(f);
      const before = copy;
      let copied = false;
      let reason = '';
      if (!enabled) {
        if (action === 'REVERSAL' && direction(f.end) !== 0) {
          // New opposite-side exposure can be copied from this known boundary.
          ratio = START_NOTIONAL_USD / (Math.abs(f.end) * f.price);
          copy = f.end * ratio;
          enabled = true;
          copied = true;
          reason = 'FRESH_REVERSAL_BOUNDARY';
        } else if (direction(f.end) === 0) {
          copy = 0;
          ratio = 0;
          enabled = true;
          reason = 'PREEXISTING_POSITION_REACHED_FLAT';
        } else {
          reason = 'PREEXISTING_POSITION_NOT_COPIED';
        }
      } else {
        if (action === 'OPEN' || action === 'REVERSAL') {
          ratio = START_NOTIONAL_USD / (Math.abs(f.end) * f.price);
          copy = f.end * ratio;
        } else if (action === 'CLOSE') {
          copy = 0;
          ratio = 0;
        } else {
          copy = f.end * ratio;
        }
        copied = true;
        reason = 'CHAIN_VERIFIED';
      }
      target = f.end;
      if (copied) {
        stats.copyActions++;
        const key = { OPEN: 'opens', ADD: 'adds', PARTIAL_CLOSE: 'partials',
          CLOSE: 'closes', REVERSAL: 'reversals' }[action] as keyof Stats;
        stats[key]++;
      }
      actions.push({ id: f.id, at: f.at, receivedAt: f.receivedAt,
        source: f.source, action, start: f.start, end: f.end,
        size: f.size, price: f.price, targetSide: sideName(f.end),
        copyBefore: before, copyAfter: copy, copied, reason });
    }
    // Incomplete chain: keep only proven actions; NEVER claim live synchronization.
    this.s.replayGap = gap;
    this.s.needsAudit = gap || this.s.needsAudit;
    this.s.targetSigned = target;
    this.s.copySigned = copy;
    this.s.ratio = ratio;
    this.s.copyEnabled = enabled && !gap;
    this.s.ledgerCount = fills.length;
    this.s.lastFillAt = ordered.length ? ordered[ordered.length - 1].at : 0;
    this.s.stats = stats;
    this.s.recent = actions.slice(-MAX_RECENT);
    // Rebuild action projection from the canonical fill ledger.
    // These are virtual actions, not orders.
    await this.ensureDb();
    // D1 batch executes ordered prepared statements with far fewer round trips.
    // Never delete existing actions; retries remain idempotent.
    const recoveryStart = Date.now();
    for (let i = 0; i < actions.length; i += 80) {
      const statements = actions.slice(i, i + 80).map(row =>
        this.env.DB.prepare(`INSERT INTO trader_watch_v4_actions
          (wallet,epoch,fill_id,event_at,payload_json) VALUES (?,?,?,?,?)
          ON CONFLICT(wallet,epoch,fill_id) DO UPDATE SET
          event_at=excluded.event_at,payload_json=excluded.payload_json`)
          .bind(TARGET, this.s.epoch, row.id, row.at, JSON.stringify(row)));
      await this.env.DB.batch(statements);
      this.recoveryRowsWritten += statements.length;
    }
    this.lastRecoveryMs = Date.now() - recoveryStart;
    await this.save();
  }

  private async ingestMany(raw: RawFill[], source: Source, receivedAt?: number): Promise<void> {
    if (!this.s.baselineAt) return;
    const processingStartedAt = Date.now();
    const freshRows: { f: NormalFill; d1DoneAt: number }[] = [];
    // Check the persisted checkpoint BEFORE inserting new rows.
    await this.verifyProjection();
    for (const x of raw) {
      const f = normalize(x, source);
      if (!f) continue;
      if (await this.insertFill(f)) freshRows.push({ f, d1DoneAt: Date.now() });
    }
    const replayStartedAt = Date.now();
    let fallback = false;
    if (freshRows.length) {
      // Append only when every newly inserted fill extends the verified prefix.
      // A late historical fill or missing predecessor triggers canonical recovery.
      const pending = freshRows.slice().sort((a,b) => a.f.at-b.f.at || a.f.id.localeCompare(b.f.id));
      let expected = Number(this.s.targetSigned);
      let lastAt = this.s.lastFillAt;
      const ordered: typeof pending = [];
      while (pending.length) {
        const i = pending.findIndex(x => x.f.at >= lastAt && same(x.f.start, expected));
        if (i < 0) { fallback = true; break; }
        const item = pending.splice(i,1)[0];
        ordered.push(item);
        expected = item.f.end;
        lastAt = item.f.at;
      }
      if (fallback) {
        this.recoveryReason = 'LATE_OR_OUT_OF_ORDER_FILL';
        this.recoveryReplays++;
        this.appendReady = false;
        await this.replay();
        if (!this.s.replayGap) this.appendReady = true;
      } else {
        try {
          for (const x of ordered) await this.appendFill(x.f);
          await this.save();
        } catch (e) {
          fallback = true;
          this.recoveryReason = 'APPEND_WRITE_FAILURE: ' + String(e);
          this.recoveryReplays++;
          this.appendReady = false;
          await this.replay();
          if (!this.s.replayGap) this.appendReady = true;
        }
      }
    } else await this.save();
    const copyReadyAt = Date.now();
    if (freshRows.length) {
      const samples = this.s.pipelineSamples || [];
      const receiveTime = receivedAt ?? processingStartedAt;
      for (const {f, d1DoneAt} of freshRows) samples.push({
        id:f.id,source,event_at:f.at,
        ws_callback_at:source==='WS_LIVE'?receiveTime:null,
        processing_started_at:processingStartedAt,
        d1_write_done_at:d1DoneAt,replay_started_at:replayStartedAt,
        copy_ready_at:copyReadyAt,
        exchange_to_callback_ms:source==='WS_LIVE'?receiveTime-f.at:null,
        callback_queue_ms:source==='WS_LIVE'?processingStartedAt-receiveTime:null,
        processing_to_d1_ms:d1DoneAt-processingStartedAt,
        d1_to_copy_ready_ms:copyReadyAt-d1DoneAt,
        replay_batch_ms:fallback?copyReadyAt-replayStartedAt:0,
        exchange_to_copy_ready_ms:copyReadyAt-f.at,
        batch_new_fills:freshRows.length,
        processing_mode:fallback?'RECOVERY_REPLAY':'INCREMENTAL',
      });
      this.s.pipelineSamples=samples.slice(-this.pipelineCap);
      await this.save();
    }
  }

  private async audit(force = false): Promise<void> {
    if (this.auditBusy || !this.s.baselineAt || (!force && Date.now() < this.s.nextApiAt)) return;
    this.auditBusy = true;
    this.s.nextApiAt = Date.now() + AUDIT_INTERVAL_MS;
    try {
      // Incremental API backfill with overlapping windows; never discard
      // an older fill just because newer WS fills were already processed.
      const end = Date.now();
      let cursor = Math.max(this.s.baselineAt, this.s.auditCursor - 30000);
      let pages = 0;
      while (cursor < end && pages < 15) {
        const upper = Math.min(end, cursor + MAX_API_WINDOW_MS);
        const raw = await this.info({ type: 'userFillsByTime', user: TARGET,
          startTime: cursor, endTime: upper, aggregateByTime: false });
        if (!Array.isArray(raw)) throw new Error('INVALID_API_FILLS');
        // Hyperliquid may cap results; do not silently mark a truncated window audited.
        if (raw.length >= 1900) throw new Error('API_WINDOW_POSSIBLY_TRUNCATED');
        await this.enqueue(() => this.ingestMany(raw, 'API_BACKFILL'));
        cursor = upper;
        this.s.auditCursor = cursor;
        pages++;
      }
      this.s.lastAuditAt = Date.now();
      if (cursor < end) this.s.needsAudit = true;
      else if (!this.s.replayGap) this.s.needsAudit = false;
      await this.evaluateSnapshotAlignment();
      if (!this.s.snapshotConfirmedMismatch && !this.s.replayGap) this.s.lastError = null;
    } catch (e) {
      this.s.needsAudit = true;
      this.s.lastError = 'AUDIT: ' + String(e);
      if (String(e).includes('429')) this.s.nextApiAt = Date.now() + 120000;
    } finally {
      this.auditBusy = false;
      await this.save();
    }
  }

  private connect(): void {
    if (!this.s.active || this.ws && [0, 1].includes(this.ws.readyState)) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (!this.s.active) { ws.close(); return; }
      this.s.connected = true;
      ws.send(JSON.stringify({ method: 'subscribe',
        subscription: { type: 'userFills', user: TARGET } }));
      ws.send(JSON.stringify({method:'subscribe',subscription:{type:'orderUpdates',user:TARGET}}));
      ws.send(JSON.stringify({method:'subscribe',subscription:{type:'openOrders',user:TARGET}}));
      void this.seedMakerOrders().catch(e=>{this.s.lastError='MAKER_ORDER_SEED: '+String(e)});
      this.save().catch(() => {});
      this.audit(true).catch(e => { this.s.lastError = String(e); });
    });
    ws.addEventListener('message', (ev: any) => {
      const callbackAt = Date.now();
      void this.enqueue(async () => {
        const msg = JSON.parse(String(ev.data));
        if(msg.channel==='orderUpdates'){await this.ingestMakerOrderUpdates(msg.data);return;}
        if(msg.channel==='openOrders'){
          const orders=Array.isArray(msg.data?.orders)?msg.data.orders:[];
          await this.ingestMakerOrderUpdates(orders.map((order:any)=>({order,status:'open'})));return;
        }
        if (msg.channel !== 'userFills') return;
        const payload = msg.data;
        const arr = Array.isArray(payload?.fills) ? payload.fills :
          Array.isArray(payload) ? payload : [];
        // Subscription historical events are ignored only if predating baseline.
        await this.ingestMany(arr, 'WS_LIVE', callbackAt);
        if (this.s.replayGap) { this.s.needsAudit = true; this.s.nextApiAt = 0; }
      }).catch(() => {});
    });
    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.s.connected = false;
      this.s.needsAudit = true;
      this.s.nextApiAt = 0;
      this.save().catch(() => {});
    };
    ws.addEventListener('close', down);
    ws.addEventListener('error', down);
  }

  // A single serial lane protects Multi-Coin's Durable Object state from
  // overlapping websocket frames and the periodic HTTP catch-up.
  private runMulti<T>(job:()=>Promise<T>):Promise<T>{
    const next=this.multiJobs.catch(()=>{}).then(job);
    this.multiJobs=next.then(()=>{},()=>{});
    return next;
  }
  private async notifyMultiCopy(route:'sync'|'order-sync'='sync'):Promise<void>{
    const service=this.env.LIVE_COPY_WORKER as {fetch(request:Request):Promise<Response>}|undefined;
    const token=this.env.LIVE_COPY_ADMIN_TOKEN as string|undefined;
    if(!service||!token){this.multiWsLastError='LIVE_COPY_SERVICE_OR_TOKEN_NOT_CONFIGURED';return;}
    try{
      const res=await service.fetch(new Request('https://live-copy.internal/'+route,{
        method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'
      }));
      if(!res.ok){
        const data:any=await res.json().catch(()=>null);
        if(!(data?.retryable===true&&data?.error==='HYPERLIQUID_RATE_LIMIT_BACKOFF')&&data?.error!=='STOPPED')
          this.multiWsLastError='LIVE_COPY_NOTIFY_HTTP_'+res.status+':'+JSON.stringify(data).slice(0,200);
      }
    }catch(e){this.multiWsLastError='LIVE_COPY_NOTIFY_FAILED: '+String(e);}
    // Notify is best-effort: controller retains its independent durable alarm.
  }
  private closeMultiWs(reason='stop'):void{
    if(this.multiWsTimer!==null){clearTimeout(this.multiWsTimer);this.multiWsTimer=null;}
    this.multiWsFrames=[];
    const ws=this.multiWs;this.multiWs=null;this.multiWsConnected=false;
    try{ws?.close(1000,reason)}catch{}
  }
  private enqueueMultiWsFills(fills:any[]):void{
    // Hyperliquid sends arrays of fills, and several messages may share a block.
    // Coalesce for 200ms so the source-position chain can be verified across them.
    this.multiWsFrames.push(...fills);
    if(this.multiWsFrames.length>2500){
      this.multiWsLastError='MULTI_WS_BUFFER_FULL_FALLBACK_TO_API';
      this.multiWsFrames=[];this.multiWsNextConnect=0;
      this.closeMultiWs('bounded buffer exceeded');
      void this.ctx.storage.setAlarm(Date.now()+1000);
      return;
    }
    if(this.multiWsTimer!==null)return;
    this.multiWsTimer=setTimeout(()=>{
      this.multiWsTimer=null;
      const batch=this.multiWsFrames.splice(0);
      void this.runMulti(async()=>{
        const result=await new MultiCoinEngine(this.ctx.storage,this.env.DB).ingestRealtime(batch);
        this.multiWsPending=result.pending;
        if(result.applied>0)await this.notifyMultiCopy();
        if(result.stored>0)await this.notifyMultiCopy('order-sync');
      }).catch(async e=>{
        this.multiWsLastError='MULTI_WS_INGEST_FAILED: '+String(e);
        await this.ctx.storage.setAlarm(Date.now()+1000).catch(()=>{});
      });
    },200);
  }
  private connectMultiWs():void{
    if(this.multiWs&&[0,1].includes(this.multiWs.readyState))return;
    if(Date.now()<this.multiWsNextConnect)return;
    let ws:WebSocket;
    try{ws=new WebSocket(WS_URL)}catch(e){
      this.multiWsLastError='MULTI_WS_CONNECT_FAILED: '+String(e);
      this.multiWsNextConnect=Date.now()+5000;return;
    }
    this.multiWs=ws;
    this.multiWsNextConnect=Date.now()+5000;
    ws.addEventListener('open',()=>{
      if(this.multiWs!==ws)return;
      this.multiWsConnected=true;this.multiWsLastRx=Date.now();
      ws.send(JSON.stringify({method:'subscribe',subscription:{type:'userFills',user:MC_WALLET,aggregateByTime:false}}));
      ws.send(JSON.stringify({method:'subscribe',subscription:{type:'orderUpdates',user:MC_WALLET}}));
    });
    ws.addEventListener('message',(ev:any)=>{
      if(this.multiWs!==ws)return;
      this.multiWsLastRx=Date.now();
      let msg:any;
      try{msg=JSON.parse(String(ev.data))}catch(e){this.multiWsLastError='MULTI_WS_INVALID_JSON';return;}
      if(msg.channel==='orderUpdates'){
        void this.runMulti(async()=>{
          const added=await new MultiCoinEngine(this.ctx.storage,this.env.DB).ingestOrderUpdates(msg.data);
          if(added>0)await this.notifyMultiCopy('order-sync');
        }).catch(e=>{this.multiWsLastError='MULTI_ORDER_UPDATES_FAILED: '+String(e)});
        return;
      }
      if(msg.channel!=='userFills')return;
      // Snapshot fills are also deduplicated against D1 and filtered by session
      // start. This prevents a reconnect gap from becoming a missed trade.
      if(msg.data?.user&&String(msg.data.user).toLowerCase()!==MC_WALLET.toLowerCase())return;
      const fills=Array.isArray(msg.data?.fills)?msg.data.fills:Array.isArray(msg.data)?msg.data:[];
      if(!fills.length)return;
      this.multiWsLastFill=Date.now();this.multiWsMessages++;
      this.enqueueMultiWsFills(fills);
    });
    const down=()=>{
      if(this.multiWs!==ws)return;
      this.multiWs=null;this.multiWsConnected=false;this.multiWsNextConnect=Date.now()+5000;
      void this.ctx.storage.setAlarm(Date.now()+1000);
    };
    ws.addEventListener('close',down);ws.addEventListener('error',down);
  }

  async alarm(): Promise<void> {
    const multi = new MultiCoinEngine(this.ctx.storage,this.env.DB);
    const mc = await multi.get();
    if(mc?.active){
      this.connectMultiWs();
      const now=Date.now();
      if(this.multiWs?.readyState===1&&now-this.multiWsLastPing>30000){
        try{this.multiWs.send(JSON.stringify({method:'ping'}));this.multiWsLastPing=now;}
        catch(e){this.multiWsLastError='MULTI_WS_PING_FAILED: '+String(e);this.closeMultiWs('ping failure');}
      }
      if(this.multiWsConnected&&this.multiWsLastRx&&now-this.multiWsLastRx>90000){
        this.multiWsLastError='MULTI_WS_STALE_RECONNECT';this.closeMultiWs('stale websocket');
      }
      // HTTP backfill is a recovery audit, not the normal event source.
      // It also maintains reference prices / order-observation diagnostics.
      if(now>=this.multiNextBackfill&&(!mc.lastPoll||now-mc.lastPoll>=60000||!this.multiWsConnected)){
        await this.runMulti(async()=>{
          const before:any=await this.env.DB.prepare('SELECT MAX(rowid) AS id FROM mc_watch_events').first();
          await multi.poll();
          const afterPoll=await multi.get();
          if(afterPoll?.lastError){
            this.multiWsLastError='MULTI_API_AUDIT: '+afterPoll.lastError;
            this.multiNextBackfill=Date.now()+(/429|RATE_LIMIT/i.test(afterPoll.lastError)?120000:30000);
          }else this.multiNextBackfill=Date.now()+60000;
          const recovered=await multi.drainRealtime();
          const left:any=await this.env.DB.prepare('SELECT COUNT(*) AS n FROM mc_watch_ws_inbox WHERE session_id=?').bind(mc.id).first();
          this.multiWsPending=Number(left?.n||0);
          const after:any=await this.env.DB.prepare('SELECT MAX(rowid) AS id FROM mc_watch_events').first();
          if(Number(after?.id||0)>Number(before?.id||0)||recovered>0)await this.notifyMultiCopy();
        }).catch(e=>{this.multiWsLastError='MULTI_BACKFILL_FAILED: '+String(e)});
      }else if(this.multiWsPending>0){
        await this.runMulti(async()=>{
          const recovered=await multi.drainRealtime();
          if(recovered>0)await this.notifyMultiCopy();
          const left:any=await this.env.DB.prepare('SELECT COUNT(*) AS n FROM mc_watch_ws_inbox WHERE session_id=?').bind(mc.id).first();
          this.multiWsPending=Number(left?.n||0);
        }).catch(e=>{this.multiWsLastError='MULTI_INBOX_DRAIN_FAILED: '+String(e)});
      }
      await this.ctx.storage.setAlarm(Date.now()+10000);
      return;
    }
    if(this.multiWs)this.closeMultiWs('multi session stopped');
    if(mc && !mc.active) return;
    if (!this.s.active || this.resetBusy) return;
    try {
      if (!this.ws || this.ws.readyState !== 1) this.connect();
      await this.snapshot();
      await this.audit();
      if(this.makerReady)await this.seedMakerOrders();
    } catch (e) {
      this.s.lastError = 'ALARM: ' + String(e);
    } finally {
      await this.save();
      if (this.s.active) await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  // V4.4: Bounded observational samples; no order submission or strategy changes.
  private pipelineAudit(): any {
    const retained: any[] = this.s.pipelineSamples || [];
    const samples = retained.filter(x => x.processing_mode === 'INCREMENTAL' || x.processing_mode === 'RECOVERY_REPLAY');
    const incremental = samples.filter(x => x.processing_mode === 'INCREMENTAL');
    const recovery = samples.filter(x => x.processing_mode === 'RECOVERY_REPLAY');
    const summarize = (rows: any[], key: string) => {
      const a = rows.map(r => r[key]).filter((v: any) => typeof v === 'number' && Number.isFinite(v)).sort((x: number,y: number) => x-y);
      const pct = (p: number) => a.length ? a[Math.min(a.length-1, Math.ceil(p*a.length)-1)] : null;
      return {count:a.length, p50_ms:pct(.5), p90_ms:pct(.9), p95_ms:pct(.95), max_ms:a.length?a[a.length-1]:null};
    };
    const metrics = (rows: any[]) => ({
      exchange_to_ws_callback: summarize(rows, 'exchange_to_callback_ms'),
      ws_callback_queue: summarize(rows, 'callback_queue_ms'),
      processing_to_d1: summarize(rows, 'processing_to_d1_ms'),
      d1_to_copy_ready: summarize(rows, 'd1_to_copy_ready_ms'),
      replay_batch: summarize(rows, 'replay_batch_ms'),
      exchange_to_copy_ready: summarize(rows, 'exchange_to_copy_ready_ms'),
    });
    return {ok:true, version:VERSION, mode:'READ_ONLY_OBSERVABILITY',
      epoch:this.s.epoch, samples:samples.length,
      retained_legacy_samples:retained.length-samples.length,
      diagnostic_started_at:this.diagnosticSince,
      incremental_samples:incremental.length,
      recovery_samples:recovery.length,
      incremental_only:metrics(incremental),
      recovery_only:metrics(recovery),
      recovery_d1_rows_written_since_restart:this.recoveryRowsWritten,
      last_recovery_d1_batch_ms:this.lastRecoveryMs,
      incremental_actions_since_restart:this.incrementalActions,
      recovery_replays_since_restart:this.recoveryReplays,
      last_recovery_reason:this.recoveryReason,
      queued_ingest_jobs:this.queuedJobs,
      ws_live:metrics(samples.filter(x=>x.source==='WS_LIVE')),
      api_backfill:metrics(samples.filter(x=>x.source==='API_BACKFILL')),
      overall:metrics(samples),
      slowest:samples.slice().sort((a,b)=>b.exchange_to_copy_ready_ms-a.exchange_to_copy_ready_ms).slice(0,12),
      caveats:[
        'WS callback is measured when this Durable Object receives a message event, not at the Hyperliquid server.',
        'D1 timing includes serial inserts and per-batch overhead; individual fill timing is not isolated.',
        'COPY ready means incremental projection persistence (or explicit recovery replay), not a real trade.',
        'Batch completion times are shared by all new fills in that batch.',
        'API backfill has no WS callback metric and is historical, not executable in real time.',
        'Main metrics exclude legacy V4.4 samples. Incremental and recovery modes are reported separately. Historical V4.5 samples remain included.',
      ]};
  }

  // V4.3: Observability only. The "latency" below measures detection/ingestion,
  // NOT real exchange order execution or a live fill of the virtual copy.
  private async executionAudit(limit = 5000): Promise<any> {
    await this.ensureDb();
    const rows: Row[] = [];
    let offset = 0;
    const cap = Math.max(100, Math.min(20000, limit));
    while (offset < cap) {
      const page: any = await this.env.DB.prepare(`SELECT payload_json FROM trader_watch_v4_actions
        WHERE wallet=? AND epoch=? ORDER BY event_at DESC,fill_id DESC LIMIT 500 OFFSET ?`)
        .bind(TARGET, this.s.epoch, offset).all();
      const batch: any[] = page.results || [];
      for (const x of batch) {
        try { rows.push(JSON.parse(x.payload_json)); } catch {}
      }
      offset += batch.length;
      if (batch.length < 500) break;
    }
    const latency = (a: Row[]) => a.map(r => r.receivedAt - r.at)
      .filter(x => Number.isFinite(x) && x >= 0).sort((a,b) => a-b);
    const percentile = (arr: number[], p: number) => arr.length
      ? arr[Math.min(arr.length-1, Math.ceil(arr.length*p)-1)] : null;
    const describe = (a: Row[]) => {
      const ms = latency(a);
      return { count: a.length, measured: ms.length,
        p50_ms: percentile(ms,0.5), p90_ms: percentile(ms,0.9),
        p95_ms: percentile(ms,0.95), p99_ms: percentile(ms,0.99),
        max_ms: ms.length ? ms[ms.length-1] : null,
        over_5s: ms.filter(x=>x>5000).length,
        over_10s: ms.filter(x=>x>10000).length,
        over_20s: ms.filter(x=>x>20000).length,
        over_30s: ms.filter(x=>x>30000).length };
    };
    const copied = rows.filter(r => r.copied);
    const skipped = rows.filter(r => !r.copied);
    const eps = 1e-7;
    const mismatches = copied.filter(r => {
      if (!Number.isFinite(r.copyAfter) || !Number.isFinite(r.copyBefore)) return true;
      if (r.action === 'CLOSE') return Math.abs(r.copyAfter) > eps;
      if (r.action === 'OPEN' || r.action === 'REVERSAL')
        return Math.abs(Math.abs(r.copyAfter)*r.price-START_NOTIONAL_USD) > 0.1;
      // For ADD/PARTIAL_CLOSE the ratio is inherited from the active position.
      // Compare consecutive before/after against the signed source fill delta.
      const delta = r.end-r.start;
      const copyDelta = r.copyAfter-r.copyBefore;
      return Math.abs(delta) < eps || Math.sign(delta) !== Math.sign(copyDelta);
    });
    const live = rows.filter(r => r.source === 'WS_LIVE');
    const backfill = rows.filter(r => r.source === 'API_BACKFILL');
    const mostDelayed = rows.slice().sort((a,b) =>
      (b.receivedAt-b.at)-(a.receivedAt-a.at)).slice(0,15)
      .map(r => ({ id:r.id, at:r.at, receivedAt:r.receivedAt,
        delay_ms:r.receivedAt-r.at, source:r.source, action:r.action, copied:r.copied }));
    return { ok:true, version:VERSION, mode:'READ_ONLY_VIRTUAL_COPY_AUDIT',
      epoch:this.s.epoch, evaluated_actions:rows.length,
      total_ledger_actions:this.s.ledgerCount,
      sample_truncated:rows.length < this.s.ledgerCount,
      time_basis:'receivedAt - exchange fill time (NOT actual trade execution)',
      overall:describe(rows), ws_live:describe(live), api_backfill:describe(backfill),
      copied_actions:copied.length, skipped_actions:skipped.length,
      copy_math_flags:mismatches.length,
      flagged_examples:mismatches.slice(0,10).map(r=>({id:r.id,action:r.action,
        start:r.start,end:r.end,copyBefore:r.copyBefore,copyAfter:r.copyAfter})),
      action_counts: {
        OPEN:copied.filter(r=>r.action==='OPEN').length,
        ADD:copied.filter(r=>r.action==='ADD').length,
        PARTIAL_CLOSE:copied.filter(r=>r.action==='PARTIAL_CLOSE').length,
        CLOSE:copied.filter(r=>r.action==='CLOSE').length,
        REVERSAL:copied.filter(r=>r.action==='REVERSAL').length,
      },
      most_delayed:mostDelayed,
      position_check:{ target_from_fills:this.s.targetSigned,
        exchange_snapshot:this.s.snapshotSigned, copy_position:this.s.copySigned,
        replay_gap:this.s.replayGap, snapshot_sync_status:this.s.snapshotSyncStatus,
        last_verified_snapshot:this.s.lastVerifiedSnapshot || null,
        last_snapshot_check:this.s.lastSnapshotCheck || null,
        snapshot_confirmed_mismatch:this.s.snapshotConfirmedMismatch },
      limitations:['Delayed API backfills are historical simulations, not timely executable copies.',
        'Snapshot and latest fill may refer to different moments.',
        'Audit flags check arithmetic direction and fresh $100 notional, not market execution.',
        'No real orders, fills, slippage or execution fees are measured.'] };
  }

  private status() {
    return {
      ok: true, version: VERSION, target: TARGET, trading_enabled: false,
      active: this.s.active, connected: this.s.connected, epoch: this.s.epoch,
      baseline_at: this.s.baselineAt, baseline_position_btc: this.s.baselineSigned,
      target_position_from_fills_btc: this.s.targetSigned,
      exchange_snapshot_btc: this.s.snapshotSigned,
      copy_position_btc: this.s.copySigned,
      copy_initial_notional_usd: START_NOTIONAL_USD,
      virtual_v46: this.s.virtualV46 ? {started_at:this.s.virtualV46.startedAt,events:this.s.virtualV46.events,
        equity_usd:this.s.virtualV46.balanceUsd+this.s.virtualV46.qty*(this.s.virtualV46.lastMarkPrice-this.s.virtualV46.avgPrice)} : null,
      copy_ratio: this.s.ratio, copy_enabled: this.s.copyEnabled,
      needs_audit: this.s.needsAudit,
      snapshot_mismatch_btc: this.s.snapshotMismatch,
      snapshot_sync_status: this.s.snapshotSyncStatus || 'NOT_CHECKED',
      snapshot_aligned_target_btc: this.s.snapshotAlignedTarget ?? null,
      snapshot_request_at: this.s.snapshotRequestAt || null,
      snapshot_response_at: this.s.snapshotResponseAt || null,
      snapshot_confirmed_mismatch: !!this.s.snapshotConfirmedMismatch,
      pending_snapshot_count: (this.s.pendingSnapshots || []).length,
      last_verified_snapshot: this.s.lastVerifiedSnapshot || null,
      last_snapshot_check: this.s.lastSnapshotCheck || null,
      snapshot_check_counts: this.s.snapshotChecks || {matched:0,mismatched:0,raced:0,pendingExpired:0},
      last_fill_at: this.s.lastFillAt, last_audit_at: this.s.lastAuditAt,
      last_snapshot_at: this.s.lastSnapshotAt,
      stats: this.s.stats, recent_actions: this.s.recent,
      pending_d1_writes: 0, error: this.s.lastError,
      ledger_count: this.s.ledgerCount, replay_gap: this.s.replayGap,
      audit_cursor: this.s.auditCursor,
      incremental_actions_since_restart:this.incrementalActions,
      recovery_replays_since_restart:this.recoveryReplays,
      last_recovery_reason:this.recoveryReason,
      queued_ingest_jobs:this.queuedJobs,
      note: 'Snapshot is compared only to audited fill state at snapshot request time. In-flight fills are marked ambiguous. Read-only.',
    };
  }

  private async reset(): Promise<Response> {
    if (this.resetBusy) return response({ ok: false, error: 'RESET_BUSY' }, 409);
    this.resetBusy = true;
    this.s.active = false;
    this.s.connected = false;
    try { this.ws?.close(1000, 'reset'); } catch {}
    this.ws = null;
    try {
      await this.processing;
      await this.ensureDb();
      // Only delete this wallet's rows. Verify legacy schema before deletion;
      // never issue an unconditional DELETE against shared cryptobot tables.
      const legacy = [
        'trader_mirror_events_v2', 'trader_copy_positions_v15',
        'trader_shadow_close_events', 'trader_shadow_positions_v14',
      ];
      for (const name of legacy) {
        const table: any = await this.env.DB.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
        ).bind(name).first();
        if (!table) continue;
        const columns: any = await this.env.DB.prepare(`PRAGMA table_info(${name})`).all();
        const hasWallet = (columns.results || []).some((c: any) => c.name === 'wallet');
        if (!hasWallet) throw new Error('RESET_ABORT_LEGACY_TABLE_WITHOUT_WALLET: ' + name);
        await this.env.DB.prepare(`DELETE FROM ${name} WHERE lower(wallet)=?`).bind(TARGET).run();
      }
      await this.env.DB.prepare(`DELETE FROM trader_watch_v4_actions WHERE wallet=?`).bind(TARGET).run();
      await this.env.DB.prepare(`DELETE FROM trader_watch_v4_fills WHERE wallet=?`).bind(TARGET).run();
      // Previous V4 shipped incompatible table layouts. Recreate ONLY V4-owned tables.
      await this.env.DB.prepare('DROP TABLE IF EXISTS trader_watch_v4_actions').run();
      await this.env.DB.prepare('DROP TABLE IF EXISTS trader_watch_v4_fills').run();
      this.databaseReady = false;
      await this.ensureDb();
      await this.ctx.storage.deleteAll();
      this.s = fresh();
      await this.save();
      return response({ ok: true, version: VERSION, reset: true,
        counters_zero: true, active: false, next_step: 'POST /start' });
    } catch (e) {
      this.s.lastError = 'RESET_INCOMPLETE: ' + String(e);
      await this.save();
      return response({ ok: false, error: 'RESET_INCOMPLETE', detail: String(e),
        note: 'Do not start until reset succeeds.' }, 500);
    } finally {
      this.resetBusy = false;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    if(path==='/multi/transport'&&request.method==='GET')return response({
      ok:true,mode:'MULTI_COIN_WEBSOCKET_USERFILLS',wallet:MC_WALLET,
      connected:this.multiWsConnected&&this.multiWs?.readyState===1,
      last_message_at:this.multiWsLastRx||null,last_fill_at:this.multiWsLastFill||null,
      received_batches:this.multiWsMessages,queued_fills:this.multiWsFrames.length,
      pending_source_fills:this.multiWsPending,
      last_error:this.multiWsLastError,
      note:'Controller order safety and copy positions remain unchanged; HTTP is fallback only.'
    });
    if(path.startsWith("/multi/")) {
      const multi=new MultiCoinEngine(this.ctx.storage,this.env.DB);
      if(path==="/multi/start" && request.method==="POST"){
        this.s.active=false;this.s.connected=false;try{this.ws?.close(1000,"switch to multi")}catch{}this.ws=null;await this.save();
      }
      const result=await multi.route(path,request.method,url);
      if(path==="/multi/start" && result.ok) {
        const data=await multi.get();if(data?.active){this.connectMultiWs();await this.ctx.storage.setAlarm(Date.now()+1000);}
      }
      if(path==="/multi/stop" && result.ok)this.closeMultiWs('multi stop');
      return result;
    }
    if (path === '/reset' && request.method === 'POST') return this.reset();
    if (path === '/start' && request.method === 'POST') {
      if(await new MultiCoinEngine(this.ctx.storage,this.env.DB).get()) return response({ok:false,error:'MULTI_COIN_MODE_ACTIVE_USE_MULTI_START'},409);
      if (this.resetBusy) return response({ ok: false, error: 'RESET_BUSY' }, 409);
      try {
        await this.ensureDb();
        await this.ensureVirtual();
        await this.ensureV463();
        await this.ensureMaker();
        await this.seedMakerOrders();
        await this.save();
        // Establish snapshot baseline BEFORE subscribing to live fills.
        if (!this.s.baselineAt) {
          await this.snapshot(true);
          if (!this.s.baselineAt) throw new Error('BASELINE_SNAPSHOT_UNAVAILABLE');
        }
        this.s.active = true;
        this.connect();
        await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
        await this.save();
        return response(this.status());
      } catch (e) { return response({ ok: false, error: String(e) }, 503); }
    }
    if (path === '/stop' && request.method === 'POST') {
      this.s.active = false;
      this.s.connected = false;
      try { this.ws?.close(1000, 'stop'); } catch {}
      this.ws = null;
      await this.save();
      return response(this.status());
    }
    if (path === '/audit' && request.method === 'POST') {
      this.s.nextApiAt = 0;
      await this.audit(true);
      await this.snapshot(true);
      return response(this.status());
    }
    if (['/status', '/v4', '/mirror'].includes(path)) return response(this.status());
    if (path === '/snapshot-audit' && request.method === 'GET') return response({
      ok:true,version:VERSION,mode:'READ_ONLY_SNAPSHOT_VERIFICATION',
      latest_snapshot:{signed:this.s.snapshotSigned,request_at:this.s.snapshotRequestAt,
        response_at:this.s.snapshotResponseAt,status:this.s.snapshotSyncStatus},
      last_verified_snapshot:this.s.lastVerifiedSnapshot || null,
      last_snapshot_check:this.s.lastSnapshotCheck || null,
      pending_snapshot_count:(this.s.pendingSnapshots || []).length,
      checks:this.s.snapshotChecks || null,
      audit_cursor:this.s.auditCursor,needs_audit:this.s.needsAudit,
      replay_gap:this.s.replayGap,trading_enabled:false});
    if (path === '/virtual-pl' && request.method === 'GET') {
      try {return response(await this.makerReport());}
      catch(e){return response({ok:false,error:String(e)},503);}
    }
    if(path==='/virtual-v465-archive' && request.method==='GET'){
      try{return response(await this.v463Report());}catch(e){return response({ok:false,error:String(e)},503);} }
    if (path === '/virtual-v46-archive' && request.method === 'GET') {
      try {return response(await this.virtualReport());}
      catch(e){return response({ok:false,error:String(e)},503);}
    }
    if (path === '/virtual-new-session' && request.method === 'POST') {
      try {await this.ensureMaker();this.maker=this.freshMaker();await this.persistMaker();
        return response(await this.makerReport());}
      catch(e){return response({ok:false,error:String(e)},503);}
    }
    if (path === '/pipeline-audit' && request.method === 'GET') return response(this.pipelineAudit());
    if (path === '/execution-audit' && request.method === 'GET') {
      try { return response(await this.executionAudit(Number(url.searchParams.get('limit') || 5000))); }
      catch (e) { return response({ok:false,error:String(e)},503); }
    }
    if (path === '/actions') {
      try {
        await this.ensureDb();
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') || 100)));
        const data: any = await this.env.DB.prepare(`SELECT payload_json
          FROM trader_watch_v4_actions WHERE wallet=? AND epoch=?
          ORDER BY event_at DESC LIMIT ?`).bind(TARGET, this.s.epoch, limit).all();
        return response({ ok: true, version: VERSION,
          rows: (data.results || []).map((r: any) => JSON.parse(r.payload_json)) });
      } catch (e) { return response({ ok: false, error: String(e) }, 503); }
    }
    return response({ ok: false, error: 'NOT_FOUND' }, 404);
  }
}
