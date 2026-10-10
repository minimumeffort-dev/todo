import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname, sep, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MODEL_ASSETS, MODEL_CACHE_NAME } from '../../app/static/model-cache.mjs';

const project = fileURLToPath(new URL('../../', import.meta.url));
const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= join(cacheRoot, 'ms-playwright');
const { chromium } = await import('playwright');
const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.wasm':'application/wasm', '.css':'text/css', '.json':'application/json' };
async function fixture({ gpu = false } = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'todo-offline-'));
  const dist = join(folder, 'dist');
  await promisify(execFile)(process.execPath, [join(project, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist],
    { cwd: project, env: { ...process.env, PATH: `${resolve(process.execPath, '..')}:${process.env.PATH}` } });
  let fault = false;
  const served = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    served.push(path);
    if (path === '/__probe.html') { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><title>Offline proof</title><output id="result"></output>'); return; }
    let file = path.startsWith('/__fixture/') ? join(cacheRoot, 'local-todo/model-assets', basename(path))
      : resolve(dist, '.' + (path === '/' ? '/index.html' : path));
    if (!path.startsWith('/__fixture/') && !file.startsWith(dist + sep)) { response.writeHead(404).end(); return; }
    try {
      const info = statSync(file);
      if (!info.isFile()) throw Error('Not file');
      response.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control','no-store');
      if (fault && path === '/static/styles.css') { response.end('broken'); return; }
      response.setHeader('Content-Length', info.size);
      createReadStream(file).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let context; let serverClosed = false;
  const deadline = setTimeout(() => { void context?.close(); }, 26_000);
  async function stopServer() { if (!serverClosed) { serverClosed = true; server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); } }
  const requests = [];
  async function launch(offline = false) {
    context = await chromium.launchPersistentContext(join(folder, 'profile'), { channel: 'chromium', headless: true,
      args: gpu ? ['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-webgpu-developer-features'] : [] });
    context.on('request', r => requests.push({ url:r.url(), method:r.method(), body:r.postData() }));
    if (offline) await context.setOffline(true);
    const page = context.pages()[0];
    if(process.env.OFFLINE_DEBUG) { page.on('console',m=>console.log('browser',m.text())); page.on('pageerror',e=>console.log('pageerror',e.message)); }
    await page.goto(origin + (offline ? '/' : '/__probe.html'));
    return page;
  }
  return { folder, dist, origin, served, requests, launch, get context() { return context; },
    fault(value) { fault = value; },
    async restart() { await context.close(); context = null; await stopServer(); return launch(true); },
    async close() { clearTimeout(deadline); await context?.close(); await stopServer(); await rm(folder, { recursive:true, force:true }); } };
}
async function cacheShell(page) {
  const state = await page.evaluate(async () => (await import('/static/offline.mjs')).offlineRuntime.initialize());
  assert.equal(state.phase, 'ready');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function seedModel(page) {
  for (const asset of MODEL_ASSETS) {
    const bytes = await readFile(join(cacheRoot, 'local-todo/model-assets', basename(asset.path)));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  }
  await page.evaluate(async () => {
    const { createModelCache } = await import('/static/model-cache.mjs');
    await createModelCache({ fetchAsset: url => fetch('/__fixture/' + url.split('/').pop()) }).prepare();
  });
}
async function infer(page) {
  return page.evaluate(async () => {
    const { modelRuntime } = await import('/static/model-runtime.mjs');
    const states = []; modelRuntime.subscribe(state => states.push(state.phase));
    try {
      await modelRuntime.loadAndTest();
      const task = await modelRuntime.embedTask({ title:'Buy fresh groceries', icon:'shopping' });
      const query = await modelRuntime.embedQuery('buy food');
      for (const value of [task,query]) if (value.dimensions!==768 || value.vector.length!==768
        || !value.vector.every(Number.isFinite) || !value.vector.some(v=>v!==0)) throw Error('Invalid real embedding');
      const cosine=task.vector.reduce((n,v,i)=>n+v*query.vector[i],0)/Math.sqrt(
        task.vector.reduce((n,v)=>n+v*v,0)*query.vector.reduce((n,v)=>n+v*v,0));
      if(!Number.isFinite(cosine))throw Error('Invalid cosine');
      document.querySelector('h1, #result').textContent='Real offline inference succeeded';
      return { states: [...states],cosine };
    } finally { modelRuntime.dispose(); }
  });
}
export async function proveRealOffline() {
  const f = await fixture({gpu:true});
  try {
    let page = await f.launch();
    await cacheShell(page); await seedModel(page);
    page = await f.restart();
    const priorServed = f.served.length;
    assert.ok(await page.locator('body').isVisible());
    const offline = await infer(page);
    assert.ok(offline.states.includes('testing')); assert.equal(offline.states.at(-1),'ready');
    assert.equal(await page.locator('h1').textContent(),'Real offline inference succeeded');
    assert.ok(offline.cosine > 0.70, 'Real task and query embeddings must preserve semantic calibration');
    assert.deepEqual(f.served.slice(priorServed), [], 'Offline restart must reach no HTTP server');
    assert.deepEqual(f.requests.filter(r=>!r.url.startsWith(f.origin + '/')),[], 'Only local immutable file requests are allowed');
    const inventory = await page.evaluate(async () => {
      const result={}; for(const name of await caches.keys())result[name]=(await(await caches.open(name)).keys()).map(r=>r.url);
      return result;
    });
    assert.equal(inventory[MODEL_CACHE_NAME].length,5);
    assert.equal(Object.values(inventory).flat().filter(url=>url.includes('huggingface.co')).length,5);
    console.log('Chromium offline real inference:',{cosine:offline.cosine,modelCopies:1});
  } finally { await f.close(); }
}
// Use the production coordinator rather than starting a second raw SQL owner.
// After an offline restart the built app already owns the database; this probe
// must proxy through that owner and never wait to take its exclusive lock.
async function database(page, action) {
  return page.evaluate(async action => {
    if (!globalThis.offlineDB) {
      const [module, contract] = await Promise.all([
        import('/static/database-coordinator.mjs'), import('/static/storage-contract.mjs'),
      ]);
      const channel = new BroadcastChannel(contract.DATABASE_CHANNEL);
      let worker = null;
      const coordinator = module.createCoordinator({
        locks: navigator.locks, storage: navigator.storage, channel,
        // Return the endpoint immediately so election releases the lock before
        // the production worker takes it. Wait for ready only when sending RPC.
        spawnOwner() {
          let resolveReady, rejectReady;
          const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
          ready.catch(() => {});
          const pending = new Map(); let sequence = 0;
          const startup = setTimeout(() => rejectReady(Error('Database worker startup timed out')), 8000);
          worker = new Worker('/static/database-worker.mjs', { type: 'module' });
          worker.onmessage = ({ data }) => {
            if (data?.ready === true) { clearTimeout(startup); resolveReady(); return; }
            const waiter = pending.get(data?.id);
            if (!waiter || data.version !== contract.STORAGE_PROTOCOL_VERSION) return;
            pending.delete(data.id); clearTimeout(waiter.timer);
            if (data.ok) waiter.resolve(data.value);
            else waiter.reject(contract.restoreStorageError(data.error));
          };
          worker.onerror = event => {
            clearTimeout(startup); rejectReady(Error(event.message));
            for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(Error(event.message)); }
            pending.clear();
          };
          async function rpc(method, args) {
            await ready;
            return new Promise((resolve, reject) => {
              const id = ++sequence;
              const timer = setTimeout(() => { pending.delete(id); reject(Error('Database reply timed out')); }, 8000);
              pending.set(id, { resolve, reject, timer });
              worker.postMessage({ version: contract.STORAGE_PROTOCOL_VERSION, id, method, args });
            });
          }
          return Object.fromEntries(contract.REPOSITORY_METHODS.map(method => [method, (...args) => rpc(method, args)]));
        },
      });
      await coordinator.initialize();
      globalThis.offlineDB = { coordinator, close() { worker?.terminate(); channel.close(); } };
    }
    const store = offlineDB.coordinator;
    if (action === 'write') {
      const { EMBEDDING_METADATA } = await import('/static/storage-contract.mjs');
      const created = await store.create({ title: 'Tasks survive cache recovery', icon: 'heart' },
        { operationId: 'offline-cache-create' });
      const completed = await store.setCompleted(created.todo.id, true,
        { expectedRevision: created.revision, operationId: 'offline-cache-complete' });
      await store.saveEmbedding(created.todo.id, {
        title: completed.todo.title, icon: completed.todo.icon,
        vector: [0.5, 0.25, ...Array(766).fill(0)], ...EMBEDDING_METADATA,
      }, { expectedSourceRevision: completed.source_revision, operationId: 'offline-cache-embedding' });
    } else if (action !== 'read') throw Error('Unknown database probe operation');
    return (await store.exportBackup()).todos;
  }, action);
}
function assertSavedTask(records) {
  assert.equal(records.length, 1);
  const [record] = records;
  assert.match(record.id, /^[a-f0-9-]{36}$/);
  assert.equal(record.title, 'Tasks survive cache recovery');
  assert.equal(record.icon, 'heart'); assert.equal(record.completed, true);
  assert.deepEqual(record.embedding, [0.5, 0.25, ...Array(766).fill(0)]);
  assert.equal(record.embedding_model, 'onnx-community/embeddinggemma-2-ONNX');
  assert.equal(record.embedding_revision, 'daa72c51243991dfcaf9f9137d2c573d8f7790c0');
  assert.equal(record.embedding_input_version, 1); assert.equal(record.embedding_dimensions, 768);
  assert.ok(record.created_at);
}
async function assertRestartedTask(page, expected) {
  await page.waitForFunction(() => document.querySelector('#storage-status')
    ?.textContent.includes('Local storage ready'), null, { timeout: 8000 });
  assert.equal(await page.locator('.task-row').count(), 1);
  assert.ok(await page.locator('.task-row .task-completion').isChecked());
  assert.ok((await page.locator('.task-row').innerText()).includes(expected[0].title));
  assert.deepEqual(await database(page, 'read'), expected);
  assert.equal(await page.evaluate(() => offlineDB.coordinator.owner), false,
    'The probe must reuse the app owner instead of competing for its lock');
}
export async function proveRecovery() {
  const f=await fixture();
  try {
    const page=await f.launch();f.fault(true);
    const failure=await page.evaluate(async()=>{
      const {createOfflineRuntime}=await import('/static/offline.mjs');
      const runtime=createOfflineRuntime({timeoutMs:5000});let state;runtime.subscribe(v=>{state=v;});
      try{await runtime.initialize();}catch{}return state;
    });
    assert.equal(failure.phase,'error');
    assert.equal(await page.evaluate(async()=>{
      for(const name of await caches.keys()) if(name.startsWith('local-todo-shell')){
        if(await(await caches.open(name)).match('/__local-todo-shell-complete')) return true;
      }return false;
    }),false);
    f.fault(false);await cacheShell(page);
    const expected = await database(page,'write'); assertSavedTask(expected);
    assert.equal(await page.evaluate(() => offlineDB.coordinator.owner), true);
    const cdp=await f.context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin',{origin:f.origin,quotaSize:1});
    const quota=await page.evaluate(async()=>{
      const {createModelCache,MODEL_ASSETS}=await import('/static/model-cache.mjs');
      try { await createModelCache({assets:MODEL_ASSETS.slice(0,1),fetchAsset:url=>fetch('/__fixture/'+url.split('/').pop())}).prepare();return {acknowledged:true}; }
      catch(error){return {message:error.message,cause:error.cause?.name};}
    });
    assert.equal(quota.cause,'QuotaExceededError');assert.match(quota.message,/storage is full/);
    await cdp.send('Storage.overrideQuotaForOrigin',{origin:f.origin,quotaSize:1024*1024*1024});
    await page.evaluate(async name=>{await(await caches.open(name)).put('https://huggingface.co/sentinel',new Response('clear'));},MODEL_CACHE_NAME);
    await page.evaluate(async()=>{
      const {modelCache,MODEL_CACHE_NAME}=await import('/static/model-cache.mjs');await modelCache.clear();
      if((await caches.keys()).includes(MODEL_CACHE_NAME))throw Error('Model cache was not removed');
      const shell=(await caches.keys()).find(n=>n.startsWith('local-todo-shell'));
      await(await caches.open(shell)).put('/static/styles.css',new Response('corrupted'));
    });
    const before=f.served.length;await cacheShell(page);
    assert.ok(f.served.slice(before).includes('/static/styles.css'));
    assert.equal(f.served.slice(before).filter(path=>path.startsWith('/vendor/')).length,0);
    assert.deepEqual(await database(page,'read'),expected);
    await page.evaluate(()=>offlineDB.close());
    const fresh=await f.restart();
    await assertRestartedTask(fresh, expected);
  } finally { await f.close(); }
}
export async function proveUpdate() {
  const f=await fixture();
  try {
    const page=await f.launch();await cacheShell(page);
    const expected=await database(page,'write'); assertSavedTask(expected);
    assert.equal(await page.evaluate(() => offlineDB.coordinator.owner), true);
    await seedModel(page);
    const old=JSON.parse(await readFile(join(f.dist,'asset-manifest.json')));
    await writeFile(join(f.dist,'static/styles.css'),(await readFile(join(f.dist,'static/styles.css'))).toString()+'\n/* update fixture */');
    const entries=[];
    for(const asset of old.assets){
      let bytes=await readFile(join(f.dist,asset.url));
      if(asset.url==='/service-worker.mjs')bytes=Buffer.from(bytes.toString().replace(old.shellVersion,'__SHELL_VERSION__'));
      entries.push([asset.url.slice(1),bytes]);
    }
    entries.sort(([a],[b])=>a.localeCompare(b));
    const shellVersion=createHash('sha256').update(JSON.stringify(entries.map(([path,bytes])=>[path,createHash('sha256').update(bytes).digest('hex')]))).digest('hex');
    const worker=entries.find(([path])=>path==='service-worker.mjs');worker[1]=Buffer.from(worker[1].toString().replace('__SHELL_VERSION__',shellVersion));
    await writeFile(join(f.dist,'service-worker.mjs'),worker[1]);
    const assets=entries.map(([path,bytes])=>({url:'/'+path,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));
    await writeFile(join(f.dist,'asset-manifest.json'),JSON.stringify({shellVersion,version:createHash('sha256').update(JSON.stringify(assets)).digest('hex'),assets}));
    await page.evaluate(async()=>{
      const reg=await navigator.serviceWorker.getRegistration();
      const changed=new Promise((resolve,reject)=>{
        reg.addEventListener('updatefound',()=>{
          const worker=reg.installing;worker.addEventListener('statechange',()=>{
            if(worker.state==='activated')resolve();if(worker.state==='redundant')reject(Error('Update failed'));
          });
        },{once:true});
      });
      await reg.update();await changed;
    });
    const inventory=await page.evaluate(async name=>{
      const names=await caches.keys();let total=0;
      for(const cacheName of names)total+=(await(await caches.open(cacheName)).keys()).filter(r=>r.url.includes('huggingface.co')).length;
      return {names,total,urls:(await(await caches.open(name)).keys()).map(r=>r.url)};
    },MODEL_CACHE_NAME);
    assert.equal(inventory.total,5);
    assert.deepEqual(inventory.urls.sort(),MODEL_ASSETS.map(a=>a.url).sort());
    assert.deepEqual(inventory.names.filter(n=>n.startsWith('local-todo-shell')),['local-todo-shell-v1-'+shellVersion]);
    await page.evaluate(()=>offlineDB.close());
    const fresh=await f.restart();await assertRestartedTask(fresh, expected);
  } finally {await f.close();}
}
// Direct Node invocation registers independent, repeatable browser scenarios.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  test('built shell and fresh worker perform real inference after offline profile restart',{timeout:29000},proveRealOffline);
  test('cache recovery repairs only failed assets and preserves OPFS tasks',{timeout:25000},proveRecovery);
  test('versioned app updates preserve the canonical model cache and OPFS database',{timeout:25000},proveUpdate);
}
