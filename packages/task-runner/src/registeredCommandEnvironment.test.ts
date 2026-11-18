import assert from 'node:assert/strict';
import test from 'node:test';
import * as taskRunner from './index.js';

// Synthetic values only. A command that runs outside a task (for example a skill
// smoke check) gets operating-system essentials and the names its registered
// policy entry lists under `environment.inherit`, and no runner-owned names.
type RegisteredCommandEnvironment = (input: {
  source: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  command: object;
  commandId?: string;
}) => Record<string, string>;

function registeredCommandEnvironment(): RegisteredCommandEnvironment {
  const builder = Reflect.get(taskRunner, 'registeredCommandEnvironment') as RegisteredCommandEnvironment | undefined;
  assert.equal(typeof builder, 'function', 'task-runner exports registeredCommandEnvironment');
  return builder!;
}

const source = {
  PATH: '/usr/bin',
  HOME: '/home/synthetic',
  LANG: 'C.UTF-8',
  SYNTHETIC_INHERITED: 'inherited-value',
  SYNTHETIC_RELAY_ONLY: 'relay-only-value',
  DHARMA_ORG_API_TOKEN: 'synthetic-organization-token',
  DHARMA_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'),
  DHARMA_ALLOW_ENV_KEY: '1',
  DHARMA_TASK_WORKTREE: '/synthetic/worktree',
};

test('a registered command outside a task gets essentials and its inherited names only', () => {
  const environment = registeredCommandEnvironment()({
    source,
    platform: 'linux',
    command: { argv: ['npm', 'test'], timeoutSeconds: 60, environment: { inherit: ['SYNTHETIC_INHERITED'] } },
    commandId: 'smoke',
  });
  assert.deepEqual(environment, {
    PATH: '/usr/bin',
    HOME: '/home/synthetic',
    LANG: 'C.UTF-8',
    SYNTHETIC_INHERITED: 'inherited-value',
  });
});

test('a registered command without an environment entry gets operating-system essentials only', () => {
  const environment = registeredCommandEnvironment()({
    source,
    platform: 'linux',
    command: { argv: ['npm', 'test'], timeoutSeconds: 60 },
  });
  assert.deepEqual(environment, { PATH: '/usr/bin', HOME: '/home/synthetic', LANG: 'C.UTF-8' });
});

test('a registered command on Windows keeps one key per name and the source spelling', () => {
  const environment = registeredCommandEnvironment()({
    source: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', Synthetic_Inherited: 'inherited-value', SYNTHETIC_RELAY_ONLY: 'x',
      dharma_org_api_token: 'synthetic-organization-token' },
    platform: 'win32',
    command: { argv: ['npm.cmd', 'test'], timeoutSeconds: 60, environment: { inherit: ['SYNTHETIC_INHERITED'] } },
  });
  assert.deepEqual(environment, { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows', Synthetic_Inherited: 'inherited-value' });
});

test('a registered command with an invalid environment entry is rejected', () => {
  assert.throws(() => registeredCommandEnvironment()({
    source,
    platform: 'linux',
    command: { argv: ['npm', 'test'], timeoutSeconds: 60, environment: { inherit: ['DHARMA_ORG_API_TOKEN'] } },
    commandId: 'smoke',
  }), /invalid environment policy: smoke/);
});

test('acceptance commands still add the runner-owned names on top of the registered command environment', () => {
  const acceptance = taskRunner.acceptanceCommandEnvironment({
    source,
    platform: 'linux',
    cwd: '/synthetic/task',
    command: { argv: ['npm', 'test'], timeoutSeconds: 60, environment: { inherit: ['SYNTHETIC_INHERITED'] } },
  });
  assert.deepEqual(acceptance, {
    PATH: '/usr/bin',
    HOME: '/home/synthetic',
    LANG: 'C.UTF-8',
    SYNTHETIC_INHERITED: 'inherited-value',
    DHARMA_TASK_WORKTREE: '/synthetic/task',
  });
});
