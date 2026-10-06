import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {readFileSync, readdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';
import {writeBootstrapHostJson, writeBootstrapHostText} from './bootstrapHostFiles.js';

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

test('withdrawal after writing prevents publication and preserves partial evidence without cleanup authority', async t => {
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
  const files = await readdir(f.root);
  assert.equal(files.length, 3);
  assert.equal(files.filter(name => name.startsWith('state.json.') && name.endsWith('.tmp')).length, 1);
  assert.equal(await readFile(resolve(f.root, 'unrelated.tmp'), 'utf8'), 'preserve\n');
});

test('a verified owning scope commits parser-safe local state', async t => {
  const f = await fixture(t);
  await writeBootstrapHostJson(f.path, {ok: true, counter: 1, optional: undefined}, f.scope);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), {ok: true, counter: 1});
  assert.deepEqual(await readdir(f.root), ['state.json']);
});

test('serialization hooks are refused without invoking caller code', async t => {
  const f = await fixture(t);
  const value = {toJSON() {f.setAllowed(false); return {private: 'synthetic-canary'};}};
  await assert.rejects(writeBootstrapHostJson(f.path, value, f.scope), {message: 'codex_setup_host_state_invalid'});
  assert.deepEqual(await readdir(f.root), []);
});

test('replacement staging file is neither published nor removed as an owned file', async t => {
  const f = await fixture(t); await writeFile(f.path, 'original\n');
  let replaced = false, foreignPath = '';
  const scoped = prepareCodexBootstrapHost({...f.input, current: async () => {
    const temporary = readdirSync(f.root).find(name => name.startsWith('state.json.') && name.endsWith('.tmp'));
    if (!replaced && temporary && readFileSync(resolve(f.root, temporary)).length > 0) {
      foreignPath = resolve(f.root, temporary);
      unlinkSync(foreignPath); writeFileSync(foreignPath, 'foreign-replacement\n'); replaced = true;
    }
    return true;
  }}).scope;
  t.after(async () => scoped.close());
  await assert.rejects(writeBootstrapHostJson(f.path, {ok: true}, scoped), /codex_setup_host_state_ownership_unconfirmed/);
  assert.equal(replaced, true);
  assert.equal(await readFile(f.path, 'utf8'), 'original\n');
  assert.equal(await readFile(foreignPath, 'utf8'), 'foreign-replacement\n');
});

test('JSON snapshot precedes asynchronous admission and rejects getters without invoking them', async t => {
  const f = await fixture(t), value = {approved: true};
  const scoped = prepareCodexBootstrapHost({...f.input, current: async () => {value.approved = false; return true;}}).scope;
  t.after(async () => scoped.close());
  await writeBootstrapHostJson(f.path, value, scoped);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), {approved: true});
  let getters = 0;
  await assert.rejects(writeBootstrapHostJson(f.path, {get privateField() {getters++; return 'private-canary';}}, f.scope),
    /codex_setup_host_state_invalid/);
  assert.equal(getters, 0);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), {approved: true});
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

test('non-data and oversized JSON is refused before creating state', async t => {
  const f = await fixture(t), cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [undefined, {private: () => 'canary'}, {huge: 'x'.repeat(2 * 1024 * 1024 + 1)},
    cycle, new Proxy({}, {get() {throw new Error('private-canary');}}), Object.create({foreign: true})]) {
    await assert.rejects(writeBootstrapHostJson(f.path, value, f.scope), /codex_setup_host_state_invalid/);
  }
  assert.deepEqual(await readdir(f.root), []);
});

test('launcher text rejects unsafe modes and non-text input before any filesystem effect', async t => {
  const f = await fixture(t);
  for (const value of [null, {}, Buffer.from('canary'), 'x'.repeat(2 * 1024 * 1024 + 1), 'text\0tail']) {
    await assert.rejects(writeBootstrapHostText(f.path, value as string, f.scope, 0o700),
      {message: 'codex_setup_host_state_invalid'});
  }
  await assert.rejects(writeBootstrapHostText(f.path, 'text', f.scope, 0o777 as 0o700),
    {message: 'codex_setup_host_state_invalid'});
  assert.deepEqual(await readdir(f.root), []);
});
