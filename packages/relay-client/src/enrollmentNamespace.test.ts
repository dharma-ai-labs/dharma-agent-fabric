import assert from 'node:assert/strict';
import {chmod, lstat, mkdir, mkdtemp, readdir, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {acquireEnrollmentAnchorLock} from './enrollmentAnchorLock.js';

test('unsafe preexisting POSIX lock namespaces are rejected without mutation', {skip: process.platform === 'win32'}, async () => {
  for (const kind of ['writable', 'symlink'] as const) {
    const root = await mkdtemp(resolve(tmpdir(), 'fabric-unsafe-namespace-'));
    const namespace = resolve(root, 'locks'), target = resolve(root, 'target');
    try {
      if (kind === 'symlink') {await mkdir(target, {mode: 0o700}); await symlink(target, namespace);}
      else {await mkdir(namespace, {mode: 0o777}); await chmod(namespace, 0o777);}
      const before = await lstat(namespace, {bigint: true});
      await assert.rejects(acquireEnrollmentAnchorLock(resolve(namespace, 'anchor.lock')), /connection_anchor_lock_invalid/);
      const after = await lstat(namespace, {bigint: true});
      assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode);
      assert.deepEqual(await readdir(kind === 'symlink' ? target : namespace), []);
    } finally {await rm(root, {recursive: true, force: true});}
  }
});

test('POSIX directory ownership, mode and symlink faults fail closed before publication on every test host', async () => {
  const [{readFile}, {fileURLToPath}, {runInNewContext}, {randomUUID}, {dirname}, {default: ts}] = await Promise.all([
    import('node:fs/promises'), import('node:url'), import('node:vm'), import('node:crypto'), import('node:path'), import('typescript'),
  ]);
  const source = await readFile(fileURLToPath(new URL('../src/enrollmentAnchorLock.ts', import.meta.url)), 'utf8');
  const ast = ts.createSourceFile('lock.ts', source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'acquireEnrollmentAnchorLock')!;
  const compiled = ts.transpileModule(node.getText(ast).replace('export async', 'async'), {
    compilerOptions: {target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None},
  }).outputText;
  for (const kind of ['foreign-owner', 'public-mode', 'symlink']) {
    let writes = 0;
    const acquire = runInNewContext(compiled + '\nacquireEnrollmentAnchorLock', {
      dirname, randomUUID, Date, setTimeout, process: {...process, platform: 'linux', getuid: () => 1234},
      mkdir: async () => undefined,
      lstat: async () => ({isDirectory: () => true, isFile: () => true,
        isSymbolicLink: () => kind === 'symlink', uid: kind === 'foreign-owner' ? 5678n : 1234n,
        mode: kind === 'public-mode' ? 0o40777n : 0o40700n, dev: 1n, ino: 2n}),
      writeFile: async () => {writes++;}, link: async () => {writes++;}, unlink: async () => undefined,
    }) as typeof acquireEnrollmentAnchorLock;
    await assert.rejects(acquire('/tmp/synthetic-private-locks/anchor.lock'), /connection_anchor_lock_invalid/, kind);
    assert.equal(writes, 0, kind);
  }
});
