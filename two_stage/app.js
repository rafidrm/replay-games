import {localAPI,importPack,backupProgress,restoreProgress,lastSession,sessionKey} from './storage.mjs';
import {entrySetup,profitSetup} from './signals.mjs';
import {moneyness,nearStrikes,orderContracts} from './contracts.mjs';
import {entrySizing} from './policies.mjs';
import {optionSVG,optionLabel,quoteCaption,windowCaption} from './option-chart.mjs';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = n => n == null ? 'Unknown' : new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
const num = (n,d=2) => n == null ? '—' : Number(n).toFixed(d);
const time = m => `${String(Math.floor((570+m)/60)).padStart(2,'0')}:${String((570+m)%60).padStart(2,'0')}`;
const escape = s => String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
$('#welcome').hidden=false;
const presets = {price:{},vwap:{vwap:true,levels:true},full:{vwap:true,ema:true,volume:true,levels:true,detector:true,model:true}};
let state=null, side='CALL', selected='', manualSelection='', busy=false, history=[], finishFocus=null,library=null;
let chartData=null,chartRequest='';
const intervalKey=()=>sessionKey+':interval:'+state.id;
const chartWidth=()=>state.engine_version===2?(Number(localStorage.getItem(intervalKey()))|| (state.setup?.entry.window===3?3:5)):5;

function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,6500)}
async function api(path,body){return localAPI(path,body)}
async function task(fn){if(busy)return;busy=true;document.body.classList.add('loading');$('#loading-status').hidden=false;try{await fn()}catch(e){toast(e.message)}finally{busy=false;document.body.classList.remove('loading');$('#loading-status').hidden=true}}
async function action(kind,extra={}){await task(async()=>{state=await api('/api/action',{id:state.id,revision:state.events.length,action:kind,note:$('#decision-note').value,...extra});if(kind!=='layers')$('#decision-note').value='';render();if(state.finished){await loadHistory();$('#debrief').scrollIntoView({behavior:'smooth'})}})}
function colored(el,value){el.textContent=money(value);el.classList.toggle('positive',value>0);el.classList.toggle('negative',value<0)}

$('#deal').onclick=()=>task(async()=>{state=await api('/api/new',{previous:state?.id,setup_id:$('#setup-select').value||undefined,layers:presets[$('#start-preset').value],plan:{entry:$('#plan-entry').value,risk:Number($('#plan-risk').value),stop:Number($('#plan-stop').value),trades:3}});localStorage.setItem(sessionKey,state.id);side=state.watchlist?.side||'CALL';selected='';manualSelection='';$('#toast').hidden=true;render();window.scrollTo({top:0,behavior:'smooth'})});
$('#next').onclick=()=>action('advance');
$('#finish').onclick=()=>{finishFocus=document.activeElement;$('#finish-dialog').showModal()};
$('#cancel-finish').onclick=()=>{$('#finish-dialog').close();finishFocus?.focus()};
$('#confirm-finish').onclick=()=>{$('#finish-dialog').close();action('finish')};
$('#save-note').onclick=()=>{if($('#decision-note').value.trim())action('note')};
$('#calls').onclick=()=>{side='CALL';selected='';manualSelection='';renderContracts();renderFocus()};
$('#puts').onclick=()=>{side='PUT';selected='';manualSelection='';renderContracts();renderFocus()};
$('#expiry').onchange=()=>{selected='';manualSelection='';renderContracts(true)};
$('#contract').onchange=()=>{selected=$('#contract').value;manualSelection=selected;renderQuote()};
const quantityKey=()=>sessionKey+':quantity:'+state.id;
$('#quantity').oninput=()=>{if(state?.policy_cards)localStorage.setItem(quantityKey(),$('#quantity').value);renderQuote();};
$('#use-policy-size').onclick=()=>{localStorage.removeItem(quantityKey());renderQuote();};
$('#buy').onclick=()=>action('buy',{contract:selected,qty:Number($('#quantity').value)});
$('#exit-all').onclick=()=>action('sell',{qty:state.position.qty});
$('#exit-partial').onclick=()=>{const runners=Number($('#runners').value);if(!Number.isInteger(runners)||runners<1||runners>=state.position.qty)return toast('Keep at least one runner and sell at least one whole contract.');action('sell',{qty:state.position.qty-runners})};
$('#sell-custom').onclick=()=>action('sell',{qty:Number($('#sell-quantity').value)});
$('#take-profit').onclick=()=>{const profit=profitSetup(state.position);if(profit.canTrim)action('sell',{qty:profit.quantity})};
$$('[data-layer]').forEach(el=>el.onchange=()=>action('layers',{layers:Object.fromEntries($$('[data-layer]').map(e=>[e.dataset.layer,e.checked]))}));
$('#export').onclick=()=>task(async()=>{const result=await api('/api/export?id='+state.id);const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`two-stage-${state.date}-${state.symbol}-${state.id.slice(0,6)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
$('#history-button').onclick=()=>task(async()=>{await loadHistory();$('#history').hidden=false;$('#history').scrollIntoView({behavior:'smooth'})});
$('#close-history').onclick=()=>$('#history').hidden=true;
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement.tagName)&&!$('#finish-dialog').open&&state&&!state.finished){e.preventDefault();action('advance')}});

function render(){
  document.body.classList.toggle('roster-game',!!state.policy_cards);
  $('#welcome').hidden=true;$('#game').hidden=false;$('#mobile-dock').hidden=false;
  $('#symbol').textContent=state.symbol;$('#session-date').textContent=new Date(state.date+'T12:00:00').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'})+(state.repeated?' · repeated case':'');
  $('#clock').textContent=time(state.minute);$('#progress-fill').style.width=`${100*state.minute/(state.deadline||390)}%`;
  colored($('#total'),state.total);colored($('#realized'),state.realized);colored($('#unrealized'),state.unrealized);$('#cash').textContent=money(state.cash);$('#entries').textContent=`${state.entries} / ${state.plan.trades}`;
  $('#next').disabled=state.finished;$('#dock-next').disabled=false;$('#dock-next-label').textContent=state.finished?'Next day →':state.next_minute?'Next → '+time(state.next_minute):'Next 5 min →';$('#finish').disabled=state.finished;$('#dock-clock').textContent=time(state.minute);$('#dock-trade').textContent=state.finished?'Review':state.position?'Exit / runners':'Entry';
  $$('[data-layer]').forEach(el=>{el.checked=!!state.layers[el.dataset.layer];el.disabled=state.finished});
  $('#last-price').textContent=(state.minute===0?'Open ':'')+money(state.spot);
  $('#next').textContent=state.policy_cards?'Step →':state.next_minute?'Next → '+time(state.next_minute):'Next 5 min →';
  if(state.policy_cards&&!state.finished)$('#dock-next-label').textContent='Step →';
  $('#setup-name').hidden=!state.setup;$('#setup-name').textContent=state.setup?.name||'';$('#ema-label').textContent=`EMA ${state.ema_fast||8} / 21`;
  $('[data-layer="model"]').closest('label').hidden=!!state.setup;
  $('#finish-description').textContent=state.setup?`Reveal the remaining candles and close at the ${time(state.deadline)} bid. Missing prices leave P&L unresolved.`:'Reveal the remaining candles and close at the 16:00 bid. Unavailable quotes or depth leave P&L unresolved.';
  chartData=null;chartRequest='';
  renderPolicyCards();drawChart();drawModel();renderSignals();renderGates();renderFocus();renderContracts();renderPosition();renderDiscipline();renderTape();renderDebrief();
  $('#save-note').disabled=state.finished;$('#decision-note').disabled=state.finished;
}

function renderSignals(){
  const s=state.signals;const bits=[];
  if(state.layers.vwap)bits.push(`<span>VWAP side<b>${s.vwap_side==='CALL'?'Above':s.vwap_side==='PUT'?'Below':'—'}</b></span>`,`<span>Retest<b>${s.retest?s.retest+' setup':'None now'}</b></span>`,`<span>Fresh cross<b>${s.cross||'None now'}</b></span>`);
  if(state.layers.ema)bits.push(`<span>EMA ${state.ema_fast||8} / 21<b>${s.ema==='CALL'?'Bullish':s.ema==='PUT'?'Bearish':'Warming / unavailable'}</b></span>`);
  
  $('#signals').innerHTML=bits.join('');
}
function renderGates(){
  const headings=$$('.gates-panel h2');headings[0].textContent=state.setup?'01 · Watchlist':'01 · Premarket';headings[1].textContent=state.setup?'02 · Entry setup':'02 · Intraday trend';$('.detail-toggle').hidden=!!state.setup;
  if(state.setup){$('#gate-summary').textContent='Setup details';$('#screens').textContent=`${state.watchlist.name} · rank ${state.watchlist.rank} · ${state.watchlist.side}`;$('#gate-status').textContent=state.setup.description+' '+state.setup.caution;return;}
  $('#gate-summary').textContent='Gate details';
  $('#screens').innerHTML=state.screens.map(s=>`<div class="screen-row"><span class="${s.passed?'passed':'muted'}">${s.passed?'✓':'–'} ${escape(s.name)}</span><span class="screen-value">${state.layers.detector?`${num(s.value,3)} / ≥ ${num(s.threshold,3)}`:s.passed?'Passed':'—'}</span></div>`).join('');
  $('#gate-status').innerHTML=`<p class="small">${state.gate_passed?`First ≥50% at ${time(state.gate_minute)}`:'Waiting for ≥50%'}</p><span class="small muted">Logistic trend probability · not direction</span>`;
}
function renderFocus(){
  const chip=(label,passed)=>`<span class="focus-chip ${passed===true?'yes':passed===false?'no':'unknown'}">${passed===true?'✓':passed===false?'○':'–'} ${escape(label)}</span>`;
  if(state.setup)renderStageCards();else{
  const passed=state.screens.filter(s=>s.passed).length;
  $('#premarket-focus').classList.toggle('ready',passed>0);
  $('#premarket-focus').innerHTML=`<div class="focus-label">01 · PREMARKET</div><div class="focus-value"><strong>${passed} / ${state.screens.length}</strong><span>screens passed</span></div><div class="focus-chips">${state.screens.map((s,i)=>chip(['RVOL','Expansion','Range'][i],s.passed)).join('')}</div>`;
  $('#trend-focus').classList.toggle('ready',state.gate_passed);
  $('#trend-focus').innerHTML=`<div class="focus-label">02 · INTRADAY TREND</div><div class="focus-value"><strong>${state.probability==null?(state.gate_passed?'Passed':'Waiting'):num(state.probability*100,1)+'%'}</strong><span class="focus-status ${state.gate_passed?'yes':'wait'}">${state.gate_passed?'PASSED':'WAIT'}</span></div><div class="focus-caption">${state.gate_passed?`Activated ${time(state.gate_minute)}`:state.minute===0?'First update 09:35':'Needs ≥50%'}${state.probability_minute!=null&&state.minute>state.probability_minute?` · last ${time(state.probability_minute)}`:''}</div>`;
  }
  const direction=state.position?.right||side,setup=entrySetup(state,direction);
  $('#entry-focus').classList.remove('profit-due','profit-missed');
  if(state.finished){
    $('#entry-focus').classList.toggle('ready',state.score===100);
    $('#entry-focus').innerHTML=`<div class="focus-label">03 · DAY COMPLETE</div><div class="focus-value"><strong>${state.score==null?'—':state.score+'%'}</strong><span>PLAN CHECKS</span></div><div class="focus-caption">${state.checks.filter(c=>c.passed).length} / ${state.checks.length} checks passed</div>`;
    return;
  }
  if(state.position&&state.profit_version){
    const p=state.position,profit=profitSetup(p),due=profit.due.length>0,missed=profit.missed.length>0;
    const t=state.trend_exit;
    if(t&&t.status!=='watching'&&t.priority!=='target'){
      const label=t.priority==='stop'?'STOP':t.priority==='missing_quote'?'NO BID':t.status==='alert'?'GET READY':t.status==='due'?'EXIT NOW':'EXIT MISSED';
      $('#entry-focus').classList.remove('ready');$('#entry-focus').classList.add(t.status==='missed'?'profit-missed':'profit-due');
      $('#entry-focus').innerHTML=`<div class="focus-label">03 · VWAP EXIT</div><div class="focus-value"><strong>${time(t.execution_minute)}</strong><span class="focus-status wait">${label}</span></div><div class="focus-caption">${t.priority==='stop'?'Original premium stop takes priority.':t.priority==='missing_quote'?'No usable bid. Exit remains manual; no price is invented.':'2 × 5m own-VWAP conflicts · exit all remaining contracts.'}</div>`;return;
    }
    $('#entry-focus').classList.toggle('ready',p.premium_return>0&&!due&&!missed);
    $('#entry-focus').classList.toggle('profit-due',due);$('#entry-focus').classList.toggle('profit-missed',!due&&missed);
    $('#entry-focus').innerHTML=`<div class="focus-label">03 · EXIT · ${direction}</div><div class="focus-value"><strong>${p.premium_return==null?'No quote':(p.premium_return>=0?'+':'')+num(p.premium_return*100,1)+'%'}</strong><span class="focus-status ${due||missed?'wait':'yes'}">${due?'TAKE PROFIT':missed?'TARGET MISSED':p.runner?'RUNNERS':'OPEN'}</span></div><div class="focus-caption">${due?profit.due.map(f=>'+'+f.percent+'%').join(' / ')+' reached · trim before advancing':missed?'Missed '+profit.missed.map(f=>'+'+f.percent+'%').join(' / ')+(profit.next==null?'':` · next +${profit.next}%`):(profit.next==null?'Planned targets reached':`Next +${profit.next}% · bid ${money(profit.nextBid)}`)}</div>`;
    if(t?.status==='watching')$('#entry-focus .focus-caption').textContent+=` · VWAP conflicts ${t.consecutive}/2${t.missing?' · gaps reset count':''}`;
    return;
  }
  $('#entry-focus').classList.toggle('ready',setup.ready);
  const vetoed=state.setup_signal?.status==='veto';$('#entry-focus').classList.toggle('profit-due',vetoed);
  const extra=!state.setup&&state.layers.vwap&&state.plan.entry==='discretionary'?chip('VWAP side',state.signals.vwap_side===direction)+chip('Retest',state.signals.retest===direction):'';
  $('#entry-focus').innerHTML=`<div class="focus-label">03 · ENTRY · ${direction}</div><div class="focus-value"><strong>${setup.label}</strong><span class="focus-status ${setup.ready?'yes':'wait'}">${vetoed?'SKIP DAY':setup.ready?(!state.setup&&state.plan.entry==='discretionary'?'MANUAL':'READY'):'WAIT'}</span></div><div class="focus-chips">${setup.requirements.map(r=>chip(r.name,r.passed)).join('')}${extra}${!state.setup&&state.layers.ema&&state.plan.entry!=='retest_ema'?chip('EMA aligned',state.signals.ema===direction):''}</div>`;
}
function renderContracts(keepExpiry=false){
  if(!state)return;
  $('#calls').classList.toggle('active',side==='CALL');$('#puts').classList.toggle('active',side==='PUT');
  const all=state.contracts.filter(c=>c.right===side),expiries=[...new Set(all.map(c=>c.expiration))].sort();
  const old=$('#expiry').value;
  $('#expiry').innerHTML=expiries.map(d=>`<option value="${d}">${d}${d===state.date?' · 0DTE':''}</option>`).join('');
  if(expiries.includes(old))$('#expiry').value=old;
  const listed=all.filter(c=>c.expiration===$('#expiry').value).sort((a,b)=>a.strike-b.strike);
  const spot=state.spot,near=nearStrikes(listed,spot);
  const contracts=orderContracts(listed,spot,{selected:manualSelection});
  $('#coverage').hidden=contracts.length>0;
  $('#coverage').textContent=state.minute===0?'Waiting for opening quotes. Advance to 09:35.':'No nearby quotes now. Try the other expiry or advance.';
  $('#menu-scope').hidden=state.menu_version!==1;
  $('#menu-scope').textContent='Old saved menu. Replay this day to use current coverage.';
  selected=contracts.some(c=>c.id===manualSelection)?manualSelection:contracts[0]?.id||'';
  $('#contract').innerHTML=contracts.length?contracts.map(c=>`<option value="${escape(c.id)}">$${num(c.strike)} · ${moneyness(c,spot,near).label}${c.quote?'':' · no quote'}</option>`).join(''):'<option value="">No nearby quotes</option>';
  $('#contract').value=selected;renderQuote();
}
function renderQuote(){
  if(!state)return;
  const c=state.contracts.find(c=>c.id===selected),q=c?.quote;
  const sized=state.policy_cards&&!state.position,manual=sized?localStorage.getItem(quantityKey()):null;
  const suggestion=sized?entrySizing(state.setup,q,state.cash):null;
  if(sized){if(manual!==null)$('#quantity').value=manual;else $('#quantity').value=suggestion?.recommended??'';}
  const qty=Number($('#quantity').value),split=sized?entrySizing(state.setup,q,state.cash,qty):null;
  $('#use-policy-size').hidden=!sized||manual===null;$('#use-policy-size').disabled=!suggestion;$('#use-policy-size').textContent='Use policy size'+(suggestion?' · '+suggestion.recommended:'');
  $('#sizing-preview').hidden=!sized;
  $('#sizing-preview').textContent=split?`${manual!==null?'Manual size · ':''}Policy size ${split.recommended}. `+(split.first?`Sell ${split.first} at +${state.setup.exit.first}%${split.runner?`; keep ${split.runner} for +${state.setup.exit.second}%`:' · full exit'}.`:'No contracts within the policy budget.'):'Sizing waits for a current quote.';
  $('#quote-box').innerHTML=q?`<div><span>BID</span><b>${money(q.bid)}</b><small>${state.setup?'Observed bid':c.bid_available+' available'}</small></div><div><span>ASK</span><b>${money(q.ask)}</b><small>${state.setup?'Observed ask':c.ask_available+' available'}</small></div><div class="quote-warning">Spread ${num(100*(q.ask-q.bid)/(state.setup?(q.ask+q.bid)/2:q.ask),1)}% · ${time(state.minute)}</div>`:`<div class="quote-warning">No current quote.</div>`;
  const cost=q?q.ask*qty*100:null,risk=cost*state.plan.stop/100,budget=20000*state.plan.risk/100;
  $('#cost-preview').innerHTML=q&&state.setup?`Premium <b class="${cost>state.setup.budget||qty>state.setup.max_contracts?'negative':''}">${money(cost)}</b> / ${money(state.setup.budget)} cap<br>Max ${state.setup.max_contracts} contracts · stop risk ${money(risk)}`:q?`Premium <b>${money(cost)}</b><br>Stop risk <b class="${risk>budget?'negative':''}">${money(risk)}</b> / ${money(budget)}`:'No current fill available.';
  $('#buy').disabled=state.finished||!!state.position||!q||!Number.isInteger(qty)||qty<1||qty>1000||cost>state.cash||qty>c.ask_available;
  $('#buy').textContent=q?`Buy ${Number.isInteger(qty)?qty:'…'} at ${money(q.ask)}`:'Buy at ask';
  if(state.setup_signal?.status==='veto'&&q)$('#buy').textContent='Off-plan buy · entry vetoed';
  else if(state.policy_cards&&q&&(state.setup_signal.status!=='ready'||side!==state.watchlist.side||state.entries))$('#buy').textContent='Off-plan buy · '+money(q.ask);
  refreshCharts();
}
function renderPosition(){
  const p=state.position;$('#entry-form').hidden=!!p;$('#position-form').hidden=!p;$('#position-tag').textContent=p?(p.runner?'RUNNERS':'OPEN'):'FLAT';$('#trade-heading').textContent=p?'Position':'Entry';
  $('#profit-plan b').textContent=state.setup?targetText(state.setup):'+25% → +50% → +75%…';
  $('#profit-plan').hidden=!!p||!state.profit_version;
  if(!p)return;
  const profit=profitSetup(p),due=profit.due.length>0;
  $('#profit-panel').hidden=!state.profit_version;
  $('#profit-panel').classList.toggle('due',due);
  $('#profit-flags').innerHTML=profit.targets.map(f=>`<span class="profit-flag ${f.status}" title="${f.minute!=null?'Reached '+time(f.minute):'Target'}${f.taken_minute!=null?' · sold '+time(f.taken_minute):''}"><b>+${f.percent}%</b><small>${{due:'Take now',taken:'✓ Taken',late:'Taken late',missed:'Missed',next:'Next'}[f.status]}</small></span>`).join('');
  $('#profit-caption').textContent=due?state.setup?'Sell the planned quantity before advancing.':'Take some profit before Next 5 min.':p.quote?(profit.next==null?'Planned targets reached.':`Next target: ${money(profit.nextBid)} bid · +${profit.next}%`):'No current quote. Targets wait for a usable bid.';
  $('#take-profit').disabled=state.finished||!profit.canTrim;
  $('#take-profit').textContent=profit.quantity?`Take profit · ${profit.quantity===p.qty?'exit':'sell'} ${profit.quantity}`:'Take profit';
  $('#profit-size').textContent=profit.quantity===p.qty?'Full exit':profit.quantity?`Keeps ${p.qty-profit.quantity} runner${p.qty-profit.quantity===1?'':'s'}${state.setup?' · planned split':' · half remaining, limited by bid size'}`:state.setup?'Waiting for a profit target':'No bid size available';
  $('#position-name').textContent=`${state.symbol} ${num(p.strike)} ${p.right.toLowerCase()}`;
  $('#position-detail').innerHTML=[['Expiration',p.expiration],['Contracts remaining',`${p.qty} of ${p.initial_qty}`],['Entry ask',`${money(p.entry)} · ${time(p.entry_minute)}`],['Current bid',p.quote?money(p.quote.bid):'Unknown'],['Premium return',p.premium_return==null?'Unknown':num(100*p.premium_return,1)+'%'],['Booked on this position',money(p.realized)],[state.setup?'Execution':'Available bid size',state.setup?'Observed bid/ask':p.bid_available]].map(([a,b])=>`<div class="detail-row"><span>${a}</span><b>${b}</b></div>`).join('');
  if(state.stop_rule)$('#position-detail').insertAdjacentHTML('beforeend',`<div class="detail-row"><span>${state.stop_rule.breakeven?'Runner stop':'Premium stop'}</span><b>${money(state.stop_rule.price)} · ${state.stop_rule.active?'active':'from '+time(state.stop_rule.activation)}</b></div>`);
  $('#stop-alert').hidden=p.stop_alert==null;$('#stop-alert').textContent=`Stop alert at ${time(p.stop_alert||0)}. Your −${state.plan.stop}% premium rule was breached. This is a manual exit; the game will not protect the position for you.`;
  if(state.stop_rule&&p.stop_alert!=null)$('#stop-alert').textContent=`${state.stop_rule.breakeven?'Breakeven runner':'Premium'} stop hit at ${time(p.stop_alert)}. Sell remaining contracts.`;
  const t=state.trend_exit;$('#trend-exit-alert').hidden=!t||t.status==='watching';
  $('#trend-exit-alert').textContent=t&&t.status!=='watching'?`Own-VWAP exit ${time(t.execution_minute)} · ${t.priority==='target'?'original profit target takes priority':t.priority==='stop'?'original stop takes priority':t.priority==='missing_quote'?'no usable bid':t.status==='alert'?'prepare to sell all remaining contracts next minute':t.status==='due'?'sell all remaining contracts now':'exit time passed'}.`:'';
  $('#exit-all').disabled=state.finished||p.bid_available<p.qty;$('#exit-partial').disabled=state.finished||p.qty<2||p.bid_available<1;$('#sell-custom').disabled=state.finished||p.bid_available<1;
  $('#runners').max=Math.max(1,p.qty-1);$('#sell-quantity').max=p.qty;
}
function renderDiscipline(){
  const name={retest:'Wait for a VWAP retest',retest_ema:'VWAP retest + aligned EMA 8/21',discretionary:'Discretionary entries'}[state.plan.entry];
  $('#commitment').textContent=`${name}. Maximum ${state.plan.risk}% planned risk, ${state.plan.trades} entries, and a −${state.plan.stop}% manual premium stop. Spread check: ≤15%.`;
  if(state.profit_version)$('#commitment').textContent+=' Take some profit at each +25% bid-return milestone before advancing.';
  if(state.setup)$('#commitment').textContent=`${state.setup.description} ${targetText(state.setup)}. −${state.plan.stop}% stop starts ${Math.max(1,state.setup.exit.grace)} minute(s) after entry. ${money(state.setup.budget)} cap, max ${state.setup.max_contracts} contracts. Manual fills at observed bid/ask; no size limits. ${state.setup.caution}`;
  $('#checks').innerHTML=state.checks.slice(-6).map(c=>`<div class="check ${c.passed?'':'failed'}"><i>${c.passed?'✓':'!'}</i><span>${escape(c.name)} · ${time(c.minute)}</span></div>`).join('')||'';
}
function renderTape(){
  const events=state.events.filter(e=>['buy','partial','close','note','stop_alert','unknown','gate','profit_target','profit_taken','profit_missed','setup','policy','vwap_unavailable','trend_signal','trend_exit','trend_missed'].includes(e.kind)).slice().reverse();
  $('#tape-summary').textContent=`Trades & notes · ${state.fills.length} fills`;
  $('#tape').innerHTML=events.map(e=>`<div class="tape-row"><time>${time(e.minute)}</time><span class="tape-kind">${escape(e.kind.replace('_',' '))}</span><div>${escape(e.note)}${e.price?`<small>${e.qty} × ${money(e.price)}${e.pnl!==undefined?' · '+money(e.pnl):''}</small>`:''}</div></div>`).join('')||'<p class="empty">No trades yet.</p>';
}
function renderDebrief(){
  $('#debrief').hidden=!state.finished;if(!state.finished)return;
  const passed=state.checks.filter(c=>c.passed).length;
  $('#debrief').innerHTML=`<span class="eyebrow">SESSION COMPLETE / ${escape(state.symbol)} / ${state.date}</span><h2>${state.total==null?'Unresolved exposure':'Day complete'}</h2><div class="debrief-metrics"><div><span>DAILY P&L</span><strong class="${state.total>0?'positive':state.total<0?'negative':''}">${money(state.total)}</strong></div><div><span>PLAN CHECKS</span><strong>${state.score==null?'Not scored':state.score+'%'}</strong></div><div><span>ENTRIES</span><strong>${state.entries}</strong></div></div><p>${state.checks.length?`${passed} of ${state.checks.length} applicable checks passed.`:'No entries means no applicable trade-discipline checks.'} ${state.total==null?`Known realized P&L: ${money(state.realized)}. Missing close liquidity is not counted as zero.`:''}</p><div>${state.checks.map(c=>`<div class="check ${c.passed?'':'failed'}"><i>${c.passed?'✓':'!'}</i><span>${time(c.minute)} · ${escape(c.name)}</span></div>`).join('')}</div><button id="another" class="primary">Next day →</button> <button id="replay-day" class="quiet">Replay this day ↻</button>`;
  $('#another').onclick=()=>{$('#game').hidden=true;$('#welcome').hidden=false;$('#mobile-dock').hidden=true;window.scrollTo({top:0,behavior:'smooth'})};
  if(state.benchmarks?.length)$('#debrief').insertAdjacentHTML('beforeend',benchmarkReview());
  $('#replay-day').onclick=()=>task(async()=>{state=await api('/api/new',{previous:state.id,replay_of:state.id,setup_id:state.setup_id,layers:state.layers,plan:state.plan});localStorage.setItem(sessionKey,state.id);selected='';manualSelection='';render();window.scrollTo({top:0,behavior:'smooth'})});
}

function benchmarkReview(){
  const price=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(n);
  const rows=state.benchmarks,selected=rows.filter(r=>r.setup_id===state.setup_id),parent=rows.filter(r=>r.setup_id==='stock_reclaim'&&r.setup_id!==state.setup_id);
  const row=r=>`<div class="benchmark-row"><span>${r.setup_id===state.setup_id?'This setup':'Original reclaim'} · ${r.profile==='lots2'?'exactly 2 contracts':'$2,000 / max 10'}<small>${r.eligible?`${r.n} contracts · ${time(r.entry_minute)} entry`:r.veto?'Vetoed · no trade':'No trade · '+escape(r.status)}</small></span><b>${money(r.pnl)}</b></div>`;
  const detail=r=>`<div class="benchmark-path"><b>${r.profile==='lots2'?'Exactly 2 contracts':'$2,000 / max 10'}</b>${r.eligible?`<p>${r.n} × ${escape(r.strike)} ${escape(r.side)} · ${escape(r.expiration)}<br>${time(r.entry_minute)} BUY ${r.n} @ ${price(r.debit/(r.n*100))}</p>${r.events.map(e=>`<p>${time(e[0])} SELL ${e[1]} @ ${price(e[2])} · ${escape(e[3].replace('_',' '))}</p>`).join('')}`:`<p>${r.veto?'Entry vetoed. No buy or sale.':'Stayed in cash.'}</p>`}</div>`;
  return `<section class="benchmark-review"><h3>Historical reference</h3><p class="small">${escape(state.benchmark_note)}</p>${[...selected,...parent].map(row).join('')}<details><summary>Reference fills</summary>${selected.map(detail).join('')}</details><p class="small muted">Selected after full-history comparison. No fresh out-of-sample claim.</p></section>`;
}

function drawModel(){
  $('#model-panel').hidden=!state.layers.model||!!state.setup;
  if(!state.layers.model||state.setup)return;
  const points=state.forecasts.filter(f=>f.horizon<=state.minute),last=points.at(-1);
  const svg=$('#model-chart'),W=Math.max(260,svg.clientWidth),H=112,left=9,right=38,top=9,bottom=25;
  const x=m=>left+(m-5)/40*(W-left-right),y=p=>top+(1-p)*(H-top-bottom);
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  $('#model-current').textContent=last?`${num(last.probability*100,1)}% · ${time(last.horizon)}`:'First update 09:35';
  $('#model-status').textContent=state.minute>state.forecast_end?`Forecasts stop at ${time(state.forecast_end)} · ${state.minute-state.forecast_end} min ago`:'50% trend gate';
  let out='';
  for(const p of [0,.5,1])out+=`<line x1="${left}" x2="${W-right}" y1="${y(p)}" y2="${y(p)}" stroke="${p===.5?'#6b7280':'#253246'}" stroke-dasharray="3 5"/><text x="${W-right+7}" y="${y(p)+3}" fill="#8396ac" font-size="9">${p*100}%</text>`;
  for(const m of [5,15,30,45])out+=`<text x="${x(m)}" y="${H-5}" text-anchor="${m===5?'start':m===45?'end':'middle'}" fill="#8396ac" font-size="9">${time(m)}</text>`;
  if(points.length)out+=`<path d="${points.map((f,i)=>`${i?'L':'M'}${x(f.horizon)},${y(f.probability)}`).join(' ')}" stroke="#6ca9f6" stroke-width="1.7" fill="none"/>`;
  for(const f of points)out+=`<circle cx="${x(f.horizon)}" cy="${y(f.probability)}" r="3" fill="#6ca9f6"><title>${time(f.horizon)} · ${num(f.probability*100,1)}%</title></circle>`;
  svg.innerHTML=out;
}

function drawChart(){
  if(!state)return;
  const svg=$('#chart'),W=Math.max(300,svg.clientWidth),H=svg.clientHeight, left=9,right=59,top=25,bottom=27,vol=state.layers.volume?55:0,priceBottom=H-bottom-vol-12;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  const width=chartData?.width??chartWidth(),bars=chartData?.bars??(width===5?state.bars:[]);
  $('#candles-3').disabled=state.engine_version!==2;$('#candles-3').title=state.engine_version===2?'Completed 3-minute stock candles':'This pack contains 5-minute stock candles';
  for(const n of [3,5]){const b=$('#candles-'+n);b.classList.toggle('active',width===n);b.setAttribute('aria-pressed',String(width===n));}
  $('#ema-label').textContent=`EMA ${state.ema_fast||8} / 21${width===3?' · 5m':''}`;
  $('#stock-evidence').hidden=state.setup?.entry.monitor!=='stock';
  $('#stock-evidence').textContent=state.setup?.entry.monitor==='stock'?(windowCaption(chartData?.stock_windows??[])||`Watch starts ${time(state.setup.entry.anchor)}`)+(state.setup.overlay==='exit_vwap_5m_2'?' · Entry 3m / exit 5m':''):'';
  const valid=bars.filter(b=>b.close!=null),values=valid.flatMap(b=>[b.high,b.low,b.vwap,b.ema8,b.ema21].filter(v=>v!=null));
  const earlyLevels=Object.entries(state.levels).filter(([,p])=>p!=null).map(([name,p])=>`${{previous_close:'Prior',premarket_high:'PM high',premarket_low:'PM low'}[name]} ${num(p)}`);
  $('#level-context').hidden=!earlyLevels.length;$('#level-context').textContent=earlyLevels.join(' · ');
  if(!values.length){svg.innerHTML=`<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#8396ac" font-size="12">${state.minute<width?`First ${width}-minute candle at ${time(width)}`:chartData?'No complete candles available':'Loading completed candles…'}</text>`;svg.onpointermove=null;$('#chart-tip').hidden=true;return}
  if(chartData?.stock_reference!=null)values.push(chartData.stock_reference);
  const baseLo=Math.min(...values),baseHi=Math.max(...values),near=Math.max((baseHi-baseLo)*.25,baseLo*.001),plotLevels={},outside=[];
  const levelNames={previous_close:'Prior',premarket_high:'PM high',premarket_low:'PM low'};
  for(const [name,p] of Object.entries(state.levels)){if(p==null)continue;if(p>=baseLo-near&&p<=baseHi+near){plotLevels[name]=p;values.push(p);}else outside.push(`${p<baseLo?'↓':'↑'} ${levelNames[name]} ${num(p)}`);}
  $('#level-context').hidden=!outside.length;$('#level-context').textContent=outside.join(' · ');
  const lo=Math.min(...values),hi=Math.max(...values),pad=Math.max((hi-lo)*.13,lo*.001),min=lo-pad,max=hi+pad;
  const slots=Math.max(state.policy_cards?12:28,bars.length+3),pw=W-left-right,dx=pw/slots,x=m=>left+(m/width-.5)*dx,y=p=>top+(max-p)/(max-min)*(priceBottom-top),cw=Math.max(2,Math.min(11,dx*.63));
  let out=`<defs><clipPath id="plot-clip"><rect x="${left}" y="${top}" width="${pw}" height="${priceBottom-top}"/></clipPath></defs>`;
  for(let i=0;i<5;i++){let p=min+(max-min)*i/4,yy=y(p);out+=`<line x1="${left}" x2="${W-right+4}" y1="${yy}" y2="${yy}" stroke="#253246" stroke-dasharray="2 5"/><text x="${W-right+11}" y="${yy+3}" fill="#7f93aa" font-size="9" font-family="monospace">${p.toFixed(2)}</text>`}
  const step=W<420?(slots>50?18:12):(slots>50?12:6);
  for(let i=0;i<slots;i+=step){out+=`<text x="${left+i*dx}" y="${H-7}" fill="#7f93aa" font-size="9" font-family="monospace">${time(i*width)}</text>`}
  out+='<g clip-path="url(#plot-clip)">';
  for(const w of chartData?.stock_windows??[]){const color=w.status==='signal'?'#65e4b5':w.status==='adverse'?'#ed8191':'#8396ac';out+=`<rect x="${x(w.start)+dx/2}" y="${top}" width="${(w.end-w.start)/width*dx}" height="${priceBottom-top}" fill="${color}" opacity=".1"><title>${escape(windowCaption([w]))}</title></rect>`;}
  if(chartData?.stock_reference!=null){const p=chartData.stock_reference;out+=`<line x1="${x(chartData.stock_anchor)+dx/2}" x2="${x(state.minute)+dx/2}" y1="${y(p)}" y2="${y(p)}" stroke="#eac575" stroke-dasharray="3 3"/><text x="${left+5}" y="${y(p)-4}" fill="#eac575" font-size="9">RECLAIM ${num(p)}</text>`;}
  for(const [name,p] of Object.entries(plotLevels)){if(p!=null)out+=`<line x1="${left}" x2="${W-right}" y1="${y(p)}" y2="${y(p)}" stroke="#607e98" stroke-dasharray="5 5"/><text x="${left+5}" y="${y(p)-4}" fill="#8da4b9" font-size="8">${{previous_close:'PRIOR CLOSE',premarket_high:'PM HIGH',premarket_low:'PM LOW'}[name]} ${num(p)}</text>`}
  for(const [key,color] of [['vwap','#eac575'],['ema8','#b298ef'],['ema21','#6ca9f6']]){let path='',gap=true;for(const b of bars){if(b[key]==null){gap=true;continue}path+=`${gap?'M':'L'}${x(b.minute)},${y(b[key])} `;gap=false}if(path)out+=`<path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" opacity=".9"/>`}
  for(const b of valid){const color=b.close>=b.open?'#65d9b0':'#ed8191';out+=`<line x1="${x(b.minute)}" x2="${x(b.minute)}" y1="${y(b.high)}" y2="${y(b.low)}" stroke="${color}"/><rect x="${x(b.minute)-cw/2}" y="${Math.min(y(b.open),y(b.close))}" width="${cw}" height="${Math.max(1,Math.abs(y(b.open)-y(b.close)))}" fill="${color}"/>`}
  for(const f of state.fills){const b=bars.findLast(b=>b.minute<=f.minute);if(b?.close!=null){const xx=x(f.minute),yy=y(b.close)+(f.side==='BUY'?13:-13);out+=`<circle cx="${xx}" cy="${yy}" r="6" fill="${f.side==='BUY'?'#65e4b5':'#eac575'}"/><text x="${xx}" y="${yy+2.5}" text-anchor="middle" fill="#09251d" font-size="7" font-weight="bold">${f.side==='BUY'?'B':'S'}</text>`}}
  if(state.policy_cards){
    const names={union_vwap_runner:'U',stock_reclaim_exit_vwap_5m_2:'R',qqq_premium_pm_veto:'Q',fixed10_budget:'10'};
    for(const e of state.events.filter(e=>e.kind==='policy'&&['alert','ready','veto'].includes(e.status))){
      const b=bars.findLast(b=>b.minute<=e.minute);if(!b?.close)continue;
      const xx=x(e.minute),yy=top+12+(Object.keys(names).indexOf(e.policy_id)%2)*15,color=e.status==='veto'?'#ed8191':e.policy_id===state.setup_id?'#65e4b5':'#8396ac';
      out+=`<line x1="${xx}" x2="${xx}" y1="${yy+4}" y2="${y(b.close)}" stroke="${color}" stroke-dasharray="2 4" opacity=".4"/><text x="${xx}" y="${yy}" text-anchor="middle" fill="${color}" font-size="9"><title>${escape(time(e.minute)+' · '+e.note)}</title>${names[e.policy_id]}${e.status==='veto'?'×':e.status==='ready'?'↑':'·'}</text>`;
    }
  }
  out+='</g>';
  if(vol){const maxv=Math.max(1,...valid.map(b=>b.volume||0));for(const b of valid){const h=(b.volume||0)/maxv*(vol-10);out+=`<rect x="${x(b.minute)-cw/2}" y="${H-bottom-h}" width="${cw}" height="${h}" fill="${b.close>=b.open?'#294e47':'#543641'}"/>`}}
  const edge=x(state.minute)+dx/2;out+=`<line x1="${edge}" x2="${edge}" y1="${top}" y2="${H-bottom}" stroke="#526476" stroke-dasharray="3 5"/>`;
  if(slots-bars.length>5)out+=`<text x="${edge+(W-right-edge)/2}" y="${top+(priceBottom-top)/2}" text-anchor="middle" fill="#415269" font-size="9" letter-spacing="1.3">NEXT CANDLES HIDDEN</text>`;
  svg.innerHTML=out;
  svg.onpointermove=e=>{const r=svg.getBoundingClientRect(),index=Math.floor((e.clientX-r.left-left)/dx),b=bars[index];if(!b){$('#chart-tip').hidden=true;return}$('#chart-tip').hidden=false;$('#chart-tip').textContent=`${time(b.minute)} ET · O ${num(b.open)}  H ${num(b.high)}  L ${num(b.low)}  C ${num(b.close)}${state.layers.vwap?' · VWAP '+num(b.vwap):''}${state.layers.ema?' · EMA'+(state.ema_fast||8)+' '+num(b.ema8)+' / EMA21 '+num(b.ema21):''}`};
  svg.onpointerleave=()=>$('#chart-tip').hidden=true;
}
new ResizeObserver(()=>{if(state&&!$('#game').hidden){drawChart();drawModel();drawOptions()}}).observe($('.chart-wrap'));
for(const n of [3,5])$('#candles-'+n).onclick=()=>{localStorage.setItem(intervalKey(),String(n));refreshCharts();};

async function refreshCharts(){
  if(!state)return;
  const contract=state.position?.id||(!manualSelection&&state.entries?state.fills.findLast(f=>f.side==='BUY')?.contract:selected)||selected,key=JSON.stringify([state.id,state.minute,state.events.length,contract,chartWidth()]);
  if(key===chartRequest)return;
  chartRequest=key;chartData=null;drawChart();drawOptions();
  try{
    const data=await api('/api/chart?'+new URLSearchParams({id:state.id,contract,width:chartWidth()}));
    if(chartRequest!==key||data.id!==state.id||data.minute!==state.minute||data.revision!==state.events.length)return;
    chartData=data;drawChart();drawOptions();
  }catch(error){if(chartRequest===key){chartRequest='';$('#option-charts').textContent='Charts unavailable · '+error.message;}}
}
function drawOptions(){
  const container=$('#option-charts');
  $('#option-cadence').textContent=state.engine_version===2?'1m quotes':'5m quotes';
  if(!chartData){container.innerHTML='<p class="small muted">Loading observed quotes…</p>';return;}
  let html='';
  if(chartData.monitor_status==='gap')html+='<p class="chart-evidence">Setup paused · missing observations</p>';
  if(chartData.monitor_status&&!chartData.charts.some(c=>c.role.startsWith('setup'))){
    const status=chartData.monitor_status;
    html+=`<p class="chart-evidence">${status==='veto'?'Setup vetoed · no anchor watch':status==='not_applicable'?'Premium setup is QQQ only':status==='gap'?'Setup anchor quote unavailable':`Setup option fixed at ${time(chartData.monitor_anchor)}`}</p>`;
  }
  for(const [i,c] of chartData.charts.entries()){
    const label={setup:'Setup option · fixed anchor',position:'Your position',traded:'Traded contract',selected:'Selected contract','setup-position':'Setup option & your position','setup-selected':'Setup option & selected contract','setup-traded':'Setup option & traded contract'}[c.role];
    html+=`<section class="option-series"><div class="option-title"><h3>${label}</h3><span>${escape(optionLabel(c.contract))}</span></div><div class="option-legend"><span>Bid <i class="key green"></i></span><span>Ask <i class="key purple"></i></span>${c.role.startsWith('setup')?'<span>Mid <i class="key gold"></i></span>':''}</div><svg data-option-chart="${i}" role="img" aria-label="${escape(label+' '+optionLabel(c.contract)+' quotes through '+time(state.minute))}"></svg><div class="option-tip" data-option-tip="${i}">${escape(quoteCaption(c,state.minute))}</div>${c.windows.length?`<div class="chart-evidence">${escape(windowCaption(c.windows))}</div>`:''}</section>`;
  }
  container.innerHTML=html||'<p class="small muted">Select a contract to see its quotes.</p>';
  for(const svg of $$('[data-option-chart]')){
    const i=Number(svg.dataset.optionChart),c=chartData.charts[i],W=Math.max(280,svg.clientWidth),H=210;
    svg.setAttribute('viewBox',`0 0 ${W} ${H}`);svg.innerHTML=optionSVG(c,state.minute,W,H);
    const tip=$('[data-option-tip="'+i+'"]'),current=quoteCaption(c,state.minute);
    svg.onpointermove=e=>{const r=svg.getBoundingClientRect(),end=Math.max(30,state.minute+3),m=Math.round((e.clientX-r.left-9)/(W-66)*end/c.cadence)*c.cadence;tip.textContent=m>=0&&m<=state.minute?quoteCaption(c,m):current;};
    svg.onpointerleave=()=>tip.textContent=current;
  }
}

async function loadHistory(){
  const data=await api('/api/info');library=data;renderLibrary();history=data.history;$('#pool').textContent=data.cases?`${data.cases} qualifying days on this device`:'Import a replay pack to start';$('#deal').disabled=!data.cases;$('#library-status').textContent=data.pack?`${data.cases} days · ready offline after first load`:'Your data stays on this device.';$('#import-status').textContent=data.pack?`${data.cases} days imported`:'';
  const completed=history.filter(h=>h.finished),groups={};
  for(const h of completed){const group=(h.setup_name?h.setup_name+' · ':'')+h.info+' · menu v'+(h.menu_version||1)+' · '+(h.clock_version===2?'09:30 start':'gate start')+(h.profit_version?' · profit targets':'');const g=groups[group]||={n:0,known:0,pnl:0,score:0,scored:0,repeats:0};g.n++;if(h.pnl!=null){g.pnl+=h.pnl;g.known++}if(h.score!=null){g.score+=h.score;g.scored++}g.repeats+=Number(h.repeated)}
  let html=completed.length?`<div class="table-wrap"><table><thead><tr><th>Information shown</th><th>Days</th><th>Known P&L days</th><th>Mean P&L</th><th>Mean plan score</th><th>Repeats</th></tr></thead><tbody>${Object.entries(groups).map(([name,g])=>`<tr><td>${escape(name)}</td><td>${g.n}</td><td>${g.known} / ${g.n}</td><td>${g.known?money(g.pnl/g.known):'Unknown'}</td><td>${g.scored?num(g.score/g.scored,0)+'%':'—'}</td><td>${g.repeats}</td></tr>`).join('')}</tbody></table></div>`:'<p class="empty">Complete a day to start comparing your information choices.</p>';
  html+='<h3>Saved sessions</h3>';
  html+=history.length?`<div class="table-wrap"><table><thead><tr><th>Case</th><th>Status</th><th>Information</th><th>Entries</th><th>P&L</th><th>Plan</th><th></th></tr></thead><tbody>${history.map(h=>`<tr><td>${h.date} · ${escape(h.symbol)}${h.repeated?' ↻':''}</td><td>${h.finished?'Complete':'In progress'}</td><td>${escape(h.setup_name?h.setup_name+' · '+h.info:h.info)}</td><td>${h.entries}</td><td>${money(h.pnl)}</td><td>${h.score==null?'—':h.score+'%'}</td><td><button class="quiet resume" data-id="${h.id}">${h.finished?'Review':'Resume'}</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="empty">Your sessions are saved locally after every action.</p>';
  $('#history-content').innerHTML=html;
  $$('.resume').forEach(b=>b.onclick=()=>task(async()=>{state=await api('/api/state?id='+b.dataset.id);side=state.watchlist?.side||'CALL';localStorage.setItem(sessionKey,state.id);selected='';manualSelection='';render();$('#history').hidden=true;window.scrollTo({top:0,behavior:'smooth'})}));
}

await task(async()=>{await loadHistory();const id=await lastSession();if(id){try{state=await api('/api/state?id='+id);side=state.watchlist?.side||'CALL';render()}catch(e){localStorage.removeItem(sessionKey);toast(e.message)}}if(!state)$('#welcome').hidden=false;});

function downloadJSON(value,name){const blob=new Blob([JSON.stringify(value)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('#library-button').onclick=()=>$('#library-dialog').showModal();
$('#close-library').onclick=()=>$('#library-dialog').close();
$('#welcome-import').onclick=()=>$('#library-dialog').showModal();
$('#pack-file').onchange=()=>{const file=$('#pack-file').files[0];if(!file)return;task(async()=>{
  try{const pack=await importPack(file,(n,total)=>{$('#import-status').textContent=`Importing ${n} / ${total} days…`});await loadHistory();$('#import-status').textContent=`${pack.cases.length} days ready. You can play.`;toast('Replay pack saved on this device.');}
  catch(error){$('#import-status').textContent=error.message;throw error;}finally{$('#pack-file').value='';}
});};
$('#backup-progress').onclick=()=>task(async()=>downloadJSON(await backupProgress(),'two-stage-progress-'+new Date().toISOString().slice(0,10)+'.json'));
$('#restore-file').onchange=()=>{const file=$('#restore-file').files[0];if(!file)return;task(async()=>{try{const result=await restoreProgress(file);await loadHistory();$('#restore-status').textContent=`${result.added} rounds restored · ${result.kept} existing rounds kept`;toast('Progress restored. Open Sessions to resume a round.');}catch(error){$('#restore-status').textContent=error.message;throw error;}finally{$('#restore-file').value='';}})};
$('#dock-next').onclick=()=>state.finished?$('#another').click():action('advance');
$('#dock-trade').onclick=()=>(state.finished?$('#debrief'):$('.trade-panel')).scrollIntoView({behavior:'smooth',block:'start'});
$('#dock-options').onclick=()=>$('#options-panel').scrollIntoView({behavior:'smooth',block:'start'});
$('#dock-chart').onclick=()=>(state.policy_cards?$('.chart-panel'):$('.signal-focus')).scrollIntoView({behavior:'smooth',block:'start'});
if('serviceWorker' in navigator){
  let reloadForUpdate=false;
  navigator.serviceWorker.register('./sw.js').then(reg=>{
    const ready=()=>{$('#update-app').hidden=!(navigator.serviceWorker.controller&&reg.waiting);$('#update-app').onclick=()=>{if(reg.waiting){reloadForUpdate=true;reg.waiting.postMessage({type:'SKIP_WAITING'});}};};ready();
    reg.addEventListener('updatefound',()=>reg.installing?.addEventListener('statechange',ready));
  }).catch(()=>{$('#offline-status').textContent='Offline installation unavailable. Keep a connection for now.';});
  let refreshing=false;navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloadForUpdate&&!refreshing){refreshing=true;location.reload();}});
  navigator.serviceWorker.ready.then(()=>{$('#offline-status').textContent='App saved for offline use.';});
}

function targetText(setup){const x=setup.exit;return x.family==='full'?`All at +${x.first}%`:`${Math.round(x.fraction*100)}% at +${x.first}% → rest at +${x.second}%`;}
function renderLibrary(){
  const old=$('#setup-select').value,pack=library.pack,modern=pack?.version===2;
  $('#pack-control').hidden=library.packs.length<2;
  $('#pack-select').innerHTML=library.packs.map(p=>`<option value="${p.id}">${escape(p.name)}${p.name.startsWith('Four setups')?'':' · legacy / reference'}</option>`).join('');$('#pack-select').value=pack?.id||'';
  $('#setup-control').hidden=!modern;$('#setup-brief').hidden=!modern;$('#legacy-entry').hidden=modern;$('#legacy-risk').hidden=modern;
  $('#setup-select').innerHTML=modern?pack.setups.map(s=>`<option value="${s.id}">${escape(s.name)}</option>`).join(''):'';
  if(modern)$('#setup-select').value=pack.setups.some(s=>s.id===old)?old:pack.default_setup;
  $('#start-preset option[value="full"]').textContent=modern?'VWAP + EMA':'VWAP + EMA + logistic';renderSetupPlan();
}
function renderSetupPlan(){
  const setup=library?.pack?.setups?.find(s=>s.id===$('#setup-select').value);
  $('#setup-brief').textContent=setup?setup.description:'';
  $('#start-rules').textContent=setup?`${money(setup.budget)} cap · max ${setup.max_contracts} contracts · one entry. ${targetText(setup)}. −${setup.exit.stop}% stop after ${Math.max(1,setup.exit.grace)}m. Close ${time(setup.deadline)}.`:'$20,000 paper account · 3 entries / day. Take some profit at +25%, +50%, +75%…';
}
function renderPolicyCards(){
  const cards=state.policy_cards;
  $('#policy-cards').hidden=!cards;$('#current-events').hidden=!cards;$('#watch-context').hidden=!cards;
  $('.signal-focus').hidden=!!cards;
  if(!cards)return;
  $('#watch-context').textContent=`09:00 watchlist · #${state.watchlist.rank} of 3 · ${state.watchlist.side} · practice: ${state.setup.name}`;
  $('#policy-cards').innerHTML=cards.map(c=>`<article class="policy-card ${c.selected?'selected ':''}${escape(c.status)}" aria-label="${escape(c.name)}"><div class="policy-title"><b>${escape(c.name)}</b>${c.selected?'<span>YOU</span>':''}</div><strong class="policy-status">${escape(c.label)}</strong><p>${escape(c.detail)}</p></article>`).join('');
  const events=state.events.filter(e=>['policy','buy','partial','close','profit_target','stop_alert','trend_signal','unknown'].includes(e.kind)).slice(-2);
  $('#current-events').innerHTML=events.map(e=>`<div><time>${time(e.minute)}</time><span>${escape(e.kind==='policy'?e.note.split('. ')[0]:e.note)}</span></div>`).join('')||'<span>Step up to five minutes. Entry and exit signals pause the clock.</span>';
}
function renderStageCards(){
  const w=state.watchlist,s=state.setup_signal,e=state.setup.entry;
  $('#premarket-focus').classList.add('ready');
  $('#premarket-focus').innerHTML=`<div class="focus-label">01 · WATCHLIST</div><div class="focus-value"><strong>#${w.rank} / 3</strong><span>${escape(w.side)}</span></div><div class="focus-caption">${escape(w.name)} · score ${num(w.score*100,1)}%</div>`;
  const status={scheduled:'SCHEDULED',waiting:'WAIT',watching:'WATCH',alert:'GET READY',ready:'ENTER',missed:'ENTRY PASSED',cash:'NO ENTRY',gap:'DATA GAP',veto:'VETOED'}[s.status];
  $('#trend-focus').classList.toggle('ready',['ready','alert'].includes(s.status));
  $('#trend-focus').innerHTML=`<div class="focus-label">02 · SETUP</div><div class="focus-value"><strong>${s.entry_minute!=null?time(s.entry_minute):e.kind==='clock'?time(e.anchor):status}</strong><span>${s.entry_minute!=null?status:''}</span></div><div class="focus-caption">${s.monitor?escape(s.monitor.strike+' '+s.monitor.right)+' · reference '+money(s.reference):s.reference!=null?'Reclaim '+money(s.reference):escape(state.setup.name)}</div>`;
  if(s.entry_veto)$('#trend-focus .focus-caption').textContent=s.entry_veto.veto?'2 × 5m own-VWAP conflicts · no retry':s.entry_veto.available?'VWAP entry veto clear':'VWAP unavailable · parent rule';
}
$('#setup-select').onchange=renderSetupPlan;
$('#pack-select').onchange=()=>task(async()=>{await api('/api/pack',{id:$('#pack-select').value});await loadHistory();toast('Replay pack selected for the next round.');});
