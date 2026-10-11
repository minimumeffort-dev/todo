import { defineConfig } from 'vite';
import { build as bundle } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, basename, extname } from 'node:path';

const sourceRoot = resolve('app/static');
const runtimeRoot = resolve('node_modules');
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm',
};

// Preserve /static module URLs and import.meta.url worker resolution. Browser
// libraries are bundled or copied from the lockfile, never fetched by build.
// Only enumerated browser source/runtime files can enter deployed assets.
export async function browserAssets() {
  const assets = new Map();
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !['.js', '.mjs', '.css', '.html'].includes(extname(entry.name))) continue;
    const path = entry.name === 'index.html' ? 'index.html'
      : entry.name === 'service-worker.mjs' ? 'service-worker.mjs' : `static/${entry.name}`;
    assets.set(path, await readFile(resolve(sourceRoot, entry.name)));
  }
  const duckdbRoot = resolve(runtimeRoot, '@duckdb/duckdb-wasm/dist');
  const bundled = await bundle({
    entryPoints: [resolve(duckdbRoot, 'duckdb-browser.mjs')],
    bundle: true, format: 'esm', platform: 'browser', write: false,
    minify: true, target: 'es2022', legalComments: 'inline',
  });
  assets.set('vendor/duckdb/duckdb-browser.mjs', bundled.outputFiles[0].contents);
  const blocking = await bundle({
    entryPoints: [resolve(duckdbRoot, 'duckdb-browser-blocking.mjs')],
    bundle: true, format: 'esm', platform: 'browser', write: false,
    minify: true, target: 'es2022', legalComments: 'inline',
  });
  assets.set('vendor/duckdb/duckdb-browser-blocking.mjs', blocking.outputFiles[0].contents);
  for (const name of ['duckdb-mvp.wasm', 'duckdb-eh.wasm',
    'duckdb-browser-mvp.worker.js', 'duckdb-browser-eh.worker.js']) {
    assets.set(`vendor/duckdb/${name}`, await readFile(resolve(duckdbRoot, name)));
  }
  assets.set('vendor/transformers/transformers.min.js', await readFile(
    resolve(runtimeRoot, '@huggingface/transformers/dist/transformers.min.js')));
  const ortRoot = resolve(runtimeRoot, 'onnxruntime-web/dist');
  for (const name of await readdir(ortRoot)) {
    if (/^ort-wasm-simd-threaded(?:\.[a-z]+)?\.(?:mjs|wasm)$/.test(name)) {
      assets.set(`vendor/onnx/${name}`, await readFile(resolve(ortRoot, name)));
    }
  }
  // Content-derived version makes app-shell cache updates reproducible. The
  // manifest intentionally excludes model downloads and the private database.
  const shellVersion = createHash('sha256').update(JSON.stringify([...assets]
    .sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) =>
      [path, createHash('sha256').update(bytes).digest('hex')]))).digest('hex');
  if (assets.has('service-worker.mjs')) assets.set('service-worker.mjs', Buffer.from(
    Buffer.from(assets.get('service-worker.mjs')).toString().replace('__SHELL_VERSION__', shellVersion)));
  const entries = [...assets].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({
    url: `/${path}`, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  const version = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  assets.set('asset-manifest.json', Buffer.from(JSON.stringify({ version, shellVersion, assets: entries }, null, 2)));
  return assets;
}

function staticBrowserApp() {
  return {
    name: 'local-todo-static-browser-app',
    resolveId(id) { if (id === 'virtual:static-browser-app') return '\0static-browser-app'; },
    load(id) { if (id === '\0static-browser-app') return 'export {};'; },
    async generateBundle(_options, output) {
      for (const name of Object.keys(output)) delete output[name];
      for (const [fileName, source] of await browserAssets()) this.emitFile({ type: 'asset', fileName, source });
    },
    async configureServer(server) {
      const runtime = await browserAssets();
      server.middlewares.use(async (request, response) => {
        try {
          const url = new URL(request.url, 'http://localhost');
          const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
          let bytes;
          if (path === 'service-worker.mjs' || path === 'asset-manifest.json') {
            const fresh = await browserAssets();
            bytes = fresh.get(path);
          }
          // Read source on each request so development edits appear on reload.
          const sourceName = path === 'index.html' ? path
            : path === 'service-worker.mjs' ? path
              : path.startsWith('static/') ? basename(path) : null;
          if (!bytes && sourceName && (path === 'index.html' || path === 'service-worker.mjs'
            || path === `static/${sourceName}`)
            && ['.html', '.mjs', '.js', '.css'].includes(extname(sourceName))) {
            const file = resolve(sourceRoot, sourceName);
            if ((await stat(file)).isFile()) bytes = await readFile(file);
          } else if (!bytes) bytes = runtime.get(path);
          if (!bytes) { response.statusCode = 404; response.end(); return; }
          response.setHeader('Content-Type', contentTypes[extname(path)] ?? 'application/octet-stream');
          response.setHeader('Cache-Control', 'no-cache');
          response.end(bytes);
        } catch { response.statusCode = 404; response.end(); }
      });
    },
  };
}

export default defineConfig({
  root: sourceRoot,
  publicDir: false,
  plugins: [staticBrowserApp()],
  build: {
    outDir: resolve('dist'), emptyOutDir: true,
    rollupOptions: { input: 'virtual:static-browser-app' },
  },
});
