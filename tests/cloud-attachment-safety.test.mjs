import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const cache = new Map();
class TFile {}
const obsidian = { normalizePath: p => path.posix.normalize(p), TFile, TFolder: class {}, Platform: {}, Notice: class {} };
function load(rel) {
  rel = rel.replace(/\.ts$/, '');
  if (cache.has(rel)) return cache.get(rel);
  const module = { exports: {} }; cache.set(rel, module.exports);
  const source = fs.readFileSync(path.join(root, rel + '.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, console, crypto: webcrypto, URLSearchParams, ArrayBuffer, Uint8Array, TextEncoder, TextDecoder,
    window: { setTimeout, clearTimeout },
    require(id) {
      if (id === 'obsidian') return obsidian;
      if (id.includes('i18n/lang')) return { $: x => x };
      if (id.includes('helpers_obsidian_bypass')) return { dump() {}, dumpError() {}, vaultDelete() {} };
      if (id.includes('sync_log_manager')) return { SyncLogManager: { getInstance: () => ({ addLog() {}, addOrUpdateLog() {} }) } };
      if (id.includes('http_api_service')) return { HttpApiService: class {} };
      return load(path.posix.normalize(path.posix.join(path.posix.dirname(rel), id)));
    },
  }, { filename: rel });
  return module.exports;
}
const { CloudAttachmentSafety } = load('src/lib/storage/cloud_attachment_safety');
const { isCloudOnlyEligible } = load('src/lib/storage/cloud_attachment_policy');
const helpers = load('src/lib/utils/helpers');
const files = load('src/lib/sync/operator_file');
const bytes = s => new TextEncoder().encode(s).buffer;

async function fixture({ content = bytes('small image payload'), path: filePath = '附件/测试 图片.png' } = {}) {
  const disk = new Map(), local = new Map(), sent = [], trashed = [], hashes = new Map();
  const file = Object.assign(new TFile(), { path: filePath, stat: { size: content.byteLength, mtime: 123, ctime: 123 } });
  local.set(filePath, { file, content });
  const hash = await helpers.hashArrayBuffer(content);
  const info = { path: filePath, size: content.byteLength, mtime: 123, contentHash: hash, isRecycle: false, updatedAt: 'version-one' };
  const state = { info, remote: content.slice(0), readCount: 0, beforeRemote: null, beforeWrite: null, failWrite: false, failTrash: false };
  const settings = { api: 'http://isolated.test', apiToken: 'test-only', vault: 'synthetic', syncEnabled: true,
    readonlySyncEnabled: false, cloudPreviewEnabled: true, cloudPreviewAutoDeleteLocal: true,
    cloudPreviewMaxSizeMb: 10, cloudPreviewMediaTypes: ['image', 'audio'] };
  const plugin = {
    settings, manifest: { id: 'fast-note-sync' },
    app: {
      vault: {
        configDir: '.obsidian',
        adapter: {
          exists: async p => disk.has(p), read: async p => disk.get(p),
          write: async (p, text) => { if (state.beforeWrite) await state.beforeWrite(p); if (state.failWrite) throw new Error('disk full'); disk.set(p, text); },
          remove: async p => { disk.delete(p); },
        },
        getFileByPath: p => local.get(p)?.file ?? null,
        readBinary: async f => { state.readCount++; return local.get(f.path).content.slice(0); },
        createBinary: async (p, data) => {
          const created = Object.assign(new TFile(), { path: p, stat: { size: data.byteLength, mtime: 1, ctime: 1 }, extension: p.split('.').pop() });
          local.set(p, { file: created, content: data });
          return created;
        },
      },
      fileManager: { trashFile: async f => { if (state.failTrash) throw new Error('trash denied'); trashed.push(f.path); local.delete(f.path); } },
      metadataCache: { resolvedLinks: { '笔记.md': { [filePath]: 1 } } },
    },
    lockManager: { withLock: async (_, fn) => fn() },
    fileHashManager: { removeFileHash: p => hashes.delete(p), flush() {} },
    api: { getFileInfo: async () => state.info,
      getFileContentForVerification: async () => { if (state.beforeRemote) await state.beforeRemote(); return state.remote.slice(0); } },
    websocket: { SendMessage: async (...args) => sent.push(args) },
  };
  const safety = plugin.cloudAttachmentSafety = new CloudAttachmentSafety(plugin);
  await safety.initialize();
  return { plugin, safety, settings, local, disk, state, sent, trashed, file, hash, content, filePath,
    stage: () => safety.prepareUpload(filePath, hash, content),
    ack: () => safety.afterUploadAck(filePath, hash) };
}

test('verified upload acknowledgement cleans only local content and persists cloud-only intent', async () => {
  const f = await fixture(); await f.stage(); assert.equal(await f.ack(), true);
  assert.equal(f.local.has(f.filePath), false); assert.equal(f.state.info.isRecycle, false);
  assert.equal(f.safety.protects(f.filePath), true); assert.equal(f.safety.protects('附件'), true);
  assert.equal(f.trashed.length, 1); assert.equal(f.sent.length, 0);
});
test('sending bytes without an upload acknowledgement never cleans local files', async () => {
  const f = await fixture(); await f.stage(); assert.equal(f.trashed.length, 0);
  assert.equal(await f.safety.afterUploadAck(f.filePath, 'wrong version'), false);
  assert.equal(f.local.has(f.filePath), true);
});
test('missing or recycled cloud files retain local copies', async () => {
  for (const info of [null, { isRecycle: true }]) {
    const f = await fixture(); await f.stage(); f.state.info = info;
    assert.equal(await f.ack(), false); assert.equal(f.local.has(f.filePath), true);
  }
});
test('a server metadata hash mismatch retains local content', async () => {
  const f = await fixture(); await f.stage(); f.state.info.contentHash = 'another-version';
  assert.equal(await f.ack(), false); assert.equal(f.trashed.length, 0);
});
test('different cloud bytes cannot pass on matching path, size, time and protocol hash alone', async () => {
  const f = await fixture(); await f.stage(); new Uint8Array(f.state.remote)[1] ^= 1;
  assert.equal(await f.ack(), false); assert.equal(f.trashed.length, 0);
});
test('the full SHA-256 catches changes outside the protocol hash samples', async () => {
  const content = new ArrayBuffer(20 * 1024 * 1024); const f = await fixture({ content });
  f.settings.cloudPreviewMaxSizeMb = 20; await f.stage(); new Uint8Array(f.state.remote)[6 * 1024 * 1024] = 1;
  assert.equal(await helpers.hashArrayBuffer(f.state.remote), f.hash);
  assert.equal(await f.ack(), false); assert.equal(f.trashed.length, 0);
});
test('same-size local edits with unchanged timestamps during verification are retained', async () => {
  const f = await fixture(); await f.stage();
  f.state.beforeRemote = () => { new Uint8Array(f.local.get(f.filePath).content)[0] ^= 1; };
  assert.equal(await f.ack(), false); assert.equal(f.trashed.length, 0);
});
test('a local edit during journal persistence cannot be deleted', async () => {
  const f = await fixture(); await f.stage(); let edited = false;
  f.state.beforeWrite = () => { if (!edited) { edited = true; new Uint8Array(f.local.get(f.filePath).content)[0] ^= 1; } };
  assert.equal(await f.ack(), false); assert.equal(f.trashed.length, 0); assert.equal(f.safety.protects(f.filePath), false);
});
test('failure to persist cloud-only intent prevents cleanup', async () => {
  const f = await fixture(); await f.stage(); f.state.failWrite = true;
  await assert.rejects(f.ack(), /disk full/); assert.equal(f.trashed.length, 0);
});
test('trash failure retains the file and restores normal deletion intent', async () => {
  const f = await fixture(); await f.stage(); f.state.failTrash = true;
  await assert.rejects(f.ack(), /trash denied/); assert.equal(f.local.has(f.filePath), true);
  assert.equal(f.safety.protects(f.filePath), false);
});
test('cloud-only intent survives restart and blocks delayed deletion handlers', async () => {
  const f = await fixture(); await f.stage(); await f.ack();
  const restarted = f.plugin.cloudAttachmentSafety = new CloudAttachmentSafety(f.plugin); await restarted.initialize();
  assert.equal(restarted.protects(f.filePath), true);
  await files.fileDelete(f.file, f.plugin, true); await files.fileDeleteByPath(f.filePath, f.plugin);
  assert.equal(f.sent.length, 0);
});
test('an interrupted main journal write recovers the durable temporary record', async () => {
  const f = await fixture(); await f.stage(); await f.ack();
  const index = '.obsidian/plugins/fast-note-sync/cloud-attachments.json';
  f.disk.set(index + '.tmp', f.disk.get(index)); f.disk.set(index, '{broken');
  const restarted = new CloudAttachmentSafety(f.plugin); await restarted.initialize();
  assert.equal(restarted.protects(f.filePath), true);
});
test('corrupt intent journals stop cleanup instead of assuming there are no cloud-only files', async () => {
  const f = await fixture(); f.disk.set('.obsidian/plugins/fast-note-sync/cloud-attachments.json', '{broken');
  await assert.rejects(new CloudAttachmentSafety(f.plugin).initialize());
});
test('changing destination or token during verification retains local content', async () => {
  for (const change of [s => { s.vault = 'different'; }, s => { s.apiToken = 'rotated-test'; }]) {
    const f = await fixture(); await f.stage(); f.state.beforeRemote = () => change(f.settings);
    assert.equal(await f.ack(), false); assert.equal(f.trashed.length, 0);
  }
});
test('disabling cleanup, changing eligible types or lowering the limit cancels pending cleanup', async () => {
  for (const change of [s => { s.cloudPreviewAutoDeleteLocal = false; }, s => { s.cloudPreviewMediaTypes = []; }, s => { s.cloudPreviewMaxSizeMb = 0; }]) {
    const f = await fixture(); await f.stage(); f.state.beforeRemote = () => change(f.settings);
    assert.equal(await f.ack(), false); assert.equal(f.trashed.length, 0);
  }
});
test('unloading the plugin cancels pending cleanup', async () => {
  const f = await fixture(); await f.stage(); f.safety.stop(); assert.equal(await f.ack(), false);
});
test('50 MB and 100 MB PDFs and large media always keep local copies', async () => {
  const f = await fixture();
  for (const name of ['book.pdf', 'movie.mp4', 'recording.mp3', 'photo.png']) {
    for (const size of [50, 100].map(mb => mb * 1024 * 1024)) {
      assert.equal(isCloudOnlyEligible(name, size, { ...f.settings, cloudPreviewMaxSizeMb: 20,
        cloudPreviewMediaTypes: ['image', 'audio', 'pdf', 'video'] }), false);
    }
  }
});
test('only the selected types at or below the configured limit qualify', async () => {
  const { settings } = await fixture();
  assert.equal(isCloudOnlyEligible('photo.PNG', 10 * 1024 * 1024, settings), true);
  assert.equal(isCloudOnlyEligible('audio.mp3', 10 * 1024 * 1024 + 1, settings), false);
  assert.equal(isCloudOnlyEligible('book.pdf', 100, settings), false);
  assert.equal(isCloudOnlyEligible('book.pdf', 100, { ...settings, cloudPreviewMediaTypes: ['pdf'] }), true);
  assert.equal(isCloudOnlyEligible('unknown.zip', 100, settings), false);
  assert.equal(isCloudOnlyEligible('photo.png', undefined, settings), false);
  assert.equal(isCloudOnlyEligible('photo.png', 1, { ...settings, cloudPreviewMaxSizeMb: Infinity }), false);
  assert.equal(isCloudOnlyEligible('photo.png', 1, { ...settings, cloudPreviewMediaTypes: ['constructor'] }), false);
});
test('local-only journal files cannot be exposed through a configuration whitelist', async () => {
  const f = await fixture();
  for (const suffix of ['', '.tmp']) {
    const file = '.obsidian/plugins/fast-note-sync/cloud-attachments.json' + suffix;
    f.settings.syncExcludeWhitelist = JSON.stringify([{ pattern: file }]);
    assert.equal(helpers.configIsPathExcluded(file, f.plugin), true);
  }
});
test('recreated local attachments leave cloud-only state and short links resolve through the journal', async () => {
  const f = await fixture(); await f.stage(); await f.ack();
  assert.equal(f.safety.resolvePath('测试 图片.png', '日记/今天.md'), f.filePath);
  f.local.set(f.filePath, { file: f.file, content: f.content });
  await f.safety.localPresent(f.filePath); assert.equal(f.safety.protects(f.filePath), false);
});

test('an upload that no saved note references stays in the file list', async () => {
  const f = await fixture(); f.plugin.app.metadataCache.resolvedLinks = {};
  await f.stage(); assert.equal(await f.ack(), false);
  assert.equal(f.local.has(f.filePath), true); assert.equal(f.safety.protects(f.filePath), false);
});
test('a deleted local file whose note link is now unresolved stays in the cloud', async () => {
  const f = await fixture(); await f.stage(); assert.equal(await f.ack(), true);
  const name = f.filePath.split('/').pop();
  f.plugin.app.metadataCache.resolvedLinks = {};
  f.plugin.app.metadataCache.unresolvedLinks = { '笔记.md': { [name]: 1 } };
  await f.safety.reconcile();
  assert.equal(f.local.has(f.filePath), false);
  assert.equal(f.safety.protects(f.filePath), true);
});
test('removing the last note reference downloads the cloud file back', async () => {
  const f = await fixture(); await f.stage(); assert.equal(await f.ack(), true);
  f.plugin.app.metadataCache.resolvedLinks = {};
  await f.safety.reconcile();
  assert.equal(f.local.has(f.filePath), true);
  assert.equal(f.safety.protects(f.filePath), false);
  assert.equal(new Uint8Array(f.local.get(f.filePath).content)[0], new Uint8Array(f.content)[0]);
});
test('adding a note reference later cleans an already uploaded local file', async () => {
  const f = await fixture(); f.plugin.app.metadataCache.resolvedLinks = {};
  await f.stage(); assert.equal(await f.ack(), false);
  f.plugin.app.metadataCache.resolvedLinks = { '笔记.md': { [f.filePath]: 1 } };
  await f.safety.reconcile();
  assert.equal(f.local.has(f.filePath), false);
});
test('a timestamp-only update during verification still cleans identical bytes', async () => {
  const f = await fixture(); await f.stage();
  f.state.beforeRemote = () => { f.file.stat.mtime = 999; };
  assert.equal(await f.ack(), true);
  assert.equal(f.local.has(f.filePath), false);
});
test('a timestamp update cannot hide changed local bytes', async () => {
  const f = await fixture(); await f.stage();
  f.state.beforeRemote = () => {
    f.file.stat.mtime = 999;
    new Uint8Array(f.local.get(f.filePath).content)[0] ^= 1;
  };
  assert.equal(await f.ack(), false);
  assert.equal(f.trashed.length, 0);
  assert.equal(f.safety.protects(f.filePath), false);
});
test('server deduplication confirmation can clean unchanged bytes after its timestamp update', async () => {
  const f = await fixture(); await f.stage(); f.file.stat.mtime = 999;
  assert.equal(await f.safety.afterServerFileExists(f.filePath, f.hash), true);
  assert.equal(f.local.has(f.filePath), false);
});
test('deduplication metadata alone cannot clean changed local bytes', async () => {
  const f = await fixture(); await f.stage(); f.file.stat.mtime = 999;
  new Uint8Array(f.local.get(f.filePath).content)[0] ^= 1;
  assert.equal(await f.safety.afterServerFileExists(f.filePath, f.hash), false);
});

test('custom preview sources never trigger deletion verified only against the sync server', async () => {
  const f = await fixture(); f.settings.cloudPreviewRemoteUrl = '.png#https://example.test/{path}'; await f.stage();
  assert.equal(await f.ack(), false); assert.equal(f.trashed.length, 0);
});

test('deduplicated NoUpdate uploads can use authenticated server confirmation and full read-back', async () => {
  const f = await fixture(); await f.stage(); assert.equal(await f.safety.confirmExistingUpload(f.filePath, f.hash), true);
});
test('no-update confirmation never substitutes for a missing cloud file or different bytes', async () => {
  for (const missing of [true, false]) {
    const f = await fixture(); await f.stage();
    if (missing) f.state.info = null; else new Uint8Array(f.state.remote)[0] ^= 1;
    assert.equal(await f.safety.confirmExistingUpload(f.filePath, f.hash), false);
    assert.equal(f.trashed.length, 0);
  }
});
test('a delayed modify callback for a now-absent file cannot erase cloud-only intent', async () => {
  const f = await fixture(); await f.stage(); await f.ack();
  await f.safety.localPresent(f.filePath); assert.equal(f.safety.protects(f.filePath), true);
  await files.fileDelete(f.file, f.plugin, true); assert.equal(f.sent.length, 0);
});
const { HttpApiService } = load('src/lib/api/http_api_service');
async function receiverFixture({ referenced = false } = {}) {
  const f = await fixture();
  f.local.clear();
  f.plugin.app.metadataCache.resolvedLinks = {};
  f.plugin.app.metadataCache.unresolvedLinks = referenced ? { '笔记.md': { [f.filePath]: 1 } } : {};
  f.plugin.pendingFileDeleteAcks = new Set();
  f.plugin.fileDownloadSessions = new Map();
  f.plugin.concurrencyLimiter = { waitForSlot: async () => {}, releaseSlot() {} };
  f.plugin.localStorageManager = { getMetadata: () => 0, setMetadata() {} };
  f.plugin.totalFilesToDownload = 0;
  const completed = [];
  f.plugin.recordSyncCompleted = (...args) => completed.push(args);
  const update = { path: f.filePath, pathHash: 'synthetic-path', contentHash: f.hash,
    size: f.content.byteLength, mtime: 123, ctime: 123, lastTime: 124, pageIndex: 0 };
  return { ...f, completed, update };
}
test('unreferenced remote images request a local download on desktop and mobile', async () => {
  for (const isMobile of [false, true]) {
    obsidian.Platform.isMobile = isMobile;
    try {
      const f = await receiverFixture();
      await files.receiveFileSyncUpdate(f.update, f.plugin);
      assert.equal(f.sent[0]?.[0], 'FileChunkDownload');
      assert.equal(f.sent[0]?.[1].path, f.filePath);
      assert.equal(f.plugin.totalFilesToDownload, 1);
      assert.equal(f.completed.length, 0);
    } finally { obsidian.Platform.isMobile = false; }
  }
});
test('referenced remote images remain available through cloud preview without downloading', async () => {
  const f = await receiverFixture({ referenced: true });
  await files.receiveFileSyncUpdate(f.update, f.plugin);
  assert.equal(f.sent.length, 0);
  assert.equal(f.completed.length, 1);
  assert.equal(f.local.size, 0);
});
test('references to another attachment do not suppress an unreferenced image download', async () => {
  const f = await receiverFixture();
  f.plugin.app.metadataCache.unresolvedLinks = { '笔记.md': { '另一张图片.png': 1 } };
  await files.receiveFileSyncUpdate(f.update, f.plugin);
  assert.equal(f.sent[0]?.[0], 'FileChunkDownload');
});
test('unavailable reference tracking conservatively downloads the remote image', async () => {
  const f = await receiverFixture();
  f.plugin.cloudAttachmentSafety = undefined;
  await files.receiveFileSyncUpdate(f.update, f.plugin);
  assert.equal(f.sent[0]?.[0], 'FileChunkDownload');
});
test('second-device preview resolves attachment-folder and note-relative paths', async () => {
  const f = await fixture(); const api = new HttpApiService(f.plugin);
  api.getFileInfo = async p => { if (p === f.filePath) return f.state.info; throw Error('not found'); };
  api.getFileList = async () => ({ list: [], pager: { totalRows: 0 } });
  assert.equal((await api.resolveFileForPreview('测试 图片.png', '日记/今天.md', '附件')).path, f.filePath);
  assert.equal((await api.resolveFileForPreview('../附件/测试 图片.png', '日记/今天.md', '')).path, f.filePath);
});
test('ambiguous or truncated remote basename searches never guess an attachment', async () => {
  const f = await fixture(); const api = new HttpApiService(f.plugin);
  api.getFileInfo = async () => { throw Error('not found'); };
  for (const page of [
    { list: [{ path: 'one/a.png', size: 1 }, { path: 'two/a.png', size: 1 }], pager: { totalRows: 2 } },
    { list: [{ path: 'one/a.png', size: 1 }], pager: { totalRows: 2 } },
  ]) {
    api.getFileList = async () => page;
    assert.equal(await api.resolveFileForPreview('a.png', 'note.md', ''), null);
  }
});
test('bounded verification uses an authorization header and rejects incomplete bytes', async () => {
  const f = await fixture(); const api = new HttpApiService(f.plugin);
  let request;
  obsidian.requestUrl = async options => { request = options; return { status: 206, arrayBuffer: f.content }; };
  const content = await api.getFileContentForVerification(f.filePath, f.content.byteLength);
  assert.equal(content.byteLength, f.content.byteLength);
  assert.equal(request.headers.Authorization, 'Bearer test-only');
  assert.equal(request.url.includes('test-only'), false);
  assert.equal(request.headers.Range, 'bytes=0-' + f.content.byteLength);
  obsidian.requestUrl = async () => ({ status: 200, arrayBuffer: new ArrayBuffer(1) });
  await assert.rejects(api.getFileContentForVerification(f.filePath, f.content.byteLength), /changed size/);
  await assert.rejects(api.getFileContentForVerification(f.filePath, 50 * 1024 * 1024), /limit/);
});
