import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { currentRepositoryRelayFailure, repositoryRelayObservationReady, runRegisteredRepositoryRelays, selectRepositoryRelayRegistrations,
  serializeRelayWork, waitForRelayRefresh, withRepositoryRelayStage } from './repositoryRelaySupervisor.js';
import { workspaceIdForDevice } from './onboardingWorkspace.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
const a = { workspaceId: 'a', policyPath: '/a/.dharma/approved-policy.json' };
const b = { workspaceId: 'b', policyPath: '/b/.dharma/approved-policy.json' };

test('two repository workers coexist; adding one never replaces the original worker', async () => {
  const controller = new AbortController();
  let rows = [a];
  const seen: string[] = [];
  const releases = new Map<string, () => void>();
  let tick = 0;
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => rows,
    run: async (row, signal) => { seen.push(row.workspaceId); await new Promise<void>(accept => {
      releases.set(row.workspaceId, accept); signal.addEventListener('abort', () => accept(), { once: true });
    }); },
    wait: async () => {
      await Promise.resolve();
      if (++tick === 1) rows = [a, b];
      if (tick === 2) { assert.deepEqual(seen, ['a', 'b']); assert.equal(releases.size, 2); controller.abort(); }
    },
  });
  assert.deepEqual(seen, ['a', 'b']);
});

test('a revoked repository stops without disrupting another registered repository', async () => {
  const controller = new AbortController();
  let rows = [a, b], tick = 0;
  const aborted: string[] = [];
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => rows,
    run: async (row, signal) => new Promise<void>(accept => {
      signal.addEventListener('abort', () => { aborted.push(row.workspaceId); accept(); }, { once: true });
    }), wait: async () => {
      await Promise.resolve();
      if (++tick === 1) rows = [b];
      if (tick === 2) { assert.deepEqual(aborted, ['a']); controller.abort(); }
    },
  });
  assert.deepEqual(aborted, ['a', 'b']);
});

test('an unavailable registry fails closed for every worker without leaking diagnostics', async () => {
  const controller = new AbortController();
  let reads = 0, tick = 0;
  const events: unknown[] = [], aborted: string[] = [];
  await runRegisteredRepositoryRelays({ signal: controller.signal,
    list: async () => { if (++reads > 1) throw new Error('private diagnostic'); return [a]; },
    run: async (row, signal) => new Promise<void>(accept => {
      signal.addEventListener('abort', () => { aborted.push(row.workspaceId); accept(); }, { once: true });
    }), observe: event => { events.push(event); }, wait: async () => {
      await Promise.resolve(); if (++tick === 2) controller.abort();
    },
  });
  assert.deepEqual(aborted, ['a']);
  assert.ok(!JSON.stringify(events).includes('private diagnostic'));
});

test('a failed repository backs off while a healthy worker remains running', async () => {
  const controller = new AbortController();
  const started: string[] = [], events: { code: string }[] = [];
  let tick = 0;
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a, b], now: () => 0,
    run: async (row, signal) => {
      started.push(row.workspaceId);
      if (row.workspaceId === 'a') throw new Error('secret');
      await new Promise<void>(accept => signal.addEventListener('abort', () => accept(), { once: true }));
    }, observe: event => { events.push(event); }, wait: async () => {
      await Promise.resolve(); await Promise.resolve(); if (++tick === 4) controller.abort();
    },
  });
  assert.deepEqual(started, ['a', 'b']);
  assert.ok(events.some(event => event.code === 'repository_relay_failed'));
});

test('a denied evidence worker reports only its repository, stage, and safe category', async () => {
  const controller = new AbortController();
  const events: unknown[] = [];
  const started: string[] = [];
  let tick = 0;
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a, b], now: () => 0,
    run: async (row, signal) => {
      started.push(row.workspaceId);
      if (row.workspaceId === 'a') {
        await withRepositoryRelayStage('evidence_sync', async () => {
          throw new Error('policy_boundary:secret_disclosure_forbidden private-payload');
        });
      } else {
        await new Promise<void>(accept => signal.addEventListener('abort', () => accept(), { once: true }));
      }
    }, observe: event => { events.push(event); }, wait: async () => {
      await Promise.resolve(); await Promise.resolve(); if (++tick === 4) controller.abort();
    },
  });
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(events, [{ workspaceId: 'a', code: 'repository_relay_failed',
    stage: 'evidence_sync', category: 'policy_boundary' }]);
  assert.ok(!JSON.stringify(events).includes('private-payload'));
});

test('nested evidence substages retain the original safe cause without leaking its text', async () => {
  const controller = new AbortController();
  const events: unknown[] = [];
  let tick = 0;
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a], now: () => 0,
    run: () => withRepositoryRelayStage('evidence_sync', () => withRepositoryRelayStage('pending_capsule_sync',
      async () => { throw new Error('policy_boundary:secret_disclosure_forbidden private-payload'); })),
    observe: event => { events.push(event); },
    wait: async () => { await Promise.resolve(); await Promise.resolve(); if (++tick === 3) controller.abort(); },
  });
  assert.deepEqual(events, [{ workspaceId: 'a', code: 'repository_relay_failed',
    stage: 'pending_capsule_sync', category: 'policy_boundary' }]);
  assert.ok(!JSON.stringify(events).includes('private-payload'));
});

test('an observer that never settles cannot block worker retry or supervisor shutdown', async () => {
  const controller = new AbortController();
  let started = 0;
  let tick = 0;
  const run = runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a],
    now: () => tick * 100_000, run: async () => { started++; throw new Error('worker failed'); },
    observe: () => new Promise<void>(() => {}),
    wait: async () => { await Promise.resolve(); if (++tick === 4) controller.abort(); },
  });
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([run, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('observer blocked relay')), 1000);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
  assert.ok(started >= 2, 'the failed worker should retry while diagnostics are pending');
});

test('diagnostics show only a current-process failure newer than its last successful poll', () => {
  const at = '2026-09-29T16:01:00.000Z';
  const relayPidMtimeMs = Date.parse(at) + 0.5;
  const relayPidCtimeMs = Date.parse(at) + 0.75;
  const receipt = { schema: 'dharma.local-repository-relay-failure/v1', organizationId: 'org_a',
    deviceId: 'device_a', workspaceId: 'a', pid: 50, relayPidMtimeMs, relayPidCtimeMs,
    at, stage: 'evidence_sync', category: 'policy_boundary', privatePayload: 'must-not-leak' };
  const input = { receipt, organizationId: 'org_a', deviceId: 'device_a', workspaceId: 'a', pid: 50,
    relayPidMtimeMs, relayPidCtimeMs,
    lastSuccessfulPollAt: '2026-09-29T16:00:00.000Z', now: Date.parse(at) + 1000 };
  assert.deepEqual(currentRepositoryRelayFailure(input), { at, stage: 'evidence_sync', category: 'policy_boundary' });
  for (const stage of ['pending_capsule_sync', 'evidence_request']) {
    assert.deepEqual(currentRepositoryRelayFailure({ ...input, receipt: { ...receipt, stage } }),
      { at, stage, category: 'policy_boundary' });
  }
  for (const changed of [{ organizationId: 'org_b' }, { deviceId: 'device_b' },
    { workspaceId: 'b' }, { pid: 51 }, { pid: 0 }, { relayPidMtimeMs: relayPidMtimeMs + 1 },
    { relayPidCtimeMs: relayPidCtimeMs + 1 }, { relayPidMtimeMs: null },
    { lastSuccessfulPollAt: at },
    { receipt: { ...receipt, stage: 'private-payload' } },
    { receipt: { ...receipt, category: 'private-payload' } },
    { receipt: { ...receipt, at: 'invalid' } }]) {
    assert.equal(currentRepositoryRelayFailure({ ...input, ...changed }), null);
  }
});

test('changed policy paths cannot replace a worker before its shutdown finishes', async () => {
  const controller = new AbortController();
  const release = deferred();
  const starts: string[] = [];
  let rows = [a], tick = 0;
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => rows,
    run: async row => { starts.push(row.policyPath); await release.promise; }, wait: async () => {
      await Promise.resolve();
      if (++tick === 1) rows = [{ ...a, policyPath: '/changed/.dharma/approved-policy.json' }];
      if (tick === 2) { assert.deepEqual(starts, [a.policyPath]); controller.abort(); release.resolve(); }
    },
  });
});

test('malformed or duplicate registrations never start a worker', async () => {
  for (const rows of [[a, a], [{ ...a, policyPath: '../foreign' }], [{ ...a, workspaceId: '' }], Array(51).fill(a)]) {
    const controller = new AbortController();
    let started = false;
    await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => rows,
      run: async () => { started = true; }, wait: async () => controller.abort() });
    assert.equal(started, false);
  }
});

test('device task turns serialize across repositories and release after failure', async () => {
  const serial = serializeRelayWork();
  const release = deferred();
  const order: string[] = [];
  const first = serial(async () => { order.push('a'); await release.promise; throw new Error('failed'); });
  const second = serial(async () => { order.push('b'); return 2; });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(order, ['a']);
  release.resolve();
  await assert.rejects(first, /failed/);
  assert.equal(await second, 2);
  assert.deepEqual(order, ['a', 'b']);
});

test('delayed earlier diagnostic writes cannot overwrite a newer failure', async () => {
  const writeDiagnostic = serializeRelayWork();
  const release = deferred();
  let lastFailure = '';
  const earlier = writeDiagnostic(async () => { await release.promise; lastFailure = 'earlier'; });
  const later = writeDiagnostic(async () => { lastFailure = 'later'; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(lastFailure, '');
  release.resolve();
  await Promise.all([earlier, later]);
  assert.equal(lastFailure, 'later');
});

test('diagnostic failure never escapes a caught worker rejection', async () => {
  const controller = new AbortController();
  let tick = 0;
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a],
    run: async () => { throw new Error('private'); },
    observe: () => { throw new Error('broken output'); }, wait: async () => {
      await Promise.resolve(); await Promise.resolve(); if (++tick === 3) controller.abort();
    } });
});

test('stopping interrupts a long refresh delay and an already stopped supervisor starts nothing', async () => {
  const controller = new AbortController();
  const waiting = waitForRelayRefresh(60_000, controller.signal);
  controller.abort();
  await waiting;
  await runRegisteredRepositoryRelays({ signal: controller.signal,
    list: async () => { throw new Error('should not read'); },
    run: async () => { throw new Error('should not start'); } });
});

test('readiness is scoped to the actual repository, executable and live receiver PID', () => {
  const at = '2026-09-29T16:00:00.000Z';
  const observation = { at, workspaceId: 'a', version: '0.2.119', pid: 50 };
  const input = { observation, workspaceId: 'a', version: '0.2.119', pid: 50, now: Date.parse(at) + 1000 };
  assert.equal(repositoryRelayObservationReady(input), true);
  for (const changed of [{ workspaceId: 'b' }, { version: '0.2.118' }, { pid: 51 }, { pid: 0 },
    { observation: null }, { now: Date.parse(at) - 1 }, { now: Date.parse(at) + 300_001 },
    { observation: { ...observation, at: 'invalid' } }]) {
    assert.equal(repositoryRelayObservationReady({ ...input, ...changed }), false);
  }
});

test('only current-device aliases with matching canonical routes and organization policies are selected', async () => {
  const enrollment = { organizationId: 'org_a', deviceId: 'device_a' };
  const make = (path: string, workspaceId: string, fields = {}) => ({ path, workspaceId,
    organizationId: enrollment.organizationId, routeHash: `route:${path}`, repositoryRemoteHash: 'remote', ...fields });
  const alias = (path: string) => make(path, workspaceIdForDevice({ ...enrollment, path }));
  const rows = [alias('/a'), make('/a', 'canonical_a'), alias('/b'), make('/b', 'canonical_b'),
    make('/foreign', 'foreign', { organizationId: 'org_foreign' }),
    make('/other-device', workspaceIdForDevice({ ...enrollment, deviceId: 'another', path: '/other-device' })),
    make('/other-device', 'canonical_other'), alias('/wrong-route'), make('/wrong-route', 'canonical_wrong', { routeHash: 'different' }),
    alias('/wrong-policy'), make('/wrong-policy', 'canonical_policy'), alias('/missing'), make('/missing', 'canonical_missing')];
  const selected = await selectRepositoryRelayRegistrations(rows, enrollment, async path => {
    if (path === resolve('/missing', '.dharma', 'approved-policy.json')) throw new Error('private missing path');
    return { organizationId: path === resolve('/wrong-policy', '.dharma', 'approved-policy.json') ? 'org_foreign' : enrollment.organizationId,
      serverAuthorization: { workspaceId: path === resolve('/a', '.dharma', 'approved-policy.json') ? 'canonical_a'
        : path === resolve('/b', '.dharma', 'approved-policy.json') ? 'canonical_b'
          : path === resolve('/wrong-route', '.dharma', 'approved-policy.json') ? 'canonical_wrong' : 'canonical_policy' } };
  });
  assert.deepEqual(selected.map(row => row.workspaceId), ['canonical_a', 'canonical_b']);
  assert.deepEqual(rows[0], alias('/a'));
  assert.deepEqual(await selectRepositoryRelayRegistrations([alias('/a'), make('/a', 'canonical_a'),
    make('/a', 'canonical_a')], enrollment, async () => ({ organizationId: enrollment.organizationId,
      serverAuthorization: { workspaceId: 'canonical_a' } })), []);
  await assert.rejects(selectRepositoryRelayRegistrations([alias('/a'), alias('/a')], enrollment,
    async () => ({ organizationId: enrollment.organizationId })), /Ambiguous registry/);
});

// Start times of one repository whose session opens fail with the given error per attempt.
async function failedSessionOpenStarts(errorFor: (attempt: number) => Error, attempts: number) {
  const controller = new AbortController();
  let clock = 0;
  const starts: number[] = [];
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a], now: () => clock,
    run: () => {
      const attempt = starts.push(clock);
      return withRepositoryRelayStage('session_open', async () => { throw errorFor(attempt); });
    },
    wait: async () => {
      await new Promise(accept => setImmediate(accept));
      clock += 10_000;
      if (starts.length > attempts || clock > 10_000_000) controller.abort();
    } });
  return starts.slice(1).map((at, index) => at - starts[index]!);
}
const identityLost = () => Error('relay_host_device_identity_unavailable');
const storeUnreadable = () => Object.assign(Error('Windows Credential Manager fresh read failed: read_response_invalid.'),
  { code: 'read_response_invalid' });

test('five consecutive device identity or store failures back the retry off to ten minutes', async () => {
  const gaps = await failedSessionOpenStarts(attempt => attempt % 2 ? identityLost() : storeUnreadable(), 7);
  assert.equal(gaps.length, 7);
  for (const gap of gaps.slice(0, 4)) assert.ok(gap <= 60_000, `short retry before the fifth failure: ${gaps}`);
  for (const gap of gaps.slice(4)) assert.ok(gap >= 600_000 && gap <= 620_000, `ten-minute retry after five: ${gaps}`);
});

test('any other failure keeps the short retry and restarts the device credential count', async () => {
  const other = await failedSessionOpenStarts(() => Error('connection_transport_unavailable private detail'), 8);
  assert.ok(other.every(gap => gap <= 60_000), `other failures: ${other}`);
  const mixed = await failedSessionOpenStarts(attempt => attempt % 5 === 0 ? Error('worker failed') : identityLost(), 10);
  assert.ok(mixed.every(gap => gap <= 60_000), `interrupted credential failures: ${mixed}`);
});

// The real relayRestartDelayMs schedule: 1, 2, 4, 8, 16, then 30 s.
test('a store that does not answer keeps the short retry however often it repeats', async () => {
  const storeBusy = () => Object.assign(Error('Windows Credential Manager fresh read failed: read_timeout.'), { code: 'read_timeout' });
  const busy = await failedSessionOpenStarts(storeBusy, 8);
  assert.equal(busy.length, 8);
  assert.ok(busy.every(gap => gap <= 60_000), `store-busy failures must never wait ten minutes: ${busy}`);
  const helperGone = await failedSessionOpenStarts(attempt => attempt % 2 ? storeBusy()
    : Object.assign(Error('Windows Credential Manager fresh read failed: read_helper_exited.'), { code: 'read_helper_exited' }), 7);
  assert.ok(helperGone.every(gap => gap <= 60_000), `helper outages: ${helperGone}`);
  const identity = await failedSessionOpenStarts(identityLost, 6);
  assert.ok(identity.slice(0, 4).every(gap => gap <= 60_000) && identity.slice(4).every(gap => gap >= 600_000),
    `identity failures still wait ten minutes after five: ${identity}`);
});

test('an unreadable WSL vault entry backs off like any unreadable store', async () => {
  const wslUnreadable = () => Error('Windows Credential Manager failed: Credential read unavailable.');
  const alone = await failedSessionOpenStarts(wslUnreadable, 6);
  assert.ok(alone.slice(0, 4).every(gap => gap <= 60_000) && alone.slice(4).every(gap => gap >= 600_000), `WSL unreadable: ${alone}`);
  const mixed = await failedSessionOpenStarts(attempt => attempt % 2 ? wslUnreadable() : identityLost(), 6);
  assert.ok(mixed.slice(4).every(gap => gap >= 600_000), `WSL unreadable with identity loss: ${mixed}`);
  const otherText = await failedSessionOpenStarts(() => Error('Windows Credential Manager failed: Credential write unavailable.'), 7);
  assert.ok(otherText.every(gap => gap <= 60_000), `other helper text stays busy: ${otherText}`);
});
