// One immutable, integrity-checked copy. Transformers' best-effort cache writes
// are deliberately disabled: a failed write must prevent offline readiness.
import { EMBEDDING_METADATA } from './storage-contract.mjs';
const { model, revision } = EMBEDDING_METADATA;
export const MODEL_CACHE_NAME = `local-todo-model-v1-${revision}`;
export const MODEL_BASE_URL = `https://huggingface.co/${model}/resolve/${revision}/`;
export const MODEL_ASSETS = Object.freeze([
  ['config.json', 5031, '8d011bfe08b5e345bbe0b81e5c6fd02c381920b345b986047bc2a33ce7b90d1d'],
  ['tokenizer_config.json', 1599, '17bd5d6e9364ca49a534e1502076593317c298d4a663623091ed45388f004874'],
  ['tokenizer.json', 32170510, '4d777ef5bdc1aa36227abdfb77c3e49e7b9c892d16e1b6bda41c393504828be4'],
  ['onnx/model_q4.onnx', 490742, 'f9eeba97acddf139b8ee2ddf04bc30dceafa88de93fadf74d7644e0d61a477a9'],
  ['onnx/model_q4.onnx_data', 174028800, 'c3975f2d1ab7a1878ae31a7d7a9b7804a827aff3800b60dfceafce21cac3df49'],
].map(([path, size, sha256]) => Object.freeze({ path, url: MODEL_BASE_URL + path, size, sha256 })));
const LOCK = 'local-todo-model-cache';

export class ModelCacheError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = 'ModelCacheError'; }
}
export async function verifiedBytes(response, asset, crypto = globalThis.crypto, onProgress) {
  if (!response?.ok || response.type === 'opaque') throw new Error(`Missing ${asset.path ?? asset.url}`);
  let bytes;
  if (onProgress) {
    const reader = response.body.getReader();
    const buffer = new Uint8Array(asset.size);
    let received = 0;
    let lastProgressAt = Date.now();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > asset.size) throw new Error('Oversized model file');
        buffer.set(value, received);
        received += value.byteLength;
        const now = Date.now();
        // Actual incoming bytes reset the parent's inactivity watchdog. Bound
        // updates during fast downloads so task controls remain responsive.
        if (value.byteLength && now - lastProgressAt >= 100) {
          lastProgressAt = now;
          onProgress(received);
        }
      }
      if (received !== asset.size) throw new Error('Incomplete model file');
      bytes = buffer.buffer;
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  } else {
    bytes = await response.arrayBuffer();
  }
  if (bytes.byteLength !== asset.size) throw new Error('Incomplete cached file');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== asset.sha256) throw new Error('Corrupted cached file');
  return bytes;
}

export function createModelCache({ storage = globalThis.caches, locks = globalThis.navigator?.locks,
  fetchAsset = globalThis.fetch?.bind(globalThis), crypto = globalThis.crypto,
  assets = MODEL_ASSETS, name = MODEL_CACHE_NAME } = {}) {
  const totalBytes = assets.reduce((sum, asset) => sum + asset.size, 0);
  let pending = null;
  const exclusive = action => {
    if (!storage || !crypto?.subtle || !locks?.request) {
      return Promise.reject(new ModelCacheError('Persistent model caching is unavailable. Use a secure browser with Cache Storage and Web Locks.'));
    }
    return locks.request(LOCK, action);
  };
  async function inspect() {
    return exclusive(async () => {
      const cache = await storage.open(name);
      let files = 0, bytes = 0;
      for (const asset of assets) {
        try { await verifiedBytes(await cache.match(asset.url), asset, crypto); ++files; bytes += asset.size; }
        catch { /* Inspection never advertises missing or corrupt data as complete. */ }
      }
      return { complete: files === assets.length, files, total: assets.length, bytes, totalBytes };
    });
  }
  function prepare(onProgress = () => {}) {
    if (pending) return pending;
    pending = exclusive(async () => {
      const cache = await storage.open(name);
      const legacy = (await storage.keys()).includes('transformers-cache')
        ? await storage.open('transformers-cache') : null;
      let completed = 0;
      for (const asset of assets) {
        let valid = false;
        try { await verifiedBytes(await cache.match(asset.url), asset, crypto); valid = true; }
        catch { await cache.delete(asset.url); }
        if (!valid) {
          let bytes;
          if (legacy) {
            try { bytes = await verifiedBytes(await legacy.match(asset.url), asset, crypto); }
            catch { /* Download this file; retain already verified files. */ }
          }
          if (!bytes) {
            onProgress({ progress: completed / totalBytes, message: `Downloading ${asset.path}…` });
            const response = await fetchAsset(asset.url, { cache: 'no-store', credentials: 'omit' });
            bytes = await verifiedBytes(response, asset, crypto, received => onProgress({
              progress: (completed + received) / totalBytes, message: `Downloading ${asset.path}…`,
            }));
          }
          await cache.put(asset.url, new Response(bytes, { headers: {
            'Content-Type': asset.path.endsWith('.json') ? 'application/json' : 'application/octet-stream',
            'Content-Length': String(asset.size),
          } }));
          // A successful API call alone is not evidence that bytes were stored.
          await verifiedBytes(await cache.match(asset.url), asset, crypto);
        }
        if (legacy) await legacy.delete(asset.url);
        completed += asset.size;
        onProgress({ progress: completed / totalBytes, message: 'Verifying saved model files…' });
      }
      // Read-only adapter, with canonical keys for both local and pinned URLs.
      // Optional metadata probes return a 404 without making another request.
      return { complete: true, customCache: {
        async match(request) {
          const url = typeof request === 'string' ? request : request.url;
          const asset = assets.find(item => url === item.url || url.endsWith(`/${model}/${item.path}`));
          if (!asset) return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
          const response = await cache.match(asset.url);
          if (!response) throw new ModelCacheError('Saved model files were removed. Reload the model to recover.');
          try {
            const bytes = await verifiedBytes(response, asset, crypto);
            return new Response(bytes, { headers: response.headers });
          } catch (error) {
            throw new ModelCacheError('Saved model files failed verification. Reload the model to recover.', error);
          }
        },
        async put() { throw new ModelCacheError('Model assets must use the managed cache.'); },
      } };
    }).catch(error => {
      if (error instanceof ModelCacheError) throw error;
      const quota = error?.name === 'QuotaExceededError';
      throw new ModelCacheError(quota ? 'Model files could not be saved: browser storage is full. Free space and retry.'
        : 'Model download or cache verification failed. Check your connection and available storage, then retry.', error);
    }).finally(() => { pending = null; });
    return pending;
  }
  async function clear() {
    await exclusive(async () => {
      await storage.delete(name);
      if ((await storage.keys()).includes('transformers-cache')) {
        const legacy = await storage.open('transformers-cache');
        for (const asset of assets) await legacy.delete(asset.url);
      }
    });
  }
  return Object.freeze({ prepare, inspect, clear });
}
export const modelCache = createModelCache();
