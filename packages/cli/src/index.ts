#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { validateContract } from '@dharma-ai/agent-fabric-contracts';
import { buildTrajectoryCapsule } from '@dharma-ai/agent-fabric-evidence-reduction';
import { LocalVault, loadExplicitTestKey } from '@dharma-ai/agent-fabric-local-vault';
import { loadOrganizationPolicy } from '@dharma-ai/agent-fabric-policy';
import { claudeAdapter, codexAdapter, providerAdapters } from '@dharma-ai/agent-fabric-provider-adapters';

const VERSION = '0.1.0';
type Output = unknown;

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

function print(value: Output): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function dharmaHome(): string {
  return resolve(process.env.DHARMA_HOME || resolve(homedir(), '.dharma'));
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
  const vault = await LocalVault.open({ root: resolve(dharmaHome(), 'vault'), masterKey: loadExplicitTestKey(process.env) });
  try {
    const raw = Buffer.from(session.records.map((record) => JSON.stringify(record.native)).join('\n'), 'utf8');
    const rawContentId = await vault.putBlob(raw, 'raw-provider-session');
    const organizationId = String(flags.get('organization-id') || policy.organizationId);
    const workspaceId = String(flags.get('workspace-id') || `workspace_${createHash('sha256').update(workspace).digest('hex').slice(0, 20)}`);
    const deviceId = String(flags.get('device-id') || process.env.DHARMA_DEVICE_ID || 'device_local_unenrolled');
    vault.recordSession({
      sessionId: session.sessionId, provider: session.provider, workspaceId,
      sourceLocator: session.sourcePath, status: session.coverage, observedAt: session.endedAt,
    });
    const capsule = buildTrajectoryCapsule({
      organizationId, deviceId, workspaceId, session, policy, rawContentId, rawBytes: raw.byteLength,
    });
    const schemaDirectory = resolve(import.meta.dirname, '../../../schemas');
    const validation = await validateContract(
      schemaDirectory,
      'https://schemas.dharma-ai.io/trajectory-capsule/v1',
      capsule,
    );
    if (!validation.ok) {
      throw new Error(`Trajectory capsule failed schema validation: ${JSON.stringify(validation.errors)}`);
    }
    const capsuleBlob = await vault.putBlob(Buffer.from(JSON.stringify(capsule)), 'trajectory-capsule');
    vault.recordCapsule(capsule.trajectoryId, capsule.revision, capsule.capsuleHash, capsuleBlob);
    const output = flags.get('output');
    if (typeof output === 'string') await writeFile(resolve(output), `${JSON.stringify(capsule, null, 2)}\n`, { mode: 0o600 });
    return capsule;
  } finally {
    vault.close();
  }
}

async function workspaceAdd(flags: Map<string, string | boolean>, positional: string[]): Promise<Output> {
  const path = await realpath(positional[0] || required(flags, 'path'));
  const organizationId = required(flags, 'organization-id');
  const home = dharmaHome();
  const registryPath = resolve(home, 'registry', 'workspaces.json');
  await mkdir(resolve(home, 'registry'), { recursive: true, mode: 0o700 });
  let registry: Array<Record<string, unknown>> = [];
  try { registry = JSON.parse(await readFile(registryPath, 'utf8')) as Array<Record<string, unknown>>; } catch {}
  const workspaceId = `workspace_${createHash('sha256').update(`${organizationId}:${path}`).digest('hex').slice(0, 20)}`;
  const without = registry.filter((item) => item.workspaceId !== workspaceId);
  without.push({ workspaceId, organizationId, routeHash: createHash('sha256').update(path).digest('hex'), status: 'active' });
  await writeFile(registryPath, `${JSON.stringify(without, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, workspaceId, organizationId, pathStored: false };
}

export async function run(argv: string[]): Promise<Output> {
  const { positional, flags } = options(argv);
  const [command, subcommand] = positional;
  if (flags.has('version') || command === 'version') return { version: VERSION };
  if (command === 'providers' && subcommand === 'list') {
    return { providers: await Promise.all(providerAdapters.map((adapter) => adapter.capability())) };
  }
  if (command === 'workspace' && subcommand === 'add') return workspaceAdd(flags, positional.slice(2));
  if (command === 'capture' || (command === 'evidence' && subcommand === 'capture')) return capture(flags);
  if (command === 'status') {
    return { version: VERSION, home: dharmaHome(), enrolled: Boolean(process.env.DHARMA_DEVICE_ID), relay: 'stopped' };
  }
  if (command === 'tasks' && subcommand === 'list') return { tasks: [], coverage: 'local_only' };
  if (command === 'skills' && subcommand === 'status') return { installations: [], coverage: 'local_only' };
  throw new Error('Usage: dharma <status|providers list|workspace add|capture|tasks list|skills status> [options]');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  run(process.argv.slice(2)).then(print).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  });
}
