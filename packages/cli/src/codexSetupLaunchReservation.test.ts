import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {canonicalize, validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {reserveCodexSetupLaunch} from './codexSetupLaunchReservation.js';

// Exercise the actual declaration with synthetic POSIX metadata. This is not
// a claim that Windows fixtures qualify Linux filesystem protection.
async function fixture() {
  const source = await readFile(new URL('../src/codexSetupLaunchReservation.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('reservation.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'reserveCodexSetupLaunch');
  assert.ok(declaration);
  const compiled = ts.transpileModule(declaration.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}}).outputText;
  let allowed = true, opens = 0, closes = 0, writes = 0, syncs = 0, duplicate = false, failClose = false;
  let homeMode = 0o700, owner = 1000, link = false, links = 1, saved = '', opened: unknown[] = [];
  let directoryFailure = false, directorySyncs = 0, directoryCloses = 0, directoryOpenFailure = false;
  let directoryCloseFailure = false, directoryMismatch = false, homeChanged = false;
  let homeReads = 0;
  const events: string[] = [];
  const synthetic = {platform: 'linux', getuid: () => 1000};
  const open = async (...args: unknown[]) => {
    if (!String(args[0]).endsWith('.json')) {
      if (directoryOpenFailure) throw new Error('PRIVATE_UNSUPPORTED_DIRECTORY_OPEN');
      return {
      stat: async () => ({isDirectory: () => true, uid: owner, mode: homeMode, dev: 1, ino: directoryMismatch ? 99 : 2}),
      sync: async () => {directorySyncs++; events.push('directory:sync'); if (directoryFailure) throw new Error('PRIVATE_SYNC_EXCEPTION');},
      close: async () => {directoryCloses++; if (directoryCloseFailure) throw new Error('PRIVATE_DIRECTORY_CLOSE');},
    };}
    opens++; opened = args; if (duplicate) throw new Error('PRIVATE_STORAGE_EXCEPTION'); duplicate = true;
    return {stat: async () => ({isFile: () => true, nlink: links, uid: owner, mode: 0o600}),
      writeFile: async (text: string) => {writes++; saved = text; events.push('file:write');},
      sync: async () => {syncs++; events.push('file:sync');},
      close: async () => {closes++; if (failClose) throw new Error('PRIVATE_CLOSE_EXCEPTION');}};
  };
  const lstat = async () => ({isDirectory: () => true, isSymbolicLink: () => link, uid: owner, mode: homeMode,
    dev: 1, ino: ++homeReads > 1 && homeChanged ? 99 : 2});
  const reserve = compileFunction(compiled.replaceAll('import.meta.dirname', 'syntheticModuleDirectory') + '\nreturn reserveCodexSetupLaunch;',
    ['exports', 'process', 'isAbsolute', 'resolve', 'createHash', 'constants', 'lstat', 'open', 'validateContract', 'canonicalize', 'syntheticModuleDirectory'])(
    {}, synthetic, isAbsolute, resolve, createHash, constants, lstat, open, validateContract, canonicalize,
    fileURLToPath(new URL('.', import.meta.url))) as (input: any) => Promise<boolean>;
  const input = {home: resolve('synthetic-owned-home'), organizationId: 'org_fixture',
    setupReference: '11111111-1111-4111-8111-111111111111', operationId: '22222222-2222-4222-8222-222222222222',
    promptSha256: 'a'.repeat(64), cents: 25, current: async () => allowed};
  return {reserve, input, setAllowed: (value: boolean) => {allowed = value;},
    setMode: (value: number) => {homeMode = value;}, setOwner: (value: number) => {owner = value;},
    setLink: () => {link = true;}, setLinks: () => {links = 2;}, failClose: () => {failClose = true;},
    failDirectorySync: () => {directoryFailure = true;}, get directorySyncs() {return directorySyncs;},
    get directoryCloses() {return directoryCloses;}, events,
    failDirectoryOpen: () => {directoryOpenFailure = true;}, failDirectoryClose: () => {directoryCloseFailure = true;},
    mismatchDirectory: () => {directoryMismatch = true;}, changeHome: () => {homeChanged = true;},
    get calls() {return {opens, closes, writes, syncs};}, get saved() {return saved;}, get opened() {return opened;}};
}
test('one reference reserves once using exclusive private no-follow creation and retains unresolved liability', async () => {
  const f = await fixture(); assert.equal(await f.reserve(f.input), true);
  assert.equal(f.opened[1], constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW);
  assert.equal(f.opened[2], 0o600);
  assert.deepEqual(f.calls, {opens: 1, closes: 1, writes: 1, syncs: 1});
  const record = JSON.parse(f.saved);
  assert.equal(record.reservedProviderCostCents, 25); assert.equal(record.actualUsd, null);
  assert.equal(record.status, 'UNSETTLED_NOT_RELEASED'); assert.equal(record.hardInvoiceCapProven, false);
  assert.equal(await f.reserve(f.input), false); assert.equal(f.calls.writes, 1);
});
for (const cause of ['open', 'stat', 'close', 'home'] as const) {
  test(`directory ${cause} uncertainty prevents provider admission`, async () => {
    const f = await fixture();
    if (cause === 'open') f.failDirectoryOpen();
    if (cause === 'stat') f.mismatchDirectory();
    if (cause === 'close') f.failDirectoryClose();
    if (cause === 'home') f.changeHome();
    assert.equal(await f.reserve(f.input), false);
    if (cause === 'open' || cause === 'stat') assert.equal(f.calls.writes, 0);
    if (cause !== 'open') assert.equal(f.directoryCloses, 1);
  });
}
test('Linux real private fixture persists the exclusive schema-valid reservation', {skip: process.platform !== 'linux'}, async t => {
  const home = await mkdtemp(resolve(tmpdir(), 'dharma-setup-reservation-'));
  t.after(async () => {await rm(home, {recursive: true, force: true});});
  const input = {home, organizationId: 'org_fixture', setupReference: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222', promptSha256: 'a'.repeat(64), cents: 25, current: async () => true};
  assert.equal(await reserveCodexSetupLaunch(input), true);
  const key = createHash('sha256').update(input.organizationId + '\0' + input.setupReference).digest('hex');
  const record = JSON.parse(await readFile(resolve(home, 'setup-reservation-' + key + '.json'), 'utf8'));
  assert.equal((await validateContract(fileURLToPath(new URL('./schemas', import.meta.url)),
    'https://schemas.dharma-ai.io/setup-launch-reservation/v1', record)).ok, true);
  assert.equal(await reserveCodexSetupLaunch(input), false);
});
test('reservation fsyncs its directory after file data and refuses an uncertain durable entry', async () => {
  const f = await fixture(); assert.equal(await f.reserve(f.input), true);
  assert.deepEqual(f.events, ['file:write', 'file:sync', 'directory:sync']);
  assert.equal(f.directoryCloses, 1);
  const g = await fixture(); g.failDirectorySync();
  assert.equal(await g.reserve(g.input), false); assert.equal(g.calls.writes, 1);
  assert.equal(g.directoryCloses, 1); assert.equal(await g.reserve(g.input), false);
  assert.equal(g.calls.writes, 1, 'uncertain reservation is retained, not retried');
});
test('persisted reservation conforms to a versioned contract and canonical integrity metadata', async () => {
  const f = await fixture(); assert.equal(await f.reserve(f.input), true);
  const value = JSON.parse(f.saved);
  const schema = fileURLToPath(new URL('./schemas', import.meta.url));
  assert.equal((await validateContract(schema, 'https://schemas.dharma-ai.io/setup-launch-reservation/v1', value)).ok, true);
  const {integrity, ...payload} = value;
  assert.deepEqual(integrity, {algorithm: 'sha256', payloadSha256: createHash('sha256').update(canonicalize(payload)).digest('hex')});
  for (const change of [{reservedProviderCostCents: 26}, {actualUsd: 0}, {schema: 'unknown'}, {extra: 'forbidden'}]) {
    assert.equal((await validateContract(schema, 'https://schemas.dharma-ai.io/setup-launch-reservation/v1', {...value, ...change})).ok, false);
  }
});
for (const reason of ['withdrawn', 'writable', 'owner', 'symlink', 'budget', 'reference', 'platform'] as const) {
  test(`reservation rejects ${reason} before file creation`, async () => {
    const f = await fixture();
    if (reason === 'withdrawn') f.setAllowed(false);
    if (reason === 'writable') f.setMode(0o755);
    if (reason === 'owner') f.setOwner(1001);
    if (reason === 'symlink') f.setLink();
    if (reason === 'budget') f.input.cents = 26;
    if (reason === 'reference') f.input.setupReference = 'invalid';
    if (reason === 'platform') f.input.home = 'relative';
    assert.equal(await f.reserve(f.input), false); assert.equal(f.calls.opens, 0);
  });
}
test('a multiply linked file is not written and close failure never admits model execution', async () => {
  const f = await fixture(); f.setLinks();
  assert.equal(await f.reserve(f.input), false); assert.equal(f.calls.writes, 0); assert.equal(f.calls.closes, 1);
  const g = await fixture(); g.failClose();
  assert.equal(await g.reserve(g.input), false); assert.equal(g.calls.writes, 1);
});
