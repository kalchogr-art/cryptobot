// MULTI-COIN TRADER WATCH V2 PRE-LIVE TEST — VIRTUAL ONLY, NO EXCHANGE ORDERS.
// V2 PRE-LIVE: $50 initial, $1.04 initial margin, 10x, no fixed position-count cap.
// V1.3.16 GAP durability and existing copy execution logic retained. Start a NEW SESSION to apply capital.
export const MC_WALLET='0x34fb5ec7d4e939161946340ea2a1f29254b893de';
const INFO='https://api.hyperliquid.xyz/info';
const INITIAL=50, LEVERAGE=10, OPEN_MARGIN=1.04, OPEN_NOTIONAL=OPEN_MARGIN*LEVERAGE;
const MAKER_FEE=.00015, TAKER_FEE=.00045, MIN_NOTIONAL=10, EPS=1e-10;
const PRELIVE_ORDER_MIN=10.40; // conservative simulation threshold; actual exchange minimum is separate
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
type Session={preLive?:PreLiveState;szDecimals?:Record<string,number>;id:string;active:boolean;started:number;cursor:number;cash:number;initial:number;positions:Record<string,Position>;baseline:Record<string,number>;ignored:Record<string,boolean>;lastPrice:Record<string,number>;fills:number;skipped:number;turnover:number;fees:number;gross:number;closed:number;wins:number;losses:number;errors:string[];lastPoll:number;lastError:string|null;orders?:Record<string,WatchOrder>;ordersLastPoll?:number;ordersLastError?:string|null;orderChanges?:number;accuracyEligible?:number;accuracyMatched?:number;accuracyGaps?:number;makerFills?:number;takerFills?:number;unknownFills?:number;mirrorOrders?:Record<string,MirrorOrder>;mirrorMatches?:number;mirrorUnmatched?:number;mirrorFills?:MirrorFill[];mirrorScale?:Record<string,number>;mirrorPositions?:Record<string,MirrorPosition>;mirrorRealized?:number;mirrorFees?:number;gapPending?:Record<string,{tradeId:string;fillId:string;at:number;coin:string;price:number;position:Position;record:any}>;};
function fresh():Session{return{id:'MC-'+Date.now(),active:false,started:Date.now(),cursor:Date.now(),cash:INITIAL,initial:INITIAL,positions:{},baseline:{},ignored:{},lastPrice:{},fills:0,skipped:0,turnover:0,fees:0,gross:0,closed:0,wins:0,losses:0,errors:[],lastPoll:0,lastError:null,orders:{},ordersLastPoll:0,ordersLastError:null,orderChanges:0,accuracyEligible:0,accuracyMatched:0,accuracyGaps:0,makerFills:0,takerFills:0,unknownFills:0,mirrorOrders:{},mirrorMatches:0,mirrorUnmatched:0,mirrorFills:[],mirrorScale:{},mirrorPositions:{},mirrorRealized:0,mirrorFees:0,preLive:newPreLive(),szDecimals:{}};}
async function info(body:any){const r=await fetch(INFO,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('HL_HTTP_'+r.status);return r.json() as Promise<any>;}
const inFlightPolls=new WeakMap<object,Promise<void>>();
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
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_closed (session_id TEXT NOT NULL, trade_id TEXT NOT NULL, coin TEXT NOT NULL, direction TEXT NOT NULL, opened INTEGER NOT NULL, closed INTEGER NOT NULL, entry REAL NOT NULL, exit REAL NOT NULL, gross REAL NOT NULL, fees REAL NOT NULL, net REAL NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,trade_id))`).run();
    await this.db.prepare(`CREATE TABLE IF NOT EXISTS mc_watch_order_events (session_id TEXT NOT NULL, event_id TEXT NOT NULL, at INTEGER NOT NULL, oid TEXT NOT NULL, coin TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,event_id))`).run();
    await this.db.prepare(`CREATE INDEX IF NOT EXISTS mc_watch_order_events_at ON mc_watch_order_events(session_id,at DESC)`).run();
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
  private preLiveFill(s:Session,coin:string,start:number,end:number,px:number,at:number,crossed:any,baselineAction:string){
    const v=s.preLive||(s.preLive=newPreLive());v.events++;
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
      const qty=Math.ceil(OPEN_NOTIONAL/px/step-1e-8)*step;
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
      if(sign(end)!==0)this.preLiveFill(s,coin,0,end,px,at,crossed,'OPEN');
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
    if(!recovery)this.preLiveFill(s,coin,start,end,px,at,f.crossed,action);
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
  async poll(){
    const prior=inFlightPolls.get(this.storage);if(prior)return prior;
    const run=this.pollCore();inFlightPolls.set(this.storage,run);
    try{await run;}finally{if(inFlightPolls.get(this.storage)===run)inFlightPolls.delete(this.storage);}
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
        s.cursor=Math.max(s.cursor,asNum(f.time));
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
    let used=0,unreal=0;const positions=Object.values(s.positions).map(p=>{const mark=s.lastPrice[p.coin]||p.last||p.avg;const u=p.qty*(mark-p.avg);const margin=Math.abs(p.qty*mark)/LEVERAGE;used+=margin;unreal+=u;return{...p,direction:sign(p.qty)>0?'LONG':'SHORT',mark,unrealized:u,margin,notional:Math.abs(p.qty*mark),duration_ms:Date.now()-p.opened};});
    const equity=s.cash+unreal;return{ok:true,version:'MULTI-COIN TRADER WATCH V2 PRE-LIVE ACCUMULATION V2.1 + V1.3.16 GAP COMMIT',mode:'VIRTUAL_ONLY_NO_REAL_ORDERS',wallet:MC_WALLET,active:s.active,session_id:s.id,started_at:s.started,last_poll:s.lastPoll,last_error:s.lastError,initial_usd:s.initial,cash_usd:s.cash,equity_usd:equity,roi_pct:(equity/s.initial-1)*100,used_margin_usd:used,free_margin_usd:equity-used,unrealized_usd:unreal,realized_gross_usd:s.gross,fees_usd:s.fees,net_realized_usd:s.gross-s.fees,turnover_usd:s.turnover,open_positions:positions,open_count:positions.length,closed_count:s.closed,wins:s.wins,losses:s.losses,win_rate_pct:s.closed?s.wins/s.closed*100:0,processed_fills:s.fills,skipped_fills:s.skipped,open_orders_count:Object.keys(s.orders||{}).length,open_orders_last_poll:s.ordersLastPoll||0,open_orders_error:s.ordersLastError||null,order_changes:s.orderChanges||0,mirror_pending_orders:Object.values(s.mirrorOrders||{}).filter(o=>o.status==='PENDING').length,mirror_theoretical_realized_gross:s.mirrorRealized||0,theoretical_fees:s.mirrorFees||0,theoretical_realized_net:(s.mirrorRealized||0)-(s.mirrorFees||0),theoretical_positions:Object.values(s.mirrorPositions||{}),matched_target_fills:s.mirrorMatches||0,mirror_unmatched_target_fills:s.mirrorUnmatched||0,copy_accuracy_pct:(s.accuracyEligible||0)>0?100*(s.accuracyMatched||0)/(s.accuracyEligible||1):null,copy_accuracy_sample:s.accuracyEligible||0,copy_accuracy_matched:s.accuracyMatched||0,copy_accuracy_gaps:s.accuracyGaps||0,copy_accuracy_since_upgrade:true,maker_target_fills:s.makerFills||0,taker_target_fills:s.takerFills||0,unknown_target_fills:s.unknownFills||0,ignored_inherited_coins:Object.keys(s.ignored),leverage:LEVERAGE,initial_margin_per_position:OPEN_MARGIN,initial_notional_per_position:OPEN_NOTIONAL,pre_live_accumulation:(()=>{const v=s.preLive||newPreLive();let unreal=0,used=0;const open=Object.values(v.positions).map(p=>{const mark=s.lastPrice[p.coin]||p.avg;unreal+=p.qty*(mark-p.avg);used+=Math.abs(p.qty*mark)/LEVERAGE;return{...p,mark,unrealized:p.qty*(mark-p.avg),pending_delta_usd:Math.abs(p.targetDesired-p.qty)*mark};});return{mode:'SHADOW_VIRTUAL_ONLY',initial_usd:INITIAL,equity_usd:v.cash+unreal,roi_pct:(v.cash+unreal)/INITIAL*100-100,realized_gross_usd:v.gross,fees_usd:v.fees,realized_net_usd:v.gross-v.fees,unrealized_usd:unreal,used_margin_usd:used,free_margin_usd:v.cash+unreal-used,turnover_usd:v.turnover,executed_orders:v.executed,deferred_add_events:v.deferredAdds,deferred_reduction_events:v.deferredReductions,blocked_margin_events:v.blockedMargin,closed:v.closed,win_rate_pct:v.closed?v.wins/v.closed*100:0,average_pending_delay_ms:v.delaySamples?v.delayMsTotal/v.delaySamples:null,positions:open,minimum_notional_usd:PRELIVE_ORDER_MIN,metadata_loaded:Object.keys(s.szDecimals||{}).length>0,limitations:['Shadow execution uses target fill prices; slippage and funding are not modeled','Exchange size precision loaded from metadata; order acceptance not verified','Small residual full-close uses virtual reduce-only close assumption']};})(),pre_live_test:{virtual_only:true,starting_capital_usdc:INITIAL,leverage:LEVERAGE,maximum_theoretical_initial_exposure_usd:INITIAL*LEVERAGE,fixed_position_count_limit:null,exchange_minimum_order_notional_usd:MIN_NOTIONAL,exchange_order_execution_verified:false,existing_session_unchanged_until_new_session:true},fee_assumptions:{maker:MAKER_FEE,taker:TAKER_FEE},limitations:['Virtual fill at target fill price; own order execution is not proven','Original 1:1 ledger remains unrestricted; compare with pre_live_accumulation shadow for order-size restrictions','Funding, liquidation, price slippage and exchange precision rules not modeled','Only contiguous previously audited target fills can be recovered; unknown gaps remain on hold and are never fabricated','Perpetual market only; spot fills are not included']};}

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
