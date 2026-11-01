import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { test } from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const logs = [];
const fakeLog = { addLog: (...args) => logs.push(args), addOrUpdateLog() {} };
const cache = new Map();
const obsidian = {
  normalizePath: p => path.posix.normalize(p.replaceAll('\\', '/')),
  Notice: class { setMessage() {} hide() {} },
  Platform: { isMobile: false }, TFolder: class {}, TFile: class {}, App: class {},
};
function load(rel) {
  rel = rel.replace(/\.ts$/, '');
  if (cache.has(rel)) return cache.get(rel);
  const module = { exports: {} };
  cache.set(rel, module.exports);
  const source = fs.readFileSync(path.join(root, rel + '.ts'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020,
  }}).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, console, TextDecoder,
    Uint8Array, ArrayBuffer, WebSocket: { OPEN: 1 }, crypto: { getRandomValues: a => a },
    window: { setTimeout, clearTimeout }, activeDocument: undefined,
    require(id) {
      if (id === 'obsidian') return obsidian;
      if (id.includes('i18n/lang')) return { $: (key, data) => key + (data ? JSON.stringify(data) : '') };
      if (id.includes('sync_log_manager')) return { SyncLogManager: { getInstance: () => fakeLog } };
      if (id.includes('helpers_obsidian_bypass')) return { dump() {}, dumpError() {}, vaultDelete() {} };
      if (id.includes('file_cloud_preview')) return { FileCloudPreview: { isRestrictedType: () => false } };
      if (id.includes('http_api_service')) return { HttpApiService: class {} };
      if (id.endsWith('/main')) return {};
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), id)));
    },
  }, { filename: rel });
  return module.exports;
}
const helpers = load('src/lib/utils/helpers');
const config = load('src/lib/sync/operator_config');
const files = load('src/lib/sync/operator_file');
const { SyncState } = load('src/lib/sync/sync_state');

// Execute the actual exported function body with controlled host/network dependencies.
function loadFunction(name, globals) {
  const source=fs.readFileSync(path.join(root,'src/lib/sync/operator.ts'),'utf8');
  const ast=ts.createSourceFile('operator.ts',source,ts.ScriptTarget.Latest,true);
  const statement=ast.statements.find(n=>
    (ts.isFunctionDeclaration(n) && n.name?.text===name) ||
    (ts.isVariableStatement(n) && n.declarationList.declarations.some(d=>d.name.getText(ast)===name)));
  assert.ok(statement, 'Function must exist: '+name);
  const code=ts.transpileModule(statement.getText(ast),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
  const module={exports:{}};
  vm.runInNewContext(code,{module,exports:module.exports,console,Date,
    window:{setTimeout:()=>0,clearInterval(){},clearTimeout(){}},
    dump(){},getPluginDir:()=>'.obsidian/plugins/fast-note-sync',
    generateUUID:()=> 'test-context',showSyncNotice(){},$:(key)=>key,...globals});
  return module.exports[name];
}

function fixture() {
  const data = new Map(); const hashes = new Map(); const metadata = new Map([['lastConfigSyncTime', 100]]);
  const sent = []; const completed = [];
  const adapter = {
    exists: async p => data.has(p),
    stat: async p => data.has(p) ? { type: 'file', mtime: data.get(p).mtime, ctime: 1, size: Buffer.byteLength(data.get(p).text) } : null,
    read: async p => data.get(p).text,
    readBinary: async p => Uint8Array.from(Buffer.from(data.get(p).text)).buffer,
    write: async (p, text) => data.set(p, { text, mtime: 200 }),
    remove: async p => data.delete(p), mkdir: async () => {},
    rename: async (a,b) => { data.set(b, data.get(a)); data.delete(a); },
  };
  const plugin = {
    manifest: { id: 'fast-note-sync', dir: '.obsidian/plugins/fast-note-sync' },
    app: { vault: { configDir: '.obsidian', adapter, getFileByPath: () => null } },
    settings: { vault: 'synthetic-test', syncEnabled: true, configSyncEnabled: true, syncExcludeWhitelist: '', syncExcludeFolders: '' },
    syncState: new SyncState(), configSyncTasks: { failed: 0 }, fileSyncTasks: { failed: 0 },
    ignoredConfigFiles: new Set(), pendingConfigModifies: new Map(), pendingConfigDeleteAcks: new Set(),
    pendingFileDeleteAcks: new Set(), lastSyncPathDeleted: new Set(), lastSyncMtime: new Map(),
    fileDownloadSessions: new Map(),
    localStorageManager: { syncPathPrefix: 'localstorage/', getMetadata: k => metadata.get(k),
      setMetadata: (k, v) => metadata.set(k, v), savePending() {} },
    configHashManager: { getAllPaths: () => Array.from(hashes.keys()), getPathHash: p => hashes.get(p) ?? null, getValidHash: () => null, isReady: () => true,
      removeFileHash: p => hashes.delete(p), setFileHash: (p, h) => hashes.set(p, h) },
    concurrencyLimiter: { waitForSlot: async () => {}, releaseSlot() {} },
    websocket: { SendMessage: async (...args) => sent.push(args) },
    recordSyncCompleted: (...args) => completed.push(args),
    addIgnoredConfigFile(p) { this.ignoredConfigFiles.add(p); },
    removeIgnoredConfigFile(p) { this.ignoredConfigFiles.delete(p); },
  };
  if (fs.existsSync(path.join(root, 'src/lib/sync/config_safety.ts'))) {
    const { ConfigSafety } = load('src/lib/sync/config_safety');
    plugin.configSafety = new ConfigSafety(plugin);
  }
  return { plugin, data, hashes, metadata, sent, completed };
}
const target = '.obsidian/plugins/diary-stream/main.js';

test('ordinary attachment update cannot download a configuration path, even whitelisted', async () => {
  const f = fixture(); f.plugin.settings.syncExcludeWhitelist = JSON.stringify([{ pattern: target }]);
  await files.receiveFileSyncUpdate({ path: target, pathHash: 'x', size: 12, pageIndex: 2 }, f.plugin);
  assert.equal(f.sent.length, 0);
  assert.equal(f.plugin.fileDownloadSessions.size, 0);
  assert.equal(f.completed.length, 1);
});
test('a remote tombstone preserves a reinstalled or changed configuration', async () => {
  const f = fixture(); f.data.set(target, { text: 'reinstalled', mtime: 50 });
  f.hashes.set(target, helpers.hashContent('old-version'));
  await config.receiveConfigSyncDelete({ path: target, pageIndex: 1 }, f.plugin);
  assert.equal(f.data.get(target)?.text, 'reinstalled');
  assert.equal(f.plugin.configSyncTasks.failed, 1);
});
test('first-sync raw event cannot overwrite server configuration before comparison', async () => {
  const f = fixture(); f.metadata.set('lastConfigSyncTime', 0);
  f.data.set(target, { text: 'local-first', mtime: 200 });
  await config.configModify(target, f.plugin, true);
  assert.equal(f.sent.length, 0);
});
test('a whitelist cannot expose the sync plugin connection settings', () => {
  const f = fixture(); const self = '.obsidian/plugins/fast-note-sync/data.json';
  f.plugin.settings.syncExcludeWhitelist = JSON.stringify([{ pattern: self }]);
  assert.equal(helpers.configIsPathExcluded(self, f.plugin), true);
});

test('ordinary attachments still enter the normal download path', async () => {
  const f = fixture();
  await files.receiveFileSyncUpdate({ path: '附件/中文 图片.png', pathHash: 'ordinary', size: 12 }, f.plugin);
  assert.equal(f.sent[0][0], 'FileChunkDownload');
  assert.equal(f.plugin.fileDownloadSessions.size, 1);
});
test('a confirmed unchanged configuration accepts server deletion', async () => {
  const f = fixture(); f.data.set(target, { text: 'synced', mtime: 50 });
  f.hashes.set(target, helpers.hashContent('synced'));
  await f.plugin.configSafety.confirm(target, helpers.hashContent('synced'));
  await config.receiveConfigSyncDelete({ path: target }, f.plugin);
  assert.equal(f.data.has(target), false);
  assert.equal(f.hashes.has(target), false);
  assert.equal(f.plugin.configSyncTasks.failed, 0);
});
test('unknown configurations are retained when a tombstone is received', async () => {
  const f = fixture(); f.data.set(target, { text: 'newly installed', mtime: 50 });
  await config.receiveConfigSyncDelete({ path: target }, f.plugin);
  assert.equal(f.data.has(target), true);
  assert.equal(await f.plugin.configSafety.has(target), true);
});
test('a cold-built local hash is not a confirmed baseline during first sync', async () => {
  const f = fixture(); f.metadata.set('lastConfigSyncTime', 0);
  f.data.set(target, { text: 'cold local', mtime: 50 });
  f.hashes.set(target, helpers.hashContent('cold local'));
  await f.plugin.configSafety.beginRound();
  f.metadata.set('lastConfigSyncTime', 500); // SyncEnd arrived before deletion page.
  await config.receiveConfigSyncDelete({ path: target }, f.plugin);
  assert.equal(f.data.has(target), true);
});
test('pending upload protects a file even when its hash matches the cached baseline', async () => {
  const f = fixture(); f.data.set(target, { text: 'local edit', mtime: 50 });
  const hash = helpers.hashContent('local edit'); f.hashes.set(target, hash);
  f.plugin.pendingConfigModifies.set(target, hash);
  await config.receiveConfigSyncDelete({ path: target }, f.plugin);
  assert.equal(f.data.has(target), true);
});
test('held conflicts survive restart and reject both requested uploads and remote overwrite', async () => {
  const f = fixture(); f.data.set(target, { text: 'keep this', mtime: 50 });
  await config.receiveConfigSyncDelete({ path: target }, f.plugin);
  const { ConfigSafety } = load('src/lib/sync/config_safety');
  f.plugin.configSafety = new ConfigSafety(f.plugin);
  await config.receiveConfigUpload({ path: target, pageIndex: 3 }, f.plugin);
  await config.receiveConfigSyncModify({ path: target, content: 'remote overwrite', pageIndex: 4 }, f.plugin);
  await config.configModify(target, f.plugin, true);
  assert.equal(f.data.get(target).text, 'keep this');
  assert.equal(f.sent.length, 0);
  assert.equal(await f.plugin.configSafety.has(target), true);
});
test('failed local delete retains the hash and leaves the cursor unchanged', async () => {
  const f = fixture(); f.data.set(target, { text: 'synced', mtime: 50 });
  const hash = helpers.hashContent('synced'); f.hashes.set(target, hash);
  await f.plugin.configSafety.confirm(target, hash);
  f.plugin.app.vault.adapter.remove = async () => { throw new Error('disk denied'); };
  await config.receiveConfigSyncDelete({ path: target, lastTime: 999 }, f.plugin);
  assert.equal(f.hashes.get(target), hash);
  assert.equal(f.metadata.get('lastConfigSyncTime'), 100);
  assert.equal(f.plugin.configSyncTasks.failed, 1);
});
test('failed conflict persistence cannot permit deletion', async () => {
  const f = fixture(); f.data.set(target, { text: 'local edit', mtime: 50 });
  const originalWrite = f.plugin.app.vault.adapter.write;
  f.plugin.app.vault.adapter.write = async (p, text) => {
    if (p.endsWith('config-delete-conflicts.json')) throw new Error('disk full');
    return originalWrite(p, text);
  };
  await config.receiveConfigSyncDelete({ path: target }, f.plugin);
  assert.equal(f.data.get(target).text, 'local edit');
  assert.equal(f.plugin.configSyncTasks.failed, 1);
});
test('ordinary-file delete, mtime, rename and unsolicited chunks cannot touch configuration', async () => {
  const f = fixture(); f.data.set(target, { text: 'keep', mtime: 50 });
  await files.receiveFileSyncDelete({ path: target }, f.plugin);
  await files.receiveFileSyncMtime({ path: target, mtime: 999 }, f.plugin);
  await files.receiveFileSyncRename({ oldPath: target, path: '附件/leaked.js' }, f.plugin);
  await files.receiveFileSyncChunkDownload({ path: target }, f.plugin);
  assert.equal(f.data.get(target).text, 'keep');
  assert.equal(f.sent.length, 0);
});
test('conflict index and temporary index are excluded even through a whitelist', () => {
  const f = fixture();
  for (const suffix of ['config-delete-conflicts.json', 'config-delete-conflicts.json.tmp']) {
    const p = '.obsidian/plugins/fast-note-sync/' + suffix;
    f.plugin.settings.syncExcludeWhitelist = JSON.stringify([{pattern:p}]);
    assert.equal(helpers.configIsPathExcluded(p, f.plugin), true);
  }
});
test('server-requested upload of a local-only file remains possible on first sync', async () => {
  const f = fixture(); f.metadata.set('lastConfigSyncTime', 0);
  f.data.set(target, { text: 'local-only', mtime: 50 });
  await config.receiveConfigUpload({ path: target, pageIndex: 1 }, f.plugin);
  assert.equal(f.sent[0][0], 'SettingModify');
  assert.equal(f.sent[0][1].content, 'local-only');
});
test('explicitly retaining a held conflict sends the local content', async () => {
  const f = fixture(); f.data.set(target, { text: 'local kept', mtime: 50 });
  await f.plugin.configSafety.hold(target);
  await config.configModify(target, f.plugin, false, undefined, true);
  assert.equal(f.sent[0][1].content, 'local kept');
  assert.equal(f.plugin.pendingConfigModifies.has(target), true);
});
test('concurrent conflict writes retain both paths', async () => {
  const f = fixture();
  await Promise.all([f.plugin.configSafety.hold('one'), f.plugin.configSafety.hold('two')]);
  const { ConfigSafety } = load('src/lib/sync/config_safety');
  const restarted = new ConfigSafety(f.plugin);
  assert.deepEqual(Array.from(await restarted.paths()).sort(), ['one', 'two']);
});
test('interrupted main-index write is recovered from the complete journal', async () => {
  const f = fixture();
  const write = f.plugin.app.vault.adapter.write;
  f.plugin.app.vault.adapter.write = async (p, text) => {
    if (p.endsWith('config-delete-conflicts.json')) throw new Error('interrupted');
    return write(p,text);
  };
  await assert.rejects(f.plugin.configSafety.hold(target));
  const { ConfigSafety } = load('src/lib/sync/config_safety');
  const restarted = new ConfigSafety(f.plugin);
  assert.equal(await restarted.has(target), true);
});
test('a rebuilt cache after previous sync does not authorize remote deletion', async () => {
  const f = fixture(); f.data.set(target, {text:'unconfirmed rebuild',mtime:50});
  f.hashes.set(target,helpers.hashContent('unconfirmed rebuild'));
  await config.receiveConfigSyncDelete({path:target},f.plugin);
  assert.equal(f.data.has(target),true);
});
test('failed incoming configuration write cannot update its confirmed hash', async () => {
  const f = fixture(); f.data.set(target,{text:'original',mtime:50});
  const old=helpers.hashContent('original'); f.hashes.set(target,old);
  f.plugin.app.vault.adapter.write = async () => {throw new Error('read only disk');};
  await config.receiveConfigSyncModify({path:target,content:'remote',contentHash:'new',mtime:200,ctime:1},f.plugin);
  assert.equal(f.data.get(target).text,'original');
  assert.equal(f.hashes.get(target),old);
  assert.equal(f.plugin.ignoredConfigFiles.has(target),false);
  assert.equal(f.plugin.configSyncTasks.failed,1);
});
test('configured alternate Obsidian directories are also protected', async () => {
  const f = fixture(); f.plugin.app.vault.configDir='.obsidian-mobile';
  await files.receiveFileSyncUpdate({path:'.obsidian-mobile/plugins/foo/main.js',size:10},f.plugin);
  assert.equal(f.sent.length,0);
});
test('an open socket without authorization queues full sync without sending or reconnecting', async () => {
  const f=fixture(); let reconnects=0;
  Object.assign(f.plugin.websocket,{isAuth:false,isConnected:()=>true,triggerReconnect:()=>reconnects++});
  f.plugin.menuManager={ribbonIconStatus:true};
  f.plugin.updateStatusBar=()=>{};
  const handleSync=loadFunction('handleSync',{});
  await handleSync(f.plugin,false);
  assert.equal(f.plugin.syncState.pendingSyncType,'full');
  assert.equal(f.plugin.syncState.activeSyncContext,null);
  assert.equal(f.plugin.isSyncing,false);
  assert.equal(reconnects,0);
  assert.equal(f.sent.length,0);
});
test('a closed unauthorized socket requests reconnection and preserves the requested sync mode', async () => {
  const f=fixture();let reconnects=0;
  Object.assign(f.plugin.websocket,{isAuth:false,isConnected:()=>false,triggerReconnect:()=>reconnects++});
  f.plugin.updateStatusBar=()=>{};
  await loadFunction('handleSync',{})(f.plugin,true);
  assert.equal(reconnects,1);
  assert.equal(f.plugin.syncState.pendingSyncType,'incremental');
});
test('a stalled configuration round reports incomplete even without attachment downloads', () => {
  const f=fixture(); const statuses=[];
  f.plugin.resetSyncTasks=()=>{};
  f.plugin.syncPageStateMap=new Map();
  f.plugin.progressTracker={forceComplete(){}};
  f.plugin.updateStatusBar=text=>statuses.push(text);
  loadFunction('checkSyncCompletion',{})(f.plugin,undefined,Date.now()-300001);
  assert.deepEqual(statuses,['ui.status.timeout_partial']);
});
test('sending a configuration inventory does not mark its contents as uploaded', async () => {
  const f=fixture();f.plugin.settings.syncEnabled=false;
  const sendSyncInBatches=async (...args)=> { args.at(-1)?.(); };
  const d={context:'test',lastTime:0,configs:[{path:target,contentHash:'local'}],delConfigs:[],missingConfigs:[]};
  await loadFunction('handleRequestSend',{sendSyncInBatches})(f.plugin,'config',{}, {},d,{});
  assert.equal(f.plugin.pendingConfigModifies.size,0);
});
test('a pending connection-settings change cannot send sync over the old authorized socket', async () => {
  const f=fixture();f.plugin.wsSettingChange=true;
  Object.assign(f.plugin.websocket,{isAuth:true,isConnected:()=>true,triggerReconnect(){throw new Error('unnecessary reconnect');}});
  f.plugin.updateStatusBar=()=>{};
  await loadFunction('handleSync',{})(f.plugin,false);
  assert.equal(f.plugin.syncState.pendingSyncType,'full');
  assert.equal(f.sent.length,0);
});
test('explicit Keep local uploads even if the local content matches an old cached version', async () => {
  const f=fixture(); const text='same cached content';
  f.data.set(target,{text,mtime:50});f.hashes.set(target,helpers.hashContent(text));f.plugin.lastSyncMtime.set(target,50);
  await f.plugin.configSafety.hold(target);
  await config.configModify(target,f.plugin,false,undefined,true);
  assert.equal(f.sent.length,1);
  assert.equal(f.sent[0][1].content,text);
});

export { fixture, load, helpers, config, files, target, root };
