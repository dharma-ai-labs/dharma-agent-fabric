import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, mkdir, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, resolve} from 'node:path';
import {promisify} from 'node:util';
import test from 'node:test';

const execute = promisify(execFile), sourceRoot = resolve(import.meta.dirname, '..');
const baseline = process.env.DHARMA_PACK_VERIFIER_BASELINE_SHA;
if (baseline && !/^[a-f0-9]{40}$/.test(baseline)) throw new Error('verifier_baseline_invalid');
const verifier = baseline
  ? (await execute('git', ['show', `${baseline}:scripts/verify-package.mjs`], {cwd: sourceRoot, windowsHide: true})).stdout
  : await readFile(new URL('./verify-package.mjs', import.meta.url));
const workspaces = ['contracts', 'secure-store', 'policy', 'provider-adapters', 'better-harness-bridge',
  'evidence-reduction', 'relay-client', 'local-vault', 'task-runner', 'skill-manager', 'sdk', 'cli'];
const required = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'LICENSES/Qoder-Better-Harness-MIT.txt',
  '.agents/plugins/marketplace.json', 'plugins/dharma-agent-fabric/.codex-plugin/plugin.json',
  'plugins/dharma-agent-fabric/.mcp.json', 'plugins/dharma-agent-fabric/skills/dharma-agent-fabric/SKILL.md',
  'packages/cli/dist/index.js', 'packages/provider-adapters/dist/knowledge-server.js',
  ...['trajectory-capsule', 'evidence-request', 'evidence-response'].map(name => `packages/cli/dist/schemas/${name}.schema.json`)];

for (const suffix of ['contracts', 'evidence-reduction', 'local-vault', 'policy', 'provider-adapters', 'relay-client', 'sdk', 'secure-store', 'skill-manager', 'task-runner', 'unknown']) {
  for (const defect of suffix === 'unknown' ? ['undeclared'] : ['missing', 'range']) {
    test(`official pack verifier rejects CLI ${suffix} ${defect} before invoking npm`, async () => {
      const parent = await realpath(tmpdir()), root = await mkdtemp(resolve(parent, 'dharma-cli-pins-'));
      try {
        for (const path of required) {
          await mkdir(dirname(resolve(root, path)), {recursive: true});
          await writeFile(resolve(root, path), path === 'THIRD_PARTY_NOTICES.md' ? 'Better Harness MIT' : 'synthetic');
        }
        for (const workspace of workspaces) {
          const manifest = JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
          if (workspace === 'cli') {
            const name = `@dharma-ai-labs/agent-fabric-${suffix}`;
            if (defect === 'undeclared') manifest.dependencies[name] = '0.0.1';
            else if (defect === 'missing') delete manifest.dependencies[name];
            else manifest.dependencies[name] = `^${manifest.dependencies[name]}`;
          }
          const path = resolve(root, 'packages', workspace, 'package.json');
          await mkdir(dirname(path), {recursive: true}); await writeFile(path, JSON.stringify(manifest));
        }
        await mkdir(resolve(root, 'scripts'), {recursive: true});
        await writeFile(resolve(root, 'scripts/verify.mjs'), verifier);
        await assert.rejects(execute(process.execPath, [resolve(root, 'scripts/verify.mjs')], {
          cwd: root, timeout: 10_000, env: {...process.env, npm_execpath: resolve(root, 'must-not-execute.mjs')}, windowsHide: true,
        }), error => error.code === 1 && error.stdout === ''
          && error.stderr.includes(suffix === 'unknown' ? 'cli_runtime_package_unknown' : `cli_runtime_package_pin_invalid:${suffix}`)
          && !error.stderr.includes('MODULE_NOT_FOUND'));
      } finally {
        assert.equal(dirname(root), parent); assert.ok(root.startsWith(resolve(parent, 'dharma-cli-pins-')));
        await rm(root, {recursive: true, force: true});
      }
    });
  }
}

test('CLI pins a relay client published with setupClaimFailureMessage', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const relay = await manifest('relay-client'), cli = await manifest('cli');
  // 0.2.36 is on npm without this export. CI links the workspace copy, but a published CLI
  // pinned to 0.2.36 would stop at module load on every command, not only setup.
  assert.ok(relay.version.localeCompare('0.2.37', undefined, {numeric: true}) >= 0, `relay-client ${relay.version} is published without the export`);
  assert.equal(cli.dependencies[relay.name], relay.version);
});

test('CLI pins runtime packages published with providerLaunch and requiredSkillFiles', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const [cli, provider, runner, evidence, vault, lifecycle] = await Promise.all(
    ['cli', 'provider-adapters', 'task-runner', 'evidence-reduction', 'local-vault', 'lifecycle-adapter'].map(manifest));
  const atLeast = (version, floor) => version.localeCompare(floor, undefined, {numeric: true}) >= 0;
  // provider-adapters 0.1.39 is on npm without providerLaunch, so a published CLI pinned to it
  // would stop at module load. task-runner 0.1.41 would silently ignore requiredSkillFiles.
  assert.ok(atLeast(provider.version, '0.1.40'), `provider-adapters ${provider.version} is published without providerLaunch`);
  assert.ok(atLeast(runner.version, '0.1.42'), `task-runner ${runner.version} is published without requiredSkillFiles`);
  assert.equal(cli.dependencies[provider.name], provider.version);
  assert.equal(cli.dependencies[runner.name], runner.version);
  // One provider-adapters copy in the install: the packages that pin it move with it.
  assert.equal(runner.dependencies[provider.name], provider.version);
  assert.equal(evidence.dependencies[provider.name], provider.version);
  assert.equal(vault.dependencies[evidence.name], evidence.version);
  assert.equal(lifecycle.dependencies[evidence.name], evidence.version);
  assert.equal(cli.dependencies[evidence.name], evidence.version);
  assert.equal(cli.dependencies[vault.name], vault.version);
});

test('CLI pins provider-adapters published with providerCapabilityWithoutExecutable', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const [cli, provider] = await Promise.all(['cli', 'provider-adapters'].map(manifest));
  // #427's relay provider guard imports providerCapabilityWithoutExecutable. provider-adapters 0.1.40 is on npm
  // without it, so a published CLI pinned to 0.1.40 would stop at module load.
  assert.ok(provider.version.localeCompare('0.1.41', undefined, {numeric: true}) >= 0,
    `provider-adapters ${provider.version} is published without providerCapabilityWithoutExecutable`);
  assert.equal(cli.dependencies[provider.name], provider.version);
});

test('CLI pins contracts, task-runner and local-vault published with the 0.2.225 exports', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const [cli, contracts, runner, vault] = await Promise.all(['cli', 'contracts', 'task-runner', 'local-vault'].map(manifest));
  const atLeast = (version, floor) => version.localeCompare(floor, undefined, {numeric: true}) >= 0;
  // Each of these is on npm without an export the 0.2.225 CLI uses, so a published CLI pinned to it
  // would fail at module load or at the call: contracts 0.1.18 lacks the session-message/v1 helpers (#445), task-runner
  // 0.1.43 lacks registeredCommandEnvironment and acceptanceCommandEnvironmentPolicy (#487, #489), and
  // local-vault 0.1.37 lacks countProviderSessionTaskExports (#472).
  assert.ok(atLeast(contracts.version, '0.1.19'), `contracts ${contracts.version} is published without the session-message helpers`);
  assert.ok(atLeast(runner.version, '0.1.44'), `task-runner ${runner.version} is published without the command environment exports`);
  assert.ok(atLeast(vault.version, '0.1.38'), `local-vault ${vault.version} is published without countProviderSessionTaskExports`);
  assert.equal(cli.dependencies[contracts.name], contracts.version);
  assert.equal(cli.dependencies[runner.name], runner.version);
  assert.equal(cli.dependencies[vault.name], vault.version);
});

test('CLI pins a relay client published with serverCode and relay_response_timeout', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const relay = await manifest('relay-client'), cli = await manifest('cli');
  // 0.2.37 and 0.2.38 are on npm without AgentFabricRequestError.serverCode and the
  // relay_response_timeout code. The CLI loads relay-client from npm, so an installed CLI
  // reports these #513 diagnostics only when it pins a later relay-client.
  assert.ok(relay.version.localeCompare('0.2.39', undefined, {numeric: true}) >= 0, `relay-client ${relay.version} is published without serverCode`);
  assert.equal(cli.dependencies[relay.name], relay.version);
});

test('CLI pins a relay client published with the relay_connect_timeout limit', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const relay = await manifest('relay-client'), cli = await manifest('cli');
  // 0.2.39 and earlier hold device signing control for up to 90 s while a relay connection never
  // opens. #512 bounds that connect phase at 30 s with the relay_connect_timeout code; an installed
  // CLI gets the shorter hold only when it pins a later relay-client.
  assert.ok(relay.version.localeCompare('0.2.40', undefined, {numeric: true}) >= 0, `relay-client ${relay.version} has no connect limit`);
  assert.equal(cli.dependencies[relay.name], relay.version);
});

test('CLI pins provider-adapters, evidence-reduction, task-runner and local-vault published with hidden child windows', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const [cli, provider, evidence, runner, vault] = await Promise.all(
    ['cli', 'provider-adapters', 'evidence-reduction', 'task-runner', 'local-vault'].map(manifest));
  const atLeast = (version, floor) => version.localeCompare(floor, undefined, {numeric: true}) >= 0;
  // provider-adapters 0.1.41 is on npm with version and sign-in probes and a process run that start
  // their children without windowsHide (#531), so on Windows each opens a console window. The CLI
  // loads provider-adapters from npm, directly and through evidence-reduction, task-runner and
  // local-vault, so each of those pins the later provider-adapters and the CLI pins them all.
  assert.ok(atLeast(provider.version, '0.1.42'), `provider-adapters ${provider.version} is published without windowsHide`);
  assert.equal(evidence.dependencies[provider.name], provider.version);
  assert.equal(runner.dependencies[provider.name], provider.version);
  assert.equal(vault.dependencies[evidence.name], evidence.version);
  for (const runtime of [provider, evidence, runner, vault]) assert.equal(cli.dependencies[runtime.name], runtime.version);
});

test('CLI pins a relay client published with setup claim clock-skew correction', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const relay = await manifest('relay-client'), cli = await manifest('cli');
  // 0.2.40 is on npm with a setup claim that fails as response_invalid when this machine's clock is more
  // than 5 s behind the server, and without the clock_skew reason. #542 corrects up to 45 s and reports
  // clock_skew with clockOffsetSeconds beyond that; an installed CLI gets it only when it pins a later relay-client.
  assert.ok(relay.version.localeCompare('0.2.41', undefined, {numeric: true}) >= 0, `relay-client ${relay.version} has no clock-skew correction`);
  assert.equal(cli.dependencies[relay.name], relay.version);
});

test('CLI pins provider-adapters, evidence-reduction, task-runner and local-vault published with executable-aware Codex and Claude capability', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const [cli, provider, evidence, runner, vault] = await Promise.all(
    ['cli', 'provider-adapters', 'evidence-reduction', 'task-runner', 'local-vault'].map(manifest));
  const atLeast = (version, floor) => version.localeCompare(floor, undefined, {numeric: true}) >= 0;
  // provider-adapters 0.1.42 is on npm with Codex and Claude adapters that report evidence available when no
  // executable is installed, so the platform registers an active endpoint for them on such a host.
  // #544 reports nothing available without the executable. The CLI loads provider-adapters from npm,
  // directly and through evidence-reduction, task-runner and local-vault, so each of those pins the
  // later provider-adapters and the CLI pins them all.
  assert.ok(atLeast(provider.version, '0.1.43'), `provider-adapters ${provider.version} reports Codex and Claude capability without an executable`);
  assert.equal(evidence.dependencies[provider.name], provider.version);
  assert.equal(runner.dependencies[provider.name], provider.version);
  assert.equal(vault.dependencies[evidence.name], evidence.version);
  for (const runtime of [provider, evidence, runner, vault]) assert.equal(cli.dependencies[runtime.name], runtime.version);
});

test('CLI pins provider-adapters, evidence-reduction, task-runner and local-vault published with Claude tools limited to the task authority', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const [cli, provider, evidence, runner, vault] = await Promise.all(
    ['cli', 'provider-adapters', 'evidence-reduction', 'task-runner', 'local-vault'].map(manifest));
  const atLeast = (version, floor) => version.localeCompare(floor, undefined, {numeric: true}) >= 0;
  // provider-adapters 0.1.43 is on npm with a Claude task argv that keeps Edit and Write available and
  // auto-approved (acceptEdits, no --tools) for a read-only signed task. #508 passes --tools with only
  // the authorized tools and runs read-only tasks with dontAsk. The CLI loads provider-adapters from npm,
  // directly and through evidence-reduction, task-runner and local-vault, so each of those pins the
  // later provider-adapters and the CLI pins them all.
  assert.ok(atLeast(provider.version, '0.1.44'), `provider-adapters ${provider.version} lets read-only Claude tasks edit`);
  assert.equal(evidence.dependencies[provider.name], provider.version);
  assert.equal(runner.dependencies[provider.name], provider.version);
  assert.equal(vault.dependencies[evidence.name], evidence.version);
  for (const runtime of [provider, evidence, runner, vault]) assert.equal(cli.dependencies[runtime.name], runtime.version);
});

test('CLI pins a relay client published with the Linux credential store setup failure', async () => {
  const manifest = async workspace => JSON.parse(await readFile(resolve(sourceRoot, 'packages', workspace, 'package.json'), 'utf8'));
  const relay = await manifest('relay-client'), cli = await manifest('cli');
  // 0.2.41 is on npm with a setup claim that reports a failed Linux Secret Service probe at store_preflight
  // without a reason or fix. #551 reports credential_store_unavailable with the keyring fix; an installed
  // CLI gets it only when it pins a later relay-client.
  assert.ok(relay.version.localeCompare('0.2.42', undefined, {numeric: true}) >= 0, `relay-client ${relay.version} has no credential_store_unavailable reason`);
  assert.equal(cli.dependencies[relay.name], relay.version);
});
