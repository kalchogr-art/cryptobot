/**
 * LIVE COPY V2.3 — isolated Hyperliquid execution adapter.
 * NOT connected to the watcher or dashboard yet. LIVE writes are gated by
 * LIVE_COPY_TRADING_ENABLED === 'true' and explicit caller authorization.
 * Use a Durable Object as the sole serialized caller. Never retry ambiguous writes.
 * Dependencies: viem, @msgpack/msgpack.
 */
import { encode } from '@msgpack/msgpack';
import { bytesToHex, concat, keccak256, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { CopyIntent } from './live-copy-ledger-v2.3';

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
const normalizeKey = (x?: string) => x ? (x.startsWith('0x') ? x : `0x${x}`) : '';
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
async function sendAction(action: Record<string,unknown>, key: `0x${string}`, master: string) {
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
    spotBalanceError:spotResult.ok ? null : spotResult.error,
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

export type VerifiedOrderResult =
  | {kind:'VERIFIED';coin:string;oid:string;cloid:string|null;totalFilledQty:number;status:string}
  | {kind:'UNRESOLVED';reason:string};

/** Order-specific verification. A matching position delta or coincident fill
 * without the order OID is NEVER sufficient proof of which order executed.
 * Legacy UNKNOWN intents without OID/CLOID remain quarantined.
 */
export async function verifyLiveOrder(env:LiveCopyEnv,intent:CopyIntent):Promise<VerifiedOrderResult>{
  const master=env.HYPERLIQUID_MASTER_ACCOUNT?.trim()||'';
  if(!validAddress(master))throw Error('MASTER_ACCOUNT_NOT_CONFIGURED');
  const lookup=intent.exchangeOid||intent.exchangeCloid;
  if(!lookup)return {kind:'UNRESOLVED',reason:'LEGACY_ORDER_WITHOUT_OID_OR_CLOID'};
  const r:any=await info({type:'orderStatus',user:master,oid:/^\d+$/.test(lookup)?Number(lookup):lookup});
  if(r?.status!=='order'||!r?.order?.order)return {kind:'UNRESOLVED',reason:'ORDER_STATUS_UNAVAILABLE_OR_UNKNOWN_OID'};
  const detail=r.order.order;
  const status=String(r.order.status||'');
  const oid=String(detail.oid??'');
  const rawQty=Number(detail.origSz);
  if(!/^\d+$/.test(oid)||detail.coin!==intent.coin||
      detail.side!==(intent.side==='BUY'?'B':'A')||
      detail.reduceOnly!==intent.reduceOnly||
      (intent.exchangeCloid&&String(detail.cloid||'').toLowerCase()!==intent.exchangeCloid.toLowerCase())||
      !Number.isFinite(rawQty)||Math.abs(rawQty-intent.requestedQty)>1e-8)
    return {kind:'UNRESOLVED',reason:'ORDER_IDENTITY_MISMATCH'};
  // IOC only. An OPEN order may still be active or unknown: never call it terminal.
  if(detail.tif!=='Ioc')return {kind:'UNRESOLVED',reason:'NOT_VERIFIED_IOC'};
  const terminal=/^(filled|canceled|rejected|marginCanceled|vaultWithdrawalCanceled|openInterestCapCanceled|selfTradeCanceled|reduceOnlyCanceled|siblingFilledCanceled|delistedCanceled|liquidatedCanceled|scheduledCancel|tickRejected|minTradeNtlRejected|perpMarginRejected)$/i.test(status);
  if(!terminal)return {kind:'UNRESOLVED',reason:'ORDER_NOT_TERMINAL:'+status};
  const orderAt=Number(detail.timestamp);
  if(!Number.isFinite(orderAt)||orderAt<=0)return {kind:'UNRESOLVED',reason:'ORDER_TIMESTAMP_MISSING'};
  // Older history may be truncated by Hyperliquid retention. Absence of fills
  // cannot prove an old IOC was unfilled.
  if(Date.now()-orderAt>6*60*60*1000||orderAt-Date.now()>30000)
    return {kind:'UNRESOLVED',reason:'ORDER_OUTSIDE_RELIABLE_RECOVERY_WINDOW'};
  if(Date.now()-Number(r.order.statusTimestamp||orderAt)<5000)
    return {kind:'UNRESOLVED',reason:'ORDER_SETTLEMENT_NOT_YET_MATURE'};
  const from=Math.max(0,orderAt-30000);
  const until=Math.max(Number(r.order.statusTimestamp)||orderAt,orderAt)+30000;
  const fills:any=await info({type:'userFillsByTime',user:master,startTime:from,endTime:until,aggregateByTime:false});
  if(!Array.isArray(fills)||fills.length>=2000)return {kind:'UNRESOLVED',reason:'FILL_HISTORY_INCOMPLETE'};
  const matches=fills.filter((x:any)=>String(x.oid)===oid);
  // Invalid/mismatching exchange data -> block rather than credit another order.
  if(matches.some((x:any)=>x.coin!==intent.coin||x.side!==(intent.side==='BUY'?'B':'A')||
      !Number.isFinite(Number(x.sz))||Number(x.sz)<=0||
      !Number.isFinite(Number(x.time))||Number(x.time)<from||Number(x.time)>until||
      (x.tid===undefined&&x.hash===undefined)))
    return {kind:'UNRESOLVED',reason:'ORDER_FILL_IDENTITY_MISMATCH'};
  const seen=new Set<string>();let total=0;
  for(const x of matches){
    const unique=String(x.hash??'')+':'+String(x.tid??'');
    if(seen.has(unique))continue;seen.add(unique);total+=Number(x.sz);
  }
  total=Math.round(total*1e10)/1e10;
  if(total>intent.requestedQty+1e-8||total+1e-8<intent.confirmedFillQty)
    return {kind:'UNRESOLVED',reason:'FILL_SIZE_INCONSISTENT'};
  if(status.toLowerCase()==='filled'&&Math.abs(total-intent.requestedQty)>1e-8)
    return {kind:'UNRESOLVED',reason:'FILLED_STATUS_WITHOUT_COMPLETE_FILLS'};
  if(status.toLowerCase().includes('reject')&&total>0)
    return {kind:'UNRESOLVED',reason:'REJECTED_STATUS_WITH_FILLS'};
  if(total===0&&!/^(rejected|tickRejected|minTradeNtlRejected|perpMarginRejected)$/i.test(status))
    return {kind:'UNRESOLVED',reason:'NO_FILL_NOT_PROVEN_BY_ORDER_STATUS'};
  return {kind:'VERIFIED',coin:intent.coin,oid,cloid:intent.exchangeCloid||null,totalFilledQty:total,status};
}
/** Lightweight read used only AFTER an order-specific recovery was verified. */
export async function readLiveCoinQuantity(env:LiveCopyEnv,coin:string):Promise<number>{
  const master=env.HYPERLIQUID_MASTER_ACCOUNT?.trim()||'';
  if(!validAddress(master))throw Error('MASTER_ACCOUNT_NOT_CONFIGURED');
  const state:any=await info({type:'clearinghouseState',user:master});
  const positions=state?.assetPositions;
  if(!Array.isArray(positions))throw Error('INVALID_EXCHANGE_POSITION_RESPONSE');
  const found=positions.find((p:any)=>p?.position?.coin===coin);
  const qty=found===undefined?0:Number(found.position.szi);
  if(!Number.isFinite(qty))throw Error('INVALID_EXCHANGE_SIGNED_QTY');
  return qty;
}
