/** LIVE COPY STAGE16 - single-source edition + SOURCE CHAIN BUFFER FIX.
 * Same controller and seven helpers, merged into one TypeScript module.
 * No local ./live-copy-*.ts imports are needed.
 * Requires the existing npm dependencies @msgpack/msgpack and viem.
 * To replace src/live-copy-controller-v2.3-stage15.ts, paste this whole file there.
 * Preserve the existing Worker entrypoint and bindings. No real orders tested here.
 */
import { bytesToHex, concat, keccak256, recoverTypedDataAddress } from 'viem';
import { encode } from '@msgpack/msgpack';
import { privateKeyToAccount } from 'viem/accounts';

// ===== live-copy-accumulator-v2.3.ts =====
namespace __LC_ACCUMULATOR {

/**
 * LIVE COPY V2.3 — pure, persistence-friendly target accumulator.
 * No HTTP requests, no wallet access, no exchange orders.
 * Caller MUST serialize per coin, persist state, and only commit fills that
 * Hyperliquid confirmed. Never mark a proposed order as filled in advance.
 */
export type CopySide = 'LONG'|'SHORT';
export type CopyCoinState = {
  coin: string;
  anchorTargetQty: number;       // latest observed whale target qty
  scale: number;                 // own base-asset qty / whale base-asset qty
  confirmedOwnQty: number;       // exchange-confirmed signed position quantity
  pendingIntentId: string|null;  // one in-flight order per coin
  suspended: boolean;           // manual close or ambiguous write
  lastFillId: string|null;
};
export type CopyProposal = {
  kind:'OPEN'|'ADD'|'PARTIAL_CLOSE'|'FULL_CLOSE'|'NONE';
  coin:string; signedDelta:number; quantity:number; reduceOnly:boolean;
  desiredOwnQty:number; pendingNotional:number; reason:string;
};
const tiny=1e-10;
const sign=(x:number)=>Math.abs(x)<tiny?0:Math.sign(x);
const truncate=(q:number,d:number)=>Math.floor(Math.max(0,q)*10**d+1e-9)/10**d;
const round=(q:number)=>Math.round(q*1e10)/1e10;
export function planCopyAction(input:{
  state:CopyCoinState; whaleTargetQty:number; price:number; szDecimals:number;
  minimumNotional?:number;
}):CopyProposal {
  const {state:s,whaleTargetQty:target,price,szDecimals:d}=input;
  const min=input.minimumNotional??10.40;
  const none=(reason:string,desiredOwnQty=0,pendingNotional=0):CopyProposal=>({kind:'NONE',coin:s.coin,signedDelta:0,quantity:0,reduceOnly:false,desiredOwnQty,pendingNotional,reason});
  if(s.suspended)return none('MANUAL_OR_UNKNOWN_WRITE_SUSPENSION');
  if(s.pendingIntentId)return none('AWAITING_EXCHANGE_CONFIRMATION');
  if(!Number.isFinite(price)||price<=0||!Number.isFinite(target)||!Number.isFinite(s.scale)||s.scale<=0||!Number.isInteger(d)||d<0||d>8)return none('INVALID_INPUT');
  const desired=round(target*s.scale);
  const actual=s.confirmedOwnQty;
  const delta=round(desired-actual);
  const quantity=truncate(Math.abs(delta),d);
  const pendingNotional=Math.abs(delta)*price;
  if(sign(delta)===0)return none('SYNCED',desired,0);
  // A close to zero or a reversal is NOT equivalent to a new opening order.
  // The caller must close first and wait for confirmation before opening reverse.
  if(sign(actual)!==0 && (sign(desired)===0||sign(desired)!==sign(actual))) {
    const closeQty=truncate(Math.abs(actual),d);
    if(closeQty===0)return none('CLOSE_BELOW_PRECISION_REQUIRES_MANUAL_REVIEW',desired,pendingNotional);
    return {kind:'FULL_CLOSE',coin:s.coin,signedDelta:-actual,quantity:closeQty,reduceOnly:true,desiredOwnQty:desired,pendingNotional,reason:'TARGET_FLAT_OR_REVERSED'};
  }
  if(quantity===0||quantity*price+tiny<min)return none('ACCUMULATING_MICRO_DELTAS',desired,pendingNotional);
  const increasing=sign(actual)===0||sign(delta)===sign(actual);
  if(!increasing && quantity>Math.abs(actual)+tiny)return none('CLOSE_EXCEEDS_CONFIRMED_POSITION',desired,pendingNotional);
  return {kind:sign(actual)===0?'OPEN':increasing?'ADD':'PARTIAL_CLOSE',coin:s.coin,
    signedDelta:round(sign(delta)*quantity),quantity,reduceOnly:!increasing,
    desiredOwnQty:desired,pendingNotional,reason:'EXECUTABLE_ACCUMULATED_DELTA'};
}
export function confirmCopyFill(state:CopyCoinState, signedFillQty:number, intentId:string):CopyCoinState {
  if(!intentId||state.pendingIntentId!==intentId)throw Error('INTENT_MISMATCH');
  if(!Number.isFinite(signedFillQty))throw Error('INVALID_FILL');
  return {...state,confirmedOwnQty:round(state.confirmedOwnQty+signedFillQty),pendingIntentId:null};
}
export function markManualClose(state:CopyCoinState):CopyCoinState {
  // Manual CLOSE stops recopying the same whale position until a fresh, separately
  // identified opening episode is observed and explicitly rearmed by the controller.
  return {...state,suspended:true,pendingIntentId:null};
}

}

// ===== live-copy-ledger-v2.3.ts =====
namespace __LC_LEDGER {

/** LIVE COPY V2.3 Stage 3: durable intent ledger and conservative reconciliation.
 * Pure functions only. No trading is performed by importing this module.
 * All mutations must run in ONE serialized Durable Object and be persisted
 * before an exchange write. A pending/unknown write is NEVER retried blindly.
 */
export type IntentStatus = 'PREPARED'|'SUBMITTING'|'FILLED'|'PARTIAL'|'REJECTED'|'UNKNOWN'|'CANCELLED';
export type IntentKind = 'OPEN'|'ADD'|'PARTIAL_CLOSE'|'FULL_CLOSE'|'MANUAL_CLOSE';
export interface CopyIntent {
  id:string; coin:string; kind:IntentKind; side:'BUY'|'SELL'; reduceOnly:boolean;
  requestedQty:number; confirmedFillQty:number; status:IntentStatus;
  createdAt:number; updatedAt:number; sourceFillId:string; exchangeOid?:string;
  lastError?:string; exchangeCloid?:string;
}
export interface LiveLedger {
  version:1; intents:Record<string,CopyIntent>;
  /** Signed quantities that were actually confirmed by the exchange. */
  confirmedByCoin:Record<string,number>;
  /** Manual close blocks recopy until a NEW flat-to-open whale episode. */
  suspendedCoins:Record<string,boolean>;
  /** Last-known exchange state. Do not use as a replacement for fresh reads. */
  lastReconciledAt:number|null;
}
export const emptyLiveLedger=():LiveLedger=>({version:1,intents:{},confirmedByCoin:{},suspendedCoins:{},lastReconciledAt:null});
const round=(v:number)=>Math.round(v*1e10)/1e10;
export function prepareIntent(ledger:LiveLedger, intent:Omit<CopyIntent,'status'|'confirmedFillQty'|'createdAt'|'updatedAt'>, now:number):LiveLedger {
  if (!Number.isFinite(now)||now<=0||!intent.id||!/^[A-Z0-9]{2,20}$/.test(intent.coin)||
      !Number.isFinite(intent.requestedQty)||intent.requestedQty<=0) throw Error('INVALID_INTENT');
  if(ledger.intents[intent.id])throw Error('DUPLICATE_INTENT_ID');
  if(ledger.suspendedCoins[intent.coin])throw Error('COIN_SUSPENDED');
  if(Object.values(ledger.intents).some(i=>i.coin===intent.coin&&['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status)))
    throw Error('UNRESOLVED_COIN_INTENT');
  return {...ledger,intents:{...ledger.intents,[intent.id]:{...intent,status:'PREPARED',confirmedFillQty:0,createdAt:now,updatedAt:now}}};
}
export function markSubmitting(ledger:LiveLedger,id:string,now:number):LiveLedger {
  const old=ledger.intents[id];if(!old||old.status!=='PREPARED')throw Error('NOT_PREPARED');
  return {...ledger,intents:{...ledger.intents,[id]:{...old,status:'SUBMITTING',updatedAt:now}}};
}
/** Unknown outcomes must remain blocked until independently verified on Hyperliquid. */
export function markUnknown(ledger:LiveLedger,id:string,now:number,error:string):LiveLedger {
  const old=ledger.intents[id];if(!old||old.status!=='SUBMITTING')throw Error('NOT_SUBMITTING');
  return {...ledger,intents:{...ledger.intents,[id]:{...old,status:'UNKNOWN',lastError:error,updatedAt:now}}};
}
/** Call only with exchange-confirmed fill qty, never with a planned qty. */
export function recordExchangeFill(ledger:LiveLedger,id:string,filledQty:number,now:number,oid?:string):LiveLedger {
  const old=ledger.intents[id];
  if(!old||!['SUBMITTING','UNKNOWN','PARTIAL'].includes(old.status))throw Error('INVALID_FILL_STATE');
  if(!Number.isFinite(filledQty)||filledQty<=0||filledQty>old.requestedQty-old.confirmedFillQty+1e-9)
    throw Error('INVALID_CONFIRMED_QUANTITY');
  const total=round(old.confirmedFillQty+filledQty);
  const status:IntentStatus=total+1e-9>=old.requestedQty?'FILLED':'PARTIAL';
  const signed=old.side==='BUY'?filledQty:-filledQty;
  return {...ledger,
    confirmedByCoin:{...ledger.confirmedByCoin,[old.coin]:round((ledger.confirmedByCoin[old.coin]||0)+signed)},
    intents:{...ledger.intents,[id]:{...old,confirmedFillQty:total,status,updatedAt:now,exchangeOid:oid||old.exchangeOid}}};
}
export function markRejected(ledger:LiveLedger,id:string,now:number,reason:string):LiveLedger {
  const old=ledger.intents[id];if(!old||old.status!=='SUBMITTING')throw Error('INVALID_REJECTION_STATE');
  return {...ledger,intents:{...ledger.intents,[id]:{...old,status:'REJECTED',updatedAt:now,lastError:reason}}};
}
/** Refuse to run on a coin if the actual account position differs from our ledger.
 * This prevents touching pre-existing/manual positions on a shared wallet.
 */
export function assertPositionOwned(ledger:LiveLedger,coin:string,exchangeSignedQty:number,szDecimals:number):void {
  if(ledger.suspendedCoins[coin])throw Error('COIN_SUSPENDED');
  if(!Number.isFinite(exchangeSignedQty)||!Number.isInteger(szDecimals)||szDecimals<0||szDecimals>8)
    throw Error('INVALID_EXCHANGE_POSITION');
  const expected=ledger.confirmedByCoin[coin]||0;
  if(Math.abs(expected-exchangeSignedQty)>0.51*10**(-szDecimals))throw Error('POSITION_OWNERSHIP_MISMATCH');
  if(Object.values(ledger.intents).some(i=>i.coin===coin&&['SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status)))
    throw Error('PENDING_EXCHANGE_RECONCILIATION');
}
export function suspendCoin(ledger:LiveLedger,coin:string):LiveLedger {
  return {...ledger,suspendedCoins:{...ledger.suspendedCoins,[coin]:true}};
}

/** Resolve ONLY after orderStatus identifies this particular order and its fills
 * have been independently verified by OID in the correct master account.
 * A terminal IOC with a partial fill is terminal, not forever PARTIAL.
 */
export function settleVerifiedOrder(ledger:LiveLedger,id:string,confirmedTotalQty:number,now:number,oid:string,terminalStatus:string):LiveLedger {
  const old=ledger.intents[id];
  if(!old||!['SUBMITTING','UNKNOWN','PARTIAL'].includes(old.status))throw Error('INTENT_NOT_UNRESOLVED');
  if(!Number.isFinite(now)||now<=0||!oid||!Number.isFinite(confirmedTotalQty)||
    confirmedTotalQty<0||confirmedTotalQty+1e-9<old.confirmedFillQty||confirmedTotalQty>old.requestedQty+1e-9)
    throw Error('INVALID_VERIFIED_ORDER_TOTAL');
  const increment=round(confirmedTotalQty-old.confirmedFillQty);
  const status:IntentStatus=confirmedTotalQty+1e-9>=old.requestedQty?'FILLED':
    confirmedTotalQty>0?'CANCELLED':terminalStatus.toLowerCase().includes('reject')?'REJECTED':'CANCELLED';
  return {...ledger,
    confirmedByCoin:{...ledger.confirmedByCoin,[old.coin]:round((ledger.confirmedByCoin[old.coin]||0)+(old.side==='BUY'?increment:-increment))},
    intents:{...ledger.intents,[id]:{...old,status,confirmedFillQty:round(confirmedTotalQty),exchangeOid:oid,
      updatedAt:now,lastError:'EXCHANGE_VERIFIED_'+terminalStatus.toUpperCase()}}};
}

/** PREPARED is persisted BEFORE SUBMITTING and BEFORE any exchange write.
 * It is safe to discard only in this exact state, never SUBMITTING/UNKNOWN.
 */
export function cancelNeverSubmittedIntent(ledger:LiveLedger,id:string,now:number):LiveLedger{
  const old=ledger.intents[id];
  if(!old||old.status!=='PREPARED'||!Number.isFinite(now)||now<=0)
    throw Error('NOT_A_NEVER_SUBMITTED_INTENT');
  return {...ledger,intents:{...ledger.intents,[id]:{...old,status:'CANCELLED',
    updatedAt:now,lastError:'PREPARED_NEVER_SENT_CLEARED'}}};
}

}

// ===== live-copy-settlement-v2.3.ts =====
namespace __LC_SETTLEMENT {
import LiveLedger = __LC_LEDGER.LiveLedger;
import recordExchangeFill = __LC_LEDGER.recordExchangeFill;
import markRejected = __LC_LEDGER.markRejected;
import markUnknown = __LC_LEDGER.markUnknown;
/** Stage 5: conservative exchange-result settlement for LIVE COPY.
 * Pure functions; NEVER sends an exchange order. A confirmed fill is not
 * inferred from HTTP 200, wallet delta, or an unverified client payload.
 */

export type ExchangeReceipt = {
  intentId:string; coin:string; status:string; executed:boolean;
  filledQty?:number; requestedQty?:number; oid?:number|string;
};
export type Settlement = {ledger:LiveLedger; outcome:'FILLED'|'PARTIAL'|'REJECTED'|'UNKNOWN'; reason:string};
const EPS=1e-9;
export function settleExchangeReceipt(ledger:LiveLedger, receipt:ExchangeReceipt, now:number):Settlement {
  const intent=ledger.intents[receipt.intentId];
  if (!intent || intent.coin!==receipt.coin) throw Error('RECEIPT_INTENT_MISMATCH');
  if (intent.status!=='SUBMITTING') throw Error('INTENT_NOT_SUBMITTING');
  if (!Number.isFinite(now)||now<=0) throw Error('INVALID_TIMESTAMP');
  if (receipt.status==='FILLED' && receipt.executed===true) {
    const qty=receipt.filledQty;
    if (typeof qty!=='number'||!Number.isFinite(qty)||qty<=0||qty>intent.requestedQty+EPS)
      throw Error('INVALID_EXCHANGE_FILL');
    if (receipt.requestedQty!==undefined && Math.abs(receipt.requestedQty-intent.requestedQty)>EPS)
      throw Error('REQUESTED_QUANTITY_MISMATCH');
    // The execution adapter must supply this receipt directly; never accept a browser-supplied receipt.
    const next=recordExchangeFill(ledger,intent.id,qty,now,receipt.oid===undefined?undefined:String(receipt.oid));
    const status=next.intents[intent.id].status;
    return {ledger:next,outcome:status==='FILLED'?'FILLED':'PARTIAL',reason:'EXCHANGE_REPORTED_FILL'};
  }
  // Explicit adapter statuses that guarantee NO order request was sent, or a
  // definitive rejection from the exchange. Do not classify an absent/ambiguous
  // exchange response as REJECTED.
  const noOrderSent=new Set(['LIVE_DISABLED','CREDENTIALS_NOT_CONFIGURED','INVALID_INTENT',
    'UNKNOWN_ASSET','BELOW_SIZE_PRECISION','NO_POSITION_TO_REDUCE','REDUCE_EXCEEDS_POSITION',
    'OPPOSITE_POSITION_EXISTS','LEVERAGE_APPROVAL_MISSING','LEVERAGE_MODE_NOT_APPROVED',
    'ASSET_MAX_LEVERAGE_BELOW_10X','EXISTING_POSITION_LEVERAGE_MISMATCH',
    'LEVERAGE_UPDATE_UNCONFIRMED_NO_ORDER','LEVERAGE_UPDATE_REJECTED_NO_ORDER',
    'BELOW_STRATEGY_MIN_NOTIONAL','PRE_ORDER_ACCOUNT_READ_FAILED_NO_ORDER']);
  if ((receipt.status==='REJECTED'||noOrderSent.has(receipt.status)) && !receipt.executed) {
    return {ledger:markRejected(ledger,intent.id,now,'NO_ORDER_OR_EXCHANGE_REJECTED:'+receipt.status),outcome:'REJECTED',reason:'EXCHANGE_REJECTED'};
  }
  return {ledger:markUnknown(ledger,intent.id,now,'AMBIGUOUS_OR_UNFILLED_EXCHANGE_RESPONSE'),outcome:'UNKNOWN',reason:'RECONCILE_BEFORE_RETRY'};
}

}

// ===== live-copy-bridge-v2.3-stage6.ts =====
namespace __LC_BRIDGE {
import planCopyAction = __LC_ACCUMULATOR.planCopyAction;
import CopyCoinState = __LC_ACCUMULATOR.CopyCoinState;
import CopyProposal = __LC_ACCUMULATOR.CopyProposal;
import prepareIntent = __LC_LEDGER.prepareIntent;
import markSubmitting = __LC_LEDGER.markSubmitting;
import settleVerifiedOrder = __LC_LEDGER.settleVerifiedOrder;
import LiveLedger = __LC_LEDGER.LiveLedger;
import CopyIntent = __LC_LEDGER.CopyIntent;
import settleExchangeReceipt = __LC_SETTLEMENT.settleExchangeReceipt;
import ExchangeReceipt = __LC_SETTLEMENT.ExchangeReceipt;
/** V2.3 Stage 6: atomic planning/ledger bridge (NO exchange writes).
 * Call only inside a serialized Durable Object. Persist returned state+ledger
 * together before an order is submitted. Never call this from a browser.
 */



export type BridgeResult={state:CopyCoinState;ledger:LiveLedger;proposal:CopyProposal;intent:CopyIntent|null};
const terminal=(status:string)=>status==='FILLED'||status==='REJECTED'||status==='CANCELLED';
const sideFor=(p:CopyProposal):'BUY'|'SELL'=>p.signedDelta>0?'BUY':'SELL';
export function planAndReserve(input:{state:CopyCoinState;ledger:LiveLedger;whaleTargetQty:number;price:number;szDecimals:number;sourceFillId:string;intentId:string;now:number;minimumNotional?:number}):BridgeResult {
  const {state,ledger,sourceFillId,intentId,now}=input;
  if(!sourceFillId||!intentId||!Number.isFinite(now)||now<=0)throw Error('INVALID_EVENT_ID');
  if(ledger.suspendedCoins[state.coin]||state.suspended)throw Error('COIN_SUSPENDED');
  const expected=ledger.confirmedByCoin[state.coin]||0;
  if(Math.abs(expected-state.confirmedOwnQty)>1e-9)throw Error('LEDGER_STATE_MISMATCH');
  if(Object.values(ledger.intents).some(i=>i.coin===state.coin&&!terminal(i.status)))throw Error('UNRESOLVED_COIN_INTENT');
  const proposal=planCopyAction({state,whaleTargetQty:input.whaleTargetQty,price:input.price,szDecimals:input.szDecimals,minimumNotional:input.minimumNotional});
  if(proposal.kind==='NONE')return {state,ledger,proposal,intent:null};
  const nextLedger=prepareIntent(ledger,{id:intentId,coin:state.coin,kind:proposal.kind,side:sideFor(proposal),reduceOnly:proposal.reduceOnly,requestedQty:proposal.quantity,sourceFillId},now);
  return {state:{...state,pendingIntentId:intentId},ledger:nextLedger,proposal,intent:nextLedger.intents[intentId]};
}
export function beginSubmission(state:CopyCoinState,ledger:LiveLedger,intentId:string,now:number){
  if(state.pendingIntentId!==intentId)throw Error('INTENT_MISMATCH');
  return {state,ledger:markSubmitting(ledger,intentId,now)};
}
/** Only pass a receipt directly from the trusted exchange adapter, never a UI payload. */
export function applyTrustedReceipt(state:CopyCoinState,ledger:LiveLedger,receipt:ExchangeReceipt,now:number){
  if(state.pendingIntentId!==receipt.intentId)throw Error('INTENT_MISMATCH');
  const result=settleExchangeReceipt(ledger,receipt,now);
  const confirmed=result.ledger.confirmedByCoin[state.coin]||0;
  // IOC partial fills are unresolved until exchange reconciliation: do not re-enter.
  const release=result.outcome==='FILLED'||result.outcome==='REJECTED';
  return {state:{...state,confirmedOwnQty:confirmed,pendingIntentId:release?null:receipt.intentId,
    suspended:state.suspended||result.outcome==='UNKNOWN'},ledger:result.ledger,outcome:result.outcome};
}

/** Unblock a coin only after independently verified terminal IOC + position check.
 * The caller must persist the returned ledger and state before further events.
 */
export function applyVerifiedOrder(state:CopyCoinState,ledger:LiveLedger,input:{intentId:string;totalFilledQty:number;oid:string;exchangeStatus:string},now:number){
  if(state.pendingIntentId!==input.intentId)throw Error('RECOVERY_INTENT_MISMATCH');
  const next=settleVerifiedOrder(ledger,input.intentId,input.totalFilledQty,now,input.oid,input.exchangeStatus);
  return {state:{...state,confirmedOwnQty:next.confirmedByCoin[state.coin]||0,pendingIntentId:null,
    suspended:!!next.suspendedCoins[state.coin]},ledger:next};
}

}

// ===== live-copy-reconciliation-v2.3.ts =====
namespace __LC_RECONCILIATION {
import LiveLedger = __LC_LEDGER.LiveLedger;
/** Stage 4: read-only reconciliation of LIVE COPY ledger against Hyperliquid.
 * Never adopts pre-existing positions, never assumes an order filled from a balance change.
 */

export type ExchangePosition = { coin:string; qty:number };
export type ExchangeAsset = { coin:string; szDecimals:number };
export type ReconciliationRow = { coin:string; expectedQty:number; exchangeQty:number; differenceQty:number; status:'MATCH'|'MISMATCH'|'UNRESOLVED_INTENT'|'UNKNOWN_ASSET'|'UNOWNED_POSITION' };
export type ReconciliationReport = { safeToTrade:boolean; rows:ReconciliationRow[]; blockers:string[] };
export function reconcileCopyLedger(ledger:LiveLedger, positions:ExchangePosition[], assets:ExchangeAsset[]):ReconciliationReport {
  const pos=new Map(positions.map(p=>[p.coin,p.qty]));
  const meta=new Map(assets.map(a=>[a.coin,a.szDecimals]));
  const coins=new Set([...Object.keys(ledger.confirmedByCoin),...pos.keys(),...Object.values(ledger.intents).map(i=>i.coin)]);
  const rows:ReconciliationRow[]=[];const blockers:string[]=[];
  for(const coin of [...coins].sort()){
    const expected=ledger.confirmedByCoin[coin]||0, actual=pos.get(coin)||0;
    const d=meta.get(coin);
    const unresolved=Object.values(ledger.intents).some(i=>i.coin===coin&&['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status));
    let status:ReconciliationRow['status'];
    if(d===undefined||!Number.isInteger(d)||d<0||d>8)status='UNKNOWN_ASSET';
    else if(unresolved)status='UNRESOLVED_INTENT';
    else if(expected===0&&actual!==0)status='UNOWNED_POSITION';
    else if(Math.abs(expected-actual)>0.51*10**(-d))status='MISMATCH';
    else status='MATCH';
    rows.push({coin,expectedQty:expected,exchangeQty:actual,differenceQty:actual-expected,status});
    if(status!=='MATCH')blockers.push(`${coin}:${status}`);
  }
  return {safeToTrade:blockers.length===0,rows,blockers};
}

}

// ===== live-copy-execution-v2.3.ts =====
namespace __LC_EXECUTION {
import CopyIntent = __LC_LEDGER.CopyIntent;
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

}

// ===== live-copy-manual-close-v2.3-stage12.ts =====
namespace __LC_MANUAL_CLOSE {
import assertPositionOwned = __LC_LEDGER.assertPositionOwned;
import markSubmitting = __LC_LEDGER.markSubmitting;
import markUnknown = __LC_LEDGER.markUnknown;
import prepareIntent = __LC_LEDGER.prepareIntent;
import LiveLedger = __LC_LEDGER.LiveLedger;
import settleExchangeReceipt = __LC_SETTLEMENT.settleExchangeReceipt;
/** Stage 12 — manual-close command engine. No UI-provided position sizes trusted.
 * Must be called by the SINGLE serialized Durable Object; persist the ledger
 * at each transition before an external exchange write. LIVE remains disabled
 * until the controller routes are integrated and audited.
 */


export type ExchangePosition={coin:string;qty:number;szDecimals:number;markPrice:number};
export type CloseAdapter={
  positions():Promise<ExchangePosition[]>;
  execute(input:{intentId:string;coin:string;direction:'LONG'|'SHORT';quantity:number;reduceOnly:true;referencePrice:number}):Promise<{status:string;executed:boolean;filledQty?:number;requestedQty?:number;oid?:string|number}>;
};
export type LedgerStore={load():Promise<LiveLedger>;save(value:LiveLedger):Promise<void>};
export type CloseResult={coin:string;status:string;intentId?:string;filledQty?:number;reason?:string};
const safeCoin=(s:string)=>/^[A-Z0-9]{2,20}$/.test(s);
const quantize=(q:number,d:number)=>Math.floor((q+1e-12)*10**d)/10**d;
/** Must be invoked after STOP is durably saved. One call at a time per DO. */
export async function closeOwnedPosition(input:{coin:string;store:LedgerStore;exchange:CloseAdapter;commandId:string;now?:()=>number;recoveryCloseAll?:boolean}):Promise<CloseResult>{
  const {coin,store,exchange,commandId}=input;const now=input.now||Date.now;
  if(!safeCoin(coin)||!/^[-A-Za-z0-9_:]{8,150}$/.test(commandId))throw Error('INVALID_CLOSE_COMMAND');
  const id=`MANUAL:${commandId}:${coin}`;
  let ledger=await store.load();
  const existing=ledger.intents[id];
  if(existing)return {coin,status:existing.status,intentId:id,reason:'EXISTING_COMMAND_NO_RESUBMIT'};
  const unresolved=Object.values(ledger.intents).filter(i=>i.coin===coin&&
    ['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status));
  // Explicit CLOSE ALL is an emergency *reduce-only* close. Old UNKNOWN
  // writes may block copying but must not permanently prevent risk reduction.
  // Never send a second close while a recent exchange write might still settle.
  if(unresolved.length && !input.recoveryCloseAll)
    return {coin,status:'BLOCKED',reason:'UNRESOLVED_INTENT'};
  if(input.recoveryCloseAll && unresolved.some(i=>i.status!=='PREPARED' &&
    (!Number.isFinite(i.updatedAt)||now()-i.updatedAt<180000)))
    return {coin,status:'BLOCKED',reason:'RECENT_UNRESOLVED_ORDER_WAIT_FOR_SETTLEMENT'};
  const positions=await exchange.positions();
  const p=positions.find(x=>x.coin===coin);
  if(!p||!Number.isFinite(p.qty)||p.qty===0){
    if(!input.recoveryCloseAll && Math.abs(ledger.confirmedByCoin[coin]||0)>1e-9)
      throw Error('LEDGER_EXCHANGE_POSITION_MISMATCH');
    return {coin,status:'NO_POSITION'};
  }
  if(!Number.isFinite(p.markPrice)||p.markPrice<=0||!Number.isInteger(p.szDecimals)||p.szDecimals<0||p.szDecimals>8)
    throw Error('INVALID_EXCHANGE_METADATA');
  if(input.recoveryCloseAll){
    // A shared Hyperliquid wallet may hold unrelated positions. Only permit
    // this command on coins with a persisted LIVE COPY ownership footprint.
    if(!Object.prototype.hasOwnProperty.call(ledger.confirmedByCoin,coin) &&
       !Object.values(ledger.intents).some(i=>i.coin===coin))
      return {coin,status:'SKIPPED',reason:'COIN_NOT_OWNED_BY_LIVE_COPY'};
    // Constrain unknown writes to their recorded maximum possible signed fill.
    // A position outside those bounds may include someone else's trades.
    let lower=ledger.confirmedByCoin[coin]||0;
    let upper=lower;
    for(const i of unresolved){
      if(i.status==='PREPARED')continue; // PREPARED never reached exchange.
      const outstanding=Math.max(0,i.requestedQty-i.confirmedFillQty);
      const signed=(i.side==='BUY'?1:-1)*outstanding;
      lower+=Math.min(0,signed);
      upper+=Math.max(0,signed);
    }
    const tol=0.51*10**(-p.szDecimals);
    if(p.qty<lower-tol || p.qty>upper+tol)
      return {coin,status:'BLOCKED',reason:'EXCHANGE_POSITION_OUTSIDE_LIVE_COPY_INTENT_BOUNDS'};
  }else{
    assertPositionOwned(ledger,coin,p.qty,p.szDecimals);
  }
  const quantity=quantize(Math.abs(p.qty),p.szDecimals);
  if(quantity<=0)throw Error('QUANTITY_BELOW_PRECISION');
  const initial={id,coin,kind:'MANUAL_CLOSE' as const,side:(p.qty>0?'SELL':'BUY') as 'BUY'|'SELL',
    reduceOnly:true,requestedQty:quantity,confirmedFillQty:0,sourceFillId:`manual:${commandId}`,
    status:'PREPARED' as const,createdAt:now(),updatedAt:now()};
  // Normal close keeps prepareIntent's standard guard. CLOSE ALL uses a
  // durable, uniquely identified reduce-only intent without clearing the
  // historical UNKNOWN, whose outcome must remain auditable.
  ledger=input.recoveryCloseAll ? {...ledger,intents:{...ledger.intents,[id]:initial}}
    : prepareIntent(ledger,{id,coin,kind:'MANUAL_CLOSE',side:initial.side,reduceOnly:true,
      requestedQty:quantity,sourceFillId:initial.sourceFillId},now());
  await store.save(ledger); // persist PREPARED BEFORE the exchange write
  ledger=markSubmitting(ledger,id,now());
  await store.save(ledger); // persist SUBMITTING BEFORE the exchange write
  let receipt:{status:string;executed:boolean;filledQty?:number;requestedQty?:number;oid?:string|number};
  try{
    receipt=await exchange.execute({intentId:id,coin,direction:p.qty>0?'LONG':'SHORT',quantity,reduceOnly:true,referencePrice:p.markPrice});
  }catch(error){
    ledger=markUnknown(ledger,id,now(),`WRITE_OUTCOME_UNKNOWN:${String(error).slice(0,100)}`);
    await store.save(ledger);
    return {coin,status:'UNKNOWN',intentId:id,reason:'VERIFY_EXCHANGE_BEFORE_ANY_RETRY'};
  }
  const result=settleExchangeReceipt(ledger,{intentId:id,coin,...receipt},now());
  ledger=result.ledger;
  // Manual CLOSE suspends re-copying until a new, explicit whale episode.
  // Even a rejected close must not cause an immediate automated re-open.
  ledger={...ledger,suspendedCoins:{...ledger.suspendedCoins,[coin]:true}};
  await store.save(ledger);
  return {coin,status:result.outcome,intentId:id,filledQty:receipt.filledQty,reason:result.reason};
}
/** Never issue parallel close orders. Caller must first STOP auto-copy. */
export async function closeAllOwned(input:{store:LedgerStore;exchange:CloseAdapter;commandId:string;now?:()=>number}){
  const positions=await input.exchange.positions();
  // Reuse the batch's verified snapshot for planning; executeLiveIoc still
  // obtains a fresh account snapshot immediately before every real order.
  // This prevents additional allMids/meta/account reads for every coin.
  const exchange={...input.exchange,positions:async()=>positions};
  const results:CloseResult[]=[];
  for(const p of positions){
    const ledger=await input.store.load();
    if(!Object.prototype.hasOwnProperty.call(ledger.confirmedByCoin,p.coin)){
      results.push({coin:p.coin,status:'SKIPPED',reason:'NOT_OWNED_BY_LIVE_COPY'});continue;
    }
    try{results.push(await closeOwnedPosition({...input,exchange,coin:p.coin,recoveryCloseAll:true}));}
    catch(e){results.push({coin:p.coin,status:'BLOCKED',reason:String(e)});}
  }
  return {results,allConfirmedClosed:results.length>0&&results.every(x=>x.status==='FILLED'||x.status==='NO_POSITION')};
}

}

// ===== LIVE CONTROLLER (existing public export) =====
import planCopyAction = __LC_ACCUMULATOR.planCopyAction;
import CopyCoinState = __LC_ACCUMULATOR.CopyCoinState;
import planAndReserve = __LC_BRIDGE.planAndReserve;
import beginSubmission = __LC_BRIDGE.beginSubmission;
import applyTrustedReceipt = __LC_BRIDGE.applyTrustedReceipt;
import applyVerifiedOrder = __LC_BRIDGE.applyVerifiedOrder;
import assertPositionOwned = __LC_LEDGER.assertPositionOwned;
import markUnknown = __LC_LEDGER.markUnknown;
import cancelNeverSubmittedIntent = __LC_LEDGER.cancelNeverSubmittedIntent;
import emptyLiveLedger = __LC_LEDGER.emptyLiveLedger;
import LiveLedger = __LC_LEDGER.LiveLedger;
import readLiveAccount = __LC_EXECUTION.readLiveAccount;
import executeLiveIoc = __LC_EXECUTION.executeLiveIoc;
import cloidForIntent = __LC_EXECUTION.cloidForIntent;
import verifyLiveOrder = __LC_EXECUTION.verifyLiveOrder;
import readLiveCoinQuantity = __LC_EXECUTION.readLiveCoinQuantity;
import LiveCopyEnv = __LC_EXECUTION.LiveCopyEnv;
import closeOwnedPosition = __LC_MANUAL_CLOSE.closeOwnedPosition;
import closeAllOwned = __LC_MANUAL_CLOSE.closeAllOwned;
import CloseAdapter = __LC_MANUAL_CLOSE.CloseAdapter;
import reconcileCopyLedger = __LC_RECONCILIATION.reconcileCopyLedger;
/** LIVE COPY V2.3 - real-execution controller, Stage16 recovery patch.
 * Live orders require explicit START, durable authorization and guarded ledger.
 * Unknown results are NEVER blindly resubmitted; isolate the affected coin.
 */







type Env=LiveCopyEnv & {LIVE_COPY_LEVERAGE_VERIFIED?:string;LIVE_COPY_LEVERAGE_MODE?:string;LIVE_COPY_AUTO_EXECUTION_ENABLED?:string;LIVE_COPY_ADMIN_TOKEN?:string;DB?:{prepare(sql:string):{bind(...args:any[]):{first<T>():Promise<T|null>;all<T>():Promise<{results:T[]}>}}}};
type Storage={get<T>(key:string):Promise<T|undefined>;put(key:string,value:unknown):Promise<void>;setAlarm?(when:number):Promise<void>;deleteAlarm?():Promise<void>};
type State={storage:Storage};
type Coin=CopyCoinState & {lastWhaleTarget:number;lastPrice:number;lastEventAt:number;firstDetectedAt?:number;episode:number;addSignals?:number;lastAddSignalAt?:number};
// ===== SOURCE CHAIN INTAKE (D1 ROWID != WHALE EXECUTION ORDER) =====
// A durable intake queue commits the D1 ingestion watermark only AFTER all
// fetched rows are persisted. Each source fill is acknowledged independently;
// an out-of-order coin never blocks the other coins. No implicit replay of old
// rows: the queue is created anew at every explicit /start.
type SourceRowV23={rowid:number;session_id:string;fill_id:string;at:number;coin:string;action:string;payload:string};
type BufferedSourceRowV23=SourceRowV23 & {receivedAt:number};
type SourceChainAnchorV23={target:number;at:number;rowid:number};
type SourceQueueV23={session:string;startedAt:number;rows:BufferedSourceRowV23[];
  anchors:Record<string,SourceChainAnchorV23>;warnings:Record<string,number>};
const SOURCE_QUEUE_KEY_V23='live_copy_v23_source_chain_queue_v1';
const SOURCE_SETTLE_MS_V23=30000;
const SOURCE_QUEUE_MAX_V23=1200;
const SOURCE_EPS_V23=1e-7;
const sourceQtyV23=(a:number,b:number)=>Math.abs(a-b)<=Math.max(SOURCE_EPS_V23,Math.max(Math.abs(a),Math.abs(b))*1e-9);
const sourceTrustedV23=(r:SourceRowV23,e:any)=>e?.source==='HYPERLIQUID_PUBLIC_FILL' &&
  e?.recovered_from_verified_skipped_fill!==true &&
  !['RESYNC_CLOSE','RESYNC_REVERSAL'].includes(r.action);
export function nextSourceChainV23(input:{rows:BufferedSourceRowV23[];coin:string;
  anchor?:SourceChainAnchorV23;now:number}):{row?:BufferedSourceRowV23;reason?:string} {
  const pool=input.rows.filter(r=>r.coin===input.coin);
  if(!pool.length)return {reason:'NO_PENDING_ROWS'};
  const parsed=pool.map(r=>{let e:any;try{e=JSON.parse(r.payload);}catch{return {r,valid:false,e:null};}
    const before=Number(e?.target_before),after=Number(e?.target_after);
    return {r,e,before,after,valid:sourceTrustedV23(r,e)&&Number.isFinite(before)&&Number.isFinite(after)};});
  // Bookkeeping rows not connected to an exchange fill are safe to acknowledge
  // immediately, but must NEVER cause a trade or become an invented anchor.
  const inert=parsed.filter(x=>!sourceTrustedV23(x.r,x.e));
  if(inert.length)return {row:inert.sort((a,b)=>a.r.rowid-b.r.rowid)[0].r};
  if(parsed.some(x=>!x.valid))return {reason:'MALFORMED_TRUSTED_FILL'};
  const anchor=input.anchor;
  let candidates=anchor?parsed.filter(x=>sourceQtyV23(x.before!,anchor.target)):[];
  if(!anchor){
    // Find the unique chain root independent of D1 insertion order.
    candidates=parsed.filter(x=>!parsed.some(y=>y!==x&&sourceQtyV23(y.after!,x.before!)));
    if(candidates.length===1){
      const first=candidates[0];
      // When a single inherited fill arrives before its predecessor, wait for
      // the watcher to finish persisting the chain. A zero-before OPEN, or a
      // multi-fill connected chain, does not incur the extra settle delay.
      if(parsed.length===1 && !sourceQtyV23(first.before!,0) &&
         !(first.r.action==='REVERSAL' && Math.sign(first.before!)!==Math.sign(first.after!) && Math.sign(first.after!)!==0) &&
         input.now-first.r.receivedAt<SOURCE_SETTLE_MS_V23)
        return {reason:'WAIT_FOR_PREDECESSOR'};
    }
  }
  if(candidates.length!==1)return {reason:candidates.length>1?'AMBIGUOUS_CHAIN':'WAIT_FOR_MISSING_LINK'};
  const next=candidates[0];
  if(anchor && next.r.at<anchor.at)return {reason:'CHAIN_TIME_REGRESSION'};
  return {row:next.r};
}

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
  private readonly recoveryLastProbeKey='live_copy_v23_recovery_probe';
  private syncBusy=false;
  private isRateLimited(e:unknown){return /(?:HTTP_429|META_HTTP_429|RATE_LIMIT|TOO_MANY_REQUESTS)/i.test(String(e));}
  private async deferRateLimit(source:string){
    const existing=await this.state.storage.get<number>(this.rateLimitUntilKey)||0;
    const until=Math.max(existing,Date.now()+60000);
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
        const latest=await this.load();this.audit(latest,'AUTO_SYNC_ERROR',undefined,JSON.stringify(result).slice(0,1500));
        await this.save(latest);
        // Never override a safety halt from /sync. Retry only transient HTTP
        // failures that have not stopped the controller.
        if(latest.mode==='RUNNING' && response.status>=500 && this.state.storage.setAlarm)
          await this.state.storage.setAlarm(Date.now()+60000);
        return;
      }
      const latest=await this.load();
      if((result.processed||0)>0||(result.ignored||0)>0||result.bootstrapped)this.audit(latest,'AUTO_SYNC_OK',undefined,`processed=${result.processed||0} ignored=${result.ignored||0}`);
      await this.save(latest);
    }catch(error){
      const latest=await this.load();this.audit(latest,'AUTO_SYNC_EXCEPTION',undefined,String(error).slice(0,240));
      await this.save(latest);
      if(latest.mode==='RUNNING'&&this.state.storage.setAlarm)
        await this.state.storage.setAlarm(Date.now()+60000);
      return;
    }
    if((await this.load()).mode==='RUNNING'&&this.state.storage.setAlarm)await this.state.storage.setAlarm(Date.now()+15000);
  }
  private async ledger(){return await this.state.storage.get<LiveLedger>('live_copy_v23_ledger')||emptyLiveLedger();}
  /** Recover a bounded number of unknown IOC writes using THEIR OWN order IDs.
   * No retrying original exchange writes. Legacy unidentifiable orders remain
   * coin-local quarantines while unrelated coins continue.
   */
  private async recoverPendingOrders(){
    let initial=await this.ledger();
    // Repair a crash after a trusted terminal ledger commit but before the
    // per-coin state/seen write. Never send a second order for that source fill.
    const stored=await this.load();
    for(const [coin,c] of Object.entries(stored.coins)){
      if(!c.pendingIntentId)continue;
      const intent=initial.intents[c.pendingIntentId];
      if(!intent||!['FILLED','REJECTED','CANCELLED'].includes(intent.status))continue;
      let qty:number,precision:number;
      try{
        qty=await readLiveCoinQuantity(this.env,coin);
        precision=Number((await this.cachedMeta()).universe.find((a:any)=>a.name===coin)?.szDecimals);
      }catch(e){if(this.isRateLimited(e)){await this.deferRateLimit('TERMINAL_LEDGER_CRASH_RECOVERY');return;}
        continue;}
      if(!Number.isInteger(precision)||precision<0||precision>8)continue;
      const expected=initial.confirmedByCoin[coin]||0;
      const matched=Math.abs(expected-qty)<=0.51*10**(-precision);
      if(!matched){
        initial={...initial,suspendedCoins:{...initial.suspendedCoins,[coin]:true}};
        await this.state.storage.put('live_copy_v23_ledger',initial);
      }
      stored.coins[coin]={...c,confirmedOwnQty:expected,pendingIntentId:null,
        suspended:!matched||!!initial.suspendedCoins[coin]};
      stored.seen[`${coin}:${intent.sourceFillId}`]=Date.now();
      this.audit(stored,matched?'COMMITTED_ORDER_STATE_RECOVERED':'COMMITTED_ORDER_COIN_QUARANTINED',coin,
        `intent=${intent.id}; expected=${expected}; actual=${qty}`);
      await this.save(stored);
    }
    // A crash after PREPARED but before SUBMITTING cannot have sent an order.
    // Safely release just these reservations without touching UNKNOWN writes.
    for(const i of Object.values(initial.intents).filter(i=>i.status==='PREPARED')){
      const snapshot=await this.load();const coin=snapshot.coins[i.coin];
      if(!coin||coin.pendingIntentId!==i.id)continue;
      initial=cancelNeverSubmittedIntent(initial,i.id,Date.now());
      await this.state.storage.put('live_copy_v23_ledger',initial);
      snapshot.coins[i.coin]={...coin,pendingIntentId:null};
      snapshot.seen[`${i.coin}:${i.sourceFillId}`]=Date.now(); // no previous exchange submission
      this.audit(snapshot,'UNSENT_RESERVATION_RECOVERED',i.coin,'intent='+i.id);
      await this.save(snapshot);
    }
    const pending=Object.values(initial.intents).filter(i=>['SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status));
    if(!pending.length)return;
    const attempts=await this.state.storage.get<Record<string,number>>(this.recoveryLastProbeKey)||{};
    let touched=0;
    for(const intent of pending){
      if(touched>=2)break;
      if(Date.now()-intent.updatedAt<12000||Date.now()-(attempts[intent.id]||0)<20000)continue;
      if(!intent.exchangeCloid&&!intent.exchangeOid){
        // Legacy UNKNOWN without a provable exchange identifier stays isolated.
        // Do not consume the recovery budget or starve newer identifiable orders.
        continue;
      }
      attempts[intent.id]=Date.now();touched++;
      await this.state.storage.put(this.recoveryLastProbeKey,attempts);
      let result:Awaited<ReturnType<typeof verifyLiveOrder>>;
      try{result=await verifyLiveOrder(this.env,intent);}
      catch(e){
        if(this.isRateLimited(e)){await this.deferRateLimit('UNKNOWN_ORDER_VERIFICATION');return;}
        const s=await this.load();this.audit(s,'ORDER_RECOVERY_RETRY',intent.coin,String(e).slice(0,140));await this.save(s);
        continue;
      }
      if(result.kind!=='VERIFIED')continue;
      // Validate exchange account state against the complete ledger BEFORE
      // resuming this coin. If it differs, isolate only the affected coin.
      const latestLedger=await this.ledger();
      const latestIntent=latestLedger.intents[intent.id];
      if(!latestIntent||!['SUBMITTING','UNKNOWN','PARTIAL'].includes(latestIntent.status))continue;
      let candidate:ReturnType<typeof applyVerifiedOrder>;
      const s=await this.load();const c=s.coins[intent.coin];
      if(!c||c.pendingIntentId!==intent.id)continue;
      try{
        candidate=applyVerifiedOrder(c,latestLedger,{
          intentId:intent.id,totalFilledQty:result.totalFilledQty,oid:result.oid,
          exchangeStatus:result.status},Date.now());
      }catch(e){this.audit(s,'RECOVERY_LEDGER_REVIEW_REQUIRED',intent.coin,String(e).slice(0,140));await this.save(s);continue;}
      let current:number;
      try{current=await readLiveCoinQuantity(this.env,intent.coin);}
      catch(e){
        if(this.isRateLimited(e)){await this.deferRateLimit('RECOVERY_POSITION_VERIFICATION');return;}
        this.audit(s,'RECOVERY_POSITION_RETRY',intent.coin,String(e).slice(0,140));await this.save(s);continue;
      }
      let decimal:number;
      try{decimal=Number((await this.cachedMeta()).universe.find((a:any)=>a.name===intent.coin)?.szDecimals);}
      catch(e){if(this.isRateLimited(e)){await this.deferRateLimit('RECOVERY_METADATA');return;}
        this.audit(s,'RECOVERY_METADATA_RETRY',intent.coin,String(e).slice(0,140));await this.save(s);continue;}
      if(!Number.isInteger(decimal)||decimal<0||decimal>8)continue;
      const expected=candidate.ledger.confirmedByCoin[intent.coin]||0;
      const matched=Math.abs(expected-current)<=0.51*10**(-decimal);
      const verifiedLedger=matched?candidate.ledger:{...candidate.ledger,
        suspendedCoins:{...candidate.ledger.suspendedCoins,[intent.coin]:true}};
      await this.state.storage.put('live_copy_v23_ledger',verifiedLedger);
      s.coins[intent.coin]={...c,confirmedOwnQty:expected,pendingIntentId:null,
        suspended:!matched||!!verifiedLedger.suspendedCoins[intent.coin]};
      this.audit(s,matched?'LIVE_ORDER_RECOVERED':'COIN_POSITION_MISMATCH_QUARANTINED',intent.coin,
        `intent=${intent.id}; oid=${result.oid}; status=${result.status}; filled=${result.totalFilledQty}; expected=${expected}; actual=${current}`);
      await this.save(s);
    }
  }

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
      ['FILLED','PARTIAL','CANCELLED'].includes(i.status));
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
    const confirmedIntents=intents.filter(i=>i.confirmedFillQty>0&&['FILLED','CANCELLED'].includes(i.status));
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
      account.positions.every((p:any)=>Number.isFinite(p.unrealized))
        ? account.positions.reduce((total:number,p:any)=>total+p.unrealized,0):null;
    return {
      capital:o?.capital??null,capital_at:o?.startedAt??null,
      capital_source:o?.source??null,reset_count:o?.resetCount??0,
      equity:accountEquity,roi:!dry&&accounting?.complete&&(o?.capital??0)>0&&Number.isFinite(accounting.realized_net)&&account&&account.positions.every((p:any)=>Math.abs(Number(ledger.confirmedByCoin[p.coin]||0)-p.qty)<1e-8)&&Number.isFinite(accountUnrealized)?(accounting.realized_net+accountUnrealized)/(o?.capital||1)*100:null,free_margin:dry?null:validNumber(account?.withdrawable),used_margin:dry?null:validNumber(account?.totalMarginUsed),
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
    // Rehydrate the explicit durable START authorization without an exchange
    // request on every alarm. Every actual order still performs a fresh account
    // read and assertPositionOwned() before submitting to Hyperliquid.
    // Unknown writes block THEIR coin only; authorization remains valid for
    // other coins. Every new order is independently checked against the ledger.
    this.liveArmAt=s.startedAt;
    return {ok:true,reason:'DURABLE_START_AUTHORIZATION_REHYDRATED'};
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
        const buffered=await this.state.storage.get<SourceQueueV23>(SOURCE_QUEUE_KEY_V23);
        return json({ok:true,read_only:true,mode:s.mode,cursor:cursor||null,latest_source:last,
          pending_rows:pending?.n??null,buffered_source_rows:buffered?.rows.length||0,
          buffered_coins:[...new Set((buffered?.rows||[]).map(r=>r.coin))],
          watcher_session_matches:!cursor?.session||!latest||cursor.session===latest.session_id,warning:'Older source rows are never replayed as real trades.'});
      }catch(e){return json({ok:false,error:'D1_DIAGNOSTIC_FAILED',detail:String(e)},503);}
    }
    if(request.method==='GET'&&path==='/recovery-status'){
      const ledger=await this.ledger();
      const unresolved=Object.values(ledger.intents).filter(i=>['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status))
        .map(i=>({coin:i.coin,id:i.id,status:i.status,created_at:i.createdAt,
          last_updated_at:i.updatedAt,has_cloid:!!i.exchangeCloid,has_oid:!!i.exchangeOid,
          needs_manual_review:!i.exchangeCloid&&!i.exchangeOid}));
      return json({ok:true,read_only:true,mode:s.mode,unresolved,unresolved_count:unresolved.length,
        note:'A missing order identifier can never be reconstructed from wallet balance alone.'});
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
    if(request.method==='GET'&&path==='/status'){
      const sourcePending=await this.state.storage.get<SourceQueueV23>(SOURCE_QUEUE_KEY_V23);
      if(s.mode==='RUNNING'&&s.sessionKind==='LIVE'&&!this.liveAuthorized(s))await this.restoreLiveArm(s);
      return json({ok:true,overview:await this.overviewStatus(s),version:'V2.3_STAGE_16_CHAIN_BUFFER_SAFE_REORDER',mode:s.mode,auto_sync_enabled:s.mode==='RUNNING',poll_interval_seconds:15,live_execution_wired:true,manual_close_wired:true,session_kind:s.sessionKind||'DRY_RUN',live_session_authorized:this.liveAuthorized(s),live_authorization_reason:this.liveAuthorizationReason(s),manual_close_enabled:this.env.LIVE_COPY_TRADING_ENABLED==='true'&&(this.env as any).LIVE_COPY_MANUAL_CLOSE_ENABLED==='true',trading_enabled:this.liveAuthorized(s),auto_execution_configured:this.liveEnabled(),started_at:s.startedAt,coins:this.coinDetails(s,await this.ledger()),recent:s.recent,processed_event_ids:Object.keys(s.seen).length,ledger_intents:Object.keys((await this.ledger()).intents).length,source_pending_rows:sourcePending?.rows.length||0,source_pending_coins:[...new Set((sourcePending?.rows||[]).map(r=>r.coin))]});
    }
    if(request.method!=='POST')return json({ok:false,error:'NOT_FOUND'},404);
    let body:any={};try{body=await request.json();}catch{return json({ok:false,error:'INVALID_JSON'},400);}
    if(path==='/overview-init'){
      try{const overview=await this.ensureOverview();return json({ok:true,overview,read_only:true});}
      catch(e){return json({ok:false,error:'OVERVIEW_CAPITAL_UNAVAILABLE',detail:String(e)},503);}
    }
    if(path==='/stop'){this.liveArmAt=null;await this.state.storage.put('live_copy_v23_durable_arm',null);s.mode='STOPPED';this.audit(s,'STOP');await this.save(s);if(this.state.storage.deleteAlarm)await this.state.storage.deleteAlarm();return json({ok:true,mode:s.mode,positions_untouched:true});}
    if(path==='/start'&&s.mode==='RUNNING')return json({ok:false,error:'ALREADY_RUNNING_STOP_FIRST'},409);
    if(path==='/start'){this.liveArmAt=null;await this.state.storage.put('live_copy_v23_durable_arm',null);if(this.liveEnabled()&&body.confirm!=='START_REAL_HYPERLIQUID_COPY')return json({ok:false,error:'EXPLICIT_LIVE_CONFIRMATION_REQUIRED'},409);if(this.liveEnabled()){try{const account=await readLiveAccount(this.env);const ledger=await this.ledger();const report=reconcileCopyLedger(ledger,account.positions,account.assetMeta);if(Object.values(ledger.intents).some(i=>['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status)))return json({ok:false,error:'UNRESOLVED_INTENTS_REQUIRE_MANUAL_RECONCILIATION'},409);if(report.rows.some(r=>r.status!=='MATCH'&&r.status!=='UNOWNED_POSITION'))
        return json({ok:false,error:'PRE_START_RECONCILIATION_BLOCKED',report},409);
        // Protect unrelated pre-existing positions on a shared wallet.
        // They are never adopted as copied positions and never traded into.
        const unowned=report.rows.filter(r=>r.status==='UNOWNED_POSITION');
        if(unowned.length){
          await this.state.storage.put('live_copy_v23_ledger',{
            ...ledger,suspendedCoins:{...ledger.suspendedCoins,
              ...Object.fromEntries(unowned.map(r=>[r.coin,true]))}});
        }}catch(e){return json({ok:false,error:'PRE_START_ACCOUNT_CHECK_FAILED',detail:String(e)},409);}}if(!this.state.storage.setAlarm)return json({ok:false,error:'ALARM_STORAGE_UNAVAILABLE'},503);
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
      await this.state.storage.put(SOURCE_QUEUE_KEY_V23,{session:anchor.session,startedAt,rows:[],anchors:{},warnings:{}} as SourceQueueV23);
      s.coins={};s.seen={};s.recent=[];
      if(!this.liveEnabled())await this.paperReset(startedAt);
      s.mode='RUNNING';s.startedAt=startedAt;s.sessionKind=this.liveEnabled()?'LIVE':'DRY_RUN';this.audit(s,s.sessionKind==='LIVE'?'START_AUTO_SYNC_LIVE':'START_AUTO_SYNC_DRY_RUN');await this.save(s);if(s.sessionKind==='LIVE'){await this.state.storage.put('live_copy_v23_durable_arm',{startedAt:s.startedAt,config:this.armConfig()});this.liveArmAt=s.startedAt;}await this.state.storage.setAlarm(Date.now()+1000);return json({ok:true,mode:s.mode,trading_enabled:this.liveAuthorized(s)});}
    if(path==='/sync'){
      if(this.syncBusy)return json({ok:true,already_running:true,processed:0,ignored:0},202);
      this.syncBusy=true;
      try{
      // Both scheduled polling and event-driven wakeups honor one shared backoff.
      // A wakeup during cooldown must not query Hyperliquid or send orders.
      const cooldown=await this.state.storage.get<number>(this.rateLimitUntilKey)||0;
      if(Date.now()<cooldown){
        if(s.mode!=='RUNNING')return json({ok:false,error:'STOPPED'},409);
        if(this.state.storage.setAlarm)await this.state.storage.setAlarm(cooldown+1000);
        return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:cooldown,exchange_order_sent:false},503);
      }
      if(s.mode==='RUNNING'&&s.sessionKind==='LIVE'&&!this.liveAuthorized(s)){const restored=await this.restoreLiveArm(s);if(!restored.ok){if(restored.reason==='HYPERLIQUID_RATE_LIMIT_RETRY'){const retryAt=await this.deferRateLimit('RESTORE_LIVE_ARM');return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:retryAt,exchange_order_sent:false},503);}
        await this.halt('LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED:'+restored.reason);return json({ok:false,error:'LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED',reason:restored.reason,stopped:true},409);}}
      if(s.mode==='RUNNING'&&((s.sessionKind==='LIVE'&&!this.liveAuthorized(s))||(s.sessionKind!=='LIVE'&&this.liveEnabled()))){const reason=s.sessionKind==='LIVE'?this.liveAuthorizationReason(s):'DRY_RUN_CONFIGURATION_CHANGED_TO_LIVE';await this.halt('LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED:'+reason);return json({ok:false,error:'LIVE_SESSION_NOT_AUTHORIZED_OR_CONFIGURATION_CHANGED',reason,stopped:true},409);}
      if(s.mode!=='RUNNING')return json({ok:false,error:'STOPPED'},409);
      if(!this.env.DB){await this.halt('DB_BINDING_MISSING');return json({ok:false,error:'DB_BINDING_MISSING',stopped:true},503);}
      // Never query the exchange on an empty cycle except when unresolved
      // intents need bounded order-specific verification.
      await this.recoverPendingOrders();
      const laterCooldown=await this.state.storage.get<number>(this.rateLimitUntilKey)||0;
      if(Date.now()<laterCooldown)return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:laterCooldown,exchange_order_sent:false},503);
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
      // The D1 cursor is ONLY an ingestion high-water mark. It must not be
      // interpreted as the execution order, and is advanced only after durable
      // staging of every fetched row (including other coins and bookkeeping).
      let staged=await this.state.storage.get<SourceQueueV23>(SOURCE_QUEUE_KEY_V23);
      if(!staged || staged.startedAt!==s.startedAt || staged.session!==cursor.session){
        staged={session:cursor.session,startedAt:s.startedAt||0,rows:[],anchors:{},warnings:{}};
        await this.state.storage.put(SOURCE_QUEUE_KEY_V23,staged);
      }
      const capacity=Math.max(0,SOURCE_QUEUE_MAX_V23-staged.rows.length);
      const batchLimit=Math.max(0,Math.min(100,capacity));
      const fetched=batchLimit?await this.env.DB.prepare(`SELECT rowid,session_id,fill_id,at,coin,action,payload FROM mc_watch_events WHERE rowid>? ORDER BY rowid ASC LIMIT ${batchLimit}`)
        .bind(cursor.rowid).all<SourceRowV23>():null;
      const newRows=fetched?.results||[];
      if(newRows.length){
        // A new watcher session needs explicit START. Never join two histories.
        const mismatch=newRows.find(r=>cursor!.session&&r.session_id!==cursor!.session);
        if(mismatch){await this.halt('WATCHER_SESSION_CHANGED_REQUIRES_REARM');
          return json({ok:false,error:'WATCHER_SESSION_CHANGED_REQUIRES_REARM',rowid:mismatch.rowid,stopped:true},409);}
        if(!staged.session)staged.session=newRows[0].session_id;
        const existingIds=new Set(staged.rows.map(r=>r.rowid));
        for(const r of newRows)if(!existingIds.has(r.rowid))staged.rows.push({...r,receivedAt:Date.now()});
        // Persist first; only then may the ingestion cursor move forward.
        await this.state.storage.put(SOURCE_QUEUE_KEY_V23,staged);
        cursor={session:newRows[newRows.length-1].session_id,rowid:newRows[newRows.length-1].rowid};
        await this.state.storage.put('live_copy_v23_d1_cursor',cursor);
      }
      if(!staged.rows.length)return json({ok:true,processed:0,ignored:0,cursor,has_more:newRows.length===batchLimit&&batchLimit>0,buffered:0});
      let metadata:any=null;let metadataError='';
      try{metadata=await this.cachedMeta();}catch(e){metadataError=String(e);}
      if(metadataError){if(this.isRateLimited(metadataError)){const retryAt=await this.deferRateLimit('METADATA');
        return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:retryAt,cursor,buffered:staged.rows.length,exchange_order_sent:false},503);}
        return json({ok:false,error:'METADATA_UNAVAILABLE',detail:metadataError,cursor,buffered:staged.rows.length,retryable:true,exchange_order_sent:false},503);}
      const precisions=new Map<string,number>(metadata.universe.map((a:any)=>[a.name,a.szDecimals]));
      let processed=0,ignored=0;let sentAnyOrder:boolean|'UNKNOWN'=false;const pendingReasons:Record<string,string>={};
      const blockedThisCycle=new Set<string>();
      // Each iteration consumes at most one row, then persists its receipt and
      // the source chain anchor. Other coins remain eligible when one coin's
      // predecessor has not arrived or one /event request fails.
      for(let step=0;step<Math.min(300,SOURCE_QUEUE_MAX_V23);step++){
        if((await this.load()).mode!=='RUNNING')break;
        const activeCooldown=await this.state.storage.get<number>(this.rateLimitUntilKey)||0;
        if(Date.now()<activeCooldown){
          if(this.state.storage.setAlarm)await this.state.storage.setAlarm(activeCooldown+1000);
          return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:activeCooldown,
            cursor,buffered:staged.rows.length,processed,ignored,exchange_order_sent:false},503);
        }
        const state=await this.load();
        const coins=[...new Set(staged.rows.map(r=>r.coin))].filter(c=>!blockedThisCycle.has(c));
        const options:{row:BufferedSourceRowV23;reason?:string}[]=[];
        for(const coin of coins){
          const anchor=staged.anchors[coin]|| (state.coins[coin]?{
            target:state.coins[coin].lastWhaleTarget,at:state.coins[coin].lastEventAt,rowid:0}:undefined);
          const proposal=nextSourceChainV23({rows:staged.rows,coin,anchor,now:Date.now()});
          if(proposal.row)options.push({row:proposal.row});
          else {pendingReasons[coin]=proposal.reason||'WAIT_FOR_CHAIN';
            const oldest=Math.min(...staged.rows.filter(r=>r.coin===coin).map(r=>r.receivedAt));
            if(Date.now()-oldest>=45000 && Date.now()-(staged.warnings[coin]||0)>=60000){
              this.audit(state,'TARGET_CHAIN_PENDING',coin,`reason=${pendingReasons[coin]}; rows=${staged.rows.filter(r=>r.coin===coin).map(r=>r.rowid).join(',').slice(0,180)}`);
              staged.warnings[coin]=Date.now();await this.save(state);await this.state.storage.put(SOURCE_QUEUE_KEY_V23,staged);
            }
          }
        }
        if(!options.length)break;
        options.sort((a,b)=>a.row.rowid-b.row.rowid);
        const row=options[0].row;
        let e:any;try{e=JSON.parse(row.payload);}catch{
          blockedThisCycle.add(row.coin);pendingReasons[row.coin]='BAD_SOURCE_PAYLOAD';continue;}
        if(!row.fill_id || !row.session_id || row.session_id!==cursor.session){
          blockedThisCycle.add(row.coin);pendingReasons[row.coin]='INVALID_FILL_ID_OR_SESSION';continue;}
        const genuine=sourceTrustedV23(row,e);
        const bookkeeping=['GAP_CLOSE','RESYNC_CLOSE','RESYNC_REVERSAL'].includes(row.action);
        let acknowledgement:any={ok:true,ignored:true};
        if(genuine && Number.isFinite(Number(e.target_before)) && Number.isFinite(Number(e.target_after))){
          if(bookkeeping){
            // GAP_CLOSE describes a genuine whale fill but a virtual watcher
            // close. Do NOT place an exchange order for it. However, its real
            // before/after values bridge the source sequence; subsequent fills
            // can then be validated without inventing an extra order.
            const current=await this.load();
            const seenId=`${row.coin}:${row.fill_id}`;
            const old=current.coins[row.coin];
            if(!current.seen[seenId]){
              if(old){
                if(row.at<old.lastEventAt || !sourceQtyV23(Number(e.target_before),old.lastWhaleTarget)){
                  blockedThisCycle.add(row.coin);pendingReasons[row.coin]='BOOKKEEPING_CHAIN_INCONSISTENT';continue;
                }
                current.coins[row.coin]={...old,lastWhaleTarget:Number(e.target_after),lastEventAt:row.at,lastFillId:row.fill_id};
              }
              current.seen[seenId]=Date.now();
              this.audit(current,'SOURCE_CHAIN_BRIDGE_NO_ORDER',row.coin,`rowid=${row.rowid} ${e.target_before}->${e.target_after}; action=${row.action}`);
              await this.save(current);
            }
          }else{
            const decimals=precisions.get(row.coin);
            if(decimals===undefined){blockedThisCycle.add(row.coin);pendingReasons[row.coin]='UNKNOWN_ASSET_PRECISION';continue;}
            const response=await this.fetch(new Request('https://live-copy.internal/event',{
              method:'POST',headers:{authorization:`Bearer ${this.env.LIVE_COPY_ADMIN_TOKEN}`,'content-type':'application/json'},
              body:JSON.stringify({coin:row.coin,fill_id:row.fill_id,source_action:row.action,
                whale_before_qty:Number(e.target_before),whale_target_qty:Number(e.target_after),
                price:Number(e.price),sz_decimals:decimals,time:row.at})}));
            acknowledgement=await response.json();
            if(!response.ok){
              const reason=String(acknowledgement?.error||'EVENT_REJECTED');
              if(acknowledgement?.retryable===true || reason==='HYPERLIQUID_RATE_LIMIT_BACKOFF'){
                const retryAt=Number(acknowledgement?.retry_at)||Date.now()+60000;
                if(this.state.storage.setAlarm)await this.state.storage.setAlarm(retryAt+1000);
                return json({ok:false,error:reason,retryable:true,retry_at:retryAt,
                  cursor,buffered:staged.rows.length,processed,ignored,exchange_order_sent:false},503);
              }
              const fresh=await this.load();
              if(fresh.mode!=='RUNNING')return json({ok:false,error:'LIVE_HALTED_BY_EVENT',reason,stopped:true,cursor},409);
              blockedThisCycle.add(row.coin);pendingReasons[row.coin]=reason;
              if(Date.now()-(staged.warnings[row.coin]||0)>60000){
                this.audit(fresh,'SOURCE_COIN_PENDING_REVIEW',row.coin,`rowid=${row.rowid}; reason=${reason}; no_order_retry`);
                staged.warnings[row.coin]=Date.now();await this.save(fresh);
              }
              continue;
            }
            if(row.action==='REVERSAL'){
              const latest=await this.load();this.audit(latest,acknowledgement.ignored?'REVERSAL_IGNORED':'REVERSAL_HANDLED',row.coin,`rowid=${row.rowid} reason=${acknowledgement.reason||acknowledgement.proposal?.reason||'accepted'}`);await this.save(latest);
            }
          }
          staged.anchors[row.coin]={target:Number(e.target_after),at:row.at,rowid:row.rowid};
        }else if(genuine){
          blockedThisCycle.add(row.coin);pendingReasons[row.coin]='INVALID_TARGET_VALUES';continue;
        }
        if(acknowledgement.exchange_order_sent==='UNKNOWN')sentAnyOrder='UNKNOWN';
        else if(acknowledgement.exchange_order_sent===true && sentAnyOrder!=='UNKNOWN')sentAnyOrder=true;
        if(acknowledgement.ignored)ignored++;else processed++;
        staged.rows=staged.rows.filter(r=>r.rowid!==row.rowid);
        await this.state.storage.put(SOURCE_QUEUE_KEY_V23,staged);
      }
      return json({ok:true,trading_enabled:this.liveAuthorized(await this.load()),processed,ignored,cursor,
        buffered:staged.rows.length,pending_coins:[...new Set(staged.rows.map(r=>r.coin))],
        pending_reasons:pendingReasons,has_more:newRows.length===batchLimit&&batchLimit>0,
        exchange_order_sent:sentAnyOrder});
      } finally {this.syncBusy=false;}
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
      if(s.mode!=='STOPPED'){
        if(path!=='/close-all')return json({ok:false,error:'STOP_REQUIRED_BEFORE_MANUAL_CLOSE'},409);
        s.mode='STOPPED';this.liveArmAt=null;
        await this.state.storage.put('live_copy_v23_durable_arm',null);
        this.audit(s,'CLOSE_ALL_AUTO_STOP');await this.save(s);
        if(this.state.storage.deleteAlarm)await this.state.storage.deleteAlarm();
      }
      if(this.syncBusy)return json({ok:false,error:'SYNC_IN_PROGRESS_RETRY_CLOSE_ALL_WHEN_IDLE',retryable:true},409);
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
        let reset:any=null;
        if(path==='/close-all'){
          // CLOSE ALL is a verified session-finalization operation, not just a
          // sequence of IOC close orders. Even if the wallet is already flat,
          // old UNKNOWN/SUBMITTING entries must not block the NEXT session forever.
          // Never mark their historical execution as FILLED or REJECTED: archive
          // them unchanged. Only discard the *active* ledger after verifying the
          // whole master account is flat and has no resting orders.
          if(this.syncBusy)throw Error('SYNC_IN_PROGRESS_RETRY_CLOSE_ALL_WHEN_IDLE');
          const current=await this.ledger();
          const unfinished=Object.values(current.intents).filter(i=>
            ['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status));
          const tooRecent=unfinished.filter(i=>i.status!=='PREPARED' &&
            (!Number.isFinite(i.updatedAt)||Date.now()-i.updatedAt<180000));
          if(tooRecent.length){
            reset={completed:false,reason:'RECENT_UNKNOWN_WRITE_WAIT_FOR_IOC_SETTLEMENT',
              blocked_intents:tooRecent.map(i=>({coin:i.coin,id:i.id,status:i.status,updatedAt:i.updatedAt}))};
          }else{
            // Two independent fresh position reads + a fresh open-orders read.
            // One-time checks on CLOSE ALL, not part of the 15s polling loop.
            const a=await readLiveAccount(this.env);
            const b=await readLiveAccount(this.env);
            // Other strategies can share this wallet; they must not be closed
            // or prevent a clean LIVE COPY session reset.
            const managedCoins=new Set<string>([
              ...Object.keys(current.confirmedByCoin),
              ...Object.values(current.intents).map(i=>i.coin),
              ...Object.keys(current.suspendedCoins)
            ]);
            const managedPosition=(p:{coin:string})=>managedCoins.has(p.coin);
            const flat=a.masterAccount===b.masterAccount &&
              !a.positions.some(managedPosition) && !b.positions.some(managedPosition);
            const otherPositions=b.positions.filter((p:any)=>!managedCoins.has(p.coin));
            if(!flat){
              reset={completed:false,reason:'EXCHANGE_POSITIONS_NOT_CONFIRMED_FLAT',
                first_positions:a.positions.map((p:any)=>({coin:p.coin,qty:p.qty})),
                second_positions:b.positions.map((p:any)=>({coin:p.coin,qty:p.qty}))};
            }else{
              const response=await fetch('https://api.hyperliquid.xyz/info',{
                method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({type:'openOrders',user:a.masterAccount})
              });
              if(!response.ok)throw Error('CLOSE_ALL_OPEN_ORDERS_HTTP_'+response.status);
              const orders:any=await response.json();
              if(!Array.isArray(orders))throw Error('CLOSE_ALL_OPEN_ORDERS_RESPONSE_INVALID');
              const conflictingOrders=orders.filter((o:any)=>
                typeof o?.coin!=='string' || managedCoins.has(o.coin));
              if(conflictingOrders.length){
                reset={completed:false,reason:'MANAGED_COIN_HAS_OPEN_ORDERS',
                  open_order_count:conflictingOrders.length};
              }else if(this.syncBusy){
                reset={completed:false,reason:'SYNC_STARTED_DURING_CLOSE_ALL'};
              }else{
                // Obtain a truthful new capital snapshot BEFORE changing ledger
                // or UI state. On API failure, leave it intact and allow a safe retry.
                const capital=b.spotUsdcTotal;
                const now=Date.now();
                const previous=await this.overview();
                if(typeof capital==='number'&&Number.isFinite(capital)&&capital>=0){
                  overview_reset={capital,startedAt:now,source:'spotClearinghouseState.USDC.total',
                    resetCount:(previous?.resetCount||0)+1};
                }
                // Keep immutable evidence of every previous order intent,
                // including legacy UNKNOWN, without contaminating a new session.
                const archiveKey='live_copy_v23_closeall_archive:'+now+':'+commandId;
                await this.state.storage.put(archiveKey,{
                  at:now,commandId,previous_started_at:s.startedAt,
                  prior_ledger:current,unresolved_at_close:unfinished.map(i=>({
                    coin:i.coin,id:i.id,status:i.status,exchangeOid:i.exchangeOid||null,
                    exchangeCloid:i.exchangeCloid||null})),
                  verification:'TWO_FLAT_MANAGED_POSITION_READS_AND_NO_MANAGED_OPEN_ORDERS',
                  unrelated_positions_untouched:otherPositions.map((p:any)=>({coin:p.coin,qty:p.qty})),
                  note:'Historical UNKNOWN outcomes remain UNKNOWN in archive; not asserted unfilled.'
                });
                await this.state.storage.put('live_copy_v23_ledger',{
                  ...emptyLiveLedger(),lastReconciledAt:now
                });
                await this.state.storage.put('live_copy_v23_recovery_probe',{});
                const sourceQueueBeforeReset=await this.state.storage.get<SourceQueueV23>(SOURCE_QUEUE_KEY_V23);
                if(sourceQueueBeforeReset?.rows.length)
                  await this.state.storage.put(archiveKey+':source_queue',sourceQueueBeforeReset);
                await this.state.storage.put(SOURCE_QUEUE_KEY_V23,{session:'',startedAt:0,rows:[],anchors:{},warnings:{}} as SourceQueueV23);
                await this.state.storage.put('live_copy_v23_d1_cursor',{session:'',rowid:0});
                await this.state.storage.put('live_copy_v23_session_baseline',{session:'',rowid:0,startedAt:0});
                await this.state.storage.put('live_copy_v23_dashboard_account',{at:now,account:b});
                await this.state.storage.put('live_copy_v23_accounting_snapshot',null);
                if(overview_reset)await this.state.storage.put('live_copy_v23_overview',overview_reset);
                await this.paperReset(now);
                this.liveArmAt=null;
                await this.state.storage.put('live_copy_v23_durable_arm',null);
                // Only the *active* session is cleared; D1 exchange history and
                // the archived old ledger remain available for audit.
                s.coins={};s.seen={};s.recent=[];s.startedAt=null;
                s.sessionKind='DRY_RUN';s.mode='STOPPED';
                (result as any).allConfirmedClosed=true;
                reset={completed:true,verified_flat:true,managed_open_orders:0,
                  other_positions_untouched:otherPositions.map((p:any)=>({coin:p.coin,qty:p.qty})),
                  overview_capital_updated:!!overview_reset,
                  archived_intents:Object.keys(current.intents).length,
                  archived_unresolved:unfinished.length,archive_key:archiveKey,
                  new_ledger_intents:0};
                this.audit(s,'CLOSE_ALL_VERIFIED_FLAT_SESSION_RESET',undefined,
                  `command=${commandId}; archived_unresolved=${unfinished.length}; new_ledger_intents=0`);
                this.audit(s,overview_reset?'OVERVIEW_CAPITAL_RESET':'OVERVIEW_CAPITAL_UNAVAILABLE',undefined,
                  overview_reset?'Fresh verified USDC snapshot after managed positions flat':
                    'USDC capital not verified; session safely reset, prior overview baseline retained');
              }
            }
          }
          if(!reset?.completed){
            (result as any).allConfirmedClosed=false;
            this.audit(s,'CLOSE_ALL_RESET_BLOCKED',undefined,
              `command=${commandId}; reason=${reset?.reason||'VERIFICATION_FAILED'}`);
          }
        }
        this.audit(s,'MANUAL_CLOSE_COMMAND',body.coin,JSON.stringify(result).slice(0,240));
        if(path==='/close-all')for(const [coin,qty] of Object.entries((await this.ledger()).confirmedByCoin))
          this.audit(s,'CLOSE_ALL_POSITION_RESULT',coin,`remaining_confirmed_qty=${qty}; command=${commandId}`);
        await this.save(s);
        if(path==='/close-all'&&!reset?.completed)
          return json({ok:false,error:'CLOSE_ALL_RESET_NOT_VERIFIED',result,reset,
            positions_may_remain:true,live_write_attempted:true},409);
        return json({ok:true,result,overview_reset,reset,live_write_attempted:true});
      }catch(e){return json({ok:false,error:'MANUAL_CLOSE_FAILED',detail:String(e)},409);}
    }
    if(path!=='/event')return json({ok:false,error:'NOT_FOUND'},404);
    if(s.mode!=='RUNNING')return json({ok:false,error:'STOPPED'},409);
    const {coin,fill_id,source_action,whale_target_qty,whale_before_qty,price,sz_decimals,time}=body;
    if(typeof coin!=='string'||!/^[A-Z0-9]{2,20}$/.test(coin)||typeof fill_id!=='string'||!fill_id||fill_id.length>180||!finite(whale_target_qty)||!finite(whale_before_qty)||!finite(price)||price<=0||!Number.isInteger(sz_decimals)||sz_decimals<0||sz_decimals>8||!finite(time)||time<=0)return json({ok:false,error:'INVALID_EVENT'},400);
    if(s.sessionKind==='LIVE'&&!this.liveAuthorized(s)){
      const restored=await this.restoreLiveArm(s);
      if(!restored.ok){await this.halt('LIVE_EVENT_NOT_AUTHORIZED:'+restored.reason);
        return json({ok:false,error:'LIVE_EVENT_NOT_AUTHORIZED',reason:restored.reason,stopped:true},409);}
    }
    if(s.sessionKind!=='LIVE'&&this.liveEnabled()){await this.halt('DRY_RUN_CONFIG_CHANGED');return json({ok:false,error:'DRY_RUN_CONFIG_CHANGED',stopped:true},409);}
    const id=`${coin}:${fill_id}`;
    if(s.seen[id])return json({ok:true,duplicate:true,exchange_order_sent:false});
    if(s.sessionKind==='DRY_RUN')await this.paperMark(coin,price);
    const old=s.coins[coin];
    if(old&&time<old.lastEventAt)return json({ok:false,error:'OUT_OF_ORDER_EVENT'},409);
    if(this.liveAuthorized(s)){
      const eventMs=time<1e11?time*1000:time;
      if(eventMs-Date.now()>30000)return json({ok:false,error:'FUTURE_WHALE_FILL',eventMs},409);
      if(Date.now()-eventMs>300000){
        // Do not trade stale fills. Quarantine this coin while preserving the
        // whale's source target chain, so OTHER coins may proceed.
        if(old)s.coins[coin]={...old,lastWhaleTarget:whale_target_qty,
          lastEventAt:time,lastFillId:fill_id,suspended:true};
        const staleLedger=await this.ledger();
        await this.state.storage.put('live_copy_v23_ledger',{
          ...staleLedger,suspendedCoins:{...staleLedger.suspendedCoins,[coin]:true}});
        s.seen[id]=Date.now();this.audit(s,'STALE_FILL_COIN_QUARANTINED',coin,`fill=${fill_id}; eventMs=${eventMs}`);
        await this.save(s);return json({ok:true,ignored:true,quarantined:true,reason:'STALE_FILL_COIN_QUARANTINED'});
      }
      const existingLedger=await this.ledger();
      const unresolved=Object.values(existingLedger.intents).some(i=>i.coin===coin&&
        ['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status));
      if(unresolved||existingLedger.suspendedCoins[coin]||old?.suspended){
        if(old)s.coins[coin]={...old,lastWhaleTarget:whale_target_qty,lastEventAt:time,lastFillId:fill_id};
        s.seen[id]=Date.now();
        this.audit(s,'COIN_EVENT_QUARANTINED',coin,`fill=${fill_id}; unresolved=${unresolved}; manual_or_stale_suspend=${!!existingLedger.suspendedCoins[coin]}`);
        await this.save(s);
        return json({ok:true,ignored:true,quarantined:true,reason:'COIN_PENDING_VERIFICATION_OR_SUSPENDED'});
      }
    }
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
      assertPositionOwned(ledger,coin,account.positions.find((p:any)=>p.coin===coin)?.qty||0,sz_decimals);
    }catch(e){if(this.isRateLimited(e)){const retryAt=await this.deferRateLimit('PRE_TRADE_READ_ONLY_CHECK');return json({ok:false,error:'HYPERLIQUID_RATE_LIMIT_BACKOFF',retryable:true,retry_at:retryAt,exchange_order_sent:false},503);}
      record.suspended=true;s.coins[coin]=record;s.seen[id]=Date.now();
      this.audit(s,'PRE_TRADE_COIN_QUARANTINED',coin,String(e).slice(0,200));await this.save(s);
      return json({ok:true,ignored:true,quarantined:true,reason:'PRE_TRADE_CHECK_FAILED',detail:String(e)});}
    if(Object.values(ledger.intents).some(i=>i.coin===coin&&['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status))){
      s.coins[coin]={...record,suspended:true};s.seen[id]=Date.now();
      this.audit(s,'COIN_UNRESOLVED_BLOCKED',coin,'Previous order still pending verification');await this.save(s);
      return json({ok:true,ignored:true,quarantined:true,reason:'UNRESOLVED_INTENT_BEFORE_NEW_ORDER'});}
    const intentId=`AUTO:${coin}:${fill_id}`;
    let planned;
    try{planned=planAndReserve({state:record,ledger,whaleTargetQty:whale_target_qty,price:markPrice,szDecimals:sz_decimals,sourceFillId:fill_id,intentId,now:Date.now()});}
    catch(e){record.suspended=true;s.coins[coin]=record;s.seen[id]=Date.now();
      this.audit(s,'INTENT_PLANNING_COIN_QUARANTINED',coin,String(e).slice(0,120));await this.save(s);
      return json({ok:true,ignored:true,quarantined:true,reason:'INTENT_PLANNING_FAILED',detail:String(e)});}
    if(!planned.intent){s.coins[coin]=record;s.seen[id]=Date.now();this.audit(s,'LIVE_ACCUMULATING',coin,planned.proposal.reason+` pending_usd=${planned.proposal.pendingNotional.toFixed(4)}`);await this.save(s);return json({ok:true,proposal:planned.proposal,exchange_order_sent:false,trading_enabled:true});}
    // Persist the reservation and in-flight state BEFORE the exchange request.
    // Persist deterministic exchange client ID BEFORE the order request. A
    // crashed/timeout response can later be verified by orderStatus(cloid).
    planned.ledger.intents[intentId]={...planned.ledger.intents[intentId],exchangeCloid:cloidForIntent(intentId)};
    await this.state.storage.put('live_copy_v23_ledger',planned.ledger);
    s.coins[coin]=planned.state as Coin;await this.save(s);
    this.audit(s,'OUR_ORDER_SUBMITTING',coin,`${planned.proposal.kind} qty=${planned.proposal.quantity} reference=${markPrice} reduceOnly=${planned.proposal.reduceOnly}`);await this.save(s);
    const submitting=beginSubmission(planned.state,planned.ledger,intentId,Date.now());
    await this.state.storage.put('live_copy_v23_ledger',submitting.ledger);
    let receipt;let orderWasSent:boolean|'UNKNOWN'='UNKNOWN';let exchangeRateLimited=false;
    try{
      const result=await executeLiveIoc(this.env,{intentId,coin,direction:planned.proposal.signedDelta>0?'LONG':'SHORT',quantity:planned.proposal.quantity,reduceOnly:planned.proposal.reduceOnly,referencePrice:markPrice});
      orderWasSent=result.orderSent??(result.executed?true:'UNKNOWN');
      exchangeRateLimited=this.isRateLimited(result.raw);
      receipt={intentId,coin,status:result.status,executed:result.executed,filledQty:result.filledQty,requestedQty:result.requestedQty,oid:result.oid};
    }catch(e){receipt={intentId,coin,status:'UNKNOWN_WRITE_OUTCOME',executed:false};}
    let settled;
    try{settled=applyTrustedReceipt(submitting.state,submitting.ledger,receipt,Date.now());}
    catch(e){await this.halt('SETTLEMENT_FAILED:'+String(e).slice(0,120),coin);return json({ok:false,error:'SETTLEMENT_FAILED_RECONCILE',detail:String(e)},409);}
    await this.state.storage.put('live_copy_v23_ledger',settled.ledger);
    s.coins[coin]=settled.state as Coin;
    this.audit(s,'LIVE_ORDER_'+settled.outcome,coin,`${planned.proposal.kind} qty=${planned.proposal.quantity} result=${receipt.status} filled=${receipt.filledQty??'unknown'} oid=${receipt.oid??'unknown'} intent=${intentId}`);
    if(settled.outcome==='UNKNOWN'||settled.outcome==='PARTIAL'){
      // A failed network response can still represent a real exchange fill.
      // Keep this intent blocked, but NEVER halt other unrelated coins.
      s.seen[id]=Date.now();
      this.audit(s,'COIN_AWAITING_ORDER_VERIFICATION',coin,`intent=${intentId}; outcome=${settled.outcome}; no_resubmit=true`);
      await this.save(s);
      if(exchangeRateLimited)await this.deferRateLimit('EXCHANGE_WRITE_UNKNOWN');
      return json({ok:true,quarantined:true,reason:'ORDER_RESULT_PENDING_VERIFICATION',
        outcome:settled.outcome,intentId,exchange_order_sent:'UNKNOWN',trading_enabled:true});
    }
    s.seen[id]=Date.now();await this.save(s);
    if(exchangeRateLimited)await this.deferRateLimit('EXCHANGE_RESPONSE');
    return json({ok:true,proposal:planned.proposal,outcome:settled.outcome,intentId,exchange_order_sent:orderWasSent,trading_enabled:true});
  }
}

