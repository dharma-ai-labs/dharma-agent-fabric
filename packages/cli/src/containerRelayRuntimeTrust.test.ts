import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyContainerControllerRuntime } from './containerRelayLifecycle.js';

async function fixture(candidateVersion = '0.2.152', callerVersion = '0.2.152') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-container-runtime-trust-')));
  const candidate = join(root, 'installed', 'dist'), caller = join(root, 'caller', 'dist');
  for (const [directory, version] of [[candidate, candidateVersion], [caller, callerVersion]]) {
    await mkdir(directory!, { recursive: true });
    await writeFile(join(directory!, '..', 'package.json'), JSON.stringify({ name: '@dharma-ai-labs/agent-fabric', version }), { mode: 0o444 });
    for (const name of ['bin.js', 'index.js', 'containerRelayLifecycle.js']) {
      await writeFile(join(directory!, name), `// synthetic public ${name}\n`, { mode: 0o444 });
    }
  }
  return { candidate, caller, installed: join(candidate, 'bin.js'), current: join(caller, 'bin.js') };
}

test('ordinary runtime ownership retains exact executable bytes despite different prefixes', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  assert.equal(await verifyContainerControllerRuntime(f.installed, f.current), f.installed);
  assert.equal(await verifyContainerControllerRuntime(f.installed, f.current, true), f.installed);
  await chmod(join(f.candidate, 'index.js'), 0o644);
  await writeFile(join(f.candidate, 'index.js'), '// changed executable\n');
  await assert.rejects(verifyContainerControllerRuntime(f.installed, f.current), /container_startup_unavailable/);
});

test('maintenance image handover requires the target controller before the newer caller is admitted', { skip: process.platform !== 'linux' }, async () => {
  const old = await fixture('0.2.207', '0.2.211');
  await assert.rejects(verifyContainerControllerRuntime(old.installed, old.current), /container_startup_unavailable/);
  await assert.rejects(verifyContainerControllerRuntime(old.installed, old.current, true), /container_startup_unavailable/);

  const target = await fixture('0.2.211', '0.2.211');
  assert.equal(await verifyContainerControllerRuntime(target.installed, target.current), target.installed);
  await chmod(join(target.candidate, 'index.js'), 0o644);
  await writeFile(join(target.candidate, 'index.js'), '// substituted target controller\n');
  await assert.rejects(verifyContainerControllerRuntime(target.installed, target.current), /container_startup_unavailable/);
});

test('version labels cannot admit synthetic or tampered historical controller bytes even in rollback', { skip: process.platform !== 'linux' }, async () => {
  for (const version of ['0.2.148', '0.2.149', '0.2.151']) {
    const f = await fixture(version);
    await assert.rejects(verifyContainerControllerRuntime(f.installed, f.current), /container_startup_unavailable/);
    await assert.rejects(verifyContainerControllerRuntime(f.installed, f.current, true), /container_startup_unavailable/);
  }
});

test('symlinked and writable executable files cannot claim ordinary controller ownership', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  const alias = join(f.candidate, 'alias.js');
  await symlink(f.installed, alias);
  await assert.rejects(verifyContainerControllerRuntime(alias, f.current), /container_startup_unavailable/);
  if (process.platform !== 'win32') {
    await chmod(join(f.candidate, 'index.js'), 0o666);
    await assert.rejects(verifyContainerControllerRuntime(f.installed, f.current), /container_startup_unavailable/);
  }
});
