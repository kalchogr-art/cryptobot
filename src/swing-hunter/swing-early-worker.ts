/** Dedicated shadow-only Cloudflare Worker entrypoint.
 * Put alongside src/swing-hunter/swing-early-scanner.ts as src/swing-hunter/swing-early-worker.ts
 * and configure this file as the Worker entrypoint (not the LIVE worker).
 */
import { runSwingEarlyCycle } from './swing-early-scanner';
export default {
 async scheduled(_event: ScheduledEvent,env:any,ctx:ExecutionContext){
  const batch=Math.floor(Date.now()/60000)%4;
  ctx.waitUntil(runSwingEarlyCycle(env,batch*5,5).then(r=>{
   if(r.errors.length || r.tracking.errors.length || r.live.errors.length)
    console.error('SWING_EARLY_ERRORS',JSON.stringify(r));
   else console.log('SWING_EARLY_OK',JSON.stringify({batch,scanned:r.scanned.length,tracking:r.tracking.processed,matched:r.live.checked}));
  }));
 },
 async fetch(req:Request){
  if(new URL(req.url).pathname==='/health')return new Response(JSON.stringify({success:true,mode:'SHADOW_ONLY',trading:false}),{headers:{'content-type':'application/json'}});
  return new Response('Not found',{status:404});
 }
};
