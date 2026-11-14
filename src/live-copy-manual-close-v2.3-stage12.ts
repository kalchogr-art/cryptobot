/** Stage 12 — manual-close command engine. No UI-provided position sizes trusted.
 * Must be called by the SINGLE serialized Durable Object; persist the ledger
 * at each transition before an external exchange write. LIVE remains disabled
 * until the controller routes are integrated and audited.
 */
import {assertPositionOwned, markSubmitting, markUnknown, prepareIntent, type LiveLedger} from './live-copy-ledger-v2.3';
import {settleExchangeReceipt} from './live-copy-settlement-v2.3';
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
export async function closeOwnedPosition(input:{coin:string;store:LedgerStore;exchange:CloseAdapter;commandId:string;now?:()=>number}):Promise<CloseResult>{
  const {coin,store,exchange,commandId}=input;const now=input.now||Date.now;
  if(!safeCoin(coin)||!/^[-A-Za-z0-9_:]{8,150}$/.test(commandId))throw Error('INVALID_CLOSE_COMMAND');
  const id=`MANUAL:${commandId}:${coin}`;
  let ledger=await store.load();
  const existing=ledger.intents[id];
  if(existing)return {coin,status:existing.status,intentId:id,reason:'EXISTING_COMMAND_NO_RESUBMIT'};
  if(Object.values(ledger.intents).some(i=>i.coin===coin&&['PREPARED','SUBMITTING','UNKNOWN','PARTIAL'].includes(i.status)))
    return {coin,status:'BLOCKED',reason:'UNRESOLVED_INTENT'};
  const positions=await exchange.positions();
  const p=positions.find(x=>x.coin===coin);
  if(!p||!Number.isFinite(p.qty)||p.qty===0){
    if(Math.abs(ledger.confirmedByCoin[coin]||0)>1e-9)throw Error('LEDGER_EXCHANGE_POSITION_MISMATCH');
    return {coin,status:'NO_POSITION'};
  }
  if(!Number.isFinite(p.markPrice)||p.markPrice<=0||!Number.isInteger(p.szDecimals)||p.szDecimals<0||p.szDecimals>8)throw Error('INVALID_EXCHANGE_METADATA');
  assertPositionOwned(ledger,coin,p.qty,p.szDecimals);
  const quantity=quantize(Math.abs(p.qty),p.szDecimals);
  if(quantity<=0)throw Error('QUANTITY_BELOW_PRECISION');
  ledger=prepareIntent(ledger,{id,coin,kind:'MANUAL_CLOSE',side:p.qty>0?'SELL':'BUY',reduceOnly:true,requestedQty:quantity,sourceFillId:`manual:${commandId}`},now());
  await store.save(ledger); // durable reservation BEFORE the write
  ledger=markSubmitting(ledger,id,now());
  await store.save(ledger); // persist SUBMITTING BEFORE the write
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
  const results:CloseResult[]=[];
  for(const p of positions){
    const ledger=await input.store.load();
    if(!Object.prototype.hasOwnProperty.call(ledger.confirmedByCoin,p.coin)){
      results.push({coin:p.coin,status:'SKIPPED',reason:'NOT_OWNED_BY_LIVE_COPY'});continue;
    }
    try{results.push(await closeOwnedPosition({...input,coin:p.coin}));}
    catch(e){results.push({coin:p.coin,status:'BLOCKED',reason:String(e)});}
  }
  return {results,allConfirmedClosed:results.length>0&&results.every(x=>x.status==='FILLED'||x.status==='NO_POSITION')};
}
