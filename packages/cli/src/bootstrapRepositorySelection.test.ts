import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { normalizeGitRemoteIdentity } from './index.js';
import { decodeSelectedRepositoryUrl, resolveBootstrapRepositoryWorkspace } from './bootstrapRepositorySelection.js';

const git = promisify(execFile);
const remote = 'https://github.com/customer/jobs.git';
const encoded = Buffer.from(remote).toString('base64url');

async function committedRepository(path: string, origin = remote) {
  await mkdir(path, { recursive: true });
  await git('git', ['init', '-q', path]);
  await git('git', ['-C', path, 'config', 'user.email', 'fixture@example.invalid']);
  await git('git', ['-C', path, 'config', 'user.name', 'Fixture']);
  await git('git', ['-C', path, 'commit', '--allow-empty', '-qm', 'fixture']);
  await git('git', ['-C', path, 'remote', 'add', 'origin', origin]);
  // An empty commit is not enough to qualify a source checkout.
  await writeFile(resolve(path, 'README.md'), '# Fixture\n');
  await git('git', ['-C', path, 'add', 'README.md']);
  await git('git', ['-C', path, 'commit', '-qm', 'source']);
}

function selection(home: string, workspace: string, cloneRepository?: (url: string, target: string) => Promise<void>) {
  return {
    home, workspace, organizationId: 'org_fixture', selectedRemoteBase64url: encoded,
    normalizeRemote: normalizeGitRemoteIdentity,
    withLock: async () => async () => {},
    cloneRepository,
  };
}

test('selected remote decoder rejects credentials, local URLs, malformed encoding and control characters', () => {
  assert.equal(decodeSelectedRepositoryUrl(encoded), remote);
  for (const value of [
    'https://user:password@github.com/customer/jobs.git',
    'https://localhost/customer/jobs.git',
    'file:///tmp/customer/jobs.git',
    'https://github.com/customer/jobs.git?token=secret',
    'https://github.com/customer/jobs.git#fragment',
    'https://github.com/customer/jobs.git\n',
    'https://github.com/customer',
  ]) {
    assert.throws(() => decodeSelectedRepositoryUrl(Buffer.from(value).toString('base64url')), /repository_selection_invalid_url/);
  }
  assert.throws(() => decodeSelectedRepositoryUrl('not+base64'), /repository_selection_invalid_url/);
});

test('matching checkout is used without cloning or modifying source', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-select-'));
  try {
    const workspace = resolve(home, 'source');
    await committedRepository(workspace, 'git@github.com:customer/jobs.git');
    let clones = 0;
    const result = await resolveBootstrapRepositoryWorkspace(selection(home, workspace, async () => { clones++; }));
    assert.equal(result.workspace, workspace);
    assert.equal(result.selection, 'existing');
    assert.equal(clones, 0);
    assert.equal((await readdir(workspace)).includes('README.md'), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('empty starting directory clones selected remote once into isolated managed checkout and reuses it', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-select-'));
  try {
    const source = resolve(home, 'upstream');
    const empty = resolve(home, 'empty');
    await committedRepository(source);
    await mkdir(empty);
    let clones = 0;
    const cloneRepository = async (url: string, target: string) => {
      assert.equal(url, remote);
      clones++;
      await git('git', ['clone', '-q', '--', source, target]);
      await git('git', ['-C', target, 'remote', 'set-url', 'origin', remote]);
    };
    const first = await resolveBootstrapRepositoryWorkspace(selection(home, empty, cloneRepository));
    assert.equal(first.selection, 'managed_cloned');
    assert.match(first.workspace, /repository-checkouts/);
    assert.deepEqual(await readdir(empty), []);
    const second = await resolveBootstrapRepositoryWorkspace(selection(home, empty, cloneRepository));
    assert.equal(second.selection, 'managed_reused');
    assert.equal(second.workspace, first.workspace);
    assert.equal(clones, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('failed clone and conflicting managed checkout fail without mutating the starting directory', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-select-'));
  try {
    const empty = resolve(home, 'empty');
    await mkdir(empty);
    await assert.rejects(resolveBootstrapRepositoryWorkspace(selection(home, empty, async () => {
      throw new Error('credential helper printed a SECRET');
    })), /repository_checkout_failed/);
    assert.deepEqual(await readdir(empty), []);

    const source = resolve(home, 'upstream');
    await committedRepository(source);
    const cloned = await resolveBootstrapRepositoryWorkspace(selection(home, empty, async (_url, target) => {
      await git('git', ['clone', '-q', '--', source, target]);
      await git('git', ['-C', target, 'remote', 'set-url', 'origin', remote]);
    }));
    await git('git', ['-C', cloned.workspace, 'remote', 'set-url', 'origin', 'https://github.com/other/jobs.git']);
    await assert.rejects(resolveBootstrapRepositoryWorkspace(selection(home, empty)), /repository_checkout_conflict/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('managed checkout symlink is rejected before any clone', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-select-'));
  try {
    const empty = resolve(home, 'empty');
    await mkdir(empty);
    const selected = await resolveBootstrapRepositoryWorkspace(selection(home, empty, async (_url, target) => {
      await committedRepository(target);
    }));
    await rm(selected.workspace, { recursive: true });
    await symlink(empty, selected.workspace, 'dir');
    await assert.rejects(resolveBootstrapRepositoryWorkspace(selection(home, empty)), /repository_checkout_conflict/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a matching Git remote with only an empty commit is not eligible', async () => {
  const home = await mkdtemp(resolve(tmpdir(), 'fabric-select-'));
  try {
    const workspace = resolve(home, 'empty-commit');
    await mkdir(workspace);
    await git('git', ['init', '-q', workspace]);
    await git('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.invalid']);
    await git('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
    await git('git', ['-C', workspace, 'commit', '--allow-empty', '-qm', 'fixture']);
    await git('git', ['-C', workspace, 'remote', 'add', 'origin', remote]);
    await assert.rejects(resolveBootstrapRepositoryWorkspace(selection(home, workspace)), /repository_checkout_empty/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
