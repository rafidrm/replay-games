// Entry readiness uses only the information exposed at the replay clock.
export function entrySetup(state, side) {
  const requirements=[{name:'Trend gate',passed:state.gate_passed}];
  if(state.plan.entry!=='discretionary')requirements.push({name:'VWAP retest',passed:state.layers.vwap?state.signals.retest===side:null});
  if(state.plan.entry==='retest_ema')requirements.push({name:'EMA aligned',passed:state.layers.ema?state.signals.ema===side:null});
  const ready=requirements.every(r=>r.passed===true);
  return {requirements,ready,label:ready?(state.plan.entry==='discretionary'?'Discretionary':`${side} setup`):requirements.some(r=>r.passed===null)?'Signal hidden':'Waiting'};
}
export function profitSetup(position) {
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
