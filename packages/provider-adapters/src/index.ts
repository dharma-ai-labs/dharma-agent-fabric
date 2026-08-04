import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { EvidenceState, ProviderCapability } from '@dharma-ai/agent-fabric-contracts';

export interface SourceRecord {
  native: Record<string, unknown>;
  sourcePath: string;
  line: number;
  workspace: string | null;
  timestamp: string | null;
  kind: string;
}

export interface ProviderSession {
  provider: 'codex' | 'claude';
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
  since?: Date;
  maximumSessions?: number;
  maximumBytesPerSession?: number;
  maximumRecordBytes?: number;
}

export interface ProviderAdapter {
  providerId: 'codex' | 'claude';
  capability(): Promise<ProviderCapability>;
  discover(request: DiscoveryRequest): Promise<ProviderSession[]>;
}

export interface ProviderExecutionResult {
  provider: 'codex' | 'claude';
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
}) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; timedOut: boolean; stdout: Buffer; stderr: Buffer }>;

const defaultProcessRunner: ProviderProcessRunner = (input) => new Promise((accept, reject) => {
  const child = spawn(input.command, input.argv, {
    cwd: input.cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DHARMA_AGENT_FABRIC_TASK: '1' },
  });
  const maximum = 5_000_000;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  const collect = (target: Buffer[], chunk: Buffer, current: number) => {
    if (current < maximum) target.push(chunk.subarray(0, Math.max(0, maximum - current)));
    return current + chunk.length;
  };
  child.stdout.on('data', (chunk: Buffer) => { stdoutBytes = collect(stdout, chunk, stdoutBytes); });
  child.stderr.on('data', (chunk: Buffer) => { stderrBytes = collect(stderr, chunk, stderrBytes); });
  const cancel = () => child.kill('SIGTERM');
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, input.timeoutMs);
  child.once('error', reject);
  child.once('close', (exitCode, signal) => {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', cancel);
    accept({ exitCode, signal, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
  });
  child.stdin.end(input.stdin);
});

export async function executeProviderTask(input: {
  provider: 'codex' | 'claude';
  workspace: string;
  instructions: string;
  timeoutSeconds: number;
  allowedCommandArgv: string[][];
  signal?: AbortSignal;
  runner?: ProviderProcessRunner;
}): Promise<ProviderExecutionResult> {
  if (!insideWorkspace(input.workspace, input.workspace)) throw new Error('Provider workspace is invalid.');
  if (!input.instructions.trim() || input.instructions.length > 20_000) throw new Error('Provider task instructions are invalid.');
  const runner = input.runner || defaultProcessRunner;
  let command: string;
  let argv: string[];
  if (input.provider === 'codex') {
    command = 'codex';
    argv = ['exec', '--json', '--color', 'never', '--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false', '-C', input.workspace, '-'];
  } else {
    command = 'claude';
    const bashTools = input.allowedCommandArgv.map((parts) => `Bash(${parts.join(' ')})`);
    argv = ['--print', '--input-format', 'text', '--output-format', 'stream-json', '--permission-mode', 'acceptEdits', '--allowedTools', ['Read', 'Edit', 'Write', ...bashTools].join(','), '--disallowedTools', 'WebFetch,WebSearch'];
  }
  const result = await runner({
    command, argv, cwd: input.workspace, stdin: input.instructions,
    timeoutMs: Math.min(Math.max(input.timeoutSeconds, 1), 3_600) * 1_000, signal: input.signal,
  });
  return {
    provider: input.provider, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut,
    stdout: result.stdout.toString('utf8'), stderr: result.stderr.toString('utf8'),
    stdoutSha256: `sha256:${createHash('sha256').update(result.stdout).digest('hex')}`,
    stderrSha256: `sha256:${createHash('sha256').update(result.stderr).digest('hex')}`,
  };
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
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) output.push(path);
    }
  }
  return output.sort();
}

async function boundedJsonlLines(path: string, size: number, maximumBytes: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    if (size <= maximumBytes) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
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
    return [...headLines, ...tailLines].filter(Boolean);
  } finally {
    await handle.close();
  }
}

async function parseSessionFile(
  provider: 'codex' | 'claude',
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
  for (const value of await boundedJsonlLines(path, fileStat.size, maximumBytes)) {
    line += 1;
    if (!value.trim()) continue;
    if (Buffer.byteLength(value) > maximumRecordBytes) { omitted = true; continue; }
    let native: Record<string, unknown>;
    try { native = JSON.parse(value) as Record<string, unknown>; } catch { omitted = true; continue; }
    const cwd = findString(native, ['cwd', 'workspace', 'workspace_path', 'working_directory']);
    const timestamp = findString(native, ['timestamp', 'created_at', 'createdAt', 'time']);
    records.push({ native, sourcePath: path, line, workspace: cwd, timestamp, kind: inferKind(native) });
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
    startedAt: normalizeTimestamp(records[0]?.timestamp ?? null, new Date(session.startedAt)),
    endedAt: normalizeTimestamp(records.at(-1)?.timestamp ?? null, new Date(session.endedAt)),
  }));
}

function defaultRoots(provider: 'codex' | 'claude'): string[] {
  if (provider === 'codex') {
    return [resolve(process.env.CODEX_HOME || resolve(homedir(), '.codex'), 'sessions')];
  }
  return [resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), '.claude'), 'projects')];
}

function adapter(provider: 'codex' | 'claude', command: string): ProviderAdapter {
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
        usageEvidence: 'partial',
      };
    },
    async discover(request) {
      const sessions: ProviderSession[] = [];
      const maximumSessions = Math.min(Math.max(request.maximumSessions ?? 100, 1), 1_000);
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
        if (session) sessions.push(...segmentProviderSession(session));
        if (sessions.length >= maximumSessions) break;
      }
      return sessions
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
        .slice(-maximumSessions);
    },
  };
}

export const codexAdapter = adapter('codex', 'codex');
export const claudeAdapter = adapter('claude', 'claude');
export const providerAdapters: ProviderAdapter[] = [codexAdapter, claudeAdapter];
export { insideWorkspace, parseSessionFile };
