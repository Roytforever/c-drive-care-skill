import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readReportData } from '../src/read-report-data.js';

const snapshot = () => ({ scan: {
  status: 'completed', root: 'C:\\fixture', totalBytes: 7,
  directories: [{ id: 'root', parentId: null, path: 'C:\\fixture', bytes: 7, ownBytes: 7 }],
  largeFiles: [{ path: 'C:\\fixture\\one.txt', bytes: 7 }],
} });

test('offline reader accepts JSON and gzip with identical validated data', async () => {
  const value = snapshot(), text = JSON.stringify(value);
  assert.deepEqual(await readReportData(text), value);
  assert.deepEqual(await readReportData(gzipSync(text).toString('base64'), 'gzip-base64'), value);
});

test('importing legacy snapshots preserves scan time and strips credential fields', async () => {
  const value = snapshot(); value.scan.finishedAt = '2024-01-01T00:00:00Z';
  value.scan.token = 'synthetic-secret';
  const data = await readReportData(JSON.stringify(value.scan), 'json', true);
  assert.equal(data.sourceMode, 'snapshot');
  assert.equal(data.scan.finishedAt, value.scan.finishedAt);
  assert.equal(data.scan.token, undefined);
});

test('offline reader rejects malformed data and unsupported encodings', async () => {
  await assert.rejects(readReportData('{'), /JSON/);
  await assert.rejects(readReportData('{}'), /索引/);
  await assert.rejects(readReportData('{}', 'remote-url'), /编码/);
  await assert.rejects(readReportData('not-gzip', 'gzip-base64'));
  const value = snapshot();
  value.caches = [{ id: 'npm', path: 'C:\\fixture', configPath: { invalid: true } }];
  await assert.rejects(readReportData(JSON.stringify(value)), /缓存来源/);
});
