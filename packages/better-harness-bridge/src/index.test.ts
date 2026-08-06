import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { summarizeHarnessEvidence } from './index.js';

test('bridge returns counts without local source paths', async () => {
  const workspace = resolve(tmpdir(), `dharma-harness-workspace-${randomUUID()}`);
  const home = resolve(tmpdir(), `dharma-harness-home-${randomUUID()}`);
  await mkdir(workspace, { recursive: true });
  await mkdir(resolve(home, 'sessions/2026/08/03'), { recursive: true });
  await writeFile(resolve(home, 'sessions/2026/08/03/session.jsonl'), `${JSON.stringify({
    type: 'session_meta',
    payload: { id: 'test-session', cwd: workspace },
    timestamp: '2026-08-03T12:00:00.000Z',
  })}\n`);
  const summary = await summarizeHarnessEvidence({
    repositoryRoot: resolve(import.meta.dirname, '../../..'),
    workspace,
    provider: 'codex',
    providerHome: home,
  });
  assert.equal(summary.provider, 'codex');
  assert.ok(summary.sessionCount >= 1);
  assert.doesNotMatch(JSON.stringify(summary), new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(JSON.stringify(summary), /(?:sourcePath|\"path\"|workspace)/i);
});
