import {createDay,createGame} from './games.mjs';
import {digest,validateDay,validateManifest,validateSaved,packLines} from './pack.mjs';
import {chartEvidence} from './chart-data.mjs';

const scope=new URL('.',location.href).pathname;
export const sessionKey='two-stage-browser:'+scope+':session';
const database=new Promise((resolve,reject)=>{
  const request=indexedDB.open('two-stage-browser-v1:'+scope,1);
  request.onupgradeneeded=()=>{for(const name of ['packs','days','sessions','settings'])request.result.createObjectStore(name,{keyPath:'id'});};
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
  request.onerror=()=>reject(Error('Could not open device storage. Use a regular Safari window.'));
});
async function read(store,key){const db=await database;return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function all(store){const db=await database;return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function put(store,value){const db=await database;return new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error??Error('Could not save. Device storage may be full.'));});}
async function save(record,expected){
  const db=await database;
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['sessions','settings'],'readwrite'),store=tx.objectStore('sessions');let failure;
    const request=store.get(record.id);
    request.onsuccess=()=>{
      const old=request.result;
      if((expected===null&&old)||(expected!==null&&(!old||old.state.events.length!==expected))){failure=Error('This round changed in another tab. Reload to resume it.');tx.abort();return;}
      store.put(record);tx.objectStore('settings').put({id:'last-session',value:record.id});
    };
    tx.oncomplete=resolve;tx.onabort=()=>reject(failure??tx.error??Error('Could not save this action.'));
  });
}
async function active(){const pref=await read('settings','active-pack');return pref?await read('packs',pref.value):null;}
const dayCache=new Map();
async function dayFor(record){
  const key=record.pack_id+':'+record.day_key;
  if(!dayCache.has(key)){
    const row=await read('days',key);if(!row)throw Error('Import the original replay pack to resume this round.');
    const pack=await read('packs',record.pack_id);dayCache.clear();dayCache.set(key,createDay(row.data,pack.manifest));
  }
  return dayCache.get(key);
}
function toRecord(game,pack_id,day_key){return {id:game.s.id,pack_id,day_key,state:game.s,summary:game.summary()};}
function choose(items){const range=2**32,limit=range-range%items.length,a=new Uint32Array(1);do{crypto.getRandomValues(a);}while(a[0]>=limit);return items[a[0]%items.length];}
export async function localAPI(path,params){
  const url=new URL(path,'https://local.invalid');
  if(url.pathname==='/api/info'){
    const pack=await active(),sessions=await all('sessions');
    return {cases:pack?.manifest.cases.length??0,pack:pack?.manifest??null,packs:(await all('packs')).map(p=>({id:p.id,name:p.manifest.name,cases:p.manifest.cases.length})),history:sessions.map(s=>s.summary).sort((a,b)=>b.created_at.localeCompare(a.created_at))};
  }
  if(url.pathname==='/api/pack'){const pack=await read('packs',params.id);if(!pack)throw Error('Replay pack not found.');await put('settings',{id:'active-pack',value:pack.id});return {ok:true};}
  if(url.pathname==='/api/state'||url.pathname==='/api/export'||url.pathname==='/api/chart'){
    const record=await read('sessions',url.searchParams.get('id'));if(!record)throw Error('Saved session not found');
    const game=createGame(await dayFor(record),{saved:record.state});
    if(url.pathname==='/api/chart')return chartEvidence(game,{contract:url.searchParams.get('contract')??'',width:Number(url.searchParams.get('width'))});
    return url.pathname==='/api/state'?game.view():{state:game.view(),summary:game.summary(),pack_id:record.pack_id};
  }
  if(url.pathname==='/api/new'){
    if(params.previous){const previous=await read('sessions',params.previous);if(previous&&!previous.state.finished)throw Error('Finish the current session before dealing another day.');}
    let pack=await active();const original=params.replay_of?await read('sessions',params.replay_of):null;if(original)pack=await read('packs',original.pack_id);if(!pack)throw Error('Import your replay pack first.');
    const history=await all('sessions'),setup=original?.state.setup_id??params.setup_id??pack.manifest.default_setup;
    const used=new Set(history.filter(s=>s.pack_id===pack.id&&(pack.manifest.version!==2||s.state.setup_id===setup)).map(s=>s.state.case_id));
    const fresh=pack.manifest.cases.filter(k=>!used.has(k.split('@')[0]));
    let key=choose(fresh.length?fresh:pack.manifest.cases);
    if(params.replay_of){if(!original?.state.finished)throw Error('Only completed sessions can be replayed.');key=original.state.case_id+(pack.manifest.version===2?'@4':'@3');if(!pack.manifest.cases.includes(key))throw Error('That day is not in this replay pack.');}
    const game=createGame(await dayFor({pack_id:pack.id,day_key:key}),{layers:params.layers,plan:params.plan,setup_id:setup,quantity:params.quantity??original?.state.ws?.quantity,delay:params.delay??original?.state.ws?.delay});game.s.repeated=used.has(game.s.case_id);
    await save(toRecord(game,pack.id,key),null);return game.view();
  }
  if(url.pathname==='/api/action'){
    const record=await read('sessions',params.id);if(!record)throw Error('Saved session not found');
    if(params.revision!==record.state.events.length)throw Error('This round changed in another tab. Reload to resume it.');
    const game=createGame(await dayFor(record),{saved:record.state});game.act(params);
    await save(toRecord(game,record.pack_id,record.day_key),params.revision);return game.view();
  }
  throw Error('Unknown local action');
}
async function withImportLock(fn){return navigator.locks?navigator.locks.request('two-stage-import:'+scope,fn):fn();}
export async function importPack(file,progress=()=>{}){
  return withImportLock(async()=>{
    let manifest,index=0;const received=new Set();
    for await(const line of packLines(file)){
      if(!manifest){manifest=await validateManifest(JSON.parse(line));progress(0,manifest.records.length);continue;}
      const expected=manifest.records[index];if(!expected||await digest(line)!==expected.sha256)throw Error('Replay checksum mismatch. Import was stopped; your previous library is unchanged.');
      const day=validateDay(JSON.parse(line));if((day.format_version===2)!==(manifest.version===2))throw Error('Replay version mismatch.');if(day.key!==expected.key||received.has(day.key))throw Error('Replay record identity mismatch.');
      if(Boolean(day.policy_signals)!==Boolean(manifest.setups?.some(s=>s.entry.kind==='union'||s.execution==='wealthsimple')))throw Error('Replay policy inputs do not match the setup roster.');
      if(Boolean(day.ws_references)!==Boolean(manifest.setups?.some(s=>s.execution==='wealthsimple')))throw Error('Wealthsimple inputs do not match the setup roster.');
      await put('days',{id:manifest.id+':'+day.key,data:day});received.add(day.key);index++;progress(index,manifest.records.length);
    }
    if(!manifest||index!==manifest.records.length)throw Error('Incomplete replay pack. Your previous library is unchanged.');
    const db=await database;
    await new Promise((resolve,reject)=>{const tx=db.transaction(['packs','settings'],'readwrite');tx.objectStore('packs').put({id:manifest.id,manifest});tx.objectStore('settings').put({id:'active-pack',value:manifest.id});tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    // The browser may decline; backups remain the durable recovery path.
    if(navigator.storage?.persist)await navigator.storage.persist().catch(()=>false);
    return manifest;
  });
}
export async function backupProgress(){return {format:'two-stage-progress',version:1,created_at:new Date().toISOString(),sessions:await all('sessions')};}
export async function restoreProgress(file){
  if(file.size>32*1024*1024)throw Error('Progress backup is too large.');
  const backup=JSON.parse(await file.text());if(backup.format!=='two-stage-progress'||backup.version!==1||!Array.isArray(backup.sessions)||backup.sessions.length>10000)throw Error('Select a Two Stage progress backup.');
  const prepared=[],ids=new Set();
  for(const row of backup.sessions){
    validateSaved(row.state);if(row.id!==row.state.id||ids.has(row.id))throw Error('Duplicate saved round.');ids.add(row.id);
    const pack=await read('packs',row.pack_id);if(!pack||!pack.manifest.records.some(r=>r.key===row.day_key))throw Error('Import the matching replay pack before restoring progress.');
    const day=await dayFor(row);validateSaved(row.state,day);
    const game=createGame(day,{saved:row.state});prepared.push(toRecord(game,row.pack_id,row.day_key));
  }
  const db=await database;let added=0,kept=0;
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('sessions','readwrite'),store=tx.objectStore('sessions');
    for(const row of prepared){const req=store.get(row.id);req.onsuccess=()=>{if(req.result){kept++;return;}store.put(row);added++;};}
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });
  return {added,kept};
}
export async function lastSession(){return localStorage.getItem(sessionKey)||((await read('settings','last-session'))?.value??null);}
