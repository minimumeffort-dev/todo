"""Static distribution checks and opt-in browser integration with real inference."""

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

from fastapi.testclient import TestClient
import pytest

from app.main import create_app

ROOT = Path(__file__).resolve().parents[1]
MODEL_MODULES = ("model-panel.mjs", "model-runtime.mjs", "model-worker.mjs")


@pytest.mark.parametrize("name", MODEL_MODULES)
def test_model_modules_are_served_as_javascript(tmp_path, name):
    with TestClient(create_app(tmp_path / "todos.duckdb")) as client:
        response = client.get(f"/static/{name}")
        assert response.status_code == 200
        assert "javascript" in response.headers["content-type"]
        assert response.content == (ROOT / "app" / "static" / name).read_bytes()
        assert client.get("/api/todos").json() == []


def test_model_panel_is_wired_without_changing_task_controls(tmp_path):
    with TestClient(create_app(tmp_path / "todos.duckdb")) as client:
        html = client.get("/").text
    assert '<script type="module" src="/static/model-panel.mjs">' in html
    assert 'id="model-status" role="status"' in html
    assert 'id="model-error" class="error" role="alert"' in html
    for element in ("todo-form", "todo-title", "todo-list", "status", "error"):
        assert f'id="{element}"' in html


def test_model_modules_are_packaged_in_wheel(tmp_path):
    # Build a copy so a repeatable check never mutates project source/egg-info.
    source = tmp_path / "source"
    source.mkdir()
    shutil.copy2(ROOT / "pyproject.toml", source)
    shutil.copytree(ROOT / "app", source / "app", ignore=shutil.ignore_patterns("__pycache__"))
    wheels = tmp_path / "wheels"
    subprocess.run(
        [sys.executable, "-m", "pip", "wheel", "--no-deps", "--no-build-isolation",
         "--wheel-dir", str(wheels), str(source)],
        check=True, capture_output=True, text=True, timeout=15,
    )
    with zipfile.ZipFile(next(wheels.glob("*.whl"))) as wheel:
        for name in MODEL_MODULES:
            path = f"app/static/{name}"
            assert wheel.read(path) == (ROOT / path).read_bytes()
        assert b"model-panel.mjs" in wheel.read("app/static/index.html")


def test_runtime_lifecycle_suite():
    subprocess.run([node_executable(), "--test", str(ROOT / "tests/model_runtime.test.mjs")],
                   check=True, capture_output=True, text=True, timeout=10)


def node_executable():
    configured = os.environ.get("MODEL_TEST_NODE")
    installed = shutil.which("node")
    managed = Path.home() / ".local/share/mise/installs/node/22.20.0/bin/node"
    result = configured or installed or str(managed)
    if not Path(result).is_file():
        pytest.fail("Install Node 22 (mise install node@22.20.0) or set MODEL_TEST_NODE.")
    return result


BROWSER_CHECK = r"""
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createReadStream, existsSync, readFileSync, statSync} from 'node:fs';
import {mkdir, mkdtemp, rename, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const root = process.env.MODEL_PROJECT_ROOT;
const mode = process.argv[1];
const cold = process.env.MODEL_COLD_DOWNLOAD === '1';
const {chromium, expect} = await import(pathToFileURL(`${root}/.venv/model-browser/node_modules/playwright/test.mjs`));
const {MODEL_ARTIFACT, TRANSFORMERS_URL} = await import(pathToFileURL(`${root}/app/static/model-worker.mjs`));
const base = `https://huggingface.co/${MODEL_ARTIFACT.id}/resolve/${MODEL_ARTIFACT.revision}/`;
const ort = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
const files = [
  ['config.json', base, '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d'],
  ['tokenizer_config.json', base, '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874'],
  ['tokenizer.json', base, '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4'],
  ['model_q4.onnx', base + 'onnx/', 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9'],
  ['model_q4.onnx_data', base + 'onnx/', 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49'],
  ['transformers.min.js', TRANSFORMERS_URL.replace(/[^/]+$/, ''), '8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743'],
  ['ort-wasm-simd-threaded.asyncify.mjs', ort, '0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611'],
  ['ort-wasm-simd-threaded.asyncify.wasm', ort, '49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082'],
].map(([name, prefix, hash]) => ({name, url: prefix + name, hash, path: `${root}/.venv/model-assets/${name}`}));
if (mode === 'download') {
  await mkdir(`${root}/.venv/model-assets`, {recursive: true});
  for (const file of files) {
    if (existsSync(file.path) && createHash('sha256').update(readFileSync(file.path)).digest('hex') === file.hash) continue;
    const temporary = file.path + '.download';
    const headers = temporary + '.headers';
    let effective = '';
    const curl = spawn('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--location', '--max-time', '240',
      '--dump-header', headers, '--write-out', '%{url_effective}', '--output', temporary, file.url]);
    curl.stdout.on('data', chunk => {effective += String(chunk);});
    curl.stderr.on('data', chunk => process.stderr.write(chunk));
    const code = await new Promise(resolve => curl.once('exit', resolve));
    if (code !== 0) {
      const blocked = existsSync(headers) && /x-proxy-error:\s*blocked-by-allowlist/i.test(readFileSync(headers, 'utf8'));
      await rm(temporary, {force: true}); await rm(headers, {force: true});
      throw Error(blocked ? 'Download blocked by allowlist: ' + new URL(effective || file.url).hostname
        : 'Could not download ' + file.url);
    }
    assert.equal(createHash('sha256').update(readFileSync(temporary)).digest('hex'), file.hash, file.name);
    await rename(temporary, file.path); await rm(headers, {force: true});
  }
  console.log('Verified browser fixtures prepared.'); process.exit(0);
}
if (!cold && !['flows', 'embedding-flows'].includes(mode)) for (const file of files) {
  assert.equal(createHash('sha256').update(readFileSync(file.path)).digest('hex'), file.hash, file.name);
}
const fixtureServer = createServer((request, response) => {
  const file = files.find(file => request.url === '/' + file.name);
  if (!file) {response.writeHead(404); response.end(); return;}
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Content-Length', statSync(file.path).size);
  response.setHeader('Content-Type', /\.m?js$/.test(file.name) ? 'text/javascript' : 'application/octet-stream');
  createReadStream(file.path).pipe(response);
});
const directory = await mkdtemp('/tmp/todo-model-integration-');
const server = spawn(process.env.MODEL_TEST_PYTHON, ['-u', '-c', `import socket, uvicorn
s = socket.socket(); s.bind(('127.0.0.1', 0)); print('PORT:'+str(s.getsockname()[1]), flush=True)
uvicorn.run('app.main:app', fd=s.fileno(), log_level='warning')`],
  {cwd: root, env: {...process.env, TODO_DB_PATH: `${directory}/todos.duckdb`}});
let browser;
let timeout;
let releaseRuntime;
let verifyDatabase;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', chunk => {const m = String(chunk).match(/PORT:(\d+)/); if (m) resolve(m[1]);});
    server.stderr.on('data', chunk => process.stderr.write(chunk));
    server.on('exit', code => reject(Error(`FastAPI exited: ${code}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {if ((await fetch(origin + '/health')).ok) break;} catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  browser = await chromium.launch({channel: 'chromium', headless: true,
    args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-webgpu-developer-features'],
    proxy: cold && process.env.HTTPS_PROXY ? {server: process.env.HTTPS_PROXY, bypass: '127.0.0.1,localhost'} : undefined});
  // The watchdog closes Chromium so a failed check never leaves an inference running.
  timeout = setTimeout(() => {void browser.close();}, cold ? 270000 : 26000);
  const context = await browser.newContext({ignoreHTTPSErrors: cold});
  context.setDefaultTimeout(5000);
  if (mode === 'embedding-flows') {
    // UI/API fault checks use an injected runtime. The separate embeddings mode
    // runs the authentic pinned worker and weights, without replacing inference.
    await context.route('**/static/model-runtime.mjs', route => route.fulfill({
      contentType: 'text/javascript', body: `
const artifact = ${JSON.stringify(MODEL_ARTIFACT)};
const controls = window.__embeddingFixture = {calls: [], pending: [], hold: false, failNext: 0};
const listeners = new Set();
let state = {phase: 'idle', progress: null, message: ''};
function publish(phase) {
  state = {phase, progress: phase === 'ready' ? 1 : null,
    message: phase === 'ready' ? 'EmbeddingGemma 2 passed its sample test on WebGPU.' : ''};
  for (const listener of listeners) listener(state);
}
controls.release = title => {
  const pending = controls.pending.filter(item => !title || item.source.title === title);
  controls.pending = controls.pending.filter(item => !pending.includes(item));
  for (const item of pending) item.resolve(item.result);
};
export const modelRuntime = {
  subscribe(listener) {listeners.add(listener); listener(state); return () => listeners.delete(listener);},
  async loadAndTest() {publish('ready');},
  dispose() {publish('idle');},
  embedTask(source) {
    source = {...source}; controls.calls.push(source);
    if (controls.failNext-- > 0) return Promise.reject(Error('Injected inference failure'));
    const vector = Array(artifact.dimensions).fill(0); vector[0] = 0.5; vector[1] = -0.25;
    const result = {...source, vector, model: artifact.id, revision: artifact.revision,
      input_version: 1, dimensions: artifact.dimensions};
    return controls.hold ? new Promise(resolve => controls.pending.push({source, result, resolve}))
      : Promise.resolve(result);
  },
};` }));
  }
  await context.addInitScript(() => {
    window.__modelMessages = []; window.__modelPhases = []; window.__testingClicks = 0;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options); this.isModel = String(url).includes('/model-worker.mjs');
        if (this.isModel) this.addEventListener('message', event => {
          window.__modelPhases.push(event.data.phase);
          if (event.data.phase === 'testing' && window.__inferenceCheckbox) {
            if (window.__inferenceCheckbox.disabled) throw Error('Task disabled during inference');
            window.__inferenceCheckbox.click(); window.__testingClicks++;
          }
        });
      }
      postMessage(message, ...rest) {
        if (this.isModel) window.__modelMessages.push(message);
        return super.postMessage(message, ...rest);
      }
    };
  });
  const external = [];
  const creations = [];
  const uploads = [];
  const uploadResponses = [];
  context.on('request', request => {if (request.url().startsWith('https://')) external.push(request.url());});
  context.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/todos')) creations.push(request.postDataJSON());
    if (request.method() === 'PUT' && request.url().endsWith('/embedding')) {
      uploads.push({id: new URL(request.url()).pathname.split('/')[3], ...request.postDataJSON()});
    }
  });
  context.on('response', response => {
    if (response.request().method() === 'PUT' && response.url().endsWith('/embedding')) uploadResponses.push(response.status());
  });
  let blockRuntime = mode === 'errors' || mode === 'flows';
  let blockedModelFile = mode === 'external-error' ? 'model_q4.onnx_data' : '';
  const gate = new Promise(resolve => {releaseRuntime = resolve;});
  if (!cold) await context.route('https://**', async route => {
    const url = route.request().url();
    if (blockRuntime) {await route.abort(); return;}
    const file = files.find(file => file.url === url && /\.m?js$/.test(file.name));
    if (!file) {await route.abort(); return;}
    if (blockedModelFile && url === TRANSFORMERS_URL) {
      // Dedicated-worker fetches are not reliably intercepted by Playwright's
      // page routing. Reject model requests at the SDK's documented fetch hook.
      // The SDK bytes and subsequent successful inference remain authentic.
      const runtime = fixtureOrigin + '/transformers.min.js';
      await route.fulfill({contentType: 'text/javascript', headers: {'Access-Control-Allow-Origin': '*'},
        body: `export * from '${runtime}'; import {env} from '${runtime}';
const fetchModel = env.fetch;
env.fetch = (url, options) => {
  if (String(url) !== '${base}onnx/${blockedModelFile}') return fetchModel(url, options);
  if (!new Headers(options?.headers).has('Range')) console.log('Model download blocked by test: ${blockedModelFile}');
  return Promise.reject(new TypeError('Model download blocked by test'));
};`});
      return;
    }
    if (mode === 'real' && url === TRANSFORMERS_URL) await gate;
    await route.fulfill({path: file.path, contentType: 'text/javascript', headers: {'Access-Control-Allow-Origin': '*'}});
  });
  const page = await context.newPage();
  if (process.env.MODEL_BROWSER_DEBUG === '1') page.on('console', message => console.log('BROWSER', message.type(), message.text()));
  page.on('console', message => {if (cold && message.type() === 'error') console.log(message.text());});
  async function open() {
    await page.goto(origin);
    await expect(page.locator('#model-load')).toHaveText('Load and test model');
    await expect(page.locator('#refresh-button')).toBeEnabled();
  }
  async function seed(exclude = '') {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', {origin, quotaSize: 1024 * 1024 * 1024});
    await page.evaluate(async ({files, fixtureOrigin, exclude}) => {
      const cache = await caches.open('transformers-cache');
      await Promise.all(files.filter(file => file.name !== exclude).map(async file => {
        if (await cache.match(file.url)) return;
        const response = await fetch(fixtureOrigin + '/' + file.name);
        if (!response.ok) throw Error('Missing authentic model fixture: ' + file.name);
        await cache.put(file.url, new Response(response.body, {headers: {'Content-Length': response.headers.get('Content-Length')}}));
      }));
    }, {files: files.map(({name, url}) => ({name, url})), fixtureOrigin, exclude});
  }
  async function add(title, icon = 'task') {
    if (await page.locator('#todo-form').isHidden()) await page.locator('#new-task').click();
    const before = await page.locator('.task-row').count();
    if (icon !== 'task') {
      await page.locator('#composer-icon .icon-button').click();
      await page.locator('#composer-icon').getByRole('button', {name: icon[0].toUpperCase() + icon.slice(1), exact: true}).click();
    }
    await page.locator('#todo-title').fill(title);
    await page.locator('#todo-title').press('Enter');
    await expect(page.locator('.task-row')).toHaveCount(before + 1);
    const titleButton = page.getByRole('button', {name: `Edit ${title.trim()}`, exact: true}).last();
    await expect(titleButton).toBeVisible();
    const id = await titleButton.locator('xpath=ancestor::li').getAttribute('data-id');
    return page.locator(`li[data-id="${id}"]`);
  }
  async function saved() {return await page.evaluate(async () => (await fetch('/api/todos')).json());}
  async function ready() {
    await expect(page.locator('#model-status')).toContainText('passed its sample test', {timeout: cold ? 240000 : 16000});
    await expect(page.locator('#model-load')).toBeDisabled();
    await expect(page.locator('#model-error')).toBeHidden();
    await expect(page.locator('#model-progress')).toBeHidden();
  }
  async function externalWeightFailure() {
    blockedModelFile = 'model_q4.onnx_data';
    const rejected = page.waitForEvent('console', {
      predicate: message => message.text() === 'Model download blocked by test: model_q4.onnx_data'});
    await page.locator('#model-load').click();
    await rejected;
    await expect(page.locator('#model-load'), 'Blocked model_q4.onnx_data must release the failed worker and permit retry').toHaveText('Retry');
    await expect(page.locator('#model-error')).toContainText('model download hosts');
    await expect(page.locator('#error')).toBeHidden();
  }
  await open();
  assert.deepEqual(external, [], 'A model download started before explicit activation');
  if (mode === 'real') {
    if (!cold) await seed();
    await page.locator('#new-task').click();
    await page.locator('#todo-title').fill('Composer survives model activation');
    await page.locator('#model-load').focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#model-progress')).toBeVisible();
    await expect(page.locator('#todo-title')).toHaveValue('Composer survives model activation');
    const row = await add('Task added while model loads');
    const checkbox = row.locator('.task-completion');
    await checkbox.check(); await expect(checkbox).toBeEnabled();
    await checkbox.uncheck(); await expect(checkbox).toBeEnabled();
    await page.locator('#todo-title').fill('Composer survives inference');
    await row.locator('.task-title').click();
    await row.locator('.task-editor').fill('Unsaved row draft during model execution');
    await page.locator('#refresh-button').click(); await expect(page.locator('#refresh-button')).toBeEnabled();
    await expect(row.locator('.task-editor')).toHaveValue('Unsaved row draft during model execution');
    await page.evaluate(() => {window.__inferenceCheckbox = document.querySelector('.task-completion');});
    releaseRuntime();
    await ready();
    await expect(checkbox).toBeChecked(); await expect(checkbox).toBeEnabled();
    await expect(row.locator('.task-editor')).toHaveValue('Unsaved row draft during model execution');
    await expect(page.locator('#todo-title')).toHaveValue('Composer survives inference');
    const state = await page.evaluate(() => ({messages: window.__modelMessages, phases: window.__modelPhases, clicks: window.__testingClicks}));
    assert.equal(state.clicks, 1); assert.ok(state.phases.includes('testing')); assert.ok(state.phases.includes('ready'));
    assert.deepEqual(Object.keys(state.messages[0]), ['type', 'id']); assert.equal(state.messages[0].type, 'load-and-test');
    assert.deepEqual((await saved()).map(({title, completed}) => ({title, completed})), [{title: 'Task added while model loads', completed: true}]);
    assert.ok(!external.some(url => /vision_encoder|audio_encoder/.test(url)));
    if (!cold) assert.ok(external.every(url => files.some(file => file.url === url && /\.m?js$/.test(file.name))));
    assert.equal(uploads.length, 0, 'Loading the model must not retroactively embed existing tasks');
  } else if (mode === 'embeddings') {
    await seed();
    await page.locator('#model-load').click(); await ready();
    assert.equal((await saved()).length, 0);
    const first = await add('  Buy groceries  ', 'shopping');
    await expect.poll(() => uploadResponses.filter(status => status === 204).length).toBe(1);
    const second = await add('Buy groceries', 'heart');
    const third = await add('Read a book', 'shopping');
    await page.locator('#todo-title').fill('Next task draft');
    await expect.poll(() => uploadResponses.filter(status => status === 204).length).toBe(3);
    for (const row of [first, second, third]) {
      await expect(row.locator('.embedding-status')).toBeHidden();
      await expect(row.locator('.embedding-feedback')).toBeHidden();
      await expect(row.locator('.task-completion')).toBeEnabled();
    }
    await expect(page.locator('#todo-title')).toHaveValue('Next task draft');
    await expect(page.locator('#todo-title')).toBeFocused();
    const sources = uploads.map(({title, icon}) => ({title, icon}));
    assert.deepEqual(sources, [{title: 'Buy groceries', icon: 'shopping'},
      {title: 'Buy groceries', icon: 'heart'}, {title: 'Read a book', icon: 'shopping'}]);
    for (const item of uploads) {
      assert.equal(item.vector.length, MODEL_ARTIFACT.dimensions);
      assert.ok(item.vector.every(Number.isFinite)); assert.ok(item.vector.some(value => value !== 0));
      assert.equal(item.model, MODEL_ARTIFACT.id); assert.equal(item.revision, MODEL_ARTIFACT.revision);
      assert.equal(item.input_version, 1); assert.equal(item.dimensions, 768);
    }
    const difference = (first, second) => Math.max(...first.map((value, index) => Math.abs(value - second[index])));
    assert.ok(difference(uploads[0].vector, uploads[1].vector) > 1e-5, 'The icon must affect the vector');
    assert.ok(difference(uploads[0].vector, uploads[2].vector) > 1e-5, 'The title must affect the vector');
    const messages = await page.evaluate(() => window.__modelMessages);
    assert.equal(messages.filter(message => message.type === 'load-and-test').length, 1);
    assert.equal(messages.filter(message => message.type === 'embed-task').length, 3);
    assert.equal(creations.length, 3);
    for (const task of await saved()) assert.deepEqual(Object.keys(task).sort(), ['completed', 'icon', 'id', 'title']);
    await page.setViewportSize({width: 375, height: 700});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    verifyDatabase = data => {
      assert.equal(data.length, 3);
      for (const task of data) {
        const expected = uploads.find(item => item.id === task.id);
        assert.ok(expected);
        assert.equal(task.title, expected.title); assert.equal(task.icon, expected.icon);
        assert.deepEqual(task.vector, expected.vector);
        assert.equal(task.model, expected.model); assert.equal(task.revision, expected.revision);
        assert.equal(task.input_version, 1); assert.equal(task.dimensions, 768);
      }
    };
  } else if (mode === 'embedding-flows') {
    const unloaded = await add('No model needed');
    assert.equal(uploads.length, 0);
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.length), 0);
    await page.locator('#model-load').click(); await ready();
    await page.evaluate(() => {window.__embeddingFixture.hold = true;});
    const first = await add('First queued task', 'shopping');
    const second = await add('Second queued task', 'heart');
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.length), 2);
    await expect(first.locator('.embedding-status')).toBeVisible();
    await expect(second.locator('.embedding-status')).toBeVisible();
    await expect(page.locator('#add-button')).toBeEnabled();
    await first.locator('.task-title').click(); await first.locator('.task-editor').fill('Unsaved during processing');
    await first.locator('.task-completion').check(); await expect(first.locator('.task-completion')).toBeEnabled();
    await first.locator('.task-editor').focus();
    await page.evaluate(() => {document.querySelector('#todo-title').value = 'Next composer draft'; window.__embeddingFixture.release();});
    await expect.poll(() => uploadResponses.filter(status => status === 204).length).toBe(2);
    await expect(first.locator('.task-editor')).toHaveValue('Unsaved during processing');
    await expect(first.locator('.task-editor')).toBeFocused();
    await expect(page.locator('#todo-title')).toHaveValue('Next composer draft');
    await expect(first.locator('.task-completion')).toBeChecked();
    await first.locator('.task-editor').press('Escape');
    await page.evaluate(() => {window.__embeddingFixture.hold = false; window.__embeddingFixture.failNext = 1;});
    const inferenceFailure = await add('Inference retry');
    await expect(inferenceFailure.locator('.embedding-feedback')).toBeVisible();
    await expect(page.locator('#error')).toBeHidden(); await expect(page.locator('#model-error')).toBeHidden();
    const failedId = await inferenceFailure.getAttribute('data-id');
    await page.route(`**/api/todos/${failedId}`, route => route.request().method() === 'PUT'
      ? route.fulfill({status: 503, contentType: 'application/json', body: '{"detail":"Save temporarily failed"}'}) : route.continue());
    await inferenceFailure.locator('.task-title').click(); await inferenceFailure.locator('.task-editor').fill('Kept failed-save draft');
    await inferenceFailure.locator('.task-editor').press('Enter');
    const saveFeedback = inferenceFailure.locator('.row-feedback:not(.embedding-feedback)');
    await expect(saveFeedback).toBeVisible();
    const createdBeforeRetry = creations.length;
    await inferenceFailure.locator('.embedding-retry').click();
    await expect(inferenceFailure.locator('.embedding-feedback')).toBeHidden();
    await expect(inferenceFailure.locator('.embedding-status')).toBeHidden();
    await expect(saveFeedback).toBeVisible();
    await expect(inferenceFailure.locator('.task-editor')).toHaveValue('Kept failed-save draft');
    assert.equal(creations.length, createdBeforeRetry, 'Inference retry must not POST another task');
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.filter(item => item.title === 'Inference retry').length), 2);
    await inferenceFailure.locator('.task-editor').press('Escape');
    let failUpload = true;
    await page.route('**/api/todos/*/embedding', route => {
      if (failUpload && route.request().postDataJSON().title === 'Upload retry') {
        failUpload = false;
        return route.fulfill({status: 503, contentType: 'application/json', body: '{"detail":"Upload temporarily failed"}'});
      }
      return route.continue();
    });
    const uploadFailure = await add('Upload retry');
    await expect(uploadFailure.locator('.embedding-feedback')).toBeVisible();
    const inferredBeforeRetry = await page.evaluate(() => window.__embeddingFixture.calls.length);
    const postedBeforeRetry = creations.length;
    await uploadFailure.locator('.embedding-retry').focus(); await page.keyboard.press('Enter');
    await expect(uploadFailure.locator('.embedding-feedback')).toBeHidden();
    await expect(uploadFailure.locator('.embedding-status')).toBeHidden();
    assert.equal(creations.length, postedBeforeRetry);
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.length), inferredBeforeRetry, 'Upload retry reuses its vector');
    const attempts = uploads.filter(item => item.title === 'Upload retry');
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    await page.evaluate(() => {window.__embeddingFixture.hold = true;});
    const edited = await add('Edit before inference');
    await edited.locator('.task-title').click(); await edited.locator('.task-editor').fill('Changed source');
    await edited.locator('.task-editor').press('Enter'); await expect(edited.locator('.task-title')).toHaveText('Changed source');
    const removed = await add('Delete before inference');
    await removed.locator('.remove').click(); await expect(removed).toHaveCount(0);
    const uploadsBeforeStale = uploads.length;
    await page.evaluate(() => {window.__embeddingFixture.release(); window.__embeddingFixture.hold = false;});
    await expect(edited.locator('.embedding-status')).toBeHidden();
    await expect(edited.locator('.embedding-feedback')).toBeHidden();
    assert.equal(uploads.length, uploadsBeforeStale, 'Changed/deleted task results must be discarded');
    for (const status of [409, 404]) {
      await page.route('**/api/todos/*/embedding', async route => {
        const body = route.request().postDataJSON();
        if (body.title !== `Remote race ${status}`) return route.fallback();
        const url = route.request().url().replace(/\/embedding$/, '');
        const response = await context.request.fetch(url, status === 409
          ? {method: 'PUT', data: {title: 'Changed in another tab', icon: 'star'}} : {method: 'DELETE'});
        assert.ok(response.ok()); await route.continue();
      });
      const raced = await add(`Remote race ${status}`);
      await expect.poll(() => uploadResponses.includes(status)).toBe(true);
      await expect(raced.locator('.embedding-status')).toBeHidden();
      await expect(raced.locator('.embedding-feedback')).toBeHidden();
      await page.locator('#refresh-button').click(); await expect(page.locator('#refresh-button')).toBeEnabled();
    }
    await expect(unloaded.locator('.embedding-feedback')).toBeHidden();
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.some(item => item.title === 'No model needed')), false);
    await page.setViewportSize({width: 375, height: 700});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(external, [], 'Injected UI checks must stay offline');
    verifyDatabase = data => {
      assert.equal(data.find(item => item.title === 'No model needed').vector, null);
      assert.equal(data.find(item => item.title === 'Changed source').vector, null);
      assert.ok(!data.some(item => item.title === 'Delete before inference' || item.title === 'Remote race 404'));
      assert.equal(data.find(item => item.title === 'Changed in another tab').vector, null);
      for (const title of ['First queued task', 'Second queued task', 'Inference retry', 'Upload retry']) {
        assert.equal(data.find(item => item.title === title).vector.length, 768);
      }
    };
  } else if (mode === 'errors') {
    await seed('model_q4.onnx_data');
    await page.locator('#model-load').click();
    await expect(page.locator('#model-load')).toHaveText('Retry');
    await expect(page.locator('#model-error')).toContainText('cdn.jsdelivr.net');
    await expect(page.locator('#error')).toBeHidden();
    await add('Task after blocked runtime');
    blockRuntime = false;
    await externalWeightFailure();
    await seed();
    const deleted = await page.evaluate(async url => (await caches.open('transformers-cache')).delete(url), base + 'onnx/model_q4.onnx');
    assert.equal(deleted, true);
    blockedModelFile = 'model_q4.onnx';
    await page.locator('#model-load').click();
    await expect(page.locator('#model-load')).toHaveText('Retry');
    await expect(page.locator('#model-error')).toContainText('model download hosts');
    blockedModelFile = ''; await seed();
    await page.locator('#model-load').click(); await ready();
    const beforeReload = external.length;
    await page.reload(); await expect(page.locator('#model-load')).toHaveText('Load and test model');
    assert.equal(external.length, beforeReload, 'Reload eagerly fetched the model');
    await page.locator('#model-load').click(); await ready();
    assert.ok(external.slice(beforeReload).every(url => /\.m?js$/.test(url)), 'Model/tokenizer cache was not reused');
    const unsupported = await context.newPage();
    await unsupported.addInitScript(() => Object.defineProperty(navigator, 'gpu', {value: undefined}));
    const beforeUnsupported = external.length;
    await unsupported.goto(origin); await unsupported.locator('#model-load').click();
    await expect(unsupported.locator('#model-load')).toHaveText('Not supported');
    await expect(unsupported.locator('#model-error')).toContainText('WebGPU');
    assert.equal(external.length, beforeUnsupported);
    await unsupported.locator('#new-task').click(); await unsupported.locator('#todo-title').fill('Task without WebGPU');
    await unsupported.locator('#todo-title').press('Enter');
    await expect(unsupported.getByRole('button', {name: 'Edit Task without WebGPU', exact: true})).toBeVisible();
  } else if (mode === 'external-error') {
    await seed('model_q4.onnx_data');
    await externalWeightFailure();
    blockedModelFile = ''; await seed();
    await page.locator('#model-load').click(); await ready();
    const phases = await page.evaluate(() => window.__modelPhases);
    assert.ok(phases.includes('error')); assert.equal(phases.at(-1), 'ready');
  } else if (mode === 'flows') {
    await page.locator('#model-load').click(); await expect(page.locator('#model-load')).toHaveText('Retry');
    const row = await add('Original task'); const other = await add('Another task');
    await row.locator('.task-title').click(); await row.locator('.task-editor').fill('Edited task');
    await row.locator('.task-editor').press('Enter'); await expect(row.locator('.task-title')).toHaveText('Edited task');
    await row.locator('.icon-button').click(); await row.getByRole('button', {name: 'Star', exact: true}).click();
    const checkbox = row.locator('.task-completion'); await expect(checkbox).toBeEnabled();
    await checkbox.check(); await expect(checkbox).toBeEnabled();
    await page.reload(); await expect(checkbox).toBeChecked();
    assert.equal((await saved()).find(task => task.title === 'Edited task').icon, 'star');
    await row.locator('.task-title').click(); await row.locator('.task-editor').fill('Preserved draft');
    await checkbox.uncheck(); await expect(checkbox).toBeEnabled();
    await expect(row.locator('.task-editor')).toHaveValue('Preserved draft');
    await page.locator('#refresh-button').click(); await expect(page.locator('#refresh-button')).toBeEnabled();
    await expect(row.locator('.task-editor')).toHaveValue('Preserved draft');
    assert.equal((await saved()).find(task => task.title === 'Edited task').completed, false);
    let failPatch = true;
    await page.route('**/api/todos/*', async route => {
      if (failPatch && route.request().method() === 'PATCH') {failPatch = false; await route.fulfill({status: 503, contentType: 'application/json', body: '{"detail":"Completion temporarily failed"}'});}
      else await route.continue();
    });
    await checkbox.check(); await expect(row.locator('.row-feedback:not(.embedding-feedback)')).toBeVisible();
    await expect(checkbox).not.toBeChecked(); await expect(row.locator('.task-editor')).toHaveValue('Preserved draft');
    await row.locator('.row-feedback:not(.embedding-feedback) .retry').click(); await expect(checkbox).toBeChecked(); await expect(checkbox).toBeEnabled();
    await expect(row.locator('.task-editor')).toHaveValue('Preserved draft');
    await row.locator('.remove').click(); await expect(row).toHaveCount(0);
    await expect(other).toBeVisible(); assert.equal((await saved()).length, 1);
    await other.locator('.remove').click(); await expect(page.locator('.task-row')).toHaveCount(0);
    assert.deepEqual(await saved(), []);
    await page.setViewportSize({width: 375, height: 700});
    await page.locator('#model-load').click(); await expect(page.locator('#model-load')).toHaveText('Retry');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  } else throw Error('Unknown browser scenario: ' + mode);
  console.log('PASS', mode, cold ? 'cold downloads' : 'verified cached assets');
} finally {
  releaseRuntime?.(); clearTimeout(timeout); await browser?.close();
  fixtureServer.closeAllConnections(); await new Promise(resolve => fixtureServer.close(resolve));
  const stopped = new Promise(resolve => {if (server.exitCode !== null) resolve(); else server.once('exit', resolve);});
  server.kill('SIGTERM'); await stopped;
  try {
    if (verifyDatabase) {
      // DuckDB permits one writer process. Inspect only after stopping FastAPI,
      // then reopen the app to verify that persisted vectors survive startup.
      const result = spawnSync(process.env.MODEL_TEST_PYTHON, ['-c', `import json, sys, duckdb
from fastapi.testclient import TestClient
from app.main import create_app
with TestClient(create_app(sys.argv[1])) as client:
    assert client.get('/api/todos').status_code == 200
with duckdb.connect(sys.argv[1]) as db:
    rows = db.execute('SELECT id, title, icon, embedding, embedding_model, embedding_revision, embedding_input_version, embedding_dimensions FROM todos ORDER BY created_at, id').fetchall()
print(json.dumps([dict(zip(('id', 'title', 'icon', 'vector', 'model', 'revision', 'input_version', 'dimensions'), row)) for row in rows]))`, `${directory}/todos.duckdb`], {cwd: root, encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
      verifyDatabase(JSON.parse(result.stdout));
    }
  } finally {await rm(directory, {recursive: true, force: true});}
}
"""


def run_browser(mode):
    environment = {**os.environ, "MODEL_PROJECT_ROOT": str(ROOT), "MODEL_TEST_PYTHON": sys.executable}
    result = subprocess.run(
        [node_executable(), "--input-type=module", "-e", BROWSER_CHECK, mode],
        cwd=ROOT, env=environment, capture_output=True, text=True,
        timeout=290 if environment.get("MODEL_COLD_DOWNLOAD") == "1" else 28,
    )
    assert result.returncode == 0, result.stdout + result.stderr


browser_check = pytest.mark.skipif(os.environ.get("MODEL_BROWSER_CHECK") != "1",
                                   reason="Set MODEL_BROWSER_CHECK=1 after installing browser fixtures.")


@browser_check
def test_real_model_and_tasks_remain_usable():
    run_browser("real")


@browser_check
def test_browser_model_failures_retry_and_cache():
    run_browser("errors")


@browser_check
def test_external_weight_download_failure_permits_retry():
    run_browser("external-error")


@browser_check
def test_task_flows_and_drafts_with_model_panel():
    run_browser("flows")


@browser_check
def test_real_task_embeddings_include_first_title_and_icon():
    run_browser("embeddings")


@browser_check
def test_embedding_creation_retries_and_races():
    run_browser("embedding-flows")


if __name__ == "__main__":
    if sys.argv[1:] == ["--download-fixtures"]:
        subprocess.run(
            [node_executable(), "--input-type=module", "-e", BROWSER_CHECK, "download"],
            cwd=ROOT, env={**os.environ, "MODEL_PROJECT_ROOT": str(ROOT)}, check=True, timeout=600,
        )
    elif sys.argv[1:] == ["--check-regressions"]:
        # Only one of these jobs runs real inference. Keep it free of another
        # software-GPU load while fitting the independently rerun 30-second check.
        with ThreadPoolExecutor(max_workers=3) as pool:
            jobs = [pool.submit(subprocess.run,
                [sys.executable, "-m", "pytest", str(ROOT / "tests"), "-q", "-p", "no:cacheprovider"],
                cwd=ROOT, env={**os.environ, "MODEL_BROWSER_CHECK": "0"}, check=True, timeout=28),
                pool.submit(run_browser, "errors"), pool.submit(run_browser, "flows")]
            for job in jobs:
                job.result()
        print("Python, Node, task-flow, cached-loading and responsive-control checks passed.")
    else:
        raise SystemExit("Usage: python tests/test_model_assets.py --download-fixtures | --check-regressions")
