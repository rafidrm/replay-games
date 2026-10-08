import {StageDay} from './stage2.mjs';
import {unionAt} from './policies.mjs';
import {exitSignal} from './reclaim.mjs';
import {makeBook,observeBook,openQty} from './ws-orders.mjs';
export class WealthsimpleDay extends StageDay {
  quote(id,m){const q=this.quotes.get(`${id}@${m}`);return q&&Number.isFinite(q.bid)&&Number.isFinite(q.ask)&&q.bid>=0&&q.ask>0&&q.ask>=q.bid?q:null;}
  setupAt(setup,m){
    if(setup.execution!=='wealthsimple')return super.setupAt(setup,m);
    const u=this.data.policy_signals.union;
    return unionAt({...u,alerts:setup.ws_code==='P05'?u.alerts.filter(a=>a.origin==='iteration'):u.alerts,events:setup.ws_code==='P09'?u.events:[]},m);
  }
}
export function entryGate(q){return !q?'entry_gap':q.ask<.5||(q.ask-q.bid)/((q.ask+q.bid)/2)>.15+1e-10?'quote_noentry':'entered';}
export function automaticReference(day,setup,n,delay=0){
  const signal=day.setupAt(setup,30),planned=signal.entry_minute;
  const result={eligible:false,resolved:true,pnl:0,lower:0,debit:0,entry:planned??-1,planned_entry:planned??-1,n,delay,changes:0,stalls:0,last_exit:-1,deadline_contracts:0,events:[],status:signal.status==='veto'?'veto':'cash'};
  if(planned==null)return result;
  const c=day.contractAt(planned),base=c&&day.quote(c.id,planned),baseGate=entryGate(base);
  if(baseGate!=='entered')return {...result,status:baseGate,resolved:baseGate!=='entry_gap',pnl:baseGate==='entry_gap'?null:0};
  const e=planned+delay,q=day.quote(c.id,e),gate=entryGate(q);
  if(gate!=='entered')return {...result,entry:e,status:gate,resolved:gate!=='entry_gap',pnl:gate==='entry_gap'?null:0};
  const r=setup.rules[n],book=makeBook(r,q.ask,e),own=r.veto?exitSignal(day.bars,c.right,e,day.deadline,day.deadline).decision_minute:null;
  for(let m=e+1;m<=day.deadline&&openQty(book)&&book.gap==null;m++)observeBook(book,m,day.quote(c.id,m),own,day.deadline,{automatic:true});
  const sales=book.events.filter(x=>x.action==='sell'),lower=book.proceeds-n*q.ask*100,resolved=openQty(book)===0;
  return {...result,eligible:true,resolved,entry:e,contract:c,entry_ask:q.ask,debit:n*q.ask*100,pnl:resolved?lower:null,lower,
    changes:book.changes,stalls:book.stalls,last_exit:sales.at(-1)?.minute??-1,deadline_contracts:sales.filter(x=>x.reason==='deadline').reduce((s,x)=>s+x.qty,0),events:book.events,status:book.gap==null?'entered':'quote_gap',own_signal:own??-1};
}
