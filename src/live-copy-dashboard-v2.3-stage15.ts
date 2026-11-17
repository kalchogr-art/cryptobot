/** V19.7 EXPOSURE CAP + PARTIAL INITIAL ENTRY TRACKING — standalone replacement for src/live-copy-controller-v2.3-stage15.ts.
 * Source: mc_v19_fills (userFills only). Fresh NEW/REVERSAL=$10.40 notional ($1.04 margin at 10x). ADD/REMOVE are percentage scaled. OPEN/CANCEL are NEVER copied.
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
const MAX_COIN_NOTIONAL_USD = 31.20; // per-coin risk cap, all NEW/REVERSAL/ADD orders
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
  averageFillPrice?: number; oid?: number | string; raw?: unknown; cloid?:string; orderSent?:boolean|'UNKNOWN'; rejectReason?:string;
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
  // Final exchange-side gate: planner's position snapshot can be stale by the
  // time of submission. Never let an opening/ADD order bypass the coin cap.
  // Use the higher of reference and limit prices for a conservative valuation.
  // Reduce-only CLOSE/REMOVE are intentionally exempt.
  if (!intent.reduceOnly) {
    const riskPx=Math.max(px,limitPx);
    const alreadySameSide=Math.max(0, current*(buy?1:-1));
    const projected=(alreadySameSide+qty)*riskPx;
    if (!Number.isFinite(projected)||projected>MAX_COIN_NOTIONAL_USD+1e-8)
      return {...base,status:'POSITION_CAP_NO_ORDER',raw:{capUsd:MAX_COIN_NOTIONAL_USD,
        ownQty:current,requestedQty:qty,riskPx,projectedUsd:projected}};
  }
  const cloid=cloidForIntent(intent.intentId);
  const action = {type:'order',orders:[{a:asset.assetId,b:buy,p:String(limitPx),s:qty.toFixed(asset.szDecimals),r:intent.reduceOnly,t:{limit:{tif:'Ioc'}},c:cloid}],grouping:'na'};
  let result:any;
  try { result = await sendAction(action,key as `0x${string}`,master); }
  catch (e) { return {...base,status:'UNKNOWN_WRITE_OUTCOME_CHECK_EXCHANGE_BEFORE_RETRY',cloid,orderSent:'UNKNOWN',raw:String(e)}; }
  const item = result?.response?.data?.statuses?.[0];
  if (item?.filled) return {ok:true,executed:true,status:'FILLED',coin:intent.coin,intentId:intent.intentId,
    requestedQty:qty,filledQty:n(item.filled.totalSz),averageFillPrice:n(item.filled.avgPx),oid:item.filled.oid,cloid,orderSent:true,raw:result};
  if (item?.resting) return {...base,status:'UNEXPECTED_RESTING_ORDER',orderSent:true,raw:result};
  // Preserve the exchange's per-order rejection message; HTTP 200 does not mean
  // the nested exchange status is a successful fill.
  const rejection = item?.error;
  const rejectReason = typeof rejection === 'string' ? rejection.slice(0,280)
    : rejection != null ? JSON.stringify(rejection).slice(0,280) : undefined;
  return {...base,status:rejection!=null?'REJECTED':'NOT_FILLED',rejectReason,orderSent:true,raw:result};
}

}

type DB = {prepare(sql:string):{bind(...args:any[]):{first<T=any>():Promise<T|null>;all<T=any>():Promise<{results:T[]}>}}};
type Env=__LC_EXECUTION.LiveCopyEnv & {
  DB:DB;LIVE_COPY_ADMIN_TOKEN?:string;LIVE_COPY_AUTO_EXECUTION_ENABLED?:string;
  LIVE_COPY_SOURCE_WALLET?:string;LIVE_COPY_V19_MIN_NOTIONAL?:string;
};
type Fill={rowid:number;session_id:string;fill_id:string;at:number;coin:string;side:'A'|'B';sz:number;px:number;start_pos:number;source_oid:string};
type CoinState={coin:string;sourceQty:number;baseline:number;scale:number;episode:number;active:boolean;waitingFlat:boolean;
  entryPending?:boolean;episodeEntryPx?:number;episodeStartedAt?:number;lastFillKind?:string;
  // Initial NEW/REVERSAL is an independent episode target. An IOC may be
  // partially filled, including below the exchange's $10 minimum.
  entryTargetQty?:number;entryConfirmedQty?:number;entryStatus?:string;
  entryRemainingUsd?:number;entryLastObservedAt?:number;
  // A pre-existing source position is a reference only. We never copy its absolute size.
  // Its subsequent ADDs create a virtual USD accumulation until the first $10.40 entry.
  inheritedMode?:boolean;inheritedPendingUsd?:number;inheritedDirection?:number;
  desired:number;lastPx:number;lastFillAt:number;lastActionAt:number;lastFillId:string;lastError:string;
  pending?:{id:string;cloid:string;status:'SUBMITTING'|'UNKNOWN';at:number;qty:number;direction:string};
  lastConfirmedOwnQty:number;actionCount:number;
  lastRejectedSignature?:string;lastRejectedUntil?:number;lastRejectReason?:string;
  pendingReduceUsd?:number;reduceState?:string;dustCloseBlockedQty?:number;dustCloseReason?:string;};
type Session={version:19;mode:'RUNNING'|'STOPPED';live:boolean;startedAt:number;cursor:number;
  coins:Record<string,CoinState>;events:number;syncs:number;skipped:number;orders:number;lastSync:number;
  errors:string[];recent:Array<{at:number;coin:string;kind:string;detail:string}>;sourceSession:string;
  stoppedReason:string;lastDecisions?:any[];cooldownUntil?:number;};
const KEY='live_copy_v19_net_position';
const MIN=10.40; // User's $10 accumulator with $0.40 buffer against min notional/precision.
const MAX_POSITION_USD=31.20; // notional per coin (approx. $3.12 margin at 10x)
/** Truncate only risk-increasing quantities; never restrict reduceOnly exits. */
export function planV19CoinCap(ownQty:number, proposedQty:number, refPrice:number, limitDeviation:number, decimals:number) {
  if(!Number.isFinite(refPrice)||refPrice<=0||!Number.isFinite(ownQty)||!Number.isFinite(proposedQty)||proposedQty<=0)
    return {qty:0,reason:'INVALID_CAP_INPUT',remainingUsd:0};
  const riskPrice=refPrice*(1+Math.max(0,limitDeviation));
  const unit=10**(-decimals);
  const room=Math.max(0,MAX_POSITION_USD/riskPrice-Math.abs(ownQty));
  const cappedQty=Math.floor(Math.min(proposedQty,room)/unit+1e-9)*unit;
  const qty=Math.round(Math.max(0,cappedQty)*1e10)/1e10;
  if(qty*riskPrice<MIN-1e-8) return {qty:0,reason:'CAP_ROOM_BELOW_MIN_ORDER',remainingUsd:room*riskPrice};
  return {qty,reason:qty<proposedQty-1e-10?'CAPPED':'WITHIN_CAP',remainingUsd:room*riskPrice};
}
const BATCH=500;const MAX_ACTIONS=2;const COALESCE_MS=1800;const MAX_ENTRY_AGE_MS=12000;
// Limit automatic INFO polling; stream fills independently even when INFO is rate limited.
const INFO_RECONCILE_MIN_MS=15000;
const INFO_RECONCILE_IDLE_MS=30000;
const INFO_MIDS_TTL_MS=12000;
const INFO_BACKOFF_MS=90000;
// Suppress only identical *confirmed* exchange rejections. A changed target,
// direction, quantity or reduceOnly remains eligible immediately.
const REJECT_RETRY_ENTRY_MS=120000;
const REJECT_RETRY_REDUCE_MS=30000;
// Entry deficit is never silently converted into a sub-minimum ADD.
// Price and size precision can prevent reaching the exact $10.40 target.
export function planV19InitialEntry(ownQty:number,targetQty:number,desiredQty:number,price:number,decimals:number,ageMs:number){
  const current=Math.max(0,Math.abs(ownQty));
  const target=Math.max(0,targetQty);
  const desired=Math.max(0,Math.abs(desiredQty));
  const unit=10**(-decimals);
  const remaining=Math.max(0,Math.min(target,desired)-current);
  const remainingUsd=remaining*price;
  if(current>=target-unit*0.5)return {action:'COMPLETE',remainingUsd:0,qty:0};
  if(desired<=current+unit*0.5)return {action:'TARGET_REDUCED',remainingUsd:0,qty:0};
  const gap=Math.max(0,desired-current);
  const raw=remainingUsd>=MIN-1e-6?remaining:gap;
  let qty=trimQty(raw,decimals);
  // At NEW the exchange size step may round a $10.40 request just below
  // the minimum. One precision step up is allowed only for a fresh zero-position
  // entry and only when the original unrounded request was >= $10.40.
  if(current===0&&qty*price<MIN&&raw*price>=MIN-1e-6){
    qty=Math.round(Math.ceil(MIN/price/unit-1e-9)*unit*1e10)/1e10;
  }
  if(qty<=0)return {action:'BELOW_QTY_PRECISION',remainingUsd,qty:0};
  if(qty*price<MIN-1e-6)return {action:current>0?'PARTIAL_ENTRY_WAIT_MIN':'NEW_BELOW_EXCHANGE_MIN',remainingUsd,qty:0};
  if(ageMs>MAX_ENTRY_AGE_MS)return {action:'STALE_PARTIAL_ENTRY',remainingUsd,qty:0};
  // If the source subsequently ADDED enough, this is a combined executable
  // residual. It is never an independent order for less than exchange minimum.
  return {action:current>0?'CONTINUE_PARTIAL_ENTRY':'NEW_ENTRY',remainingUsd,qty};
}
const J=(v:any,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
const postInfo=async(body:any)=>{const r=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error('INFO_HTTP_'+r.status);return await r.json() as any;};
const finite=(n:any)=>Number.isFinite(Number(n));
const round=(n:number)=>Math.round(n*1e10)/1e10;
function trimQty(n:number,d:number){return Math.floor(Math.max(0,n)*10**d+1e-9)/10**d;}
// Pure preflight for reduce-only actions. A partial REMOVE is not submitted
// until >= $10.40, and must not create a residual position below $10.40.
// A full CLOSE can be attempted once even for sub-minimum dust; an exchange
// rejection is then explicitly surfaced instead of retried indefinitely.
export function planV19Reduce(ownQty:number, reduceQty:number, px:number, fullClose:boolean,
  alreadyRejectedDust:boolean):{action:'SEND_REMOVE'|'SEND_CLOSE'|'ACCUMULATE_REMOVE'|'AVOID_DUST'|'DUST_CLOSE_REJECTED';notional:number;remainingUsd:number}{
  const own=Math.abs(ownQty), qty=Math.min(own,Math.abs(reduceQty));
  const notional=qty*px, remainingUsd=Math.max(0,own-qty)*px;
  if(fullClose && own>0){
    if(alreadyRejectedDust && own*px<MIN)return {action:'DUST_CLOSE_REJECTED',notional,remainingUsd};
    return {action:'SEND_CLOSE',notional,remainingUsd};
  }
  if(notional<MIN)return {action:'ACCUMULATE_REMOVE',notional,remainingUsd};
  if(remainingUsd>0 && remainingUsd<MIN)return {action:'AVOID_DUST',notional,remainingUsd};
  return {action:'SEND_REMOVE',notional,remainingUsd};
}
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
  private async midsForReconcile():Promise<Record<string,string>>{
    // Never cache own wallet positions for execution decisions. Prices, unlike
    // wallet quantity, may be briefly cached and are only a reference price;
    // the IOC adapter retains its independent price/deviation verification.
    const cached=await this.state.storage.get('live_copy_v19_mids_cache') as {at:number;data:Record<string,string>}|undefined;
    if(cached&&Date.now()-cached.at<INFO_MIDS_TTL_MS)return cached.data;
    const data=await postInfo({type:'allMids'});
    if(!data||typeof data!=='object'||Array.isArray(data))throw Error('INVALID_MIDS');
    await this.state.storage.put('live_copy_v19_mids_cache',{at:Date.now(),data});
    return data;
  }
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
      coins[coin]={coin,sourceQty:qty,baseline:qty,scale:0,episode:0,active:false,waitingFlat:false,inheritedMode:true,inheritedPendingUsd:0,inheritedDirection:Math.sign(qty),desired:0,lastPx:0,lastFillAt:0,lastActionAt:0,lastFillId:'',lastError:'',lastConfirmedOwnQty:0,actionCount:0};
    const s:Session={version:19,mode:'RUNNING',live:this.liveConfigured(),startedAt:at,cursor:latest?.rowid||0,
      sourceSession:latest?.session_id||'',coins,events:0,syncs:0,skipped:0,orders:0,lastSync:0,errors:[],recent:[],stoppedReason:''};
    await this.state.storage.put('live_copy_v19_arm',s.live?{startedAt:at}:null);await this.state.storage.put('live_copy_v19_last_reconcile',0);this.arm=s.live?at:null;
    await this.save(s);await this.state.storage.setAlarm(Date.now()+1000);
    return J({ok:true,version:'V19_7_POSITION_CAP',mode:s.mode,live:s.live,cursor:s.cursor,existing_source_positions_ignored:Object.keys(coins).length});
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
      let p=s.coins[f.coin];if(p&&p.lastFillAt>0&&f.at<p.lastFillAt){s.skipped++;continue;}if(!p){p={coin:f.coin,sourceQty:before,baseline:before,scale:0,episode:0,active:false,waitingFlat:false,
        inheritedMode:Math.abs(before)>1e-8,inheritedPendingUsd:0,inheritedDirection:Math.sign(before),
        desired:0,lastPx:0,lastFillAt:0,lastActionAt:0,lastFillId:'',lastError:'',lastConfirmedOwnQty:0,actionCount:0};s.coins[f.coin]=p;}
      // In-place migration of an already RUNNING V19.1 session: anchor at its last
      // accepted source position, NOT the source position at original START.
      // Historical skipped fills are never replayed and no retroactive order is sent.
      if(p.waitingFlat===true){
        p.baseline=p.sourceQty;p.waitingFlat=false;p.inheritedMode=Math.abs(p.sourceQty)>1e-8;
        p.inheritedPendingUsd=0;p.inheritedDirection=Math.sign(p.sourceQty);
        p.desired=0;p.active=false;p.entryPending=false;
      }
      // A source fill contains the authoritative before-position. Unexpected gaps are marked but the latest
      // source position replaces the internal estimate; no invented intermediate trades are replayed.
      if(Math.abs(p.sourceQty-before)>Math.max(1e-7,Math.abs(before)*1e-5))p.lastError='SOURCE_POSITION_DISCONTINUITY';
      p.sourceQty=after;p.lastPx=f.px;p.lastFillAt=f.at;p.lastFillId=f.fill_id;s.events++;
      const beforeSign=Math.sign(before),afterSign=Math.sign(after);
      // A completely new source position or a reversal is always an immediate
      // $10.40 notional entry. Source exposure from before START is never copied.
      const opening=Math.abs(before)<1e-8&&Math.abs(after)>1e-8;
      const reversal=beforeSign!==0&&afterSign!==0&&beforeSign!==afterSign;
      if(opening||reversal){
        p.episode++;p.active=true;p.baseline=0;p.inheritedMode=false;p.inheritedPendingUsd=0;
        p.inheritedDirection=0;p.scale=MIN/(Math.abs(after)*f.px);
        p.desired=round(afterSign*MIN/f.px);
        p.entryPending=true;p.episodeEntryPx=f.px;p.episodeStartedAt=f.at;
        p.entryTargetQty=round(MIN/f.px);p.entryConfirmedQty=0;p.entryRemainingUsd=MIN;
        p.entryStatus='PENDING';p.entryLastObservedAt=0;
        p.lastFillKind=reversal?'REVERSAL':'NEW';p.lastError='';
        this.log(s,f.coin,reversal?'SOURCE_REVERSAL':'SOURCE_NEW',
          'initial_notional_usd='+MIN+' source_before='+before+' source_after='+after);
        continue;
      }
      if(Math.abs(after)<1e-8){
        p.desired=0;p.active=false;p.scale=0;p.entryPending=false;
        p.entryStatus='CLOSED';p.entryRemainingUsd=0;
        p.inheritedMode=false;p.inheritedPendingUsd=0;p.inheritedDirection=0;
        p.lastFillKind='CLOSE';
        this.log(s,f.coin,'SOURCE_FLAT','Close target 100%, do not wait for ADD minimum');
        continue;
      }
      if(!p.active){
        // We have no copied position on this coin yet. Source already held a
        // position at START. Calculate subsequent ADD/REMOVE percentages only.
        // A pending ADD is a virtual USD amount, not an actual wallet position.
        if(beforeSign===0||beforeSign!==afterSign){
          p.lastError='INHERITED_SOURCE_DIRECTION_MISMATCH';continue;
        }
        p.inheritedMode=true;p.inheritedDirection=afterSign;
        const ratio=Math.abs(after)/Math.abs(before);
        const prior=Math.max(0,Number(p.inheritedPendingUsd||0));
        // A 20% source ADD contributes 20% of our $10.40 virtual base.
        // REMOVE scales DOWN pending unexecuted ADD, never triggers a naked short.
        const updated=ratio>1+1e-9?prior+MIN*(ratio-1):prior*ratio;
        p.inheritedPendingUsd=Math.max(0,Math.round(updated*1e8)/1e8);
        p.desired=0;p.lastFillKind=ratio>1+1e-9?'INHERITED_ADD':ratio<1-1e-9?'INHERITED_REMOVE':'INHERITED_UNCHANGED';
        this.log(s,f.coin,p.lastFillKind,
          'source_ratio='+ratio.toFixed(8)+' accumulated_usd='+p.inheritedPendingUsd.toFixed(4));
        if(p.inheritedPendingUsd>=MIN-1e-7){
          // A threshold ADD opens an initial $10.40 position, with any excess
          // kept in desired to accumulate for the next genuine ADD order.
          p.episode++;p.active=true;p.entryPending=true;
          p.episodeEntryPx=f.px;p.episodeStartedAt=f.at;
          p.entryTargetQty=round(MIN/f.px);p.entryConfirmedQty=0;p.entryRemainingUsd=MIN;
          p.entryStatus='PENDING';p.entryLastObservedAt=0;
          p.desired=round(afterSign*p.inheritedPendingUsd/f.px);
          p.inheritedMode=false;p.inheritedPendingUsd=0;
          p.lastFillKind='INHERITED_ADD_ENTRY';
          this.log(s,f.coin,'INHERITED_ADD_THRESHOLD',
            'entry_notional_usd='+MIN+' pending_total_usd='+p.inheritedPendingUsd.toFixed(4));
        }
        continue;
      }
      if(beforeSign!==afterSign || beforeSign===0){
        p.lastError='SOURCE_EPISODE_UNEXPECTED';continue;
      }
      // Percentage from the source position IMMEDIATELY BEFORE this fill.
      // E.g. source +20% => our desired +20%, followed by a 30% remove => desired -30%.
      // The open add amount is naturally accumulated as (desired - actual) until >= $10.40.
      const changeRatio=Math.abs(after)/Math.abs(before);
      const previousDesired=p.desired;
      p.desired=round(p.desired*changeRatio);
      const increased=changeRatio>1+1e-9;
      p.lastFillKind=increased?'ADD':'REMOVE';
      // A removal scales unexecuted ADD down as well, so no obsolete catch-up order is sent.
      this.log(s,f.coin,p.lastFillKind,
        'source_ratio='+changeRatio.toFixed(8)+' target_before='+previousDesired+' target_after='+p.desired);

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
    // No exchange calls when only passive inherited positions are tracked and
    // there is no active own-side target or unresolved order to reconcile.
    const actionable=Object.values(s.coins).some(p=>p.lastFillAt>0&&
      (p.active===true||!!p.pending||Math.abs(p.desired)>1e-10));
    if(!actionable)return {sent:0,decisions:Object.values(s.coins).filter(p=>p.lastFillAt>0&&p.inheritedMode)
      .map(p=>({coin:p.coin,action:'ACCUMULATE_INHERITED_ADD',pending_usd:Number(p.inheritedPendingUsd||0)})).slice(0,100)};
    // Read a FRESH wallet snapshot for any real execution. Never trade from
    // a cached position while a prior fill or uncertain write may have landed.
    const actual=live?await this.ownPositions():{} as Record<string,number>;
    const meta=await this.meta();const mids=await this.midsForReconcile();
    const sorted=Object.values(s.coins).filter(p=>p.lastFillAt>0).sort((a,b)=>{
      const aa=actual[a.coin]||0,bb=actual[b.coin]||0;
      const aExit=aa!==0&&(a.desired===0||Math.sign(aa)!==Math.sign(a.desired)||Math.abs(a.desired)<Math.abs(aa)-1e-9);
      const bExit=bb!==0&&(b.desired===0||Math.sign(bb)!==Math.sign(b.desired)||Math.abs(b.desired)<Math.abs(bb)-1e-9);
      return Number(bExit)-Number(aExit)||a.lastActionAt-b.lastActionAt;
    });
    let sent=0;const decisions:any[]=[];
    for(const p of sorted){
      if(!p.active&&p.inheritedMode){
        decisions.push({coin:p.coin,action:'ACCUMULATE_INHERITED_ADD',pending_usd:Number(p.inheritedPendingUsd||0),source_last_action:p.lastFillKind||'BASELINE'});
        continue;
      }
      const asset=meta.universe.find((a:any)=>a.name===p.coin);
      const price=Number(mids[p.coin]||p.lastPx);if(!asset||!finite(price)||price<=0){p.lastError='MISSING_ASSET_OR_PRICE';continue;}
      const decimals=asset.szDecimals;let own=Number(actual[p.coin]||0);
      // A confirmed account position change allows re-evaluating a prior dust
      // failure; merely receiving another source fill does not.
      if(p.dustCloseBlockedQty!=null &&
         Math.abs(Math.abs(own)-Number(p.dustCloseBlockedQty))>=Math.pow(10,-decimals)*0.5){
        p.dustCloseBlockedQty=undefined;p.dustCloseReason=undefined;
      }
      if(live&&p.pending){const confirmed=await this.checkAmbiguous(s,p);
        if(confirmed===null){decisions.push({coin:p.coin,action:'WAIT_PROOF',reason:p.pending?.status});continue;}
        own=confirmed;actual[p.coin]=own;}
      // Do NOT clear entryPending just because there is any fill in our direction.
      // A $10.40 IOC can partially fill for $0.90; that is NOT a complete entry.
      // Only exchange-confirmed own quantity can settle the initial target.
      if(p.entryPending && p.active && Math.sign(p.desired)!==0){
        const target=Math.max(0,Number(p.entryTargetQty||MIN/Number(p.episodeEntryPx||price)));
        p.entryTargetQty=target;
        const ownAligned=Math.sign(own)===Math.sign(p.desired)?Math.abs(own):0;
        const precisionUnit=10**(-decimals);
        p.entryConfirmedQty=ownAligned;
        p.entryRemainingUsd=Math.max(0,target-ownAligned)*price;
        p.entryLastObservedAt=now;
        if(ownAligned>=target-precisionUnit*0.5){
          p.entryPending=false;p.entryStatus='COMPLETE';p.entryRemainingUsd=0;
          this.log(s,p.coin,'INITIAL_ENTRY_COMPLETE','own_qty='+ownAligned+' target_qty='+target);
        }else if(ownAligned>0){
          p.entryStatus='PARTIAL';
        }else{p.entryStatus='PENDING';}
      }
      const gap=round(p.desired-own);
      const opposite=own!==0&&(p.desired===0||Math.sign(p.desired)!==Math.sign(own));
      const reduce=own!==0&&(opposite||Math.sign(gap)!==Math.sign(own));
      if(reduce&&p.entryPending){
        // The source has reduced/closed/reversed while our initial IOC was
        // partial. Never top it up against a newer shrinking source target.
        p.entryPending=false;p.entryStatus='SUPERSEDED_BY_REMOVE';
        p.entryRemainingUsd=0;
      }
      // IMPORTANT: reduce size is bounded by confirmed actual own position; exits don't wait for $10.
      const raw=opposite?Math.abs(own):reduce?Math.min(Math.abs(gap),Math.abs(own)):Math.abs(gap);
      let qty=trimQty(raw,decimals);
      // A fresh NEW or REVERSAL sends ONLY the initial $10.40 notional,
      // even if several ADD fills arrived before the first reconciliation.
      // Their excess remains in p.desired and is accumulated for a later ADD.
      const freshEntry=!reduce&&p.entryPending===true&&p.active===true;
      let entryPlanAction:string|null=null;
      if(freshEntry){
        const initial=Math.max(0,Number(p.episodeEntryPx||price));
        const baseQty=Number(p.entryTargetQty||MIN/(initial||price));
        const plan=planV19InitialEntry(own,baseQty,p.desired,price,decimals,
          now-Number(p.lastFillAt||p.episodeStartedAt));
        entryPlanAction=plan.action;
        p.entryRemainingUsd=plan.remainingUsd;
        if(plan.action==='COMPLETE'){
          p.entryPending=false;p.entryStatus='COMPLETE';
        }else if(plan.action==='TARGET_REDUCED'){
          p.entryPending=false;p.entryStatus='TARGET_REDUCED';
        }else if(plan.action==='NEW_ENTRY'||plan.action==='CONTINUE_PARTIAL_ENTRY'){
          qty=plan.qty;
        }else{
          p.entryStatus=plan.action;
          // Remain an incomplete initial episode; never relabel the deficit ADD.
          decisions.push({coin:p.coin,action:plan.action,
            pending_usd:plan.remainingUsd,initial_target_usd:MIN,
            confirmed_usd:Math.abs(own)*price,reason:'Unfilled initial order remainder; no sub-minimum IOC'});
          continue;
        }
      }
      // Exchange precision can round a $10.40 initial entry just below minimum.
      if(!reduce&&qty*price<MIN&&(raw*price>=MIN-1e-6)&&(!freshEntry||Math.abs(own)<1e-10)){
        const unit=10**(-decimals);const rounded=Math.ceil(MIN/price/unit-1e-9)*unit;
        if(p.coin!=='ZEC'||rounded*price<=20.000001)qty=round(rounded);
      }
      let notional=qty*price;
      // The gap already accumulates all unexecuted REMOVE fills, so no separate
      // D1 queue or double-counting accumulator is required.
      p.pendingReduceUsd=reduce?Math.abs(gap)*price:0;
      if(qty<=0){p.reduceState=reduce?'BELOW_QTY_PRECISION':'NONE';decisions.push({coin:p.coin,action:'NONE',reason:'SYNCED_OR_BELOW_PRECISION',pending_usd:Math.abs(gap)*price});continue;}
      if(reduce){
        const fullClose=opposite||Math.abs(p.desired)<=1e-10||qty>=Math.abs(own)-1e-10;
        const dustBlocked=Number(p.dustCloseBlockedQty||0)>0&&
          Math.abs(Number(p.dustCloseBlockedQty)-Math.abs(own))<Math.pow(10,-decimals)*0.5;
        const plan=planV19Reduce(own,qty,price,fullClose,dustBlocked);
        p.reduceState=plan.action;
        if(plan.action==='ACCUMULATE_REMOVE'||plan.action==='AVOID_DUST'||plan.action==='DUST_CLOSE_REJECTED'){
          const reason=plan.action==='ACCUMULATE_REMOVE'?'Waiting for combined reduce >= $10.40':
            plan.action==='AVOID_DUST'?'Partial remove would strand a position below $10.40':
            p.dustCloseReason||'Full dust close previously rejected by Hyperliquid';
          // This state is visible per coin and recalculated on each source fill.
          decisions.push({coin:p.coin,action:plan.action,pending_usd:p.pendingReduceUsd,
            remaining_usd:plan.remainingUsd,reason,desired:p.desired,actual:own});
          continue;
        }
      }else{
        p.pendingReduceUsd=0;p.reduceState='NONE';
        // Never exceed $31.20 in total exposure for this coin. Existing
        // over-cap positions stay untouched; risk-reducing actions remain free.
        const cap=planV19CoinCap(own,qty,price,0.0075,decimals);
        if(cap.qty<=0){
          decisions.push({coin:p.coin,action:'POSITION_CAP_HOLD',
            pending_usd:Math.abs(gap)*price,cap_usd:MAX_POSITION_USD,
            current_usd:Math.abs(own)*price,room_usd:cap.remainingUsd,
            reason:cap.reason});
          continue;
        }
        qty=cap.qty;notional=qty*price;
        if(cap.reason==='CAPPED')this.log(s,p.coin,'POSITION_CAP_APPLIED',
          'planned_usd='+notional.toFixed(2)+' limit_usd='+MAX_POSITION_USD);
      }
      if(!reduce&&notional<MIN){decisions.push({coin:p.coin,action:freshEntry?'PARTIAL_ENTRY_WAIT_MIN':'ACCUMULATE_ADD',pending_usd:Math.abs(gap)*price});continue;}
      if(!reduce&&now-p.lastFillAt>MAX_ENTRY_AGE_MS){decisions.push({coin:p.coin,action:'SKIP_STALE_ENTRY',pending_usd:notional});continue;}
      if(!reduce&&!freshEntry&&now-p.lastActionAt<COALESCE_MS){decisions.push({coin:p.coin,action:'COALESCE_ADD',pending_usd:notional});continue;}
      if(sent>=MAX_ACTIONS){decisions.push({coin:p.coin,action:'NEXT_TICK',pending_usd:notional});continue;}
      const direction=(opposite?own<0:gap>0)?'LONG':'SHORT';
      // Account balance and desired target are part of the signature; a new
      // REMOVE/CLOSE/REVERSAL is never held behind an old rejected ADD.
      const rejectSignature=[p.coin,direction,reduce?'R':'O',qty.toFixed(decimals),
        own.toFixed(decimals),p.desired.toFixed(decimals)].join('|');
      if(live&&p.lastRejectedSignature===rejectSignature&&Number(p.lastRejectedUntil||0)>now){
        decisions.push({coin:p.coin,action:'REJECT_RETRY_DEFERRED',qty,usd:notional,
          reason:p.lastRejectReason||'EXCHANGE_REJECTED',retry_at:p.lastRejectedUntil});
        continue;
      }
      decisions.push({coin:p.coin,action:reduce?(opposite?'CLOSE_FOR_REVERSAL_OR_FLAT':'PERCENT_REMOVE'):freshEntry?(Math.abs(own)>0?'CONTINUE_PARTIAL_ENTRY':p.episode>1?'NEW_OR_REVERSAL_ENTRY':'NEW_ENTRY'):'PERCENT_ADD',qty,usd:notional,direction,desired:p.desired,actual:own,source_last_action:p.lastFillKind,initial_remaining_usd:p.entryRemainingUsd||0});
      if(!live)continue;
      const intentId=`V19:${s.startedAt}:${p.coin}:${++p.actionCount}`;
      const cloid=__LC_EXECUTION.cloidForIntent(intentId);
      // Persist BEFORE the exchange call. An uncertain result must never be resent blindly.
      p.pending={id:intentId,cloid,status:'SUBMITTING',at:now,qty,direction};await this.save(s);
      const result=await __LC_EXECUTION.executeLiveIoc(this.env,{intentId,coin:p.coin,direction:direction as 'LONG'|'SHORT',quantity:qty,
        reduceOnly:reduce,referencePrice:price});
      p.lastActionAt=now;
      if(result.executed&&result.filledQty&&result.filledQty>0){
        p.pending=undefined;p.lastError='';p.lastRejectedSignature=undefined;
        p.lastRejectedUntil=0;p.lastRejectReason=undefined;
        p.lastConfirmedOwnQty=own+(direction==='LONG'?1:-1)*Number(result.filledQty);
        p.dustCloseBlockedQty=undefined;p.dustCloseReason=undefined;
        if(!reduce && freshEntry){
          const filled=Number(result.filledQty);
          const total=Math.abs(own)+filled;
          p.entryConfirmedQty=total;
          p.entryRemainingUsd=Math.max(0,Number(p.entryTargetQty||0)-total)*price;
          const unit=10**(-decimals);
          const complete=total>=Number(p.entryTargetQty||0)-unit*0.5;
          p.entryPending=!complete;
          p.entryStatus=complete?'COMPLETE':'PARTIAL';
          this.log(s,p.coin,complete?'INITIAL_ENTRY_COMPLETE':'PARTIAL_ENTRY_FILLED',
            'requested_qty='+qty+' filled_qty='+filled+' cumulative_qty='+total+
            ' initial_target_qty='+p.entryTargetQty+' remaining_usd='+p.entryRemainingUsd.toFixed(4));
        }
        s.orders++;this.log(s,p.coin,reduce?'REDUCE_FILLED':'OPEN_FILLED','qty='+result.filledQty);
      }else if(result.orderSent==='UNKNOWN'||result.orderSent===true&&result.status==='UNEXPECTED_RESTING_ORDER'){
        p.pending!.status='UNKNOWN';p.lastError=result.status;this.log(s,p.coin,'WRITE_UNCERTAIN',result.status);
      }else{
        p.pending=undefined;
        const reason=(result.rejectReason||'').replace(/[\r\n\t]+/g,' ').slice(0,220);
        const detailed=result.status==='REJECTED'&&reason?'REJECTED: '+reason:result.status;
        p.lastError=detailed;
        // Only a confirmed exchange rejection is retry-suppressed. Network
        // uncertainty retains its existing order-specific proof path.
        if(result.status==='REJECTED'&&result.orderSent===true){
          // If even an entire position cannot be closed because its value is
          // below the exchange minimum, keep it visible and do not spam 429/REJECTED.
          if(reduce && opposite && /minimum value of \$?10|MinTradeNtl/i.test(reason)
              && Math.abs(own)*price<MIN){
            p.dustCloseBlockedQty=Math.abs(own);p.dustCloseReason=detailed;
            p.reduceState='DUST_CLOSE_REJECTED';
            this.log(s,p.coin,'DUST_CLOSE_REJECTED',detailed+'; own_qty='+own+
              '; manual exchange resolution may be required');
          }
          p.lastRejectedSignature=rejectSignature;
          p.lastRejectedUntil=Date.now()+(reduce?REJECT_RETRY_REDUCE_MS:REJECT_RETRY_ENTRY_MS);
          p.lastRejectReason=detailed;
          this.log(s,p.coin,'EXCHANGE_REJECTED',detailed+'; qty='+qty+'; reduceOnly='+reduce+
            '; retry_after='+new Date(p.lastRejectedUntil).toISOString());
        }else this.log(s,p.coin,'NO_FILL',detailed);
      }
      await this.save(s);sent++;
    }
    return {sent,decisions:decisions.slice(0,100)};
  }
  private async sync():Promise<Response>{
    if(this.busy)return J({ok:true,busy:true});this.busy=true;
    let s:Session|undefined;
    try{
      s=await this.load();if(s.mode!=='RUNNING')return J({ok:false,error:'STOPPED'},409);
      if(s.live&&!this.authorized(s)&&!(await this.restore(s)))return J({ok:false,error:'LIVE_ARM_NOT_RESTORED'},409);
      // Once-only V19.1 upgrade. Do not replay historical fills.
      for(const p of Object.values(s.coins))if(p.waitingFlat===true){
        p.baseline=p.sourceQty;p.waitingFlat=false;p.inheritedMode=Math.abs(p.sourceQty)>1e-8;
        p.inheritedPendingUsd=0;p.inheritedDirection=Math.sign(p.sourceQty);
        p.desired=0;p.active=false;p.entryPending=false;
      }
      // D1 fills MUST advance during an INFO 429 backoff. The exchange's
      // current position is checked again before any later execution.
      const processed=await this.processFills(s);s.syncs++;s.lastSync=Date.now();await this.save(s);
      const now=Date.now();const cooldown=Number(s.cooldownUntil||0);
      if(cooldown>now)return J({ok:true,version:'V19_7_POSITION_CAP',processed,
        cursor:s.cursor,events:s.events,exchange_deferred:true,
        reason:'INFO_RATE_LIMIT_BACKOFF',retry_after:cooldown,real_orders_sent:0});
      const last=Number(await this.state.storage.get('live_copy_v19_last_reconcile')||0);
      const interval=processed>0?INFO_RECONCILE_MIN_MS:INFO_RECONCILE_IDLE_MS;
      if(now-last<interval)return J({ok:true,version:'V19_7_POSITION_CAP',processed,
        cursor:s.cursor,events:s.events,exchange_deferred:true,
        reason:'INFO_POLL_COALESCING',next_check_at:last+interval,real_orders_sent:0});
      // Reserve the INFO polling slot before sending requests. A WebSocket
      // burst cannot trigger dozens of overlapping/excessive reconciliations.
      await this.state.storage.put('live_copy_v19_last_reconcile',now);
      try{
        const result=await this.reconcile(s);s.lastDecisions=result.decisions;
        // Successful INFO read resets previous API error display and cooldown.
        s.cooldownUntil=0;
        s.errors=(s.errors||[]).filter(e=>!String(e).includes('INFO_HTTP_429'));
        await this.save(s);
        return J({ok:true,version:'V19_7_POSITION_CAP',processed,cursor:s.cursor,
          events:s.events,live:this.authorized(s),...result});
      }catch(e){
        const rateLimited=/429|RATE_LIMIT|TOO_MANY_REQUESTS/i.test(String(e));
        if(rateLimited){
          s.cooldownUntil=Date.now()+INFO_BACKOFF_MS;
          // Keep just one rate-limit message; status exposes retry_after.
          s.errors=(s.errors||[]).filter(x=>!String(x).includes('INFO_HTTP_429'));
          s.errors.unshift('INFO_HTTP_429 · automatic INFO requests paused');
          await this.save(s);
          return J({ok:true,version:'V19_7_POSITION_CAP',processed,cursor:s.cursor,
            events:s.events,exchange_deferred:true,reason:'INFO_RATE_LIMIT_BACKOFF',
            retry_after:s.cooldownUntil,real_orders_sent:0});
        }
        this.error(s,e);await this.save(s);
        return J({ok:false,error:'V19_RECONCILE_FAILED',detail:String(e),
          processed,cursor:s.cursor,events:s.events},503);
      }
    }catch(e){
      if(s){this.error(s,e);await this.save(s);}
      return J({ok:false,error:'V19_FILL_SYNC_FAILED',detail:String(e)},503);
    }finally{this.busy=false;}
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
      const s=await this.load();const latest=await this.latest().catch(()=>null);const coins=Object.values(s.coins).map(p=>({coin:p.coin,source_qty:p.sourceQty,desired_qty:p.desired,scale:p.scale,active:p.active,waiting_flat:p.waitingFlat,entry_pending:p.entryPending===true,last_fill_kind:p.lastFillKind||null,
        last_price:p.lastPx,last_fill_at:p.lastFillAt,updated_at:p.lastActionAt,error:p.lastError,pending:p.pending?.status||null,episode:p.episode,inherited_mode:p.inheritedMode===true,inherited_pending_add_usd:Number(p.inheritedPendingUsd||0),
          pending_reduce_usd:Number(p.pendingReduceUsd||0),reduce_state:p.reduceState||null,
          dust_close_alert:p.dustCloseReason||null,entry_kind:p.lastFillKind||null,entry_confirmed:p.entryStatus==='COMPLETE',entry_status:p.entryStatus||null,entry_target_qty:p.entryTargetQty||0,entry_confirmed_qty:p.entryConfirmedQty||0,entry_remaining_usd:Number(p.entryRemainingUsd||0),rejection_retry_until:p.lastRejectedUntil||0,last_reject_reason:p.lastRejectReason||null}));
      return J({ok:true,version:'V19_7_POSITION_CAP',mode:s.mode,session_kind:s.live?'LIVE':'DRY_RUN',live_execution:s.mode==='RUNNING'&&s.live&&this.liveConfigured(),
        cursor:s.cursor,latest_fill_row:latest?.rowid||0,lag_rows:Math.max(0,(latest?.rowid||0)-s.cursor),processed_fills:s.events,orders_sent_and_filled:s.orders,
        skipped:s.skipped,syncs:s.syncs,last_sync:s.lastSync,minimum_notional_usd:MIN,max_position_notional_usd:MAX_POSITION_USD,max_position_margin_at_10x_usd:MAX_POSITION_USD/10,api_backoff_until:s.cooldownUntil||0,api_backoff_seconds:Math.max(0,Math.ceil(((s.cooldownUntil||0)-Date.now())/1000)),exchange_poll_interval_ms:INFO_RECONCILE_MIN_MS,source_session:s.sourceSession,started_at:s.startedAt,
        coins,decisions:s.lastDecisions||[],errors:s.errors,recent:s.recent,stopped_reason:s.stoppedReason,mode_description:'PERCENTAGE_FILLS_INHERITED_ADD_ACCUMULATION_10_40'});
    }
    if(method==='GET'&&path==='/account'){try{return J(await __LC_EXECUTION.readLiveAccount(this.env));}catch(e){return J({ok:false,error:String(e)},503);}}
    if(method==='GET'&&path==='/our-activity'){const s=await this.load();return J({ok:true,events:s.recent});}
    return J({ok:false,error:'UNSUPPORTED_V19_ROUTE',path},404);
  }
}
