import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  PINNED_NODE_VERSION, ensurePinnedNodeRuntime, pinnedNodeArchive,
} from './pinnedNodeRuntime.js';
import { isSupportedNodeVersion, selectCliRuntime } from './runtime-bootstrap.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('the pinned Node runtime is a supported version with a SHA-256 pin per release platform (#398)', () => {
  assert.equal(isSupportedNodeVersion(PINNED_NODE_VERSION), true);
  const windows = pinnedNodeArchive('win32', 'x64');
  assert.equal(windows?.file, `node-v${PINNED_NODE_VERSION}-win-x64.zip`);
  assert.equal(windows?.url, `https://nodejs.org/dist/v${PINNED_NODE_VERSION}/node-v${PINNED_NODE_VERSION}-win-x64.zip`);
  assert.equal(windows?.executable, 'node.exe');
  assert.equal(pinnedNodeArchive('linux', 'arm64')?.file, `node-v${PINNED_NODE_VERSION}-linux-arm64.tar.gz`);
  assert.equal(pinnedNodeArchive('darwin', 'arm64')?.executable, join('bin', 'node'));
  for (const [platform, arch] of [['win32', 'x64'], ['win32', 'arm64'], ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']] as const) {
    assert.match(pinnedNodeArchive(platform, arch)?.sha256 ?? '', /^[0-9a-f]{64}$/, `${platform}-${arch}`);
  }
  assert.equal(pinnedNodeArchive('aix', 'ppc64'), null);
});

test('an unsupported current Node with no supported local runtime falls back to the pinned runtime (#398)', async () => {
  const calls: string[] = [];
  const runtime = await selectCliRuntime({
    version: '26.8.1', bootstrapped: false,
    findSupported: () => { calls.push('find'); return null; },
    ensurePinned: async () => { calls.push('pinned'); return '/home/user/.dharma/runtime/node/bin/node'; },
  });
  assert.equal(runtime, '/home/user/.dharma/runtime/node/bin/node');
  assert.deepEqual(calls, ['find', 'pinned']);
  // A supported local runtime is preferred and nothing is downloaded.
  const local = await selectCliRuntime({
    version: '26.8.1', bootstrapped: false,
    findSupported: () => '/usr/local/bin/node',
    ensurePinned: async () => assert.fail('must not fetch when a supported runtime exists'),
  });
  assert.equal(local, '/usr/local/bin/node');
  // A relaunched child never fetches again.
  assert.equal(await selectCliRuntime({
    version: '26.8.1', bootstrapped: true,
    findSupported: () => assert.fail('bootstrapped child must not search'),
    ensurePinned: async () => assert.fail('bootstrapped child must not fetch'),
  }), null);
});

test('the pinned runtime is fetched once, digest-checked, installed under the Dharma home and then reused (#398)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-pinned-node-'));
  const bytes = Buffer.from('pinned-node-archive');
  const archive = { ...pinnedNodeArchive('linux', 'x64')!, sha256: sha256(bytes) };
  let downloads = 0;
  const options = {
    dharmaHome: home, archive,
    download: async (url: string) => { downloads += 1; assert.equal(url, archive.url); return bytes; },
    extract: async (file: string, destination: string) => {
      assert.equal(sha256(Buffer.from(await import('node:fs/promises').then(fs => fs.readFile(file)))), archive.sha256);
      await mkdir(join(destination, archive.directory, 'bin'), { recursive: true });
      await writeFile(join(destination, archive.directory, 'bin', 'node'), '');
    },
    runtimeVersion: () => `v${PINNED_NODE_VERSION}`,
  };
  const executable = await ensurePinnedNodeRuntime(options);
  assert.equal(executable, join(home, 'runtime', archive.directory, 'bin', 'node'));
  assert.equal(await ensurePinnedNodeRuntime(options), executable);
  assert.equal(downloads, 1);
  assert.deepEqual((await readdir(join(home, 'runtime'))).sort(), [archive.directory]);
});

test('a pinned runtime archive with the wrong digest is refused and nothing is installed (#398)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dharma-pinned-node-bad-'));
  const archive = pinnedNodeArchive('linux', 'x64')!;
  await assert.rejects(ensurePinnedNodeRuntime({
    dharmaHome: home, archive,
    download: async () => Buffer.from('tampered'),
    extract: async () => assert.fail('a tampered archive must not be extracted'),
    runtimeVersion: () => `v${PINNED_NODE_VERSION}`,
  }), /node_runtime_digest_mismatch/);
  assert.deepEqual(await readdir(join(home, 'runtime')), []);
});

test('the default extractor installs a real pinned archive layout on POSIX (#398)', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dharma-pinned-node-tar-'));
  const archive = pinnedNodeArchive('linux', 'x64')!;
  const source = join(root, 'source');
  await mkdir(join(source, archive.directory, 'bin'), { recursive: true });
  const fake = join(source, archive.directory, 'bin', 'node');
  await writeFile(fake, `#!/bin/sh\necho v${PINNED_NODE_VERSION}\n`);
  await chmod(fake, 0o755);
  const tarball = join(root, archive.file);
  assert.equal(spawnSync('tar', ['-czf', tarball, '-C', source, archive.directory]).status, 0);
  const bytes = await import('node:fs/promises').then(fs => fs.readFile(tarball));
  const home = join(root, 'home');
  const executable = await ensurePinnedNodeRuntime({
    dharmaHome: home, archive: { ...archive, sha256: sha256(bytes) }, platform: 'linux', download: async () => bytes,
  });
  assert.equal(executable, join(home, 'runtime', archive.directory, 'bin', 'node'));
  assert.equal(existsSync(executable), true);
});
