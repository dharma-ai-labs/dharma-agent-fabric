import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { currentRepositoryRelayFailure, repositoryRelayObservationReady, runRegisteredRepositoryRelays, selectRepositoryRelayRegistrations,
  serializeRelayWork, waitForRelayRefresh, withRepositoryRelayStage } from './repositoryRelaySupervisor.js';
import * as supervisor from './repositoryRelaySupervisor.js';
import { withDeviceSigningControl } from '@dharma-ai-labs/agent-fabric-relay-client';
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
  assert.deepEqual(events, [{ workspaceId: 'a', at: new Date(0).toISOString(), code: 'repository_relay_failed',
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
  assert.deepEqual(events, [{ workspaceId: 'a', at: new Date(0).toISOString(), code: 'repository_relay_failed',
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

// #513: every stage line carries a time and, without a typed failure code, a safe error class.
async function observedEvents(error: () => unknown, clock = 1_790_000_000_000) {
  const controller = new AbortController();
  const events: unknown[] = [];
  let tick = 0;
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a], now: () => clock,
    run: () => withRepositoryRelayStage('task_poll', async () => { throw error(); }),
    observe: event => { events.push(event); },
    wait: async () => { await Promise.resolve(); await Promise.resolve(); if (++tick === 3) controller.abort(); } });
  return events;
}

test('repository relay events carry an ISO time from the supervisor clock', async () => {
  const clock = Date.parse('2026-11-20T10:15:30.250Z');
  assert.deepEqual(await observedEvents(() => Error('private'), clock), [{ workspaceId: 'a', at: '2026-11-20T10:15:30.250Z',
    code: 'repository_relay_failed', stage: 'task_poll', category: 'unexpected' }]);
  const controller = new AbortController();
  const events: unknown[] = [];
  let reads = 0;
  await runRegisteredRepositoryRelays({ signal: controller.signal, now: () => clock,
    list: async () => { if (++reads > 1) controller.abort(); throw Error('private registry path'); },
    run: async () => {}, observe: event => { events.push(event); }, wait: async () => { await Promise.resolve(); } });
  assert.deepEqual(events[0], { workspaceId: null, at: '2026-11-20T10:15:30.250Z', code: 'repository_registry_unavailable' });
});

test('an HTTP rejection reports its status and server code, never its message', async () => {
  const rejection = () => Object.assign(Error('upstream_unavailable: private server text'),
    { name: 'AgentFabricRequestError', status: 503, definitive: false, serverCode: 'upstream_unavailable' });
  const events = await observedEvents(rejection);
  assert.deepEqual(events, [{ workspaceId: 'a', at: new Date(1_790_000_000_000).toISOString(), code: 'repository_relay_failed',
    stage: 'task_poll', category: 'unexpected', httpStatus: 503, errorCode: 'upstream_unavailable' }]);
  assert.doesNotMatch(JSON.stringify(events), /private/);
});

test('an errno code is found on the cause of a wrapped network error', async () => {
  const fetchFailed = () => new TypeError('fetch failed', { cause: Object.assign(Error('connect ECONNREFUSED 192.0.2.1:443'),
    { code: 'ECONNREFUSED', errno: -111, syscall: 'connect', address: '192.0.2.1', port: 443 }) });
  const events = await observedEvents(fetchFailed);
  assert.deepEqual(events.map(event => (event as { errorCode?: string }).errorCode), ['ECONNREFUSED']);
  assert.doesNotMatch(JSON.stringify(events), /192\.0\.2\.1|fetch failed|connect/);
});

test('the relay acknowledgement timeout reports its own code', async () => {
  const events = await observedEvents(() => Object.assign(Error('Relay response timed out.'), { code: 'relay_response_timeout' }));
  assert.deepEqual(events.map(event => (event as { errorCode?: string }).errorCode), ['relay_response_timeout']);
  assert.doesNotMatch(JSON.stringify(events), /timed out/);
});

test('unsafe status and code values are dropped, and free text never becomes a code', async () => {
  for (const error of [Error('plain_lowercase_words'), Error('sk_live_token_value'),
    Object.assign(Error('x'), { code: 'C:/Users/someone/.secret' }), Object.assign(Error('x'), { code: 'has space' }),
    Object.assign(Error('x'), { code: 'a'.repeat(81) }), Object.assign(Error('x'), { code: 7 }),
    Object.assign(Error('x'), { serverCode: 'Request-Failed: private' }), Object.assign(Error('x'), { serverCode: 42 }),
    Object.assign(Error('x'), { status: 42 }), Object.assign(Error('x'), { status: '503' }),
    Object.assign(Error('x'), { status: 700 }), Object.assign(Error('x'), { status: 503.5 }), 'raw string failure',
    Object.defineProperty(Error('x'), 'code', { get() { throw Error('hostile getter'); } })]) {
    const events = await observedEvents(() => error);
    assert.deepEqual(events, [{ workspaceId: 'a', at: new Date(1_790_000_000_000).toISOString(), code: 'repository_relay_failed',
      stage: 'task_poll', category: 'unexpected' }], `unexpected class for ${String((error as Error).message ?? error)}`);
  }
});

// #515: the restart gap after a loop that ran for runMs and then failed, following six quick failures (30 s backoff).
async function restartGapAfterRun(runMs: number) {
  const controller = new AbortController();
  let clock = 0, failedAt = 0;
  const starts: number[] = [];
  await runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a], now: () => clock,
    run: async (_row, signal) => {
      if (starts.push(clock) === 7) {
        const begin = clock;
        while (clock - begin < runMs && !signal.aborted) await new Promise(accept => setImmediate(accept));
        failedAt = clock;
      }
      throw Error('worker failed');
    },
    wait: async () => {
      await new Promise(accept => setImmediate(accept));
      clock += 1_000;
      if (starts.length > 7 || clock > 5_000_000) controller.abort();
    } });
  assert.equal(starts.length, 8, `the loop restarted after its long run: ${starts}`);
  assert.ok(starts[6]! - starts[5]! >= 30_000, `six quick failures reach the 30 s backoff: ${starts}`);
  return starts[7]! - failedAt;
}

test('a loop that ran healthy for ten minutes restarts on the short schedule again', async () => {
  const gap = await restartGapAfterRun(10 * 60_000);
  assert.ok(gap <= 3_000, `restart after a ten-minute healthy run waited ${gap} ms`);
});

test('a loop that failed before ten minutes keeps its backoff', async () => {
  const gap = await restartGapAfterRun(9 * 60_000);
  assert.ok(gap >= 30_000, `restart after a nine-minute run waited only ${gap} ms`);
});

// #511: a signing control held by another process is retried inside the stage, so the loop keeps its place.
type BusyRetry = <T>(operation: () => Promise<T>, input: { signal: AbortSignal;
  wait?: (ms: number, signal: AbortSignal) => Promise<void> }) => Promise<T>;
function busyRetry() {
  const value = (supervisor as unknown as Record<string, unknown>).retrySigningControlBusy;
  assert.equal(typeof value, 'function', 'retrySigningControlBusy is exported');
  return value as BusyRetry;
}

test('a busy signing control is retried inside the stage after a short wait', async () => {
  const retry = busyRetry();
  const waits: number[] = [];
  let calls = 0;
  const value = await retry(async () => { if (++calls < 3) throw Error('connection_anchor_busy'); return 'open'; },
    { signal: new AbortController().signal, wait: async ms => { waits.push(ms); } });
  assert.deepEqual({ value, calls, waits }, { value: 'open', calls: 3, waits: [1_000, 1_000] });
});

test('only connection_anchor_busy is retried, and the retries are bounded', async () => {
  const retry = busyRetry(), signal = new AbortController().signal, wait = async () => {};
  for (const message of ['connection_anchor_recovery_required', 'device_signing_control_unavailable', 'connection_anchor_busy: x']) {
    let calls = 0;
    await assert.rejects(retry(async () => { calls++; throw Error(message); }, { signal, wait }), { message });
    assert.equal(calls, 1, message);
  }
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw Error('connection_anchor_busy'); }, { signal, wait }),
    { message: 'connection_anchor_busy' });
  assert.equal(calls, 4);
});

test('a stopping loop does not retry a busy signing control', async () => {
  const retry = busyRetry(), controller = new AbortController();
  let calls = 0;
  await assert.rejects(retry(async () => { calls++; controller.abort(); throw Error('connection_anchor_busy'); },
    { signal: controller.signal, wait: async () => assert.fail('waited while stopping') }), { message: 'connection_anchor_busy' });
  assert.equal(calls, 1);
});

// Review round 1 on #511: stopping the relay reaches a loop that waits in the in-process signing line.
test('a relay stop releases a loop queued behind a sibling signing hold before the hold ends, and it signs nothing', async () => {
  const controller = new AbortController(), held = deferred(), released = deferred(), queued = deferred();
  const config = { hqUrl: 'https://www.dharma-ai.io', organizationId: `org_fixture${Date.now()}`, deviceId: randomUUID() };
  const outcome: Record<string, string> = {};
  let signedByB = 0;
  const stopped = runRegisteredRepositoryRelays({ signal: controller.signal, list: async () => [a, b],
    run: async row => {
      if (row.workspaceId === 'a') {
        await withDeviceSigningControl({ config }, async () => { held.resolve(); await released.promise; });
        outcome.a = 'released';
        return;
      }
      await held.promise;
      const signing = withDeviceSigningControl({ config }, async () => { signedByB++; });
      queued.resolve();
      outcome.b = await signing.then(() => 'signed', (error: Error) => error.name);
    },
    wait: async (_ms, signal) => { await queued.promise; if (!signal.aborted) controller.abort(); } });
  try {
    const deadline = Date.now() + 2_000;
    while (!outcome.b && Date.now() < deadline) await new Promise(accept => setTimeout(accept, 10));
    assert.deepEqual(outcome, { b: 'AbortError' }, 'the queued loop settles while its sibling still holds signing control');
  } finally { released.resolve(); await stopped; }
  assert.deepEqual({ outcome, signedByB }, { outcome: { b: 'AbortError', a: 'released' }, signedByB: 0 });
});

// #514: a per-workspace count and short history of loop failures, kept while each later loop succeeds.
type FailureHistory = { count: number; since: string; entries: Array<Record<string, unknown>> };
type FailureHistoryApi = {
  REPOSITORY_RELAY_FAILURE_HISTORY_LIMIT: number;
  appendRepositoryRelayFailureHistory(previous: unknown, event: Record<string, unknown>,
    binding: Record<string, unknown>): Record<string, unknown> | null;
  currentRepositoryRelayFailureHistory(input: Record<string, unknown>): FailureHistory | null;
  recentRepositoryRelayFailure(history: FailureHistory | null, now?: number): Record<string, unknown> | null;
};
function failureHistoryApi() {
  const api = supervisor as unknown as Partial<FailureHistoryApi>;
  assert.equal(typeof api.appendRepositoryRelayFailureHistory, 'function', 'the failure history is not kept');
  return api as FailureHistoryApi;
}
const historyStart = Date.parse('2026-11-20T00:00:00.000Z');
const historyBinding = { organizationId: 'org_a', deviceId: 'device_a', workspaceId: 'a', pid: 50,
  relayPidMtimeMs: historyStart - 0.5, relayPidCtimeMs: historyStart - 0.25 };
const failureAt = (minutes: number) => new Date(historyStart + minutes * 60_000).toISOString();
const failureEvent = (minutes: number, extra: Record<string, unknown> = {}) => ({ workspaceId: 'a',
  code: 'repository_relay_failed', at: failureAt(minutes), stage: 'task_poll', category: 'unexpected', ...extra });
function historyOf(events: Record<string, unknown>[], previous: unknown = null) {
  const api = failureHistoryApi();
  return events.reduce<unknown>((record, event) => api.appendRepositoryRelayFailureHistory(record, event, historyBinding), previous);
}

test('the failure history keeps the last 20 failures, a running count and the first failure time', () => {
  const api = failureHistoryApi();
  assert.equal(api.REPOSITORY_RELAY_FAILURE_HISTORY_LIMIT, 20);
  const events = Array.from({ length: 25 }, (_, index) => index % 2
    ? failureEvent(index, { stage: 'session_open', failureCode: 'connection_identity_store_busy' })
    : failureEvent(index, { httpStatus: 503, errorCode: 'upstream_unavailable' }));
  const record = historyOf(events) as { count: number; since: string; entries: unknown[] };
  assert.equal(record.count, 25);
  assert.equal(record.since, failureAt(0));
  assert.equal(record.entries.length, 20);
  assert.deepEqual(record.entries[0], { at: failureAt(5), stage: 'session_open', failureCode: 'connection_identity_store_busy' });
  assert.deepEqual(record.entries[19], { at: failureAt(24), stage: 'task_poll', httpStatus: 503, errorCode: 'upstream_unavailable' });
  const current = api.currentRepositoryRelayFailureHistory({ record, ...historyBinding, now: historyStart + 3_600_000 });
  assert.deepEqual(current, { count: 25, since: failureAt(0), entries: record.entries });
  assert.ok(JSON.stringify(record).length < 4096, 'the history stays small however long the relay fails');
});

test('history entries keep only the time, stage, failure code and safe error class', () => {
  const canary = 'token-sk-private-canary C:/Users/someone/.secret';
  const record = historyOf([
    failureEvent(1, { stage: 'session_open', failureCode: 'connection_identity_store_busy', message: canary, remedy: canary }),
    failureEvent(2, { failureCode: canary, httpStatus: 700, errorCode: 'has space' }),
    failureEvent(3, { httpStatus: 429, errorCode: 'ECONNRESET', category: 'policy_boundary' }),
  ]) as { entries: unknown[] };
  assert.deepEqual(record.entries, [
    { at: failureAt(1), stage: 'session_open', failureCode: 'connection_identity_store_busy' },
    { at: failureAt(2), stage: 'task_poll' },
    { at: failureAt(3), stage: 'task_poll', httpStatus: 429, errorCode: 'ECONNRESET' },
  ]);
  assert.doesNotMatch(JSON.stringify(record), /canary|secret|policy_boundary|unexpected/);
  const api = failureHistoryApi();
  for (const event of [{ ...failureEvent(4), stage: 'private-stage' }, { ...failureEvent(4), at: 'not-a-time' },
    { workspaceId: null, code: 'repository_registry_unavailable', at: failureAt(4) }]) {
    assert.equal(api.appendRepositoryRelayFailureHistory(record, event, historyBinding), null);
  }
});

test('a new relay process or a damaged history starts a fresh count', () => {
  const previous = historyOf([failureEvent(1), failureEvent(2)]) as Record<string, unknown>;
  assert.equal(previous.count, 2);
  for (const stale of [{ ...previous, pid: 49 }, { ...previous, relayPidMtimeMs: 1 }, { ...previous, workspaceId: 'b' },
    { ...previous, schema: 'foreign' }, { ...previous, entries: [{ at: failureAt(1), stage: 'task_poll', message: 'x' }] },
    '\0'.repeat(186), null, []]) {
    const record = historyOf([failureEvent(3)], stale) as { count: number; since: string; entries: unknown[] };
    assert.deepEqual({ count: record.count, since: record.since, entries: record.entries },
      { count: 1, since: failureAt(3), entries: [{ at: failureAt(3), stage: 'task_poll' }] });
  }
});

test('status reads a failure history only for the current relay process and in its exact form', () => {
  const api = failureHistoryApi();
  const record = historyOf([failureEvent(1), failureEvent(2, { httpStatus: 502 })]) as Record<string, unknown>;
  const input = { record, ...historyBinding, now: historyStart + 3_600_000 };
  assert.equal(api.currentRepositoryRelayFailureHistory(input)?.count, 2);
  const entries = record.entries as Record<string, unknown>[];
  for (const changed of [{ organizationId: 'org_b' }, { deviceId: 'device_b' }, { workspaceId: 'b' }, { pid: 51 },
    { relayPidMtimeMs: null }, { relayPidCtimeMs: historyBinding.relayPidCtimeMs + 1 },
    { now: historyStart }, // every entry would be from the future
    { record: { ...record, count: 1 } }, { record: { ...record, count: 2.5 } }, { record: { ...record, since: 'x' } },
    { record: { ...record, entries: [] } }, { record: { ...record, entries: Array(21).fill(entries[0]) } },
    { record: { ...record, entries: [{ ...entries[0], message: 'private' }] } },
    { record: { ...record, entries: [{ ...entries[0], failureCode: 'C:/private' }] } },
    { record: { ...record, entries: [{ ...entries[0], stage: 'private' }] } },
    { record: { ...record, privatePayload: 'x' } }, { record: '\0'.repeat(32) }]) {
    assert.equal(api.currentRepositoryRelayFailureHistory({ ...input, ...changed }), null, JSON.stringify(changed));
  }
});

test('the default status summary names a workspace only for a failure in the last 24 hours', () => {
  const api = failureHistoryApi();
  const record = historyOf([failureEvent(0), failureEvent(10, { stage: 'evidence_sync', httpStatus: 503 })]);
  const history = api.currentRepositoryRelayFailureHistory({ record, ...historyBinding, now: historyStart + 3_600_000 });
  const latestAt = historyStart + 10 * 60_000;
  assert.deepEqual(api.recentRepositoryRelayFailure(history, latestAt + 23 * 3_600_000), { count: 2, since: failureAt(0),
    latest: { at: failureAt(10), stage: 'evidence_sync', httpStatus: 503 } });
  assert.equal(api.recentRepositoryRelayFailure(history, latestAt + 24 * 3_600_000 + 1), null);
  assert.equal(api.recentRepositoryRelayFailure(null, latestAt), null);
});
