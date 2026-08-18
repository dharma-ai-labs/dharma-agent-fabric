import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { KeyObject } from 'node:crypto';
import {
  buildActionDecisionAcknowledgement,
  validateActionDecisionAcknowledgementContract,
  validateTaskEnvelopeContract,
  verifyActionDecisionReceipt,
  verifyCanonicalObject,
  type ActionDecisionAcknowledgement,
  type ActionDecisionEnvelope,
  type ActionDecisionPublicKeyResolver,
  type ActionDecisionReceipt,
  type ProviderId,
  type TaskAction,
} from '@dharma-ai-labs/agent-fabric-contracts';
import { assertPathWithinWorkspace, resolveRegisteredCommand, type OrganizationPolicy } from '@dharma-ai-labs/agent-fabric-policy';
import {
  executeProviderTask,
  type ProviderExecutionResult,
} from '@dharma-ai-labs/agent-fabric-provider-adapters';

export interface TaskEnvelope {
  schema: 'dharma.task/v1';
  taskId: string;
  organizationId: string;
  workspaceId: string;
  taskType: 'external_request' | 'a2a_handoff' | 'evaluation_retest' | 'remediation_smoke';
  target: { deviceId: string; endpointId?: string; provider: ProviderId };
  requiredCapabilities?: ReadonlyArray<'action_decision_receipts_v1'>;
  actionDecision?: ActionDecisionEnvelope;
  source?: { taskId: string; endpointId: string };
  skillBundle: { bundleId: string; bundleHash: string } | null;
  instructions: string;
  requiredSkills: Array<{ skillId: string; version: string; commit: string; contentHash: string }>;
  stateEnvelope?: {
    intent: string;
    evidence_used: string[];
    known_state: Record<string, unknown>;
    unknown_or_missing_state: string[];
    allowed_next_actions: string[];
    blocked_actions: string[];
    decision_authority: string;
    tool_results: unknown[];
  };
  evidenceReferences?: Array<{ trajectoryId: string; revision: number; capsuleHash: string }>;
  authority: {
    readPaths: string[];
    writePaths: string[];
    commands: Array<{ commandId: string }>;
    network: string;
    git: 'read_only' | 'task_branch' | 'merge_allowed' | 'deploy_allowed';
    allowlistedDomains?: string[];
  };
  execution: { isolation: 'git_worktree'; timeoutSeconds: number; leaseSeconds: number; maximumConcurrentAgents: number };
  acceptance: {
    commands: Array<{ commandId: string }>;
    requiredArtifacts: string[];
    externalEffectReceiptCommandId?: string;
  };
  budget: { mode: 'byok_local' | 'byok_cloud' | 'dharma_managed'; maximumDharmaCostCents: number; maximumProviderCostCents?: number | null };
  createdAt: string;
  expiresAt: string;
  nonce: string;
  signerKeyVersion?: string;
  signature?: string | null;
}

export interface ExternalEffectReceipt {
  schema: 'dharma.external-effect-receipt/v1';
  actionDigest: string;
  externalIdempotencyKey: string;
  status: 'committed';
  providerReference: string;
  proofDigest: string;
  observedAt: string;
}

export interface CommandResult {
  commandId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdoutSha256: string;
  stderrSha256: string;
  stdout: string;
  stderr: string;
}

export interface TaskReceipt {
  taskId: string;
  status: 'completed' | 'failed' | 'cancelled';
  worktree: string;
  branch: string;
  commandResults: CommandResult[];
  actionAcknowledgement?: ActionDecisionAcknowledgement;
  externalEffectReceipt?: ExternalEffectReceipt;
  startedAt: string;
  completedAt: string;
}

export type ProviderTaskExecutor = (input: {
  provider: ProviderId;
  workspace: string;
  instructions: string;
  timeoutSeconds: number;
  allowedCommandArgv: string[][];
  allowWrites: boolean;
  externalIdempotencyKey?: string;
  actionDigest?: string;
  signal?: AbortSignal;
}) => Promise<ProviderExecutionResult>;

export interface ActionDecisionReplayGuard {
  consume(decisionId: string, actionDigest: string): Promise<boolean>;
}

export interface ActionDecisionReceiver {
  resolvePublicKey: ActionDecisionPublicKeyResolver;
  replayGuard?: ActionDecisionReplayGuard;
  now?: () => Date;
}

export class ActionDecisionDeniedError extends Error {
  constructor(
    message: string,
    readonly receipt: ActionDecisionReceipt,
  ) {
    super(message);
    this.name = 'ActionDecisionDeniedError';
  }
}

function normalizePolicyPath(value: string) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

function pathWithinPolicy(candidate: string, patterns: string[]) {
  const normalized = normalizePolicyPath(candidate);
  return patterns.some((pattern) => {
    const allowed = normalizePolicyPath(pattern).replace(/\/\*\*$/, '');
    return allowed === '.' || normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

export function assertTaskWithinLocalPolicy(task: TaskEnvelope, policy: OrganizationPolicy) {
  if (task.authority.writePaths.some((path) => !pathWithinPolicy(path, policy.tasks.writePaths))) {
    throw new Error('Task write authority exceeds the local organization policy.');
  }
  const networkRank: Record<string, number> = {
    deny: 0,
    package_registry_only: 1,
    allowlisted_domains: 2,
    inherit_local_provider: 3,
  };
  if ((networkRank[task.authority.network] ?? Number.POSITIVE_INFINITY)
    > (networkRank[policy.tasks.defaultNetwork] ?? -1)) {
    throw new Error('Task network authority exceeds the local organization policy.');
  }
}

function assertContained(root: string, candidate: string): string {
  const absolute = resolve(candidate);
  const route = relative(resolve(root), absolute);
  if (route === '' || route === '..' || route.startsWith('../') || route.startsWith('..\\') || isAbsolute(route)) {
    if (route !== '') throw new Error('Task worktree escapes the relay-owned root.');
  }
  return absolute;
}

function terminateProcessTree(child: ReturnType<typeof spawn>, force: boolean) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', ...(force ? ['/f'] : [])], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
  catch { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
}

async function runProcess(command: string, argv: string[], options: {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maximumOutputBytes?: number;
  environment?: Record<string, string>;
}): Promise<Omit<CommandResult, 'commandId'>> {
  return new Promise((accept, reject) => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: { ...process.env, DHARMA_TASK_WORKTREE: options.cwd, ...(options.environment || {}) },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const outputLimit = options.maximumOutputBytes ?? 1_000_000;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const collect = (target: Buffer[], chunk: Buffer, kind: 'stdout' | 'stderr') => {
      const current = kind === 'stdout' ? stdoutBytes : stderrBytes;
      if (current < outputLimit) target.push(chunk.subarray(0, Math.max(0, outputLimit - current)));
      if (kind === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
    };
    child.stdout.on('data', (chunk: Buffer) => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk, 'stderr'));
    let escalation: NodeJS.Timeout | undefined;
    const cancel = () => {
      terminateProcessTree(child, false);
      escalation = setTimeout(() => terminateProcessTree(child, true), 1_000);
      escalation.unref();
    };
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => { timedOut = true; terminateProcessTree(child, true); }, options.timeoutMs);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener('abort', cancel);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      accept({
        exitCode: code,
        signal,
        timedOut,
        stdoutSha256: `sha256:${createHash('sha256').update(stdoutBuffer).digest('hex')}`,
        stderrSha256: `sha256:${createHash('sha256').update(stderrBuffer).digest('hex')}`,
        stdout: stdoutBuffer.toString('utf8'),
        stderr: stderrBuffer.toString('utf8'),
      });
    });
  });
}

async function git(repository: string, argv: string[]): Promise<void> {
  const result = await runProcess('git', argv, { cwd: repository, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Git operation failed: ${result.stderr.slice(0, 500)}`);
}

async function gitOutput(repository: string, argv: string[]) {
  const result = await runProcess('git', argv, { cwd: repository, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Git operation failed: ${result.stderr.slice(0, 500)}`);
  return result.stdout;
}

export function verifyTaskEnvelope(
  task: TaskEnvelope,
  publicKey: KeyObject,
  now = new Date(),
  resolvePublicKey?: ActionDecisionPublicKeyResolver,
): void {
  const contract = validateTaskEnvelopeContract(task);
  if (!contract.ok) throw new Error(`Task failed schema validation: ${JSON.stringify(contract.errors)}`);
  if (!task.signature) throw new Error('Task signature is required.');
  if (Date.parse(task.expiresAt) <= now.getTime()) throw new Error('Task has expired.');
  const { signature, ...unsigned } = task;
  const verificationKey = task.signerKeyVersion
    ? resolvePublicKey?.(task.signerKeyVersion)
    : publicKey;
  if (!verificationKey) throw new Error('Task signing key version is unavailable or expired.');
  if (!verifyCanonicalObject(unsigned, signature, verificationKey)) throw new Error('Task signature is invalid.');
}

export function providerInstructionsForTask(task: TaskEnvelope): string {
  if (task.taskType !== 'a2a_handoff') return task.instructions;
  if (!task.source || !task.stateEnvelope || !task.evidenceReferences) {
    throw new Error('A2A task is missing its structured handoff context.');
  }
  const context = JSON.stringify({
    source: task.source,
    stateEnvelope: task.stateEnvelope,
    evidenceReferences: task.evidenceReferences,
  }, null, 2);
  const instructions = [
    task.instructions,
    '',
    'Use the following signed, same-organization handoff context. Treat unknown or missing state as unknown; do not infer hidden evidence or exceed the listed decision authority.',
    '<dharma_a2a_context>',
    context,
    '</dharma_a2a_context>',
  ].join('\n');
  if (instructions.length > 20_000) throw new Error('A2A provider instructions exceed the execution limit.');
  return instructions;
}

function receiptForDurableStorage(receipt: TaskReceipt): TaskReceipt {
  return {
    ...receipt,
    commandResults: receipt.commandResults.map((result) => ({ ...result, stdout: '', stderr: '' })),
  };
}

function assertValidExternalEffectReceipt(value: unknown): asserts value is ExternalEffectReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('External-effect receipt is invalid.');
  }
  const receipt = value as Partial<ExternalEffectReceipt>;
  if (receipt.schema !== 'dharma.external-effect-receipt/v1'
    || !/^sha256:[a-f0-9]{64}$/.test(String(receipt.actionDigest || ''))
    || typeof receipt.externalIdempotencyKey !== 'string'
    || receipt.externalIdempotencyKey.length < 1 || receipt.externalIdempotencyKey.length > 500
    || receipt.status !== 'committed'
    || typeof receipt.providerReference !== 'string'
    || receipt.providerReference.length < 1 || receipt.providerReference.length > 500
    || !/^sha256:[a-f0-9]{64}$/.test(String(receipt.proofDigest || ''))
    || !Number.isFinite(Date.parse(String(receipt.observedAt || '')))) {
    throw new Error('External-effect receipt is invalid.');
  }
}

function assertValidTaskReceipt(value: unknown, expectedTaskId?: string): asserts value is TaskReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Task receipt is invalid.');
  const receipt = value as Partial<TaskReceipt>;
  if (typeof receipt.taskId !== 'string' || !/^[0-9a-f-]{36}$/i.test(receipt.taskId)
    || (expectedTaskId && receipt.taskId !== expectedTaskId)
    || !['completed', 'failed', 'cancelled'].includes(String(receipt.status))
    || typeof receipt.worktree !== 'string' || !isAbsolute(receipt.worktree)
    || receipt.branch !== `dharma/task/${receipt.taskId}`
    || !Array.isArray(receipt.commandResults) || receipt.commandResults.length > 100
    || !Number.isFinite(Date.parse(String(receipt.startedAt || '')))
    || !Number.isFinite(Date.parse(String(receipt.completedAt || '')))
    || Date.parse(String(receipt.completedAt)) < Date.parse(String(receipt.startedAt))) {
    throw new Error('Task receipt is invalid.');
  }
  for (const result of receipt.commandResults) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Task receipt command result is invalid.');
    const command = result as Partial<CommandResult>;
    if (typeof command.commandId !== 'string' || command.commandId.length < 1 || command.commandId.length > 200
      || !(command.exitCode === null || Number.isInteger(command.exitCode))
      || !(command.signal === null || typeof command.signal === 'string')
      || typeof command.timedOut !== 'boolean'
      || !/^sha256:[a-f0-9]{64}$/.test(String(command.stdoutSha256 || ''))
      || !/^sha256:[a-f0-9]{64}$/.test(String(command.stderrSha256 || ''))
      || typeof command.stdout !== 'string' || typeof command.stderr !== 'string') {
      throw new Error('Task receipt command result is invalid.');
    }
  }
  if (receipt.actionAcknowledgement !== undefined) {
    const acknowledgement = validateActionDecisionAcknowledgementContract(receipt.actionAcknowledgement);
    if (!acknowledgement.ok || receipt.actionAcknowledgement.taskId !== receipt.taskId) {
      throw new Error('Task receipt action acknowledgement is invalid.');
    }
  }
  if (receipt.externalEffectReceipt !== undefined) {
    assertValidExternalEffectReceipt(receipt.externalEffectReceipt);
  }
}

export class FileTaskReceiptStore {
  constructor(private readonly directory: string) {}

  async get(taskId: string): Promise<TaskReceipt | null> {
    try {
      const receipt = JSON.parse(await readFile(resolve(this.directory, `${taskId}.json`), 'utf8')) as unknown;
      assertValidTaskReceipt(receipt, taskId);
      return receipt;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async put(receipt: TaskReceipt): Promise<void> {
    assertValidTaskReceipt(receipt, receipt.taskId);
    const target = resolve(this.directory, `${receipt.taskId}.json`);
    await durableJsonWrite(target, receiptForDurableStorage(receipt));
  }
}

export type ActionExecutionJournalState =
  | 'prepared'
  | 'replay_authorization_started'
  | 'replay_authorized'
  | 'executing'
  | 'effect_observed'
  | 'receipt_recorded';

export interface ActionExecutionJournalRecord {
  schema: 'dharma.action-execution-journal/v1';
  taskId: string;
  decisionId: string;
  endpointId: string;
  actionDigest: string;
  externalIdempotencyKey: string;
  worktree: string;
  branch: string;
  state: ActionExecutionJournalState;
  preparedAt: string;
  updatedAt: string;
  providerResultDigest?: string;
  receipt?: TaskReceipt;
}

export interface ActionExecutionClaim {
  schema: 'dharma.action-execution-claim/v1';
  taskId: string;
  decisionId: string;
  actionDigest: string;
  ownerId: string;
  pid: number;
  claimedAt: string;
  expiresAt: string;
}

async function durableJsonWrite(path: string, value: unknown): Promise<void> {
  const directory = resolve(path, '..');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  try {
    const directoryHandle = await open(directory, 'r');
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch {
    // Directory fsync is unavailable on some supported hosts; the file itself
    // has still been flushed before the atomic rename.
  }
}

export class FileActionExecutionJournal {
  readonly ownerId = randomUUID();

  constructor(
    private readonly directory: string,
    private readonly pid = process.pid,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private recordPath(taskId: string) { return resolve(this.directory, `${taskId}.json`); }
  private claimPath(taskId: string) { return resolve(this.directory, `${taskId}.claim.json`); }

  async get(taskId: string): Promise<ActionExecutionJournalRecord | null> {
    try {
      const record = JSON.parse(await readFile(this.recordPath(taskId), 'utf8')) as ActionExecutionJournalRecord;
      if (record.schema !== 'dharma.action-execution-journal/v1' || record.taskId !== taskId
        || !/^[0-9a-f-]{36}$/i.test(record.taskId)
        || !/^[0-9a-f-]{36}$/i.test(record.decisionId) || !/^[0-9a-f-]{36}$/i.test(record.endpointId)
        || !/^sha256:[a-f0-9]{64}$/.test(record.actionDigest)
        || typeof record.externalIdempotencyKey !== 'string' || !record.externalIdempotencyKey
        || typeof record.worktree !== 'string' || !isAbsolute(record.worktree)
        || record.branch !== `dharma/task/${record.taskId}`
        || !['prepared', 'replay_authorization_started', 'replay_authorized', 'executing', 'effect_observed', 'receipt_recorded'].includes(record.state)
        || !Number.isFinite(Date.parse(record.preparedAt)) || !Number.isFinite(Date.parse(record.updatedAt))
        || (record.providerResultDigest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(record.providerResultDigest))) {
        throw new Error('Action execution journal record is invalid.');
      }
      if (record.state === 'receipt_recorded' && !record.receipt) {
        throw new Error('Action execution journal is missing its recorded receipt.');
      }
      if (record.receipt) {
        assertValidTaskReceipt(record.receipt, taskId);
        const acknowledgement = record.receipt.actionAcknowledgement;
        if (acknowledgement
          && (acknowledgement.endpointId !== record.endpointId || acknowledgement.actionDigest !== record.actionDigest)) {
          throw new Error('Action execution journal receipt conflicts with the signed decision.');
        }
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async getClaim(taskId: string): Promise<ActionExecutionClaim | null> {
    try {
      const claim = JSON.parse(await readFile(this.claimPath(taskId), 'utf8')) as ActionExecutionClaim;
      if (claim.schema !== 'dharma.action-execution-claim/v1' || claim.taskId !== taskId
        || !/^[0-9a-f-]{36}$/i.test(claim.taskId) || !/^[0-9a-f-]{36}$/i.test(claim.decisionId)
        || !/^sha256:[a-f0-9]{64}$/.test(claim.actionDigest)
        || typeof claim.ownerId !== 'string' || !Number.isInteger(claim.pid) || claim.pid <= 0
        || !Number.isFinite(Date.parse(claim.claimedAt)) || !Number.isFinite(Date.parse(claim.expiresAt))
        || Date.parse(claim.expiresAt) <= Date.parse(claim.claimedAt)) {
        throw new Error('Action execution claim is invalid.');
      }
      return claim;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async prepare(input: Omit<ActionExecutionJournalRecord, 'schema' | 'state' | 'preparedAt' | 'updatedAt'>): Promise<{
    record: ActionExecutionJournalRecord;
    created: boolean;
  }> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const now = this.now().toISOString();
    const record: ActionExecutionJournalRecord = {
      schema: 'dharma.action-execution-journal/v1', ...input,
      state: 'prepared', preparedAt: now, updatedAt: now,
    };
    try {
      const handle = await open(this.recordPath(input.taskId), 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      return { record, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await this.get(input.taskId);
      if (!existing
        || existing.decisionId !== input.decisionId
        || existing.endpointId !== input.endpointId
        || existing.actionDigest !== input.actionDigest
        || existing.externalIdempotencyKey !== input.externalIdempotencyKey
        || existing.worktree !== input.worktree
        || existing.branch !== input.branch) {
        throw new Error('Action execution journal conflicts with the signed task.');
      }
      return { record: existing, created: false };
    }
  }

  async transition(
    taskId: string,
    allowed: ActionExecutionJournalState[],
    state: ActionExecutionJournalState,
    patch: Partial<ActionExecutionJournalRecord> = {},
  ): Promise<ActionExecutionJournalRecord> {
    const current = await this.get(taskId);
    if (!current || !allowed.includes(current.state)) {
      throw new Error(`Action execution journal transition to ${state} is invalid.`);
    }
    const next = { ...current, ...patch, state, updatedAt: this.now().toISOString() };
    await durableJsonWrite(this.recordPath(taskId), next);
    return next;
  }

  async claim(record: ActionExecutionJournalRecord, maximumAgeMs: number): Promise<ActionExecutionClaim> {
    if (record.state !== 'replay_authorized') throw new Error('Action execution is not authorized for claiming.');
    const boundedAgeMs = Math.min(Math.max(maximumAgeMs, 1), 24 * 60 * 60_000);
    const claim: ActionExecutionClaim = {
      schema: 'dharma.action-execution-claim/v1', taskId: record.taskId,
      decisionId: record.decisionId, actionDigest: record.actionDigest,
      ownerId: this.ownerId, pid: this.pid, claimedAt: this.now().toISOString(),
      expiresAt: new Date(this.now().getTime() + boundedAgeMs).toISOString(),
    };
    const handle = await open(this.claimPath(record.taskId), 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(claim)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await this.transition(record.taskId, ['replay_authorized'], 'executing');
    return claim;
  }

  isClaimOwnerAlive(claim: ActionExecutionClaim): boolean {
    if (Date.parse(claim.expiresAt) <= this.now().getTime()) return false;
    if (claim.ownerId === this.ownerId && claim.pid === this.pid) return true;
    try { process.kill(claim.pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
  }

  async recordEffectObserved(taskId: string, providerResult: unknown): Promise<void> {
    await this.transition(taskId, ['executing'], 'effect_observed', {
      providerResultDigest: `sha256:${createHash('sha256').update(JSON.stringify(providerResult)).digest('hex')}`,
    });
  }

  async recordReceipt(receipt: TaskReceipt): Promise<void> {
    assertValidTaskReceipt(receipt, receipt.taskId);
    await this.transition(receipt.taskId, [
      'prepared', 'replay_authorization_started', 'replay_authorized', 'executing', 'effect_observed',
    ], 'receipt_recorded', { receipt: receiptForDurableStorage(receipt) });
    await rm(this.claimPath(receipt.taskId), { force: true });
  }

  async selfTest(): Promise<void> {
    const path = resolve(this.directory, `.self-test-${randomUUID()}.json`);
    try {
      await durableJsonWrite(path, { schema: 'dharma.action-execution-journal-self-test/v1' });
      const value = JSON.parse(await readFile(path, 'utf8')) as { schema?: string };
      if (value.schema !== 'dharma.action-execution-journal-self-test/v1') throw new Error('Journal self-test readback failed.');
    } finally { await rm(path, { force: true }); }
  }
}

export class FileActionDecisionReplayGuard implements ActionDecisionReplayGuard {
  constructor(private readonly directory: string) {}

  async consume(decisionId: string, actionDigest: string): Promise<boolean> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = resolve(this.directory, `${decisionId}.json`);
    try {
      const handle = await open(target, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          decisionId,
          actionDigest,
          consumedAt: new Date().toISOString(),
        })}\n`);
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }
}

export function canonicalTaskActionForTask(
  task: TaskEnvelope,
  actionId: string,
): TaskAction {
  if (!task.target.endpointId) throw new Error('Receipt-required task target endpoint is unavailable.');
  return {
    schema: 'dharma.task-action/v1',
    organizationId: task.organizationId,
    actionId,
    taskId: task.taskId,
    targetEndpointId: task.target.endpointId,
    workspaceId: task.workspaceId,
    taskType: task.taskType,
    instructions: task.instructions,
    ...(task.source ? {
      source: task.source,
      stateEnvelope: task.stateEnvelope,
      evidenceReferences: task.evidenceReferences,
    } : {}),
    skillBundle: task.skillBundle,
    requiredSkills: task.requiredSkills,
    authority: task.authority,
    execution: task.execution,
    acceptance: task.acceptance,
    budget: task.budget,
    expiresAt: task.expiresAt,
  };
}

export function parseExternalEffectReceipt(
  stdout: string,
  expected: { actionDigest: string; externalIdempotencyKey: string },
): ExternalEffectReceipt {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let value: unknown;
  for (const line of lines.reverse()) {
    try {
      const candidate = JSON.parse(line) as unknown;
      if (candidate && typeof candidate === 'object'
        && (candidate as { schema?: unknown }).schema === 'dharma.external-effect-receipt/v1') {
        value = candidate;
        break;
      }
    } catch { /* verifier output may contain non-JSON diagnostics before the receipt */ }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('External-effect verifier did not emit a Dharma effect receipt.');
  }
  assertValidExternalEffectReceipt(value);
  const receipt = value as Partial<ExternalEffectReceipt>;
  if (receipt.schema !== 'dharma.external-effect-receipt/v1'
    || receipt.actionDigest !== expected.actionDigest
    || receipt.externalIdempotencyKey !== expected.externalIdempotencyKey
    || receipt.status !== 'committed'
    || typeof receipt.providerReference !== 'string' || receipt.providerReference.length < 1 || receipt.providerReference.length > 500
    || !/^sha256:[a-f0-9]{64}$/.test(String(receipt.proofDigest || ''))
    || !Number.isFinite(Date.parse(String(receipt.observedAt || '')))) {
    throw new Error('External-effect receipt does not match the signed action and idempotency key.');
  }
  return receipt as ExternalEffectReceipt;
}

export async function authorizeEmbeddedActionDecision(input: {
  task: TaskEnvelope;
  receiver: ActionDecisionReceiver;
  replayGuard: ActionDecisionReplayGuard;
}): Promise<ActionDecisionReceipt> {
  const receipt = verifyEmbeddedActionDecision(input.task, input.receiver);
  const envelope = input.task.actionDecision!;
  if (!await input.replayGuard.consume(envelope.id, envelope.actionDigest)) {
    throw new Error('Action-decision receipt replay was rejected.');
  }
  if (receipt.outcome !== 'release') {
    throw new ActionDecisionDeniedError(
      `Action-decision outcome ${receipt.outcome} denied execution.`,
      receipt,
    );
  }
  return receipt;
}

export function verifyEmbeddedActionDecision(
  task: TaskEnvelope,
  receiver: ActionDecisionReceiver,
): ActionDecisionReceipt {
  const envelope = task.actionDecision;
  if (!envelope) throw new Error('Embedded action-decision receipt is unavailable; execution is denied.');
  const action = canonicalTaskActionForTask(task, envelope.receipt.actionId);
  const verification = verifyActionDecisionReceipt(
    envelope,
    action,
    receiver.resolvePublicKey,
    receiver.now?.() ?? new Date(),
  );
  if (!verification.ok) throw new Error(`Action-decision receipt is invalid: ${verification.reason}.`);
  return envelope.receipt;
}

function requiresActionDecisionReceipt(task: TaskEnvelope): boolean {
  return task.requiredCapabilities?.includes('action_decision_receipts_v1') ?? false;
}

function interruptedActionReceipt(record: ActionExecutionJournalRecord, now: Date): TaskReceipt {
  const commandResults: CommandResult[] = [{
    commandId: 'runner', exitCode: null, signal: null, timedOut: false,
    stdoutSha256: `sha256:${'0'.repeat(64)}`,
    stderrSha256: `sha256:${createHash('sha256').update('External effect outcome is unknown after receiver restart.').digest('hex')}`,
    stdout: '', stderr: 'External effect outcome is unknown after receiver restart; execution was not repeated.',
  }];
  return {
    taskId: record.taskId, status: 'failed', worktree: record.worktree, branch: record.branch,
    commandResults,
    actionAcknowledgement: buildActionDecisionAcknowledgement({
      taskId: record.taskId, endpointId: record.endpointId, actionDigest: record.actionDigest,
      disposition: 'unknown', externalIdempotencyKey: record.externalIdempotencyKey,
      result: { status: 'failed', recovery: 'abandoned_execution_claim', commandResults },
    }, now),
    startedAt: record.preparedAt, completedAt: now.toISOString(),
  };
}

export async function executeTask(input: {
  task: TaskEnvelope;
  policy: OrganizationPolicy;
  workspace: string;
  relayStateDirectory: string;
  serverPublicKey: KeyObject;
  serverPublicKeyResolver?: ActionDecisionPublicKeyResolver;
  receiptStore: FileTaskReceiptStore;
  signal?: AbortSignal;
  providerExecutor?: ProviderTaskExecutor;
  actionDecisions?: ActionDecisionReceiver;
  actionExecutionJournal?: FileActionExecutionJournal;
}): Promise<TaskReceipt> {
  verifyTaskEnvelope(input.task, input.serverPublicKey, new Date(), input.serverPublicKeyResolver);
  const taskExpiresAt = Date.parse(input.task.expiresAt);
  const remainingTaskMs = () => taskExpiresAt - Date.now();
  if (!Number.isFinite(taskExpiresAt) || remainingTaskMs() <= 0) throw new Error('Task envelope expired.');
  if (input.task.organizationId !== input.policy.organizationId) throw new Error('Task organization does not match policy.');
  const previous = await input.receiptStore.get(input.task.taskId);
  if (previous) return previous;
  if (input.task.execution.isolation !== 'git_worktree') throw new Error('Only Git worktree isolation is supported.');
  if (input.task.authority.git !== 'task_branch') throw new Error('Pilot tasks require task_branch Git authority.');
  assertTaskWithinLocalPolicy(input.task, input.policy);
  for (const path of [...input.task.authority.readPaths, ...input.task.authority.writePaths]) {
    assertPathWithinWorkspace(input.workspace, path);
  }
  const allowed = new Set(input.task.authority.commands.map(({ commandId }) => commandId));
  for (const { commandId } of input.task.acceptance.commands) {
    if (!allowed.has(commandId)) throw new Error(`Acceptance command is outside task authority: ${commandId}`);
  }
  const effectReceiptCommandId = input.task.acceptance.externalEffectReceiptCommandId;
  if (effectReceiptCommandId
    && !input.task.acceptance.commands.some(({ commandId }) => commandId === effectReceiptCommandId)) {
    throw new Error('External-effect receipt command must be an acceptance command.');
  }
  if (requiresActionDecisionReceipt(input.task) && input.task.authority.network !== 'deny' && !effectReceiptCommandId) {
    throw new Error('Network-authorized tasks require a registered external-effect receipt verifier.');
  }

  const receiptRequired = requiresActionDecisionReceipt(input.task);
  const journal = input.actionExecutionJournal
    ?? new FileActionExecutionJournal(resolve(input.relayStateDirectory, 'action-execution-journal'));
  const worktreeRoot = resolve(input.relayStateDirectory, 'worktrees');
  const worktree = assertContained(worktreeRoot, resolve(worktreeRoot, input.task.taskId));
  const branch = `dharma/task/${input.task.taskId}`;
  let decisionReceipt: ActionDecisionReceipt | null = null;
  let journalRecord: ActionExecutionJournalRecord | null = null;
  let executionClaimed = false;
  let contained = false;
  let externalEffectReceipt: ExternalEffectReceipt | undefined;
  const startedAt = new Date().toISOString();

  if (receiptRequired) {
    if (!input.actionDecisions) throw new Error('Action-decision public key resolver is unavailable; execution is denied.');
    if (!input.task.target.endpointId) throw new Error('Receipt-required task target endpoint is unavailable.');
    decisionReceipt = verifyEmbeddedActionDecision(input.task, input.actionDecisions);
    const prepared = await journal.prepare({
      taskId: input.task.taskId, decisionId: decisionReceipt.decisionId,
      endpointId: input.task.target.endpointId, actionDigest: decisionReceipt.actionDigest,
      externalIdempotencyKey: decisionReceipt.decisionId, worktree, branch,
    });
    journalRecord = prepared.record;
    if (journalRecord.state === 'receipt_recorded') {
      if (!journalRecord.receipt) throw new Error('Action execution journal is missing its recorded receipt.');
      await input.receiptStore.put(journalRecord.receipt);
      return journalRecord.receipt;
    }
    const priorClaim = await journal.getClaim(input.task.taskId);
    if (priorClaim) {
      if (priorClaim.decisionId !== journalRecord.decisionId || priorClaim.actionDigest !== journalRecord.actionDigest) {
        throw new Error('Action execution claim conflicts with the signed decision.');
      }
      if (journal.isClaimOwnerAlive(priorClaim)) throw new Error('Action execution is already in progress.');
      const recovered = interruptedActionReceipt(journalRecord, input.actionDecisions.now?.() ?? new Date());
      await journal.recordReceipt(recovered);
      await input.receiptStore.put(recovered);
      return recovered;
    }
    if (journalRecord.state === 'replay_authorization_started'
      || journalRecord.state === 'executing'
      || journalRecord.state === 'effect_observed') {
      const recovered = interruptedActionReceipt(journalRecord, input.actionDecisions.now?.() ?? new Date());
      await journal.recordReceipt(recovered);
      await input.receiptStore.put(recovered);
      return recovered;
    }
    if (decisionReceipt.outcome !== 'release') {
      contained = true;
    } else if (journalRecord.state === 'prepared') {
      if (input.actionDecisions.replayGuard) {
        journalRecord = await journal.transition(input.task.taskId, ['prepared'], 'replay_authorization_started');
        if (!await input.actionDecisions.replayGuard.consume(decisionReceipt.decisionId, decisionReceipt.actionDigest)) {
          throw new Error('Action-decision receipt replay was rejected.');
        }
        journalRecord = await journal.transition(input.task.taskId, ['replay_authorization_started'], 'replay_authorized');
      } else {
        journalRecord = await journal.transition(input.task.taskId, ['prepared'], 'replay_authorized');
      }
    }
    if (!contained) {
      if (journalRecord.state !== 'replay_authorized') throw new Error('Action execution journal is not ready for execution.');
      try {
        await journal.claim(
          journalRecord,
          Math.min(
            (input.task.execution.timeoutSeconds + input.task.execution.leaseSeconds + 300) * 1_000,
            remainingTaskMs(),
          ),
        );
        executionClaimed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        throw new Error('Action execution is already claimed by another receiver.');
      }
    }
  }

  const commandResults: CommandResult[] = [];
  let status: TaskReceipt['status'] = contained ? 'failed' : 'completed';
  if (contained && decisionReceipt) {
    commandResults.push({
      commandId: 'runner', exitCode: null, signal: null, timedOut: false,
      stdoutSha256: `sha256:${'0'.repeat(64)}`,
      stderrSha256: `sha256:${createHash('sha256').update(`Action-decision outcome ${decisionReceipt.outcome} denied execution.`).digest('hex')}`,
      stdout: '', stderr: `Action-decision outcome ${decisionReceipt.outcome} denied execution.`,
    });
  }

  if (!contained) {
    try {
      await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
      await rm(worktree, { recursive: true, force: true });
      await git(input.workspace, ['worktree', 'add', '--detach', worktree, 'HEAD']);
      await git(worktree, ['switch', '-c', branch]);
      const startingCommit = (await gitOutput(worktree, ['rev-parse', 'HEAD'])).trim();
    const allowedCommands = input.task.authority.commands.map(({ commandId }) => resolveRegisteredCommand(input.policy, commandId).argv);
    const providerInstructions = providerInstructionsForTask(input.task);
    const providerTimeBudgetSeconds = Math.min(
      input.task.execution.timeoutSeconds,
      Math.floor(remainingTaskMs() / 1_000),
    );
    if (providerTimeBudgetSeconds < 1) throw new Error('Task expires before provider execution can start.');
    const providerInput = {
      provider: input.task.target.provider,
      workspace: worktree,
      instructions: providerInstructions,
      timeoutSeconds: providerTimeBudgetSeconds,
      allowedCommandArgv: allowedCommands,
      allowWrites: input.task.authority.writePaths.length > 0,
      ...(decisionReceipt ? {
        externalIdempotencyKey: decisionReceipt.decisionId,
        actionDigest: decisionReceipt.actionDigest,
      } : {}),
      signal: input.signal,
    };
    const providerResult: ProviderExecutionResult = await (input.providerExecutor ?? executeProviderTask)(providerInput);
    if (remainingTaskMs() <= 0) throw new Error('Task expired during provider execution.');
    if (executionClaimed) await journal.recordEffectObserved(input.task.taskId, providerResult);
    commandResults.push({
      commandId: `provider.${input.task.target.provider}`,
      exitCode: providerResult.exitCode,
      signal: providerResult.signal,
      timedOut: providerResult.timedOut,
      stdout: providerResult.stdout,
      stderr: providerResult.stderr,
      stdoutSha256: providerResult.stdoutSha256,
      stderrSha256: providerResult.stderrSha256,
    });
    if (providerResult.exitCode !== 0 || providerResult.timedOut) status = input.signal?.aborted ? 'cancelled' : 'failed';
    const trackedChanges = await gitOutput(worktree, [
      'diff', '--name-only', '--diff-filter=ACDMRTUXB', startingCommit, '--',
    ]);
    const untrackedChanges = await gitOutput(worktree, ['ls-files', '--others', '--exclude-standard']);
    const changedPaths = `${trackedChanges}\n${untrackedChanges}`
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean);
    if (changedPaths.length > 0) {
      const writes = input.task.authority.writePaths;
      if (writes.length === 0 || changedPaths.some((path) => !pathWithinPolicy(path, writes))) {
        throw new Error('Provider changed a path outside the signed task authority.');
      }
    }
    for (const { commandId } of input.task.acceptance.commands) {
      if (status !== 'completed') break;
      if (input.signal?.aborted) { status = 'cancelled'; break; }
      const command = resolveRegisteredCommand(input.policy, commandId);
      const cwd = command.workingDirectory
        ? assertPathWithinWorkspace(worktree, command.workingDirectory)
        : worktree;
      const [executable, ...argv] = command.argv;
      const acceptanceTimeBudgetMs = remainingTaskMs();
      if (acceptanceTimeBudgetMs <= 0) throw new Error('Task expired before acceptance verification.');
      const result = await runProcess(executable!, argv, {
        cwd,
        timeoutMs: Math.min(
          command.timeoutSeconds * 1_000,
          input.task.execution.timeoutSeconds * 1_000,
          acceptanceTimeBudgetMs,
        ),
        signal: input.signal,
        ...(decisionReceipt ? {
          environment: {
            DHARMA_EXTERNAL_IDEMPOTENCY_KEY: decisionReceipt.decisionId,
            DHARMA_ACTION_DIGEST: decisionReceipt.actionDigest,
          },
        } : {}),
      });
      if (remainingTaskMs() <= 0) throw new Error('Task expired during acceptance verification.');
      commandResults.push({ commandId, ...result });
      if (receiptRequired && commandId === input.task.acceptance.externalEffectReceiptCommandId
        && decisionReceipt) {
        externalEffectReceipt = parseExternalEffectReceipt(result.stdout, {
          actionDigest: decisionReceipt.actionDigest,
          externalIdempotencyKey: decisionReceipt.decisionId,
        });
      }
      if (result.exitCode !== 0 || result.timedOut) { status = input.signal?.aborted ? 'cancelled' : 'failed'; break; }
    }
    } catch (error) {
      status = input.signal?.aborted ? 'cancelled' : 'failed';
      commandResults.push({
        commandId: 'runner', exitCode: null, signal: null, timedOut: false,
        stdoutSha256: `sha256:${'0'.repeat(64)}`,
        stderrSha256: `sha256:${createHash('sha256').update(String(error)).digest('hex')}`,
        stdout: '', stderr: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (receiptRequired && !contained && status === 'completed' && input.task.authority.network !== 'deny'
    && !externalEffectReceipt) {
    const message = 'Provider completion cannot prove an external network effect without a provider-specific effect receipt.';
    status = 'failed';
    commandResults.push({
      commandId: 'runner', exitCode: null, signal: null, timedOut: false,
      stdoutSha256: `sha256:${'0'.repeat(64)}`,
      stderrSha256: `sha256:${createHash('sha256').update(message).digest('hex')}`,
      stdout: '', stderr: message,
    });
  }
  const actionAcknowledgement = decisionReceipt && input.task.target.endpointId
    ? buildActionDecisionAcknowledgement({
      taskId: input.task.taskId,
      endpointId: input.task.target.endpointId,
      actionDigest: decisionReceipt.actionDigest,
      disposition: contained ? 'contained' : status === 'completed' ? 'executed' : 'unknown',
      externalIdempotencyKey: decisionReceipt.decisionId,
      result: {
        status,
        commandResults: commandResults.map(({ commandId, exitCode, signal, timedOut, stdoutSha256, stderrSha256 }) => ({
          commandId, exitCode, signal, timedOut, stdoutSha256, stderrSha256,
        })),
      },
    }, input.actionDecisions?.now?.() ?? new Date())
    : undefined;
  const receipt: TaskReceipt = {
    taskId: input.task.taskId,
    status,
    worktree,
    branch,
    commandResults,
    ...(externalEffectReceipt ? { externalEffectReceipt } : {}),
    ...(actionAcknowledgement ? { actionAcknowledgement } : {}),
    startedAt,
    completedAt: new Date().toISOString(),
  };
  if (receiptRequired) await journal.recordReceipt(receipt);
  await input.receiptStore.put(receipt);
  return receipt;
}
