import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { commandExitCode, run } from './index.js';
import { CLI_USAGE } from './usage.js';
import { blockedGuidedEntry } from './guidedEntry.js';
import { canonicalize, sha256, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import { fileURLToPath } from 'node:url';

test('bare noninteractive entry returns a typed no-effect result, not enrollment or a usage exception', async () => {
  assert.notEqual(process.stdin.isTTY, true, 'This fixture must not open an interactive terminal.');
  const value = await run([]) as Record<string, unknown>;
  assert.equal(value.schema, 'dharma.guided-entry/v1');
  assert.equal(value.ok, false);
  assert.equal(value.stage, 'blocked');
  assert.equal(value.code, 'guided_entry_interactive_required');
  assert.equal(value.effects, false);
  assert.equal(value.ready, false);
  assert.equal(value.enrollmentStarted, false);
  assert.equal(commandExitCode([], value), 2);
});

test('an unrecognized bare-entry result cannot report a successful exit', () => {
  for (const value of [null, {}, { ok: true }, { ready: true }, { effects: true }]) {
    assert.equal(commandExitCode([], value), 2);
  }
});

test('guided entry leaves explicit help and version dispatch unchanged', async () => {
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(await run(['--help']), CLI_USAGE);
  assert.deepEqual(await run(['version']), { version: metadata.version });
});

test('interactive context alone cannot manufacture organization, recipient or role authority', () => {
  const result = blockedGuidedEntry({ cliVersion: '0.2.211', nodeVersion: '22.22.3', interactive: true });
  assert.equal(result.code, 'guided_entry_context_required');
  for (const field of ['organizationId', 'recipientMembershipId', 'roleRevision', 'repositoryBindingId'] as const) {
    assert.equal(result[field], null);
  }
  assert.equal(result.authorityVerified, false);
  assert.equal(result.effects, false);
  assert.equal(result.ready, false);
  assert.equal(commandExitCode([], result), 2);
});

test('an unsupported runtime is refused before any interactive driver or enrollment', () => {
  const result = blockedGuidedEntry({ cliVersion: '0.2.211', nodeVersion: '25.0.0', interactive: true });
  assert.equal(result.code, 'guided_entry_runtime_unsupported');
  assert.equal(result.enrollmentStarted, false);
  assert.equal(result.effects, false);
});

test('public integrity is a checksum, never an enrollment or role authorization', () => {
  const { integrity, ...result } = blockedGuidedEntry({ cliVersion: '0.2.211', nodeVersion: '22.22.3', interactive: true });
  assert.equal(integrity.kind, 'public_unkeyed_sha256');
  assert.equal(integrity.hash, sha256(canonicalize(result)));
  assert.equal(integrity.authorizesEffects, false);
  assert.throws(() => blockedGuidedEntry({ cliVersion: 'not-a-public-version', nodeVersion: '22.22.3', interactive: true }),
    /^Error: guided_entry_input_invalid$/);
  assert.throws(() => blockedGuidedEntry({ cliVersion: '0.2.211', nodeVersion: '22.22.3', interactive: true, now: new Date(NaN) }),
    /^Error: guided_entry_input_invalid$/);
});

test('the public blocked result schema rejects authority, credentials and success claims', async () => {
  const directory = fileURLToPath(new URL('../../../schemas', import.meta.url));
  const result = blockedGuidedEntry({ cliVersion: '0.2.211', nodeVersion: '22.22.3', interactive: true,
    now: new Date('2026-10-19T13:30:00Z') });
  const schema = 'https://schemas.dharma-ai.io/guided-entry/v1';
  assert.equal((await validateContract(directory, schema, result)).ok, true);
  for (const patch of [{ grant: 'synthetic-forbidden' }, { token: 'synthetic-forbidden' }, { ready: true },
    { effects: true }, { authorityVerified: true }, { organizationId: 'org_unverified' },
    { recipientMembershipId: 'unverified' }, { roleRevision: 'owner' }, { repositoryBindingId: 'foreign' },
    { stage: 'complete' }, { code: 'raw error or private input' }, { ok: true }]) {
    assert.equal((await validateContract(directory, schema, { ...result, ...patch })).ok, false);
  }
});
