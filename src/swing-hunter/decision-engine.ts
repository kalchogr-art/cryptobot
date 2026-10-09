import type {Candidate,CandleSet,Structure,Pattern} from './types';
import {structure} from './market-structure';
import {detectBreakout} from './patterns';
export function decide(coin:string,h1:CandleSet,h4:CandleSet,d1:CandleSet):Candidate{
  const reasons:string[]=[];const base={coin,observedAt:new Date().toISOString()};
  for(const x of [h1,h4,d1])if(x.invalid||x.gaps||x.duplicates||x.closed.length<60)reasons.push(`${x.interval}: incomplete or invalid history`);
  if(reasons.length)return {...base,mode:'NONE',side:'NEUTRAL',status:'NO_SIGNAL',entry:null,stop:null,target:null,rr:null,pattern:null,reason:reasons};
  const a=structure(h1.closed),b=structure(h4.closed),d=structure(d1.closed);
  const p4=detectBreakout(h4.closed,b),p1=detectBreakout(h1.closed,a);
  const useSwing=!!p4?.confirmed&&p4.direction===d.direction;
  const p:Pattern|null=useSwing?p4:(p1?.confirmed&&p1.direction===b.direction&&p1.direction===d.direction?p1:null);
  if(!p){reasons.push('No fully confirmed breakout aligned with higher timeframes');return {...base,mode:'NONE',side:'NEUTRAL',status:'NO_SIGNAL',entry:null,stop:null,target:null,rr:null,pattern:p4||p1,reason:reasons};}
  const mode=useSwing?'SWING':'INTRADAY';const frame:Structure=useSwing?b:a;
  const entry=frame.close,stop=p.direction==='LONG'?entry-1.5*frame.atr14:entry+1.5*frame.atr14;
  const risk=Math.abs(entry-stop);const rr=useSwing?2.5:2;const target=p.direction==='LONG'?entry+rr*risk:entry-rr*risk;
  if(!Number.isFinite(target)||target<=0||risk<=0){reasons.push('Invalid ATR-based risk');return {...base,mode:'NONE',side:'NEUTRAL',status:'NO_SIGNAL',entry:null,stop:null,target:null,rr:null,pattern:p,reason:reasons};}
  reasons.push('Research-only candidate; ATR stop and target are hypothetical; no orders');
  return {...base,mode,side:p.direction,status:'CANDIDATE',entry,stop,target,rr,pattern:p,reason:reasons};
}
