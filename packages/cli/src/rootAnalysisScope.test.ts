import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import { planRootAnalysisScope } from './rootAnalysisScope.js';

const id = (n: number) => `79000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const pair = generateKeyPairSync('ed25519'), now = new Date('2026-10-19T14:20:00Z');
const host = { mcpOrigin: 'https://mcp.dharma-ai.io', mcpPath: '/mcp', appId: 'app_fixture', appVersion: '1.0.0', deploymentId: 'deployment_fixture',
  sourceSha: 'a'.repeat(40), registrationRevision: 'registration_fixture', schemaHash: 'sha256:' + 'b'.repeat(64),
  adapterId: 'fixture-root-adapter', adapterVersion: '1.0.0', selectedLinkId: 'link_fixture' };
const expected = { organizationId: 'org_fixture', membershipId: id(1), bindingId: id(2), policyRevision: 'fixture-policy-v3',
  rootIdentity: 'fixture-root-thread', targetKind: 'agent', targetId: id(4), host,
  publicKeyEd25519: pair.publicKey.export({ format: 'jwk' }).x! };
function signed(patch: Record<string, unknown> = {}) {
  const body = { schema: 'dharma.root-analysis-provenance/v1', recordId: id(3), organizationId: 'org_fixture',
    membershipId: id(1), membershipStatus: 'active', bindingId: id(2), policyRevision: 'fixture-policy-v3',
    rootIdentity: 'fixture-root-thread', targetKind: 'agent', targetId: id(4), host,
    registeredSelectors: ['scopeMode', 'organizationAgentIds', 'endpointIds', 'trajectoryTarget'],
    observedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString(), ...patch };
  return { ...body, signature: sign(null, Buffer.from(canonicalize(body)), pair.privateKey).toString('base64url') };
}
const plan = (provenance: unknown, changes = {}) => planRootAnalysisScope({ provenance, expected: { ...expected, ...changes }, now });

test('B01 exact same-org logical root yields only an explicit agents scope plan', async () => {
  const result = await plan(signed()); assert.equal(result.ok, true);
  assert.deepEqual(result.scope, { mode: 'agents', organizationAgentIds: [id(4)], endpointIds: [] });
  assert.equal(result.analysisInvoked, false); assert.equal(result.effects, false); assert.equal(result.requestAdmitted, false);
});
test('B02 endpoint scope cannot silently become organization or logical-agent scope', async () => {
  const result = await plan(signed({ targetKind: 'endpoint' }), { targetKind: 'endpoint' });
  assert.deepEqual(result.scope, { mode: 'endpoints', organizationAgentIds: [], endpointIds: [id(4)] });
  assert.equal(result.analysisInvoked, false);
});
test('B03 missing tuple, ambiguous root or unknown host revision fail before request admission', async () => {
  for (const value of [undefined, null, {}, signed({ host: {} }), signed({ targetKind: 'organization' }),
    signed({ targetId: [id(4), id(5)] }), signed({ rootIdentity: '' })]) {
    const result = await plan(value); assert.equal(result.ok, false); assert.equal(result.scope, null);
    assert.equal(result.analysisInvoked, false); assert.equal(result.requestAdmitted, false);
  }
});
test('B07 source selectors do not cure a connected registration omitting those fields', async () => {
  for (const registeredSelectors of [[], ['confirmed', 'idempotencyKey', 'link_id', 'organizationId', 'retryWindowId'],
    ['scopeMode', 'organizationAgentIds', 'endpointIds']]) {
    const result = await plan(signed({ registeredSelectors }));
    assert.equal(result.ok, false); assert.equal(result.code, 'root_analysis_selector_contract_unavailable');
    assert.equal(result.scope, null); assert.equal(result.analysisInvoked, false);
  }
});
test('B04 same origin cannot substitute a draft app, different account, source, adapter or policy', async () => {
  for (const patch of [{ organizationId: 'org_foreign' }, { membershipId: id(9) }, { membershipStatus: 'inactive' },
    { policyRevision: 'foreign' }, { bindingId: id(9) }, { host: { ...host, appId: 'draft_app' } },
    { host: { ...host, sourceSha: 'c'.repeat(40) } }, { host: { ...host, adapterVersion: '2.0.0' } },
    { host: { ...host, selectedLinkId: 'foreign_link' } }]) {
    assert.equal((await plan(signed(patch))).ok, false);
  }
});
test('expired, tampered, extra secret fields and unsigned metadata are not provenance', async () => {
  const receipt = signed();
  for (const value of [{ ...receipt, signature: 'not-a-signature' }, { ...receipt, targetId: id(9) },
    signed({ expiresAt: now.toISOString() }), signed({ token: 'synthetic-no-echo' }), { ...receipt, signature: undefined }]) {
    const result = await plan(value); assert.equal(result.ok, false); assert.equal(result.effects, false);
    assert.equal(JSON.stringify(result).includes('synthetic-no-echo'), false);
  }
});
test('wrong pin, excessive age window and same-origin alternate MCP path cannot admit a scope', async () => {
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
  assert.equal((await plan(signed(), { publicKeyEd25519: other })).ok, false);
  assert.equal((await plan(signed({ expiresAt: new Date(now.getTime() + 300001).toISOString() }))).ok, false);
  assert.equal((await plan(signed({ host: { ...host, mcpPath: '/different' } }))).ok, false);
});
test('repeated offline plans never become analysis admission or a provider request', async () => {
  const receipt = signed(), first = await plan(receipt), second = await plan(receipt);
  assert.equal(first.ok, true); assert.deepEqual(first, second);
  assert.equal(second.analysisInvoked, false); assert.equal(second.requestAdmitted, false);
  assert.equal(second.authorityVerified, false);
});
test('B05 target identifiers retain the existing server parser version/variant restrictions', async () => {
  for (const targetId of ['', 'not-a-uuid', '79000000-0000-7000-8000-000000000004']) {
    const result = await plan(signed({ targetId }), { targetId });
    assert.equal(result.ok, false); assert.equal(result.scope, null); assert.equal(result.analysisInvoked, false);
  }
});
