// Read-only Hyperliquid public wallet fill latency test. No order/signing paths.
const WS_URL = 'wss://api.hyperliquid.xyz/ws';
const INFO_URL = 'https://api.hyperliquid.xyz/info';
const TARGET = '0xbb160cb61e694570f9d570f9fcde7c61dd2143ad';
const j = (x: unknown, status = 200) => new Response(JSON.stringify(x, null, 2), {status, headers:{'content-type':'application/json','cache-control':'no-store'}});
type Sample = {tid:string;time:number;received:number;latency_ms:number;coin:string;side:string;dir:string;px:string;sz:string;closedPnl:string;fee:string;source:string};
export class TraderWatch {
  private ctx:any; private env:any; private ws:WebSocket|null=null;
  private state:any={active:false,connected:false,started_at:0,last_message_at:0,last_fill_at:0,reconnects:0,ws_messages:0,ws_fills:0,api_missing:0,api_checked:0,errors:[]};
  private samples:Sample[]=[];
  private ids:string[]=[];
  private queue:Promise<void>=Promise.resolve();
  constructor(ctx:any,env:any){this.ctx=ctx;this.env=env;ctx.blockConcurrencyWhile(async()=>{this.state=(await ctx.storage.get('state'))??this.state;this.samples=(await ctx.storage.get('samples'))??[];this.ids=(await ctx.storage.get('ids'))??[];if(this.state.active)await ctx.storage.setAlarm(Date.now()+1000);});}
  private async persist(){await this.ctx.storage.put({state:this.state,samples:this.samples,ids:this.ids});}
  private error(e:unknown){this.state.errors=[...this.state.errors.slice(-9),{at:Date.now(),message:String(e)}];}
  private take(f:any,source:string){
    if(String(f?.coin).toUpperCase()!=='BTC')return false;
    const tid=String(f?.tid??'');if(!tid||this.ids.includes(tid))return false;
    const received=Date.now(),time=Number(f?.time),latency=received-time;
    this.ids.push(tid);if(this.ids.length>12000)this.ids.splice(0,this.ids.length-12000);
    this.samples.push({tid,time,received,latency_ms:latency,coin:String(f.coin),side:String(f.side??''),dir:String(f.dir??''),px:String(f.px??''),sz:String(f.sz??''),closedPnl:String(f.closedPnl??''),fee:String(f.fee??''),source});
    if(this.samples.length>3000)this.samples.splice(0,this.samples.length-3000);
    this.state.last_fill_at=received;if(source==='WS')this.state.ws_fills++;else this.state.api_missing++;
    return true;
  }
  private async onMessage(raw:any){let msg:any;try{msg=JSON.parse(typeof raw==='string'?raw:String(raw));}catch{return;}
    this.state.last_message_at=Date.now();this.state.ws_messages++;
    if(msg?.channel==='userFills'){
      const d=msg.data;const fills=Array.isArray(d?.fills)?d.fills:Array.isArray(d)?d:[];
      for(const f of fills)this.take(f,'WS');
      await this.persist();
    }
  }
  private connect(){if(!this.state.active)return;
    if(this.ws&&(this.ws.readyState===WebSocket.CONNECTING||this.ws.readyState===WebSocket.OPEN))return;
    const ws=new WebSocket(WS_URL);this.ws=ws;
    ws.addEventListener('open',()=>{if(!this.state.active){ws.close();return;}this.state.connected=true;this.state.last_message_at=Date.now();ws.send(JSON.stringify({method:'subscribe',subscription:{type:'userFills',user:TARGET}}));this.persist().catch(()=>{});});
    ws.addEventListener('message',(e:MessageEvent)=>{this.queue=this.queue.then(()=>this.onMessage(e.data)).catch(err=>{this.error(err);});});
    const disconnect=()=>{if(this.ws!==ws)return;this.state.connected=false;this.ws=null;if(this.state.active)this.ctx.storage.setAlarm(Date.now()+1000).catch(()=>{});};
    ws.addEventListener('close',disconnect);ws.addEventListener('error',disconnect);
  }
  private async reconcile(){
    // API is a verification/backfill source, not a 1-minute snapshot.
    const now=Date.now(),start=now-5*60_000;
    const r=await fetch(INFO_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'userFillsByTime',user:TARGET,startTime:start,endTime:now,aggregateByTime:false})});
    if(!r.ok)throw Error('INFO_HTTP_'+r.status);
    const data=await r.json() as any;
    if(!Array.isArray(data))throw Error('INVALID_API_FILLS');
    this.state.api_checked+=data.filter((f:any)=>String(f.coin).toUpperCase()==='BTC').length;
    for(const f of data)this.take(f,'API_BACKFILL');
    this.state.last_audit_at=now;
    // 5 minute window may hit an API response cap for high frequency wallets.
    this.state.audit_truncation_risk=data.length>=1900;
    await this.persist();
  }
  async alarm(){if(!this.state.active)return;
    if(!this.ws||this.ws.readyState===WebSocket.CLOSED||this.ws.readyState===WebSocket.CLOSING){this.state.reconnects++;this.connect();}
    else if(this.state.connected&&Date.now()-this.state.last_message_at>45000){try{this.ws.close();}catch{}this.ws=null;this.state.connected=false;this.state.reconnects++;this.connect();}
    if(!this.state.last_audit_at||Date.now()-this.state.last_audit_at>=60000){try{await this.reconcile();}catch(e){this.error(e);}}
    await this.persist();await this.ctx.storage.setAlarm(Date.now()+10000);
  }
  async fetch(request:Request){const u=new URL(request.url),path=u.pathname;
    if(path==='/start'){this.state.active=true;this.state.started_at ||=Date.now();this.connect();await this.ctx.storage.setAlarm(Date.now()+10000);await this.persist();return j({ok:true,active:true,target:TARGET});}
    if(path==='/stop'){this.state.active=false;this.state.connected=false;try{this.ws?.close(1000,'stopped');}catch{}this.ws=null;await this.persist();return j({ok:true,active:false});}
    if(path==='/audit'){try{await this.reconcile();return j({ok:true,...this.stats()});}catch(e){this.error(e);await this.persist();return j({ok:false,error:String(e)},502);}}
    if(path==='/status')return j(this.stats());
    if(path==='/samples')return j({target:TARGET,samples:this.samples.slice(-Math.min(500,Math.max(1,Number(u.searchParams.get('limit')||100))))});
    return j({error:'NOT_FOUND'},404);
  }
  private stats(){const ws=this.samples.filter(x=>x.source==='WS'&&x.latency_ms>=0).map(x=>x.latency_ms).sort((a,b)=>a-b);const p=(q:number)=>ws.length?ws[Math.min(ws.length-1,Math.floor((ws.length-1)*q))]:null;
    return {target:TARGET,...this.state,ws_latency_ms:{count:ws.length,p50:p(.5),p90:p(.9),p99:p(.99),min:ws[0]??null,max:ws.at(-1)??null},sample_count:this.samples.length,notes:['Latency is fill timestamp to monitor receipt, not wire-only latency.','API_BACKFILL means WS delivery was not observed within the retained dedupe window; startup history may count as missing.','No orders or real trading.']};}
}
