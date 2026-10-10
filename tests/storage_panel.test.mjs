import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { initStoragePanel, storageMessage, MAX_BACKUP_BYTES } from '../app/static/storage-panel.mjs';

globalThis.crypto ??= webcrypto;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise,resolve}; };
function element() {
  const listeners = new Map();
  return { textContent:'',hidden:false,disabled:false,value:'',files:[],attrs:{},
    setAttribute(key,value) { this.attrs[key] = value; },
    addEventListener(type,handler) { listeners.set(type,handler); },
    removeEventListener(type) { listeners.delete(type); },
    click() { this.clicked = true; return listeners.get('click')?.(); },
    contains(value) { return value === this; },
  };
}
function fixture(extra = {}) {
  const elements = Object.fromEntries(['panel','status','error','exportButton','importButton','fileInput','retryButton'].map(key => [key,element()]));
  const calls = [], downloaded = [], imported = [];
  const store = {
    async exportBackup() { calls.push('export'); return {format:'local-todo',version:1,todos:[]}; },
    async importBackup(document,options) { calls.push({document,options}); return {imported:1,skipped:2}; },
    ...extra.store,
  };
  const panel = initStoragePanel({ ...elements,root:null,getRepository:async () => store,
    download:text => downloaded.push(text),onImported:result => imported.push(result),recover:async () => {},...extra,...elements });
  return { panel,elements,store,calls,downloaded,imported };
}
const file = text => ({size:Buffer.byteLength(text),text:async () => text});

test('storage status distinguishes unavailable, unconfirmed, quota and protection denial', () => {
  const f = fixture();
  f.panel.setReady({persistence:{granted:false}});
  assert.match(f.elements.status.textContent,/not granted.*export a backup/);
  f.panel.setError({code:'quota'});
  assert.match(f.elements.error.textContent,/full.*not confirmed/);
  f.panel.setError({code:'unconfirmed'});
  assert.match(f.elements.error.textContent,/not confirmed.*same change.*draft is kept/);
  f.panel.setError({code:'unavailable',message:'OPFS unavailable'});
  assert.equal(f.elements.error.textContent,'OPFS unavailable');
  assert.equal(f.elements.retryButton.hidden,false);
  assert.match(storageMessage(),/Persistent local storage is unavailable/);
});

test('export downloads exactly the versioned repository backup', async () => {
  const f = fixture();
  await f.panel.exportTasks();
  assert.deepEqual(f.calls,['export']);
  assert.deepEqual(JSON.parse(f.downloaded[0]),{format:'local-todo',version:1,todos:[]});
  assert.equal(f.elements.status.textContent,'Backup exported.');
});

test('import reports success only after the durable repository promise resolves', async () => {
  const gate = deferred();
  const f = fixture({store:{importBackup:async () => { await gate.promise; return {imported:3,skipped:1}; }}});
  const saving = f.panel.importFile(file('{"format":"local-todo","version":1,"todos":[]}'));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.elements.panel.attrs['aria-busy'],'true');
  assert.equal(f.imported.length,0);
  assert.doesNotMatch(f.elements.status.textContent,/Imported/);
  gate.resolve(); await saving;
  assert.equal(f.elements.status.textContent,'Imported 3 tasks · 1 unchanged.');
  assert.deepEqual(f.imported,[{imported:3,skipped:1}]);
});

test('malformed or oversized backups are rejected before entering the repository', async () => {
  const f = fixture();
  await f.panel.importFile(file('not json'));
  assert.match(f.elements.error.textContent,/valid JSON/);
  await f.panel.importFile({size:MAX_BACKUP_BYTES+1,text:() => assert.fail('Oversized file must not be read')});
  assert.match(f.elements.error.textContent,/too large/);
  assert.equal(f.calls.length,0);
});

test('repository validation and conflicting IDs never show an import success', async () => {
  for (const code of ['validation','conflict']) {
    const f = fixture({store:{importBackup:async () => { throw Object.assign(new Error('Rejected backup'),{code}); }}});
    await f.panel.importFile(file('{"version":999}'));
    assert.equal(f.elements.error.textContent,'Rejected backup');
    assert.equal(f.imported.length,0);
    assert.doesNotMatch(f.elements.status.textContent,/Imported/);
    assert.equal(f.elements.importButton.textContent,'Import');
  }
});

test('uncertain imports reuse the parsed backup and durable operation ID', async () => {
  const calls = [];
  const f = fixture({store:{importBackup:async (document,options) => {
    calls.push({document,options});
    if (calls.length === 1) throw Object.assign(new Error('Flush failed'),{code:'unconfirmed'});
    return {imported:1,skipped:0};
  }}});
  await f.panel.importFile(file('{"format":"local-todo","version":1,"todos":[]}'));
  assert.equal(f.elements.importButton.textContent,'Retry import');
  assert.equal(f.imported.length,0);
  await f.panel.importFile();
  assert.equal(calls[0].document,calls[1].document);
  assert.equal(calls[0].options.operationId,calls[1].options.operationId);
  assert.ok(calls[0].options.operationId);
  assert.equal(f.imported.length,1);
});

test('recovery leaves failed task changes to their own retry and teardown removes handlers', async () => {
  let recoveries = 0;
  const f = fixture({isBusy:() => true,recover:async () => { ++recoveries; }});
  await f.panel.exportTasks();
  await f.panel.importFile(file('{}'));
  assert.equal(f.calls.length,0);
  await f.panel.recover();
  assert.equal(recoveries,1,'Storage recovery remains available while a task is unconfirmed');
  f.panel.destroy();
  await f.elements.retryButton.click();
  assert.equal(recoveries,1);
});
