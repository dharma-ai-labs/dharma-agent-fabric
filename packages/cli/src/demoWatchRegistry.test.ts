import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { demoWatchRegistrationKey, listDemoWatchRegistrations,
  registerDemoWatch, unregisterDemoWatch, type DemoWatchRegistration } from './demoWatchRegistry.js';

const scope = {
  hqUrl: 'https://demo.example.test', organizationId: 'org_demo123',
  repositoryId: '00000000-0000-4000-8000-000000000001',
  normalizedRepository: 'github.com/example/repository', provider: 'codex' as const,
};

async function fixture(parent = tmpdir()) {
  const root = await realpath(await mkdtemp(join(parent, 'dharma-demo-watch-')));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home); await mkdir(workspace);
  return { root, home, workspace, registration: { schema: 'dharma.demo-watch/v1' as const,
    ...scope, workspace } };
}

test('Demo watch registration is scoped, credential-free and idempotent', async () => {
  const f = await fixture();
  try {
    assert.equal((await registerDemoWatch(f.home, f.registration)).created, true);
    assert.equal((await registerDemoWatch(f.home, f.registration)).created, false);
    assert.deepEqual(await listDemoWatchRegistrations(f.home), [f.registration]);
    const bytes = await readFile(join(f.home, 'relay', 'demo-watches',
      `${demoWatchRegistrationKey(f.registration)}.json`), 'utf8');
    assert.equal(bytes.includes('grant'), false);
    assert.equal(bytes.includes('privateKey'), false);
    assert.equal(bytes.includes('installationId'), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('fixtures canonicalize an aliased temporary root without accepting an alias in a registration', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-watch-temp-alias-')));
  const target = join(root, 'target');
  const alias = join(root, 'alias');
  try {
    await mkdir(target);
    await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const f = await fixture(alias);
    assert.equal(f.workspace, await realpath(f.workspace));
    await registerDemoWatch(f.home, f.registration);
    await assert.rejects(registerDemoWatch(f.home, { ...f.registration,
      workspace: join(alias, basename(f.root), 'workspace') }), /canonical path/);
    assert.deepEqual(await listDemoWatchRegistrations(f.home), [f.registration]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('concurrent registration converges and never overwrites another checkout', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      registerDemoWatch(f.home, f.registration)));
    assert.equal(results.filter(result => result.created).length, 1);
    const other = join(f.root, 'other'); await mkdir(other);
    await assert.rejects(registerDemoWatch(f.home, { ...f.registration, workspace: other }),
      /demo_watch_workspace_conflict/);
    assert.deepEqual(await listDemoWatchRegistrations(f.home), [f.registration]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('registration rejects untrusted fields and invalid scope', async () => {
  const f = await fixture();
  try {
    for (const override of [{ grant: 'never-save-me' }, { workspace: '../foreign' },
      { hqUrl: 'https://secret@example.test' }, { repositoryId: '../foreign' },
      { provider: 'shell' }, { normalizedRepository: 'repo\ncommand' }]) {
      await assert.rejects(registerDemoWatch(f.home,
        { ...f.registration, ...override } as DemoWatchRegistration));
    }
    assert.deepEqual(await listDemoWatchRegistrations(f.home), []);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('registration and listing reject symlink redirection and forged filenames', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, 'relay'));
    await symlink(f.workspace, join(f.home, 'relay', 'demo-watches'), 'dir');
    await assert.rejects(registerDemoWatch(f.home, f.registration), /symlink|directory/);
    await rm(join(f.home, 'relay', 'demo-watches'));
    await registerDemoWatch(f.home, f.registration);
    const directory = join(f.home, 'relay', 'demo-watches');
    await writeFile(join(directory, `${'a'.repeat(64)}.json`), JSON.stringify(f.registration));
    await assert.rejects(listDemoWatchRegistrations(f.home), /identity/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('unregister removes only its scope and preserves workspace content', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, 'preserve.txt'), 'customer work');
    await registerDemoWatch(f.home, f.registration);
    await registerDemoWatch(f.home, { ...f.registration,
      repositoryId: '00000000-0000-4000-8000-000000000002' });
    assert.equal(await unregisterDemoWatch(f.home, f.registration), true);
    assert.equal(await unregisterDemoWatch(f.home, f.registration), false);
    assert.equal((await listDemoWatchRegistrations(f.home)).length, 1);
    assert.equal(await readFile(join(f.workspace, 'preserve.txt'), 'utf8'), 'customer work');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('capacity is bounded and a rejected registration leaves existing scopes intact', async () => {
  const f = await fixture();
  try {
    for (let index = 1; index <= 32; index += 1) {
      await registerDemoWatch(f.home, { ...f.registration,
        repositoryId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` });
    }
    await assert.rejects(registerDemoWatch(f.home, { ...f.registration,
      repositoryId: '00000000-0000-4000-8000-000000000033' }), /limit/);
    assert.equal((await listDemoWatchRegistrations(f.home)).length, 32);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('leaf symlink never supplies a registration or gets overwritten', async () => {
  const f = await fixture();
  try {
    await registerDemoWatch(f.home, f.registration);
    const target = join(f.home, 'relay', 'demo-watches', `${demoWatchRegistrationKey(f.registration)}.json`);
    await rm(target);
    const outside = join(f.workspace, 'outside.json');
    await writeFile(outside, JSON.stringify(f.registration));
    await symlink(outside, target, 'file');
    await assert.rejects(listDemoWatchRegistrations(f.home), /symlink/);
    await assert.rejects(registerDemoWatch(f.home, f.registration), /symlink/);
    assert.deepEqual(JSON.parse(await readFile(outside, 'utf8')), f.registration);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
