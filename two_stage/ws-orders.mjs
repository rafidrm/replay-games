// Frozen inherited-price presets. No broker connection or live-order submission.
const rule=(n,first,second,stop,grace,schedule,kind,mode,veto,counts)=>({n,first,second,stop,grace,schedule,kind,mode,veto,counts});
export const WS_RULES={
  P08:Object.fromEntries([2,5,10].map(n=>[n,rule(n,1,1,.15,15,0,2,0,1,[0,0,n])])),
  P05:{2:rule(2,.25,1,.35,0,1,2,0,0,[0,0,2]),5:rule(5,.25,1,.35,0,1,2,0,0,[0,0,5]),10:rule(10,.25,1,.35,0,1,1,3,1,[1,8,1])},
  P09:{2:rule(2,1,1,.15,15,0,2,4,0,[0,0,2]),5:rule(5,1,1,.15,15,0,2,4,0,[1,0,4]),10:rule(10,1,1,.15,15,0,2,4,0,[1,0,9])},
};
export const activation=(r,e,role)=>e+[r.schedule===1?10:1,r.schedule?10:1,Math.max(1,r.grace,r.schedule===1?10:1)][role];
export const openQty=b=>b.groups.reduce((n,g)=>n+g.qty,0);
const record=(b,minute,action,extra={})=>b.events.push({minute,action,...extra});
export function makeBook(r,entry,minute){
  return {version:1,rule:structuredClone(r),entry,entry_minute:minute,groups:r.counts.flatMap((qty,role)=>qty?[{id:role,role,qty,initial_qty:qty,activation:activation(r,minute,role),active:'none',level:null,pending:null,placed:false,last_check:null}]:[]),seen:{profit:false,loss:false,vwap:false},cue:null,gap:null,events:[],changes:0,stalls:0,proceeds:0};
}
function place(b,g,m){
  const r=b.rule;g.active=g.role<2?'target':r.kind===0?'market':'stoplimit';g.level=b.entry*(g.role<2?1+(g.role===0?r.first:r.second):1-r.stop);g.placed=true;g.last_check=null;
  record(b,m,'place',{group:g.id,qty:g.qty,rule:g.active,level:g.level});
}
export function placeDue(b,m,group=null){
  if(b.gap!=null)throw Error('Missing quote history. This exposure is unresolved.');
  let count=0;
  for(const g of b.groups)if(g.qty&&g.active==='none'&&!g.pending&&m>=g.activation&&(group==null?!g.placed:g.id===group)){place(b,g,m);count++;}
  if(!count)throw Error('No initial orders are due at this clock.');
}
export function queueReplacement(b,m,{automatic=false}={}){
  const cue=b.cue;if(!cue)throw Error('No replacement is requested.');
  const due=cue.kind==='breakeven'?Math.max(m+1,b.entry_minute+Math.max(1,b.rule.grace)):m+1;
  for(const g of b.groups)if(g.qty&&(!g.pending||g.pending.kind==='cancel'||cue.kind==='stop')){
    g.pending={kind:cue.kind,due,requested:m,signal_minute:cue.minute};
    record(b,m,'request',{group:g.id,qty:g.qty,rule:cue.kind,due,signal_minute:cue.minute,automatic});
  }
  b.cue=null;
}
export function cancelGroup(b,id,m){
  const g=b.groups.find(g=>g.id===id&&g.qty);if(!g||g.active==='none'&&!g.pending)throw Error('No active order to cancel.');
  g.pending={kind:'cancel',due:m+1,requested:m,signal_minute:m};record(b,m,'request',{group:id,qty:g.qty,rule:'cancel',due:m+1});
}
export function sellGroup(b,g,qty,price,m,reason){
  if(!Number.isInteger(qty)||qty<1||qty>g.qty)throw Error('Choose a whole number within this order group.');
  g.qty-=qty;b.proceeds+=qty*100*price;
  record(b,m,'sell',{group:g.id,qty,price,reason});
  if(!g.qty){g.active='closed';g.pending=null;}
}

// Standing orders are automatic. Placements/reassignments are automatic only in
// reference playback; practice requires explicit placeDue/queueReplacement calls.
export function observeBook(b,m,q,vwapSignal,deadline,{automatic=false}={}){
  const start=b.events.length;
  if(!openQty(b)||b.gap!=null||m<=b.entry_minute)return [];
  if(!q||!Number.isFinite(q.bid)||!Number.isFinite(q.ask)){b.gap=m;record(b,m,'gap');return b.events.slice(start);}
  const r=b.rule;let profit=false,loss=false;
  for(const g of b.groups){
    if(!g.qty)continue;
    if(g.pending&&m>=g.pending.due){
      const p=g.pending;g.active=p.kind==='cancel'?'none':'market';g.level=p.kind==='breakeven'?b.entry:b.entry*(1-r.stop);g.pending=null;g.placed=true;g.last_check=null;b.changes+=g.qty;
      record(b,m,'replace',{group:g.id,qty:g.qty,rule:p.kind,level:g.level});
    }
    if(automatic&&g.active==='none'&&m>=g.activation&&!g.pending)place(b,g,m);
    if(g.last_check===m)continue;g.last_check=m;
    let why=null,fill=q.bid;
    if(g.active==='target'&&q.bid>=g.level-1e-10){why='target';fill=g.level;profit=true;}
    if(g.active==='market'&&q.bid<=g.level+1e-12){why='stop_market';loss=true;}
    if(g.active==='stoplimit'&&q.bid<=g.level+1e-12){g.active='limit';g.level=b.entry*(1-r.stop-(r.kind===2?.05:0));record(b,m,'trigger_stop_limit',{group:g.id,qty:g.qty,limit:g.level});}
    if(g.active==='limit'){if(q.bid>=g.level-1e-10){why='stop_limit';loss=true;}else b.stalls+=g.qty;}
    if(!why&&automatic&&m===deadline)why='deadline';
    if(why)sellGroup(b,g,g.qty,fill,m,why);
  }
  const lossRequest=!b.seen.loss&&((loss&&[1,3].includes(r.mode))||(r.mode===4&&m>=b.entry_minute+Math.max(1,r.grace)&&q.bid<=b.entry*(1-r.stop)+1e-12));
  const profitRequest=!b.seen.profit&&profit&&[2,3,4].includes(r.mode);
  const vwapRequest=!!r.veto&&!b.seen.vwap&&vwapSignal!=null&&m>=vwapSignal;
  if(loss||lossRequest)b.seen.loss=true;if(profit)b.seen.profit=true;if(vwapRequest)b.seen.vwap=true;
  if(openQty(b)&&(lossRequest||profitRequest||vwapRequest)){
    const kind=profitRequest&&!lossRequest&&!vwapRequest?'breakeven':'stop';
    if(!b.cue||kind==='stop')b.cue={kind,minute:m,reason:lossRequest?'loss':vwapRequest?'vwap':'profit'};
    record(b,m,'signal',{rule:kind,reason:b.cue.reason});
    if(automatic)queueReplacement(b,m,{automatic:true});
  }
  return b.events.slice(start);
}

export function ruleDescription(r){
  const count=r.counts,targets=[count[0]?`${count[0]} at +${r.first*100}%`:null,count[1]?`${count[1]} at +${r.second*100}%`:null].filter(Boolean);
  return `${targets.join(' · ')||'No take-profit targets'} · ${count[2]} stop-limit${count[2]===1?'':'s'}: −${r.stop*100}% trigger / −${Math.round((r.stop+(r.kind===2?.05:0))*100)}% limit. Close 15:00.`;
}
