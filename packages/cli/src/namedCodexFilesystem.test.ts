import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { namedCodexFilesystem } from './namedCodexFilesystem.js';

async function fixture(packageDirectory = 'node_modules') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-native-runtime-')));
  const bin = join(root, 'bin'), code = join(root, packageDirectory, '@openai/codex');
  const native = join(root, packageDirectory, `@openai/codex-linux-${process.arch}`);
  await mkdir(bin, { recursive: true });
  await mkdir(join(code, 'bin'), { recursive: true });
  await mkdir(native, { recursive: true });
  await writeFile(join(code, 'package.json'), JSON.stringify({ name: '@openai/codex', optionalDependencies: { [`@openai/codex-linux-${process.arch}`]: `npm:@openai/codex@1.0.0-linux-${process.arch}` } }));
  await writeFile(join(native, 'package.json'), JSON.stringify({ name: '@openai/codex', version: `1.0.0-linux-${process.arch}` }));
  await writeFile(join(code, 'bin/codex.js'), '#!/usr/bin/env node\n');
  await chmod(join(code, 'bin/codex.js'), 0o755);
  await symlink(join(code, 'bin/codex.js'), join(bin, 'codex'));
  return { root, bin, code, native };
}

test('named filesystem exposes only public provider packages and denies existing private roots', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    const result = await namedCodexFilesystem({ environment: { PATH: f.bin }, workspace: join(f.root, 'checkout'),
      privateRoots: [join(f.root, 'device'), join(f.root, 'codex'), '/run/ef/current'], writeRoots: ['src', 'tests'] });
    assert.deepEqual(result.runtimeRoots, [f.code, f.native]);
    assert.ok(result.peer.includes(`${JSON.stringify(f.code)}="read"`));
    assert.ok(result.peer.includes(`${JSON.stringify(join(f.root, 'device'))}="deny"`));
    assert.ok(result.peer.includes('"/run/ef/current"="deny"'));
    assert.ok(result.peer.includes('":workspace_roots"={"."="read"}'));
    assert.ok(!result.peer.includes('="write"'));
    assert.ok(result.work.includes('":workspace_roots"={"."="read","src"="write","tests"="write"}'));
    assert.ok(!result.peer.includes(`${JSON.stringify(f.root)}="read"`));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('dot-prefixed descendants are not mistaken for parent traversal', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture('..runtime');
  try {
    await assert.rejects(namedCodexFilesystem({ environment: { PATH: f.bin }, workspace: f.root,
      privateRoots: [], writeRoots: [] }), /named_session_provider_runtime_scope_invalid/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('provider runtime cannot overlap the checkout or a protected credential root', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    for (const scope of [{ workspace: f.root, privateRoots: [] }, { workspace: join(f.root, 'checkout'), privateRoots: [f.code] }]) {
      await assert.rejects(namedCodexFilesystem({ environment: { PATH: f.bin }, ...scope, writeRoots: ['src'] }), /named_session_provider_runtime_scope_invalid/);
    }
    await assert.rejects(namedCodexFilesystem({ environment: { PATH: 'relative' }, workspace: join(f.root, 'checkout'), privateRoots: [], writeRoots: [] }), /named_session_provider_runtime_missing/);
    await writeFile(join(f.native, 'package.json'), JSON.stringify({ name: '@openai/codex', version: 'wrong-alias' }));
    await assert.rejects(namedCodexFilesystem({ environment: { PATH: f.bin }, workspace: join(f.root, 'checkout'), privateRoots: [], writeRoots: [] }), /named_session_provider_runtime_invalid/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
