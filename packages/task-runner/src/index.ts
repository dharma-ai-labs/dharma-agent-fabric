import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { KeyObject } from 'node:crypto';
import { validateTaskEnvelopeContract, verifyCanonicalObject, type ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';
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
  target: { deviceId: string; provider: ProviderId };
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
  };
  execution: { isolation: 'git_worktree'; timeoutSeconds: number; leaseSeconds: number; maximumConcurrentAgents: number };
  acceptance: { commands: Array<{ commandId: string }>; requiredArtifacts: string[] };
  budget: { mode: 'byok_local' | 'byok_cloud' | 'dharma_managed'; maximumDharmaCostCents: number; maximumProviderCostCents?: number | null };
  createdAt: string;
  expiresAt: string;
  nonce: string;
  signature?: string | null;
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
  signal?: AbortSignal;
}) => Promise<ProviderExecutionResult>;

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

async function runProcess(command: string, argv: string[], options: {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maximumOutputBytes?: number;
}): Promise<Omit<CommandResult, 'commandId'>> {
  return new Promise((accept, reject) => {
    const child = spawn(command, argv, {
      cwd: options.cwd,
      env: { ...process.env, DHARMA_TASK_WORKTREE: options.cwd },
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
    const cancel = () => child.kill('SIGTERM');
    options.signal?.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
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

export function verifyTaskEnvelope(task: TaskEnvelope, publicKey: KeyObject, now = new Date()): void {
  const contract = validateTaskEnvelopeContract(task);
  if (!contract.ok) throw new Error(`Task failed schema validation: ${JSON.stringify(contract.errors)}`);
  if (!task.signature) throw new Error('Task signature is required.');
  if (Date.parse(task.expiresAt) <= now.getTime()) throw new Error('Task has expired.');
  const { signature, ...unsigned } = task;
  if (!verifyCanonicalObject(unsigned, signature, publicKey)) throw new Error('Task signature is invalid.');
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

export class FileTaskReceiptStore {
  constructor(private readonly directory: string) {}

  async get(taskId: string): Promise<TaskReceipt | null> {
    try { return JSON.parse(await readFile(resolve(this.directory, `${taskId}.json`), 'utf8')) as TaskReceipt; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async put(receipt: TaskReceipt): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = resolve(this.directory, `${receipt.taskId}.json`);
    const temp = `${target}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    await rename(temp, target);
  }
}

export async function executeTask(input: {
  task: TaskEnvelope;
  policy: OrganizationPolicy;
  workspace: string;
  relayStateDirectory: string;
  serverPublicKey: KeyObject;
  receiptStore: FileTaskReceiptStore;
  signal?: AbortSignal;
  providerExecutor?: ProviderTaskExecutor;
}): Promise<TaskReceipt> {
  verifyTaskEnvelope(input.task, input.serverPublicKey);
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

  const worktreeRoot = resolve(input.relayStateDirectory, 'worktrees');
  const worktree = assertContained(worktreeRoot, resolve(worktreeRoot, input.task.taskId));
  const branch = `dharma/task/${input.task.taskId}`;
  await mkdir(worktreeRoot, { recursive: true, mode: 0o700 });
  await rm(worktree, { recursive: true, force: true });
  await git(input.workspace, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  await git(worktree, ['switch', '-c', branch]);
  const startingCommit = (await gitOutput(worktree, ['rev-parse', 'HEAD'])).trim();
  const startedAt = new Date().toISOString();
  const commandResults: CommandResult[] = [];
  let status: TaskReceipt['status'] = 'completed';
  try {
    const allowedCommands = input.task.authority.commands.map(({ commandId }) => resolveRegisteredCommand(input.policy, commandId).argv);
    const providerResult = await (input.providerExecutor ?? executeProviderTask)({
      provider: input.task.target.provider,
      workspace: worktree,
      instructions: providerInstructionsForTask(input.task),
      timeoutSeconds: input.task.execution.timeoutSeconds,
      allowedCommandArgv: allowedCommands,
      allowWrites: input.task.authority.writePaths.length > 0,
      signal: input.signal,
    });
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
      const result = await runProcess(executable!, argv, {
        cwd,
        timeoutMs: Math.min(command.timeoutSeconds, input.task.execution.timeoutSeconds) * 1_000,
        signal: input.signal,
      });
      commandResults.push({ commandId, ...result });
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
  const receipt: TaskReceipt = {
    taskId: input.task.taskId,
    status,
    worktree,
    branch,
    commandResults,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  await input.receiptStore.put(receipt);
  return receipt;
}
