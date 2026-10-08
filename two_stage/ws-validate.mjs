const finite=Number.isFinite;
const whole=(n,a,b)=>Number.isInteger(n)&&n>=a&&n<=b;
export function validateWSSetup(s,rules,fail){
  const code=s.ws_code,e=s.entry,x=s.exit;
  if(!rules[code]||s.id!=='ws_'+code.toLowerCase()||!s.rules||Object.keys(s.rules).length!==3)fail('invalid Wealthsimple identity.');
  for(const n of [2,5,10])if(JSON.stringify(s.rules[n])!==JSON.stringify(rules[code][n]))fail('Wealthsimple rule drift.');
  if(e?.kind!=='wealthsimple'||e.monitor!=='none'||e.anchor!==0||e.window!==5||x?.family!=='full'||x.first!==100||x.second!==100||x.fraction!==1||x.stop!==(code==='P05'?35:15)||x.grace!==(code==='P05'?10:15)||s.budget!==20000||s.max_contracts!==10||s.max_entries!==1||s.deadline!==330)fail('unsupported Wealthsimple schedule.');
}
export function validateWSReferences(refs,day,fail){
  if(refs.version!==1||!Array.isArray(refs.baseline)||refs.baseline.length!==9||!Array.isArray(refs.delays)||refs.delays.length!==54)fail('invalid Wealthsimple reference rows.');
  for(const key of ['baseline','delays']){
    const seen=new Set();
    for(const r of refs[key]){
      const id=r.short_id+':'+r.n+':'+(key==='baseline'?0:r.delay);
      if(!['P08','P05','P09'].includes(r.short_id)||![2,5,10].includes(r.n)||seen.has(id)||r.date!==day.meta.date||r.symbol!==day.meta.symbol||typeof r.eligible!=='boolean'||typeof r.resolved!=='boolean'||!finite(r.debit)||r.debit<0||r.pnl!==null&&!finite(r.pnl)||!finite(r.lower)||!whole(r.entry,-1,day.deadline-1)||!finite(r.changes)||r.changes<0)fail('invalid Wealthsimple reference accounting.');
      if(key==='delays'&&(!whole(r.delay,0,5)||r.contract_mode!=='same_contract'||r.exit_response!==1))fail('invalid delay reference.');
      if(r.eligible&&(!['CALL','PUT'].includes(r.side)||!finite(r.strike)||r.strike<=0||!/^\d{4}-\d{2}-\d{2}$/.test(r.expiration)||r.debit<=0||r.entry<0))fail('invalid reference contract.');
      if(!r.eligible&&r.debit!==0)fail('cash reference has a debit.');seen.add(id);
    }
  }
}
export function validateWSState(s,setup,day,bad){
  const w=s.ws,r=setup.rules[w?.quantity],b=w?.book;
  if(s.ws_version!==1||!r||![2,5,10].includes(w.quantity)||!whole(w.delay,0,5)||w.actual_delay!==null&&!whole(w.actual_delay,0,5)||!whole(w.cursor,0,20000))bad();
  if(s.entries>1||Boolean(b)!==Boolean(s.entries)||!b&&s.position)bad();
  if(!b)return;
  const contract=day.menu.find(c=>c.id===w.anchor?.id);
  if(!contract||JSON.stringify(b.rule)!==JSON.stringify(r)||!finite(b.entry)||b.entry<=0||!whole(b.entry_minute,0,s.minute)||day.quote(contract.id,b.entry_minute)?.ask!==b.entry||b.version!==1||!finite(b.proceeds)||b.proceeds<0||!whole(b.changes,0,100000)||!whole(b.stalls,0,100000)||!Array.isArray(b.events)||b.events.length!==w.cursor||b.gap!==null&&!whole(b.gap,b.entry_minute+1,s.minute))bad();
  if(!b.seen||['profit','loss','vwap'].some(k=>typeof b.seen[k]!=='boolean')||!Array.isArray(b.groups)||b.groups.length!==r.counts.filter(Boolean).length)bad();
  let remaining=0;const ids=new Set();
  for(const g of b.groups){
    if(ids.has(g.id)||g.id!==g.role||!whole(g.role,0,2)||g.initial_qty!==r.counts[g.role]||!whole(g.qty,0,g.initial_qty)||!whole(g.activation,b.entry_minute+1,day.deadline)||!['none','target','market','stoplimit','limit','closed'].includes(g.active)||g.qty===0&&g.active!=='closed'||!finite(g.level)&&g.level!==null||typeof g.placed!=='boolean'||g.last_check!==null&&!whole(g.last_check,b.entry_minute+1,s.minute))bad();
    if(g.pending&&(!g.qty||!['stop','breakeven','cancel'].includes(g.pending.kind)||!whole(g.pending.requested,b.entry_minute+1,s.minute)||!whole(g.pending.due,g.pending.requested+1,day.deadline+1)||!whole(g.pending.signal_minute,b.entry_minute+1,g.pending.requested)))bad();
    ids.add(g.id);remaining+=g.qty;
  }
  if(remaining!==(s.position?.qty??0)||s.position&&s.position.id!==contract.id)bad();
  if(b.cue&&(!['stop','breakeven'].includes(b.cue.kind)||!['loss','profit','vwap'].includes(b.cue.reason)||!whole(b.cue.minute,b.entry_minute+1,s.minute)))bad();
  for(const e of b.events)if(!whole(e.minute,b.entry_minute+(e.action==='sell'&&e.reason==='manual'?0:1),s.minute)||!['place','replace','request','sell','trigger_stop_limit','signal','gap'].includes(e.action))bad();
  const bought=s.fills.filter(f=>f.side==='BUY'),sales=s.fills.filter(f=>f.side==='SELL');
  if(bought.length!==1||bought[0].qty!==w.quantity||bought[0].price!==b.entry||bought[0].minute!==b.entry_minute||s.fills.some(f=>f.contract!==contract.id)||sales.reduce((n,f)=>n+f.qty,0)+remaining!==w.quantity)bad();
  const proceeds=sales.reduce((n,f)=>n+f.price*f.qty*100,0),pnl=sales.reduce((n,f)=>n+(f.price-b.entry)*f.qty*100,0);
  if(Math.abs(proceeds-b.proceeds)>1e-7||Math.abs(s.cash-(20000-w.quantity*b.entry*100+proceeds))>1e-7||Math.abs(s.realized-pnl)>1e-7)bad();
}
