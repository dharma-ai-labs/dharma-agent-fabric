import assert from 'node:assert/strict';
import test from 'node:test';
import { run } from './index.js';

test('version is parser-safe structured output', async () => {
  assert.deepEqual(await run(['version']), { version: '0.1.0' });
});

test('unknown commands fail as usage errors', async () => {
  await assert.rejects(() => run(['unknown']), /Usage:/);
});
