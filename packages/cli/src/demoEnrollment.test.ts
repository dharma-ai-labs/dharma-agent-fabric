import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import type { SecureSecretStore } from '@dharma-ai-labs/agent-fabric-relay-client';
import { connectDemoDevice, verifyDemoDevice } from './demoEnrollment.js';
import { run } from './index.js';

const orgId = 'org_fixture';
const repositoryId = '10000000-0000-4000-8000-000000000001';
const deviceId = '30000000-0000-4000-8000-000000000001';
const grant = 'A'.repeat(43);
const deviceCode = 'B'.repeat(43);
const browserCode = 'ABCDEF0123456789ABCD';
const normalizedRepository = 'github.com/example/private';
const hqUrl = 'https://dharma.example';

function memoryStore(): SecureSecretStore {
  const values = new Map<string, string>();
  return { backend: 'linux-secret-service',
    async get(account) { return values.get(account) || null; },
    async put(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); } };
}

function options(stateRoot: string) {
  return { hqUrl, organizationId: orgId, repositoryId, normalizedRepository,
    grant, deviceName: 'Fixture laptop', platform: 'linux' as const,
    installationId: '40000000-0000-4000-8000-000000000001',
    stateRoot, maximumWaitMs: 1_000 };
}

test('Demo enrollment verifies the browser origin, waits for approval and signs a scoped status request', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-cli-'));
  const calls: string[] = [];
  let publicKey = '';
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    calls.push(url.pathname);
    if (url.pathname.endsWith('/enrollments')) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      assert.equal(body.grant, grant);
      assert.equal(body.repositoryId, repositoryId);
      publicKey = body.publicKeyEd25519!;
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      assert.deepEqual(JSON.parse(String(init?.body)), { orgId, deviceCode });
      return new Response(JSON.stringify({ ok: true, status: 'approved',
        deviceId, repositoryId }), { status: 200 });
    }
    assert.equal(url.pathname,
      `/api/demo/fabric/repositories/${repositoryId}/status`);
    const headers = new Headers(init?.headers);
    const signingPayload = Buffer.from(JSON.stringify({
      bodyHash: `sha256:${createHash('sha256').update('').digest('hex')}`,
      deviceId,
      messageId: headers.get('x-dharma-message-id'),
      method: 'GET',
      nonce: headers.get('x-dharma-nonce'),
      organizationId: orgId,
      pathname: `${url.pathname}${url.search}`,
      sequence: Number(headers.get('x-dharma-sequence')),
      sessionId: headers.get('x-dharma-session-id'),
      timestamp: headers.get('x-dharma-timestamp'),
    }));
    assert.equal(verify(null, signingPayload,
      createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' }),
      Buffer.from(headers.get('x-dharma-signature')!, 'base64url')), true);
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const approvals: string[] = [];
  const connected = await connectDemoDevice(options(stateRoot), {
    store: memoryStore(), fetcher, sleep: async () => {},
    onApprovalRequired: async (url) => { approvals.push(url); },
  });
  assert.equal(connected.stage, 'device_signed_ready');
  assert.equal(connected.deviceId, deviceId);
  assert.deepEqual(calls, ['/api/demo/fabric/enrollments',
    '/api/demo/fabric/enrollments/poll', `/api/demo/fabric/repositories/${repositoryId}/status`]);
  assert.equal(approvals.length, 1);
  assert.equal(new URL(approvals[0]!).origin, hqUrl);
  const config = JSON.parse(await readFile(connected.configPath, 'utf8')) as Record<string, unknown>;
  assert.equal(config.deviceId, deviceId);
  assert.equal(config.grant, undefined);
  assert.equal(config.privateKey, undefined);
  if (process.platform !== 'win32') assert.equal((await stat(connected.configPath)).mode & 0o777, 0o600);
});

test('Demo enrollment rejects an off-origin approval link before opening a browser or saving a device', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-cli-invalid-'));
  let opened = false;
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ ok: true, status: 'pending',
    organizationId: orgId, repositoryId, deviceCode,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    verificationUri: `https://attacker.example/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
  { status: 202 });
  await assert.rejects(connectDemoDevice(options(stateRoot), { store: memoryStore(), fetcher,
    onApprovalRequired: async () => { opened = true; } }), /verification origin/i);
  assert.equal(opened, false);
});

test('Demo command dry-run verifies the local repository without a grant or device write', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'dharma-demo-repo-'));
  const home = await mkdtemp(resolve(tmpdir(), 'dharma-demo-home-'));
  execFileSync('git', ['init', root]);
  execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:Example/Private.git']);
  const previous = process.env.DHARMA_HOME;
  process.env.DHARMA_HOME = home;
  try {
    const receipt = await run(['demo', 'connect', '--dry-run', '--workspace', root,
      '--portal-url', hqUrl, '--organization-id', orgId,
      '--repository-id', repositoryId, '--normalized-repository', normalizedRepository]);
    assert.equal((receipt as { stage: string }).stage, 'demo_device_plan');
    for (const command of ['status', 'role', 'peers', 'ask', 'reply', 'inbox', 'ack', 'resume']) {
      const peerPlan = await run(['demo', command, '--dry-run', '--workspace', root,
        '--portal-url', hqUrl, '--organization-id', orgId,
        '--repository-id', repositoryId, '--normalized-repository', normalizedRepository]);
      assert.equal((peerPlan as { stage: string }).stage, 'demo_device_plan');
    }
    await assert.rejects(stat(resolve(home, 'installation.json')), { code: 'ENOENT' });
    await assert.rejects(run(['demo', 'connect', '--dry-run', '--workspace', root,
      '--portal-url', hqUrl, '--organization-id', orgId,
      '--repository-id', repositoryId, '--normalized-repository', 'github.com/other/repo']),
    /does not match/);
  } finally {
    if (previous === undefined) delete process.env.DHARMA_HOME;
    else process.env.DHARMA_HOME = previous;
  }
});

test('lost status response resumes grant-free with exact replay, then retries an unseen expired sequence', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-recovery-'));
  const store = memoryStore();
  const signed: Headers[] = [];
  let loseResponse = true;
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify({ ok: true, status: 'approved', deviceId, repositoryId }),
        { status: 200 });
    }
    signed.push(new Headers(init?.headers));
    if (loseResponse) { loseResponse = false; throw new Error('connection lost after dispatch'); }
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository, duplicate: signed.length === 2 }), { status: 200 });
  };
  await assert.rejects(connectDemoDevice(options(stateRoot), { store, fetcher }),
    /connection lost/);
  const directory = resolve(stateRoot, 'demo', (await readdir(resolve(stateRoot, 'demo')))[0]!);
  const configPath = resolve(directory, 'device.json');
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { signedReady: boolean }).signedReady, false);
  const scope = options(stateRoot);
  const recovered = await verifyDemoDevice(scope, { store, fetcher });
  assert.equal(recovered.stage, 'device_signed_ready');
  assert.equal(signed[0]!.get('x-dharma-message-id'), signed[1]!.get('x-dharma-message-id'));
  assert.equal(signed[1]!.get('x-dharma-sequence'), '1');

  const pendingPath = `${configPath}.pending-status.json`;
  const pending = { url: `${hqUrl}/api/demo/fabric/repositories/${repositoryId}/status?orgId=${orgId}`,
    deviceId, sequence: 2, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    headers: {} };
  await writeFile(pendingPath, JSON.stringify(pending));
  const recoveredAfterExpiry = await verifyDemoDevice(scope, { store, fetcher });
  assert.equal(recoveredAfterExpiry.stage, 'device_signed_ready');
  assert.equal(signed.at(-1)!.get('x-dharma-sequence'), '2');
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { nextSequence: number }).nextSequence, 3);
});

test('expired status advances once only after a typed sequence conflict', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-expired-'));
  const store = memoryStore();
  const sequences: number[] = [];
  let acceptedSequence = 0;
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify({ ok: true, status: 'approved', deviceId, repositoryId }),
        { status: 200 });
    }
    const sequence = Number(new Headers(init?.headers).get('x-dharma-sequence'));
    sequences.push(sequence);
    if (sequence !== acceptedSequence + 1) {
      return new Response(JSON.stringify({ ok: false, error: {
        code: 'demo_fabric_sequence_out_of_order', message: 'Device sequence is out of order.',
      } }), { status: 409 });
    }
    acceptedSequence = sequence;
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const connected = await connectDemoDevice(options(stateRoot), { store, fetcher });
  assert.equal(acceptedSequence, 1);
  const configPath = connected.configPath;
  const pendingPath = `${configPath}.pending-status.json`;
  await writeFile(pendingPath, JSON.stringify({
    url: `${hqUrl}/api/demo/fabric/repositories/${repositoryId}/status?orgId=${orgId}`,
    deviceId, sequence: 2, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), headers: {},
  }));
  acceptedSequence = 2;
  const recovered = await verifyDemoDevice(options(stateRoot), { store, fetcher });
  assert.equal(recovered.stage, 'device_signed_ready');
  assert.deepEqual(sequences, [1, 2, 3]);
  assert.equal((JSON.parse(await readFile(configPath, 'utf8')) as { nextSequence: number }).nextSequence, 4);
});

test('a 0.2.81 pending sequence that skipped an unseen request recovers without another grant', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-legacy-gap-'));
  const store = memoryStore();
  const sequences: number[] = [];
  let lastAccepted = 0;
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify({ ok: true, status: 'approved', deviceId, repositoryId }),
        { status: 200 });
    }
    const sequence = Number(new Headers(init?.headers).get('x-dharma-sequence'));
    sequences.push(sequence);
    if (sequence !== lastAccepted + 1) {
      return new Response(JSON.stringify({ ok: false, error: {
        code: 'demo_fabric_sequence_out_of_order', message: 'Device sequence is out of order.',
      } }), { status: 409 });
    }
    lastAccepted = sequence;
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const connected = await connectDemoDevice(options(stateRoot), { store, fetcher });
  await writeFile(`${connected.configPath}.pending-status.json`, JSON.stringify({
    url: `${hqUrl}/api/demo/fabric/repositories/${repositoryId}/status?orgId=${orgId}`,
    deviceId, sequence: 3, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), headers: {},
  }));
  const recovered = await verifyDemoDevice(options(stateRoot), { store, fetcher });
  assert.equal(recovered.stage, 'device_signed_ready');
  assert.deepEqual(sequences, [1, 3, 2]);
  assert.equal((JSON.parse(await readFile(connected.configPath, 'utf8')) as { nextSequence: number }).nextSequence, 3);
});

test('expired status does not advance on an unrelated conflict', async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), 'dharma-demo-conflict-'));
  const store = memoryStore();
  const sequences: number[] = [];
  const fetcher: typeof fetch = async (resource, init) => {
    const url = new URL(String(resource));
    if (url.pathname.endsWith('/enrollments')) {
      return new Response(JSON.stringify({ ok: true, status: 'pending', organizationId: orgId,
        repositoryId, deviceCode, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        verificationUri: `${hqUrl}/demo/fabric/approve?orgId=${orgId}&repositoryId=${repositoryId}&code=${browserCode}` }),
      { status: 202 });
    }
    if (url.pathname.endsWith('/poll')) {
      return new Response(JSON.stringify({ ok: true, status: 'approved', deviceId, repositoryId }),
        { status: 200 });
    }
    const sequence = Number(new Headers(init?.headers).get('x-dharma-sequence'));
    sequences.push(sequence);
    if (sequence > 1) return new Response(JSON.stringify({ ok: false, error: {
      code: 'demo_fabric_message_replay_conflict', message: 'Message conflict.',
    } }), { status: 409 });
    return new Response(JSON.stringify({ ok: true, organizationId: orgId, repositoryId,
      deviceId, normalizedRepository }), { status: 200 });
  };
  const connected = await connectDemoDevice(options(stateRoot), { store, fetcher });
  const pendingPath = `${connected.configPath}.pending-status.json`;
  await writeFile(pendingPath, JSON.stringify({
    url: `${hqUrl}/api/demo/fabric/repositories/${repositoryId}/status?orgId=${orgId}`,
    deviceId, sequence: 2, createdAt: new Date(Date.now() - 5 * 60_000).toISOString(), headers: {},
  }));
  await assert.rejects(verifyDemoDevice(options(stateRoot), { store, fetcher }),
    /demo_fabric_message_replay_conflict/);
  assert.deepEqual(sequences, [1, 2]);
  assert.equal((JSON.parse(await readFile(connected.configPath, 'utf8')) as { nextSequence: number }).nextSequence, 2);
});
