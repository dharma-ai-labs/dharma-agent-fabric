import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { SANDBOX_FIX, type RegisteredCommandSandbox, type SandboxRefusalReason } from '@dharma-ai-labs/agent-fabric-task-runner';
import { commandExitCode, parseCliOptions, run } from './index.js';
import {
  HOST_SANDBOX_REFUSAL_REASONS,
  RELAY_SANDBOX_STATUS_SCHEMA,
  assertRelaySandboxStatusOptions,
  formatRelaySandboxStatus,
  readRelaySandboxStatus,
  relaySandboxStatusExitCode,
} from './relaySandboxStatus.js';

// `dharma relay sandbox status [--json]` runs the relay's own command-sandbox probe and prints
// the answer. It is read-only: it takes no other option, writes nothing outside the probe's own
// scratch folder (which it removes, with any folder it had to create for it) and changes no
// setting. A usable sandbox exits 0; a refusal exits 1 and names the typed reason and the fix.
// The probe is injected here, so these tests run on every operating system.

const USABLE: RegisteredCommandSandbox = {
  usable: true, host: 'linux', bwrapPath: '/usr/bin/bwrap', bwrapVersion: '0.9.0', bwrapSha256: `sha256:${'a'.repeat(64)}`,
  policy: 'bwrap-policy/2', layout: { bin: 'symlink', sbin: 'symlink', lib: 'symlink', lib32: 'absent', lib64: 'symlink', libx32: 'absent' },
  nodePrefix: '/home/relay/.local', bindNodePrefix: true, nodeMounts: [{ kind: 'bind', path: '/home/relay/.local/bin/node' }],
  disableUserns: true, probe: { checks: ['network_denied', 'home_hidden'], probedAt: '2026-11-28T00:00:00.000Z' },
};

function refusal(reason: SandboxRefusalReason): RegisteredCommandSandbox {
  return { usable: false, reason, detail: `synthetic detail for ${reason}`, fix: SANDBOX_FIX[reason] };
}

async function validator() {
  const schema = JSON.parse(await readFile(new URL('./schemas/relay-sandbox-status.v1.schema.json', import.meta.url), 'utf8'));
  return new Ajv2020({ strict: true, strictRequired: false }).compile(schema);
}

async function stateRoot(t: TestContext) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-sandbox-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const COMMAND = ['relay', 'sandbox', 'status'];

test('a usable sandbox prints the probed bubblewrap, policy, host and probe result, and exits 0', async (t) => {
  const relayStateDirectory = resolve(await stateRoot(t), 'relay');
  const calls: string[] = [];
  const status = await readRelaySandboxStatus({ relayStateDirectory,
    probe: async (options) => { calls.push(options.relayStateDirectory); return USABLE; } });
  assert.deepEqual(calls, [relayStateDirectory], 'the relay probe runs once, on the relay state directory');
  assert.deepEqual(status, { schema: RELAY_SANDBOX_STATUS_SCHEMA, usable: true, host: 'linux', bwrapPath: '/usr/bin/bwrap',
    bwrapVersion: '0.9.0', bwrapSha256: `sha256:${'a'.repeat(64)}`, policy: 'bwrap-policy/2',
    probe: { result: 'passed', checks: ['network_denied', 'home_hidden'], probedAt: '2026-11-28T00:00:00.000Z' } });
  // Paths under the relay user's home (the Node prefix and mounts) are not printed.
  assert.doesNotMatch(JSON.stringify(status), /home\/relay/);
  assert.equal(relaySandboxStatusExitCode(status), 0);
  assert.equal(commandExitCode([...COMMAND, '--json'], status), 0);
  const text = formatRelaySandboxStatus(status);
  assert.match(text, /^Command sandbox: usable\n/);
  assert.match(text, /\/usr\/bin\/bwrap 0\.9\.0/);
  assert.match(text, /bwrap-policy\/2/);
  assert.match(text, /passed 2 checks/);
  assert.equal(relaySandboxStatusExitCode(text), 0);
  assert.equal(commandExitCode(COMMAND, text), 0);
});

test('the refusal reasons a host probe can give are the sandbox reasons without the task-only network reason', () => {
  assert.deepEqual([...HOST_SANDBOX_REFUSAL_REASONS].sort(),
    Object.keys(SANDBOX_FIX).filter(reason => reason !== 'network_not_denied').sort());
});

for (const reason of HOST_SANDBOX_REFUSAL_REASONS) {
  test(`a refusal (${reason}) prints the typed reason, detail and fix, and exits 1`, async (t) => {
    const relayStateDirectory = resolve(await stateRoot(t), 'relay');
    const status = await readRelaySandboxStatus({ relayStateDirectory, probe: async () => refusal(reason) });
    assert.deepEqual(status, { schema: RELAY_SANDBOX_STATUS_SCHEMA, usable: false, reason,
      detail: `synthetic detail for ${reason}`, fix: SANDBOX_FIX[reason] });
    assert.equal(relaySandboxStatusExitCode(status), 1);
    assert.equal(commandExitCode([...COMMAND, '--json'], status), 1);
    const text = formatRelaySandboxStatus(status);
    assert.match(text, new RegExp(`^Command sandbox: refused \\(${reason}\\)\\n`));
    assert.ok(text.includes(SANDBOX_FIX[reason]), 'the fix line is printed');
    assert.ok(text.includes(`synthetic detail for ${reason}`), 'the detail is printed');
    assert.equal(relaySandboxStatusExitCode(text), 1);
    assert.equal(commandExitCode(COMMAND, text), 1);
  });
}

test('the --json output is one parser-safe value that matches its schema and nothing else', async (t) => {
  const validate = await validator();
  const relayStateDirectory = resolve(await stateRoot(t), 'relay');
  const outputs = [await readRelaySandboxStatus({ relayStateDirectory, probe: async () => USABLE })];
  for (const reason of HOST_SANDBOX_REFUSAL_REASONS) {
    outputs.push(await readRelaySandboxStatus({ relayStateDirectory, probe: async () => refusal(reason) }));
  }
  for (const output of outputs) {
    assert.equal(validate(output), true, JSON.stringify(validate.errors));
    assert.deepEqual(JSON.parse(JSON.stringify(output)), output);
  }
  const usable = outputs[0]!;
  const refused = outputs[1]!;
  assert.deepEqual(Object.keys(usable).sort(), ['bwrapPath', 'bwrapSha256', 'bwrapVersion', 'host', 'policy', 'probe', 'schema', 'usable']);
  assert.deepEqual(Object.keys(refused).sort(), ['detail', 'fix', 'reason', 'schema', 'usable']);
  for (const change of [{ usable: false }, { reason: 'network_not_denied' }, { nodePrefix: '/home/relay/.local' },
    { secret: 'CANARY_PRIVATE_INPUT' }, { schema: 'dharma.relay-sandbox-status/v2' }, { bwrapPath: 'bwrap' },
    { bwrapSha256: 'sha256:short' }, { probe: { result: 'failed', checks: ['network_denied'], probedAt: '2026-11-28T00:00:00.000Z' } }]) {
    assert.equal(validate({ ...usable, ...change }), false, JSON.stringify(change));
  }
  for (const change of [{ usable: true }, { reason: 'network_not_denied' }, { reason: 'unknown' }, { detail: 'x'.repeat(2001) },
    { bwrapPath: '/usr/bin/bwrap' }]) {
    assert.equal(validate({ ...refused, ...change }), false, JSON.stringify(change));
  }
});

test('the exit code is 1 for anything that is not a usable status', () => {
  for (const value of [undefined, null, '', 'Command sandbox: usable', 'usable', { usable: true }, [],
    { schema: RELAY_SANDBOX_STATUS_SCHEMA, usable: 'true' }]) {
    assert.equal(relaySandboxStatusExitCode(value), 1, JSON.stringify(value));
  }
  // Help and version keep exit code 0.
  assert.equal(commandExitCode([...COMMAND, '--help'], 'usage'), 0);
});

test('the command is read-only: the folders it had to create for the probe are removed and existing ones are kept', async (t) => {
  const root = await stateRoot(t);
  // A fresh host: no Dharma home yet. The probe creates its scratch folder under the relay state
  // directory, as the relay's probe does, and removes only its own subfolder.
  const freshRelay = resolve(root, 'fresh', '.dharma', 'relay');
  await readRelaySandboxStatus({ relayStateDirectory: freshRelay, probe: async ({ relayStateDirectory }) => {
    const scratch = resolve(relayStateDirectory, 'sandbox-probe', 'probe-run');
    await mkdir(scratch, { recursive: true });
    await rm(scratch, { recursive: true });
    return USABLE;
  } });
  assert.deepEqual(await readdir(root), ['fresh']);
  assert.deepEqual(await readdir(resolve(root, 'fresh')), [], 'no Dharma home is left behind');

  // An enrolled host: the relay state directory and its files stay as they were.
  const relay = resolve(root, 'enrolled', '.dharma', 'relay');
  await mkdir(relay, { recursive: true });
  await writeFile(resolve(relay, 'protocol-state.json'), '{}');
  await readRelaySandboxStatus({ relayStateDirectory: relay, probe: async ({ relayStateDirectory }) => {
    await mkdir(resolve(relayStateDirectory, 'sandbox-probe', 'probe-run'), { recursive: true });
    await rm(resolve(relayStateDirectory, 'sandbox-probe', 'probe-run'), { recursive: true });
    return refusal('bubblewrap_missing');
  } });
  assert.deepEqual(await readdir(relay), ['protocol-state.json']);
  assert.equal(await readFile(resolve(relay, 'protocol-state.json'), 'utf8'), '{}');

  // A folder someone else filled during the probe is not removed.
  const busy = resolve(root, 'busy', 'relay');
  await readRelaySandboxStatus({ relayStateDirectory: busy, probe: async ({ relayStateDirectory }) => {
    await mkdir(resolve(relayStateDirectory, 'sandbox-probe'), { recursive: true });
    await writeFile(resolve(relayStateDirectory, 'protocol-state.json'), '{}');
    return USABLE;
  } });
  assert.deepEqual(await readdir(busy), ['protocol-state.json']);
});

test('the command takes only --json; any other option or argument is refused before the probe runs', () => {
  const accept = (args: string[]) => {
    const { positional, flags, repeated } = parseCliOptions(args);
    assertRelaySandboxStatusOptions(positional, flags, repeated);
  };
  accept(COMMAND);
  accept([...COMMAND, '--json']);
  for (const args of [[...COMMAND, 'extra'], [...COMMAND, '--apply'], [...COMMAND, '--dry-run'], [...COMMAND, '--json=false'],
    [...COMMAND, '--json', '--json'], [...COMMAND, '--policy', 'approved-policy.json'], [...COMMAND, '--fix']]) {
    assert.throws(() => accept(args), /relay_sandbox_status_options_invalid/, args.join(' '));
  }
});

test('the CLI routes relay sandbox status to this command and refuses unknown sandbox subcommands', async () => {
  await assert.rejects(run([...COMMAND, '--apply']), /relay_sandbox_status_options_invalid/);
  await assert.rejects(run([...COMMAND, 'extra']), /relay_sandbox_status_options_invalid/);
  await assert.rejects(run(['relay', 'sandbox', 'enable']), /Use dharma relay sandbox status/);
  await assert.rejects(run(['relay', 'sandbox']), /Use dharma relay sandbox status/);
});

