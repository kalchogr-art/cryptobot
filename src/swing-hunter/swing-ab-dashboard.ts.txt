/** Swing Hunter A/B Research Dashboard — DISPLAY ONLY.
 * Historical snapshot provided from D1 replay, NOT live API or execution.
 * No orders, no writes, no changes to existing dashboard.
 */
export function swingABDashboard(): string {
  return `<!doctype html>
<html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Swing Hunter · A/B Research</title>
<style>
:root{color-scheme:dark;font-family:system-ui,Arial,sans-serif;background:#090f1d;color:#e8efff}*{box-sizing:border-box}body{margin:auto;max-width:1250px;padding:20px}h1{font-size:25px;margin:0}h2{font-size:19px}small,.muted{color:#9aabc7}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.panel,.card{background:#121e32;border:1px solid #2b3d58;border-radius:14px;padding:17px;margin:15px 0}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.card{margin:0}.card strong{display:block;font-size:27px;margin-top:8px}.green{color:#5ee1ac}.red{color:#ff8797}.amber{color:#ffcb78}.badge{display:inline-block;padding:6px 10px;border-radius:20px;background:#3d3320;color:#ffcb78;font-size:12px}.tablewrap{overflow:auto}table{width:100%;border-collapse:collapse;min-width:730px}th,td{padding:11px 10px;border-bottom:1px solid #293a53;text-align:left;font-size:13px}th{color:#a9bdd6}button,a.btn{border:1px solid #3d5574;background:#1b3453;color:#e8efff;padding:10px 13px;border-radius:9px;cursor:pointer;text-decoration:none}button.active{background:#275fa5}.filters{display:flex;gap:8px;flex-wrap:wrap;margin:15px 0}.note{line-height:1.6;color:#b5c4da}.hero{font-size:38px;font-weight:800}.split{display:grid;grid-template-columns:1fr 1fr;gap:14px}.bars{display:flex;height:14px;border-radius:8px;overflow:hidden;background:#24344c;margin:9px 0}.bars span{display:block;height:100%}@media(max-width:700px){body{padding:12px}.cards,.split{grid-template-columns:repeat(2,minmax(0,1fr))}.hero{font-size:28px}}
</style></head><body>
<div class="top"><div><h1>SWING HUNTER · A/B RESEARCH</h1><small>BTC regime comparison · SHORT 1H + 4H · TP 2% / SL 1%</small></div><span class="badge">ИСТОРИЧЕСКА СНИМКА · НЕ LIVE</span></div>
<div class="panel"><div class="top"><h2>Сравнение на филтрите</h2><div class="filters"><button id="all" class="active">Общо 1H + 4H</button><button id="one">Само 1H</button><button id="four">Само 4H</button></div></div>
<div class="split"><div class="card"><small>Вариант A · BTC 1H MIXED</small><div id="a-rate" class="hero">67.53%</div><small id="a-closed">77 TP/SL приключили</small><div class="bars"><span id="a-bar" style="background:#5ee1ac;width:67.53%"></span></div><small id="a-net">Хипотетичен NET сбор +65.8845%</small></div><div class="card"><small>Вариант B · BTC 1H MIXED + BTC 4H MIXED</small><div id="b-rate" class="hero green">83.33%</div><small id="b-closed">60 TP/SL приключили</small><div class="bars"><span id="b-bar" style="background:#5ee1ac;width:83.33%"></span></div><small id="b-net">Хипотетичен NET сбор +79.20%</small></div></div></div>
<div class="cards"><div class="card"><small>Разлика win rate B−A</small><strong id="delta" class="green">+15.80 п.п.</strong></div><div class="card"><small>Приети входове A / B</small><strong id="entries">93 / 74</strong></div><div class="card"><small>Стопове A / B</small><strong id="losses">25 / 10</strong></div><div class="card"><small>TRACKING A / B</small><strong id="tracking">15 / 14</strong></div></div>
<section class="panel"><h2>Хронологичен replay · изходни данни</h2><div class="tablewrap"><table><thead><tr><th>Вариант</th><th>TF</th><th>Сигнали</th><th>Приети</th><th>SKIP</th><th>TP</th><th>SL</th><th>TIME</th><th>TRACKING</th><th>Win rate</th><th>NET сбор</th></tr></thead><tbody id="table"></tbody></table></div><p class="note">Една изследователска позиция на монета и посока между 1H и 4H. TRACKING блокира следващите входове при липса на доказан изход. Win rate = TP / (TP + SL). NET е сбор на хипотетични резултати, а не доходност на сметка.</p></section>
<section class="panel"><h2>Проверка за коректност на вход/изход</h2><div class="cards"><div class="card"><small>Проверени приключили записи</small><strong>161</strong></div><div class="card"><small>Липсващ touch time</small><strong class="green">0</strong></div><div class="card"><small>Изход преди вход</small><strong class="green">0</strong></div><div class="card"><small>Вход вътре в touch свещ</small><strong class="green">0</strong></div></div><p class="note">Проверката е върху записи за DOUBLE MIXED (152 за 1H и 9 за 4H), не върху 161 независими позиции.</p></section>
<section class="panel"><h2>Статус на внедряване</h2><p class="note"><b class="green">Dashboard:</b> A/B визуализация на последния потвърден SQL replay.<br><b class="amber">Execution:</b> не е променян.<br><b class="amber">Live:</b> не е променян.<br><b>Обновяване:</b> данните са статичен snapshot от предоставените SQL резултати; за автоматично обновяване е необходим нов read-only API.</p><a class="btn" href="/swing-hunter/monitor">← Съществуващ монитор</a></section>
<script>
(function(){'use strict';
const data=[
{v:'A',tf:'1h',c:122,a:85,s:37,tp:46,sl:23,time:1,t:15,net:57.3245},
{v:'A',tf:'4h',c:19,a:8,s:11,tp:6,sl:2,time:0,t:0,net:8.56},
{v:'B',tf:'1h',c:89,a:68,s:21,tp:44,sl:10,time:0,t:14,net:68.28},
{v:'B',tf:'4h',c:7,a:6,s:1,tp:6,sl:0,time:0,t:0,net:10.92}
];
const $=x=>document.getElementById(x);const sum=(rows,k)=>rows.reduce((a,r)=>a+r[k],0);
function update(tf){const rows=data.filter(r=>!tf||r.tf===tf);const group=v=>{const rr=rows.filter(r=>r.v===v);const out={};['c','a','s','tp','sl','time','t','net'].forEach(k=>out[k]=sum(rr,k));out.rate=out.tp+out.sl?100*out.tp/(out.tp+out.sl):null;return out};const a=group('A'),b=group('B');
for(const [v,o] of [['a',a],['b',b]]){$(v+'-rate').textContent=o.rate===null?'—':o.rate.toFixed(2)+'%';$(v+'-closed').textContent=(o.tp+o.sl)+' TP/SL приключили';$(v+'-net').textContent='Хипотетичен NET сбор '+(o.net>=0?'+':'')+o.net.toFixed(4)+'%';$(v+'-bar').style.width=(o.rate||0)+'%'}
$('delta').textContent=a.rate===null||b.rate===null?'—':((b.rate-a.rate)>=0?'+':'')+(b.rate-a.rate).toFixed(2)+' п.п.';$('entries').textContent=a.a+' / '+b.a;$('losses').textContent=a.sl+' / '+b.sl;$('tracking').textContent=a.t+' / '+b.t;
$('table').innerHTML=rows.map(r=>'<tr><td><b>'+r.v+'</b></td><td>'+r.tf+'</td><td>'+r.c+'</td><td>'+r.a+'</td><td>'+r.s+'</td><td class="green">'+r.tp+'</td><td class="red">'+r.sl+'</td><td>'+r.time+'</td><td>'+r.t+'</td><td>'+((r.tp+r.sl)?(100*r.tp/(r.tp+r.sl)).toFixed(2)+'%':'—')+'</td><td>'+(r.net>=0?'+':'')+r.net.toFixed(4)+'%</td></tr>').join('');
for(const [id,value] of [['all',''],['one','1h'],['four','4h']])$(id).classList.toggle('active',tf===value);
}
$('all').onclick=()=>update('');$('one').onclick=()=>update('1h');$('four').onclick=()=>update('4h');update('');
})();
</script></body></html>`;
}
