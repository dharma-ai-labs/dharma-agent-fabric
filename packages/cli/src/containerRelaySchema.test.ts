import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import test from 'node:test';

async function validator(name: string) {
  const schema = JSON.parse(await readFile(new URL(`./schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  return new Ajv2020({ strict: true, strictRequired: false }).compile(schema);
}

test('container startup schema rejects credentials, arbitrary backends and malformed authority paths', async () => {
  const validate = await validator('relay-autostart.v3');
  const value = { schema: 'dharma.relay-autostart/v3', backend: 'container-entrypoint', launcher: '/repo/.dharma/bin/dharma',
    workspace: '/repo', policy: '/repo/.dharma/approved-policy.json', version: '0.2.134', taskName: null };
  assert.equal(validate(value), true);
  for (const change of [{ grant: 'CANARY_PRIVATE_INPUT' }, { backend: 'systemd-user' }, { taskName: 'other' },
    { policy: '../foreign' }, { launcher: '/repo\ncommand' }, { version: 'unpublished arbitrary value' }]) {
    assert.equal(validate({ ...value, ...change }), false);
  }
});

test('container lifecycle schema separates configuration from live-child receipt and forbids secret fields', async () => {
  const validate = await validator('container-relay-lifecycle.v1');
  const marker = { schema: 'dharma.container-entrypoint/v1', home: '/private/device', pid: 1, uid: 1000, startTicks: '1234' };
  const control = { schema: 'dharma.container-relay-control/v1', home: '/private/device', registrationHash: 'a'.repeat(64), running: true };
  const running = { schema: 'dharma.container-relay-heartbeat/v1', home: '/private/device', startTicks: '1234', polledAt: 1000,
    lifecycle: 'running', reason: null, registrationHash: 'a'.repeat(64), childPid: 42, childStartTicks: '1235' };
  for (const value of [marker, control, running, { ...running, lifecycle: 'blocked', reason: 'consumer_store_locked_or_unavailable', childPid: null, childStartTicks: null }]) {
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, grant: 'CANARY_PRIVATE_INPUT' }), false);
  }
  for (const change of [{ childStartTicks: null }, { childPid: null }, { lifecycle: 'ready' }, { reason: 'CANARY_PRIVATE_INPUT' },
    { startTicks: 'invalid' }, { polledAt: -1 }]) assert.equal(validate({ ...running, ...change }), false);
  assert.equal(validate({ ...marker, uid: 0 }), false);
  assert.equal(validate({ ...control, registrationHash: 'foreign' }), false);
});

test('Docker-init marker carries both boot identities and rejects incomplete or secret-bearing authority', async () => {
  const validate = await validator('container-relay-lifecycle.v1');
  const marker = { schema: 'dharma.container-entrypoint/v2', home: '/private/device', pid: 42, uid: 1000,
    startTicks: '1235', initStartTicks: '1234' };
  assert.equal(validate(marker), true, JSON.stringify(validate.errors));
  for (const delta of [{ pid: 1 }, { uid: 0 }, { initStartTicks: null }, { initStartTicks: 'CANARY_PRIVATE_INPUT' },
    { startTicks: '' }, { grant: 'CANARY_PRIVATE_INPUT' }]) assert.equal(validate({ ...marker, ...delta }), false);
});
