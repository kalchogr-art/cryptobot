/** Stage 5: conservative exchange-result settlement for LIVE COPY.
 * Pure functions; NEVER sends an exchange order. A confirmed fill is not
 * inferred from HTTP 200, wallet delta, or an unverified client payload.
 */
import { type LiveLedger, recordExchangeFill, markRejected, markUnknown } from './live-copy-ledger-v2.3';

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
  if (receipt.status==='REJECTED' && !receipt.executed) {
    return {ledger:markRejected(ledger,intent.id,now,'EXCHANGE_REJECTED'),outcome:'REJECTED',reason:'EXCHANGE_REJECTED'};
  }
  return {ledger:markUnknown(ledger,intent.id,now,'AMBIGUOUS_OR_UNFILLED_EXCHANGE_RESPONSE'),outcome:'UNKNOWN',reason:'RECONCILE_BEFORE_RETRY'};
}
