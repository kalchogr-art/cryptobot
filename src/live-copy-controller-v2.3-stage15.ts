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
type Coin=CopyCoinState & {lastWhaleTarget:number;lastPrice:number;lastEventAt:number;firstDetectedAt?:number;episode:number;addSignals?:number;lastAddSignalAt?:number};
type Snapshot={version:2;mode:'STOPPED'|'RUNNING';sessionKind?:'DRY_RUN'|'LIVE';startedAt:number|null;coins:Record<string,Coin>;seen:Record<string,number>;recent:{at:number;kind:string;coin?:string;detail?:string}[]};
const KEY='live_copy_v23_stage7';
const fresh=():Snapshot=>({version:2,mode:'STOPPED',sessionKind:'DRY_RUN',startedAt:null,coins:{},seen:{},recent:[]});
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const finite=(v:unknown)=>typeof v==='number'&&Number.isFinite(v);
const round=(n:number)=>Math.round(n*1e10)/1e10;
// ZEC ONLY: smallest exchange-valid initial order >= $10.40, with a hard $20 cap.
// No fallback to larger orders; no catch-up of old whale fills.
function zecInitialQuantity(price:number,decimals:number):number|null{
  if(!Number.isFinite(price)||price<=0||!Number.isInteger(decimals)||decimals<0||decimals>8)return null;
  const unit=10**(-decimals);
  const qty=Math.ceil((10.40/price)/unit-1e-9)*unit;
  const notional=qty*price;
  return notional>=10-1e-7&&notional<=20+1e-7?round(qty):null;
}

export class LiveCopyControllerStage7 {
  // Memory is a per-instance cache; the explicit START authorization is stored durably.
  private liveArmAt:number|null=null;
  private readonly metaCacheKey='live_copy_v23_meta_cache';
  private readonly rateLimitUntilKey='live_copy_v23_rate_limit_until';
  private isRateLimited(e:unknown){return /(?:HTTP_429|META_HTTP_429|RATE_LIMIT|TOO_MANY_REQUESTS)/i.test(String(e));}
  private async deferRateLimit(source:string){
    const until=Date.now()+60000;
    await this.state.storage.put(this.rateLimitUntilKey,until);
    const current=await this.load();this.audit(current,'HYPERLIQUID_RATE_LIMIT_BACKOFF',undefined,source+'; retry after 60s; NO ORDERS');await this.save(current);
    return until;
  }
  private async cachedMeta(){
    const old=await this.state.storage.get<{at:number;data:any}>(this.metaCacheKey);
    if(old&&Date.now()-old.at<30*60*1000&&Array.isArray(old.data?.universe))return old.data;
    const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'meta'})});
    if(!r.ok)throw Error('META_HTTP_'+r.status);
    const data:any=await r.json();if(!Array.isArray(data?.universe))throw Error('META_UNIVERSE_MISSING');
    await this.state.storage.put(this.metaCacheKey,{at:Date.now(),data});return data;
  }
  constructor(private state:State,private env:Env){}
  private async load(){return await this.state.storage.get<Snapshot>(KEY)||fresh();}
  private async save(s:Snapshot){
    await this.state.storage.put(KEY,s);
    // D1 is independent of order execution: telemetry failures never change a fill.
    const pending=this.activityQueue.splice(0);
    if(!pending.length||!this.env.DB)return;
    try{
      if(!this.activityTableReady){await this.env.DB.prepare('CREATE TABLE IF NOT EXISTS live_copy_our_activity (id TEXT PRIMARY KEY, at INTEGER NOT NULL, coin TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)').bind().all();this.activityTableReady=true;}
      for(const event of pending){
        await this.env.DB.prepare('INSERT OR IGNORE INTO live_copy_our_activity (id,at,coin,kind,detail) VALUES (?,?,?,?,?)').bind(event.id,event.at,event.coin,event.kind,event.detail).all();
      }
    }catch(_e){
      // Retain failed telemetry for retry; never block real-order state commits.
      this.activityQueue.unshift(...pending);
    }
  }
  private activityQueue:{id:string;at:number;coin:string;kind:string;detail:string}[]=[];
  private activityTableReady=false;

  private audit(s:Snapshot,kind:string,coin?:string,detail?:string){
    const at=Date.now();s.recent.unshift({at,kind,coin,detail});s.recent=s.recent.slice(0,100);
    if(coin&&kind!=='LIVE_ARM_RESTORED'){
      const id=coin+':'+at+':'+kind+':'+Math.random().toString(36).slice(2);
      this.activityQueue.push({id,at,coin,kind,detail:detail||''});
    }
  }

  // Alarms are serialized by the Durable Object. Never overwrite fresh state from /sync.
  async alarm():Promise<void>{
    const s=await this.load();
    if(s.mode!=='RUNNING')return;
    const rateLimitUntil=await this.state.storage.get<number>(this.rateLimitUntilKey)||0;
    if(Date.now()<rateLimitUntil){if(this.state.storage.setAlarm)await this.state.storage.setAlarm(rateLimitUntil+1000);return;}
    try{
      const response=await this.fetch(new Request('https://live-copy.internal/sync',{
        method:'POST',headers:{authorization:`Bearer ${this.env.LIVE_COPY_ADMIN_TOKEN}`,'content-type':'application/json'},body:'{}'
      }));
      const result:any=await response.json();
      if(!response.ok){
        if(result?.retryable===true&&result?.error==='HYPERLIQUID_RATE_LIMIT_BACKOFF'){
          if(this.state.storage.setAlarm)await this.state.storage.setAlarm(Math.max(Date.now()+1000,Number(result.retry_at)||Date.now()+60000));
          return;
        }
        const latest=await this.load();this.audit(latest,'AUTO_SYNC_ERROR',undefined,JSON.stringify(result).slice(0,240));
        latest.mode='STOPPED';await this.save(latest);return;
      }
      const latest=await this.load();
      if((result.processed||0)>0||(result.ignored||0)>0||result.bootstrapped)this.audit(latest,'AUTO_SYNC_OK',undefined,`processed=${result.processed||0} ignored=${result.ignored||0}`);
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
  // Read-only target telemetry. Public Hyperliquid info endpoint; no signing or orders.
  // Maker/taker counts are scoped to the current LIVE COPY START cursor, not watcher history.
  private async targetTelemetry(){
    const key='live_copy_v23_target_telemetry_cache';
    const prior=await this.state.storage.get<{at:number;value:any}>(key);
    if(prior&&Date.now()-prior.at<60000)return prior.value;
    const cursor=await this.state.storage.get<{session:string;rowid:number}>('live_copy_v23_d1_cursor');
    const baseline=await this.state.storage.get<{session:string;rowid:number;startedAt:number}>('live_copy_v23_session_baseline');
    const wallet=(this.env as any).LIVE_COPY_TARGET_ACCOUNT; // Explicit target only: never silently use a fallback wallet
    const info=async(type:string)=>{
      if(typeof wallet!=='string'||!/^0x[a-fA-F0-9]{40}$/.test(wallet))throw Error('LIVE_COPY_TARGET_ACCOUNT_MISSING_OR_INVALID');
      const controller=new AbortController();
      const timeout=setTimeout(()=>controller.abort(),8000);
      try{
        const response=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,user:wallet}),signal:controller.signal});
        if(!response.ok)throw Error(type+'_HTTP_'+response.status);
        return await response.json() as any;
      }finally{clearTimeout(timeout);}
    };
    const [orders,positions,counts]=await Promise.allSettled([
      info('openOrders'),info('clearinghouseState'),
      (async()=>{
        if(!this.env.DB||!baseline||!cursor)return null;
        // Only genuine target fills; ignore synthetic bookkeeping and gap-recovery rows.
        return await this.env.DB.prepare(`SELECT
          SUM(CASE WHEN json_extract(payload,'$.crossed') = 0 THEN 1 ELSE 0 END) AS maker,
          SUM(CASE WHEN json_extract(payload,'$.crossed') = 1 THEN 1 ELSE 0 END) AS taker
          FROM mc_watch_events
          WHERE rowid>? AND rowid<=? AND json_extract(payload,'$.source')='HYPERLIQUID_PUBLIC_FILL'
          AND COALESCE(json_extract(payload,'$.recovered_from_verified_skipped_fill'),0)=0
          AND action NOT IN ('GAP_CLOSE','RESYNC_CLOSE','RESYNC_REVERSAL')`)
          .bind(baseline.rowid,cursor.rowid).first<{maker:number|null;taker:number|null}>();
      })()
    ]);
    const errors:string[]=[];
    if(orders.status==='rejected')errors.push('openOrders: '+String(orders.reason));
    if(positions.status==='rejected')errors.push('clearinghouseState: '+String(positions.reason));
    if(counts.status==='rejected')errors.push('D1 fills: '+String(counts.reason));
    const openOrders=orders.status==='fulfilled'&&Array.isArray(orders.value)?orders.value.length:null;
    const rawPositions=positions.status==='fulfilled'?positions.value?.assetPositions:null;
    const openPositions=Array.isArray(rawPositions)?rawPositions.filter((x:any)=>Math.abs(Number(x?.position?.szi))>0).length:null;
    const stats=counts.status==='fulfilled'?counts.value:null;
    const result={target_maker_fills:stats!==null?Number(stats.maker||0):null,target_taker_fills:stats!==null?Number(stats.taker||0):null,
      target_open_orders:openOrders,target_open_positions:openPositions,
      target_session:cursor?.session||null,target_session_started_at:baseline?.startedAt??null,target_updated_at:Date.now(),target_errors:errors};
    if(errors.length&&prior)return {...prior.value,target_errors:errors,target_stale:true};
    await this.state.storage.put(key,{at:Date.now(),value:result});
    return result;
  }
  // No Hyperliquid calls in /status: reuse the snapshot explicitly fetched by /account.
  private async cachedAccount(){return await this.state.storage.get<{at:number;account:Awaited<ReturnType<typeof readLiveAccount>>}>('live_copy_v23_dashboard_account');}
  // Read-only, exchange-verified accounting. Refresh ONLY from /account, not /status
  // or the trading alarm. Match OIDs from our durable ledger; never attribute other
  // strategies' wallet fills to LIVE COPY.
  private async refreshCopyAccounting(s:Snapshot){
    const ledger=await this.ledger();
    const intents=Object.values(ledger.intents).filter(i=>i.exchangeOid&&i.confirmedFillQty>0&&
      ['FILLED','PARTIAL'].includes(i.status));
    const oids=new Map<string,typeof intents[number]>();
    for(const i of intents)oids.set(String(i.exchangeOid),i);
    const allConfirmed=Object.values(ledger.intents).filter(i=>i.confirmedFillQty>0);
    const missingOid=allConfirmed.filter(i=>!i.exchangeOid).length;
    const wallet=this.env.HYPERLIQUID_MASTER_ACCOUNT?.trim();
    if(!wallet||!/^0x[0-9a-fA-F]{40}$/.test(wallet))throw Error('INVALID_MASTER_ACCOUNT');
    const since=Math.max(0,Math.min(s.startedAt||Date.now(),...intents.map(i=>i.createdAt))-60000);
    const response=await fetch('https://api.hyperliquid.xyz/info',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({type:'userFillsByTime',user:wallet,startTime:since,aggregateByTime:false})
    });
    if(!response.ok)throw Error('FILLS_HTTP_'+response.status);
    const rows:any=await response.json();
    if(!Array.isArray(rows))throw Error('INVALID_FILLS_RESPONSE');
    // Hyperliquid caps this endpoint; a truncated response cannot be called complete.
    const possiblyTruncated=rows.length>=2000;
    const matches=rows.filter((f:any)=>oids.has(String(f.oid))&&
      Number.isFinite(Number(f.time))&&Number(f.time)>=since);
    const unique=new Map<string,any>();
    for(const f of matches){const key=String(f.hash||'')+':'+String(f.tid??'')+':'+String(f.oid);
      if(!unique.has(key))unique.set(key,f);}
    const fills=[...unique.values()];
    const sum=(key:string)=>fills.reduce((a,f)=>a+Number(f[key]),0);
    const valid=fills.every(f=>Number.isFinite(Number(f.px))&&Number(f.px)>0&&
      Number.isFinite(Number(f.sz))&&Number(f.sz)>0&&
      Number.isFinite(Number(f.fee))&&Number.isFinite(Number(f.closedPnl)));
    const realized=valid?sum('closedPnl'):null;
    const fees=valid?sum('fee'):null;
    const turnover=valid?fills.reduce((a,f)=>a+Number(f.px)*Number(f.sz),0):null;
    const closeIntents=intents.filter(i=>i.kind==='FULL_CLOSE'||i.kind==='MANUAL_CLOSE');
    const fullyMatched=closeIntents.filter(i=>{
      const group=fills.filter(f=>String(f.oid)===String(i.exchangeOid));
      const qty=group.reduce((a,f)=>a+Number(f.sz),0);
      return group.length>0&&Math.abs(qty-i.confirmedFillQty)<1e-7&&i.status==='FILLED';
    });
    const wins=fullyMatched.filter(i=>fills.filter(f=>String(f.oid)===String(i.exchangeOid))
      .reduce((a,f)=>a+Number(f.closedPnl)-Number(f.fee),0)>0).length;
    const allOidsMatched=intents.every(i=>{
      const group=fills.filter(f=>String(f.oid)===String(i.exchangeOid));
      const qty=group.reduce((a,f)=>a+Number(f.sz),0);
      return group.length>0&&Number.isFinite(qty)&&Math.abs(qty-i.confirmedFillQty)<=Math.max(1e-7,i.confirmedFillQty*1e-7);
    });
    // Do not call an empty history complete when the session has no confirmed orders.
    const complete=allConfirmed.length>0&&!possiblyTruncated&&!missingOid&&allOidsMatched&&valid;
    // A CLOSE order is not always a completed trade: partial CLOSEs, multiple
    // fills and reversals need position-level reconstruction for win rate.
    // Keep that metric unavailable rather than count order IDs as trades.
    const result={at:Date.now(),session_started_at:s.startedAt,realized_gross:valid&&fills.length?realized:null,
      fees:valid&&fills.length?fees:null,realized_net:valid&&fills.length?realized!-fees!:null,
      turnover:valid&&fills.length?turnover:null,
      closed_trades:null,win_rate:null,
      fill_count:fills.length,order_count:new Set(fills.map(f=>String(f.oid))).size,
      close_order_count:fullyMatched.length,close_order_wins:wins,
      confirmed_intents:allConfirmed.length,matched_intents:intents.filter(i=>fills.some(f=>String(f.oid)===String(i.exchangeOid))).length,
      missing_oid:missingOid,possibly_truncated:possiblyTruncated,complete,
      note:complete?'Matched to LIVE COPY exchange OIDs':
        'PARTIAL HISTORY: metrics include only verified matched OIDs; totals may be incomplete'};
    await this.state.storage.put('live_copy_v23_accounting_snapshot',result);
    return result;
  }
  private async cachedCopyAccounting(){
    return await this.state.storage.get<any>('live_copy_v23_accounting_snapshot');
  }
  private coinDetails(s:Snapshot,ledger:LiveLedger){
    return Object.values(s.coins).map(p=>{
      const intents=Object.values(ledger.intents).filter(i=>i.coin===p.coin).sort((a,b)=>a.createdAt-b.createdAt);
      const filled=intents.filter(i=>i.status==='FILLED');
      const entry=filled.find(i=>i.kind==='OPEN');
      const adds=filled.filter(i=>i.kind==='ADD');
      const latest=filled[filled.length-1];
      const actual=Number(ledger.confirmedByCoin[p.coin]||0);
      const desired=Number(p.lastWhaleTarget)*Number(p.scale);
      const delta=desired-actual;
      const increasing=Math.abs(actual)>1e-9 && Math.sign(delta)===Math.sign(actual);
      const pendingAddUsd=increasing?Math.max(0,Math.abs(delta)*Number(p.lastPrice)):0;
      const minimumUsd=10.40; // strategy threshold; exchange may impose another minimum
      return {...p,confirmedOwnQty:actual,addSignals:p.addSignals??null,
        pendingAddUsd:Math.round(pendingAddUsd*100)/100,
        addRemainingUsd:increasing?Math.round(Math.max(0,minimumUsd-pendingAddUsd)*100)/100:null,
        addMinimumUsd:minimumUsd,filledAdds:adds.length,
        openedAt:entry?.createdAt??null,lastAddAt:adds.length?adds[adds.length-1].updatedAt:null,
        lastOrderAt:latest?.updatedAt??null,lastAddSignalAt:p.lastAddSignalAt??null,
        confirmedFillCount:filled.length};
    });
  }
  private async overviewStatus(s:Snapshot){
    const o=await this.overview();
    const ledger=await this.ledger();
    const target=await this.targetTelemetry();
    const cache=await this.cachedAccount();
    const accountingCache=await this.cachedCopyAccounting();
    const accounting=accountingCache?.session_started_at===s.startedAt?accountingCache:null;
    const account=cache&&Date.now()-cache.at<120000?cache.account:null;
    const intents=Object.values(ledger.intents);
    const confirmedIntents=intents.filter(i=>i.status==='FILLED');
    const ownedOpen=Object.values(ledger.confirmedByCoin).filter(q=>Number.isFinite(q)&&Math.abs(q)>1e-9).length;
    const paper=s.sessionKind==='DRY_RUN'?await this.paper():null;
    const validPaper=!!paper&&paper.startedAt===s.startedAt;
    // NEVER mix virtual fills or estimated fees with LIVE financial metrics.
    // LIVE fills are matched by exchange OID; missing matches remain unavailable.
    // Capital stays unchanged; account snapshots are read-only.
    const dry=s.sessionKind!=='LIVE';
    const skipped=validPaper?Number(paper.skipped||0):null;
    const accuracyCoins=Object.values(s.coins).filter(c=>Number.isFinite(c.scale)&&c.scale>0&&Number.isFinite(c.lastWhaleTarget));
    const accurate=accuracyCoins.filter(c=>{
      const desired=c.lastWhaleTarget*c.scale,actual=Number(ledger.confirmedByCoin[c.coin]||0);
      return Math.abs(desired-actual)<=Math.max(0.005*Math.abs(desired),1e-8);
    }).length;
    // Unified USDC collateral is the account-wide balance basis used for initial capital.
    // Never add PERP accountValue: it can double-count collateral in unified mode.
    // Other spot assets are not valued here; do not label this full multi-asset portfolio equity.
    // Do not confuse account-wide balance with LIVE COPY strategy performance.
    const validNumber=(v:unknown):number|null=>typeof v==='number'&&Number.isFinite(v)?v:null;
    const accountEquity=dry?null:validNumber(account?.spotUsdcTotal);
    const accountUnrealized=dry||!account?null:
      account.positions.every(p=>Number.isFinite(p.unrealized))
        ? account.positions.reduce((total,p)=>total+p.unrealized,0):null;
    return {
      capital:o?.capital??null,capital_at:o?.startedAt??null,
      capital_source:o?.source??null,reset_count:o?.resetCount??0,
      equity:accountEquity,roi:!dry&&accounting?.complete&&o?.capital>0&&Number.isFinite(accounting.realized_net)&&account&&account.positions.every(p=>Math.abs(Number(ledger.confirmedByCoin[p.coin]||0)-p.qty)<1e-8)&&Number.isFinite(accountUnrealized)?(accounting.realized_net+accountUnrealized)/o.capital*100:null,free_margin:dry?null:validNumber(account?.withdrawable),used_margin:dry?null:validNumber(account?.totalMarginUsed),
      realized_gross:dry?null:accounting?.realized_gross??null,
      fees:dry?null:accounting?.fees??null,
      realized_net:dry?null:accounting?.realized_net??null,
      unrealized:accountUnrealized,turnover:dry?null:accounting?.turnover??null,
      our_open_positions:dry?0:ownedOpen,
      closed_trades:dry?null:accounting?.closed_trades??null,
      win_rate:dry?null:accounting?.win_rate??null,
      processed_fills:Object.keys(s.seen).length,skipped,
      own_exchange_fills:accounting?.fill_count??null,own_exchange_orders:accounting?.order_count??null,
      copy_accuracy:dry||!accuracyCoins.length?null:accurate/accuracyCoins.length*100,
      accuracy_sample:dry?null:accuracyCoins.length,
      ...target,
      ledger_intents:intents.length,confirmed_intents:confirmedIntents.length,
      accounting_mode:dry?'DRY_RUN_DIAGNOSTIC_ONLY':accounting?.complete?'LIVE_MATCHED_EXCHANGE_FILLS':'LIVE_PARTIAL_EXCHANGE_FILLS',
      accounting_snapshot_at:accounting?.at??null,accounting_diagnostic:accounting??null,
      paper_session_ready:validPaper,paper_started_at:paper?.startedAt??null,
      session_started_at:s.startedAt,telemetry_error:target.target_errors,
      account_snapshot_at:account?cache?.at:null,account_metrics_scope:"UNIFIED_USDC_COLLATERAL_NOT_FULL_MULTI_ASSET_PORTFOLIO",
      diagnostic_paper_proposals:validPaper?Number(paper.executions||0):null,
      diagnostic_paper_accuracy_sample:validPaper?Number(paper.accuracySample||0):null,
      accounting_note:dry
        ? 'DRY RUN: no real orders. All financial and own-position figures are intentionally hidden; proposals are diagnostics only.'
        : 'LIVE: Equity показва общия USDC collateral от Unified акаунта, без да добавя PERP accountValue втори път. Други spot активи не са оценени. Маржинът е от PERP snapshot. P/L, такси и оборот са само от съпоставени LIVE COPY OID; при непълна история са частични. ROI се показва само при пълно съпоставяне на fills и ако всички отворени PERP позиции съвпадат с LIVE COPY ledger; външни потоци могат да го изкривят. Натисни БАЛАНС за обновяване. '+(accounting?.note||'Няма отчет от fills.')
    };
  }

  // Independent, session-scoped PAPER ledger. Never mistaken for real exchange fills.
  private async paper(){return await this.state.storage.get<any>('live_copy_v23_paper_session')||null;}
  private async paperReset(startedAt:number){
    await this.state.storage.put('live_copy_v23_paper_session',{startedAt,positions:{},realizedGross:0,fees:0,turnover:0,closed:0,wins:0,executions:0,skipped:0,accuracySample:0,accuracyHits:0});
  }
  private async paperFill(coin:string,price:number,delta:number,feeRate=0.00045){
    if(!Number.isFinite(delta)||Math.abs(delta)<1e-12||!Number.isFinite(price)||price<=0)return;
    const a=await this.paper();if(!a)return;
    const old=a.positions[coin]||{qty:0,entry:0,mark:price};
    let qty=old.qty,entry=old.entry,realized=0,closed=false;
    if(Math.abs(qty)>1e-10&&Math.sign(qty)!==Math.sign(delta)){
      const reduced=Math.min(Math.abs(qty),Math.abs(delta));
      realized=(price-entry)*reduced*Math.sign(qty);
      qty+=Math.sign(delta)*reduced;
      closed=Math.abs(qty)<1e-10;
      if(closed){qty=0;entry=0;}
      const residual=Math.abs(delta)-reduced;
      if(residual>1e-10){qty=Math.sign(delta)*residual;entry=price;}
    }else{
      const newQty=qty+delta;
      entry=Math.abs(newQty)>1e-10?(Math.abs(qty)*entry+Math.abs(delta)*price)/Math.abs(newQty):0;
      qty=newQty;
    }
    a.realizedGross+=realized;a.turnover+=Math.abs(delta*price);a.fees+=Math.abs(delta*price)*feeRate;
    a.executions++;if(closed){a.closed++;if(realized>0)a.wins++;}
    a.positions[coin]={qty,entry,mark:price};
    await this.state.storage.put('live_copy_v23_paper_session',a);
  }
  private async paperMark(coin:string,price:number){
    const a=await this.paper();if(!a||!a.positions[coin])return;
    a.positions[coin].mark=price;await this.state.storage.put('live_copy_v23_paper_session',a);
  }
  private async paperSkip(){const a=await this.paper();if(a){a.skipped++;await this.state.storage.put('live_copy_v23_paper_session',a);}}
  private liveEnabled(){return this.env.LIVE_COPY_TRADING_ENABLED==='true'&&this.env.LIVE_COPY_AUTO_EXECUTION_ENABLED==='true'&&this.env.LIVE_COPY_LEVERAGE_VERIFIED==='true'&&this.env.LIVE_COPY_LEVERAGE_MODE==='cross';}
  private armConfig(){return JSON.stringify({trading:this.env.LIVE_COPY_TRADING_ENABLED,auto:this.env.LIVE_COPY_AUTO_EXECUTION_ENABLED,leverage:this.env.LIVE_COPY_LEVERAGE_VERIFIED,mode:this.env.LIVE_COPY_LEVERAGE_MODE,account:this.env.HYPERLIQUID_MASTER_ACCOUNT});}
  private async restoreLiveArm(s:Snapshot):Promise<{ok:boolean;reason:string}>{
    if(s.mode!=='RUNNING'||s.sessionKind!=='LIVE'||!this.liveEnabled()||!s.startedAt)return {ok:false,reason:'LIVE_CONFIGURATION_DISABLED_OR_CHANGED'};
    if(this.liveAuthorized(s))return {ok:true,reason:'AUTHORIZED'};
    const saved=await this.state.storage.get<{startedAt:number;config:string}>('live_copy_v23_durable_arm');
    if(!saved||saved.startedAt!==s.startedAt)return {ok:false,reason:'DURABLE_ARM_MISSING_OR_SESSION_MISMATCH'};
    if(saved.config!==this.armConfig())return {ok:false,reason:'LIVE_CONFIGURATION_CHANGED'};
    try{
      const ledger=await this.ledger();
      if(Object.values(ledger.intents).some(i=>['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status)))return {ok:false,reason:'UNRESOLVED_INTENTS_REQUIRE_MANUAL_RECONCILIATION'};
      const account=await readLiveAccount(this.env);
      const report=reconcileCopyLedger(ledger,account.positions,account.assetMeta);
      if(!report.safeToTrade)return {ok:false,reason:'RESTART_RECONCILIATION_BLOCKED'};
      this.liveArmAt=s.startedAt;
      this.audit(s,'LIVE_ARM_RESTORED',undefined,'Durable authorization and exchange reconciliation verified');
      await this.save(s);
      return {ok:true,reason:'AUTHORIZED_RESTORED'};
    }catch(e){if(this.isRateLimited(e))return {ok:false,reason:'HYPERLIQUID_RATE_LIMIT_RETRY'};return {ok:false,reason:'RESTART_ACCOUNT_CHECK_FAILED:'+String(e).slice(0,120)};}
  }
  private liveAuthorized(s:Snapshot){return s.mode==='RUNNING'&&s.sessionKind==='LIVE'&&this.liveArmAt!==null&&this.liveArmAt===s.startedAt&&this.liveEnabled();}
  private liveAuthorizationReason(s:Snapshot):string {
    if(s.mode!=='RUNNING')return 'SESSION_NOT_RUNNING';
    if(s.sessionKind!=='LIVE')return 'SESSION_NOT_LIVE';
    if(!this.liveEnabled())return 'LIVE_CONFIGURATION_DISABLED_OR_CHANGED';
    if(this.liveArmAt===null)return 'VOLATILE_LIVE_ARM_LOST_RESTART_OR_REDEPLOY';
    if(this.liveArmAt!==s.startedAt)return 'LIVE_ARM_SESSION_MISMATCH';
    return 'AUTHORIZED';
  }
  private async halt(reason:string,coin?:string){this.liveArmAt=null;await this.state.storage.put('live_copy_v23_durable_arm',null);const s=await this.load();s.mode='STOPPED';this.audit(s,'LIVE_HALTED',coin,reason);await this.save(s);if(this.state.storage.deleteAlarm)await this.state.storage.deleteAlarm();}
  async fetch(request:Request):Promise<Response>{
    if(!this.env.LIVE_COPY_ADMIN_TOKEN||request.headers.get('authorization')!==`Bearer ${this.env.LIVE_COPY_ADMIN_TOKEN}`)return json({ok:false,error:'UNAUTHORIZED'},401);
    const path=new URL(request.url).pathname;
    const s=await this.load();
    if(request.method==='GET'&&path==='/diagnostic'){
      const cursor=await this.state.storage.get<{session:string;rowid:number}>('live_copy_v23_d1_cursor');
      if(!this.env.DB)return json({ok:false,error:'DB_BINDING_MISSING'},503);
      try{
        const latest=await this.env.DB.prepare('SELECT rowid,session_id,fill_id,at,coin,action,payload FROM mc_watch_events ORDER BY rowid DESC LIMIT 1').bind().first<{rowid:number;session_id:string;fill_id:string;at:number;coin:string;action:string;payload:string}>();
        const last=latest?{rowid:latest.rowid,session:latest.session_id,fill_id:latest.fill_id,at:latest.at,coin:latest.coin,action:latest.action}:null;
        const pending=await this.env.DB.prepare('SELECT COUNT(*) AS n FROM mc_watch_events WHERE rowid>?').bind(cursor?.rowid||0).first<{n:number}>();
        return json({ok:true,read_only:true,mode:s.mode,cursor:cursor||null,latest_source:last,pending_rows:pending?.n??null,watcher_session_matches:!cursor?.session||!latest||cursor.session===latest.session_id,warning:'Older source rows are never replayed as real trades.'});
      }catch(e){return json({ok:false,error:'D1_DIAGNOSTIC_FAILED',detail:String(e)},503);}
    }
    if(request.method==='GET'&&path==='/our-activity'){
      if(!this.env.DB)return json({ok:false,error:'D1_BINDING_MISSING'},503);
      const coin=new URL(request.url).searchParams.get('coin')?.toUpperCase()||'';
      if(coin&&!/^[A-Z0-9]{2,20}$/.test(coin))return json({ok:false,error:'INVALID_COIN'},400);
      try{
        if(!this.activityTableReady){await this.env.DB.prepare('CREATE TABLE IF NOT EXISTS live_copy_our_activity (id TEXT PRIMARY KEY, at INTEGER NOT NULL, coin TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL)').bind().all();this.activityTableReady=true;}
        const sql=coin?'SELECT id,at,coin,kind,detail FROM live_copy_our_activity WHERE coin=? ORDER BY at DESC LIMIT 200':'SELECT id,at,coin,kind,detail FROM live_copy_our_activity ORDER BY at DESC LIMIT 200';
        const rows=await this.env.DB.prepare(sql).bind(...(coin?[coin]:[])).all();
        return json({ok:true,coin:coin||null,events:rows.results,read_only:true});
      }catch(e){return json({ok:false,error:'OUR_ACTIVITY_UNAVAILABLE',detail:String(e)},503);}
    }
    if(request.method==='GET'&&path==='/status')return json({ok:true,overview:await this.overviewStatus(s),version:'V2.3_STAGE_15_3_SAFETY_REVIEW',mode:s.mode,auto_sync_enabled:s.mode==='RUNNING',poll_interval_seconds:15,live_execution_wired:true,manual_close_wired:true,session_kind:s.sessionKind||'DRY_RUN',live_session_authorized:this.liveAuthorized(s),live_authorization_reason:this.liveAuthorizationReason(s),manual_close_enabled:this.env.LIVE_COPY_TRADING_ENABLED==='true'&&(this.env as any).LIVE_COPY_MANUAL_CLOSE_ENABLED==='true',trading_enabled:this.liveAuthorized(s),auto_execution_configured:this.liveEnabled(),started_at:s.startedAt,coins:this.coinDetails(s,await this.ledger()),recent:s.recent,processed_event_ids:Object.keys(s.seen).length,ledger_intents:Object.keys((await this.ledger()).intents).length});
    if(request.method!=='POST')return json({ok:false,error:'NOT_FOUND'},404);
    let body:any={};try{body=await request.json();}catch{return json({ok:false,error:'INVALID_JSON'},400);}
    if(path==='/overview-init'){
      try{const overview=await this.ensureOverview();return json({ok:true,overview,read_only:true});}
      catch(e){return json({ok:false,error:'OVERVIEW_CAPITAL_UNAVAILABLE',detail:String(e)},503);}
    }
    if(path==='/stop'){this.liveArmAt=null;await this.state.storage.put('live_copy_v23_durable_arm',null);s.mode='STOPPED';this.audit(s,'STOP');await this.save(s);if(this.state.storage.deleteAlarm)await this.state.storage.deleteAlarm();return json({ok:true,mode:s.mode,positions_untouched:true});}
    if(path==='/start'&&s.mode==='RUNNING')return json({ok:false,error:'ALREADY_RUNNING_STOP_FIRST'},409);
    if(path==='/start'){this.liveArmAt=null;await this.state.storage.put('live_copy_v23_durable_arm',null);if(this.liveEnabled()&&body.confirm!=='START_REAL_HYPERLIQUID_COPY')return json({ok:false,error:'EXPLICIT_LIVE_CONFIRMATION_REQUIRED'},409);if(this.liveEnabled()){try{const account=await readLiveAccount(this.env);const ledger=await this.ledger();const report=reconcileCopyLedger(ledger,account.positions,account.assetMeta);if(Object.values(ledger.intents).some(i=>['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status)))return json({ok:false,error:'UNRESOLVED_INTENTS_REQUIRE_MANUAL_RECONCILIATION'},409);if(!report.safeToTrade)return json({ok:false,error:'PRE_START_RECONCILIATION_BLOCKED',report},409);}catch(e){return json({ok:false,error:'PRE_START_ACCOUNT_CHECK_FAILED',detail:String(e)},409);}}if(!this.state.storage.setAlarm)return json({ok:false,error:'ALARM_STORAGE_UNAVAILABLE'},503);
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
      // Every START begins a fresh telemetry session. Never erase the persistent
      // real-order ledger or re-anchor LIVE positions without the existing safety checks.
      if(!this.env.DB)return json({ok:false,error:'DB_BINDING_MISSING'},503);
      const last=await this.env.DB.prepare('SELECT session_id AS session, rowid FROM mc_watch_events ORDER BY rowid DESC LIMIT 1').bind().first<{session:string;rowid:number}>();
      const startedAt=Date.now();
      const anchor={session:last?.session||'',rowid:last?.rowid||0};
      await this.state.storage.put('live_copy_v23_d1_cursor',anchor);
      await this.state.storage.put('live_copy_v23_session_baseline',{...anchor,startedAt});
      s.coins={};s.seen={};s.recent=[];
      if(!this.liveEnabled())await this.paperReset(startedAt);
      s.mode='RUNNING';s.startedAt=startedAt;s.sessionKind=this.liveEnabled()?'LIVE':'DRY_RUN';this.audit(s,s.sessionKind==='LIVE'?'START_AUTO_SYNC_LIVE':'START_AUTO_SYNC_DRY_RUN');await this.save(s);if(s.sessionKind==='LIVE'){await this.state.storage.put('live_copy_v23_durable_arm',{startedAt:s.startedAt,config:this.armConfig()});this.liveArmAt=s.startedAt;}await this.state.storage.setAlarm(Date.now()+1000);return json({ok:true,mode:s.mode,trading_enabled:this.liveAuthorized(s)});}
    if(path==='/sync'){
      if(s.mode==='RUNNING'&&s.sessionKind==='LIVE'&&!this.liveAuthorized(s)){const restored=await this.restoreLiveArm(s);if(!restored.ok){if(restored.reason==='HYPERLIQUID_RATE_LIMIT_RETRY'){const retryAt=await this.deferRateLimit('RESTORE_LIVE_ARM');return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:retryAt,exchange_order_sent:false},503);}
        await this.halt('LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED:'+restored.reason);return json({ok:false,error:'LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED',reason:restored.reason,stopped:true},409);}}
      if(s.mode==='RUNNING'&&((s.sessionKind==='LIVE'&&!this.liveAuthorized(s))||(s.sessionKind!=='LIVE'&&this.liveEnabled()))){const reason=s.sessionKind==='LIVE'?this.liveAuthorizationReason(s):'DRY_RUN_CONFIGURATION_CHANGED_TO_LIVE';await this.halt('LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED:'+reason);return json({ok:false,error:'LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED',reason,stopped:true},409);}
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
      try{metadata=await this.cachedMeta();}
      catch(e){metadataError=String(e);}
      if(metadataError){if(this.isRateLimited(metadataError)){const retryAt=await this.deferRateLimit('METADATA');return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:retryAt,exchange_order_sent:false},503);}
        await this.halt('METADATA_UNAVAILABLE');return json({ok:false,error:'METADATA_UNAVAILABLE',detail:metadataError,cursor,stopped:true},503);}
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
        const event={coin:row.coin,fill_id:row.fill_id,source_action:row.action,whale_before_qty:e.target_before,whale_target_qty:e.target_after,price:e.price,sz_decimals:decimals,time:row.at};
        const response=await this.fetch(new Request('https://live-copy.internal/event',{method:'POST',headers:{authorization:`Bearer ${this.env.LIVE_COPY_ADMIN_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(event)}));
        const result:any=await response.json();
        if(!response.ok){failure={error:'EVENT_REJECTED',rowid:row.rowid,coin:row.coin,detail:result};break;}
        if(result.ignored)ignored++;else processed++;
        if(row.action==='REVERSAL'){const latest=await this.load();this.audit(latest,result.ignored?'REVERSAL_IGNORED':'REVERSAL_HANDLED',row.coin,`rowid=${row.rowid} reason=${result.reason||result.proposal?.reason||'accepted'}`);await this.save(latest);}
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
      try { const account=await readLiveAccount(this.env);await this.state.storage.put('live_copy_v23_dashboard_account',{at:Date.now(),account});
        let accounting:any=null,accounting_error:string|null=null;
        if(s.sessionKind==='LIVE')try{accounting=await this.refreshCopyAccounting(s);}catch(e){accounting_error=String(e);}
        return json({ok:true,account,accounting,accounting_error}); }
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
              await this.paperReset(overview_reset.startedAt);
              this.audit(s,'OVERVIEW_CAPITAL_RESET',undefined,'New verified USDC snapshot after owned positions flat');
            }catch(e){this.audit(s,'OVERVIEW_RESET_PENDING',undefined,String(e).slice(0,150));}
          }else this.audit(s,'OVERVIEW_RESET_BLOCKED',undefined,'Owned positions or unresolved intents remain');
        }
        this.audit(s,'MANUAL_CLOSE_COMMAND',body.coin,JSON.stringify(result).slice(0,240));
        if(path==='/close-all')for(const [coin,qty] of Object.entries((await this.ledger()).confirmedByCoin))
          this.audit(s,'CLOSE_ALL_POSITION_RESULT',coin,`remaining_confirmed_qty=${qty}; command=${commandId}`);await this.save(s);
        return json({ok:true,result,overview_reset,live_write_attempted:true});
      }catch(e){return json({ok:false,error:'MANUAL_CLOSE_FAILED',detail:String(e)},409);}
    }
    if(path!=='/event')return json({ok:false,error:'NOT_FOUND'},404);
    if(s.mode!=='RUNNING')return json({ok:false,error:'STOPPED'},409);
    const {coin,fill_id,source_action,whale_target_qty,whale_before_qty,price,sz_decimals,time}=body;
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
    if(s.sessionKind==='DRY_RUN')await this.paperMark(coin,price);
    const old=s.coins[coin];
    if(old&&time<old.lastEventAt)return json({ok:false,error:'OUT_OF_ORDER_EVENT'},409);
    if(old&&Math.abs(whale_before_qty-old.lastWhaleTarget)>1e-7)return json({ok:false,error:'TARGET_CHAIN_GAP'},409);
    if(old?.suspended)return json({ok:true,ignored:true,reason:'COIN_SUSPENDED',exchange_order_sent:false});
    // A genuine public fill can reverse an inherited whale position.
    // The old side was NEVER owned by LIVE COPY: anchor only the NEW side.
    // Never synthesize a close order for the inherited side.
    const inheritedReversal=!old && source_action==='REVERSAL' &&
      Math.abs(whale_before_qty)>1e-10 && Math.abs(whale_target_qty)>1e-10 &&
      Math.sign(whale_before_qty)!==Math.sign(whale_target_qty);
    if(!old && !inheritedReversal && (Math.abs(whale_before_qty)>1e-10||Math.abs(whale_target_qty)<1e-10)){
      if(s.sessionKind==='DRY_RUN')await this.paperSkip();
      s.seen[id]=Date.now();this.audit(s,'SKIP_INHERITED',coin,`source=${source_action||'UNKNOWN'} before=${whale_before_qty} after=${whale_target_qty}`);await this.save(s);
      return json({ok:true,ignored:true,reason:'WAIT_NEW_FLAT_TO_OPEN',exchange_order_sent:false});
    }
    if(inheritedReversal){
      this.audit(s,'INHERITED_REVERSAL_NEW_ENTRY',coin,`before=${whale_before_qty} after=${whale_target_qty} fill=${fill_id}; fixed_entry_notional=10.40`);
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
    // For ZEC, a fresh initial entry is sized to a valid exchange quantity.
    // Also repair an unfilled tracked ZEC episode with no outstanding intent.
    // Never resize an existing real position or touch any other coin.
    const zecUnfilled=coin==='ZEC'&&!!old&&Math.abs(old.confirmedOwnQty)<1e-10&&
      !old.pendingIntentId&&!old.suspended&&Math.abs((await this.ledger()).confirmedByCoin[coin]||0)<1e-10;
    const zecQty=coin==='ZEC'&&(!old||newEpisode||zecUnfilled)?zecInitialQuantity(price,sz_decimals):null;
    const scale=(coin==='ZEC'&&zecQty!==null&&(!old||newEpisode||zecUnfilled))
      ?zecQty/Math.abs(whale_target_qty)
      :(!old||newEpisode)?10.40/(Math.abs(whale_target_qty)*price):old.scale;

    if(!Number.isFinite(scale)||scale<=0)return json({ok:false,error:'INVALID_SCALE'},400);
    const record:Coin=(old&&!newEpisode)?{...old,lastWhaleTarget:whale_target_qty,lastPrice:price,lastEventAt:time,firstDetectedAt:old.firstDetectedAt??Date.now(),lastFillId:fill_id}:{coin,anchorTargetQty:whale_target_qty,scale,confirmedOwnQty:0,pendingIntentId:null,suspended:false,lastFillId:fill_id,lastWhaleTarget:whale_target_qty,lastPrice:price,lastEventAt:time,firstDetectedAt:Date.now(),episode:(old?.episode||0)+1};
    // Count new ADD signals only for an already tracked/owned position.
    // Persist together with the accepted event, not on failed exchange writes.
    const isAddSignal=!!old&&!newEpisode&&source_action==='ADD'&&Math.abs(old.confirmedOwnQty)>1e-9;
    const addCount=(old?.addSignals||0)+(isAddSignal?1:0);
    record.addSignals=newEpisode?0:addCount;
    record.lastAddSignalAt=isAddSignal?Date.now():(newEpisode?undefined:old?.lastAddSignalAt);
    const ledger=await this.ledger();
    if(coin==='ZEC'&&(!old||newEpisode||zecUnfilled)&&zecQty===null){
      this.audit(s,'ZEC_MINIMUM_BLOCKED',coin,`price=${price}; szDecimals=${sz_decimals}; cap=$20; no order`);
      // Do not silently increase beyond cap or mark the source fill as executed.
    }
    if(ledger.suspendedCoins[coin])return json({ok:false,error:'MANUALLY_CLOSED_COIN_REQUIRES_REARM'},409);
    // An inherited reversal creates a NEW position on the opposite side.
    // The previous side was never ours, so do not send any close for it.
    // New entry sizing uses the fixed $10.40 notional anchor above.
    if(s.sessionKind==='DRY_RUN'){
      const paper=await this.paper();
      const paperQty=Number(paper?.positions?.[coin]?.qty||0);
      const proposal=planCopyAction({state:{...record,confirmedOwnQty:paperQty},whaleTargetQty:whale_target_qty,price,szDecimals:sz_decimals});
      if(proposal.kind!=='NONE'&&proposal.quantity>0){
        await this.paperFill(coin,price,proposal.signedDelta);
      }else{await this.paperSkip();}
      // Count every eligible tracked target update as a paper alignment sample.
      // This is NOT exchange execution accuracy.
      const accuracyPaper=await this.paper();
      if(accuracyPaper){
        const desired=whale_target_qty*record.scale;
        const actual=Number(accuracyPaper.positions?.[coin]?.qty||0);
        const tolerance=Math.max(Math.pow(10,-sz_decimals),Math.abs(desired)*0.005);
        accuracyPaper.accuracySample=Number(accuracyPaper.accuracySample||0)+1;
        if(Math.abs(actual-desired)<=tolerance)accuracyPaper.accuracyHits=Number(accuracyPaper.accuracyHits||0)+1;
        await this.state.storage.put('live_copy_v23_paper_session',accuracyPaper);
      }
      const updatedPaper=await this.paper();
      record.confirmedOwnQty=Number(updatedPaper?.positions?.[coin]?.qty||0);
      s.coins[coin]=record;s.seen[id]=Date.now();this.audit(s,'DRY_RUN_PROPOSAL',coin,`${proposal.kind}:${proposal.reason}${inheritedReversal?' [INHERITED_REVERSAL_NEW_SIDE]':''}`);
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
    }catch(e){if(this.isRateLimited(e)){const retryAt=await this.deferRateLimit('PRE_TRADE_READ_ONLY_CHECK');return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:retryAt,exchange_order_sent:false},503);}
      await this.halt('PRE_TRADE_CHECK_FAILED:'+String(e).slice(0,120),coin);return json({ok:false,error:'PRE_TRADE_CHECK_FAILED',detail:String(e)},409);}
    if(Object.values(ledger.intents).some(i=>i.coin===coin&&['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status))){await this.halt('UNRESOLVED_INTENT_BEFORE_NEW_ORDER',coin);return json({ok:false,error:'UNRESOLVED_INTENT_BEFORE_NEW_ORDER'},409);}
    const intentId=`AUTO:${coin}:${fill_id}`;
    let planned;
    try{planned=planAndReserve({state:record,ledger,whaleTargetQty:whale_target_qty,price:markPrice,szDecimals:sz_decimals,sourceFillId:fill_id,intentId,now:Date.now()});}
    catch(e){await this.halt('INTENT_PLANNING_FAILED:'+String(e).slice(0,120),coin);return json({ok:false,error:'INTENT_PLANNING_FAILED',detail:String(e)},409);}
    if(!planned.intent){s.coins[coin]=record;s.seen[id]=Date.now();this.audit(s,'LIVE_ACCUMULATING',coin,planned.proposal.reason+` pending_usd=${planned.proposal.pendingNotional.toFixed(4)}`);await this.save(s);return json({ok:true,proposal:planned.proposal,exchange_order_sent:false,trading_enabled:true});}
    // Persist the reservation and in-flight state BEFORE the exchange request.
    await this.state.storage.put('live_copy_v23_ledger',planned.ledger);
    s.coins[coin]=planned.state as Coin;await this.save(s);
    this.audit(s,'OUR_ORDER_SUBMITTING',coin,`${planned.proposal.kind} qty=${planned.proposal.quantity} reference=${markPrice} reduceOnly=${planned.proposal.reduceOnly}`);await this.save(s);
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
    this.audit(s,'LIVE_ORDER_'+settled.outcome,coin,`${planned.proposal.kind} qty=${planned.proposal.quantity} filled=${receipt.filledQty??'unknown'} oid=${receipt.oid??'unknown'} intent=${intentId}`);
    if(settled.outcome==='UNKNOWN'||settled.outcome==='PARTIAL'){
      s.mode='STOPPED';await this.save(s);if(this.state.storage.deleteAlarm)await this.state.storage.deleteAlarm();
      return json({ok:false,error:'EXCHANGE_RECONCILIATION_REQUIRED',outcome:settled.outcome,intentId},409);
    }
    s.seen[id]=Date.now();await this.save(s);
    return json({ok:true,proposal:planned.proposal,outcome:settled.outcome,intentId,exchange_order_sent:true,trading_enabled:true});
  }
}
