import type {Candle,Direction,Structure} from './types';
export type PatternHit={id:string;name:string;side:'LONG'|'SHORT';frame:'1h'|'4h';strength:number;confirmed:boolean;details:string;signalBarOpen:number};
const avg=(a:number[])=>a.reduce((x,y)=>x+y,0)/Math.max(1,a.length);
const max=(a:Candle[])=>Math.max(...a.map(x=>x.h));
const min=(a:Candle[])=>Math.min(...a.map(x=>x.l));
const hit=(id:string,name:string,side:'LONG'|'SHORT',frame:'1h'|'4h',c:Candle[],strength:number,details:string):PatternHit=>({id,name,side,frame,strength:Math.round(Math.min(100,Math.max(1,strength))),confirmed:true,details,signalBarOpen:c[c.length-1].t});
/** Finite, deterministic catalog of 15 price/volume setups; not a claim to cover every conceivable pattern. */
export function detectCatalog(c:Candle[],s:Structure,frame:'1h'|'4h'):PatternHit[]{
 if(c.length<65)return [];
 const out:PatternHit[]=[],z=c.length-1,b=c[z],p=c[z-1],q=c[z-2],prior=c.slice(-21,-1);
 const range=Math.max(s.atr14,1e-10),v=avg(prior.map(x=>x.v)),vr=v>0?b.v/v:0;
 const body=Math.abs(b.c-b.o),height=Math.max(b.h-b.l,1e-10),upper=b.h-Math.max(b.c,b.o),lower=Math.min(b.c,b.o)-b.l;
 const bull=b.c>b.o,bear=b.c<b.o;
 const add=(cond:boolean,id:string,name:string,side:'LONG'|'SHORT',strength:number,details:string)=>{if(cond)out.push(hit(id,name,side,frame,c,strength,details));};
 const hi=max(prior),lo=min(prior);
 add(b.c>hi&&bull&&vr>=1.2,'RANGE_BREAKOUT','20-bar range breakout','LONG',60+vr*10,`Above ${hi}; volume ${vr.toFixed(2)}x`);
 add(b.c<lo&&bear&&vr>=1.2,'RANGE_BREAKDOWN','20-bar range breakdown','SHORT',60+vr*10,`Below ${lo}; volume ${vr.toFixed(2)}x`);
 add(b.l<lo&&b.c>lo&&bull&&lower/height>0.35,'LIQUIDITY_SWEEP_LOW','Liquidity sweep below support','LONG',65+lower/height*25,'Swept prior low and closed back above');
 add(b.h>hi&&b.c<hi&&bear&&upper/height>0.35,'LIQUIDITY_SWEEP_HIGH','Liquidity sweep above resistance','SHORT',65+upper/height*25,'Swept prior high and closed back below');
 add(bull&&p.c<p.o&&b.o<=p.c&&b.c>=p.o&&body/height>0.55,'BULL_ENGULF','Bullish engulfing','LONG',67,'Body engulfs preceding bearish body');
 add(bear&&p.c>p.o&&b.o>=p.c&&b.c<=p.o&&body/height>0.55,'BEAR_ENGULF','Bearish engulfing','SHORT',67,'Body engulfs preceding bullish body');
 add(bull&&lower/height>=0.6&&body/height<=0.35,'HAMMER','Bullish hammer','LONG',58,'Long lower wick, bullish close');
 add(bear&&upper/height>=0.6&&body/height<=0.35,'SHOOTING_STAR','Shooting star','SHORT',58,'Long upper wick, bearish close');
 add(bull&&p.c<p.o&&q.c<q.o&&b.c>p.h&&vr>=1,'MOMENTUM_REVERSAL_LONG','Three-bar momentum reversal','LONG',65,'Two red bars followed by strong bullish recovery');
 add(bear&&p.c>p.o&&q.c>q.o&&b.c<p.l&&vr>=1,'MOMENTUM_REVERSAL_SHORT','Three-bar momentum reversal','SHORT',65,'Two green bars followed by strong bearish recovery');
 const recent=c.slice(-9,-1),localHigh=max(recent),localLow=min(recent);
 add(s.direction==='LONG'&&p.l<=s.ema20+range*0.35&&p.l>=s.ema20-range*1.5&&b.c>p.h&&bull,'EMA_PULLBACK_LONG','EMA20 pullback continuation','LONG',64,'Pullback near EMA20 then bullish continuation');
 add(s.direction==='SHORT'&&p.h>=s.ema20-range*0.35&&p.h<=s.ema20+range*1.5&&b.c<p.l&&bear,'EMA_PULLBACK_SHORT','EMA20 pullback continuation','SHORT',64,'Pullback near EMA20 then bearish continuation');
 add(p.l<=localHigh&&p.c>localHigh&&b.c>p.h&&bull&&vr>=1,'BREAKOUT_RETEST_LONG','Breakout and retest','LONG',72,'Reclaimed former resistance and continued');
 add(p.h>=localLow&&p.c<localLow&&b.c<p.l&&bear&&vr>=1,'BREAKOUT_RETEST_SHORT','Breakdown and retest','SHORT',72,'Rejected former support and continued');
 const left=c.slice(-31,-16),right=c.slice(-15,-1);
 if(left.length===15&&right.length===14){
  const leftLow=min(left),rightLow=min(right),leftHigh=max(left),rightHigh=max(right);
  add(Math.abs(leftLow-rightLow)<=range*0.7&&b.c>max(c.slice(-8,-1))&&bull&&b.c>p.c,'DOUBLE_BOTTOM','Double bottom breakout','LONG',70,'Two comparable swing lows, recent high cleared');
  add(Math.abs(leftHigh-rightHigh)<=range*0.7&&b.c<min(c.slice(-8,-1))&&bear&&b.c<p.c,'DOUBLE_TOP','Double top breakdown','SHORT',70,'Two comparable swing highs, recent low broken');
 }
 const highs=c.slice(-12,-1).map(x=>x.h),lows=c.slice(-12,-1).map(x=>x.l);
 const contracting=highs.slice(-4).every((x,i,a)=>i===0||x<=a[i-1]+range*.15)&&lows.slice(-4).every((x,i,a)=>i===0||x>=a[i-1]-range*.15);
 add(contracting&&b.c>max(c.slice(-6,-1))&&bull&&vr>=1.2,'TRIANGLE_UP','Compression breakout up','LONG',70,'Tightening range and upside close');
 add(contracting&&b.c<min(c.slice(-6,-1))&&bear&&vr>=1.2,'TRIANGLE_DOWN','Compression breakout down','SHORT',70,'Tightening range and downside close');
 const atrPct=range/b.c;
 add(s.direction==='LONG'&&b.c>hi&&vr>=1.5&&atrPct<0.08,'VOLUME_EXPANSION_LONG','Volume expansion breakout','LONG',65+vr*8,'Breakout with strong relative volume');
 add(s.direction==='SHORT'&&b.c<lo&&vr>=1.5&&atrPct<0.08,'VOLUME_EXPANSION_SHORT','Volume expansion breakdown','SHORT',65+vr*8,'Breakdown with strong relative volume');
 return out;
}
export const CATALOG_IDS=['RANGE_BREAKOUT','RANGE_BREAKDOWN','LIQUIDITY_SWEEP_LOW','LIQUIDITY_SWEEP_HIGH','BULL_ENGULF','BEAR_ENGULF','HAMMER','SHOOTING_STAR','MOMENTUM_REVERSAL_LONG','MOMENTUM_REVERSAL_SHORT','EMA_PULLBACK_LONG','EMA_PULLBACK_SHORT','BREAKOUT_RETEST_LONG','BREAKOUT_RETEST_SHORT','DOUBLE_BOTTOM','DOUBLE_TOP','TRIANGLE_UP','TRIANGLE_DOWN','VOLUME_EXPANSION_LONG','VOLUME_EXPANSION_SHORT'];
