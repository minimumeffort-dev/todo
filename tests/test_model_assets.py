"""Static distribution checks and opt-in browser integration with real inference."""

import os
from pathlib import Path
import shutil
import signal
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
    assert html.index('id="model-panel"') < html.index("<main>") < html.index("<h1>")
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
    subprocess.run([node_executable(), "--test", str(ROOT / "tests/model_runtime.test.mjs"),
                    str(ROOT / "tests/model_panel.test.mjs")],
                   check=True, capture_output=True, text=True, timeout=10)


def node_executable():
    configured = os.environ.get("MODEL_TEST_NODE")
    installed = shutil.which("node")
    managed = sorted((Path.home() / ".local/share/mise/installs/node").glob("22*/bin/node"))
    result = configured or installed or (str(managed[-1]) if managed else "")
    if not Path(result).is_file():
        pytest.fail("Install Node 22 (mise install node@22) or set MODEL_TEST_NODE.")
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
const {chromium, webkit, expect} = await import(pathToFileURL(`${root}/.venv/model-browser/node_modules/playwright/test.mjs`));
const browserName = process.env.MODEL_TEST_BROWSER ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(browserName));
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

if (mode === 'real') for (const file of files) {
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
const directory = await mkdtemp('/tmp/todo-search-integration-');
const server = spawn(process.env.MODEL_TEST_PYTHON, ['-u', '-c', `import socket, uvicorn
s = socket.socket(); s.bind(('127.0.0.1', 0)); print('PORT:'+str(s.getsockname()[1]), flush=True)
uvicorn.run('app.main:app', fd=s.fileno(), log_level='warning')`],
  {cwd: root, env: {...process.env, TODO_DB_PATH: `${directory}/todos.duckdb`}});
let browser;
let browserServer;
let timeout;
let releaseRuntime;
let verifyDatabase;
try {
  const port = await new Promise((resolve, reject) => {
    server.stdout.on('data', chunk => {const match = String(chunk).match(/PORT:(\d+)/); if (match) resolve(match[1]);});
    server.stderr.on('data', chunk => process.stderr.write(chunk));
    server.once('exit', code => reject(Error(`FastAPI exited: ${code}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; ++attempt) {
    try {if ((await fetch(origin + '/health')).ok) break;} catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve));
  const fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  const engine = browserName === 'webkit' ? webkit : chromium;
  browserServer = await engine.launchServer(browserName === 'chromium'
    ? {channel: 'chromium', headless: true,
      args: ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-webgpu-developer-features']}
    : {headless: true});
  browser = await engine.connect(browserServer.wsEndpoint());
  timeout = setTimeout(() => {void browserServer.kill();}, 27000);
  const context = await browser.newContext();
  context.setDefaultTimeout(5000);
  const external = [];
  const creations = [];
  const uploads = [];
  const uploadResponses = [];
  const sourceWrites = [];
  context.on('request', request => {
    if (request.url().startsWith('https://')) external.push(request.url());
    if (request.method() === 'POST' && request.url().endsWith('/api/todos')) creations.push(request.postDataJSON());
    if (request.method() === 'PUT' && request.url().endsWith('/embedding')) {
      uploads.push({id: new URL(request.url()).pathname.split('/')[3], ...request.postDataJSON()});
    } else if (request.method() === 'PUT' && /\/api\/todos\//.test(request.url())) sourceWrites.push(request.postDataJSON());
  });
  context.on('response', response => {
    if (response.request().method() === 'PUT' && response.url().endsWith('/embedding')) uploadResponses.push(response.status());
  });
  if (process.env.MODEL_BROWSER_DEBUG === '1') context.on('requestfinished', request => console.log('FINISHED', request.method(), request.url()));
  await context.addInitScript(() => {
    window.__modelMessages = [];
    window.__modelResults = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options); this.isModel = String(url).includes('/model-worker.mjs');
        if (this.isModel) this.addEventListener('message', event => {
          const result = {id: event.data.id, type: event.data.type, phase: event.data.phase, at: performance.now()};
          window.__modelResults.push(result);
          console.log('MODEL', JSON.stringify(result));
        });
      }
      postMessage(message, ...rest) {
        if (this.isModel) window.__modelMessages.push(message);
        return super.postMessage(message, ...rest);
      }
    };
  });
  if (['flows', 'focus'].includes(mode)) {
    // Inject only inference/lifecycle for deterministic races; use the real DOM,
    // app orchestration, HTTP endpoints and DuckDB. The real mode below uses
    // authentic model inference without replacing its inputs or outputs.
    await context.route('**/static/model-runtime.mjs', route => route.fulfill({contentType: 'text/javascript', body: `
const artifact = ${JSON.stringify(MODEL_ARTIFACT)};
const controls = window.__embeddingFixture = {calls: [], queries: [], pending: [], hold: true, failNext: 0, loads: 0};
const listeners = new Set();
let state = {phase: 'idle', progress: null, message: ''};
let finishLoad;
function publish(phase, message = '') {state = {phase, progress: phase === 'ready' ? 1 : null, message}; for (const listener of listeners) listener(state);}
function metadata(vector) {return {vector, model: artifact.id, revision: artifact.revision, input_version: 1, dimensions: artifact.dimensions};}
function vector(text) {const data = Array(768).fill(0); data[/space/i.test(text) ? 2 : /book/i.test(text) ? 1 : 0] = 1; return data;}
controls.loading = () => publish('loading');
controls.error = () => {publish('error', 'Injected model loading failure'); finishLoad?.();};
controls.ready = () => {publish('testing'); publish('ready'); finishLoad?.();};
controls.release = () => {controls.hold = false; const pending = controls.pending.splice(0); for (const item of pending) item.resolve(item.result);};
export const modelRuntime = {
  subscribe(listener) {listeners.add(listener); listener(state); return () => listeners.delete(listener);},
  loadAndTest() {controls.loads++; publish('loading'); return new Promise(resolve => {finishLoad = resolve;});},
  dispose() {publish('idle');},
  embedQuery(query) {controls.queries.push(query); return Promise.resolve(metadata(vector(query)));},
  embedTask(source) {
    source = {...source}; controls.calls.push(source);
    if (controls.failNext > 0) {controls.failNext--; return Promise.reject(Error('Injected inference failure'));}
    const result = {...source, ...metadata(vector(source.title))};
    return controls.hold ? new Promise(resolve => controls.pending.push({source, result, resolve})) : Promise.resolve(result);
  },
};` }));
  }
  let failRuntime = mode === 'real';
  const runtimeGate = new Promise(resolve => {releaseRuntime = resolve;});
  await context.route('https://**', async route => {
    if (mode !== 'real') {await route.abort(); return;}
    const url = route.request().url();
    if (url === TRANSFORMERS_URL) {
      await runtimeGate;
      if (failRuntime) {await route.abort(); return;}
    }
    const file = files.find(file => file.url === url && /\.m?js$/.test(file.name));
    if (!file) {await route.abort(); return;}
    await route.fulfill({path: file.path, contentType: 'text/javascript', headers: {'Access-Control-Allow-Origin': '*'}});
  });
  async function api(path, options = {}) {
    const response = await context.request.fetch(origin + path, options);
    assert.ok(response.ok(), `${options.method ?? 'GET'} ${path}: ${response.status()}`);
    return response.status() === 204 ? null : response.json();
  }
  async function create(title, icon = 'task') {return api('/api/todos', {method: 'POST', data: {title, icon}});}
  const groceries = await create(mode === 'real' ? 'Buy groceries' : 'Old groceries', 'shopping');
  const book = await create(mode === 'real' ? 'Read a novel' : 'Read a science fiction book', 'star');
  if (['flows', 'focus'].includes(mode)) {
    const vector = Array(768).fill(0); vector[1] = 1;
    await api(`/api/todos/${book.id}/embedding`, {method: 'PUT', data: {...book, id: undefined, completed: undefined,
      vector, model: MODEL_ARTIFACT.id, revision: MODEL_ARTIFACT.revision, input_version: 1, dimensions: 768}});
  }
  const page = await context.newPage();
  if (process.env.MODEL_BROWSER_DEBUG === '1') page.on('console', message => console.log('BROWSER', message.type(), message.text()));
  function responseFor(path, method, matches = () => true) {
    return page.waitForResponse(async response => {
      const request = response.request();
      const pathname = new URL(response.url()).pathname;
      return response.url().startsWith(origin + '/') && request.method() === method
        && (typeof path === 'string' ? pathname === path : path.test(pathname)) && await matches(request, response);
    }, {timeout: mode === 'real' ? 25000 : 5000});
  }
  async function completed(responsePromise, status = 200) {
    const response = await responsePromise;
    assert.equal(response.status(), status, `${response.request().method()} ${response.url()}`);
    if (process.env.MODEL_BROWSER_DEBUG === '1') console.log('AWAIT BODY', status, response.request().method(), response.url());
    // A 204 is complete at its headers and has no body. Chromium does not emit
    // loadingFinished for these fetches; callers also assert the completed UI.
    if (status === 204) assert.equal(response.headers()['content-length'] ?? '0', '0');
    else assert.equal(await response.finished(), null, 'Response body did not finish successfully');
    if (process.env.MODEL_BROWSER_DEBUG === '1') console.log('COMPLETE', status, response.request().method(), response.url());
    return response;
  }
  function deferred() {
    let resolve;
    const promise = new Promise(finish => {resolve = finish;});
    return {promise, resolve};
  }
  async function holdRequest(path, method) {
    const captured = deferred();
    const handler = route => {
      if (route.request().method() !== method) return route.fallback();
      captured.resolve(route);
    };
    await page.route(origin + path, handler);
    return {
      captured: captured.promise,
      async release() {
        await (await captured.promise).continue();
        await page.unroute(origin + path, handler);
      },
    };
  }
  async function holdSearchResponse() {
    const captured = deferred();
    const gate = deferred();
    let request;
    // Register before triggering the query; request identity distinguishes
    // the held reply even when a later query has the same vector.
    const delivered = page.waitForResponse(response => response.request() === request);
    const handler = async route => {
      request = route.request();
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      captured.resolve(await response.json());
      await gate.promise;
      await route.fulfill({response});
    };
    await page.route(origin + '/api/todos/search', handler, {times: 1});
    return {
      captured: captured.promise,
      async release() {
        gate.resolve();
        await completed(delivered);
        // Flush the page's response handlers before asserting obsolete replies
        // cannot change the rendered result. This is not a timing delay.
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await page.unroute(origin + '/api/todos/search', handler);
      },
    };
  }
  const initialList = responseFor('/api/todos', 'GET');
  await page.goto(origin);
  await completed(initialList);
  const row = id => page.locator(`li[data-id="${id}"]`);
  const first = row(groceries.id);
  const second = row(book.id);
  await expect(first).toBeVisible(); await expect(second).toBeVisible();
  await expect(page.locator('#model-panel')).toHaveClass(/is-busy/);
  await expect(page.locator('#model-progress')).toBeVisible();
  await expect(page.locator('#model-load')).toBeHidden();
  assert.equal(await page.locator('#model-panel').evaluate(element => !!element.closest('.card')), false);
  assert.equal(await page.locator('#model-panel').evaluate(element => element.parentElement === document.body
    && Boolean(element.compareDocumentPosition(document.querySelector('main')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  assert.equal(await page.locator('footer').count(), 0);
  await expect(page.getByRole('searchbox', {name: 'Search tasks'})).toBeEnabled();
  await expect(page.locator('#refresh-button')).toBeEnabled();
  async function add(title) {
    if (await page.locator('#todo-form').isHidden()) await page.locator('#new-task').click();
    await page.locator('#todo-title').fill(title);
    const creation = responseFor('/api/todos', 'POST', request => request.postDataJSON().title === title);
    // Force the ordering that exposed the old helper's premature GET: while
    // creation is held, the saved list must still omit the new task.
    const held = mode === 'flows' && title === 'Upload retry' ? await holdRequest('/api/todos', 'POST') : null;
    await page.locator('#todo-title').press('Enter');
    if (held) {
      await held.captured;
      await expect(page.locator('#todo-form')).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#add-button')).toBeDisabled();
      assert.equal((await api('/api/todos')).some(item => item.title === title), false);
      await held.release();
    }
    const saved = await (await completed(creation, 201)).json();
    assert.equal(saved.title, title);
    assert.equal(saved.icon, 'task');
    assert.equal(saved.completed, false);
    const result = row(saved.id);
    await expect(result).toBeVisible();
    await expect(result.locator('.task-title')).toHaveText(title);
    await expect(page.locator('#todo-form')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#todo-title')).toHaveValue('');
    return result;
  }
  async function completeTask(task) {
    const id = await task.getAttribute('data-id');
    const response = responseFor(`/api/todos/${id}`, 'PATCH', request => request.postDataJSON().completed === true);
    await task.locator('.task-completion').check();
    const saved = await (await completed(response)).json();
    assert.equal(saved.id, id); assert.equal(saved.completed, true);
    await expect(task.locator('.task-completion')).toBeEnabled();
    await expect(task.locator('.task-completion')).toBeChecked();
    await expect(task).toHaveClass(/is-completed/);
  }
  async function ready() {
    await expect(page.locator('#model-status')).toHaveText('Model ready.', {timeout: 16000});
    await expect(page.locator('#model-load')).toBeHidden();
    await expect(page.locator('#model-error')).toBeHidden();
  }
  async function indexed() {
    try {
      await expect.poll(async () => (await api('/api/todos/embeddings/pending')).length, {timeout: 15000}).toBe(0);
    } catch (error) {
      console.log('INDEX STATE', await page.evaluate(() => ({
        messages: window.__modelMessages,
        results: window.__modelResults,
        status: document.querySelector('#model-status').textContent,
        feedback: [...document.querySelectorAll('.embedding-feedback')].map(element => ({hidden: element.hidden, text: element.textContent})),
      })), 'UPLOADS', uploadResponses);
      throw error;
    }
  }
  async function search(text, preserveFocus = false) {
    if (preserveFocus) await page.evaluate(text => {
      const input = document.querySelector('#todo-search'); input.value = text; input.dispatchEvent(new Event('input', {bubbles: true}));
    }, text);
    else await page.locator('#todo-search').fill(text);
  }
  const guidanceSamples = [];
  async function renderedSearch(responsePromise) {
    const result = await (await completed(responsePromise)).json();
    assert.ok(Number.isFinite(result.min_score) && result.min_score >= -1 && result.min_score <= 1);
    assert.ok(result.matches.every(match => Number.isFinite(match.score) && match.score >= result.min_score && match.score <= 1));
    const count = result.matches.length;
    const summary = count ? `${count} results` : 'No matching tasks';
    await expect(page.locator('#search-status')).toHaveText(result.pending_count > 0
      ? `${summary} · ${result.pending_count} tasks still being indexed` : summary);
    if (count) await expect(page.locator('.task-row:visible').first()).toHaveAttribute('data-id', result.matches[0].todo.id);
    for (const match of result.matches) {
      await expect(row(match.todo.id).locator('.similarity')).toHaveText(`Similarity ${match.score.toFixed(2)}`);
      await expect(row(match.todo.id).locator('.nonmatch')).toBeHidden();
    }
    await expect(page.locator('.similarity:visible')).toHaveCount(count);
    if (count) {
      await expect(page.locator('#search-explain')).toBeVisible();
      await expect(page.locator('#search-explain')).toContainText('closer meaning, not confidence');
      guidanceSamples.push({text: await page.locator('#search-explain').innerText(), minScore: result.min_score});
    } else await expect(page.locator('#search-explain')).toBeHidden();
    return result;
  }
  async function assertSearchCleared() {
    await expect(page.locator('#todo-search')).toHaveValue('');
    await expect(page.locator('#search-status')).toBeHidden();
    await expect(page.locator('#search-clear')).toBeHidden();
    await expect(page.locator('#search-explain')).toBeHidden();
    await expect(page.locator('.similarity:visible, .nonmatch:visible')).toHaveCount(0);
    assert.ok((await page.locator('.similarity').allTextContents()).every(text => text === ''));
  }
  async function layout(name) {
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const bar = await page.locator('#model-panel').boundingBox();
    assert.equal(bar.x, 0); assert.equal(bar.y, 0); assert.equal(bar.width, page.viewportSize().width);
    assert.ok(bar.y + bar.height < (await page.locator('h1').boundingBox()).y);
    await expect(page.locator('#todo-search')).toHaveAttribute('type', 'search');
    await expect(page.locator('.search-row button')).toHaveCount(1);
    // Chromium's user-agent shadow tree contains the native cancel control.
    // Inspect its computed style rather than counting only authored DOM buttons.
    if (browserName === 'chromium') {
      const cdp = await context.newCDPSession(page);
      const {root: dom} = await cdp.send('DOM.getDocument', {depth: -1, pierce: true});
      function find(node, predicate) {
        if (predicate(node)) return node;
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
          const found = find(child, predicate); if (found) return found;
        }
      }
      const input = find(dom, node => node.attributes?.includes('todo-search'));
      const cancel = find(input, node => node.attributes?.includes('search-clear')
        || node.attributes?.includes('-webkit-search-cancel-button') || node.pseudoType === 'search-cancel-button');
      if (cancel) {
        await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
        const {computedStyle} = await cdp.send('CSS.getComputedStyleForNode', {nodeId: cancel.nodeId});
        assert.equal(computedStyle.find(item => item.name === 'display').value, 'none');
      } else {
        assert.equal(await page.locator('#todo-search').evaluate(element => {
          return [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).some(rule =>
            rule.selectorText?.includes('#todo-search::-webkit-search-cancel-button') && rule.style.display === 'none');
        }), true);
      }
      await cdp.detach();
    } else {
      assert.equal(await page.locator('#todo-search').evaluate(() =>
        [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).some(rule =>
          rule.selectorText?.includes('#todo-search::-webkit-search-cancel-button') && rule.style.display === 'none')), true);
    }
    await mkdir(`${root}/.venv/browser-screenshots`, {recursive: true});
    await page.screenshot({path: `${root}/.venv/browser-screenshots/${browserName}-${mode}-${process.env.MODEL_REAL_QUERY}-${name}.png`, fullPage: true});
  }
  const loadingTask = mode === 'flows' ? await add('Schedule a dental checkup') : null;
  if (loadingTask) {
    await completeTask(loadingTask);
  } else await page.locator('#new-task').click();
  await page.locator('#todo-title').fill('Preserved composer draft');
  if (mode === 'flows') {
    await search('food');
    await expect(page.locator('#search-status')).toContainText('Waiting for the model');
  }
  if (mode === 'real') {
    assert.equal((await page.evaluate(() => window.__modelMessages)).filter(message => message.type === 'load-and-test').length, 1,
      'The page must activate the model automatically exactly once');
    // Populate the normal origin cache with verified downloaded bytes while the
    // first SDK request is gated, then exercise failure/retry with the real worker.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Storage.overrideQuotaForOrigin', {origin, quotaSize: 1024 * 1024 * 1024});
    await page.evaluate(async ({files, fixtureOrigin}) => {
      const cache = await caches.open('transformers-cache');
      await Promise.all(files.map(async file => {
        const response = await fetch(fixtureOrigin + '/' + file.name);
        if (!response.ok) throw Error('Missing authentic fixture ' + file.name);
        await cache.put(file.url, new Response(response.body, {headers: {'Content-Length': response.headers.get('Content-Length')}}));
      }));
    }, {files: files.map(({name, url}) => ({name, url})), fixtureOrigin});
    releaseRuntime();
    await expect(page.locator('#model-load')).toHaveText('Retry');
    await expect(page.locator('#model-error')).toContainText('cdn.jsdelivr.net');
    await expect(page.locator('#error')).toBeHidden();
    failRuntime = false;
    const tasks = [groceries, book];
    const taskUploads = tasks.map(task => responseFor(`/api/todos/${task.id}/embedding`, 'PUT'));
    await page.locator('#model-load').click();
    await ready(); await indexed();
    for (const response of taskUploads) await completed(response, 204);
    await expect(first.locator('.embedding-status')).toBeHidden();
    await expect(second.locator('.embedding-status')).toBeHidden();
    await expect(page.locator('#todo-title')).toHaveValue('Preserved composer draft');
    assert.equal(uploadResponses.filter(status => status === 204).length, tasks.length);
    assert.deepEqual(uploads.map(item => item.title).sort(), tasks.map(task => task.title).sort());
    for (const upload of uploads) {
      assert.equal(upload.vector.length, 768); assert.ok(upload.vector.every(Number.isFinite));
      assert.ok(upload.vector.some(value => value !== 0));
      assert.equal(upload.model, MODEL_ARTIFACT.id); assert.equal(upload.revision, MODEL_ARTIFACT.revision);
      assert.equal(upload.input_version, 1);
    }
    await completeTask(first);
    // Each authentic scenario runs in its own command. SwiftShader's initial
    // compilation is expensive; keep every check below the VM's 30-second cap.
    const scenarios = {
      groceries: ['purchase food', groceries],
      book: ['read a story', book],
      none: ['repair the spacecraft engine', null],
    };
    const selected = process.env.MODEL_REAL_QUERY ?? 'groceries';
    assert.ok(Object.hasOwn(scenarios, selected) || selected === 'cache', 'Unknown real-model query fixture');
    if (selected !== 'cache') {
      const [query, expected] = scenarios[selected];
      const queryResponse = responseFor('/api/todos/search', 'POST');
      await search(query);
      const response = await queryResponse;
      const vector = response.request().postDataJSON().vector;
      const scores = uploads.map(upload => {
        const dot = vector.reduce((sum, value, index) => sum + value * upload.vector[index], 0);
        const norm = values => Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
        return {id: upload.id, title: upload.title, score: dot / (norm(vector) * norm(upload.vector))};
      });
      console.log('COSINE', JSON.stringify({query, scores}));
      const result = await renderedSearch(Promise.resolve(response));
      assert.equal(result.pending_count, 0);
      assert.deepEqual(result.matches.map(match => match.todo.id), expected ? [expected.id] : []);
      assert.deepEqual(scores.filter(item => item.score >= result.min_score).map(item => item.id),
        expected ? [expected.id] : []);
      for (const match of result.matches) {
        assert.ok(Math.abs(match.score - scores.find(item => item.id === match.todo.id).score) < 1e-6);
      }
      if (expected) await expect(page.locator('.task-row:visible .task-title')).toHaveText(expected.title);
      else await expect(page.locator('.task-row:visible')).toHaveCount(0);
    }
    await layout('desktop');
    const desktopSize = page.viewportSize();
    await page.setViewportSize({width: 375, height: 700});
    await layout('narrow-search');
    await page.setViewportSize(desktopSize);
    await page.locator('#todo-search').press('Escape'); await assertSearchCleared();
    assert.deepEqual(await page.locator('.task-row:visible').evaluateAll(rows => rows.map(row => row.dataset.id)), tasks.map(task => task.id));
    if (selected === 'cache') {
      const beforeReload = external.length;
      const reloadedList = responseFor('/api/todos', 'GET');
      await page.reload();
      await completed(reloadedList);
      await expect(row(groceries.id).locator('.task-title')).toHaveText(groceries.title);
      await expect(row(groceries.id)).toHaveClass(/is-completed/);
      // Testing starts only after the fresh worker has loaded its configuration,
      // tokenizer and weights. That proves cache reuse without waiting for a
      // second nine-second SwiftShader sample; the first sample already passed.
      await expect(page.locator('#model-status')).toHaveText(/Testing model…|Model ready\./, {timeout: 10000});
      await indexed();
      assert.equal((await page.evaluate(() => window.__modelMessages)).filter(message => message.type === 'load-and-test').length, 1);
      assert.equal((await page.evaluate(() => window.__modelMessages)).filter(message => message.type === 'embed-task').length, 0,
        'Current embeddings must be reused after reload');
      assert.ok(external.slice(beforeReload).every(url => /\.m?js$/.test(url)), 'Cached tokenizer/weights were downloaded again');
      assert.equal(uploads.length, tasks.length, 'Reload must not re-embed current tasks');
      if (process.env.MODEL_BROWSER_DEBUG === '1') console.log('MODEL TIMINGS', await page.evaluate(() => window.__modelResults));
      const unsupported = await context.newPage();
      await unsupported.addInitScript(() => Object.defineProperty(navigator, 'gpu', {value: undefined}));
      const unsupportedList = unsupported.waitForResponse(response => response.url() === origin + '/api/todos'
        && response.request().method() === 'GET');
      await unsupported.goto(origin);
      await completed(unsupportedList);
      await expect(unsupported.locator(`li[data-id="${groceries.id}"] .task-title`)).toHaveText(groceries.title);
      await expect(unsupported.locator('#model-error')).toContainText('WebGPU');
      await expect(unsupported.locator('#todo-search')).toBeEnabled();
      await expect(unsupported.locator('#new-task')).toBeEnabled();
      await unsupported.locator('#todo-search').fill('food');
      await expect(unsupported.locator('#search-status')).toHaveText('Search unavailable. Retry the model.');
    }
    verifyDatabase = data => {
      assert.equal(data.length, tasks.length);
      for (const task of data) {
        const upload = uploads.find(item => item.id === task.id);
        assert.ok(upload); assert.deepEqual(task.vector, upload.vector);
        assert.equal(task.revision, MODEL_ARTIFACT.revision); assert.equal(task.dimensions, 768);
      }
    };
  } else if (mode === 'focus') {
    const firstUpload = responseFor(`/api/todos/${groceries.id}/embedding`, 'PUT');
    await page.evaluate(() => {window.__embeddingFixture.release(); window.__embeddingFixture.ready();});
    await ready(); await completed(firstUpload, 204); await indexed();
    async function bookSearch(preserveFocus = false) {
      const response = responseFor('/api/todos/search', 'POST', request => request.postDataJSON().vector[1] === 1);
      await search('book', preserveFocus);
      return renderedSearch(response);
    }
    async function clear() {await page.locator('#search-clear').click(); await assertSearchCleared();}
    async function retained(task) {
      await expect(task).toBeVisible();
      await expect(task.locator('.nonmatch')).toBeVisible();
      await expect(task.locator('.nonmatch')).toHaveText('Not a search match');
      await expect(task.locator('.similarity')).toBeHidden();
      await expect(page.locator('#search-status')).toHaveText(/^1 results(?: · \d+ tasks still being indexed)?$/);
      await expect(page.locator('.similarity:visible')).toHaveCount(1);
    }
    // Focus alone protects a nonmatch. Losing focus must hide it promptly.
    // Change only response metadata to prove guidance consumes the cutoff
    // rather than repeating the current backend constant in browser code.
    await page.route(origin + '/api/todos/search', async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.fulfill({response, json: {...await response.json(), min_score: 0.83}});
    }, {times: 1});
    await first.locator('.task-title').focus();
    await bookSearch(true); await retained(first);
    await expect(first.locator('.task-title')).toBeFocused();
    await layout('desktop-retained');
    await page.setViewportSize({width: 375, height: 700}); await layout('narrow-retained');
    // Blurring to the body fires focusout without a later focusin. The row
    // must lose focus protection even when no other control receives focus.
    await first.locator('.task-title').evaluate(element => element.blur());
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    await expect(first).toBeHidden(); await clear();
    // Search reordering keeps a live draft and selection without submitting it.
    await first.locator('.task-title').click(); await first.locator('.task-editor').fill('Local unsaved draft');
    await first.locator('.task-editor').evaluate(element => element.setSelectionRange(2, 5));
    const writes = sourceWrites.length;
    await bookSearch(true); await retained(first);
    await expect(first.locator('.task-editor')).toBeFocused();
    assert.deepEqual(await first.locator('.task-editor').evaluate(element => [element.selectionStart, element.selectionEnd]), [2, 5]);
    assert.equal(sourceWrites.length, writes);
    await first.locator('.task-editor').press('Escape');
    await page.locator('#todo-search').focus(); await expect(first).toBeHidden(); await clear();
    // Failed saves remain retryable and unscored while filtering excludes them.
    await first.locator('.task-title').click(); await first.locator('.task-editor').fill('Saved retry source');
    await page.route(origin + `/api/todos/${groceries.id}`, route => route.fulfill({status: 503,
      contentType: 'application/json', body: '{"detail":"Save temporarily failed"}'}), {times: 1});
    const failedSave = responseFor(`/api/todos/${groceries.id}`, 'PUT');
    await first.locator('.task-editor').press('Enter'); await completed(failedSave, 503);
    await bookSearch(true); await retained(first);
    const saveFeedback = first.locator('.row-feedback:not(.embedding-feedback)');
    await expect(saveFeedback).toBeVisible();
    await expect(first.locator('.task-editor')).toHaveValue('Saved retry source');
    const retriedSave = responseFor(`/api/todos/${groceries.id}`, 'PUT');
    const savedUpload = responseFor(`/api/todos/${groceries.id}/embedding`, 'PUT');
    await saveFeedback.locator('.retry').click(); await completed(retriedSave); await completed(savedUpload, 204);
    await expect(saveFeedback).toBeHidden();
    await expect(first.locator('.task-title')).toHaveText('Saved retry source');
    await bookSearch(); await expect(first).toBeHidden(); await clear();
    // A controlled pending completion protects a row even after focus leaves.
    const completionGate = await holdRequest(`/api/todos/${groceries.id}`, 'PATCH');
    const completionResponse = responseFor(`/api/todos/${groceries.id}`, 'PATCH');
    await first.locator('.task-completion').focus(); await first.locator('.task-completion').press('Space');
    await completionGate.captured;
    await bookSearch(); await retained(first); await expect(first).toHaveAttribute('aria-busy', 'true');
    const settledSearch = responseFor('/api/todos/search', 'POST');
    await completionGate.release(); await completed(completionResponse); await renderedSearch(settledSearch);
    await expect(first).toBeHidden(); await clear();
    // Indexing failures retain a working retry without counting as a match.
    await page.evaluate(() => {window.__embeddingFixture.failNext = 1;});
    const processing = await add('Processing retry');
    await expect(processing.locator('.embedding-feedback')).toBeVisible();
    await bookSearch(); await retained(processing);
    const creationsBeforeRetry = creations.length;
    const retryUpload = responseFor(`/api/todos/${await processing.getAttribute('data-id')}/embedding`, 'PUT');
    const retryGate = await holdRequest(`/api/todos/${await processing.getAttribute('data-id')}/embedding`, 'PUT');
    await processing.locator('.embedding-retry').click(); await retryGate.captured;
    // Clearing the error must not hide a pending retry after focus leaves.
    // Keep its actual upload held so this state cannot disappear prematurely.
    await page.locator('#todo-search').focus(); await retained(processing);
    await expect(processing.locator('.embedding-feedback')).toBeHidden();
    await expect(processing.locator('.embedding-status')).toHaveText('Processing…');
    const afterRetrySearch = responseFor('/api/todos/search', 'POST');
    await retryGate.release(); await completed(retryUpload, 204);
    await expect(processing).toBeHidden();
    await renderedSearch(afterRetrySearch);
    await expect(processing.locator('.embedding-feedback')).toBeHidden();
    await page.locator('#todo-search').focus(); await expect(processing).toBeHidden();
    assert.equal(creations.length, creationsBeforeRetry); await clear();
    // A hidden next neighbour must not prevent focus moving to a visible row.
    const lastMatch = await add('Read another book'); await indexed();
    const matches = await bookSearch();
    assert.deepEqual(matches.matches.map(match => match.todo.id), [book.id, await lastMatch.getAttribute('data-id')]);
    const removeLast = responseFor(`/api/todos/${await lastMatch.getAttribute('data-id')}`, 'DELETE');
    const remainingSearch = responseFor('/api/todos/search', 'POST');
    await lastMatch.locator('.remove').focus(); await lastMatch.locator('.remove').press('Enter');
    await completed(removeLast, 204); await expect(lastMatch).toHaveCount(0);
    await expect(second.locator('.task-title')).toBeFocused(); await expect(second).toBeVisible();
    await renderedSearch(remainingSearch);
    const removeOnly = responseFor(`/api/todos/${book.id}`, 'DELETE');
    const emptySearch = responseFor('/api/todos/search', 'POST');
    await second.locator('.remove').focus(); await second.locator('.remove').press('Enter');
    await completed(removeOnly, 204); await expect(second).toHaveCount(0);
    await expect(page.locator('#todo-title')).toBeFocused(); await expect(page.locator('#todo-title')).toBeVisible();
    await renderedSearch(emptySearch); await expect(page.locator('.task-row:visible')).toHaveCount(0);
    await page.locator('#todo-search').press('Escape'); await assertSearchCleared();
    // The lifecycle fixture lets WebKit exercise the failure/retry presentation.
    await page.emulateMedia({reducedMotion: 'reduce'});
    await page.evaluate(() => window.__embeddingFixture.loading());
    await expect(page.locator('#model-panel')).toHaveClass(/is-busy/);
    assert.equal(await page.locator('.model-dot').evaluate(element => getComputedStyle(element).animationName), 'none');
    await page.evaluate(() => window.__embeddingFixture.error());
    await expect(page.locator('#model-error')).toHaveText('Injected model loading failure');
    await expect(page.locator('#model-load')).toHaveText('Retry'); await layout('narrow-error');
    await page.locator('#model-load').click();
    assert.equal(await page.evaluate(() => window.__embeddingFixture.loads), 2);
    await expect(page.locator('#model-panel')).toHaveClass(/is-busy/);
    await page.evaluate(() => window.__embeddingFixture.ready()); await ready();
    assert.deepEqual(external, []);
  } else if (mode === 'flows') {
    assert.equal(await page.evaluate(() => window.__embeddingFixture.loads), 1);
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.length), 0);
    await first.locator('.task-title').click(); await first.locator('.task-editor').fill('Unsaved old draft');
    const readyScan = responseFor('/api/todos/embeddings/pending', 'GET');
    const initialSearch = responseFor('/api/todos/search', 'POST');
    await page.evaluate(() => window.__embeddingFixture.ready()); await ready();
    await completed(readyScan);
    await renderedSearch(initialSearch);
    await expect.poll(() => page.evaluate(() => window.__embeddingFixture.calls.length)).toBe(1);
    await expect(page.locator('#search-status')).toContainText('2 tasks still being indexed');
    await completeTask(first);
    const refreshedList = responseFor('/api/todos', 'GET');
    const refreshedScan = responseFor('/api/todos/embeddings/pending', 'GET');
    await page.locator('#refresh-button').click();
    await completed(refreshedList); await completed(refreshedScan);
    await expect(page.locator('#refresh-button')).toBeEnabled();
    await expect(first.locator('.task-editor')).toHaveValue('Unsaved old draft');
    assert.deepEqual(await page.evaluate(() => window.__embeddingFixture.calls), [{title: 'Old groceries', icon: 'shopping'}]);
    // Change a source and delete another item while the old inference is held.
    const savedSource = responseFor(`/api/todos/${groceries.id}`, 'PUT', request => request.postDataJSON().title === 'Confirmed source edit');
    const saveGate = await holdRequest(`/api/todos/${groceries.id}`, 'PUT');
    await first.locator('.task-editor').fill('Confirmed source edit');
    await first.locator('.task-editor').press('Enter');
    await saveGate.captured;
    await expect(first).toHaveAttribute('aria-busy', 'true');
    await expect(first.locator('.task-completion')).toBeDisabled();
    await expect(first.locator('.task-editor')).toHaveValue('Confirmed source edit');
    assert.equal((await api('/api/todos')).find(task => task.id === groceries.id).title, 'Old groceries');
    await saveGate.release();
    assert.equal((await (await completed(savedSource)).json()).title, 'Confirmed source edit');
    await expect(first.locator('.task-title')).toHaveText('Confirmed source edit');
    const removed = responseFor(`/api/todos/${await loadingTask.getAttribute('data-id')}`, 'DELETE');
    await loadingTask.locator('.remove').click(); await completed(removed, 204);
    await expect(loadingTask).toHaveCount(0);
    const editedUpload = responseFor(`/api/todos/${groceries.id}/embedding`, 'PUT', request => request.postDataJSON().title === 'Confirmed source edit');
    const indexedSearch = responseFor('/api/todos/search', 'POST', async (_request, response) => (await response.json()).pending_count === 0);
    await page.evaluate(() => window.__embeddingFixture.release());
    await completed(editedUpload, 204); await indexed();
    await expect(first.locator('.embedding-status')).toBeHidden();
    await renderedSearch(indexedSearch);
    await expect(page.locator('#search-status')).toHaveText('1 results');
    assert.equal(uploads.some(item => item.title === 'Old groceries' || item.title === 'Schedule a dental checkup'), false);
    assert.ok(uploads.some(item => item.title === 'Confirmed source edit'));
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.some(item => /science fiction/.test(item.title))), false);
    await page.locator('#search-clear').click();
    await assertSearchCleared();
    let failUpload = true;
    await page.route('**/api/todos/*/embedding', route => {
      if (failUpload && route.request().postDataJSON().title === 'Upload retry') {
        failUpload = false; return route.fulfill({status: 503, contentType: 'application/json', body: '{"detail":"Upload temporarily failed"}'});
      }
      return route.continue();
    });
    const failedUpload = responseFor(/^\/api\/todos\/[^/]+\/embedding$/, 'PUT', request => request.postDataJSON().title === 'Upload retry');
    const failed = await add('Upload retry'); await completed(failedUpload, 503);
    await expect(failed.locator('.embedding-feedback')).toBeVisible();
    const inferred = await page.evaluate(() => window.__embeddingFixture.calls.length);
    const created = creations.length;
    const retriedUpload = responseFor(`/api/todos/${await failed.getAttribute('data-id')}/embedding`, 'PUT');
    await failed.locator('.embedding-retry').click(); await completed(retriedUpload, 204); await indexed();
    await expect(failed.locator('.embedding-feedback')).toBeHidden();
    await expect(failed.locator('.embedding-status')).toBeHidden();
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.length), inferred);
    assert.equal(creations.length, created);
    const attempts = uploads.filter(item => item.title === 'Upload retry');
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    await page.evaluate(() => {window.__embeddingFixture.failNext = 1;});
    const inference = await add('Inference retry'); await expect(inference.locator('.embedding-feedback')).toBeVisible();
    const retriedInference = responseFor(`/api/todos/${await inference.getAttribute('data-id')}/embedding`, 'PUT');
    await inference.locator('.embedding-retry').click(); await completed(retriedInference, 204); await indexed();
    await expect(inference.locator('.embedding-feedback')).toBeHidden();
    await expect(inference.locator('.embedding-status')).toBeHidden();
    assert.equal(await page.evaluate(() => window.__embeddingFixture.calls.filter(item => item.title === 'Inference retry').length), 2);
    // API 409/404 retain their atomic source guarantees and reconcile remote races.
    for (const status of [409, 404]) {
      let once = true;
      const uploadStarted = deferred();
      const uploadGate = deferred();
      await page.route('**/api/todos/*/embedding', async route => {
        if (!once || route.request().postDataJSON().title !== `Remote race ${status}`) return route.fallback();
        once = false;
        uploadStarted.resolve(); await uploadGate.promise;
        const url = route.request().url().replace(/\/embedding$/, '');
        const response = await context.request.fetch(url, status === 409
          ? {method: 'PUT', data: {title: 'Remote confirmed edit', icon: 'star'}} : {method: 'DELETE'});
        assert.ok(response.ok()); await route.continue();
      });
      const raceResponse = responseFor(/^\/api\/todos\/[^/]+\/embedding$/, 'PUT', request => request.postDataJSON().title === `Remote race ${status}`);
      const reconciledList = responseFor('/api/todos', 'GET');
      const reconciledUpload = status === 409 ? responseFor(/^\/api\/todos\/[^/]+\/embedding$/, 'PUT', request => request.postDataJSON().title === 'Remote confirmed edit') : null;
      const raced = await add(`Remote race ${status}`);
      await uploadStarted.promise;
      await expect(raced.locator('.embedding-status')).toHaveText('Processing…');
      uploadGate.resolve();
      await completed(raceResponse, status);
      await completed(reconciledList);
      if (reconciledUpload) await completed(reconciledUpload, 204);
      await indexed();
      if (status === 409) await expect(raced.locator('.task-title')).toHaveText('Remote confirmed edit');
      else await expect(raced).toHaveCount(0);
    }
    const noMatch = responseFor('/api/todos/search', 'POST', request => request.postDataJSON().vector[2] === 1);
    await search('space');
    const empty = await renderedSearch(noMatch);
    assert.deepEqual(empty, {matches: [], pending_count: 0, min_score: empty.min_score});
    await expect(page.locator('.task-row:visible')).toHaveCount(0);
    await page.locator('#todo-search').press('Escape'); await assertSearchCleared();
    assert.deepEqual(await page.locator('.task-row:visible').evaluateAll(rows => rows.map(row => row.dataset.id)),
      (await api('/api/todos')).map(task => task.id));
    await page.route(origin + '/api/todos/search', route => route.fulfill({status: 503,
      contentType: 'application/json', body: '{"detail":"Search temporarily failed"}'}), {times: 1});
    const failedSearch = responseFor('/api/todos/search', 'POST');
    await search('temporary query failure'); await completed(failedSearch, 503);
    await expect(page.locator('#search-status')).toHaveText('Search temporarily failed');
    await expect(page.locator('.similarity:visible')).toHaveCount(0);
    await page.locator('#search-clear').click(); await assertSearchCleared();
    // Hold an authentic API result and deliver it after the newer query.
    const staleSearch = await holdSearchResponse();
    await search('old query');
    const staleResult = await staleSearch.captured;
    assert.equal(staleResult.matches[0].todo.id, groceries.id);
    const newestSearch = responseFor('/api/todos/search', 'POST', request => request.postDataJSON().vector[1] === 1);
    await search('book'); await renderedSearch(newestSearch);
    await expect(page.locator('.task-row:visible .task-title').first()).toHaveText(book.title);
    await staleSearch.release();
    await expect(page.locator('.task-row:visible .task-title').first()).toHaveText(book.title);
    await expect(first).toBeHidden();
    await expect(second.locator('.similarity')).toHaveText('Similarity 1.00');
    const clearedSearch = await holdSearchResponse();
    await search('food to clear');
    assert.equal((await clearedSearch.captured).matches[0].todo.id, groceries.id);
    await page.locator('#search-clear').click();
    await expect(page.locator('#search-status')).toBeHidden();
    await clearedSearch.release();
    await assertSearchCleared();
    const expectedOrder = (await api('/api/todos')).map(item => item.id);
    assert.deepEqual(await page.locator('.task-row:visible').evaluateAll(rows => rows.map(row => row.dataset.id)), expectedOrder);
    // A reply for the old source arriving while a save is pending must also be
    // ignored. Release the save only after verifying its draft and busy state.
    const sourceSearch = await holdSearchResponse();
    await search('food before save');
    const beforeSave = await sourceSearch.captured;
    assert.equal(beforeSave.matches[0].todo.title, 'Confirmed source edit');
    await first.locator('.task-title').click();
    await first.locator('.task-editor').fill('Saved after held search');
    const sourceSave = responseFor(`/api/todos/${groceries.id}`, 'PUT');
    const sourceUpload = responseFor(`/api/todos/${groceries.id}/embedding`, 'PUT', request => request.postDataJSON().title === 'Saved after held search');
    const sourceGate = await holdRequest(`/api/todos/${groceries.id}`, 'PUT');
    const writesBeforeSave = sourceWrites.length;
    await first.locator('.task-editor').press('Enter');
    await sourceGate.captured;
    await sourceSearch.release();
    await expect(first.locator('.similarity')).toBeHidden();
    await expect(first).toHaveAttribute('aria-busy', 'true');
    await expect(first.locator('.task-editor')).toHaveValue('Saved after held search');
    await expect(page.locator('#search-status')).toHaveText('Searching…');
    assert.equal((await api('/api/todos')).find(task => task.id === groceries.id).title, 'Confirmed source edit');
    const currentSearch = responseFor('/api/todos/search', 'POST', async (_request, response) => {
      const result = await response.json();
      return result.pending_count === 0 && result.matches[0].todo.title === 'Saved after held search';
    });
    await sourceGate.release();
    assert.equal((await (await completed(sourceSave)).json()).title, 'Saved after held search');
    await expect(first.locator('.task-title')).toHaveText('Saved after held search');
    await completed(sourceUpload, 204); await indexed();
    const afterSave = await renderedSearch(currentSearch);
    assert.equal(afterSave.matches[0].todo.title, 'Saved after held search');
    assert.equal(sourceWrites.length, writesBeforeSave + 1, 'Held search caused an extra source save');
    await page.locator('#search-clear').click();
    await assertSearchCleared();
    assert.deepEqual(await page.locator('.task-row:visible').evaluateAll(rows => rows.map(row => row.dataset.id)), expectedOrder);
    // Reordering driven by indexing/search must keep a live draft and selection,
    // without triggering the editor's normal blur-save behavior.
    await first.locator('.task-title').click(); await first.locator('.task-editor').fill('Draft remains local');
    await first.locator('.task-editor').evaluate(element => element.setSelectionRange(2, 5));
    const writes = sourceWrites.length;
    // A second tab can change a source after this page's query starts. Hold
    // the request until that change is indexed, then gate the refresh so the
    // new score cannot be displayed beside the stale source or lose a draft.
    const remoteQuery = responseFor('/api/todos/search', 'POST');
    const remoteQueryGate = await holdRequest('/api/todos/search', 'POST');
    await search('food after remote edit', true);
    await remoteQueryGate.captured;
    const remoteSave = await context.request.put(origin + `/api/todos/${groceries.id}`,
      {data: {title: 'Saved after held search', icon: 'star'}});
    assert.equal(remoteSave.status(), 200); assert.equal((await remoteSave.json()).icon, 'star');
    const currentUpload = uploads.findLast(upload => upload.id === groceries.id);
    assert.ok(currentUpload);
    const {id: remoteId, ...remoteEmbedding} = currentUpload;
    const remoteUpload = await context.request.put(origin + `/api/todos/${remoteId}/embedding`,
      {data: {...remoteEmbedding, icon: 'star'}});
    assert.equal(remoteUpload.status(), 204);
    const remoteList = responseFor('/api/todos', 'GET', (_request, response) => response.status() === 200);
    const remoteListGate = await holdRequest('/api/todos', 'GET');
    const failedRemoteList = responseFor('/api/todos', 'GET', (_request, response) => response.status() === 503);
    await page.route(origin + '/api/todos', route => route.fulfill({status: 503,
      contentType: 'application/json', body: '{"detail":"Source refresh temporarily failed"}'}), {times: 1});
    await remoteQueryGate.release();
    assert.equal((await (await completed(remoteQuery)).json()).matches.find(match => match.todo.id === groceries.id).todo.icon, 'star');
    await completed(failedRemoteList, 503);
    await remoteListGate.captured;
    await expect(page.locator('.similarity:visible')).toHaveCount(0);
    await expect(page.locator('#search-explain')).toBeHidden();
    await expect(first.locator('.task-editor')).toHaveValue('Draft remains local');
    await expect(first.locator('.task-editor')).toBeFocused();
    const resyncedSearch = responseFor('/api/todos/search', 'POST');
    await remoteListGate.release(); await completed(remoteList);
    const remoteResult = await renderedSearch(resyncedSearch);
    assert.equal(remoteResult.matches.find(match => match.todo.id === groceries.id).todo.icon, 'star');
    await expect(first.locator('.task-editor')).toHaveValue('Draft remains local');
    await expect(first.locator('.task-editor')).toBeFocused();
    assert.deepEqual(await first.locator('.task-editor').evaluate(element => [element.selectionStart, element.selectionEnd]), [2, 5]);
    assert.equal(sourceWrites.length, writes, 'Remote-source refresh submitted a local draft');
    const draftSearch = responseFor('/api/todos/search', 'POST', request => request.postDataJSON().vector[1] === 1);
    await search('book', true);
    await renderedSearch(draftSearch);
    await expect(page.locator('.task-row:visible .task-title').first()).toHaveText(book.title);
    await expect(first.locator('.task-editor')).toHaveValue('Draft remains local');
    await expect(first.locator('.task-editor')).toBeFocused();
    await expect(first.locator('.nonmatch')).toHaveText('Not a search match');
    await expect(first.locator('.nonmatch')).toBeVisible();
    await expect(first.locator('.similarity')).toBeHidden();
    await expect(page.locator('#search-status')).toHaveText('1 results');
    assert.deepEqual(await first.locator('.task-editor').evaluate(element => [element.selectionStart, element.selectionEnd]), [2, 5]);
    assert.equal(sourceWrites.length, writes, 'Search reordering submitted a draft');
    await layout('desktop');
    await page.setViewportSize({width: 375, height: 700});
    await layout('narrow-search');
    await search('', true);
    await assertSearchCleared();
    await expect(first.locator('.task-editor')).toHaveValue('Draft remains local');
    await expect(first.locator('.task-editor')).toBeFocused();
    assert.deepEqual(await first.locator('.task-editor').evaluate(element => [element.selectionStart, element.selectionEnd]), [2, 5]);
    assert.deepEqual(await page.locator('.task-row:visible').evaluateAll(rows => rows.map(row => row.dataset.id)), expectedOrder);
    assert.equal(sourceWrites.length, writes, 'Clearing submitted a draft');
    assert.deepEqual(external, [], 'Injected integration checks must stay offline');
    verifyDatabase = data => {
      assert.ok(!data.some(task => task.title === 'Old groceries' || task.title === 'Schedule a dental checkup' || task.title === 'Remote race 404'));
      assert.ok(data.some(task => task.title === 'Saved after held search'));
      for (const task of data) {assert.equal(task.vector.length, 768); assert.equal(task.input_version, 1);}
    };
  } else throw Error('Unknown browser mode: ' + mode);
  // Capture authentic layouts before reload starts another software-GPU sample;
  // compositor screenshots during that compilation can exceed the check budget.
  if (mode === 'flows') {
    await page.setViewportSize({width: 375, height: 700});
    await layout('narrow');
  }
  await page.emulateMedia({reducedMotion: 'reduce'});
  if (mode === 'flows') {
    await page.evaluate(() => window.__embeddingFixture.loading());
    await expect(page.locator('#model-panel')).toHaveClass(/is-busy/);
  }
  assert.equal(await page.locator('.model-dot').evaluate(element => getComputedStyle(element).animationName), 'none');
  for (const sample of guidanceSamples) {
    assert.ok(sample.text.includes(sample.minScore.toFixed(2)),
      `Search guidance must explain the server cutoff ${sample.minScore.toFixed(2)}: ${sample.text}`);
  }
  console.log('PASS', browserName, mode);
} finally {
  releaseRuntime?.(); clearTimeout(timeout);
  // Kill only this test's Chromium process group, including active GPU work.
  // A graceful close can wait for SwiftShader compilation beyond the budget.
  await browserServer?.kill(); await browser?.close().catch(() => {});
  fixtureServer.closeAllConnections(); await new Promise(resolve => fixtureServer.close(resolve));
  const stopped = new Promise(resolve => {if (server.exitCode !== null) resolve(); else server.once('exit', resolve);});
  server.kill('SIGTERM'); await stopped;
  try {
    if (verifyDatabase) {
      const result = spawnSync(process.env.MODEL_TEST_PYTHON, ['-c', `import json, sys, duckdb
from fastapi.testclient import TestClient
from app.main import create_app
with TestClient(create_app(sys.argv[1])) as client:
    assert client.get('/api/todos').status_code == 200
with duckdb.connect(sys.argv[1]) as db:
    rows = db.execute('SELECT id, title, icon, embedding, embedding_model, embedding_revision, embedding_input_version, embedding_dimensions FROM todos ORDER BY created_at, id').fetchall()
print(json.dumps([dict(zip(('id', 'title', 'icon', 'vector', 'model', 'revision', 'input_version', 'dimensions'), row)) for row in rows]))`, `${directory}/todos.duckdb`], {cwd: root, encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr); verifyDatabase(JSON.parse(result.stdout));
    }
  } finally {await rm(directory, {recursive: true, force: true});}
}

"""


def run_browser(mode, real_query="groceries", browser="chromium"):
    environment = {
        **os.environ, "MODEL_PROJECT_ROOT": str(ROOT), "MODEL_TEST_PYTHON": sys.executable,
        "MODEL_REAL_QUERY": real_query, "MODEL_TEST_BROWSER": browser,
    }
    process = subprocess.Popen(
        [node_executable(), "--input-type=module", "-e", BROWSER_CHECK, mode],
        cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    try:
        stdout, stderr = process.communicate(timeout=28)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        raise AssertionError("Browser check exceeded 28 seconds.\n" + stdout + stderr) from None
    assert process.returncode == 0, stdout + stderr
    if stdout:
        print(stdout.strip())


browser_check = pytest.mark.skipif(os.environ.get("MODEL_BROWSER_CHECK") != "1",
                                   reason="Set MODEL_BROWSER_CHECK=1 after installing browser fixtures.")


@browser_check
@pytest.mark.parametrize("real_query", ["groceries", "book", "none", "cache"])
def test_real_model_automatic_backfill_search_and_cache(real_query):
    run_browser("real", real_query)


@browser_check
def test_browser_backfill_search_retries_and_drafts():
    run_browser("flows")


@browser_check
@pytest.mark.parametrize("browser", ["chromium", "webkit"])
def test_browser_retained_nonmatches_and_visible_focus(browser):
    run_browser("focus", browser=browser)


if __name__ == "__main__":
    if sys.argv[1:] == ["--download-fixtures"]:
        environment = {**os.environ, "MODEL_PROJECT_ROOT": str(ROOT)}
        result = subprocess.run(
            [node_executable(), "--input-type=module", "-e", BROWSER_CHECK, "download"],
            cwd=ROOT, env=environment, capture_output=True, text=True, timeout=600,
        )
        print(result.stdout + result.stderr)
        raise SystemExit(result.returncode)
    elif sys.argv[1:] == ["--check-suites"]:
        subprocess.run(
            [sys.executable, "-m", "pytest", str(ROOT / "tests"), "-q", "-p", "no:cacheprovider"],
            cwd=ROOT, env={**os.environ, "MODEL_BROWSER_CHECK": "0"}, check=True, timeout=28,
        )
    elif sys.argv[1:] == ["--check-flows"]:
        run_browser("flows")
    elif sys.argv[1:] == ["--check-focus"]:
        run_browser("focus")
    elif sys.argv[1:] == ["--check-webkit"]:
        run_browser("focus", browser="webkit")
    elif sys.argv[1:] == ["--check-real"]:
        run_browser("real")
    elif sys.argv[1:] == ["--check-real-book"]:
        run_browser("real", "book")
    elif sys.argv[1:] == ["--check-real-no-match"]:
        run_browser("real", "none")
    elif sys.argv[1:] == ["--check-real-cache"]:
        run_browser("real", "cache")
    else:
        raise SystemExit("Usage: --download-fixtures | --check-suites | --check-flows | --check-focus | --check-webkit | "
                         "--check-real | --check-real-book | --check-real-no-match | --check-real-cache")
