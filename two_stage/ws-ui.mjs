import {ruleDescription,activation} from './ws-orders.mjs';
const $=s=>document.querySelector(s);
const price=n=>n==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(n);
const time=m=>`${String(Math.floor((570+m)/60)).padStart(2,'0')}:${String((570+m)%60).padStart(2,'0')}`;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function wsStartRules(setup,n){
  const r=setup.rules[n],targets=r.counts[0]+r.counts[1],first=activation(r,0,targets?0:2);
  return ruleDescription(r)+` Initial ${targets?'targets':'stops'} at entry +${first}m. Exact quantity; no $2,000 cap.`;
}
export function renderWS(state,action){
  const w=state.ws,p=state.position;
  $('#ws-orders').hidden=!w;document.body.classList.toggle('ws-game',!!w);
  $('.runner-control').hidden=!!w;$('#sell-quantity').closest('label').hidden=!!w;$('#sell-custom').hidden=!!w;
  if(!w)return;
  const b=w.book,r=w.rule,m=state.minute,canAct=!!p&&!state.finished&&b.gap==null,canChange=canAct&&m<state.deadline;
  let html=`<div class="ws-rule"><strong>${state.setup.ws_code} · ${w.quantity} contracts</strong><p>${escape(ruleDescription(r))}</p><small>One active sell rule per contract · fixed stops do not trail.</small></div>`;
  if(!b){
    const e=w.entry;
    html+=`<p class="ws-notice">${e.planned==null?(e.signal.status==='veto'?'Entry vetoed · stay in cash':e.signal.status==='cash'?'No qualifying entry':'Waiting for a forecast'):`Forecast ${time(e.signal.alert_minute)} → planned ${time(e.planned)}<br>Practice buy ${time(e.practice_entry)} · +${w.delay}m extra`}</p>`;
    if(e.contract)html+=`<p class="small muted">Fixed entry contract: ${e.contract.strike} ${e.contract.right}. Levels and clocks start at your actual buy.</p>`;
    if(e.base_status&&e.base_status!=='entered'||e.gate&&e.gate!=='entered')html+='<p class="ws-notice">Entry quote unavailable or outside the saved premium/spread rule.</p>';
  }else{
    const due=b.groups.filter(g=>g.qty&&!g.placed&&g.active==='none'&&!g.pending&&g.activation<=m);
    if(b.gap!=null)html+='<p class="ws-notice warning">Missing required quote · exposure unresolved. Finish to review.</p>';
    else if(w.deadline_due)html+='<p class="ws-notice warning">15:00 close · exit all remaining contracts now.</p>';
    else if(b.cue)html+=`<p class="ws-notice warning">${{profit:'Profit fill',loss:'Loss threshold',vwap:'2 × 5m VWAP conflict'}[b.cue.reason]} · replace survivors with ${b.cue.kind==='breakeven'?'breakeven':`−${r.stop*100}%`} stop-market orders.</p><button id="ws-replace" class="primary wide" ${canChange?'':'disabled'}>Submit replacement</button>`;
    if(due.length&&canChange)html+=`<button id="ws-place" class="primary wide">Place due orders · ${due.reduce((n,g)=>n+g.qty,0)} contracts</button>`;
    for(const g of b.groups){
      const original=g.role<2?`Target +${(g.role===0?r.first:r.second)*100}%`:`Stop-limit −${r.stop*100}% / −${Math.round((r.stop+(r.kind===2?.05:0))*100)}%`;
      const live=g.active==='none'?(g.placed?'No active order':`Unplaced · due ${time(g.activation)}`):g.active==='closed'?'Closed':g.active==='target'?`Target limit ${price(g.level)}`:g.active==='market'?`Stop-market trigger ${price(g.level)}`:g.active==='limit'?`Triggered limit ${price(g.level)} · ${p?.quote&&p.quote.bid<g.level?'UNFILLED':'live'}`:`Stop ${price(g.level)} / limit ${price(b.entry*(1-r.stop-(r.kind===2?.05:0)))}`;
      html+=`<article class="ws-group ${g.active==='limit'?'stalled':''}"><div class="ws-group-title"><b>G${g.id+1} · ${g.qty} / ${g.initial_qty}</b><span>${original}</span></div><strong>${live}</strong>${g.pending?`<p class="ws-pending">Pending ${g.pending.kind} · effective ${time(g.pending.due)}<br>Current order stays live until then.</p>`:''}`;
      if(g.qty&&canAct){html+='<div class="ws-group-actions">';if(canChange&&(g.active!=='none'||g.pending))html+=`<button class="quiet" data-ws-cancel="${g.id}">Cancel</button>`;if(canChange&&g.active==='none'&&g.placed&&!g.pending)html+=`<button class="quiet" data-ws-place="${g.id}">Restore rule</button>`;
        html+=`<label>Sell <input aria-label="Sell quantity G${g.id+1}" data-ws-qty="${g.id}" type="number" min="1" max="${g.qty}" step="1" value="1"></label><button class="quiet" data-ws-sell="${g.id}">Sell at bid</button></div>`;}
      html+='</article>';
    }
    html+=`<p class="small muted">Actual entry +${w.actual_delay}m · ${b.changes} replacements · ${b.stalls} unfilled contract-minutes.</p>`;
    if(w.own_vwap&&p)html+=`<p class="small muted">Own VWAP: ${w.own_vwap.consecutive}/2 fully post-entry 5m closes.</p>`;
    if(state.setup.ws_code==='P09')html+='<p class="small muted">Entry VWAP veto only · no post-entry VWAP switch.</p>';
  }
  $('#ws-orders').innerHTML=html;
  if(p){$('#position-detail').innerHTML=[['Remaining',`${p.qty} / ${p.initial_qty}`],['Entry ask',`${price(p.entry)} · ${time(p.entry_minute)}`],['Current bid',price(p.quote?.bid)]].map(([label,value])=>`<div class="detail-row"><span>${label}</span><b>${value}</b></div>`).join('');$('#exit-all').disabled=!canAct;$('#exit-all').textContent='Exit all at bid';}
  $('#finish-description').textContent='Reveal the remaining day. Only orders you already placed keep working. Close any remaining contracts at the session deadline; missing quotes stay unresolved.';
  $('#commitment').textContent=wsStartRules(state.setup,w.quantity)+' Submit changes yourself; they take one minute while old orders remain active. This is sampled quote practice, not a broker connection.';
  $('#ws-place')?.addEventListener('click',()=>action('ws_place'));
  $('#ws-replace')?.addEventListener('click',()=>action('ws_replace'));
  for(const button of document.querySelectorAll('[data-ws-cancel]'))button.onclick=()=>action('ws_cancel',{group:Number(button.dataset.wsCancel)});
  for(const button of document.querySelectorAll('[data-ws-place]'))button.onclick=()=>action('ws_place',{group:Number(button.dataset.wsPlace)});
  for(const button of document.querySelectorAll('[data-ws-sell]'))button.onclick=()=>{const group=Number(button.dataset.wsSell);action('ws_sell',{group,qty:Number($(`[data-ws-qty="${group}"]`).value)});};
}
export function wsBenchmark(state){
  const r=state.ws_reference;if(!r)return '';
  return `<section class="benchmark-review"><h3>Automatic historical reference</h3><p class="small">${state.ws.quantity} contracts · +${r.delay}m entry delay · scheduled placement and one-minute replacement response. Your manual actions are separate.</p><div class="benchmark-row"><span>Your result</span><b>${price(state.total)}</b></div><div class="benchmark-row"><span>Reference result</span><b>${price(r.pnl)}</b></div><details><summary>Reference orders and fills</summary>${r.eligible?`<p>${time(r.entry)} BUY ${r.n} @ ${price(r.entry_ask)}</p>`:'<p>No entry.</p>'}${r.events.map(e=>`<p class="small">${time(e.minute)} · ${escape(e.action.replaceAll('_',' '))}${e.group!=null?' · G'+(e.group+1):''}${e.qty?' ×'+e.qty:''}${e.price!=null?' @ '+price(e.price):''}${e.rule?' · '+escape(e.rule):''}${e.due?' → '+time(e.due):''}</p>`).join('')}</details><p class="small muted">Inherited historical rules; this replay adds no fresh profitability evidence.</p></section>`;
}
