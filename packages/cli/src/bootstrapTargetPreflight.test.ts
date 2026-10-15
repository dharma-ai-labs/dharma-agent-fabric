import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Exercise the real bootstrap entry before any repository, identity or network
// effect. All context below is synthetic; no local enrollment is opened.
async function fixture(existing: {organizationId: string; hqUrl: string} | null) {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const entry = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrap');
  assert.equal(entry.length, 1);
  const compiled = ts.transpileModule(entry[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.None}});
  const effects: string[] = [];
  const bootstrap = runInNewContext(`${compiled.outputText}\nbootstrap`, {
    readDeviceConfig: async () => existing,
    automaticBootstrapResume: () => false,
    normalizeHqUrl: (value: string) => new URL(value).origin,
    portalUrl: () => 'https://hq.example',
    required: (flags: Map<string, unknown>, key: string) => {
      const value = flags.get(key); if (typeof value !== 'string') throw Error(`missing_${key}`); return value;
    },
    bootstrapGrantMode: () => 'argument',
    dharmaHome: () => '/synthetic/device',
    normalizeGitRemoteIdentity: (value: string) => value,
    resolveBootstrapRepositoryWorkspace: async () => {
      effects.push('repository_selection'); throw Error('synthetic_selection_boundary');
    },
  }, {timeout: 1000, contextCodeGeneration: {strings: false, wasm: false}}) as
    (flags: Map<string, string | boolean>) => Promise<Record<string, unknown>>;
  const flags = new Map<string, string | boolean>([
    ['organization-id', 'org_intended'], ['grant', 'synthetic-not-a-grant'],
    ['repository-url-base64url', Buffer.from('https://example.invalid/team/repo.git').toString('base64url')],
  ]);
  return {bootstrap, flags, effects};
}

for (const existing of [
  {organizationId: 'org_foreign', hqUrl: 'https://hq.example'},
  {organizationId: 'org_intended', hqUrl: 'https://foreign.example'},
]) test('foreign local context is rejected before repository selection with no protected effects', async () => {
  const f = await fixture(existing);
  const result = await f.bootstrap(f.flags);
  assert.equal(result.code, 'connection_context_mismatch');
  assert.equal(result.effects, false);
  assert.equal(result.grantRedeemed, false);
  assert.equal(result.enrollmentChanged, false);
  assert.deepEqual(f.effects, []);
  assert.equal(JSON.stringify(result).includes('foreign'), false, 'Do not expose the unrelated tenant');
});

for (const existing of [null, {organizationId: 'org_intended', hqUrl: 'https://hq.example'}])
test('new or exactly matching local context may reach normal repository selection', async () => {
  const f = await fixture(existing);
  const result = await f.bootstrap(f.flags);
  assert.equal(result.stage, 'repository_selection');
  assert.deepEqual(f.effects, ['repository_selection']);
});

test('explicit legacy replacement retains its separately authorized downstream flow', async () => {
  const f = await fixture({organizationId: 'org_foreign', hqUrl: 'https://hq.example'});
  f.flags.set('replace-existing-enrollment', true);
  const result = await f.bootstrap(f.flags);
  assert.equal(result.stage, 'repository_selection');
  assert.deepEqual(f.effects, ['repository_selection']);
});
