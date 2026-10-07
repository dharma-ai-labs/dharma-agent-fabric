import assert from 'node:assert/strict';
import test from 'node:test';
import {waitForNamedSessionStartup} from './namedSessionStartup.js';

function fixture(readyAt: number, maximumWaitMs?: number) {
  let time = 0, effects = 0;
  const input = {
    maximumWaitMs, now: () => time,
    sleep: async (milliseconds: number) => {time += milliseconds;},
    step: async <T>(operation: () => Promise<T>) => operation(),
    assertActive: async () => {},
    observe: async () => {effects++; if (time < readyAt) throw new Error('socket_unavailable'); return {ok: true};},
  };
  return {input, time: () => time, effects: () => effects, advance: (milliseconds: number) => {time += milliseconds;}};
}

test('published slow-start case does not fail before a 36-second retained-session startup', async () => {
  const f = fixture(36_000);
  assert.deepEqual(await waitForNamedSessionStartup(f.input), {ok: true});
  assert.equal(f.time(), 36_000);
});

test('unavailable startup remains finite with no successful receipt', async () => {
  const f = fixture(Infinity, 1000);
  await assert.rejects(waitForNamedSessionStartup(f.input), /named_session_startup_failed/);
  assert.equal(f.time(), 1000);
});

test('remaining approved setup lifetime is not extended to fit a slow startup', async () => {
  const f = fixture(36_000, 25_000);
  await assert.rejects(waitForNamedSessionStartup(f.input), /named_session_startup_failed/);
  assert.equal(f.time(), 25_000);
});

test('normal ready startup returns without consuming the full wait allowance', async () => {
  const f = fixture(0);
  assert.deepEqual(await waitForNamedSessionStartup(f.input), {ok: true});
  assert.equal(f.time(), 250);
  assert.equal(f.effects(), 1);
});

test('caller deadline cannot be enlarged beyond the bounded startup allowance', async () => {
  for (const maximumWaitMs of [0, -1, 120_001, 1.5, NaN, Infinity]) {
    const f = fixture(0, maximumWaitMs);
    await assert.rejects(waitForNamedSessionStartup(f.input), /named_session_startup_failed/);
    assert.equal(f.effects(), 0);
  }
});

test('scope withdrawal before a probe performs no observation', async () => {
  const f = fixture(0);
  f.input.step = async () => {throw new Error('setup_session_scope_unavailable');};
  await assert.rejects(waitForNamedSessionStartup(f.input), /setup_session_scope_unavailable/);
  assert.equal(f.effects(), 0);
});

test('scope withdrawal after a successful observation is not swallowed as transport retry', async () => {
  const f = fixture(0);
  let steps = 0;
  f.input.step = async operation => {
    const result = await operation();
    if (++steps === 2) throw new Error('setup_session_scope_unavailable');
    return result;
  };
  await assert.rejects(waitForNamedSessionStartup(f.input), /setup_session_scope_unavailable/);
  assert.equal(f.effects(), 1);
});

test('active-host refusal propagates before a probe', async () => {
  const f = fixture(0);
  f.input.assertActive = async () => {throw new Error('codex_setup_host_scope_unavailable');};
  await assert.rejects(waitForNamedSessionStartup(f.input), /codex_setup_host_scope_unavailable/);
  assert.equal(f.effects(), 0);
});

test('late observation cannot establish readiness after the bounded deadline', async () => {
  const f = fixture(0, 1000);
  f.input.observe = async () => {f.advance(1000); return {ok: true};};
  await assert.rejects(waitForNamedSessionStartup(f.input), /named_session_startup_failed/);
});

test('deadline reached during the final sleep admits no extra observation', async () => {
  const f = fixture(Infinity, 1000);
  await assert.rejects(waitForNamedSessionStartup(f.input), /named_session_startup_failed/);
  assert.equal(f.effects(), 3);
});

test('deadline reached during active-host assertion admits no observation', async () => {
  const f = fixture(0, 1000);
  f.input.assertActive = async () => {f.advance(1000);};
  await assert.rejects(waitForNamedSessionStartup(f.input), /named_session_startup_failed/);
  assert.equal(f.effects(), 0);
});

test('deadline reached in step preauthorization admits no observation', async () => {
  const f = fixture(0, 1000);
  let steps = 0;
  f.input.step = async operation => {
    if (++steps === 2) f.advance(1000);
    return operation();
  };
  await assert.rejects(waitForNamedSessionStartup(f.input), /named_session_startup_failed/);
  assert.equal(f.effects(), 0);
});

test('an owned child failure is preserved rather than hidden behind a full startup timeout', async () => {
  const f = fixture(Infinity, 1000);
  const input = Object.assign(f.input, {readFailure: () => 'named_session_startup_setup_child_unavailable' as const});
  await assert.rejects(waitForNamedSessionStartup(input), /^Error: named_session_startup_setup_child_unavailable$/);
  assert.equal(f.time(), 250);
  assert.equal(f.effects(), 0);
});

test('scope refusal takes priority over inspecting child diagnostics', async () => {
  const f = fixture(Infinity, 1000);
  let diagnosticReads = 0;
  f.input.step = async () => {throw new Error('setup_session_scope_unavailable');};
  const input = Object.assign(f.input, {readFailure: () => {diagnosticReads++; return 'named_session_startup_child_exited' as const;}});
  await assert.rejects(waitForNamedSessionStartup(input), /setup_session_scope_unavailable/);
  assert.equal(diagnosticReads, 0);
});

test('a child that closes during socket observation cannot produce ready status', async () => {
  const f = fixture(0, 1000);
  let failed = false;
  f.input.observe = async () => {failed = true; return {ok: true};};
  const input = Object.assign(f.input, {readFailure: () => failed ? 'named_session_startup_child_exited' as const : undefined});
  await assert.rejects(waitForNamedSessionStartup(input), /named_session_startup_child_exited/);
});

test('an unexpected diagnostic value cannot become a secret-bearing error', async () => {
  const f = fixture(0, 1000);
  const input = Object.assign(f.input, {readFailure: () => 'private-secret-placeholder'});
  await assert.rejects(waitForNamedSessionStartup(input as unknown as Parameters<typeof waitForNamedSessionStartup>[0]),
    /^Error: named_session_startup_failed$/);
});
