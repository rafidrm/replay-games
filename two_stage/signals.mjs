// Entry readiness uses only the information exposed at the replay clock.
export function entrySetup(state, side) {
  if(state.setup){const s=state.setup_signal,ready=s.status==='ready'&&side===state.watchlist.side;return {ready,label:s.status==='veto'?'Stay in cash':ready?side+' setup':s.status==='missed'?'Entry passed':'Waiting',requirements:[{name:'Setup clock',passed:s.status==='ready'},{name:state.watchlist.side+' direction',passed:side===state.watchlist.side},...(s.entry_veto?[{name:s.entry_veto.available?'VWAP veto clear':'VWAP unavailable · parent rule',passed:s.entry_veto.available?!s.entry_veto.veto:null}]:[])]};}
  const requirements=[{name:'Trend gate',passed:state.gate_passed}];
  if(state.plan.entry!=='discretionary')requirements.push({name:'VWAP retest',passed:state.layers.vwap?state.signals.retest===side:null});
  if(state.plan.entry==='retest_ema')requirements.push({name:'EMA aligned',passed:state.layers.ema?state.signals.ema===side:null});
  const ready=requirements.every(r=>r.passed===true);
  return {requirements,ready,label:ready?(state.plan.entry==='discretionary'?'Discretionary':`${side} setup`):requirements.some(r=>r.passed===null)?'Signal hidden':'Waiting'};
}
export function profitSetup(position) {
  if(position?.target_plan)return strategyProfit(position);
  const flags=position?.profit_flags||[];
  const next=(flags.at(-1)?.percent||0)+25;
  const due=flags.filter(f=>f.status==='due');
  const missed=flags.filter(f=>f.status==='missed');
  const targets=[...flags,{percent:next,status:'next'}];
  while(targets.length<3)targets.push({percent:targets.at(-1).percent+25,status:'next'});
  const quantity=position?Math.min(Math.max(1,Math.floor(position.qty/2)),position.bid_available||0):0;
  return {next,due,missed,targets:targets.slice(-3),quantity,
    canTrim:quantity>0&&position?.premium_return>0,
    nextBid:position?position.entry*(1+next/100):null};
}

export function strategyProfit(position){
  const flags=position.profit_flags||[],plan=position.target_plan;
  const targets=plan.map(t=>({...t,...(flags.find(f=>f.percent===t.percent)||{status:'next'})}));
  const next=targets.find(t=>t.status==='next')?.percent??null;
  const due=flags.filter(f=>f.status==='due'),missed=flags.filter(f=>f.status==='missed');
  const eligible=flags.filter(f=>['due','missed'].includes(f.status)&&position.premium_return+1e-10>=f.percent/100);
  const quantity=Math.min(position.qty,eligible.reduce((n,f)=>n+f.required_qty-f.taken_qty,0));
  return {targets,next,due,missed,quantity,canTrim:quantity>0&&position.bid_available>0,nextBid:next==null?null:position.entry*(1+next/100)};
}
