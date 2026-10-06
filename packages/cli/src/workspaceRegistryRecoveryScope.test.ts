import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {currentBootstrapHostScope, runCodexBootstrapHost} from './bootstrapHostScope.js';

async function fixture(t: {after(fn: () => Promise<void>): void}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'dharma-recovery-scope-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const registry = path.join(root, 'registry', 'workspaces.json');
  await fs.mkdir(path.dirname(registry)); await fs.writeFile(registry, '[]');
  const now = Date.now(), digest = `sha256:${'a'.repeat(64)}`;
  const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  return {root, registry, entry: {workspaceId: id(5), organizationId: 'org_demo', path: root,
    repositoryRemoteHash: digest}, input: {workspace: root, current: async () => true,
    signal: new AbortController().signal, intent: {schema: 'dharma.codex-setup-intent/v1' as const,
      operationId: id(1), setupReference: id(2), organizationId: 'org_demo', recipientMembershipId: id(3),
      origin: 'https://hq.example', repositoryFingerprint: digest, policyRevision: 'policy-v1',
      scopeDigest: digest, contractDigest: digest, hostContextId: id(4),
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}}};
}

// Execute the actual module with only its filesystem boundary instrumented.
async function recovery(overrides: Record<string, unknown> = {}) {
  const source = await fs.readFile(new URL('../src/workspaceRegistryRecovery.ts', import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(output.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error).length, 0);
  const exports: Record<string, (...args: any[]) => Promise<any>> = {};
  runInNewContext(output.outputText, {exports, Buffer, process, Date, structuredClone,
    require: (name: string) => {
      if (name === 'node:fs/promises') return {...fs, ...overrides};
      if (name === 'node:crypto') return crypto;
      if (name === 'node:path') return path;
      if (name === './bootstrapHostScope.js') return {currentBootstrapHostScope};
      throw new Error('unexpected fixture dependency');
    }}, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}});
  return exports;
}

test('recovery scope refuses closed inspect and apply before filesystem effects', async t => {
  const f = await fixture(t); let effects = 0;
  const c = await recovery({lstat: async (...args: Parameters<typeof fs.lstat>) => {
    effects++; return fs.lstat(...args);
  }});
  for (const apply of [false, true]) {
    let rejected = false;
    await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
      scope.close();
      try {
        if (apply) await c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
          expectedKind: 'valid', expectedHash: null, entry: f.entry});
        else await c.inspectRegistryRecoveryFile!(f.registry);
      } catch (error) {rejected = true; throw error;}
    }), {message: 'codex_setup_host_scope_unavailable'});
    assert.equal(rejected, true);
  }
  assert.equal(effects, 0);
});

test('recovery scope cannot read after metadata withdrawal or return withdrawn bytes', async t => {
  for (const phase of ['metadata', 'read']) {
    const f = await fixture(t); let reads = 0, returned = false;
    await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
      const c = await recovery({lstat: async (...args: Parameters<typeof fs.lstat>) => {
        const value = await fs.lstat(...args); if (phase === 'metadata') scope.close(); return value;
      }, readFile: async (...args: Parameters<typeof fs.readFile>) => {
        reads++; const value = await fs.readFile(...args); if (phase === 'read') scope.close(); return value;
      }});
      await c.inspectRegistryRecoveryFile!(f.registry); returned = true;
    }), {message: 'codex_setup_host_scope_unavailable'});
    assert.equal(returned, false); assert.equal(reads, phase === 'read' ? 1 : 0);
  }
});

test('recovery scope requalifies ENOENT and redacts filesystem diagnostics', async t => {
  const f = await fixture(t);
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await recovery({lstat: async () => {scope.close();
      throw Object.assign(new Error('private-missing-canary'), {code: 'ENOENT'});
    }});
    await c.inspectRegistryRecoveryFile!(f.registry);
  }), {message: 'codex_setup_host_scope_unavailable'});
  const c = await recovery({lstat: async () => {
    throw Object.assign(new Error('private-filesystem-canary'), {code: 'EACCES'});
  }});
  await runCodexBootstrapHost(f.input, async () => {
    await assert.rejects(c.inspectRegistryRecoveryFile!(f.registry), (error: Error) =>
      error.message === 'registry_recovery_read_failed' && error.cause === undefined);
  });
});

test('recovery backup snapshots bytes before asynchronous directory preparation', async t => {
  const f = await fixture(t), bytes = Buffer.from('[]'); let mutated = false;
  const c = await recovery({mkdir: async (...args: Parameters<typeof fs.mkdir>) => {
    if (!mutated) {mutated = true; bytes.fill(0x78);} return fs.mkdir(...args);
  }});
  await runCodexBootstrapHost(f.input, async () => {
    const backup = await c.backupRegistryRecoveryFile!({home: f.root, path: f.registry, expectedBytes: bytes});
    assert.equal(await fs.readFile(backup, 'utf8'), '[]');
  });
});

test('recovery backup preserves created evidence and stops after authority withdrawal', async t => {
  const f = await fixture(t); let laterReads = 0, backup: string | undefined;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await recovery({readFile: async (...args: Parameters<typeof fs.readFile>) => {
      laterReads++; return fs.readFile(...args);
    }, writeFile: async (file: Parameters<typeof fs.writeFile>[0], ...args: any[]) => {
      await fs.writeFile(file, args[0], args[1]); backup = String(file); scope.close();
    }, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('.bin')) {
        backup = String(args[0]); const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => {
          await write(...input); scope.close();
        };
      }
      return handle;
    }});
    await c.backupRegistryRecoveryFile!({home: f.root, path: f.registry, expectedBytes: Buffer.from('[]')});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(laterReads, 0); assert.ok(backup); assert.equal(await fs.readFile(backup, 'utf8'), '[]');
});

test('recovery apply snapshots the intended entry before its first read', async t => {
  const f = await fixture(t), original = {...f.entry}; let mutated = false;
  const c = await recovery({readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const value = await fs.readFile(...args);
    if (!mutated) {mutated = true; f.entry.workspaceId = 'foreign-mutated-row';} return value;
  }});
  const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
  await runCodexBootstrapHost(f.input, async () => {
    await c.applyRegistryRecoveryFile!({home: f.root, path: f.registry, expectedKind: 'valid', expectedHash, entry: f.entry});
  });
  assert.deepEqual(JSON.parse(await fs.readFile(f.registry, 'utf8')), [original]);
});

test('recovery apply closes and removes its own temporary after exclusive-open withdrawal', async t => {
  const f = await fixture(t); let temporary: string | undefined, closes = 0, writes = 0;
  const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await recovery({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        temporary = String(args[0]); const close = handle.close.bind(handle), write = handle.writeFile.bind(handle);
        handle.close = async () => {closes++; await close();};
        handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => {writes++; await write(...input);};
        scope.close();
      }
      return handle;
    }});
    await c.applyRegistryRecoveryFile!({home: f.root, path: f.registry, expectedKind: 'valid', expectedHash, entry: f.entry});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.ok(temporary); assert.equal(closes, 1); assert.equal(writes, 0);
  await assert.rejects(fs.lstat(temporary), {code: 'ENOENT'});
  assert.equal(await fs.readFile(f.registry, 'utf8'), '[]');
});

test('recovery apply does not rename after temporary write withdraws authority', async t => {
  const f = await fixture(t); let renames = 0;
  const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await recovery({writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await fs.writeFile(...args); if (String(args[0]).endsWith('.tmp')) scope.close();
    }, open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => {await write(...input); scope.close();};
      }
      return handle;
    }, rename: async (...args: Parameters<typeof fs.rename>) => {renames++; await fs.rename(...args);}});
    await c.applyRegistryRecoveryFile!({home: f.root, path: f.registry, expectedKind: 'valid', expectedHash, entry: f.entry});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(renames, 0); assert.equal(await fs.readFile(f.registry, 'utf8'), '[]');
  assert.deepEqual((await fs.readdir(path.dirname(f.registry))).sort(), ['recovery-backups', 'workspaces.json']);
});

test('recovery apply preserves a foreign replacement at its temporary name', async t => {
  const f = await fixture(t); let replaced: string | undefined, owned: string | undefined;
  const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
  let result: unknown;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await recovery({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async (...input: Parameters<typeof handle.writeFile>) => {
          await write(...input); replaced = String(args[0]); owned = `${replaced}.retained`;
          await fs.rename(replaced, owned); await fs.writeFile(replaced, 'foreign-preserve'); scope.close();
        };
      }
      return handle;
    }});
    try {await c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
      expectedKind: 'valid', expectedHash, entry: f.entry});} catch (error) {result = error; throw error;}
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.ok(result instanceof Error || result && typeof result === 'object');
  assert.equal((result as Error).message, 'registry_recovery_cleanup_unconfirmed');
  assert.ok(replaced); assert.ok(owned); assert.equal(await fs.readFile(replaced, 'utf8'), 'foreign-preserve');
  assert.equal(await fs.readFile(f.registry, 'utf8'), '[]');
});

test('recovery apply verifies exact final bytes rather than only matching row count', async t => {
  const f = await fixture(t); let renamed = false;
  const c = await recovery({rename: async (...args: Parameters<typeof fs.rename>) => {
    await fs.rename(...args); renamed = true;
  }, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    if (renamed && String(args[0]) === f.registry) return Buffer.from(JSON.stringify([{...f.entry, repositoryRemoteHash: 'foreign'}]));
    return fs.readFile(...args);
  }});
  const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
  await runCodexBootstrapHost(f.input, async () => {
    await assert.rejects(c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
      expectedKind: 'valid', expectedHash, entry: f.entry}), {message: 'registry_recovery_write_unconfirmed'});
  });
});

test('recovery backup refuses a symlinked directory without touching its target', async t => {
  const f = await fixture(t), target = path.join(f.root, 'foreign-backups');
  await fs.mkdir(target);
  await fs.symlink(target, path.join(f.root, 'registry', 'recovery-backups'), 'junction');
  const c = await recovery();
  await runCodexBootstrapHost(f.input, async () => {
    await assert.rejects(c.backupRegistryRecoveryFile!({home: f.root, path: f.registry, expectedBytes: Buffer.from('[]')}),
      {message: 'registry_recovery_backup_directory_unsafe'});
  });
  assert.deepEqual(await fs.readdir(target), []);
});

test('recovery backup closes an acquired handle before post-open withdrawal can escape', async t => {
  const f = await fixture(t); let closes = 0, writes = 0;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    const c = await recovery({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args), close = handle.close.bind(handle);
      handle.close = async () => {closes++; await close();};
      handle.writeFile = async () => {writes++;};
      scope.close(); return handle;
    }});
    await c.backupRegistryRecoveryFile!({home: f.root, path: f.registry, expectedBytes: Buffer.from('[]')});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.equal(closes, 1); assert.equal(writes, 0);
  const backups = await fs.readdir(path.join(f.root, 'registry', 'recovery-backups'));
  assert.equal(backups.length, 1);
  assert.equal((await fs.readFile(path.join(f.root, 'registry', 'recovery-backups', backups[0]!))).length, 0);
});

test('recovery apply never deletes a reused temporary name after its own successful rename', async t => {
  const f = await fixture(t); let reused: string | undefined, readsAfterRename = 0;
  const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
  await assert.rejects(runCodexBootstrapHost(f.input, async ({scope}) => {
    let renamed = false;
    const c = await recovery({rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args); reused = String(args[0]); await fs.writeFile(reused, 'foreign-preserve');
      renamed = true; scope.close();
    }, readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (renamed) readsAfterRename++; return fs.readFile(...args);
    }});
    await c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
      expectedKind: 'valid', expectedHash, entry: f.entry});
  }), {message: 'codex_setup_host_scope_unavailable'});
  assert.ok(reused); assert.equal(await fs.readFile(reused, 'utf8'), 'foreign-preserve');
  assert.deepEqual(JSON.parse(await fs.readFile(f.registry, 'utf8')), [f.entry]);
  assert.equal(readsAfterRename, 0);
});

test('recovery apply preserves unknown ownership after handle metadata fails', async t => {
  const f = await fixture(t); let temporary: string | undefined, closes = 0;
  const c = await recovery({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('.tmp')) {
      temporary = String(args[0]); const close = handle.close.bind(handle);
      handle.stat = async () => {throw new Error('private-metadata-canary');};
      handle.close = async () => {closes++; await close();};
    }
    return handle;
  }});
  const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
  await runCodexBootstrapHost(f.input, async () => {
    await assert.rejects(c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
      expectedKind: 'valid', expectedHash, entry: f.entry}), {message: 'registry_recovery_cleanup_unconfirmed'});
  });
  assert.ok(temporary); assert.equal(closes, 1); assert.equal((await fs.readFile(temporary)).length, 0);
  assert.equal(await fs.readFile(f.registry, 'utf8'), '[]');
});

test('recovery apply does not convert write or close failures into success', async t => {
  for (const phase of ['write', 'close']) {
    const f = await fixture(t); let calls = 0;
    const c = await recovery({open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith('.tmp')) {
        if (phase === 'write') handle.writeFile = async () => {throw new Error('private-write-canary');};
        else {
          const close = handle.close.bind(handle);
          handle.close = async () => {calls++; await close(); throw new Error('private-close-canary');};
        }
      }
      return handle;
    }});
    const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
    await runCodexBootstrapHost(f.input, async () => {
      await assert.rejects(c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
        expectedKind: 'valid', expectedHash, entry: f.entry}),
      (error: Error) => error.message === (phase === 'write' ? 'registry_recovery_write_failed'
        : 'registry_recovery_cleanup_unconfirmed') && error.cause === undefined);
    });
    assert.equal(await fs.readFile(f.registry, 'utf8'), '[]');
    if (phase === 'close') assert.equal(calls, 2);
  }
});

test('current recovery scope preserves sibling rows and reports already-present without effects', async t => {
  const f = await fixture(t), sibling = {...f.entry, workspaceId: 'sibling', path: `${f.root}-sibling`};
  await fs.writeFile(f.registry, JSON.stringify([sibling])); const c = await recovery();
  await runCodexBootstrapHost(f.input, async () => {
    const before = await c.inspectRegistryRecoveryFile!(f.registry);
    const result = await c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
      expectedKind: before.kind, expectedHash: before.hash, entry: f.entry});
    assert.equal(result.state, 'recovered'); assert.equal(result.restoredCount, 2);
    assert.deepEqual(JSON.parse(await fs.readFile(f.registry, 'utf8')), [sibling, f.entry]);
    const current = await c.inspectRegistryRecoveryFile!(f.registry);
    const after = await c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
      expectedKind: current.kind, expectedHash: current.hash, entry: f.entry});
    assert.equal(after.state, 'already_present'); assert.equal(after.backup, null);
  });
});

test('recovery apply preserves a backup close failure without leaking host diagnostics', async t => {
  const f = await fixture(t);
  const c = await recovery({open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (String(args[0]).endsWith('.bin')) {
      const close = handle.close.bind(handle);
      handle.close = async () => {await close(); throw new Error('private-backup-close-canary');};
    }
    return handle;
  }});
  const expectedHash = `sha256:${crypto.createHash('sha256').update('[]').digest('hex')}`;
  await runCodexBootstrapHost(f.input, async () => {
    await assert.rejects(c.applyRegistryRecoveryFile!({home: f.root, path: f.registry,
      expectedKind: 'valid', expectedHash, entry: f.entry}),
    {message: 'registry_recovery_backup_close_unconfirmed'});
  });
  assert.equal(await fs.readFile(f.registry, 'utf8'), '[]');
});
