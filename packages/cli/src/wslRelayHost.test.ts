import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test, {type TestContext} from 'node:test';
import {enableRelayAutostart, relayAutostartStatus, disableRelayAutostart, startRelayAutostart,
  assertRelayStartupOwnership} from './relayAutostart.js';
import {resolveWslRelayContext} from './wslRelayHost.js';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import {prepareCodexBootstrapHost, runCodexBootstrapHostScope} from './bootstrapHostScope.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dharma-wsl-host-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  const scripts: string[] = [];
  let exists = false;
  let running = false;
  let loseRegistrationResponse = false;
  const options = {platform: 'linux' as const, home: join(root, 'device'), userHome: root,
    workspace: '/fixtures/repo', launcher: '/fixtures/repo/.dharma/bin/dharma',
    policy: '/fixtures/repo/.dharma/approved-policy.json', version: '0.2.198',
    run: async () => ({stdout: 'enabled\n'}),
    wslHost: {
      context: async () => ({distribution: 'Ubuntu', linuxUser: 'maatru'}),
      run: async (script: string) => {
        scripts.push(script);
        if (script.includes('dharma-wsl-host:identity')) return {stdout: JSON.stringify({
          sid: 'S-1-5-21-123-456-789-1001', executable: 'C:\\Windows\\System32\\wsl.exe'})};
        if (script.includes('dharma-wsl-host:register')) {
          exists = true;
          if (loseRegistrationResponse) throw new Error('registration response lost');
        }
        if (script.includes('dharma-wsl-host:start')) running = true;
        if (script.includes('dharma-wsl-host:disable')) {exists = false; running = false;}
        return {stdout: JSON.stringify({exists, enabled: exists, running})};
      },
    },
  };
  return {options, scripts, foreignTask: () => {exists = true;}, loseResponse: () => {loseRegistrationResponse = true;}};
}

test('WSL startup registers an exact user-logon host action instead of relying on systemd lifetime', async t => {
  const {options, scripts} = await fixture(t);
  await enableRelayAutostart(options);
  assert(scripts.some(script => script.includes('dharma-wsl-host:register')),
    'an enabled Linux service alone cannot keep the WSL distro alive');
  const receipt = await readFile(join(options.home, 'relay', 'wsl-host.json'), 'utf8');
  assert.doesNotMatch(receipt, /password|token|grant|credential/i);
  const action = scripts.find(script => script.includes('dharma-wsl-host:register'))!;
  assert.match(action, /start --wait dharma-agent-fabric\.service/);
  assert.match(action, /-LogonType Interactive -RunLevel Limited/);
  assert.doesNotMatch(action, /-Force|ExecutionPolicy|wsl.*--shutdown|sleep infinity/);
  const status = await relayAutostartStatus(options);
  assert.equal(status.state, 'enabled');
  assert.equal(Reflect.get(status, 'restartCoverage'), 'wsl-host-logon');
  assert.equal(Reflect.get(status, 'hostLifecycle'), 'registered');
  await startRelayAutostart(options);
  assert.equal(Reflect.get(await relayAutostartStatus(options), 'hostLifecycle'), 'running');
  const registrationCalls = scripts.filter(script => script.includes('dharma-wsl-host:register')).length;
  await enableRelayAutostart(options);
  assert.equal(scripts.filter(script => script.includes('dharma-wsl-host:register')).length, registrationCalls);
  await disableRelayAutostart(options);
  assert(scripts.some(script => script.includes('dharma-wsl-host:disable')));
  await assert.rejects(readFile(join(options.home, 'relay', 'wsl-host.json')), {code: 'ENOENT'});
});

test('a foreign WSL host task is refused before startup registration writes', async t => {
  const f = await fixture(t);
  f.foreignTask();
  await assert.rejects(assertRelayStartupOwnership(f.options), /autostart_conflict/);
  await assert.rejects(enableRelayAutostart(f.options), /autostart_conflict/);
  assert(!f.scripts.some(script => script.includes('dharma-wsl-host:register')));
  await assert.rejects(readFile(join(f.options.home, 'relay', 'autostart.json')), {code: 'ENOENT'});
});

test('a lost registration response preserves ownership and readback reconciles without replacement', async t => {
  const f = await fixture(t);
  f.loseResponse();
  await assert.rejects(enableRelayAutostart(f.options), /wsl_host_startup_unavailable/);
  assert.equal((await relayAutostartStatus(f.options)).state, 'enabled');
  const before = f.scripts.filter(script => script.includes('dharma-wsl-host:register')).length;
  await enableRelayAutostart(f.options);
  assert.equal(f.scripts.filter(script => script.includes('dharma-wsl-host:register')).length, before);
});

test('changed WSL recipient and injected host fields cannot be adopted, started or disabled', async t => {
  const f = await fixture(t);
  await enableRelayAutostart(f.options);
  const path = join(f.options.home, 'relay', 'wsl-host.json');
  const original = await readFile(path, 'utf8');
  const record = JSON.parse(original);
  for (const delta of [{windowsSid: 'S-1-5-21-123-456-789-9001'}, {arguments: 'arbitrary.exe'},
    {distribution: 'foreign'}, {extra: 'CANARY_PRIVATE_MATERIAL'}]) {
    await writeFile(path, JSON.stringify({...record, ...delta}));
    f.scripts.length = 0;
    assert.equal((await relayAutostartStatus(f.options)).state, 'unavailable');
    await assert.rejects(startRelayAutostart(f.options), /autostart_conflict|unavailable/);
    await assert.rejects(disableRelayAutostart(f.options), /autostart_conflict|unavailable/);
    assert(!f.scripts.some(script => /dharma-wsl-host:(register|start|disable)/.test(script)));
  }
});

test('unavailable WSL interop and malformed distro metadata fail before startup writes', async t => {
  const f = await fixture(t);
  const badContexts = [{distribution: 'Ubuntu"; cmd', linuxUser: 'maatru'},
    {distribution: 'Ubuntu\n', linuxUser: 'maatru'}, {distribution: 'Ubuntu', linuxUser: 'maatru;cmd'}];
  for (const current of badContexts) {
    await assert.rejects(enableRelayAutostart({...f.options, wslHost: {...f.options.wslHost,
      context: async () => current}}), /wsl_host_startup_unavailable/);
  }
  await assert.rejects(enableRelayAutostart({...f.options, wslHost: {...f.options.wslHost,
    run: async () => {throw new Error('interop unavailable');}}}), /wsl_host_startup_unavailable/);
  await assert.rejects(readFile(join(f.options.home, 'relay', 'autostart.json')), {code: 'ENOENT'});
  assert.deepEqual(f.scripts, []);
});

test('WSL cannot report complete startup coverage after its host receipt is lost', async t => {
  const {options} = await fixture(t);
  await enableRelayAutostart(options);
  await rm(join(options.home, 'relay', 'wsl-host.json'), {force: true});
  const status = await relayAutostartStatus(options);
  assert.equal(status.state, 'unavailable');
  assert.equal(status.reason, 'wsl_host_startup_unavailable');
});

test('bare Linux startup does not query or register any Windows host task', async t => {
  const {options, scripts} = await fixture(t);
  const bare = {...options, wslHost: {...options.wslHost, context: async () => null}};
  await enableRelayAutostart(bare);
  assert.equal((await relayAutostartStatus(bare)).state, 'enabled');
  assert.deepEqual(scripts, []);
});

test('injected OS controls also contain Windows interop instead of escaping through a real runner', async t => {
  const f = await fixture(t);
  const seen: string[] = [];
  const options = {...f.options, wslHost: {context: f.options.wslHost.context},
    run: async (file: string, args: string[]) => {
      seen.push(file);
      if (file === 'systemctl') return {stdout: 'enabled\n'};
      assert.equal(file, '/init');
      return f.options.wslHost.run(Buffer.from(args.at(-1)!, 'base64').toString('utf16le'));
    }};
  await enableRelayAutostart(options);
  assert(seen.includes('/init'));
});

test('withdrawal during WSL registration preserves the receipt but admits no later OS action', async t => {
  const f = await fixture(t), controller = new AbortController(), now = Date.now();
  const prepared = prepareCodexBootstrapHost({workspace: f.options.userHome, signal: controller.signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: '11111111-1111-4111-8111-111111111111',
      setupReference: '22222222-2222-4222-8222-222222222222', organizationId: 'org_demo',
      recipientMembershipId: '33333333-3333-4333-8333-333333333333', origin: 'https://hq.example',
      repositoryFingerprint: `sha256:${'a'.repeat(64)}`, policyRevision: 'policy-v1',
      scopeDigest: `sha256:${'a'.repeat(64)}`, contractDigest: `sha256:${'b'.repeat(64)}`,
      hostContextId: '44444444-4444-4444-8444-444444444444', issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 60000).toISOString()}});
  t.after(() => prepared.scope.close());
  const options = {...f.options, wslHost: {...f.options.wslHost, run: async (script: string) => {
    const result = await f.options.wslHost.run(script);
    if (script.includes('dharma-wsl-host:register')) controller.abort();
    return result;
  }}};
  await assert.rejects(runCodexBootstrapHostScope(prepared.scope, () => enableRelayAutostart(options)), /scope_unavailable/);
  assert(f.scripts.at(-1)?.includes('dharma-wsl-host:register'));
  assert.equal(JSON.parse(await readFile(join(options.home, 'relay', 'wsl-host.json'), 'utf8')).schema, 'dharma.wsl-relay-host/v1');
});

test('WSL systemd startup resolves missing session metadata only from its owned binding', () => {
  const installed = {schema: 'dharma.wsl-relay-host/v1', distribution: 'Ubuntu', linuxUser: 'maatru'};
  assert.deepEqual(resolveWslRelayContext(undefined, 'maatru', installed), {distribution: 'Ubuntu', linuxUser: 'maatru'});
  for (const value of [null, {}, {...installed, linuxUser: 'other'}, {...installed, distribution: 'Ubuntu\n'}]) {
    assert.throws(() => resolveWslRelayContext(undefined, 'maatru', value), /wsl_host_startup_unavailable/);
  }
});

test('WSL host receipt schema excludes secrets and unbounded command authority', async t => {
  const f = await fixture(t);
  await enableRelayAutostart(f.options);
  const record = JSON.parse(await readFile(join(f.options.home, 'relay', 'wsl-host.json'), 'utf8'));
  const schema = 'https://schemas.dharma-ai.io/wsl-relay-host/v1';
  const validate = (value: unknown) => validateContract(join(import.meta.dirname, 'schemas'), schema, value);
  assert.equal((await validate(record)).ok, true);
  for (const delta of [{token: 'CANARY_NEVER_ALLOWED'}, {password: 'CANARY_NEVER_ALLOWED'},
    {arguments: 'arbitrary.exe'}, {windowsSid: '*'}, {linuxUser: 'user;cmd'}]) {
    assert.equal((await validate({...record, ...delta})).ok, false);
  }
});

test('generated WSL host commands pass the actual Windows PowerShell parser without execution', {skip: process.platform !== 'win32'}, async t => {
  const f = await fixture(t);
  await enableRelayAutostart(f.options);
  await startRelayAutostart(f.options);
  await disableRelayAutostart(f.options);
  const script = `$items=ConvertFrom-Json ([Console]::In.ReadToEnd()); `
    + `foreach($item in $items) {$tokens=$null;$errors=$null; `
    + `[System.Management.Automation.Language.Parser]::ParseInput($item,[ref]$tokens,[ref]$errors)|Out-Null; `
    + `if ($errors.Count -gt 0) {[Console]::Error.Write('generated_wsl_host_parse_error');exit 1}}; `
    + `[Console]::Out.Write($items.Count)`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], {input: JSON.stringify(f.scripts), encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 16384});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Number(result.stdout), f.scripts.length);
});
