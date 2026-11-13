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
