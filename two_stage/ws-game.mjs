import {Game,DEFAULT_LAYERS} from './engine.mjs';
import {exitSignal} from './reclaim.mjs';
import {entryGate,automaticReference} from './ws-replay.mjs';
import {makeBook,observeBook,openQty,placeDue,queueReplacement,cancelGroup,sellGroup,ruleDescription} from './ws-orders.mjs';
const clone=structuredClone;
const time=m=>`${String(Math.floor((570+m)/60)).padStart(2,'0')}:${String((570+m)%60).padStart(2,'0')}`;
export class WealthsimpleGame extends Game {
  constructor(day,options={}){
    const setup=day.setups.find(s=>s.id===(options.saved?.setup_id??options.setup_id??day.default_setup));
    if(!setup)throw Error('Unknown Wealthsimple preset.');
    super(day,{...options,layers:options.layers??{...DEFAULT_LAYERS,levels:true,model:false},plan:{entry:'discretionary',risk:1,stop:setup.exit.stop,trades:1}});
    this.setup=setup;
    if(!options.saved){
      const quantity=options.quantity??5,delay=options.delay??0;
      if(![2,5,10].includes(quantity)||!Number.isInteger(delay)||delay<0||delay>5)throw Error('Choose 2, 5 or 10 contracts and 0–5 extra minutes.');
      Object.assign(this.s,{engine_version:2,ws_version:1,setup_id:setup.id,profit_version:0,ws:{quantity,delay,anchor:null,base_status:null,book:null,cursor:0,actual_delay:null}});
      this.s.layers.model=false;this.s.events[0].note='Wealthsimple practice. Place and change orders yourself; standing fills use observed quotes.';this.observeSignals();
    }
  }
  get rule(){return this.setup.rules[this.s.ws.quantity];}
  available(id){return this.day.quote(id,this.s.minute)?1000:0;}
  use_depth(){}
  observe_profit(){}
  observe_stop(){}
  entryContext(){
    const m=this.s.minute,w=this.s.ws,signal=this.day.setupAt(this.setup,m),planned=signal.entry_minute;
    const contract=planned!=null&&m>=planned?this.day.contractAt(planned):null;
    const base_status=contract?entryGate(this.day.quote(contract.id,planned)):planned!=null&&m>=planned?'entry_gap':null;
    const quote=contract?this.day.quote(contract.id,m):null,gate=contract?entryGate(quote):null;
    const can_buy=!this.s.entries&&planned!=null&&m>=planned&&m<=planned+5&&base_status==='entered'&&gate==='entered';
    return {signal,planned,practice_entry:planned==null?null:planned+w.delay,contract,base_status,gate,can_buy,late:planned==null?null:m-planned};
  }
  observeSignals(){
    for(const setup of this.day.setups){
      const a=this.day.setupAt(setup,this.s.minute);
      if(['alert','ready','veto','cash'].includes(a.status)&&!this.s.events.some(e=>e.kind==='policy'&&e.policy_id===setup.id&&e.status===a.status))this.event('policy',`${setup.name}: ${a.status}${a.entry_minute!=null?' · planned buy '+time(a.entry_minute):''}`,{policy_id:setup.id,status:a.status});
    }
    const c=this.entryContext();if(c.contract&&!this.s.ws.anchor){this.s.ws.anchor=clone(c.contract);this.s.ws.base_status=c.base_status;}
  }
  buy(id,qty){
    const s=this.s,c=this.entryContext(),q=this.day.quote(id,s.minute);
    if(s.position||s.entries)throw Error('This preset allows one entry.');
    if(!c.can_buy||id!==c.contract?.id)throw Error('Use the contract selected at the planned buy, within its 0–5 minute entry window.');
    if(qty!==s.ws.quantity)throw Error('Use the exact quantity selected for this preset.');
    const cost=q.ask*qty*100;if(cost>s.cash)throw Error('Insufficient practice cash.');
    s.ws.anchor=clone(c.contract);s.cash-=cost;s.entries++;s.ws.actual_delay=s.minute-c.planned;s.ws.book=makeBook(this.rule,q.ask,s.minute);s.ws.cursor=0;
    s.position={...clone(c.contract),entry:q.ask,entry_minute:s.minute,qty,initial_qty:qty,realized:0,stop_alert:null,runner:false,profit_flags:[],target_plan:[]};
    s.fills.push({side:'BUY',minute:s.minute,contract:id,qty,price:q.ask,pnl:0,native:false});
    this.check('Bought at the chosen extra-delay clock',s.ws.actual_delay===s.ws.delay);this.event('buy',`Bought ${qty} at ask; +${s.ws.actual_delay}m after planned entry.`,{contract:id,qty,price:q.ask});
  }
  ownSignal(){const p=this.s.position,b=this.s.ws.book;return b&&this.rule.veto?exitSignal(this.day.bars,p?.right??this.s.ws.anchor.right,b.entry_minute,this.s.minute,this.day.deadline):null;}
  syncBook(){
    const s=this.s,b=s.ws.book;if(!b)return;
    for(const e of b.events.slice(s.ws.cursor)){
      if(e.action==='sell'){
        const pnl=(e.price-b.entry)*e.qty*100;s.cash+=e.price*e.qty*100;s.realized+=pnl;if(s.position)s.position.realized+=pnl;
        s.fills.push({side:'SELL',minute:e.minute,contract:s.ws.anchor.id,qty:e.qty,price:e.price,pnl,reason:e.reason,group:e.group,native:!['manual','deadline'].includes(e.reason)});
        this.event('order_fill',`${e.qty} sold · ${e.reason.replaceAll('_',' ')} @ $${e.price.toFixed(4)}.`,{qty:e.qty,price:e.price,pnl,group:e.group});
      }else {
        const note=e.action==='place'?`Placed ${e.qty} ${e.rule} order(s).`:e.action==='replace'?`${e.qty} order(s) now ${e.rule}.`:e.action==='request'?`Replacement submitted; effective ${time(e.due)}. Old orders remain active.`:e.action==='trigger_stop_limit'?`Stop-limit triggered for ${e.qty}; limit $${e.limit.toFixed(4)} remains live until filled or changed.`:e.action==='signal'?`Action needed: ${e.reason} → ${e.rule} protection.`:'Missing required quote. Open exposure is unresolved.';
        this.event(e.action==='gap'?'unknown':'order',note,{order_action:e.action,group:e.group});
      }
    }
    s.ws.cursor=b.events.length;if(s.position){s.position.qty=openQty(b);if(!s.position.qty)s.position=null;}
  }
  observeOrders(){
    const b=this.s.ws.book;if(!b||!this.s.position)return;
    observeBook(b,this.s.minute,this.day.quote(this.s.position.id,this.s.minute),this.ownSignal()?.decision_minute,this.day.deadline);this.syncBook();
    for(const g of b.groups)if(g.qty&&!g.placed&&!g.pending&&g.activation<=this.s.minute&&!this.s.events.some(e=>e.kind==='place_due'&&e.group===g.id))this.event('place_due',`Place ${g.qty} initial ${g.role<2?'target':'stop-limit'} order(s) now.`,{group:g.id});
    if(this.s.position&&this.s.minute===this.day.deadline&&!this.s.events.some(e=>e.kind==='deadline'))this.event('deadline','15:00 close: cancel outstanding orders and sell the remaining position.');
  }
  nextMinute(){
    const m=this.s.minute,c=this.entryContext(),b=this.s.ws.book,times=[Math.min(this.day.deadline,(Math.floor(m/5)+1)*5)];
    if(c.planned!=null&&!this.s.entries){times.push(c.planned,c.practice_entry);if(m>=c.planned&&m<c.planned+5)times.push(m+1);}
    for(const g of b?.groups??[])if(g.qty){if(!g.placed)times.push(g.activation);if(g.pending)times.push(g.pending.due);}
    return Math.min(...times.filter(t=>t>m),this.day.deadline);
  }
  advance(){
    const s=this.s;if(s.ws.book?.gap!=null)throw Error('Quote history is missing. Finish to review the unresolved exposure.');
    if(s.minute>=this.day.deadline)throw Error('The replay is at its close. Liquidate or finish this day.');
    const book=s.ws.book;
    for(const g of book?.groups??[])if(g.qty&&!g.placed&&!g.pending&&g.activation<=s.minute&&!s.checks.some(c=>c.order_group===g.id&&c.missed_initial)){this.check('Missed initial order placement for G'+(g.id+1),false);Object.assign(s.checks.at(-1),{order_group:g.id,missed_initial:true});}
    if(book?.cue&&!s.checks.some(c=>c.missed_cue===book.cue.minute)){this.check('Replacement response was late',false);s.checks.at(-1).missed_cue=book.cue.minute;}
    const end=this.nextMinute();this.event('wait',s.position?'Held the position.':'Stayed flat.');
    while(s.minute<end){s.minute++;const start=s.events.length;this.observeSignals();this.observeOrders();if(s.events.slice(start).some(e=>['policy','place_due','order_fill','unknown','deadline'].includes(e.kind)||e.kind==='order'&&['signal','trigger_stop_limit','replace'].includes(e.order_action)))break;}
  }
  sell(qty,note='',forced=false,group=null){
    const s=this.s,p=s.position,b=s.ws.book;if(!p)throw Error('No open position.');if(b.gap!=null)throw Error('Missing quote history. No fill is invented.');
    const q=this.day.quote(p.id,s.minute);if(!q)throw Error('No usable bid now.');
    if(!Number.isInteger(qty)||qty<1||qty>p.qty)throw Error('Choose a valid whole-contract quantity.');
    if(group==null&&qty!==p.qty)throw Error('Select an order group for a partial exit.');
    const groups=group==null?b.groups.filter(g=>g.qty):b.groups.filter(g=>g.id===group&&g.qty);if(group!=null&&(!groups.length||qty>groups[0].qty))throw Error('Quantity exceeds the selected group.');
    let left=qty;for(const g of groups){const amount=Math.min(g.qty,left);sellGroup(b,g,amount,q.bid,s.minute,forced?'deadline':'manual');left-=amount;if(!left)break;}
    this.syncBook();if(!forced)this.check('Manual exit recorded separately from standing orders',true);
  }
  finish(){
    while(this.s.minute<this.day.deadline&&this.s.ws.book?.gap==null)this.advance();
    if(this.s.position&&this.s.ws.book.gap==null)this.sell(this.s.position.qty,'',true);
    if(this.s.position)this.check('All exposure resolved',false);
    if(!this.s.entries)this.check('Stayed in cash only without a valid entry',!['entered'].includes(this.entryContext().base_status));
    this.s.finished=true;this.event('finish','Practice complete. Reference results are now revealed.');
  }
  act(a){
    if(!a.action.startsWith('ws_'))return super.act(a);
    const s=this.s,b=s.ws.book;if(s.finished||!s.position||b.gap!=null||s.minute>=this.day.deadline&&a.action!=='ws_sell')throw Error('Order changes are unavailable; close or review the position.');
    if(a.action==='ws_place'){
      const before=b.events.length;placeDue(b,s.minute,a.group??null);
      const placements=b.events.slice(before);this.check('Initial orders placed on schedule',placements.every(e=>b.groups.find(g=>g.id===e.group).activation===s.minute));this.observeOrders();
    }else if(a.action==='ws_replace'){
      this.check('Replacement submitted when requested',b.cue?.minute===s.minute);queueReplacement(b,s.minute);this.syncBook();
    }else if(a.action==='ws_cancel'){cancelGroup(b,a.group,s.minute);this.syncBook();}
    else if(a.action==='ws_sell')this.sell(a.qty,'',false,a.group);
    else throw Error('Unknown order action.');
  }
  view(){
    const v=super.view(),s=this.s,c=this.entryContext(),b=s.ws.book,own=this.ownSignal();
    const unrealized=b?.gap!=null&&s.position?null:v.unrealized;
    const ws={quantity:s.ws.quantity,delay:s.ws.delay,actual_delay:s.ws.actual_delay,entry:clone(c),rule:clone(this.rule),book:clone(b),own_vwap:own,deadline_due:!!s.position&&s.minute===this.day.deadline};
    const cards=this.day.setups.map(setup=>{
      const sig=this.day.setupAt(setup,s.minute),selected=setup.id===this.setup.id;
      let status=sig.status,label={alert:'Entry queued',ready:'Planned buy now',missed:'Entry passed',cash:'No entry',veto:'Vetoed · skip',waiting:'Waiting'}[status]??status;
      let detail=sig.origin?`Forecast ${time(sig.alert_minute)} · planned ${sig.entry_minute==null?'vetoed':time(sig.entry_minute)}`:'Waiting for a qualifying alert';
      if(setup.ws_code==='P09'&&sig.origin)detail+=sig.vwap_checked?(sig.status==='veto'?' · opposing VWAP event':' · entry veto clear'):' · VWAP check '+time(sig.cutoff);
      if(selected&&s.position){status=b.gap!=null?'gap':b.cue?'alert':'position';label=b.gap!=null?'Data gap':b.cue?'Replace orders':ws.deadline_due?'Close now':'Managing orders';detail=ruleDescription(this.rule);}
      else if(selected&&s.entries){label='Position closed';detail='Continue observing or finish the day.';}
      else if(selected&&c.can_buy){status='ready';label=s.minute<c.practice_entry?'Delay practice':s.minute===c.practice_entry?'Buy now':'Late entry';detail=`${s.ws.quantity} contracts · practice ${time(c.practice_entry)} · ${s.minute-c.planned}m after planned buy`;}
      return {id:setup.id,name:setup.name,selected,status,label,detail};
    });
    return {...v,engine_version:2,ws,setup_id:this.setup.id,setup:clone(this.setup),setup_signal:c.signal,policy_cards:cards,trend_exit:null,stop_rule:null,watchlist:{rank:this.day.meta.rank,side:this.day.meta.morning_side,name:this.day.meta.watchlist},screens:[],forecasts:[],deadline:this.day.deadline,next_minute:s.finished||s.minute===this.day.deadline?null:this.nextMinute(),ema_fast:9,spot:this.day.spot(s.minute),unrealized,total:unrealized==null?null:s.realized+unrealized,
      ...(s.finished?{ws_reference:automaticReference(this.day,this.setup,s.ws.quantity,s.ws.actual_delay??s.ws.delay)}:{})};
  }
  summary(){return {...super.summary(),engine_version:2,setup_id:this.setup.id,setup_name:this.setup.name+` · ${this.s.ws.quantity} contracts · +${this.s.ws.delay}m`,ws_version:1};}
}
