// Read-only chart projections. Every series ends at the saved replay clock.
import {stopRule} from './policies.mjs';
const finite=Number.isFinite;
const copy=v=>structuredClone(v);

export function stockBars(day,minute,width=5,layers={vwap:true,ema:true,volume:true}){
  const bars=[];
  if(width===3&&day.underlying){
    for(let end=3;end<=minute;end+=3){
      const block=day.underlying.slice(end-3,end);
      const good=block.length===3&&block.every((b,i)=>b.minute===end-3+i&&['open','high','low','close'].every(k=>finite(b[k])));
      // VWAP is cumulative regular-session VWAP; EMA retains the policy's 5m clock.
      const ema=day.bars.findLast(b=>b.minute<=end);
      bars.push({minute:end,open:good?block[0].open:null,high:good?Math.max(...block.map(b=>b.high)):null,
        low:good?Math.min(...block.map(b=>b.low)):null,close:good?block.at(-1).close:null,
        volume:good&&block.every(b=>finite(b.volume))?block.reduce((n,b)=>n+b.volume,0):null,
        vwap:good?block.at(-1).vwap:null,ema8:good?ema?.ema8??null:null,ema21:good?ema?.ema21??null:null});
    }
  }else bars.push(...copy(day.bars.filter(b=>b.minute<=minute)));
  for(const b of bars){if(!layers.vwap)delete b.vwap;if(!layers.ema){delete b.ema8;delete b.ema21;}if(!layers.volume)delete b.volume;}
  return bars;
}

export function setupWindows(day,setup,minute,signal){
  const e=setup?.entry;
  if(!e||!['stock','premium'].includes(e.monitor)||minute<e.anchor||!finite(signal.reference))return [];
  const result=[],sign=day.meta.morning_side==='CALL'?1:-1;
  let adverseSeen=false;
  for(let end=e.anchor+e.window;end<=Math.min(minute,e.anchor+30,signal.entry_minute==null?Infinity:signal.entry_minute-1);end+=e.window){
    const start=end-e.window;let open,close;
    if(e.monitor==='stock'){
      const block=day.underlying.slice(start,end);
      if(block.length===e.window&&block.every(b=>finite(b.open)&&finite(b.close))){open=block[0].open;close=block.at(-1).close;}
    }else{
      const qs=Array.from({length:e.window+1},(_,i)=>day.quote(signal.monitor?.id,start+i));
      if(qs.every(Boolean)){open=(qs[0].bid+qs[0].ask)/2;close=(qs.at(-1).bid+qs.at(-1).ask)/2;}
    }
    if(!finite(open)||!finite(close)){result.push({start,end,status:'gap'});break;}
    const adverse=e.monitor==='stock'?sign*(close-open)<0:close<open;
    const reclaimed=e.monitor==='stock'?sign*(close-signal.reference)>=0:close>=signal.reference;
    const triggered=e.kind==='adverse'?adverse:adverseSeen&&reclaimed;
    result.push({start,end,open,close,status:triggered?'signal':adverse?'adverse':'waiting'});
    if(triggered)break;
    adverseSeen||=adverse;
  }
  return result;
}

export function chartEvidence(game,{contract='',width=5}={}){
  const day=game.day,s=game.s,minute=s.minute,setup=game.setup,signal=setup?day.setupAt(setup,minute):null;
  width=width===3&&day.underlying?3:5;
  const windows=setupWindows(day,setup,minute,signal),p=s.position;
  const charts=[];
  function series(id,role){
    const c=day.menu.find(c=>c.id===id&&(c.listed_minute??0)<=minute);if(!c)return null;
    const cadence=day.underlying?1:5,points=[];
    for(let m=0;m<=minute;m+=cadence){
      const q=m>=(c.listed_minute??0)?day.quote(c.id,m):null;
      points.push({minute:m,bid:q?.bid??null,ask:q?.ask??null,mid:q?(q.bid+q.ask)/2:null});
    }
    return {contract:copy(c),role,cadence,points,lines:[],windows:[],fills:copy(s.fills.filter(f=>f.contract===id&&f.minute<=minute))};
  }
  if(signal?.monitor){
    const anchor=series(signal.monitor.id,'setup');
    if(anchor){anchor.windows=windows;if(finite(signal.reference))anchor.lines.push({price:signal.reference,label:'Anchor midpoint',start:setup.entry.anchor,kind:'anchor'});charts.push(anchor);}
  }
  const id=p?.id||contract;
  let trade=charts.find(c=>c.contract.id===id);
  const traded=!p&&s.fills.some(f=>f.side==='BUY'&&f.contract===id&&f.minute<=minute);
  if(trade)trade.role=p?'setup-position':traded?'setup-traded':'setup-selected';
  else {trade=series(id,p?'position':traded?'traded':'selected');if(trade)charts.push(trade);}
  if(trade&&p&&s.ws_version===1){
    const b=s.ws.book,r=b.rule;
    trade.lines.push({price:p.entry,label:'Entry ask',start:p.entry_minute,kind:'entry'});
    for(const g of b.groups.filter(g=>g.qty)){
      const prefix=`G${g.id+1} ×${g.qty} · `,unplaced=g.active==='none';
      const target=g.active==='target'||unplaced&&g.role<2;
      const level=unplaced?b.entry*(g.role<2?1+(g.role===0?r.first:r.second):1-r.stop):g.level;
      trade.lines.push({price:level,label:prefix+(unplaced?'Unplaced ':'')+(target?'target':g.active==='limit'?'triggered limit':'stop trigger'),start:unplaced?b.entry_minute:Math.min(g.activation,s.minute),kind:target?'target':'stop',active:true});
      if(g.active==='stoplimit'||unplaced&&g.role===2)trade.lines.push({price:b.entry*(1-r.stop-(r.kind===2?.05:0)),label:prefix+'limit',start:b.entry_minute,kind:'stop',active:true});
      if(g.pending&&g.pending.kind!=='cancel')trade.lines.push({price:b.entry*(g.pending.kind==='breakeven'?1:1-r.stop),label:prefix+'pending '+g.pending.kind+' @ '+`${String(Math.floor((570+g.pending.due)/60)).padStart(2,'0')}:${String((570+g.pending.due)%60).padStart(2,'0')}`,start:s.minute,kind:'stop',active:true});
    }
  }else if(trade&&p){
    trade.lines.push({price:p.entry,label:'Entry ask',start:p.entry_minute,kind:'entry'});
    const x=setup?.exit,targets=x?(x.family==='full'?[x.first]:[x.first,x.second]):[25,50,75,100];
    for(const percent of targets)trade.lines.push({price:p.entry*(1+percent/100),label:'+'+percent+'%',start:p.entry_minute,kind:'target'});
    const stop=setup?stopRule(p,setup,minute):{price:p.entry*(1-s.plan.stop/100),active:minute>p.entry_minute,activation:p.entry_minute+5};
    trade.lines.push({...stop,label:stop.breakeven?'Breakeven':`Stop −${x?.stop??s.plan.stop}%`,start:stop.breakeven?Math.min(minute,stop.activation):p.entry_minute,kind:'stop'});
  }
  return {id:s.id,minute,revision:s.events.length,width,supports_three:!!day.underlying,
    bars:stockBars(day,minute,width,s.layers),stock_reference:setup?.entry.monitor==='stock'?signal.reference??null:null,
    stock_anchor:setup?.entry.monitor==='stock'?setup.entry.anchor:null,stock_windows:setup?.entry.monitor==='stock'?windows:[],
    monitor_status:setup?.entry.monitor==='premium'?signal.status:null,monitor_anchor:setup?.entry.monitor==='premium'?setup.entry.anchor:null,
    charts};
}
