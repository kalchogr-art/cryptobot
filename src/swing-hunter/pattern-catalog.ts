import type { Candle, Structure } from './types';
import { detectCatalog, type PatternHit } from './pattern-catalog';

/** SHADOW ONLY: 20 V1 + 20 stricter V2 + 10 classic V3 + 10 stricter V4.
 * All detectors use closed candles only. V2 is a NEW conservative candidate,
 * not a recovered copy of any previously tested V2 implementation.
 */
type Frame = '1h' | '4h';
type Side = 'LONG' | 'SHORT';
type Version = 'V1' | 'V2' | 'V3' | 'V4';
export type VersionedHit = PatternHit & { version: Version; baseId: string };
const mean = (v: number[]) => v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0;
const clamp = (v:number) => Math.max(1,Math.min(100,Math.round(v)));
const hi = (a:Candle[]) => Math.max(...a.map(x=>x.h));
const lo = (a:Candle[]) => Math.min(...a.map(x=>x.l));
const body = (x:Candle) => Math.abs(x.c-x.o);
const range = (x:Candle) => Math.max(1e-12,x.h-x.l);
const bull = (x:Candle) => x.c>x.o;
const bear = (x:Candle) => x.c<x.o;
function pivot(c:Candle[],i:number,high:boolean,r=2):boolean {
  if(i<r||i+r>=c.length)return false;
  const v=high?c[i].h:c[i].l;
  for(let j=i-r;j<=i+r;j++)if(j!==i&&(high?c[j].h>=v:c[j].l<=v))return false;
  return true;
}
const near=(a:number,b:number,t:number)=>Math.abs(a-b)<=t;
function volumeRatio(c:Candle[]):number {const m=mean(c.slice(-21,-1).map(x=>x.v));return m>0?c[c.length-1].v/m:0;}
function v2Pass(h:PatternHit,c:Candle[],s:Structure):boolean {
  const b=c[c.length-1],p=c[c.length-2],prev=c.slice(-21,-1),atr=Number(s.atr14);
  const vr=volumeRatio(c),bfrac=body(b)/range(b);
  const directional=h.side==='LONG'?bull(b):bear(b);
  if(!directional||!Number.isFinite(atr)||atr<=0)return false;
  // Tighten existing V1 hits without changing their base detection rules.
  switch(h.id){
    case 'RANGE_BREAKOUT':case 'RANGE_BREAKDOWN':return vr>=1.5&&bfrac>=0.58&&body(b)>=atr*.55;
    case 'LIQUIDITY_SWEEP_LOW':return (Math.min(b.o,b.c)-b.l)/range(b)>=.5&&vr>=1.05;
    case 'LIQUIDITY_SWEEP_HIGH':return (b.h-Math.max(b.o,b.c))/range(b)>=.5&&vr>=1.05;
    case 'BULL_ENGULF':case 'BEAR_ENGULF':return bfrac>=.68&&body(b)>=body(p)*1.3&&vr>=1.05;
    case 'HAMMER':case 'SHOOTING_STAR':return vr>=1.1&&body(b)/range(b)<=.25;
    case 'MOMENTUM_REVERSAL_LONG':case 'MOMENTUM_REVERSAL_SHORT':return vr>=1.3&&bfrac>=.6;
    case 'EMA_PULLBACK_LONG':case 'EMA_PULLBACK_SHORT':return bfrac>=.55&&vr>=1.1;
    case 'BREAKOUT_RETEST_LONG':case 'BREAKOUT_RETEST_SHORT':return vr>=1.25&&bfrac>=.55;
    case 'DOUBLE_BOTTOM':case 'DOUBLE_TOP':return vr>=1.35&&body(b)>=atr*.45;
    case 'TRIANGLE_UP':case 'TRIANGLE_DOWN':return vr>=1.4&&bfrac>=.55;
    case 'VOLUME_EXPANSION_LONG':case 'VOLUME_EXPANSION_SHORT':return vr>=2.1&&bfrac>=.65;
    default:return false;
  }
}
function classic(c:Candle[],s:Structure,frame:Frame,strict:boolean):PatternHit[]{
  if(c.length<65)return [];
  const z=c.length-1,b=c[z],p=c[z-1],atr=Number(s.atr14),vr=volumeRatio(c);
  if(!Number.isFinite(atr)||atr<=0||!Number.isFinite(vr))return [];
  const out:PatternHit[]=[];
  const add=(ok:boolean,id:string,name:string,side:Side,level:number,detail:string)=>{
    if(!ok)return;
    // V4 is a strict subset of V3; confirm stronger breakout + participation.
    if(strict){
      if(vr<1.35||body(b)/range(b)<.55||body(b)<atr*.45)return;
      if(side==='LONG' ? !(b.c>level+atr*.12) : !(b.c<level-atr*.12))return;
    }
    out.push({id,name,side,frame,strength:clamp(65+vr*8+(strict?8:0)),confirmed:true,
      details:`${detail}; level=${level.toFixed(8)}; volume=${vr.toFixed(2)}x`,signalBarOpen:b.t});
  };
  // Confirmed pivot geometry: last 2 candles excluded from pivots.
  const from=Math.max(3,z-55),to=z-3;
  const highs:number[]=[],lows:number[]=[];
  for(let i=from;i<=to;i++){if(pivot(c,i,true))highs.push(i);if(pivot(c,i,false))lows.push(i);}
  const last3=(a:number[])=>a.slice(-3);
  const hh=last3(highs),ll=last3(lows);
  const minGap=(a:number[])=>a.length===3&&a[1]-a[0]>=3&&a[2]-a[1]>=3&&z-a[2]<=20;
  // Head & Shoulders / inverse: center extremum + near-symmetric shoulders;
  // neckline from two intervening troughs/peaks, break on current candle.
  if(minGap(hh)){
    const [a,m,d]=hh,shoulders=near(c[a].h,c[d].h,atr*.9),head=c[m].h>Math.max(c[a].h,c[d].h)+atr*.45;
    const n1=lo(c.slice(a+1,m)),n2=lo(c.slice(m+1,d));
    const neckline=(n1+n2)/2;
    add(shoulders&&head&&near(n1,n2,atr*1.3)&&p.c>=neckline&&b.c<neckline&&bear(b),
      'HEAD_SHOULDERS','Head & Shoulders','SHORT',neckline,'Three confirmed peaks and neckline break');
  }
  if(minGap(ll)){
    const [a,m,d]=ll,shoulders=near(c[a].l,c[d].l,atr*.9),head=c[m].l<Math.min(c[a].l,c[d].l)-atr*.45;
    const n1=hi(c.slice(a+1,m)),n2=hi(c.slice(m+1,d));
    const neckline=(n1+n2)/2;
    add(shoulders&&head&&near(n1,n2,atr*1.3)&&p.c<=neckline&&b.c>neckline&&bull(b),
      'INVERSE_HEAD_SHOULDERS','Inverse Head & Shoulders','LONG',neckline,'Three confirmed troughs and neckline break');
  }
  // Triple tops/bottoms: three comparable confirmed extrema, fresh neckline break.
  if(minGap(hh)){
    const [a,m,d]=hh,vals=hh.map(i=>c[i].h),neckline=Math.min(lo(c.slice(a+1,m)),lo(c.slice(m+1,d)));
    add(Math.max(...vals)-Math.min(...vals)<=atr*.85&&Math.min(...vals)-neckline>=atr&&p.c>=neckline&&b.c<neckline&&bear(b),
      'TRIPLE_TOP','Triple Top','SHORT',neckline,'Three comparable swing highs and support break');
  }
  if(minGap(ll)){
    const [a,m,d]=ll,vals=ll.map(i=>c[i].l),neckline=Math.max(hi(c.slice(a+1,m)),hi(c.slice(m+1,d)));
    add(Math.max(...vals)-Math.min(...vals)<=atr*.85&&neckline-Math.max(...vals)>=atr&&p.c<=neckline&&b.c>neckline&&bull(b),
      'TRIPLE_BOTTOM','Triple Bottom','LONG',neckline,'Three comparable swing lows and resistance break');
  }
  // Flags: prior impulse 8 bars, short 6-bar countertrend channel, fresh break.
  const pole=c.slice(z-14,z-6),flag=c.slice(z-6,z),poleMove=pole.at(-1)!.c-pole[0].o;
  const flagHigh=hi(flag),flagLow=lo(flag),half=Math.floor(flag.length/2);
  const early=mean(flag.slice(0,half).map(x=>x.c)),late=mean(flag.slice(half).map(x=>x.c));
  add(poleMove>=atr*2.2&&late<early&&flagHigh-flagLow<=Math.abs(poleMove)*.75&&p.c<=flagHigh&&b.c>flagHigh&&bull(b),
    'BULL_FLAG','Bull Flag','LONG',flagHigh,'Strong upward pole, descending flag and breakout');
  add(poleMove<=-atr*2.2&&late>early&&flagHigh-flagLow<=Math.abs(poleMove)*.75&&p.c>=flagLow&&b.c<flagLow&&bear(b),
    'BEAR_FLAG','Bear Flag','SHORT',flagLow,'Strong downward pole, ascending flag and breakdown');
  // Wedges: last two confirmed highs and lows move in same direction, contracting width.
  if(highs.length>=2&&lows.length>=2){
    const [ha,hb]=highs.slice(-2),[la,lb]=lows.slice(-2);
    if(Math.abs(ha-la)<=12&&Math.abs(hb-lb)<=12&&hb-ha>=3&&lb-la>=3){
      const h1=c[ha].h,h2=c[hb].h,l1=c[la].l,l2=c[lb].l;
      const w1=h1-l1,w2=h2-l2;
      const shrinking=w1>atr&&w2>0&&w2<w1*.85;
      add(shrinking&&h2>h1&&l2>l1&&(l2-l1)>(h2-h1)&&p.c>=l2&&b.c<l2&&bear(b),
        'RISING_WEDGE','Rising Wedge','SHORT',l2,'Rising converging swing boundaries and breakdown');
      add(shrinking&&h2<h1&&l2<l1&&(h1-h2)>(l1-l2)&&p.c<=h2&&b.c>h2&&bull(b),
        'FALLING_WEDGE','Falling Wedge','LONG',h2,'Falling converging swing boundaries and breakout');
    }
  }
  // Cup: rounded bowl / inverse bowl across 30 bars, then 6-bar handle.
  const cup=c.slice(z-36,z-6),handle=c.slice(z-6,z);
  const left=mean(cup.slice(0,5).map(x=>x.c)),mid=mean(cup.slice(12,18).map(x=>x.c)),right=mean(cup.slice(-5).map(x=>x.c));
  const rim=(left+right)/2,handleHi=hi(handle),handleLo=lo(handle);
  add(near(left,right,atr*1.4)&&rim-mid>=atr*1.6&&handleLo>=mid+(rim-mid)*.45&&p.c<=Math.max(rim,handleHi)&&b.c>Math.max(rim,handleHi)&&bull(b),
    'CUP_HANDLE','Cup & Handle','LONG',Math.max(rim,handleHi),'Rounded bowl, shallow handle and resistance breakout');
  add(near(left,right,atr*1.4)&&mid-rim>=atr*1.6&&handleHi<=mid-(mid-rim)*.45&&p.c>=Math.min(rim,handleLo)&&b.c<Math.min(rim,handleLo)&&bear(b),
    'INVERSE_CUP_HANDLE','Inverse Cup & Handle','SHORT',Math.min(rim,handleLo),'Rounded dome, shallow handle and support breakdown');
  return out;
}
export function detectVersionedCatalog(c:Candle[],s:Structure,frame:Frame):VersionedHit[]{
  if(c.length<65)return [];
  const base=detectCatalog(c,s,frame);
  const stamp=(h:PatternHit,version:Version):VersionedHit=>({...h,version,baseId:h.id});
  const v1=base.map(h=>stamp(h,'V1'));
  const v2=base.filter(h=>v2Pass(h,c,s)).map(h=>stamp(h,'V2'));
  const v3=classic(c,s,frame,false).map(h=>stamp(h,'V3'));
  const v4=classic(c,s,frame,true).map(h=>stamp(h,'V4'));
  return [...v1,...v2,...v3,...v4];
}
