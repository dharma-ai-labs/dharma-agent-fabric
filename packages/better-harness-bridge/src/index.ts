import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export type HarnessProvider = 'codex' | 'claude';

interface HarnessSource {
  kind?: unknown;
  role?: unknown;
  exists?: unknown;
  enabled?: unknown;
  optional?: unknown;
}

interface HarnessSession {
  coverage?: Record<string, unknown>;
  sourceKinds?: unknown;
}

export interface HarnessEvidenceSummary {
  provider: HarnessProvider;
  sourceCounts: Record<string, number>;
  sessionCount: number;
  sessionCoverage: Record<string, number>;
  warnings: string[];
}

function runJson(command: string, argv: string[], cwd: string): Promise<unknown> {
  return new Promise((accept, reject) => {
    const child = spawn(command, argv, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Better Harness bridge failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`));
        return;
      }
      try {
        accept(JSON.parse(Buffer.concat(stdout).toString('utf8')));
      } catch {
        reject(new Error('Better Harness returned non-JSON output.'));
      }
    });
  });
}

export async function summarizeHarnessEvidence(input: {
  repositoryRoot: string;
  workspace: string;
  provider: HarnessProvider;
}): Promise<HarnessEvidenceSummary> {
  const vendorRoot = resolve(input.repositoryRoot, 'vendor/better-harness');
  const script = resolve(vendorRoot, 'scripts/session-analysis.mjs');
  const output = await runJson(process.execPath, [
    script,
    'sources',
    '--platform', input.provider,
    '--workspace', resolve(input.workspace),
    '--json',
  ], vendorRoot) as { sources?: HarnessSource[]; sessions?: HarnessSession[]; warnings?: unknown[] };

  const sourceCounts: Record<string, number> = {};
  for (const source of output.sources ?? []) {
    const key = typeof source.kind === 'string' ? source.kind : 'unknown';
    sourceCounts[key] = (sourceCounts[key] ?? 0) + (source.exists === true && source.enabled !== false ? 1 : 0);
  }
  const sessionCoverage: Record<string, number> = {};
  for (const session of output.sessions ?? []) {
    for (const [key, value] of Object.entries(session.coverage ?? {})) {
      if (value === true) sessionCoverage[key] = (sessionCoverage[key] ?? 0) + 1;
    }
  }

  return {
    provider: input.provider,
    sourceCounts,
    sessionCount: output.sessions?.length ?? 0,
    sessionCoverage,
    warnings: (output.warnings ?? []).filter((item): item is string => typeof item === 'string').slice(0, 20),
  };
}
