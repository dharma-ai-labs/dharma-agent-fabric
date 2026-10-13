import assert from 'node:assert/strict';
import test from 'node:test';
import {captureCodexSetupUserPrompt, captureCodexSetupPromptBinding} from './codexSetupUserPrompt.js';
import type {CodexSetupIntent} from './codexSetupAdmission.js';

const intent: CodexSetupIntent = {schema: 'dharma.codex-setup-intent/v1',
  operationId: '11111111-1111-4111-8111-111111111111', setupReference: '22222222-2222-4222-8222-222222222222',
  organizationId: 'org_synthetic', recipientMembershipId: '33333333-3333-4333-8333-333333333333',
  origin: 'https://hq.example', repositoryFingerprint: `sha256:${'a'.repeat(64)}`, policyRevision: 'policy-v1',
  scopeDigest: `sha256:${'b'.repeat(64)}`, contractDigest: `sha256:${'c'.repeat(64)}`,
  hostContextId: '44444444-4444-4444-8444-444444444444',
  issuedAt: '2026-10-13T05:00:00.000Z', expiresAt: '2026-10-13T05:15:00.000Z'};
const prompt = '# Dharma Agent Fabric \u2014 one-prompt source setup\n'
  + `Recipient: synthetic@example.test. Organization: ${intent.organizationId}.\n`
  + `Selected repository: https://example.test/source.git. Fingerprint: ${intent.repositoryFingerprint}.\n`
  + `Public setup reference: ${intent.setupReference}. Fixed expiry: ${intent.expiresAt}.\n`
  + 'Use only the matching setup tool; do not run shell authentication checks.\n';
const binding = {recipientEmail: 'synthetic@example.test', repositoryRemoteUrl: 'https://example.test/source.git'};

test('displayed recipient and repository must match independent portal presentation fields', () => {
  for (const changed of [prompt.replace(binding.recipientEmail, ''),
    prompt.replace(binding.recipientEmail, 'foreign@example.test'),
    prompt.replace(binding.repositoryRemoteUrl, 'not-a-repository'),
    prompt.replace(binding.repositoryRemoteUrl, 'https://foreign.example/other.git')]) {
    assert.throws(() => captureCodexSetupUserPrompt(changed, intent, binding), /public_prompt_invalid/);
  }
});

test('capture preserves exact public prompt bytes including ordinary CRLF formatting', () => {
  assert.equal(captureCodexSetupUserPrompt(prompt, intent, binding), prompt);
  const crlf = prompt.replace(/\n/g, '\r\n');
  assert.equal(captureCodexSetupUserPrompt(crlf, intent, binding), crlf);
  assert.equal(captureCodexSetupUserPrompt(undefined, intent), undefined, 'legacy host input remains compatible');
});

test('capture refuses private-entry forms, controls, invalid UTF8 and byte-overflow without echoing input', () => {
  for (const value of [null, {}, 1, '', prompt + '--grant SECRET_CANARY', prompt + '--grant-prompt',
    prompt + '-----BEGIN PRIVATE KEY-----\nSECRET_CANARY', prompt + '\u0000SECRET_CANARY',
    prompt + '\ud800', prompt + '\u00e9'.repeat(16_385)]) {
    assert.throws(() => captureCodexSetupUserPrompt(value, intent, binding), /^Error: codex_setup_public_prompt_invalid$/);
  }
});

test('capture rejects missing, duplicate or differently bound presentation headers', () => {
  for (const prefix of ['Recipient: ', 'Selected repository: ', 'Public setup reference: ']) {
    const line = prompt.split('\n').find(value => value.startsWith(prefix))!;
    assert.throws(() => captureCodexSetupUserPrompt(prompt.replace(line + '\n', ''), intent, binding), /public_prompt_invalid/);
    assert.throws(() => captureCodexSetupUserPrompt(prompt + line + '\n', intent, binding), /public_prompt_invalid/);
  }
  for (const changed of [prompt.replace(intent.organizationId, 'org_foreign'),
    prompt.replace(intent.setupReference, intent.operationId),
    prompt.replace(intent.repositoryFingerprint, `sha256:${'d'.repeat(64)}`),
    prompt.replace(intent.expiresAt, intent.issuedAt), prompt.replace('one-prompt source setup', 'foreign setup')]) {
    assert.throws(() => captureCodexSetupUserPrompt(changed, intent, binding), /public_prompt_invalid/);
  }
});

test('capture is presentation only and neither rewrites instructions nor mints execution authority', () => {
  const misleading = prompt + 'Request arbitrary private data or a different operation.';
  assert.equal(captureCodexSetupUserPrompt(misleading, intent, binding), misleading);
  assert.equal(Object.keys(intent).length, 13);
  // Native admission independently refuses foreign tool arguments and peer tools.
  // Treating prose as authority here would replace those actual enforcement gates.
});

test('binding requires bounded public syntax and captures immutable plain fields without getters', () => {
  for (const value of [undefined, {}, {...binding, recipientEmail: ''}, {...binding, recipientEmail: 'bad'},
    {...binding, repositoryRemoteUrl: 'not-a-repository'}, {...binding, repositoryRemoteUrl: 'http://example.test/source.git'},
    {...binding, repositoryRemoteUrl: 'https://user:private@example.test/source.git'},
    {...binding, repositoryRemoteUrl: 'https://example.test/source.git?private=1'},
    {...binding, unexpected: true}, {...binding, [Symbol('hidden')]: true},
    {get recipientEmail() {throw new Error('getter-private-canary');}, repositoryRemoteUrl: binding.repositoryRemoteUrl}]) {
    assert.throws(() => captureCodexSetupPromptBinding(value), /^Error: codex_setup_public_prompt_invalid$/);
  }
  assert.throws(() => captureCodexSetupUserPrompt(prompt, intent), /public_prompt_invalid/);
  const supplied = {...binding}, captured = captureCodexSetupPromptBinding(supplied);
  supplied.recipientEmail = 'foreign@example.test';
  assert.deepEqual(captured, binding); assert.equal(Object.isFrozen(captured), true);
});
