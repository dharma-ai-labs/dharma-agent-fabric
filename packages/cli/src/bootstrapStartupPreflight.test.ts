import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileFunction } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

// Execute the actual bootstrap prefix through the first claim-installation
// boundary. Synthetic dependencies never enroll, access credentials or start a relay.
async function fixture(mode = 'reference', failure?: Error, withdraw = false, anchorFailure?: string) {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const bootstrap = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'bootstrap');
  assert.ok(bootstrap && ts.isFunctionDeclaration(bootstrap) && bootstrap.body);
  const prefixEnd = bootstrap.body.statements.findIndex(node => node.getText(ast).startsWith('let config: DeviceConfig'));
  assert.ok(prefixEnd > 0);
  const effects: string[] = [];
  let withdrawn = false;
  const flags = new Map<string, string | boolean>([
    ['organization-id', 'org_demo'], ['complete', true], ['provider', 'codex'], ['policy-revision', 'policy-v1'],
    ['setup-reference', '11111111-1111-4111-8111-111111111111'],
    ['setup-recipient-membership-id', '22222222-2222-4222-8222-222222222222'],
    ['setup-scope-digest', `sha256:${'a'.repeat(64)}`], ['setup-contract-digest', `sha256:${'b'.repeat(64)}`],
  ]);
  const hostScope = { assert: async () => {
    if (withdrawn) throw new Error('codex_setup_host_scope_unavailable');
  }, step: async (run: () => Promise<unknown>) => {
    if (withdrawn) throw new Error('codex_setup_host_scope_unavailable');
    const value = await run();
    if (withdrawn) throw new Error('codex_setup_host_scope_unavailable');
    return value;
  } };
  const dependencies = {
    VERSION: '0.2.174',
    flags, hostScope, portalUrl: () => 'https://hq.example', normalizeHqUrl: (url: string) => url,
    required: (input: typeof flags, key: string) => input.get(key), bootstrapGrantMode: () => mode,
    UUID_PATTERN: /^[a-f0-9-]{36}$/,
    loadAgentFabricOnboardingContract: async () => ({ sha256: 'b'.repeat(64) }),
    originalCodexSetupSessionSender: async () => ({}), dharmaHome: () => '/fixture/device',
    realpath: async () => '/fixture/repository', preflightBootstrapWorkspaceIdentity: async () => ({ fingerprint: 'source' }),
    assertBootstrapHostSource: async () => {}, isLocalProviderId: () => true,
    readDeviceConfig: async () => anchorFailure ? { organizationId: 'org_demo', deviceId: 'device', hqUrl: 'https://hq.example' } : null,
    assertRelayStartupOwnership: async (options: { home: string; version: string }) => {
      assert.equal(options.home, '/fixture/device');
      assert.equal(options.version, '0.2.174');
      effects.push('startup_preflight');
      if (failure) throw failure;
      if (withdraw) withdrawn = true;
    },
    readPrivateBootstrapGrant: async () => { effects.push('private_input'); return 'fixture'; },
    process: { stderr: { write: () => { throw new Error('unexpected stderr'); } } },
  };
  const anchor = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'assertBootstrapStartupAnchor');
  const anchorDependencies = {
    ...dependencies,
    relayAutostartStatus: async () => anchorFailure === 'manager-unavailable'
      ? { state: 'unavailable', backend: 'systemd-user', reason: 'systemd_user_unavailable' }
      : anchorFailure === 'legacy' ? { state: 'unavailable', backend: 'systemd-user', reason: 'autostart_conflict' }
      : anchorFailure ? { state: 'enabled', backend: 'systemd-user' } : { state: 'disabled', backend: null },
    inspectOwnedRelayAutostart: async () => ({ workspace: '/fixture/anchor',
      policy: '/fixture/anchor/.dharma/approved-policy.json', version: '0.2.174' }),
    registry: async () => [{ workspaceId: 'anchor', organizationId: 'org_demo', path: '/fixture/anchor',
      routeHash: 'route', repositoryRemoteHash: 'remote' }],
    selectDeviceWorkspace: () => anchorFailure === 'missing-workspace' ? null
      : { routeHash: 'route', repositoryRemoteHash: 'remote' },
    resolve: (...parts: string[]) => parts.join('/'),
    loadOrganizationPolicy: async () => {
      if (anchorFailure === 'missing-policy') throw new Error('private policy path unreadable');
      return { serverAuthorization: { workspaceId: anchorFailure === 'foreign-route' ? 'foreign' : 'anchor' } };
    },
    loadVerifiedWorkspacePolicy: async () => {
      if (anchorFailure === 'invalid-policy') throw new Error('private policy authorization invalid');
      return {};
    },
  };
  const anchorBody = ts.transpileModule(anchor?.getText(ast) ?? 'async function assertBootstrapStartupAnchor() {}', {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const assertBootstrapStartupAnchor = compileFunction(anchorBody + '\nreturn assertBootstrapStartupAnchor;',
    Object.keys(anchorDependencies))(...Object.values(anchorDependencies));
  const prefix = bootstrap.body.statements.slice(0, prefixEnd).map(node => node.getText(ast)).join('\n');
  const compiled = ts.transpileModule(`async function run(){${prefix}\nreturn {reachedClaimBoundary:true};}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true,
  });
  assert.equal(compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
  const allDependencies = { ...dependencies, assertBootstrapStartupAnchor };
  const run = compileFunction(compiled.outputText + '\nreturn run;', Object.keys(allDependencies))(...Object.values(allDependencies));
  return { run, effects };
}

test('source-connected bootstrap rejects startup collision before claim installation or credential effects', async () => {
  const f = await fixture('reference', new Error('autostart_conflict: private path must not leak'));
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'startup_preflight');
  assert.equal(result.code, 'autostart_conflict');
  assert.equal(result.grantRedeemed, false);
  assert.equal(result.enrollmentChanged, false);
  assert.equal(JSON.stringify(result).includes('private path'), false);
  assert.deepEqual(f.effects, ['startup_preflight']);
});

test('source-connected bootstrap checks startup before reaching claim installation', async () => {
  const f = await fixture();
  assert.deepEqual(await f.run(), { reachedClaimBoundary: true });
  assert.deepEqual(f.effects, ['startup_preflight']);
});

test('startup preflight read failure has a sanitized typed blocker rather than consuming setup authority', async () => {
  const f = await fixture('reference', new Error('private unreadable path'));
  const result = await f.run();
  assert.equal(result.code, 'startup_preflight_unavailable');
  assert.equal(result.grantRedeemed, false);
  assert.equal(JSON.stringify(result).includes('private unreadable path'), false);
});

test('startup version mismatch is an actionable preclaim blocker without authority consumption', async () => {
  const f = await fixture('reference', new Error('relay_runtime_upgrade_required: private path'));
  const result = await f.run();
  assert.equal(result.code, 'relay_runtime_upgrade_required');
  assert.equal(result.grantRedeemed, false);
  assert.equal(result.enrollmentChanged, false);
  assert.match(result.message, /upgrade/i);
  assert.equal(JSON.stringify(result).includes('private path'), false);
  assert.deepEqual(f.effects, ['startup_preflight']);
});

test('preflight preserves native host withdrawal instead of proceeding to claim installation', async () => {
  const f = await fixture('reference', undefined, true);
  await assert.rejects(f.run(), /codex_setup_host_scope_unavailable/);
});

test('legacy private-input bootstrap behavior is unchanged', async () => {
  const f = await fixture('prompt');
  assert.deepEqual(await f.run(), { reachedClaimBoundary: true });
  assert.deepEqual(f.effects, ['private_input']);
});

for (const kind of ['missing-workspace', 'missing-policy', 'foreign-route', 'invalid-policy']) {
  test(`source-connected bootstrap rejects ${kind} standard anchor before claim`, async () => {
    const f = await fixture('reference', undefined, false, kind);
    const result = await f.run();
    assert.equal(result.ok, false);
    assert.equal(result.stage, 'startup_preflight');
    assert.equal(result.grantRedeemed, false);
    assert.equal(result.enrollmentChanged, false);
    assert.equal(JSON.stringify(result).includes('private policy'), false);
    assert.deepEqual(f.effects, ['startup_preflight']);
  });
}

test('source-connected bootstrap admits an existing valid standard anchor before claim', async () => {
  const f = await fixture('reference', undefined, false, 'valid');
  assert.deepEqual(await f.run(), { reachedClaimBoundary: true });
  assert.deepEqual(f.effects, ['startup_preflight']);
});

test('source-connected bootstrap rejects unavailable startup manager before claim', async () => {
  const f = await fixture('reference', undefined, false, 'manager-unavailable');
  const result = await f.run();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'startup_preflight_unavailable');
  assert.equal(result.grantRedeemed, false);
  assert.equal(result.enrollmentChanged, false);
  assert.deepEqual(f.effects, ['startup_preflight']);
});

test('source-connected bootstrap retains exact owned legacy migration despite conflict status', async () => {
  const f = await fixture('reference', undefined, false, 'legacy');
  assert.deepEqual(await f.run(), { reachedClaimBoundary: true });
  assert.deepEqual(f.effects, ['startup_preflight']);
});
