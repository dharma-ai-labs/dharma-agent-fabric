import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { signCanonicalObject } from '../packages/contracts/dist/index.js';
import { LocalVault } from '../packages/local-vault/dist/index.js';
import { openCodexBoundSession } from '../packages/cli/dist/codexBoundSession.js';
import { openCodexAppServerTransport } from '../packages/provider-adapters/dist/codexAppServerTransport.js';

// No model turn is permitted: exercise only the first-thread path and budget denial.
const command = process.argv[2];
if (!command || !isAbsolute(command)) throw new Error('probe_command_invalid');
const homeIndex = process.argv.indexOf('--configured-home');
const configuredHome = homeIndex >= 0 ? process.argv[homeIndex + 1] : null;
if (homeIndex >= 0 && (!configuredHome || !isAbsolute(configuredHome))) throw new Error('probe_home_invalid');
if (configuredHome && !(await stat(configuredHome)).isDirectory()) throw new Error('probe_home_invalid');
const root = await mkdtemp(join(tmpdir(), 'dharma-codex-no-model-'));
const workspaceRoot = join(root, 'workspace');
await mkdir(workspaceRoot);
const environment = { ...process.env, CODEX_HOME: configuredHome ?? join(root, 'codex-home') };
if (!configuredHome) await mkdir(environment.CODEX_HOME);
const argv = ['-c', 'default_permissions="dharma_bridge"',
  '-c', 'permissions.dharma_bridge.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
  '-c', 'permissions.dharma_bridge.network={enabled=false}', 'app-server'];
if (process.argv.includes('--diagnose-launch')) {
  const result = spawnSync(command, argv, { cwd: workspaceRoot, env: environment, input: '', timeout: 5000, encoding: 'utf8', windowsHide: true });
  process.stdout.write(JSON.stringify({ exitCode: result.status, stderr: result.stderr?.slice(0, 2000) }) + '\n');
  process.exit(result.status ?? 1);
}
if (process.argv.includes('--diagnose-wire')) {
  // Diagnostic uses only this empty workspace/home and never submits turn/start.
  const child = spawn(command, argv, { cwd: workspaceRoot, env: environment, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 15000);
  lines.on('line', line => {
    if (Buffer.byteLength(line) > 16384) { child.kill(); process.exitCode = 1; return; }
    const message = JSON.parse(line);
    if (message.id === 1 && message.result) {
      send({ method: 'initialized', params: {} });
      send({ id: 2, method: 'thread/start', params: { cwd: workspaceRoot,
        approvalPolicy: 'never', permissions: 'dharma_bridge', ephemeral: false } });
    } else if ((message.id === 1 || message.id === 2) && message.error) {
      process.stdout.write(JSON.stringify({ method: message.id === 1 ? 'initialize' : 'thread/start',
        code: message.error.code, diagnostic: String(message.error.message).slice(0, 2000) }) + '\n');
      child.stdin.end(); process.exitCode = 1;
    } else if (message.id === 2 && message.result) {
      process.stdout.write(JSON.stringify({ method: 'thread/start', state: 'created' }) + '\n'); child.stdin.end();
    }
  });
  child.on('close', () => { clearTimeout(timer); lines.close(); });
  send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dharma-empty-home-diagnostic', version: '0.0.0' },
    capabilities: { experimentalApi: true } } });
  await new Promise(resolve => child.once('close', resolve));
  process.exit(process.exitCode ?? 0);
}
const transport = await openCodexAppServerTransport({ command, cwd: workspaceRoot, environment, argv,
  requestTimeoutMs: 15000, experimentalApi: true });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
try {
  if (configuredHome && process.platform === 'win32') {
    const readiness = await transport.request('windowsSandbox/readiness', {});
    if (readiness.status !== 'ready') throw new Error('probe_windows_sandbox_not_ready');
  }
  const created = await transport.request('thread/start', { cwd: workspaceRoot,
    approvalPolicy: 'never', permissions: 'dharma_bridge', ephemeral: false });
  const threadId = created.thread.id;
  const read = await transport.request('thread/read', { threadId, includeTurns: false });
  const listed = await transport.request('permissionProfile/list', { cwd: workspaceRoot });
  const configured = await transport.request('config/read', { includeLayers: false });
  let sandboxChecks = null;
  if (process.argv.includes('--check-sandbox')) {
    if (process.platform !== 'linux') throw new Error('probe_sandbox_check_os_unsupported');
    const allowed = join(workspaceRoot, 'allowed.txt');
    const denied = join(root, 'denied.txt');
    const marker = `synthetic-${randomUUID()}`;
    await writeFile(allowed, marker); await writeFile(denied, marker);
    const execute = command => transport.request('command/exec', { command, cwd: workspaceRoot,
      permissionProfile: 'dharma_bridge', timeoutMs: 3000, outputBytesCap: 4096 });
    const readable = await execute(['/bin/cat', allowed]);
    const outside = await execute(['/bin/cat', denied]);
    const write = await execute(['/bin/sh', '-c', 'printf blocked > denied-write.txt']);
    const curl = await execute(['/usr/bin/curl', '--version']);
    let requests = 0;
    const server = createServer((_req, res) => { requests++; res.end('synthetic'); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port;
    let network;
    try {
      const address = `http://127.0.0.1:${port}/`;
      const control = await fetch(address, { signal: AbortSignal.timeout(1000) });
      if (await control.text() !== 'synthetic') throw new Error('probe_network_control_failed');
      requests = 0;
      network = await execute(['/usr/bin/curl', '--noproxy', '*', '--max-time', '1', address]);
    }
    finally { await new Promise(resolve => server.close(resolve)); }
    const writeAbsent = await readFile(join(workspaceRoot, 'denied-write.txt')).then(() => false,
      error => { if (error.code !== 'ENOENT') throw error; return true; });
    sandboxChecks = { allowedRead: readable.exitCode === 0 && readable.stdout.trim() === marker,
      outsideReadDenied: outside.exitCode !== 0 && !outside.stdout.includes(marker),
      writeDenied: write.exitCode !== 0 && writeAbsent,
      networkDenied: curl.exitCode === 0 && network.exitCode !== 0 && requests === 0 };
    if (Object.values(sandboxChecks).some(value => !value)) throw new Error('probe_sandbox_enforcement_failed');
  }
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
  let budgetChecks = 0;
  let consumed = false;
  let modelTurnRequested = false;
  const guarded = { onNotification: transport.onNotification, close: transport.close,
    request(method, params) {
      if (method === 'turn/start') { modelTurnRequested = true; throw new Error('probe_model_turn_forbidden'); }
      return transport.request(method, params);
    } };
  const { threadId: _threadId, ...localScope } = binding;
  const localBinding = { ...localScope, schema: 'dharma.local-provider-session-binding/v1',
    sessionId: threadId, createdAt: now.toISOString() };
  const { organizationId, repositoryBindingId, workspaceId, endpointId, membershipId, deviceId, provider } = binding;
  const identity = { organizationId, repositoryBindingId, workspaceId, endpointId, membershipId, deviceId, provider };
  const vault = await LocalVault.open({ root: join(root, 'vault'), masterKey: randomBytes(32) });
  let owner;
  const dispositions = [];
  let leaseRetained = false;
  let leaseReleased = false;
  try {
    vault.saveProviderSessionBinding(localBinding);
    owner = await openCodexBoundSession({ vault, bindingId: binding.bindingId, identity,
      openTransport: async () => guarded,
      verifier: { resolvePublicKey: () => publicKey, consume: async () => { consumed = true; return true; } },
      budget: { reserve: async () => { budgetChecks++; return false; } } });
    for (let attempt = 0; attempt < 2; attempt++) {
      const candidate = { ...unsigned, questionId: randomUUID(), nonce: randomUUID() };
      try {
        await owner.runQuestion({ question: { ...candidate, signature: signCanonicalObject(candidate, privateKey) } });
        dispositions.push('unexpected_success');
      } catch (error) { dispositions.push(error.message); }
    }
    const sameThread = await transport.request('thread/read', { threadId, includeTurns: false });
    if (sameThread.thread.id !== threadId || sameThread.thread.status?.type !== 'idle') throw new Error('probe_live_thread_lost');
    const conflicting = vault.tryAcquireProviderSessionLease(binding.bindingId, identity);
    leaseRetained = conflicting === null;
    conflicting?.release();
    await owner.close();
    const reacquired = vault.tryAcquireProviderSessionLease(binding.bindingId, identity);
    leaseReleased = reacquired !== null;
    reacquired?.release();
  } finally {
    try { if (owner) await owner.close(); }
    finally { vault.close(); }
  }
  process.stdout.write(`${JSON.stringify({ createdStatus: created.thread.status?.type, readStatus: read.thread.status?.type,
    matchingThread: read.thread.id === threadId, dispositions, budgetChecks, consumed, modelTurnRequested,
    leaseRetained, leaseReleased,
    providerHomeMode: configuredHome ? 'configured' : 'disposable',
    sandboxChecks,
    profile: configured.config.permissions?.dharma_bridge,
    profileAvailability: listed.data?.filter(p => p.id === 'dharma_bridge') })}\n`);
  if (dispositions.length !== 2 || dispositions.some(value => value !== 'codex_session_budget_unavailable')
    || budgetChecks !== 2 || !leaseRetained || !leaseReleased || consumed || modelTurnRequested) process.exitCode = 1;
} finally { await transport.close(); }
