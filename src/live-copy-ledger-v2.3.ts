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
