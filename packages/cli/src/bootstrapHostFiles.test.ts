import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';
import {writeBootstrapHostJson} from './bootstrapHostFiles.js';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-bootstrap-host-json-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  let allowed = true;
  const input = {workspace: root, current: async () => allowed,
    signal: new AbortController().signal, intent: {schema: 'dharma.codex-setup-intent/v1' as const, operationId: uuid(1),
      setupReference: uuid(2), organizationId: 'org_demo', recipientMembershipId: uuid(3), origin: 'https://hq.example',
      repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
      hostContextId: uuid(4), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
  const scope = prepareCodexBootstrapHost(input).scope;
  t.after(async () => scope.close());
  return {root, scope, input, path: resolve(root, 'state.json'), setAllowed(value: boolean) {allowed = value;}};
}

test('withdrawn setup cannot create a local state file', async t => {
  const f = await fixture(t); f.scope.close();
  await assert.rejects(writeBootstrapHostJson(f.path, {ok: true}, f.scope), {message: 'codex_setup_host_scope_unavailable'});
  assert.deepEqual(await readdir(f.root), []);
});

test('withdrawal after writing the owned temporary prevents state publication and cleans only that temporary', async t => {
  const f = await fixture(t); await writeFile(f.path, 'original\n');
  await writeFile(resolve(f.root, 'unrelated.tmp'), 'preserve\n');
  const scoped = prepareCodexBootstrapHost({
    ...f.input, current: async () => {
      const temporary = readdirSync(f.root).find(name => name.startsWith('state.json.') && name.endsWith('.tmp'));
      return !temporary || readFileSync(resolve(f.root, temporary)).length === 0;
    }}).scope;
  t.after(async () => scoped.close());
  await assert.rejects(writeBootstrapHostJson(f.path, {changed: true}, scoped), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(await readFile(f.path, 'utf8'), 'original\n');
  assert.deepEqual(await readdir(f.root), ['state.json', 'unrelated.tmp']);
  assert.equal(await readFile(resolve(f.root, 'unrelated.tmp'), 'utf8'), 'preserve\n');
});

test('a verified owning scope commits parser-safe local state', async t => {
  const f = await fixture(t);
  await writeBootstrapHostJson(f.path, {ok: true, counter: 1}, f.scope);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), {ok: true, counter: 1});
  assert.deepEqual(await readdir(f.root), ['state.json']);
});

test('serialization cannot revoke authority and still publish its result', async t => {
  const f = await fixture(t);
  const value = {toJSON() {f.setAllowed(false); return {private: 'synthetic-canary'};}};
  await assert.rejects(writeBootstrapHostJson(f.path, value, f.scope), {message: 'codex_setup_host_scope_unavailable'});
  assert.deepEqual(await readdir(f.root), []);
});

test('withdrawal after completed rename reports failure without inventing rollback', async t => {
  const f = await fixture(t); await writeFile(f.path, 'original\n');
  const scoped = prepareCodexBootstrapHost({...f.input, current: async () => readFileSync(f.path, 'utf8') === 'original\n'}).scope;
  t.after(async () => scoped.close());
  await assert.rejects(writeBootstrapHostJson(f.path, {committed: true}, scoped), {message: 'codex_setup_host_scope_unavailable'});
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), {committed: true});
  assert.deepEqual(await readdir(f.root), ['state.json']);
});

test('relative paths are refused before creating a temporary', async t => {
  const f = await fixture(t);
  await assert.rejects(writeBootstrapHostJson('relative-state.json', {}, f.scope), {message: 'codex_setup_host_state_path_invalid'});
  assert.deepEqual(await readdir(f.root), []);
});

test('serialization errors never reflect private diagnostics and leave no artifact', async t => {
  const f = await fixture(t);
  await assert.rejects(writeBootstrapHostJson(f.path, {toJSON() {throw new Error('private-serialization-canary');}}, f.scope),
    {message: 'codex_setup_host_state_invalid'});
  assert.deepEqual(await readdir(f.root), []);
});
