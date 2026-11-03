import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { CLAUDE_LOGIN_REQUIRED_CODE, claudeSignInPreflight, type ClaudeSignInProbe } from './claudeSignInPreflight.js';

// #398: setup reported a ready Claude endpoint, then the first task failed with
// "Not logged in · Please run /login". Setup must check the Claude Code CLI sign-in first.

function probe(state: 'signed_in' | 'signed_out' | 'not_installed') {
  const calls: string[] = [];
  const value: ClaudeSignInProbe = {
    version: async () => { calls.push('version'); return state === 'not_installed' ? null : '2.1.311 (Claude Code)'; },
    readiness: async () => { calls.push('auth_status'); return state === 'signed_in' ? 'available' : 'partial'; },
  };
  return { probe: value, calls };
}

test('a signed-out Claude Code CLI blocks readiness with a stable code and one exact fix', async () => {
  const fake = probe('signed_out');
  const result = await claudeSignInPreflight(fake.probe);
  assert.ok(result);
  assert.equal(result.ok, false);
  assert.equal(result.code, CLAUDE_LOGIN_REQUIRED_CODE);
  assert.equal(result.code, 'provider_claude_login_required');
  assert.equal(result.stage, 'provider_preflight');
  assert.equal(result.provider, 'claude');
  assert.equal(result.grantRedeemed, false);
  assert.equal(result.enrollmentChanged, false);
  assert.match(result.message, /`claude`/);
  assert.match(result.message, /\/login/);
  assert.match(result.message, /rerun/i);
  assert.deepEqual(fake.calls, ['version', 'auth_status']);
});

test('a signed-in Claude Code CLI passes the preflight', async () => {
  const fake = probe('signed_in');
  assert.equal(await claudeSignInPreflight(fake.probe), null);
  assert.deepEqual(fake.calls, ['version', 'auth_status']);
});

test('a missing Claude Code CLI keeps the existing behavior and is not reported as a sign-in problem', async () => {
  const fake = probe('not_installed');
  assert.equal(await claudeSignInPreflight(fake.probe), null);
  assert.deepEqual(fake.calls, ['version']);
});

// Execute the actual bootstrap prefix through the claim boundary, as in
// bootstrapStartupPreflight.test.ts. Synthetic dependencies never enroll or start a relay.
async function bootstrapPrefix(provider: string, state: 'signed_in' | 'signed_out' | 'not_installed') {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const bootstrap = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrap');
  assert.ok(bootstrap && ts.isFunctionDeclaration(bootstrap) && bootstrap.body);
  const prefixEnd = bootstrap.body.statements.findIndex(node => node.getText(ast).startsWith('let config: DeviceConfig'));
  assert.ok(prefixEnd > 0);
  const effects: string[] = [];
  const fake = probe(state);
  const flags = new Map<string, string | boolean>([
    ['organization-id', 'org_demo'], ['complete', true], ['provider', provider], ['policy-revision', 'policy-v1'],
    ['setup-reference', '11111111-1111-4111-8111-111111111111'],
    ['setup-recipient-membership-id', '22222222-2222-4222-8222-222222222222'],
    ['setup-scope-digest', `sha256:${'a'.repeat(64)}`], ['setup-contract-digest', `sha256:${'b'.repeat(64)}`],
  ]);
  const dependencies = {
    VERSION: '0.2.217',
    flags, hostScope: undefined, portalUrl: () => 'https://hq.example', normalizeHqUrl: (url: string) => url,
    required: (input: typeof flags, key: string) => input.get(key), bootstrapGrantMode: () => 'reference',
    UUID_PATTERN: /^[a-f0-9-]{36}$/,
    loadAgentFabricOnboardingContract: async () => ({ sha256: 'b'.repeat(64) }),
    originalCodexSetupSessionSender: async () => ({}), dharmaHome: () => '/fixture/device',
    realpath: async () => '/fixture/repository', preflightBootstrapWorkspaceIdentity: async () => ({ fingerprint: 'source' }),
    assertBootstrapHostSource: async () => {}, isLocalProviderId: () => true,
    readDeviceConfig: async () => null,
    assertRelayStartupOwnership: async () => { effects.push('startup_preflight'); },
    assertBootstrapStartupAnchor: async () => {},
    readPrivateBootstrapGrant: async () => { effects.push('private_input'); return 'fixture'; },
    claudeSignInPreflight: async () => claudeSignInPreflight(fake.probe),
    process: { stderr: { write: () => { throw new Error('unexpected stderr'); } } },
  };
  const prefix = bootstrap.body.statements.slice(0, prefixEnd).map(node => node.getText(ast)).join('\n');
  const compiled = ts.transpileModule(`async function run(){${prefix}\nreturn {reachedClaimBoundary:true};}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const run = compileFunction(compiled.outputText + '\nreturn run;', Object.keys(dependencies))(...Object.values(dependencies));
  return { run, effects, calls: fake.calls };
}

test('Claude setup with a signed-out CLI stops before startup, claim or enrollment and never reports ready', async () => {
  const f = await bootstrapPrefix('claude', 'signed_out');
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'provider_preflight');
  assert.equal(result.code, 'provider_claude_login_required');
  assert.equal(result.grantRedeemed, false);
  assert.equal(result.enrollmentChanged, false);
  assert.notEqual(result.stage, 'complete');
  assert.deepEqual(f.effects, []);
});

test('Claude setup with a signed-in CLI continues to the claim boundary', async () => {
  const f = await bootstrapPrefix('claude', 'signed_in');
  assert.deepEqual(await f.run(), { reachedClaimBoundary: true });
  assert.deepEqual(f.effects, ['startup_preflight']);
  assert.deepEqual(f.calls, ['version', 'auth_status']);
});

test('Claude setup with no Claude Code CLI keeps the existing path', async () => {
  const f = await bootstrapPrefix('claude', 'not_installed');
  assert.deepEqual(await f.run(), { reachedClaimBoundary: true });
  assert.deepEqual(f.effects, ['startup_preflight']);
});

test('Codex setup never runs the Claude sign-in check', async () => {
  const f = await bootstrapPrefix('codex', 'signed_out');
  assert.deepEqual(await f.run(), { reachedClaimBoundary: true });
  assert.deepEqual(f.calls, []);
});
