import {fetchClosed} from './ohlcv';
import type {Interval} from './types';
const cache=new Map<string,{expires:number;value:Awaited<ReturnType<typeof fetchClosed>>}>();
const metrics={requests:0,cacheHits:0,upstreamAttempts:0,retries429:0,failures:0};
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const inflight=new Map<string,Promise<Awaited<ReturnType<typeof fetchClosed>>>>();
export async function safeFetchClosed(coin:string,interval:Interval,count=160){
  metrics.requests++;
  const key=`${coin}:${interval}:${count}`,now=Date.now(),cached=cache.get(key);
  if(cached&&cached.expires>now){metrics.cacheHits++;return cached.value;}
  const pending=inflight.get(key);if(pending)return pending;
  const task=(async()=>{
    for(let attempt=0;attempt<3;attempt++){
      try{
        metrics.upstreamAttempts++;
        const value=await fetchClosed(coin,interval,count);
        // Short-lived isolate-local cache; does not change source candle validation.
        cache.set(key,{value,expires:Date.now()+60000});
        if(cache.size>100)cache.delete(cache.keys().next().value as string);
        return value;
      }catch(e){
        const message=e instanceof Error?e.message:String(e);
        if(!/429|RATE_LIMIT/i.test(message)||attempt===2){metrics.failures++;throw e;}
        metrics.retries429++;await sleep(500*Math.pow(2,attempt)+Math.floor(Math.random()*200));
      }
    }
    throw new Error('RETRY_EXHAUSTED');
  })();
  inflight.set(key,task);
  try{return await task;}finally{inflight.delete(key);}
}
export function healthReport(){return {success:true,module:'SWING_HUNTER_V1_3_HEALTH',mode:'SHADOW_READ_ONLY',trading:false,d1_queries:0,scope:'WORKER_ISOLATE_ONLY',cacheTTLSeconds:60,cacheEntries:cache.size,inflight:inflight.size,metrics,notes:['Metrics reset when Worker isolate restarts','429 retries use exponential backoff','This is not a global distributed rate limiter']};}
