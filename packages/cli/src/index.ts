#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { validateContract } from '@dharma-ai/agent-fabric-contracts';
import { buildTrajectoryCapsule } from '@dharma-ai/agent-fabric-evidence-reduction';
import { LocalVault, loadOrCreateVaultMasterKey } from '@dharma-ai/agent-fabric-local-vault';
import { loadOrganizationPolicy } from '@dharma-ai/agent-fabric-policy';
import { claudeAdapter, codexAdapter, providerAdapters } from '@dharma-ai/agent-fabric-provider-adapters';
import {
  AgentFabricClient, beginEnrollment, loadOrCreateDeviceIdentity, pollEnrollment, saveDeviceConfig, type DeviceConfig,
} from '@dharma-ai/agent-fabric-relay-client';
import { executeTask, FileTaskReceiptStore, type TaskEnvelope } from '@dharma-ai/agent-fabric-task-runner';

const VERSION = '0.1.0';
const execFileAsync = promisify(execFile);
type Output = unknown;

interface WorkspaceRecord {
  workspaceId: string;
  organizationId: string;
  name: string;
  path: string;
  routeHash: string;
  repositoryRemoteHash: string | null;
  defaultBranch: string | null;
  status: 'active';
}

function options(args: string[]): { positional: string[]; flags: Map<string, string | boolean> } {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const [rawKey, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) { flags.set(rawKey!, inline); continue; }
    const next = args[index + 1];
    if (next && !next.startsWith('--')) { flags.set(rawKey!, next); index += 1; }
    else flags.set(rawKey!, true);
  }
  return { positional, flags };
}

function required(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing required option --${name}.`);
  return value;
}

function print(value: Output): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function dharmaHome(): string { return resolve(process.env.DHARMA_HOME || resolve(homedir(), '.dharma')); }
function configPath() { return resolve(dharmaHome(), 'device.json'); }
function protocolStatePath() { return resolve(dharmaHome(), 'relay', 'protocol-state.json'); }
function workspaceRegistryPath() { return resolve(dharmaHome(), 'registry', 'workspaces.json'); }

function deterministicUuid(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function platform(): Promise<DeviceConfig['platform']> {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'linux') {
    try { if (/microsoft|wsl/i.test(await readFile('/proc/version', 'utf8'))) return 'wsl'; } catch {}
    return 'linux';
  }
  throw new Error(`Unsupported device platform: ${process.platform}`);
}

async function registry(): Promise<WorkspaceRecord[]> {
  try { return JSON.parse(await readFile(workspaceRegistryPath(), 'utf8')) as WorkspaceRecord[]; }
  catch { return []; }
}

async function gitValue(workspace: string, argv: string[]) {
  try { return (await execFileAsync('git', ['-C', workspace, ...argv], { timeout: 10_000 })).stdout.trim() || null; }
  catch { return null; }
}

async function client() {
  const instance = await AgentFabricClient.open({ configPath: configPath(), statePath: protocolStatePath() });
  await instance.openSession(VERSION);
  return instance;
}

async function login(flags: Map<string, string | boolean>): Promise<Output> {
  const hqUrl = String(flags.get('hq-url') || 'https://hq.dharma-ai.io').replace(/\/$/, '');
  const organizationId = required(flags, 'organization-id');
  const name = String(flags.get('device-name') || `${process.env.USER || process.env.USERNAME || 'developer'} device`);
  const devicePlatform = await platform();
  const identity = await loadOrCreateDeviceIdentity({ hqUrl, organizationId });
  const enrollment = await beginEnrollment({ hqUrl, organizationId, name, platform: devicePlatform, publicKeyEd25519: identity.publicKeyEd25519 });
  if (flags.has('no-wait')) return { ok: true, status: 'pending', ...enrollment };
  const deadline = Date.now() + enrollment.expiresInSeconds * 1_000;
  while (Date.now() < deadline) {
    const result = await pollEnrollment({ hqUrl, deviceCode: enrollment.deviceCode });
    if (result.status === 'approved') {
      if (typeof result.deviceId !== 'string' || typeof result.relayUrl !== 'string' || typeof result.serverPublicKeyEd25519 !== 'string') {
        throw new Error('Enrollment was approved but the relay or server signing key is not configured.');
      }
      const config: DeviceConfig = {
        schema: 'dharma.device-config/v1', hqUrl, organizationId, deviceId: result.deviceId,
        deviceName: name, platform: devicePlatform, publicKeyEd25519: identity.publicKeyEd25519,
        serverPublicKeyEd25519: result.serverPublicKeyEd25519, relayUrl: result.relayUrl, enrolledAt: new Date().toISOString(),
      };
      await saveDeviceConfig(configPath(), config);
      return { ok: true, status: 'approved', deviceId: config.deviceId, organizationId, relayUrl: config.relayUrl };
    }
    if (result.status === 'denied' || result.status === 'expired') throw new Error(`Enrollment ${result.status}.`);
    await new Promise((accept) => setTimeout(accept, 2_000));
  }
  throw new Error(`Enrollment timed out. Approve it at ${enrollment.verificationUri}`);
}

async function capture(flags: Map<string, string | boolean>): Promise<Output> {
  const workspace = await realpath(required(flags, 'workspace'));
  const provider = required(flags, 'provider');
  const policy = await loadOrganizationPolicy(required(flags, 'policy'));
  const adapter = provider === 'codex' ? codexAdapter : provider === 'claude' ? claudeAdapter : null;
  if (!adapter) throw new Error(`Unsupported capture provider: ${provider}`);
  const root = flags.get('source-root');
  const sessions = await adapter.discover({ workspace, roots: typeof root === 'string' ? [root] : undefined });
  if (sessions.length === 0) throw new Error('No workspace-qualified provider sessions were found.');
  const session = sessions.at(-1)!;
  const device = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
  const registered = (await registry()).find((item) => item.path === workspace);
  if (!registered) throw new Error('Workspace is not registered locally. Run dharma workspace add.');
  const vault = await LocalVault.open({ root: resolve(dharmaHome(), 'vault'), masterKey: await loadOrCreateVaultMasterKey() });
  try {
    const raw = Buffer.from(session.records.map((record) => JSON.stringify(record.native)).join('\n'), 'utf8');
    const rawContentId = await vault.putBlob(raw, 'raw-provider-session');
    vault.recordSession({ sessionId: session.sessionId, provider: session.provider, workspaceId: registered.workspaceId, sourceLocator: session.sourcePath, status: session.coverage, observedAt: session.endedAt });
    const capsule = buildTrajectoryCapsule({
      organizationId: device.organizationId, deviceId: device.deviceId, workspaceId: registered.workspaceId,
      session, policy, rawContentId, rawBytes: raw.byteLength,
    });
    const validation = await validateContract(resolve(import.meta.dirname, '../../../schemas'), 'https://schemas.dharma-ai.io/trajectory-capsule/v1', capsule);
    if (!validation.ok) throw new Error(`Trajectory capsule failed schema validation: ${JSON.stringify(validation.errors)}`);
    const capsuleBlob = await vault.putBlob(Buffer.from(JSON.stringify(capsule)), 'trajectory-capsule');
    vault.recordCapsule(capsule.trajectoryId, capsule.revision, capsule.capsuleHash, capsuleBlob);
    const output = flags.get('output');
    if (typeof output === 'string') await writeFile(resolve(output), `${JSON.stringify(capsule, null, 2)}\n`, { mode: 0o600 });
    if (flags.has('sync')) return { capsule, sync: await (await client()).syncTrajectory(capsule) };
    return capsule;
  } finally { vault.close(); }
}

async function workspaceAdd(flags: Map<string, string | boolean>, positional: string[]): Promise<Output> {
  const path = await realpath(positional[0] || required(flags, 'path'));
  const device = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
  const organizationId = String(flags.get('organization-id') || device.organizationId);
  if (organizationId !== device.organizationId) throw new Error('Workspace organization must match the enrolled device.');
  await mkdir(resolve(dharmaHome(), 'registry'), { recursive: true, mode: 0o700 });
  const workspaceId = deterministicUuid(`${organizationId}:${device.deviceId}:${path}`);
  const remote = await gitValue(path, ['config', '--get', 'remote.origin.url']);
  const entry: WorkspaceRecord = {
    workspaceId, organizationId, name: String(flags.get('name') || basename(path)), path,
    routeHash: `sha256:${createHash('sha256').update(path).digest('hex')}`,
    repositoryRemoteHash: remote ? `sha256:${createHash('sha256').update(remote).digest('hex')}` : null,
    defaultBranch: await gitValue(path, ['branch', '--show-current']), status: 'active',
  };
  const without = (await registry()).filter((item) => item.workspaceId !== workspaceId);
  without.push(entry);
  await writeFile(workspaceRegistryPath(), `${JSON.stringify(without, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, workspaceId, organizationId, pathStoredLocally: true, pathDisclosedToServer: false };
}

async function workspaceSync(flags: Map<string, string | boolean>, positional: string[]): Promise<Output> {
  const workspaceId = positional[0] || required(flags, 'workspace-id');
  const item = (await registry()).find((candidate) => candidate.workspaceId === workspaceId);
  if (!item) throw new Error('Workspace is not registered locally.');
  const providers = await Promise.all(providerAdapters.map((adapter) => adapter.capability()));
  return (await client()).registerWorkspace({
    workspaceId: item.workspaceId, name: item.name, routeHash: item.routeHash,
    repositoryRemoteHash: item.repositoryRemoteHash, defaultBranch: item.defaultBranch,
    policyRevision: required(flags, 'policy-revision'), providers,
  });
}

async function evidenceSync(flags: Map<string, string | boolean>): Promise<Output> {
  const capsule = JSON.parse(await readFile(resolve(required(flags, 'file')), 'utf8'));
  return (await client()).syncTrajectory(capsule);
}

async function executeOneTask(
  fabric: AgentFabricClient,
  policy: Awaited<ReturnType<typeof loadOrganizationPolicy>>,
  leaseSeconds: number,
): Promise<Record<string, unknown>> {
  const polled = await fabric.pollTask(leaseSeconds);
  const taskRow = polled.task as { envelope?: TaskEnvelope } | null | undefined;
  if (!taskRow?.envelope) return { ok: true, task: null };
  const task = taskRow.envelope;
  const workspace = (await registry()).find((item) => item.workspaceId === task.workspaceId);
  if (!workspace) throw new Error('Task workspace is not registered on this device.');
  const config = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
  if (task.target.deviceId !== config.deviceId) throw new Error('Task target does not match this enrolled device.');
  const serverPublicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519 }, format: 'jwk' });
  await fabric.postTaskEvent(task.taskId, 'started', { bundleHash: null });
  const heartbeats: Promise<unknown>[] = [];
  const heartbeat = setInterval(() => {
    heartbeats.push(fabric.postTaskEvent(task.taskId, 'lease_extended', { taskId: task.taskId }).catch(() => undefined));
  }, Math.max(15_000, Math.floor(leaseSeconds * 500)));
  let receipt;
  try {
    receipt = await executeTask({
      task, policy, workspace: workspace.path, relayStateDirectory: resolve(dharmaHome(), 'relay'), serverPublicKey,
      receiptStore: new FileTaskReceiptStore(resolve(dharmaHome(), 'relay', 'receipts')),
    });
  } finally {
    clearInterval(heartbeat);
    await Promise.allSettled(heartbeats);
  }
  const summary = {
    status: receipt.status, branch: receipt.branch,
    commandResults: receipt.commandResults.map(({ commandId, exitCode, signal, timedOut, stdoutSha256, stderrSha256 }) => ({ commandId, exitCode, signal, timedOut, stdoutSha256, stderrSha256 })),
    startedAt: receipt.startedAt, completedAt: receipt.completedAt,
  };
  await fabric.postTaskEvent(task.taskId, receipt.status, summary);
  return { ok: true, taskId: task.taskId, receipt: summary };
}

async function runOneTask(flags: Map<string, string | boolean>): Promise<Output> {
  const policy = await loadOrganizationPolicy(required(flags, 'policy'));
  return executeOneTask(await client(), policy, Number(flags.get('lease-seconds') || 120));
}

async function relayStart(flags: Map<string, string | boolean>): Promise<Output> {
  const policy = await loadOrganizationPolicy(required(flags, 'policy'));
  const fabric = await client();
  const leaseSeconds = Number(flags.get('lease-seconds') || 120);
  const pollMs = Math.min(Math.max(Number(flags.get('poll-seconds') || 3), 1), 60) * 1_000;
  const pidPath = resolve(dharmaHome(), 'relay', 'relay.pid');
  await mkdir(resolve(dharmaHome(), 'relay'), { recursive: true, mode: 0o700 });
  await writeFile(pidPath, `${process.pid}\n`, { mode: 0o600 });
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let tasksCompleted = 0;
  try {
    do {
      const result = await executeOneTask(fabric, policy, leaseSeconds);
      if (result.taskId) tasksCompleted += 1;
      if (flags.has('once')) break;
      if (!result.taskId) await new Promise((accept) => setTimeout(accept, pollMs));
    } while (!stopping);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await rm(pidPath, { force: true });
  }
  return { ok: true, stopped: true, tasksCompleted };
}

export async function run(argv: string[]): Promise<Output> {
  const { positional, flags } = options(argv);
  const [command, subcommand] = positional;
  if (flags.has('version') || command === 'version') return { version: VERSION };
  if (command === 'login') return login(flags);
  if (command === 'providers' && subcommand === 'list') return { providers: await Promise.all(providerAdapters.map((adapter) => adapter.capability())) };
  if (command === 'workspace' && subcommand === 'add') return workspaceAdd(flags, positional.slice(2));
  if (command === 'workspace' && subcommand === 'sync') return workspaceSync(flags, positional.slice(2));
  if (command === 'capture' || (command === 'evidence' && subcommand === 'capture')) return capture(flags);
  if (command === 'evidence' && subcommand === 'sync') return evidenceSync(flags);
  if (command === 'status') {
    try {
      const config = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
      return { version: VERSION, home: dharmaHome(), enrolled: true, organizationId: config.organizationId, deviceId: config.deviceId, relay: 'on_demand' };
    } catch { return { version: VERSION, home: dharmaHome(), enrolled: false, relay: 'stopped' }; }
  }
  if (command === 'tasks' && subcommand === 'run-once') return runOneTask(flags);
  if (command === 'relay' && subcommand === 'start') return relayStart(flags);
  if (command === 'tasks' && subcommand === 'list') return { tasks: [], coverage: 'server_poll_requires_relay' };
  if (command === 'skills' && subcommand === 'status') return { installations: [], coverage: 'local_only' };
  throw new Error('Usage: dharma <login|status|providers list|workspace add|workspace sync|evidence capture|evidence sync|relay start|tasks run-once|skills status> [options]');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run(process.argv.slice(2)).then(print).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  });
}
