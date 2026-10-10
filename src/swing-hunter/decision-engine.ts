import type {Candidate,CandleSet,Structure,Pattern} from './types';
import {structure} from './market-structure';
import {detectBreakout} from './patterns';
import {detectCatalog,PatternHit} from './pattern-catalog';
export type PatternCandidate=Candidate & {triggerPatterns:PatternHit[];supportingPatterns:PatternHit[];signalKey:string|null;signalBarOpen:number|null;rule:'CATALOG_V1'|'NONE'};
/** V1.6 Swing Hunter ONLY. Existing live trading strategies are not connected to this function. */
export function decide(coin:string,h1:CandleSet,h4:CandleSet,d1:CandleSet):PatternCandidate{
 const base={coin,observedAt:new Date().toISOString(),triggerPatterns:[] as PatternHit[],supportingPatterns:[] as PatternHit[],signalKey:null as string|null,signalBarOpen:null as number|null,rule:'NONE' as const};
 const fail=(reason:string,pattern:Pattern|null=null):PatternCandidate=>({...base,mode:'NONE',side:'NEUTRAL',status:'NO_SIGNAL',entry:null,stop:null,target:null,rr:null,pattern,reason:[reason]});
 if([h1,h4,d1].some(x=>x.invalid||x.gaps||x.duplicates||x.closed.length<65))return fail('Incomplete/invalid history');
 const a=structure(h1.closed),b=structure(h4.closed),d=structure(d1.closed);
 const h1hits=detectCatalog(h1.closed,a,'1h'),h4hits=detectCatalog(h4.closed,b,'4h');
 // A candidate requires trend confirmation on the signal frame and at least one higher frame.
 const eligible=(hits:PatternHit[],frame:Structure,higher:Structure[])=>hits.filter(p=>p.side===frame.direction&&higher.some(x=>x.direction===p.side));
 const swing=eligible(h4hits,b,[d]);const intra=eligible(h1hits,a,[b,d]);
 const mode=swing.length?'SWING':intra.length?'INTRADAY':null;
 const matches=mode==='SWING'?swing:mode==='INTRADAY'?intra:[];
 if(!mode)return {...fail('No catalog pattern confirmed with trend and higher-timeframe alignment'),supportingPatterns:[...h1hits,...h4hits]};
 const frame=mode==='SWING'?b:a,series=mode==='SWING'?h4.closed:h1.closed,side=matches[0].side;
 const triggers=matches.filter(p=>p.side===side).sort((x,y)=>y.strength-x.strength);
 const primary=triggers[0],risk=1.5*frame.atr14,rr=mode==='SWING'?2.5:2,entry=frame.close;
 if(!Number.isFinite(risk)||risk<=0||entry<=0)return fail('Invalid ATR risk');
 const stop=side==='LONG'?entry-risk:entry+risk,target=side==='LONG'?entry+rr*risk:entry-rr*risk;
 const legacy=detectBreakout(series,frame);
 const pattern:Pattern={name:primary.id,direction:side,confirmed:true,breakoutLevel:entry,stopReference:stop,confidence:primary.strength,explanation:primary.details};
 return {...base,rule:'CATALOG_V1',mode,side,status:'CANDIDATE',entry,stop,target,rr,pattern:legacy?.confirmed&&legacy.direction===side?legacy:pattern,
  triggerPatterns:triggers,supportingPatterns:[...h1hits,...h4hits].filter(p=>!triggers.includes(p)),
  signalBarOpen:primary.signalBarOpen,signalKey:`${coin}:${mode}:${side}:${primary.signalBarOpen}`,
  reason:[`Triggered by ${triggers.map(p=>p.id).join(', ')}`,'Research only; no live orders']};
}
