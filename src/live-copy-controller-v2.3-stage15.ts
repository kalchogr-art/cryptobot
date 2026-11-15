/** V19 NET POSITION COPY — standalone replacement for src/live-copy-controller-v2.3-stage15.ts.
 * Source: mc_v19_fills (userFills only). OPEN/CANCEL are NEVER copied.
 * One DO serializes decisions. Live trading requires explicit existing flags + START confirmation.
 * Data validation, dedupe, write uncertainty and exchange reality are kept separate from obsolete V18 ledger.
 * Live deployment NOT validated against exchange; test SHADOW then small funded live with account flat.
 */
import { bytesToHex, concat, keccak256, recoverTypedDataAddress } from 'viem';
import { encode } from '@msgpack/msgpack';
import { privateKeyToAccount } from 'viem/accounts';
namespace __LC_EXECUTION {

/**
 * LIVE COPY V2.3 — isolated Hyperliquid execution adapter.
 * NOT connected to the watcher or dashboard yet. LIVE writes are gated by
 * LIVE_COPY_TRADING_ENABLED === 'true' and explicit caller authorization.
 * Use a Durable Object as the sole serialized caller. Never retry ambiguous writes.
 * Dependencies: viem, @msgpack/msgpack.
 */




const INFO = 'https://api.hyperliquid.xyz/info';
const EXCHANGE = 'https://api.hyperliquid.xyz/exchange';
const DEFAULT_MIN_NOTIONAL = 10.40; // strategy's conservative threshold, not exchange guarantee
const MAX_PRICE_DEVIATION = 0.0075;
const NONCE_LOCK = new Map<string, number>(); // worker-isolate only; DO must serialize requests
export interface LiveCopyEnv {
  HYPERLIQUID_API_PRIVATE_KEY?: string;
  HYPERLIQUID_MASTER_ACCOUNT?: string;
  LIVE_COPY_TRADING_ENABLED?: string;
  LIVE_COPY_LEVERAGE_VERIFIED?: string;
  LIVE_COPY_LEVERAGE_MODE?: string;
}
export type Direction = 'LONG' | 'SHORT';
export type LiveOrderIntent = {
  intentId: string; coin: string; direction: Direction; quantity: number;
  reduceOnly: boolean; referencePrice: number;
};
export type LiveResult = {
  ok: boolean; executed: boolean; status: string; coin: string;
  intentId: string; requestedQty?: number; filledQty?: number;
  averageFillPrice?: number; oid?: number | string; raw?: unknown; cloid?:string; orderSent?:boolean|'UNKNOWN';
};
const n = (x: unknown) => Number(x);
const validAddress = (x: string) => /^0x[0-9a-fA-F]{40}$/.test(x);
const keyFormat = (x: string) => /^0x[0-9a-fA-F]{64}$/.test(x);
export const normalizeKey = (x?: string) => x ? (x.startsWith('0x') ? x : `0x${x}`) : '';
const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
  const raw = await r.text();
  let data: any; try { data = JSON.parse(raw); } catch { throw Error(`NON_JSON_RESPONSE_${r.status}`); }
  if (!r.ok) throw Error(`HYPERLIQUID_HTTP_${r.status}:${JSON.stringify(data).slice(0,250)}`);
  return data;
};
const info = (body: unknown) => post(INFO, body);
/** Stable 128-bit client ID: never use an untracked random order identifier. */
export function cloidForIntent(intentId:string):string {
  if(!intentId||intentId.length>220)throw Error('INVALID_INTENT_FOR_CLOID');
  return '0x'+keccak256(bytesToHex(new TextEncoder().encode('LIVE_COPY_V23:'+intentId))).slice(2,34);
}
const decimalQty = (q: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.floor((q + 1e-12) * factor) / factor;
};
function formatPrice(px: number, szDecimals: number): string {
  if (!Number.isFinite(px) || px <= 0) throw Error('INVALID_PRICE');
  // Hyperliquid perps: <=5 significant digits and <=(6-szDecimals) decimal places.
  const sig = Number(px.toPrecision(5));
  const decimals = Math.max(0, 6 - szDecimals);
  const factor = 10 ** decimals;
  return String(Math.round(sig * factor) / factor);
}
function u64be(v: bigint) {
  const bytes = new Uint8Array(8);
  for (let i=7;i>=0;i--) { bytes[i] = Number(v & 255n); v >>= 8n; }
  return bytes;
}
function nonceFor(wallet: string) {
  const now = Date.now(); const next = Math.max(now, (NONCE_LOCK.get(wallet) || 0) + 1);
  NONCE_LOCK.set(wallet, next); return next;
}
export async function sendAction(action: Record<string,unknown>, key: `0x${string}`, master: string) {
  const account = privateKeyToAccount(key);
  const nonce = nonceFor(master);
  const hash = keccak256(concat([bytesToHex(encode(action)), bytesToHex(u64be(BigInt(nonce))), '0x00']));
  const domain = { chainId:1337, name:'Exchange', verifyingContract:'0x0000000000000000000000000000000000000000', version:'1' } as const;
  const types = { Agent:[{name:'source',type:'string'},{name:'connectionId',type:'bytes32'}] } as const;
  const message = {source:'a',connectionId:hash} as const;
  const signature = await account.signTypedData({domain,types,primaryType:'Agent',message});
  const recovered = await recoverTypedDataAddress({domain,types,primaryType:'Agent',message,signature});
  if (recovered.toLowerCase() !== account.address.toLowerCase()) throw Error('SIGNATURE_RECOVERY_FAILED');
  const hex = signature.slice(2);
  const rawV = parseInt(hex.slice(128,130),16);
  const sig = {r:`0x${hex.slice(0,64)}`,s:`0x${hex.slice(64,128)}`,v:rawV<27?rawV+27:rawV};
  // Never automatically retry: timeout can mean the order was accepted.
  return post(EXCHANGE, {action,nonce,signature:sig,vaultAddress:null});
}
export async function readLiveAccount(env: LiveCopyEnv) {
  const master = env.HYPERLIQUID_MASTER_ACCOUNT?.trim() || '';
  if (!validAddress(master)) throw Error('MASTER_ACCOUNT_NOT_CONFIGURED');
  const [state,meta,spotResult] = await Promise.all([
    info({type:'clearinghouseState',user:master}), info({type:'meta'}),
    // Unified-account collateral is reported in spotClearinghouseState.
    // A failed spot read must not silently masquerade as a zero balance.
    info({type:'spotClearinghouseState',user:master}).then(value=>({ok:true,value} as const),error=>({ok:false,error:String(error)} as const))
  ]);
  const positions = (state.assetPositions || []).map((entry:any) => {
    const p = entry.position || {};
    return {coin:p.coin, qty:n(p.szi), entry:n(p.entryPx), unrealized:n(p.unrealizedPnl),
      marginUsed:n(p.marginUsed), leverage:p.leverage, liquidationPx:p.liquidationPx};
  }).filter((p:any)=>Number.isFinite(p.qty) && p.qty!==0);
  const spotBalances = spotResult.ok && Array.isArray(spotResult.value?.balances)
    ? spotResult.value.balances : [];
  const usdc = spotBalances.find((b:any)=>String(b.coin).toUpperCase()==='USDC');
  const usdcTotal = usdc ? Number(usdc.total) : null;
  const usdcHold = usdc ? Number(usdc.hold || 0) : null;
  // Do not sum perp accountValue and spot USDC: this double-counts unified collateral.
  // Expose sources separately rather than presenting an unverified equity formula.
  const spotUsdcTotal = usdcTotal!==null && Number.isFinite(usdcTotal) ? usdcTotal : null;
  const spotUsdcHold = usdcHold!==null && Number.isFinite(usdcHold) ? usdcHold : null;
  return {ok:true, mode:'READ_ONLY', masterAccount:master,
    balanceMode:'UNIFIED_SOURCES_SEPARATE',
    spotUsdcTotal, spotUsdcHold,
    spotUsdcAvailable:spotUsdcTotal!==null && spotUsdcHold!==null ? spotUsdcTotal-spotUsdcHold : null,
    spotBalanceError:spotResult.ok ? null : (spotResult as any).error,
    spotBalances:spotBalances.map((b:any)=>({coin:b.coin,total:b.total,hold:b.hold})),
    accountValue:n(state.marginSummary?.accountValue), withdrawable:n(state.withdrawable),
    totalMarginUsed:n(state.marginSummary?.totalMarginUsed), positions,
    assetMeta:(meta.universe||[]).map((a:any,i:number)=>({coin:a.name,assetId:i,szDecimals:a.szDecimals,maxLeverage:a.maxLeverage}))};
}
export async function executeLiveIoc(env: LiveCopyEnv, intent: LiveOrderIntent): Promise<LiveResult> {
  const base = {ok:false,executed:false,status:'BLOCKED',coin:intent.coin,intentId:intent.intentId,orderSent:false as boolean|'UNKNOWN'};
  if (env.LIVE_COPY_TRADING_ENABLED !== 'true') return {...base,status:'LIVE_DISABLED'};
  const key = normalizeKey(env.HYPERLIQUID_API_PRIVATE_KEY);
  const master = env.HYPERLIQUID_MASTER_ACCOUNT?.trim() || '';
  if (!keyFormat(key) || !validAddress(master)) return {...base,status:'CREDENTIALS_NOT_CONFIGURED'};
  if (!intent.intentId || !/^[A-Z0-9]{2,20}$/.test(intent.coin) ||
      !['LONG','SHORT'].includes(intent.direction) || !Number.isFinite(intent.quantity) ||
      intent.quantity<=0 || !Number.isFinite(intent.referencePrice) || intent.referencePrice<=0)
    return {...base,status:'INVALID_INTENT'};
  let snapshot:Awaited<ReturnType<typeof readLiveAccount>>;
  try{snapshot=await readLiveAccount(env);}
  catch(error){return {...base,status:'PRE_ORDER_ACCOUNT_READ_FAILED_NO_ORDER',raw:String(error)};}
  const asset = snapshot.assetMeta.find((a:any)=>a.coin===intent.coin);
  if (!asset) return {...base,status:'UNKNOWN_ASSET'};
  const qty = decimalQty(intent.quantity, asset.szDecimals);
  if (!(qty>0)) return {...base,status:'BELOW_SIZE_PRECISION'};
  const pos = snapshot.positions.find((p:any)=>p.coin===intent.coin);
  const current = pos?.qty || 0;
  const buy = intent.reduceOnly ? current < 0 : intent.direction === 'LONG';
  if (intent.reduceOnly) {
    if (current===0) return {...base,status:'NO_POSITION_TO_REDUCE'};
    if (qty > Math.abs(current)+1e-10) return {...base,status:'REDUCE_EXCEEDS_POSITION'};
  } else if (current!==0 && Math.sign(current)!==(buy?1:-1)) {
    return {...base,status:'OPPOSITE_POSITION_EXISTS'};
  }
  // Verify or configure leverage using the exchange itself. An environment flag alone
  // is NOT evidence of the leverage actually configured on Hyperliquid.
  // Do not change leverage for reduce-only orders (closing should remain possible).
  if (!intent.reduceOnly) {
    if (env.LIVE_COPY_LEVERAGE_VERIFIED !== 'true') return {...base,status:'LEVERAGE_APPROVAL_MISSING'};
    if (env.LIVE_COPY_LEVERAGE_MODE !== 'cross') return {...base,status:'LEVERAGE_MODE_NOT_APPROVED'};
    if (asset.maxLeverage < 10) return {...base,status:'ASSET_MAX_LEVERAGE_BELOW_10X'};
    if (pos && (Number(pos.leverage?.value) !== 10 || pos.leverage?.type !== 'cross'))
      return {...base,status:'EXISTING_POSITION_LEVERAGE_MISMATCH'};
    // Existing live position already provides exchange proof of 10x cross.
    // Never send a repeated updateLeverage before every ADD.
    if(!pos){
      let leverageResponse:any;
      try {
        leverageResponse = await sendAction({type:'updateLeverage',asset:asset.assetId,isCross:true,leverage:10},key as `0x${string}`,master);
      } catch (error) {
        return {...base,status:'LEVERAGE_UPDATE_UNCONFIRMED_NO_ORDER',raw:String(error)};
      }
      if (leverageResponse?.status !== 'ok' || leverageResponse?.response?.type !== 'default')
        return {...base,status:'LEVERAGE_UPDATE_REJECTED_NO_ORDER',raw:leverageResponse};
    }
  }
  const px = n(intent.referencePrice);
  if (!intent.reduceOnly && qty*px < DEFAULT_MIN_NOTIONAL) return {...base,status:'BELOW_STRATEGY_MIN_NOTIONAL'};
  // IOC price bound relative to the supplied *fresh* reference price.
  // Caller must verify reference freshness and use an account-level serialized executor.
  const limitPx = n(formatPrice(px*(buy?(1+MAX_PRICE_DEVIATION):(1-MAX_PRICE_DEVIATION)),asset.szDecimals));
  const cloid=cloidForIntent(intent.intentId);
  const action = {type:'order',orders:[{a:asset.assetId,b:buy,p:String(limitPx),s:qty.toFixed(asset.szDecimals),r:intent.reduceOnly,t:{limit:{tif:'Ioc'}},c:cloid}],grouping:'na'};
  let result:any;
  try { result = await sendAction(action,key as `0x${string}`,master); }
  catch (e) { return {...base,status:'UNKNOWN_WRITE_OUTCOME_CHECK_EXCHANGE_BEFORE_RETRY',cloid,orderSent:'UNKNOWN',raw:String(e)}; }
  const item = result?.response?.data?.statuses?.[0];
  if (item?.filled) return {ok:true,executed:true,status:'FILLED',coin:intent.coin,intentId:intent.intentId,
    requestedQty:qty,filledQty:n(item.filled.totalSz),averageFillPrice:n(item.filled.avgPx),oid:item.filled.oid,cloid,orderSent:true,raw:result};
  if (item?.resting) return {...base,status:'UNEXPECTED_RESTING_ORDER',orderSent:true,raw:result};
  return {...base,status:item?.error?'REJECTED':'NOT_FILLED',orderSent:true,raw:result};
}

}

type DB = {prepare(sql:string):{bind(...args:any[]):{first<T=any>():Promise<T|null>;all<T=any>():Promise<{results:T[]}>}}};
type Env=__LC_EXECUTION.LiveCopyEnv & {
  DB:DB;LIVE_COPY_ADMIN_TOKEN?:string;LIVE_COPY_AUTO_EXECUTION_ENABLED?:string;
  LIVE_COPY_SOURCE_WALLET?:string;LIVE_COPY_V19_MIN_NOTIONAL?:string;
};
type Fill={rowid:number;session_id:string;fill_id:string;at:number;coin:string;side:'A'|'B';sz:number;px:number;start_pos:number;source_oid:string};
type CoinState={coin:string;sourceQty:number;baseline:number;scale:number;episode:number;active:boolean;waitingFlat:boolean;
  desired:number;lastPx:number;lastFillAt:number;lastActionAt:number;lastFillId:string;lastError:string;
  pending?:{id:string;cloid:string;status:'SUBMITTING'|'UNKNOWN';at:number;qty:number;direction:string};
  lastConfirmedOwnQty:number;actionCount:number;};
type Session={version:19;mode:'RUNNING'|'STOPPED';live:boolean;startedAt:number;cursor:number;
  coins:Record<string,CoinState>;events:number;syncs:number;skipped:number;orders:number;lastSync:number;
  errors:string[];recent:Array<{at:number;coin:string;kind:string;detail:string}>;sourceSession:string;
  stoppedReason:string;lastDecisions?:any[];cooldownUntil?:number;};
const KEY='live_copy_v19_net_position';
const MIN=10.40; // User's $10 accumulator with $0.40 buffer against min notional/precision.
const BATCH=500;const MAX_ACTIONS=2;const COALESCE_MS=1800;const MAX_ENTRY_AGE_MS=12000;
const J=(v:any,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const postInfo=async(body:any)=>{const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('INFO_HTTP_'+r.status);return await r.json() as any;};
const finite=(n:any)=>Number.isFinite(Number(n));
const round=(n:number)=>Math.round(n*1e10)/1e10;
function trimQty(n:number,d:number){return Math.floor(Math.max(0,n)*10**d+1e-9)/10**d;}
export class LiveCopyControllerStage7 {
  private busy=false;
  private arm:number|null=null;
  constructor(private state:any,private env:Env){}
  private async load():Promise<Session>{return await this.state.storage.get(KEY)||{version:19,mode:'STOPPED',live:false,startedAt:0,cursor:0,coins:{},events:0,syncs:0,skipped:0,orders:0,lastSync:0,errors:[],recent:[],sourceSession:'',stoppedReason:''};}
  private async save(s:Session){await this.state.storage.put(KEY,s);}
  private liveConfigured(){return this.env.LIVE_COPY_TRADING_ENABLED==='true'&&this.env.LIVE_COPY_AUTO_EXECUTION_ENABLED==='true'&&this.env.LIVE_COPY_LEVERAGE_VERIFIED==='true'&&this.env.LIVE_COPY_LEVERAGE_MODE==='cross';}
  private authorized(s:Session){return s.mode==='RUNNING'&&s.live&&this.liveConfigured()&&this.arm===s.startedAt;}
  private async restore(s:Session){if(!s.live||!this.liveConfigured())return false;const saved=await this.state.storage.get('live_copy_v19_arm');if(saved?.startedAt!==s.startedAt)return false;this.arm=s.startedAt;return true;}
  private log(s:Session,coin:string,kind:string,detail:string){s.recent.unshift({at:Date.now(),coin,kind,detail});s.recent=s.recent.slice(0,120);}
  private async meta(){const key='v19_meta';const x=await this.state.storage.get(key);if(x&&Date.now()-x.at<30*60*1000)return x.data;const data=await postInfo({type:'meta'});if(!Array.isArray(data?.universe))throw Error('INVALID_META');await this.state.storage.put(key,{at:Date.now(),data});return data;}
  private async positions(wallet:string){const d=await postInfo({type:'clearinghouseState',user:wallet});if(!Array.isArray(d?.assetPositions))throw Error('INVALID_POSITIONS');const out:Record<string,number>={};for(const p of d.assetPositions){const coin=String(p?.position?.coin||'');const q=Number(p?.position?.szi);if(coin&&Number.isFinite(q))out[coin]=q;}return out;}
  private async ownPositions(){const w=this.env.HYPERLIQUID_MASTER_ACCOUNT?.trim()||'';if(!/^0x[0-9a-f]{40}$/i.test(w))throw Error('MASTER_ADDRESS_MISSING');return this.positions(w);}
  private async sourcePositions(){const w=this.env.LIVE_COPY_SOURCE_WALLET?.trim()||'0x34fb5ec7d4e939161946340ea2a1f29254b893de';if(!/^0x[0-9a-f]{40}$/i.test(w))throw Error('SOURCE_ADDRESS_INVALID');return this.positions(w);}
  private async latest(){return await this.env.DB.prepare('SELECT rowid,session_id FROM mc_v19_fills ORDER BY rowid DESC LIMIT 1').bind().first<{rowid:number;session_id:string}>();}
  private error(s:Session,e:any){s.errors.unshift(String(e));s.errors=s.errors.slice(0,20);}
  private async start(body:any){
    const old=await this.load();if(this.liveConfigured()&&body.confirm!=='START_REAL_HYPERLIQUID_COPY')return J({ok:false,error:'EXPLICIT_LIVE_CONFIRMATION_REQUIRED'},409);
    if(this.liveConfigured()){
      const own=await this.ownPositions();const w=this.env.HYPERLIQUID_MASTER_ACCOUNT||'';
      const open=await postInfo({type:'openOrders',user:w});
      if(Object.values(own).some(x=>Math.abs(x)>1e-9)||!Array.isArray(open)||open.length)
        return J({ok:false,error:'ACCOUNT_NOT_FLAT_USE_CLOSE_ALL_FIRST',positions:own,open_orders:Array.isArray(open)?open.length:null},409);
    }
    const latest=await this.latest();const baseline=await this.sourcePositions();const at=Date.now();
    // Every START is fresh; existing V18 storage is intentionally not read or reused.
    const coins:Record<string,CoinState>={};for(const [coin,qty] of Object.entries(baseline))if(Math.abs(qty)>1e-9)
      coins[coin]={coin,sourceQty:qty,baseline:qty,scale:0,episode:0,active:false,waitingFlat:true,desired:0,lastPx:0,lastFillAt:0,lastActionAt:0,lastFillId:'',lastError:'',lastConfirmedOwnQty:0,actionCount:0};
    const s:Session={version:19,mode:'RUNNING',live:this.liveConfigured(),startedAt:at,cursor:latest?.rowid||0,
      sourceSession:latest?.session_id||'',coins,events:0,syncs:0,skipped:0,orders:0,lastSync:0,errors:[],recent:[],stoppedReason:''};
    await this.state.storage.put('live_copy_v19_arm',s.live?{startedAt:at}:null);await this.state.storage.put('live_copy_v19_last_reconcile',0);this.arm=s.live?at:null;
    await this.save(s);await this.state.storage.setAlarm(Date.now()+1000);
    return J({ok:true,version:'V19_NET_POSITION',mode:s.mode,live:s.live,cursor:s.cursor,existing_source_positions_ignored:Object.keys(coins).length});
  }
  private async processFills(s:Session){
    const rows=await this.env.DB.prepare(`SELECT rowid,session_id,fill_id,at,coin,side,sz,px,start_pos,source_oid
      FROM mc_v19_fills WHERE rowid>? ORDER BY rowid ASC LIMIT ${BATCH}`).bind(s.cursor).all<Fill>();
    for(const f of rows.results||[]){
      // Row-id is a durable processing cursor; never replay an already accepted fill.
      s.cursor=f.rowid;
      if(s.sourceSession&&s.sourceSession!==f.session_id){s.skipped++;continue;}
      if(!s.sourceSession)s.sourceSession=f.session_id;
      if(f.at<s.startedAt||f.at>Date.now()+30000||!finite(f.sz)||f.sz<=0||!finite(f.px)||f.px<=0||!finite(f.start_pos)||!['A','B'].includes(f.side)){s.skipped++;continue;}
      const delta=(f.side==='B'?1:-1)*Number(f.sz);const before=Number(f.start_pos);const after=round(before+delta);
      let p=s.coins[f.coin];if(p&&p.lastFillAt>0&&f.at<p.lastFillAt){s.skipped++;continue;}if(!p){p={coin:f.coin,sourceQty:before,baseline:before,scale:0,episode:0,active:false,waitingFlat:Math.abs(before)>1e-8,
        desired:0,lastPx:0,lastFillAt:0,lastActionAt:0,lastFillId:'',lastError:'',lastConfirmedOwnQty:0,actionCount:0};s.coins[f.coin]=p;}
      // A source fill contains the authoritative before-position. Unexpected gaps are marked but the latest
      // source position replaces the internal estimate; no invented intermediate trades are replayed.
      if(Math.abs(p.sourceQty-before)>Math.max(1e-7,Math.abs(before)*1e-5))p.lastError='SOURCE_POSITION_DISCONTINUITY';
      p.sourceQty=after;p.lastPx=f.px;p.lastFillAt=f.at;p.lastFillId=f.fill_id;s.events++;
      if(p.waitingFlat){p.desired=0;if(Math.abs(after)<1e-8){p.waitingFlat=false;p.baseline=0;p.lastError='';this.log(s,f.coin,'SOURCE_FLAT','Inherited position reached zero');}continue;}
      if(!p.active){
        // Fresh, independent flat->position episode. Scale such that initial mirrored position ≈ $10.
        if(Math.abs(before)<1e-8&&Math.abs(after)>1e-8){p.scale=MIN/(Math.abs(after)*f.px);p.episode++;p.active=true;p.baseline=0;this.log(s,f.coin,'NEW_EPISODE','scale='+p.scale.toPrecision(7));}
        else {p.waitingFlat=true;p.desired=0;continue;}
      }
      p.desired=round(after*p.scale);
      if(Math.abs(after)<1e-8){p.desired=0;p.active=false;p.scale=0;this.log(s,f.coin,'SOURCE_FLAT','Target position zero');}
    }
    return rows.results?.length||0;
  }
  private async checkAmbiguous(s:Session,p:CoinState):Promise<number|null>{
    if(!p.pending)return null;
    // Never issue a second order while the first write could already have landed.
    // A delayed exchange response must be resolved using its unique cloid and fills, not wallet delta alone.
    try{const master=this.env.HYPERLIQUID_MASTER_ACCOUNT||'';const x=await postInfo({type:'orderStatus',user:master,oid:p.pending.cloid});
      if(x?.status!=='order'||!x?.order?.order)return null;
      const status=String(x.order.status||'').toLowerCase();
      if(status==='open')return null;
      const knownTerminal=/filled|canceled|cancelled|rejected/i.test(status);
      if(!knownTerminal)return null;
      // Fresh wallet position AFTER terminal proof; never plan from a pre-proof wallet snapshot.
      const confirmed=Number((await this.ownPositions())[p.coin]||0);
      p.pending=undefined;p.lastConfirmedOwnQty=confirmed;return confirmed;
    }catch(e){p.lastError='PENDING_PROOF_ERROR:'+String(e);return null;}
  }
  private async reconcile(s:Session):Promise<any>{
    const now=Date.now();const live=this.authorized(s);
    const actual=live?await this.ownPositions():{} as Record<string,number>;
    const meta=await this.meta();const mids=await postInfo({type:'allMids'});
    const sorted=Object.values(s.coins).filter(p=>p.lastFillAt>0).sort((a,b)=>{
      const aa=actual[a.coin]||0,bb=actual[b.coin]||0;
      const aExit=aa!==0&&(a.desired===0||Math.sign(aa)!==Math.sign(a.desired)||Math.abs(a.desired)<Math.abs(aa)-1e-9);
      const bExit=bb!==0&&(b.desired===0||Math.sign(bb)!==Math.sign(b.desired)||Math.abs(b.desired)<Math.abs(bb)-1e-9);
      return Number(bExit)-Number(aExit)||a.lastActionAt-b.lastActionAt;
    });
    let sent=0;const decisions:any[]=[];
    for(const p of sorted){
      const asset=meta.universe.find((a:any)=>a.name===p.coin);
      const price=Number(mids[p.coin]||p.lastPx);if(!asset||!finite(price)||price<=0){p.lastError='MISSING_ASSET_OR_PRICE';continue;}
      const decimals=asset.szDecimals;let own=Number(actual[p.coin]||0);
      if(live&&p.pending){const confirmed=await this.checkAmbiguous(s,p);
        if(confirmed===null){decisions.push({coin:p.coin,action:'WAIT_PROOF',reason:p.pending?.status});continue;}
        own=confirmed;actual[p.coin]=own;}
      const gap=round(p.desired-own);
      const opposite=own!==0&&(p.desired===0||Math.sign(p.desired)!==Math.sign(own));
      const reduce=own!==0&&(opposite||Math.sign(gap)!==Math.sign(own));
      // IMPORTANT: reduce size is bounded by confirmed actual own position; exits don't wait for $10.
      const raw=opposite?Math.abs(own):reduce?Math.min(Math.abs(gap),Math.abs(own)):Math.abs(gap);
      let qty=trimQty(raw,decimals);
      // Exchange size step may round a $10.40 target just below $10.
      // Round UP one precision step only when the unrounded desired notional already reached MIN.
      if(!reduce&&qty*price<MIN&&raw*price>=MIN-1e-6){
        const unit=10**(-decimals);const rounded=Math.ceil(MIN/price/unit-1e-9)*unit;
        if(p.coin!=='ZEC'||rounded*price<=20.000001)qty=round(rounded);
      }
      const notional=qty*price;
      if(qty<=0){decisions.push({coin:p.coin,action:'NONE',reason:'SYNCED_OR_BELOW_PRECISION',pending_usd:Math.abs(gap)*price});continue;}
      if(!reduce&&notional<MIN){decisions.push({coin:p.coin,action:'ACCUMULATE',pending_usd:Math.abs(gap)*price});continue;}
      if(!reduce&&now-p.lastFillAt>MAX_ENTRY_AGE_MS){decisions.push({coin:p.coin,action:'SKIP_STALE_ENTRY',pending_usd:notional});continue;}
      if(now-p.lastActionAt<COALESCE_MS){decisions.push({coin:p.coin,action:'COALESCE',pending_usd:notional});continue;}
      if(sent>=MAX_ACTIONS){decisions.push({coin:p.coin,action:'NEXT_TICK',pending_usd:notional});continue;}
      const direction=(opposite?own<0:gap>0)?'LONG':'SHORT';
      decisions.push({coin:p.coin,action:reduce?'CLOSE_OR_REDUCE':'OPEN_OR_ADD',qty,usd:notional,direction,desired:p.desired,actual:own});
      if(!live)continue;
      const intentId=`V19:${s.startedAt}:${p.coin}:${++p.actionCount}`;
      const cloid=__LC_EXECUTION.cloidForIntent(intentId);
      // Persist BEFORE the exchange call. An uncertain result must never be resent blindly.
      p.pending={id:intentId,cloid,status:'SUBMITTING',at:now,qty,direction};await this.save(s);
      const result=await __LC_EXECUTION.executeLiveIoc(this.env,{intentId,coin:p.coin,direction:direction as 'LONG'|'SHORT',quantity:qty,
        reduceOnly:reduce,referencePrice:price});
      p.lastActionAt=now;
      if(result.executed&&result.filledQty&&result.filledQty>0){p.pending=undefined;p.lastError='';p.lastConfirmedOwnQty=own+(direction==='LONG'?1:-1)*Number(result.filledQty);s.orders++;this.log(s,p.coin,reduce?'REDUCE_FILLED':'OPEN_FILLED','qty='+result.filledQty);}
      else if(result.orderSent==='UNKNOWN'||result.orderSent===true&&result.status==='UNEXPECTED_RESTING_ORDER'){
        p.pending!.status='UNKNOWN';p.lastError=result.status;this.log(s,p.coin,'WRITE_UNCERTAIN',result.status);
      }else{p.pending=undefined;p.lastError=result.status;this.log(s,p.coin,'NO_FILL',result.status);}
      await this.save(s);sent++;
    }
    return {sent,decisions:decisions.slice(0,100)};
  }
  private async sync():Promise<Response>{
    if(this.busy)return J({ok:true,busy:true});this.busy=true;
    try{
      const s=await this.load();if(s.mode!=='RUNNING')return J({ok:false,error:'STOPPED'},409);
      if((s.cooldownUntil||0)>Date.now())return J({ok:false,error:'API_RATE_LIMIT_BACKOFF',retry_after:s.cooldownUntil},503);
      if(s.live&&!this.authorized(s)&&!(await this.restore(s)))return J({ok:false,error:'LIVE_ARM_NOT_RESTORED'},409);
      const processed=await this.processFills(s);s.syncs++;s.lastSync=Date.now();await this.save(s);
      const elapsed=Date.now()-Number(await this.state.storage.get('live_copy_v19_last_reconcile')||0);
      const shouldReconcile=elapsed>=20000||(elapsed>=COALESCE_MS&&processed>0);
      const result=shouldReconcile?await this.reconcile(s):{sent:0,decisions:[]};
      if(shouldReconcile){s.lastDecisions=result.decisions;await this.state.storage.put('live_copy_v19_last_reconcile',Date.now());}await this.save(s);
      return J({ok:true,version:'V19_NET_POSITION',processed,cursor:s.cursor,events:s.events,live:this.authorized(s),...result});
    }catch(e){const s=await this.load();this.error(s,e);if(/429|RATE_LIMIT|TOO_MANY_REQUESTS/i.test(String(e)))s.cooldownUntil=Date.now()+60000;await this.save(s);return J({ok:false,error:'V19_SYNC_FAILED',detail:String(e)},503);}
    finally{this.busy=false;}
  }
  private async closeAll():Promise<Response>{
    const s=await this.load();s.mode='STOPPED';s.stoppedReason='CLOSE_ALL';await this.save(s);
    await this.state.storage.deleteAlarm?.();this.arm=null;await this.state.storage.put('live_copy_v19_arm',null);
    // Account-wide: cancels all perps orders, then reduce-only closes all positions.
    const master=this.env.HYPERLIQUID_MASTER_ACCOUNT?.trim()||'';
    if(this.env.LIVE_COPY_TRADING_ENABLED!=='true')return J({ok:false,error:'CLOSE_ALL_REQUIRES_REAL_TRADING_PERMISSION',stopped:true},409);
    if(!/^0x[0-9a-f]{40}$/i.test(master))return J({ok:false,error:'MASTER_ACCOUNT_INVALID',stopped:true},409);
    const actions:any[]=[];
    try{
      const open=await postInfo({type:'openOrders',user:master});if(!Array.isArray(open))throw Error('OPEN_ORDERS_INVALID');
      if(open.length){const meta=await this.meta();const cancels=open.map((o:any)=>({asset:meta.universe.findIndex((a:any)=>a.name===o.coin),oid:Number(o.oid)}));
        if(cancels.some((c:any)=>c.asset<0||!Number.isSafeInteger(c.oid)))throw Error('INVALID_CANCEL_ORDER');
        const key=__LC_EXECUTION.normalizeKey(this.env.HYPERLIQUID_API_PRIVATE_KEY);
        await __LC_EXECUTION.sendAction({type:'cancel',cancels},key as `0x${string}`,master);
        actions.push({type:'CANCEL',count:cancels.length});
        const rest=await postInfo({type:'openOrders',user:master});if(!Array.isArray(rest)||rest.length)
          return J({ok:false,error:'OPEN_ORDERS_REMAIN',remaining:rest,actions,stopped:true},409);
      }
      const positions=await this.ownPositions();const mids=await postInfo({type:'allMids'});
      for(const [coin,qty] of Object.entries(positions)){
        if(Math.abs(qty)<1e-10)continue;
        const previous=await this.state.storage.get('live_copy_v19_close_pending:'+coin);
        if(previous&&['SUBMITTING','UNKNOWN_WRITE_OUTCOME_CHECK_EXCHANGE_BEFORE_RETRY'].includes(previous.status||'SUBMITTING')){
          const proof=await postInfo({type:'orderStatus',user:master,oid:previous.cloid});
          if(proof?.status!=='order'||!proof?.order?.order||String(proof.order.status).toLowerCase()==='open')
            return J({ok:false,error:'PRIOR_CLOSE_WRITE_UNRESOLVED',coin,stopped:true,actions},409);
        }
        const px=Number(mids[coin]);if(!finite(px)||px<=0)throw Error('CLOSE_PRICE_MISSING_'+coin);
        const intentId='V19_CLOSE_ALL:'+s.startedAt+':'+coin+':'+Date.now();
        // Save an ambiguous-write marker before sending close, since a retry could double-submit.
        await this.state.storage.put('live_copy_v19_close_pending:'+coin,{id:intentId,cloid:__LC_EXECUTION.cloidForIntent(intentId),at:Date.now(),qty,status:'SUBMITTING'});
        const r=await __LC_EXECUTION.executeLiveIoc(this.env,{intentId,coin,direction:qty>0?'SHORT':'LONG',quantity:Math.abs(qty),reduceOnly:true,referencePrice:px});
        await this.state.storage.put('live_copy_v19_close_pending:'+coin,{id:intentId,at:Date.now(),qty,status:r.status,cloid:r.cloid});
        actions.push({type:'CLOSE',coin,qty,result:r.status});
        if(r.orderSent==='UNKNOWN')return J({ok:false,error:'CLOSE_OUTCOME_UNKNOWN_CHECK_EXCHANGE',coin,actions,stopped:true},409);
      }
      const remaining=await this.ownPositions();const rest=await postInfo({type:'openOrders',user:master});
      const flat=!Object.values(remaining).some(q=>Math.abs(q)>1e-9)&&Array.isArray(rest)&&!rest.length;
      if(!flat)return J({ok:false,error:'CLOSE_ALL_INCOMPLETE',positions:remaining,open_orders:rest,actions,stopped:true},409);
      await this.state.storage.put(KEY,{...s,coins:{},stoppedReason:'CLOSED_FLAT_CONFIRMED'});
      return J({ok:true,stopped:true,account_flat:true,actions});
    }catch(e){return J({ok:false,error:'CLOSE_ALL_FAILED',detail:String(e),actions,stopped:true},503);}
  }
  async alarm():Promise<void>{const s=await this.load();if(s.mode!=='RUNNING')return;
    await this.sync();const current=await this.load();if(current.mode==='RUNNING')await this.state.storage.setAlarm(Math.max(Date.now()+5000,(current.cooldownUntil||0)+1000));}
  async fetch(req:Request):Promise<Response>{
    if(!this.env.LIVE_COPY_ADMIN_TOKEN||req.headers.get('authorization')!=='Bearer '+this.env.LIVE_COPY_ADMIN_TOKEN)return J({ok:false,error:'UNAUTHORIZED'},401);
    const path=new URL(req.url).pathname;const method=req.method;
    if(method==='POST'&&path==='/start')return this.start(await req.json().catch(()=>({})));
    if(method==='POST'&&path==='/stop'){const s=await this.load();s.mode='STOPPED';s.stoppedReason='STOP';await this.save(s);await this.state.storage.deleteAlarm?.();this.arm=null;await this.state.storage.put('live_copy_v19_arm',null);return J({ok:true,mode:'STOPPED',positions_untouched:true});}
    if(method==='POST'&&path==='/close-all')return this.closeAll();
    if(method==='POST'&&['/sync','/order-sync'].includes(path))return this.sync();
    if(method==='GET'&&['/status','/v19-status','/order-follow-status'].includes(path)){
      const s=await this.load();const latest=await this.latest().catch(()=>null);const coins=Object.values(s.coins).map(p=>({coin:p.coin,source_qty:p.sourceQty,desired_qty:p.desired,scale:p.scale,active:p.active,waiting_flat:p.waitingFlat,
        last_price:p.lastPx,last_fill_at:p.lastFillAt,updated_at:p.lastActionAt,error:p.lastError,pending:p.pending?.status||null,episode:p.episode}));
      return J({ok:true,version:'V19_NET_POSITION',mode:s.mode,session_kind:s.live?'LIVE':'DRY_RUN',live_execution:s.mode==='RUNNING'&&s.live&&this.liveConfigured(),
        cursor:s.cursor,latest_fill_row:latest?.rowid||0,lag_rows:Math.max(0,(latest?.rowid||0)-s.cursor),processed_fills:s.events,orders_sent_and_filled:s.orders,
        skipped:s.skipped,syncs:s.syncs,last_sync:s.lastSync,minimum_notional_usd:MIN,source_session:s.sourceSession,started_at:s.startedAt,
        coins,decisions:s.lastDecisions||[],errors:s.errors,recent:s.recent,stopped_reason:s.stoppedReason,mode_description:'NET_POSITION_USERFILLS_ONLY'});
    }
    if(method==='GET'&&path==='/account'){try{return J(await __LC_EXECUTION.readLiveAccount(this.env));}catch(e){return J({ok:false,error:String(e)},503);}}
    if(method==='GET'&&path==='/our-activity'){const s=await this.load();return J({ok:true,events:s.recent});}
    return J({ok:false,error:'UNSUPPORTED_V19_ROUTE',path},404);
  }
}
