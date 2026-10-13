import assert from 'node:assert/strict';
import {constants} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve, isAbsolute} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

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
  const synthetic = {platform: 'linux', getuid: () => 1000};
  const open = async (...args: unknown[]) => {
    opens++; opened = args; if (duplicate) throw new Error('PRIVATE_STORAGE_EXCEPTION'); duplicate = true;
    return {stat: async () => ({isFile: () => true, nlink: links, uid: owner, mode: 0o600}),
      writeFile: async (text: string) => {writes++; saved = text;}, sync: async () => {syncs++;},
      close: async () => {closes++; if (failClose) throw new Error('PRIVATE_CLOSE_EXCEPTION');}};
  };
  const lstat = async () => ({isDirectory: () => true, isSymbolicLink: () => link, uid: owner, mode: homeMode});
  const reserve = compileFunction(compiled + '\nreturn reserveCodexSetupLaunch;',
    ['exports', 'process', 'isAbsolute', 'resolve', 'createHash', 'constants', 'lstat', 'open'])(
    {}, synthetic, isAbsolute, resolve, createHash, constants, lstat, open) as (input: any) => Promise<boolean>;
  const input = {home: resolve('synthetic-owned-home'), organizationId: 'org_fixture',
    setupReference: '11111111-1111-4111-8111-111111111111', operationId: '22222222-2222-4222-8222-222222222222',
    promptSha256: 'a'.repeat(64), cents: 25, current: async () => allowed};
  return {reserve, input, setAllowed: (value: boolean) => {allowed = value;},
    setMode: (value: number) => {homeMode = value;}, setOwner: (value: number) => {owner = value;},
    setLink: () => {link = true;}, setLinks: () => {links = 2;}, failClose: () => {failClose = true;},
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
