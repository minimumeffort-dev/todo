// Tab coordination for the local repository. One tab owns the OPFS database
// (exclusive origin-wide Web Lock + dedicated worker); every other tab
// proxies repository calls to the owner over a BroadcastChannel-based local
// RPC and reconciles missed changes by sequence after resume.
//
// - Never opens OPFS files while another tab holds the lock.
// - Serializes operations through the single owner.
// - Publishes committed change notifications; subscribers reconcile with
//   list() when their sequence falls behind (e.g. after sleep).
// - initialize() requests navigator.storage.persist() and reports the
//   result; missing OPFS/Web-Lock/Worker support is an explicit
//   'unavailable' error, never a silent memory fallback.
//
// All dependencies are injectable so Node tests can run the election,
// proxying, stale-revision rejection and uncertain-reply recovery without a
// browser.
import {
  DATABASE_CHANNEL,
  DATABASE_LOCK,
  REPOSITORY_METHODS,
  STORAGE_PROTOCOL_VERSION,
  StorageError,
  restoreStorageError,
} from './storage-contract.mjs';
import { newOperationId } from './database-schema.mjs';

export const COORDINATOR_VERSION = STORAGE_PROTOCOL_VERSION;

function toError(reply) {
  return restoreStorageError(reply.error);
}

// Linked in-memory channel pair for Node tests. Each endpoint exposes
// postMessage/onmessage like a BroadcastChannel; delivery is async.
export function createMemoryChannel() {
  const endpoints = [];
  function deliver(target, message) {
    queueMicrotask(() => { target.onmessage?.({ data: structuredClone(message) }); });
  }
  for (let index = 0; index < 2; index++) {
    endpoints.push({
      onmessage: null,
      postMessage(message) { deliver(endpoints[1 - index], message); },
    });
  }
  return { owner: endpoints[0], client: endpoints[1] };
}

// Dependencies:
// - locks: Web-Locks-like {request(name, options, callback)}.
// - spawnOwner(): resolves a repository object exposing the async methods.
// - channel: {postMessage(message), onmessage} BroadcastChannel-like.
// - storage: navigator.storage-like {persist()} (optional).
export function createCoordinator({ locks = null, spawnOwner = null, channel = null, storage = null, requestTimeoutMs = 8000, startupTimeoutMs = 20000, discoveryGraceMs = 50 } = {}) {
  let repository = null; // Owned repository (owner tab) or proxy (client tab).
  let isOwner = false;
  let sequence = 0;
  const listeners = new Set();
  let requestId = 0;
  const pending = new Map();
  const seenOperations = new Map(); // operationId -> reply value (uncertain-reply recovery)
  let started = false;
  let connectionLost = false; // Set when a proxied request times out: the owner may be gone.
  // Startup election state. The page-side election lock is released as soon
  // as spawnOwner resolves, but the worker only owns the database once it
  // acquires the lifetime lock. Actual worker readiness is authoritative:
  // winners announce themselves and yield to a serving owner (or a
  // lower-id fellow contender) instead of stranding a second worker queued
  // behind the lifetime lock.
  let phase = 'idle'; // idle | starting | serving | client
  let servingAttached = false;
  let startupYield = null; // resolve function for the startup race, if any
  let servingSeen = false; // a serving announcement was heard on the channel
  let servingWaiters = []; // resolvers waiting for the next serving announcement

  function publish(event) {
    for (const listener of [...listeners]) {
      try { listener(event); } catch { /* Never break coordination. */ }
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function handleRemoteCommit(message) {
    if (!message || typeof message.sequence !== 'number') return;
    if (message.sequence > sequence) {
      sequence = message.sequence;
      publish({ sequence, operationId: message.operationId ?? null, ids: message.ids ?? null, remote: true });
    }
  }

  function attachChannel(ch) {
    if (!ch) return;
    ch.onmessage = (event) => {
      const message = event?.data ?? event;
      if (message && message.__coordinatorRpc) {
        // Replies only: requests (direction 'request') are served by the
        // owner path, and a reply must name this tab as its destination.
        // Request IDs are per-tab counters, so an ID alone cannot correlate
        // a reply when several client tabs share one broadcast channel.
        if (message.direction === 'request') return;
        if (message.to !== coordinatorId) return;
        if (message.ok === undefined) return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        if (message.ok) waiter.resolve(message.value);
        else waiter.reject(toError(message));
        return;
      }
      if (message && message.__coordinatorStartup && message.from !== coordinatorId) {
        handleStartupMessage(message);
        return;
      }
      if (message && typeof message.sequence === 'number' && message.from !== coordinatorId) {
        handleRemoteCommit(message);
      }
    };
  }

  // Startup discovery: election winners broadcast claims, serving owners
  // answer them, and contenders yield deterministically (lower tab id wins)
  // so exactly one tab serves the database.
  function handleStartupMessage(message) {
    const kind = message.__coordinatorStartup ? message.__coordinatorStartup.kind : undefined;
    if (message.to !== undefined && message.to !== coordinatorId) return;
    if (kind === 'serving') {
      servingSeen = true;
      for (const resolve of servingWaiters.splice(0)) {
        try { resolve(); } catch { /* A stale waiter never breaks discovery. */ }
      }
      if (phase === 'starting') {
        // A serving owner exists: join it instead of competing.
        if (startupYield) startupYield({ yield: true });
      } else if (phase === 'serving' && message.from < coordinatorId) {
        // Concurrent finish: the lower-id owner wins; step down.
        void stepDownToClient();
      }
      return;
    }
    if (kind === 'claim') {
      if (phase === 'serving') {
        // Answer contenders directly so they join instead of competing.
        try {
          postLocal({ __coordinatorStartup: { kind: 'serving' }, to: message.from });
        } catch { /* Contenders fall back to the public serving announcement. */ }
      } else if (phase === 'starting' && message.from < coordinatorId) {
        // Fellow contender with the lower id wins deterministically.
        if (startupYield) startupYield({ yield: true });
      }
    }
  }

  const coordinatorId = `tab-${Math.floor(Math.random() * 2 ** 32).toString(36)}`;

  function postLocal(message) {
    if (!channel) throw new StorageError('unavailable', 'No channel to the database owner.');
    channel.postMessage({ ...message, from: coordinatorId });
  }

  // Owner side: answer proxied RPC from client tabs. Attached as soon as an
  // election is won (phase 'starting') so contenders that yield during
  // worker warmup can already proxy through this tab; detached on step-down.
  function serveProxyRequests() {
    if (!channel || (phase !== 'starting' && phase !== 'serving')) return;
    const previous = channel.onmessage;
    channel.onmessage = (event) => {
      const message = event?.data ?? event;
      if (message && message.__coordinatorRpc && message.from !== coordinatorId && message.direction === 'request') {
        const { id, method, args } = message;
        Promise.resolve()
          .then(() => {
            if (!REPOSITORY_METHODS.includes(method) && method !== 'initialize') {
              throw new StorageError('validation', `Unknown repository method: ${method}.`);
            }
            return repository[method](...(args ?? []));
          })
          .then((value) => {
            if (typeof value?.sequence === 'number' && value.sequence > sequence) sequence = value.sequence;
            // The owner already advanced its observed sequence, so the later
            // commit broadcast for this mutation is suppressed as a duplicate.
            // Publish to the owner's own subscribers here instead, or the
            // owner's UI would stay stale until a manual refresh. Reads carry
            // no operationId and never publish.
            if (value?.operationId !== undefined && value?.operationId !== null) {
              publish({ sequence: value?.sequence ?? sequence, operationId: value.operationId, ids: value?.ids ?? null, remote: false });
            }
            channel.postMessage({ __coordinatorRpc: true, id, ok: true, value, from: coordinatorId, to: message.from });
            channel.postMessage({ sequence: value?.sequence ?? sequence, operationId: value?.operationId ?? null, ids: value?.ids ?? null, from: coordinatorId });
          })
          .catch((error) => {
            const serialized = {
              code: error?.code ?? 'unavailable',
              status: error?.status ?? 503,
              message: error?.message ?? 'Local storage is unavailable.',
            };
            if (error?.operationId !== undefined) serialized.operationId = error.operationId;
            channel.postMessage({ __coordinatorRpc: true, id, ok: false, error: serialized, from: coordinatorId, to: message.from });
          });
        return;
      }
      if (typeof previous === 'function') previous(event);
      else if (previous) previous(event);
    };
  }

  function attachServing() {
    if (servingAttached) return;
    servingAttached = true;
    serveProxyRequests();
  }

  function detachServing() {
    servingAttached = false;
    if (channel) attachChannel(channel);
  }

  async function closeRepository() {
    const owned = repository;
    repository = null;
    try {
      if (owned && typeof owned.close === 'function') await owned.close();
    } catch { /* Termination is best-effort. */ }
  }

  // Give a concurrently starting owner a moment to announce itself so the
  // first proxied RPC is served instead of racing worker warmup. Resolves
  // immediately when an owner is already known; never rejects.
  function waitForServing() {
    if (servingSeen) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        servingWaiters = servingWaiters.filter((waiter) => waiter !== done);
        resolve();
      }, discoveryGraceMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      servingWaiters.push(done);
    });
  }

  // Join the serving owner as a proxying client after yielding an election.
  async function joinAsClient(persistence) {
    phase = 'client';
    isOwner = false;
    detachServing();
    repository = Object.fromEntries([...REPOSITORY_METHODS, 'initialize'].map((method) => [method, proxyMethod(method)]));
    const state = await repository.initialize();
    if (typeof state?.sequence === 'number') sequence = state.sequence;
    return { sequence, persistence, owner: false };
  }

  // Step down after a concurrent finish revealed a lower-id serving owner.
  // In-flight owner RPCs fail fast so callers retry against the true owner.
  async function stepDownToClient() {
    if (phase !== 'serving') return;
    phase = 'client';
    isOwner = false;
    await closeRepository();
    detachServing();
    repository = Object.fromEntries([...REPOSITORY_METHODS, 'initialize'].map((method) => [method, proxyMethod(method)]));
    try {
      const state = await repository.initialize();
      if (typeof state?.sequence === 'number') sequence = state.sequence;
    } catch {
      connectionLost = true;
    }
  }

  // Election winner path: serve proxied RPCs even while the worker warms up,
  // announce the startup claim, and let actual worker readiness plus
  // discovery decide. Victory needs both: the worker initialized (proving it
  // holds the lifetime lock) and a grace window with no serving owner or
  // lower-id contender. Otherwise the spare worker is terminated and this
  // tab joins the existing owner as a client.
  async function claimOwnership(persistence) {
    phase = 'starting';
    attachServing();
    if (channel) {
      try {
        postLocal({ __coordinatorStartup: { kind: 'claim' } });
      } catch { /* Channel failures surface through RPC timeouts. */ }
    }
    let yieldRequested = false;
    startupYield = () => { yieldRequested = true; };
    const timers = [];
    const later = (ms, value) => new Promise((resolve) => {
      timers.push(setTimeout(() => resolve(value), ms));
    });
    const ready = Promise.resolve()
      .then(() => repository.initialize())
      .then((state) => ({ ready: true, state }), (error) => ({ failed: true, error }));
    const pending = new Map();
    const track = (promise, name) => {
      pending.set(name, promise.then((value) => ({ name, value })));
    };
    track(ready, 'ready');
    track(later(startupTimeoutMs, { timeout: true }), 'deadline');
    if (channel) track(later(discoveryGraceMs, { grace: true }), 'grace');
    let readyState = null;
    let graceDone = channel ? false : true;
    let outcome = null;
    while (!outcome && pending.size > 0) {
      if (yieldRequested) {
        outcome = { yield: true };
        break;
      }
      const winner = await Promise.race(pending.values());
      pending.delete(winner.name);
      if (winner.value && winner.value.failed) {
        outcome = { failed: true, error: winner.value.error };
      } else if (winner.value && winner.value.timeout) {
        outcome = { timeout: true };
      } else if (winner.name === 'grace') {
        graceDone = true;
        if (readyState) outcome = { won: true };
      } else if (winner.name === 'ready') {
        readyState = winner.value.state;
        if (graceDone) outcome = { won: true };
      }
    }
    if (!outcome) outcome = { timeout: true };
    for (const timer of timers) clearTimeout(timer);
    startupYield = null;
    if (outcome.yield) {
      ready.catch(() => {});
      await closeRepository();
      return joinAsClient(persistence);
    }
    if (outcome.failed) {
      await closeRepository();
      throw outcome.error;
    }
    if (outcome.timeout) {
      ready.catch(() => {});
      await closeRepository();
      throw new StorageError('unavailable', 'The database worker did not start. Reconnect storage and retry.');
    }
    phase = 'serving';
    isOwner = true;
    if (typeof readyState?.sequence === 'number') sequence = readyState.sequence;
    if (channel) {
      try {
        postLocal({ __coordinatorStartup: { kind: 'serving' } });
      } catch { /* The serving announcement is best-effort; tabs reconcile by sequence. */ }
    }
    return { sequence, persistence, owner: true };
  }

  function proxyMethod(method) {
    return (...args) => {
      const operationArg = method !== 'subscribe'
        ? args.find((arg) => arg && typeof arg === 'object' && 'operationId' in arg)
        : undefined;
      const operationId = operationArg?.operationId;
      const id = ++requestId;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          // The owner is gone or not answering. Mark the connection lost so
          // a later initialize()/reconnect() re-runs the lock election
          // instead of returning the stale started state. Mutations carry
          // their durable operationId and report 'unconfirmed' so the caller
          // retries with the SAME operationId; reads report 'unavailable'.
          connectionLost = true;
          if (operationId !== undefined && operationId !== null) {
            reject(new StorageError('unconfirmed', 'The database owner did not confirm the save. Retry with the same change.', { operationId }));
          } else {
            reject(new StorageError('unavailable', 'The database owner is not responding. Reconnect storage and retry.'));
          }
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer });
      });
      postLocal({ __coordinatorRpc: true, direction: 'request', id, method, args, version: COORDINATOR_VERSION });
      return promise.then((value) => {
        if (typeof value?.sequence === 'number' && value.sequence > sequence) sequence = value.sequence;
        if (value?.operationId) seenOperations.set(value.operationId, value);
        return value;
      });
    };
  }

  async function initialize() {
    if (started && !connectionLost) return { sequence, persistence: { requested: false, granted: false }, owner: isOwner };
    // Recovery path: a previous owner stopped answering. Drop the dead
    // proxy, keep durable operation IDs, and re-run the lock election.
    if (connectionLost) {
      for (const [, waiter] of pending) {
        try {
          waiter.reject(new StorageError('unavailable', 'The database owner changed. Reconnect storage and retry.'));
        } catch { /* A bad waiter never breaks recovery. */ }
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      }
      pending.clear();
      // Reconnecting from an owned tab must terminate its worker first, or
      // the orphan would keep the lifetime lock and a fresh worker could
      // never start. Client proxies have no closeable resources.
      if ((phase === 'serving' || phase === 'starting') && repository) {
        try {
          if (typeof repository.close === 'function') await repository.close();
        } catch { /* Termination is best-effort. */ }
      }
      repository = null;
      isOwner = false;
      connectionLost = false;
      started = false;
      phase = 'idle';
      startupYield = null;
      servingAttached = false;
    }
    started = true;
    if (channel) attachChannel(channel);
    let persistence = { requested: false, granted: false };
    try {
      if (storage?.persist) {
        persistence = { requested: true, granted: await storage.persist() };
      }
    } catch { persistence = { requested: true, granted: false }; }
    if (!locks) throw new StorageError('unavailable', 'Web Locks are required for safe database access.');
    // Never take ownership while the lock is held. Query first: a lock held
    // by any tab (including this page, where the same agent may re-grant an
    // ifAvailable request) must select the proxy path without spawning a
    // competing owner or touching OPFS files.
    let lockHeld = false;
    try {
      const status = await locks.query?.();
      lockHeld = Array.isArray(status?.held)
        && status.held.some((entry) => entry?.name === DATABASE_LOCK);
    } catch { lockHeld = false; }
    // Try exclusive ownership without waiting: another tab may hold it.
    let owned = false;
    if (!lockHeld) {
      try {
        owned = await locks.request(DATABASE_LOCK, { mode: 'exclusive', ifAvailable: true }, async (granted) => {
          // Some Chromium builds invoke the callback with null when the
          // lock cannot be granted instead of resolving without invoking
          // it. A null grant is a refusal, never ownership.
          if (granted === null) return false;
          if (!spawnOwner) throw new StorageError('unavailable', 'No database owner factory.');
          repository = await spawnOwner();
          return true;
        });
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError('unavailable', 'Could not open the task database.');
      }
    }
    if (owned === true) {
      return claimOwnership(persistence);
    }
    // Client tab: proxy through the owner over the channel.
    phase = 'client';
    isOwner = false;
    await waitForServing();
    repository = Object.fromEntries([...REPOSITORY_METHODS, 'initialize'].map((method) => [method, proxyMethod(method)]));
    const state = await repository.initialize();
    if (typeof state?.sequence === 'number') sequence = state.sequence;
    return { sequence, persistence, owner: false };
  }

  // Reconcile after resume: fetch the current list and publish if behind.
  async function reconcile() {
    const current = await repository.list();
    if (current.sequence > sequence) {
      sequence = current.sequence;
      publish({ sequence, operationId: null, ids: null, remote: true });
    }
    return current;
  }

  function requireStarted() {
    if (!started || !repository) throw new StorageError('unavailable', 'The task database is not initialized.');
  }

  // Wrap a mutation so an uncertain reply (transport failure after the owner
  // committed) is recovered by reissuing the SAME operationId instead of
  // reporting success or duplicating the write.
  async function mutateWithRecovery(method, args, options = {}) {
    requireStarted();
    const operationId = options.operationId ?? newOperationId();
    const callArgs = args.map((arg) => arg);
    const optionsIndex = callArgs.findIndex((arg) => arg && typeof arg === 'object' && ('expectedRevision' in arg || 'expectedSourceRevision' in arg || 'operationId' in arg));
    if (optionsIndex >= 0) callArgs[optionsIndex] = { ...callArgs[optionsIndex], operationId };
    else if (method === 'create' || method === 'importBackup') callArgs.push({ operationId });
    try {
      return await repository[method](...callArgs);
    } catch (error) {
      if (error && typeof error === 'object' && (error.code === 'unconfirmed' || error.message === 'Transport lost')) {
        if (seenOperations.has(operationId)) return seenOperations.get(operationId);
        const recovered = await repository[method](...callArgs);
        seenOperations.set(operationId, recovered);
        return recovered;
      }
      throw error;
    }
  }

  // Fail unanswered requests and re-elect through the Web Lock. Durable
  // operation IDs (seenOperations) survive, so uncertain mutations are
  // still recovered idempotently after the new owner is ready.
  async function reconnect() {
    connectionLost = true;
    return initialize();
  }

  const api = {
    subscribe,
    initialize,
    reconnect,
    reconcile,
    get owner() { return isOwner; },
    get currentSequence() { return sequence; },
    async list(...args) { requireStarted(); return repository.list(...args); },
    async create(input, options) { requireStarted(); return mutateWithRecovery('create', [input, options ?? {}], options); },
    async update(id, input, options) { requireStarted(); return mutateWithRecovery('update', [id, input, options ?? {}], options); },
    async setCompleted(id, completed, options) { requireStarted(); return mutateWithRecovery('setCompleted', [id, completed, options ?? {}], options); },
    async delete(id, options) { requireStarted(); return mutateWithRecovery('delete', [id, options ?? {}], options); },
    async saveEmbedding(id, input, options) { requireStarted(); return mutateWithRecovery('saveEmbedding', [id, input, options ?? {}], options); },
    async pendingEmbeddings(...args) { requireStarted(); return repository.pendingEmbeddings(...args); },
    async search(...args) { requireStarted(); return repository.search(...args); },
    async exportBackup(...args) { requireStarted(); return repository.exportBackup(...args); },
    async importBackup(document, options) { requireStarted(); return mutateWithRecovery('importBackup', [document, options ?? {}], options); },
    // Test hooks (never part of the repository contract).
    __test: { handleRemoteCommit, pending, seenOperations },
  };
  return api;
}
