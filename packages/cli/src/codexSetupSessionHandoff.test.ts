import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {LocalVault, type LocalCodexSetupSessionRequest, type LocalCodexSetupSessionResult} from '@dharma-ai-labs/agent-fabric-local-vault';
import type {BootstrapHostScope} from './bootstrapHostScope.js';
import {createNamedSessionChildOwner} from './namedSessionChildOwner.js';
import {awaitCodexSetupSession, consumeCodexSetupSessions, type AcceptedSetupSessionScope} from './codexSetupSessionHandoff.js';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const digest = `sha256:${'a'.repeat(64)}`;
async function fixture(run: (f: {vault: LocalVault; request: LocalCodexSetupSessionRequest; leaseId: string;
  signal: AbortSignal; abort(): void; scope: BootstrapHostScope}) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-session-supervisor-'));
  const vault = await LocalVault.open({root, masterKey: randomBytes(32)}), controller = new AbortController();
  const claim = vault.claimCodexSetupOperation(uuid(1), digest);
  if (claim.state !== 'acquired') throw new Error('fixture_claim_missing');
  const request: LocalCodexSetupSessionRequest = {schema: 'dharma.local-codex-setup-session/v1', operationId: uuid(1),
    intentDigest: digest, organizationId: 'org_demo', membershipId: uuid(2), deviceId: uuid(3), workspaceId: uuid(4),
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
    await owner.run(async () => {
      assert.equal(await consumeCodexSetupSessions({vault: f.vault, owner, signal: f.signal, authorize: async () => false,
        start: async () => {starts++; return unconfirmed;}}), 0);
    });
    assert.equal(starts, 0); assert.equal(f.vault.readCodexSetupSession(uuid(1), digest)?.state, 'pending');
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
      leaseId: f.leaseId, waitMs: 1}), /setup_session_start_unconfirmed/);
    assert.equal(f.vault.readCodexSetupSession(uuid(1), digest)?.state, 'withdrawn');
  });
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
