#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, link, mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { canonicalize, sha256, validateContract, verifyCanonicalObject, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
import { buildTrajectoryCapsule, redactValue, referencesExcludedPath, type RedactionStats } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import { assertPolicy, loadOrganizationPolicy, verifyServerAuthorizedPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { agyAdapter, claudeAdapter, codexAdapter, providerAdapters } from '@dharma-ai-labs/agent-fabric-provider-adapters';
import {
  AgentFabricClient, beginEnrollment, loadOrCreateDeviceIdentity, normalizeHqUrl, pollEnrollment, saveDeviceConfig, type DeviceConfig,
} from '@dharma-ai-labs/agent-fabric-relay-client';
import { getActiveSkillBundleId, installSkillBundle, verifySkillBundle, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import { executeTask, FileTaskReceiptStore, type TaskEnvelope, type TaskReceipt } from '@dharma-ai-labs/agent-fabric-task-runner';

const VERSION = '0.1.10';
const USAGE = 'Usage: dharma <onboard|login|status|providers list|workspace add|workspace sync|evidence preview|evidence capture|evidence capture-batch|evidence sync|evidence run-request|relay start|tasks run-once|skills sync|skills status|skills verify> [options]';
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

function print(value: Output): void {
  process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);
}

async function loadVaultModule() {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const warningName = warning instanceof Error ? warning.name : args.find((value) => value === 'ExperimentalWarning');
    if (warningName === 'ExperimentalWarning') return;
    return (original as (...values: unknown[]) => void).call(process, warning, ...args);
  }) as typeof process.emitWarning;
  try {
    return await import('@dharma-ai-labs/agent-fabric-local-vault');
  } finally {
    process.emitWarning = original;
  }
}

export function isDirectExecution(argvPath: string | undefined, moduleUrl: string): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(argvPath) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

function dharmaHome(): string { return resolve(process.env.DHARMA_HOME || resolve(homedir(), '.dharma')); }
function configPath() { return resolve(dharmaHome(), 'device.json'); }
function pendingEnrollmentPath() { return resolve(dharmaHome(), 'pending-enrollment.json'); }
function protocolStatePath() { return resolve(dharmaHome(), 'relay', 'protocol-state.json'); }
function workspaceRegistryPath() { return resolve(dharmaHome(), 'registry', 'workspaces.json'); }
function evidenceUploadLedgerPath() { return resolve(dharmaHome(), 'relay', 'evidence-upload-ledger.json'); }
function evidenceRequestReceiptPath(requestId: string) { return resolve(dharmaHome(), 'relay', 'evidence-requests', `${requestId}.json`); }

async function pathExists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function readSessionAllowlist(flags: Map<string, string | boolean>): Promise<string[] | null> {
  const path = flags.get('session-ids-file');
  if (typeof path !== 'string') return null;
  const values = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown;
  if (!Array.isArray(values) || values.length === 0 || values.length > 1_000
    || values.some((value) => typeof value !== 'string' || value.length > 160)) {
    throw new Error('Session ID allowlist must be a non-empty JSON string array with at most 1,000 entries.');
  }
  return [...new Set(values as string[])];
}

function boundedInteger(value: string | boolean | undefined, fallback: number, minimum: number, maximum: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function rawLocalRetentionDays(policy: Pick<OrganizationPolicy, 'retention'>): number {
  const value = policy.retention.rawLocalDays ?? 30;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 3_650) {
    throw new Error('Organization rawLocalDays retention must be an integer between 1 and 3650.');
  }
  return Number(value);
}

async function syncPendingRetentionCapsules(
  vault: {
    listPendingCapsuleSyncs<T>(limit?: number): Promise<Array<{ trajectoryId: string; revision: number; capsule: T }>>;
    markCapsuleSynced(trajectoryId: string, revision: number): void;
    discardPendingCapsuleSync(trajectoryId: string, revision: number, reason?: string): void;
  },
  fabric: AgentFabricClient,
  policy: OrganizationPolicy,
): Promise<number> {
  // The caller must obtain this policy from an authoritative control-plane
  // refresh. An expired policy pauses the queue instead of mutating it.
  assertPolicy(policy);
  let synced = 0;
  for (;;) {
    const pending = await vault.listPendingCapsuleSyncs<Record<string, unknown>>(100);
    if (pending.length === 0) return synced;
    for (const item of pending) {
      try {
        assertCapsuleIntegrity(item.capsule);
      } catch {
        vault.discardPendingCapsuleSync(item.trajectoryId, item.revision, 'capsule_integrity_failed');
        continue;
      }
      try {
        assertCapsuleAuthorizedByCurrentPolicy(item.capsule, policy);
      } catch {
        // A successfully refreshed policy is authoritative. Retire only the
        // superseded capsule so it cannot permanently block later valid work.
        vault.discardPendingCapsuleSync(item.trajectoryId, item.revision, 'authorization_superseded');
        continue;
      }
      await reserveDailyContentUpload(item.capsule, policy);
      await fabric.syncTrajectory(item.capsule);
      vault.markCapsuleSynced(item.trajectoryId, item.revision);
      synced += 1;
    }
  }
}

async function refreshVerifiedWorkspacePolicyForTransmission(
  policyPath: string,
  workspaceId: string,
  fabric: AgentFabricClient,
) {
  if (!workspaceId) throw new Error('Content transmission requires a registered workspace ID.');
  const item = (await registry()).find((candidate) => candidate.workspaceId === workspaceId);
  if (!item) throw new Error('Content transmission workspace is not registered locally.');
  const canonicalPolicyPath = resolve(item.path, '.dharma', 'approved-policy.json');
  if (resolve(policyPath) !== canonicalPolicyPath) {
    throw new Error('Content transmission requires the canonical registered workspace policy path.');
  }
  const current = await loadOrganizationPolicy(policyPath);
  if (current.organizationId !== item.organizationId) {
    throw new Error('Workspace policy organization does not match registration.');
  }
  await syncWorkspacePolicy(fabric, item, current.revision, true);
  return loadVerifiedWorkspacePolicy(policyPath, workspaceId);
}

export function assertCapsuleIntegrity(capsule: Record<string, unknown>) {
  const capsuleHash = String(capsule.capsuleHash || '');
  const { capsuleHash: _capsuleHash, ...unsigned } = capsule;
  if (!/^sha256:[a-f0-9]{64}$/.test(capsuleHash) || sha256(canonicalize(unsigned)) !== capsuleHash) {
    throw new Error('Trajectory capsule integrity check failed.');
  }
}

export function assertCapsuleAuthorizedByCurrentPolicy(capsule: Record<string, unknown>, policy: OrganizationPolicy) {
  assertPolicy(policy);
  const mode = capsule.automaticDisclosureMode;
  const receipt = capsule.redactionReceipt && typeof capsule.redactionReceipt === 'object' && !Array.isArray(capsule.redactionReceipt)
    ? capsule.redactionReceipt as Record<string, unknown> : {};
  if (!['metadata_only', 'local_analysis', 'customer_authorized_content'].includes(String(mode))
    || receipt.disclosureMode !== mode) {
    throw new Error('Trajectory capsule disclosure mode is invalid or inconsistent.');
  }
  const events = Array.isArray(capsule.events) ? capsule.events : [];
  if (mode !== 'customer_authorized_content') {
    const emptyRecord = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value as Record<string, unknown>).length === 0;
    if (!emptyRecord(capsule.repoState) || !emptyRecord(capsule.skillState)
      || !Array.isArray(capsule.validationResults) || capsule.validationResults.length !== 0) {
      throw new Error('Reduced trajectory capsule contains unauthorized auxiliary content.');
    }
    const contentIndex = Array.isArray(capsule.contentIndex) ? capsule.contentIndex : [];
    if (contentIndex.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
      || (entry as Record<string, unknown>).uploaded !== false
      || (entry as Record<string, unknown>).normalizedPath !== null)) {
      throw new Error('Reduced trajectory capsule contains an unauthorized content descriptor.');
    }
    for (const event of events) {
      const payload = event && typeof event === 'object' && !Array.isArray(event)
        ? (event as Record<string, unknown>).payload : null;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Reduced trajectory event payload is invalid.');
      }
      const record = payload as Record<string, unknown>;
      const allowedKeys = new Set(['nativeKind', 'recordBytes', 'contentOmitted']);
      if (Object.keys(record).some((key) => !allowedKeys.has(key)) || record.contentOmitted !== true) {
        throw new Error('Reduced trajectory capsule contains unauthorized provider content.');
      }
    }
    if (receipt.consentReceiptId !== null && receipt.consentReceiptId !== undefined) {
      throw new Error('Reduced trajectory capsule cannot claim a content consent receipt.');
    }
    return;
  }
  const disclosure = policy.evidence.automaticDisclosure;
  if (disclosure?.mode !== 'customer_authorized_content'
    || receipt.policyRevision !== policy.revision
    || receipt.consentReceiptId !== disclosure.consentReceiptId
    || !policy.serverAuthorization) {
    throw new Error('Queued content capsule is no longer authorized by the current signed policy.');
  }
}

async function acquirePidLock(lockPath: string, timeoutMs: number, timeoutMessage: string): Promise<() => Promise<void>> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const candidate = `${lockPath}.${process.pid}.${randomUUID()}.candidate`;
    try {
      await writeFile(candidate, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      await link(candidate, lockPath);
      await unlink(candidate);
      return async () => { await unlink(lockPath).catch(() => undefined); };
    } catch (error) {
      await unlink(candidate).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = Number((await readFile(lockPath, 'utf8')).trim());
        if (Number.isSafeInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (ownerError) {
            if ((ownerError as NodeJS.ErrnoException).code === 'ESRCH') {
              await unlink(lockPath);
              continue;
            }
          }
        } else {
          const metadata = await stat(lockPath);
          if (Date.now() - metadata.mtimeMs >= timeoutMs) {
            await unlink(lockPath);
            continue;
          }
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error(timeoutMessage);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }
}

async function withEvidenceLedgerLock<T>(operation: () => Promise<T>): Promise<T> {
  const release = await acquirePidLock(
    `${evidenceUploadLedgerPath()}.lock`,
    5_000,
    'Timed out waiting for the evidence upload ledger lock.',
  );
  try { return await operation(); }
  finally { await release(); }
}

async function writeJsonAtomic(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function reserveDailyEvidenceBytes(key: string, bytes: number, policy: OrganizationPolicy) {
  if (!/^sha256:[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('Evidence upload reservation is invalid.');
  }
  const day = new Date().toISOString().slice(0, 10);
  await withEvidenceLedgerLock(async () => {
    let ledger: { day: string; totalBytes: number; capsuleHashes: string[]; capsuleBytes: Record<string, number> } = {
      day, totalBytes: 0, capsuleHashes: [], capsuleBytes: {},
    };
    try {
      const stored = JSON.parse(await readFile(evidenceUploadLedgerPath(), 'utf8')) as typeof ledger;
      if (stored.day !== day) {
        ledger = { day, totalBytes: 0, capsuleHashes: [], capsuleBytes: {} };
      } else if (Number.isSafeInteger(stored.totalBytes) && stored.totalBytes >= 0
        && Array.isArray(stored.capsuleHashes) && stored.capsuleBytes && typeof stored.capsuleBytes === 'object') {
        ledger = stored;
      } else {
        throw new Error('Evidence upload ledger is invalid.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Evidence upload ledger is missing; refresh and reapply the signed workspace policy.');
      }
      throw error;
    }
    if (ledger.capsuleHashes.includes(key)) return;
    if (ledger.totalBytes + bytes > policy.evidence.maximumDailyUploadBytes) {
      throw new Error('Organization daily content upload limit would be exceeded.');
    }
    ledger.totalBytes += bytes;
    ledger.capsuleHashes.push(key);
    ledger.capsuleBytes[key] = bytes;
    await writeJsonAtomic(evidenceUploadLedgerPath(), ledger);
  });
}

export async function reserveDailyContentUpload(capsule: Record<string, unknown>, policy: OrganizationPolicy) {
  if (capsule.automaticDisclosureMode !== 'customer_authorized_content') return;
  const capsuleHash = String(capsule.capsuleHash || '');
  assertCapsuleIntegrity(capsule);
  const bytes = Buffer.byteLength(canonicalize(capsule));
  await reserveDailyEvidenceBytes(capsuleHash, bytes, policy);
}

export async function releaseDailyContentUpload(capsule: Record<string, unknown>, policy: OrganizationPolicy) {
  if (capsule.automaticDisclosureMode !== 'customer_authorized_content') return;
  const capsuleHash = String(capsule.capsuleHash || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(capsuleHash)) return;
  await withEvidenceLedgerLock(async () => {
    try {
      const ledger = JSON.parse(await readFile(evidenceUploadLedgerPath(), 'utf8')) as {
        day: string; totalBytes: number; capsuleHashes: string[]; capsuleBytes?: Record<string, number>;
      };
      if (!ledger.capsuleHashes.includes(capsuleHash)) return;
      const reservedBytes = Number(ledger.capsuleBytes?.[capsuleHash] ?? Buffer.byteLength(canonicalize(capsule)));
      ledger.capsuleHashes = ledger.capsuleHashes.filter((hash) => hash !== capsuleHash);
      ledger.totalBytes = Math.max(0, ledger.totalBytes - (Number.isSafeInteger(reservedBytes) ? reservedBytes : 0));
      if (ledger.capsuleBytes) delete ledger.capsuleBytes[capsuleHash];
      await writeJsonAtomic(evidenceUploadLedgerPath(), ledger);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}

export async function relayProcessState(home = dharmaHome()): Promise<'running' | 'stopped' | 'unknown'> {
  let pid: number;
  try {
    pid = Number((await readFile(resolve(home, 'relay', 'relay.pid'), 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid < 1) return 'unknown';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'stopped' : 'unknown';
  }
  try {
    process.kill(pid, 0);
    return 'running';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'stopped';
    return code === 'EPERM' ? 'unknown' : 'stopped';
  }
}

export async function materializeWorkspacePolicy(input: {
  workspace: string;
  organizationId: string;
  revision: string;
  serverPolicyAuthorization?: unknown;
  serverPublicKeyEd25519?: string;
  workspaceId?: string;
  dryRun?: boolean;
}) {
  const allowedCommands: OrganizationPolicy['tasks']['allowedCommands'] = {};
  try {
    const packageJson = JSON.parse(await readFile(resolve(input.workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = packageJson.scripts || {};
    for (const [script, commandId, timeoutSeconds] of [
      ['test', 'repo.test', 1_200],
      ['lint', 'repo.lint', 600],
      ['typecheck', 'repo.typecheck', 600],
      ['type-check', 'repo.typecheck', 600],
      ['build', 'repo.build', 1_200],
    ] as const) {
      if (typeof scripts[script] === 'string' && !allowedCommands[commandId]) {
        allowedCommands[commandId] = { argv: ['npm', 'run', script], timeoutSeconds };
      }
    }
  } catch {}

  const writePaths: string[] = [];
  for (const candidate of ['src', 'app', 'apps', 'lib', 'packages', 'test', 'tests', 'docs']) {
    if (await pathExists(resolve(input.workspace, candidate))) writePaths.push(`${candidate}/**`);
  }
  let policy: OrganizationPolicy = {
    schema: 'dharma.organization-policy/v2',
    organizationId: input.organizationId,
    revision: input.revision,
    evidence: {
      defaultMode: 'deep',
      automaticDisclosure: { mode: 'local_analysis' },
      registeredWorkspaceOnly: true,
      excludePaths: ['.env', '.env.*', '.git/**', 'node_modules/**', 'dist/**', 'build/**', '**/*.pem', '**/*.key'],
      maximumCapsuleBytes: 1_000_000,
      maximumDailyUploadBytes: 50_000_000,
      maximumExpansionBytes: 65_536,
      pseudonymizeIdentity: true,
    },
    tasks: {
      defaultNetwork: 'deny',
      defaultGit: 'task_branch',
      allowedCommands,
      writePaths,
      requireLocalConfirmationFor: ['network.allowlisted_domains', 'git.push', 'merge', 'deploy'],
    },
    skills: { automaticInstall: true, automaticPromotionMaxRisk: 'R2', canaryPercent: 10 },
    retention: { rawLocalDays: 30, capsuleServerDays: 90 },
    budgets: { dailyAnalysisCents: 1_000 },
  };
  const existingPath = resolve(input.workspace, '.dharma', 'approved-policy.json');
  if (await pathExists(existingPath)) {
    const existing = await loadOrganizationPolicy(existingPath);
    if (existing.organizationId === input.organizationId) policy = existing;
  }
  if (input.serverPolicyAuthorization !== undefined && input.serverPolicyAuthorization !== null) {
    if (!input.serverPublicKeyEd25519 || !input.workspaceId) {
      throw new Error('Server policy authorization requires the enrolled server key and workspace ID.');
    }
    policy = applyServerEvidencePolicy(
      policy,
      input.serverPolicyAuthorization,
      input.serverPublicKeyEd25519,
      input.organizationId,
      input.workspaceId,
    );
    if (!input.dryRun) {
      await applyWorkspaceAuthorizationAtomically({
        workspaceId: input.workspaceId,
        authorization: policy.serverAuthorization!,
        policyPath: existingPath,
        policy,
      });
    } else {
      await assertWorkspaceAuthorizationCurrent(input.workspaceId, policy.serverAuthorization!, false);
    }
  }
  assertPolicy(policy);
  const relativePath = '.dharma/approved-policy.json';
  if (!input.dryRun && !policy.serverAuthorization) {
    await mkdir(resolve(input.workspace, '.dharma'), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(resolve(input.workspace, relativePath), policy);
  }
  return { relativePath, policy, applied: !input.dryRun };
}

function workspaceAuthorizationStatePath(workspaceId: string) {
  return resolve(dharmaHome(), 'registry', 'workspace-authorizations', `${workspaceId}.json`);
}

async function withFileLock<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const release = await acquirePidLock(lockPath, 10_000, 'Timed out waiting for the workspace authorization lock.');
  try { return await operation(); }
  finally { await release(); }
}

async function assertWorkspaceAuthorizationCurrent(
  workspaceId: string,
  authorization: NonNullable<OrganizationPolicy['serverAuthorization']>,
  requireExisting = true,
) {
  const statePath = workspaceAuthorizationStatePath(workspaceId);
  type AuthorizationState = { issuedAt: string; signature: string };
  let previous: AuthorizationState | null = null;
  try { previous = JSON.parse(await readFile(statePath, 'utf8')) as AuthorizationState; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !requireExisting) return;
    throw new Error('Workspace authorization replay state is missing or invalid; apply a fresh server policy.');
  }
  if (previous) {
    const incomingTime = Date.parse(authorization.issuedAt);
    const previousTime = Date.parse(previous.issuedAt);
    if (!Number.isFinite(previousTime)
      || incomingTime < previousTime
      || (incomingTime === previousTime && authorization.signature !== previous.signature)) {
      throw new Error('Server workspace policy authorization is older than the last accepted authorization.');
    }
  }
}

async function applyWorkspaceAuthorizationAtomically(input: {
  workspaceId: string;
  authorization: NonNullable<OrganizationPolicy['serverAuthorization']>;
  policyPath: string;
  policy: OrganizationPolicy;
}) {
  const statePath = workspaceAuthorizationStatePath(input.workspaceId);
  await withFileLock(`${statePath}.lock`, async () => {
    await assertWorkspaceAuthorizationCurrent(input.workspaceId, input.authorization, false);
    let previous: { contentLedgerInitialized?: boolean } | null = null;
    try { previous = JSON.parse(await readFile(statePath, 'utf8')) as { contentLedgerInitialized?: boolean }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Workspace authorization replay state is missing or invalid; apply a fresh server policy.');
      }
    }
    const contentAuthorized = input.policy.evidence.automaticDisclosure?.mode === 'customer_authorized_content';
    const ledgerExists = await pathExists(evidenceUploadLedgerPath());
    if (contentAuthorized && previous?.contentLedgerInitialized === true && !ledgerExists) {
      throw new Error('Evidence upload quota ledger is missing; content transmission is disabled until the device is re-enrolled.');
    }
    if (contentAuthorized && !ledgerExists) {
      await writeJsonAtomic(evidenceUploadLedgerPath(), {
        day: new Date().toISOString().slice(0, 10), totalBytes: 0, capsuleHashes: [], capsuleBytes: {},
      });
    }
    await writeJsonAtomic(statePath, {
      issuedAt: input.authorization.issuedAt,
      signature: input.authorization.signature,
      contentLedgerInitialized: previous?.contentLedgerInitialized === true || contentAuthorized,
    });
    await writeJsonAtomic(input.policyPath, input.policy);
  });
}

export function applyServerEvidencePolicy(
  base: OrganizationPolicy,
  value: unknown,
  serverPublicKeyEd25519: string,
  organizationId: string,
  workspaceId: string,
  now = new Date(),
): OrganizationPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Server workspace policy authorization must be an object.');
  }
  const envelope = value as Record<string, unknown>;
  const { signature, ...unsigned } = envelope;
  if (envelope.schema !== 'dharma.workspace-policy-authorization/v1'
    || envelope.organizationId !== organizationId
    || envelope.workspaceId !== workspaceId
    || typeof signature !== 'string'
    || !Number.isFinite(Date.parse(String(envelope.issuedAt || '')))
    || Date.parse(String(envelope.expiresAt || '')) <= now.getTime()) {
    throw new Error('Server workspace policy authorization is invalid or expired.');
  }
  const serverPublicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: serverPublicKeyEd25519 }, format: 'jwk' });
  if (!verifyCanonicalObject(unsigned, signature, serverPublicKey)) {
    throw new Error('Server workspace policy authorization signature is invalid.');
  }
  const fragment = envelope.policy;
  if (!fragment || typeof fragment !== 'object' || Array.isArray(fragment)) {
    throw new Error('Server workspace policy authorization has no policy.');
  }
  const policyFragment = fragment as Record<string, unknown>;
  const evidence = policyFragment.evidence;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('Server workspace policy evidence must be an object.');
  }
  const grant = evidence as Record<string, unknown>;
  const disclosure = grant.automaticDisclosure;
  if (!disclosure || typeof disclosure !== 'object' || Array.isArray(disclosure)) {
    throw new Error('Server workspace policy disclosure grant is required.');
  }
  const automaticDisclosure = disclosure as Record<string, unknown>;
  const noContent = ['metadata_only', 'local_analysis'].includes(String(automaticDisclosure.mode))
    && automaticDisclosure.consentReceiptId === undefined
    && automaticDisclosure.allowedContentClasses === undefined;
  const authorizedContent = automaticDisclosure.mode === 'customer_authorized_content'
    && typeof automaticDisclosure.consentReceiptId === 'string'
    && Array.isArray(automaticDisclosure.allowedContentClasses)
    && automaticDisclosure.allowedContentClasses.length === 1
    && automaticDisclosure.allowedContentClasses[0] === 'native_provider_payload';
  if (!noContent && !authorizedContent) {
    throw new Error('Server workspace policy contains an invalid content disclosure grant.');
  }
  const revision = policyFragment.revision;
  const maximumCapsuleBytes = Number(grant.maximumCapsuleBytes);
  const maximumDailyUploadBytes = Number(grant.maximumDailyUploadBytes);
  const maximumExpansionBytes = Number(grant.maximumExpansionBytes);
  const excludePaths = Array.isArray(grant.excludePaths) ? grant.excludePaths.map(String) : [];
  if (typeof revision !== 'string' || !revision.trim()
    || !Number.isSafeInteger(maximumCapsuleBytes)
    || !Number.isSafeInteger(maximumDailyUploadBytes)
    || !Number.isSafeInteger(maximumExpansionBytes)
    || maximumExpansionBytes < 1 || maximumExpansionBytes > 262_144
    || grant.pseudonymizeIdentity !== true
    || excludePaths.length < 1 || excludePaths.some((item) => !item || item.length > 200)) {
    throw new Error('Server workspace policy limits or revision are invalid.');
  }
  const policy: OrganizationPolicy = {
    ...structuredClone(base),
    schema: 'dharma.organization-policy/v2',
    revision,
    evidence: {
      ...structuredClone(base.evidence),
      automaticDisclosure: authorizedContent ? {
        mode: 'customer_authorized_content',
        consentReceiptId: String(automaticDisclosure.consentReceiptId),
        allowedContentClasses: ['native_provider_payload'],
      } : { mode: automaticDisclosure.mode as 'metadata_only' | 'local_analysis' },
      maximumCapsuleBytes,
      maximumDailyUploadBytes,
      maximumExpansionBytes,
      excludePaths,
      pseudonymizeIdentity: true,
    },
    serverAuthorization: envelope as OrganizationPolicy['serverAuthorization'],
  };
  verifyServerAuthorizedPolicy({
    policy,
    publicKeyEd25519: serverPublicKeyEd25519,
    organizationId,
    workspaceId,
    now,
  });
  assertPolicy(policy);
  return policy;
}

function providerAdapter(provider: string) {
  if (provider === 'codex') return codexAdapter;
  if (provider === 'claude') return claudeAdapter;
  if (provider === 'agy') return agyAdapter;
  return null;
}

function deterministicUuid(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function responseTextFromEvent(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item)
    ? event.item as Record<string, unknown>
    : {};
  if (item.type === 'agent_message' && typeof item.text === 'string') return item.text;
  if (event.type === 'result' && typeof event.result === 'string') return event.result;
  const message = event.message && typeof event.message === 'object' && !Array.isArray(event.message)
    ? event.message as Record<string, unknown>
    : {};
  const content = Array.isArray(message.content) ? message.content : [];
  const parts = content.flatMap((part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
    const text = (part as Record<string, unknown>).text;
    return typeof text === 'string' ? [text] : [];
  });
  return parts.length ? parts.join('\n') : null;
}

export function taskResponsePreview(receipt: TaskReceipt) {
  const provider = receipt.commandResults.find((result) => result.commandId.startsWith('provider.'));
  if (!provider?.stdout) return null;
  const candidates: string[] = [];
  for (const line of provider.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const response = responseTextFromEvent(JSON.parse(line));
      if (response?.trim()) candidates.push(response.trim());
    } catch {}
  }
  const selected = candidates.at(-1);
  if (!selected) return null;
  const stats: RedactionStats = { classes: new Set(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0 };
  const redacted = String(redactValue(selected, stats));
  return {
    text: redacted.slice(0, 8_000),
    truncated: redacted.length > 8_000,
    redactionClasses: [...stats.classes].sort(),
    redactedValues: stats.redactedValues,
  };
}

export function assertTaskSkillPin(
  pinned: TaskEnvelope['skillBundle'],
  activeBundleId: string | null,
): void {
  if (pinned === undefined) throw new Error('Task is missing its signed skill bundle pin.');
  if ((pinned?.bundleId || null) !== activeBundleId) {
    throw new Error(
      `Task skill bundle does not match the active local bundle (task=${pinned?.bundleId || 'none'}, local=${activeBundleId || 'none'}).`,
    );
  }
  if (pinned && !/^sha256:[a-f0-9]{64}$/.test(pinned.bundleHash)) {
    throw new Error('Task skill bundle hash is invalid.');
  }
}

export function taskSkillPinFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('missing its signed skill bundle pin')) return 'skill_bundle_pin_missing';
  if (message.includes('does not match the active local bundle')) return 'skill_bundle_mismatch';
  if (message.includes('bundle hash is invalid')) return 'skill_bundle_hash_invalid';
  return 'skill_bundle_preflight_failed';
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

async function openVerificationUri(url: string) {
  const attempts: Array<[string, string[]]> = process.platform === 'darwin'
    ? [['open', [url]]]
    : process.platform === 'win32'
      ? [['rundll32.exe', ['url.dll,FileProtocolHandler', url]]]
      : [
          ['wslview', [url]],
          ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
          ['xdg-open', [url]],
        ];
  for (const [command, argv] of attempts) {
    try {
      await execFileAsync(command, argv, { timeout: 10_000 });
      return true;
    } catch {}
  }
  return false;
}

async function login(flags: Map<string, string | boolean>): Promise<Output> {
  type PendingEnrollment = {
    hqUrl: string;
    organizationId: string;
    name: string;
    platform: DeviceConfig['platform'];
    publicKeyEd25519: string;
    deviceCode: string;
    verificationUri: string;
    browserCode: string;
    expiresAt: string;
  };
  let pending: PendingEnrollment;
  if (flags.has('resume')) {
    pending = JSON.parse(await readFile(pendingEnrollmentPath(), 'utf8')) as PendingEnrollment;
  } else {
    const hqUrl = normalizeHqUrl(String(flags.get('hq-url') || 'https://www.dharma-ai.io'));
    const organizationId = required(flags, 'organization-id');
    const name = String(flags.get('device-name') || `${process.env.USER || process.env.USERNAME || 'developer'} device`);
    const devicePlatform = await platform();
    const identity = await loadOrCreateDeviceIdentity({ hqUrl, organizationId });
    const enrollment = await beginEnrollment({ hqUrl, organizationId, name, platform: devicePlatform, publicKeyEd25519: identity.publicKeyEd25519 });
    pending = {
      hqUrl, organizationId, name, platform: devicePlatform, publicKeyEd25519: identity.publicKeyEd25519,
      deviceCode: enrollment.deviceCode, verificationUri: enrollment.verificationUri,
      browserCode: enrollment.browserCode,
      expiresAt: new Date(Date.now() + enrollment.expiresInSeconds * 1_000).toISOString(),
    };
    await mkdir(dharmaHome(), { recursive: true, mode: 0o700 });
    await writeFile(pendingEnrollmentPath(), `${JSON.stringify(pending, null, 2)}\n`, { mode: 0o600 });
    const browserOpened = flags.has('no-browser') ? false : await openVerificationUri(pending.verificationUri);
    if (flags.has('no-wait')) {
      return { ok: true, status: 'pending', deviceCode: pending.deviceCode, verificationUri: pending.verificationUri, browserCode: pending.browserCode, browserOpened, expiresAt: pending.expiresAt };
    }
    process.stderr.write(`Approve this device in your browser: ${pending.verificationUri}\n`);
  }
  const deadline = Date.parse(pending.expiresAt);
  while (Date.now() < deadline) {
    const result = await pollEnrollment({ hqUrl: pending.hqUrl, deviceCode: pending.deviceCode });
    if (result.status === 'approved') {
      if (typeof result.deviceId !== 'string' || typeof result.relayUrl !== 'string' || typeof result.serverPublicKeyEd25519 !== 'string') {
        throw new Error('Enrollment was approved but the relay or server signing key is not configured.');
      }
      const config: DeviceConfig = {
        schema: 'dharma.device-config/v1', hqUrl: pending.hqUrl, organizationId: pending.organizationId, deviceId: result.deviceId,
        deviceName: pending.name, platform: pending.platform, publicKeyEd25519: pending.publicKeyEd25519,
        serverPublicKeyEd25519: result.serverPublicKeyEd25519, relayUrl: result.relayUrl, enrolledAt: new Date().toISOString(),
      };
      await saveDeviceConfig(configPath(), config);
      await rm(pendingEnrollmentPath(), { force: true });
      return { ok: true, status: 'approved', deviceId: config.deviceId, organizationId: pending.organizationId, relayUrl: config.relayUrl };
    }
    if (result.status === 'denied' || result.status === 'expired') throw new Error(`Enrollment ${result.status}.`);
    if (flags.has('no-wait')) return { ok: true, status: 'pending', verificationUri: pending.verificationUri, expiresAt: pending.expiresAt };
    await new Promise((accept) => setTimeout(accept, 2_000));
  }
  throw new Error(`Enrollment timed out. Approve it at ${pending.verificationUri}`);
}

async function capture(flags: Map<string, string | boolean>, batch = false): Promise<Output> {
  const sessionIds = await readSessionAllowlist(flags);
  if (batch && !sessionIds && !flags.has('maximum-sessions')) {
    throw new Error('Batch capture requires --maximum-sessions or --session-ids-file. Run evidence preview first.');
  }
  if (!batch && sessionIds && sessionIds.length !== 1) {
    throw new Error('Single capture requires exactly one session ID when --session-ids-file is used.');
  }
  const workspace = await realpath(required(flags, 'workspace'));
  const provider = required(flags, 'provider');
  const policyPath = required(flags, 'policy');
  const adapter = providerAdapter(provider);
  if (!adapter) throw new Error(`Unsupported capture provider: ${provider}`);
  const root = flags.get('source-root');
  const maximumSessions = batch
    ? boundedInteger(flags.get('maximum-sessions'), sessionIds?.length || 1, 1, 1_000, '--maximum-sessions')
    : 1;
  const sessions = await adapter.discover({
    workspace,
    roots: typeof root === 'string' ? [root] : undefined,
    sessionIds: sessionIds || undefined,
    maximumSessions,
    maximumBytesPerSession: boundedInteger(
      flags.get('maximum-bytes-per-session'), 8_388_608, 65_536, 67_108_864, '--maximum-bytes-per-session',
    ),
  });
  if (sessions.length === 0) throw new Error('No workspace-qualified provider sessions were found.');
  if (sessionIds && sessions.length !== sessionIds.length) {
    throw new Error(`Only ${sessions.length} of ${sessionIds.length} explicitly selected sessions were found in this workspace.`);
  }
  const session = sessions.at(-1)!;
  const device = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
  const registered = (await registry()).find((item) => item.path === workspace);
  if (!registered) throw new Error('Workspace is not registered locally. Run dharma workspace add.');
  let policy = await loadVerifiedWorkspacePolicy(policyPath, registered.workspaceId);
  const { LocalVault, loadOrCreateVaultMasterKey } = await loadVaultModule();
  const fabric = flags.has('sync') ? await client() : null;
  if (fabric) policy = await refreshVerifiedWorkspacePolicyForTransmission(policyPath, registered.workspaceId, fabric);
  const vault = await LocalVault.open({
    root: resolve(dharmaHome(), 'vault'),
    masterKey: await loadOrCreateVaultMasterKey(),
    rawLocalDays: rawLocalRetentionDays(policy),
  });
  try {
    const capsules = [];
    const syncResults = [];
    if (fabric) await syncPendingRetentionCapsules(vault, fabric, policy);
    for (const selected of batch ? sessions : [session]) {
      const rawTurn = Buffer.from(`${selected.records.map((record) => JSON.stringify(record.native)).join('\n')}\n`);
      const rawContentId = sha256(rawTurn);
      const firstRevision = buildTrajectoryCapsule({
        organizationId: device.organizationId, deviceId: device.deviceId, workspaceId: registered.workspaceId,
        session: selected, policy, rawContentId, rawBytes: rawTurn.byteLength, rawKind: 'raw-provider-turn',
      });
      const latestMetadata = vault.getLatestCapsuleMetadata(firstRevision.trajectoryId);
      const latestCapsule = latestMetadata
        ? await vault.getLatestCapsule<ReturnType<typeof buildTrajectoryCapsule>>(firstRevision.trajectoryId)
        : null;
      const evidenceHash = (value: ReturnType<typeof buildTrajectoryCapsule>) => {
        const { revision: _revision, previousRevisionHash: _previous, capsuleHash: _hash, ...evidence } = value;
        return sha256(canonicalize(evidence));
      };
      const capsule = latestCapsule && evidenceHash(latestCapsule) === evidenceHash(firstRevision)
        ? latestCapsule
        : latestMetadata
          ? buildTrajectoryCapsule({
            organizationId: device.organizationId, deviceId: device.deviceId, workspaceId: registered.workspaceId,
            session: selected, policy, rawContentId, rawBytes: rawTurn.byteLength, rawKind: 'raw-provider-turn',
            revision: latestMetadata.revision + 1, previousRevisionHash: latestMetadata.capsuleHash,
          })
          : firstRevision;
      const validation = await validateContract(resolve(import.meta.dirname, 'schemas'), 'https://schemas.dharma-ai.io/trajectory-capsule/v1', capsule);
      if (!validation.ok) throw new Error(`Trajectory capsule failed schema validation: ${JSON.stringify(validation.errors)}`);
      if (!latestCapsule || latestCapsule.capsuleHash !== capsule.capsuleHash) {
        await vault.commitCapture({
          raw: { plaintext: rawTurn, kind: 'raw-provider-turn', expectedContentId: rawContentId },
          capsule: {
            plaintext: Buffer.from(JSON.stringify(capsule)), trajectoryId: capsule.trajectoryId,
            revision: capsule.revision, capsuleHash: capsule.capsuleHash,
          },
          session: {
            sessionId: selected.sessionId, provider: selected.provider, workspaceId: registered.workspaceId,
            sourceLocator: selected.sourcePath, status: selected.coverage, observedAt: selected.endedAt,
          },
        });
      }
      capsules.push(capsule);
      if (fabric) {
        await reserveDailyContentUpload(capsule as unknown as Record<string, unknown>, policy);
        try {
          syncResults.push(await fabric.syncTrajectory(capsule));
        } catch (error) {
          await releaseDailyContentUpload(capsule as unknown as Record<string, unknown>, policy).catch(() => undefined);
          throw error;
        }
      }
    }
    const output = flags.get('output');
    if (!batch) {
      const capsule = capsules[0]!;
      if (typeof output === 'string') await writeFile(resolve(output), `${JSON.stringify(capsule, null, 2)}\n`, { mode: 0o600 });
      if (flags.has('sync')) return { capsule, sync: syncResults[0] };
      return capsule;
    }
    const manifest = {
      ok: true,
      captured: capsules.length,
      synced: syncResults.length,
      coverage: {
        observed: capsules.filter((capsule) => capsule.coverage.state === 'observed').length,
        partial: capsules.filter((capsule) => capsule.coverage.state === 'partial').length,
      },
      trajectories: capsules.map((capsule) => ({
        trajectoryId: capsule.trajectoryId,
        sessionId: capsule.sessionId,
        capsuleHash: capsule.capsuleHash,
        status: capsule.status,
        eventCount: capsule.events.length,
        timeRange: capsule.timeRange,
      })),
    };
    if (typeof output === 'string') await writeFile(resolve(output), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } finally { vault.close(); }
}

async function evidencePreview(flags: Map<string, string | boolean>): Promise<Output> {
  const workspace = await realpath(required(flags, 'workspace'));
  const provider = required(flags, 'provider');
  const adapter = providerAdapter(provider);
  if (!adapter) throw new Error(`Unsupported preview provider: ${provider}`);
  const root = flags.get('source-root');
  const maximumSessions = Math.min(Math.max(Number(flags.get('maximum-sessions') || 100), 1), 1_000);
  const maximumBytesPerSession = Math.min(
    Math.max(Number(flags.get('maximum-bytes-per-session') || 8_388_608), 65_536),
    67_108_864,
  );
  const sessions = await adapter.discover({
    workspace,
    roots: typeof root === 'string' ? [root] : undefined,
    maximumSessions,
    maximumBytesPerSession,
  });
  const eventKinds: Record<string, number> = {};
  let records = 0;
  for (const session of sessions) {
    records += session.records.length;
    for (const record of session.records) eventKinds[record.kind] = (eventKinds[record.kind] || 0) + 1;
  }
  let automaticDisclosure: Record<string, unknown>;
  const policyPath = flags.get('policy');
  if (typeof policyPath === 'string') {
    const device = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
    const registered = (await registry()).find((item) => item.path === workspace);
    if (!registered) throw new Error('Workspace is not registered locally. Run dharma workspace add.');
    const policy = await loadVerifiedWorkspacePolicy(policyPath, registered?.workspaceId);
    const capsules = sessions.map((session) => {
      const rawTurn = Buffer.from(`${session.records.map((record) => JSON.stringify(record.native)).join('\n')}\n`);
      return buildTrajectoryCapsule({
        organizationId: device.organizationId,
        deviceId: device.deviceId,
        workspaceId: registered.workspaceId,
        session,
        policy,
        rawContentId: sha256(rawTurn),
        rawBytes: rawTurn.byteLength,
        rawKind: 'raw-provider-turn',
      });
    });
    automaticDisclosure = {
      ready: true,
      disclosureClass: 'automatic_capsule',
      disclosureMode: capsules[0]?.automaticDisclosureMode ?? policy.evidence.automaticDisclosure?.mode ?? 'local_analysis',
      consentReceiptId: policy.evidence.automaticDisclosure?.consentReceiptId ?? null,
      disclosedClasses: [...new Set(capsules.flatMap((capsule) => capsule.redactionReceipt.disclosedClasses))].sort(),
      excludedClasses: [...new Set(capsules.flatMap((capsule) => capsule.redactionReceipt.excludedClasses))].sort(),
      capsuleBytes: capsules.reduce((total, capsule) => total + Buffer.byteLength(canonicalize(capsule)), 0),
      rawProviderBytesLocal: capsules.reduce((total, capsule) => total + (capsule.contentIndex[0]?.bytes || 0), 0),
      rawProviderBytesUploaded: capsules.reduce((total, capsule) => total + (
        capsule.automaticDisclosureMode === 'customer_authorized_content'
          ? Buffer.byteLength(canonicalize(capsule.events.map((event) => event.payload.nativeProviderPayload ?? null)))
          : 0
      ), 0),
      semanticReviewCandidates: capsules.filter((capsule) => capsule.localAnalysis?.semanticReviewRecommended).length,
      syncRequiresExplicitFlag: true,
    };
  } else {
    automaticDisclosure = {
      ready: false,
      reason: 'Add --policy <path> to calculate exact automatic-capsule bytes and content classes before sync.',
      disclosureClass: 'automatic_capsule',
      rawProviderBytesUploaded: 0,
      syncRequiresExplicitFlag: true,
    };
  }
  return {
    ok: true,
    provider,
    workspaceQualified: true,
    trajectoryCount: sessions.length,
    recordCount: records,
    coverage: {
      observed: sessions.filter((session) => session.coverage === 'observed').length,
      partial: sessions.filter((session) => session.coverage === 'partial').length,
    },
    timeRange: sessions.length > 0
      ? { start: sessions[0]!.startedAt, end: sessions.at(-1)!.endedAt }
      : null,
    eventKinds: Object.fromEntries(Object.entries(eventKinds).sort(([left], [right]) => left.localeCompare(right))),
    automaticDisclosure,
    sessions: sessions.map((session) => ({
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      coverage: session.coverage,
      records: session.records.length,
    })),
  };
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
  const policyRevision = required(flags, 'policy-revision');
  if (!flags.has('apply')) {
    return {
      ok: true, workspaceId, planned: true, serverMutation: false, localMutation: false,
      next: `dharma workspace sync ${workspaceId} --policy-revision ${policyRevision} --apply`,
    };
  }
  return syncWorkspacePolicy(await client(), item, policyRevision, true);
}

async function syncWorkspacePolicy(fabric: AgentFabricClient, item: WorkspaceRecord, policyRevision: string, apply = true) {
  const providers = await Promise.all(providerAdapters.map((adapter) => adapter.capability()));
  const response = await fabric.registerWorkspace({
    workspaceId: item.workspaceId, name: item.name, routeHash: item.routeHash,
    repositoryRemoteHash: item.repositoryRemoteHash, defaultBranch: item.defaultBranch,
    policyRevision, providers,
  });
  const generated = await materializeWorkspacePolicy({
    workspace: item.path,
    organizationId: item.organizationId,
    revision: String((response.workspace as Record<string, unknown> | undefined)?.policyRevision || policyRevision),
    serverPolicyAuthorization: response.organizationPolicyAuthorization,
    serverPublicKeyEd25519: (await readDeviceConfig())?.serverPublicKeyEd25519,
    workspaceId: item.workspaceId,
    dryRun: !apply,
  });
  return {
    ...response,
    localPolicy: {
      path: generated.relativePath,
      revision: generated.policy.revision,
      disclosureMode: generated.policy.evidence.automaticDisclosure?.mode || 'local_analysis',
      applied: generated.applied,
    },
  };
}

async function readDeviceConfig(): Promise<DeviceConfig | null> {
  try { return JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig; }
  catch { return null; }
}

async function loadVerifiedWorkspacePolicy(path: string, workspaceId?: string) {
  const policy = await loadOrganizationPolicy(path);
  if (policy.evidence.automaticDisclosure?.mode !== 'customer_authorized_content') return policy;
  const config = await readDeviceConfig();
  const authorizedWorkspaceId = workspaceId || policy.serverAuthorization?.workspaceId;
  const registered = authorizedWorkspaceId
    ? (await registry()).some((item) => item.workspaceId === authorizedWorkspaceId && item.organizationId === policy.organizationId)
    : false;
  if (!config || policy.organizationId !== config.organizationId || !authorizedWorkspaceId || !registered) {
    throw new Error('Content policy does not match an enrolled organization and workspace.');
  }
  const verified = applyServerEvidencePolicy(
    { ...structuredClone(policy), evidence: { ...structuredClone(policy.evidence), automaticDisclosure: { mode: 'local_analysis' } }, serverAuthorization: undefined },
    policy.serverAuthorization,
    config.serverPublicKeyEd25519,
    config.organizationId,
    authorizedWorkspaceId,
  );
  await assertWorkspaceAuthorizationCurrent(authorizedWorkspaceId, verified.serverAuthorization!);
  return verified;
}

export async function installRepositoryAgentFabricSkill(input: {
  workspace: string;
  hqUrl: string;
  organizationId: string;
  workspaceId: string;
  policyRevision: string;
}) {
  const skillRoot = resolve(input.workspace, '.agents', 'skills', 'dharma-agent-fabric');
  const marker = resolve(skillRoot, '.dharma-agent-fabric.json');
  let skillRootExists = true;
  try { await access(skillRoot); } catch { skillRootExists = false; }
  if (skillRootExists) {
    try { await access(marker); }
    catch { throw new Error('Refusing to replace an unmanaged repository skill at .agents/skills/dharma-agent-fabric.'); }
  }
  await mkdir(resolve(skillRoot, 'references'), { recursive: true, mode: 0o700 });
  await mkdir(resolve(input.workspace, '.dharma'), { recursive: true, mode: 0o700 });
  const skill = `---
name: dharma-agent-fabric
description: Connect this repository's coding agents to the organization's Dharma Agent Fabric control plane.
---

# Dharma Agent Fabric

Use the installed \`dharma\` CLI for organization-scoped agent work. Never print or commit provider credentials, developer tokens, local paths, or raw private trajectories. Transmit content only when the organization policy contains an auditable customer-authorized content grant.

## Required flow

1. Run \`dharma status\`, then run the verification command for the current agent before accepting work:
   - Codex: \`dharma skills verify --provider codex --workspace .\`
   - Claude Code: \`dharma skills verify --provider claude --workspace .\`
   - Agy: \`dharma skills verify --provider agy --workspace .\`
   Do not substitute a placeholder or shell variable. Stop unless the result reports \`ready: true\`. Restart the provider after the first installation so it discovers the native skill.
2. Run \`dharma providers list\` to confirm the provider's independently tested evidence, task, continuation, skill, activation, and rollback capabilities.
3. Keep \`dharma relay start --policy .dharma/approved-policy.json\` running for signed task, evidence, and skill delivery.
4. Preview the exact automatic disclosure with \`dharma evidence preview --workspace . --provider codex --policy .dharma/approved-policy.json --maximum-sessions 20\` for Codex, replacing only the literal provider value with \`claude\` or \`agy\` when that is the current agent. Confirm the policy mode and consent receipt before syncing.
5. Run local deterministic self-analysis during capture. Deliver event counts, timing, coverage, failure signals, tool-discipline results, reason codes, and content availability metadata. Do not invent a semantic judgment from metadata. Sessions flagged \`semanticReviewRecommended\` require a policy-authorized evidence request or customer-authorized content mode before server judging.
6. Use only signed tasks whose organization, device, workspace, authority, budget, and skill pin pass local validation.
7. For cross-agent help, ask the control plane for a structured, task-bound handoff. Do not open arbitrary chat, shell, file, merge, deploy, or secret authority.
8. Install only signed skill bundles. Preserve the active bundle receipt and automatic rollback result.

The organization contract and API origin are recorded in \`.dharma/agent-fabric.json\`. API calls must use the published SDK and a scoped organization token supplied at runtime, never a credential committed to this repository.
`;
  const reference = `# Organization connection

- HQ API: ${input.hqUrl}
- Organization: ${input.organizationId}
- Workspace: ${input.workspaceId}
- Policy revision: ${input.policyRevision}
- OpenAPI: ${input.hqUrl}/api/v1/agent-fabric/openapi.json

The CLI enrolls this device through browser-confirmed Clerk organization consent. Local provider credentials remain on this device. Managed and cloud BYOK execution are brokered by Dharma HQ and expose neither private runtime URLs nor cloud credentials.
`;
  const connection = {
    schema: 'dharma.repository-connection/v1',
    hqUrl: input.hqUrl,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    policyRevision: input.policyRevision,
    openapiUrl: `${input.hqUrl}/api/v1/agent-fabric/openapi.json`,
  };
  await writeFile(resolve(skillRoot, 'SKILL.md'), skill, { mode: 0o600 });
  await writeFile(resolve(skillRoot, 'references', 'organization.md'), reference, { mode: 0o600 });
  await writeFile(marker, `${JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: input.workspaceId }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(resolve(input.workspace, '.dharma', 'agent-fabric.json'), `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  return {
    skillPath: '.agents/skills/dharma-agent-fabric/SKILL.md',
    connectionPath: '.dharma/agent-fabric.json',
  };
}

async function onboard(flags: Map<string, string | boolean>): Promise<Output> {
  const workspace = await realpath(String(flags.get('workspace') || flags.get('path') || '.'));
  const organizationId = required(flags, 'organization-id');
  const policyRevision = required(flags, 'policy-revision');
  const requestedHqUrl = normalizeHqUrl(String(flags.get('hq-url') || 'https://www.dharma-ai.io'));
  let config = await readDeviceConfig();
  if (!config) {
    const loginFlags = new Map(flags);
    loginFlags.set('hq-url', requestedHqUrl);
    loginFlags.set('organization-id', organizationId);
    const enrollment = await login(loginFlags) as Record<string, unknown>;
    if (enrollment.status !== 'approved') {
      return {
        ok: true,
        stage: 'approve_device',
        enrollment,
        nextCommand: `dharma onboard --resume --organization-id ${organizationId} --workspace . --policy-revision ${policyRevision}`,
      };
    }
    config = await readDeviceConfig();
  }
  if (!config) throw new Error('Device enrollment did not produce a local device configuration.');
  if (config.organizationId !== organizationId) {
    throw new Error('This DHARMA_HOME is enrolled to a different organization. Use a separate DHARMA_HOME for each organization.');
  }
  if (flags.has('hq-url') && config.hqUrl !== requestedHqUrl) {
    throw new Error('This device is enrolled to a different Dharma HQ origin. Use a separate DHARMA_HOME for each HQ origin.');
  }
  const hqUrl = config.hqUrl;
  let registered = (await registry()).find((item) => item.path === workspace);
  if (!registered) {
    await workspaceAdd(new Map<string, string | boolean>([
      ['organization-id', organizationId],
      ['path', workspace],
      ['name', String(flags.get('name') || basename(workspace))],
    ]), [workspace]);
    registered = (await registry()).find((item) => item.path === workspace);
  }
  if (!registered) throw new Error('Workspace registration failed.');
  const synced = await workspaceSync(new Map<string, string | boolean>([
    ['policy-revision', policyRevision], ['apply', true],
  ]), [registered.workspaceId]) as Record<string, unknown>;
  const localPolicy = synced.localPolicy as Record<string, unknown> | undefined;
  const authoritativeRevision = String(localPolicy?.revision || policyRevision);
  const generatedPolicy = await loadVerifiedWorkspacePolicy(resolve(workspace, '.dharma', 'approved-policy.json'), registered.workspaceId);
  const installed = await installRepositoryAgentFabricSkill({
    workspace,
    hqUrl,
    organizationId,
    workspaceId: registered.workspaceId,
    policyRevision: authoritativeRevision,
  });
  const providers = await Promise.all(providerAdapters.map((adapter) => adapter.capability()));
  const nativeSkills = [];
  for (const capability of providers) {
    if (capability.skillInstall !== 'available') continue;
    nativeSkills.push(await installNativeAgentFabricBootstrap({
      provider: capability.provider as ProviderId,
      workspace,
      workspaceId: registered.workspaceId,
      organizationId,
      hqUrl,
    }));
  }
  return {
    ok: true,
    stage: 'ready',
    organizationId,
    workspaceId: registered.workspaceId,
    deviceId: config.deviceId,
    providers,
    organizationPolicy: {
      path: '.dharma/approved-policy.json',
      revision: generatedPolicy.revision,
      disclosureMode: generatedPolicy.evidence.automaticDisclosure?.mode || 'local_analysis',
      commandIds: Object.keys(generatedPolicy.tasks.allowedCommands).sort(),
      writePaths: generatedPolicy.tasks.writePaths,
    },
    repositorySkill: installed,
    nativeSkills,
    workspaceSync: synced,
    next: {
      preview: 'dharma evidence preview --workspace . --provider codex',
      sync: 'dharma evidence capture-batch --workspace . --provider codex --policy .dharma/approved-policy.json --maximum-sessions 20 --sync',
      relay: 'dharma relay start --policy .dharma/approved-policy.json',
      verifySkill: 'dharma skills verify --provider codex --workspace .',
    },
  };
}

async function evidenceSync(flags: Map<string, string | boolean>): Promise<Output> {
  const capsule = JSON.parse(await readFile(resolve(required(flags, 'file')), 'utf8'));
  const workspaceId = typeof flags.get('workspace-id') === 'string' ? String(flags.get('workspace-id')) : String(capsule.workspaceId || '');
  const fabric = await client();
  const policy = await refreshVerifiedWorkspacePolicyForTransmission(required(flags, 'policy'), workspaceId, fabric);
  const validation = await validateContract(resolve(import.meta.dirname, 'schemas'), 'https://schemas.dharma-ai.io/trajectory-capsule/v1', capsule);
  if (!validation.ok) throw new Error(`Trajectory capsule failed schema validation: ${JSON.stringify(validation.errors)}`);
  assertCapsuleIntegrity(capsule);
  assertCapsuleAuthorizedByCurrentPolicy(capsule, policy);
  await reserveDailyContentUpload(capsule, policy);
  return fabric.syncTrajectory(capsule);
}

type EvidenceRequest = {
  schema: 'dharma.evidence-request/v1' | 'dharma.evidence-request/v2';
  requestId: string;
  organizationId: string;
  deviceId: string;
  workspaceId: string;
  trajectoryId: string;
  capsuleRevision?: number;
  capsuleHash?: string;
  purpose: string;
  selectors: Array<{ contentId: string; range?: { start: number; end: number } | null; reason?: string | null }>;
  maximumBytes: number;
  retentionClass: string;
  requestedBy: string;
  authorityDecisionId: string;
  createdAt: string;
  expiresAt: string;
  nonce: string;
  keyVersion?: string;
  signature: string;
};

async function processEvidenceRequest(
  fabric: AgentFabricClient,
  policy: Awaited<ReturnType<typeof loadOrganizationPolicy>>,
  workspaceId?: string,
): Promise<Record<string, unknown>> {
  assertPolicy(policy);
  const config = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
  const workspaces = (await registry()).filter((item) => !workspaceId || item.workspaceId === workspaceId);
  if (workspaces.length === 0) throw new Error('Evidence workspace is not registered locally.');
  let request: EvidenceRequest | null = null;
  let workspace: WorkspaceRecord | null = null;
  for (const item of workspaces) {
    const polled = await fabric.pollEvidence({ workspaceId: item.workspaceId });
    if (polled.request && typeof polled.request === 'object') {
      request = polled.request as EvidenceRequest;
      workspace = item;
      break;
    }
  }
  if (!request || !workspace) return { ok: true, request: null };
  const contractId = request.schema === 'dharma.evidence-request/v2'
    ? 'https://schemas.dharma-ai.io/evidence-request/v2'
    : 'https://schemas.dharma-ai.io/evidence-request/v1';
  const contract = await validateContract(resolve(import.meta.dirname, 'schemas'), contractId, request);
  if (!contract.ok) throw new Error(`Evidence request failed schema validation: ${JSON.stringify(contract.errors)}`);
  const { signature, ...unsignedRequest } = request;
  const serverPublicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519 }, format: 'jwk' });
  if (!verifyCanonicalObject(unsignedRequest, signature, serverPublicKey)) throw new Error('Evidence request signature is invalid.');
  if (request.organizationId !== config.organizationId || request.deviceId !== config.deviceId
    || request.workspaceId !== workspace.workspaceId || policy.organizationId !== config.organizationId) {
    throw new Error('Evidence request does not match the enrolled organization, device, workspace, or policy.');
  }
  if (Date.parse(request.expiresAt) <= Date.now()) throw new Error('Evidence request has expired.');
  const requestReceipt = evidenceRequestReceiptPath(request.requestId);
  await mkdir(dirname(requestReceipt), { recursive: true, mode: 0o700 });
  let requestHandle;
  try {
    requestHandle = await open(requestReceipt, 'wx', 0o600);
    await requestHandle.writeFile(`${JSON.stringify({
      schema: 'dharma.evidence-request-receipt/v1',
      requestId: request.requestId,
      nonce: request.nonce,
      state: 'processing',
      acceptedAt: new Date().toISOString(),
    })}\n`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Evidence request was already accepted locally.');
    throw error;
  } finally {
    await requestHandle?.close().catch(() => undefined);
  }
  const { LocalVault, loadOrCreateVaultMasterKey } = await loadVaultModule();
  const vault = await LocalVault.open({
    root: resolve(dharmaHome(), 'vault'),
    masterKey: await loadOrCreateVaultMasterKey(),
    rawLocalDays: rawLocalRetentionDays(policy),
  });
  try {
    await syncPendingRetentionCapsules(vault, fabric, policy);
    const capsule = await vault.getLatestCapsule<Record<string, unknown>>(request.trajectoryId);
    assertCapsuleIntegrity(capsule);
    if (!request.capsuleRevision || !request.capsuleHash) {
      throw new Error('Legacy evidence request lacks a signed capsule revision and must be reissued.');
    }
    if (Number(capsule.revision) !== request.capsuleRevision || capsule.capsuleHash !== request.capsuleHash) {
      throw new Error('Evidence request is not bound to the current local capsule revision.');
    }
    const capsuleReceipt = capsule.redactionReceipt && typeof capsule.redactionReceipt === 'object' && !Array.isArray(capsule.redactionReceipt)
      ? capsule.redactionReceipt as Record<string, unknown> : {};
    const expansionBlockedByExcludedPath = Number(capsuleReceipt.excludedPaths || 0) > 0;
    const contentIndex = Array.isArray(capsule.contentIndex) ? capsule.contentIndex : [];
    const available = new Set(contentIndex.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      return record.availableLocally === true && record.uploaded !== true && typeof record.contentId === 'string'
        ? [record.contentId] : [];
    }));
    const stats: RedactionStats = { classes: new Set(), redactedValues: 0, excludedPaths: 0, inputBytes: 0, outputBytes: 0 };
    const approved: Array<{ contentId: string; bytes: number; chunkHash: string; contentBase64: string }> = [];
    const excluded: Array<{ contentId: string; reasonCode: string }> = [];
    const authorizedBytes = Math.min(request.maximumBytes, policy.evidence.maximumExpansionBytes);
    let bytesPrepared = 0;
    for (const selector of request.selectors) {
      if (expansionBlockedByExcludedPath) {
        excluded.push({ contentId: selector.contentId, reasonCode: 'configured_excluded_path' });
        continue;
      }
      if (!available.has(selector.contentId)) { excluded.push({ contentId: selector.contentId, reasonCode: 'not_available_in_capsule' }); continue; }
      try {
        const source = await vault.getBlob(selector.contentId);
        const start = selector.range?.start ?? 0;
        const end = selector.range?.end ?? source.byteLength;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > source.byteLength) {
          excluded.push({ contentId: selector.contentId, reasonCode: 'invalid_range' });
          continue;
        }
        const selected = source.subarray(start, end).toString('utf8');
        const sourceLines = selected.split(/\r?\n/).filter(Boolean);
        const sourceRecords: unknown[] = [];
        let structured = sourceLines.length > 0;
        for (const line of sourceLines) {
          try { sourceRecords.push(JSON.parse(line) as unknown); }
          catch { structured = false; break; }
        }
        if (!structured) {
          excluded.push({ contentId: selector.contentId, reasonCode: 'malformed_structured_content' });
          continue;
        }
        if (referencesExcludedPath(sourceRecords, policy.evidence.excludePaths)) {
          excluded.push({ contentId: selector.contentId, reasonCode: 'configured_excluded_path' });
          continue;
        }
        const redactedValue = sourceRecords.map((record) => redactValue(record, stats, '', {
          pseudonymizeIdentity: policy.evidence.pseudonymizeIdentity,
        })).map((record) => JSON.stringify(record)).join('\n');
        const redacted = Buffer.from(redactedValue, 'utf8');
        if (redacted.byteLength === 0) {
          excluded.push({ contentId: selector.contentId, reasonCode: 'redacted_empty' });
          continue;
        }
        if (bytesPrepared + redacted.byteLength > authorizedBytes) {
          excluded.push({ contentId: selector.contentId, reasonCode: 'byte_limit_exceeded' });
          continue;
        }
        approved.push({
          contentId: selector.contentId, bytes: redacted.byteLength,
          chunkHash: sha256(redacted), contentBase64: redacted.toString('base64'),
        });
        bytesPrepared += redacted.byteLength;
      } catch {
        excluded.push({ contentId: selector.contentId, reasonCode: 'vault_content_unavailable' });
      }
    }
    const unsignedResponse = {
      schema: 'dharma.evidence-response/v1', responseId: randomUUID(), requestId: request.requestId,
      organizationId: config.organizationId, deviceId: config.deviceId, workspaceId: workspace.workspaceId,
      trajectoryId: request.trajectoryId, approved, excluded,
      redactionReceipt: { policyRevision: policy.revision, classes: [...stats.classes].sort(), redactedValues: stats.redactedValues },
      bytesPrepared, createdAt: new Date().toISOString(),
    };
    const response = { ...unsignedResponse, responseHash: sha256(canonicalize(unsignedResponse)), signature: null };
    const responseContract = await validateContract(resolve(import.meta.dirname, 'schemas'), 'https://schemas.dharma-ai.io/evidence-response/v1', response);
    if (!responseContract.ok) throw new Error(`Evidence response failed schema validation: ${JSON.stringify(responseContract.errors)}`);
    const expansionReservation = sha256(canonicalize({ requestId: request.requestId, responseHash: response.responseHash }));
    await reserveDailyEvidenceBytes(expansionReservation, bytesPrepared, policy);
    const accepted = await fabric.postEvidenceResponse(request.requestId, response);
    const receipt = accepted.receipt && typeof accepted.receipt === 'object' ? accepted.receipt as Record<string, unknown> : {};
    const receiptHash = typeof receipt.hash === 'string' && /^sha256:[a-f0-9]{64}$/.test(receipt.hash)
      ? receipt.hash : response.responseHash;
    vault.recordDisclosure(unsignedResponse.responseId, receiptHash, bytesPrepared);
    await writeJsonAtomic(requestReceipt, {
      schema: 'dharma.evidence-request-receipt/v1',
      requestId: request.requestId,
      nonce: request.nonce,
      state: 'completed',
      responseId: unsignedResponse.responseId,
      responseHash: response.responseHash,
      completedAt: new Date().toISOString(),
    });
    return {
      ok: true, requestId: request.requestId, responseId: unsignedResponse.responseId,
      approved: approved.length, excluded: excluded.length, bytesPrepared, receipt,
    };
  } finally { vault.close(); }
}

async function runOneEvidenceRequest(flags: Map<string, string | boolean>): Promise<Output> {
  const policy = await loadVerifiedWorkspacePolicy(required(flags, 'policy'), typeof flags.get('workspace-id') === 'string' ? String(flags.get('workspace-id')) : undefined);
  return processEvidenceRequest(await client(), policy, typeof flags.get('workspace-id') === 'string' ? String(flags.get('workspace-id')) : undefined);
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
  const activeBundleId = await getActiveSkillBundleId(nativeSkillDirectory(task.target.provider));
  try {
    assertTaskSkillPin(task.skillBundle, activeBundleId);
  } catch (error) {
    await fabric.postTaskEvent(task.taskId, 'failed', {
      phase: 'preflight',
      code: taskSkillPinFailureCode(error),
      taskBundleId: task.skillBundle?.bundleId || null,
      localBundleId: activeBundleId,
    }).catch(() => undefined);
    throw error;
  }
  await fabric.postTaskEvent(task.taskId, 'started', {
    bundleId: task.skillBundle?.bundleId || null,
    bundleHash: task.skillBundle?.bundleHash || null,
  });
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
    response: taskResponsePreview(receipt),
    commandResults: receipt.commandResults.map(({ commandId, exitCode, signal, timedOut, stdoutSha256, stderrSha256 }) => ({ commandId, exitCode, signal, timedOut, stdoutSha256, stderrSha256 })),
    startedAt: receipt.startedAt, completedAt: receipt.completedAt,
  };
  await fabric.postTaskEvent(task.taskId, receipt.status, summary);
  return { ok: true, taskId: task.taskId, receipt: summary };
}

async function runOneTask(flags: Map<string, string | boolean>): Promise<Output> {
  const policy = await loadVerifiedWorkspacePolicy(required(flags, 'policy'), typeof flags.get('workspace-id') === 'string' ? String(flags.get('workspace-id')) : undefined);
  return executeOneTask(await client(), policy, Number(flags.get('lease-seconds') || 120));
}

export function nativeSkillDirectory(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  if (provider === 'codex') return resolve(env.CODEX_HOME || resolve(home, '.codex'), 'skills');
  if (provider === 'claude') return resolve(env.CLAUDE_CONFIG_DIR || resolve(home, '.claude'), 'skills');
  return resolve(env.AGY_CONFIG_DIR || resolve(home, '.gemini', 'antigravity-cli'), 'plugins', 'dharma-agent-fabric', 'skills');
}

export async function installNativeAgentFabricBootstrap(input: {
  provider: ProviderId;
  workspace: string;
  workspaceId: string;
  organizationId: string;
  hqUrl: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}) {
  const root = nativeSkillDirectory(input.provider, input.env, input.home);
  const skillRoot = resolve(root, 'dharma-agent-fabric');
  const marker = resolve(skillRoot, '.dharma-agent-fabric-bootstrap.json');
  if (await pathExists(skillRoot) && !await pathExists(marker)) {
    throw new Error(`Refusing to replace an unmanaged ${input.provider} skill at ${skillRoot}.`);
  }
  const skill = `---
name: dharma-agent-fabric
description: Connect the current repository to Dharma Agent Fabric for signed tasks, bounded evidence, and verified skill releases.
---

# Dharma Agent Fabric

Use this skill only inside a repository containing \`.dharma/agent-fabric.json\` and \`.dharma/approved-policy.json\`.

1. Run \`dharma status\` and \`dharma skills verify --provider ${input.provider} --workspace .\` before accepting work.
2. Start \`dharma relay start --policy .dharma/approved-policy.json\` for signed task, evidence, and skill delivery.
3. Preview evidence before sync. Run local deterministic self-analysis and disclose only the policy-selected metadata or customer-authorized content classes. Never expose provider credentials, hidden evaluation truth, or unrelated local files.
4. Accept only organization-scoped tasks whose workspace, path, command, network, Git, budget, expiry, replay, and skill-pin checks pass locally.
5. Treat cross-agent requests as structured, task-bound handoffs. Never infer shell, merge, deploy, secret, or unrelated-file authority.

The repository-local skill and connection manifest are authoritative for the active organization. Signed remediation bundles replace this bootstrap only after server-side evaluation, held-out, approval, signing, and rollout gates pass.
`;
  await mkdir(skillRoot, { recursive: true, mode: 0o700 });
  await writeFile(resolve(skillRoot, 'SKILL.md'), skill, { mode: 0o600 });
  await writeFile(marker, `${JSON.stringify({
    schema: 'dharma.native-skill-bootstrap/v1',
    managedBy: 'dharma-agent-fabric',
    provider: input.provider,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    workspaceRouteHash: sha256(resolve(input.workspace)),
    hqUrl: input.hqUrl,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  if (input.provider === 'agy') await activateAgyPlugin({ env: input.env, home: input.home });
  return {
    provider: input.provider,
    nativeSkillDirectory: root,
    skillPath: resolve(skillRoot, 'SKILL.md'),
    activation: 'next_session',
    verified: await pathExists(resolve(skillRoot, 'SKILL.md')) && await pathExists(marker),
  };
}

export async function verifyAgentFabricSkillInstallation(input: {
  provider: ProviderId;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
}) {
  const workspace = await realpath(input.workspace);
  const repositorySkillPath = resolve(workspace, '.agents', 'skills', 'dharma-agent-fabric', 'SKILL.md');
  const connectionPath = resolve(workspace, '.dharma', 'agent-fabric.json');
  const nativeRoot = nativeSkillDirectory(input.provider, input.env, input.home);
  const nativeSkillPath = resolve(nativeRoot, 'dharma-agent-fabric', 'SKILL.md');
  const nativeMarkerPath = resolve(nativeRoot, 'dharma-agent-fabric', '.dharma-agent-fabric-bootstrap.json');
  const repositoryInstalled = await pathExists(repositorySkillPath) && await pathExists(connectionPath);
  const nativeInstalled = await pathExists(nativeSkillPath) && await pathExists(nativeMarkerPath);
  return {
    provider: input.provider,
    ready: repositoryInstalled && nativeInstalled,
    repositoryInstalled,
    nativeInstalled,
    repositorySkillPath,
    connectionPath,
    nativeSkillPath,
    activeBundleId: await getActiveSkillBundleId(nativeRoot),
    activation: 'next_session',
    nextAction: repositoryInstalled && nativeInstalled
      ? `Start a new ${input.provider} session from ${workspace} and invoke the dharma-agent-fabric skill.`
      : 'Run dharma onboard again from the repository root.',
  };
}

type AgyPluginExecutor = (executable: string, argv: string[], options: { timeout: number }) => Promise<unknown>;

export async function activateAgyPlugin(input: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  execute?: AgyPluginExecutor;
} = {}) {
  const root = resolve(nativeSkillDirectory('agy', input.env, input.home), '..');
  const execute = input.execute || ((executable, argv, options) => execFileAsync(executable, argv, options));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const manifest = resolve(root, 'plugin.json');
  try { await access(manifest); }
  catch { await writeFile(manifest, `${JSON.stringify({ name: 'dharma-agent-fabric' }, null, 2)}\n`, { mode: 0o600 }); }
  await execute('agy', ['plugin', 'validate', root], { timeout: 30_000 });
  await execute('agy', ['plugin', 'enable', 'dharma-agent-fabric'], { timeout: 30_000 });
}

function containedInlinePath(root: string, value: string) {
  if (!value || value.includes('\\') || isAbsolute(value)) throw new Error('Inline skill file path is invalid.');
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new Error('Inline skill file path is invalid.');
  const candidate = resolve(root, ...segments);
  const route = relative(resolve(root), candidate);
  if (route === '..' || route.startsWith('../') || route.startsWith('..\\') || isAbsolute(route)) {
    throw new Error('Inline skill file path escapes its skill root.');
  }
  return candidate;
}

export async function materializeInlineSkillFiles(bundle: SkillBundle, sourceRoot: string) {
  if (bundle.operation === 'clear') return false;
  const inline = bundle.skills.map((skill) => skill.files);
  if (inline.every((files) => files === undefined)) return false;
  if (!inline.every((files) => Array.isArray(files) && files.length > 0 && files.length <= 32)) {
    throw new Error('Every skill in an inline bundle must contain 1-32 signed files.');
  }
  let totalBytes = 0;
  for (const skill of bundle.skills) {
    const skillRoot = containedInlinePath(sourceRoot, skill.path);
    const seen = new Set<string>();
    for (const file of skill.files || []) {
      if (!file || typeof file.path !== 'string' || typeof file.contentBase64 !== 'string' || typeof file.sha256 !== 'string') {
        throw new Error('Inline skill file metadata is invalid.');
      }
      if (seen.has(file.path)) throw new Error('Inline skill bundle contains duplicate file paths.');
      seen.add(file.path);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) {
        throw new Error('Inline skill file encoding is invalid.');
      }
      const content = Buffer.from(file.contentBase64, 'base64');
      totalBytes += content.length;
      if (totalBytes > 1_048_576) throw new Error('Inline skill bundle exceeds the 1 MiB limit.');
      const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
      if (digest !== file.sha256) throw new Error(`Inline skill file hash mismatch: ${file.path}`);
      const destination = containedInlinePath(skillRoot, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { mode: 0o600 });
    }
  }
  return true;
}

async function skillSync(flags: Map<string, string | boolean>): Promise<Output> {
  const workspaceId = required(flags, 'workspace-id');
  const providerValue = required(flags, 'provider');
  if (!['codex', 'claude', 'agy'].includes(providerValue)) throw new Error('Skill provider must be codex, claude, or agy.');
  const provider = providerValue as ProviderId;
  const workspace = (await registry()).find((item) => item.workspaceId === workspaceId);
  if (!workspace) throw new Error('Skill workspace is not registered locally.');
  const policy = await loadOrganizationPolicy(required(flags, 'policy'));
  const destination = nativeSkillDirectory(provider);
  const fabric = await client();
  const response = await fabric.pollSkill({ workspaceId, provider, installedBundleId: await getActiveSkillBundleId(destination) });
  const rollout = response.rollout as { id?: unknown; bundle?: unknown } | null | undefined;
  if (!rollout) return { ok: true, rollout: null, changed: false };
  if (typeof rollout.id !== 'string' || !rollout.bundle || typeof rollout.bundle !== 'object') throw new Error('Skill rollout response is invalid.');
  const bundle = rollout.bundle as SkillBundle;
  if (bundle.organizationId !== policy.organizationId || !Array.isArray(bundle.skills)
    || (bundle.operation === 'install' && bundle.skills.length === 0)
    || (bundle.operation === 'clear' && bundle.skills.length !== 0)) {
    throw new Error('Skill bundle does not match local organization policy.');
  }
  const commits = [...new Set(bundle.skills.map((skill) => skill.commit))];
  const repositories = [...new Set(bundle.skills.map((skill) => skill.repository))];
  if (bundle.operation === 'install') {
    if (commits.length !== 1 || !/^[a-f0-9]{40,64}$/i.test(commits[0]!)) throw new Error('Skill bundle must pin one full Git commit.');
    if (repositories.length !== 1 || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repositories[0]!)) {
      throw new Error('Skill bundle must pin one credential-free GitHub repository.');
    }
  }
  const sourceRoot = resolve(dharmaHome(), 'relay', 'skill-sources', bundle.bundleId);
  const config = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
  verifySkillBundle(bundle, createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519 }, format: 'jwk' }));
  await mkdir(resolve(dharmaHome(), 'relay', 'skill-sources'), { recursive: true, mode: 0o700 });
  await rm(sourceRoot, { recursive: true, force: true });
  await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
  const materializedInline = await materializeInlineSkillFiles(bundle, sourceRoot);
  if (bundle.operation === 'install' && !materializedInline) {
    await rm(sourceRoot, { recursive: true, force: true });
    await execFileAsync('git', ['clone', '--filter=blob:none', '--no-checkout', repositories[0]!, sourceRoot], { timeout: 120_000 });
    await execFileAsync('git', ['-C', sourceRoot, 'fetch', '--no-tags', '--depth=1', 'origin', commits[0]!], { timeout: 120_000 });
    await execFileAsync('git', ['-C', sourceRoot, 'checkout', '--detach', commits[0]!], { timeout: 30_000 });
  }
  try {
    const identity = await loadOrCreateDeviceIdentity({ hqUrl: config.hqUrl, organizationId: config.organizationId });
    const receipt = await installSkillBundle({
      bundle,
      sourceDirectory: sourceRoot,
      nativeSkillDirectory: destination,
      policy,
      serverPublicKey: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519 }, format: 'jwk' }),
      devicePrivateKey: createPrivateKey({ key: identity.privateJwk, format: 'jwk' }),
      deviceId: config.deviceId,
      workspaceId,
      provider,
      smokeCommandId: typeof flags.get('smoke-command') === 'string' ? String(flags.get('smoke-command')) : undefined,
      organizationApprovalId: typeof flags.get('approval-id') === 'string' ? String(flags.get('approval-id')) : undefined,
    });
    if (provider === 'agy' && receipt.status === 'active') await activateAgyPlugin();
    await fabric.postInstallReceipt(bundle.bundleId, rollout.id, receipt);
    return { ok: true, rolloutId: rollout.id, bundleId: bundle.bundleId, status: receipt.status, changed: true };
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
}

async function relayStart(flags: Map<string, string | boolean>): Promise<Output> {
  const policyPath = resolve(required(flags, 'policy'));
  let policy = await loadVerifiedWorkspacePolicy(policyPath);
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
  let evidenceResponsesCompleted = 0;
  let nextPolicyRefreshAt = 0;
  let evidencePolicyFresh = false;
  try {
    do {
      if (Date.now() >= nextPolicyRefreshAt) {
        let canonicalWorkspaceSeen = false;
        let canonicalWorkspaceRefreshed = false;
        for (const workspace of (await registry()).filter((item) => item.organizationId === policy.organizationId)) {
          const isCanonicalWorkspace = policyPath === resolve(workspace.path, '.dharma', 'approved-policy.json');
          if (isCanonicalWorkspace) canonicalWorkspaceSeen = true;
          try {
            await syncWorkspacePolicy(fabric, workspace, policy.revision, true);
            if (isCanonicalWorkspace) {
              policy = await loadVerifiedWorkspacePolicy(policyPath, workspace.workspaceId);
              canonicalWorkspaceRefreshed = true;
            }
          } catch {
            if (isCanonicalWorkspace) canonicalWorkspaceRefreshed = false;
          }
        }
        evidencePolicyFresh = canonicalWorkspaceSeen && canonicalWorkspaceRefreshed;
        nextPolicyRefreshAt = Date.now() + 60_000;
      }
      let evidenceRequestId: string | undefined;
      if (evidencePolicyFresh) {
        const evidence = await processEvidenceRequest(fabric, policy);
        evidenceRequestId = typeof evidence.requestId === 'string' ? evidence.requestId : undefined;
        if (evidenceRequestId) evidenceResponsesCompleted += 1;
      }
      const result = await executeOneTask(fabric, policy, leaseSeconds);
      if (result.taskId) tasksCompleted += 1;
      if (flags.has('once')) break;
      if (!result.taskId && !evidenceRequestId) await new Promise((accept) => setTimeout(accept, pollMs));
    } while (!stopping);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await rm(pidPath, { force: true });
  }
  return { ok: true, stopped: true, tasksCompleted, evidenceResponsesCompleted };
}

export async function run(argv: string[]): Promise<Output> {
  const { positional, flags } = options(argv);
  const [command, subcommand] = positional;
  if (flags.has('help') || command === 'help') return USAGE;
  if (flags.has('version') || command === 'version') return { version: VERSION };
  if (command === 'onboard') return onboard(flags);
  if (command === 'login') return login(flags);
  if (command === 'providers' && subcommand === 'list') return { providers: await Promise.all(providerAdapters.map((adapter) => adapter.capability())) };
  if (command === 'workspace' && subcommand === 'add') return workspaceAdd(flags, positional.slice(2));
  if (command === 'workspace' && subcommand === 'sync') return workspaceSync(flags, positional.slice(2));
  if (command === 'capture' || (command === 'evidence' && subcommand === 'capture')) return capture(flags);
  if (command === 'evidence' && subcommand === 'capture-batch') return capture(flags, true);
  if (command === 'evidence' && subcommand === 'preview') return evidencePreview(flags);
  if (command === 'evidence' && subcommand === 'sync') return evidenceSync(flags);
  if (command === 'evidence' && subcommand === 'run-request') return runOneEvidenceRequest(flags);
  if (command === 'status') {
    const relay = await relayProcessState();
    try {
      const config = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
      const status: Record<string, unknown> = { version: VERSION, enrolled: true, relay };
      if (flags.has('verbose') || flags.has('diagnostic')) {
        Object.assign(status, { home: dharmaHome(), organizationId: config.organizationId, deviceId: config.deviceId });
      }
      return status;
    } catch {
      const status: Record<string, unknown> = { version: VERSION, enrolled: false, relay };
      if (flags.has('verbose') || flags.has('diagnostic')) status.home = dharmaHome();
      return status;
    }
  }
  if (command === 'tasks' && subcommand === 'run-once') return runOneTask(flags);
  if (command === 'relay' && subcommand === 'start') return relayStart(flags);
  if (command === 'tasks' && subcommand === 'list') return { tasks: [], coverage: 'server_poll_requires_relay' };
  if (command === 'skills' && subcommand === 'sync') return skillSync(flags);
  if (command === 'skills' && subcommand === 'status') {
    const providerValue = required(flags, 'provider');
    if (!['codex', 'claude', 'agy'].includes(providerValue)) throw new Error('Skill provider must be codex, claude, or agy.');
    const root = nativeSkillDirectory(providerValue as ProviderId);
    return { provider: providerValue, activeBundleId: await getActiveSkillBundleId(root), nativeSkillDirectory: root };
  }
  if (command === 'skills' && subcommand === 'verify') {
    const providerValue = required(flags, 'provider');
    if (!['codex', 'claude', 'agy'].includes(providerValue)) throw new Error('Skill provider must be codex, claude, or agy.');
    const result = await verifyAgentFabricSkillInstallation({
      provider: providerValue as ProviderId,
      workspace: String(flags.get('workspace') || '.'),
    });
    if (!result.ready) throw new Error(`Agent Fabric skill verification failed: ${JSON.stringify(result)}`);
    return result;
  }
  throw new Error(USAGE);
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  run(process.argv.slice(2)).then(print).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
  });
}
