/** V19.14 FULL dashboard — inherited ADD accumulator, new/reversal, source fills. */
export interface LiveDashboardEnv { LIVE_COPY_ADMIN_TOKEN?:string;LIVE_COPY_CONTROLLER?:{idFromName(name:string):unknown;get(id:unknown):{fetch(request:Request):Promise<Response>}}; }
const PAGE=`<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"/><title>LIVE COPY V19.16.1 · START UI FIX</title>
<style>body{margin:0;background:#0c1220;color:#eef2ff;font:14px system-ui,Arial,sans-serif}main{max-width:1160px;margin:auto;padding:20px}h1{font-size:24px}h2{font-size:17px;margin-top:5px}.muted{color:#9daec5}.box{border:1px solid #334155;background:#162033;border-radius:13px;padding:15px;margin:12px 0}.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}input,button{border-radius:8px;padding:11px;background:#202c40;color:white;border:1px solid #50627f}input{width:240px}button{cursor:pointer}button:hover{background:#32445e}button:disabled{opacity:.4;cursor:default}.pager{display:flex;gap:5px;align-items:center;justify-content:flex-end;flex-wrap:wrap;margin-top:10px}.pager button{padding:5px 10px}.pager .selected{background:#416aa5;border-color:#77a8ec}.danger{background:#8c2630}.green{color:#50d99c}.warn{color:#ffc36c}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}.stat{padding:12px;border:1px solid #32405b;border-radius:9px}.num{font-size:23px;font-weight:700}.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:760px}th,td{padding:9px;text-align:left;border-bottom:1px solid #34415a}th{color:#9daec5;font-weight:600}code{background:#263752;padding:2px 5px;border-radius:4px}#message{white-space:pre-wrap}</style></head><body><main>
<h1>Hyperliquid · LIVE COPY V19.16.1</h1><p class="muted">NEW / REVERSAL: директен вход $10.40 позиция ($1.04 маржин × 10x). ADD: само към позиции без загуба, с таван $31.20. Борсов Stop Market при -25% ROE и постоянна проверка на синхронизацията. REMOVE / CLOSE: намаляване на реалната позиция. Само изпълнени userFills.</p>
<div class="box"><div class="controls"><input id="token" type="password" placeholder="Admin token" autocomplete="off"/><button id="connect">СВЪРЖИ</button><button id="refresh">ОБНОВИ</button><label style="display:flex;align-items:center;gap:6px;padding:8px;border:1px solid #50627f;border-radius:8px"><input id="liveConfirm" type="checkbox" style="width:auto"/> <span>Потвърждавам РЕАЛНА търговия</span></label><button id="start">НОВА СЕСИЯ</button><button id="stop">STOP</button><button id="closeall" class="danger">CLOSE ALL</button></div><p id="message" class="muted">Няма връзка</p></div>
<div class="box"><h2>Реален Hyperliquid акаунт · само четене</h2><div class="controls"><button id="account">ОБНОВИ АКАУНТА</button><span id="accountinfo" class="muted">—</span></div><div class="scroll"><table><thead><tr><th>Монета</th><th>Реално количество</th><th>Средна цена</th><th>Нереализирано P/L</th></tr></thead><tbody id="positions"><tr><td colspan="4">Не е заредено</td></tr></tbody></table></div></div>
<div class="box"><h2>LIMIT COPY · FULL TRADE LIVE (V19.16.4)</h2>
<p class="muted">Източник: 0xbb160c…143ad · REAL FULL TRADE · LONG / SHORT / ADD / PARTIAL CLOSE / CLOSE / REVERSAL. Реален LIMIT ALO Maker вход/изход; при неизпълнен изход е възможно защитно reduce-only IOC (Taker). Максимум 10 приключени позиции, $10.40 начален номинал, 10x cross, таван $31.20. START изисква старият бот да е спрян и реалният акаунт да е изцяло празен. WebSocket прекъсване спира новите входове. Риск: реална загуба е възможна.</p>
<div class="controls"><button id="ltRefresh">ОБНОВИ LIMIT TEST</button><button id="ltStart" type="button">START · НОВИЯ ТРЕЙДЪР · РЕАЛНИ СДЕЛКИ</button><button id="ltStop">STOP LIMIT ВХОДОВЕТЕ</button></div>
<div id="ltStartPanel" class="box" style="display:none;border-color:#b58a46" aria-live="polite">
<p><strong>Потвърждение на LIVE тест</strong> · Реални средства. Преди потвърждение старият LIVE COPY трябва да е STOP и Hyperliquid акаунтът да няма активни позиции и поръчки.</p>
<label style="display:block;margin:8px 0"><input type="checkbox" id="ltAcceptRisk" style="width:auto"/> Потвърждавам, че старият бот е спрян и проверих реалните позиции и поръчки</label>
<label style="display:block;margin:8px 0">Въведи точно <code>START FULL TRADE LIVE</code></label>
<input id="ltPhrase" type="text" placeholder="START FULL TRADE LIVE" autocomplete="off" autocapitalize="characters" style="max-width:100%;box-sizing:border-box"/>
<div class="controls" style="margin-top:10px"><button id="ltConfirmStart" type="button">ПОТВЪРДИ И ИЗПРАТИ START</button><button id="ltCancelStart" type="button">ОТКАЖИ</button></div>
</div>
<p id="ltStartStatus" class="warn" role="status" aria-live="polite">START още не е заявен.</p>
<div class="stats"><div class="stat">Режим<div id="ltMode" class="num">—</div></div><div class="stat">Приключени<div id="ltCompleted" class="num">—</div></div><div class="stat">Maker fills<div id="ltMaker" class="num">—</div></div><div class="stat">Taker fills<div id="ltTaker" class="num">—</div></div><div class="stat">Такси<div id="ltFees" class="num">—</div></div><div class="stat">NET P/L без funding<div id="ltNet" class="num">—</div></div></div><p class="warn" id="ltWarning">Не е свързан</p>
<p class="muted" id="ltAuditInfo">Последни 15 минути · изчаква данни от източника</p>
<div class="scroll"><table><thead><tr><th>Час</th><th>Монета</th><th>Действие</th><th>Преди → След</th><th>Цена</th><th>Размер</th></tr></thead><tbody id="ltAuditRows"><tr><td colspan="6">Не са заредени изпълнения</td></tr></tbody></table></div>
<div class="scroll"><table><thead><tr><th>Време</th><th>Монета</th><th>Събитие</th><th>Подробности</th></tr></thead><tbody id="ltHistory"><tr><td colspan="4">Няма събития</td></tr></tbody></table></div></div>
<div class="box"><h2>V19 · СЪСТОЯНИЕ</h2><div class="stats"><div class="stat">Режим<div class="num" id="mode">—</div></div><div class="stat">Изпълнение<div class="num" id="live">—</div></div><div class="stat">Обработени fills<div class="num" id="events">—</div></div><div class="stat">Изпълнени наши ордери<div class="num" id="orders">—</div></div><div class="stat">D1 курсор<div class="num" id="cursor">—</div></div><div class="stat">Изоставане (редове)<div class="num" id="lag">—</div></div><div class="stat" style="grid-column:1/-1">D1 диагностика<div id="d1error" class="warn" style="font-size:12px;overflow-wrap:anywhere">—</div></div>
<div class="stat" style="grid-column:1/-1">Капитал при нова сесия<div class="num" id="capital">—</div><span class="muted" style="font-size:11px">Фиксиран при START</span></div>
<div class="stat">EQUITY<div class="num" id="equity">—</div></div>
<div class="stat">ROI<div class="num" id="roi">—</div></div>
<div class="stat" style="grid-column:1/-1">Win Rate<div class="num" id="winrate">—</div><span id="tradecount" class="muted">Само затворени позиции</span></div><div class="stat">Минимум ADD<div class="num" id="minimum">—</div></div><div class="stat">Начален маржин<div class="num" id="margin">—</div></div><div class="stat">Ливъридж<div class="num" id="leverage">—</div></div><div class="stat">Макс. позиция<div class="num" id="cap">—</div></div><div class="stat">Stop Loss<div class="num" id="stoploss">−25% ROE</div></div><div class="stat">Без ADD при загуба<div class="num" id="noadd">ДА</div></div><div class="stat">Safety audit<div class="num" id="safetyaudit">—</div></div><div class="stat">Hyperliquid INFO<div class="num" id="infostatus" style="font-size:16px">—</div></div><div class="stat">Последна проверка<div class="num" id="lastsync" style="font-size:16px">—</div></div></div></div>
<div class="box"><h2>Hyperliquid · IP REST монитор (само четене)</h2>
<p class="muted">Показва само заявките, наблюдавани от текущия Cloudflare Worker isolate. НЕ е точният оставащ IP бюджет; други инстанции, Workers и изходящи IP адреси не са включени. Не изпраща тестови заявки и не променя поръчки.</p>
<div class="stats"><div class="stat">Лимит / 60 сек<div id="ipLimit" class="num">1 200</div></div><div class="stat">Наблюдаван weight / 60 сек<div id="ipWeight" class="num">—</div></div><div class="stat">Заявки / 60 сек<div id="ipReqs" class="num">—</div></div><div class="stat">INFO / EXCHANGE weight<div id="ipSplit" class="num" style="font-size:17px">—</div></div><div class="stat">HTTP 429 · 60 мин<div id="ip429hour" class="num">—</div></div><div class="stat">HTTP 429 · 24 ч<div id="ip429day" class="num">—</div></div></div>
<p id="ipDiag" class="muted">Няма наблюдения</p><div class="controls"><button id="ipRefresh">ОБНОВИ IP МОНИТОРА</button></div>
<div class="scroll"><table><thead><tr><th>Час София</th><th>Endpoint</th><th>Операция</th><th>HTTP</th><th>Weight</th><th>Време ms</th></tr></thead><tbody id="ipFailures"><tr><td colspan="6">Няма регистрирани откази</td></tr></tbody></table></div></div>
<div class="box"><h2>Hyperliquid · API лимит за реални поръчки (само четене)</h2>
<p class="muted">Проверка на 60 секунди за основния търговски адрес. Това е адресният лимит на exchange заявките, НЕ лимитът на IP / WebSocket. Няма автоматична промяна на поръчките.</p>
<div class="stats"><div class="stat">Състояние<div id="quotaState" class="num">—</div></div><div class="stat">Остават заявки<div id="quotaRemain" class="num">—</div></div><div class="stat">Използвани<div id="quotaUsed" class="num">—</div></div><div class="stat">Общ лимит<div id="quotaCap" class="num">—</div></div><div class="stat">Резерв<div id="quotaSurplus" class="num">—</div></div><div class="stat">Използване<div id="quotaPct" class="num">—</div></div></div>
<p id="quotaDiag" class="muted">Не е проверено</p><p id="quotaEvents" class="warn">—</p>
<div class="controls"><button id="quotaRefresh">ПРОВЕРИ ЛИМИТА</button></div></div>
<div class="box"><h2>Натрупване и целеви позиции по монети</h2><p class="muted">Целевите количества са изчисления; реалното изпълнение се потвърждава отделно на борсата. Наследените позиции служат само за база: техните нови ADD се натрупват до $10.40. Старият размер не се копира.</p><div class="scroll"><table><thead><tr><th>Монета</th><th>Източник qty</th><th>Цел за нас qty</th><th>Цел USD*</th><th>Натрупан ADD USD</th><th>Чакащ REMOVE USD</th><th>Състояние</th><th>Начален вход</th><th>Последен fill</th><th>Стоп / Safety</th><th>Проблем</th></tr></thead><tbody id="coins"><tr><td colspan="11">Няма данни</td></tr></tbody></table></div><div id="coinsPager" class="pager"></div><p class="muted">* По последната наблюдавана цена, ориентировъчно. Няма симулирана печалба.</p></div>
<div class="box"><h2>Последни решения · NEW / REVERSAL / ADD / REMOVE</h2><p class="muted">EPISODE_EXIT_REQUIRED: затваря предишния епизод и чака борсово потвърждение, преди нов вход. ENTRY_BALANCE_BLOCKED: не повтаря неуспешния вход върху стар епизод. NEW_ENTRY и REVERSAL_ENTRY: $10.40 номинал при 10x. Максимум $31.20 експозиция на монета, без автоматично намаляване на съществуващи по-големи позиции. ACCUMULATE_ADD: чака сбор поне $10.40. REMOVE: натрупва до $10.40. CLOSE: пълно затваряне; остатъци под минимума се маркират отделно. В SHADOW няма реални поръчки.</p><div class="scroll"><table><thead><tr><th>Монета</th><th>Решение</th><th>Натрупано USD</th><th>Количество</th><th>Посока</th></tr></thead><tbody id="decisions"><tr><td colspan="5">Няма решения</td></tr></tbody></table></div><div id="decisionsPager" class="pager"></div></div>
<div class="box"><h2>Последни реални действия и грешки</h2><p class="muted">PARTIAL ENTRY показва неизпълнения остатък от първия вход, който не се смесва с ADD. EXCHANGE_REJECTED показва точната причина от Hyperliquid. Малките REMOVE се натрупват. STOP_INSTALL_FAILED / STOP_MISSING блокира нова експозиция и изисква CLOSE. ADD_BLOCKED_POSITION_LOSING отказва увеличения в загуба. DUST_CLOSE_REJECTED показва остатъчна позиция, която борсата отказва да затвори; нужна е проверка в Hyperliquid.</p><div id="errors" class="warn"></div><div class="scroll"><table><thead><tr><th>Час София</th><th>Монета</th><th>Действие</th><th>Детайл</th></tr></thead><tbody id="recent"><tr><td colspan="4">Няма данни</td></tr></tbody></table></div><div id="recentPager" class="pager"></div></div>
<script>
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let connected=false,busy=false;
function time(ms){return ms?new Date(ms).toLocaleString('bg-BG',{timeZone:'Europe/Sofia'}):'—'}
async function api(path,method='GET',payload){const r=await fetch('/live-copy/api/'+path,{method,headers:{authorization:'Bearer '+$('token').value.trim(),'content-type':'application/json'},body:method==='POST'?JSON.stringify(payload||{}):undefined,cache:'no-store'});const j=await r.json();if(!r.ok||j.ok===false)throw Error(j.error||'HTTP_'+r.status+(j.detail?' '+j.detail:''));return j;}
function show(msg){$('message').textContent=msg}
const pageData={coins:[],decisions:[],recent:[]};
const pageIndex={coins:0,decisions:0,recent:0};
const pageSizes={coins:5,decisions:10,recent:10};
function renderPage(kind){
 const data=pageData[kind],size=pageSizes[kind],pages=Math.max(1,Math.ceil(data.length/size));
 pageIndex[kind]=Math.min(Math.max(0,pageIndex[kind]),pages-1);
 const start=pageIndex[kind]*size;
 const empty={coins:'Чакаме нови изпълнени сделки',decisions:'Няма решения',recent:'Няма нови реални действия'};
 const colspan={coins:11,decisions:5,recent:4};
 const rows=data.slice(start,start+size).map(p=>kind==='coins'?coinRow(p):kind==='decisions'?decisionRow(p):recentRow(p));
 $(kind).innerHTML=rows.join('')||'<tr><td colspan="'+colspan[kind]+'">'+empty[kind]+'</td></tr>';
 const pager=$(kind+'Pager');pager.replaceChildren();
 if(pages===1&&data.length===0)return;
 const label=document.createElement('span');label.className='muted';label.textContent=data.length+' записа · '+(pageIndex[kind]+1)+' / '+pages;pager.appendChild(label);
 const add=(title,index,disabled,selected=false)=>{const b=document.createElement('button');b.textContent=title;b.disabled=disabled;b.className=selected?'selected':'';b.onclick=()=>{pageIndex[kind]=index;renderPage(kind)};pager.appendChild(b)};
 add('‹',pageIndex[kind]-1,pageIndex[kind]===0);
 const left=Math.max(0,pageIndex[kind]-2),right=Math.min(pages,left+5);
 for(let i=Math.max(0,right-5);i<right;i++)add(String(i+1),i,false,i===pageIndex[kind]);
 add('›',pageIndex[kind]+1,pageIndex[kind]>=pages-1);
}
function coinRow(p){return '<tr><td>'+esc(p.coin)+'</td><td>'+esc(p.source_qty)+'</td><td>'+esc(p.desired_qty)+'</td><td>$'+(Math.abs(Number(p.desired_qty)*Number(p.last_price))).toFixed(2)+'</td><td>$'+Number(p.inherited_pending_add_usd||0).toFixed(2)+'</td><td>$'+Number(p.pending_reduce_usd||0).toFixed(2)+'</td><td>'+esc(p.exit_barrier?'EXIT REQUIRED · '+(p.exit_barrier_reason||'EPISODE'):p.source_chain_fault?'SOURCE CHAIN QUARANTINE':p.entry_balance_blocked?'BALANCE BLOCKED':p.pending?'PENDING '+p.pending:['ACCUMULATE_REMOVE','AVOID_DUST','DUST_CLOSE_REJECTED'].includes(p.reduce_state)?p.reduce_state:p.inherited_mode?'ACCUMULATE ADD':p.active?'TRACKING':p.waiting_flat?'LEGACY WAIT':'FLAT')+'</td><td>'+esc(p.entry_status?((p.entry_status==='COMPLETE'?'INITIAL COMPLETE':p.entry_status)+ ' · '+(Number(p.entry_confirmed_qty||0)).toFixed(6)+'/'+(Number(p.entry_target_qty||0)).toFixed(6)+' qty · остатък $'+Number(p.entry_remaining_usd||0).toFixed(2)):p.entry_pending?(p.entry_kind+' · ENTRY PENDING'):p.entry_confirmed?'CONFIRMED':'—')+'</td><td>'+esc(time(p.last_fill_at))+'</td><td>'+esc(p.stop_fault||p.safety_source_fault||p.stop_status||'—')+'</td><td>'+esc(p.dust_close_alert||p.error||p.reduce_state||'')+'</td></tr>'}
function decisionRow(d){return '<tr><td>'+esc(d.coin)+'</td><td>'+esc(d.action)+'</td><td>$'+Number(d.usd??d.pending_usd??0).toFixed(2)+'</td><td>'+esc(d.qty??'—')+'</td><td>'+esc(d.direction??'—')+'</td></tr>'}
function recentRow(p){return '<tr><td>'+esc(time(p.at))+'</td><td>'+esc(p.coin)+'</td><td>'+esc(p.kind)+'</td><td>'+esc(p.detail)+'</td></tr>'}
let lastPerf=0;
async function updatePerformance(force=false){
 if(!connected||(!force&&Date.now()-lastPerf<60000))return;
 lastPerf=Date.now();
 try{
  const p=await api('performance');
  const money=x=>x==null||!Number.isFinite(Number(x))?'—':'$'+Number(x).toFixed(2);
  $('capital').textContent=money(p.capital_usd);
  $('equity').textContent=money(p.equity_usd);
  $('roi').textContent=p.roi_pct==null?'—':(p.roi_pct>=0?'+':'')+Number(p.roi_pct).toFixed(2)+'%';
  $('winrate').textContent=p.win_rate_pct==null?'—':Number(p.win_rate_pct).toFixed(1)+'%';
  $('tradecount').textContent=p.closed_trades==null?(p.reason||'Няма статистика'):p.closed_trades+' затворени · '+p.wins+' печеливши · '+p.losses+' губещи'+(p.reason?' · '+p.reason:'');
 }catch(e){$('tradecount').textContent='Performance: '+e.message;}
}
let lastQuotaPoll=0;
async function updateQuota(force=false){
 if(!connected||(!force&&Date.now()-lastQuotaPoll<60000))return;
 lastQuotaPoll=Date.now();
 try{
  const q=await api('api-quota');
  const integer=x=>Number.isFinite(Number(x))?Math.round(Number(x)).toLocaleString('en-US'):'—';
  $('quotaState').textContent=q.state||'—';
  $('quotaRemain').textContent=integer(q.remaining_requests);
  $('quotaUsed').textContent=integer(q.requests_used);
  $('quotaCap').textContent=integer(q.requests_cap);
  $('quotaSurplus').textContent=integer(q.requests_surplus);
  $('quotaPct').textContent=q.usage_percent==null?'—':Number(q.usage_percent).toFixed(2)+'%';
  $('quotaDiag').textContent='Акаунт '+q.address+' · проверено '+time(q.checked_at)+(q.cached?' · кеш '+q.age_seconds+' сек':'')+' · Обем $'+Number(q.cum_volume_usd).toFixed(2);
  $('quotaEvents').textContent='Регистрирани rate-limit събития в последните '+q.recent_history_size+' записа: '+q.rate_limit_events_in_recent_history+' · Това НЕ е брой пропуснати сделки.';
 }catch(e){$('quotaState').textContent='НЕИЗВЕСТНО';$('quotaDiag').textContent='API монитор: '+e.message+' · не означава нулев оставащ бюджет';}
}
let lastIpPoll=0;
async function updateIpMonitor(force=false){
 if(!connected||(!force&&Date.now()-lastIpPoll<60000))return;
 lastIpPoll=Date.now();
 try{
  const r=await api('ip-rest-monitor');
  $('ipLimit').textContent=Number(r.ip_limit_weight_per_minute||1200).toLocaleString('en-US');
  $('ipWeight').textContent=Number(r.observed_weight_60s||0).toLocaleString('en-US')+' ('+Number(r.observed_weight_pct_60s||0).toFixed(1)+'%)';
  $('ipReqs').textContent=r.observed_requests_60s??'—';
  $('ipSplit').textContent=(r.observed_info_weight_60s??'—')+' / '+(r.observed_exchange_weight_60s??'—');
  $('ip429hour').textContent=r.http_429_60m??'—';
  $('ip429day').textContent=r.http_429_24h??'—';
  $('ipDiag').textContent='Наблюдение от '+time(r.boot_at)+' · проверено '+time(r.checked_at)+' · НЕ включва други изходящи IP, инстанции или допълнителни тежести за големи отговори. Оставащият реален IP бюджет е неизвестен.';
  const failures=r.recent_rest_failures||[];
  $('ipFailures').innerHTML=failures.map(x=>'<tr><td>'+esc(time(x.at))+'</td><td>'+esc(x.endpoint)+'</td><td>'+esc(x.operation)+'</td><td>'+esc(x.status||'NETWORK')+'</td><td>'+esc(x.weight)+'</td><td>'+esc(x.elapsed_ms)+'</td></tr>').join('')||'<tr><td colspan="6">Няма регистрирани откази в този Worker isolate</td></tr>';
 }catch(e){$('ipDiag').textContent='IP монитор: '+e.message;}
}
async function refresh(){if(!connected||busy)return;busy=true;try{const s=await api('status');if(!['V19_NET_POSITION','V19_1_PERCENTAGE_FILL_COPY','V19_2_INHERITED_ADD_COPY','V19_3_INFO_RATE_LIMIT_FIX','V19_4_EXCHANGE_REJECTION_DETAILS','V19_6_PARTIAL_ENTRY_FIX','V19_7_POSITION_CAP','V19_9_LOSS_STOP_SAFETY_AUDIT','V19_13_IP_REST_MONITOR','V19_14_LIMIT_TEST_INTEGRATED','V19_16_FULL_TRADE_LIVE_CANDIDATE','V19_16_3_REST_STATUS_CACHE','V19_16_4_IDLE_BACKOFF'].includes(s.version))throw Error('CONTROLLER_IS_NOT_V19: '+s.version);
 $('mode').textContent=s.mode;$('live').textContent=s.live_execution?'REAL LIVE':s.session_kind==='LIVE'?'LIVE NOT AUTHORIZED':'SHADOW';
 $('events').textContent=s.processed_fills??'—';$('orders').textContent=s.orders_sent_and_filled??'—';$('cursor').textContent=s.cursor??'—';$('lag').textContent=s.lag_rows??'—';$('d1error').textContent=s.d1_diagnostic?(s.d1_diagnostic.status+' · '+s.d1_diagnostic.query+' · опити '+s.d1_diagnostic.attempts+' · '+time(s.d1_diagnostic.at)+(s.d1_diagnostic.error?' · '+s.d1_diagnostic.error:s.d1_diagnostic.previous_error?' · предишна: '+s.d1_diagnostic.previous_error:'')):'Няма отчетена D1 грешка';
 // V19.1 returns minimum_notional_usd. Its execution adapter uses fixed 10x,
 // with $10.40 notional = $1.04 initial margin. Never render undefined.
 const addUsd=Number(s.add_threshold_usd??s.minimum_notional_usd);
 const lev=Number(s.leverage??(['V19_1_PERCENTAGE_FILL_COPY','V19_2_INHERITED_ADD_COPY','V19_3_INFO_RATE_LIMIT_FIX','V19_4_EXCHANGE_REJECTION_DETAILS','V19_6_PARTIAL_ENTRY_FIX','V19_7_POSITION_CAP','V19_9_LOSS_STOP_SAFETY_AUDIT','V19_13_IP_REST_MONITOR','V19_14_LIMIT_TEST_INTEGRATED','V19_16_FULL_TRADE_LIVE_CANDIDATE','V19_16_3_REST_STATUS_CACHE','V19_16_4_IDLE_BACKOFF'].includes(s.version)?10:NaN));
 const mar=Number(s.initial_margin_usd??(Number.isFinite(addUsd)&&Number.isFinite(lev)&&lev>0?addUsd/lev:NaN));
 $('minimum').textContent=Number.isFinite(addUsd)?'$'+addUsd.toFixed(2):'—';
 $('margin').textContent=Number.isFinite(mar)?'$'+mar.toFixed(2):'—';
 $('leverage').textContent=Number.isFinite(lev)?lev+'x':'—';
 $('cap').textContent=Number.isFinite(Number(s.max_position_notional_usd))?'$'+Number(s.max_position_notional_usd).toFixed(2):'—';
 $('stoploss').textContent=s.stop_loss_roe_pct!=null?'−'+s.stop_loss_roe_pct+'% ROE':'—';
 $('noadd').textContent=s.no_add_to_losing?'ДА':'НЕ';
 $('safetyaudit').textContent=(s.coins||[]).some(c=>c.stop_fault||c.safety_source_fault)?'ПРОБЛЕМ':'АКТИВЕН';
 $('infostatus').textContent=Number(s.api_backoff_seconds||0)>0?'429 · пауза '+s.api_backoff_seconds+' сек':'Нормален режим';
 $('lastsync').textContent=s.last_sync?time(s.last_sync):'Няма завършена синхронизация';
 pageData.coins=(s.coins||[]).slice().sort((a,b)=>Number(Boolean(b.active||b.pending||b.exit_barrier||Math.abs(Number(b.desired_qty||0))>0))-Number(Boolean(a.active||a.pending||a.exit_barrier||Math.abs(Number(a.desired_qty||0))>0))||Number(b.last_fill_at||b.updated_at||0)-Number(a.last_fill_at||a.updated_at||0)||String(a.coin).localeCompare(String(b.coin)));
 pageData.decisions=(s.decisions||[]).slice().sort((a,b)=>Number(b.at||0)-Number(a.at||0)||String(a.coin).localeCompare(String(b.coin)));
 renderPage('coins');renderPage('decisions');
 $('errors').textContent=(s.errors||[]).slice(0,6).join(' | ');
 pageData.recent=(s.recent||[]).slice().sort((a,b)=>Number(b.at||0)-Number(a.at||0));renderPage('recent');
 show('Контролер ' + s.version + ' свързан · '+time(Date.now()));await updatePerformance();await updateQuota();await updateIpMonitor();await ltUpdate();}catch(e){show('Грешка: '+e.message)}finally{busy=false}}

async function ltUpdate(){if(!connected)return;try{const q=await api('limit-test/status');
 $('ltMode').textContent=q.halted?'HALTED':q.active?(q.websocket_connected?'LIVE ACTIVE':'CONNECTING'):'STOPPED';$('start').disabled=Boolean(q.active||q.order||q.coin||q.halted);$('ltCompleted').textContent=q.completed+'/10';
 $('ltMaker').textContent=q.statistics?.maker_fills??'—';$('ltTaker').textContent=q.statistics?.taker_fills??'—';
 $('ltFees').textContent=q.statistics?.total_fees_usd==null?'—':'$'+Number(q.statistics.total_fees_usd).toFixed(4);
 $('ltNet').textContent=q.statistics?.realized_net_ex_funding_usd==null?'—':'$'+Number(q.statistics.realized_net_ex_funding_usd).toFixed(4);
 $('ltWarning').textContent='FULL TRADE · WS: '+(q.websocket_connected?'CONNECTED':'DISCONNECTED')+' · Coin: '+(q.coin||'—')+' · Target: '+Number(q.target||0).toFixed(6)+' · '+q.reason+(Number(q.rest_backoff_until||0)>Date.now()?' · REST пауза '+Math.ceil((Number(q.rest_backoff_until)-Date.now())/1000)+' сек':'')+' · '+(q.errors||[]).slice(0,2).join(' | ')+' · P/L без funding; другите стратегии трябва да са STOP.';
 $('ltAuditInfo').textContent=q.fullTradeAudit?.error?('Грешка при четене на source fills: '+q.fullTradeAudit.error):('Изпълнения от последните 15 минути: '+(q.fullTradeAudit?.observed_events??0)+' · непълни за класифициране: '+(q.fullTradeAudit?.unclassified_fills??0)+' · Само реални source fills, без симулирани изпълнения.');
 $('ltAuditRows').innerHTML=(q.fullTradeAudit?.events||[]).map(x=>'<tr><td>'+esc(time(x.at))+'</td><td>'+esc(x.coin)+'</td><td>'+esc(x.action)+'</td><td>'+esc(x.before)+' → '+esc(x.after)+'</td><td>'+esc(x.price)+'</td><td>'+esc(x.delta)+'</td></tr>').join('')||'<tr><td colspan="6">Няма класифицирани изпълнения</td></tr>';
 $('ltHistory').innerHTML=(q.history||[]).slice(0,30).map(x=>'<tr><td>'+esc(time(x.at))+'</td><td>'+esc(x.coin)+'</td><td>'+esc(x.event)+'</td><td>'+esc(x.detail)+'</td></tr>').join('')||'<tr><td colspan="4">Няма събития</td></tr>';
 }catch(e){$('ltWarning').textContent='LIMIT TEST: '+e.message;}}
$('ltRefresh').onclick=ltUpdate;
$('ltStart').onclick=()=>{
  $('ltStartPanel').style.display='block';
  $('ltStartStatus').textContent='Попълни потвърждението тук, под START. Не е изпратена заявка.';
  $('ltStartPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
};
$('ltCancelStart').onclick=()=>{
  $('ltStartPanel').style.display='none';
  $('ltStartStatus').textContent='START отменен. Не е изпращана заявка.';
};
$('ltConfirmStart').onclick=async()=>{
  const status=$('ltStartStatus'),button=$('ltConfirmStart');
  if(!connected){status.textContent='НЕ Е ИЗПРАТЕН: първо натисни СВЪРЖИ с валиден Admin token.';return;}
  if(!$('liveConfirm').checked){status.textContent='НЕ Е ИЗПРАТЕН: отметни „Потвърждавам РЕАЛНА търговия“ най-горе.';return;}
  if(!$('ltAcceptRisk').checked){status.textContent='НЕ Е ИЗПРАТЕН: потвърди проверката на стария бот, позициите и ордерите.';return;}
  if($('ltPhrase').value.trim()!=='START FULL TRADE LIVE'){
    status.textContent='НЕ Е ИЗПРАТЕН: точният текст е START FULL TRADE LIVE (латински букви).';return;
  }
  button.disabled=true;
  status.textContent='Изпращам START към контролера…';
  try{
    const q=await api('limit-test/start','POST',{confirm:'START_FULL_TRADE_LIVE_10_TRADES'});
    status.textContent='START ПРИЕТ: '+(q.mode||'STARTING')+' · '+(q.warning||'Проверявай WebSocket статуса и реалната сметка.');
    $('liveConfirm').checked=false;
    $('ltPhrase').value='';$('ltStartPanel').style.display='none';
    await ltUpdate();
  }catch(e){
    status.textContent='START ОТКАЗАН: '+e.message+' · Няма потвърден успешен старт.';
    try{await ltUpdate()}catch(_){}
  }finally{button.disabled=false;}
};
$('ltStop').onclick=async()=>{if(!connected)return;try{const r=await api('limit-test/stop','POST');show('LIMIT STOP: забранени нови входове. Провери позициите в Hyperliquid!');await ltUpdate();}catch(e){show('LIMIT STOP: '+e.message);}};

$('quotaRefresh').onclick=()=>updateQuota(true);
$('ipRefresh').onclick=()=>updateIpMonitor(true);
$('connect').onclick=()=>{if(!$('token').value.trim())return show('Въведи token');connected=true;refresh()};$('refresh').onclick=refresh;
$('start').onclick=async()=>{if(!connected)return;if(!$('liveConfirm').checked)return show('START НЕ Е ИЗПРАТЕН: отметни „Потвърждавам РЕАЛНА търговия“ само ако искаш LIVE изпълнение. За SHADOW режим трябва отделна конфигурация.');if(!confirm('ПОТВЪРЖДЕНИЕ ЗА РЕАЛНА ТЪРГОВИЯ: ще бъде изпратено разрешение за LIVE сесия. Увери се, че акаунтът няма позиции и чакащи ордери от V18. Продължаваме ли?'))return;try{const r=await api('start','POST',{confirm:'START_REAL_HYPERLIQUID_COPY'});lastPerf=0;$('liveConfirm').checked=false;show('Сесията стартира: '+r.mode+' '+(r.live?'LIVE':'SHADOW'));await refresh();}catch(e){show('START: '+e.message)}};
$('stop').onclick=async()=>{if(!connected)return;try{const r=await api('stop','POST');show('STOP · текущите позиции остават. '+r.mode);await refresh();}catch(e){show('STOP: '+e.message)}};
$('closeall').onclick=async()=>{if(!connected||!confirm('ВНИМАНИЕ: CLOSE ALL спира копирането и се опитва да затвори ВСИЧКИ perpetual позиции и чакащи ордери в акаунта, включително от други стратегии. Продължаваме ли?'))return;try{const r=await api('close-all','POST');show(JSON.stringify(r,null,2));await refresh();}catch(e){show('CLOSE ALL: '+e.message)}};
$('account').onclick=async()=>{if(!connected)return;try{const a=await api('account');$('accountinfo').textContent='Perp account value '+(a.accountValue??'—')+' USD · Perp withdrawable '+(a.withdrawable??'—')+' USD · Spot USDC '+(a.spotUsdcTotal??'няма данни')+' (показват се отделно; не се сумират)'+(a.spotBalanceError?' · Spot read error: '+a.spotBalanceError:'');$('positions').innerHTML=(a.positions||[]).map(p=>'<tr><td>'+esc(p.coin)+'</td><td>'+esc(p.qty)+'</td><td>'+esc(p.entry)+'</td><td>'+esc(p.unrealized)+'</td></tr>').join('')||'<tr><td colspan="4">Няма позиции</td></tr>';}catch(e){$('accountinfo').textContent='Грешка '+e.message}};
setInterval(()=>{if(connected&&!document.hidden)refresh()},5000);
</script></main></body></html>`;
const j=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function serveLiveCopyDashboard(request:Request,env:LiveDashboardEnv):Promise<Response|null>{
 const url=new URL(request.url);if(request.method==='GET'&&url.pathname==='/live-copy')return new Response(PAGE,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"}});
 if(!url.pathname.startsWith('/live-copy/api/'))return null;
 if(!env.LIVE_COPY_ADMIN_TOKEN||request.headers.get('authorization')!=='Bearer '+env.LIVE_COPY_ADMIN_TOKEN)return j({ok:false,error:'UNAUTHORIZED'},401);
 const name=url.pathname.slice('/live-copy/api/'.length);const GET=['status','v19-status','account','our-activity','performance','api-quota','ip-rest-monitor','limit-test/status'];const POST=['start','stop','sync','close-all','limit-test/start','limit-test/stop','limit-test/sync'];
 if(!(GET.includes(name)&&request.method==='GET'||POST.includes(name)&&request.method==='POST'))return j({ok:false,error:'ROUTE_NOT_SUPPORTED',name},404);
 if(!env.LIVE_COPY_CONTROLLER)return j({ok:false,error:'CONTROLLER_BINDING_MISSING'},503);
 try{const id=env.LIVE_COPY_CONTROLLER.idFromName('live-copy-v23');const stub=env.LIVE_COPY_CONTROLLER.get(id);const r=await stub.fetch(new Request('https://live-copy.internal/'+name,{method:request.method,headers:{authorization:'Bearer '+env.LIVE_COPY_ADMIN_TOKEN,'content-type':'application/json'},...(request.method==='POST'?{body:await request.text()}:{})}));return new Response(r.body,{status:r.status,headers:{'content-type':'application/json','cache-control':'no-store'}});}catch(e){return j({ok:false,error:'CONTROLLER_UNAVAILABLE',detail:String(e)},503);}
}
