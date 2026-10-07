import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {LocalVault, type LocalCodexSetupSessionRequest, type LocalCodexSetupSessionResult} from '@dharma-ai-labs/agent-fabric-local-vault';
import {prepareCodexBootstrapHost, runCodexBootstrapHostScope, type BootstrapHostScope} from './bootstrapHostScope.js';
import {createCodexSetupAdmission} from './codexSetupAdmission.js';
import {createNamedSessionChildOwner} from './namedSessionChildOwner.js';
import {awaitCodexSetupSession, consumeCodexSetupSessions, currentAcceptedSetupSessionScope,
  originalCodexSetupSessionSender, withCodexSetupSessionSender, type AcceptedSetupSessionScope} from './codexSetupSessionHandoff.js';
import type {CodexSetupFailureDiagnostic} from './codexSetupDiagnostic.js';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;
async function fixture(run: (f: {vault: LocalVault; request: LocalCodexSetupSessionRequest; leaseId: string;
  signal: AbortSignal; abort(): void; scope: BootstrapHostScope}) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-session-supervisor-'));
  const vault = await LocalVault.open({root, masterKey: randomBytes(32)}), controller = new AbortController();
  const claim = vault.claimCodexSetupOperation(uuid(1), digest);
  if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
  const request: LocalCodexSetupSessionRequest = {schema: 'dharma.local-codex-setup-session/v1', operationId: uuid(1),
    intentDigest: digest, setupReference: uuid(99), senderPid: process.pid, senderStartTicks: '1',
    organizationId: 'org_demo', membershipId: uuid(2), deviceId: uuid(3), workspaceId: uuid(4),
    repositoryBindingId: uuid(5), endpointId: uuid(6), provider: 'codex', origin: 'https://hq.example',
    repositoryFingerprint: digest, policyRevision: 'policy-v1', policyHash: digest, scopeDigest: digest,
    contractDigest: digest, name: 'reviewer', workspaceRoot: root, maximumCostCents: 1000, maximumTurnCostCents: 25,
    issuedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString()};
  const scope: BootstrapHostScope = {signal: controller.signal, current: async () => !controller.signal.aborted,
    async assert() {if (controller.signal.aborted) throw new Error('codex_setup_host_scope_unavailable');},
    close() {controller.abort();}, async step(operation) {await this.assert(); const result = await operation(); await this.assert(); return result;}};
  try {await run({vault, request, leaseId: claim.leaseId, signal: controller.signal, abort: () => controller.abort(), scope});}
  finally {controller.abort(); vault.close(); await rm(root, {recursive: true, force: true});}
}

const sender = (vault: LocalVault) => ({async stageCodexSetupSession(...args: Parameters<LocalVault['stageCodexSetupSession']>) {
  const submission = vault.stageCodexSetupSession(...args); return {async withdraw() {submission.withdraw();}};
}, async readCodexSetupSession(...args: Parameters<LocalVault['readCodexSetupSession']>) {return vault.readCodexSetupSession(...args);}});
const unconfirmed: LocalCodexSetupSessionResult = {state: 'unconfirmed', code: 'session_start_unconfirmed'};

test('accepted startup can finish after 30 seconds without restaging or extending original expiry', async t => {
  await fixture(async f => {
    let now = Date.now(), reads = 0, submissions = 0, withdrawals = 0;
    t.mock.method(Date, 'now', () => now);
    const result: LocalCodexSetupSessionResult = {state:'started',bindingId:uuid(9),sessionId:'synthetic_delayed',
      sessionPid:42,supervisorPid:process.pid,sessionStartTicks:'1',supervisorStartTicks:'1'};
    const vault = {
      async stageCodexSetupSession() {submissions++;return {async withdraw(){withdrawals++;}};},
      async readCodexSetupSession() {
        reads++;
        if (reads === 1) return {request:f.request,state:'accepted' as const,result:null};
        if (reads === 2) {now += 31_000;return {request:f.request,state:'accepted' as const,result:null};}
        return {request:f.request,state:'accepted' as const,result};
      },
    };
    assert.deepEqual(await awaitCodexSetupSession({vault,scope:f.scope,request:f.request,leaseId:f.leaseId}),result);
    assert.equal(submissions,1);assert.equal(reads,3);assert.equal(withdrawals,1);
    assert.ok(now < Date.parse(f.request.expiresAt));
  });
});

test('accepted wait rejects invalid budgets before staging any authority', async () => {
  await fixture(async f => {
    for (const acceptedWaitMs of [0,-1,120_001,1.5,NaN,Infinity]) {
      let stages = 0;
      const vault = {...sender(f.vault),async stageCodexSetupSession() {stages++;throw new Error('unexpected_stage');}};
      await assert.rejects(awaitCodexSetupSession({vault,scope:f.scope,request:f.request,leaseId:f.leaseId,acceptedWaitMs}),/setup_session_invalid/);
      assert.equal(stages,0);
    }
  });
});

test('accepted wait cannot extend pending timeout, original expiry, or its own finite deadline', async t => {
  await fixture(async f => {
    let now = Date.now();
    t.mock.method(Date,'now',() => now);
    for (const mode of ['pending','expiry','accepted-budget'] as const) {
      now = Date.parse(f.request.issuedAt) + 1000;
      let reads = 0,stages = 0,withdrawals = 0;
      const vault = {async stageCodexSetupSession(){stages++;return {async withdraw(){withdrawals++;}};},
        async readCodexSetupSession(){
          reads++;
          if (mode === 'pending') now += 30_001;
          else if (reads === 2) now = mode === 'expiry' ? Date.parse(f.request.expiresAt) : now + 1000;
          return {request:f.request,state:'accepted' as const,result:reads === 2 ? unconfirmed : null};
        }};
      await assert.rejects(awaitCodexSetupSession({vault,scope:f.scope,request:f.request,leaseId:f.leaseId,
        acceptedWaitMs:mode === 'accepted-budget' ? 1000 : 120_000}),
      mode === 'pending' ? /setup_session_receiver_timeout/ : /setup_session_accepted_unconfirmed/);
      assert.equal(stages,1);assert.equal(withdrawals,1);assert.equal(reads,mode === 'pending' ? 1 : 2);
    }
  });
});

test('cancellation and state regression after acceptance never restage or return a late result', async () => {
  for (const mode of ['cancel','regress'] as const) await fixture(async f => {
    let reads = 0,stages = 0,withdrawals = 0;
    const vault = {async stageCodexSetupSession(){stages++;return {async withdraw(){withdrawals++;}};},
      async readCodexSetupSession(){
        reads++;
        if (reads === 2 && mode === 'cancel') f.abort();
        return {request:f.request,state:reads === 2 && mode === 'regress' ? 'pending' as const : 'accepted' as const,
          result:reads === 2 ? unconfirmed : null};
      }};
    await assert.rejects(awaitCodexSetupSession({vault,scope:f.scope,request:f.request,leaseId:f.leaseId}),
      mode === 'cancel' ? /codex_setup_host_scope_unavailable/ : /setup_session_scope_changed/);
    assert.equal(stages,1);assert.equal(reads,2);assert.equal(withdrawals,1);
  });
});

test('sender and actual standing owner share one encrypted request and a fresh child, without another dispatch', async () => {
  await fixture(async f => {
    const owner = createNamedSessionChildOwner(f.signal);
    const waiting = awaitCodexSetupSession({vault: sender(f.vault), scope: f.scope, request: f.request, leaseId: f.leaseId});
    await new Promise(resolveWait => setImmediate(resolveWait));
    let starts = 0;
    await owner.run(async () => {
      assert.equal(await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => true,
        start: scope => scope.step(async () => {
          starts++;
          const child = await owner.spawn(scope.request.name, () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'}));
          return {state: 'started', bindingId: uuid(9), sessionId: 'synthetic', sessionPid: child.pid!,
            supervisorPid: process.pid, sessionStartTicks: '1', supervisorStartTicks: '1'};
        })}), 1);
      assert.equal((await waiting).state, 'started');
      assert.equal(await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => true,
        start: async () => {starts++; return unconfirmed;}}), 0);
      assert.equal(starts, 1);
    });
  });
});

test('a serialized or out-of-context owner cannot accept or start a request', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal); let starts = 0;
    try {await assert.rejects(consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal,
      authorize: async () => true, start: async () => {starts++; return unconfirmed;}}), /setup_session_owner_unavailable/);}
    finally {await owner.close();}
    assert.equal(starts, 0); assert.equal(f.vault.readCodexSetupSession(uuid(1), digest)?.state, 'pending');
  });
});

test('policy rejection leaves pending request untouched and produces no provider effect', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal); let starts = 0;
    const failures: Readonly<CodexSetupFailureDiagnostic>[] = [];
    await owner.run(async () => {
      assert.equal(await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => false,
        onFailure: failure => {failures.push(failure);},
        start: async () => {starts++; return unconfirmed;}}), 0);
    });
    assert.equal(starts, 0); assert.equal(f.vault.readCodexSetupSession(uuid(1), digest)?.state, 'pending');
    assert.deepEqual(failures, [{schema: 'dharma.codex-setup-failure-diagnostic/v1',
      stage: 'named_session', category: 'setup_session_authorization_unconfirmed'}]);
  });
});

test('withdrawal during authorization wins over acceptance without a start', async () => {
  await fixture(async f => {
    const submission = f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal); let starts = 0;
    await owner.run(async () => {
      assert.equal(await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal,
        authorize: async () => {submission.withdraw(); return true;}, start: async () => {starts++; return unconfirmed;}}), 0);
    });
    assert.equal(starts, 0); assert.equal(f.vault.readCodexSetupSession(uuid(1), digest)?.state, 'withdrawn');
  });
});

test('post-acceptance policy change records bounded unconfirmed disposition and never repeats the start', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal); let calls = 0, starts = 0;
    await owner.run(async () => {
      assert.equal(await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => ++calls === 1,
        start: async () => {starts++; return unconfirmed;}}), 1);
      assert.deepEqual(f.vault.readCodexSetupSession(uuid(1), digest)?.result, unconfirmed);
      assert.equal(await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => true,
        start: async () => {starts++; return unconfirmed;}}), 0);
    });
    assert.equal(starts, 0);
  });
});

test('claimed process metadata cannot substitute for the standing owner fresh child', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal);
    await owner.run(async () => {
      await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => true,
        start: async () => ({state: 'started', bindingId: uuid(9), sessionId: 'foreign', sessionPid: process.pid,
          supervisorPid: process.pid, sessionStartTicks: '1', supervisorStartTicks: '1'})});
    });
    assert.deepEqual(f.vault.readCodexSetupSession(uuid(1), digest)?.result, unconfirmed);
  });
});

test('late accepted-scope descendants cannot dispatch after callback completion', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal); let retained: AcceptedSetupSessionScope | undefined, effects = 0;
    await owner.run(async () => {
      await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => true,
        start: async scope => {retained = scope; return unconfirmed;}});
      await assert.rejects(retained!.step(async () => {effects++;}), /setup_session_scope_unavailable/);
    });
    assert.equal(effects, 0);
  });
});

test('sender timeout withdraws only pending authority and never invents successful startup', async () => {
  await fixture(async f => {
    await assert.rejects(awaitCodexSetupSession({vault: sender(f.vault), scope: f.scope, request: f.request,
      leaseId: f.leaseId, waitMs: 1}), /setup_session_receiver_timeout/);
    assert.equal(f.vault.readCodexSetupSession(uuid(1), digest)?.state, 'withdrawn');
  });
});

test('accepted request without a result is distinct from a never-accepted timeout and is not withdrawn', async () => {
  await fixture(async f => {
    const wrapped = sender(f.vault);
    const staged = {...wrapped, async stageCodexSetupSession(...args: Parameters<LocalVault['stageCodexSetupSession']>) {
      const submission = await wrapped.stageCodexSetupSession(...args);
      const observation = f.vault.readCodexSetupSession(f.request.operationId, f.request.intentDigest)!;
      const {canonicalize, sha256} = await import('@dharma-ai-labs/agent-fabric-contracts');
      assert.ok(f.vault.acceptCodexSetupSession(f.request.operationId, f.request.intentDigest,
        sha256(canonicalize(observation.request))));
      return submission;
    }};
    await assert.rejects(awaitCodexSetupSession({vault: staged, scope: f.scope, request: f.request,
      leaseId: f.leaseId, acceptedWaitMs: 1}), /setup_session_accepted_unconfirmed/);
    assert.equal(f.vault.readCodexSetupSession(f.request.operationId, f.request.intentDigest)?.state, 'accepted');
  });
});

test('accepted failure retains only a fixed category after cleanup; throwing observers cannot alter its disposition', async () => {
  for (const category of ['named_session_startup_failed', 'setup_session_scope_unavailable', 'private-secret-placeholder']) {
    await fixture(async f => {
      f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
      const owner = createNamedSessionChildOwner(f.signal);
      const failures: Readonly<CodexSetupFailureDiagnostic>[] = [];
      await owner.run(async () => {
        assert.equal(await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal,
          authorize: async () => true, start: async () => {throw new Error(category);},
          onFailure: failure => {failures.push(failure); throw new Error('observer-secret-placeholder');}}), 1);
      });
      assert.deepEqual(f.vault.readCodexSetupSession(f.request.operationId, digest)?.result, unconfirmed);
      assert.deepEqual(failures, [{schema: 'dharma.codex-setup-failure-diagnostic/v1', stage: 'named_session',
        category: category === 'private-secret-placeholder' ? 'setup_runtime_unclassified' : category}]);
      assert.equal(JSON.stringify(failures).includes('secret-placeholder'), false);
    });
  }
});

test('failed accepted startup drains only its new owned child and preserves a live sibling', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal);
    await owner.run(async () => {
      const sibling = await owner.spawn('implementer', () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'}));
      let failedChild: ReturnType<typeof spawn> | undefined;
      await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => true,
        start: async scope => {
          failedChild = await owner.spawn(scope.request.name, () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'}));
          throw new Error('private-canary');
        }});
      assert.ok(failedChild); assert.ok(failedChild.exitCode !== null || failedChild.signalCode !== null);
      assert.equal(owner.ownedPid('implementer'), sibling.pid);
      assert.equal(sibling.exitCode, null); assert.equal(sibling.signalCode, null);
      assert.deepEqual(f.vault.readCodexSetupSession(uuid(1), digest)?.result, unconfirmed);
    });
  });
});

test('checkpoint cleanup does not stop a child that predates the request', async () => {
  await fixture(async f => {
    const owner = createNamedSessionChildOwner(f.signal);
    await owner.run(async () => {
      const child = await owner.spawn('reviewer', () => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio: 'ignore'}));
      const checkpoint = owner.checkpoint('reviewer');
      await checkpoint.stopFresh(); assert.equal(owner.ownedPid('reviewer'), child.pid);
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null);
    });
  });
});

test('a descendant cannot return tool results when callback settlement happens during its final policy yield', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal);
    let pauseNext = false, release!: () => void, reached!: () => void, pending: Promise<unknown> | undefined;
    const gate = new Promise<void>(resolveWait => {release = resolveWait;});
    const waiting = new Promise<void>(resolveWait => {reached = resolveWait;});
    await owner.run(async () => {
      await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal,
        authorize: async () => {if (pauseNext) {pauseNext = false; reached(); await gate;} return true;},
        start: async scope => {
          pending = scope.step(async () => {pauseNext = true; return 'synthetic-tool-result';});
          void pending.catch(() => {}); await waiting; return unconfirmed;
        }});
      release();
      await assert.rejects(pending!, /setup_session_scope_unavailable/);
    });
  });
});

test('original sender requires the admitted lease and original context; copied and settled contexts are denied', async () => {
  await fixture(async f => {
    const prepared = prepareCodexBootstrapHost({workspace: f.request.workspaceRoot, signal: f.signal, current: async () => true,
      intent: {schema: 'dharma.codex-setup-intent/v1', operationId: uuid(18), setupReference: uuid(99),
        organizationId: f.request.organizationId, recipientMembershipId: f.request.membershipId, origin: f.request.origin,
        repositoryFingerprint: digest, policyRevision: 'policy-v1', scopeDigest: digest, contractDigest: digest,
        hostContextId: uuid(19), issuedAt: f.request.issuedAt, expiresAt: f.request.expiresAt}});
    const binding = {connectionId: uuid(20), threadId: 'synthetic_thread', turnId: 'synthetic_turn', hostContextId: uuid(19)};
    let admitted = 0, late!: () => Promise<unknown>, executionError: unknown;
    const owner = createCodexSetupAdmission({...binding, intent: prepared.intent,
      current: async () => ({...binding, mode: 'setup'}), qualifyHost: async () => true,
      journal: {claim: async (id, value) => f.vault.claimCodexSetupOperation(id, value),
        read: async (id, value) => f.vault.readCodexSetupOperation(id, value),
        finish: async (id, value, result) => f.vault.finishCodexSetupOperation(id, value, result)},
      execute: async (_intent, _signal, _current, lease) => {try {return await runCodexBootstrapHostScope(prepared.scope, async () => {
        await assert.rejects(withCodexSetupSessionSender({scope: prepared.scope, vault: sender(f.vault), lease: {...lease}},
          async () => {admitted++;}), /execution_lease_unavailable/);
        await withCodexSetupSessionSender({scope: prepared.scope, vault: sender(f.vault), lease}, async () => {
          assert.equal((await originalCodexSetupSessionSender(prepared.scope)).lease, lease); admitted++;
          await assert.rejects(withCodexSetupSessionSender({scope: prepared.scope, vault: sender(f.vault), lease},
            async () => {admitted++;}), /sender_conflict/);
          late = () => originalCodexSetupSessionSender(prepared.scope);
        });
        await assert.rejects(late(), /sender_unavailable/);
        return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
      });} catch (error) {executionError = error; throw error;}}, verifyReadiness: async () => false});
    try {
      const result = await owner.handler({threadId: binding.threadId, turnId: binding.turnId, callId: 'synthetic_call',
        tool: 'dharma_setup_reference', namespace: null, arguments: {operationId: uuid(18), setupReference: uuid(99)}},
        {signal: f.signal});
      await owner.settled;
      if (executionError) throw executionError;
      assert.equal(result.success, false); assert.equal(admitted, 1);
      await assert.rejects(late(), /sender_unavailable/);
    } finally {owner.close(); await owner.settled; prepared.scope.close();}
  });
});

test('accepted receiver descendants retain a closed context instead of falling back to unscoped authority', async () => {
  await fixture(async f => {
    f.vault.stageCodexSetupSession(f.leaseId, digest, f.request);
    const owner = createNamedSessionChildOwner(f.signal);
    let release!: () => void, pending!: Promise<void>, effects = 0;
    const gate = new Promise<void>(done => {release = done;});
    await owner.run(async () => {
      await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => true,
        start: async scope => {
          assert.equal(currentAcceptedSetupSessionScope(), scope);
          pending = (async () => {await gate;
            assert.equal(currentAcceptedSetupSessionScope(), scope);
            await assert.rejects(currentAcceptedSetupSessionScope()!.step(async () => {effects++;}), /scope_unavailable/);
          })();
          return unconfirmed;
        }});
      assert.equal(currentAcceptedSetupSessionScope(), undefined);
      release(); await pending; assert.equal(effects, 0);
    });
  });
});
