// Replaced during build. Including the dependency digest in this script makes
// browser update detection respond to every app/runtime change, not only SW edits.
const VERSION = '__SHELL_VERSION__';
const PREFIX = 'local-todo-shell-v1-';
const CACHE = PREFIX + VERSION;
const COMPLETE = new URL('/__local-todo-shell-complete', self.location.origin).href;
let preparing = null;

async function verify(response, asset) {
  if (!response?.ok || response.type === 'opaque') throw Error(`Missing app asset: ${asset.url}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== asset.size) throw Error(`Incomplete app asset: ${asset.url}`);
  const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    v => v.toString(16).padStart(2, '0')).join('');
  if (sha !== asset.sha256) throw Error(`Corrupt app asset: ${asset.url}`);
  return bytes;
}
async function prepare() {
  if (preparing) return preparing;
  preparing = (async () => {
    const cache = await caches.open(CACHE);
    let manifestResponse = await fetch('/asset-manifest.json', { cache: 'no-store' }).catch(() => null);
    if (!manifestResponse?.ok) manifestResponse = await cache.match('/asset-manifest.json');
    if (!manifestResponse?.ok) throw Error('The app asset manifest is unavailable. Connect and retry.');
    const manifest = await manifestResponse.clone().json();
    if (manifest.shellVersion !== VERSION || !Array.isArray(manifest.assets)) throw Error('App update changed while caching. Reload and retry.');
    const manifestHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(JSON.stringify(manifest.assets)))), v => v.toString(16).padStart(2, '0')).join('');
    if (manifestHash !== manifest.version) throw Error('The app asset manifest failed verification.');
    // A partially repaired cache must never retain a completed marker.
    await cache.delete(COMPLETE);
    for (const asset of manifest.assets) {
      if (!/^\/(?:static\/|vendor\/|index\.html$|service-worker\.mjs$)/.test(asset.url)
        || /(?:models\/|\.onnx|\.duckdb)/.test(asset.url)) throw Error('Invalid app asset manifest');
      try { await verify(await cache.match(asset.url), asset); }
      catch {
        await cache.delete(asset.url);
        const response = await fetch(asset.url, { cache: 'no-store' });
        const bytes = await verify(response.clone(), asset);
        await cache.put(asset.url, new Response(bytes, { headers: response.headers }));
        await verify(await cache.match(asset.url), asset);
      }
    }
    await cache.put('/asset-manifest.json', manifestResponse);
    await cache.put(COMPLETE, new Response(VERSION));
    if ((await (await cache.match(COMPLETE))?.text()) !== VERSION) throw Error('App cache write was not confirmed');
    return { ready: true, version: VERSION };
  })().finally(() => { preparing = null; });
  return preparing;
}
self.addEventListener('install', event => {
  event.waitUntil(prepare().then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    if (!await cache.match(COMPLETE)) throw Error('App cache is incomplete');
    for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'prepare-shell') return;
  event.waitUntil(prepare().then(result => event.ports[0]?.postMessage(result), error => {
    event.ports[0]?.postMessage({ ready: false, message: error?.name === 'QuotaExceededError'
      ? 'App files could not be saved: browser storage is full.' : 'App caching failed. Connect, check available storage and retry.' });
  }));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // No task endpoints, model responses or third-party requests enter this cache.
  if (request.method !== 'GET' || url.origin !== self.location.origin
    || !(request.mode === 'navigate' || url.pathname === '/asset-manifest.json'
      || /^\/(?:static|vendor)\//.test(url.pathname))) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Installation already required a complete cache. During a recovery pass,
    // continue serving verified surviving files instead of racing a network-only
    // window while the completion marker is rebuilt.
    {
      const cached = await cache.match(request.mode === 'navigate' ? '/index.html' : url.pathname);
      if (cached) return cached;
    }
    return fetch(request);
  })());
});
