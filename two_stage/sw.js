const VERSION='two-stage-a3ff420fea63fa5a';
const PREFIX='two-stage:'+self.registration.scope+':';
const CACHE=PREFIX+VERSION;
const ASSETS=['./','./index.html','./style.css','./app.js','./engine.mjs','./storage.mjs','./stage2.mjs','./reclaim.mjs','./pack.mjs','./signals.mjs','./contracts.mjs','./manifest.webmanifest','./icon-192.png','./icon-512.png'];
const urls=new Set(ASSETS.map(p=>new URL(p,self.registration.scope).href));
// Pages sets HTTP cache lifetimes independently of our release. Populate a new
// release from fresh responses so a waiting worker cannot pin an old app bundle.
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS.map(path=>new Request(new URL(path,self.registration.scope),{cache:'reload'}))))));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));
self.addEventListener('message',event=>{if(event.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||!urls.has(event.request.url))return;
  event.respondWith(caches.open(CACHE).then(async cache=>(await cache.match(event.request))||fetch(event.request)));
});
