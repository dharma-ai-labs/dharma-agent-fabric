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
  const node = join(root, 'public-node', 'node');
  await mkdir(join(root, 'public-node'), { recursive: true });
  await writeFile(node, '#!/bin/sh\nexit 0\n');
  await chmod(node, 0o755);
  return { root, bin, code, native, node };
}

test('the trusted Node executable is readable without exposing its directory or private siblings', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    const request = { environment: { PATH: f.bin }, workspace: join(f.root, 'checkout'),
      privateRoots: [join(f.root, 'private')], writeRoots: ['src'], nodeExecutable: f.node };
    const result = await namedCodexFilesystem(request);
    assert.equal(result.additionalFilesystemRules[f.node], 'read');
    assert.equal(result.additionalFilesystemRules[join(f.root, 'public-node')], undefined);
    assert.equal(result.additionalFilesystemRules[join(f.root, 'private')], 'deny');
    assert.ok(result.peer.includes(`${JSON.stringify(f.node)}="read"`));
    assert.ok(result.work.includes(`${JSON.stringify(f.node)}="read"`));
    assert.ok(!result.peer.includes('="write"'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a trusted-runtime symlink cannot expose a protected store or checkout', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    const alias = join(f.bin, 'node');
    await symlink(f.node, alias);
    for (const scope of [{ workspace: join(f.root, 'public-node'), privateRoots: [] },
      { workspace: join(f.root, 'checkout'), privateRoots: [join(f.root, 'public-node')] }]) {
      const request = { environment: { PATH: f.bin }, ...scope, writeRoots: [], nodeExecutable: alias };
      await assert.rejects(namedCodexFilesystem(request), /named_session_provider_runtime_scope_invalid/);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('relative, missing, directory and non-executable trusted runtimes fail closed', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    await chmod(f.node, 0o600);
    for (const nodeExecutable of ['relative', join(f.root, 'missing'), join(f.root, 'public-node'), f.node]) {
      const request = { environment: { PATH: f.bin }, workspace: join(f.root, 'checkout'), privateRoots: [], writeRoots: [], nodeExecutable };
      await assert.rejects(namedCodexFilesystem(request), /named_session_node_runtime_invalid/);
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('production composition exposes the running Node, never an environment-selected replacement', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    const result = await namedCodexFilesystem({ environment: { PATH: f.bin, NODE: '/foreign/node' },
      workspace: join(f.root, 'checkout'), privateRoots: [], writeRoots: [] });
    assert.equal(result.additionalFilesystemRules[await realpath(process.execPath)], 'read');
    assert.equal(result.additionalFilesystemRules['/foreign/node'], undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a runtime already inside the public provider package needs no redundant child mount', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    const node = join(f.code, 'node');
    await writeFile(node, '#!/bin/sh\nexit 0\n'); await chmod(node, 0o755);
    const result = await namedCodexFilesystem({ environment: { PATH: f.bin }, workspace: join(f.root, 'checkout'),
      privateRoots: [], writeRoots: [], nodeExecutable: node });
    assert.deepEqual(result.runtimeRoots, [f.code, f.native]);
    assert.equal(result.additionalFilesystemRules[node], undefined);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('named filesystem exposes only public provider packages and denies existing private roots', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    const result = await namedCodexFilesystem({ environment: { PATH: f.bin }, workspace: join(f.root, 'checkout'),
      privateRoots: [join(f.root, 'device'), join(f.root, 'codex'), '/run/ef/current'], writeRoots: ['src', 'tests'], nodeExecutable: f.node });
    assert.deepEqual(result.runtimeRoots, [f.code, f.native, f.node]);
    assert.deepEqual(result.additionalFilesystemRules, { [f.code]: 'read', [f.native]: 'read', [f.node]: 'read',
      [join(f.root, 'device')]: 'deny', [join(f.root, 'codex')]: 'deny', '/run/ef/current': 'deny' });
    assert.equal(Object.isFrozen(result.additionalFilesystemRules), true);
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

test('parent denials cover nested OS sockets regardless of order without weakening sibling isolation', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture();
  try {
    for (const privateRoots of [
      ['/run/user/1000', '/run/user/1000/bus', '/run/user/1000', '/run/user/10001'],
      ['/run/ef/current/bus', '/run/ef/current', '/run/ef/current/keyring/control', '/run/ef/current-sibling'],
    ]) {
      const result = await namedCodexFilesystem({ environment: { PATH: f.bin }, workspace: join(f.root, 'checkout'),
        privateRoots, writeRoots: ['src'], nodeExecutable: f.node });
      const parents = privateRoots[0]!.startsWith('/run/user/')
        ? ['/run/user/1000', '/run/user/10001'] : ['/run/ef/current', '/run/ef/current-sibling'];
      assert.deepEqual(result.additionalFilesystemRules, {
        [f.code]: 'read', [f.native]: 'read', [f.node]: 'read', ...Object.fromEntries(parents.map(root => [root, 'deny'])),
      });
      for (const root of parents) {
        assert.ok(result.peer.includes(`${JSON.stringify(root)}="deny"`));
        assert.ok(result.work.includes(`${JSON.stringify(root)}="deny"`));
      }
      assert.ok(!result.peer.includes('/bus"'));
      assert.ok(!result.work.includes('/keyring/control"'));
      assert.ok(!result.peer.includes('="write"'));
    }
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
