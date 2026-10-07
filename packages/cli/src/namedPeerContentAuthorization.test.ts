import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalize } from '@dharma-ai-labs/agent-fabric-contracts';
import type { OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { createNamedPeerContentAuthorization } from './namedPeerContentAuthorization.js';
import { createProviderSessionChannel } from './providerSessionChannel.js';

const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const scope = { organizationId: 'org_peer_fixture', workspaceId: uuid(1), repositoryBindingId: uuid(2), repositoryAgentId: uuid(3) };
const now = new Date('2026-10-04T07:00:00Z');
function source(roots = ['.']) {
  const policy = { action: 'authorize', confirmed: true, requestId: uuid(4), repositoryBindingId: scope.repositoryBindingId,
    expectedRevision: 0, allowedContentClasses: ['approved_outputs', 'repository_content', 'repository_skills'],
    approvedRepositoryPaths: roots, approvedOutputFolders: ['reports'], automaticValidatedPublication: true,
    retentionDays: 30, maximumFileBytes: 262144, maximumSnapshotBytes: 4194304,
    maximumDailyUploadBytes: 8388608, expiresAt: '2026-10-04T08:00:00.000Z' as string | null };
  return { schema: 'dharma.repository-source-authorization/v1', ...scope, revision: 1, generationId: uuid(5),
    receiptId: `repo_consent_${uuid(5)}`, policyRevision: `repository-source-${uuid(5)}`,
    policyHash: `sha256:${createHash('sha256').update(canonicalize(policy)).digest('hex')}`,
    confirmedAt: '2026-10-04T06:00:00Z', policy };
}
function fixture(diagnostics = false) {
  let current = source();
  const policy: OrganizationPolicy = { schema: 'dharma.organization-policy/v2', organizationId: scope.organizationId,
    revision: 'local-analysis-v1', evidence: { defaultMode: 'structured', registeredWorkspaceOnly: true,
      automaticDisclosure: { mode: 'local_analysis' }, excludePaths: ['.env', '.env.*', 'private/**'],
      maximumCapsuleBytes: 1048576, maximumDailyUploadBytes: 8388608, maximumExpansionBytes: 1048576 },
    tasks: { defaultNetwork: 'deny', defaultGit: 'read_only', allowedCommands: {}, writePaths: [], requireLocalConfirmationFor: [] },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 }, retention: {}, budgets: {} };
  let loads = 0, unavailable = false;
  const authorize = createNamedPeerContentAuthorization({ scope, now: () => now, ...{ diagnostics },
    loadCurrentPolicy: async () => policy, loadCurrentSourceAuthorization: async () => {
      loads++; if (unavailable) throw new Error('fixture_denied'); return current;
    } });
  return { policy, authorize, loads: () => loads, setSource: (value: typeof current) => { current = value; },
    setUnavailable: () => { unavailable = true; } };
}

test('repository-authorized task text works without upgrading local-analysis or learning consent', async () => {
  const f = fixture(), original = structuredClone(f.policy);
  assert.equal(await f.authorize('How should a logical job handle duplicate retries?', 'question'), true);
  assert.equal(await f.authorize('Coalesce the retry.\nReject conflicting payloads.', 'answer'), true);
  assert.equal(f.loads(), 2); assert.deepEqual(f.policy, original);
  assert.equal(f.policy.evidence.automaticDisclosure?.consentReceiptId, undefined);
});
test('source authority is refreshed and a later denial cannot reuse approval', async () => {
  const f = fixture(); assert.equal(await f.authorize('Which catalog applies?', 'question'), true);
  f.setUnavailable(); assert.equal(await f.authorize('Which catalog applies?', 'question'), false);
  assert.equal(f.loads(), 2);
});
test('subtree approval does not authorize the current whole-repository peer sandbox', async () => {
  const f = fixture(); f.setSource(source(['src']));
  assert.equal(await f.authorize('Which procedure applies?', 'question'), false);
});
test('foreign organization, workspace, repository and agent source receipts fail closed', async () => {
  for (const change of [{ organizationId: 'org_other' }, { workspaceId: uuid(8) },
    { repositoryBindingId: uuid(8) }, { repositoryAgentId: uuid(8) }]) {
    const f = fixture(); f.setSource({ ...source(), ...change });
    assert.equal(await f.authorize('Which procedure applies?', 'question'), false);
  }
});
test('expired or tampered source authority cannot disclose task text', async () => {
  for (const change of ['expired', 'hash', 'confirmed'] as const) {
    const f = fixture(), receipt = source();
    if (change === 'expired') receipt.policy.expiresAt = '2026-10-04T06:30:00.000Z';
    else if (change === 'hash') receipt.policyHash = `sha256:${'0'.repeat(64)}`;
    else receipt.confirmedAt = '2026-10-04T09:00:00Z';
    f.setSource(receipt); assert.equal(await f.authorize('Which procedure applies?', 'question'), false);
  }
});
test('metadata-only and legacy evidence modes remain withheld', async () => {
  for (const mode of ['metadata_only', undefined] as const) {
    const f = fixture(); f.policy.evidence.automaticDisclosure = mode ? { mode } : undefined;
    assert.equal(await f.authorize('Which procedure applies?', 'question'), false); assert.equal(f.loads(), 0);
  }
});
test('foreign current evidence policy never uses a valid local source receipt', async () => {
  const f = fixture(); f.policy.organizationId = 'org_other';
  assert.equal(await f.authorize('Which procedure applies?', 'answer'), false); assert.equal(f.loads(), 0);
});
test('a forged learning-content flag is not a substitute for verified signed evidence authorization', async () => {
  const f = fixture(); f.policy.evidence.automaticDisclosure = { mode: 'customer_authorized_content',
    consentReceiptId: 'forged', allowedContentClasses: ['native_provider_payload'] };
  assert.equal(await f.authorize('Which procedure applies?', 'question'), false); assert.equal(f.loads(), 0);
});
test('secrets, excluded paths, private local paths, controls and oversized content are denied before source fetch', async () => {
  const f = fixture();
  for (const content of ['api_key=abcdefgh12345678', 'password=abcdefgh12345678', 'Bearer abcdefgh12345678',
    'Read .env.local', 'Read private/customer.txt',
    'Read /home/user/private.txt', 'Read C:\\private\\data.txt', 'invalid\u0000text', 'x'.repeat(2001), '']) {
    assert.equal(await f.authorize(content, 'question'), false, content.slice(0, 40));
  }
  assert.equal(f.loads(), 0);
});
test('task channel sends only after fresh source approval and cannot reuse it after revocation', async () => {
  const f = fixture(), calls: Array<Record<string, unknown>> = [];
  const session = { organizationId: scope.organizationId, workspaceId: scope.workspaceId,
    repositoryBindingId: scope.repositoryBindingId, endpointId: uuid(6), membershipId: uuid(7), deviceId: uuid(8), bindingId: uuid(9),
    provider: 'codex' as const, expiresAt: '2026-10-04T08:00:00Z', maximumProviderCostCents: 25 };
  const channel = createProviderSessionChannel({ scope: session, mode: 'bridge_owned', expectedRevision: 0,
    now: () => now, assertOwner: async () => true, authorizeContent: f.authorize,
    verifier: { resolvePublicKey: () => null }, transport: { signedPost: async (_route, wire) => {
      const body = wire as Record<string, unknown>; calls.push(body);
      if (body.action === 'attach') return { ok: true, organizationId: scope.organizationId, correlationId: uuid(10),
        registration: { bindingId: session.bindingId, workspaceId: scope.workspaceId, endpointId: session.endpointId,
          repositoryBindingId: scope.repositoryBindingId, membershipId: session.membershipId, deviceId: session.deviceId,
          provider: 'codex', mode: 'bridge_owned', revision: 1, state: 'attached',
          leaseUntil: '2026-10-04T07:01:00Z', replay: false } };
      return { ok: true, organizationId: scope.organizationId, correlationId: uuid(10),
        result: { questionId: uuid(11), taskId: body.taskId, targetBindingId: body.targetBindingId, state: 'queued', replay: false } };
    } } });
  await channel.attach();
  const question = { targetBindingId: uuid(12), taskId: uuid(13), category: 'architecture',
    question: 'How should a logical job handle retries?', maximumProviderCostCents: 25 };
  assert.equal((await channel.ask(question)).state, 'queued');
  f.setUnavailable();
  await assert.rejects(channel.ask({ ...question, question: 'Should payload conflicts fail before effects?' }), /provider_session_channel_input/);
  assert.equal(calls.filter(call => call.action === 'ask').length, 1);
  assert.equal(f.policy.evidence.automaticDisclosure?.mode, 'local_analysis');
});

test('opt-in peer diagnostics expose fixed blockers without answer text or policy details', async () => {
  const cases = [
    ['text_contract_invalid', 'api_key=abcdefgh12345678', () => {}],
    ['private_local_path', 'Read /home/user/private.txt', () => {}],
    ['excluded_path', 'Read private/customer.txt', () => {}],
    ['redaction_required', 'Read /internal/notes.txt', () => {}],
    ['foreign_policy', 'Which catalog applies?', (f: ReturnType<typeof fixture>) => { f.policy.organizationId = 'org_other'; }],
    ['metadata_only', 'Which catalog applies?', (f: ReturnType<typeof fixture>) => { f.policy.evidence.automaticDisclosure = { mode: 'metadata_only' }; }],
    ['source_subtree_not_authorized', 'Which catalog applies?', (f: ReturnType<typeof fixture>) => { f.setSource(source(['src'])); }],
    ['source_authority_unavailable', 'Which catalog applies?', (f: ReturnType<typeof fixture>) => { f.setUnavailable(); }],
    ['authority_unavailable', 'Which catalog applies?', (f: ReturnType<typeof fixture>) => { f.policy.revision = ''; }],
  ] as const;
  for (const [blocker, content, change] of cases) {
    const f = fixture(true); change(f);
    await assert.rejects(f.authorize(content, 'answer'), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'provider_session_channel_input');
      assert.deepEqual(Object.keys(error), ['blocker']);
      assert.equal((error as Error & { blocker: string }).blocker, blocker);
      assert.equal(JSON.stringify(error).includes(content), false);
      assert.equal(JSON.stringify(error).includes('org_other'), false);
      return true;
    });
  }
  assert.equal(await fixture(true).authorize('Coalesce retries by logical job.', 'answer'), true);
});
