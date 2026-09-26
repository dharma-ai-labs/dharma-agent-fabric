import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgentFabricClient } from '@dharma-ai-labs/agent-fabric-sdk';
import { previewLifecycleSource, SqliteLifecycleAdapter, type LifecycleSourceOptions } from './index.js';

const scope = { organizationId: 'org_fixture', repositoryBindingId: randomUUID(),
  workspaceId: randomUUID(), sourceEndpointId: randomUUID(),
  targets: [{ endpointId: randomUUID(), workspaceId: randomUUID() }] };
function event() {
  return { schema: 'dharma.lifecycle-event/v1', eventId: randomUUID(), revision: 1,
    organizationId: scope.organizationId, repositoryBindingId: scope.repositoryBindingId,
    workspaceId: scope.workspaceId, sourceEndpointId: scope.sourceEndpointId,
    targetEndpointId: scope.targets[0]!.endpointId, targetWorkspaceId: scope.targets[0]!.workspaceId,
    sourceTaskId: randomUUID(), workflow: 'coding', boundary: 'reviewed_plan_to_implementation',
    sourceCommit: 'a'.repeat(40), sourceHash: `sha256:${'b'.repeat(64)}`,
    occurredAt: '2026-09-25T00:00:00.000Z', expiresAt: '2026-09-25T00:15:00.000Z',
    intent: 'Implement the approved plan', summary: 'Reviewed plan with frozen acceptance tests.',
    missing: [], evidenceReferences: [] };
}

const now = new Date('2026-09-25T00:01:00.000Z');
const authorize: LifecycleSourceOptions['authorize'] = async () => ({ approved: true, policyRevision: 'policy-1' });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fabric-lifecycle-'));
  const sourcePath = join(root, 'source.sqlite');
  const statePath = join(root, 'state.sqlite');
  const db = new DatabaseSync(sourcePath);
  db.exec('CREATE TABLE lifecycle (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL); CREATE VIEW dharma_lifecycle_export_v1 AS SELECT sequence, event_json FROM lifecycle;');
  db.close();
  return { root, sourcePath, statePath,
    input: { sourcePath, statePath, streamId: randomUUID(), scope, authorize, now },
    write(sequence: number, value: unknown) {
      const db = new DatabaseSync(sourcePath);
      try { db.prepare('INSERT OR REPLACE INTO lifecycle VALUES (?, ?)').run(sequence, JSON.stringify(value)); }
      finally { db.close(); }
    },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
function accepted(input: Parameters<AgentFabricClient['dispatchHandoff']>[0]) {
  const taskId = randomUUID();
  return { ok: true, organizationId: scope.organizationId, correlationId: randomUUID(),
    task: { id: taskId, org_id: scope.organizationId, target_endpoint_id: input.targetEndpointId,
      source_endpoint_id: scope.sourceEndpointId, envelope: { source: { taskId: input.sourceTaskId, endpointId: scope.sourceEndpointId } },
      workspace_id: scope.targets[0]!.workspaceId, status: 'offered' },
    message: { id: randomUUID(), org_id: scope.organizationId, task_id: taskId,
      conversation_id: input.conversationId, source_endpoint_id: scope.sourceEndpointId,
      target_endpoint_id: input.targetEndpointId, state_envelope: input.stateEnvelope } };
}
const transport = { organizationId: scope.organizationId, dispatchHandoff: async (input: Parameters<AgentFabricClient['dispatchHandoff']>[0]) => accepted(input) };

test('preview reads a bounded approved SQLite event without writing customer history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'fabric-lifecycle-'));
  const sourcePath = join(root, 'source.sqlite');
  try {
    const db = new DatabaseSync(sourcePath);
    db.exec('CREATE TABLE lifecycle (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL); CREATE VIEW dharma_lifecycle_export_v1 AS SELECT sequence, event_json FROM lifecycle;');
    db.prepare('INSERT INTO lifecycle VALUES (?, ?)').run(1, JSON.stringify(event()));
    db.close();
    const before = await readFile(sourcePath);
    const preview = await previewLifecycleSource({ sourcePath, scope,
      authorize: async () => ({ approved: true, policyRevision: 'policy-1' }),
      now: new Date('2026-09-25T00:01:00.000Z') });
    assert.equal(preview.length, 1);
    assert.deepEqual(await readFile(sourcePath), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('canonical schema matches the runtime copy and recognizes all four boundaries', async () => {
  assert.deepEqual(JSON.parse(await readFile(new URL('../../../schemas/lifecycle-event.schema.json', import.meta.url), 'utf8')),
    JSON.parse(await readFile(new URL('./lifecycle-event.schema.json', import.meta.url), 'utf8')));
  const f = await fixture();
  try {
    const boundaries = [['coding', 'reviewed_plan_to_implementation'], ['coding', 'implementation_to_review'],
      ['creative', 'approved_brief_to_draft'], ['creative', 'draft_to_review']];
    boundaries.forEach(([workflow, boundary], i) => f.write(i + 1, { ...event(), workflow, boundary }));
    const planned = await previewLifecycleSource(f.input);
    assert.equal(planned.length, 4);
    assert.ok(planned.every(p => p.state === 'planned'));
    f.write(1, { ...event(), workflow: 'coding', boundary: 'draft_to_review' });
    await assert.rejects(previewLifecycleSource(f.input), /lifecycle_event_invalid/);
  } finally { await f.cleanup(); }
});

test('redaction precedes transmission and durable state contains no raw summary or credentials', async () => {
  const f = await fixture();
  const secret = `sk-${'x'.repeat(40)}`;
  try {
    f.write(1, { ...event(), summary: `Approved synthetic summary ${secret} C:\\Users\\fixture\\private.txt` });
    const before = await readFile(f.sourcePath);
    const preview = await previewLifecycleSource(f.input);
    assert.ok(!JSON.stringify(preview).includes(secret));
    assert.ok(!JSON.stringify(preview).includes('C:\\Users'));
    assert.equal(preview[0]?.state === 'planned' && preview[0].redactedValues! >= 2, true);
    const adapter = await SqliteLifecycleAdapter.open(f.input);
    try {
      const result = await adapter.run({ ...transport, dispatchHandoff: async input => {
        assert.ok(!JSON.stringify(input).includes(secret));
        return accepted(input);
      } });
      assert.equal(result.state, 'drained');
      assert.equal(result.executionVerified, false);
    } finally { adapter.close(); }
    assert.deepEqual(await readFile(f.sourcePath), before);
    const bytes = await readFile(f.statePath);
    assert.ok(!bytes.includes(Buffer.from(secret)));
    assert.ok(!bytes.includes(Buffer.from('Approved synthetic summary')));
  } finally { await f.cleanup(); }
});

test('dedupe and a lost response reuse immutable requests across adapter restart', async () => {
  const f = await fixture();
  const e = event(); f.write(1, e); f.write(2, e);
  let firstBody: unknown; let firstKey: string | undefined;
  try {
    let adapter = await SqliteLifecycleAdapter.open(f.input);
    const first = await adapter.run({ ...transport, dispatchHandoff: async (input, options) => {
      firstBody = input; firstKey = options?.idempotencyKey;
      throw new Error('simulated response loss');
    } });
    assert.equal(first.state, 'blocked'); assert.equal(first.cursor, 0);
    adapter.close();
    adapter = await SqliteLifecycleAdapter.open(f.input);
    try {
      let calls = 0;
      const resumed = await adapter.run({ ...transport, dispatchHandoff: async (input, options) => {
        calls++; assert.deepEqual(input, firstBody); assert.equal(options?.idempotencyKey, firstKey);
        return accepted(input);
      } });
      assert.equal(resumed.state, 'drained'); assert.equal(resumed.cursor, 2); assert.equal(calls, 1);
      assert.deepEqual(resumed.processed.map(p => p.state), ['dispatched', 'duplicate']);
      assert.equal((await adapter.run(transport)).processed.length, 0);
    } finally { adapter.close(); }
  } finally { await f.cleanup(); }
});

test('editing a pending source revision blocks replay without advancing the cursor', async () => {
  const f = await fixture(); const e = event(); f.write(1, e);
  try {
    const adapter = await SqliteLifecycleAdapter.open(f.input);
    try {
      await adapter.run({ ...transport, dispatchHandoff: async () => { throw new Error('lost'); } });
      f.write(1, { ...e, summary: 'Changed immutable history.' });
      let sent = false;
      const result = await adapter.run({ ...transport, dispatchHandoff: async input => { sent = true; return accepted(input); } });
      assert.equal(result.state, 'blocked');
      assert.equal(result.state === 'blocked' && result.code, 'lifecycle_projection_conflict');
      assert.equal(result.cursor, 0); assert.equal(sent, false);
    } finally { adapter.close(); }
  } finally { await f.cleanup(); }
});

test('foreign scope, policy revocation, oversized rows and bad responses never count as delivered', async () => {
  const f = await fixture();
  try {
    for (const changed of [{ organizationId: 'org_foreign' }, { repositoryBindingId: randomUUID() },
      { targetEndpointId: randomUUID() }, { sourceEndpointId: randomUUID() }]) {
      f.write(1, { ...event(), ...changed });
      await assert.rejects(previewLifecycleSource(f.input), /lifecycle_scope_mismatch/);
    }
    f.write(1, event());
    await assert.rejects(previewLifecycleSource({ ...f.input, authorize: async () => ({ approved: false }) }), /lifecycle_policy_denied/);
    f.write(1, { ...event(), summary: 'x'.repeat(20000) });
    await assert.rejects(previewLifecycleSource(f.input), /lifecycle_event_too_large/);
    f.write(1, event());
    const adapter = await SqliteLifecycleAdapter.open(f.input);
    try {
      const result = await adapter.run({ ...transport, dispatchHandoff: async () => ({ ok: true }) });
      assert.equal(result.state, 'blocked'); assert.equal(result.cursor, 0);
      assert.equal(result.state === 'blocked' && result.code, 'lifecycle_response_invalid');
      await assert.rejects(adapter.run({ ...transport, organizationId: 'org_foreign' }), /lifecycle_transport_scope_mismatch/);
    } finally { adapter.close(); }
  } finally { await f.cleanup(); }
});

test('source aliases and reusing a state database for another repository are rejected', async () => {
  const f = await fixture();
  try {
    await assert.rejects(SqliteLifecycleAdapter.open({ ...f.input, statePath: f.sourcePath }), /lifecycle_state_is_source/);
    const adapter = await SqliteLifecycleAdapter.open(f.input); adapter.close();
    await assert.rejects(SqliteLifecycleAdapter.open({ ...f.input,
      scope: { ...scope, repositoryBindingId: randomUUID() } }), /lifecycle_state_scope_conflict/);
  } finally { await f.cleanup(); }
});

test('concurrent adapters cannot dispatch the same source while an owner is alive', async () => {
  const f = await fixture(); f.write(1, event());
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const started = new Promise<void>(r => { entered = r; });
  try {
    const a = await SqliteLifecycleAdapter.open(f.input); const b = await SqliteLifecycleAdapter.open(f.input);
    try {
      const flight = a.run({ ...transport, dispatchHandoff: async input => { entered(); await gate; return accepted(input); } });
      await started;
      await assert.rejects(b.run(transport), /lifecycle_adapter_busy/);
      release(); assert.equal((await flight).state, 'drained');
      assert.equal((await b.run(transport)).processed.length, 0);
    } finally { a.close(); b.close(); }
  } finally { release(); await f.cleanup(); }
});

test('expired history is recorded explicitly without launching work', async () => {
  const f = await fixture(); f.write(1, event());
  try {
    const adapter = await SqliteLifecycleAdapter.open({ ...f.input, now: new Date('2026-09-26T00:00:00Z') });
    try {
      const result = await adapter.run({ ...transport, dispatchHandoff: async () => { throw new Error('must not dispatch'); } });
      assert.equal(result.processed[0]?.state, 'expired'); assert.equal(result.cursor, 1);
    } finally { adapter.close(); }
  } finally { await f.cleanup(); }
});

test('actual SDK and SQLite replay after process exit produce one logical local-service handoff', async () => {
  const f = await fixture(); f.write(1, event());
  const bodies: string[] = []; const keys: string[] = []; const responses = new Map<string, Record<string, unknown>>();
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    bodies.push(body); const key = String(request.headers['idempotency-key']); keys.push(key);
    assert.equal(request.url, `/api/v1/orgs/${scope.organizationId}/agent-fabric/conversations`);
    assert.equal(request.headers.authorization, 'Bearer fixture-only');
    if (!responses.has(key)) responses.set(key, accepted(JSON.parse(body)));
    response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify(responses.get(key)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const script = `import { SqliteLifecycleAdapter } from ${JSON.stringify(new URL('./index.js', import.meta.url).href)};
      import { AgentFabricClient } from '@dharma-ai-labs/agent-fabric-sdk';
      const input=JSON.parse(process.env.FIXTURE_INPUT); input.now=new Date(input.now);
      input.authorize=async()=>({approved:true,policyRevision:'policy-1'});
      const adapter=await SqliteLifecycleAdapter.open(input);
      const client=new AgentFabricClient({organizationId:input.scope.organizationId,token:'fixture-only',baseUrl:process.env.FIXTURE_URL});
      await adapter.run({organizationId:client.organizationId,dispatchHandoff:async(input,options)=>{
        await client.dispatchHandoff(input,options); process.exit(23); }});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(),
      env: { ...process.env, FIXTURE_INPUT: JSON.stringify(f.input), FIXTURE_URL: baseUrl }, stdio: 'ignore' });
    const [code] = await once(child, 'close'); assert.equal(code, 23);
    const adapter = await SqliteLifecycleAdapter.open(f.input);
    try {
      const result = await adapter.run(new AgentFabricClient({ organizationId: scope.organizationId, token: 'fixture-only', baseUrl }));
      assert.equal(result.state, 'drained'); assert.equal(result.cursor, 1); assert.equal(result.executionVerified, false);
      assert.equal(responses.size, 1); assert.equal(bodies.length, 2);
      assert.equal(bodies[0], bodies[1]); assert.equal(keys[0], keys[1]);
    } finally { adapter.close(); }
  } finally { server.close(); await once(server, 'close'); await f.cleanup(); }
});

test('an unanswered handoff that later expires stays pending reconciliation', async () => {
  const f = await fixture(); f.write(1, event());
  try {
    let adapter = await SqliteLifecycleAdapter.open(f.input);
    await adapter.run({ ...transport, dispatchHandoff: async () => { throw new Error('response lost'); } });
    adapter.close();
    adapter = await SqliteLifecycleAdapter.open({ ...f.input, now: new Date('2026-09-26T00:00:00Z') });
    try {
      const result = await adapter.run(transport);
      assert.equal(result.state, 'blocked'); assert.equal(result.cursor, 0);
      assert.equal(result.state === 'blocked' && result.code, 'lifecycle_pending_expired');
    } finally { adapter.close(); }
  } finally { await f.cleanup(); }
});

test('an unrelated existing state database remains byte-for-byte untouched', async () => {
  const f = await fixture();
  try {
    const db = new DatabaseSync(f.statePath); db.exec('CREATE TABLE customer_history (data TEXT);'); db.close();
    const before = await readFile(f.statePath);
    await assert.rejects(SqliteLifecycleAdapter.open(f.input), /lifecycle_state_not_adapter/);
    assert.deepEqual(await readFile(f.statePath), before);
  } finally { await f.cleanup(); }
});

test('source task attribution is required in the accepted child task', async () => {
  const f = await fixture(); f.write(1, event());
  try {
    const adapter = await SqliteLifecycleAdapter.open(f.input);
    try {
      const result = await adapter.run({ ...transport, dispatchHandoff: async input => {
        const result = accepted(input); return { ...result, task: { ...result.task, source_endpoint_id: randomUUID() } };
      } });
      assert.equal(result.state, 'blocked'); assert.equal(result.cursor, 0);
      assert.equal(result.state === 'blocked' && result.code, 'lifecycle_response_invalid');
    } finally { adapter.close(); }
  } finally { await f.cleanup(); }
});

test('an unresponsive transport is bounded and a subsequent policy revocation prevents replay', async () => {
  const f = await fixture(); f.write(1, event());
  try {
    let adapter = await SqliteLifecycleAdapter.open({ ...f.input, requestTimeoutMs: 20 });
    const result = await adapter.run({ ...transport, dispatchHandoff: async () => new Promise(() => {}) });
    assert.equal(result.state, 'blocked'); assert.equal(result.cursor, 0);
    assert.equal(result.state === 'blocked' && result.code, 'lifecycle_transport_unavailable');
    adapter.close();
    adapter = await SqliteLifecycleAdapter.open({ ...f.input, authorize: async () => ({ approved: false }) });
    try {
      const revoked = await adapter.run({ ...transport, dispatchHandoff: async () => { throw new Error('must not send'); } });
      assert.equal(revoked.state === 'blocked' && revoked.code, 'lifecycle_policy_denied');
      assert.equal(revoked.cursor, 0);
    } finally { adapter.close(); }
  } finally { await f.cleanup(); }
});

test('default reference runner is metadata-only dry-run and never initializes state or a client', async () => {
  const f = await fixture(); f.write(1, event());
  try {
    const config = join(f.root, 'config.mjs');
    await writeFile(config, `const input=${JSON.stringify(f.input)}; input.now=new Date(input.now);
      input.authorize=async()=>({approved:true,policyRevision:'policy-1'});
      input.createClient=()=>{throw new Error('dry-run must not create a client');}; export default input;`);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/run.mjs', import.meta.url)),
      '--config', config], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const [code] = await once(child, 'close'); assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout); assert.equal(result.state, 'preview'); assert.equal(result.executionVerified, false);
    assert.equal(result.events.length, 1); assert.ok(!stdout.includes('stateEnvelope')); assert.ok(!stdout.includes('Reviewed plan'));
    await assert.rejects(access(f.statePath), /ENOENT/);
  } finally { await f.cleanup(); }
});

test('a state hard-link to source is refused before any source write', async () => {
  const f = await fixture();
  try {
    await link(f.sourcePath, f.statePath); const before = await readFile(f.sourcePath);
    await assert.rejects(SqliteLifecycleAdapter.open(f.input), /lifecycle_state_is_source/);
    assert.deepEqual(await readFile(f.sourcePath), before);
  } finally { await f.cleanup(); }
});

test('editing the last consumed projection row blocks further reads', async () => {
  const f = await fixture(); const e = event(); f.write(1, e);
  try {
    const adapter = await SqliteLifecycleAdapter.open(f.input);
    try {
      assert.equal((await adapter.run(transport)).state, 'drained');
      f.write(1, { ...e, summary: 'History altered after consumption.' });
      const result = await adapter.run(transport);
      assert.equal(result.state, 'blocked'); assert.equal(result.cursor, 1);
      assert.equal(result.state === 'blocked' && result.code, 'lifecycle_consumed_history_changed');
    } finally { adapter.close(); }
  } finally { await f.cleanup(); }
});
