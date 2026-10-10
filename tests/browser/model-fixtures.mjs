// Shared fixtures for verification browser specs. Everything runs against the
// built static app in `dist/` over an ephemeral loopback server started and
// stopped in the same process. No backend, no fixed ports, no /api traffic.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = process.env.VERIFY_PROJECT_ROOT || resolve(FIXTURE_DIR, '../..');

if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = join(
    process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'ms-playwright');
}

export const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

// Build dist when it is missing so checks run against current source.
export async function ensureDist() {
  const manifest = join(PROJECT_ROOT, 'dist/asset-manifest.json');
  try {
    if (statSync(manifest).isFile()) return join(PROJECT_ROOT, 'dist');
  } catch { /* Build below. */ }
  await promisify(execFile)(process.execPath,
    [join(PROJECT_ROOT, 'node_modules/vite/bin/vite.js'), 'build'],
    { cwd: PROJECT_ROOT, env: { ...process.env, PATH: `${resolve(process.execPath, '..')}:${process.env.PATH}` } });
  return join(PROJECT_ROOT, 'dist');
}

// Static server for dist. `routes` maps extra fixture paths to JS bodies.
// Every request path is recorded for the zero-backend audit.
export async function serveDist(routes = {}) {
  const root = await ensureDist();
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ path: url.pathname, method: request.method });
    if (Object.hasOwn(routes, url.pathname)) {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(routes[url.pathname]);
      return;
    }
    const file = resolve(root, `.${url.pathname === '/' ? '/index.html' : url.pathname}`);
    if (!file.startsWith(`${root}${sep}`)) { response.writeHead(404).end(); return; }
    try {
      const info = statSync(file);
      if (!info.isFile()) { response.writeHead(404).end(); return; }
      response.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream');
      response.setHeader('Content-Length', info.size);
      response.setHeader('Cache-Control', 'no-cache');
      createReadStream(file).pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise(done => server.close(done));
    },
  };
}

export async function makeProfile(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function dropProfile(profile) {
  await rm(profile, { recursive: true, force: true });
}
