import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createScanner } from '../server/scanner.mjs';
import { discoverCaches } from '../server/inventory.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'liubai-scan-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(root).startsWith('liubai-scan-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function completion(scanner) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const state = scanner.getState();
      if (['completed', 'cancelled', 'failed'].includes(state.status)) { clearInterval(timer); resolve(state); }
      else if (Date.now() - started > 15000) { clearInterval(timer); scanner.cancel(); reject(new Error('scan timed out')); }
    }, 25);
  });
}

test('sums each file once through nested directories and orders real large files', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'a', 'b'), { recursive: true });
  await fs.writeFile(path.join(root, 'one.txt'), Buffer.alloc(17));
  await fs.writeFile(path.join(root, 'a', 'two.bin'), Buffer.alloc(61));
  await fs.writeFile(path.join(root, 'a', 'b', 'three.vhdx'), Buffer.alloc(113));
  const scanner = createScanner();
  await scanner.start(root);
  const state = await completion(scanner);
  assert.equal(state.status, 'completed');
  assert.equal(state.totalBytes, 191);
  assert.equal(state.filesCount, 3);
  assert.equal(state.dirsCount, 3);
  assert.equal(state.directories.find(d => d.id === 'root').bytes, 191);
  assert.equal(state.directories.find(d => d.path === path.join(root, 'a')).bytes, 174);
  assert.equal(state.directories.find(d => d.path === path.join(root, 'a')).ownBytes, 61);
  assert.deepEqual(state.largeFiles.map(f => f.bytes), [113, 61, 17]);
  assert.equal(state.largeFiles[0].protected, true);
  assert.equal(state.errors, 0);
});

test('never descends into a junction or counts its target twice', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'target'));
  await fs.writeFile(path.join(root, 'target', 'data'), Buffer.alloc(37));
  await fs.symlink(path.join(root, 'target'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const scanner = createScanner();
  await scanner.start(root);
  const state = await completion(scanner);
  assert.equal(state.totalBytes, 37);
  assert.equal(state.filesCount, 1);
  assert.equal(state.skipped, 1);
  assert.match(state.skipDetails[0].reason, /reparse|symbolic/i);
  assert.equal(state.directories.some(d => d.path.includes('alias')), false);
});

test('scans Windows long nested paths and accepts a long directory as the scan root', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  let deep = root;
  for (let i = 0; i < 4; i++) deep = path.join(deep, `folder-${i}-${'x'.repeat(64)}`);
  await fs.mkdir(deep, { recursive: true });
  await fs.writeFile(path.join(deep, 'marker.bin'), Buffer.alloc(73));
  await fs.symlink(root, path.join(deep, 'loop'), 'junction');
  assert.ok(deep.length > 260);
  for (const scanRoot of [root, deep]) {
    const scanner = createScanner();
    await scanner.start(scanRoot);
    const state = await completion(scanner);
    assert.equal(state.status, 'completed');
    assert.equal(state.errors, 0);
    assert.equal(state.filesCount, 1);
    assert.equal(state.totalBytes, 73);
    assert.equal(state.skipped, 1);
    assert.equal(state.issueSummary.skipped.reasonCounts[0].code, 'reparse:junction');
    assert.equal(state.directories.some(d => d.path === path.join(deep, 'loop')), false);
    assert.equal(state.largeFiles[0].path, path.join(deep, 'marker.bin'));
    assert.ok(state.directories.every(d => !d.path.startsWith('\\\\?\\')));
  }
});

test('summarizes all skipped links despite the 100-detail limit', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'target'));
  const links = path.join(root, 'links');
  await fs.mkdir(links);
  for (let i = 0; i < 125; i++) await fs.symlink(path.join(root, 'target'), path.join(links, `alias-${i}`), process.platform === 'win32' ? 'junction' : 'dir');
  const scanner = createScanner();
  await scanner.start(root);
  const state = await completion(scanner);
  assert.equal(state.skipped, 125);
  assert.equal(state.skipDetails.length, 100);
  assert.equal(state.issueSummary.version, 1);
  assert.equal(state.issueSummary.skipped.reasonCounts.reduce((sum, reason) => sum + reason.count, 0), 125);
  assert.equal(state.issueSummary.skipped.directories.find(item => item.path === links)?.count, 125);
  assert.equal(state.issueSummary.skipped.otherDirectoryEvents, 0);
  assert.equal(state.issueSummary.skipped.reasonCounts[0].code, process.platform === 'win32' ? 'reparse:junction' : 'reparse:symlink');
});

test('issue aggregation reports directory overflow without losing reason totals', async () => {
  const source = [
    'import importlib.util,json,sys',
    'spec=importlib.util.spec_from_file_location("worker",sys.argv[1])',
    'module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)',
    'summary=module.IssueSummary(directory_limit=2)',
    'summary.add("skipped","reparse:junction","目录联接或挂载点",r"C:\\a")',
    'summary.add("skipped","reparse:junction","目录联接或挂载点",r"C:\\b")',
    'summary.add("skipped","offline","离线或云占位",r"C:\\c")',
    'summary.add("skipped","offline","离线或云占位",r"C:\\a")',
    'print(json.dumps(summary.finalize()))',
  ].join(';');
  const { stdout } = await promisify(execFile)('python', ['-I', '-c', source, path.resolve('server/scan-worker.py')], { windowsHide: true });
  const result = JSON.parse(stdout);
  assert.equal(result.skipped.reasonCounts.reduce((sum, reason) => sum + reason.count, 0), 4);
  assert.equal(result.skipped.directories.length, 2);
  assert.equal(result.skipped.directories.find(item => item.path === 'C:\\a').count, 2);
  assert.equal(result.skipped.otherDirectoryEvents, 1);
});

test('rejects a reparse point used as scan root', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'target'));
  await fs.symlink(path.join(root, 'target'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const scanner = createScanner();
  await scanner.start(path.join(root, 'alias'));
  const state = await completion(scanner);
  assert.equal(state.status, 'failed');
  assert.match(state.error, /reparse|symbolic/i);
});

test('reports missing or unreadable root as failed instead of empty complete', async t => {
  const root = await fixture(t);
  const scanner = createScanner();
  await scanner.start(path.join(root, 'missing'));
  const state = await completion(scanner);
  assert.equal(state.status, 'failed');
  assert.ok(state.error);
  assert.ok(state.errors > 0);
  assert.equal(state.issueSummary.errors.reasonCounts.reduce((sum, reason) => sum + reason.count, 0), state.errors);
  assert.equal(state.issueSummary.errors.directories[0].path, path.join(root, 'missing'));
});

test('cancellation retains an explicit partial state', async t => {
  const root = await fixture(t);
  const scanner = createScanner();
  await scanner.start(root);
  scanner.cancel();
  const state = await completion(scanner);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.complete, false);
});

test('bounded index marks truncation rather than claiming full volume coverage', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'a'));
  await fs.mkdir(path.join(root, 'b'));
  const scanner = createScanner({ maxDirectories: 2 });
  await scanner.start(root);
  const state = await completion(scanner);
  assert.equal(state.status, 'completed');
  assert.equal(state.complete, false);
  assert.equal(state.truncated, true);
  assert.ok(state.warnings.length);
});

test('prunes only the displayed directory tree while preserving traversal totals and ancestors', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'big', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'small'));
  await fs.writeFile(path.join(root, 'big', 'nested', 'large'), Buffer.alloc(100));
  await fs.writeFile(path.join(root, 'big', 'own'), Buffer.alloc(7));
  await fs.writeFile(path.join(root, 'small', 'small-file'), Buffer.alloc(3));
  const scanner = createScanner({ maxDisplayDirectories: 3 });
  await scanner.start(root);
  const state = await completion(scanner);
  assert.equal(state.status, 'completed');
  assert.equal(state.complete, true);
  assert.equal(state.truncated, false);
  assert.equal(state.displayPruned, true);
  assert.equal(state.displayOmittedDirectories, 1);
  assert.equal(state.dirsCount, 4);
  assert.equal(state.filesCount, 3);
  assert.equal(state.totalBytes, 110);
  assert.equal(state.directories.length, 3);
  assert.equal(state.directories.find(d => d.id === 'root').omittedBytes, 3);
  assert.equal(state.directories.some(d => d.path === path.join(root, 'small')), false);
  assert.ok(state.directories.every(d => !d.parentId || state.directories.some(parent => parent.id === d.parentId)));
  assert.equal(state.largeFiles.length, 3);
});

test('retains only the largest 500 entries while totals include every file', async t => {
  const root = await fixture(t);
  for (let i = 1; i <= 501; i++) await fs.writeFile(path.join(root, String(i)), Buffer.alloc(i));
  const scanner = createScanner();
  await scanner.start(root);
  const state = await completion(scanner);
  assert.equal(state.filesCount, 501);
  assert.equal(state.totalBytes, 125751);
  assert.equal(state.largeFiles.length, 500);
  assert.equal(state.largeFiles[0].bytes, 501);
  assert.equal(state.largeFiles.at(-1).bytes, 2);
});

test('does not read or count Windows offline placeholders', { skip: process.platform !== 'win32' }, async t => {
  const root = await fixture(t);
  const file = path.join(root, 'cloud-placeholder');
  await fs.writeFile(file, Buffer.alloc(79));
  const setAttributes = 'import ctypes,sys; assert ctypes.windll.kernel32.SetFileAttributesW(sys.argv[1],int(sys.argv[2]))';
  const run = promisify(execFile);
  await run('python', ['-I', '-c', setAttributes, file, '4096'], { windowsHide: true });
  t.after(async () => { await run('python', ['-I', '-c', setAttributes, file, '128'], { windowsHide: true }).catch(() => {}); });
  const scanner = createScanner();
  await scanner.start(root);
  const state = await completion(scanner);
  assert.equal(state.totalBytes, 0);
  assert.equal(state.filesCount, 0);
  assert.equal(state.skipped, 1);
  assert.match(state.skipDetails[0].reason, /offline/);
  assert.equal(state.issueSummary.skipped.reasonCounts[0].code, 'offline');
});

test('cache discovery labels defaults and excludes overridden arbitrary directories from actions', async t => {
  const root = await fixture(t);
  const local = path.join(root, 'Local');
  const home = path.join(root, 'user');
  await fs.mkdir(path.join(local, 'npm-cache'), { recursive: true });
  await fs.mkdir(home);
  const env = { LOCALAPPDATA: local, APPDATA: path.join(root, 'Roaming'), USERPROFILE: home };
  let caches = await discoverCaches({ env, home });
  const npm = caches.find(c => c.id === 'npm');
  assert.equal(npm.exists, true);
  assert.equal(npm.supported, true);
  assert.equal(npm.source, 'default');
  assert.ok(npm.warnings.length);
  await fs.writeFile(path.join(home, '.npmrc'), 'cache = C:\\Documents\\valuable\n');
  caches = await discoverCaches({ env, home });
  assert.equal(caches.find(c => c.id === 'npm').supported, false);
  assert.equal(caches.find(c => c.id === 'npm').source, 'config');
});
