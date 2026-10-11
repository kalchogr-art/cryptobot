import {scanAndLog,settleSignals,recentSignals} from './signal-logger';
import {tpFirstTouchCoin} from './tp-first-touch';
import {tpSlFirstTouchCoin} from './tp-sl-first-touch';
import {entryResearchCoin} from './entry-research';
import {chartLearningCoin,chartLearningMarket} from './chart-pattern-learning';
import {fetchClosed,quality,COINS} from './ohlcv';
import type {Interval} from './types';
import {decide} from './decision-engine';
import {shadowProjection} from './shadow-trades';
import {dashboard} from './dashboard';
import {scanMarket} from './scanner';
import {replayCoin} from './replay';
import {researchCoin,compareCoin} from './research';
import {healthReport} from './stability';
import {outcomeCoin} from './outcomes';
import {auditCoin} from './accuracy-audit';
import {unifiedCoin,unifiedMarket} from './unified-backtest';
import {detectCatalog,CATALOG_IDS} from './pattern-catalog';
import {intelligenceCoin,intelligenceMarket,intelligenceDashboard} from './pattern-intelligence';

const json=(x:unknown,status=200)=>new Response(JSON.stringify(x,null,2),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
export async function handleSwingHunterRequest(req:Request,_env:unknown):Promise<Response>{
  const env=_env as any;
  const u=new URL(req.url);
  // V1.9: privileged logger operations; public GET diagnostics remain unchanged.
  if(u.pathname==='/api/swing/v19/scan'||u.pathname==='/api/swing/v19/settle'||u.pathname==='/api/swing/v19/log'){
    if(!env.SWING_ADMIN_TOKEN)return json({success:false,error:'SWING_ADMIN_TOKEN_NOT_CONFIGURED'},503);
    if(req.headers.get('x-swing-token')!==env.SWING_ADMIN_TOKEN)return json({success:false,error:'UNAUTHORIZED'},401);
    try{
      if(u.pathname==='/api/swing/v19/log'){
        if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
        return json(await recentSignals(env,Number(u.searchParams.get('limit')||20),u.searchParams.get('side')||undefined));
      }
      if(req.method!=='POST')return json({success:false,error:'POST_REQUIRED'},405);
      if(u.pathname==='/api/swing/v19/settle')return json(await settleSignals(env,Number(u.searchParams.get('limit')||12)));
      return json(await scanAndLog(env,{interval:(u.searchParams.get('interval')||'1h') as Interval,offset:Number(u.searchParams.get('offset')||0),limit:Number(u.searchParams.get('limit')||3)}));
    }catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502);}
  }
  if(req.method!=='GET')return json({success:false,error:'METHOD_NOT_ALLOWED'},405);
  if(u.pathname==='/swing-hunter/intelligence')return new Response(intelligenceDashboard(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(u.pathname==='/swing-hunter')return new Response(dashboard(),{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
  if(u.pathname==='/api/swing'||u.pathname==='/api/swing/status')
    return json({success:true,module:'SWING_HUNTER_V1_9',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,scheduled:false,coins:COINS.length,routes:['/swing-hunter','/api/swing/status','/api/swing/ohlcv','/api/swing/analyze','/api/swing/structure','/api/swing/patterns','/api/swing/decision','/api/swing/shadow','/api/swing/dashboard','/api/swing/scan','/api/swing/replay','/api/swing/research','/api/swing/compare','/api/swing/health','/api/swing/outcomes','/api/swing/audit','/api/swing/unified','/api/swing/unified-market','/api/swing/catalog','/api/swing/intelligence','/api/swing/intelligence-market','/api/swing/chart-learning','/api/swing/chart-learning-market','/api/swing/entry-research','/api/swing/integrity-audit','/api/swing/tp-first-touch','/api/swing/tp-sl-first-touch','/api/swing/v19/scan','/api/swing/v19/settle','/api/swing/v19/log','/swing-hunter/intelligence']});
  if(u.pathname==='/api/swing/dashboard')return json({success:true,module:'SWING_HUNTER_V1_8_5',mode:'READ_ONLY',dashboard:'/swing-hunter'});
  if(u.pathname==='/api/swing/health')return json(healthReport());
  if(u.pathname==='/api/swing/catalog')return json({success:true,module:'SWING_HUNTER_V1_6_PATTERN_CATALOG',patternIds:CATALOG_IDS,patternsCount:CATALOG_IDS.length,notes:['20 directional detectors, not every conceivable market pattern','Signals include triggerPatterns and supportingPatterns','Research-only']});
  if(u.pathname==='/api/swing/chart-learning-market'){try{return json(await chartLearningMarket(Number(u.searchParams.get('offset')||0),Number(u.searchParams.get('limit')||2),(u.searchParams.get('interval')||'4h') as Interval));}catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502);}}
  if(u.pathname==='/api/swing/intelligence-market'){try{return json(await intelligenceMarket(Number(u.searchParams.get('offset')||0),Number(u.searchParams.get('limit')||2)));}catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502);}}
  if(u.pathname==='/api/swing/unified-market'){try{return json(await unifiedMarket(Number(u.searchParams.get('offset')||0),Number(u.searchParams.get('limit')||2)));}catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502);}}
  if(u.pathname==='/api/swing/scan'){
    try { return json(await scanMarket()); } catch(e) { return json({success:false,error:e instanceof Error?e.message:String(e)},502); }
  }
  const coin=(u.searchParams.get('coin')||'BTC').toUpperCase();
  if(!(COINS as readonly string[]).includes(coin))return json({success:false,error:'INVALID_COIN'},400);
  try {
    if(u.pathname==='/api/swing/tp-sl-first-touch')return json(await tpSlFirstTouchCoin(coin,(u.searchParams.get('interval')||'4h') as Interval,Number(u.searchParams.get('limit')??'10')));
    if(u.pathname==='/api/swing/tp-first-touch')return json(await tpFirstTouchCoin(coin,(u.searchParams.get('interval')||'4h') as Interval,Number(u.searchParams.get('limit')||15)));
    if(u.pathname==='/api/swing/entry-research'||u.pathname==='/api/swing/integrity-audit')return json(await entryResearchCoin(coin,(u.searchParams.get('interval')||'4h') as Interval,Number(u.searchParams.get('limit')||15)));
    if(u.pathname==='/api/swing/chart-learning')return json(await chartLearningCoin(coin,(u.searchParams.get('interval')||'4h') as Interval,Number(u.searchParams.get('limit')||30)));
    if(u.pathname==='/api/swing/intelligence')return json(await intelligenceCoin(coin));
    if(u.pathname==='/api/swing/unified')return json(await unifiedCoin(coin));
    if(u.pathname==='/api/swing/audit')return json(await auditCoin(coin));
    if(u.pathname==='/api/swing/outcomes')return json(await outcomeCoin(coin));
    if(u.pathname==='/api/swing/replay')return json(await replayCoin(coin));
    if(u.pathname==='/api/swing/research')return json(await researchCoin(coin));
    if(u.pathname==='/api/swing/compare')return json(await compareCoin(coin));
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
      return json({success:true,coin,quality:qualities,patterns:{'1h':detectCatalog(h1.closed,structure(h1.closed),'1h'),'4h':detectCatalog(h4.closed,structure(h4.closed),'4h')},catalogCount:CATALOG_IDS.length});
    }
    const candidate=decide(coin,h1,h4,d1);
    if(u.pathname==='/api/swing/decision')return json({success:true,coin,quality:qualities,candidate});
    if(u.pathname==='/api/swing/shadow')return json({success:true,coin,shadow:shadowProjection(candidate),note:'Projection only; no trade tracking or D1 writes'});
    return json({success:true,mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,quality:qualities,candidate,shadow:shadowProjection(candidate)});
  } catch(e){return json({success:false,error:e instanceof Error?e.message:String(e)},502);}
}

/** Optional cron hook: call from the EXISTING Worker's scheduled handler.
 * At most 3 coins per tick; 20 coins require 7 staggered ticks.
 * Do not add a second scheduled export to src/index.ts.
 */
export async function swingHunterScheduled(env:any,offset=0,interval:Interval='1h'){
  const scan=await scanAndLog(env,{offset,limit:3,interval});
  const settlement=await settleSignals(env,8);
  return {scan,settlement};
}
