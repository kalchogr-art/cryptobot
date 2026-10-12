/** Swing Hunter V1.9.5 — protected, read-only monitoring UI. */
export function swingMonitorDashboard(): string {
  return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swing Hunter • Monitor</title>
<style>
:root{color-scheme:dark;font-family:system-ui,Arial;background:#090f1d;color:#e8efff}*{box-sizing:border-box}
body{margin:0;padding:20px;max-width:1350px;margin:auto}h1{font-size:26px;margin:0}h2{font-size:16px;margin:0 0 12px}
small,.muted{color:#92a4c1}.top{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px}
.panel,.metric{background:#121e32;border:1px solid #273a54;border-radius:14px;padding:16px}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0}
.metric strong{display:block;font-size:28px;margin-top:8px}input,select,button{background:#1a2b43;color:#e8efff;border:1px solid #3a506c;border-radius:8px;padding:10px}
button{cursor:pointer;background:#275fa5}button:hover{background:#3177ca}.filters{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}
table{border-collapse:collapse;width:100%;min-width:850px}th,td{padding:11px;border-bottom:1px solid #26384e;text-align:left;font-size:13px}th{color:#a9bdd6}
.tablewrap{overflow:auto}.long{color:#61d6ac}.short{color:#ff8c99}.pill{border-radius:20px;padding:4px 8px;background:#253650;white-space:nowrap}
#message{margin:10px 0;color:#ffc86a;min-height:24px}.detail{white-space:pre-wrap;overflow:auto;max-height:440px;font-size:12px}
details{margin:10px 0}.status{font-size:13px}.nowrap{white-space:nowrap}
@media(max-width:700px){body{padding:12px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}h1{font-size:21px}}
</style></head><body>
<div class="top"><div><h1>SWING HUNTER <span style="color:#71b5ff">MONITOR</span></h1><small>V1.9.5 • Research only • Без реални сделки</small></div>
<div class="status" id="updated">Не са заредени данни</div></div>
<section class="panel"><h2>Достъп до мониторинга</h2><div class="filters">
<input id="token" type="password" placeholder="SWING_ADMIN_TOKEN" autocomplete="off" style="flex:1;min-width:190px">
<button id="connect">Свържи</button><button id="refresh">Обнови</button></div>
<small>Токенът се пази само в паметта на тази страница и се изпраща като защитен header. Не се записва в URL или localStorage.</small>
<div id="message"></div></section>
<div class="cards"><div class="metric"><small>Последни сигнали</small><strong id="total">—</strong></div>
<div class="metric"><small>TRACKING</small><strong id="tracking">—</strong></div>
<div class="metric"><small>RESOLVED (цялата D1)</small><strong id="resolved">—</strong></div>
<div class="metric"><small>LONG / SHORT</small><strong id="sides">—</strong></div></div>
<section class="panel"><h2>Записани патерни и резултати</h2>
<div class="filters"><select id="side"><option value="">Всички посоки</option><option>LONG</option><option>SHORT</option></select>
<select id="tf"><option value="">Всички таймфреймове</option><option>1h</option><option>4h</option><option>1d</option></select>
<select id="status"><option value="">Всички статуси</option><option>TRACKING</option><option>RESOLVED</option></select>
<input id="coin" placeholder="Монета, напр. BTC" maxlength="10" style="width:150px">
</div><small>Филтрите се прилагат върху цялата D1 база. По 100 записа на страница.</small>
<div class="filters"><button id="prev">← Предишна</button><span id="pageInfo" class="muted">Страница —</span><button id="next">Следваща →</button></div>
<div class="tablewrap"><table><thead><tr><th>Време (UTC)</th><th>Монета</th><th>TF</th><th>Патерн</th><th>Посока</th><th>Цена</th><th>Статус</th><th>Филтри / TP-SL</th></tr></thead><tbody id="rows"><tr><td colspan="8">Свържи се, за да заредиш данни.</td></tr></tbody></table></div></section>
<section class="panel" style="margin-top:14px"><h2>Подробности за избрания сигнал</h2><div id="detail" class="muted">Избери „Виж“ от таблицата.</div></section>
<script>
(function(){
'use strict';
var token='',records=[],busy=false,page=1,pages=1,requestId=0;
var el=function(id){return document.getElementById(id)};
var escapeHtml=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
function fmt(v){if(v==null||v==='')return '—';var n=Number(v);return Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:7}):'—'}
function time(v){var n=Number(v);var d=Number.isFinite(n)&&n>0?new Date(n):new Date(v);return isNaN(d.getTime())?'—':d.toISOString().replace('T',' ').slice(0,16)}
function filters(x){var c=x.context||{};var keys=['btcDirection','fearGreed','macroEvents','multiTimeframe','supportResistance','volume','indicators','liquiditySpread'];return keys.map(function(k){return k+': '+((c[k]||{}).status||'—')}).join(' | ')}
function render(){
 el('rows').innerHTML=records.length?records.map(function(x,i){
 var sc=x.outcome&&x.outcome.scenarios||[],tp=sc.filter(function(s){return s.status==='TP_FIRST'}).length,sl=sc.filter(function(s){return s.status==='SL_FIRST'}).length;
 return '<tr><td class="nowrap">'+escapeHtml(time(x.signal_bar_open))+'</td><td><b>'+escapeHtml(x.coin)+'</b></td><td>'+escapeHtml(x.interval)+'</td><td>'+escapeHtml(x.pattern)+'</td><td class="'+(x.side==='LONG'?'long':'short')+'">'+escapeHtml(x.side)+'</td><td>'+escapeHtml(fmt(x.reference_price??x.entry_price))+'</td><td><span class="pill">'+escapeHtml(x.status)+'</span></td><td><button data-i="'+i+'">Виж</button> <small>'+(sc.length?'TP: '+tp+' · SL: '+sl:'8 филтъра')+'</small></td></tr>'}).join(''):'<tr><td colspan="8">Няма записи по избраните филтри.</td></tr>';
 el('pageInfo').textContent='Страница '+page+' / '+pages;
 el('prev').disabled=page<=1;el('next').disabled=page>=pages;
}
async function load(){
 if(!token){el('message').textContent='Въведи SWING_ADMIN_TOKEN от Cloudflare Secrets.';return}
 if(busy){return}busy=true;el('message').textContent='Зареждане…';
 try{
 var qs=new URLSearchParams({limit:'100',page:String(page)});
 if(el('side').value)qs.set('side',el('side').value);
 if(el('tf').value)qs.set('interval',el('tf').value);
 if(el('status').value)qs.set('status',el('status').value);
 if(el('coin').value.trim())qs.set('coin',el('coin').value.trim().toUpperCase());
 var r=await fetch('/api/swing/v19/history?'+qs.toString(),{headers:{'x-swing-token':token},cache:'no-store'});
 var j=await r.json();if(!r.ok||!j.success)throw Error(j.error||'HTTP '+r.status);
 records=Array.isArray(j.rows)?j.rows:[];page=Number(j.page)||1;pages=Number(j.pages)||1;
 var s=j.stats||{};
 el('total').textContent=Number(s.total)||0;el('tracking').textContent=Number(s.tracking)||0;
 el('resolved').textContent=Number(s.resolved)||0;
 el('sides').textContent=(Number(s.longs)||0)+' / '+(Number(s.shorts)||0);
 render();el('message').textContent='Заредени '+records.length+' от '+(Number(j.filteredTotal)||0)+' записа по филтрите.';
 el('updated').textContent='Обновено: '+new Date().toLocaleTimeString('bg-BG');
 }catch(e){el('message').textContent='Грешка: '+e.message;el('updated').textContent='Неуспешно зареждане'}finally{busy=false}
}
el('connect').onclick=function(){token=el('token').value.trim();el('token').value='';page=1;load()};
el('refresh').onclick=load;
el('prev').onclick=function(){if(page>1&&!busy){page--;load()}};
el('next').onclick=function(){if(page<pages&&!busy){page++;load()}};
['side','tf','status','coin'].forEach(function(k){el(k).addEventListener(k==='coin'?'change':'change',function(){page=1;load()})});
el('rows').onclick=function(e){var b=e.target.closest('button[data-i]');if(!b)return;var x=records[Number(b.dataset.i)];if(!x)return;
el('detail').innerHTML='<div><b>'+escapeHtml(x.coin)+' · '+escapeHtml(x.pattern)+' · '+escapeHtml(x.side)+'</b></div><details open><summary>8 филтъра — статус</summary><pre class="detail">'+escapeHtml(filters(x))+'</pre></details><details open><summary>Контекст при сигнала</summary><pre class="detail">'+escapeHtml(JSON.stringify(x.context||{},null,2))+'</pre></details><details><summary>TP / SL сценарии (хипотетични)</summary><pre class="detail">'+escapeHtml(JSON.stringify(x.outcome||{status:'PENDING'},null,2))+'</pre></details>';
};
setInterval(function(){if(token&&!document.hidden)load()},60000);
})();
</script></body></html>`;
}
