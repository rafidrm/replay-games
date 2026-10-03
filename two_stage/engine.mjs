// Browser port of the audited local replay rules. Input paths remain private on-device.
export const LAYERS=['vwap','ema','volume','levels','detector','model'];
export const DEFAULT_LAYERS={vwap:true,ema:true,volume:true,levels:false,detector:true,model:true};
const SCREENS=[['trend_rvol','Relative volume','rvol'],['expansion_logistic','Expansion model','logistic_score'],['expansion_pm_range','Premarket range','pm_range_score']];
const clone=value=>structuredClone(value);
// Match Python's round-to-even, including its binary float representation.
export function roundEven(value,digits=0){
  if(!Number.isFinite(value))throw Error('Invalid amount');
  if(value===0)return 0;
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,Math.abs(value));
  const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&2047n),fraction=bits&((1n<<52n)-1n);
  let numerator=exponent?fraction+(1n<<52n):fraction,denominator=1n;
  const power=(exponent?exponent-1023:1-1023)-52;
  if(power>=0)numerator<<=BigInt(power);else denominator<<=BigInt(-power);
  numerator*=10n**BigInt(digits);
  let quotient=numerator/denominator;const rest=numerator%denominator;
  if(rest*2n>denominator||(rest*2n===denominator&&quotient%2n))quotient++;
  return (value<0?-1:1)*Number(quotient)/10**digits;
}
function integer(value,low,high,name){
  if(typeof value!=='number'||!Number.isInteger(value)||value<low||value>high)throw Error(`${name} must be a whole number from ${low} to ${high}`);
  return value;
}
export class Day {
  constructor(data){
    this.meta=data.meta;this.bars=data.bars;this.menu=data.menu;this.forecasts=data.forecasts;this.menu_version=data.menu_version;
    this.quotes=new Map(data.quotes.map(([i,m,bid,ask,bid_size,ask_size])=>[`${data.menu[i].id}@${m}`,{bid,ask,bid_size,ask_size}]));
  }
  quote(cid,minute){
    const q=this.quotes.get(`${cid}@${minute}`);
    return q&&Object.values(q).every(v=>v!=null)&&0<q.bid&&q.bid<=q.ask&&Math.min(q.bid_size,q.ask_size)>=1?q:null;
  }
  trend_gate(minute){return this.forecasts.find(f=>f.horizon<=minute&&f.probability>=.5)?.horizon??null;}
  signals(minute){
    const seen=this.bars.filter(b=>b.minute<=minute),result={retest:null,cross:null,ema:null,vwap_side:null};
    if(!seen.length||seen.at(-1).close==null)return result;
    const b=seen.at(-1),p=seen.at(-2);
    if(b.vwap!=null)result.vwap_side=b.close>b.vwap?'CALL':b.close<b.vwap?'PUT':null;
    if(b.ema8!=null&&b.ema21!=null)result.ema=b.ema8>b.ema21?'CALL':b.ema8<b.ema21?'PUT':null;
    if(seen.length<2||minute<15||p.close==null||p.vwap==null||b.vwap==null)return result;
    if(p.close>p.vwap&&b.open>=p.vwap&&b.low<=p.vwap&&b.close>Math.max(p.vwap,b.vwap))result.retest='CALL';
    else if(p.close<p.vwap&&b.open<=p.vwap&&b.high>=p.vwap&&b.close<Math.min(p.vwap,b.vwap))result.retest='PUT';
    if(p.close<=p.vwap&&b.close>b.vwap)result.cross='CALL';
    else if(p.close>=p.vwap&&b.close<b.vwap)result.cross='PUT';
    return result;
  }
}
export class Game {
  constructor(day,{saved=null,layers=null,plan={},id=crypto.randomUUID().replaceAll('-',''),created_at=new Date().toISOString()}={}){
    this.day=day;
    if(saved){
      this.s=clone(saved);this.s.layers.model??=this.s.layers.detector??false;this.s.clock_version??=1;
      this.s.profit_version??=this.s.finished?0:1;
      if(!this.s.finished&&this.s.position&&!this.s.position.profit_flags){this.s.position.profit_flags=[];this.observe_profit();}
      return;
    }
    const entry=plan.entry??'retest';
    if(!['retest','retest_ema','discretionary'].includes(entry))throw Error('Unknown entry plan');
    this.s={id,case_id:day.meta.case_id,minute:0,clock_version:2,replay_start:0,profit_version:1,menu_version:day.menu_version??1,
      created_at,cash:20000,realized:0,position:null,events:[],fills:[],checks:[],entries:0,finished:false,
      layers:Object.fromEntries(LAYERS.map(k=>[k,Boolean((layers??DEFAULT_LAYERS)[k])])),
      plan:{entry,risk:integer(plan.risk??2,1,10,'Risk percent'),stop:integer(plan.stop??25,5,90,'Premium stop percent'),trades:integer(plan.trades??3,1,20,'Daily entry limit')},
      liquidity:{},layer_history:[],repeated:false};
    this.event('start','Market open. Waiting for the intraday trend gate.');
  }
  event(kind,note,extra={}){this.s.events.push({kind,minute:this.s.minute,note:String(note).slice(0,500),layers:clone(this.s.layers),...extra});}
  check(name,ok){this.s.checks.push({name,passed:Boolean(ok),minute:this.s.minute});}
  available(cid,side){const q=this.day.quote(cid,this.s.minute);return q?Math.max(0,Math.trunc(q[side+'_size'])-(this.s.liquidity[`${this.s.minute}:${cid}:${side}`]??0)):0;}
  use_depth(cid,side,qty){
    if(qty>this.available(cid,side))throw Error('Not enough displayed contracts at this snapshot. Reduce quantity or wait.');
    const key=`${this.s.minute}:${cid}:${side}`;this.s.liquidity[key]=(this.s.liquidity[key]??0)+qty;
  }
  buy(cid,qty,note=''){
    const s=this.s;
    if(s.position)throw Error('Manage the current position before opening another.');
    if(s.minute>=390)throw Error('The market has closed.');
    qty=integer(qty,1,1000,'Contracts');
    const c=this.day.menu.find(c=>c.id===cid&&(c.listed_minute??0)<=s.minute),q=this.day.quote(cid,s.minute);
    if(!c||!q)throw Error('No usable two-sided quote for this contract at this clock.');
    const cost=roundEven(q.ask*qty*100,2);
    if(cost>s.cash)throw Error('Insufficient practice cash. Reduce the contract count.');
    this.use_depth(cid,'ask',qty);
    const sig=this.day.signals(s.minute),rule=s.plan.entry;
    if(rule!=='discretionary')this.check('Entry matched VWAP retest',sig.retest===c.right);
    if(rule==='retest_ema')this.check('Entry matched EMA 8/21',sig.ema===c.right);
    this.check('Planned premium risk within budget',cost*s.plan.stop/100<=20000*s.plan.risk/100+.001);
    this.check('Entry spread at most 15%',(q.ask-q.bid)/q.ask<=.15+1e-10);
    this.check('Daily entry limit respected',s.entries<s.plan.trades);
    if(s.clock_version>=2)this.check('Waited for intraday trend gate',this.day.trend_gate(s.minute)!=null);
    s.entries++;s.cash=roundEven(s.cash-cost,2);
    s.position={...c,qty,initial_qty:qty,entry:q.ask,entry_minute:s.minute,realized:0,stop_alert:null,runner:false,profit_flags:[]};
    s.fills.push({side:'BUY',minute:s.minute,contract:cid,qty,price:q.ask,pnl:0});
    this.event('buy',note||`Bought ${qty} at the ask.`,{contract:cid,qty,price:q.ask});this.observe_stop();
  }
  sell(qty,note='',forced=false){
    const s=this.s,p=s.position;if(!p)throw Error('No open position.');
    qty=integer(qty,1,p.qty,'Contracts to sell');const q=this.day.quote(p.id,s.minute);
    if(!q)throw Error('No usable quote at this clock. P&L remains unknown; no price is invented.');
    this.use_depth(p.id,'bid',qty);
    if(!forced)for(const flag of p.profit_flags??[]){
      if(['due','missed'].includes(flag.status)&&q.bid+1e-10>=p.entry*(1+flag.percent/100)){
        const on_time=flag.status==='due';Object.assign(flag,{status:on_time?'taken':'late',taken_minute:s.minute,qty});
        if(on_time)this.check(`Took profit at +${flag.percent}% before advancing`,true);
        this.event('profit_taken',`+${flag.percent}% profit taken${on_time?'.':' late.'}`,{target:flag.percent,qty,contract:p.id});
      }
    }
    const proceeds=roundEven(q.bid*qty*100,2),pnl=roundEven((q.bid-p.entry)*qty*100,2);
    s.cash=roundEven(s.cash+proceeds,2);s.realized=roundEven(s.realized+pnl,2);p.realized=roundEven(p.realized+pnl,2);
    p.qty-=qty;p.runner=Boolean(p.qty);
    s.fills.push({side:'SELL',minute:s.minute,contract:p.id,qty,price:q.bid,pnl});
    this.event(p.qty===0?'close':'partial',note||(forced?'Session-close liquidation.':`Sold ${qty} at the bid.`),{contract:p.id,qty,price:q.bid,pnl,remaining:p.qty});
    if(p.qty===0){if(p.stop_alert!=null)this.check('Closed by the next step after stop alert',s.minute<=p.stop_alert+5);s.position=null;}
  }
  observe_stop(){
    const p=this.s.position;if(!p||p.stop_alert!=null)return;
    const q=this.day.quote(p.id,this.s.minute);
    if(q&&q.bid<=p.entry*(1-this.s.plan.stop/100)){
      p.stop_alert=this.s.minute;
      this.event('stop_alert','Your premium stop is breached at this decision snapshot. Exit by the next step to follow your plan.');
    }
  }
  observe_profit(){
    const p=this.s.position;if(!p||this.s.minute>=390)return;
    const q=this.day.quote(p.id,this.s.minute);if(!q||this.available(p.id,'bid')<1)return;
    const flags=p.profit_flags??=[],reached=[];let target=(flags.at(-1)?.percent??0)+25;
    while(q.bid+1e-10>=p.entry*(1+target/100)){flags.push({percent:target,minute:this.s.minute,status:'due'});reached.push(target);target+=25;}
    if(reached.length)this.event('profit_target',reached.map(v=>`+${v}%`).join(' / ')+' reached. Take some profit before advancing.',{targets:reached,contract:p.id});
  }
  miss_profit(){
    for(const flag of this.s.position?.profit_flags??[])if(flag.status==='due'){
      flag.status='missed';this.check(`Took profit at +${flag.percent}% before advancing`,false);
      this.event('profit_missed',`+${flag.percent}% passed without taking profit.`,{target:flag.percent,contract:this.s.position.id});
    }
  }
  observe_gate(){if(this.s.clock_version>=2&&this.day.trend_gate(this.s.minute)===this.s.minute)this.event('gate','Intraday trend gate passed.');}
  advance(note=''){
    this.miss_profit();this.event('wait',note||(this.s.position?'Held the position.':'Stayed flat.'));
    this.s.minute=Math.min(390,this.s.minute+5);this.observe_gate();this.observe_stop();this.observe_profit();
    if(this.s.minute===390)this.finish();
  }
  finish(){
    while(this.s.minute<390){this.miss_profit();this.s.minute+=5;this.observe_gate();this.observe_stop();this.observe_profit();}
    this.miss_profit();const p=this.s.position;
    if(p){
      const qty=Math.min(p.qty,this.available(p.id,'bid'));if(qty)this.sell(qty,'',true);
      if(this.s.position){
        this.check('Position fully closed by session end',false);
        if(this.s.position.stop_alert!=null)this.check('Closed by the next step after stop alert',false);
        this.event('unknown','Some exposure could not be closed with the available close quote/depth. Final P&L is unresolved.');
      }
    }
    this.s.finished=true;this.event('finish','Session complete.');
  }
  act(a){
    if(this.s.finished)throw Error('This session is complete. Deal a new day.');
    switch(a.action){
      case 'layers':{
        const next=Object.fromEntries(LAYERS.map(k=>[k,Boolean(a.layers?.[k])]));
        if(LAYERS.some(k=>next[k]!==this.s.layers[k])){this.s.layers=next;this.s.layer_history.push({minute:this.s.minute,layers:clone(next)});this.event('layers','Changed visible information.');}break;
      }
      case 'buy':this.buy(a.contract,a.qty,a.note??'');break;
      case 'sell':this.sell(a.qty,a.note??'');break;
      case 'advance':this.advance(a.note??'');break;
      case 'finish':this.finish();break;
      case 'note':this.event('note',a.note??'');break;
      default:throw Error('Unknown action');
    }
  }
  view(){
    const s=this.s,d=this.day,l=s.layers;
    const bars=clone(d.bars.filter(b=>b.minute<=s.minute));
    for(const b of bars)for(const [key,on] of [['vwap',l.vwap],['ema8',l.ema],['ema21',l.ema],['volume',l.volume]])if(!on)delete b[key];
    const contracts=d.menu.filter(c=>(c.listed_minute??0)<=s.minute).map(c=>({...c,quote:d.quote(c.id,s.minute),ask_available:this.available(c.id,'ask'),bid_available:this.available(c.id,'bid')}));
    const position=clone(s.position);let unrealized=0;
    if(position){
      const q=d.quote(position.id,s.minute),depth=this.available(position.id,'bid');
      unrealized=q&&depth>=position.qty?roundEven((q.bid-position.entry)*100*position.qty,2):null;
      Object.assign(position,{quote:q,unrealized,bid_available:depth,premium_return:q?q.bid/position.entry-1:null});
    }
    const forecasts=d.forecasts.filter(f=>f.horizon<=s.minute).map(f=>({horizon:f.horizon,probability:f.probability}));
    const screens=SCREENS.map(([key,name,score])=>({name,passed:Boolean(d.meta[key]),value:l.detector?d.meta[score]:null,threshold:l.detector?d.meta[key+'_threshold']??null:null}));
    const signals=d.signals(s.minute);
    if(!l.vwap)for(const k of ['retest','cross','vwap_side'])signals[k]=null;if(!l.ema)signals.ema=null;
    const checks=s.finished?s.checks:s.checks.filter(c=>(!c.name.includes('VWAP')||l.vwap)&&(!c.name.includes('EMA')||l.ema));
    const total=unrealized==null||(s.finished&&position)?null:roundEven(s.realized+unrealized,2),gate=d.trend_gate(s.minute);
    return {id:s.id,menu_version:s.menu_version??1,clock_version:s.clock_version,profit_version:s.profit_version,symbol:d.meta.symbol,date:d.meta.date,minute:s.minute,start:s.replay_start??d.meta.start,
      gate_passed:gate!=null,gate_minute:gate,spot:s.minute===0?d.meta.session_open??null:bars.at(-1)?.close??null,
      finished:s.finished,bars,contracts,position,signals,layers:l,plan:s.plan,cash:s.cash,realized:s.realized,unrealized,total,entries:s.entries,screens,
      probability:(l.detector||l.model)?forecasts.at(-1)?.probability??null:null,probability_minute:(l.detector||l.model)?forecasts.at(-1)?.horizon??null:null,
      forecasts:l.model?forecasts:[],forecast_end:45,levels:l.levels?Object.fromEntries(['previous_close','premarket_high','premarket_low'].map(k=>[k,d.meta[k]])):{},
      checks,score:checks.length?roundEven(100*checks.filter(c=>c.passed).length/checks.length):null,events:s.events,fills:s.fills,repeated:s.repeated};
  }
  summary(){
    const v=this.view(),s=this.s,patterns=new Set(s.events.filter(e=>['start','layers','buy','partial','close','wait'].includes(e.kind)).map(e=>JSON.stringify(LAYERS.map(k=>e.layers[k]??(k==='model'?(e.layers.detector??false):false)))));
    const info=patterns.size>1?'Mixed layers':LAYERS.filter(k=>s.layers[k]).map(k=>k==='ema'?'EMA':k[0].toUpperCase()+k.slice(1)).join(', ')||'Price only';
    return {id:s.id,menu_version:s.menu_version??1,clock_version:s.clock_version,profit_version:s.profit_version,case_id:s.case_id,date:v.date,symbol:v.symbol,finished:v.finished,pnl:v.total,realized:v.realized,score:v.score,entries:v.entries,info,repeated:v.repeated,created_at:s.created_at};
  }
}
