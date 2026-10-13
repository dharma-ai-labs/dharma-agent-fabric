import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {requestCodexSetupHostPreparation} from './codexSetupPortalPreparation.js';

const now = Date.parse('2030-01-01T00:00:00.000Z');
const reference = '11111111-1111-4111-8111-111111111111';
const membership = '22222222-2222-4222-8222-222222222222';
const binding = {recipientEmail: 'synthetic@example.test', repositoryRemoteUrl: 'https://github.com/example/synthetic.git'};
const fingerprint = `sha256:${'a'.repeat(64)}`;
const prompt = '# Dharma Agent Fabric \u2014 one-prompt source setup\n'
  + `Recipient: ${binding.recipientEmail}. Organization: org_fixture.\n`
  + `Selected repository: ${binding.repositoryRemoteUrl}. Fingerprint: ${fingerprint}.\n`
  + `Public setup reference: ${reference}. Fixed expiry: 2030-01-01T00:15:00.000Z.\n`;
function fixture() {
  let calls = 0;
  const response = {schema: 'dharma.setup-host-preparation/v1', ok: true, effects: false,
    grantRedeemed: false, approvalRequired: true, sourcePolicyRevalidated: true,
    preparedAt: new Date(now).toISOString(), expiresAt: '2030-01-01T00:15:00.000Z',
    promptSha256: createHash('sha256').update(prompt).digest('hex'), cliVersion: '0.2.190',
    binding: {...binding}, context: {origin: 'https://www.dharma-ai.io', organizationId: 'org_fixture',
      setupReference: reference, recipientMembershipId: membership, repositoryFingerprint: fingerprint,
      policyRevision: 'policy-v1', scopeDigest: `sha256:${'b'.repeat(64)}`, contractDigest: `sha256:${'c'.repeat(64)}`}};
  const input = {origin: response.context.origin, organizationId: 'org_fixture', setupReference: reference,
    cliVersion: '0.2.190', initialUserPrompt: prompt as unknown, signal: new AbortController().signal, now: () => now,
    fetcher: (async (url, options) => {
      calls++;
      assert.equal(String(url), 'https://www.dharma-ai.io/api/v1/agent-fabric/bootstrap/setup-claim');
      assert.equal(options?.redirect, 'error');
      assert.deepEqual(JSON.parse(String(options?.body)), {action: 'prepare_host', organizationId: 'org_fixture',
        setupReference: reference, promptSha256: createHash('sha256').update(prompt).digest('hex')});
      assert.equal(options?.credentials, 'omit');
      return new Response(JSON.stringify(response), {headers: {'content-type': 'application/json'}});
    }) as typeof fetch};
  return {response, input, get calls() {return calls;}};
}
test('public preparation obtains independent server binding without invoking a provider or enrollment', async () => {
  const f = fixture();
  const result = await requestCodexSetupHostPreparation(f.input);
  assert.equal(f.calls, 1);
  assert.deepEqual((result as any).binding, binding);
  assert.equal((result as any).initialUserPrompt, prompt);
  assert.equal((result as any).effects, false);
});
test('credential-shaped prose is rejected before any network admission', async () => {
  const f = fixture();
  const canary = ['dhab', 'synthetic', 'not-a-real-grant'].join('_');
  await assert.rejects(requestCodexSetupHostPreparation({...f.input, initialUserPrompt: prompt + canary}));
  assert.equal(f.calls, 0);
});
test('bounded server clock lead waits without weakening issued-at or expiry validation', async () => {
  const f = fixture(); let localNow = now, waited = 0;
  f.response.preparedAt = new Date(now + 2208).toISOString();
  const result = await requestCodexSetupHostPreparation({...f.input, now: () => localNow,
    ...{sleep: async (ms: number) => {waited++; assert.equal(ms, 2208); localNow += ms;}}});
  assert.equal(waited, 1); assert.equal(result.intent.issuedAt, f.response.preparedAt); assert.equal(f.calls, 1);
});
test('excessive server clock lead is rejected without sleeping or provider effects', async () => {
  const f = fixture(); let waits = 0;
  f.response.preparedAt = new Date(now + 5001).toISOString();
  await assert.rejects(requestCodexSetupHostPreparation({...f.input,
    ...{sleep: async () => {waits++;}}}));
  assert.equal(waits, 0); assert.equal(f.calls, 1);
});
test('clock wait cancellation cannot authorize a future preparation', async () => {
  const f = fixture(), control = new AbortController();
  f.response.preparedAt = new Date(now + 1000).toISOString();
  await assert.rejects(requestCodexSetupHostPreparation({...f.input, signal: control.signal,
    ...{sleep: async () => {control.abort();}}}));
});
test('clipboard CRLF uses the same public digest while preserving actual native message bytes', async () => {
  const f = fixture(), original = prompt.replace(/\n/g, '\r\n');
  const result = await requestCodexSetupHostPreparation({...f.input, initialUserPrompt: original});
  assert.equal(result.initialUserPrompt, original);
  assert.equal(result.initialUserPromptSha256, createHash('sha256').update(original).digest('hex'));
  assert.equal(result.promptSha256, createHash('sha256').update(prompt).digest('hex'));
});
for (const cause of ['origin', 'organization', 'reference', 'version', 'prompt-hash', 'recipient', 'repository', 'expired', 'effects', 'unknown'] as const) {
  test(`public preparation rejects ${cause} instead of accepting model-supplied binding`, async () => {
    const f = fixture();
    if (cause === 'origin') f.response.context.origin = 'https://foreign.example';
    if (cause === 'organization') f.response.context.organizationId = 'org_foreign';
    if (cause === 'reference') f.response.context.setupReference = membership;
    if (cause === 'version') f.response.cliVersion = '0.2.191';
    if (cause === 'prompt-hash') f.response.promptSha256 = 'e'.repeat(64);
    if (cause === 'recipient') f.response.binding.recipientEmail = 'other@example.test';
    if (cause === 'repository') f.response.binding.repositoryRemoteUrl = 'https://github.com/other/source.git';
    if (cause === 'expired') f.response.expiresAt = new Date(now).toISOString();
    if (cause === 'effects') f.response.effects = true;
    if (cause === 'unknown') (f.response as Record<string, unknown>).privateField = 'PRIVATE_CANARY';
    await assert.rejects(requestCodexSetupHostPreparation(f.input));
  });
}
test('a cancelled preparation makes no network request', async () => {
  const f = fixture();
  await assert.rejects(requestCodexSetupHostPreparation({...f.input, signal: AbortSignal.abort()}));
  assert.equal(f.calls, 0);
});
for (const cause of ['http-error', 'invalid-json', 'oversized', 'foreign-redirect', 'vendor-error'] as const) {
  test(`transport ${cause} is bounded, not retried and never reflects a response or vendor exception`, async () => {
    const f = fixture(); let calls = 0;
    const fetcher = (async () => {
      calls++;
      if (cause === 'vendor-error') throw Error('PRIVATE_VENDOR_EXCEPTION');
      if (cause === 'http-error') return new Response('PRIVATE_RESPONSE', {status: 403});
      if (cause === 'foreign-redirect') return new Response('', {status: 302, headers: {location: 'https://foreign.example'}});
      return new Response(cause === 'invalid-json' ? 'PRIVATE_INVALID_RESPONSE' : 'x'.repeat(65537),
        {headers: {'content-type': 'application/json'}});
    }) as typeof fetch;
    await assert.rejects(requestCodexSetupHostPreparation({...f.input, fetcher}),
      error => error instanceof Error && error.message === 'codex_setup_portal_preparation_unavailable');
    assert.equal(calls, 1);
  });
}
