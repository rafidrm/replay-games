// These functions consume frozen input streams, never saved outcome rows.
export function unionAt(input,minute){
  const alert=input.alerts.filter(a=>a.minute<=minute).sort((a,b)=>a.minute-b.minute||(a.origin==='waiting'?-1:1))[0];
  if(!alert)return {status:minute>=input.last_alert?'cash':'waiting',known_at:Math.min(minute,input.last_alert),entry_minute:null};
  const cutoff=alert.entry_minute-5;
  const latest=input.events.filter(e=>e.minute<=Math.min(minute,cutoff)&&e.side!=='NONE').at(-1);
  const checked=minute>=cutoff,veto=checked&&latest!=null&&latest.side!==alert.side;
  return {status:veto?'veto':minute<alert.entry_minute?'alert':minute===alert.entry_minute?'ready':'missed',
    known_at:checked?cutoff:alert.minute,entry_minute:veto?null:alert.entry_minute,
    alert_minute:alert.minute,origin:alert.origin,side:alert.side,cutoff,
    vwap_context:latest?.side??'NONE',vwap_event_minute:latest?.minute??null,vwap_checked:checked};
}

export function peerAt(symbol,side,pm){
  if(symbol!=='QQQ')return {status:'not_applicable',known_at:-30,entry_minute:null};
  const available=pm?.pm_known===true&&Number.isFinite(pm.pm_return)&&Number.isFinite(pm.pm_vwap);
  const sign=side==='CALL'?1:-1;
  const veto=available&&sign*pm.pm_return<0&&sign*pm.pm_vwap<0;
  return {status:veto?'veto':null,known_at:-30,entry_minute:null,
    peer:{available,veto,return:available?pm.pm_return:null,vwap:available?pm.pm_vwap:null}};
}

export function stopRule(position,setup,minute){
  const p=position,x=setup.exit,grace=p.entry_minute+Math.max(1,x.grace);
  const first=p.profit_flags.find(f=>f.percent===x.first&&['taken','late'].includes(f.status));
  const breakeven=x.post==='breakeven'&&first!=null;
  const activation=breakeven?Math.max(grace,first.taken_minute+1):grace;
  return {active:minute>=activation,activation,price:p.entry*(breakeven?1:1-x.stop/100),breakeven};
}

const clock=m=>`${String(Math.floor((570+m)/60)).padStart(2,'0')}:${String((570+m)%60).padStart(2,'0')}`;
const price=p=>Number.isFinite(p)?'$'+p.toFixed(2):'unavailable';
export function policyCard(setup,signal,game){
  const selected=setup.id===game.setup.id,p=selected?game.s.position:null,m=game.s.minute;
  let status=signal.status,detail='';
  if(setup.entry.kind==='union'){
    detail=signal.origin?`${signal.origin==='waiting'?'Patience':'Early'} alert ${clock(signal.alert_minute)} · `+
      (signal.vwap_checked?(signal.status==='veto'?'opposing VWAP event → skip':signal.vwap_context==='NONE'?'no opposing VWAP event':'VWAP event agrees'):`VWAP check ${clock(signal.cutoff)}`):
      status==='cash'?'No qualifying alert by 09:50 · stay in cash':'Wait for a qualifying patience or early signal';
  }else if(setup.peer_rule){
    detail=status==='not_applicable'?'QQQ only':signal.peer?.veto?'SPY premarket return and VWAP both oppose this trade':
      signal.peer?.available?'SPY premarket veto clear':'SPY premarket unavailable · use the dip rule';
    if(['watching','alert','ready','missed','cash','gap'].includes(status))detail+=signal.monitor?` · ${signal.monitor.strike} ${signal.monitor.right} anchor ${price(signal.reference)}`:'';
    if(status==='watching')detail+=` · watch ${clock(signal.window_start)}–${clock(signal.window_end)} premium`;
    if(status==='waiting')detail+=' · start 10:00';
  }else if(setup.entry.monitor==='stock'){
    detail=status==='waiting'?'From 10:30: adverse 3m window, then a later reclaim':
      `Reference ${price(signal.reference)} · ${signal.adverse_seen?'adverse window seen':'need an adverse 3m window'}`;
    if(['alert','ready','missed'].includes(status))detail=`Reclaimed ${price(signal.reference)} · alert ${clock(signal.known_at)}`;
    if(status==='watching'&&signal.adverse_seen)detail+=' · wait for a later reclaim';
  }else detail=`${game.day.meta.morning_side} at 10:00 · half +25%, rest +50%`;
  if(status==='cash'&&setup.entry.kind!=='union')detail='Monitoring window ended without a trigger · stay in cash';
  if(status==='gap')detail='Required setup prices missing · no signal invented';
  let label=({scheduled:'Scheduled',waiting:'Waiting',watching:'Developing',alert:'Queued',ready:'Buy now',missed:'Entry passed',cash:'Stay in cash',gap:'Data gap',veto:'Vetoed · skip',not_applicable:'Not applicable'})[status];
  if(signal.entry_minute!=null&&['scheduled','alert'].includes(status))label+=` · ${clock(signal.entry_minute)}`;
  if(p){
    const q=game.day.quote(p.id,m),stop=stopRule(p,setup,m),trend=game.trendExit();
    const due=p.profit_flags.filter(f=>f.status==='due'),missed=p.profit_flags.some(f=>f.status==='missed');
    status='position';label=p.runner?'Runners':'In position';
    const next=p.target_plan.find(t=>!p.profit_flags.some(f=>f.percent===t.percent&&['taken','late'].includes(f.status)));
    detail=`${p.qty} contracts${next?' · next +'+next.percent+'%':''} · stop ${price(stop.price)} ${stop.active?'active':'from '+clock(stop.activation)}`;
    if(trend?.status==='watching')detail+=` · VWAP ${trend.consecutive}/2 opposing bars`;
    if(due.length){status='target';label='Take profit';detail=due.map(f=>`+${f.percent}% · sell ${Math.min(p.qty,f.required_qty-f.taken_qty)}`).join(' / ');}
    else if(p.stop_alert!=null){status='stop';label='Exit now · stop';detail=`${stop.breakeven?'Breakeven runner':'Premium'} stop hit ${clock(p.stop_alert)} · sell remaining ${p.qty}`;}
    else if(trend&&['alert','due','missed'].includes(trend.status)){
      status=trend.status==='alert'?'exit_queued':'exit';label=trend.status==='alert'?`Exit queued · ${clock(trend.execution_minute)}`:trend.status==='due'?'Exit now · VWAP':'VWAP exit passed';detail=`2/2 completed opposing bars · sell remaining ${p.qty}`;
    }else if(missed)detail+=' · profit target missed';
    if(!q){status='gap';label='No current quote';detail='Position stays open · P&L unknown until a valid price';}
  }else if(selected&&game.s.entries){status='closed';label='Position closed';detail='One entry used · continue observing the day';}
  if(game.s.finished){status='finished';label='Finished';}
  return {id:setup.id,name:setup.name,selected,status,label,detail,signal};
}
