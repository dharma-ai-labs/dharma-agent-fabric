import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCodexAppServerTransport } from '../packages/provider-adapters/dist/codexAppServerTransport.js';

// No model calls or enrollment: exercise native permission changes on one process.
if (process.platform !== 'linux') throw new Error('probe_linux_required');
const root = await mkdtemp(join(tmpdir(), 'dharma-named-permissions-'));
const workspace = join(root, 'repo'), home = join(root, 'codex');
await mkdir(workspace); await mkdir(home); await mkdir(join(workspace, 'src'));
await mkdir(join(workspace, 'test'));
await writeFile(join(workspace, 'source.txt'), 'synthetic');
await writeFile(join(root, 'outside.txt'), 'private-fixture');
const transport = await openCodexAppServerTransport({ command: process.argv[2] || '/usr/local/bin/codex',
  cwd: workspace, environment: { ...process.env, CODEX_HOME: home }, experimentalApi: true,
  argv: ['-c', 'default_permissions="dharma_bridge"',
    '-c', 'permissions.dharma_bridge.filesystem={":minimal"="read",":workspace_roots"={"."="read"}}',
    '-c', 'permissions.dharma_bridge.network={enabled=false}',
    '-c', 'permissions.dharma_work.filesystem={":minimal"="read",":workspace_roots"={"."="read",src="write",test="write"}}',
    '-c', 'permissions.dharma_work.network={enabled=false}', 'app-server'] });
try {
  const thread = await transport.request('thread/start', { cwd: workspace,
    approvalPolicy: 'never', permissions: 'dharma_bridge', ephemeral: false });
  const execute = (profile, script) => transport.request('command/exec', { command: ['/bin/sh', '-c', script],
    cwd: workspace, permissionProfile: profile, timeoutMs: 3000, outputBytesCap: 4096 });
  const write = await execute('dharma_work', 'printf permitted > src/result.txt');
  const expanded = await execute('dharma_work', 'printf denied > root-denied.txt');
  const switched = await execute('dharma_bridge', 'printf denied > src/peer-denied.txt');
  const readable = await execute('dharma_bridge', 'cat src/result.txt');
  const outside = await execute('dharma_work', `cat ${join(root, 'outside.txt')}`);
  const absent = path => readFile(path).then(() => false, error => { if (error.code !== 'ENOENT') throw error; return true; });
  const checks = { localWrite: write.exitCode === 0,
    rootWriteDenied: expanded.exitCode !== 0 && await absent(join(workspace, 'root-denied.txt')),
    peerWriteDeniedAfterLocalWrite: switched.exitCode !== 0 && await absent(join(workspace, 'src/peer-denied.txt')),
    peerRead: readable.exitCode === 0 && readable.stdout.trim() === 'permitted',
    outsideReadDenied: outside.exitCode !== 0 && !outside.stdout.includes('private-fixture') };
  process.stdout.write(`${JSON.stringify({ schema: 'dharma.permission-probe/v1', timestamp: new Date().toISOString(),
    sessionId: thread.thread.id, checks, modelCalls: 0, workspace })}\n`);
  assert.ok(Object.values(checks).every(Boolean), 'native permissions must enforce every selected boundary');
} finally { await transport.close(); }
