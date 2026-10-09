import {fetchClosed,quality,COINS} from './ohlcv';
import type {Interval} from './types';
import {decide} from './decision-engine';
import {shadowProjection} from './shadow-trades';
import {dashboard} from './dashboard';

const json=(x:unknown,status=200)=>new Response(JSON.stringify(x,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
type AuthEnv={RESEARCH_EXPORT_KEY?:string};
const allowed=(req:Request,env:AuthEnv)=>!!env.RESEARCH_EXPORT_KEY&&req.headers.get('authorization')===`Bearer ${env.RESEARCH_EXPORT_KEY}`;
export async function handleSwingHunterRequest(req:Request,env:AuthEnv):Promise<Response>{
  const u=new URL(req.url);
  if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
  if(u.pathname==='/swing-hunter')return new Response(dashboard(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(!allowed(req,env))return json({success:false,error:'UNAUTHORIZED',hint:'Set RESEARCH_EXPORT_KEY secret and send Authorization: Bearer <key>'},401);
  if(u.pathname==='/api/swing'||u.pathname==='/api/swing/status')
    return json({success:true,module:'SWING_HUNTER_V1',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,scheduled:false,coins:COINS.length,routes:['/swing-hunter','/api/swing/status','/api/swing/ohlcv','/api/swing/analyze','/api/swing/structure','/api/swing/patterns','/api/swing/decision','/api/swing/shadow','/api/swing/dashboard']});
  if(u.pathname==='/api/swing/dashboard')return json({success:true,module:'SWING_HUNTER_V1',mode:'READ_ONLY',dashboard:'/swing-hunter'});
  const coin=(u.searchParams.get('coin')||'BTC').toUpperCase();
  if(!(COINS as readonly string[]).includes(coin))return json({success:false,error:'INVALID_COIN'},400);
  try {
    if(u.pathname==='/api/swing/ohlcv'){
      const interval=(u.searchParams.get('interval')||'4h') as Interval;
      const count=Number(u.searchParams.get('count')||100);
      const x=await fetchClosed(coin,interval,count);
      return json({success:true,mode:'READ_ONLY',d1_queries:0,...quality(x)});
    }
    if(!['/api/swing/analyze','/api/swing/structure','/api/swing/patterns','/api/swing/decision','/api/swing/shadow'].includes(u.pathname))
      return json({success:false,error:'NOT_FOUND'},404);
    const [h1,h4,d1]=await Promise.all([fetchClosed(coin,'1h'),fetchClosed(coin,'4h'),fetchClosed(coin,'1d')]);
    const qualities=[quality(h1),quality(h4),quality(d1)].map(({last3,...q})=>q);
    if(u.pathname==='/api/swing/structure'){
      const {structure}=await import('./market-structure');
      return json({success:true,coin,quality:qualities,structure:{'1h':structure(h1.closed),'4h':structure(h4.closed),'1d':structure(d1.closed)}});
    }
    if(u.pathname==='/api/swing/patterns'){
      const {structure}=await import('./market-structure');
      const {detectBreakout}=await import('./patterns');
      return json({success:true,coin,quality:qualities,patterns:{'1h':detectBreakout(h1.closed,structure(h1.closed)),'4h':detectBreakout(h4.closed,structure(h4.closed))}});
    }
    const candidate=decide(coin,h1,h4,d1);
    if(u.pathname==='/api/swing/decision')return json({success:true,coin,quality:qualities,candidate});
    if(u.pathname==='/api/swing/shadow')return json({success:true,coin,shadow:shadowProjection(candidate),note:'Projection only; no trade tracking or D1 writes'});
    return json({success:true,mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,quality:qualities,candidate,shadow:shadowProjection(candidate)});
  } catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502);}
}
