#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, link, mkdir, open, readFile, readdir, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  canonicalize, createActionDecisionPublicKeyResolver, sha256, validateContract,
  validateTrustedServerSigningKeysetContract, verifyCanonicalObject, verifyInitialServerSigningKeyset,
  type ProviderCapability, type ProviderId, type TrustedServerSigningKeyset,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { buildTrajectoryCapsule, redactValue, referencesExcludedPath, trajectoryCapsuleHash, type RedactionStats, type TrajectoryCapsule } from '@dharma-ai-labs/agent-fabric-evidence-reduction';
import { assertPolicy, loadOrganizationPolicy, verifyServerAuthorizedPolicy, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import { agyAdapter, claudeAdapter, codexAdapter, hermesAdapter, providerAdapters, providerExecutionRecords, providerProcessEnvironment, type ProviderSession } from '@dharma-ai-labs/agent-fabric-provider-adapters';
import {
  AgentFabricClient, beginEnrollment, loadOrCreateDeviceIdentity, normalizeHqUrl, pollEnrollment,
  deleteActiveSkillAuthorizationAnchor, loadActiveSkillAuthorizationAnchor, loadDeviceEnrollmentAnchor, saveActiveSkillAuthorizationAnchor,
  isDefinitiveAgentFabricRejection, recoverDeviceEnrollmentConsistency,
  saveDeviceConfig, saveDeviceEnrollmentAnchor, type DeviceConfig, type SecureSecretStore,
} from '@dharma-ai-labs/agent-fabric-relay-client';
import { AgentFabricClient as AgentFabricApiClient } from '@dharma-ai-labs/agent-fabric-sdk';
import { getActiveSkillBundleAuthorization, getExpiredSkillBundleAuthorizationForReplacement, getLegacySkillBundleIdForUpgrade, installSkillBundle, rollbackUnconfirmedSkillBundle, verifySkillBundle, type SkillBundle } from '@dharma-ai-labs/agent-fabric-skill-manager';
import {
  executeTask,
  FileActionExecutionJournal,
  FileTaskReceiptStore,
  providerInstructionsForTask,
  type TaskEnvelope,
  type TaskReceipt,
} from '@dharma-ai-labs/agent-fabric-task-runner';
import { CLI_USAGE } from './usage.js';

const VERSION = '0.2.24';
const USAGE = CLI_USAGE;
const execFileAsync = promisify(execFile);
const LOCAL_PROVIDER_IDS = ['codex', 'claude', 'agy', 'hermes'] as const;
type Output = unknown;

function isLocalProviderId(value: string): value is ProviderId {
  return (LOCAL_PROVIDER_IDS as readonly string[]).includes(value);
}

interface WorkspaceRecord {
  workspaceId: string;
  organizationId: string;
  name: string;
  path: string;
  routeHash: string;
  repositoryRemoteHash: string | null;
  repositoryIdentityVersion?: 'normalized-v1' | 'legacy-v0';
  repositoryAgentId?: string | null;
  repositoryBindingId?: string | null;
  repositoryAgentKey?: string | null;
  controlBranch?: string | null;
  defaultBranch: string | null;
  status: 'active';
}

export function parseCliOptions(args: string[]): {
  positional: string[];
  flags: Map<string, string | boolean>;
  repeated: Map<string, Array<string | boolean>>;
} {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  const repeated = new Map<string, Array<string | boolean>>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith('--')) { positional.push(value); continue; }
    const rawOption = value.slice(2);
    const separator = rawOption.indexOf('=');
    const rawKey = separator < 0 ? rawOption : rawOption.slice(0, separator);
    const inline = separator < 0 ? undefined : rawOption.slice(separator + 1);
    if (inline !== undefined) {
      flags.set(rawKey!, inline);
      repeated.set(rawKey!, [...(repeated.get(rawKey!) || []), inline]);
      continue;
    }
    const next = args[index + 1];
    const parsed = next && !next.startsWith('--') ? next : true;
    flags.set(rawKey!, parsed);
    repeated.set(rawKey!, [...(repeated.get(rawKey!) || []), parsed]);
    if (parsed !== true) index += 1;
  }
  return { positional, flags, repeated };
}

function required(flags: Map<string, string | boolean>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing required option --${name}.`);
  return value;
}

export function portalUrl(flags: Map<string, string | boolean>, fallback = 'https://www.dharma-ai.io'): string {
  return String(flags.get('portal-url') || flags.get('hq-url') || fallback);
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

type EvidenceUploadLedger = {
  schema: 'dharma.evidence-upload-ledger/v2';
  day: string;
  totalBytes: number;
  capsuleHashes: string[];
  capsuleBytes: Record<string, number>;
};

function newEvidenceUploadLedger(day: string): EvidenceUploadLedger {
  return { schema: 'dharma.evidence-upload-ledger/v2', day, totalBytes: 0, capsuleHashes: [], capsuleBytes: {} };
}

function assertEvidenceLedger(ledger: EvidenceUploadLedger, day: string) {
  if (ledger.schema !== 'dharma.evidence-upload-ledger/v2' || ledger.day !== day
    || !Number.isSafeInteger(ledger.totalBytes) || ledger.totalBytes < 0
    || !Array.isArray(ledger.capsuleHashes) || new Set(ledger.capsuleHashes).size !== ledger.capsuleHashes.length
    || ledger.capsuleHashes.some((hash) => !/^sha256:[a-f0-9]{64}$/.test(hash))
    || !ledger.capsuleBytes || typeof ledger.capsuleBytes !== 'object'
    || ledger.capsuleHashes.some((hash) => !Number.isSafeInteger(ledger.capsuleBytes[hash]) || ledger.capsuleBytes[hash]! < 0)
    || Object.keys(ledger.capsuleBytes).some((hash) => !ledger.capsuleHashes.includes(hash))
    || ledger.capsuleHashes.reduce((sum, hash) => sum + ledger.capsuleBytes[hash]!, 0) !== ledger.totalBytes) {
    throw new Error('Evidence upload ledger is invalid.');
  }
}

function evidenceLedgerForPolicyActivation(value: unknown, day: string): EvidenceUploadLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Evidence upload ledger is invalid.');
  }
  const ledger = value as Partial<EvidenceUploadLedger>;
  if (typeof ledger.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ledger.day)) {
    throw new Error('Evidence upload ledger is invalid.');
  }
  if (ledger.day !== day) {
    if (ledger.day > day) throw new Error('Evidence upload ledger is invalid.');
    return newEvidenceUploadLedger(day);
  }
  if (ledger.schema === 'dharma.evidence-upload-ledger/v2') {
    assertEvidenceLedger(ledger as EvidenceUploadLedger, day);
    return ledger as EvidenceUploadLedger;
  }
  const legacyEmpty = ledger.schema === undefined
    && ledger.totalBytes === 0
    && Array.isArray(ledger.capsuleHashes)
    && ledger.capsuleHashes.length === 0
    && (ledger.capsuleBytes === undefined
      || (typeof ledger.capsuleBytes === 'object' && Object.keys(ledger.capsuleBytes).length === 0));
  if (!legacyEmpty) throw new Error('Evidence upload ledger is invalid.');
  return newEvidenceUploadLedger(day);
}

export async function pathExistsOrThrow(
  path: string,
  check: (path: string) => Promise<unknown> = access,
) {
  try {
    await check(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function canonicalFilesystemPath(path: string) {
  return realpath(path);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
    listPendingCapsuleSyncs<T>(limit?: number, offset?: number): Promise<Array<{ trajectoryId: string; revision: number; capsule: T }>>;
    markCapsuleSynced(trajectoryId: string, revision: number): void;
    discardPendingCapsuleSync(trajectoryId: string, revision: number, reason?: string): void;
  },
  fabric: AgentFabricClient,
  policy: OrganizationPolicy,
  workspaceId: string,
): Promise<number> {
  // The caller must obtain this policy from an authoritative control-plane
  // refresh. An expired policy pauses the queue instead of mutating it.
  assertPolicy(policy);
  let synced = 0;
  let offset = 0;
  for (;;) {
    const pending = await vault.listPendingCapsuleSyncs<Record<string, unknown>>(1_000, offset);
    if (pending.length === 0) return synced;
    let matched = 0;
    for (const item of pending) {
      if (String(item.capsule.workspaceId || '') !== workspaceId) continue;
      matched += 1;
      try {
        assertCapsuleIntegrity(item.capsule);
      } catch {
        vault.discardPendingCapsuleSync(item.trajectoryId, item.revision, 'capsule_integrity_failed');
        continue;
      }
      // Policy expiry and signature failure pause the queue. Only a capsule
      // mismatch under a still-current policy is an authoritative discard.
      assertPolicy(policy);
      try {
        assertCapsuleAuthorizedByCurrentPolicy(item.capsule, policy);
      } catch {
        assertPolicy(policy);
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
    if (matched === 0) {
      if (pending.length < 1_000) return synced;
      offset += pending.length;
    } else {
      offset = 0;
    }
  }
}

async function refreshVerifiedWorkspacePolicyForTransmission(
  policyPath: string,
  workspaceId: string,
  fabric: AgentFabricClient,
) {
  return withWorkspacePolicyRefreshLock(workspaceId, async () => {
    const item = (await registry()).find((candidate) => candidate.workspaceId === workspaceId);
    if (!item) throw new Error('Content transmission workspace is not registered locally.');
    const canonicalPolicyPath = resolve(item.path, '.dharma', 'approved-policy.json');
    const [providedIdentity, registeredIdentity] = await Promise.all([
      canonicalFilesystemPath(resolve(policyPath)),
      canonicalFilesystemPath(canonicalPolicyPath),
    ]);
    if (providedIdentity !== registeredIdentity) {
      throw new Error('Content transmission requires the canonical registered workspace policy path.');
    }
    const current = await loadOrganizationPolicy(policyPath);
    if (current.organizationId !== item.organizationId) {
      throw new Error('Workspace policy organization does not match registration.');
    }
    await syncWorkspacePolicy(fabric, item, current.revision, true);
    return loadVerifiedWorkspacePolicy(policyPath, workspaceId);
  });
}

export function assertCapsuleIntegrity(capsule: Record<string, unknown>) {
  const capsuleHash = String(capsule.capsuleHash || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(capsuleHash) || trajectoryCapsuleHash(capsule as unknown as TrajectoryCapsule) !== capsuleHash) {
    throw new Error('Trajectory capsule integrity check failed.');
  }
}

function trajectoryCapsuleSchemaId(capsule: unknown) {
  const schema = capsule && typeof capsule === 'object' && !Array.isArray(capsule)
    ? (capsule as { schema?: unknown }).schema : null;
  if (schema === 'dharma.trajectory-capsule/v1') return 'https://schemas.dharma-ai.io/trajectory-capsule/v1';
  if (schema === 'dharma.trajectory-capsule/v2') return 'https://schemas.dharma-ai.io/trajectory-capsule/v2';
  if (schema === 'dharma.trajectory-capsule/v3') return 'https://schemas.dharma-ai.io/trajectory-capsule/v3';
  throw new Error('Trajectory capsule schema is unsupported.');
}

export function assertCapsuleAuthorizedByCurrentPolicy(capsule: Record<string, unknown>, policy: OrganizationPolicy) {
  assertPolicy(policy);
  const mode = capsule.automaticDisclosureMode;
  const receipt = capsule.redactionReceipt && typeof capsule.redactionReceipt === 'object' && !Array.isArray(capsule.redactionReceipt)
    ? capsule.redactionReceipt as Record<string, unknown> : {};
  if (!['metadata_only', 'local_analysis', 'customer_authorized_content'].includes(String(mode))
    || receipt.disclosureMode !== mode
    || mode !== (policy.evidence.automaticDisclosure?.mode || 'local_analysis')
    || capsule.organizationId !== policy.organizationId
    || (policy.serverAuthorization && capsule.workspaceId !== policy.serverAuthorization.workspaceId)) {
    throw new Error('Trajectory capsule disclosure mode is invalid or inconsistent.');
  }
  const events = Array.isArray(capsule.events) ? capsule.events : [];
  if (mode !== 'customer_authorized_content') {
    const provider = String(capsule.provider || '');
    const capsuleSchema = String(capsule.schema || '');
    const captureProvenance = capsule.captureProvenance && typeof capsule.captureProvenance === 'object'
      && !Array.isArray(capsule.captureProvenance)
      ? capsule.captureProvenance as Record<string, unknown> : {};
    const fixedEventKinds = new Set([
      'user_message', 'agent_message', 'tool_call', 'tool_result', 'command', 'file_read', 'file_write',
      'git', 'validation', 'permission', 'subagent', 'error', 'retry', 'session_state', 'metadata', 'collapsed_output',
    ]);
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    const digest = /^sha256:[a-f0-9]{64}$/;
    const allowedMissingFields = new Set([
      'workspace_on_some_events', 'events_collapsed_for_size', 'native_payload_collapsed_for_size',
    ]);
    const allowedDisclosedClasses = new Set([
      'tenant_identifier', 'device_identifier', 'workspace_identifier', 'pseudonymous_session_identifier',
      'provider_name', 'event_kind', 'event_timestamp', 'event_coverage', 'source_kind', 'record_size',
      'local_evidence_descriptor', 'local_deterministic_analysis',
    ]);
    const allowedExcludedClasses = new Set([
      'encrypted_reasoning', 'execution_configuration', 'instruction_text', 'local_path', 'native_provider_payload',
      'prompt_text', 'rate_limit_metadata', 'response_text', 'token_metadata', 'tool_schema', 'tool_input', 'tool_output',
    ]);
    const allowedRedactionClasses = new Set([
      'automatic_content_omission', 'configured_excluded_path', 'invalid_unicode_nul', 'local_path',
      'private_key', 'github_token', 'openai_key', 'aws_access_key', 'jwt', 'connection_string', 'authorization',
      'google_api_key', 'slack_token', 'generic_secret', 'sensitive_field',
    ]);
    const coverage = capsule.coverage && typeof capsule.coverage === 'object' && !Array.isArray(capsule.coverage)
      ? capsule.coverage as Record<string, unknown> : {};
    const missingFields = Array.isArray(coverage.missingFields) ? coverage.missingFields : null;
    const signedTaskCapture = capsuleSchema === 'dharma.trajectory-capsule/v3'
      && captureProvenance.sourceClass === 'signed_task_execution';
    const signedTaskBundleIds = [...new Set(events.map((event) => (
      event && typeof event === 'object' && !Array.isArray(event)
        ? String((event as Record<string, unknown>).skillBundleId || '') : ''
    )).filter(Boolean))];
    if (!isLocalProviderId(provider)
      || !digest.test(String(capsule.sessionId || ''))
      || (signedTaskCapture
        ? !uuid.test(String(capsule.taskId || ''))
          || !digest.test(String(captureProvenance.taskReceiptHash || ''))
          || !Number.isFinite(Date.parse(String(captureProvenance.collectedAt || '')))
          || signedTaskBundleIds.length !== 1
          || !uuid.test(signedTaskBundleIds[0] || '')
        : capsule.taskId !== null || capsuleSchema === 'dharma.trajectory-capsule/v3')
      || !uuid.test(String(capsule.deviceId || ''))
      || capsule.redactionReceipt === null
      || receipt.policyRevision !== policy.revision
      || capsule.evidenceMode !== policy.evidence.defaultMode
      || !['completed', 'partial'].includes(String(capsule.status || ''))
      || !['observed', 'partial'].includes(String(coverage.state || ''))
      || !Number.isSafeInteger(coverage.admittedSessions) || Number(coverage.admittedSessions) < 0
      || !Number.isSafeInteger(coverage.excludedSessions) || Number(coverage.excludedSessions) < 0
      || !missingFields || missingFields.some((value) => typeof value !== 'string' || !allowedMissingFields.has(value))) {
      throw new Error('Reduced trajectory capsule contains unauthorized identity or policy metadata.');
    }
    const emptyRecord = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value as Record<string, unknown>).length === 0;
    if (!emptyRecord(capsule.repoState) || !emptyRecord(capsule.skillState)
      || !Array.isArray(capsule.validationResults) || capsule.validationResults.length !== 0) {
      throw new Error('Reduced trajectory capsule contains unauthorized auxiliary content.');
    }
    const contentIndex = Array.isArray(capsule.contentIndex) ? capsule.contentIndex : [];
    if (contentIndex.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
      || !digest.test(String((entry as Record<string, unknown>).contentId || ''))
      || (entry as Record<string, unknown>).uploaded !== false
      || (entry as Record<string, unknown>).availableLocally !== true
      || !Number.isSafeInteger((entry as Record<string, unknown>).bytes)
      || Number((entry as Record<string, unknown>).bytes) < 0
      || (entry as Record<string, unknown>).normalizedPath !== null
      || !['raw-provider-session', 'raw-provider-turn'].includes(String((entry as Record<string, unknown>).kind || ''))
      || (entry as Record<string, unknown>).mimeType !== 'application/x-ndjson')) {
      throw new Error('Reduced trajectory capsule contains an unauthorized content descriptor.');
    }
    const localEvidenceAvailable = Array.isArray(capsule.localEvidenceAvailable) ? capsule.localEvidenceAvailable : [];
    if (localEvidenceAvailable.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)
      || !digest.test(String((entry as Record<string, unknown>).contentId || ''))
      || !['raw-provider-session', 'raw-provider-turn'].includes(String((entry as Record<string, unknown>).kind || ''))
      || !Number.isSafeInteger((entry as Record<string, unknown>).bytes)
      || Number((entry as Record<string, unknown>).bytes) < 0)) {
      throw new Error('Reduced trajectory capsule contains an unauthorized local evidence descriptor.');
    }
    for (const event of events) {
      const payload = event && typeof event === 'object' && !Array.isArray(event)
        ? (event as Record<string, unknown>).payload : null;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Reduced trajectory event payload is invalid.');
      }
      const record = payload as Record<string, unknown>;
      const allowedKeys = new Set(['nativeKind', 'recordBytes', 'contentOmitted']);
      if (Object.keys(record).some((key) => !allowedKeys.has(key)) || record.contentOmitted !== true
        || !/^[A-Za-z0-9_.:-]{1,80}$/.test(String(record.nativeKind || ''))
        || !Number.isSafeInteger(record.recordBytes) || Number(record.recordBytes) < 0) {
        throw new Error('Reduced trajectory capsule contains unauthorized provider content.');
      }
      const eventRecord = event as Record<string, unknown>;
      const allowedEventKeys = new Set([
        'schema', 'eventId', 'organizationId', 'deviceId', 'workspaceId', 'provider', 'sessionId', 'sequence',
        'occurredAt', 'kind', 'coverage', 'contentRefs', 'payload', 'source', 'skillBundleId', 'providerModel',
      ]);
      const source = eventRecord.source && typeof eventRecord.source === 'object' && !Array.isArray(eventRecord.source)
        ? eventRecord.source as Record<string, unknown> : {};
      const eventKind = String(eventRecord.kind || '');
      if (Object.keys(eventRecord).some((key) => !allowedEventKeys.has(key))
        || eventRecord.schema !== 'dharma.agent-event/v1'
        || !uuid.test(String(eventRecord.eventId || ''))
        || eventRecord.organizationId !== capsule.organizationId
        || eventRecord.deviceId !== capsule.deviceId
        || eventRecord.workspaceId !== capsule.workspaceId
        || eventRecord.provider !== provider
        || eventRecord.sessionId !== capsule.sessionId
        || !Number.isSafeInteger(eventRecord.sequence) || Number(eventRecord.sequence) < 0
        || !Number.isFinite(Date.parse(String(eventRecord.occurredAt || '')))
        || !fixedEventKinds.has(eventKind)
        || !['observed', 'partial', 'unavailable', 'excluded', 'redacted', 'out_of_window', 'not_supported'].includes(String(eventRecord.coverage || ''))
        || !Array.isArray(eventRecord.contentRefs) || eventRecord.contentRefs.length !== 0
        || source.nativeEventId !== null || source.localLocatorId !== null || source.sourceKind !== eventKind
        || record.nativeKind !== eventKind
        || eventRecord.skillBundleId !== (signedTaskCapture ? signedTaskBundleIds[0] : null)
        || eventRecord.providerModel !== null) {
        throw new Error('Reduced trajectory capsule contains unauthorized event descriptors.');
      }
    }
    if (receipt.consentReceiptId !== null && receipt.consentReceiptId !== undefined) {
      throw new Error('Reduced trajectory capsule cannot claim a content consent receipt.');
    }
    const localAnalysis = capsule.localAnalysis;
    if (mode === 'metadata_only' && localAnalysis !== null) {
      throw new Error('Metadata-only trajectory capsule cannot contain local analysis.');
    }
    if (mode === 'local_analysis') {
      if (!localAnalysis || typeof localAnalysis !== 'object' || Array.isArray(localAnalysis)) {
        throw new Error('Local-analysis trajectory capsule is missing deterministic analysis.');
      }
      const analysis = localAnalysis as Record<string, unknown>;
      const eventKinds = analysis.eventKinds && typeof analysis.eventKinds === 'object' && !Array.isArray(analysis.eventKinds)
        ? analysis.eventKinds as Record<string, unknown> : null;
      const reasonCodes = Array.isArray(analysis.reasonCodes) ? analysis.reasonCodes : null;
      const allowedReasons = new Set(['runtime_failure_signal', 'tool_call_without_result', 'tool_result_without_call', 'partial_evidence']);
      if (analysis.schema !== 'dharma.local-trajectory-analysis/v1' || analysis.analyzer !== 'deterministic'
        || !eventKinds || Object.entries(eventKinds).some(([key, value]) => !(fixedEventKinds.has(key)
          || (signedTaskCapture && key === 'unknown'))
          || !Number.isSafeInteger(value) || Number(value) < 0)
        || !reasonCodes || reasonCodes.some((value) => typeof value !== 'string' || !allowedReasons.has(value))) {
        throw new Error('Local-analysis trajectory capsule contains invalid free-form analysis data.');
      }
    }
    const validReceiptValues = (key: string, allowed: Set<string>) => Array.isArray(receipt[key])
      && (receipt[key] as unknown[]).every((value) => typeof value === 'string' && allowed.has(value));
    if (!validReceiptValues('disclosedClasses', allowedDisclosedClasses)
      || !validReceiptValues('excludedClasses', allowedExcludedClasses)
      || !validReceiptValues('classes', allowedRedactionClasses)) {
      throw new Error('Reduced trajectory capsule contains invalid redaction receipt classes.');
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
      const recoveryPath = `${lockPath}.recovery`;
      const recoveryCandidate = `${recoveryPath}.${process.pid}.${randomUUID()}.candidate`;
      try {
        await mkdir(recoveryCandidate);
        await writeFile(resolve(recoveryCandidate, 'owner'), `${process.pid}\n`, { mode: 0o600 });
        await rename(recoveryCandidate, recoveryPath);
        try {
          let ownerPid = 0;
          try { ownerPid = Number((await readFile(lockPath, 'utf8')).trim()); }
          catch (readError) {
            if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          }
          let ownerAlive = Number.isSafeInteger(ownerPid) && ownerPid > 0;
          if (ownerAlive) {
            try { process.kill(ownerPid, 0); }
            catch (killError) { ownerAlive = (killError as NodeJS.ErrnoException).code === 'EPERM'; }
          }
          if (!ownerAlive) {
            const quarantine = `${lockPath}.dead.${randomUUID()}`;
            try {
              await rename(lockPath, quarantine);
              await unlink(quarantine);
              continue;
            } catch (renameError) {
              if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
            }
          }
        } finally {
          await rm(recoveryPath, { recursive: true, force: true });
        }
      } catch (recoveryError) {
        await rm(recoveryCandidate, { recursive: true, force: true });
        if (!['EEXIST', 'ENOTEMPTY'].includes((recoveryError as NodeJS.ErrnoException).code || '')) throw recoveryError;
        let recoveryOwner = 0;
        try { recoveryOwner = Number((await readFile(resolve(recoveryPath, 'owner'), 'utf8')).trim()); } catch {}
        let recoveryOwnerAlive = Number.isSafeInteger(recoveryOwner) && recoveryOwner > 0;
        if (recoveryOwnerAlive) {
          try { process.kill(recoveryOwner, 0); }
          catch (killError) { recoveryOwnerAlive = (killError as NodeJS.ErrnoException).code === 'EPERM'; }
        }
        if (!recoveryOwnerAlive) {
          const quarantine = `${recoveryPath}.dead.${randomUUID()}`;
          try { await rename(recoveryPath, quarantine); await rm(quarantine, { recursive: true, force: true }); }
          catch (renameError) { if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError; }
        }
      }
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

async function reserveDailyEvidenceBytes(key: string, bytes: number, policy: OrganizationPolicy, _store?: SecureSecretStore) {
  if (!/^sha256:[a-f0-9]{64}$/.test(key) || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('Evidence upload reservation is invalid.');
  }
  const day = new Date().toISOString().slice(0, 10);
  await withEvidenceLedgerLock(async () => {
    let ledger: EvidenceUploadLedger;
    try {
      ledger = JSON.parse(await readFile(evidenceUploadLedgerPath(), 'utf8')) as EvidenceUploadLedger;
      if (ledger.day !== day) {
        ledger = newEvidenceUploadLedger(day);
      } else {
        assertEvidenceLedger(ledger, day);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        ledger = newEvidenceUploadLedger(day);
      } else {
        throw error;
      }
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

export async function reserveDailyContentUpload(
  capsule: Record<string, unknown>, policy: OrganizationPolicy, store?: SecureSecretStore,
) {
  if (capsule.automaticDisclosureMode !== 'customer_authorized_content') return;
  const capsuleHash = String(capsule.capsuleHash || '');
  assertCapsuleIntegrity(capsule);
  const bytes = Buffer.byteLength(canonicalize(capsule));
  await reserveDailyEvidenceBytes(capsuleHash, bytes, policy, store);
}

export async function releaseDailyContentUpload(
  capsule: Record<string, unknown>, policy: OrganizationPolicy, _store?: SecureSecretStore,
) {
  if (capsule.automaticDisclosureMode !== 'customer_authorized_content') return;
  const capsuleHash = String(capsule.capsuleHash || '');
  if (!/^sha256:[a-f0-9]{64}$/.test(capsuleHash)) return;
  await withEvidenceLedgerLock(async () => {
    try {
      const ledger = JSON.parse(await readFile(evidenceUploadLedgerPath(), 'utf8')) as EvidenceUploadLedger;
      assertEvidenceLedger(ledger, new Date().toISOString().slice(0, 10));
      if (!ledger.capsuleHashes.includes(capsuleHash)) return;
      const reservedBytes = Number(ledger.capsuleBytes[capsuleHash] ?? Buffer.byteLength(canonicalize(capsule)));
      ledger.capsuleHashes = ledger.capsuleHashes.filter((hash) => hash !== capsuleHash);
      ledger.totalBytes = Math.max(0, ledger.totalBytes - (Number.isSafeInteger(reservedBytes) ? reservedBytes : 0));
      delete ledger.capsuleBytes[capsuleHash];
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
  secureStore?: SecureSecretStore;
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
        secureStore: input.secureStore,
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

async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  timeoutMessage = 'Timed out waiting for the workspace authorization lock.',
): Promise<T> {
  const release = await acquirePidLock(lockPath, 10_000, timeoutMessage);
  try { return await operation(); }
  finally { await release(); }
}

export async function withWorkspacePolicyRefreshLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
  if (!workspaceId) throw new Error('Content transmission requires a registered workspace ID.');
  return withFileLock(
    `${workspaceAuthorizationStatePath(workspaceId)}.refresh.lock`,
    operation,
    'Timed out waiting for the workspace policy refresh lock.',
  );
}

export async function withWorkspaceSkillActivationLock<T>(
  workspaceId: string,
  provider: ProviderId,
  operation: () => Promise<T>,
): Promise<T> {
  if (!workspaceId || !isLocalProviderId(provider)) {
    throw new Error('Skill activation lock requires a registered workspace and supported provider.');
  }
  const key = createHash('sha256').update(`${workspaceId}:${provider}`).digest('hex');
  return withFileLock(
    resolve(dharmaHome(), 'registry', 'skill-activation-locks', `${key}.lock`),
    operation,
    'Timed out waiting for the workspace skill activation lock.',
  );
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
  secureStore?: SecureSecretStore;
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
    if (contentAuthorized && ledgerExists) {
      const current = JSON.parse(await readFile(evidenceUploadLedgerPath(), 'utf8')) as unknown;
      const ledger = evidenceLedgerForPolicyActivation(current, new Date().toISOString().slice(0, 10));
      if (JSON.stringify(current) !== JSON.stringify(ledger)) {
        await writeJsonAtomic(evidenceUploadLedgerPath(), ledger);
      }
    }
    if (contentAuthorized && !ledgerExists) {
      const ledger = newEvidenceUploadLedger(new Date().toISOString().slice(0, 10));
      await writeJsonAtomic(evidenceUploadLedgerPath(), ledger);
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
  if (provider === 'hermes') return hermesAdapter;
  return null;
}

function deterministicUuid(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeGitRemoteIdentity(value: string): string {
  const raw = value.trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error('Git remote is empty or invalid.');
  let host: string;
  let repositoryPath: string;
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  if (!raw.includes('://') && scp && !/^[A-Za-z]:[\\/]/.test(raw)) {
    host = scp[1]!.toLowerCase();
    repositoryPath = scp[2]!;
  } else {
    let remote: URL;
    try { remote = new URL(raw); }
    catch { throw new Error('Git remote must be a hosted URL or use --repository-key.'); }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(remote.protocol) || !remote.hostname) {
      throw new Error('Local and file Git remotes require an explicit stable --repository-key.');
    }
    host = remote.hostname.toLowerCase();
    const port = remote.port && !((remote.protocol === 'https:' && remote.port === '443') || (remote.protocol === 'http:' && remote.port === '80'))
      ? `:${remote.port}` : '';
    host += port;
    repositoryPath = remote.pathname;
  }
  repositoryPath = repositoryPath.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  if (!repositoryPath || repositoryPath.includes('..') || /\s/.test(repositoryPath)) {
    throw new Error('Git remote repository path is invalid.');
  }
  if (host === 'github.com' || host === 'gitlab.com') repositoryPath = repositoryPath.toLowerCase();
  return `${host}/${repositoryPath}`;
}

export function sourceRepositoryFingerprint(remote: string | null, explicitKey?: string | null): {
  fingerprint: string;
  source: 'remote' | 'explicit_key';
} {
  const key = explicitKey?.trim();
  let identity: string;
  let source: 'remote' | 'explicit_key';
  if (key) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(key) || key.includes('..')) {
      throw new Error('--repository-key must be a stable 1-160 character identifier without secrets or path traversal.');
    }
    identity = `key:${key}`;
    source = 'explicit_key';
  } else if (remote) {
    identity = `remote:${normalizeGitRemoteIdentity(remote)}`;
    source = 'remote';
  } else {
    throw new Error('Repository has no hosted Git remote. Supply a stable --repository-key for this repository.');
  }
  return { fingerprint: `sha256:${createHash('sha256').update(identity).digest('hex')}`, source };
}

export function responseTextFromEvent(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item)
    ? event.item as Record<string, unknown>
    : {};
  if (item.type === 'agent_message' && typeof item.text === 'string') return item.text;
  if (event.type === 'result' && typeof event.result === 'string') return event.result;
  if (event.status === 'SUCCESS' && typeof event.response === 'string') return event.response;
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
  active: { bundleId: string; bundleHash: string } | null,
): void {
  if (pinned === undefined) throw new Error('Task is missing its signed skill bundle pin.');
  if ((pinned?.bundleId || null) !== (active?.bundleId || null)) {
    throw new Error(
      `Task skill bundle does not match the active local bundle (task=${pinned?.bundleId || 'none'}, local=${active?.bundleId || 'none'}).`,
    );
  }
  if (pinned && !/^sha256:[a-f0-9]{64}$/.test(pinned.bundleHash)) {
    throw new Error('Task skill bundle hash is invalid.');
  }
  if (pinned && pinned.bundleHash !== active?.bundleHash) {
    throw new Error('Task skill bundle hash does not match the active local bundle.');
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

async function saveRegistry(items: WorkspaceRecord[]): Promise<void> {
  await mkdir(resolve(dharmaHome(), 'registry'), { recursive: true, mode: 0o700 });
  await writeFile(workspaceRegistryPath(), `${JSON.stringify(items, null, 2)}\n`, { mode: 0o600 });
}

async function saveWorkspaceRecord(entry: WorkspaceRecord): Promise<void> {
  const items = (await registry()).filter((item) => item.workspaceId !== entry.workspaceId);
  items.push(entry);
  await saveRegistry(items);
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

async function organizationApi(flags: Map<string, string | boolean>) {
  let enrolled: DeviceConfig | null = null;
  try { enrolled = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig; } catch {}
  const organizationId = String(flags.get('organization-id') || enrolled?.organizationId || '').trim();
  if (!organizationId) throw new Error('Organization command requires --organization-id or an enrolled device.');
  const token = String(process.env.DHARMA_ORG_API_TOKEN || '').trim();
  if (!token) throw new Error('Organization command requires DHARMA_ORG_API_TOKEN. Tokens are not accepted on the command line.');
  return new AgentFabricApiClient({
    organizationId,
    token,
    baseUrl: portalUrl(flags, enrolled?.hqUrl || 'https://www.dharma-ai.io'),
  });
}

async function commandJsonBody(flags: Map<string, string | boolean>) {
  const inline = flags.get('json-body');
  const path = flags.get('body-file');
  if (typeof inline === 'string' && typeof path === 'string') {
    throw new Error('Use either --json-body or --body-file, not both.');
  }
  const serialized = typeof inline === 'string'
    ? inline
    : typeof path === 'string'
      ? await readFile(resolve(path), 'utf8')
      : '{}';
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Command body must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function requireExplicitConfirmation(flags: Map<string, string | boolean>, action: string) {
  if (flags.get('confirm') !== true) {
    throw new Error(`${action} requires --confirm after reviewing organization scope, cost, and authority.`);
  }
}

async function runOrganizationCommand(command: string | undefined, subcommand: string | undefined, flags: Map<string, string | boolean>) {
  const api = await organizationApi(flags);
  if (command === 'organization' && subcommand === 'status') return api.instructions();
  if (command === 'agents' && subcommand === 'list') return api.listAgents();
  if (command === 'agents' && subcommand === 'bind-runtime') {
    requireExplicitConfirmation(flags, 'Binding a managed or cloud BYOK runtime endpoint');
    const agentId = required(flags, 'agent-id');
    const body = await commandJsonBody(flags);
    const endpointKind = String(body.endpointKind || '');
    if (!['managed_runtime', 'cloud_byok'].includes(endpointKind)) {
      throw new Error('Runtime endpoint kind must be managed_runtime or cloud_byok.');
    }
    return api.bindRuntimeEndpoint(agentId, {
      endpointKind: endpointKind as 'managed_runtime' | 'cloud_byok',
      managedAgentId: String(body.managedAgentId || ''),
      runtimeBindingId: String(body.runtimeBindingId || ''),
      ...(body.priority === undefined ? {} : { priority: Number(body.priority) }),
    });
  }
  if (command === 'experiments' && subcommand === 'list') return api.listAnalysisWindows();
  if (command === 'experiments' && subcommand === 'run') {
    requireExplicitConfirmation(flags, 'Running an experiment');
    return api.requestAnalysis(await commandJsonBody(flags));
  }
  if (command === 'failures' && subcommand === 'list') return api.listFailures();
  if (command === 'remediations' && subcommand === 'list') return api.listRemediations();
  if (command === 'remediations' && subcommand === 'act') {
    const targetId = required(flags, 'target-id');
    const body = await commandJsonBody(flags);
    const action = String(flags.get('action') || body.action || '');
    if (!['stage_evaluation', 'run_backtest', 'link_backtest', 'approve', 'merge_pr', 'release', 'expand', 'rollback'].includes(action)) {
      throw new Error('Remediation action must be stage_evaluation, run_backtest, link_backtest, approve, merge_pr, release, expand, or rollback.');
    }
    if (action === 'stage_evaluation') {
      const endpointId = String(flags.get('endpoint-id') || body.endpointId || '');
      if (!UUID_PATTERN.test(endpointId)) throw new Error('stage_evaluation requires --endpoint-id with an exact endpoint UUID.');
      if (flags.get('dry-run') === true) {
        return {
          ok: true,
          planned: true,
          serverMutation: false,
          targetId,
          transition: { action, endpointId },
        };
      }
      requireExplicitConfirmation(flags, 'Staging a repository remediation evaluation');
      return api.transitionRemediationTarget(targetId, { action, endpointId });
    }
    requireExplicitConfirmation(flags, 'Changing a repository remediation release');
    return api.transitionRemediationTarget(targetId, {
      action: action as 'run_backtest' | 'link_backtest' | 'approve' | 'merge_pr' | 'release' | 'expand' | 'rollback',
      ...(Array.isArray(body.trajectoryIds) ? { trajectoryIds: body.trajectoryIds.map(String) } : {}),
      ...(typeof body.campaignId === 'string' ? { campaignId: body.campaignId } : {}),
      ...(typeof body.establishAutoUpdatePolicy === 'boolean'
        ? { establishAutoUpdatePolicy: body.establishAutoUpdatePolicy }
        : {}),
    });
  }
  if (command === 'skills' && subcommand === 'list') return api.listSkills();
  if (command === 'skills' && subcommand === 'release') {
    requireExplicitConfirmation(flags, 'Releasing a skill');
    return api.releaseSkill(await commandJsonBody(flags));
  }
  if (command === 'skills' && (subcommand === 'rollout' || subcommand === 'rollback')) {
    requireExplicitConfirmation(flags, `${subcommand === 'rollback' ? 'Rolling back' : 'Rolling out'} a skill`);
    const bundleId = required(flags, 'bundle-id');
    const body = await commandJsonBody(flags);
    return api.transitionSkillRollout(bundleId, {
      action: subcommand === 'rollback' ? 'rollback' : String(body.action || 'start') as 'start' | 'expand',
      ...(body.canaryPercent === undefined ? {} : { canaryPercent: Number(body.canaryPercent) }),
    });
  }
  if (command === 'tasks' && subcommand === 'list') return api.listTasks();
  if (command === 'tasks' && subcommand === 'dispatch') {
    requireExplicitConfirmation(flags, 'Dispatching a task');
    return api.dispatchTask(await commandJsonBody(flags));
  }
  if (command === 'handoffs' && subcommand === 'list') return api.listHandoffs();
  if (command === 'handoffs' && subcommand === 'dispatch') {
    requireExplicitConfirmation(flags, 'Dispatching an A2A handoff');
    return api.dispatchHandoff(await commandJsonBody(flags) as unknown as Parameters<typeof api.dispatchHandoff>[0]);
  }
  if (command === 'usage' && subcommand === 'list') return api.usage();
  return null;
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

export type ControlAgentCliClient = Pick<AgentFabricClient,
  'listControlAgentSessions'
  | 'createControlAgentSession'
  | 'submitControlAgentMessage'
  | 'listControlAgentEvents'
>;

type ControlAgentCliClientFactory = () => Promise<ControlAgentCliClient>;

function validatedControlAgentId(value: string, label: string) {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID.`);
  return value;
}

function controlAgentSessionId(response: Record<string, unknown>) {
  const session = response.session && typeof response.session === 'object' && !Array.isArray(response.session)
    ? response.session as Record<string, unknown>
    : null;
  const id = typeof session?.id === 'string' ? session.id : '';
  return validatedControlAgentId(id, 'Created control-agent session ID');
}

export function controlAgentDecisionUrl(input: {
  portalOrigin: string;
  organizationId: string;
  toolCallId: string;
  decision: 'approve' | 'reject';
  sessionId?: string;
}) {
  const url = new URL('/portal/dashboard', normalizeHqUrl(input.portalOrigin));
  url.searchParams.set('orgId', input.organizationId);
  url.searchParams.set('controlAgent', 'open');
  url.searchParams.set('toolCallId', validatedControlAgentId(input.toolCallId, 'Control-agent tool call ID'));
  url.searchParams.set('decision', input.decision);
  if (input.sessionId) {
    url.searchParams.set('sessionId', validatedControlAgentId(input.sessionId, 'Control-agent session ID'));
  }
  return url.toString();
}

export async function runAssistantCommand(
  subcommand: string | undefined,
  flags: Map<string, string | boolean>,
  openClient: ControlAgentCliClientFactory = client,
  openUrl: (url: string) => Promise<boolean> = openVerificationUri,
): Promise<Record<string, unknown>> {
  if (!['chat', 'history', 'status', 'approve', 'reject'].includes(String(subcommand))) {
    throw new Error('Assistant command must be chat, history, status, approve, or reject.');
  }

  if (subcommand === 'approve' || subcommand === 'reject') {
    const config = await readDeviceConfig();
    if (!config) throw new Error('Assistant approval requires an enrolled device. Run dharma login first.');
    const toolCallId = required(flags, 'tool-call-id');
    const sessionId = typeof flags.get('session-id') === 'string' ? String(flags.get('session-id')) : undefined;
    const url = controlAgentDecisionUrl({
      portalOrigin: portalUrl(flags, config.hqUrl),
      organizationId: config.organizationId,
      toolCallId,
      decision: subcommand,
      ...(sessionId ? { sessionId } : {}),
    });
    const opened = flags.has('no-open') ? false : await openUrl(url);
    return {
      ok: true,
      decision: subcommand,
      approvalPerformed: false,
      opened,
      url,
      nextStep: 'Review the exact tool authority and confirm or reject it in the authenticated Dharma portal.',
    };
  }

  const fabric = await openClient();
  if (subcommand === 'history') {
    const sessionId = typeof flags.get('session-id') === 'string'
      ? validatedControlAgentId(String(flags.get('session-id')), 'Control-agent session ID')
      : null;
    if (!sessionId) return fabric.listControlAgentSessions();
    const afterSequence = Number(flags.get('after-sequence') || 0);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error('--after-sequence must be a non-negative integer.');
    }
    return fabric.listControlAgentEvents(sessionId, afterSequence);
  }

  if (subcommand === 'status') {
    const sessionId = validatedControlAgentId(required(flags, 'session-id'), 'Control-agent session ID');
    const [session, events] = await Promise.all([
      fabric.listControlAgentSessions(sessionId),
      fabric.listControlAgentEvents(sessionId, 0),
    ]);
    return { ok: true, sessionId, session, events };
  }

  requireExplicitConfirmation(flags, 'Sending a paid organization control-agent message');
  const suppliedBody = flags.has('json-body') || flags.has('body-file')
    ? await commandJsonBody(flags)
    : { message: required(flags, 'message') };
  const message = typeof suppliedBody.message === 'string' ? suppliedBody.message.trim() : '';
  if (!message) throw new Error('Assistant chat requires a non-empty message.');
  const sessionIdFlag = typeof flags.get('session-id') === 'string'
    ? validatedControlAgentId(String(flags.get('session-id')), 'Control-agent session ID')
    : null;
  const created = sessionIdFlag ? null : await fabric.createControlAgentSession(String(flags.get('title') || 'CLI conversation'));
  const sessionId = sessionIdFlag || controlAgentSessionId(created!);
  const accepted = await fabric.submitControlAgentMessage(sessionId, suppliedBody);
  return {
    ok: true,
    sessionId,
    sessionCreated: Boolean(created),
    accepted,
    statusCommand: `dharma assistant status --session-id ${sessionId}`,
  };
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
  async function assertEnrollmentHomeCompatible(hqUrl: string, organizationId: string): Promise<void> {
    let existing: DeviceConfig | null = null;
    try {
      existing = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Existing device enrollment could not be validated: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (existing && existing.organizationId !== organizationId) {
      throw new Error('This DHARMA_HOME is enrolled to a different organization. Use a separate DHARMA_HOME for each organization.');
    }
    if (existing && normalizeHqUrl(existing.hqUrl) !== normalizeHqUrl(hqUrl)) {
      throw new Error('This device is enrolled to a different Dharma portal origin. Use a separate DHARMA_HOME for each portal origin.');
    }
    let registered: Array<{ organizationId?: unknown }> = [];
    try {
      const parsed = JSON.parse(await readFile(workspaceRegistryPath(), 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('workspace registry must be an array');
      registered = parsed as Array<{ organizationId?: unknown }>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Existing workspace registry could not be validated: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (registered.some((workspace) => workspace.organizationId !== organizationId)) {
      throw new Error('This DHARMA_HOME contains workspaces from a different organization. Use a separate DHARMA_HOME for each organization.');
    }
  }
  let pending: PendingEnrollment;
  if (flags.has('resume')) {
    pending = JSON.parse(await readFile(pendingEnrollmentPath(), 'utf8')) as PendingEnrollment;
    await assertEnrollmentHomeCompatible(pending.hqUrl, pending.organizationId);
  } else {
    const hqUrl = normalizeHqUrl(portalUrl(flags));
    const organizationId = required(flags, 'organization-id');
    await assertEnrollmentHomeCompatible(hqUrl, organizationId);
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
      if (result.serverSigningKeyset) {
        const candidate = result.serverSigningKeyset as TrustedServerSigningKeyset;
        const verification = verifyInitialServerSigningKeyset(
          candidate,
          createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: result.serverPublicKeyEd25519 }, format: 'jwk' }),
          pending.organizationId,
        );
        if (!verification.ok) throw new Error(`Enrollment signing keyset was rejected: ${verification.reason}.`);
        config.serverSigningKeyset = candidate;
      }
      await saveDeviceConfig(configPath(), config);
      await saveDeviceEnrollmentAnchor({ config });
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
  const captureProvenance = (collectedAt: string) => ({
    sourceClass: (typeof root === 'string' ? 'explicit_import' : 'provider_discovery') as
      'explicit_import' | 'provider_discovery',
    collectedAt,
    taskReceiptHash: null,
  });
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
    if (fabric) await syncPendingRetentionCapsules(vault, fabric, policy, registered.workspaceId);
    for (const selected of batch ? sessions : [session]) {
      const rawTurn = Buffer.from(`${selected.records.map((record) => JSON.stringify(record.native)).join('\n')}\n`);
      const rawContentId = sha256(rawTurn);
      const firstRevision = buildTrajectoryCapsule({
        organizationId: device.organizationId, deviceId: device.deviceId, workspaceId: registered.workspaceId,
        session: selected, policy, rawContentId, rawBytes: rawTurn.byteLength, rawKind: 'raw-provider-turn',
        captureProvenance: captureProvenance(selected.endedAt),
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
            captureProvenance: captureProvenance(selected.endedAt),
          })
          : firstRevision;
      const validation = await validateContract(resolve(import.meta.dirname, 'schemas'), trajectoryCapsuleSchemaId(capsule), capsule);
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
        // An unknown delivery outcome retains the local advisory reservation.
        // HQ performs the authoritative, idempotent organization/day charge.
        syncResults.push(await fabric.syncTrajectory(capsule));
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
    const captureProvenance = (collectedAt: string) => ({
      sourceClass: (typeof root === 'string' ? 'explicit_import' : 'provider_discovery') as
        'explicit_import' | 'provider_discovery',
      collectedAt,
      taskReceiptHash: null,
    });
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
        captureProvenance: captureProvenance(session.endedAt),
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
  const workspaceId = deterministicUuid(`${organizationId}:${device.deviceId}:${path}`);
  const remote = await gitValue(path, ['config', '--get', 'remote.origin.url']);
  const identity = sourceRepositoryFingerprint(remote, typeof flags.get('repository-key') === 'string' ? String(flags.get('repository-key')) : null);
  const entry: WorkspaceRecord = {
    workspaceId, organizationId, name: String(flags.get('name') || basename(path)), path,
    routeHash: `sha256:${createHash('sha256').update(path).digest('hex')}`,
    repositoryRemoteHash: identity.fingerprint,
    repositoryIdentityVersion: 'normalized-v1',
    repositoryAgentId: null,
    repositoryBindingId: null,
    repositoryAgentKey: null,
    controlBranch: null,
    defaultBranch: await gitValue(path, ['branch', '--show-current']), status: 'active',
  };
  await saveWorkspaceRecord(entry);
  return {
    ok: true,
    workspaceId,
    organizationId,
    sourceFingerprint: identity.fingerprint,
    repositoryIdentitySource: identity.source,
    pathStoredLocally: true,
    pathDisclosedToServer: false,
  };
}

async function discoverRepositoryAt(path: string) {
  const canonical = await realpath(path);
  const topLevel = await gitValue(canonical, ['rev-parse', '--show-toplevel']);
  if (!topLevel) return null;
  const workspace = await realpath(topLevel);
  const remote = await gitValue(workspace, ['config', '--get', 'remote.origin.url']);
  let normalizedRemote: string | null = null;
  let fingerprint: string | null = null;
  if (remote) {
    normalizedRemote = normalizeGitRemoteIdentity(remote);
    fingerprint = sourceRepositoryFingerprint(remote).fingerprint;
  }
  return {
    name: basename(workspace),
    path: workspace,
    remote: normalizedRemote,
    sourceFingerprint: fingerprint,
    defaultBranch: await gitValue(workspace, ['branch', '--show-current']),
    connectable: Boolean(fingerprint),
    requiredAction: fingerprint ? null : 'Supply --repository-key when connecting this repository.',
  };
}

async function repositoriesDiscover(flags: Map<string, string | boolean>, positional: string[], roots: Array<string | boolean>): Promise<Output> {
  const requested = [...positional, ...roots.filter((value): value is string => typeof value === 'string')];
  if (requested.length === 0) requested.push(String(flags.get('root') || '.'));
  const discovered = new Map<string, Awaited<ReturnType<typeof discoverRepositoryAt>>>();
  for (const requestedRoot of requested) {
    const root = await realpath(requestedRoot);
    const direct = await discoverRepositoryAt(root);
    if (direct) {
      discovered.set(direct.path, direct);
      continue;
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = await discoverRepositoryAt(resolve(root, entry.name));
      if (candidate) discovered.set(candidate.path, candidate);
    }
  }
  return {
    ok: true,
    scanBoundary: 'explicit_roots_and_immediate_children',
    repositories: [...discovered.values()].filter(Boolean),
  };
}

function repositoryKeyAssignments(paths: string[], values: Array<string | boolean>): Map<number, string> {
  const keys = values.filter((value): value is string => typeof value === 'string');
  const assignments = new Map<number, string>();
  if (keys.length === 0) return assignments;
  const named = keys.filter((value) => value.includes('='));
  if (named.length > 0 && named.length !== keys.length) {
    throw new Error('Use either ordered --repository-key values or path=key assignments, not both.');
  }
  if (named.length > 0) {
    for (const value of named) {
      const split = value.indexOf('=');
      const path = resolve(value.slice(0, split));
      const index = paths.findIndex((candidate) => resolve(candidate) === path);
      if (index < 0) throw new Error(`Repository key assignment does not match a selected repository: ${value.slice(0, split)}`);
      assignments.set(index, value.slice(split + 1));
    }
    return assignments;
  }
  if (keys.length !== paths.length) {
    if (paths.length === 1 && keys.length === 1) return new Map([[0, keys[0]!]]);
    throw new Error('Provide one ordered --repository-key per selected repository without a hosted remote.');
  }
  keys.forEach((key, index) => assignments.set(index, key));
  return assignments;
}

async function repositoriesConnect(
  flags: Map<string, string | boolean>,
  positional: string[],
  repeatedRepos: Array<string | boolean>,
  repeatedKeys: Array<string | boolean>,
  repeatedProviders: Array<string | boolean>,
): Promise<Output> {
  const selected = [...positional, ...repeatedRepos.filter((value): value is string => typeof value === 'string')];
  if (selected.length === 0) selected.push(String(flags.get('repo') || '.'));
  const canonical = await Promise.all(selected.map((path) => realpath(path)));
  const unique = [...new Set(canonical)];
  const keys = repositoryKeyAssignments(unique, repeatedKeys.length ? repeatedKeys : (
    typeof flags.get('repository-key') === 'string' ? [String(flags.get('repository-key'))] : []
  ));
  const providerIds = parseSelectedProviderIds(repeatedProviders.length ? repeatedProviders : (
    typeof flags.get('provider') === 'string' ? [String(flags.get('provider'))] : []
  ));
  const results: Output[] = [];
  for (let index = 0; index < unique.length; index += 1) {
    const connectFlags = new Map(flags);
    connectFlags.set('workspace', unique[index]!);
    const repositoryKey = keys.get(index);
    if (repositoryKey) connectFlags.set('repository-key', repositoryKey);
    else connectFlags.delete('repository-key');
    if (providerIds) connectFlags.set('providers', providerIds.join(','));
    const result = await onboard(connectFlags);
    results.push(result);
    if ((result as Record<string, unknown>)?.stage === 'approve_device') break;
  }
  return { ok: true, requested: unique.length, connected: results.length, repositories: results };
}

export function parseSelectedProviderIds(values: Array<string | boolean>): ProviderId[] | null {
  const selected = [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean))];
  if (selected.length === 0) return null;
  if (selected.some((value) => !isLocalProviderId(value))) {
    throw new Error('Repository providers must be codex, claude, agy, or hermes. Repeat --provider to select more than one.');
  }
  return selected as ProviderId[];
}

export function actionDecisionCapabilityFreshUntil(
  keyset: TrustedServerSigningKeyset,
  trustedKeyVersions: string[],
  now = new Date(),
): string {
  const trustedExpiries = keyset.keys
    .filter((key) => trustedKeyVersions.includes(key.keyVersion))
    .map((key) => Date.parse(key.notAfter));
  const earliestExpiry = Math.min(Date.parse(keyset.expiresAt), ...trustedExpiries);
  if (!Number.isFinite(earliestExpiry) || earliestExpiry <= now.getTime()) {
    throw new Error('trusted_server_signing_keys_invalid_or_expired');
  }
  return new Date(Math.min(now.getTime() + 5 * 60_000, earliestExpiry)).toISOString();
}

function selectedProviderAdapters(providerIds: ProviderId[] | null) {
  return providerIds
    ? providerAdapters.filter((adapter) => providerIds.includes(adapter.providerId))
    : providerAdapters;
}

export async function receiptAwareProviderCapabilities(
  providers: ProviderCapability[],
  now = new Date(),
): Promise<ProviderCapability[]> {
  const selfTestedAt = now.toISOString();
  let freshUntil = now.toISOString();
  let receiverState: 'available' | 'unavailable' = 'unavailable';
  let reason = 'device_not_enrolled';
  let trustedKeyVersions: string[] = [];
  try {
    const config = await recoverDeviceEnrollmentConsistency({ configPath: configPath(), now });
    await loadDeviceEnrollmentAnchor({ config });
    const keyset = config.serverSigningKeyset;
    if (!keyset) throw new Error('trusted_server_signing_keyset_unavailable');
    if (!validateTrustedServerSigningKeysetContract(keyset).ok
      || Date.parse(keyset.expiresAt) <= now.getTime()) {
      throw new Error('trusted_server_signing_keyset_invalid_or_expired');
    }
    const resolver = createActionDecisionPublicKeyResolver(keyset, now);
    trustedKeyVersions = keyset.keys
      .filter((key) => resolver(key.keyVersion) !== null)
      .map((key) => key.keyVersion);
    if (trustedKeyVersions.length === 0) throw new Error('trusted_server_signing_keys_unavailable');
    freshUntil = actionDecisionCapabilityFreshUntil(keyset, trustedKeyVersions, now);
    await new FileActionExecutionJournal(resolve(dharmaHome(), 'relay', 'action-execution-journal')).selfTest();
    receiverState = 'available';
    reason = '';
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  return providers.map((provider) => {
    const available = provider.taskExecution === 'available' && receiverState === 'available';
    return {
      ...provider,
      actionDecisionReceipts: available ? 'available' as const : 'unavailable' as const,
      actionDecisionReceiver: {
        protocol: 'action_decision_receipts_v1' as const,
        protocolVersion: 1 as const,
        journalSchema: 'dharma.action-execution-journal/v1' as const,
        state: available ? 'available' as const : 'unavailable' as const,
        selfTestedAt, freshUntil,
        trustedKeyVersions: available ? trustedKeyVersions : [],
        ...(!available ? { reason: provider.taskExecution !== 'available' ? 'provider_task_execution_unavailable' : reason } : {}),
      },
    };
  });
}

async function repositoriesList(flags: Map<string, string | boolean>): Promise<Output> {
  const verbose = flags.has('verbose') || flags.has('diagnostic');
  return {
    ok: true,
    repositories: (await registry()).map((item) => ({
      workspaceId: item.workspaceId,
      name: item.name,
      repositoryAgentId: item.repositoryAgentId || null,
      repositoryAgentKey: item.repositoryAgentKey || null,
      controlBranch: item.controlBranch || null,
      connected: Boolean(item.repositoryAgentId && item.controlBranch),
      ...(verbose ? { localPath: item.path, sourceFingerprint: item.repositoryRemoteHash } : {}),
    })),
  };
}

async function bindRepositoryAgent(fabric: AgentFabricClient, item: WorkspaceRecord): Promise<WorkspaceRecord> {
  if (item.repositoryAgentId && item.repositoryBindingId && item.repositoryAgentKey && item.controlBranch) return item;
  const remote = await gitValue(item.path, ['config', '--get', 'remote.origin.url']);
  const currentIdentity = item.repositoryIdentityVersion === 'normalized-v1'
    ? item.repositoryRemoteHash
    : remote ? sourceRepositoryFingerprint(remote).fingerprint : item.repositoryRemoteHash;
  if (!currentIdentity) {
    throw new Error('Repository identity is missing. Re-run dharma workspace add with --repository-key.');
  }
  const response = await fabric.connectRepositoryAgent({
    sourceFingerprint: currentIdentity,
    displayName: item.name,
    defaultSourceRef: item.defaultBranch,
    workspaceId: item.workspaceId,
    legacySourceFingerprint: item.repositoryIdentityVersion === 'normalized-v1' ? null : item.repositoryRemoteHash,
  });
  const repositoryAgent = response.repositoryAgent && typeof response.repositoryAgent === 'object'
    ? response.repositoryAgent as Record<string, unknown>
    : null;
  const branch = repositoryAgent?.branch && typeof repositoryAgent.branch === 'object'
    ? repositoryAgent.branch as Record<string, unknown>
    : null;
  const updated: WorkspaceRecord = {
    ...item,
    repositoryRemoteHash: currentIdentity,
    repositoryIdentityVersion: 'normalized-v1',
    repositoryAgentId: String(repositoryAgent?.organization_agent_id || ''),
    repositoryBindingId: String(repositoryAgent?.id || ''),
    repositoryAgentKey: String(repositoryAgent?.agent_key || ''),
    controlBranch: String(repositoryAgent?.control_branch || branch?.branch || ''),
  };
  if (!/^[0-9a-f-]{36}$/i.test(updated.repositoryAgentId || '')
    || !/^[0-9a-f-]{36}$/i.test(updated.repositoryBindingId || '')
    || !/^repo:[a-f0-9]{24}$/.test(updated.repositoryAgentKey || '')
    || !/^agents\/[a-z0-9][a-z0-9._-]*-[a-f0-9]{8}$/.test(updated.controlBranch || '')) {
    throw new Error('Dharma HQ returned an invalid repository-agent binding.');
  }
  await saveWorkspaceRecord(updated);
  return updated;
}

async function workspaceSync(flags: Map<string, string | boolean>, positional: string[]): Promise<Output> {
  const workspaceId = positional[0] || required(flags, 'workspace-id');
  const policyRevision = required(flags, 'policy-revision');
  const item = (await registry()).find((candidate) => candidate.workspaceId === workspaceId);
  if (!item) throw new Error('Workspace is not registered locally.');
  if (!flags.has('apply')) {
    return {
      ok: true, workspaceId, planned: true, serverMutation: false, localMutation: false,
      next: `dharma workspace sync ${workspaceId} --policy-revision ${policyRevision} --apply`,
    };
  }
  const fabric = await client();
  const providerIds = parseSelectedProviderIds(typeof flags.get('provider') === 'string' ? [String(flags.get('provider'))] : []);
  return syncWorkspacePolicy(fabric, await bindRepositoryAgent(fabric, item), policyRevision, true, providerIds);
}

async function syncWorkspacePolicy(
  fabric: AgentFabricClient,
  item: WorkspaceRecord,
  policyRevision: string,
  apply = true,
  providerIds: ProviderId[] | null = null,
) {
  const providers = await receiptAwareProviderCapabilities(
    await Promise.all(selectedProviderAdapters(providerIds).map((adapter) => adapter.capability())),
  );
  const response = await fabric.registerWorkspace({
    workspaceId: item.workspaceId, name: item.name, routeHash: item.routeHash,
    repositoryRemoteHash: item.repositoryRemoteHash, defaultBranch: item.defaultBranch,
    repositoryAgentId: item.repositoryAgentId,
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

async function activeSkillAuthorization(
  provider: ProviderId,
  workspaceId: string,
  organizationAgentId: string,
  config: DeviceConfig,
) {
  const root = nativeSkillDirectory(provider);
  const pointer = resolve(root, '.dharma-managed', 'workspaces', workspaceId, 'ACTIVE_BUNDLE');
  if (!await pathExistsOrThrow(pointer)) return null;
  if (!organizationAgentId) throw new Error('Workspace is not bound to a repository agent. Run dharma workspace sync.');
  const [identity, enrollment, active] = await Promise.all([
    loadOrCreateDeviceIdentity({ hqUrl: config.hqUrl, organizationId: config.organizationId }),
    loadDeviceEnrollmentAnchor({ config }),
    loadActiveSkillAuthorizationAnchor({ config, workspaceId, organizationAgentId, provider }),
  ]);
  if (!active) throw new Error('Active skill state is not anchored in secure storage. Run dharma skill sync again.');
  if (identity.publicKeyEd25519 !== enrollment.devicePublicKeyEd25519) {
    throw new Error('Active skill device identity does not match secure enrollment state.');
  }
  return getActiveSkillBundleAuthorization({
    nativeSkillDirectory: root,
    workspaceId,
    provider,
    organizationId: config.organizationId,
    organizationAgentId,
    deviceId: config.deviceId,
    serverPublicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: enrollment.serverPublicKeyEd25519 },
      format: 'jwk',
    }),
    devicePublicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKeyEd25519 },
      format: 'jwk',
    }),
    expectedReceiptHash: active.receiptHash,
  });
}

async function expiredSkillAuthorizationForReplacement(
  provider: ProviderId,
  workspaceId: string,
  organizationAgentId: string,
  config: DeviceConfig,
) {
  const root = nativeSkillDirectory(provider);
  if (!organizationAgentId) throw new Error('Workspace is not bound to a repository agent. Run dharma workspace sync.');
  const [identity, enrollment, active] = await Promise.all([
    loadOrCreateDeviceIdentity({ hqUrl: config.hqUrl, organizationId: config.organizationId }),
    loadDeviceEnrollmentAnchor({ config }),
    loadActiveSkillAuthorizationAnchor({ config, workspaceId, organizationAgentId, provider }),
  ]);
  if (!active) throw new Error('Active skill state is not anchored in secure storage. Run dharma skill sync again.');
  if (identity.publicKeyEd25519 !== enrollment.devicePublicKeyEd25519) {
    throw new Error('Active skill device identity does not match secure enrollment state.');
  }
  return getExpiredSkillBundleAuthorizationForReplacement({
    nativeSkillDirectory: root,
    workspaceId,
    provider,
    organizationId: config.organizationId,
    organizationAgentId,
    deviceId: config.deviceId,
    serverPublicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: enrollment.serverPublicKeyEd25519 },
      format: 'jwk',
    }),
    devicePublicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: identity.publicKeyEd25519 },
      format: 'jwk',
    }),
    expectedReceiptHash: active.receiptHash,
  });
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
  repositoryAgentId?: string | null;
  repositoryAgentKey?: string | null;
  controlBranch?: string | null;
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
4. Preview the exact automatic disclosure with \`dharma evidence preview --workspace . --provider codex --policy .dharma/approved-policy.json --maximum-sessions 20\` for Codex, replacing only the literal provider value with \`claude\`, \`agy\`, or \`hermes\` when that is the current agent. Confirm the policy mode and consent receipt before syncing.
5. Run local deterministic self-analysis during capture. Deliver event counts, timing, coverage, failure signals, tool-discipline results, reason codes, and content availability metadata. Do not invent a semantic judgment from metadata. Sessions flagged \`semanticReviewRecommended\` require a policy-authorized evidence request or customer-authorized content mode before server judging.
6. Use only signed tasks whose organization, device, workspace, authority, budget, and skill pin pass local validation.
7. For cross-agent help, ask the control plane for a structured, task-bound handoff. Do not open arbitrary chat, shell, file, merge, deploy, or secret authority.
8. Install only signed skill bundles. Preserve the active bundle receipt and automatic rollback result.
9. Use the organization MCP connection for role-scoped status, experiments, failures, remediations, rollouts, and profile administration. Reads may run directly. Paid evals, task dispatch, GitHub writes, approvals, rollout, rollback, and profile mutation require the granted scope and explicit confirmation.

The organization contract and API origin are recorded in \`.dharma/agent-fabric.json\`; the logical repository-agent identity is recorded in \`.dharma/repository-agent.json\`. API calls must use the published SDK and a scoped organization token supplied at runtime, never a credential committed to this repository.
`;
  const reference = `# Organization connection

- HQ API: ${input.hqUrl}
- Organization: ${input.organizationId}
- Workspace: ${input.workspaceId}
- Repository agent: ${input.repositoryAgentKey || 'pending'}
- Permanent control branch: ${input.controlBranch || 'pending'}
- Policy revision: ${input.policyRevision}
- OpenAPI: ${input.hqUrl}/api/v1/agent-fabric/openapi.json
- Organization instructions: ${input.hqUrl}/api/v1/orgs/${input.organizationId}/agent-fabric/instructions

The CLI enrolls this device through browser-confirmed Clerk organization consent. Local provider credentials remain on this device. Managed and cloud BYOK execution are brokered by Dharma HQ and expose neither private runtime URLs nor cloud credentials.
`;
  const connection = {
    schema: 'dharma.repository-connection/v2',
    hqUrl: input.hqUrl,
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    repositoryAgentId: input.repositoryAgentId || null,
    repositoryAgentKey: input.repositoryAgentKey || null,
    controlBranch: input.controlBranch || null,
    policyRevision: input.policyRevision,
    openapiUrl: `${input.hqUrl}/api/v1/agent-fabric/openapi.json`,
    instructionsUrl: `${input.hqUrl}/api/v1/orgs/${input.organizationId}/agent-fabric/instructions`,
  };
  const repositoryAgent = {
    schema: 'dharma.repository-agent/v1',
    organizationId: input.organizationId,
    organizationAgentId: input.repositoryAgentId || null,
    agentKey: input.repositoryAgentKey || null,
    controlBranch: input.controlBranch || null,
    workspaceId: input.workspaceId,
  };
  await writeFile(resolve(skillRoot, 'SKILL.md'), skill, { mode: 0o600 });
  await writeFile(resolve(skillRoot, 'references', 'organization.md'), reference, { mode: 0o600 });
  await writeFile(marker, `${JSON.stringify({ managedBy: 'dharma-agent-fabric', workspaceId: input.workspaceId }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(resolve(input.workspace, '.dharma', 'agent-fabric.json'), `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  await writeFile(resolve(input.workspace, '.dharma', 'repository-agent.json'), `${JSON.stringify(repositoryAgent, null, 2)}\n`, { mode: 0o600 });
  return {
    skillPath: '.agents/skills/dharma-agent-fabric/SKILL.md',
    connectionPath: '.dharma/agent-fabric.json',
    repositoryAgentPath: '.dharma/repository-agent.json',
  };
}

async function onboard(flags: Map<string, string | boolean>): Promise<Output> {
  const workspace = await realpath(String(flags.get('workspace') || flags.get('path') || '.'));
  const organizationId = required(flags, 'organization-id');
  const policyRevision = required(flags, 'policy-revision');
  const requestedHqUrl = normalizeHqUrl(portalUrl(flags));
  let config = await readDeviceConfig();
  if (!config) {
    const loginFlags = new Map(flags);
    loginFlags.set('hq-url', requestedHqUrl);
    loginFlags.set('organization-id', organizationId);
    if (flags.has('non-interactive')) {
      loginFlags.set('no-browser', true);
      loginFlags.set('no-wait', true);
    }
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
  if ((flags.has('portal-url') || flags.has('hq-url')) && config.hqUrl !== requestedHqUrl) {
    throw new Error('This device is enrolled to a different Dharma portal origin. Use a separate DHARMA_HOME for each portal origin.');
  }
  const hqUrl = config.hqUrl;
  const providerIds = parseSelectedProviderIds(typeof flags.get('providers') === 'string'
    ? [String(flags.get('providers'))]
    : typeof flags.get('provider') === 'string' ? [String(flags.get('provider'))] : []);
  let registered = (await registry()).find((item) => item.path === workspace);
  if (!registered || (!registered.repositoryRemoteHash && typeof flags.get('repository-key') === 'string')) {
    const addFlags = new Map<string, string | boolean>([
      ['organization-id', organizationId],
      ['path', workspace],
      ['name', String(flags.get('name') || basename(workspace))],
    ]);
    if (typeof flags.get('repository-key') === 'string') addFlags.set('repository-key', String(flags.get('repository-key')));
    await workspaceAdd(addFlags, [workspace]);
    registered = (await registry()).find((item) => item.path === workspace);
  }
  if (!registered) throw new Error('Workspace registration failed.');
  const fabric = await client();
  registered = await bindRepositoryAgent(fabric, registered);
  const synced = await syncWorkspacePolicy(fabric, registered, policyRevision, true, providerIds) as Record<string, unknown>;
  const localPolicy = synced.localPolicy as Record<string, unknown> | undefined;
  const authoritativeRevision = String(localPolicy?.revision || policyRevision);
  const generatedPolicy = await loadVerifiedWorkspacePolicy(resolve(workspace, '.dharma', 'approved-policy.json'), registered.workspaceId);
  const installed = await installRepositoryAgentFabricSkill({
    workspace,
    hqUrl,
    organizationId,
    workspaceId: registered.workspaceId,
    repositoryAgentId: registered.repositoryAgentId,
    repositoryAgentKey: registered.repositoryAgentKey,
    controlBranch: registered.controlBranch,
    policyRevision: authoritativeRevision,
  });
  const providers = await receiptAwareProviderCapabilities(
    await Promise.all(selectedProviderAdapters(providerIds).map((adapter) => adapter.capability())),
  );
  const nativeSkillResult = await installAvailableNativeAgentFabricBootstraps({
    providers,
    workspace,
    workspaceId: registered.workspaceId,
    organizationId,
    hqUrl,
  });
  const primaryProvider = providers[0]?.provider || 'codex';
  return {
    ok: true,
    stage: nativeSkillResult.failures.length ? 'ready_with_provider_actions' : 'ready',
    organizationId,
    workspaceId: registered.workspaceId,
    repositoryAgent: {
      id: registered.repositoryAgentId,
      key: registered.repositoryAgentKey,
      bindingId: registered.repositoryBindingId,
      controlBranch: registered.controlBranch,
    },
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
    nativeSkills: nativeSkillResult.installed,
    nativeSkillFailures: nativeSkillResult.failures,
    workspaceSync: synced,
    next: {
      preview: `dharma evidence preview --workspace . --provider ${primaryProvider}`,
      sync: `dharma evidence capture-batch --workspace . --provider ${primaryProvider} --policy .dharma/approved-policy.json --maximum-sessions 20 --sync`,
      relay: 'dharma relay start --policy .dharma/approved-policy.json',
      verifySkill: `dharma skills verify --provider ${primaryProvider} --workspace .`,
    },
  };
}

async function evidenceSync(flags: Map<string, string | boolean>): Promise<Output> {
  const capsule = JSON.parse(await readFile(resolve(required(flags, 'file')), 'utf8')) as Record<string, unknown>;
  const workspaceId = typeof flags.get('workspace-id') === 'string' ? String(flags.get('workspace-id')) : String(capsule.workspaceId || '');
  const validation = await validateContract(resolve(import.meta.dirname, 'schemas'), trajectoryCapsuleSchemaId(capsule), capsule);
  if (!validation.ok) throw new Error(`Trajectory capsule failed schema validation: ${JSON.stringify(validation.errors)}`);
  assertCapsuleIntegrity(capsule);
  const trajectoryId = String(capsule.trajectoryId || '');
  const revision = Number(capsule.revision);
  const { LocalVault, loadOrCreateVaultMasterKey } = await loadVaultModule();
  const vault = await LocalVault.open({
    root: resolve(dharmaHome(), 'vault'),
    masterKey: await loadOrCreateVaultMasterKey(),
  });
  try {
    const storedCapsule = await vault.getCapsule<Record<string, unknown>>(trajectoryId, revision);
    if (canonicalize(storedCapsule) !== canonicalize(capsule)) {
      throw new Error('Trajectory capsule file does not exactly match the encrypted local-vault revision.');
    }
    const fabric = await client();
    const policy = await refreshVerifiedWorkspacePolicyForTransmission(required(flags, 'policy'), workspaceId, fabric);
    assertCapsuleAuthorizedByCurrentPolicy(storedCapsule, policy);
    await reserveDailyContentUpload(storedCapsule, policy);
    return fabric.syncTrajectory(storedCapsule);
  } finally {
    vault.close();
  }
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
    await syncPendingRetentionCapsules(vault, fabric, policy, workspace.workspaceId);
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
  const workspaceId = required(flags, 'workspace-id');
  const fabric = await client();
  const policy = await refreshVerifiedWorkspacePolicyForTransmission(required(flags, 'policy'), workspaceId, fabric);
  return processEvidenceRequest(fabric, policy, workspaceId);
}

export function taskReceiptSession(task: TaskEnvelope, receipt: TaskReceipt, workspace: string): ProviderSession {
  const instructionRecord = {
    native: {
      taskId: task.taskId,
      type: 'user_message',
      role: 'user',
      content: providerInstructionsForTask(task),
    },
    sourcePath: 'dharma-task-receipt',
    line: 1,
    workspace,
    timestamp: receipt.startedAt,
    kind: 'user_message',
    coverage: 'observed' as const,
  };
  return {
    provider: task.target.provider,
    sessionId: `dharma-task-${task.taskId}`,
    sourcePath: 'dharma-task-receipt',
    workspace,
    coverage: 'observed',
    startedAt: receipt.startedAt,
    endedAt: receipt.completedAt,
    records: [instructionRecord, ...receipt.commandResults.flatMap((result, index) => {
      if (result.commandId.startsWith('provider.')) {
        return providerExecutionRecords({
          provider: task.target.provider,
          stdout: result.stdout,
          workspace,
          startedAt: receipt.startedAt,
          endedAt: receipt.completedAt,
        }).map((record, recordIndex) => ({
          ...record,
          line: (index + 2) * 1_000_000 + recordIndex,
          native: {
            ...record.native,
            taskId: task.taskId,
            commandId: result.commandId,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            stdoutSha256: result.stdoutSha256,
            stderrSha256: result.stderrSha256,
          },
        }));
      }
      return [{
        native: {
          taskId: task.taskId,
          commandId: result.commandId,
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutSha256: result.stdoutSha256,
          stderrSha256: result.stderrSha256,
        },
        sourcePath: 'dharma-task-receipt',
        line: index + 2,
        workspace,
        timestamp: receipt.completedAt,
        kind: 'validation',
        coverage: 'observed' as const,
      }];
    })],
  };
}

function prepareSignedTaskTrajectory(input: {
  policy: OrganizationPolicy;
  task: TaskEnvelope;
  receipt: TaskReceipt;
  taskReceiptHash: string;
  collectedAt: string;
  workspace: WorkspaceRecord;
  device: DeviceConfig;
  activeSkill: Awaited<ReturnType<typeof activeSkillAuthorization>>;
  activeSkillVerifiedAt: string;
}) {
  if (!input.activeSkill || input.task.skillBundle?.bundleId !== input.activeSkill.bundleId) {
    throw new Error('Signed task trajectory requires the active task-pinned skill bundle.');
  }
  const session = taskReceiptSession(input.task, input.receipt, input.workspace.path);
  const rawTurn = Buffer.from(`${session.records.map((record) => JSON.stringify(record.native)).join('\n')}\n`);
  const rawContentId = sha256(rawTurn);
  const capsule = buildTrajectoryCapsule({
    organizationId: input.device.organizationId,
    deviceId: input.device.deviceId,
    workspaceId: input.workspace.workspaceId,
    session,
    policy: input.policy,
    rawContentId,
    rawBytes: rawTurn.byteLength,
    rawKind: 'raw-provider-turn',
    taskId: input.task.taskId,
    captureProvenance: {
      sourceClass: 'signed_task_execution',
      collectedAt: input.collectedAt,
      taskReceiptHash: input.taskReceiptHash,
    },
    activeSkillBundleId: input.activeSkill.bundleId,
    activeSkillBundleActivatedAt: input.activeSkill.activatedAt,
    activeSkillBundleExpiresAt: input.activeSkill.expiresAt,
    activeSkillBundleVerifiedAt: input.activeSkillVerifiedAt,
  });
  return { capsule, rawTurn, rawContentId, session };
}

async function syncSignedTaskTrajectory(input: {
  fabric: AgentFabricClient;
  policy: OrganizationPolicy;
  workspace: WorkspaceRecord;
  prepared: ReturnType<typeof prepareSignedTaskTrajectory>;
}) {
  const { capsule, rawTurn, rawContentId, session } = input.prepared;
  const validation = await validateContract(
    resolve(import.meta.dirname, 'schemas'),
    trajectoryCapsuleSchemaId(capsule),
    capsule,
  );
  if (!validation.ok) throw new Error(`Signed task capsule failed schema validation: ${JSON.stringify(validation.errors)}`);
  assertCapsuleAuthorizedByCurrentPolicy(capsule as unknown as Record<string, unknown>, input.policy);
  const { LocalVault, loadOrCreateVaultMasterKey } = await loadVaultModule();
  const vault = await LocalVault.open({
    root: resolve(dharmaHome(), 'vault'),
    masterKey: await loadOrCreateVaultMasterKey(),
    rawLocalDays: rawLocalRetentionDays(input.policy),
  });
  try {
    const existing = vault.getCapsuleMetadata(capsule.trajectoryId, capsule.revision);
    if (!existing) {
      await vault.commitCapture({
        raw: { plaintext: rawTurn, kind: 'raw-provider-turn', expectedContentId: rawContentId },
        capsule: {
          plaintext: Buffer.from(JSON.stringify(capsule)), trajectoryId: capsule.trajectoryId,
          revision: capsule.revision, capsuleHash: capsule.capsuleHash,
        },
        session: {
          sessionId: session.sessionId, provider: session.provider, workspaceId: input.workspace.workspaceId,
          sourceLocator: session.sourcePath, status: session.coverage, observedAt: session.endedAt,
        },
      });
    } else if (existing.capsuleHash !== capsule.capsuleHash) {
      throw new Error('Signed task evidence already exists with different immutable content.');
    }
    vault.queueCapsuleSync(capsule.trajectoryId, capsule.revision);
    await reserveDailyContentUpload(capsule as unknown as Record<string, unknown>, input.policy);
    const synced = await input.fabric.syncTrajectory(capsule);
    vault.markCapsuleSynced(capsule.trajectoryId, capsule.revision);
    return synced;
  } finally {
    vault.close();
  }
}

type SignedTaskTrajectoryRecovery = {
  schema: 'dharma.signed-task-trajectory-recovery/v1';
  taskId: string;
  workspaceId: string;
  prepared: {
    capsule: TrajectoryCapsule;
    rawTurnBase64: string;
    rawContentId: string;
    session: ProviderSession;
  };
};

export function assertRecoveredTaskWorkspacePolicy(input: {
  recoveryWorkspaceId: string;
  workspace: { workspaceId: string; organizationId: string };
  policy: Pick<OrganizationPolicy, 'organizationId' | 'serverAuthorization'>;
}): void {
  if (input.workspace.workspaceId !== input.recoveryWorkspaceId) {
    throw new Error('Recovered task completion does not match its registered workspace.');
  }
  if (input.policy.organizationId !== input.workspace.organizationId
    || (input.policy.serverAuthorization
      && input.policy.serverAuthorization.workspaceId !== input.workspace.workspaceId)) {
    throw new Error('Recovered task completion policy does not authorize its workspace.');
  }
}

export function recoveredTaskPolicyWasSuperseded(
  capsule: Pick<TrajectoryCapsule, 'redactionReceipt'>,
  currentPolicy: Pick<OrganizationPolicy, 'revision'>,
): boolean {
  return capsule.redactionReceipt?.policyRevision !== currentPolicy.revision;
}

export function assertTaskWorkspacePolicy(input: {
  task: Pick<TaskEnvelope, 'organizationId' | 'workspaceId'>;
  workspace: { workspaceId: string; organizationId: string };
  policy: Pick<OrganizationPolicy, 'organizationId' | 'serverAuthorization'>;
}): void {
  if (input.task.workspaceId !== input.workspace.workspaceId
    || input.task.organizationId !== input.workspace.organizationId
    || input.policy.organizationId !== input.workspace.organizationId
    || (input.policy.serverAuthorization
      && input.policy.serverAuthorization.workspaceId !== input.workspace.workspaceId)) {
    throw new Error('Task workspace policy does not match the signed task and local registration.');
  }
}

export async function acknowledgeTaskActionDecision(input: {
  task: Pick<TaskEnvelope, 'taskId' | 'actionDecision'>;
  receipt: Pick<TaskReceipt, 'actionAcknowledgement'>;
  postEnforcement: (decisionId: string, acknowledgement: NonNullable<TaskReceipt['actionAcknowledgement']>) => Promise<unknown>;
}): Promise<boolean> {
  const acknowledgement = input.receipt.actionAcknowledgement;
  if (!acknowledgement) return false;
  const decisionId = input.task.actionDecision?.id;
  if (!decisionId) throw new Error('Task produced an action acknowledgement without an embedded decision.');
  if (acknowledgement.taskId !== input.task.taskId) {
    throw new Error('Task action acknowledgement does not match the executed task.');
  }
  await input.postEnforcement(decisionId, acknowledgement);
  return true;
}

export async function postTaskOutcome(input: {
  task: Pick<TaskEnvelope, 'taskId' | 'actionDecision'>;
  receipt: Pick<TaskReceipt, 'status' | 'actionAcknowledgement'>;
  payload: Record<string, unknown>;
  postEnforcement: (decisionId: string, acknowledgement: NonNullable<TaskReceipt['actionAcknowledgement']>) => Promise<unknown>;
  postEvent: (taskId: string, eventType: TaskReceipt['status'], payload: Record<string, unknown>) => Promise<unknown>;
}) {
  await acknowledgeTaskActionDecision(input);
  return input.postEvent(input.task.taskId, input.receipt.status, input.payload);
}

async function stageSignedTaskTrajectoryRecovery(
  taskId: string,
  workspaceId: string,
  policy: OrganizationPolicy,
  prepared: ReturnType<typeof prepareSignedTaskTrajectory>,
): Promise<void> {
  const { LocalVault, loadOrCreateVaultMasterKey } = await loadVaultModule();
  const vault = await LocalVault.open({
    root: resolve(dharmaHome(), 'vault'),
    masterKey: await loadOrCreateVaultMasterKey(),
    rawLocalDays: rawLocalRetentionDays(policy),
  });
  try {
    const recovery: SignedTaskTrajectoryRecovery = {
      schema: 'dharma.signed-task-trajectory-recovery/v1', taskId, workspaceId,
      prepared: {
        capsule: prepared.capsule,
        rawTurnBase64: prepared.rawTurn.toString('base64'),
        rawContentId: prepared.rawContentId,
        session: prepared.session,
      },
    };
    await vault.stageTaskCompletionRecovery(taskId, Buffer.from(JSON.stringify(recovery)));
  } finally {
    vault.close();
  }
}

async function finalizeRecoveredSignedTaskTrajectories(
  fabric: AgentFabricClient,
  vaultPolicy: OrganizationPolicy,
  onlyTaskId?: string,
): Promise<Array<{ taskId: string; trajectory: Record<string, unknown> }>> {
  const completions = fabric.listRecoveredTaskCompletions()
    .filter((item) => !onlyTaskId || item.taskId === onlyTaskId);
  const finalized: Array<{ taskId: string; trajectory: Record<string, unknown> }> = [];
  for (const completion of completions) {
    const { LocalVault, loadOrCreateVaultMasterKey } = await loadVaultModule();
    const vault = await LocalVault.open({
      root: resolve(dharmaHome(), 'vault'),
      masterKey: await loadOrCreateVaultMasterKey(),
      rawLocalDays: rawLocalRetentionDays(vaultPolicy),
    });
    let recovery: SignedTaskTrajectoryRecovery | null;
    try {
      recovery = await vault.getTaskCompletionRecovery<SignedTaskTrajectoryRecovery>(completion.taskId);
    } finally {
      vault.close();
    }
    if (!recovery || recovery.schema !== 'dharma.signed-task-trajectory-recovery/v1'
      || recovery.taskId !== completion.taskId) {
      throw new Error(`Recovered task completion ${completion.taskId} is missing its encrypted local evidence.`);
    }
    const workspace = (await registry()).find((item) => item.workspaceId === recovery.workspaceId);
    if (!workspace) throw new Error(`Recovered task completion ${completion.taskId} has no registered workspace.`);
    const recoveryPolicy = await refreshVerifiedWorkspacePolicyForTransmission(
      resolve(workspace.path, '.dharma', 'approved-policy.json'),
      recovery.workspaceId,
      fabric,
    );
    assertRecoveredTaskWorkspacePolicy({
      recoveryWorkspaceId: recovery.workspaceId,
      workspace,
      policy: recoveryPolicy,
    });
    const rawTurn = Buffer.from(recovery.prepared.rawTurnBase64, 'base64');
    if (recovery.prepared.capsule.taskId !== completion.taskId
      || recovery.prepared.capsule.workspaceId !== recovery.workspaceId
      || recovery.prepared.capsule.capsuleHash !== completion.trajectoryCapsuleHash
      || sha256(rawTurn) !== recovery.prepared.rawContentId) {
      throw new Error(`Recovered task completion ${completion.taskId} does not match its trajectory capsule.`);
    }
    const capsule = {
      ...recovery.prepared.capsule,
      captureProvenance: {
        ...recovery.prepared.capsule.captureProvenance,
        taskReceiptHash: completion.receiptHash,
      },
    };
    assertCapsuleIntegrity(capsule as unknown as Record<string, unknown>);
    if (recoveredTaskPolicyWasSuperseded(capsule, recoveryPolicy)) {
      const supersededVault = await LocalVault.open({
        root: resolve(dharmaHome(), 'vault'),
        masterKey: await loadOrCreateVaultMasterKey(),
        rawLocalDays: rawLocalRetentionDays(vaultPolicy),
      });
      try {
        const existing = supersededVault.getCapsuleMetadata(capsule.trajectoryId, capsule.revision);
        if (!existing) {
          await supersededVault.commitCapture({
            raw: { plaintext: rawTurn, kind: 'raw-provider-turn', expectedContentId: recovery.prepared.rawContentId },
            capsule: {
              plaintext: Buffer.from(JSON.stringify(capsule)), trajectoryId: capsule.trajectoryId,
              revision: capsule.revision, capsuleHash: capsule.capsuleHash,
            },
            session: {
              sessionId: recovery.prepared.session.sessionId,
              provider: recovery.prepared.session.provider,
              workspaceId: recovery.workspaceId,
              sourceLocator: recovery.prepared.session.sourcePath,
              status: recovery.prepared.session.coverage,
              observedAt: recovery.prepared.session.endedAt,
            },
          });
        } else if (existing.capsuleHash !== capsule.capsuleHash) {
          throw new Error('Recovered task evidence already exists with different immutable content.');
        }
        supersededVault.discardPendingCapsuleSync(capsule.trajectoryId, capsule.revision, 'policy_revision_superseded');
      } finally {
        supersededVault.close();
      }
      await fabric.acknowledgeRecoveredTaskCompletion(completion.taskId, completion.receiptHash);
      const acknowledgedVault = await LocalVault.open({
        root: resolve(dharmaHome(), 'vault'),
        masterKey: await loadOrCreateVaultMasterKey(),
        rawLocalDays: rawLocalRetentionDays(vaultPolicy),
      });
      try { await acknowledgedVault.clearTaskCompletionRecovery(completion.taskId); }
      finally { acknowledgedVault.close(); }
      finalized.push({
        taskId: completion.taskId,
        trajectory: {
          ok: false,
          status: 'withheld',
          reason: 'policy_revision_superseded',
          trajectoryId: capsule.trajectoryId,
          revision: capsule.revision,
        },
      });
      continue;
    }
    const trajectory = await syncSignedTaskTrajectory({
      fabric, policy: recoveryPolicy, workspace,
      prepared: {
        capsule,
        rawTurn,
        rawContentId: recovery.prepared.rawContentId,
        session: recovery.prepared.session,
      },
    });
    await fabric.acknowledgeRecoveredTaskCompletion(completion.taskId, completion.receiptHash);
    const cleanupVault = await LocalVault.open({
      root: resolve(dharmaHome(), 'vault'),
      masterKey: await loadOrCreateVaultMasterKey(),
      rawLocalDays: rawLocalRetentionDays(vaultPolicy),
    });
    try { await cleanupVault.clearTaskCompletionRecovery(completion.taskId); }
    finally { cleanupVault.close(); }
    finalized.push({ taskId: completion.taskId, trajectory });
  }
  return finalized;
}

async function executeOneTask(
  fabric: AgentFabricClient,
  leaseSeconds: number,
): Promise<Record<string, unknown>> {
  const polled = await fabric.pollTask(leaseSeconds);
  const taskRow = polled.task as { envelope?: TaskEnvelope } | null | undefined;
  if (!taskRow?.envelope) return { ok: true, task: null };
  const task = taskRow.envelope;
  const workspace = (await registry()).find((item) => item.workspaceId === task.workspaceId);
  if (!workspace) throw new Error('Task workspace is not registered on this device.');
  const taskPolicy = await refreshVerifiedWorkspacePolicyForTransmission(
    resolve(workspace.path, '.dharma', 'approved-policy.json'),
    workspace.workspaceId,
    fabric,
  );
  assertTaskWorkspacePolicy({ task, workspace, policy: taskPolicy });
  const config = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
  const waitingHeartbeats: Promise<unknown>[] = [];
  const waitingHeartbeat = setInterval(() => {
    waitingHeartbeats.push(fabric.postTaskEvent(task.taskId, 'lease_extended', {
      taskId: task.taskId,
      phase: 'waiting_for_skill_activation_lock',
    }).catch(() => undefined));
  }, Math.max(5_000, Math.floor(leaseSeconds * 500)));
  try {
  return await withWorkspaceSkillActivationLock(task.workspaceId, task.target.provider, async () => {
  if (task.target.deviceId !== config.deviceId) throw new Error('Task target does not match this enrolled device.');
  const serverPublicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519 }, format: 'jwk' });
  const serverPublicKeyResolver = config.serverSigningKeyset
    ? createActionDecisionPublicKeyResolver(config.serverSigningKeyset)
    : undefined;
  const activeSkill = await activeSkillAuthorization(
    task.target.provider, task.workspaceId, String(workspace.repositoryAgentId || ''), config,
  );
  const activeBundleId = activeSkill?.bundleId ?? null;
  try {
    assertTaskSkillPin(task.skillBundle, activeSkill);
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
      task, policy: taskPolicy, workspace: workspace.path, relayStateDirectory: resolve(dharmaHome(), 'relay'), serverPublicKey,
      ...(serverPublicKeyResolver ? { serverPublicKeyResolver } : {}),
      receiptStore: new FileTaskReceiptStore(resolve(dharmaHome(), 'relay', 'receipts')),
      ...(task.actionDecision ? {
        actionDecisions: {
          resolvePublicKey: config.serverSigningKeyset
            ? createActionDecisionPublicKeyResolver(config.serverSigningKeyset)
            : () => null,
        },
      } : {}),
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
  const collectedAt = receipt.completedAt;
  const prepared = receipt.status === 'completed' && task.skillBundle
    ? prepareSignedTaskTrajectory({
      policy: taskPolicy, task, receipt, taskReceiptHash: `sha256:${'0'.repeat(64)}`, collectedAt,
      workspace, device: config, activeSkill,
      // The receipt is durable and retry-idempotent. Its start time is after
      // the first successful local bundle verification, so it is also the
      // stable verification timestamp for a recovered trajectory.
      activeSkillVerifiedAt: receipt.startedAt,
    })
    : null;
  if (prepared) await stageSignedTaskTrajectoryRecovery(task.taskId, workspace.workspaceId, taskPolicy, prepared);
  await postTaskOutcome({
    task,
    receipt,
    payload: {
      ...summary,
      ...(prepared ? { trajectoryCapsuleHash: prepared.capsule.capsuleHash } : {}),
    },
    postEnforcement: (decisionId, acknowledgement) => fabric.postActionEnforcement(decisionId, acknowledgement),
    postEvent: (taskId, eventType, payload) => fabric.postTaskEvent(taskId, eventType, payload),
  });
  let trajectory = null;
  if (receipt.status === 'completed' && task.skillBundle) {
    const finalized = await finalizeRecoveredSignedTaskTrajectories(
      fabric,
      taskPolicy,
      task.taskId,
    );
    trajectory = finalized[0]?.trajectory || null;
    if (!trajectory) throw new Error('Task completion did not return a recoverable server receipt.');
  }
  return { ok: true, taskId: task.taskId, receipt: summary, trajectory };
  });
  } catch (error) {
    if (error instanceof Error && error.message === 'Timed out waiting for the workspace skill activation lock.') {
      await fabric.postTaskEvent(task.taskId, 'failed', {
        phase: 'coordination',
        code: 'skill_activation_lock_timeout',
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    clearInterval(waitingHeartbeat);
    await Promise.allSettled(waitingHeartbeats);
  }
}

async function runOneTask(flags: Map<string, string | boolean>): Promise<Output> {
  const policyPath = resolve(required(flags, 'policy'));
  const requestedWorkspaceId = typeof flags.get('workspace-id') === 'string' ? String(flags.get('workspace-id')) : undefined;
  const selectedWorkspace = (await registry()).find((item) => (
    resolve(item.path, '.dharma', 'approved-policy.json') === policyPath
    && (!requestedWorkspaceId || item.workspaceId === requestedWorkspaceId)
  ));
  if (!selectedWorkspace) throw new Error('Task policy must be the canonical policy of one registered workspace.');
  const policy = await loadVerifiedWorkspacePolicy(policyPath, selectedWorkspace.workspaceId);
  const fabric = await client();
  const recoveredTaskTrajectories = await finalizeRecoveredSignedTaskTrajectories(
    fabric,
    policy,
  );
  const result = await executeOneTask(fabric, Number(flags.get('lease-seconds') || 120));
  return recoveredTaskTrajectories.length ? { ...result, recoveredTaskTrajectories } : result;
}

export function nativeSkillDirectory(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  if (provider === 'codex') return resolve(env.CODEX_HOME || resolve(home, '.codex'), 'skills');
  if (provider === 'claude') return resolve(env.CLAUDE_CONFIG_DIR || resolve(home, '.claude'), 'skills');
  if (provider === 'hermes') return resolve(env.HERMES_HOME || resolve(home, '.hermes'), 'skills');
  return resolve(env.AGY_CONFIG_DIR || resolve(home, '.gemini', 'antigravity-cli'), 'plugins', 'dharma-agent-fabric', 'skills');
}

type HermesSkillExecutor = (
  executable: string,
  argv: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; cwd: string },
) => Promise<{ stdout?: string | Buffer }>;

export async function trustHermesProject(input: {
  workspace: string;
  env?: NodeJS.ProcessEnv;
  execute?: HermesSkillExecutor;
}) {
  const workspace = await realpath(input.workspace);
  const execute = input.execute || ((executable, argv, options) => execFileAsync(executable, argv, options));
  await execute('hermes', ['skills', 'trust', workspace], {
    timeout: 30_000,
    env: providerProcessEnvironment(input.env),
    cwd: workspace,
  });
  return { workspace, trusted: true };
}

export async function installNativeAgentFabricBootstrap(input: {
  provider: ProviderId;
  workspace: string;
  workspaceId: string;
  organizationId: string;
  hqUrl: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  executeHermes?: HermesSkillExecutor;
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
    schema: 'dharma.native-skill-bootstrap/v2',
    managedBy: 'dharma-agent-fabric',
    provider: input.provider,
    hqUrl: input.hqUrl,
    installedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  if (input.provider === 'agy') await activateAgyPlugin({ env: input.env, home: input.home });
  if (input.provider === 'hermes') {
    await trustHermesProject({
      workspace: input.workspace,
      env: input.env,
      execute: input.executeHermes,
    });
  }
  return {
    provider: input.provider,
    nativeSkillDirectory: root,
    skillPath: resolve(skillRoot, 'SKILL.md'),
    activation: input.provider === 'agy' ? 'manual_invocation_required' : 'next_session',
    verified: await pathExists(resolve(skillRoot, 'SKILL.md')) && await pathExists(marker),
  };
}

type NativeBootstrapCapability = { provider: string; skillInstall: string };
type NativeBootstrapInstaller = typeof installNativeAgentFabricBootstrap;

export async function installAvailableNativeAgentFabricBootstraps(input: {
  providers: NativeBootstrapCapability[];
  workspace: string;
  workspaceId: string;
  organizationId: string;
  hqUrl: string;
  install?: NativeBootstrapInstaller;
}) {
  const install = input.install || installNativeAgentFabricBootstrap;
  const installed: Awaited<ReturnType<NativeBootstrapInstaller>>[] = [];
  const failures: Array<{ provider: string; code: 'native_skill_install_failed'; message: string }> = [];
  for (const capability of input.providers) {
    if (capability.skillInstall === 'unavailable') continue;
    try {
      installed.push(await install({
        provider: capability.provider as ProviderId,
        workspace: input.workspace,
        workspaceId: input.workspaceId,
        organizationId: input.organizationId,
        hqUrl: input.hqUrl,
      }));
    } catch (error) {
      failures.push({
        provider: capability.provider,
        code: 'native_skill_install_failed',
        message: error instanceof Error ? error.message : 'Native skill installation failed.',
      });
    }
  }
  return { installed, failures };
}

export async function verifyAgentFabricSkillInstallation(input: {
  provider: ProviderId;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  listAgyPlugins?: (
    executable: string,
    argv: string[],
    options: { timeout: number; env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string | Buffer }>;
  listHermesSkills?: HermesSkillExecutor;
}) {
  const workspace = await realpath(input.workspace);
  const repositorySkillPath = resolve(workspace, '.agents', 'skills', 'dharma-agent-fabric', 'SKILL.md');
  const connectionPath = resolve(workspace, '.dharma', 'agent-fabric.json');
  const nativeRoot = nativeSkillDirectory(input.provider, input.env, input.home);
  const nativeSkillPath = resolve(nativeRoot, 'dharma-agent-fabric', 'SKILL.md');
  const nativeMarkerPath = resolve(nativeRoot, 'dharma-agent-fabric', '.dharma-agent-fabric-bootstrap.json');
  const repositoryInstalled = await pathExists(repositorySkillPath) && await pathExists(connectionPath);
  let nativeManaged = false;
  if (await pathExists(nativeSkillPath) && await pathExists(nativeMarkerPath)) {
    try {
      const marker = JSON.parse(await readFile(nativeMarkerPath, 'utf8')) as Record<string, unknown>;
      nativeManaged = marker.managedBy === 'dharma-agent-fabric'
        && marker.provider === input.provider
        && ['dharma.native-skill-bootstrap/v1', 'dharma.native-skill-bootstrap/v2'].includes(String(marker.schema));
    } catch {}
  }
  const nativeInstalled = nativeManaged;
  let nativeDiscovered = ['agy', 'hermes'].includes(input.provider) ? false : nativeInstalled;
  if (input.provider === 'agy' && nativeInstalled) {
    try {
      const listAgyPlugins = input.listAgyPlugins
        || ((executable: string, argv: string[], options: { timeout: number; env: NodeJS.ProcessEnv }) => (
          execFileAsync(executable, argv, options)
        ));
      const { stdout } = await listAgyPlugins('agy', ['plugin', 'list'], {
        timeout: 30_000,
        env: providerProcessEnvironment(input.env),
      });
      const list = JSON.parse(String(stdout)) as { imports?: unknown };
      nativeDiscovered = Array.isArray(list.imports) && list.imports.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const plugin = item as Record<string, unknown>;
        return plugin.name === 'dharma-agent-fabric'
          && Array.isArray(plugin.components)
          && plugin.components.includes('skills');
      });
    } catch {}
  }
  if (input.provider === 'hermes' && nativeInstalled) {
    try {
      const listHermesSkills = input.listHermesSkills
        || ((executable: string, argv: string[], options: { timeout: number; env: NodeJS.ProcessEnv; cwd: string }) => (
          execFileAsync(executable, argv, options)
        ));
      const { stdout } = await listHermesSkills('hermes', ['skills', 'list', '--source', 'local', '--enabled-only'], {
        timeout: 30_000,
        env: providerProcessEnvironment(input.env),
        cwd: workspace,
      });
      nativeDiscovered = /\bdharma-agent-fabric\b/.test(String(stdout || ''));
    } catch {}
  }
  const bootstrapReady = repositoryInstalled && nativeInstalled && nativeDiscovered;
  let workspaceId: string | undefined;
  let organizationAgentId: string | undefined;
  try {
    const connection = JSON.parse(await readFile(connectionPath, 'utf8')) as { workspaceId?: unknown };
    if (typeof connection.workspaceId === 'string') {
      workspaceId = connection.workspaceId;
      organizationAgentId = (await registry()).find((item) => item.workspaceId === workspaceId)?.repositoryAgentId || undefined;
    }
  } catch {}
  const config = await readDeviceConfig();
  const activeBundleId = workspaceId && organizationAgentId && config
    ? (await activeSkillAuthorization(input.provider, workspaceId, organizationAgentId, config))?.bundleId ?? null
    : null;
  let activationAttested = !['agy', 'hermes'].includes(input.provider) ? nativeInstalled : false;
  if (['agy', 'hermes'].includes(input.provider) && activeBundleId && workspaceId) {
    try {
      const receipt = JSON.parse(await readFile(resolve(
        nativeRoot,
        '.dharma-managed',
        'workspaces',
        workspaceId,
        'active',
        'INSTALL_RECEIPT.json',
      ), 'utf8')) as { checks?: unknown };
      activationAttested = Array.isArray(receipt.checks) && receipt.checks.some((item) => (
        item && typeof item === 'object'
        && (item as Record<string, unknown>).name === `provider:${input.provider}:activation`
        && (item as Record<string, unknown>).status === 'pass'
      ));
    } catch {}
  }
  const signedLifecycleReady = bootstrapReady && activationAttested && Boolean(activeBundleId);
  return {
    provider: input.provider,
    ready: bootstrapReady,
    verificationScope: 'generic_bootstrap',
    bootstrapReady,
    signedLifecycleReady,
    repositoryInstalled,
    nativeInstalled,
    nativeManaged,
    nativeDiscovered,
    activationAttested,
    repositorySkillPath,
    connectionPath,
    nativeSkillPath,
    workspaceId: workspaceId || null,
    activeBundleId,
    activation: input.provider === 'agy' ? (activationAttested ? 'attested' : 'manual_invocation_required') : 'next_session',
    nextAction: input.provider === 'agy' && bootstrapReady && !activationAttested
        ? 'The Agy bootstrap is installed and discoverable. A signed remediation bundle must include and pass the content-bound activation challenge before full lifecycle support is reported.'
      : input.provider === 'hermes' && bootstrapReady && !activationAttested
        ? 'The Hermes bootstrap is installed, the project is trusted, and the skill is discoverable. A signed remediation bundle must pass Hermes discovery before full lifecycle support is reported.'
      : bootstrapReady
        ? `Start a new ${input.provider} session from ${workspace} and invoke the dharma-agent-fabric skill.`
      : 'Run dharma onboard again from the repository root.',
  };
}

export async function attestHermesSkillBundleActivation(input: {
  bundle: SkillBundle;
  workspace: string;
  nativeSkillDirectory?: string;
  env?: NodeJS.ProcessEnv;
  execute?: HermesSkillExecutor;
}) {
  if (input.bundle.skills.length === 0) {
    return {
      name: 'provider:hermes:activation',
      status: 'unavailable' as const,
      details: 'The signed bundle contains no Hermes skill content to discover.',
    };
  }
  const workspace = await realpath(input.workspace);
  const execute = input.execute || ((executable, argv, options) => execFileAsync(executable, argv, options));
  await trustHermesProject({ workspace, env: input.env, execute });
  let stdout: string | Buffer | undefined;
  try {
    ({ stdout } = await execute('hermes', ['skills', 'list', '--source', 'local', '--enabled-only'], {
      timeout: 30_000,
      env: {
        ...providerProcessEnvironment(input.env),
        // Hermes renders a Rich table even when stdout is not a TTY. Give it
        // enough width to preserve signed skill IDs for exact attestation.
        COLUMNS: '1000',
      },
      cwd: workspace,
    }));
  } catch (error) {
    return {
      name: 'provider:hermes:activation',
      status: 'fail' as const,
      details: error instanceof Error ? `Hermes skill discovery failed: ${error.message}`.slice(0, 1_000) : 'Hermes skill discovery failed.',
    };
  }
  const listing = String(stdout || '');
  const nativeRoot = input.nativeSkillDirectory || nativeSkillDirectory('hermes', input.env);
  const discoveryNames = await Promise.all(input.bundle.skills.map(async (skill) => {
    try {
      const content = await readFile(resolve(nativeRoot, skill.skillId, 'SKILL.md'), 'utf8');
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
      const nameLine = frontmatter.match(/(?:^|\r?\n)name:\s*(?:"([^"]+)"|'([^']+)'|([^\r\n#]+))/);
      const declaredName = (nameLine?.[1] || nameLine?.[2] || nameLine?.[3] || '').trim();
      if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(declaredName)) {
        return { skillId: skill.skillId, names: [skill.skillId, declaredName] };
      }
    } catch {}
    return { skillId: skill.skillId, names: [skill.skillId] };
  }));
  const missing = discoveryNames
    .filter(({ names }) => !names.some((name) => listing.includes(name)))
    .map(({ skillId }) => skillId);
  if (missing.length) {
    return {
      name: 'provider:hermes:activation',
      status: 'fail' as const,
      details: `Hermes did not discover the installed signed skill${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
    };
  }
  return {
    name: 'provider:hermes:activation',
    status: 'pass' as const,
    details: `Hermes discovered ${input.bundle.skills.length} installed signed skill${input.bundle.skills.length === 1 ? '' : 's'} in the trusted workspace.`,
  };
}

type AgyPluginExecutor = (
  executable: string,
  argv: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv },
) => Promise<unknown>;

export async function activateAgyPlugin(input: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  execute?: AgyPluginExecutor;
} = {}) {
  await ensureAgyReadOnlyAttestationPermission({ env: input.env, home: input.home });
  const root = resolve(nativeSkillDirectory('agy', input.env, input.home), '..');
  const execute = input.execute || ((executable, argv, options) => execFileAsync(executable, argv, options));
  const options = { timeout: 30_000, env: providerProcessEnvironment(input.env) };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const manifest = resolve(root, 'plugin.json');
  try { await access(manifest); }
  catch { await writeFile(manifest, `${JSON.stringify({ name: 'dharma-agent-fabric' }, null, 2)}\n`, { mode: 0o600 }); }
  await execute('agy', ['plugin', 'validate', root], options);
  await execute('agy', ['plugin', 'install', root], options);
  await execute('agy', ['plugin', 'enable', 'dharma-agent-fabric'], options);
}

const AGY_ATTESTATION_PERMISSION = 'command(git status)';
const AGY_ACTIVATION_TOKEN = /^Dharma activation token: `(sha256:[a-f0-9]{64})`$/m;

export async function ensureAgyReadOnlyAttestationPermission(input: {
  env?: NodeJS.ProcessEnv;
  home?: string;
} = {}) {
  const configRoot = resolve(
    input.env?.AGY_CONFIG_DIR || resolve(input.home || homedir(), '.gemini', 'antigravity-cli'),
  );
  const settingsPath = resolve(configRoot, 'settings.json');
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  let settings: Record<string, unknown> = {};
  if (await pathExists(settingsPath)) {
    const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Agy settings must be a JSON object before Dharma can add its read-only preflight permission.');
    }
    settings = parsed as Record<string, unknown>;
  }
  const permissions = settings.permissions && typeof settings.permissions === 'object' && !Array.isArray(settings.permissions)
    ? settings.permissions as Record<string, unknown>
    : {};
  const current = permissions.allow;
  if (current !== undefined && (!Array.isArray(current) || current.some((item) => typeof item !== 'string'))) {
    throw new Error('Agy permissions.allow must be a string array.');
  }
  const allow = [...new Set([...(Array.isArray(current) ? current : []), AGY_ATTESTATION_PERMISSION])];
  if (Array.isArray(current) && current.length === allow.length) {
    return { changed: false, settingsPath, permission: AGY_ATTESTATION_PERMISSION };
  }
  const updated = { ...settings, permissions: { ...permissions, allow } };
  const temporary = resolve(configRoot, `.settings.${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, settingsPath);
  return { changed: true, settingsPath, permission: AGY_ATTESTATION_PERMISSION };
}

type AgyAttestationExecutor = (
  executable: string,
  argv: string[],
  options: { timeout: number; env: NodeJS.ProcessEnv; cwd: string },
) => Promise<{ stdout: string | Buffer }>;

function parseAgyStructuredResponse(stdout: string | Buffer): Record<string, unknown> | null {
  try {
    const outer = JSON.parse(String(stdout)) as Record<string, unknown>;
    if (outer.status !== 'SUCCESS' || typeof outer.response !== 'string') return null;
    const match = outer.response.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const value = JSON.parse(match[0]) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export async function attestAgySkillActivation(input: {
  skillId: string;
  skillPath: string;
  workspace: string;
  challenge?: string;
  env?: NodeJS.ProcessEnv;
  execute?: AgyAttestationExecutor;
}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.skillId)) {
    throw new Error('Agy activation skill identifier is invalid.');
  }
  const skill = await readFile(input.skillPath, 'utf8');
  const token = skill.match(AGY_ACTIVATION_TOKEN)?.[1];
  if (!token) {
    return {
      name: 'provider:agy:activation',
      status: 'unavailable' as const,
      details: `Signed skill ${input.skillId} does not contain a Dharma activation token.`,
    };
  }
  const challenge = input.challenge || randomUUID();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(challenge)) throw new Error('Agy activation challenge is invalid.');
  const schema = JSON.stringify({
    type: 'object',
    additionalProperties: false,
    required: ['challenge', 'activationToken'],
    properties: {
      challenge: { type: 'string' },
      activationToken: { type: 'string' },
    },
  });
  const prompt = `/${input.skillId}\nDharma activation attestation. Do not use tools or inspect files. Return only JSON with fields challenge and activationToken. Challenge: ${challenge}`;
  const execute = input.execute || ((executable, argv, options) => execFileAsync(executable, argv, options));
  let stdout: string | Buffer;
  try {
    ({ stdout } = await execute('agy', [
      '--new-project',
      '--print', prompt,
      '--output-format', 'json',
      '--json-schema', schema,
      '--model', input.env?.DHARMA_AGY_ATTEST_MODEL || 'gemini-3.7-flash-low',
      '--mode', 'plan',
      '--sandbox',
      '--print-timeout', '90s',
    ], {
      timeout: 120_000,
      env: providerProcessEnvironment(input.env),
      cwd: await realpath(input.workspace),
    }));
  } catch (error) {
    return {
      name: 'provider:agy:activation',
      status: 'fail' as const,
      details: error instanceof Error ? `Agy activation process failed: ${error.message}`.slice(0, 1_000) : 'Agy activation process failed.',
    };
  }
  const response = parseAgyStructuredResponse(stdout);
  if (!response || response.challenge !== challenge) {
    return {
      name: 'provider:agy:activation',
      status: 'fail' as const,
      details: 'Agy did not return the fresh activation challenge.',
    };
  }
  if (response.activationToken !== token) {
    return {
      name: 'provider:agy:activation',
      status: 'fail' as const,
      details: 'Agy returned an activation token that does not match the installed signed skill.',
    };
  }
  return {
    name: 'provider:agy:activation',
    status: 'pass' as const,
    details: `Agy expanded ${input.skillId} and returned a fresh content-bound challenge.`,
  };
}

export async function attestAgySkillBundleActivation(input: {
  bundle: SkillBundle;
  nativeSkillDirectory: string;
  workspace: string;
}) {
  if (input.bundle.skills.length === 0) {
    return {
      name: 'provider:agy:activation',
      status: 'unavailable' as const,
      details: 'The signed bundle contains no Agy skill content to attest.',
    };
  }
  await activateAgyPlugin();
  for (const skill of input.bundle.skills) {
    const check = await attestAgySkillActivation({
      skillId: skill.skillId,
      skillPath: resolve(input.nativeSkillDirectory, skill.skillId, 'SKILL.md'),
      workspace: input.workspace,
    });
    if (check.status !== 'pass') return check;
  }
  return {
    name: 'provider:agy:activation',
    status: 'pass' as const,
    details: `Agy expanded ${input.bundle.skills.length} signed skill${input.bundle.skills.length === 1 ? '' : 's'} with fresh content-bound challenges.`,
  };
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

export async function recoverLegacySkillBundleIdAfterAuthorizationFailure(input: {
  nativeSkillDirectory: string;
  workspaceId: string;
  authorizationError: unknown;
}): Promise<string> {
  const legacyBundleId = await getLegacySkillBundleIdForUpgrade({
    nativeSkillDirectory: input.nativeSkillDirectory,
    workspaceId: input.workspaceId,
  });
  if (!legacyBundleId) throw input.authorizationError;
  return legacyBundleId;
}

export async function installedBundleIdForSkillPollAfterAuthorizationFailure(input: {
  nativeSkillDirectory: string;
  workspaceId: string;
  authorizationError: unknown;
}): Promise<string> {
  return recoverLegacySkillBundleIdAfterAuthorizationFailure(input);
}

async function skillSync(flags: Map<string, string | boolean>): Promise<Output> {
  const workspaceId = required(flags, 'workspace-id');
  const providerValue = required(flags, 'provider');
  if (!isLocalProviderId(providerValue)) throw new Error('Skill provider must be codex, claude, agy, or hermes.');
  const provider = providerValue as ProviderId;
  return withWorkspaceSkillActivationLock(workspaceId, provider, async () => {
  const workspace = (await registry()).find((item) => item.workspaceId === workspaceId);
  if (!workspace) throw new Error('Skill workspace is not registered locally.');
  const policy = await loadOrganizationPolicy(required(flags, 'policy'));
  const destination = nativeSkillDirectory(provider);
  const fabric = await client();
  const config = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
  let activeBundleId: string | null;
  let legacyBaselineMigrationRequested = false;
  try {
    activeBundleId = (await activeSkillAuthorization(
      provider, workspaceId, String(workspace.repositoryAgentId || ''), config,
    ))?.bundleId ?? null;
  } catch (error) {
    if (error instanceof Error && error.message === 'Skill bundle has expired.') {
      activeBundleId = (await expiredSkillAuthorizationForReplacement(
        provider, workspaceId, String(workspace.repositoryAgentId || ''), config,
      ))?.bundleId ?? null;
    } else {
      activeBundleId = await installedBundleIdForSkillPollAfterAuthorizationFailure({
        nativeSkillDirectory: destination,
        workspaceId,
        authorizationError: error,
      });
      legacyBaselineMigrationRequested = true;
    }
  }
  const response = await fabric.pollSkill({
    workspaceId,
    provider,
    installedBundleId: activeBundleId,
    legacyBaselineMigrationRequested,
  });
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
    const previousAnchor = await loadActiveSkillAuthorizationAnchor({
      config,
      workspaceId,
      organizationAgentId: String(workspace.repositoryAgentId || ''),
      provider,
    });
    const identity = await loadOrCreateDeviceIdentity({ hqUrl: config.hqUrl, organizationId: config.organizationId });
    const receipt = await installSkillBundle({
      bundle,
      sourceDirectory: sourceRoot,
      nativeSkillDirectory: destination,
      policy,
      serverPublicKey: createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: config.serverPublicKeyEd25519 }, format: 'jwk' }),
      devicePrivateKey: createPrivateKey({ key: identity.privateJwk, format: 'jwk' }),
      deviceId: config.deviceId,
      organizationAgentId: String(workspace.repositoryAgentId || ''),
      workspaceId,
      provider,
      smokeCommandId: typeof flags.get('smoke-command') === 'string' ? String(flags.get('smoke-command')) : undefined,
      organizationApprovalId: typeof flags.get('approval-id') === 'string' ? String(flags.get('approval-id')) : undefined,
      ...(provider === 'agy' ? {
        providerActivationCheck: () => attestAgySkillBundleActivation({
          bundle,
          nativeSkillDirectory: destination,
          workspace: workspace.path,
        }),
      } : provider === 'hermes' ? {
        providerActivationCheck: () => attestHermesSkillBundleActivation({
          bundle,
          workspace: workspace.path,
          nativeSkillDirectory: destination,
        }),
      } : {}),
    });
    const restoreAnchor = async () => {
      if (previousAnchor) {
        await saveActiveSkillAuthorizationAnchor({
          config,
          workspaceId,
          organizationAgentId: previousAnchor.organizationAgentId,
          provider,
          bundleId: previousAnchor.bundleId,
          receiptHash: previousAnchor.receiptHash,
          activatedAt: previousAnchor.activatedAt,
          expiresAt: previousAnchor.expiresAt,
        });
      } else {
        await deleteActiveSkillAuthorizationAnchor({ config, workspaceId, provider });
      }
    };
    const recoverLocalInstallation = async (error: unknown): Promise<never> => {
      const recoveryErrors: unknown[] = [];
      try {
        await rollbackUnconfirmedSkillBundle({
          nativeSkillDirectory: destination,
          workspaceId,
          receipt,
        });
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError);
      }
      try {
        await restoreAnchor();
      } catch (anchorError) {
        recoveryErrors.push(anchorError);
      }
      if (recoveryErrors.length) {
        throw new AggregateError([error, ...recoveryErrors], 'Skill installation failed and local recovery was incomplete.');
      }
      throw error;
    };
    try {
      if (receipt.status === 'active') {
        await saveActiveSkillAuthorizationAnchor({
          config,
          workspaceId,
          organizationAgentId: String(workspace.repositoryAgentId || ''),
          provider,
          bundleId: receipt.bundleId,
          receiptHash: receipt.receiptHash,
          activatedAt: receipt.completedAt,
          expiresAt: bundle.expiresAt ?? null,
        });
      }
    } catch (error) {
      await recoverLocalInstallation(error);
    }
    try {
      await fabric.postInstallReceipt(bundle.bundleId, rollout.id, receipt);
    } catch (error) {
      if (isDefinitiveAgentFabricRejection(error)) await recoverLocalInstallation(error);
      throw error;
    }
    return { ok: true, rolloutId: rollout.id, bundleId: bundle.bundleId, status: receipt.status, changed: true };
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
  }
  });
}

async function relayStart(flags: Map<string, string | boolean>): Promise<Output> {
  const policyPath = resolve(required(flags, 'policy'));
  const canonicalWorkspace = (await registry()).find((item) => resolve(item.path, '.dharma', 'approved-policy.json') === policyPath);
  if (!canonicalWorkspace) throw new Error('Relay policy must be the canonical policy of one registered workspace.');
  let policy = await loadVerifiedWorkspacePolicy(policyPath, canonicalWorkspace.workspaceId);
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
  let taskTrajectoriesRecovered = 0;
  let evidenceResponsesCompleted = 0;
  let trajectorySyncsCompleted = 0;
  let nextPolicyRefreshAt = 0;
  let evidencePolicyFresh = false;
  const { LocalVault, loadOrCreateVaultMasterKey } = await loadVaultModule();
  const vault = await LocalVault.open({
    root: resolve(dharmaHome(), 'vault'),
    masterKey: await loadOrCreateVaultMasterKey(),
    rawLocalDays: rawLocalRetentionDays(policy),
  });
  try {
    taskTrajectoriesRecovered += (await finalizeRecoveredSignedTaskTrajectories(
      fabric,
      policy,
    )).length;
    do {
      if (Date.now() >= nextPolicyRefreshAt) {
        try {
          await syncWorkspacePolicy(fabric, canonicalWorkspace, policy.revision, true);
          policy = await loadVerifiedWorkspacePolicy(policyPath, canonicalWorkspace.workspaceId);
          evidencePolicyFresh = true;
        } catch {
          evidencePolicyFresh = false;
        }
        nextPolicyRefreshAt = Date.now() + 60_000;
      }
      let evidenceRequestId: string | undefined;
      if (evidencePolicyFresh) {
        trajectorySyncsCompleted += await syncPendingRetentionCapsules(
          vault,
          fabric,
          policy,
          canonicalWorkspace.workspaceId,
        );
        const evidence = await processEvidenceRequest(fabric, policy, canonicalWorkspace.workspaceId);
        evidenceRequestId = typeof evidence.requestId === 'string' ? evidence.requestId : undefined;
        if (evidenceRequestId) evidenceResponsesCompleted += 1;
      }
      const result = await executeOneTask(fabric, leaseSeconds);
      if (result.taskId) tasksCompleted += 1;
      if (flags.has('once')) break;
      if (!result.taskId && !evidenceRequestId) await new Promise((accept) => setTimeout(accept, pollMs));
    } while (!stopping);
  } finally {
    vault.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await rm(pidPath, { force: true });
  }
  return {
    ok: true, stopped: true, tasksCompleted, taskTrajectoriesRecovered,
    evidenceResponsesCompleted, trajectorySyncsCompleted,
  };
}

export async function run(argv: string[]): Promise<Output> {
  const { positional, flags, repeated } = parseCliOptions(argv);
  const [command, subcommand] = positional;
  if (flags.has('help') || command === 'help') return USAGE;
  if (flags.has('version') || command === 'version') return { version: VERSION };
  if (command === 'onboard') return onboard(flags);
  if (command === 'login') return login(flags);
  if (command === 'providers' && subcommand === 'list') return {
    providers: await receiptAwareProviderCapabilities(await Promise.all(providerAdapters.map((adapter) => adapter.capability()))),
  };
  if (command === 'repositories' && subcommand === 'discover') {
    return repositoriesDiscover(flags, positional.slice(2), repeated.get('root') || []);
  }
  if (command === 'repositories' && subcommand === 'connect') {
    return repositoriesConnect(
      flags,
      positional.slice(2),
      repeated.get('repo') || [],
      repeated.get('repository-key') || [],
      repeated.get('provider') || [],
    );
  }
  if (command === 'repositories' && subcommand === 'list') return repositoriesList(flags);
  if (command === 'repositories' && subcommand === 'status') {
    const listed = await repositoriesList(flags) as Record<string, unknown>;
    return {
      ...listed,
      relay: await relayProcessState(),
      providers: await receiptAwareProviderCapabilities(await Promise.all(providerAdapters.map((adapter) => adapter.capability()))),
    };
  }
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
  if (command === 'assistant') return runAssistantCommand(subcommand, flags);
  if ([
    'organization', 'agents', 'experiments', 'failures', 'remediations', 'handoffs', 'usage',
  ].includes(String(command)) || (
    ['tasks', 'skills'].includes(String(command))
    && ['list', 'dispatch', 'release', 'rollout', 'rollback'].includes(String(subcommand))
  )) {
    const result = await runOrganizationCommand(command, subcommand, flags);
    if (result) return result;
  }
  if (command === 'tasks' && subcommand === 'run-once') return runOneTask(flags);
  if (command === 'relay' && subcommand === 'start') return relayStart(flags);
  if (command === 'skills' && subcommand === 'sync') return skillSync(flags);
  if (command === 'skills' && subcommand === 'status') {
    const providerValue = required(flags, 'provider');
    if (!isLocalProviderId(providerValue)) throw new Error('Skill provider must be codex, claude, agy, or hermes.');
    const root = nativeSkillDirectory(providerValue as ProviderId);
    const workspaceId = required(flags, 'workspace-id');
    const config = JSON.parse(await readFile(configPath(), 'utf8')) as DeviceConfig;
    const workspace = (await registry()).find((item) => item.workspaceId === workspaceId);
    if (!workspace) throw new Error('Skill workspace is not registered locally.');
    return {
      provider: providerValue,
      workspaceId,
      activeBundleId: (await activeSkillAuthorization(
        providerValue as ProviderId, workspaceId, String(workspace.repositoryAgentId || ''), config,
      ))?.bundleId ?? null,
      nativeSkillDirectory: root,
    };
  }
  if (command === 'skills' && subcommand === 'verify') {
    const providerValue = required(flags, 'provider');
    if (!isLocalProviderId(providerValue)) throw new Error('Skill provider must be codex, claude, agy, or hermes.');
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
