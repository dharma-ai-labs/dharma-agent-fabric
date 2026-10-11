import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {join} from 'node:path';
import test from 'node:test';
import {validateContract} from '@dharma-ai-labs/agent-fabric-contracts';
import type {LocalProviderSessionBinding} from '@dharma-ai-labs/agent-fabric-local-vault';
import type {CodexLocalWorkCapture} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-session';
import {readNamedSessionNativeAudit} from './namedSessionNativeAudit.js';

const digest = (value: string | Uint8Array) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fixture() {
  const at = new Date().toISOString(), identity = {organizationId: 'org_audit', repositoryBindingId: randomUUID(),
    workspaceId: randomUUID(), endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(), provider: 'codex' as const};
  const binding: LocalProviderSessionBinding = {schema: 'dharma.local-provider-session-binding/v1', ...identity,
    bindingId: randomUUID(), owner: 'dharma_bridge', sessionId: randomUUID(), workspaceRoot: '/synthetic/checkout',
    createdAt: at, expiresAt: new Date(Date.now()+60000).toISOString(), maximumProviderCostCents: 25};
  const turnId = randomUUID(), command = 'node --test test/public.test.js';
  const item = {id: 'native-command', type: 'commandExecution', command, exitCode: 0, durationMs: 123,
    aggregatedOutput: 'TEST_OUTPUT_PRIVATE_CANARY'};
  const events = [
    {method: 'item/started', params: {threadId: binding.sessionId, turnId, item}},
    {method: 'item/completed', params: {threadId: binding.sessionId, turnId, item}},
    {method: 'item/completed', params: {threadId: binding.sessionId, turnId, item: {id: 'reasoning', type: 'reasoning', text: 'PROTECTED_REASONING_CANARY'}}},
    {method: 'turn/completed', params: {threadId: binding.sessionId, turn: {id: turnId, status: 'completed', items: [item,
      {id: 'answer', type: 'agentMessage', text: 'UNTRUSTED_ASSISTANT_CLAIM_CANARY'}]}}},
  ].map((notification, sequence) => ({notification, sequence, receivedAt: at}));
  const capture: CodexLocalWorkCapture = {schema: 'dharma.codex-local-work-capture/v1', ...identity, bindingId: binding.bindingId,
    captureId: randomUUID(), workId: randomUUID(), providerThreadId: binding.sessionId, providerTurnId: turnId,
    startedAt: at, closedAt: at, workOutcome: 'completed', providerTurnState: 'completed', captureScope: 'turn_notifications',
    coverage: 'partial', limitations: [], droppedEvents: 0, acceptedLearningObservation: false, executedModel: null,
    events, eventsHash: digest(JSON.stringify(events))};
  const blobs = new Map<string, Buffer>(), reads: string[] = [];
  const store = (value: unknown) => {const bytes = Buffer.from(JSON.stringify(value)), id = digest(bytes);blobs.set(id, bytes);return id;};
  const prepare = () => {
    capture.eventsHash = digest(JSON.stringify(capture.events));
    const captureHash = store(capture), receiptHash = store({workId: capture.workId, nativeEvidence: {captureId: capture.captureId,
      contentHash: captureHash, secret: 'RECEIPT_SECRET_CANARY'}});
    return {vault: {getBlob: async (id: string) => {reads.push(id);assert.ok(blobs.has(id));return blobs.get(id)!;}}, binding,
      work: {workId: capture.workId, state: 'completed', receiptHash}};
  };
  return {capture, binding, prepare, blobs, reads, command};
}

test('exact-work audit hashes native facts, excludes transcripts and validates its bounded contract', async () => {
  const f = fixture(), input = f.prepare(), result = await readNamedSessionNativeAudit(input);
  assert.equal(result.captureId, f.capture.captureId);assert.equal(result.workId, f.capture.workId);
  assert.equal(result.workState, 'completed');assert.equal(result.captureWorkOutcome, 'completed');
  assert.equal(result.events.length, 1);assert.equal(result.events[0]!.commandHash, digest(f.command));
  assert.equal(result.events[0]!.exitCode, 0);assert.equal(result.events[0]!.durationMs, 123);
  assert.equal(result.events[0]!.outputHash, digest('TEST_OUTPUT_PRIVATE_CANARY'));
  assert.equal(result.acceptedLearningObservation, false);assert.equal(result.rawContentExported, false);
  for (const canary of ['TEST_OUTPUT_PRIVATE_CANARY', 'PROTECTED_REASONING_CANARY', 'UNTRUSTED_ASSISTANT_CLAIM_CANARY',
    'RECEIPT_SECRET_CANARY', f.command]) assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
    'https://schemas.dharma-ai.io/named-session-native-audit/v1', result)).ok, true);
  assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
    'https://schemas.dharma-ai.io/named-session-native-audit/v1', {...result, raw: 'SECRET'})).ok, false);
  assert.equal(f.reads.length, 2);
});

for (const field of ['organizationId','repositoryBindingId','workspaceId','endpointId','membershipId','deviceId','bindingId','providerThreadId','workId'] as const) {
  test(`audit rejects foreign ${field} instead of returning another work item`, async () => {
    const f = fixture(), input = f.prepare();
    (f.capture as unknown as Record<string, unknown>)[field] = field === 'organizationId' ? 'org_foreign' : randomUUID();
    const foreign = f.prepare();
    await assert.rejects(readNamedSessionNativeAudit({...foreign, work: {...foreign.work, workId: input.work.workId}}), /audit_(scope_mismatch|integrity_failed)/);
  });
}

test('audit rejects absent, unfinished, corrupt and tampered captures without arbitrary reads', async () => {
  const f = fixture(), input = f.prepare();
  for (const state of ['executing', 'interrupted']) await assert.rejects(readNamedSessionNativeAudit({...input, work: {...input.work, state}}), /audit_unavailable/);
  await assert.rejects(readNamedSessionNativeAudit({...input, work: null}), /audit_unavailable/);assert.equal(f.reads.length, 0);
  f.blobs.set(input.work.receiptHash, Buffer.from('{"secret":"TAMPERED"}'));
  await assert.rejects(readNamedSessionNativeAudit(input), /audit_integrity_failed/);
  const g = fixture();g.capture.eventsHash = 'sha256:'+'0'.repeat(64);
  const good = g.prepare();
  const raw = JSON.parse(g.blobs.get(good.work.receiptHash)!.toString());
  const bytes = g.blobs.get(raw.nativeEvidence.contentHash)!;
  const tampered = JSON.parse(bytes.toString());tampered.eventsHash = 'sha256:'+'0'.repeat(64);
  const changed = Buffer.from(JSON.stringify(tampered)), changedHash = digest(changed);g.blobs.set(changedHash, changed);
  raw.nativeEvidence.contentHash = changedHash;
  const receipt = Buffer.from(JSON.stringify(raw)), receiptHash = digest(receipt);g.blobs.set(receiptHash, receipt);
  await assert.rejects(readNamedSessionNativeAudit({...good, work: {...good.work, receiptHash}}), /audit_integrity_failed/);
});

test('audit surfaces bounded truncation and hashes paths/tool arguments without exporting secrets', async () => {
  const f = fixture(), sample = f.capture.events[1]!;
  f.capture.events = Array.from({length: 70}, (_, sequence) => ({...sample, sequence, notification: {
    method: 'item/completed', params: {threadId: f.binding.sessionId, turnId: f.capture.providerTurnId,
      item: {id: `item-${sequence}`, type: sequence ? 'fileChange' : 'dynamicToolCall',
        arguments: {password: 'ARGUMENT_SECRET_CANARY'}, result: {secret: 'RESULT_SECRET_CANARY'},
        changes: [{path: '/private/PATH_SECRET_CANARY', diff: 'DIFF_SECRET_CANARY'}]}}}}));
  const result = await readNamedSessionNativeAudit(f.prepare());
  assert.equal(result.events.length, 32);assert.equal(result.qualifyingItems, 70);assert.equal(result.truncated, true);
  for (const text of ['ARGUMENT_SECRET_CANARY','RESULT_SECRET_CANARY','PATH_SECRET_CANARY','DIFF_SECRET_CANARY']) {
    assert.equal(JSON.stringify(result).includes(text), false);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 50000);
});

test('audit rejects a foreign native event even with a self-consistent content hash', async () => {
  const f = fixture();(f.capture.events[1]!.notification.params as Record<string, unknown>).threadId = randomUUID();
  await assert.rejects(readNamedSessionNativeAudit(f.prepare()), /audit_scope_mismatch/);
});

test('typed native output facts are limited to exact version/test commands and complete bounded TAP totals', async () => {
  const sampleOutput = '# tests 11\n# pass 11\n# fail 0\n# cancelled 0\n# skipped 0\nSECRET_OUTSIDE_THE_TYPED_TOTALS';
  for (const [command, output, shape, nodeVersion, pass] of [
    ['node --version', 'v22.22.3\n', 'node_version', 'v22.22.3', null],
    ['/usr/local/bin/node -v', 'v22.22.3\nSECRET', 'node_version', null, null],
    ['node --test test/public.test.js', sampleOutput, 'node_test', null, 11],
    ['npm test', sampleOutput, 'npm_test', null, 11],
    ['echo node --version', 'v22.22.3', 'other', null, null],
    ['node --version\necho SECRET', 'v22.22.3', 'other', null, null],
    ['npm test', sampleOutput+'\n# pass 11', 'npm_test', null, null],
    ['npm test', sampleOutput.replace('# pass 11', '# pass 12'), 'npm_test', null, null],
  ] as const) {
    const f = fixture(), item = (f.capture.events[1]!.notification.params as {item: Record<string, unknown>}).item;
    item.command = command;item.aggregatedOutput = output;
    const result = await readNamedSessionNativeAudit(f.prepare()), event = result.events[0]!;
    assert.equal(event.commandShape, shape);assert.equal(event.reportedNodeVersion, nodeVersion);
    assert.equal(event.reportedTapSummary?.pass ?? null, pass);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/named-session-native-audit/v1', result)).ok, true);
  }
});

test('typed TAP totals reject unexplained gaps and nonzero or malformed TODO categories', async () => {
  for (const suffix of ['', '\n# todo 1', '\n# todo nope', '\n# todo 0\n# todo 0']) {
    const f = fixture(), item = (f.capture.events[1]!.notification.params as {item: Record<string, unknown>}).item;
    item.command = 'node --test test/public.test.js';
    item.aggregatedOutput = '# tests 11\n# pass 10\n# fail 0\n# cancelled 0\n# skipped 0' + suffix;
    assert.equal((await readNamedSessionNativeAudit(f.prepare())).events[0]!.reportedTapSummary, null);
  }
  for (const suffix of ['\n# todo 1', '\n# todo nope', '\n# todo 0\n# todo 0']) {
    const f = fixture(), item = (f.capture.events[1]!.notification.params as {item: Record<string, unknown>}).item;
    item.command = 'npm test';
    item.aggregatedOutput = '# tests 11\n# pass 11\n# fail 0\n# cancelled 0\n# skipped 0' + suffix;
    assert.equal((await readNamedSessionNativeAudit(f.prepare())).events[0]!.reportedTapSummary, null);
  }
  const f = fixture(), item = (f.capture.events[1]!.notification.params as {item: Record<string, unknown>}).item;
  item.command = 'npm test';
  item.aggregatedOutput = '# tests 11\n# pass 11\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0';
  assert.deepEqual((await readNamedSessionNativeAudit(f.prepare())).events[0]!.reportedTapSummary,
    {tests: 11, pass: 11, fail: 0, cancelled: 0, skipped: 0});
});

test('v2 audit checks request integrity and original workspace without upgrading partial coverage', async () => {
  const f = fixture();
  const request = {method: 'turn/start' as const, params: {threadId: f.binding.sessionId,
    input: [{type: 'text' as const, text: 'PRIVATE_REQUEST_CANARY'}] as [{type: 'text'; text: string}],
    cwd: f.binding.workspaceRoot, approvalPolicy: 'never' as const, permissions: 'dharma_work' as const}};
  Object.assign(f.capture, {schema: 'dharma.codex-local-work-capture/v2', captureScope: 'turn_request_and_notifications',
    request, requestHash: digest(JSON.stringify(request)), limitations: ['credential_excluded'], droppedEvents: 3});
  const result = await readNamedSessionNativeAudit(f.prepare());
  assert.equal(result.coverage, 'partial');assert.equal(JSON.stringify(result).includes('PRIVATE_REQUEST_CANARY'), false);
  assert.deepEqual(result.captureLimitations, ['credential_excluded']);assert.equal(result.droppedEvents, 3);
  assert.equal(result.unrecognizedCaptureLimitationCount, 0);
  f.capture.limitations.push('PRIVATE_LIMITATION_CANARY');
  await assert.rejects(readNamedSessionNativeAudit(f.prepare()), /audit_integrity_failed/);
  f.capture.limitations.pop();
  request.params.cwd = '/foreign/checkout';
  await assert.rejects(readNamedSessionNativeAudit(f.prepare()), /audit_integrity_failed/);
});

test('audit retains path truncation instead of silently claiming complete file-change evidence', async () => {
  const f = fixture(), item = (f.capture.events[1]!.notification.params as {item: Record<string, unknown>}).item;
  item.type = 'fileChange';item.changes = Array.from({length: 9}, (_, n) => ({path: `src/file${n}.ts`}));
  const result = await readNamedSessionNativeAudit(f.prepare());
  assert.equal(result.events[0]!.pathHashes.length, 4);assert.equal(result.events[0]!.pathsTruncated, true);
  assert.equal(result.truncated, true);
});

test('audit rejects contradictory repeated completion items instead of choosing the successful result', async () => {
  const f = fixture(), item = (f.capture.events[1]!.notification.params as {item: Record<string, unknown>}).item;
  const clone = JSON.parse(JSON.stringify(item));clone.exitCode = 1;
  const final = (f.capture.events[3]!.notification.params as {turn: {items: unknown[]}}).turn;
  final.items[0] = clone;
  await assert.rejects(readNamedSessionNativeAudit(f.prepare()), /audit_integrity_failed/);
});

test('official dynamic-tool responses hash content and outcome without substituting MCP result fields', async () => {
  for (const [status, success, contentItems] of [
    ['completed', true, [{type: 'inputText', text: 'PEER_RESPONSE_PRIVATE_CANARY'}]],
    ['failed', false, [{type: 'inputText', text: 'PEER_FAILURE_PRIVATE_CANARY'}]],
    ['completed', null, null],
  ] as const) {
    const f = fixture(), item = (f.capture.events[1]!.notification.params as {item: Record<string, unknown>}).item;
    Object.keys(item).forEach(key => delete item[key]);
    Object.assign(item, {id: 'dynamic-native', type: 'dynamicToolCall', namespace: 'dharma', tool: 'peer_answer',
      arguments: {questionId: 'SYNTHETIC_QUESTION'}, status, success, contentItems, durationMs: 12});
    const result = await readNamedSessionNativeAudit(f.prepare()), event = result.events[0]! as unknown as Record<string, unknown>;
    assert.equal(event.dynamicContentHash, contentItems === null ? null : digest(JSON.stringify(contentItems)));
    assert.equal(event.dynamicResponseHash, digest(JSON.stringify({contentItems, success, status})));
    assert.equal(event.toolSuccess, success);assert.equal(event.toolStatus, status);
    assert.equal(event.outputHash, null);assert.equal(event.resultHash, null);assert.equal(event.cwdHash, null);
    assert.equal(JSON.stringify(result).includes('PRIVATE_CANARY'), false);
    assert.equal((await validateContract(join(import.meta.dirname, 'schemas'),
      'https://schemas.dharma-ai.io/named-session-native-audit/v1', result)).ok, true);
    delete item.contentItems;
    const missing = (await readNamedSessionNativeAudit(f.prepare())).events[0]! as unknown as Record<string, unknown>;
    assert.equal(missing.dynamicContentHash, null);assert.equal(missing.dynamicResponseHash, null);
  }
});

test('command cwd is independently matchable while MCP results and errors retain separate hashes', async () => {
  const f = fixture(), item = (f.capture.events[1]!.notification.params as {item: Record<string, unknown>}).item;
  item.cwd = '/synthetic/checkout';
  const first = (await readNamedSessionNativeAudit(f.prepare())).events[0]! as unknown as Record<string, unknown>;
  item.cwd = '/foreign/PRIVATE_CWD_CANARY';
  const other = (await readNamedSessionNativeAudit(f.prepare())).events[0]! as unknown as Record<string, unknown>;
  assert.equal(first.cwdHash, digest('/synthetic/checkout'));assert.equal(other.cwdHash, digest(String(item.cwd)));
  assert.notEqual(first.cwdHash, other.cwdHash);assert.equal(first.commandHash, other.commandHash);
  assert.equal(first.outputHash, other.outputHash);assert.equal(JSON.stringify(other).includes('PRIVATE_CWD_CANARY'), false);
  Object.keys(item).forEach(key => delete item[key]);
  Object.assign(item, {id: 'mcp-native', type: 'mcpToolCall', server: 'dharma', tool: 'peer_answer', status: 'failed',
    arguments: {questionId: 'SYNTHETIC_QUESTION'}, result: null, error: {message: 'PRIVATE_MCP_ERROR_CANARY'}});
  const mcp = (await readNamedSessionNativeAudit(f.prepare())).events[0]! as unknown as Record<string, unknown>;
  assert.equal(mcp.errorHash, digest(JSON.stringify(item.error)));assert.equal(mcp.toolStatus, 'failed');
  assert.equal(mcp.toolSuccess, null);assert.equal(mcp.dynamicResponseHash, null);assert.equal(mcp.cwdHash, null);
  assert.equal(JSON.stringify(mcp).includes('PRIVATE_MCP_ERROR_CANARY'), false);
});
