export const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
const keyPattern=/^\d{4}-\d{2}-\d{2}_[A-Z0-9.-]+@[123]$/;
const finite=v=>typeof v==='number'&&Number.isFinite(v);
const optional=v=>v===null||finite(v);
const fail=message=>{throw Error('Invalid replay pack: '+message);};
export async function validateManifest(m){
  if(m?.format!=='two-stage-replay'||m.version!==1)fail('unsupported format.');
  if(!Array.isArray(m.records)||m.records.length<1||m.records.length>2000||!Array.isArray(m.cases)||!m.cases.length)fail('bad case list.');
  const keys=new Set();
  for(const r of m.records){if(!keyPattern.test(r.key)||!/^([a-f0-9]{64})$/.test(r.sha256)||keys.has(r.key))fail('bad record index.');keys.add(r.key);}
  if(m.cases.some(k=>!keys.has(k)||!k.endsWith('@3'))||new Set(m.cases).size!==m.cases.length)fail('bad playable cases.');
  if(await digest(JSON.stringify(m.records))!==m.id)fail('manifest checksum mismatch.');
  if(typeof m.name!=='string'||m.name.length>100)fail('bad name.');
  return m;
}
export function validateDay(d){
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
  const clock=v=>whole(v,0,s.minute)&&v%5===0;
  const layers=v=>v&&typeof v==='object'&&['vwap','ema','volume','levels','detector'].every(k=>typeof v[k]==='boolean')&&(v.model==null||typeof v.model==='boolean');
  if(!s||!/^[a-f0-9]{32}$/.test(s.id)||!whole(s.minute,0,390)||s.minute%5||!finite(s.cash)||s.cash<0||!finite(s.realized)||typeof s.finished!=='boolean'||!whole(s.entries,0,10000))bad();
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
      for(const f of p.profit_flags){if(!whole(f.percent,previous+25,250000)||f.percent%25||!clock(f.minute)||!['due','missed','taken','late'].includes(f.status)||(f.taken_minute!=null&&!clock(f.taken_minute))||(f.qty!=null&&!whole(f.qty,1,1000)))bad();previous=f.percent;}
    }
  }
  if(day){
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
