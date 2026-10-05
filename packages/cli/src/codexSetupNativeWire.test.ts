import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import test from 'node:test';
import {openCodexAppServerTransport} from '@dharma-ai-labs/agent-fabric-provider-adapters/experimental/codex-transport';
import type {SecureSecretStore} from '@dharma-ai-labs/agent-fabric-secure-store';
import {prepareCodexBootstrapHost} from './bootstrapHostScope.js';
import {openCodexSetupVaultJournal} from './codexSetupVaultJournal.js';
import {startCodexSetupNativeHost} from './codexSetupNativeHost.js';
import {bootstrapFromCodexSetup, loadAgentFabricOnboardingContract} from './index.js';
import * as cli from './index.js';

const id = (n: number) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
test('native owner composition is exposed through the public CLI library, not a private cross-package import', () => {
  const publicApi = cli as unknown as {startCodexSetupNativeHost?: unknown; openCodexSetupVaultJournal?: unknown};
  assert.equal(publicApi.startCodexSetupNativeHost, startCodexSetupNativeHost);
  assert.equal(publicApi.openCodexSetupVaultJournal, openCodexSetupVaultJournal);
});
// Owned stdio child with synthetic native API frames; no provider, model or network.
const server = `
const lines = require('node:readline').createInterface({input: process.stdin});
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let name = '', cwd = '';
lines.on('line', line => {
  const value = JSON.parse(line), respond = result => send({id: value.id, result});
  if (value.method === 'initialize') respond({userAgent: 'native-setup-wire-fixture'});
  else if (value.method === 'permissionProfile/list') respond({data: [{id: 'dharma_bridge', allowed: true}]});
  else if (value.method === 'config/read') respond({config: {permissions: {dharma_bridge: {
    filesystem: {':minimal': 'read', ':workspace_roots': {'.': 'read'}}, network: {enabled: false}}}}});
  else if (value.method === 'thread/start') {
    if (value.params.permissions !== 'dharma_bridge' || value.params.dynamicTools.at(-1).name !== 'dharma_setup_reference') process.exit(3);
    cwd = value.params.cwd; respond({thread: {id: 'synthetic_thread', cwd, name, status: {type: 'idle'}}});
  } else if (value.method === 'thread/name/set') {name = value.params.name; respond({});}
  else if (value.method === 'thread/read') respond({thread: {id: 'synthetic_thread', cwd, name, status: {type: 'idle'}}});
  else if (value.method === 'turn/start') {
    send({id: 'fixture_call', method: 'item/tool/call', params: {threadId: 'synthetic_thread', turnId: 'synthetic_turn',
      callId: 'fixture_call', tool: 'dharma_setup_reference', namespace: null,
      arguments: {operationId: '${id(1)}', setupReference: '${id(2)}'}}});
    respond({turn: {id: 'synthetic_turn', status: 'inProgress'}});
  } else if (value.method === 'turn/interrupt') respond({});
  else if (value.id === 'fixture_call' && value.result) {
    send({method: 'fixture/disposition', params: value.result});
    send({method: 'turn/completed', params: {threadId: 'synthetic_thread', turn: {id: 'synthetic_turn', status: 'completed'}}});
  }
});
`;

async function fixture(run: (input: Parameters<typeof startCodexSetupNativeHost>[0],
  disposition: Promise<unknown>) => Promise<void>) {
  const root = await mkdtemp(resolve(tmpdir(), 'fabric-native-setup-wire-'));
  const workspace = resolve(root, 'source'), now = Date.now();
  const contract = await loadAgentFabricOnboardingContract();
  const prepared = prepareCodexBootstrapHost({workspace, signal: new AbortController().signal, current: async () => true,
    intent: {schema: 'dharma.codex-setup-intent/v1', operationId: id(1), setupReference: id(2), organizationId: 'org_demo',
      recipientMembershipId: id(3), origin: 'https://hq.example', hostContextId: id(4),
      repositoryFingerprint: `sha256:${'a'.repeat(64)}`, policyRevision: 'policy-v1', scopeDigest: `sha256:${'b'.repeat(64)}`,
      contractDigest: `sha256:${contract.sha256}`, issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString()}});
  const key = randomBytes(32).toString('base64');
  const store: SecureSecretStore = {backend: 'linux-secret-service', get: async () => key,
    put: async () => {throw new Error('unexpected fixture key write');}, delete: async () => {throw new Error('unexpected fixture key deletion');}};
  let transport: Awaited<ReturnType<typeof openCodexAppServerTransport>> | undefined, unsubscribe = () => {};
  let timer: NodeJS.Timeout | undefined;
  try {
    transport = await openCodexAppServerTransport({command: process.execPath, argv: ['-e', server], cwd: root,
      environment: process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot} : {}, requestTimeoutMs: 2000,
      toolCallTimeoutMs: 2000, experimentalApi: true});
    const owned = transport;
    const disposition = new Promise<unknown>((done, fail) => {
      timer = setTimeout(() => fail(new Error('synthetic_native_disposition_missing')), 5000);
      unsubscribe = owned.onNotification((raw: unknown) => {
        const event = raw as {method?: string; params?: unknown};
        if (event.method === 'fixture/disposition') done(event.params);
      });
    });
    await run({transport, workspace, name: 'implementer', intent: prepared.intent,
      openJournal: scope => openCodexSetupVaultJournal({root: resolve(root, 'vault'), scope, store}),
      signal: prepared.scope.signal, current: () => prepared.scope.current(), maximumProviderCostCents: 25,
      reserve: async () => true, execute: async () => ({state: 'completed', readinessReceiptId: id(6)}),
      verifyReadiness: async receipt => receipt === id(6)}, disposition);
  } finally {
    if (timer) clearTimeout(timer); unsubscribe(); prepared.scope.close();
    try {await transport?.close();} finally {await rm(root, {recursive: true, force: true});}
  }
}

test('native registration, encrypted journal and early-call binding compose over actual owned stdio', async () => {
  await fixture(async (input, disposition) => {
    let executed = 0; input.execute = async () => {executed++; return {state: 'completed', readinessReceiptId: id(6)};};
    const host = await startCodexSetupNativeHost(input);
    try {
      const result = await disposition as {success: boolean; contentItems: Array<{text: string}>};
      assert.equal(result.success, true);
      assert.deepEqual(JSON.parse(result.contentItems[0]!.text), {operationId: id(1), state: 'completed', readinessReceiptId: id(6)});
      await host.settled; assert.equal(executed, 1);
    } finally {await host.close();}
  });
});

test('actual CLI bootstrap guard remains unconfirmed through native registration without consuming a claim', async () => {
  await fixture(async (input, disposition) => {
    let bootstrap: unknown;
    input.execute = async (intent, signal, current) => {
      bootstrap = await bootstrapFromCodexSetup({intent, signal, current, workspace: input.workspace});
      return {state: 'unconfirmed', code: 'setup_execution_unconfirmed'};
    };
    const host = await startCodexSetupNativeHost(input);
    try {
      const result = await disposition as {success: boolean; contentItems: Array<{text: string}>};
      assert.equal(result.success, false); assert.equal(JSON.parse(result.contentItems[0]!.text).code, 'codex_setup_execution_unconfirmed');
      await host.settled;
      assert.ok(bootstrap && typeof bootstrap === 'object' && !Array.isArray(bootstrap));
      const observed = bootstrap as Record<string, unknown>;
      assert.equal(observed.code, 'codex_setup_host_execution_unqualified');
      assert.equal(observed.grantRedeemed, false); assert.equal(observed.effects, false);
    } finally {await host.close();}
  });
});
