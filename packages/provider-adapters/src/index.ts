import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdtemp, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, relative, resolve } from 'node:path';
import type { EvidenceState, ProviderCapability, ProviderId } from '@dharma-ai-labs/agent-fabric-contracts';

export interface SourceRecord {
  native: Record<string, unknown>;
  sourcePath: string;
  line: number;
  workspace: string | null;
  timestamp: string | null;
  kind: string;
  coverage?: EvidenceState;
}

export interface ProviderSession {
  provider: ProviderId;
  sessionId: string;
  sourcePath: string;
  workspace: string;
  records: SourceRecord[];
  coverage: EvidenceState;
  startedAt: string;
  endedAt: string;
}

export interface DiscoveryRequest {
  workspace: string;
  roots?: string[];
  sessionIds?: string[];
  since?: Date;
  maximumSessions?: number;
  maximumBytesPerSession?: number;
  maximumRecordBytes?: number;
}

export interface ProviderAdapter {
  providerId: ProviderId;
  capability(): Promise<ProviderCapability & { skillRollback: 'available' | 'partial' | 'unavailable' }>;
  discover(request: DiscoveryRequest): Promise<ProviderSession[]>;
}

export interface ProviderExecutionResult {
  provider: ProviderId;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutSha256: string;
  stderrSha256: string;
}

export type ProviderProcessRunner = (input: {
  command: string; argv: string[]; cwd: string; stdin: string; timeoutMs: number; signal?: AbortSignal;
  completeOnResultJson?: boolean;
  environment?: Record<string, string>;
}) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: Buffer; stderr: Buffer }>;

export function providerProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'Path', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'TMP', 'TEMP', 'TMPDIR',
    'SHELL', 'COMSPEC', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'LANG', 'LC_ALL', 'TERM',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'AGY_CONFIG_DIR',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    if (typeof source[name] === 'string') env[name] = source[name];
  }
  const pathName = typeof env.PATH === 'string' ? 'PATH' : typeof env.Path === 'string' ? 'Path' : 'PATH';
  const home = source.HOME || source.USERPROFILE || homedir();
  const localBin = resolve(home, '.local', 'bin');
  const pathEntries = (env[pathName] || '').split(delimiter).filter(Boolean);
  if (!pathEntries.includes(localBin)) pathEntries.push(localBin);
  env[pathName] = pathEntries.join(delimiter);
  env.NO_COLOR = '1';
  env.DHARMA_AGENT_FABRIC_TASK = '1';
  return env;
}

export const defaultProcessRunner: ProviderProcessRunner = (input) => new Promise((accept, reject) => {
  const child = spawn(input.command, input.argv, {
    cwd: input.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...providerProcessEnvironment(), ...(input.environment || {}) },
  });
  const maximum = 5_000_000;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let terminalResultCode: number | null = null;
  let pendingJson = '';
  const collect = (target: Buffer[], chunk: Buffer, current: number) => {
    if (current < maximum) target.push(chunk.subarray(0, Math.max(0, maximum - current)));
    return current + chunk.length;
  };
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBytes = collect(stdout, chunk, stdoutBytes);
    if (!input.completeOnResultJson || terminalResultCode !== null) return;
    pendingJson += chunk.toString('utf8');
    const complete = (line: string): boolean => {
      try {
        const event = JSON.parse(line) as { type?: unknown; is_error?: unknown; subtype?: unknown };
        if (event.type !== 'result') return false;
        terminalResultCode = event.is_error === true || String(event.subtype || '').includes('error') ? 1 : 0;
        child.kill('SIGTERM');
        return true;
      } catch {
        return false;
      }
    };
    const lines = pendingJson.split(/\r?\n/);
    pendingJson = lines.pop() || '';
    for (const line of lines) {
      if (complete(line)) break;
    }
    if (terminalResultCode === null && complete(pendingJson)) pendingJson = '';
  });
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
  const cancel = () => child.kill('SIGTERM');
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, input.timeoutMs);
  child.once('error', reject);
  child.once('close', (exitCode, signal) => {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', cancel);
    accept({
      exitCode: terminalResultCode ?? exitCode,
      signal: terminalResultCode === null ? signal : null,
      timedOut,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    });
  });
  child.stdin.end(input.stdin);
});

export async function executeProviderTask(input: {
  provider: ProviderId;
  workspace: string;
  instructions: string;
  timeoutSeconds: number;
  allowedCommandArgv: string[][];
  allowWrites: boolean;
  externalIdempotencyKey?: string;
  actionDigest?: string;
  signal?: AbortSignal;
  runner?: ProviderProcessRunner;
}): Promise<ProviderExecutionResult> {
  if (!insideWorkspace(input.workspace, input.workspace)) throw new Error('Provider workspace is invalid.');
  if (!input.instructions.trim() || input.instructions.length > 20_000) throw new Error('Provider task instructions are invalid.');
  const runner = input.runner || defaultProcessRunner;
  let command: string;
  let argv: string[];
  let stdin = input.instructions;
  let temporaryDirectory: string | null = null;
  let agyLogPath: string | null = null;
  if (input.provider === 'codex') {
    command = 'codex';
    argv = input.allowWrites
      ? ['exec', '--ignore-user-config', '--json', '--color', 'never', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '-C', input.workspace, '-']
      : ['exec', '--ignore-user-config', '--json', '--color', 'never', '--sandbox', 'read-only', '-C', input.workspace, '-'];
  } else if (input.provider === 'claude') {
    command = 'claude';
    const configuredModel = (process.env.DHARMA_CLAUDE_MODEL || '').trim();
    if (configuredModel && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(configuredModel)) {
      throw new Error('DHARMA_CLAUDE_MODEL is invalid.');
    }
    const bashTools = input.allowedCommandArgv.map((parts) => `Bash(${parts.join(' ')})`);
    const allowedTools = input.allowWrites ? ['Read', 'Edit', 'Write', ...bashTools] : ['Read', ...bashTools];
    argv = [
      '--print', '--verbose', '--safe-mode', '--no-session-persistence',
      ...(configuredModel ? ['--model', configuredModel] : []),
      '--input-format', 'text', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits',
      '--allowedTools', allowedTools.join(','), '--disallowedTools', 'WebFetch,WebSearch',
    ];
  } else {
    if (input.allowWrites) {
      throw new Error('Agy write tasks are disabled because its supported CLI does not expose a path and command allowlist.');
    }
    if (input.allowedCommandArgv.length > 0) {
      throw new Error('Agy tasks cannot receive registered shell commands.');
    }
    command = 'agy';
    temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'dharma-agy-task-'));
    agyLogPath = resolve(temporaryDirectory, 'agy.log');
    // Agy's sandbox and plan mode are the structural boundary. The prompt is
    // defense in depth and must not be treated as delegated write authority.
    const guardedInstructions = [
      'Operate only inside the current repository. Use file-reading tools only. Do not modify files, run shell commands, use the network, or inspect parent/sibling directories.',
      input.instructions,
    ].join('\n\n');
    argv = [
      '--new-project',
      '--print', guardedInstructions,
      '--output-format', 'json',
      '--sandbox',
      '--mode', 'plan',
      '--log-file', agyLogPath,
      '--print-timeout', `${Math.min(Math.max(input.timeoutSeconds, 1), 3_600)}s`,
    ];
    stdin = '';
  }
  try {
    const result = await runner({
      command, argv, cwd: input.workspace, stdin,
      timeoutMs: Math.min(Math.max(input.timeoutSeconds, 1), 3_600) * 1_000,
      signal: input.signal,
      completeOnResultJson: input.provider === 'claude',
      environment: {
        ...(input.externalIdempotencyKey ? { DHARMA_EXTERNAL_IDEMPOTENCY_KEY: input.externalIdempotencyKey } : {}),
        ...(input.actionDigest ? { DHARMA_ACTION_DIGEST: input.actionDigest } : {}),
      },
    });
    let stderr = result.stderr.toString('utf8');
    let exitCode = result.exitCode;
    if (input.provider === 'agy') {
      let log = '';
      try { log = await readFile(agyLogPath!, 'utf8'); } catch {}
      const stdout = result.stdout.toString('utf8');
      const diagnostic = `${stdout}\n${stderr}\n${log}`;
      const userFacingDiagnostic = `${stdout}\n${stderr}`;
      let structuredStatus: string | null = null;
      try {
        const parsed = JSON.parse(stdout) as { status?: unknown };
        if (typeof parsed.status === 'string') structuredStatus = parsed.status.toUpperCase();
      } catch {}
      if (/not logged into antigravity|auth(?:entication)? (?:timed out|required|failed)|please (?:log in|authenticate)|oauth.*(?:failed|expired)/i.test(userFacingDiagnostic)
        || /no output produced.*auto-denied/i.test(diagnostic)
        || structuredStatus !== 'SUCCESS'
        || (result.exitCode === 0 && !stdout.trim())) {
        exitCode = 1;
        stderr = `${stderr}${stderr ? '\n' : ''}Agy authentication or execution failed. Run agy interactively to authenticate this device.`;
      }
    }
    const stderrBuffer = Buffer.from(stderr, 'utf8');
    return {
      provider: input.provider, exitCode, signal: result.signal, timedOut: result.timedOut,
      stdout: result.stdout.toString('utf8'), stderr,
      stdoutSha256: `sha256:${createHash('sha256').update(result.stdout).digest('hex')}`,
      stderrSha256: `sha256:${createHash('sha256').update(stderrBuffer).digest('hex')}`,
    };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function executableVersion(command: string): Promise<string | null> {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr).trim().split('\n')[0] || null;
}

function insideWorkspace(workspace: string, candidate: string): boolean {
  const normalizeHostPath = (value: string): string => {
    const slashed = value.replaceAll('\\', '/');
    const wsl = slashed.match(/^\/{2}wsl\.localhost\/[^/]+(\/.*)$/i);
    if (wsl?.[1]) return wsl[1];
    const drive = slashed.match(/^([A-Za-z]):\/(.*)$/);
    if (drive?.[1] && drive[2] && process.platform !== 'win32') {
      return `/mnt/${drive[1].toLowerCase()}/${drive[2]}`;
    }
    return value;
  };
  const route = relative(resolve(normalizeHostPath(workspace)), resolve(normalizeHostPath(candidate)));
  return route === '' || (!route.startsWith('..') && !isAbsolute(route));
}

function findString(record: Record<string, unknown>, keys: string[]): string | null {
  const queue: unknown[] = [record];
  let visited = 0;
  while (queue.length > 0 && visited < 200) {
    const value = queue.shift();
    visited += 1;
    if (!value || typeof value !== 'object') continue;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(key) && typeof child === 'string' && child.length > 0) return child;
      if (child && typeof child === 'object') queue.push(child);
    }
  }
  return null;
}

function normalizeTimestamp(value: string | null, fallback: Date): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback.toISOString();
}

function inferKind(record: Record<string, unknown>): string {
  const payload = record.payload && typeof record.payload === 'object'
    ? record.payload as Record<string, unknown>
    : {};
  const item = payload.item && typeof payload.item === 'object'
    ? payload.item as Record<string, unknown>
    : {};
  const raw = [payload.type, payload.role, item.type, item.role, record.type, record.kind, record.event_type, record.role]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (raw.includes('user')) return 'user_message';
  if (raw.includes('assistant') || raw.includes('agent')) return 'agent_message';
  if (raw.includes('tool') && (raw.includes('result') || raw.includes('end') || raw.includes('output'))) return 'tool_result';
  if (raw.includes('function_call_output') || raw.includes('patch_apply_end')) return 'tool_result';
  if (raw.includes('tool') || raw.includes('function_call') || raw.includes('patch_apply')) return 'tool_call';
  if (raw.includes('command') || raw.includes('shell')) return 'command';
  if (raw.includes('error')) return 'error';
  if (raw.includes('retry')) return 'retry';
  return 'metadata';
}

const PROTECTED_NATIVE_FIELDS = new Set([
  'encrypted_content',
  'encryptedContent',
  'encrypted_reasoning',
  'encryptedReasoning',
]);

function stripProtectedNativeContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProtectedNativeContent);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !PROTECTED_NATIVE_FIELDS.has(key))
    .map(([key, child]) => [key, stripProtectedNativeContent(child)]));
}

async function jsonlFiles(root: string): Promise<string[]> {
  try { await access(root); } catch { return []; }
  const rootStat = await stat(root);
  if (rootStat.isFile()) return root.endsWith('.jsonl') ? [root] : [];
  const output: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.name.endsWith('.jsonl') && entry.isFile()) output.push(path);
      else if (entry.name.endsWith('.jsonl') && entry.isSymbolicLink() && (await stat(path)).isFile()) {
        output.push(await realpath(path));
      }
    }
  }
  return output.sort();
}

async function boundedJsonlLines(
  path: string,
  size: number,
  maximumBytes: number,
): Promise<{ lines: string[]; tailOffset: number | null }> {
  const handle = await open(path, 'r');
  try {
    if (size <= maximumBytes) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return { lines: buffer.toString('utf8').split(/\r?\n/).filter(Boolean), tailOffset: null };
    }
    const headSize = Math.min(1_048_576, Math.floor(maximumBytes / 2));
    const tailSize = maximumBytes - headSize;
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    await handle.read(head, 0, headSize, 0);
    await handle.read(tail, 0, tailSize, size - tailSize);
    const headLines = head.toString('utf8').split(/\r?\n/);
    headLines.pop();
    const tailLines = tail.toString('utf8').split(/\r?\n/);
    tailLines.shift();
    const boundedHead = headLines.filter(Boolean);
    return { lines: [...boundedHead, ...tailLines.filter(Boolean)], tailOffset: boundedHead.length };
  } finally {
    await handle.close();
  }
}

async function parseSessionFile(
  provider: Exclude<ProviderId, 'agy'>,
  path: string,
  workspace: string,
  limits: { maximumBytes?: number; maximumRecordBytes?: number } = {},
): Promise<ProviderSession | null> {
  const fileStat = await stat(path);
  const records: SourceRecord[] = [];
  const maximumBytes = Math.min(Math.max(limits.maximumBytes ?? 8_388_608, 65_536), 67_108_864);
  const maximumRecordBytes = Math.min(Math.max(limits.maximumRecordBytes ?? 262_144, 4_096), 1_048_576);
  let line = 0;
  let omitted = fileStat.size > maximumBytes;
  const bounded = await boundedJsonlLines(path, fileStat.size, maximumBytes);
  let tailTurnReady = bounded.tailOffset === null;
  let currentTurnStart = 0;
  const markCurrentTurnPartial = () => {
    for (const record of records.slice(currentTurnStart)) record.coverage = 'partial';
  };
  for (const [index, value] of bounded.lines.entries()) {
    line += 1;
    if (!value.trim()) continue;
    if (Buffer.byteLength(value) > maximumRecordBytes) {
      omitted = true;
      markCurrentTurnPartial();
      continue;
    }
    let native: Record<string, unknown>;
    try { native = stripProtectedNativeContent(JSON.parse(value)) as Record<string, unknown>; } catch {
      omitted = true;
      markCurrentTurnPartial();
      continue;
    }
    const inTail = bounded.tailOffset !== null && index >= bounded.tailOffset;
    if (inTail && !tailTurnReady) {
      const candidate: SourceRecord = {
        native,
        sourcePath: path,
        line,
        workspace: null,
        timestamp: null,
        kind: 'metadata',
      };
      if (!recordTurnId(candidate)) continue;
      tailTurnReady = true;
    }
    if (recordTurnId({ native, sourcePath: path, line, workspace: null, timestamp: null, kind: 'metadata' })) {
      currentTurnStart = records.length;
    }
    const cwd = findString(native, ['cwd', 'workspace', 'workspace_path', 'working_directory']);
    const timestamp = findString(native, ['timestamp', 'created_at', 'createdAt', 'time']);
    records.push({
      native,
      sourcePath: path,
      line,
      workspace: cwd,
      timestamp,
      kind: inferKind(native),
      coverage: bounded.tailOffset === null || (inTail && tailTurnReady) ? 'observed' : 'partial',
    });
  }
  const bound = records.filter((record) => record.workspace && insideWorkspace(workspace, record.workspace));
  if (bound.length === 0) return null;
  const effective = records.filter((record) => !record.workspace || insideWorkspace(workspace, record.workspace));
  const startedAt = normalizeTimestamp(effective[0]?.timestamp ?? null, fileStat.birthtime);
  const endedAt = normalizeTimestamp(effective.at(-1)?.timestamp ?? null, fileStat.mtime);
  const sourceHash = createHash('sha256').update(path).digest('hex');
  return {
    provider,
    sessionId: `${provider}-${sourceHash.slice(0, 24)}`,
    sourcePath: path,
    workspace: resolve(workspace),
    records: effective,
    coverage: !omitted && effective.length === records.length ? 'observed' : 'partial',
    startedAt,
    endedAt,
  };
}

function recordTurnId(record: SourceRecord): string | null {
  const payload = record.native.payload && typeof record.native.payload === 'object'
    ? record.native.payload as Record<string, unknown>
    : {};
  const value = payload.turn_id ?? payload.turnId;
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export function segmentProviderSession(session: ProviderSession): ProviderSession[] {
  const explicitTurns = session.records
    .map((record) => recordTurnId(record))
    .filter((value): value is string => Boolean(value));
  if (explicitTurns.length === 0) return [session];

  const prefix: SourceRecord[] = [];
  const ordered: Array<{ turnId: string; records: SourceRecord[] }> = [];
  const byTurn = new Map<string, SourceRecord[]>();
  let currentTurnId: string | null = null;
  for (const record of session.records) {
    const turnId = recordTurnId(record);
    if (turnId) currentTurnId = turnId;
    if (!currentTurnId) {
      prefix.push(record);
      continue;
    }
    let records = byTurn.get(currentTurnId);
    if (!records) {
      records = ordered.length === 0 ? [...prefix] : [];
      byTurn.set(currentTurnId, records);
      ordered.push({ turnId: currentTurnId, records });
    }
    records.push(record);
  }

  return ordered.map(({ turnId, records }) => ({
    ...session,
    sessionId: `${session.sessionId}:turn:${turnId}`,
    records,
    coverage: records.every((record) => record.coverage === 'observed') ? 'observed' : 'partial',
    startedAt: normalizeTimestamp(records[0]?.timestamp ?? null, new Date(session.startedAt)),
    endedAt: normalizeTimestamp(records.at(-1)?.timestamp ?? null, new Date(session.endedAt)),
  }));
}

async function parseAgyHistoryFile(path: string, workspace: string): Promise<ProviderSession[]> {
  const fileStat = await stat(path);
  const bounded = await boundedJsonlLines(path, fileStat.size, 8_388_608);
  const sessions: ProviderSession[] = [];
  for (const [index, value] of bounded.lines.entries()) {
    let native: Record<string, unknown>;
    try { native = JSON.parse(value) as Record<string, unknown>; } catch { continue; }
    const recordedWorkspace = typeof native.workspace === 'string' ? native.workspace : null;
    if (!recordedWorkspace || !insideWorkspace(workspace, recordedWorkspace)) continue;
    const rawTimestamp = native.timestamp;
    const timestamp = typeof rawTimestamp === 'number'
      ? new Date(rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1_000).toISOString()
      : normalizeTimestamp(typeof rawTimestamp === 'string' ? rawTimestamp : null, fileStat.mtime);
    const conversationId = typeof native.conversationId === 'string' ? native.conversationId : null;
    const identity = conversationId || `${recordedWorkspace}:${timestamp}:${String(native.display || '')}:${index}`;
    const sessionId = `agy-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
    sessions.push({
      provider: 'agy',
      sessionId,
      sourcePath: path,
      workspace: resolve(workspace),
      records: [{
        native,
        sourcePath: path,
        line: index + 1,
        workspace: recordedWorkspace,
        timestamp,
        kind: 'metadata',
        coverage: 'partial',
      }],
      coverage: 'partial',
      startedAt: timestamp,
      endedAt: timestamp,
    });
  }
  return sessions;
}

async function parseAgyTranscriptFile(
  path: string,
  workspace: string,
  conversationId: string,
  limits: { maximumBytes?: number; maximumRecordBytes?: number } = {},
): Promise<ProviderSession | null> {
  const fileStat = await stat(path);
  const maximumBytes = Math.min(Math.max(limits.maximumBytes ?? 8_388_608, 65_536), 67_108_864);
  const maximumRecordBytes = Math.min(Math.max(limits.maximumRecordBytes ?? 262_144, 4_096), 1_048_576);
  const bounded = await boundedJsonlLines(path, fileStat.size, maximumBytes);
  const records: SourceRecord[] = [];
  let omitted = fileStat.size > maximumBytes;
  for (const [index, value] of bounded.lines.entries()) {
    if (Buffer.byteLength(value) > maximumRecordBytes) {
      omitted = true;
      continue;
    }
    let native: Record<string, unknown>;
    try { native = JSON.parse(value) as Record<string, unknown>; }
    catch {
      omitted = true;
      continue;
    }
    const timestamp = normalizeTimestamp(
      findString(native, ['created_at', 'createdAt', 'timestamp', 'time']),
      fileStat.mtime,
    );
    records.push({
      native,
      sourcePath: path,
      line: index + 1,
      workspace: resolve(workspace),
      timestamp,
      kind: inferKind(native),
      coverage: omitted ? 'partial' : 'observed',
    });
  }
  if (records.length === 0) return null;
  const sourceHash = createHash('sha256').update(conversationId).digest('hex').slice(0, 24);
  return {
    provider: 'agy',
    sessionId: `agy-${sourceHash}`,
    sourcePath: path,
    workspace: resolve(workspace),
    records,
    coverage: omitted ? 'partial' : 'observed',
    startedAt: records[0]!.timestamp!,
    endedAt: records.at(-1)!.timestamp!,
  };
}

async function discoverAgyNativeTranscripts(
  configRoot: string,
  request: DiscoveryRequest,
): Promise<ProviderSession[]> {
  const mappingPath = resolve(configRoot, 'cache', 'last_conversations.json');
  let mapping: Record<string, unknown>;
  try { mapping = JSON.parse(await readFile(mappingPath, 'utf8')) as Record<string, unknown>; }
  catch { return []; }
  const sessions: ProviderSession[] = [];
  for (const [recordedWorkspace, rawConversationId] of Object.entries(mapping)) {
    if (resolve(recordedWorkspace) !== resolve(request.workspace)) continue;
    if (typeof rawConversationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(rawConversationId)) continue;
    const candidates = [
      resolve(configRoot, 'brain', rawConversationId, '.system_generated', 'logs', 'transcript_full.jsonl'),
      resolve(configRoot, 'brain', rawConversationId, '.system_generated', 'logs', 'transcript.jsonl'),
    ];
    for (const path of candidates) {
      try {
        const session = await parseAgyTranscriptFile(path, request.workspace, rawConversationId, {
          maximumBytes: request.maximumBytesPerSession,
          maximumRecordBytes: request.maximumRecordBytes,
        });
        if (session) sessions.push(session);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return sessions;
}

function defaultRoots(provider: ProviderId): string[] {
  if (provider === 'codex') {
    return [resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'sessions')];
  }
  if (provider === 'claude') {
    return [resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude'), 'projects')];
  }
  return [resolve(process.env.AGY_CONFIG_DIR || resolve(homedir(), '.gemini', 'antigravity-cli'), 'history.jsonl')];
}

function adapter(provider: Exclude<ProviderId, 'agy'>, command: string): ProviderAdapter {
  return {
    providerId: provider,
    async capability() {
      const version = await executableVersion(command);
      return {
        provider,
        version,
        evidence: 'available',
        configuredAssets: 'partial',
        taskExecution: version ? 'available' : 'unavailable',
        sessionContinuation: 'unavailable',
        skillInstall: version ? 'available' : 'unavailable',
        activation: 'next_session',
        skillRollback: version ? 'available' : 'unavailable',
        usageEvidence: 'partial',
      };
    },
    async discover(request) {
      const sessions: ProviderSession[] = [];
      const maximumSessions = Math.min(Math.max(request.maximumSessions ?? 100, 1), 1_000);
      const requestedSessionIds = request.sessionIds ? new Set(request.sessionIds) : null;
      const candidates: Array<{ path: string; modified: number }> = [];
      for (const root of request.roots ?? defaultRoots(provider)) {
        for (const path of await jsonlFiles(root)) {
          const fileStat = await stat(path);
          if (!request.since || fileStat.mtime >= request.since) candidates.push({ path, modified: fileStat.mtimeMs });
        }
      }
      candidates.sort((left, right) => right.modified - left.modified);
      for (const candidate of candidates) {
        const session = await parseSessionFile(provider, candidate.path, request.workspace, {
          maximumBytes: request.maximumBytesPerSession,
          maximumRecordBytes: request.maximumRecordBytes,
        });
        if (session) {
          const discovered = segmentProviderSession(session);
          sessions.push(...(requestedSessionIds
            ? discovered.filter((candidate) => requestedSessionIds.has(candidate.sessionId))
            : discovered));
        }
        if (requestedSessionIds
          ? sessions.length >= requestedSessionIds.size
          : sessions.length >= maximumSessions) break;
      }
      const ordered = sessions.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
      return requestedSessionIds ? ordered : ordered.slice(-maximumSessions);
    },
  };
}

export function agyCapability(version: string | null): ProviderCapability & { skillRollback: 'unavailable' } {
  return {
    provider: 'agy',
    version,
    evidence: version ? 'partial' : 'unavailable',
    configuredAssets: version ? 'partial' : 'unavailable',
    taskExecution: version ? 'partial' : 'unavailable',
    sessionContinuation: version ? 'partial' : 'unavailable',
    skillInstall: version ? 'partial' : 'unavailable',
    activation: 'unavailable',
    skillRollback: 'unavailable',
    usageEvidence: 'unavailable',
  };
}

export const agyAdapter: ProviderAdapter = {
  providerId: 'agy',
  async capability() {
    return agyCapability(await executableVersion('agy'));
  },
  async discover(request) {
    const maximumSessions = Math.min(Math.max(request.maximumSessions ?? 100, 1), 1_000);
    const requestedSessionIds = request.sessionIds ? new Set(request.sessionIds) : null;
    const sessions: ProviderSession[] = [];
    const roots = request.roots;
    for (const root of roots ?? defaultRoots('agy')) {
      for (const path of await jsonlFiles(root)) {
        sessions.push(...await parseAgyHistoryFile(path, request.workspace));
      }
    }
    if (!roots) {
      const configRoot = resolve(process.env.AGY_CONFIG_DIR || resolve(homedir(), '.gemini', 'antigravity-cli'));
      sessions.push(...await discoverAgyNativeTranscripts(configRoot, request));
    }
    const ordered = sessions
      .filter((session) => !request.since || Date.parse(session.endedAt) >= request.since.getTime())
      .filter((session) => !requestedSessionIds || requestedSessionIds.has(session.sessionId))
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    return requestedSessionIds ? ordered : ordered.slice(-maximumSessions);
  },
};

export const codexAdapter = adapter('codex', 'codex');
export const claudeAdapter = adapter('claude', 'claude');
export const providerAdapters: ProviderAdapter[] = [codexAdapter, claudeAdapter, agyAdapter];
export { insideWorkspace, parseAgyHistoryFile, parseAgyTranscriptFile, parseSessionFile };
