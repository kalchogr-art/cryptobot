import type {Candidate} from './types';
/** Stateless read-only projection. No persistence and no claims of executed fills. */
export function shadowProjection(c:Candidate,feePerSidePct=0.05){
  if(c.status!=='CANDIDATE'||c.entry===null||c.stop===null||c.target===null)return {status:'NO_TRADE',persisted:false};
  const sign=c.side==='LONG'?1:-1;
  const tpGross=sign*(c.target/c.entry-1)*100,slGross=sign*(c.stop/c.entry-1)*100;
  return {status:'HYPOTHETICAL_ONLY',persisted:false,entry:c.entry,stop:c.stop,target:c.target,rr:c.rr,
    assumed_fee_pct_each_side:feePerSidePct,estimated_tp_net_pct:tpGross-2*feePerSidePct,estimated_sl_net_pct:slGross-2*feePerSidePct,
    caveat:'Excludes funding, slippage, liquidation and execution; no future-outcome tracking in V1.'};
}
