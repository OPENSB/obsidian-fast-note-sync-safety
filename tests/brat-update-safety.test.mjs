import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const file = new URL('../src/lib/utils/version_manager.ts', import.meta.url);
const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture() {
  let sideEffects = 0;
  const forbidden = () => { sideEffects++; throw new Error('Unexpected network or file mutation'); };
  const mod = { exports: {} };
  vm.runInNewContext(compiled, {
    module: mod, exports: mod.exports,
    require(id) {
      if (id === 'obsidian') return { requestUrl: forbidden, normalizePath: x => x };
      if (id === 'fflate') return { unzipSync: forbidden };
      if (id === './helpers') return { dump() {}, isVersionNew: () => true, showSyncNotice() {} };
      if (id === '../../i18n/lang') return { $: x => x };
      throw new Error(`Unexpected import ${id}`);
    },
  });
  const metadata = { pluginVersionNewName: '99.0.0', serverVersion: '3.6.1', serverVersionNewName: '99.0.0' };
  const plugin = {
    manifest: { version: '2.4.0-safety.2' },
    localStorageManager: { getMetadata: k => metadata[k], setMetadata: (k, v) => metadata[k] = v },
    api: { adminUpgrade: forbidden },
    websocket: { unRegister: forbidden },
  };
  return { manager: new mod.exports.VersionManager(plugin), sideEffects: () => sideEffects };
}

test('test builds ignore upstream plugin and server update badges', () => {
  const { manager } = fixture();
  assert.equal(manager.isPluginNew(), false);
  assert.equal(manager.isServerNew(), false);
  assert.equal(manager.hasNewVersion(), false);
});

test('test builds reject upstream plugin installation before any side effects', async () => {
  const f = fixture();
  await assert.rejects(f.manager.upgradePlugin(() => assert.fail('No progress before rejection')), /BRAT/);
  assert.equal(f.sideEffects(), 0);
});

test('test builds reject shared server upgrades before disconnecting or requesting', async () => {
  const f = fixture();
  await assert.rejects(f.manager.upgradeServer(() => assert.fail('No progress before rejection')), /disabled/);
  assert.equal(f.sideEffects(), 0);
});
