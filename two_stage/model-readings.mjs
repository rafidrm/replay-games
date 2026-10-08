// Frozen learner outputs, independent of the chosen trade and clipped to the replay clock.
const specs={waiting:{title:'Waiting',threshold:10,lag:15,start:-10,end:15,lastEligible:15},iteration:{title:'Iteration',threshold:.6,lag:5,start:0,end:20,lastEligible:20}};
export function validateModelReadings(d,fail){
  const a=d.model_readings;if(a==null)return;
  if(a.version!==1||a.side!==d.meta.morning_side||!d.policy_signals)fail('invalid model reading identity.');
  const alerts=[];
  for(const [code,s] of Object.entries(specs)){
    if(!Array.isArray(a[code])||a[code].length!==(code==='waiting'?6:5))fail('incomplete model readings.');
    for(const [i,r] of a[code].entries()){
      if(r.minute!==s.start+i*5||r.entry_minute!==r.minute+s.lag||!Number.isFinite(r.value))fail('invalid model reading clock or value.');
      if(code==='iteration'&&(r.value<0||r.value>1))fail('invalid iteration score.');
      if(code==='waiting'&&(!Number.isFinite(r.enter_value)||!Number.isFinite(r.wait_value)||r.wait_value<0||Math.abs(r.enter_value-r.wait_value-r.value)>1e-7))fail('invalid waiting value decomposition.');
      if(r.value>s.threshold&&r.minute<=s.lastEligible)alerts.push({minute:r.minute,entry_minute:r.entry_minute,side:a.side,origin:code});
    }
  }
  alerts.sort((a,b)=>a.minute-b.minute||(a.origin==='waiting'?-1:1));
  if(JSON.stringify(alerts)!==JSON.stringify(d.policy_signals.union.alerts))fail('model readings disagree with frozen alerts.');
}
export function modelReadings(day,minute,setup){
  const source=day.modelReadings??day.data?.model_readings;
  if(!day.data?.policy_signals)return null;
  if(!source)return {available:false,side:day.meta.morning_side,models:[]};
  return {available:true,side:source.side,models:Object.entries(specs).map(([id,s])=>{
    const history=source[id].filter(r=>r.minute<=minute).map(r=>({...r,eligible:r.minute<=s.lastEligible,passes:r.value>s.threshold}));
    const latest=history.at(-1)??null;
    return {id,...s,used:setup.ws_code!=='P05'||id==='iteration',history,latest,phase:minute>s.end?'closed':latest?.minute===minute?'fresh':latest?'held':'pending'};
  })};
}
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=m=>`${String(Math.floor((570+m)/60)).padStart(2,'0')}:${String((570+m)%60).padStart(2,'0')}`;
const value=(m,v)=>m.id==='waiting'?(v<0?'−':'+')+'$'+Math.abs(v).toFixed(2):(v*100).toFixed(1)+'%';
export function readingSVG(m){
  const W=300,H=100,left=12,right=10,top=12,bottom=22,p=m.history;
  const vals=[...p.map(r=>r.value),m.threshold,0],low=m.id==='iteration'?0:Math.min(...vals),high=m.id==='iteration'?1:Math.max(...vals),pad=m.id==='iteration'?0:Math.max(5,(high-low)*.15),lo=low-pad,hi=high+pad;
  const x=t=>left+(t-m.start)/(m.end-m.start)*(W-left-right),y=v=>top+(hi-v)/(hi-lo)*(H-top-bottom);
  let out=`<line x1="${left}" x2="${W-right}" y1="${y(m.threshold)}" y2="${y(m.threshold)}" stroke="#607e98" stroke-dasharray="4 4"/><text x="${W-right}" y="${y(m.threshold)-4}" text-anchor="end" fill="#8396ac" font-size="9">${m.id==='waiting'?'+$10':'60%'} trigger</text>`;
  if(p.length)out+=`<path d="${p.map((r,i)=>`${i?'L':'M'}${x(r.minute)},${y(r.value)}`).join(' ')}" fill="none" stroke="#b298ef" stroke-width="1.6"/>`;
  for(let t=m.start;t<=m.end;t+=5)out+=`<text x="${x(t)}" y="${H-3}" text-anchor="${t===m.start?'start':t===m.end?'end':'middle'}" fill="#8396ac" font-size="8">${time(t)}</text>`;
  for(const r of p)out+=`<circle cx="${x(r.minute)}" cy="${y(r.value)}" r="3" fill="${!r.eligible?'#8396ac':r.passes?'#65e4b5':'#b298ef'}"><title>${time(r.minute)} · ${escape(value(m,r.value))} · ${r.eligible?(r.passes?'above':'below')+' threshold':'outside early-entry window'}</title></circle>`;
  return out;
}
export function renderModelReadings(state){
  const panel=document.querySelector('#entry-models'),source=state.model_readings;panel.hidden=!state.ws;
  if(!state.ws)return;
  if(!source?.available){panel.innerHTML='<p class="small muted">Waiting / iteration scores need the model-signals pack. Import it once to add readings to this saved round.</p>';return;}
  panel.innerHTML=`<div class="entry-model-heading"><h3>Entry models · ${escape(source.side)}</h3><span>${state.setup.ws_code==='P05'?'P05 uses iteration':'P08 / P09 use either signal'}</span></div><div class="entry-model-grid">${source.models.map(m=>{
    const r=m.latest,signal=r?.eligible&&r.passes,closed=m.phase==='closed',status=!m.used?'Context only':closed?'Window ended':!r?'Awaiting reading':!r.eligible?'Outside entry window':signal?'Signal':'No signal';
    return `<article class="entry-model ${signal&&!closed&&m.used?'triggered':''}"><div class="entry-model-title"><b>${m.title}</b><span>${status}</span></div><div class="entry-model-value">${r?value(m,r.value):'—'}<small>${m.id==='waiting'?'enter − wait advantage':'entry score'}</small></div><p>${r?`${closed?'Final':m.phase==='fresh'?'Forecast':'Last reading'} ${time(r.minute)} · ${r.eligible?'candidate buy '+time(r.entry_minute):'10:00 fallback excluded'}`:'First forecast '+time(m.start)}</p><svg viewBox="0 0 300 100" role="img" aria-label="${m.title} model readings through ${time(state.minute)}">${readingSVG(m)}</svg><details><summary>Readings</summary><table><thead><tr><th>Forecast</th><th>${m.id==='waiting'?'Advantage':'Score'}</th><th>Entry</th></tr></thead><tbody>${m.history.map(r=>`<tr><td>${time(r.minute)}</td><td>${value(m,r.value)}</td><td>${r.eligible?time(r.entry_minute):'Excluded'}</td></tr>`).join('')}</tbody></table></details></article>`;
  }).join('')}</div><p class="entry-model-note">Waiting uses a two-contract dollar model, not your position size. Iteration is an entry score, not win probability. Scores end in the morning; the selected entry stays fixed.</p>`;
}
