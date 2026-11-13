/** V2.3 Stage 7 — integrated Durable Object controller, SAFE DRY RUN.
 * Uses V2.3 accumulator and ledger, but NEVER submits exchange orders.
 * Does not mutate the existing V2.2 virtual simulations.
 */
import {planCopyAction, type CopyCoinState} from './live-copy-accumulator-v2.3';
import {planAndReserve, beginSubmission, applyTrustedReceipt} from './live-copy-bridge-v2.3-stage6';
import {assertPositionOwned, markUnknown} from './live-copy-ledger-v2.3';
import {emptyLiveLedger, type LiveLedger} from './live-copy-ledger-v2.3';
import {readLiveAccount, executeLiveIoc, type LiveCopyEnv} from './live-copy-execution-v2.3';
import {closeOwnedPosition, closeAllOwned, type CloseAdapter} from './live-copy-manual-close-v2.3-stage12';
import {reconcileCopyLedger} from './live-copy-reconciliation-v2.3';

type Env=LiveCopyEnv & {LIVE_COPY_LEVERAGE_VERIFIED?:string;LIVE_COPY_LEVERAGE_MODE?:string;LIVE_COPY_AUTO_EXECUTION_ENABLED?:string;LIVE_COPY_ADMIN_TOKEN?:string;DB?:{prepare(sql:string):{bind(...args:any[]):{first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>}}}};
type Storage={get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>;setAlarm?(when:number):Promise<void>;deleteAlarm?():Promise<void>};
type State={storage:Storage};
type Coin=CopyCoinState & {lastWhaleTarget:number;lastPrice:number;lastEventAt:number;episode:number};
type Snapshot={version:2;mode:'STOPPED'|'RUNNING';sessionKind?:'DRY_RUN'|'LIVE';startedAt:number|null;coins:Record<string,Coin>;seen:Record<string,number>;recent:{at:number;kind:string;coin?:string;detail?:string}[]};
const KEY='live_copy_v23_stage7';
const fresh=():Snapshot=>({version:2,mode:'STOPPED',sessionKind:'DRY_RUN',startedAt:null,coins:{},seen:{},recent:[]});
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
const round=(n:number)=>Math.round(n*1e10)/1e10;
export class LiveCopyControllerStage7 {
  // Intentionally volatile: a DO restart/hibernation revokes LIVE permission.
  private liveArmAt:number|null=null;
  constructor(private state:State,private env:Env){}
  private async load(){return await this.state.storage.get<Snapshot>(KEY)||fresh();}
  private async save(s:Snapshot){await this.state.storage.put(KEY,s);}
  private audit(s:Snapshot,kind:string,coin?:string,detail?:string){s.recent.unshift({at:Date.now(),kind,coin,detail});s.recent=s.recent.slice(0,100);}
  // Alarms are serialized by the Durable Object. Never overwrite fresh state from /sync.
  async alarm():Promise<void>{
    const s=await this.load();
    if(s.mode!=='RUNNING')return;
    try{
      const response=await this.fetch(new Request('https://live-copy.internal/sync',{
        method:'POST',headers:{authorization:`Bearer ${this.env.LIVE_COPY_ADMIN_TOKEN}`,'content-type':'application/json'},body:'{}'
      }));
      const result:any=await response.json();
      if(!response.ok){
        const latest=await this.load();this.audit(latest,'AUTO_SYNC_ERROR',undefined,JSON.stringify(result).slice(0,240));
        latest.mode='STOPPED';await this.save(latest);return;
      }
      const latest=await this.load();
      this.audit(latest,'AUTO_SYNC_OK',undefined,`processed=${result.processed||0} ignored=${result.ignored||0}`);
      await this.save(latest);
    }catch(error){
      const latest=await this.load();this.audit(latest,'AUTO_SYNC_EXCEPTION',undefined,String(error).slice(0,240));
      latest.mode='STOPPED';await this.save(latest);return;
    }
    if((await this.load()).mode==='RUNNING'&&this.state.storage.setAlarm)await this.state.storage.setAlarm(Date.now()+15000);
  }
  private async ledger(){return await this.state.storage.get<LiveLedger>('live_copy_v23_ledger')||emptyLiveLedger();}
  // Overview is stored separately from trading state. No retroactive P/L is invented.
  private async overview(){return await this.state.storage.get<{capital:number;startedAt:number;source:string;resetCount:number}>('live_copy_v23_overview');}
  private async accountCapital(){
    const a=await readLiveAccount(this.env);
    // Unified USDC is a collateral figure, NOT total portfolio equity if other assets exist.
    const n=a.spotUsdcTotal;
    if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw Error('UNIFIED_USDC_NOT_AVAILABLE_FOR_CAPITAL');
    return n;
  }
  private async ensureOverview(){
    let o=await this.overview();
    if(!o){const capital=await this.accountCapital();o={capital,startedAt:Date.now(),source:'spotClearinghouseState.USDC.total',resetCount:0};await this.state.storage.put('live_copy_v23_overview',o);}
    return o;
  }
  private async overviewStatus(s:Snapshot){
    const o=await this.overview();const ledger=await this.ledger();
    const intents=Object.values(ledger.intents);
    const ownedOpen=Object.values(ledger.confirmedByCoin).filter(q=>Number.isFinite(q)&&Math.abs(q)>1e-9).length;
    return {capital:o?.capital??null,capital_at:o?.startedAt??null,capital_source:o?.source??null,reset_count:o?.resetCount??0,
      equity:null,roi:null,free_margin:null,used_margin:null,realized_gross:null,fees:null,realized_net:null,unrealized:null,turnover:null,
      our_open_positions:ownedOpen,closed_trades:null,win_rate:null,processed_fills:Object.keys(s.seen).length,
      skipped:null,copy_accuracy:null,accuracy_sample:null,target_maker_fills:null,target_taker_fills:null,
      target_open_orders:null,target_open_positions:null,
      ledger_intents:intents.length,confirmed_intents:intents.filter(i=>i.status==='FILLED').length,
      accounting_note:'No verified exchange-fill fee/PnL ledger. Financial and target-order metrics are unavailable, not zero.'};
  }

  private liveEnabled(){return this.env.LIVE_COPY_TRADING_ENABLED==='true'&&this.env.LIVE_COPY_AUTO_EXECUTION_ENABLED==='true'&&this.env.LIVE_COPY_LEVERAGE_VERIFIED==='true'&&this.env.LIVE_COPY_LEVERAGE_MODE==='cross';}
  private liveAuthorized(s:Snapshot){return s.mode==='RUNNING'&&s.sessionKind==='LIVE'&&this.liveArmAt!==null&&this.liveArmAt===s.startedAt&&this.liveEnabled();}
  private async halt(reason:string,coin?:string){this.liveArmAt=null;const s=await this.load();s.mode='STOPPED';this.audit(s,'LIVE_HALTED',coin,reason);await this.save(s);if(this.state.storage.deleteAlarm)await this.state.storage.deleteAlarm();}
  async fetch(request:Request):Promise<Response>{
    if(!this.env.LIVE_COPY_ADMIN_TOKEN||request.headers.get('authorization')!==`Bearer ${this.env.LIVE_COPY_ADMIN_TOKEN}`)return json({ok:false,error:'UNAUTHORIZED'},401);
    const path=new URL(request.url).pathname;
    const s=await this.load();
    if(request.method==='GET'&&path==='/status')return json({ok:true,overview:await this.overviewStatus(s),version:'V2.3_STAGE_15_3_SAFETY_REVIEW',mode:s.mode,auto_sync_enabled:s.mode==='RUNNING',poll_interval_seconds:15,live_execution_wired:true,manual_close_wired:true,session_kind:s.sessionKind||'DRY_RUN',live_session_authorized:this.liveAuthorized(s),manual_close_enabled:this.env.LIVE_COPY_TRADING_ENABLED==='true'&&(this.env as any).LIVE_COPY_MANUAL_CLOSE_ENABLED==='true',trading_enabled:this.liveAuthorized(s),auto_execution_configured:this.liveEnabled(),started_at:s.startedAt,coins:Object.values(s.coins),recent:s.recent,processed_event_ids:Object.keys(s.seen).length,ledger_intents:Object.keys((await this.ledger()).intents).length});
    if(request.method!=='POST')return json({ok:false,error:'NOT_FOUND'},404);
    let body:any={};try{body=await request.json();}catch{return json({ok:false,error:'INVALID_JSON'},400);}
    if(path==='/overview-init'){
      try{const overview=await this.ensureOverview();return json({ok:true,overview,read_only:true});}
      catch(e){return json({ok:false,error:'OVERVIEW_CAPITAL_UNAVAILABLE',detail:String(e)},503);}
    }
    if(path==='/stop'){this.liveArmAt=null;s.mode='STOPPED';this.audit(s,'STOP');await this.save(s);if(this.state.storage.deleteAlarm)await this.state.storage.deleteAlarm();return json({ok:true,mode:s.mode,positions_untouched:true});}
    if(path==='/start'){this.liveArmAt=null;if(this.liveEnabled()&&body.confirm!=='START_REAL_HYPERLIQUID_COPY')return json({ok:false,error:'EXPLICIT_LIVE_CONFIRMATION_REQUIRED'},409);if(this.liveEnabled()){try{const account=await readLiveAccount(this.env);const ledger=await this.ledger();const report=reconcileCopyLedger(ledger,account.positions,account.assetMeta);if(Object.values(ledger.intents).some(i=>['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status)))return json({ok:false,error:'UNRESOLVED_INTENTS_REQUIRE_MANUAL_RECONCILIATION'},409);if(!report.safeToTrade)return json({ok:false,error:'PRE_START_RECONCILIATION_BLOCKED',report},409);}catch(e){return json({ok:false,error:'PRE_START_ACCOUNT_CHECK_FAILED',detail:String(e)},409);}}if(!this.state.storage.setAlarm)return json({ok:false,error:'ALARM_STORAGE_UNAVAILABLE'},503);
      // Fail closed on restart: never silently backfill a stopped interval.
      // Existing owned positions require explicit reconciliation/handling, not a fresh anchor.
      if(this.liveEnabled()){
        const ledger=await this.ledger();
        if(Object.values(ledger.confirmedByCoin).some(q=>Math.abs(q)>1e-9))
          return json({ok:false,error:'OWNED_POSITIONS_REQUIRE_CONTINUOUS_SESSION_OR_MANUAL_CLOSE'},409);
        if(!this.env.DB)return json({ok:false,error:'DB_BINDING_MISSING'},503);
        const latest=await this.env.DB.prepare('SELECT session_id AS session, rowid FROM mc_watch_events ORDER BY rowid DESC LIMIT 1').bind().first<{session:string;rowid:number}>();
        await this.state.storage.put('live_copy_v23_d1_cursor',{session:latest?.session||'',rowid:latest?.rowid||0});
        s.coins={};s.seen={};
      }
      s.mode='RUNNING';s.startedAt=Date.now();s.sessionKind=this.liveEnabled()?'LIVE':'DRY_RUN';this.audit(s,s.sessionKind==='LIVE'?'START_AUTO_SYNC_LIVE':'START_AUTO_SYNC_DRY_RUN');await this.save(s);if(s.sessionKind==='LIVE')this.liveArmAt=s.startedAt;await this.state.storage.setAlarm(Date.now()+1000);return json({ok:true,mode:s.mode,trading_enabled:this.liveAuthorized(s)});}
    if(path==='/sync'){
      if(s.mode==='RUNNING'&&((s.sessionKind==='LIVE'&&!this.liveAuthorized(s))||(s.sessionKind!=='LIVE'&&this.liveEnabled()))){await this.halt('LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED');return json({ok:false,error:'LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED',stopped:true},409);}
      if(s.mode!=='RUNNING')return json({ok:false,error:'STOPPED'},409);
      if(!this.env.DB){await this.halt('DB_BINDING_MISSING');return json({ok:false,error:'DB_BINDING_MISSING',stopped:true},503);}
      type Cursor={session:string;rowid:number};
      let cursor=await this.state.storage.get<Cursor>('live_copy_v23_d1_cursor');
      // The first sync is intentionally anchored to the most recent row.
      // Never retroactively trade fills from before LIVE START.
      if(!cursor){
        const last=await this.env.DB.prepare('SELECT session_id AS session, rowid FROM mc_watch_events ORDER BY rowid DESC LIMIT 1').bind().first<Cursor>();
        cursor={session:last?.session||'',rowid:last?.rowid||0};
        await this.state.storage.put('live_copy_v23_d1_cursor',cursor);
        return json({ok:true,bootstrapped:true,session:cursor.session,rowid:cursor.rowid,processed:0,trading_enabled:this.liveEnabled()});
      }
      const rows=await this.env.DB.prepare('SELECT rowid,session_id,fill_id,at,coin,action,payload FROM mc_watch_events WHERE rowid>? ORDER BY rowid ASC LIMIT 100').bind(cursor.rowid).all<{rowid:number;session_id:string;fill_id:string;at:number;coin:string;action:string;payload:string}>();
      // No fresh D1 fills: do not depend on exchange metadata for an empty sync.
      if(!(rows.results||[]).length)return json({ok:true,processed:0,ignored:0,cursor,has_more:false,metadata_skipped:'NO_NEW_FILLS'});
      let metadata:any=null;let metadataError='';
      try{const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'meta'})});if(!r.ok)throw Error('META_HTTP_'+r.status);metadata=await r.json();if(!Array.isArray(metadata?.universe))throw Error('META_UNIVERSE_MISSING');}
      catch(e){metadataError=String(e);}
      if(metadataError){await this.halt('METADATA_UNAVAILABLE');return json({ok:false,error:'METADATA_UNAVAILABLE',detail:metadataError,cursor,stopped:true},503);}
      const precisions=new Map<string,number>(metadata.universe.map((a:any)=>[a.name,a.szDecimals]));
      let processed=0,ignored=0;let failure:any=null;
      for(const row of rows.results||[]){
        // A changed watcher session must not be spliced into the old target chain.
        if(cursor.session && row.session_id!==cursor.session){failure={error:'WATCHER_SESSION_CHANGED_REQUIRES_REARM',rowid:row.rowid};break;}
        let e:any;try{e=JSON.parse(row.payload);}catch{failure={error:'BAD_SOURCE_PAYLOAD',rowid:row.rowid};break;}
        // D1 includes virtual bookkeeping and recovery events. Only a genuine
        // public Hyperliquid fill can be forwarded to the copy controller.
        // SKIPPED is deliberately NOT excluded: it may mean the *virtual*
        // simulation lacked margin, even though the whale fill is genuine.
        const nonFillActions=new Set(['GAP_CLOSE','RESYNC_CLOSE','RESYNC_REVERSAL']);
        if(!row.fill_id || typeof row.fill_id!=='string' || !row.session_id) {failure={error:'INVALID_D1_FILL_ID',rowid:row.rowid};break;}
        if(nonFillActions.has(row.action)||e?.source!=='HYPERLIQUID_PUBLIC_FILL'||e?.recovered_from_verified_skipped_fill===true){
          ignored++;cursor={session:row.session_id,rowid:row.rowid};
          await this.state.storage.put('live_copy_v23_d1_cursor',cursor);
          continue;
        }
        if(!Number.isFinite(Number(e.target_before))||!Number.isFinite(Number(e.target_after))||!Number.isFinite(Number(e.price))){
          failure={error:'INVALID_SOURCE_FILL',rowid:row.rowid};break;
        }
        const decimals=precisions.get(row.coin);
        if(decimals===undefined){failure={error:'UNKNOWN_ASSET_PRECISION',coin:row.coin,rowid:row.rowid};break;}
        const event={coin:row.coin,fill_id:row.fill_id,whale_before_qty:e.target_before,whale_target_qty:e.target_after,price:e.price,sz_decimals:decimals,time:row.at};
        const response=await this.fetch(new Request('https://live-copy.internal/event',{method:'POST',headers:{authorization:`Bearer ${this.env.LIVE_COPY_ADMIN_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(event)}));
        const result:any=await response.json();
        if(!response.ok){failure={error:'EVENT_REJECTED',rowid:row.rowid,coin:row.coin,detail:result};break;}
        if(result.ignored)ignored++;else processed++;
        cursor={session:row.session_id,rowid:row.rowid};
        // Commit after each processed event to avoid skipping events on crash.
        await this.state.storage.put('live_copy_v23_d1_cursor',cursor);
      }
      if(failure)await this.halt('SYNC_FAILED:'+String(failure.error));
      return json({ok:!failure,trading_enabled:this.liveAuthorized(await this.load()),processed,ignored,cursor,failure,has_more:(rows.results||[]).length===100},failure?409:200);
    }
    if(path==='/reconcile'){
      try{const account=await readLiveAccount(this.env);const report=reconcileCopyLedger(await this.ledger(),account.positions,account.assetMeta);this.audit(s,report.safeToTrade?'RECONCILE_OK':'RECONCILE_BLOCKED');await this.save(s);return json({ok:true,read_only:true,...report});}
      catch(e){return json({ok:false,error:'ACCOUNT_READ_FAILED',detail:String(e)},503);}
    }
    if(path==='/account'){
      try { const account=await readLiveAccount(this.env);return json({ok:true,account}); }
      catch(e){return json({ok:false,error:'ACCOUNT_READ_FAILED',detail:String(e)},503);}
    }
    if(path==='/close'||path==='/close-all'){
      // Close commands are independent of auto-sync, but require STOP persisted first.
      // This explicit second flag prevents accidental live writes on deployment.
      if(s.mode!=='STOPPED')return json({ok:false,error:'STOP_REQUIRED_BEFORE_MANUAL_CLOSE'},409);
      if(this.env.LIVE_COPY_TRADING_ENABLED!=='true'||(this.env as any).LIVE_COPY_MANUAL_CLOSE_ENABLED!=='true')
        return json({ok:false,error:'LIVE_MANUAL_CLOSE_DISABLED',positions_untouched:true},409);
      if(body.confirm!=='CLOSE_REAL_HYPERLIQUID_POSITION')return json({ok:false,error:'EXPLICIT_CONFIRMATION_REQUIRED'},400);
      const commandId=body.command_id;
      if(typeof commandId!=='string'||!/^[-A-Za-z0-9_:]{8,150}$/.test(commandId))return json({ok:false,error:'INVALID_COMMAND_ID'},400);
      const store={load:()=>this.ledger(),save:(v:LiveLedger)=>this.state.storage.put('live_copy_v23_ledger',v)};
      const exchange:CloseAdapter={
        positions:async()=>[],
        execute:async(i)=>{
          const r=await executeLiveIoc(this.env,i);
          return {status:r.status,executed:r.executed,filledQty:r.filledQty,requestedQty:r.requestedQty,oid:r.oid};
        }
      };
      // Fetch fresh mark prices from exchange; entry price is NOT a current reference.
      exchange.positions=async()=>{
        const a=await readLiveAccount(this.env);
        const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'allMids'})});
        if(!r.ok)throw Error('MID_PRICES_UNAVAILABLE');
        const mids=await r.json() as Record<string,string>;
        return a.positions.map((p:any)=>{
          const m=a.assetMeta.find((x:any)=>x.coin===p.coin);
          return {coin:p.coin,qty:p.qty,szDecimals:m?.szDecimals??-1,markPrice:Number(mids[p.coin])};
        });
      };
      try{
        const result=path==='/close'
          ? await closeOwnedPosition({coin:body.coin,commandId,store,exchange})
          : await closeAllOwned({commandId,store,exchange});
        let overview_reset:any=null;
        if(path==='/close-all'){
          const updated=await this.ledger();
          const open=Object.values(updated.confirmedByCoin).some(q=>Math.abs(q)>1e-9);
          const unresolved=Object.values(updated.intents).some(i=>['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status));
          if((result as any).allConfirmedClosed===true&&!open&&!unresolved){
            try{const capital=await this.accountCapital();const previous=await this.overview();
              overview_reset={capital,startedAt:Date.now(),source:'spotClearinghouseState.USDC.total',resetCount:(previous?.resetCount||0)+1};
              await this.state.storage.put('live_copy_v23_overview',overview_reset);
              this.audit(s,'OVERVIEW_CAPITAL_RESET',undefined,'New verified USDC snapshot after owned positions flat');
            }catch(e){this.audit(s,'OVERVIEW_RESET_PENDING',undefined,String(e).slice(0,150));}
          }else this.audit(s,'OVERVIEW_RESET_BLOCKED',undefined,'Owned positions or unresolved intents remain');
        }
        this.audit(s,'MANUAL_CLOSE_COMMAND',body.coin,JSON.stringify(result).slice(0,240));await this.save(s);
        return json({ok:true,result,overview_reset,live_write_attempted:true});
      }catch(e){return json({ok:false,error:'MANUAL_CLOSE_FAILED',detail:String(e)},409);}
    }
    if(path!=='/event')return json({ok:false,error:'NOT_FOUND'},404);
    if(s.mode!=='RUNNING')return json({ok:false,error:'STOPPED'},409);
    const {coin,fill_id,whale_target_qty,whale_before_qty,price,sz_decimals,time}=body;
    if(typeof coin!=='string'||!/^[A-Z0-9]{2,20}$/.test(coin)||typeof fill_id!=='string'||!fill_id||fill_id.length>180||!finite(whale_target_qty)||!finite(whale_before_qty)||!finite(price)||price<=0||!Number.isInteger(sz_decimals)||sz_decimals<0||sz_decimals>8||!finite(time)||time<=0)return json({ok:false,error:'INVALID_EVENT'},400);
    if(s.sessionKind==='LIVE'&&!this.liveAuthorized(s)){await this.halt('LIVE_EVENT_NOT_AUTHORIZED');return json({ok:false,error:'LIVE_EVENT_NOT_AUTHORIZED',stopped:true},409);}
    if(s.sessionKind!=='LIVE'&&this.liveEnabled()){await this.halt('DRY_RUN_CONFIG_CHANGED');return json({ok:false,error:'DRY_RUN_CONFIG_CHANGED',stopped:true},409);}
    if(this.liveAuthorized(s)){
      const eventMs=time<1e11?time*1000:time;
      if(Date.now()-eventMs>120000||eventMs-Date.now()>30000)
        return json({ok:false,error:'STALE_OR_FUTURE_WHALE_FILL',eventMs},409);
    }
    const id=`${coin}:${fill_id}`;
    if(s.seen[id])return json({ok:true,duplicate:true,exchange_order_sent:false});
    const old=s.coins[coin];
    if(old&&time<old.lastEventAt)return json({ok:false,error:'OUT_OF_ORDER_EVENT'},409);
    if(old&&Math.abs(whale_before_qty-old.lastWhaleTarget)>1e-7)return json({ok:false,error:'TARGET_CHAIN_GAP'},409);
    if(old?.suspended)return json({ok:true,ignored:true,reason:'COIN_SUSPENDED',exchange_order_sent:false});
    if(!old && (Math.abs(whale_before_qty)>1e-10||Math.abs(whale_target_qty)<1e-10)){
      s.seen[id]=Date.now();this.audit(s,'SKIP_INHERITED',coin);await this.save(s);
      return json({ok:true,ignored:true,reason:'WAIT_NEW_FLAT_TO_OPEN',exchange_order_sent:false});
    }
    // A new episode after a confirmed flat target gets a fresh scaling anchor.
    // Refuse to rearm when the previous position is still open or unresolved.
    const newEpisode=!!old&&Math.abs(old.lastWhaleTarget)<1e-10&&Math.abs(whale_target_qty)>1e-10;
    if(newEpisode){
      const prior=await this.ledger();
      if(prior.suspendedCoins[coin])return json({ok:false,error:'MANUAL_CLOSE_SUSPENSION_REQUIRES_REARM'},409);
      if(Math.abs(prior.confirmedByCoin[coin]||0)>1e-9 || Object.values(prior.intents).some(i=>i.coin===coin&&['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status)))
        return json({ok:false,error:'PRIOR_EPISODE_NOT_CLOSED'},409);
    }
    const scale=(!old||newEpisode)?10.40/(Math.abs(whale_target_qty)*price):old.scale;
    if(!Number.isFinite(scale)||scale<=0)return json({ok:false,error:'INVALID_SCALE'},400);
    const record:Coin=(old&&!newEpisode)?{...old,lastWhaleTarget:whale_target_qty,lastPrice:price,lastEventAt:time,lastFillId:fill_id}:{coin,anchorTargetQty:whale_target_qty,scale,confirmedOwnQty:0,pendingIntentId:null,suspended:false,lastFillId:fill_id,lastWhaleTarget:whale_target_qty,lastPrice:price,lastEventAt:time,episode:(old?.episode||0)+1};
    const ledger=await this.ledger();
    if(ledger.suspendedCoins[coin])return json({ok:false,error:'MANUALLY_CLOSED_COIN_REQUIRES_REARM'},409);
    if(!this.liveAuthorized(s)){
      const proposal=planCopyAction({state:record,whaleTargetQty:whale_target_qty,price,szDecimals:sz_decimals});
      s.coins[coin]=record;s.seen[id]=Date.now();this.audit(s,'DRY_RUN_PROPOSAL',coin,`${proposal.kind}:${proposal.reason}`);
      if(Object.keys(s.seen).length>=25000){s.mode='STOPPED';this.audit(s,'DEDUP_CAP_STOP');}
      await this.save(s);
      return json({ok:true,mode:s.mode,proposal,exchange_order_sent:false,trading_enabled:false});
    }
    // No exchange write unless the wallet is freshly reconciled and the current
    // exchange mark is close to the source reference. All live writes are opt-in.
    let account:Awaited<ReturnType<typeof readLiveAccount>>;
    let markPrice:number;
    try{
      account=await readLiveAccount(this.env);
      const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'allMids'})});
      if(!r.ok)throw Error('MARK_PRICE_HTTP_'+r.status);
      const mids=await r.json() as Record<string,string>;
      markPrice=Number(mids[coin]);
      if(!Number.isFinite(markPrice)||markPrice<=0||Math.abs(markPrice-price)/markPrice>0.005)throw Error('STALE_SOURCE_PRICE');
      assertPositionOwned(ledger,coin,account.positions.find(p=>p.coin===coin)?.qty||0,sz_decimals);
    }catch(e){await this.halt('PRE_TRADE_CHECK_FAILED:'+String(e).slice(0,120),coin);return json({ok:false,error:'PRE_TRADE_CHECK_FAILED',detail:String(e)},409);}
    if(Object.values(ledger.intents).some(i=>i.coin===coin&&['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status))){await this.halt('UNRESOLVED_INTENT_BEFORE_NEW_ORDER',coin);return json({ok:false,error:'UNRESOLVED_INTENT_BEFORE_NEW_ORDER'},409);}
    const intentId=`AUTO:${coin}:${fill_id}`;
    let planned;
    try{planned=planAndReserve({state:record,ledger,whaleTargetQty:whale_target_qty,price:markPrice,szDecimals:sz_decimals,sourceFillId:fill_id,intentId,now:Date.now()});}
    catch(e){await this.halt('INTENT_PLANNING_FAILED:'+String(e).slice(0,120),coin);return json({ok:false,error:'INTENT_PLANNING_FAILED',detail:String(e)},409);}
    if(!planned.intent){s.coins[coin]=record;s.seen[id]=Date.now();this.audit(s,'LIVE_ACCUMULATING',coin,planned.proposal.reason);await this.save(s);return json({ok:true,proposal:planned.proposal,exchange_order_sent:false,trading_enabled:true});}
    // Persist the reservation and in-flight state BEFORE the exchange request.
    await this.state.storage.put('live_copy_v23_ledger',planned.ledger);
    s.coins[coin]=planned.state as Coin;await this.save(s);
    const submitting=beginSubmission(planned.state,planned.ledger,intentId,Date.now());
    await this.state.storage.put('live_copy_v23_ledger',submitting.ledger);
    let receipt;
    try{
      const result=await executeLiveIoc(this.env,{intentId,coin,direction:planned.proposal.signedDelta>0?'LONG':'SHORT',quantity:planned.proposal.quantity,reduceOnly:planned.proposal.reduceOnly,referencePrice:markPrice});
      receipt={intentId,coin,status:result.status,executed:result.executed,filledQty:result.filledQty,requestedQty:result.requestedQty,oid:result.oid};
    }catch(e){receipt={intentId,coin,status:'UNKNOWN_WRITE_OUTCOME',executed:false};}
    let settled;
    try{settled=applyTrustedReceipt(submitting.state,submitting.ledger,receipt,Date.now());}
    catch(e){await this.halt('SETTLEMENT_FAILED:'+String(e).slice(0,120),coin);return json({ok:false,error:'SETTLEMENT_FAILED_RECONCILE',detail:String(e)},409);}
    await this.state.storage.put('live_copy_v23_ledger',settled.ledger);
    s.coins[coin]=settled.state as Coin;
    this.audit(s,'LIVE_ORDER_'+settled.outcome,coin,intentId);
    if(settled.outcome==='UNKNOWN'||settled.outcome==='PARTIAL'){
      s.mode='STOPPED';await this.save(s);if(this.state.storage.deleteAlarm)await this.state.storage.deleteAlarm();
      return json({ok:false,error:'EXCHANGE_RECONCILIATION_REQUIRED',outcome:settled.outcome,intentId},409);
    }
    s.seen[id]=Date.now();await this.save(s);
    return json({ok:true,proposal:planned.proposal,outcome:settled.outcome,intentId,exchange_order_sent:true,trading_enabled:true});
  }
}
