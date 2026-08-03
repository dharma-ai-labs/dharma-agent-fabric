import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
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
}

export interface ProviderAdapter {
  providerId: 'codex' | 'claude';
  capability(): Promise<ProviderCapability>;
  discover(request: DiscoveryRequest): Promise<ProviderSession[]>;
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
  const raw = String(record.type ?? record.kind ?? record.event_type ?? record.role ?? 'metadata').toLowerCase();
  if (raw.includes('user')) return 'user_message';
  if (raw.includes('assistant') || raw.includes('agent')) return 'agent_message';
  if (raw.includes('tool') && raw.includes('result')) return 'tool_result';
  if (raw.includes('tool')) return 'tool_call';
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

async function parseSessionFile(provider: 'codex' | 'claude', path: string, workspace: string): Promise<ProviderSession | null> {
  const fileStat = await stat(path);
  const records: SourceRecord[] = [];
  let line = 0;
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const value of reader) {
    line += 1;
    if (!value.trim()) continue;
    let native: Record<string, unknown>;
    try { native = JSON.parse(value) as Record<string, unknown>; } catch { continue; }
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
    coverage: effective.length === records.length ? 'observed' : 'partial',
    startedAt,
    endedAt,
  };
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
        taskExecution: version ? 'partial' : 'unavailable',
        sessionContinuation: 'unavailable',
        skillInstall: 'partial',
        activation: 'next_session',
        usageEvidence: 'partial',
      };
    },
    async discover(request) {
      const sessions: ProviderSession[] = [];
      for (const root of request.roots ?? defaultRoots(provider)) {
        for (const path of await jsonlFiles(root)) {
          const fileStat = await stat(path);
          if (request.since && fileStat.mtime < request.since) continue;
          const session = await parseSessionFile(provider, path, request.workspace);
          if (session) sessions.push(session);
        }
      }
      return sessions.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    },
  };
}

export const codexAdapter = adapter('codex', 'codex');
export const claudeAdapter = adapter('claude', 'claude');
export const providerAdapters: ProviderAdapter[] = [codexAdapter, claudeAdapter];
export { insideWorkspace, parseSessionFile };
