const CACHE='drsx-v5-phase3';
const IMAGE_CACHE='drsx-images-v5-phase3';
const STATIC=['./','./index.html','./assets/styles.css','./assets/data-service.js','./assets/app.js','./manifest.webmanifest','./icon.svg','./icon-192.png','./icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(STATIC)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>![CACHE,IMAGE_CACHE].includes(key)).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
async function staleImage(request){const cache=await caches.open(IMAGE_CACHE),cached=await cache.match(request);const network=fetch(request).then(response=>{if(response.ok||response.type==='opaque')cache.put(request,response.clone());return response;}).catch(()=>cached);return cached||network;}
self.addEventListener('fetch',event=>{const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);
 if(request.destination==='image'){event.respondWith(staleImage(request));return;}
 if(url.origin!==self.location.origin)return;
 if(url.pathname.endsWith('/config.js')){event.respondWith(fetch(request,{cache:'no-store'}).catch(()=>caches.match(request)));return;}
 const fresh=request.mode==='navigate'||/\/(index\.html|assets\/(app\.js|data-service\.js|styles\.css))$/.test(url.pathname);
 if(fresh){event.respondWith(fetch(request,{cache:'no-store'}).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;}).catch(()=>caches.match(request).then(cached=>cached||(request.mode==='navigate'?caches.match('./index.html'):undefined))));return;}
 event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy));}return response;})));
});
