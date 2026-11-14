/** V2.3 Stage 6: atomic planning/ledger bridge (NO exchange writes).
 * Call only inside a serialized Durable Object. Persist returned state+ledger
 * together before an order is submitted. Never call this from a browser.
 */
import {planCopyAction, type CopyCoinState, type CopyProposal} from './live-copy-accumulator-v2.3';
import {prepareIntent, markSubmitting, settleVerifiedOrder, type LiveLedger, type CopyIntent} from './live-copy-ledger-v2.3';
import {settleExchangeReceipt, type ExchangeReceipt} from './live-copy-settlement-v2.3';

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
