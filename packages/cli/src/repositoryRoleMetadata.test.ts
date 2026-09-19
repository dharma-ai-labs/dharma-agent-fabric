import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalize, validateContract } from '@dharma-ai-labs/agent-fabric-contracts';
import {
  registerRepositoryRoleMetadata, discoverRepositoryRoleMetadata,
  type RepositoryRoleScope, type RepositoryRoleTransport,
} from './repositoryRoleMetadata.js';

const scope: RepositoryRoleScope = {
  organizationId: 'org_role_fixture', workspaceId: '056b63dc-ebed-48ed-85d8-02c72f623ea8',
  repositoryBindingId: '73a95988-fd64-41ba-a0b9-6c8867d03788',
  repositoryAgentId: '57f61652-a5eb-46e4-930c-9478cd4a9c31',
  endpointId: 'c5f92580-75c8-43f2-a8a5-55fbf3f660b0', sourceFingerprint: `sha256:${'a'.repeat(64)}`,
};
const input = { expectedRevision: 0, roleName: 'Verifier specialist',
  questionCategories: ['verifier-design'], description: 'Helps peers with deterministic verifier design.' };
function roleResponse() {
  return {
    ok: true, organizationId: scope.organizationId, correlationId: 'fixture-correlation',
    registration: {
      role: { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
        endpointId: scope.endpointId, repositoryBindingId: scope.repositoryBindingId,
        repositoryAgentId: scope.repositoryAgentId, roleName: input.roleName,
        questionCategories: [...input.questionCategories], description: input.description, revision: 1 },
      revision: 1, replay: false,
    },
  };
}
function peer(index = 0) {
  return {
    endpointId: `c5f92580-75c8-43f2-a8a5-${String(index + 1).padStart(12, '0')}`,
    workspaceId: 'df5a4f3b-d44e-4a46-8c03-b82c10c58a83', provider: 'claude',
    roleName: input.roleName, questionCategories: [...input.questionCategories], description: input.description, revision: 1,
  };
}
function discoveryResponse(peers = [peer()]) {
  return {
    ok: true, organizationId: scope.organizationId, correlationId: 'fixture-correlation',
    discovery: { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
      repositoryBindingId: scope.repositoryBindingId, repositoryAgentId: scope.repositoryAgentId,
      peers, limit: 50, possiblyTruncated: peers.length === 50 },
  };
}
function fixture(response: Record<string, unknown>) {
  const calls: Array<{ method: string; route: string; body?: unknown }> = [];
  const transport: RepositoryRoleTransport = {
    signedGet: async route => { calls.push({ method: 'GET', route }); return response; },
    signedPost: async (route, body) => { calls.push({ method: 'POST', route, body }); return response; },
  };
  return { calls, transport };
}
async function schema(value: unknown) {
  const checked = await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)), 'dharma.repository-role-metadata/v1', value);
  assert.equal(checked.ok, true, checked.ok ? undefined : JSON.stringify(checked.errors));
}

test('role registration observes the exact device-scoped server receipt without claiming communication readiness', async () => {
  const f = fixture(roleResponse());
  const result = await registerRepositoryRoleMetadata(f.transport, scope, input);
  assert.equal(result.stage, 'repository_role_observed');
  assert.deepEqual(f.calls, [{ method: 'POST', route: '/agent-fabric/repository-roles', body: {
    workspaceId: scope.workspaceId, endpointId: scope.endpointId, ...input,
  } }]);
  assert.equal(result.role?.revision, 1);
  assert.equal(result.sharedRepositoryReady, false);
  assert.equal(result.communicationReady, false);
  assert.equal(result.sourceFingerprintVerified, false);
  assert.equal(result.contactAuthority, false);
  await schema(result);
});

test('role discovery observes peers in another workspace on the same binding using an empty-body signed GET', async () => {
  const f = fixture(discoveryResponse());
  const result = await discoverRepositoryRoleMetadata(f.transport, scope);
  assert.equal(result.stage, 'repository_role_observed');
  assert.deepEqual(f.calls, [{ method: 'GET', route: `/agent-fabric/repository-roles?workspaceId=${scope.workspaceId}` }]);
  assert.deepEqual(result.discovery?.peers, [peer()]);
  assert.equal(result.discovery?.catalogComplete, true);
  assert.equal(result.presence, 'unavailable');
  assert.equal(result.currentAuthorizationVerified, false);
  assert.equal(result.communicationReady, false);
  await schema(result);
});

test('role discovery encodes a canonical category and never supplies the derived receipt payload as a GET body', async () => {
  const f = fixture(discoveryResponse());
  await discoverRepositoryRoleMetadata(f.transport, scope, 'verifier-design');
  assert.deepEqual(f.calls, [{ method: 'GET', route: `/agent-fabric/repository-roles?workspaceId=${scope.workspaceId}&category=verifier-design` }]);
});

test('role discovery at the server cap remains explicitly incomplete without invented presence or contact rights', async () => {
  const f = fixture(discoveryResponse(Array.from({ length: 50 }, (_, i) => peer(i))));
  const result = await discoverRepositoryRoleMetadata(f.transport, scope);
  assert.equal(result.discovery?.catalogComplete, false);
  assert.equal(result.discovery?.possiblyTruncated, true);
  assert.equal(result.contactAuthority, false);
  await schema(result);
});

test('empty repository peer discovery is an observed empty set, not a ready communication channel', async () => {
  const f = fixture(discoveryResponse([]));
  const result = await discoverRepositoryRoleMetadata(f.transport, scope);
  assert.deepEqual(result.discovery?.peers, []);
  assert.equal(result.communicationReady, false);
  await schema(result);
});

test('role registration rejects foreign scope fields and inconsistent revisions in server responses', async () => {
  for (const key of ['organizationId', 'workspaceId', 'repositoryBindingId', 'repositoryAgentId', 'endpointId'] as const) {
    const response = roleResponse(); response.registration.role[key] = key === 'organizationId' ? 'org_foreign' : 'fd5a4f3b-d44e-4a46-8c03-b82c10c58a83';
    await assert.rejects(() => registerRepositoryRoleMetadata(fixture(response).transport, scope, input), /role.*response/i);
  }
  const response = roleResponse(); response.registration.revision = 2;
  await assert.rejects(() => registerRepositoryRoleMetadata(fixture(response).transport, scope, input), /role.*response/i);
});

test('role registration rejects altered expertise text or categories instead of adopting a mismatched operation', async () => {
  for (const key of ['roleName', 'description', 'questionCategories'] as const) {
    const response = roleResponse();
    if (key === 'questionCategories') response.registration.role[key] = ['unrequested'];
    else response.registration.role[key] = 'Unrequested role content';
    await assert.rejects(() => registerRepositoryRoleMetadata(fixture(response).transport, scope, input), /role.*response/i);
  }
});

test('role discovery rejects foreign container scope without using an organization-wide fallback', async () => {
  for (const key of ['organizationId', 'workspaceId', 'repositoryBindingId', 'repositoryAgentId'] as const) {
    const response = discoveryResponse(); response.discovery[key] = key === 'organizationId' ? 'org_foreign' : 'fd5a4f3b-d44e-4a46-8c03-b82c10c58a83';
    await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(response).transport, scope), /role.*response/i);
  }
});

test('role discovery rejects duplicate endpoints, malformed peers and unknown provider capabilities', async () => {
  const duplicate = discoveryResponse([peer(), peer()]);
  await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(duplicate).transport, scope), /role.*response/i);
  for (const changes of [{ endpointId: 'not-uuid' }, { workspaceId: `${peer().workspaceId}\n` },
    { provider: 'unknown-provider' }, { roleName: '' }, { questionCategories: ['verifier-design\n'] }, { revision: 0 }]) {
    const response = discoveryResponse([{ ...peer(), ...changes }]);
    await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(response).transport, scope), /role.*response/i);
  }
});

test('role discovery rejects inconsistent truncation and limits instead of claiming a complete catalog', async () => {
  for (const changes of [{ limit: 49 }, { possiblyTruncated: true }, { possiblyTruncated: 'false' }]) {
    const response = discoveryResponse(); Object.assign(response.discovery, changes);
    await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(response).transport, scope), /role.*response/i);
  }
  const response = discoveryResponse(Array.from({ length: 51 }, (_, i) => peer(i)));
  await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(response).transport, scope), /role.*response/i);
});

test('role adapters reject malformed scope before dispatch, including newline identities and missing fingerprint', async () => {
  for (const changes of [{ workspaceId: `${scope.workspaceId}\n` }, { endpointId: 'not-uuid' },
    { sourceFingerprint: '' }, { repositoryBindingId: '' }, { organizationId: 'org_fixture\n' }]) {
    const f = fixture(roleResponse());
    await assert.rejects(() => registerRepositoryRoleMetadata(f.transport, { ...scope, ...changes }, input), /role.*scope/i);
    assert.equal(f.calls.length, 0);
  }
});

test('role adapters reject invalid expertise fields and query categories before dispatch', async () => {
  for (const changes of [{ expectedRevision: -1 }, { expectedRevision: 2147483647 }, { roleName: '' },
    { description: 'x'.repeat(1025) }, { questionCategories: ['verifier-design', 'verifier-design'] },
    { questionCategories: ['verifier-design\n'] }]) {
    const f = fixture(roleResponse());
    await assert.rejects(() => registerRepositoryRoleMetadata(f.transport, scope, { ...input, ...changes }), /role.*input/i);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(discoveryResponse());
  await assert.rejects(() => discoverRepositoryRoleMetadata(f.transport, scope, 'bad category'), /role.*input/i);
  assert.equal(f.calls.length, 0);
});

test('role response boundary rejects accessors and proxies without executing their traps', async () => {
  let hits = 0;
  const response = roleResponse(); Object.defineProperty(response, 'ok', { get() { hits += 1; return true; } });
  await assert.rejects(() => registerRepositoryRoleMetadata(fixture(response).transport, scope, input), /role.*response/i);
  const proxy = new Proxy(roleResponse(), { getOwnPropertyDescriptor() { hits += 1; throw new Error('trap'); } });
  await assert.rejects(() => registerRepositoryRoleMetadata(fixture(proxy).transport, scope, input), /role.*response/i);
  assert.equal(hits, 0);
});

test('role response boundary rejects inherited descriptor values without invoking prototype getters', async () => {
  let hits = 0;
  const response = roleResponse();
  Object.defineProperty(response, 'ok', { enumerable: true, configurable: true, get() { hits += 1; return true; } });
  let rejection: unknown;
  Object.defineProperty(Object.prototype, 'value', { configurable: true, get() { hits += 1; return true; } });
  try {
    await registerRepositoryRoleMetadata(fixture(response).transport, scope, input).catch(error => { rejection = error; });
  } finally { delete (Object.prototype as { value?: unknown }).value; }
  assert.match(String(rejection), /role.*response/i);
  assert.equal(hits, 0);
});

test('role adapters propagate unavailable authenticated transport without treating absence as an empty catalog', async () => {
  const transport: RepositoryRoleTransport = {
    signedGet: async () => { throw new Error('transport_unavailable'); },
    signedPost: async () => { throw new Error('transport_unavailable'); },
  };
  await assert.rejects(() => registerRepositoryRoleMetadata(transport, scope, input), /transport_unavailable/);
  await assert.rejects(() => discoverRepositoryRoleMetadata(transport, scope), /transport_unavailable/);
});

test('role registration accepts a matching replay receipt without promoting it to live authorization proof', async () => {
  const response = roleResponse(); response.registration.replay = true;
  const result = await registerRepositoryRoleMetadata(fixture(response).transport, scope, input);
  assert.equal(result.role?.revision, 1);
  assert.equal(result.currentAuthorizationVerified, false);
  assert.equal(result.communicationReady, false);
  await schema(result);
});

test('role metadata clones accepted values so later response mutation cannot change the observed profile', async () => {
  const response = roleResponse();
  const result = await registerRepositoryRoleMetadata(fixture(response).transport, scope, input);
  response.registration.role.roleName = 'Changed later';
  assert.equal(result.role?.roleName, input.roleName);
});

test('role metadata records a unique local observation with a verifiable hash, not a server signature', async () => {
  const result = await registerRepositoryRoleMetadata(fixture(roleResponse()).transport, scope, input);
  const other = await registerRepositoryRoleMetadata(fixture(roleResponse()).transport, scope, input);
  assert.notEqual(result.observationId, other.observationId);
  assert.equal(new Date(result.observedAt).toISOString(), result.observedAt);
  assert.equal(result.integrity.kind, 'local_hash_not_signature');
  assert.equal(result.integrity.sha256, `sha256:${createHash('sha256').update(canonicalize({ scope: result.scope,
    operation: result.operation, role: result.role, discovery: result.discovery })).digest('hex')}`);
  await schema(result);
});

test('role metadata rejects unknown fields, malformed truth values and non-metadata payloads', async () => {
  for (const response of [{ ...roleResponse(), ok: 'true' }, { ...roleResponse(), error: 'unexpected' },
    { ...roleResponse(), organizationId: 'org_foreign' }, { ...roleResponse(), registration: {} },
    { ...roleResponse(), correlationId: 'unsafe\nreference' }]) {
    await assert.rejects(() => registerRepositoryRoleMetadata(fixture(response).transport, scope, input), /role.*response/i);
  }
  const response = roleResponse(); Object.assign(response.registration.role, { privateTranscript: 'not metadata' });
  await assert.rejects(() => registerRepositoryRoleMetadata(fixture(response).transport, scope, input), /role.*response/i);
});

test('role metadata blocks common secrets and local paths before sending expertise metadata', async () => {
  for (const description of ['api_key=abcdef1234567890', 'Bearer abcdef1234567890', 'Uses C:\\Users\\private\\data',
    'Uses /home/private/data', 'github_pat_abcdefghijklmnopqrstuvwxyz1234567890']) {
    const f = fixture(roleResponse());
    await assert.rejects(() => registerRepositoryRoleMetadata(f.transport, scope, { ...input, description }), /role.*input/i);
    assert.equal(f.calls.length, 0);
  }
});

test('role discovery rejects a mismatched category or forged self-workspace attribution', async () => {
  await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(discoveryResponse()).transport, scope, 'another-category'), /role.*response/i);
  const response = discoveryResponse([{ ...peer(), endpointId: scope.endpointId }]);
  await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(response).transport, scope), /role.*response/i);
});

test('role metadata canonicalizes submitted categories without accepting noncanonical server categories', async () => {
  const response = roleResponse(); response.registration.role.questionCategories = ['a-category', 'z-category'];
  const f = fixture(response);
  const result = await registerRepositoryRoleMetadata(f.transport, scope, { ...input, questionCategories: ['z-category', 'a-category'] });
  assert.deepEqual((f.calls[0]?.body as Record<string, unknown>).questionCategories, ['a-category', 'z-category']);
  assert.deepEqual(result.role?.questionCategories, ['a-category', 'z-category']);
  response.registration.role.questionCategories = ['z-category', 'a-category'];
  await assert.rejects(() => registerRepositoryRoleMetadata(fixture(response).transport, scope, { ...input, questionCategories: ['z-category', 'a-category'] }), /role.*response/i);
});

test('role metadata detaches expected expertise from transport-side mutation while awaiting a receipt', async () => {
  const transport: RepositoryRoleTransport = {
    signedGet: async () => discoveryResponse(),
    signedPost: async (_route, body) => {
      const sent = body as Record<string, unknown>;
      (sent.questionCategories as string[]).push('unrequested');
      return roleResponse();
    },
  };
  const result = await registerRepositoryRoleMetadata(transport, scope, input);
  assert.deepEqual(result.role?.questionCategories, input.questionCategories);
  assert.deepEqual(input.questionCategories, ['verifier-design']);
});

test('role metadata rejects cyclic, sparse and inherited-hook responses without serialization side effects', async () => {
  let hits = 0;
  const cyclic: Record<string, unknown> = roleResponse(); cyclic.loop = cyclic;
  await assert.rejects(() => registerRepositoryRoleMetadata(fixture(cyclic).transport, scope, input), /role.*response/i);
  const sparse = discoveryResponse(); sparse.discovery.peers = Array(2);
  await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(sparse).transport, scope), /role.*response/i);
  const hooked = Object.assign(Object.create({ toJSON() { hits += 1; return roleResponse(); } }), roleResponse());
  await assert.rejects(() => registerRepositoryRoleMetadata(fixture(hooked).transport, scope, input), /role.*response/i);
  assert.equal(hits, 0);
});

test('role discovery rejects non-string providers without running coercion hooks', async () => {
  let hits = 0;
  const response = discoveryResponse();
  Object.assign(response.discovery.peers[0]!, { provider: { toString() { hits += 1; return 'claude'; } } });
  await assert.rejects(() => discoverRepositoryRoleMetadata(fixture(response).transport, scope), /role.*response/i);
  assert.equal(hits, 0);
});

test('role metadata schema rejects promoted authority and malformed receipt fields', async () => {
  const result = await registerRepositoryRoleMetadata(fixture(roleResponse()).transport, scope, input);
  for (const changed of [{ ...result, communicationReady: true }, { ...result, contactAuthority: true },
    { ...result, sourceFingerprintVerified: true }, { ...result, observationId: `${result.observationId}\n` },
    { ...result, observedAt: 'not-a-time' }, { ...result, role: { ...result.role, questionCategories: ['duplicate', 'duplicate'] } }]) {
    const checked = await validateContract(fileURLToPath(new URL('./schemas/', import.meta.url)), 'dharma.repository-role-metadata/v1', changed);
    assert.equal(checked.ok, false);
  }
});
