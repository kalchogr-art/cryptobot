/** V19.7 EXPOSURE CAP + PARTIAL INITIAL ENTRY TRACKING — standalone replacement for src/live-copy-controller-v2.3-stage15.ts.
 * Source: mc_v19_fills (userFills only). Fresh NEW/REVERSAL=$10.40 notional ($1.04 margin at 10x). ADD/REMOVE are percentage scaled. OPEN/CANCEL are NEVER copied.
 * One DO serializes decisions. Live trading requires explicit existing flags + START confirmation.
 * Data validation, dedupe, write uncertainty and exchange reality are kept separate from obsolete V18 ledger.
 * Live deployment NOT validated against exchange; test SHADOW then small funded live with account flat.
 */
import { bytesToHex, concat, keccak256, recoverTypedDataAddress } from 'viem';
import { encode } from '@msgpack/msgpack';
import { privateKeyToAccount } from 'viem/accounts';

/** V19.13 READ ONLY IP REST instrumentation.
 * Counts only REST requests actually observed in this Worker isolate. Cloudflare may use
 * different outbound IPs and other processes may consume the same IP budget.
 * Data is process-memory only and starts again on isolate restart. Not an exchange quota.
 */
type HLRestObservation={at:number;endpoint:'info'|'exchange';operation:string;weight:number;status:number;elapsed_ms:number;error?:string};
const HL_REST_BOOT_AT=Date.now();
const HL_REST_LIMIT=1200;
const HL_REST_OBSERVATIONS:HLRestObservation[]=[];
const HL_REST_KEEP_MS=24*60*60*1000;
function hlWeight(endpoint:'info'|'exchange',body:any):number{
  if(endpoint==='exchange'){
    const a=body?.action;
    const count=Array.isArray(a?.orders)?a.orders.length:Array.isArray(a?.cancels)?a.cancels.length:Array.isArray(a?.modifies)?a.modifies.length:1;
    return 1+Math.floor(Math.max(1,count)/40);
  }
  const op=String(body?.type||'unknown');
  if(['l2Book','allMids','clearinghouseState','orderStatus','spotClearinghouseState','exchangeStatus'].includes(op))return 2;
  if(op==='userRole')return 60;
  // Endpoint-dependent response-length surcharge is not included: lower-bound estimate.
  return 20;
}
async function hlObservedFetch(url:string,body:any):Promise<Response>{
  const endpoint:'info'|'exchange'=url.endsWith('/exchange')?'exchange':'info';
  const operation=endpoint==='exchange'?String(body?.action?.type||'exchange_action'):String(body?.type||'info_unknown');
  const weight=hlWeight(endpoint,body),started=Date.now();
  let status=0,error='';
  try{
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    status=response.status;
    return response;
  }catch(e){error=String(e).slice(0,150);throw e;}
  finally{
    HL_REST_OBSERVATIONS.push({at:Date.now(),endpoint,operation,weight,status,elapsed_ms:Date.now()-started,...(error?{error}:{})});
    const cutoff=Date.now()-HL_REST_KEEP_MS;
    while(HL_REST_OBSERVATIONS.length&&(HL_REST_OBSERVATIONS[0].at<cutoff||HL_REST_OBSERVATIONS.length>6000))HL_REST_OBSERVATIONS.shift();
  }
}
function hlIpRestSnapshot(){
  const now=Date.now(),last60=HL_REST_OBSERVATIONS.filter(x=>x.at>now-60000),lastHour=HL_REST_OBSERVATIONS.filter(x=>x.at>now-3600000),lastDay=HL_REST_OBSERVATIONS.filter(x=>x.at>now-86400000);
  const sum=(xs:HLRestObservation[])=>xs.reduce((n,x)=>n+x.weight,0);
  const n429=(xs:HLRestObservation[])=>xs.filter(x=>x.status===429).length;
  const knownWeight=sum(last60),infoWeight=sum(last60.filter(x=>x.endpoint==='info'));
  return {ok:true,mode:'READ_ONLY',scope:'WORKER_ISOLATE_OBSERVED_REST_ONLY',estimated:true,
    boot_at:HL_REST_BOOT_AT,checked_at:now,ip_limit_weight_per_minute:HL_REST_LIMIT,
    observed_weight_60s:knownWeight,observed_info_weight_60s:infoWeight,
    observed_exchange_weight_60s:knownWeight-infoWeight,
    observed_requests_60s:last60.length,
    observed_weight_pct_60s:Math.round(10000*knownWeight/HL_REST_LIMIT)/100,
    http_429_60m:n429(lastHour),http_429_24h:n429(lastDay),
    observed_requests_60m:lastHour.length,observed_weight_60m:sum(lastHour),
    recent_http_429:lastDay.filter(x=>x.status===429).slice(-30).reverse(),
    recent_rest_failures:lastDay.filter(x=>x.status===429||x.status===0||x.status>=500).slice(-30).reverse(),
    response_item_surcharges_not_counted:true,other_cloudflare_isolates_and_external_ip_traffic_not_counted:true,
    exact_remaining_ip_quota:null,websocket_usage_not_counted:true,
    warning:'Observed weight is a lower-bound estimate for one Worker isolate, NOT total IP consumption. 429 does not prove a missed trade.'};
}

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
  const r = await hlObservedFetch(url,body);
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

/** V19.16: bidirectional, strictly post-only maker order. Order may rest or fail;
 * accepted != filled. Durable Object must persist cloid before calling this.
 */
export async function makerFullTradeOrder(env:LiveCopyEnv,coin:string,qtyWanted:number,
    direction:'LONG'|'SHORT',reduceOnly:boolean,intentId:string):Promise<{cloid:string;qty:number;price:number;oid:number|string|null;responseStatus:string}>{
  const key=normalizeKey(env.HYPERLIQUID_API_PRIVATE_KEY),master=env.HYPERLIQUID_MASTER_ACCOUNT?.trim()||'';
  if(env.LIVE_COPY_TRADING_ENABLED!=='true'||env.LIVE_COPY_LEVERAGE_VERIFIED!=='true'||env.LIVE_COPY_LEVERAGE_MODE!=='cross')throw Error('FULL_TRADE_FLAGS_NOT_ENABLED');
  if(!keyFormat(key)||!validAddress(master))throw Error('FULL_TRADE_CREDENTIALS_INVALID');
  const [account,book]=await Promise.all([readLiveAccount(env),info({type:'l2Book',coin})]);
  const asset=account.assetMeta.find((x:any)=>x.coin===coin);
  if(!asset)throw Error('FULL_TRADE_UNKNOWN_ASSET');
  const bid=Number(book?.levels?.[0]?.[0]?.px),ask=Number(book?.levels?.[1]?.[0]?.px);
  if(!(bid>0&&ask>bid)||Date.now()-Number(book.time||0)>1800)throw Error('FULL_TRADE_STALE_BOOK');
  const current=Number(account.positions.find((x:any)=>x.coin===coin)?.qty||0);
  if(account.positions.some((x:any)=>x.coin!==coin))throw Error('FULL_TRADE_FOREIGN_POSITION');
  const buy=direction==='LONG';
  if(reduceOnly){if(current===0||Math.sign(current)===(buy?1:-1))throw Error('FULL_TRADE_INVALID_REDUCE');}
  else if(current!==0&&Math.sign(current)!==(buy?1:-1))throw Error('FULL_TRADE_CROSS_SIDE_BLOCKED');
  const qty=decimalQty(reduceOnly?Math.min(Math.abs(current),qtyWanted):qtyWanted,asset.szDecimals);
  const price=Number(formatPrice(buy?bid:ask,asset.szDecimals));
  if(!(qty>0&&price>0))throw Error('FULL_TRADE_BELOW_PRECISION');
  if((buy&&price>=ask)||(!buy&&price<=bid))throw Error('FULL_TRADE_WOULD_CROSS');
  if(!reduceOnly){
    const total=(Math.abs(current)+qty)*Math.max(price,ask);
    if(qty*price<10.0)throw Error('FULL_TRADE_BELOW_EXCHANGE_MINIMUM');
    if(total>31.20+1e-8)throw Error('FULL_TRADE_NOTIONAL_CAP');
    if(asset.maxLeverage<10)throw Error('FULL_TRADE_LEVERAGE_UNSUPPORTED');
    const existing=account.positions.find((x:any)=>x.coin===coin);
    if(existing && (Number(existing.leverage?.value)!==10||existing.leverage?.type!=='cross'))throw Error('FULL_TRADE_EXISTING_LEVERAGE_MISMATCH');
    if(!existing){
      const lr=await sendAction({type:'updateLeverage',asset:asset.assetId,isCross:true,leverage:10},key as `0x${string}`,master);
      if(lr?.status!=='ok'||lr?.response?.type!=='default')throw Error('FULL_TRADE_LEVERAGE_NOT_VERIFIED');
    }
  }
  const cloid=cloidForIntent(intentId);
  const action={type:'order',orders:[{a:asset.assetId,b:buy,p:String(price),s:qty.toFixed(asset.szDecimals),r:reduceOnly,t:{limit:{tif:'Alo'}},c:cloid}],grouping:'na'};
  const r=await sendAction(action,key as `0x${string}`,master);
  const status=r?.response?.data?.statuses?.[0];
  if(r?.status!=='ok'||!status||status.error)throw Error('FULL_TRADE_ORDER_REJECTED:'+JSON.stringify(status||r).slice(0,260));
  if(!status.resting&&!status.filled)throw Error('FULL_TRADE_ORDER_UNKNOWN_STATUS');
  return {cloid,qty,price,oid:status.resting?.oid??status.filled?.oid??null,responseStatus:status.resting?'resting':'filled'};
}

/** V19.14 legacy SHORT-only order adapter (not activated for V19.15). ALO cannot execute taker. */
export async function makerShortOrder(env:LiveCopyEnv, coin:string, qtyWanted:number, buy:boolean, reduceOnly:boolean, intentId:string){
  if(env.LIVE_COPY_TRADING_ENABLED!=='true'||env.LIVE_COPY_LEVERAGE_VERIFIED!=='true'||env.LIVE_COPY_LEVERAGE_MODE!=='cross')throw Error('LIMIT_TEST_LIVE_FLAGS_MISSING');
  const key=normalizeKey(env.HYPERLIQUID_API_PRIVATE_KEY),master=env.HYPERLIQUID_MASTER_ACCOUNT||'';
  if(!keyFormat(key)||!validAddress(master))throw Error('LIMIT_TEST_CREDENTIALS_INVALID');
  const [account,book]=await Promise.all([readLiveAccount(env),info({type:'l2Book',coin})]);
  const asset=account.assetMeta.find((a:any)=>a.coin===coin);if(!asset)throw Error('LIMIT_TEST_ASSET_UNKNOWN');
  const bid=Number(book?.levels?.[0]?.[0]?.px),ask=Number(book?.levels?.[1]?.[0]?.px);
  if(!(bid>0&&ask>bid))throw Error('LIMIT_TEST_INVALID_BOOK');
  const pos=account.positions.find((p:any)=>p.coin===coin);const own=Number(pos?.qty||0);
  if(buy){if(!reduceOnly||own>=0)throw Error('LIMIT_TEST_NO_SHORT_TO_REDUCE');}
  else {if(reduceOnly||account.positions.length!==0)throw Error('LIMIT_TEST_ACCOUNT_NOT_FLAT');}
  const qty=decimalQty(buy?Math.min(Math.abs(own),qtyWanted):qtyWanted,asset.szDecimals);
  const px=Number(formatPrice(buy?bid:ask,asset.szDecimals));
  if(!(qty>0&&px>0))throw Error('LIMIT_TEST_PRECISION');
  // Formatting must never accidentally cross the book.
  if(buy&&px>=ask||!buy&&px<=bid)throw Error('LIMIT_TEST_POST_ONLY_PRICE_CROSSES');
  if(!reduceOnly&&qty*px<10.40)throw Error('LIMIT_TEST_BELOW_MIN_NOTIONAL');
  if(!reduceOnly&&qty*px>11.20)throw Error('LIMIT_TEST_ENTRY_CAP');
  const cloid=cloidForIntent(intentId);
  const action={type:'order',orders:[{a:asset.assetId,b:buy,p:String(px),s:qty.toFixed(asset.szDecimals),r:reduceOnly,t:{limit:{tif:'Alo'}},c:cloid}],grouping:'na'};
  const response=await sendAction(action,key as `0x${string}`,master);
  const status=response?.response?.data?.statuses?.[0];
  if(response?.status!=='ok'||!status||status.error)throw Error('LIMIT_TEST_ORDER_REJECTED:'+JSON.stringify(status||response).slice(0,300));
  return {cloid,qty,price:px,oid:status.resting?.oid??status.filled?.oid??null,fill:status.filled??null};
}
export async function cancelMakerTest(env:LiveCopyEnv,coin:string,cloid:string){
  const key=normalizeKey(env.HYPERLIQUID_API_PRIVATE_KEY),master=env.HYPERLIQUID_MASTER_ACCOUNT||'';
  if(!keyFormat(key)||!validAddress(master))throw Error('LIMIT_TEST_CREDENTIALS_INVALID');
  const meta=await info({type:'meta'}),id=(meta?.universe||[]).findIndex((x:any)=>x.name===coin);
  if(id<0)throw Error('LIMIT_TEST_ASSET_UNKNOWN');
  return sendAction({type:'cancelByCloid',cancels:[{asset:id,cloid}]},key as `0x${string}`,master);
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


/** Stop-market protective order. Reduce-only, signed and client-addressable.
 * Trigger condition is based on MARK price. An acknowledged resting stop is
 * not proof it will fill at the trigger price. Unknown writes are never retried.
 */
export async function placeStopMarket(env:LiveCopyEnv, intentId:string, coin:string, signedQty:number,
                                      triggerPrice:number):Promise<{ok:boolean;cloid:string;status:string;reason?:string}> {
  const cloid=cloidForIntent(intentId);
  const key=normalizeKey(env.HYPERLIQUID_API_PRIVATE_KEY);
  const master=env.HYPERLIQUID_MASTER_ACCOUNT?.trim()||'';
  if(env.LIVE_COPY_TRADING_ENABLED!=='true'||!keyFormat(key)||!validAddress(master))
    return {ok:false,cloid,status:'STOP_CREDENTIALS_NOT_CONFIGURED'};
  if(!Number.isFinite(triggerPrice)||triggerPrice<=0||!Number.isFinite(signedQty)||signedQty===0)
    return {ok:false,cloid,status:'STOP_INVALID_INPUT'};
  let state:any,meta:any;
  try{[state,meta]=await Promise.all([
    info({type:'clearinghouseState',user:master}),info({type:'meta'})]);
  }catch(e){return {ok:false,cloid,status:'STOP_ACCOUNT_READ_FAILED',reason:String(e)};}
  const idx=(meta?.universe||[]).findIndex((a:any)=>a.name===coin);
  const asset=idx>=0?{assetId:idx,szDecimals:Number(meta.universe[idx].szDecimals)}:null;
  const pos=(state?.assetPositions||[]).find((x:any)=>x?.position?.coin===coin)?.position;
  const actualQty=Number(pos?.szi||0);
  if(!asset||!Number.isFinite(actualQty)||!actualQty||Math.sign(actualQty)!==Math.sign(signedQty))
    return {ok:false,cloid,status:'STOP_POSITION_NOT_CONFIRMED'};
  const size=decimalQty(Math.min(Math.abs(actualQty),Math.abs(signedQty)),asset.szDecimals);
  if(size<=0)return {ok:false,cloid,status:'STOP_BELOW_SIZE_PRECISION'};
  const isBuy=actualQty<0;
  const triggerPx=formatPrice(triggerPrice,asset.szDecimals);
  // Market-trigger price is a far-side limit; not the guaranteed execution price.
  const boundPx=formatPrice(Number(triggerPx)*(isBuy?1.10:0.90),asset.szDecimals);
  const order={a:asset.assetId,b:isBuy,p:boundPx,s:size.toFixed(asset.szDecimals),r:true,
    t:{trigger:{isMarket:true,triggerPx,tpsl:'sl'}},c:cloid};
  try{
    const res=await sendAction({type:'order',orders:[order],grouping:'na'},key as `0x${string}`,master);
    const st=res?.response?.data?.statuses?.[0];
    if(st?.resting?.oid!=null)return {ok:true,cloid,status:'RESTING'};
    if(st?.error)return {ok:false,cloid,status:'STOP_REJECTED',reason:String(st.error)};
    return {ok:false,cloid,status:'STOP_RESPONSE_UNCERTAIN',reason:JSON.stringify(res).slice(0,230)};
  }catch(e){return {ok:false,cloid,status:'STOP_WRITE_UNCERTAIN',reason:String(e)};}
}
export async function cancelStopByCloid(env:LiveCopyEnv,coin:string,cloid:string):Promise<boolean>{
  const key=normalizeKey(env.HYPERLIQUID_API_PRIVATE_KEY);
  const master=env.HYPERLIQUID_MASTER_ACCOUNT?.trim()||'';
  if(!keyFormat(key)||!validAddress(master))throw Error('CANCEL_STOP_CREDENTIALS');
  const meta=await info({type:'meta'});
  const assetId=(meta?.universe||[]).findIndex((a:any)=>a.name===coin);
  if(assetId<0)throw Error('CANCEL_STOP_ASSET');
  const res=await sendAction({type:'cancelByCloid',cancels:[{asset:assetId,cloid}]},key as `0x${string}`,master);
  return res?.status==='ok' && Array.isArray(res?.response?.data?.statuses) && res.response.data.statuses.every((x:any)=>x==='success');
}

}

type DB = {prepare(sql:string):{bind(...args:any[]):{first<T=any>():Promise<T|null>;all<T=any>():Promise<{results:T[]}>}}};
type Env=__LC_EXECUTION.LiveCopyEnv & {
  DB:DB;LIVE_COPY_ADMIN_TOKEN?:string;LIVE_COPY_AUTO_EXECUTION_ENABLED?:string;
  LIVE_COPY_SOURCE_WALLET?:string;LIVE_COPY_V19_MIN_NOTIONAL?:string;LIMIT_TEST_TRADING_ENABLED?:string;
};
type Fill={rowid:number;session_id:string;fill_id:string;at:number;coin:string;side:'A'|'B';sz:number;px:number;start_pos:number;source_oid:string};
type CoinState={coin:string;sourceQty:number;baseline:number;scale:number;episode:number;active:boolean;waitingFlat:boolean;
  entryPending?:boolean;episodeEntryPx?:number;episodeStartedAt?:number;lastFillKind?:string;
  // V19.8: durable, per-coin exit barrier. A fast SHORT->LONG->SHORT must
  // close the old SHORT before opening the new episode, even when both fills
  // are consumed in the same D1 batch.
  exitBarrier?:boolean;exitBarrierReason?:string;exitBarrierAt?:number;
  sourceChainFault?:boolean;sourceChainFaultAt?:number;
  entryBalanceBlockedEpisode?:number;
  /** V19.9 independent per-coin safety state, persisted in Durable Object. */
  stopCloid?:string;stopQty?:number;stopPx?:number;stopEpisode?:number;
  stopStatus?:string;stopFault?:string;stopCheckedAt?:number;
  stopBlockedEpisode?:number;stopRequestSerial?:number;stopCleanupCloids?:string[];
  safetyLastSourceQty?:number;safetyCheckAt?:number;safetyFault?:string;safetyMismatchCount?:number;
  noAddLossCount?:number;
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
  stoppedReason:string;lastDecisions?:any[];cooldownUntil?:number;sessionCapital?:number;sessionEquityBasis?:string;};

/** Single equity source: NEVER add unified spot USDC to perps account value. */
function v19SessionEquity(a:Awaited<ReturnType<typeof __LC_EXECUTION.readLiveAccount>>):{value:number;basis:string}|null {
  if(a.spotUsdcTotal!==null&&Number.isFinite(a.spotUsdcTotal)&&a.spotUsdcTotal>=0)
    return {value:a.spotUsdcTotal,basis:'UNIFIED_SPOT_USDC'};
  if(!a.spotBalanceError&&Number.isFinite(a.accountValue)&&a.accountValue>0)
    return {value:a.accountValue,basis:'PERP_ACCOUNT_VALUE'};
  return null;
}
/** Computes completed position episodes, not per-order wins. A missing/truncated history stays unknown. */
export function v19SessionWinRate(rows:any[],since:number){
  if(!Array.isArray(rows)||rows.length>=2000)
    return {closed:null,wins:null,losses:null,winRate:null,reason:'FILL_HISTORY_TRUNCATED'};
  const fills=rows.filter(x=>Number(x.time)>=since).sort((a,b)=>Number(a.time)-Number(b.time)||Number(a.tid||0)-Number(b.tid||0));
  const ep:Record<string,{pnl:number;known:boolean}>={};let closed=0,wins=0,losses=0;
  for(const f of fills){
    if(!f.coin||!['A','B'].includes(f.side))continue;
    const before=Number(f.startPosition),sz=Number(f.sz),fee=Number(f.fee||0),pnl=Number(f.closedPnl||0);
    if(!Number.isFinite(before)||!Number.isFinite(sz)||sz<=0||!Number.isFinite(pnl)||!Number.isFinite(fee))continue;
    const after=before+(f.side==='B'?sz:-sz),cross=before*after< -1e-8,flat=Math.abs(after)<1e-8;
    let current=ep[f.coin];if(!current)current=ep[f.coin]={pnl:0,known:Math.abs(before)<1e-8};
    const closeShare=cross?Math.min(1,Math.abs(before)/sz):1;
    current.pnl+=pnl-fee*closeShare;
    if((flat||cross)&&Math.abs(before)>1e-8){
      if(current.known){closed++;if(current.pnl>1e-7)wins++;else if(current.pnl< -1e-7)losses++;}
      delete ep[f.coin];
    }
    if(cross)ep[f.coin]={pnl:-fee*(1-closeShare),known:true};
  }
  return {closed,wins,losses,winRate:closed?wins*100/closed:null,reason:closed?'':'NO_COMPLETED_TRADES'};
}
const KEY='live_copy_v19_net_position';
export function canAddAtMark(ownQty:number, entryPrice:number,markPrice:number):boolean {
  if(!Number.isFinite(ownQty)||!Number.isFinite(entryPrice)||!Number.isFinite(markPrice)||
     !entryPrice||entryPrice<=0||markPrice<=0)return false;
  if(Math.abs(ownQty)<1e-10)return true;
  return ownQty>0?markPrice>=entryPrice:markPrice<=entryPrice;
}
export function stopTriggerAtEntry(ownQty:number,entryPrice:number):number {
  return ownQty>0?entryPrice*(1-STOP_ADVERSE_MOVE):entryPrice*(1+STOP_ADVERSE_MOVE);
}
const MIN=10.40; // User's $10 accumulator with $0.40 buffer against min notional/precision.
const STOP_LOSS_ROE=0.25; // 25% of initial 10x margin ~= 2.5% adverse mark move
const STOP_ADVERSE_MOVE=STOP_LOSS_ROE/10;
const SAFETY_AUDIT_INTERVAL_MS=60000;
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
const postInfo=async(body:any)=>{const r=await hlObservedFetch('https://api.hyperliquid.xyz/info',body);if(!r.ok)throw Error('INFO_HTTP_'+r.status);return await r.json() as any;};
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

/** V19.14: isolate *strategy state*, NOT account, in the same Durable Object.
 * Legacy short execution remains disabled. V19.15 audits all source fill actions without executing.
 * This monitor is strictly single-coin / single-position and is guarded by
 * the original strategy STOP + flat account + no exchange orders.
 */
const LIMIT_TEST_SOURCE='0xbb160cb61e694570f9d570f9fcde7c61dd2143ad';
const LIMIT_TEST_KEY='v19_limit_short_test_v1';
const LIMIT_TEST_NOTIONAL=10.40;
const LIMIT_TEST_ENTRY_TTL_MS=2300;
const LIMIT_TEST_EXIT_TTL_MS=1800;
const LIMIT_TEST_MAX_HOLD_MS=12000;
type LTOrder={cloid:string;coin:string;at:number;qty:number;px:number;side:'ENTRY'|'EXIT';state:'UNKNOWN'|'OPEN';};
type LTState={active:boolean;halted:boolean;reason:string;started:number;lastPoll:number;sourceAfter:number;seen:string[];
  coin:string;sourceShort:boolean;sourceExit:boolean;enteredAt:number;exitMakerTried?:boolean;order?:LTOrder;
  completed:number;opens:number;missed:number;forcedTaker:number;errors:string[];
  history:Array<{at:number;coin:string;event:string;detail:string}>;};
function ltDefault():LTState{return {active:false,halted:false,reason:'NOT_STARTED',started:0,lastPoll:0,sourceAfter:0,seen:[],coin:'',sourceShort:false,sourceExit:false,enteredAt:0,completed:0,opens:0,missed:0,forcedTaker:0,errors:[],history:[]};}


/** V19.15 FULL TRADE source audit, read-only.
 * Derive actions from actual source fill startPosition + signed fill size.
 * Handles LONG, SHORT, ADD, partial close, CLOSE, and reversal. A fill
 * spanning zero is one REVERSAL, not two independently executable orders.
 * No maker orders are submitted by this diagnostic.
 */
type FullTradeEvent={at:number;coin:string;action:string;side:string;before:number;after:number;delta:number;price:number;fee:number;closedPnl:number;fillId:string};
function classifySourceFullTrade(f:any):FullTradeEvent|null {
  const coin=String(f?.coin||'');
  const at=Number(f?.time),sz=Math.abs(Number(f?.sz)),before=Number(f?.startPosition),price=Number(f?.px);
  const side=String(f?.side||'').toUpperCase();
  if(!coin||!Number.isFinite(at)||!Number.isFinite(sz)||sz<=0||!Number.isFinite(before)||!Number.isFinite(price)||price<=0||!['A','B'].includes(side))return null;
  const delta=side==='B'?sz:-sz;
  const after=Number((before+delta).toPrecision(12));
  const eps=Math.max(1e-9,sz*1e-7);
  const sign=(n:number)=>Math.abs(n)<=eps?0:n>0?1:-1;
  const b=sign(before),a=sign(after);
  let action:string;
  if(b===0&&a!==0)action=a>0?'OPEN_LONG':'OPEN_SHORT';
  else if(b!==0&&a===0)action='CLOSE';
  else if(b!==0&&a!==0&&b!==a)action='REVERSAL_'+(a>0?'LONG':'SHORT');
  else if(b===a&&Math.abs(after)>Math.abs(before)+eps)action='ADD';
  else if(b===a&&Math.abs(after)<Math.abs(before)-eps)action='PARTIAL_CLOSE';
  else action='UNCHANGED_OR_ROUNDING';
  return {at,coin,action,side,before,after,delta,price,fee:Number(f?.fee||0),closedPnl:Number(f?.closedPnl||0),fillId:String(f?.hash||'')+':'+String(f?.tid??f?.oid??'')+':'+at};
}

/** V19.16 durable, independent FULL TRADE state. Old LT state retained solely
 * for migration visibility and is NEVER automatically armed. */
const FT_KEY='v19_full_trade_v1916';
type FTOrder={cloid:string;coin:string;at:number;qty:number;reduceOnly:boolean;state:'SUBMITTING'|'OPEN'|'CANCELING'};
type FTState={active:boolean;halted:boolean;started:number;reason:string;coin:string;sourceQty:number;target:number;scale:number;
  episode:number;episodeAt:number;lastActionAt:number;lastFillAt:number;lastEntryAttemptAt:number;
  order?:FTOrder;stop?:{cloid:string;qty:number;at:number;status:'SUBMITTING'|'RESTING'};
  pendingReversal?:{qty:number;px:number;at:number};seen:string[];ignoredCoins:string[];
  wsReadyAt:number;wsDisconnectedAt:number;seq:number;hadExposure:boolean;completed:number;missed:number;
  errors:string[];history:Array<{at:number;coin:string;event:string;detail:string}>;lastOrderResolvedAt:number;exitMakerAttemptAt:number;emergencyIntent?:string;exitBarrier:boolean;};
function ftDefault():FTState{return {active:false,halted:false,started:0,reason:'NOT_STARTED',coin:'',sourceQty:0,target:0,scale:0,
  episode:0,episodeAt:0,lastActionAt:0,lastFillAt:0,lastEntryAttemptAt:0,seen:[],ignoredCoins:[],wsReadyAt:0,wsDisconnectedAt:0,
  seq:0,hadExposure:false,completed:0,missed:0,errors:[],history:[],lastOrderResolvedAt:0,exitMakerAttemptAt:0,exitBarrier:false};}

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
  // Retry only read-only D1 queries on transient Cloudflare internal faults.
  // No execution/order submission is included in this retry scope.
  private async d1Read<T>(label:string,read:()=>Promise<T>):Promise<T>{
    for(let attempt=0;attempt<3;attempt++){
      try{const result=await read();
        const previous=await this.state.storage.get('live_copy_v19_d1_diagnostic') as {status?:string;error?:string}|undefined;
        if(attempt>0||previous?.status==='FAILED'||previous?.status==='RETRYING')
          await this.state.storage.put('live_copy_v19_d1_diagnostic',
            {status:'RECOVERED',query:label,attempts:attempt+1,at:Date.now(),previous_error:previous?.error||null});
        return result;
      }catch(e){const message=String(e);
        const transient=/D1_ERROR|internal error|SQLITE_BUSY|database is locked|temporarily unavailable/i.test(message);
        await this.state.storage.put('live_copy_v19_d1_diagnostic',
          {status:transient&&attempt<2?'RETRYING':'FAILED',query:label,attempts:attempt+1,at:Date.now(),error:message});
        if(!transient||attempt===2)throw e;
        await new Promise<void>(resolve=>setTimeout(resolve,250*(2**attempt)));
      }
    }
    throw Error('D1_READ_RETRIES_EXHAUSTED');
  }
  private async latest(){return this.d1Read('LATEST_FILL',()=>this.env.DB.prepare('SELECT rowid,session_id FROM mc_v19_fills ORDER BY rowid DESC LIMIT 1').bind().first<{rowid:number;session_id:string}>());}
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
    const capitalRecord=v19SessionEquity(await __LC_EXECUTION.readLiveAccount(this.env));
    if(!capitalRecord||capitalRecord.value<=0)return J({ok:false,error:'CAPITAL_SNAPSHOT_UNAVAILABLE_NO_START'},503);
    // Every START is fresh; existing V18 storage is intentionally not read or reused.
    const coins:Record<string,CoinState>={};for(const [coin,qty] of Object.entries(baseline))if(Math.abs(qty)>1e-9)
      coins[coin]={coin,sourceQty:qty,baseline:qty,scale:0,episode:0,active:false,waitingFlat:false,inheritedMode:true,inheritedPendingUsd:0,inheritedDirection:Math.sign(qty),desired:0,lastPx:0,lastFillAt:0,lastActionAt:0,lastFillId:'',lastError:'',lastConfirmedOwnQty:0,actionCount:0};
    const s:Session={version:19,mode:'RUNNING',live:this.liveConfigured(),startedAt:at,cursor:latest?.rowid||0,
      sourceSession:latest?.session_id||'',coins,events:0,syncs:0,skipped:0,orders:0,lastSync:0,errors:[],recent:[],stoppedReason:'',sessionCapital:capitalRecord.value,sessionEquityBasis:capitalRecord.basis};
    await this.state.storage.put('live_copy_v19_arm',s.live?{startedAt:at}:null);await this.state.storage.put('live_copy_v19_last_reconcile',0);this.arm=s.live?at:null;
    await this.save(s);await this.state.storage.setAlarm(Date.now()+1000);
    return J({ok:true,version:'V19_16_FULL_TRADE_LIVE_CANDIDATE',mode:s.mode,live:s.live,cursor:s.cursor,existing_source_positions_ignored:Object.keys(coins).length});
  }
  private async processFills(s:Session){
    const rows=await this.d1Read('PROCESS_FILLS',()=>this.env.DB.prepare(`SELECT rowid,session_id,fill_id,at,coin,side,sz,px,start_pos,source_oid
      FROM mc_v19_fills WHERE rowid>? ORDER BY rowid ASC LIMIT ${BATCH}`).bind(s.cursor).all<Fill>());
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
      // An inconsistent source chain must not be silently treated as a same-episode ADD.
      // Quarantine only this coin until an independently established NEW/REVERSAL;
      // existing own exposure is reduced to zero by the exit barrier.
      const chainBroken=Math.abs(p.sourceQty-before)>Math.max(1e-7,Math.abs(before)*1e-5);
      if(chainBroken){
        p.lastError='SOURCE_POSITION_DISCONTINUITY';p.sourceChainFault=true;p.sourceChainFaultAt=f.at;
        p.exitBarrier=true;p.exitBarrierReason='SOURCE_CHAIN_BROKEN';p.exitBarrierAt=f.at;
        p.desired=0;p.active=false;p.entryPending=false;p.entryStatus='SOURCE_CHAIN_BROKEN';
        p.inheritedPendingUsd=0;p.inheritedMode=false;
        this.log(s,f.coin,'SOURCE_CHAIN_QUARANTINE','before='+before+' previous='+p.sourceQty+' rowid='+f.rowid);
      }
      p.sourceQty=after;p.lastPx=f.px;p.lastFillAt=f.at;p.lastFillId=f.fill_id;s.events++;
      if(p.sourceChainFault){
        // A fresh zero->nonzero or cross-zero fill gives a new authoritative
        // source episode, but the old live position must still be exited FIRST.
        const recovered=(Math.abs(before)<1e-8&&Math.abs(after)>1e-8)||
          (Math.sign(before)!==0&&Math.sign(after)!==0&&Math.sign(before)!==Math.sign(after));
        if(!recovered){p.desired=0;p.active=false;p.lastFillKind='SOURCE_CHAIN_QUARANTINE';continue;}
        p.sourceChainFault=false;
        this.log(s,f.coin,'SOURCE_CHAIN_RECOVERED_NEW_EPISODE','rowid='+f.rowid);
      }
      const beforeSign=Math.sign(before),afterSign=Math.sign(after);
      // A completely new source position or a reversal is always an immediate
      // $10.40 notional entry. Source exposure from before START is never copied.
      const opening=Math.abs(before)<1e-8&&Math.abs(after)>1e-8;
      const reversal=beforeSign!==0&&afterSign!==0&&beforeSign!==afterSign;
      if(opening||reversal){
        // A source episode boundary is NOT an ADD, even if subsequent fills
        // return to the same direction before our next exchange poll.
        if(p.active||p.exitBarrier){
          p.exitBarrier=true;p.exitBarrierReason=reversal?'SOURCE_REVERSAL':'SOURCE_NEW_AFTER_EXIT';
          p.exitBarrierAt=f.at;
          this.log(s,f.coin,'EPISODE_EXIT_BARRIER','source_event='+p.exitBarrierReason+' rowid='+f.rowid);
        }
        // Every new source episode supersedes stale stop state; NEVER keep its
        // client id as protection for the new position.
        if(p.stopCloid)p.stopCleanupCloids=[...new Set([...(p.stopCleanupCloids||[]),p.stopCloid])];
        p.stopCloid=undefined;p.stopQty=undefined;p.stopPx=undefined;
        p.stopStatus=undefined;p.stopFault=undefined;p.stopBlockedEpisode=undefined;
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
        if(p.active||p.exitBarrier){
          p.exitBarrier=true;p.exitBarrierReason='SOURCE_FLAT';p.exitBarrierAt=f.at;
          this.log(s,f.coin,'EPISODE_EXIT_BARRIER','source_flat rowid='+f.rowid);
        }
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
  private async ownDetailed():Promise<Record<string,{qty:number;entry:number;unrealized:number}>> {
    const master=this.env.HYPERLIQUID_MASTER_ACCOUNT?.trim()||'';
    if(!/^0x[0-9a-f]{40}$/i.test(master))throw Error('MASTER_ADDRESS_INVALID');
    const state=await postInfo({type:'clearinghouseState',user:master});
    if(!Array.isArray(state?.assetPositions))throw Error('INVALID_OWN_POSITION_DETAILS');
    const out:Record<string,{qty:number;entry:number;unrealized:number}>={};
    for(const row of state.assetPositions){const p=row?.position;const q=Number(p?.szi);
      if(p?.coin&&Number.isFinite(q)&&q!==0)
        out[p.coin]={qty:q,entry:Number(p.entryPx),unrealized:Number(p.unrealizedPnl)};
    }
    return out;
  }
  /** Exchange-attached safety check, separate from copy planning. Any disagreement
   * prevents NEW/ADD, while retaining permission to CLOSE / reduce risk.
   * Does not mutate the watched trader's position.
   */
  private async auditSource(s:Session,now:number):Promise<void>{
    if(!this.authorized(s))return;
    const last=Number(await this.state.storage.get('v199_source_audit_at')||0);
    if(now-last<SAFETY_AUDIT_INTERVAL_MS)return;
    await this.state.storage.put('v199_source_audit_at',now);
    const source=await this.sourcePositions();
    for(const p of Object.values(s.coins)){
      if(!p.lastFillAt||!p.active||p.exitBarrier)continue;
      const exchangeQty=Number(source[p.coin]||0),ledgerQty=Number(p.sourceQty||0);
      const discrep=Math.abs(exchangeQty-ledgerQty);
      const tolerance=Math.max(1e-7,Math.abs(exchangeQty)*0.02);
      p.safetyCheckAt=now;p.safetyLastSourceQty=exchangeQty;
      if(discrep>tolerance){
        // One mismatch may simply mean the collector has not yet written the
        // latest source fill. First mismatch blocks exposure, repeated mismatch
        // closes exposure. Never permit a speculative ADD while waiting.
        p.safetyMismatchCount=Number(p.safetyMismatchCount||0)+1;
        p.safetyFault='SOURCE_WALLET_POSITION_MISMATCH';
        this.log(s,p.coin,'SAFETY_SOURCE_MISMATCH',`ledger=${ledgerQty} exchange=${exchangeQty}; count=${p.safetyMismatchCount}`);
        if(p.safetyMismatchCount>=2){
          p.exitBarrier=true;p.exitBarrierReason='SOURCE_AUDIT_MISMATCH';p.exitBarrierAt=now;
          p.desired=0;p.active=false;p.entryPending=false;
        }
      }else{p.safetyFault=undefined;p.safetyMismatchCount=0;}
    }
  }
  /** Verify a live reduce-only stop for this coin using exchange open order data.
   * Never cancel unrelated orders. If the stop cannot be verified, do not ADD.
   * If placement is uncertain do not blindly repeat (duplicate stop risk).
   */
  private async ensureStop(s:Session,p:CoinState,qty:number,entry:number,mark:number,
                           openOrders:any[],now:number):Promise<boolean>{
    if(Math.abs(qty)<1e-10)return true;
    if(!Number.isFinite(entry)||entry<=0||!Number.isFinite(mark)||mark<=0){
      p.stopFault='MISSING_LIVE_ENTRY_OR_MARK';return false;
    }
    const triggered=qty>0?mark<=stopTriggerAtEntry(qty,entry):mark>=stopTriggerAtEntry(qty,entry);
    if(triggered){
      p.stopFault='LOSS_LIMIT_ALREADY_BREACHED';p.exitBarrier=true;p.exitBarrierReason='LOSS_LIMIT_BREACHED';
      p.exitBarrierAt=now;p.desired=0;p.active=false;p.stopBlockedEpisode=p.episode;
      this.log(s,p.coin,'LOSS_LIMIT_BREACHED','stop already passed; force reduce-only exit');
      return false;
    }
    const expectedPx=stopTriggerAtEntry(qty,entry);
    const matching=openOrders.find(o=>String(o?.cloid||'').toLowerCase()===String(p.stopCloid||'').toLowerCase()&&
       String(o?.cloid||'').length>10 && Number(o?.sz)>0 && o?.reduceOnly===true &&
       Number(o?.triggerPx)>0 && Math.sign(qty)===(o?.side==='A'?1:o?.side==='B'?-1:Math.sign(qty)) );
    const precision=10**(-Number((await this.meta()).universe.find((x:any)=>x.name===p.coin)?.szDecimals||0));
    const same=matching && Math.abs(Number(matching.sz)-Math.abs(qty))<=precision*0.5 &&
       Math.abs(Number(matching.triggerPx)-expectedPx)<=Math.max(expectedPx*.0005,.01);
    if(same){p.stopCheckedAt=now;p.stopStatus='VERIFIED';p.stopFault=undefined;return true;}
    // If an existing protective order disappeared while the source episode has
    // not changed, don't reopen a stopped/manual-closed position.
    if(p.stopCloid&&!matching && p.stopEpisode===p.episode){
      p.stopFault='STOP_MISSING_FROM_EXCHANGE';p.stopBlockedEpisode=p.episode;
      p.exitBarrier=true;p.exitBarrierReason='STOP_MISSING';p.exitBarrierAt=now;
      p.desired=0;p.active=false;
      this.log(s,p.coin,'STOP_MISSING','Missing stop: no ADD/NEW until new source episode; exit if still exposed');
      return false;
    }
    if(p.stopStatus==='UNCERTAIN')return false;
    // Place replacement BEFORE canceling previous protection; never leave the
    // account unprotected merely to resize the stop.
    const old=p.stopCloid,serial=Number(p.stopRequestSerial||0)+1;
    const intentId=`V19STOP:${s.startedAt}:${p.coin}:${p.episode}:${serial}`;
    p.stopRequestSerial=serial;p.stopStatus='SUBMITTING';await this.save(s);
    const placed=await __LC_EXECUTION.placeStopMarket(this.env,intentId,p.coin,qty,expectedPx);
    if(!placed.ok){
      p.stopFault=placed.status+(placed.reason?': '+placed.reason:'');
      p.stopStatus=/UNCERTAIN/.test(placed.status)?'UNCERTAIN':'REJECTED';
      // Preserve an older existing stop while urgently blocking increased risk.
      p.exitBarrier=true;p.exitBarrierReason='STOP_NOT_PROTECTED';p.exitBarrierAt=now;
      p.desired=0;p.active=false;p.stopBlockedEpisode=p.episode;
      this.log(s,p.coin,'STOP_INSTALL_FAILED',p.stopFault);
      return false;
    }
    p.stopCloid=placed.cloid;p.stopQty=Math.abs(qty);p.stopPx=expectedPx;
    p.stopEpisode=p.episode;p.stopStatus='RESTING_PENDING_PROOF';p.stopFault=undefined;
    this.log(s,p.coin,'STOP_PLACED','qty='+qty+' trigger='+expectedPx+' cloid='+placed.cloid);
    // We do NOT call this VERIFIED until a later exchange open-order snapshot.
    if(old&&old!==placed.cloid){
      try{
        const canceled=await __LC_EXECUTION.cancelStopByCloid(this.env,p.coin,old);
        if(!canceled){p.stopFault='OLD_STOP_CANCEL_NOT_CONFIRMED';p.stopStatus='REPLACEMENT_OLD_STOP_UNCERTAIN';return false;}
      }catch(e){p.stopFault='OLD_STOP_CANCEL_UNKNOWN '+String(e);p.stopStatus='REPLACEMENT_OLD_STOP_UNCERTAIN';return false;}
    }
    return false;
  }
  private async reconcile(s:Session):Promise<any>{
    const now=Date.now();const live=this.authorized(s);
    // No exchange calls when only passive inherited positions are tracked and
    // there is no active own-side target or unresolved order to reconcile.
      const actionable=Object.values(s.coins).some(p=>p.lastFillAt>0&&
      (p.active===true||!!p.pending||!!p.exitBarrier||Math.abs(p.desired)>1e-10));
    if(!actionable)return {sent:0,decisions:Object.values(s.coins).filter(p=>p.lastFillAt>0&&p.inheritedMode)
      .map(p=>({coin:p.coin,action:'ACCUMULATE_INHERITED_ADD',pending_usd:Number(p.inheritedPendingUsd||0)})).slice(0,100)};
    // Read a FRESH wallet snapshot for any real execution. Never trade from
    // a cached position while a prior fill or uncertain write may have landed.
    const ownDetail=live?await this.ownDetailed():{} as Record<string,{qty:number;entry:number;unrealized:number}>;
    const actual:Record<string,number>={};for(const [coin,pos] of Object.entries(ownDetail))actual[coin]=pos.qty;
    const meta=await this.meta();const mids=await this.midsForReconcile();
    // IMPORTANT: frontendOpenOrders exposes trigger orders; openOrders may not.
    // A failed safety read fails CLOSED for new exposure. Existing exits are
    // still planned and should not be blocked by unavailable stop data.
    let safetyOrders:any[]=[];let safetyAvailable=!live;
    if(live){try{const orders=await postInfo({type:'frontendOpenOrders',user:this.env.HYPERLIQUID_MASTER_ACCOUNT});
      if(!Array.isArray(orders))throw Error('SAFETY_ORDERS_INVALID');safetyOrders=orders;safetyAvailable=true;
    }catch(e){this.log(s,'*','SAFETY_ORDERS_READ_FAILED',String(e));}}
    if(live){try{await this.auditSource(s,now);}catch(e){
      // Exchange failure means safety unknown, not permission to submit new risk.
      safetyAvailable=false;this.log(s,'*','SAFETY_SOURCE_READ_FAILED',String(e));}}

    const sorted=Object.values(s.coins).filter(p=>p.lastFillAt>0).sort((a,b)=>{
      const aa=actual[a.coin]||0,bb=actual[b.coin]||0;
      const aExit=aa!==0&&(!!a.exitBarrier||a.desired===0||Math.sign(aa)!==Math.sign(a.desired)||Math.abs(a.desired)<Math.abs(aa)-1e-9);
      const bExit=bb!==0&&(!!b.exitBarrier||b.desired===0||Math.sign(bb)!==Math.sign(b.desired)||Math.abs(b.desired)<Math.abs(bb)-1e-9);
      return Number(bExit)-Number(aExit)||a.lastActionAt-b.lastActionAt;
    });
    let sent=0;const decisions:any[]=[];
    for(const p of sorted){
      if(!p.active&&p.inheritedMode&&!p.exitBarrier){
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
      if(live&&Math.abs(own)<1e-10&&p.stopCloid&&p.stopEpisode===p.episode&&!p.exitBarrier){
        p.stopBlockedEpisode=p.episode;p.desired=0;p.active=false;
        p.stopStatus='POSITION_FLAT_AFTER_STOP';
        this.log(s,p.coin,'FLAT_AFTER_PROTECTED_POSITION','Do not re-enter this source episode after stop/manual close');
      }
      // Protection-first: inspect account position and live stop before considering
      // new exposure. This block never prevents a later reduce-only close.
      const liveEntry=Number(ownDetail[p.coin]?.entry||0);
      const liveUnrealized=Number(ownDetail[p.coin]?.unrealized||0);
      if(live&&Math.abs(own)>1e-10&&!p.exitBarrier){
        if(!safetyAvailable){p.stopFault='SAFETY_CHECK_UNAVAILABLE';
          // Unable to attest an exchange stop: no new exposure until data return.
        }else{
          const protectedNow=await this.ensureStop(s,p,own,liveEntry,price,safetyOrders,now);
          if(!protectedNow&&p.exitBarrier){
            decisions.push({coin:p.coin,action:'SAFETY_EXIT_REQUIRED',reason:p.exitBarrierReason});
          }
        }
      }
      // Mandatory exchange-confirmed episode boundary. Do not collapse
      // SHORT->LONG->SHORT into a same-direction ADD in one source batch.
      if(p.exitBarrier){
        if(Math.abs(own)<=Math.pow(10,-decimals)*0.5){
          // In LIVE, own is from a fresh exchange snapshot / pending proof.
          // Retire all stops of old position episodes before allowing a new one.
          if(live){
            if(!safetyAvailable){decisions.push({coin:p.coin,action:'EXIT_WAIT_STOP_AUDIT'});continue;}
            const stale=[...new Set([...(p.stopCleanupCloids||[]),...(p.stopCloid?[p.stopCloid]:[])])];
            let cleanupOk=true;
            for(const old of stale){
              if(!safetyOrders.some(o=>String(o?.cloid||'').toLowerCase()===old.toLowerCase()))continue;
              try{if(!(await __LC_EXECUTION.cancelStopByCloid(this.env,p.coin,old)))cleanupOk=false;}
              catch(e){cleanupOk=false;p.stopFault='OLD_STOP_CANCEL_UNCERTAIN '+String(e);}
            }
            if(!cleanupOk){decisions.push({coin:p.coin,action:'EXIT_WAIT_STOP_CANCEL',reason:p.stopFault});continue;}
            p.stopCloid=undefined;p.stopCleanupCloids=[];p.stopStatus=undefined;p.stopPx=undefined;p.stopQty=undefined;
            p.exitBarrier=false;p.exitBarrierReason=undefined;p.exitBarrierAt=undefined;
            p.lastRejectedSignature=undefined;p.lastRejectedUntil=0;
            p.pendingReduceUsd=0;p.dustCloseBlockedQty=undefined;
            p.entryConfirmedQty=0;
            this.log(s,p.coin,'EPISODE_EXIT_CONFIRMED','flat on Hyperliquid; episode='+p.episode);
          }else{
            decisions.push({coin:p.coin,action:'DRY_RUN_EXIT_BARRIER',reason:p.exitBarrierReason});continue;
          }
        }else{
          const exitQty=trimQty(Math.abs(own),decimals);
          if(!(exitQty>0)){decisions.push({coin:p.coin,action:'EPISODE_EXIT_BELOW_PRECISION',own});continue;}
          if(sent>=MAX_ACTIONS){decisions.push({coin:p.coin,action:'EPISODE_EXIT_NEXT_TICK',own});continue;}
          // A full reduceOnly close does not need free margin to open a new trade.
          // An exchange minimum/dust rejection leaves this barrier in place:
          // NEVER issue a new ADD or entry on top of the old position.
          const exitDirection=own<0?'LONG':'SHORT';
          const exitSignature=[p.coin,'EPISODE_EXIT',own.toFixed(decimals)].join('|');
          if(live&&p.lastRejectedSignature===exitSignature&&Number(p.lastRejectedUntil||0)>now){
            decisions.push({coin:p.coin,action:'EPISODE_EXIT_RETRY_DEFERRED',own,reason:p.lastRejectReason,retry_at:p.lastRejectedUntil});continue;
          }
          decisions.push({coin:p.coin,action:'EPISODE_EXIT_REQUIRED',own,qty:exitQty,
            reason:p.exitBarrierReason,episode:p.episode,source_last_action:p.lastFillKind});
          if(!live)continue;
          const intentId=`V19:${s.startedAt}:${p.coin}:${++p.actionCount}`;
          p.pending={id:intentId,cloid:__LC_EXECUTION.cloidForIntent(intentId),status:'SUBMITTING',at:now,qty:exitQty,direction:exitDirection};
          await this.save(s);
          const exitResult=await __LC_EXECUTION.executeLiveIoc(this.env,{intentId,coin:p.coin,
            direction:exitDirection as 'LONG'|'SHORT',quantity:exitQty,reduceOnly:true,referencePrice:price});
          p.lastActionAt=now;sent++;
          if(exitResult.executed&&Number(exitResult.filledQty)>0){
            p.pending=undefined;p.lastConfirmedOwnQty=own+(exitDirection==='LONG'?1:-1)*Number(exitResult.filledQty);
            p.lastError='';p.lastRejectedSignature=undefined;p.lastRejectedUntil=0;
            s.orders++;this.log(s,p.coin,'EPISODE_EXIT_PARTIAL_OR_FILLED','filled_qty='+exitResult.filledQty+' await flat proof');
          }else if(exitResult.orderSent==='UNKNOWN'||exitResult.status==='UNEXPECTED_RESTING_ORDER'){
            p.pending!.status='UNKNOWN';p.lastError=exitResult.status;
            this.log(s,p.coin,'EPISODE_EXIT_UNCERTAIN',exitResult.status);
          }else{
            p.pending=undefined;
            const reason=String(exitResult.rejectReason||exitResult.status||'UNKNOWN').slice(0,230);
            p.lastError='EPISODE_EXIT_REJECTED: '+reason;
            p.lastRejectedSignature=exitSignature;p.lastRejectedUntil=Date.now()+REJECT_RETRY_REDUCE_MS;
            p.lastRejectReason=reason;
            this.log(s,p.coin,'EPISODE_EXIT_REJECTED',reason+'; no new ADD allowed');
          }
          await this.save(s);
          continue;
        }
      }
      if(p.sourceChainFault){decisions.push({coin:p.coin,action:'SOURCE_CHAIN_QUARANTINE',reason:'Wait for authoritative NEW/REVERSAL'});continue;}
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
      // Lack of available balance may skip new exposure, never risk-reducing exits.
      // When a stop has fired or an episode was risk-blocked, no re-entry until
      // a genuinely new SOURCE episode. Never top up the old losing trade.
      if(!reduce&&p.stopBlockedEpisode===p.episode){
        decisions.push({coin:p.coin,action:'RISK_EPISODE_BLOCKED',episode:p.episode});continue;
      }
      if(!reduce&&live&&Math.abs(own)>1e-10){
        if(!safetyAvailable||p.safetyFault||p.stopStatus!=='VERIFIED'||p.stopFault){
          decisions.push({coin:p.coin,action:'ADD_BLOCKED_STOP_UNVERIFIED',reason:p.stopFault||p.stopStatus||'UNKNOWN'});continue;
        }
        if(!canAddAtMark(own,liveEntry,price)||liveUnrealized<0){
          p.noAddLossCount=Number(p.noAddLossCount||0)+1;
          decisions.push({coin:p.coin,action:'ADD_BLOCKED_POSITION_LOSING',mark_price:price,entry_price:liveEntry,unrealized_pnl:liveUnrealized});
          continue;
        }
      }
      if(!reduce&&live&&(!safetyAvailable||!!p.safetyFault)){
        decisions.push({coin:p.coin,action:'NEW_BLOCKED_SAFETY_UNAVAILABLE'});continue;
      }
      if(!reduce&&p.entryBalanceBlockedEpisode===p.episode){
        decisions.push({coin:p.coin,action:'ENTRY_SKIPPED_INSUFFICIENT_BALANCE',episode:p.episode});continue;
      }
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
        // Fast-path protect a brand-new fill immediately. Await durable proof on
        // next poll; a failed placement triggers the episode exit barrier.
        if(!reduce){try{
          const protectedState=await this.ownDetailed();
          const current=protectedState[p.coin];
          if(current&&Math.sign(current.qty)===(direction==='LONG'?1:-1)){
            const orders=await postInfo({type:'frontendOpenOrders',user:this.env.HYPERLIQUID_MASTER_ACCOUNT});
            if(!Array.isArray(orders))throw Error('STOP_FAST_CHECK_INVALID');
            await this.ensureStop(s,p,current.qty,current.entry,price,orders,Date.now());
          }else{p.stopFault='POST_FILL_POSITION_NOT_CONFIRMED';p.exitBarrier=true;p.exitBarrierReason='POST_FILL_POSITION_UNKNOWN';}
        }catch(e){p.stopFault='STOP_FAST_PATH_FAILED '+String(e);p.exitBarrier=true;p.exitBarrierReason='STOP_FAST_PATH_FAILED';
          p.exitBarrierAt=Date.now();p.desired=0;p.active=false;p.stopBlockedEpisode=p.episode;
          this.log(s,p.coin,'STOP_FAST_PATH_FAILED',String(e));}}

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
        // A refused NEW/REVERSAL due to insufficient buying power is NOT a
        // filled trade, and must not be retried hours later as a delayed ADD.
        // Keep this one source episode skipped; a later independent NEW/REVERSAL
        // resets the episode ID and may enter normally.
        if(!reduce&&/insufficient|margin|buying power|balance/i.test(detailed)){
          p.entryBalanceBlockedEpisode=p.episode;
          p.entryStatus='INSUFFICIENT_MARGIN_SKIP_EPISODE';
          this.log(s,p.coin,'ENTRY_BALANCE_BLOCKED','episode='+p.episode+'; '+detailed);
        }
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
      if(cooldown>now)return J({ok:true,version:'V19_16_FULL_TRADE_LIVE_CANDIDATE',processed,
        cursor:s.cursor,events:s.events,exchange_deferred:true,
        reason:'INFO_RATE_LIMIT_BACKOFF',retry_after:cooldown,real_orders_sent:0});
      const last=Number(await this.state.storage.get('live_copy_v19_last_reconcile')||0);
      const interval=processed>0?INFO_RECONCILE_MIN_MS:INFO_RECONCILE_IDLE_MS;
      if(now-last<interval)return J({ok:true,version:'V19_16_FULL_TRADE_LIVE_CANDIDATE',processed,
        cursor:s.cursor,events:s.events,exchange_deferred:true,
        reason:'INFO_POLL_COALESCING',next_check_at:last+interval,real_orders_sent:0});
      // Reserve the INFO polling slot before sending requests. A WebSocket
      // burst cannot trigger dozens of overlapping/excessive reconciliations.
      await this.state.storage.put('live_copy_v19_last_reconcile',now);
      try{
        const result=await this.reconcile(s);s.lastDecisions=(result.decisions||[]).map((d:any)=>({
          ...d,at:Number(s!.coins[d.coin]?.lastActionAt||s!.coins[d.coin]?.lastFillAt||Date.now()),
          active:s!.coins[d.coin]?.active===true
        })).sort((a:any,b:any)=>Number(b.at)-Number(a.at));
        // Successful INFO read resets previous API error display and cooldown.
        s.cooldownUntil=0;
        s.errors=(s.errors||[]).filter(e=>!String(e).includes('INFO_HTTP_429'));
        await this.save(s);
        return J({ok:true,version:'V19_16_FULL_TRADE_LIVE_CANDIDATE',processed,cursor:s.cursor,
          events:s.events,live:this.authorized(s),...result});
      }catch(e){
        const rateLimited=/429|RATE_LIMIT|TOO_MANY_REQUESTS/i.test(String(e));
        if(rateLimited){
          s.cooldownUntil=Date.now()+INFO_BACKOFF_MS;
          // Keep just one rate-limit message; status exposes retry_after.
          s.errors=(s.errors||[]).filter(x=>!String(x).includes('INFO_HTTP_429'));
          s.errors.unshift('INFO_HTTP_429 · automatic INFO requests paused');
          await this.save(s);
          return J({ok:true,version:'V19_16_FULL_TRADE_LIVE_CANDIDATE',processed,cursor:s.cursor,
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

  /* V19.16 FULL TRADE LIVE -- isolated state, same existing Durable Object. */
  private ftWs:WebSocket|null=null;
  private ftWsReady=false;
  private ftQueue:Promise<void>=Promise.resolve();
  private ftEnqueue<T>(fn:()=>Promise<T>):Promise<T>{
    const job=this.ftQueue.then(fn);
    this.ftQueue=job.then(()=>{},()=>{});
    return job;
  }
  private async ltLoad():Promise<FTState>{return (await this.state.storage.get(FT_KEY) as FTState)||ftDefault();}
  private async ltSave(t:FTState){await this.state.storage.put(FT_KEY,t);}
  private ltLog(t:FTState,event:string,detail:string,coin?:string){t.history.unshift({at:Date.now(),coin:coin||t.coin||'—',event,detail});t.history=t.history.slice(0,160);}
  private async ltFlat(){
    const [account,orders]=await Promise.all([__LC_EXECUTION.readLiveAccount(this.env),postInfo({type:'frontendOpenOrders',user:this.env.HYPERLIQUID_MASTER_ACCOUNT})]);
    if(!Array.isArray(orders))throw Error('FULL_TRADE_ORDER_READ_INVALID');
    return {account,orders,flat:!account.positions.length&&!orders.length};
  }
  private async ftConnect():Promise<boolean>{
    if(this.ftWs?.readyState===1&&this.ftWsReady)return true;
    if(this.ftWs?.readyState===0)return false;
    const ws=new WebSocket('wss://api.hyperliquid.xyz/ws');this.ftWs=ws;this.ftWsReady=false;
    ws.addEventListener('open',()=>{
      if(this.ftWs!==ws)return;
      ws.send(JSON.stringify({method:'subscribe',subscription:{type:'userFills',user:LIMIT_TEST_SOURCE,aggregateByTime:false}}));
      ws.send(JSON.stringify({method:'subscribe',subscription:{type:'userFills',user:this.env.HYPERLIQUID_MASTER_ACCOUNT,aggregateByTime:false}}));
    });
    ws.addEventListener('message',(event:MessageEvent)=>{
      if(this.ftWs!==ws)return;
      try{const msg=JSON.parse(String(event.data));
        if(msg?.channel==='subscriptionResponse'&&msg?.data?.subscription?.type==='userFills'&&
          String(msg.data.subscription.user||'').toLowerCase()===LIMIT_TEST_SOURCE.toLowerCase()){
          this.ftWsReady=true;
          void this.ftWsAck();return;
        }
        if(msg?.channel==='userFills'&&Array.isArray(msg.data?.fills)){
          const user=String(msg.data.user||'').toLowerCase();
          if(user===LIMIT_TEST_SOURCE.toLowerCase()){
            // Snapshots since START are deduplicated; never trade on old fills.
            const task=this.ftEnqueue(()=>this.ftProcessFills(msg.data.fills,msg.data.isSnapshot===true))
              .then(()=>this.ftSync()).catch(e=>this.ftFatal('WS_FILL_PROCESS_FAILED '+String(e)));
            this.state.waitUntil?.(task);
          }else if(user===String(this.env.HYPERLIQUID_MASTER_ACCOUNT||'').toLowerCase()&&!msg.data.isSnapshot){
            const task=this.ftSync().catch(e=>this.ftFatal('OWN_FILL_RECONCILIATION '+String(e)));
            this.state.waitUntil?.(task);
          }
        }
      }catch(e){void this.ftFatal('WS_MESSAGE_INVALID '+String(e));}
    });
    const lost=()=>{if(this.ftWs!==ws)return;this.ftWsReady=false;void this.ftDisconnect();};
    ws.addEventListener('close',lost);ws.addEventListener('error',lost);
    return false;
  }
  private async ftWsAck(){const t=await this.ltLoad();if(t.active){t.wsReadyAt=Date.now();t.wsDisconnectedAt=0;this.ltLog(t,'WS_CONNECTED','Hyperliquid userFills subscription acknowledged');await this.ltSave(t);await this.ftSync();}}
  private async ftDisconnect(){const t=await this.ltLoad();if(!t.started)return;t.wsDisconnectedAt=Date.now();this.ltLog(t,'WS_DISCONNECTED','New entries blocked; position monitored for safe exit');await this.ltSave(t);await this.state.storage.setAlarm(Date.now()+1000);}
  private async ftFatal(reason:string){const t=await this.ltLoad();t.halted=true;t.active=false;t.reason='SAFETY_HALT';t.errors.unshift(reason);this.ltLog(t,'SAFETY_HALT',reason);await this.ltSave(t);await this.state.storage.setAlarm(Date.now()+1000);}
  private async ftProcessFills(raw:any[],isSnapshot:boolean){
    const t=await this.ltLoad();if(!t.started)return;
    const evs=raw.map(classifySourceFullTrade).filter((v:FullTradeEvent|null):v is FullTradeEvent=>v!==null)
      .sort((a:FullTradeEvent,b:FullTradeEvent)=>a.at-b.at||a.fillId.localeCompare(b.fillId));
    for(const e of evs){
      if(e.at<t.started||t.seen.includes(e.fillId))continue;
      t.seen.push(e.fillId);if(t.seen.length>1000)t.seen.shift();
      t.lastFillAt=Math.max(t.lastFillAt,e.at);
      this.ltLog(t,'SOURCE_'+e.action,`${e.before} => ${e.after} · $${e.price} · ${isSnapshot?'snapshot':'stream'}`,e.coin);
      if(t.ignoredCoins.includes(e.coin)){
        if(Math.abs(e.after)<1e-10)t.ignoredCoins=t.ignoredCoins.filter(c=>c!==e.coin);
        continue;
      }
      if(!t.active){continue;}
      if(t.coin&&t.coin!==e.coin){
        if(Math.abs(e.after)>1e-10){t.active=false;t.reason='SOURCE_MULTI_COIN_IGNORED';this.ltLog(t,'SOURCE_OTHER_COIN_IGNORED',e.coin,e.coin);}
        continue;
      }
      if(!t.coin){
        if(Math.abs(e.before)>1e-10||Math.abs(e.after)<1e-10)continue;
        if(Date.now()-e.at>1500){t.missed++;this.ltLog(t,'SOURCE_ENTRY_STALE','Entry skipped; older than 1.5 seconds',e.coin);t.ignoredCoins.push(e.coin);continue;}
        t.coin=e.coin;t.scale=LIMIT_TEST_NOTIONAL/(Math.abs(e.after)*e.price);
        t.episode++;t.episodeAt=e.at;t.target=0;t.lastActionAt=0;
      }
      if(t.coin===e.coin){
        if(t.exitBarrier){
          // Source reopened while our prior position was still closing.
          // Skip the new episode rather than conflate two positions.
          t.target=0;t.lastActionAt=e.at;
          this.ltLog(t,'EPISODE_BARRIER','New source fill ignored until own position confirmed flat');
          continue;
        }
        if(t.pendingReversal){
          // Follow only the latest new-side source quantity; never mix old
          // episode scaling into the new one while our old position remains.
          if(Math.abs(e.after)<1e-10)t.pendingReversal=undefined;
          else t.pendingReversal={qty:e.after,px:e.price,at:e.at};
          t.target=0;t.lastActionAt=e.at;continue;
        }
        if(e.action.startsWith('REVERSAL_')){
          // Reversal: close existing own exposure first. New episode may be
          // missed if source is already gone; never cross directly in one order.
          t.target=0;t.pendingReversal={qty:e.after,px:e.price,at:e.at};
        }else{
          t.sourceQty=e.after;
          t.target=Math.abs(e.after)<1e-10?0:e.after*t.scale;
          if(t.target===0)t.exitBarrier=true;
        }
        t.lastActionAt=e.at;
      }
    }
    await this.ltSave(t);
  }
  private async ltStart(body:any):Promise<Response>{
    if(body?.confirm!=='START_FULL_TRADE_LIVE_10_TRADES')return J({ok:false,error:'FULL_TRADE_EXPLICIT_CONFIRM_REQUIRED'},409);
    if(this.env.LIMIT_TEST_TRADING_ENABLED!=='true'||!this.liveConfigured())return J({ok:false,error:'FULL_TRADE_FLAGS_MISSING'},409);
    if(!this.env.HYPERLIQUID_API_PRIVATE_KEY||!this.env.HYPERLIQUID_MASTER_ACCOUNT)return J({ok:false,error:'FULL_TRADE_CREDENTIALS_MISSING'},409);
    if(!/^0x[0-9a-fA-F]{64}$/.test(__LC_EXECUTION.normalizeKey(this.env.HYPERLIQUID_API_PRIVATE_KEY)))
      return J({ok:false,error:'FULL_TRADE_API_KEY_INVALID_FORMAT'},409);
    if(LIMIT_TEST_SOURCE.toLowerCase()===this.env.HYPERLIQUID_MASTER_ACCOUNT.toLowerCase())return J({ok:false,error:'SOURCE_CANNOT_BE_OWN_ACCOUNT'},409);
    const old=await this.load();if(old.mode==='RUNNING')return J({ok:false,error:'STOP_OLD_COPY_FIRST'},409);
    const prev=await this.ltLoad();if(prev.active||prev.order||prev.halted||prev.coin)return J({ok:false,error:'FULL_TRADE_PREVIOUS_UNRESOLVED'},409);
    const {flat,account,orders}=await this.ltFlat();if(!flat)return J({ok:false,error:'FULL_TRADE_ACCOUNT_NOT_FLAT',positions:account.positions,openOrders:orders},409);
    // Unified account: perp accountValue can be 0 even with usable spot USDC collateral.
    // Do not reject START based on perp accountValue; exchange enforces margin on order placement.
    const source=await postInfo({type:'clearinghouseState',user:LIMIT_TEST_SOURCE});
    if(!Array.isArray(source?.assetPositions))throw Error('FULL_TRADE_SOURCE_INVALID');
    const now=Date.now(),t=ftDefault();t.started=now;t.active=true;t.reason='CONNECTING';
    t.ignoredCoins=source.assetPositions.filter((x:any)=>Math.abs(Number(x?.position?.szi||0))>0).map((x:any)=>String(x.position.coin));
    this.ltLog(t,'START','Awaiting confirmed Hyperliquid userFills WebSocket; 10 full-trade episodes; max $31.20 exposure');
    await this.ltSave(t);await this.ftConnect();await this.state.storage.setAlarm(now+1000);
    return J({ok:true,mode:'FULL_TRADE_STARTING',source:LIMIT_TEST_SOURCE,waiting_for_ws_ack:true,
      maximum_completed:10,warning:'No trade until source userFills subscription is acknowledged; post-only orders may not fill.'});
  }
  private async ltStop():Promise<Response>{
    const t=await this.ltLoad();t.active=false;t.target=0;t.reason='USER_STOP_CLOSE_REQUIRED';
    this.ltLog(t,'USER_STOP','No more entries; live exposure will be reconciled and reduced');await this.ltSave(t);
    await this.state.storage.setAlarm(Date.now()+1000);
    return J({ok:true,entry_stopped:true,positions_may_remain:true,requires_flat_verification:true});
  }
  private async ltStatus():Promise<Response>{
    const t=await this.ltLoad();let statistics:any={};
    if(t.started){try{
      const f=await postInfo({type:'userFillsByTime',user:this.env.HYPERLIQUID_MASTER_ACCOUNT,startTime:t.started,aggregateByTime:false});
      const fills=(Array.isArray(f)?f:[]).filter((x:any)=>Number(x.time)>=t.started);
      const fee=fills.reduce((a:number,x:any)=>a+Number(x.fee||0),0);
      const pnl=fills.reduce((a:number,x:any)=>a+Number(x.closedPnl||0),0);
      statistics={fills:fills.length,total_fees_usd:fee,realized_gross_usd:pnl,realized_net_ex_funding_usd:pnl-fee,
        maker_fills:fills.filter((x:any)=>x.crossed===false).length,taker_fills:fills.filter((x:any)=>x.crossed===true).length,
        caveat:'All account fills since START; keep old bot stopped and account dedicated to this test. Funding excluded.'};
    }catch(e){statistics={error:String(e)};}}
    let fullTradeAudit:any={};try{
      const raw=await postInfo({type:'userFillsByTime',user:LIMIT_TEST_SOURCE,startTime:Date.now()-900000,aggregateByTime:false});
      const events=(Array.isArray(raw)?raw:[]).map(classifySourceFullTrade).filter(Boolean)
        .sort((a:any,b:any)=>b.at-a.at).slice(0,100);
      fullTradeAudit={mode:'SOURCE_FILLS',events,observed_events:events.length};
    }catch(e){fullTradeAudit={error:String(e)};}
    return J({ok:true,version:'V19_16_FULL_TRADE_LIVE_CANDIDATE',source:LIMIT_TEST_SOURCE,
      trade_scope:'LONG_SHORT_ADD_PARTIAL_CLOSE_CLOSE_REVERSAL',live_start_available:true,
      websocket_connected:this.ftWsReady&&this.ftWs?.readyState===1,statistics,fullTradeAudit,...t});
  }
  private async ftEnsureProtection(t:FTState,qty:number,entry:number,orders:any[]):Promise<boolean>{
    if(!qty){return true;}
    if(!(entry>0)){await this.ftFatal('PROTECTION_ENTRY_PRICE_UNKNOWN');return false;}
    const old=t.stop;
    const existing=old&&orders.find((x:any)=>String(x.cloid||'').toLowerCase()===old.cloid.toLowerCase());
    if(old?.status==='RESTING'&&!existing&&Math.abs(Number(old.qty)-Math.abs(qty))<1e-10){
      await this.ftFatal('PROTECTIVE_STOP_DISAPPEARED_CHECK_EXCHANGE');return false;
    }
    if(existing&&Math.abs(Number(old!.qty)-Math.abs(qty))<1e-10)return true;
    // Native reduce-only stop before proceeding with further exposure.
    const price=qty>0?entry*0.975:entry*1.025;
    const cloidId=`FT:STOP:${t.started}:${t.episode}:${t.coin}:${++t.seq}`;
    const cloid=__LC_EXECUTION.cloidForIntent(cloidId);
    t.stop={cloid,qty:Math.abs(qty),at:Date.now(),status:'SUBMITTING'};await this.ltSave(t);
    const placed=await __LC_EXECUTION.placeStopMarket(this.env,cloidId,t.coin,qty,price);
    if(!placed.ok){await this.ftFatal('NATIVE_STOP_NOT_CONFIRMED '+placed.status+' '+String(placed.reason||''));return false;}
    t.stop={cloid,qty:Math.abs(qty),at:Date.now(),status:'RESTING'};
    this.ltLog(t,'STOP_INSTALLED',`${qty} @ ${price.toFixed(8)}`);await this.ltSave(t);
    if(old){try{const ok=await __LC_EXECUTION.cancelStopByCloid(this.env,t.coin,old.cloid);
      if(!ok){await this.ftFatal('OLD_STOP_CANCEL_NOT_CONFIRMED');return false;}}
      catch(e){await this.ftFatal('OLD_STOP_CANCEL_UNKNOWN '+String(e));return false;}}
    return true;
  }
  private async ftOrderStatus(t:FTState,ownQty:number):Promise<boolean>{
    if(!t.order)return true;
    const p=t.order,now=Date.now(),master=this.env.HYPERLIQUID_MASTER_ACCOUNT||'';
    let status:any;try{status=await postInfo({type:'orderStatus',user:master,oid:p.cloid});}
    catch(e){await this.ftFatal('ORDER_STATUS_READ_FAILED '+String(e));return false;}
    const v=String(status?.order?.status||'').toLowerCase();
    if(status?.status!=='order'||!status?.order?.order){await this.ftFatal('UNKNOWN_ORDER_STATUS '+p.cloid);return false;}
    const open=v==='open';
    if(open){
      const ttl=p.reduceOnly?650:850;
      if(p.state==='CANCELING'){
        if(now-p.at>2200)await this.ftFatal('CANCEL_CONFIRMATION_TIMEOUT '+p.cloid);
        return false;
      }
      if(now-p.at>ttl||!t.active||t.target===0){
        p.state='CANCELING';await this.ltSave(t);
        try{await __LC_EXECUTION.cancelMakerTest(this.env,p.coin,p.cloid);this.ltLog(t,'MAKER_CANCEL_SENT',p.cloid);}
        catch(e){await this.ftFatal('CANCEL_OUTCOME_UNKNOWN '+String(e));}
      }
      return false;
    }
    // Status known terminal; reconcile the actual position on next loop.
    this.ltLog(t,'ORDER_RESOLVED',p.cloid+' '+v);t.order=undefined;t.lastOrderResolvedAt=now;
    await this.ltSave(t);return false;
  }
  private ftSync():Promise<Response>{return this.ftEnqueue(()=>this.ftSyncCore());}
  private async ftEmergencyClose(t:FTState,qty:number,reason:string):Promise<Response>{
    if(t.emergencyIntent)return J({ok:false,error:'EMERGENCY_ALREADY_USED_REQUIRES_RECONCILIATION'},503);
    if(!t.coin||!qty)return J({ok:true,flat:true});
    const id='FT:SAFE_CLOSE:'+t.started+':'+t.episode+':'+t.coin+':'+(++t.seq);
    t.emergencyIntent=id;t.halted=true;t.active=false;t.target=0;t.reason=reason;
    this.ltLog(t,'EMERGENCY_CLOSE_REQUEST',reason+' qty='+qty);await this.ltSave(t);
    try{
      const mids=await postInfo({type:'allMids'}),price=Number(mids?.[t.coin]);
      if(!(price>0))throw Error('EMERGENCY_PRICE_MISSING');
      const result=await __LC_EXECUTION.executeLiveIoc(this.env,{intentId:id,coin:t.coin,
        direction:qty<0?'LONG':'SHORT',quantity:Math.abs(qty),reduceOnly:true,referencePrice:price});
      this.ltLog(t,'EMERGENCY_CLOSE_RESULT',result.status+' filled='+String(result.filledQty||0));
      await this.ltSave(t);
      if(result.orderSent==='UNKNOWN'||!result.executed){await this.ftFatal('EMERGENCY_NOT_CONFIRMED '+result.status);return J({ok:false,error:'EMERGENCY_NOT_CONFIRMED'},503);}
      return J({ok:true,emergency_reduce_only:true,status:result.status});
    }catch(e){await this.ftFatal('EMERGENCY_UNCERTAIN '+String(e));return J({ok:false,error:'EMERGENCY_UNCERTAIN',detail:String(e)},503);}
  }
  private async ftSyncCore():Promise<Response>{
    if(this.busy)return J({ok:true,deferred:'BUSY'});
    this.busy=true;let t=await this.ltLoad();
    try{
      if(!t.started)return J({ok:true,idle:true});
      const now=Date.now();
      const snapshot=await this.ltFlat(),actual=snapshot.account.positions;
      if(actual.length>1||actual.some((p:any)=>t.coin&&p.coin!==t.coin)||(!t.coin&&actual.length)){
        await this.ftFatal('UNEXPECTED_ACCOUNT_POSITION');return J({ok:false,error:'UNEXPECTED_ACCOUNT_POSITION'},503);
      }
      const pos=actual[0],qty=Number(pos?.qty||0);
      if(t.stop?.status==='SUBMITTING'){
        const present=snapshot.orders.find((o:any)=>String(o.cloid||'').toLowerCase()===t.stop!.cloid.toLowerCase());
        if(!present){await this.ftFatal('STOP_SUBMIT_OUTCOME_UNKNOWN');return J({ok:false,error:'STOP_SUBMIT_OUTCOME_UNKNOWN'},503);}
        t.stop.status='RESTING';await this.ltSave(t);
      }
      if(qty){t.hadExposure=true;await this.ltSave(t);
        if(!await this.ftEnsureProtection(t,qty,Number(pos.entry||0),snapshot.orders))
          return this.ftEmergencyClose(t,qty,'NATIVE_STOP_NOT_CONFIRMED');
      }
      if(t.order){await this.ftOrderStatus(t,qty);return J({ok:true,pending:t.order?.cloid||'resolved'});}
      if(!qty&&t.stop){
        if(t.hadExposure&&t.target!==0){t.target=0;t.active=false;t.reason='FLAT_AFTER_PROTECTED_POSITION';
          this.ltLog(t,'FLAT_AFTER_PROTECTION','Do not re-enter the same episode after exchange flattened position');await this.ltSave(t);}
        // Own position is flat; remove our protective order before re-entry.
        const exists=snapshot.orders.some((o:any)=>String(o.cloid||'').toLowerCase()===t.stop!.cloid.toLowerCase());
        if(exists){const old=t.stop.cloid;
          try{const ok=await __LC_EXECUTION.cancelStopByCloid(this.env,t.coin,old);if(!ok)throw Error('STOP_CANCEL_NOT_CONFIRMED');}
          catch(e){await this.ftFatal('FLAT_STOP_CLEANUP_FAILED '+String(e));return J({ok:false,error:'STOP_CLEANUP_FAILED'},503);}
          t.stop=undefined;await this.ltSave(t);return J({ok:true,stop_cleanup_requested:true});
        }
        t.stop=undefined;await this.ltSave(t);
      }
      if(t.halted){
        if(!qty&&!t.order&&!t.stop){t.coin='';await this.ltSave(t);try{this.ftWs?.close(1000,'halted');}catch{}this.ftWs=null;this.ftWsReady=false;}
        return J({ok:false,error:'SAFETY_HALTED',manual_exchange_check_required:!!qty},409);
      }
      const staleWs=!this.ftWsReady||this.ftWs?.readyState!==1||!t.wsReadyAt;
      const connecting=staleWs&&now-t.started<5500&&!t.wsDisconnectedAt;
      if(connecting)return J({ok:true,awaiting_websocket_subscription:true});
      if(staleWs&&t.active){t.active=false;t.target=0;t.reason='WEBSOCKET_DISCONNECTED';this.ltLog(t,'WS_UNAVAILABLE','Stop new entries and reduce live exposure');await this.ltSave(t);}
      if(qty&&now-t.episodeAt>LIMIT_TEST_MAX_HOLD_MS){t.target=0;t.active=false;t.reason='MAX_HOLD';await this.ltSave(t);}
      // A closed/reversed source first requires a verified flat account.
      if(t.pendingReversal&&Math.abs(qty)<1e-10){
        if(t.hadExposure){t.completed++;t.hadExposure=false;this.ltLog(t,'REVERSAL_OLD_EPISODE_CLOSED','completed='+t.completed);}
        t.exitMakerAttemptAt=0;t.emergencyIntent=undefined;
        if(now-t.pendingReversal.at<1200&&t.active&&t.completed<10){
          const rev=t.pendingReversal;t.sourceQty=rev.qty;t.scale=LIMIT_TEST_NOTIONAL/(Math.abs(rev.qty)*rev.px);
          t.target=rev.qty*t.scale;t.episode++;t.episodeAt=rev.at;
        }else{t.target=0;t.missed++;t.sourceQty=0;t.coin='';}
        t.pendingReversal=undefined;await this.ltSave(t);
      }
      const target=t.active?t.target:0;
      if(Math.abs(qty)<1e-10&&Math.abs(target)<1e-10){
        if(t.coin){
          t.completed+=t.hadExposure?1:0;t.missed+=t.hadExposure?0:1;
          this.ltLog(t,'EPISODE_DONE',`completed=${t.completed}, missed=${t.missed}`);
          t.coin='';t.sourceQty=0;t.target=0;t.scale=0;t.hadExposure=false;t.episodeAt=0;t.exitMakerAttemptAt=0;t.emergencyIntent=undefined;t.exitBarrier=false;
          if(t.completed>=10){t.active=false;t.reason='TEN_CLOSED_TRADES';}
          await this.ltSave(t);
        }
        return J({ok:true,flat:true,completed:t.completed});
      }
      const sign=(x:number)=>x>1e-10?1:x<-1e-10?-1:0;
      const reduce=qty!==0&&(target===0||sign(target)!==sign(qty)||Math.abs(target)<Math.abs(qty)-1e-10);
      const delta=reduce?-Math.sign(qty)*Math.min(Math.abs(qty),sign(qty)===sign(target)?Math.abs(qty)-Math.abs(target):Math.abs(qty)):target-qty;
      if(!Number.isFinite(delta)||Math.abs(delta)<1e-10){
        if(t.exitMakerAttemptAt||t.emergencyIntent){t.exitMakerAttemptAt=0;t.emergencyIntent=undefined;await this.ltSave(t);}
        return J({ok:true,in_sync:true});
      }
      if(!reduce){
        if(!t.active||now-t.lastActionAt>1500||staleWs)return J({ok:true,entry_not_sent:'STALE_OR_STOPPED'});
        if(t.lastEntryAttemptAt===t.lastActionAt)return J({ok:true,entry_not_sent:'ALREADY_ATTEMPTED_THIS_FILL'});
        t.lastEntryAttemptAt=t.lastActionAt;
      }
      const ref=Number((await postInfo({type:'allMids'}))?.[t.coin]);
      if(!(ref>0))throw Error('PRICE_NOT_AVAILABLE');
      // Do not repeatedly leave a close order resting while source is already flat.
      // After a canceled maker exit, use one reduce-only IOC fallback with an
      // intentionally durable ID. An unknown outcome ALWAYS halts for reconciliation.
      if(reduce&&t.exitMakerAttemptAt>0&&now-t.exitMakerAttemptAt>=650){
        if(t.emergencyIntent){await this.ftFatal('EMERGENCY_INTENT_ALREADY_USED_UNCERTAIN');return J({ok:false,error:'EMERGENCY_INTENT_UNCERTAIN'},503);}
        const id='FT:EMERGENCY:'+t.started+':'+t.episode+':'+t.coin+':'+(++t.seq);
        t.emergencyIntent=id;await this.ltSave(t);
        const result=await __LC_EXECUTION.executeLiveIoc(this.env,{intentId:id,coin:t.coin,
          direction:delta>0?'LONG':'SHORT',quantity:Math.abs(delta),reduceOnly:true,referencePrice:ref});
        this.ltLog(t,'EMERGENCY_REDUCE',String(result.status)+' qty='+String(result.filledQty||0));
        if(result.orderSent==='UNKNOWN'||!result.executed){await this.ftFatal('EMERGENCY_EXIT_NOT_CONFIRMED '+String(result.status));return J({ok:false,error:'EMERGENCY_EXIT_NOT_CONFIRMED'},503);}
        // Never send an additional IOC in this episode without exchange check.
        await this.ltSave(t);return J({ok:true,emergency_exit_submitted:true,status:result.status});
      }
      if(reduce&&t.exitMakerAttemptAt===0){t.exitMakerAttemptAt=now;await this.ltSave(t);}
      if(!reduce&&Math.abs(delta*ref)<10)return J({ok:true,entry_not_sent:'BELOW_EXCHANGE_MINIMUM'});
      const intentId=`FT:${reduce?'REDUCE':'OPEN'}:${t.started}:${t.episode}:${t.coin}:${++t.seq}`;
      const cloid=__LC_EXECUTION.cloidForIntent(intentId);
      const dir=delta>0?'LONG':'SHORT';
      t.order={cloid,coin:t.coin,at:now,qty:Math.abs(delta),reduceOnly:reduce,state:'SUBMITTING'};
      await this.ltSave(t); // durable before any exchange mutation, prevents duplicate order retry
      try{
        const r=await __LC_EXECUTION.makerFullTradeOrder(this.env,t.coin,Math.abs(delta),dir,reduce,intentId);
        t.order={...t.order,cloid:r.cloid,qty:r.qty,state:'OPEN'};
        this.ltLog(t,reduce?'MAKER_REDUCE':'MAKER_OPEN',`${dir} ${r.qty} @ ${r.price}, ${r.responseStatus}`);
        await this.ltSave(t);await this.state.storage.setAlarm(Date.now()+700);
        return J({ok:true,order_submitted:true,cloid:r.cloid});
      }catch(e){
        // UNKNOWN after submission requires explicit exchange reconciliation.
        const msg=String(e);await this.ftFatal('MAKER_SEND_OR_ACK_UNCERTAIN '+msg);
        return J({ok:false,error:'MAKER_UNCERTAIN',detail:msg},503);
      }
    }catch(e){await this.ftFatal('SYNC_FAILED '+String(e));return J({ok:false,error:'FULL_TRADE_SAFETY_HALT',detail:String(e)},503);}
    finally{this.busy=false;}
  }

  async alarm():Promise<void>{const lt=await this.ltLoad();if(lt.started&&(lt.active||lt.order||lt.coin||lt.stop)){
    if(lt.active&&(!this.ftWs||this.ftWs.readyState>1))await this.ftConnect();
    await this.ftSync();const next=await this.ltLoad();
    if(next.started&&(next.active||next.order||next.coin||next.stop))await this.state.storage.setAlarm(Date.now()+(next.halted?5000:1000));
    return;
  }const s=await this.load();if(s.mode!=='RUNNING')return;
    await this.sync();const current=await this.load();if(current.mode==='RUNNING')await this.state.storage.setAlarm(Math.max(Date.now()+5000,(current.cooldownUntil||0)+1000));}
  async fetch(req:Request):Promise<Response>{
    if(!this.env.LIVE_COPY_ADMIN_TOKEN||req.headers.get('authorization')!=='Bearer '+this.env.LIVE_COPY_ADMIN_TOKEN)return J({ok:false,error:'UNAUTHORIZED'},401);
    const path=new URL(req.url).pathname;const method=req.method;
    if(method==='POST'&&path==='/limit-test/start')return this.ltStart(await req.json().catch(()=>({})));
    if(method==='POST'&&path==='/limit-test/stop')return this.ltStop();
    if(method==='POST'&&path==='/limit-test/sync')return this.ftSync();
    if(method==='GET'&&path==='/limit-test/status')return this.ltStatus();
    if(method==='POST'&&path==='/start'){const lt=await this.ltLoad();if(lt.active||lt.order||lt.coin||lt.halted)return J({ok:false,error:'LIMIT_TEST_MUST_BE_FLAT_AND_STOPPED'},409);return this.start(await req.json().catch(()=>({})));}
    if(method==='POST'&&path==='/stop'){const lt=await this.ltLoad();if(lt.active||lt.order||lt.coin)return J({ok:false,error:'USE_LIMIT_TEST_STOP'},409);const s=await this.load();s.mode='STOPPED';s.stoppedReason='STOP';await this.save(s);await this.state.storage.deleteAlarm?.();this.arm=null;await this.state.storage.put('live_copy_v19_arm',null);return J({ok:true,mode:'STOPPED',positions_untouched:true});}
    if(method==='POST'&&path==='/close-all'){const lt=await this.ltLoad();if(lt.active||lt.order||lt.coin)return J({ok:false,error:'LIMIT_TEST_ACTIVE_USE_LIMIT_STOP_AND_MANUAL_EXCHANGE_CHECK'},409);return this.closeAll();}
    if(method==='POST'&&['/sync','/order-sync'].includes(path))return this.sync();
    if(method==='GET'&&['/status','/v19-status','/order-follow-status'].includes(path)){
      const s=await this.load();const latest=await this.latest().catch(()=>null);const d1Diagnostic=await this.state.storage.get('live_copy_v19_d1_diagnostic')||null;const coins=Object.values(s.coins).map(p=>({coin:p.coin,source_qty:p.sourceQty,desired_qty:p.desired,scale:p.scale,active:p.active,waiting_flat:p.waitingFlat,entry_pending:p.entryPending===true,last_fill_kind:p.lastFillKind||null,
        exit_barrier:p.exitBarrier===true,exit_barrier_reason:p.exitBarrierReason||null,
        source_chain_fault:p.sourceChainFault===true,
        stop_status:p.stopStatus||null,stop_cloid:p.stopCloid||null,stop_trigger:p.stopPx||null,
        stop_qty:p.stopQty||0,stop_fault:p.stopFault||null,stop_checked_at:p.stopCheckedAt||null,
        safety_source_fault:p.safetyFault||null,safety_checked_at:p.safetyCheckAt||null,
        add_blocked_losing_count:p.noAddLossCount||0,
        entry_balance_blocked:p.entryBalanceBlockedEpisode===p.episode,
        last_price:p.lastPx,last_fill_at:p.lastFillAt,updated_at:p.lastActionAt,error:p.lastError,pending:p.pending?.status||null,episode:p.episode,inherited_mode:p.inheritedMode===true,inherited_pending_add_usd:Number(p.inheritedPendingUsd||0),
          pending_reduce_usd:Number(p.pendingReduceUsd||0),reduce_state:p.reduceState||null,
          dust_close_alert:p.dustCloseReason||null,entry_kind:p.lastFillKind||null,entry_confirmed:p.entryStatus==='COMPLETE',entry_status:p.entryStatus||null,entry_target_qty:p.entryTargetQty||0,entry_confirmed_qty:p.entryConfirmedQty||0,entry_remaining_usd:Number(p.entryRemainingUsd||0),rejection_retry_until:p.lastRejectedUntil||0,last_reject_reason:p.lastRejectReason||null}));
      return J({ok:true,version:'V19_16_FULL_TRADE_LIVE_CANDIDATE',mode:s.mode,session_kind:s.live?'LIVE':'DRY_RUN',live_execution:s.mode==='RUNNING'&&s.live&&this.liveConfigured(),
        cursor:s.cursor,latest_fill_row:latest?.rowid||0,lag_rows:latest?Math.max(0,latest.rowid-s.cursor):null,d1_diagnostic:d1Diagnostic,processed_fills:s.events,orders_sent_and_filled:s.orders,
        skipped:s.skipped,syncs:s.syncs,last_sync:s.lastSync,minimum_notional_usd:MIN,max_position_notional_usd:MAX_POSITION_USD,max_position_margin_at_10x_usd:MAX_POSITION_USD/10,stop_loss_roe_pct:25,no_add_to_losing:true,safety_source_audit_interval_ms:SAFETY_AUDIT_INTERVAL_MS,api_backoff_until:s.cooldownUntil||0,api_backoff_seconds:Math.max(0,Math.ceil(((s.cooldownUntil||0)-Date.now())/1000)),exchange_poll_interval_ms:INFO_RECONCILE_MIN_MS,source_session:s.sourceSession,started_at:s.startedAt,
        coins,decisions:s.lastDecisions||[],errors:s.errors,recent:s.recent,stopped_reason:s.stoppedReason,mode_description:'PERCENTAGE_FILLS_INHERITED_ADD_ACCUMULATION_10_40'});
    }
    // V19.13 OBSERVATIONAL DIAGNOSTICS ONLY: no extra Hyperliquid network request.
    if(method==='GET'&&path==='/ip-rest-monitor')return J(hlIpRestSnapshot());
    // V19.12 READ-ONLY Hyperliquid account-based exchange request quota.
    // This endpoint never submits/cancels an order and never modifies strategy state.
    if(method==='GET'&&path==='/api-quota'){
      const wallet=String(this.env.HYPERLIQUID_MASTER_ACCOUNT||'').trim();
      if(!/^0x[a-fA-F0-9]{40}$/.test(wallet))return J({ok:false,error:'HYPERLIQUID_MASTER_ACCOUNT_INVALID'},422);
      type QuotaCache={at:number;ok:boolean;data:any};
      const cacheKey='live_copy_v19_hl_quota_cache';
      const prior=await this.state.storage.get(cacheKey) as QuotaCache|undefined;
      const now=Date.now();
      const recent=(await this.load()).recent||[];
      const rateEvents=recent.filter(x=>/429|RATE_LIMIT|TOO_MANY_REQUESTS|quota|limit exceeded/i.test(String(x.kind)+' '+String(x.detail)));
      // This history is bounded to 120 events; do not interpret counts as total missed trades.
      const observations={rate_limit_events_in_recent_history:rateEvents.length,
        recent_history_size:recent.length,
        recent_rate_limit_event:rateEvents[0]||null,
        caveat:'Recent events are a bounded diagnostic, not a count of missed trades; IP limits are separate.'};
      if(prior&&now-prior.at<(prior.ok?60000:20000))
        return J({...prior.data,...observations,cached:true,age_seconds:Math.floor((now-prior.at)/1000)});
      try{
        const r=await hlObservedFetch('https://api.hyperliquid.xyz/info',{type:'userRateLimit',user:wallet});
        if(!r.ok)throw Error('INFO_HTTP_'+r.status);
        const q=await r.json() as any;
        const used=Number(q?.nRequestsUsed),cap=Number(q?.nRequestsCap),surplus=Number(q?.nRequestsSurplus);
        const volume=Number(q?.cumVlm);
        if(![used,cap,surplus,volume].every(Number.isFinite)||cap<0||used<0||surplus<0)
          throw Error('INVALID_USER_RATE_LIMIT_RESPONSE');
        // Treat surplus separately; available cap is not evidence of successful order placement.
        const remaining=Math.max(0,cap-used);
        const data={ok:true,address:wallet.slice(0,6)+'…'+wallet.slice(-4),
          cum_volume_usd:volume,requests_used:used,requests_cap:cap,
          requests_surplus:surplus,remaining_requests:remaining,
          remaining_percent:cap>0?100*remaining/cap:null,
          usage_percent:cap>0?100*used/cap:null,
          state:remaining===0?'EXHAUSTED':cap>0&&remaining/cap<=0.05?'CRITICAL':cap>0&&remaining/cap<=0.15?'WARNING':'OK',
          checked_at:now,scope:'ACCOUNT_EXCHANGE_REQUESTS_ONLY',
          ip_rate_limit_included:false,websocket_limit_included:false};
        await this.state.storage.put(cacheKey,{at:now,ok:true,data});
        return J({...data,...observations,cached:false,age_seconds:0});
      }catch(e){
        const data={ok:false,error:'HYPERLIQUID_QUOTA_UNAVAILABLE',detail:String(e),checked_at:now,scope:'ACCOUNT_EXCHANGE_REQUESTS_ONLY'};
        await this.state.storage.put(cacheKey,{at:now,ok:false,data});
        return J({...data,...observations,cached:false},503);
      }
    }
    if(method==='GET'&&path==='/performance'){
      const s=await this.load();
      const base={ok:true,capital_usd:s.sessionCapital??null,equity_usd:null as number|null,roi_pct:null as number|null,
        equity_basis:s.sessionEquityBasis||null,win_rate_pct:null as number|null,closed_trades:null as number|null,
        wins:null as number|null,losses:null as number|null,reason:''};
      if(!(Number(s.sessionCapital)>0))return J({...base,reason:'CAPITAL_WILL_BE_SAVED_AT_NEXT_START'});
      const cache=await this.state.storage.get('v19_performance_cached') as {session:number;at:number;data:any}|undefined;
      if(cache&&cache.session===s.startedAt&&Date.now()-cache.at<60000)return J(cache.data);
      try{
        const source=v19SessionEquity(await __LC_EXECUTION.readLiveAccount(this.env));
        if(source&&source.basis===s.sessionEquityBasis){
          base.equity_usd=source.value;base.roi_pct=(source.value/Number(s.sessionCapital)-1)*100;
        }else base.reason='EQUITY_SOURCE_UNAVAILABLE';
      }catch(e){base.reason='EQUITY_READ_ERROR';}
      try{
        const fills=await postInfo({type:'userFillsByTime',user:this.env.HYPERLIQUID_MASTER_ACCOUNT,
          startTime:s.startedAt,aggregateByTime:false});
        const x=v19SessionWinRate(fills,s.startedAt);
        base.closed_trades=x.closed;base.wins=x.wins;base.losses=x.losses;base.win_rate_pct=x.winRate;
        if(x.reason)base.reason=x.reason;
      }catch(e){base.reason='FILL_HISTORY_READ_ERROR';}
      const data={...base,calculated_at:Date.now()};
      await this.state.storage.put('v19_performance_cached',{session:s.startedAt,at:Date.now(),data});
      return J(data);
    }
    if(method==='GET'&&path==='/account'){try{return J(await __LC_EXECUTION.readLiveAccount(this.env));}catch(e){return J({ok:false,error:String(e)},503);}}
    if(method==='GET'&&path==='/our-activity'){const s=await this.load();return J({ok:true,events:s.recent});}
    return J({ok:false,error:'UNSUPPORTED_V19_ROUTE',path},404);
  }
}
