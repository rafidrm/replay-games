export const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const keyPattern=/^\d{4}-\d{2}-\d{2}_[A-Z0-9.-]+@[1234]$/;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const optional=v=>v===null||finite(v);
const fail=message=>{throw Error('Invalid replay pack: '+message);};
export async function validateManifest(m){
  if(m?.format!=='two-stage-replay'||![1,2].includes(m.version))fail('unsupported format.');
  if(!Array.isArray(m.records)||m.records.length<1||m.records.length>2000||!Array.isArray(m.cases)||!m.cases.length)fail('bad case list.');
  const keys=new Set();
  for(const r of m.records){if(!keyPattern.test(r.key)||!/^([a-f0-9]{64})$/.test(r.sha256)||keys.has(r.key))fail('bad record index.');keys.add(r.key);}
  if(m.cases.some(k=>!keys.has(k)||!k.endsWith(m.version===2?'@4':'@3'))||new Set(m.cases).size!==m.cases.length)fail('bad playable cases.');
  if(m.version===2){if(!Array.isArray(m.setups)||!m.setups.length||m.setups.length>30)fail('bad setups.');for(const setup of m.setups)validateSetup(setup);if(new Set(m.setups.map(s=>s.id)).size!==m.setups.length||!m.setups.some(s=>s.id===m.default_setup))fail('bad default setup.');}
  if(await digest(JSON.stringify(m.version===2?{records:m.records,setups:m.setups,default_setup:m.default_setup}:m.records))!==m.id)fail('manifest checksum mismatch.');
  if(typeof m.name!=='string'||m.name.length>100)fail('bad name.');
  return m;
}
export function validateDay(d){
  if(d?.format_version===2)return validateStageDay(d);
  if(!keyPattern.test(d?.key)||!d.meta||d.key!==`${d.meta.case_id}@${d.menu_version}`)fail('day identity mismatch.');
  const m=d.meta;
  if(m.case_id!==`${m.date}_${m.symbol}`||!/^\d{4}-\d{2}-\d{2}$/.test(m.date)||!/^[A-Z0-9.-]{1,16}$/.test(m.symbol))fail('invalid date or ticker.');
  if(!Number.isInteger(m.start)||m.start<5||m.start>45||m.start%5)fail('invalid gate clock.');
  for(const k of ['session_open','previous_close','premarket_high','premarket_low','rvol','logistic_score','pm_range_score','trend_rvol_threshold','expansion_logistic_threshold','expansion_pm_range_threshold'])if(!optional(m[k]??null))fail('invalid metadata.');
  for(const k of ['trend_rvol','expansion_logistic','expansion_pm_range'])if(typeof m[k]!=='boolean')fail('invalid screen.');
  if(!Array.isArray(d.bars)||d.bars.length!==78)fail('incomplete five-minute grid.');
  d.bars.forEach((b,i)=>{if(b.minute!==(i+1)*5)fail('bad candle clock.');for(const k of ['open','high','low','close','volume','vwap','ema8','ema21'])if(!optional(b[k]))fail('bad candle.');});
  if(!Array.isArray(d.menu)||d.menu.length>20000)fail('bad contracts.');
  const ids=new Set();
  for(const c of d.menu){
    if(!['CALL','PUT'].includes(c.right)||!finite(c.strike)||c.strike<=0||!/^\d{4}-\d{2}-\d{2}$/.test(c.expiration)||typeof c.id!=='string'||c.id.length>80||!/^[0-9.|A-Z-]+$/.test(c.id)||ids.has(c.id))fail('bad contract identity.');
    if(c.listed_minute!=null&&(!Number.isInteger(c.listed_minute)||c.listed_minute<0||c.listed_minute>391))fail('bad listing clock.');
    ids.add(c.id);
  }
  if(!Array.isArray(d.forecasts)||d.forecasts.length<1||d.forecasts.length>9)fail('bad forecasts.');
  let previous=0;
  for(const f of d.forecasts){if(!Number.isInteger(f.horizon)||f.horizon%5||f.horizon<=previous||f.horizon>45||!finite(f.probability)||f.probability<0||f.probability>1)fail('bad probability.');previous=f.horizon;}
  if(!Array.isArray(d.quotes)||d.quotes.length>1600000)fail('bad quotes.');
  const seen=new Set();
  for(const q of d.quotes){
    if(!Array.isArray(q)||q.length!==6||!Number.isInteger(q[0])||q[0]<0||q[0]>=d.menu.length||!Number.isInteger(q[1])||q[1]<0||q[1]>390||q[1]%5||q.slice(2).some(v=>!optional(v)||v<0))fail('bad quote row.');
    const key=q[0]*400+q[1];if(seen.has(key))fail('duplicate quote.');seen.add(key);
  }
  return d;
}
export async function* packLines(file){
  if(file.size>256*1024*1024)fail('file is too large.');
  const magic=new Uint8Array(await file.slice(0,2).arrayBuffer());let stream=file.stream();
  if(magic[0]===31&&magic[1]===139){
    if(typeof DecompressionStream==='undefined')throw Error('Update Safari to import compressed replay packs.');
    stream=stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const reader=stream.getReader(),decoder=new TextDecoder();let buffer='',total=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>512*1024*1024)fail('decoded file is too large.');
      buffer+=decoder.decode(value,{stream:true});let end;
      while((end=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(line.trim())yield line;}
      if(buffer.length>32*1024*1024)fail('record is too large.');
    }
    buffer+=decoder.decode();if(buffer.trim())yield buffer;
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export function validateSaved(s,day=null){
  const bad=()=>{throw Error('Invalid progress backup. The saved round is inconsistent.');};
  const whole=(v,lo,hi)=>Number.isInteger(v)&&v>=lo&&v<=hi;
  const clock=v=>whole(v,0,s.minute)&&(s.engine_version===2||v%5===0);
  const layers=v=>v&&typeof v==='object'&&['vwap','ema','volume','levels','detector'].every(k=>typeof v[k]==='boolean')&&(v.model==null||typeof v.model==='boolean');
  if(!s||!/^[a-f0-9]{32}$/.test(s.id)||!whole(s.minute,0,390)||(s.engine_version!==2&&s.minute%5)||!finite(s.cash)||s.cash<0||!finite(s.realized)||typeof s.finished!=='boolean'||!whole(s.entries,0,10000))bad();
  if(!layers(s.layers)||!s.plan||!['retest','retest_ema','discretionary'].includes(s.plan.entry)||!whole(s.plan.risk,1,10)||!whole(s.plan.stop,5,90)||!whole(s.plan.trades,1,20))bad();
  if(typeof s.created_at!=='string'||!Number.isFinite(Date.parse(s.created_at))||!s.liquidity||typeof s.liquidity!=='object'||Object.values(s.liquidity).some(v=>!whole(v,0,1000000)))bad();
  for(const key of ['events','fills','checks','layer_history'])if(!Array.isArray(s[key])||s[key].length>20000)bad();
  for(const e of s.events)if(typeof e.kind!=='string'||typeof e.note!=='string'||!layers(e.layers)||!clock(e.minute))bad();
  for(const f of s.fills)if(!['BUY','SELL'].includes(f.side)||typeof f.contract!=='string'||!whole(f.qty,1,1000)||!finite(f.price)||f.price<=0||!finite(f.pnl)||!clock(f.minute))bad();
  for(const c of s.checks)if(typeof c.name!=='string'||typeof c.passed!=='boolean'||!clock(c.minute))bad();
  for(const h of s.layer_history)if(!clock(h.minute)||!layers(h.layers))bad();
  const p=s.position;
  if(p){
    if(!whole(p.qty,1,1000)||!whole(p.initial_qty,p.qty,1000)||!finite(p.entry)||p.entry<=0||!finite(p.realized)||!clock(p.entry_minute)||(p.stop_alert!=null&&!clock(p.stop_alert))||typeof p.runner!=='boolean')bad();
    let previous=0;
    if(p.profit_flags!=null){
      if(!Array.isArray(p.profit_flags)||p.profit_flags.length>10000)bad();
      for(const f of p.profit_flags){if(!whole(f.percent,previous+(s.engine_version===2?1:25),250000)||(s.engine_version!==2&&f.percent%25)||!clock(f.minute)||!['due','missed','taken','late'].includes(f.status)||(f.taken_minute!=null&&!clock(f.taken_minute))||(f.qty!=null&&!whole(f.qty,1,1000)))bad();previous=f.percent;}
    }
  }
  if(s.engine_version===2){
    if(typeof s.setup_id!=='string'||(p&&(!Array.isArray(p.target_plan)||p.target_plan.length<1||p.target_plan.length>2||p.target_plan.some(t=>!whole(t.percent,1,1000)||!whole(t.qty,1,1000)))))bad();
    if(p)for(const f of p.profit_flags){if(!whole(f.required_qty,1,1000)||!whole(f.taken_qty,0,f.required_qty)||!p.target_plan.some(t=>t.percent===f.percent&&t.qty===f.required_qty))bad();}
  }
  if(day){
    if(s.engine_version===2&&(!day.setups?.some(x=>x.id===s.setup_id)||s.minute>day.deadline))bad();
    if(Boolean(day.setups)!==(s.engine_version===2))bad();
    if(s.engine_version===2){
      const setup=day.setups.find(x=>x.id===s.setup_id),x=setup.exit;
      if(s.plan.entry!=='discretionary'||s.plan.stop!==x.stop||s.plan.trades!==setup.max_entries)bad();
      if(p){const n=p.initial_qty,first=x.family==='full'||n===1?n:Math.min(n-1,Math.max(1,Math.floor(n*x.fraction+.5)));
        const expected=[{percent:x.first,qty:first},...(n>first?[{percent:x.second,qty:n-first}]:[])];
        if(JSON.stringify(p.target_plan)!==JSON.stringify(expected))bad();
      }
    }
    if(s.case_id!==day.meta.case_id||(s.menu_version??1)!==day.menu_version)bad();
    const contracts=new Map(day.menu.map(c=>[c.id,c]));
    if(s.fills.some(f=>!contracts.has(f.contract)))bad();
    if(p){
      const c=contracts.get(p.id),entry=day.quote(p.id,p.entry_minute);
      if(!c||['right','strike','expiration'].some(k=>p[k]!==c[k])||!entry||p.entry!==entry.ask)bad();
    }
  }
  return s;
}

function validateSetup(s){
  if(!s||!/^[a-z0-9_]{1,60}$/.test(s.id)||typeof s.name!=='string'||s.name.length>100||typeof s.description!=='string'||s.description.length>1000||typeof s.caution!=='string'||s.caution.length>1000)fail('invalid setup identity.');
  const e=s.entry,x=s.exit;
  if(s.overlay!=null&&(!['entry_vwap_5m_2','exit_vwap_5m_2'].includes(s.overlay)||s.parent_setup!=='stock_reclaim'||e?.kind!=='reclaim'||e?.monitor!=='stock'||e?.anchor!==60||e?.window!==3||x?.family!=='full'||x?.first!==50||x?.second!==50||x?.fraction!==1||x?.stop!==25||x?.grace!==10))fail('unsupported reclaim overlay.');
  if(!e||!['clock','adverse','reclaim'].includes(e.kind)||!['none','stock','premium'].includes(e.monitor)||!Number.isInteger(e.anchor)||e.anchor<0||e.anchor>300||!Number.isInteger(e.window)||(e.kind==='clock'?e.window!==0||e.monitor!=='none':e.window<1||e.window>5||e.monitor==='none'))fail('invalid entry rule.');
  if(!x||!['runner','full'].includes(x.family)||!Number.isInteger(x.first)||x.first<1||x.first>1000||!Number.isInteger(x.second)||x.second<x.first||x.second>1000||!finite(x.fraction)||x.fraction<=0||x.fraction>1||!Number.isInteger(x.stop)||x.stop<5||x.stop>90||!Number.isInteger(x.grace)||x.grace<0||x.grace>60)fail('invalid exit rule.');
  if(!finite(s.budget)||s.budget<1||s.budget>20000||!Number.isInteger(s.max_contracts)||s.max_contracts<1||s.max_contracts>1000||s.max_entries!==1||s.deadline!==330)fail('invalid setup limits.');
}
function validateStageDay(d){
  const m=d.meta,h=d.deadline;
  if(!m||d.menu_version!==4||!keyPattern.test(d.key)||d.key!==`${m.case_id}@4`||m.case_id!==`${m.date}_${m.symbol}`||!/^\d{4}-\d{2}-\d{2}$/.test(m.date)||!/^[A-Z0-9.-]{1,16}$/.test(m.symbol)||!Number.isInteger(h)||h<95||h>330||h%5)fail('invalid Stage 2 identity.');
  if(!['CALL','PUT'].includes(m.morning_side)||!Number.isInteger(m.rank)||m.rank<1||m.rank>3||!finite(m.watch_score)||m.watch_score<0||m.watch_score>1||typeof m.watchlist!=='string'||m.watchlist.length>100)fail('invalid watchlist.');
  for(const k of ['session_open','previous_close','premarket_high','premarket_low'])if(!optional(m[k]))fail('invalid levels.');
  if(!Array.isArray(d.bars)||d.bars.length!==h/5||!Array.isArray(d.underlying)||d.underlying.length!==h||!Array.isArray(d.forecasts)||d.forecasts.length)fail('invalid clocks.');
  for(const [i,b] of d.bars.entries()){if(b.minute!==(i+1)*5)fail('invalid candle clock.');for(const k of ['open','high','low','close','volume','vwap','ema8','ema21'])if(!optional(b[k]))fail('invalid candle.');}
  for(const [i,b] of d.underlying.entries()){if(b.minute!==i)fail('invalid minute clock.');for(const k of ['open','high','low','close','volume','vwap'])if(!optional(b[k]))fail('invalid minute.');}
  if(!Array.isArray(d.selection_strikes)||!d.selection_strikes.length||d.selection_strikes.some(k=>!finite(k)||k<=0)||!/^\d{4}-\d{2}-\d{2}$/.test(d.expiration))fail('invalid contract selection.');
  if(!Array.isArray(d.menu)||d.menu.length>20000||!Array.isArray(d.quotes)||d.quotes.length>1600000)fail('invalid quote table.');
  const ids=new Set(),seen=new Set();
  for(const c of d.menu){if(typeof c.id!=='string'||!/^[0-9.|A-Z-]{1,80}$/.test(c.id)||ids.has(c.id)||!['CALL','PUT'].includes(c.right)||!finite(c.strike)||c.strike<=0||!/^\d{4}-\d{2}-\d{2}$/.test(c.expiration)||!Number.isInteger(c.listed_minute)||c.listed_minute<0||c.listed_minute>h)fail('invalid contract.');ids.add(c.id);}
  for(const q of d.quotes){
    if(!Array.isArray(q)||q.length!==6||!Number.isInteger(q[0])||q[0]<0||q[0]>=d.menu.length||!Number.isInteger(q[1])||q[1]<0||q[1]>h||q.slice(2).some(v=>!optional(v)||v<0))fail('invalid quote.');
    const key=q[0]*400+q[1];if(seen.has(key))fail('duplicate quote.');seen.add(key);
  }
  if(d.benchmarks!=null)validateBenchmarks(d.benchmarks,h);
  return d;
}

function validateBenchmarks(rows,deadline){
  if(!Array.isArray(rows)||rows.length!==6)fail('invalid benchmarks.');
  const seen=new Set();
  for(const b of rows){
    if(!['stock_reclaim','stock_reclaim_exit_vwap_5m_2','stock_reclaim_entry_vwap_5m_2'].includes(b.setup_id)||!['cap2000_max10','lots2'].includes(b.profile)||seen.has(b.setup_id+':'+b.profile))fail('invalid benchmark identity.');
    seen.add(b.setup_id+':'+b.profile);
    if(typeof b.eligible!=='boolean'||typeof b.resolved!=='boolean'||typeof b.veto!=='boolean'||!Number.isInteger(b.n)||b.n<0||b.n>10||!finite(b.debit)||b.debit<0||!optional(b.pnl)||!optional(b.lower)||!optional(b.upper)||typeof b.status!=='string'||b.status.length>80||!Array.isArray(b.events)||b.events.length>3)fail('invalid benchmark accounting.');
    if(!b.eligible&&(b.n!==0||b.debit!==0||b.events.length)||b.veto&&(b.eligible||b.pnl!==0))fail('veto or cash benchmark has trades.');
    if(b.eligible&&(!Number.isInteger(b.entry_minute)||b.entry_minute<0||b.entry_minute>=deadline||!['CALL','PUT'].includes(b.side)||!finite(b.strike)||b.strike<=0||!/^\d{4}-\d{2}-\d{2}$/.test(b.expiration)||b.n<1||b.debit<=0))fail('invalid benchmark entry.');
    let sold=0,last=b.entry_minute;
    for(const ev of b.events){if(!Array.isArray(ev)||ev.length!==5||!Number.isInteger(ev[0])||ev[0]<=b.entry_minute||ev[0]<last||ev[0]>deadline||!Number.isInteger(ev[1])||ev[1]<1||!finite(ev[2])||ev[2]<=0||!['target','stop','deadline','trend_exit'].includes(ev[3])||![-1,0,1].includes(ev[4]))fail('invalid benchmark sale.');sold+=ev[1];last=ev[0];}
    if(sold>b.n||b.resolved&&(sold!==b.n||!finite(b.pnl)||Math.abs(-b.debit+b.events.reduce((n,e)=>n+100*e[1]*e[2],0)-b.pnl)>1e-6))fail('benchmark cashflow mismatch.');
  }
}
