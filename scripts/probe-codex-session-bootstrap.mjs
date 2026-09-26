import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signCanonicalObject } from '../packages/contracts/dist/index.js';
import { runCodexBridgeQuestion } from '../packages/provider-adapters/dist/codexAppServerSession.js';
import { openCodexAppServerTransport } from '../packages/provider-adapters/dist/codexAppServerTransport.js';

// No model turn is permitted: exercise only the first-thread path and budget denial.
const command = process.argv[2];
if (!command) throw new Error('Usage: node scripts/probe-codex-session-bootstrap.mjs /absolute/path/to/codex');
const root = await mkdtemp(join(tmpdir(), 'dharma-codex-no-model-'));
const workspaceRoot = join(root, 'workspace');
await mkdir(workspaceRoot);
const environment = { ...process.env, CODEX_HOME: join(root, 'codex-home') };
await mkdir(environment.CODEX_HOME);
const argv = ['-c', 'default_permissions="dharma_bridge"',
  '-c', 'permissions.dharma_bridge.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
  '-c', 'permissions.dharma_bridge.network={enabled=false}', 'app-server'];
if (process.argv.includes('--diagnose-launch')) {
  const result = spawnSync(command, argv, { cwd: workspaceRoot, env: environment, input: '', timeout: 5000, encoding: 'utf8', windowsHide: true });
  process.stdout.write(JSON.stringify({ exitCode: result.status, stderr: result.stderr?.slice(0, 2000) }) + '\n');
  process.exit(result.status ?? 1);
}
const transport = await openCodexAppServerTransport({ command, cwd: workspaceRoot, environment, argv,
  requestTimeoutMs: 15000, experimentalApi: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
try {
  const created = await transport.request('thread/start', { cwd: workspaceRoot,
    approvalPolicy: 'never', permissions: 'dharma_bridge', ephemeral: false });
  const threadId = created.thread.id;
  const read = await transport.request('thread/read', { threadId, includeTurns: false });
  const listed = await transport.request('permissionProfile/list', { cwd: workspaceRoot });
  const configured = await transport.request('config/read', { includeLayers: false });
  const now = new Date();
  const binding = { organizationId: 'org_synthetic', repositoryBindingId: randomUUID(), workspaceId: randomUUID(),
    endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID(), bindingId: randomUUID(),
    provider: 'codex', owner: 'dharma_bridge', threadId, workspaceRoot,
    expiresAt: new Date(now.getTime() + 120000).toISOString(), maximumProviderCostCents: 0 };
  const unsigned = { schema: 'dharma.session-question/v1', questionId: randomUUID(), taskId: randomUUID(),
    organizationId: binding.organizationId, repositoryBindingId: binding.repositoryBindingId,
    source: { workspaceId: randomUUID(), endpointId: randomUUID(), membershipId: randomUUID(), deviceId: randomUUID() },
    target: { workspaceId: binding.workspaceId, endpointId: binding.endpointId, membershipId: binding.membershipId,
      deviceId: binding.deviceId, bindingId: binding.bindingId, provider: 'codex' },
    category: 'code-review', question: 'This synthetic probe must never dispatch a model turn.',
    authority: { mode: 'read_only', readPaths: ['.'], network: 'deny', maximumProviderCostCents: 0 },
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 60000).toISOString(),
    nonce: randomUUID(), signerKeyVersion: 'synthetic-v1' };
  let budgetChecked = false;
  let consumed = false;
  let modelTurnRequested = false;
  const guarded = { onNotification: transport.onNotification,
    request(method, params) {
      if (method === 'turn/start') { modelTurnRequested = true; throw new Error('probe_model_turn_forbidden'); }
      return transport.request(method, params);
    } };
  let disposition;
  try {
    await runCodexBridgeQuestion({ transport: guarded, binding,
      question: { ...unsigned, signature: signCanonicalObject(unsigned, privateKey) },
      verifier: { resolvePublicKey: () => publicKey, consume: async () => { consumed = true; return true; } },
      exclusiveLease: { assertHeld: async () => true }, budget: { reserve: async () => { budgetChecked = true; return false; } } });
    disposition = 'unexpected_success';
  } catch (error) { disposition = error.message; }
  process.stdout.write(`${JSON.stringify({ createdStatus: created.thread.status?.type, readStatus: read.thread.status?.type,
    matchingThread: read.thread.id === threadId, disposition, budgetChecked, consumed, modelTurnRequested,
    profile: configured.config.permissions?.dharma_bridge,
    profileAvailability: listed.data?.filter(p => p.id === 'dharma_bridge') })}\n`);
  if (disposition !== 'codex_session_budget_unavailable' || !budgetChecked || consumed || modelTurnRequested) process.exitCode = 1;
} finally { await transport.close(); }
