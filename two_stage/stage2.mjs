import {Day,Game,DEFAULT_LAYERS} from './engine.mjs';
import {entryVeto,exitSignal,exitPriority} from './reclaim.mjs';
import {unionAt,peerAt,stopRule,policyCard} from './policies.mjs';
const clone=v=>structuredClone(v);
const valid=v=>Number.isFinite(v);
export class StageDay extends Day {
  constructor(data,manifest){super(data);this.data=data;this.setups=manifest.setups;this.default_setup=manifest.default_setup;this.deadline=data.deadline;this.underlying=data.underlying;this.roster=data.policy_signals?.version===1;}
  quote(cid,minute){const q=this.quotes.get(`${cid}@${minute}`);return q&&valid(q.bid)&&valid(q.ask)&&q.bid>0&&q.ask>=q.bid?q:null;}
  trend_gate(){return null;}
  spot(minute){return minute===0?this.meta.session_open:this.underlying[minute-1]?.close??null;}
  contractAt(minute){
    const spot=this.spot(minute);if(!valid(spot))return null;
    const strike=[...this.data.selection_strikes].sort((a,b)=>Math.abs(a-spot)-Math.abs(b-spot)||a-b)[0];
    return this.menu.find(c=>c.expiration===this.data.expiration&&c.strike===strike&&c.right===this.meta.morning_side&&(c.listed_minute??0)<=minute)??null;
  }
  setupAt(setup,minute){
    if(setup.entry.kind==='union')return unionAt(this.data.policy_signals.union,minute);
    if(setup.peer_rule){
      const peer=peerAt(this.meta.symbol,this.meta.morning_side,this.data.policy_signals.spy_premarket);
      if(peer.status)return peer;
      return {...this.parentSetupAt(setup,minute),peer:peer.peer};
    }
    const signal=this.parentSetupAt(setup,minute);
    if(setup.overlay==='entry_vwap_5m_2'&&signal.entry_minute!=null&&minute>=signal.entry_minute){
      const veto=entryVeto(this.bars,this.meta.morning_side,signal.entry_minute,minute);
      return {...signal,status:veto.veto?'veto':signal.status,entry_veto:veto};
    }
    return signal;
  }
  parentSetupAt(setup,minute){
    const e=setup.entry,anchor=e.anchor,width=e.window;
    const result=(status,known_at,entry_minute=null,extra={})=>({status,known_at,entry_minute,...extra});
    const triggered=(entry,alert,extra={})=>result(minute<entry?'alert':minute===entry?'ready':'missed',alert,entry,extra);
    if(e.kind==='clock')return minute<anchor?result('scheduled',0,anchor):triggered(anchor,anchor);
    if(minute<anchor)return result('waiting',0);
    const sign=this.meta.morning_side==='CALL'?1:-1;
    let reference,monitor=null;
    if(e.monitor==='stock')reference=this.underlying[anchor-1]?.close;
    else {
      monitor=this.contractAt(anchor);const q=monitor?this.quote(monitor.id,anchor):null;
      reference=q?(q.bid+q.ask)/2:null;
    }
    const extra={reference:valid(reference)?reference:null,monitor:monitor?{...monitor}:null};
    if(!valid(reference))return result('gap',anchor,null,extra);
    let adverseSeen=false;
    for(let end=anchor+width;end<=Math.min(minute,anchor+30);end+=width){
      const start=end-width;let adverse,reclaimed;
      if(e.monitor==='stock'){
        const block=this.underlying.slice(start,end);
        if(block.length!==width||block.some(b=>!valid(b.open)||!valid(b.close)))return result('gap',end,null,extra);
        const close=block.at(-1).close;adverse=sign*(close-block[0].open)<0;reclaimed=sign*(close-reference)>=0;
      }else{
        const samples=Array.from({length:width+1},(_,i)=>this.quote(monitor.id,start+i));
        if(samples.some(q=>!q))return result('gap',end,null,extra);
        const mids=samples.map(q=>(q.bid+q.ask)/2);adverse=mids.at(-1)<mids[0];reclaimed=mids.at(-1)>=reference;
      }
      if(e.kind==='adverse'?adverse:adverseSeen&&reclaimed)return triggered(end+1,end,extra);
      adverseSeen||=adverse;
    }
    return result(minute>=anchor+30?'cash':'watching',Math.min(minute,anchor+30),null,{...extra,adverse_seen:adverseSeen,
      ...(this.roster?{window_start:anchor+Math.floor((minute-anchor)/width)*width,window_end:Math.min(anchor+30,anchor+(Math.floor((minute-anchor)/width)+1)*width)}:{})});
  }
}
export class StageGame extends Game {
  constructor(day,options={}){
    const id=options.saved?.setup_id??options.setup_id??day.default_setup;
    const setup=day.setups.find(x=>x.id===id);if(!setup)throw Error('This setup is not in the replay pack.');
    super(day,{...options,layers:{...(options.layers??DEFAULT_LAYERS),model:false},plan:{entry:'discretionary',risk:Math.min(10,Math.max(1,Math.ceil(setup.budget*setup.exit.stop/20000))),stop:setup.exit.stop,trades:setup.max_entries}});
    this.setup=setup;
    if(!options.saved){this.s.engine_version=2;this.s.setup_id=id;this.s.layers.model=false;this.s.events[0].note='Market open. Follow the setup in this replay pack.';}
    if(day.roster&&!options.saved)this.observe_gate();
  }
  available(cid){return this.day.quote(cid,this.s.minute)?1000:0;}
  use_depth(){}
  nextMinute(){
    if(this.day.roster){
      const m=this.s.minute,times=[this.day.deadline,(Math.floor(m/5)+1)*5];
      for(const setup of this.day.setups){
        const signal=this.day.setupAt(setup,m),e=setup.entry;
        if(['cash','gap','veto','not_applicable','missed'].includes(signal.status))continue;
        if(signal.entry_minute>m)times.push(signal.entry_minute);
        if(signal.cutoff>m)times.push(signal.cutoff);
        if(e.kind==='union')times.push(0,5,10,15,20);
        else if(e.kind!=='clock'){times.push(e.anchor);for(let end=e.anchor+e.window;end<=e.anchor+30;end+=e.window)times.push(end);}
      }
      if(this.s.position)times.push(stopRule(this.s.position,this.setup,m).activation);
      const trend=this.trendExit();if(trend?.execution_minute>m)times.push(trend.execution_minute);
      return Math.min(...times.filter(t=>t>m));
    }
    const s=this.s,e=this.setup.entry,seen=this.day.setupAt(this.setup,s.minute);
    const times=[this.day.deadline,(Math.floor(s.minute/5)+1)*5];
    if(seen.entry_minute>s.minute)times.push(seen.entry_minute);
    if(!['ready','missed','cash','gap','veto'].includes(seen.status)&&e.kind!=='clock'){
      times.push(e.anchor);
      for(let end=e.anchor+e.window;end<=e.anchor+30;end+=e.window)times.push(end);
    }
    if(s.position)times.push(s.position.entry_minute+Math.max(1,this.setup.exit.grace));
    const trend=this.trendExit();if(trend?.execution_minute>s.minute)times.push(trend.execution_minute);
    return Math.min(...times.filter(t=>t>s.minute));
  }
  buy(cid,qty,note=''){
    if(this.s.minute>=this.day.deadline)throw Error('This setup has reached its close.');
    const start=this.s.checks.length;super.buy(cid,qty,note);this.s.checks.splice(start);
    const p=this.s.position,q=this.day.quote(cid,this.s.minute),signal=this.day.setupAt(this.setup,this.s.minute),x=this.setup.exit;
    this.check('Entry matched the setup clock',signal.status==='ready');
    this.check('Entry matched the morning direction',p.right===this.day.meta.morning_side);
    this.check('Entry within setup capital and contract limits',p.entry*qty*100<=this.setup.budget+.001&&qty<=this.setup.max_contracts);
    this.check('Entry quote met the setup premium and spread rule',q.ask>=.5&&(q.ask-q.bid)/((q.ask+q.bid)/2)<=.15+1e-10);
    this.check('One entry for this setup',this.s.entries<=this.setup.max_entries);
    if(this.day.roster)this.check('Selected the causal ATM contract',cid===this.day.contractAt(this.s.minute)?.id);
    if(this.setup.overlay==='entry_vwap_5m_2')this.check('Respected the VWAP entry veto',signal.status!=='veto');
    const first=x.family==='full'||qty===1?qty:Math.min(qty-1,Math.max(1,Math.floor(qty*x.fraction+.5)));
    p.target_plan=[{percent:x.first,qty:first},...(qty>first?[{percent:x.second,qty:qty-first}]:[])];
  }
  observe_stop(){
    const p=this.s.position;if(!p||p.stop_alert!=null||this.s.minute<p.entry_minute+Math.max(1,this.setup.exit.grace))return;
    if(this.day.roster){
      const q=this.day.quote(p.id,this.s.minute),stop=stopRule(p,this.setup,this.s.minute);
      if(q&&stop.active&&q.bid<=stop.price){p.stop_alert=this.s.minute;this.event('stop_alert',`${stop.breakeven?'Breakeven runner':'Premium'} stop reached. Exit the remaining contracts now.`);}
      return;
    }
    super.observe_stop();
  }
  observe_profit(){
    const p=this.s.position;if(!p||this.s.minute<=p.entry_minute||this.s.minute>=this.day.deadline)return;
    const q=this.day.quote(p.id,this.s.minute);if(!q)return;
    for(const t of p.target_plan){
      if(!p.profit_flags.some(f=>f.percent===t.percent)&&q.bid+1e-10>=p.entry*(1+t.percent/100)){
        p.profit_flags.push({percent:t.percent,minute:this.s.minute,status:'due',required_qty:t.qty,taken_qty:0});
        this.event('profit_target',`+${t.percent}% reached. Take ${Math.min(t.qty,p.qty)} contract(s) before advancing.`,{targets:[t.percent],contract:p.id});
      }
    }
  }
  sell(qty,note='',forced=false){
    const p=this.s.position;if(!p)return super.sell(qty,note,forced);
    const trend=this.trendExit();
    const flags=p.profit_flags;p.profit_flags=[];
    try{super.sell(qty,note,forced);}finally{p.profit_flags=flags;}
    if(!forced&&!p.qty&&trend?.status==='due'&&trend.priority==='trend_exit'){
      this.check('Closed on the scheduled VWAP exit',true);this.event('trend_exit','Closed the remaining contracts on the VWAP exit.');
    }
    if(forced)return;
    const q=this.day.quote(p.id,this.s.minute);let remaining=qty;
    for(const f of flags){
      if(!['due','missed'].includes(f.status)||q.bid+1e-10<p.entry*(1+f.percent/100))continue;
      const used=Math.min(remaining,f.required_qty-f.taken_qty);remaining-=used;f.taken_qty+=used;
      if(f.taken_qty>=f.required_qty){
        const onTime=f.status==='due';f.status=onTime?'taken':'late';f.taken_minute=this.s.minute;f.qty=f.taken_qty;
        if(onTime)this.check(`Took planned profit at +${f.percent}% before advancing`,true);
        this.event('profit_taken',`+${f.percent}% planned quantity sold${onTime?'':' late'}.`,{target:f.percent,qty:f.qty});
      }
    }
    if(!p.qty)for(const f of flags)if(f.status==='due'){
      f.status='missed';this.check(`Took planned quantity at +${f.percent}%`,false);
      this.event('profit_missed',`Closed before taking the planned +${f.percent}% quantity.`);
    }
  }
  observe_gate(){
    if(this.day.roster){
      for(const setup of this.day.setups){
        const signal=this.day.setupAt(setup,this.s.minute);
        if(!['alert','ready','cash','gap','veto'].includes(signal.status)||this.s.events.some(e=>e.kind==='policy'&&e.policy_id===setup.id&&e.status===signal.status))continue;
        const card=policyCard(setup,signal,this);
        this.event('policy',`${setup.name}: ${card.label}. ${card.detail}`,{policy_id:setup.id,status:signal.status,entry_minute:signal.entry_minute});
      }
      return;
    }
    const now=this.day.setupAt(this.setup,this.s.minute);
    if(['alert','ready','cash','gap','veto'].includes(now.status)&&!this.s.events.some(e=>e.kind==='setup'&&e.status===now.status))this.event('setup',({alert:'Setup triggered; prepare for the announced entry.',ready:'Setup entry is now.',cash:'No setup trigger. Stay in cash.',gap:'Setup inputs are missing. No signal is invented.',veto:'Two completed 5-minute own-VWAP conflicts. Entry vetoed for this day; stay in cash.'})[now.status],{status:now.status});
    if(now.entry_veto?.available===false&&!this.s.events.some(e=>e.kind==='vwap_unavailable'))this.event('vwap_unavailable','VWAP entry check unavailable. Follow the original reclaim setup.');
  }
  trendExit(){
    const p=this.s.position;if(!p||this.setup.overlay!=='exit_vwap_5m_2')return null;
    const signal=exitSignal(this.day.bars,p.right,p.entry_minute,this.s.minute,this.day.deadline);
    return {...signal,priority:signal.execution_minute!=null&&this.s.minute>=signal.execution_minute?exitPriority(p,this.day.quote(p.id,this.s.minute),this.s.minute,this.setup,this.day.deadline):null};
  }
  observe_trend(){
    const t=this.trendExit(),p=this.s.position;
    if(t?.status==='alert'&&!this.s.events.some(e=>e.kind==='trend_signal'&&e.entry_minute===p.entry_minute))this.event('trend_signal','Two fully post-entry 5-minute closes oppose the trade. Exit remaining contracts one minute later.',{entry_minute:p.entry_minute,execution_minute:t.execution_minute});
  }
  miss_trend(){
    const t=this.trendExit();
    if(t?.status==='due'&&t.priority==='trend_exit'){
      this.check('Closed on the scheduled VWAP exit',false);this.event('trend_missed','Scheduled VWAP exit passed with contracts still open.');
    }else if(t?.status==='due'&&t.priority==='missing_quote')this.event('unknown','No usable bid at the scheduled VWAP exit. No price is invented.');
  }
  advance(note=''){
    if(this.day.roster){this.walk(note);if(this.s.minute>=this.day.deadline)this.finish();return;}
    this.miss_trend();this.miss_profit();this.event('wait',note||(this.s.position?'Held the position.':'Stayed flat.'));
    this.s.minute=this.nextMinute();this.observe_gate();this.observe_stop();this.observe_profit();this.observe_trend();
    if(this.s.minute>=this.day.deadline)this.finish();
  }
  finish(){
    if(this.day.roster)while(this.s.minute<this.day.deadline)this.walk();
    while(this.s.minute<this.day.deadline){this.miss_trend();this.miss_profit();this.s.minute=this.nextMinute();this.observe_gate();this.observe_stop();this.observe_profit();this.observe_trend();}
    this.miss_profit();
    if(this.s.position){
      if(this.day.quote(this.s.position.id,this.s.minute))this.sell(this.s.position.qty,'Setup-close liquidation.',true);
      else{this.check('Position fully closed by setup close',false);this.event('unknown','Missing close price. Final P&L is unresolved.');}
    }
    if(this.s.entries===0){const signal=this.day.setupAt(this.setup,this.s.minute);if(['cash','veto','not_applicable'].includes(signal.status))this.check(signal.status==='veto'?(this.day.roster?'Respected the entry veto':'Respected the VWAP entry veto'):'Stayed in cash without an entry signal',true);else if(signal.status==='missed')this.check('Acted on the setup entry',false);}
    this.s.finished=true;this.event('finish','Session complete.');
  }
  view(){
    const v=super.view(),minute=this.s.minute,signal=this.day.setupAt(this.setup,minute);
    return {...v,engine_version:2,setup_id:this.setup.id,setup:clone(this.setup),setup_signal:signal,trend_exit:this.trendExit(),
      ...(this.day.roster?{policy_cards:this.day.setups.map(s=>policyCard(s,this.day.setupAt(s,minute),this)),
        stop_rule:this.s.position?stopRule(this.s.position,this.setup,minute):null,
        ...(this.s.finished?{benchmarks:clone(this.day.data.policy_benchmarks.filter(b=>b.setup_id===this.setup.id)),benchmark_note:'Saved automatic reference · capped target fills. Your manual exits use the observed bid.'}:{})}:{}),
      ...(this.s.finished&&this.day.data.benchmarks?{benchmarks:clone(this.day.data.benchmarks.filter(b=>b.setup_id===this.setup.id||b.setup_id==='stock_reclaim'&&this.setup.overlay)),benchmark_note:'Saved historical study · automatic capped targets · sizing shown separately from your manual bid fills.'}:{}),
      watchlist:{rank:this.day.meta.rank,score:this.day.meta.watch_score,side:this.day.meta.morning_side,name:this.day.meta.watchlist},
      deadline:this.day.deadline,next_minute:this.s.finished?null:this.nextMinute(),ema_fast:9,spot:this.day.spot(minute),screens:[],probability:null,probability_minute:null,forecasts:[],
      gate_passed:signal.status==='ready',gate_minute:signal.status==='ready'?minute:null,execution:'excellent_at_observed_bid_ask'};
  }
  walk(note=''){
    // The button announces only the next known checkpoint. Inspect intervening
    // minute observations sequentially and pause when new action becomes known.
    const end=this.nextMinute();this.miss_trend();this.miss_profit();
    if(this.s.position?.stop_alert===this.s.minute)this.check('Exited at the stop observation',false);
    this.event('wait',note||(this.s.position?'Held the position.':'Stayed flat.'));
    while(this.s.minute<end){
      this.s.minute++;const start=this.s.events.length;
      this.observe_gate();this.observe_stop();this.observe_profit();this.observe_trend();
      const p=this.s.position;
      if(p&&!this.day.quote(p.id,this.s.minute)&&!this.s.events.some(e=>e.kind==='unknown'&&e.minute===this.s.minute))this.event('unknown','No usable position quote. No price or fill is invented.');
      if(this.s.events.slice(start).some(e=>['policy','stop_alert','profit_target','trend_signal','unknown'].includes(e.kind)))break;
    }
  }
  summary(){return {...super.summary(),engine_version:2,setup_id:this.setup.id,setup_name:this.setup.name};}
}
export const createDay=(data,manifest)=>data.format_version===2?new StageDay(data,manifest):new Day(data);
export const createGame=(day,options)=>day instanceof StageDay?new StageGame(day,options):new Game(day,options);
