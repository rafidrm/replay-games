// Own-underlying VWAP only. A bar's minute is its completion time.
const finite=Number.isFinite;
function opposed(bar,side){return finite(bar.close)&&finite(bar.vwap)?(side==='CALL'?bar.close<bar.vwap:bar.close>bar.vwap):null;}
export function entryVeto(bars,side,entry,clock){
  if(clock<entry)return {available:null,veto:false,conflicts:0,bars:[]};
  const selected=bars.filter(b=>b.minute<=entry-1).slice(-2);
  const checks=selected.map(b=>opposed(b,side)),available=selected.length===2&&checks.every(v=>v!==null);
  return {available,veto:available&&checks.every(Boolean),conflicts:checks.filter(v=>v===true).length,
    bars:selected.map(b=>({minute:b.minute,close:b.close,vwap:b.vwap})),known_at:entry};
}
export function exitSignal(bars,side,entry,clock,deadline){
  let consecutive=0,missing=0;
  for(const b of bars){
    if(b.minute>clock)break;
    if((b.start??b.minute-5)<entry)continue;
    const conflict=opposed(b,side);
    if(conflict===null)missing++;
    consecutive=conflict===true?consecutive+1:0;
    if(consecutive>=2&&b.minute+1<=deadline){
      const execution=b.minute+1;
      return {status:clock<execution?'alert':clock===execution?'due':'missed',decision_minute:b.minute,execution_minute:execution,consecutive:2,missing};
    }
  }
  return {status:'watching',decision_minute:null,execution_minute:null,consecutive,missing};
}

// The original exit has priority at the same observation. Practice still uses
// manual bid fills; capped automatic fills appear only in the saved benchmark.
export function exitPriority(position,quote,minute,setup,deadline){
  if(!quote)return 'missing_quote';
  if(quote.bid+1e-10>=position.entry*(1+setup.exit.first/100))return 'target';
  if(minute>=position.entry_minute+Math.max(1,setup.exit.grace)&&quote.bid<=position.entry*(1-setup.exit.stop/100))return 'stop';
  return minute>=deadline?'deadline':'trend_exit';
}
