import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compileFunction} from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';
import {parseCliOptions, sourceRepositoryFingerprint} from './index.js';

// Real public-command binding; only its subsequent native startup is synthetic.
async function fixture() {
  const now = Date.now(), id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  let starts = 0, supplied: any, allowed = true, nested = false;
  const input = {workspace: resolve('synthetic-source'), name: 'implementer', signal: new AbortController().signal,
    current: async () => allowed, reserve: async () => true, maximumProviderCostCents: 25,
    expectedAccountEmail: 'synthetic@example.test', intent: {schema: 'dharma.codex-setup-intent/v1',
      operationId: id(1), setupReference: id(2), organizationId: 'org_demo', recipientMembershipId: id(3),
      hostContextId: id(4), origin: 'https://hq.example', repositoryFingerprint: sourceRepositoryFingerprint('https://github.com/demo/source.git').fingerprint,
      scopeDigest: `sha256:${'b'.repeat(64)}`, contractDigest: `sha256:${'c'.repeat(64)}`, policyRevision: 'policy-v1',
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}};
  const scope = prepareCodexBootstrapHost({intent: input.intent as Parameters<typeof prepareCodexBootstrapHost>[0]['intent'],
    workspace: input.workspace, signal: input.signal, current: input.current});
  const argv = ['bootstrap', ...[...scope.flags].flatMap(([key, value]) => value === true ? [`--${key}`] : [`--${key}`, String(value)])];
  scope.scope.close();
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const matches = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'openCodexBootstrapFromPortalCommand');
  assert.equal(matches.length, 1);
  const compiled = ts.transpileModule(matches[0]!.getText(ast), {compilerOptions: {
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS}, reportDiagnostics: true});
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const dependencies = {currentBootstrapHostScope: () => nested ? {} : undefined,
    prepareCodexBootstrapHost, parseCliOptions, resolve, Buffer, URL, sourceRepositoryFingerprint,
    openCodexBootstrapNativeHost: async (value: unknown) => {starts++; supplied = value; return {threadId: 'synthetic-native'};}};
  const open = compileFunction(`${compiled.outputText}\nreturn openCodexBootstrapFromPortalCommand;`, ['exports', ...Object.keys(dependencies)])(
    {}, ...Object.values(dependencies)) as (value: any) => Promise<any>;
  return {input, argv, open, get starts() {return starts;}, get supplied() {return supplied;},
    withdraw() {allowed = false;}, nested() {nested = true;}};
}

test('portal command enters the owning host with only the fixed recipient/source intent and budget', async () => {
  const f = await fixture();
  const args = [...f.argv]; args[args.indexOf('--workspace') + 1] = '.'; args[args.indexOf('--provider') + 1] = 'auto';
  assert.equal((await f.open({...f.input, portalArgs: args})).threadId, 'synthetic-native');
  assert.equal(f.starts, 1); assert.deepEqual(f.supplied.intent, f.input.intent);
  assert.notEqual(f.supplied.intent, f.input.intent); assert.equal(f.supplied.reserve, f.input.reserve);
  assert.equal(f.supplied.maximumProviderCostCents, 25); assert.equal('portalArgs' in f.supplied, false);
});
test('matching public selected-repository URL is validated, never cloned or passed as startup authority', async () => {
  const f = await fixture();
  const args = [...f.argv, '--repository-url-base64url', Buffer.from('https://github.com/demo/source.git').toString('base64url')];
  await f.open({...f.input, portalArgs: args}); assert.equal(f.starts, 1);
  assert.equal('repository-url-base64url' in f.supplied, false); assert.equal(f.supplied.workspace, f.input.workspace);
});
for (const cause of ['command', 'extra', 'duplicate', 'grant', 'private-prompt', 'resume', 'join', 'dry-run', 'help',
  'recipient', 'reference', 'organization', 'origin', 'policy', 'scope', 'contract', 'workspace', 'provider', 'incomplete'] as const) {
  test(`portal binding rejects ${cause} before native/store/model admission`, async () => {
    const f = await fixture(), args = [...f.argv];
    const replace = (key: string, value: string) => {args[args.indexOf(`--${key}`) + 1] = value;};
    if (cause === 'command') args[0] = 'status';
    if (cause === 'extra') args.push('shell-fragment');
    if (cause === 'duplicate') args.push('--setup-reference', String(f.input.intent.setupReference));
    if (cause === 'grant') args.push('--grant', 'private-canary-never-echo');
    if (cause === 'private-prompt') args.push('--grant-prompt');
    if (cause === 'resume') args.push('--resume');
    if (cause === 'join') args.push('--join-repository-binding-id', f.input.intent.operationId);
    if (cause === 'dry-run') args.push('--dry-run');
    if (cause === 'help') args.push('--help');
    if (cause === 'recipient') replace('setup-recipient-membership-id', f.input.intent.operationId);
    if (cause === 'reference') replace('setup-reference', f.input.intent.operationId);
    if (cause === 'organization') replace('organization-id', 'org_foreign');
    if (cause === 'origin') replace('portal-url', 'https://foreign.example');
    if (cause === 'policy') replace('policy-revision', 'foreign-policy');
    if (cause === 'scope') replace('setup-scope-digest', `sha256:${'d'.repeat(64)}`);
    if (cause === 'contract') replace('setup-contract-digest', `sha256:${'d'.repeat(64)}`);
    if (cause === 'workspace') replace('workspace', resolve('foreign-workspace'));
    if (cause === 'provider') replace('provider', 'foreign');
    if (cause === 'incomplete') args.splice(args.indexOf('--complete'), 1);
    await assert.rejects(f.open({...f.input, portalArgs: args}), /^Error: codex_setup_portal_command_mismatch$/);
    assert.equal(f.starts, 0);
  });
}
for (const [cause, remote] of [['foreign', 'https://github.com/foreign/source.git'],
  ['userinfo', 'https://user:private-canary@github.com/demo/source.git'],
  ['http', 'http://github.com/demo/source.git'], ['file', 'file:///tmp/source'],
  ['query', 'https://github.com/demo/source.git?private-canary'],
  ['fragment', 'https://github.com/demo/source.git#fragment'], ['missing-path', 'https://github.com/'],
  ['control-character', '\u0000https://github.com/demo/source.git']] as const) {
  test(`portal selected URL refuses ${cause} source`, async () => {
    const f = await fixture(), args = [...f.argv, '--repository-url-base64url', Buffer.from(remote).toString('base64url')];
    await assert.rejects(f.open({...f.input, portalArgs: args}), /^Error: codex_setup_portal_command_mismatch$/);
    assert.equal(f.starts, 0);
  });
}
for (const cause of ['overlong', 'sparse', 'noncanonical-base64', 'non-utf8'] as const) {
  test(`portal argument framing rejects ${cause} without native effects`, async () => {
    const f = await fixture(), args = [...f.argv];
    if (cause === 'overlong') args.push('a'.repeat(4097));
    if (cause === 'sparse') args.length++;
    if (cause === 'noncanonical-base64') args.push('--repository-url-base64url', 'abc=');
    if (cause === 'non-utf8') args.push('--repository-url-base64url', Buffer.from([255, 254]).toString('base64url'));
    await assert.rejects(f.open({...f.input, portalArgs: args}), /^Error: codex_setup_portal_command_mismatch$/);
    assert.equal(f.starts, 0);
  });
}
test('portal binding refuses lost host authority rather than starting a replacement', async () => {
  const f = await fixture(); f.withdraw();
  await assert.rejects(f.open({...f.input, portalArgs: f.argv}), /codex_setup_host_scope_unavailable/); assert.equal(f.starts, 0);
});
test('portal binding cannot be invoked from a borrowed setup/peer descendant', async () => {
  const f = await fixture(); f.nested();
  await assert.rejects(f.open({...f.input, portalArgs: f.argv}), /codex_setup_host_context_conflict/); assert.equal(f.starts, 0);
});
