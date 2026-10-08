const time=m=>`${String(Math.floor((570+m)/60)).padStart(2,'0')}:${String((570+m)%60).padStart(2,'0')}`;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const price=v=>v==null?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(v);
export const optionLabel=c=>`${c.expiration} · $${c.strike} ${c.right}`;

export function optionSVG(chart,minute,W,H=210){
  const left=9,right=57,top=23,bottom=27,pw=W-left-right;
  const points=chart.points,values=points.flatMap(p=>[p.bid,p.ask].filter(Number.isFinite));
  if(!values.length)return `<text x="${W/2}" y="${H/2}" text-anchor="middle" fill="#8396ac" font-size="12">No observed quotes yet</text>`;
  values.push(...chart.lines.map(l=>l.price).filter(Number.isFinite));
  const lo=Math.min(...values),hi=Math.max(...values),pad=Math.max((hi-lo)*.18,.05),min=Math.max(0,lo-pad),max=hi+pad;
  const end=Math.max(30,minute+3),x=m=>left+m/end*pw,y=p=>top+(max-p)/(max-min)*(H-top-bottom);
  let out='';
  for(let i=0;i<4;i++){const v=min+(max-min)*i/3;out+=`<line x1="${left}" x2="${W-right}" y1="${y(v)}" y2="${y(v)}" stroke="#253246" stroke-dasharray="2 5"/><text x="${W-right+8}" y="${y(v)+3}" fill="#8396ac" font-size="9">${v.toFixed(2)}</text>`;}
  for(const w of chart.windows){
    const color=w.status==='signal'?'#65e4b5':w.status==='adverse'?'#ed8191':'#8396ac';
    out+=`<rect x="${x(w.start)}" y="${top}" width="${x(w.end)-x(w.start)}" height="${H-top-bottom}" fill="${color}" opacity=".09"/><text x="${x(w.end)}" y="${top-5}" text-anchor="end" fill="${color}" font-size="9">${w.status==='signal'?'Signal':w.status==='gap'?'Gap':'·'}</text>`;
  }
  // Keep exact horizontal prices while separating coincident order labels.
  const labelRows=chart.lines.map(line=>({line,y:y(line.price)-4})).sort((a,b)=>a.y-b.y);
  for(let i=0;i<labelRows.length;i++)labelRows[i].y=Math.max(top+2,labelRows[i].y,i?labelRows[i-1].y+12:0);
  for(let i=labelRows.length-1;i>=0;i--)labelRows[i].y=Math.min(H-bottom-3,labelRows[i].y,i<labelRows.length-1?labelRows[i+1].y-12:Infinity);
  for(const {line,y:labelY} of labelRows){
    const color={anchor:'#eac575',entry:'#b6c5d4',target:'#65e4b5',stop:'#ed8191'}[line.kind];
    const label=line.label+(line.kind==='stop'&&!line.active?' · active '+time(line.activation):'');
    out+=`<line x1="${x(Math.min(minute,line.start))}" x2="${x(minute)}" y1="${y(line.price)}" y2="${y(line.price)}" stroke="${color}" stroke-dasharray="4 4" opacity=".65"/><text x="${left+4}" y="${labelY}" fill="${color}" font-size="9">${escape(label)} ${price(line.price)}</text>`;
  }
  const keys=chart.role.startsWith('setup')?[['bid','#65d9b0'],['ask','#b298ef'],['mid','#eac575']]:[['bid','#65d9b0'],['ask','#b298ef']];
  for(const [key,color] of keys){
    let path='',gap=true;
    for(const p of points){if(!Number.isFinite(p[key])){gap=true;continue;}path+=`${gap?'M':'L'}${x(p.minute)},${y(p[key])} `;gap=false;
      out+=`<circle cx="${x(p.minute)}" cy="${y(p[key])}" r="${points.length>80?1:1.7}" fill="${color}"><title>${time(p.minute)} · ${key} ${price(p[key])}</title></circle>`;
    }
    out+=`<path d="${path}" fill="none" stroke="${color}" stroke-width="${key==='mid'?1.8:1.2}"/>`;
  }
  for(const f of chart.fills){const color=f.side==='BUY'?'#65e4b5':'#eac575';out+=`<circle cx="${x(f.minute)}" cy="${y(f.price)}" r="6" fill="${color}"/><text x="${x(f.minute)}" y="${y(f.price)+2.5}" text-anchor="middle" fill="#09251d" font-size="7" font-weight="bold">${f.side==='BUY'?'B':'S'}<title>${time(f.minute)} · ${f.side} ${f.qty} at ${price(f.price)}</title></text>`;}
  const interval=end<=60?15:end<=180?30:60;
  for(let m=0;m<=minute;m+=interval)out+=`<text x="${x(m)}" y="${H-6}" fill="#8396ac" font-size="9">${time(m)}</text>`;
  out+=`<line x1="${x(minute)}" x2="${x(minute)}" y1="${top}" y2="${H-bottom}" stroke="#526476" stroke-dasharray="3 5"/>`;
  return out;
}

export function quoteCaption(chart,minute){
  const p=chart.points.find(p=>p.minute===minute);
  return `${time(minute)} · Bid ${price(p?.bid)} / Ask ${price(p?.ask)}${chart.role.startsWith('setup')?' · Mid '+price(p?.mid):''}`;
}
export function windowCaption(windows){
  const w=windows.at(-1);if(!w)return '';
  return `${time(w.start)}–${time(w.end)} · ${w.status==='gap'?'Missing observations':price(w.open)+' → '+price(w.close)+' · '+({signal:'Signal',adverse:'Adverse',waiting:'No signal'}[w.status])}`;
}
