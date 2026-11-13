/** Stage 4: read-only reconciliation of LIVE COPY ledger against Hyperliquid.
 * Never adopts pre-existing positions, never assumes an order filled from a balance change.
 */
import type { LiveLedger } from './live-copy-ledger-v2.3';
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
