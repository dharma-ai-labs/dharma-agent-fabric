import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { readDemoSourceHistory, writeDemoSourceHistory, type DemoSourceHistory } from './demoSourceHistory.js';

const scope = { organizationId: 'org_fixture', repositoryId: '10000000-0000-4000-8000-000000000001',
  workspaceId: '20000000-0000-4000-8000-000000000001', policyHash: `sha256:${'a'.repeat(64)}` };
const row: DemoSourceHistory = { schema: 'dharma.demo-source-history/v1', ...scope,
  localSnapshotHash: `sha256:${'b'.repeat(64)}`, pending: null };

test('Demo source history persists contentless scoped pointers across restart', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-demo-history-'));
  assert.equal(await readDemoSourceHistory(root, scope), null);
  await writeDemoSourceHistory(root, row);
  assert.deepEqual(await readDemoSourceHistory(root, scope), row);
  const path = resolve(root, 'demo-source-history', scope.organizationId, scope.repositoryId, `${scope.workspaceId}.json`);
  const bytes = await readFile(path, 'utf8');
  assert.equal(/grant|contentBase64|credential|privateKey/i.test(bytes), false);
  await assert.rejects(readDemoSourceHistory(root, { ...scope, policyHash: `sha256:${'c'.repeat(64)}` }), /integrity or scope/);
  assert.deepEqual(await readDemoSourceHistory(root, { ...scope, policyHash: `sha256:${'c'.repeat(64)}` }, scope.policyHash), row);
});

test('Demo source history rejects malformed pointers and unknown fields', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-demo-history-'));
  await assert.rejects(writeDemoSourceHistory(root, { ...row, localSnapshotHash: '../foreign' }), /integrity/);
  await assert.rejects(writeDemoSourceHistory(root, { ...row, pending: { localSnapshotHash: row.localSnapshotHash,
    snapshotHash: 'corrupt', sourceFingerprint: scope.policyHash, capturedAt: '2026-09-26T00:00:00.000Z' } }), /integrity/);
  const folder = resolve(root, 'demo-source-history', scope.organizationId, scope.repositoryId);
  await mkdir(folder, { recursive: true });
  await writeFile(resolve(folder, `${scope.workspaceId}.json`), JSON.stringify({ ...row, grant: 'forbidden' }));
  await assert.rejects(readDemoSourceHistory(root, scope), /integrity/);
});
