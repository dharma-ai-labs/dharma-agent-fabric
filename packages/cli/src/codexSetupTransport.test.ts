import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, sep} from 'node:path';
import test from 'node:test';
import {LocalVault} from '@dharma-ai-labs/agent-fabric-local-vault';
import {openCodexAppServerTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import {createCodexSetupAdmission, type CodexSetupIntent} from './codexSetupAdmission.js';
import {createCodexSetupVaultJournal} from './codexSetupVaultJournal.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const hash = `sha256:${'a'.repeat(64)}`;
const intent: CodexSetupIntent = {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2),
  organizationId: 'org_demo', recipientMembershipId: id(3), origin: 'https://hq.example', hostContextId: id(4),
  repositoryFingerprint: hash, policyRevision: 'policy-v1', scopeDigest: hash, contractDigest: hash,
  issuedAt: '2026-10-05T18:00:00.000Z', expiresAt: '2026-10-05T18:15:00.000Z'};
const binding = {connectionId: id(5), threadId: 'synthetic_thread', turnId: 'synthetic_turn', hostContextId: id(4)};
type Execute = Parameters<typeof createCodexSetupAdmission>[0]['execute'];

// Real stdio transport, synthetic server frames: no provider or model process.
const server = `
const lines = require('node:readline').createInterface({input: process.stdin});
let call = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', line => {
  const value = JSON.parse(line);
  if (value.method === 'initialize') send({id: value.id, result: {userAgent: 'setup-fixture'}});
  else if (value.method === 'ping') send({id: value.id, result: {pong: true}});
  else if (value.method === 'setup') {
    send({id: value.id, result: {dispatched: true}});
    send({id: 'fixture_' + (++call), method: 'item/tool/call', params: {
      threadId: 'synthetic_thread', turnId: 'synthetic_turn', callId: 'fixture_' + call,
      tool: 'dharma_setup_reference', namespace: null,
      arguments: {operationId: '${id(1)}', setupReference: '${id(2)}'}
    }});
  } else if (typeof value.id === 'string' && value.result) {
    send({method: 'setup/disposition', params: value.result});
  }
});
`;

async function fixture(execute: Execute) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-setup-transport-'));
  const vault = await LocalVault.open({root, masterKey: randomBytes(32)});
  const owner = createCodexSetupAdmission({intent, ...binding, responseWaitMs: 10,
    now: () => Date.parse('2026-10-05T18:01:00.000Z'),
    current: async () => ({...binding, mode: 'setup'}), qualifyHost: async () => true,
    journal: createCodexSetupVaultJournal(vault), execute, verifyReadiness: async () => true});
  const clean = async () => {
    vault.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}fabric-setup-transport-`)) throw new Error('fixture_cleanup_scope_invalid');
    await rm(root, {recursive: true, force: true});
  };
  try {
    const transport = await openCodexAppServerTransport({command: process.execPath,
      argv: ['-e', server], cwd: root, environment: process.platform === 'win32'
        ? {SystemRoot: process.env.SystemRoot} : {}, requestTimeoutMs: 2000, toolCallTimeoutMs: 1000});
    const unregister = transport.onToolCall(owner.handler);
    const close = async () => {
      owner.close(); unregister();
      try {await transport.close();} finally {await owner.settled; await clean();}
    };
    const request = async () => {
      let timer: NodeJS.Timeout | undefined; let unregisterNotification = () => {};
      const disposition = new Promise<any>((done, fail) => {
        timer = setTimeout(() => fail(new Error('fixture_disposition_missing')), 4000);
        unregisterNotification = transport.onNotification((value: any) => {
          if (value.method === 'setup/disposition') done(value.params);
        });
      });
      try {assert.deepEqual(await transport.request('setup', {}), {dispatched: true}); return await disposition;}
      finally {if (timer) clearTimeout(timer); unregisterNotification();}
    };
    return {owner, transport, request, close};
  } catch (error) {owner.close(); await owner.settled; await clean(); throw error;}
}

test('public stdio adapter returns bounded status and reconciles the same encrypted operation', async () => {
  let release!: () => void; let executions = 0;
  const finish = new Promise<void>(done => {release = done;});
  const f = await fixture(async () => {executions++; await finish; return {state: 'completed', readinessReceiptId: id(6)};});
  try {
    const pending = await f.request();
    assert.equal(pending.success, false);
    assert.equal(JSON.parse(pending.contentItems[0].text).code, 'codex_setup_in_progress');
    assert.equal(f.owner.pending, true); assert.equal(executions, 1);
    assert.deepEqual(await f.transport.request('ping', {}), {pong: true});
    assert.equal(JSON.parse((await f.request()).contentItems[0].text).code, 'codex_setup_in_progress');
    assert.equal(executions, 1);
    release(); await f.owner.settled;
    const complete = await f.request();
    assert.equal(complete.success, true);
    assert.deepEqual(JSON.parse(complete.contentItems[0].text), {
      operationId: id(1), state: 'completed', readinessReceiptId: id(6)});
    assert.equal(executions, 1);
    assert.deepEqual(await f.transport.request('ping', {}), {pong: true});
  } finally {release(); await f.close();}
});

test('normal owning lifecycle closes a returned callback operation without a protected effect', async () => {
  let effects = 0; let stopped = false; let operationSignal: AbortSignal | undefined;
  const f = await fixture(async (_intent, signal, current) => {
    operationSignal = signal;
    await new Promise<void>(done => {if (signal.aborted) done(); else signal.addEventListener('abort', () => done(), {once: true});});
    if (await current()) effects++;
    stopped = true; return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
  });
  try {
    assert.equal(JSON.parse((await f.request()).contentItems[0].text).code, 'codex_setup_in_progress');
    assert.ok(operationSignal); assert.equal(operationSignal.aborted, false);
    assert.equal(f.owner.pending, true); assert.equal(stopped, false);
  } finally {await f.close();}
  assert.equal(operationSignal?.aborted, true); assert.equal(stopped, true); assert.equal(effects, 0);
  assert.equal(f.owner.pending, false);
  await assert.rejects(f.transport.request('ping', {}), /codex_app_server_unavailable/);
});
